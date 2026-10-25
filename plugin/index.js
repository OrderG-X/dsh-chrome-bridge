/**
 * Browser Bridge —— DSH 宿主插件
 *
 * 把 `cb` 那套能力变成 DSH 的原生工具：模型直接调 browser_*，不经过 bash。
 *
 * 传输层刻意做得很薄：插件只是个 Unix socket 客户端，说的协议和 `cb` CLI 完全一样，
 * 所以两边共用同一个宿主/扩展，不存在第二份实现。
 *
 *   DSH 工具 → socket → 宿主 → 原生消息 → Chrome 扩展 → chrome.debugger → CDP
 */

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { installImageGuard } from './image-guard.js'
import { ensureInstalled, installHint, assistInstall, paths, extensionId } from './setup.js'
import { snapshot, locate, focusShadow, elementBox, selectInPage, frameTexts } from './refs.js'
import { consoleLog, networkLog, responseBody, clearLogs } from './devtools.js'
import { historyNav, waitUntil } from './nav.js'
import { PANEL_ROUTE, panelHandler } from './panel.js'
import { drag } from './drag.js'
import { download, downloadsDir, humanSize } from './download.js'

/**
 * 这里刻意不 import 任何外部包——不碰 `@deepseek-ai/dsh-tools`。
 *
 * 原因：profile 上下文里那个包解析不到（裸 node 实测 ERR_MODULE_NOT_FOUND），
 * 一旦解析失败，整个插件模块加载失败、行直接挂掉，而且错误只留在 app 进程里，
 * 外面完全看不到。所以工具对象在这里按 dsh-tools 的产出形状手搓：
 *   parameters —— 属性表编译成 JSON Schema（等价 parameterSchemaSpecToJsonSchema）
 *   output     —— { schema, render }，schema 直接写成 JSON Schema
 */

// socket / token / 日志都在只有当前用户进得去的 /tmp/dsh-bridge-<uid>/（和宿主、cb 同一个约定）：
// /tmp 人人可写，固定文件名会被别的用户抢先占位，或者用软链接把写入引到别处。
// Windows：目录是 %TEMP%\dsh-bridge（本来就只属于当前用户）；没有 Unix socket，宿主每次起一个
// 随机名字的命名管道，名字写在 token 文件第二行
const WIN = process.platform === 'win32'
const UID = typeof process.getuid === 'function' ? process.getuid() : null
const DIR = process.env.DSH_BRIDGE_DIR || (WIN ? path.join(os.tmpdir(), 'dsh-bridge') : `/tmp/dsh-bridge-${UID ?? 'user'}`)
const TOKEN_FILE = process.env.DSH_BRIDGE_TOKEN || path.join(DIR, 'dsh-bridge.token')
const FIXED_SOCK = process.env.DSH_BRIDGE_SOCK || (WIN ? null : path.join(DIR, 'dsh-bridge.sock'))

function tokenLines() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').split('\n').map((l) => l.trim()) } catch { return [] }
}
/** 宿主在听的地址（Windows 上每次启动都换） */
function hostSock() { return FIXED_SOCK || tokenLines()[1] || null }
/** 宿主起没起：socket 文件在不在；Windows 看 token 文件里有没有管道名（宿主退出时会删掉） */
function hostUp() { const s = hostSock(); return Boolean(s) && (WIN || fs.existsSync(s)) }
const TRACE = path.join(DIR, 'plugin.log')
const { O_WRONLY, O_CREAT, O_APPEND, O_NOFOLLOW } = fs.constants

/** 目录必须是自己的真目录（不是软链接）、别人进不去：不然连上的可能是别人摆的假宿主 */
function checkDir(dir) {
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || (!WIN && ((UID !== null && st.uid !== UID) || (st.mode & 0o077)))) {
    throw new Error(`${dir} 不是只属于当前用户的目录，拒绝使用`)
  }
}

let traceOk = null
function trace(line) {
  try {
    if (traceOk === null) {
      traceOk = false
      try { fs.mkdirSync(DIR, { mode: 0o700 }) } catch {}
      checkDir(DIR)
      traceOk = true
    }
    if (traceOk) {
      fs.appendFileSync(TRACE, `${new Date().toISOString()} ${line}\n`, { flag: O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, mode: 0o600 })
    }
  } catch {}
}

/** 属性表 → JSON Schema：{ [name]: { type, required?, description?, ... } } */
function specToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = node
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/**
 * 每次工具调用的「名片」：哪个 DSH 会话、哪个工具、大概在干嘛。随每个请求带给扩展，
 * 扩展弹窗靠它把操作归到会话下面、把一次工具调用的多个底层操作合成一条「最近动作」。
 * 用 AsyncLocalStorage 传，工具代码里一层层的 call() 不用改签名。
 */
const callInfo = new AsyncLocalStorage()
const BASE_CLIENT = { kind: 'dsh', pid: process.pid }

/** DSH 没有正式文档说 exec 里有什么，几个可能的位置都试一下；拿不到就按进程算一个会话 */
function sessionOf(exec) {
  const a = exec && exec.agent
  const v = (exec && exec.sessionId) || (a && (a.sessionId || (a.session && a.session.id) || a.id))
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null
}

let execProbed = false
function probeExec(exec) {
  if (execProbed || !exec) return
  execProbed = true
  try {
    const a = exec.agent
    trace(`exec 键: ${Object.keys(exec).join(',')}｜agent 键: ${a ? Object.keys(a).join(',') : '-'}`)
  } catch {}
}

const short = (v, n = 40) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** 一眼看得懂的一句话：「[3]」「「加载完成」」「back」「https://…」 */
function hintOf(name, a = {}) {
  const el = (p = '') => {
    const ref = a[p ? `${p}Ref` : 'ref']
    if (ref !== undefined && ref !== null) return `[${ref}]`
    const sel = a[p ? `${p}Selector` : 'selector']
    if (sel) return short(sel, 30)
    const text = a[p ? `${p}Text` : 'text']
    if (text) return `「${short(text, 20)}」`
    const x = a[p ? `${p}X` : 'x']
    const y = a[p ? `${p}Y` : 'y']
    return x !== undefined && y !== undefined ? `(${x}, ${y})` : ''
  }
  switch (name) {
    case 'browser_tabs': return [a.action, short(a.url || a.query || '', 40)].filter(Boolean).join(' ')
    case 'browser_read': return [a.what, a.selector ? short(a.selector, 30) : ''].filter(Boolean).join(' ')
    case 'browser_click': return el()
    case 'browser_input':
      // 只记字数：这句会显示在扩展弹窗的「最近动作」里，打的可能是密码
      return a.action === 'type' ? `打字 ${String(a.text ?? '').length} 字${a.ref != null || a.selector ? ` → ${el()}` : ''}`
        : a.action === 'key' ? `按键 ${a.key || ''}`
          : `${a.action} ${el()}`.trim()
    case 'browser_nav': return (a.action && a.action !== 'go') ? a.action : short(a.url, 50)
    case 'browser_screenshot': return a.mode === 'element' ? `元素 ${el()}` : a.mode || ''
    case 'browser_eval': return short(a.expression, 40)
    case 'browser_wait':
      return `${a.gone ? '等消失 ' : ''}${a.text ? `「${short(a.text, 20)}」` : a.url ? `网址 ${short(a.url, 30)}` : short(a.selector, 30)}`
    case 'browser_dialog': return a.action || ''
    case 'browser_drag': return `${el('from')} → ${el('to')}`
    case 'browser_download': return a.ref !== undefined && a.ref !== null ? `[${a.ref}]` : short(a.selector || a.url || '', 50)
    case 'browser_devtools': return [a.action, a.level && a.level !== 'all' ? a.level : '', a.filter ? `「${short(a.filter, 16)}」` : ''].filter(Boolean).join(' ')
    default: return ''
  }
}

/** 等价于 dsh-tools 的 defineTool（只用它的产出形状，不依赖它） */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: specToJsonSchema(options.parameters),
    output: { schema: options.output.schema, render: options.output.render },
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
    execute(args, exec) {
      probeExec(exec)
      let hint = ''
      try { hint = hintOf(options.name, args || {}) } catch {}
      const info = {
        ...BASE_CLIENT,
        session: sessionOf(exec),
        tool: options.name,
        call: (exec && exec.callId) || crypto.randomUUID(),
        hint,
      }
      return callInfo.run(info, () => options.execute(args, exec))
    },
  }
}

export const name = 'browser-bridge'
export const inject = ['tools']

/**
 * 第一次发现宿主连不上时，做一次「引导」：把扩展目录塞进剪贴板、后台打开
 * chrome://extensions（见 setup.js 的 assistInstall）。每个进程只做一次。
 * 那一下点选替不了 —— Chrome 137+ 没有 --load-extension —— 但至少让用户不用自己去翻目录、找页面。
 * 宿主连得上就算装好（不管扩展是解压的还是商店的），这里根本不会被调到。
 */
let aided = false
function firstAid() {
  if (aided) return ''
  aided = true
  try {
    if (hostUp()) return ''
    const r = assistInstall()
    const notes = []
    if (r.opened) notes.push(`我已经帮你把 chrome://extensions 打开（后台标签页）${r.store ? '，看一眼 DSH Bridge 是不是启用着' : ''}`)
    if (r.clipboard) notes.push(`扩展文件夹的路径已经复制到剪贴板（${WIN ? '粘进文件框顶上的地址栏、回车' : '文件框里 ⌘⇧G 再 ⌘V 回车'}就到）`)
    return notes.length ? `\n（${notes.join('；')}）` : ''
  } catch {
    return ''
  }
}

/** 报错时带上「还差哪一步」——宿主和 native 注册已由 setup.js 自动装好。 */
const HINT = () => installHint() + firstAid()

// ── 与宿主通话 ──────────────────────────────────────────────────────────────

/** 一次请求一个连接，协议是换行分隔的 JSON（和 cb CLI 完全一致）。 */
function call(op, args = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const SOCK = hostSock()
    if (!hostUp()) {
      return reject(new Error(`浏览器桥没在跑（找不到 ${SOCK || TOKEN_FILE}）：Chrome 没开，或扩展还没加载。\n${HINT()}`))
    }
    try { checkDir(WIN ? DIR : path.dirname(SOCK)) } catch (e) { return reject(e) }
    const token = tokenLines()[0] || null
    const id = crypto.randomUUID()
    const sock = net.connect(SOCK)
    let acc = ''
    let done = false
    let timer = null
    const finish = (fn, v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sock.destroy() } catch {}
      fn(v)
    }
    sock.setEncoding('utf8')
    const client = callInfo.getStore() || BASE_CLIENT
    // timeoutMs 也带给宿主：它按这个等扩展，不再一律 45 秒（等元素、截图这类慢操作以前必定被它掐掉）
    sock.on('connect', () => sock.write(JSON.stringify({ token, id, op, args, client, timeoutMs }) + '\n'))
    sock.on('data', (d) => {
      acc += d
      const i = acc.indexOf('\n')
      if (i < 0) return
      let msg
      try { msg = JSON.parse(acc.slice(0, i)) } catch { return finish(reject, new Error('宿主回了坏 JSON')) }
      if (msg.ok) finish(resolve, msg.result)
      else finish(reject, new Error(msg.error || '未知错误'))
    })
    sock.on('error', (e) => finish(reject, new Error(`连不上浏览器桥：${e.message}\n${HINT()}`)))
    sock.on('close', () => finish(reject, new Error('浏览器桥连接被关掉了')))
    timer = setTimeout(() => finish(reject, new Error(`等浏览器桥超时（${timeoutMs}ms）`)), timeoutMs)
  })
}

/**
 * 每个会话「正在用的标签页」：它自己打开的，或者它点名操作过的。不传 tab 时就接着用它；
 * 一个都没有就报错 —— 绝不默认去动用户正在看的标签页（以前省略等于 active：模型没传 tab，
 * 就把用户正在编辑的页面跳走了）。明确传 "active" 照旧：那是模型按用户的话有意要动当前页。
 */
const currentTab = new Map() // 会话 → 标签页 id
const sessionKey = () => (callInfo.getStore() || {}).session || 'default'
const rememberTab = (id) => currentTab.set(sessionKey(), Number(id))

/** 标签页关掉了：谁正在用它，谁就忘掉它 */
function forgetTab(id) {
  for (const [k, v] of currentTab) if (v === Number(id)) currentTab.delete(k)
}

async function resolveTab(tab) {
  if (tab !== undefined && tab !== null && tab !== '') {
    if (String(tab) === 'active') {
      const active = (await call('tabs')).find((t) => t.active)
      if (!active) throw new Error('没有活动标签页')
      rememberTab(active.id)
      return active.id
    }
    const id = Number(tab)
    if (!Number.isInteger(id)) throw new Error(`tab 要是标签页 id（数字）或 "active"，收到的是「${tab}」`)
    rememberTab(id)
    return id
  }
  const id = currentTab.get(sessionKey())
  if (id !== undefined) {
    if ((await call('tabs')).some((t) => t.id === id)) return id
    currentTab.delete(sessionKey())
  }
  throw new Error(
    '没指定标签页（tab）。先用 browser_tabs 打开（open）或找到（list / find）要操作的页面，再把 id 传给 tab；' +
    '要操作用户正在看的那一页就明确传 tab="active"。不传 tab 时只会接着用你自己打开或点名操作过的标签页，不会去动用户正在看的页面')
}

/**
 * 后台标签页（或者 Chrome 窗口被别的窗口挡住）时页面是 hidden，CDP 发的鼠标/键盘事件
 * 会被直接丢掉——工具照样回「已点击」，其实什么都没发生（实测：3 次点击 0 次生效）。
 * 打开焦点模拟后事件就能送达（Playwright 对每个页面都这么做）。
 * 空闲断开调试会话会清掉它，所以每次动手前补一下，本地一个来回，很便宜。
 */
async function emulateFocus(tabId) {
  try {
    await call('cdp', { tabId, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } })
  } catch (e) {
    trace(`焦点模拟失败（忽略）: ${e && e.message}`)
  }
}

/**
 * 换目录之前的宿主只在 /tmp/dsh-bridge.sock 听：插件升级后它要是还活着，新插件就找不到宿主。
 * 只要那个 socket 确实是自己的，就请它让扩展重载一次 —— 扩展重连时 Chrome 会拉起新宿主（新目录）。
 * 只发 reload，不发别的。
 */
function nudgeLegacyHost() {
  if (WIN) return
  try {
    const legacy = '/tmp/dsh-bridge.sock'
    const tokenFile = '/tmp/dsh-bridge.token'
    const st = fs.lstatSync(legacy)
    const tk = fs.lstatSync(tokenFile)
    if (!st.isSocket() || !tk.isFile() || (UID !== null && (st.uid !== UID || tk.uid !== UID))) return
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    const s = net.connect(legacy)
    s.on('connect', () => s.end(JSON.stringify({ token, id: crypto.randomUUID(), op: 'reload', args: {} }) + '\n'))
    s.on('error', () => {})
    setTimeout(() => s.destroy(), 3000).unref()
    trace('旧宿主还在老地方听：已请扩展重载，换成新宿主')
  } catch {}
}

/**
 * 扩展是「已解压」加载的：setup 把新文件拷进扩展目录后，Chrome 不会自己重载，跑的还是旧代码。
 * 所以插件启动时对一下版本号，对不上就让扩展自己 chrome.runtime.reload()（一秒内带着新代码回来）。
 *
 * 只管解压版（ID 和 ~/dsh-bridge-extension 推导出来的一致）。商店版的代码由商店自己更新，
 * reload 只会白白掐断宿主一下；而商店版本号常常落后本地，不跳过就会每次启动都重载。
 */
async function refreshExtension() {
  if (!hostUp()) {
    if (!process.env.DSH_BRIDGE_SOCK) nudgeLegacyHost()
    return
  }
  let want, localId
  try {
    const manifestFile = path.join(paths().extDir, 'manifest.json')
    want = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).version
    localId = extensionId(manifestFile)
  } catch {
    return
  }
  try {
    const { version, id } = await call('version', {}, 5000)
    if (id && id !== localId) {
      trace(`扩展 ${version}（${id}）不是本地解压版，不重载`)
      return
    }
    if (version === want) return
    await call('reload', {}, 5000)
    trace(`扩展 ${version} → ${want}：已让它重载`)
  } catch (e) {
    trace(`检查扩展版本失败（忽略）: ${e && e.message}`)
  }
}

/** 页内光标脚本：点东西时让用户看得见。读不到就静默降级。 */
let cursorCache
function cursorScript() {
  if (cursorCache !== undefined) return cursorCache
  // 先用插件自带的那份：版本跟插件走，别的安装脚本往 ~/.dsh/chrome-cursor 里写了旧版也不受影响
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor/in-page-cursor.js'),
    path.join(os.homedir(), '.dsh/chrome-cursor/in-page-cursor.js'), // setup.js 落盘的位置（cb 命令行也读它）
  ]
  cursorCache = ''
  for (const file of candidates) {
    try { cursorCache = fs.readFileSync(file, 'utf8'); break } catch {}
  }
  return cursorCache
}
const withCursor = (extra = {}) => {
  const script = cursorScript()
  return script ? { ...extra, script } : extra
}

const clip = (s, n = 6000) => (s.length > n ? s.slice(0, n) + `\n…（截断，全文 ${s.length} 字）` : s)

/** DSH 的会话投影服务（读会话现在的工作目录用）；apply 里 inject 到了才有 */
let projections = null

/**
 * 会话现在的工作目录：先看 DSH 的 workingDirectory 投影（会话里切过目录就是新的），没有再用会话头里
 * 建会话时的目录。都拿不到返回空串。写法同 dsh-video-preview 的 sessionCwd。
 */
function sessionCwd(exec) {
  const session = exec && exec.agent && exec.agent.session
  let cwd
  try {
    cwd = projections && session && projections.stateOf(session, 'workingDirectory')
  } catch { /* 没装这个投影 */ }
  if (typeof cwd !== 'string' || !cwd) cwd = session && session.header && session.header.cwd
  return typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : ''
}

/**
 * upload 能塞进网页的文件：只限会话工作目录、系统临时目录下的普通文件，路径里任何一段以 . 开头
 * （~/.ssh、.env 这类隐藏目录/文件）都不行。按 realpath 判断，软链接绕不过去；交给扩展的也是 realpath。
 */
function uploadable(files, cwd) {
  const roots = [cwd, os.tmpdir(), '/tmp'].filter(Boolean)
    .map((d) => { try { return fs.realpathSync(d) } catch { return null } }).filter(Boolean)
  const hidden = (p) => p.split(path.sep).some((seg) => seg.startsWith('.'))
  return files.map((f) => {
    const raw = String(f)
    if (!path.isAbsolute(raw) && !cwd) throw new Error(`upload 要给绝对路径：${raw}`)
    const abs = path.resolve(cwd || '/', raw)
    let real
    try { real = fs.realpathSync(abs) } catch { throw new Error(`文件不存在：${raw}`) }
    if (hidden(abs) || hidden(real)) throw new Error(`不能上传隐藏目录 / 隐藏文件：${raw}`)
    if (!roots.some((r) => real.startsWith(r + path.sep))) {
      throw new Error(`只能上传会话工作目录${cwd ? `（${cwd}）` : ''}或系统临时目录下的文件：${raw}`)
    }
    if (!fs.statSync(real).isFile()) throw new Error(`不是普通文件：${raw}`)
    return real
  })
}

/** browser_wait 最多等多久：再长就该换个思路（或者分几次等），别把一次工具调用挂几分钟 */
const WAIT_MAX_MS = 120_000

// ── 工具通用外壳 ────────────────────────────────────────────────────────────

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

const TAB_DESC = '标签页 id（数字），或 "active" 表示用户当前正在看的标签页。省略时接着用本会话上次打开或操作过的标签页；还没有就报错，不会默认去动用户正在看的页面'
const REF_DESC = '元素编号：browser_read(what=snapshot) 列出的 [N]。最稳，有编号就别再猜选择器'
const present = (title) => (args) => ({ card: 'generic', title, kind: 'other', rawInput: args })

// ── 截图：把图直接给模型看 ──────────────────────────────────────────────────

/** render 是同步的，所以 execute 把附件引用存在这里，render 取出来用。 */
const shotRefs = new Map()

export function apply(ctx, config) {
  trace('apply 被调用')

  // 一次性安装：宿主 + native 注册自动落地，用户只剩把扩展装进 Chrome（加载已解压，或商店装）
  try {
    const s = ensureInstalled()
    trace(s.ok ? `setup: ${s.changed ? '已落盘' : '已是最新'} ext=${s.extId}` : `setup 跳过: ${s.reason}`)
  } catch (e) {
    trace(`setup 异常（忽略）: ${e && e.message}`)
  }
  refreshExtension()

  // DSH 插件页里的设置卡（client.js）靠这条路由拿状态、按开关。webServer 是可选的：
  // 没有网页端的 profile（headless）里就不挂，工具照常注册。
  // 挂不上也只是设置页没数据，绝不能连累工具注册
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub) => {
        if (!sub || typeof sub.effect !== 'function' || !sub.webServer) return
        sub.effect(() => sub.webServer.register({
          kind: 'exact',
          path: PANEL_ROUTE,
          handler: panelHandler({ call, sock: hostUp, origin: () => sub.webServer.getOrigin(), trace }),
        }), 'chrome-bridge: settings panel route')
        trace(`设置页路由已挂上 ${PANEL_ROUTE}`)
      })
    }
  } catch (e) {
    trace(`设置页路由没挂上（忽略）: ${e && e.message}`)
  }

  // 会话投影：upload 只放行会话工作目录（和系统临时目录）下的文件，要靠它读工作目录。
  // 可选的：拿不到就退回会话头里的目录。别直接读 ctx.sessionProjections：没写进 inject 的服务，
  // DSH（cordis）会直接抛「cannot get property without inject」，整个 apply 就断了
  projections = null
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessionProjections'], (sub) => { if (sub && sub.sessionProjections) projections = sub.sessionProjections })
    }
  } catch (e) {
    trace(`会话投影没拿到（upload 按会话头里的目录算）: ${e && e.message}`)
  }

  const tools = [
    // ── 标签页 ──────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_tabs',
      description:
        '列出 / 查找 / 打开 / 关闭 / 切换 Chrome 标签页。其它 browser_* 工具都要 tab 参数，先用它拿 id。' +
        '只对用户真实浏览器里已存在的页面生效，不会新开一个干净的浏览器。',
      parameters: {
        action: {
          type: 'string', required: true, enum: ['list', 'find', 'open', 'close', 'activate'],
          description: 'list 全部；find 按关键词过滤标题/URL；open 新开；close 关掉；activate 切到前台',
        },
        query: { type: 'string', description: 'action=find 时的关键词（匹配标题或 URL）' },
        url: { type: 'string', description: 'action=open 时要打开的网址' },
        tab: { type: 'string', description: 'action=close/activate 时的标签页 id' },
      },
      output: textOutput,
      presentCall: present('Browser tabs'),
      async execute(args) {
        switch (args.action) {
          case 'list': {
            const tabs = await call('tabs')
            const lines = tabs.map((t) =>
              `${t.active ? '*' : ' '} ${String(t.id).padStart(5)} ${(t.title || '').slice(0, 50)} — ${t.url.slice(0, 80)}`)
            return { text: lines.join('\n') || '(没有标签页)' }
          }
          case 'find': {
            const q = String(args.query || '').toLowerCase()
            const tabs = (await call('tabs')).filter((t) =>
              (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q))
            return {
              text: tabs.map((t) => `${String(t.id).padStart(5)} ${t.title} — ${t.url}`).join('\n') || '(没有匹配的标签页)',
            }
          }
          case 'open': {
            if (!args.url) throw new Error('action=open 需要 url')
            const r = await call('open', { url: args.url })
            rememberTab(r.tabId)
            return { text: `已打开标签页 ${r.tabId}：${r.url}` }
          }
          case 'close': {
            const tabId = await resolveTab(args.tab)
            await call('close', { tabId })
            forgetTab(tabId)
            return { text: `已关闭标签页 ${tabId}` }
          }
          case 'activate': {
            const tabId = await resolveTab(args.tab)
            await call('activate', { tabId })
            return { text: `已切到标签页 ${tabId}` }
          }
          default:
            throw new Error(`不认识的 action: ${args.action}`)
        }
      },
    }),

    // ── 读页面 ──────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_read',
      description:
        '读页面内容。what=snapshot 列出页面上能点/能填的元素，每个带编号 [N]——要操作页面时先调它，' +
        '之后 browser_click / browser_input 直接传 ref=N，比猜选择器稳（同源 iframe 里的元素也会列出、也能按编号操作）；' +
        'text 取可见文字（抓内容首选）；html 取外层 HTML；' +
        'attr 取某个属性；info 取标题/URL/视口，并会告诉你有没有 alert 弹窗挡着（挡着的话先调 browser_dialog）。',
      parameters: {
        what: { type: 'string', required: true, enum: ['snapshot', 'text', 'html', 'attr', 'info'], description: '读什么' },
        tab: { type: 'string', description: TAB_DESC },
        selector: { type: 'string', description: 'CSS 选择器；snapshot/text/html 省略时取整页' },
        name: { type: 'string', description: 'what=attr 时要读的属性名，例如 href' },
        limit: { type: 'integer', description: '最多返回多少字符，默认 6000（snapshot 默认 8000）' },
      },
      output: textOutput,
      presentCall: present('Read page'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const limit = Number(args.limit || (args.what === 'snapshot' ? 8000 : 6000))
        switch (args.what) {
          case 'snapshot': {
            return { text: await snapshot(call, tabId, { selector: args.selector || undefined, limit }) }
          }
          case 'text': {
            const r = await call('text', { tabId, selector: args.selector || undefined, limit })
            let text = r.text || ''
            // 整页读时把同源 iframe 里的字接在后面（innerText 不含框架内容）；跨站的给一行提示
            if (!args.selector) {
              for (const f of await frameTexts(call, tabId).catch(() => [])) {
                text += f.cross
                  ? `\n\n[iframe] ${f.src}（跨站框架，读不到里面的字：browser_screenshot 看）`
                  : f.text ? `\n\n[iframe] ${f.src}\n${f.text}` : ''
              }
            }
            return { text: clip(text.trim(), limit) || '(页面没有可见文字)' }
          }
          case 'html': {
            const r = await call('html', { tabId, selector: args.selector || 'body', limit })
            return { text: clip(r.html, limit) }
          }
          case 'attr': {
            if (!args.selector || !args.name) throw new Error('what=attr 需要 selector 和 name')
            const r = await call('attr', { tabId, selector: args.selector, name: args.name })
            return { text: r.value === null ? '(没有这个属性)' : String(r.value) }
          }
          case 'info': {
            const r = await call('info', { tabId })
            const v = r.viewport ? ` | 视口 ${r.viewport.w}×${r.viewport.h}，已滚动 ${r.viewport.scrollY}px` : ''
            const d = r.pendingDialog
              ? `\n⚠️ 有 ${r.pendingDialog.type} 弹窗挡着：「${r.pendingDialog.message}」——先调 browser_dialog 放行`
              : ''
            return { text: `${r.title}\n${r.url}${v}${d}` }
          }
          default:
            throw new Error(`不认识的 what: ${args.what}`)
        }
      },
    }),

    // ── 点击 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_click',
      description:
        '在页面里点击。最稳的是 ref（browser_read what=snapshot 给的编号）；其次 selector 或 text（按文字找元素），' +
        '都不行再退回坐标 x/y。' +
        '发的是真实鼠标事件（能触发新窗口、弹窗、焦点），不是 JS 假点击。点击时用户屏幕上会出现一个小光标。',
      parameters: {
        tab: { type: 'string', description: TAB_DESC },
        ref: { type: 'integer', description: REF_DESC },
        selector: { type: 'string', description: 'CSS 选择器' },
        text: { type: 'string', description: '按可见文字找元素并点击（比 selector 更耐改版）' },
        x: { type: 'integer', description: '视口坐标 X（配合 y）' },
        y: { type: 'integer', description: '视口坐标 Y（配合 x）' },
        count: { type: 'integer', description: '点击次数，默认 1（2 = 双击）' },
      },
      output: textOutput,
      presentCall: present('Browser click'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        await emulateFocus(tabId)
        const count = Number(args.count || 1)
        if (args.ref !== undefined && args.ref !== null) {
          const el = await locate(call, tabId, args.ref, { wantPoint: count > 1 })
          if (el.selector && count === 1) {
            const r = await call('clickEl', { tabId, selector: el.selector, ...withCursor() })
            return { text: `已点击 [${args.ref}] ${r.target.tag}「${r.target.text}」@ (${r.x}, ${r.y})` }
          }
          // shadow DOM / iframe 里的元素（选择器够不着），或者要双击：按坐标点
          const r = await call('click', { tabId, x: el.x, y: el.y, clickCount: count, ...withCursor() })
          return { text: `已点击 [${args.ref}] ${el.tag}「${el.text}」@ (${r.x}, ${r.y})${count > 1 ? ` ×${count}` : ''}` }
        }
        if (args.selector) {
          const r = await call('clickEl', { tabId, selector: args.selector, ...withCursor() })
          return { text: `已点击 ${r.target.tag}「${r.target.text}」@ (${r.x}, ${r.y})` }
        }
        if (args.text) {
          const r = await call('clickText', { tabId, text: args.text, exact: false, ...withCursor() })
          return { text: `已点击 ${r.target.tag}「${r.target.text}」@ (${r.x}, ${r.y})` }
        }
        if (args.x !== undefined && args.y !== undefined) {
          const r = await call('click', { tabId, x: Number(args.x), y: Number(args.y), clickCount: count, ...withCursor() })
          return { text: `已点击坐标 (${r.x}, ${r.y})` }
        }
        throw new Error('要给出 ref、selector、text 或 x+y 之一')
      },
    }),

    // ── 输入 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_input',
      description:
        '往页面里输入：type 打字（可先用 selector 聚焦）、key 按键（含组合键如 meta+a）、' +
        'select 选下拉项、upload 塞文件、focus 聚焦、hover 悬停、scroll 滚动。',
      parameters: {
        action: {
          type: 'string', required: true, enum: ['type', 'key', 'select', 'upload', 'focus', 'hover', 'scroll'],
          description: '要做的输入动作',
        },
        tab: { type: 'string', description: TAB_DESC },
        text: { type: 'string', description: 'action=type 时要输入的文字' },
        ref: { type: 'integer', description: `${REF_DESC}；可代替 selector` },
        selector: { type: 'string', description: 'CSS 选择器（type 时先点它聚焦；select/upload/focus/hover 要它或 ref）' },
        key: { type: 'string', description: 'action=key 的按键，例如 Enter / Escape / "meta+a" / "ctrl+shift+k"' },
        value: { type: 'string', description: 'action=select 时要选的 value 或选项文字' },
        files: { type: 'array', items: { type: 'string' }, description: 'action=upload 的本地文件绝对路径（只限会话工作目录或系统临时目录下、非隐藏的文件）' },
        dy: { type: 'integer', description: 'action=scroll 的纵向滚动量，默认 600（向下为正）' },
        dx: { type: 'integer', description: 'action=scroll 的横向滚动量，默认 0' },
        x: { type: 'integer', description: 'action=hover 且不用 selector 时的视口 X 坐标' },
        y: { type: 'integer', description: 'action=hover 且不用 selector 时的视口 Y 坐标' },
      },
      output: textOutput,
      presentCall: present('Browser input'),
      async execute(args, exec) {
        const tabId = await resolveTab(args.tab)
        if (args.action !== 'scroll') await emulateFocus(tabId)
        // 有编号就先把它换成选择器；shadow DOM / iframe 里的元素换不成，下面各自按坐标/页内处理
        const hasRef = args.ref !== undefined && args.ref !== null &&
          ['type', 'select', 'upload', 'focus', 'hover'].includes(args.action)
        const el = hasRef ? await locate(call, tabId, args.ref) : null
        const selector = el ? el.selector : args.selector
        const target = hasRef ? `[${args.ref}]` : args.selector
        const noShadow = (what) => {
          if (el && el.shadow) throw new Error(`编号 ${args.ref} 在 shadow DOM 或 iframe 里，${what} 暂时不支持按编号——改用 browser_eval`)
        }
        switch (args.action) {
          case 'type': {
            if (args.text === undefined) throw new Error('action=type 需要 text')
            if (el && el.shadow) {
              await call('click', { tabId, x: el.x, y: el.y, ...withCursor() })
              const r = await call('type', { tabId, text: args.text })
              return { text: `已输入 ${r.typed} 个字符（先点了 ${target}）` }
            }
            const r = await call('type', { tabId, text: args.text, selector: selector || undefined, ...withCursor() })
            return { text: `已输入 ${r.typed} 个字符${selector ? `（先聚焦了 ${target}）` : ''}` }
          }
          case 'key': {
            if (!args.key) throw new Error('action=key 需要 key')
            await call('key', { tabId, key: args.key })
            return { text: `已按键 ${args.key}` }
          }
          case 'select': {
            if (!selector && !el) throw new Error('action=select 需要 ref 或 selector')
            if (args.value === undefined) throw new Error('action=select 需要 value')
            if (el && el.shadow) {
              const r = await selectInPage(call, tabId, args.ref, args.value)
              return { text: `已选择「${r.label}」(${r.value})` }
            }
            const r = await call('select', { tabId, selector, value: args.value })
            return { text: `已选择「${r.label}」(${r.value})` }
          }
          case 'upload': {
            if (!selector && !el) throw new Error('action=upload 需要 ref 或 selector')
            if (!args.files?.length) throw new Error('action=upload 需要 files')
            noShadow('upload')
            const files = uploadable(args.files, sessionCwd(exec))
            const r = await call('upload', { tabId, selector, files })
            return { text: `已把 ${r.files.length} 个文件塞进 ${target}` }
          }
          case 'focus': {
            if (!selector && !el) throw new Error('action=focus 需要 ref 或 selector')
            if (el && el.shadow) await focusShadow(call, tabId, args.ref)
            else await call('focus', { tabId, selector })
            return { text: `已聚焦 ${target}` }
          }
          case 'hover': {
            const byPoint = el && el.shadow
            if (!selector && !byPoint && (args.x === undefined || args.y === undefined)) {
              throw new Error('action=hover 需要 ref 或 selector，或者给 x/y 坐标')
            }
            const r = await call('hover', {
              tabId,
              x: byPoint ? el.x : selector ? undefined : Number(args.x),
              y: byPoint ? el.y : selector ? undefined : Number(args.y),
              selector: byPoint ? undefined : selector || undefined,
              ...withCursor(),
            })
            return { text: `已悬停 @ (${r.x}, ${r.y})${r.target ? ` ${r.target.tag}「${r.target.text}」` : ''}` }
          }
          case 'scroll': {
            const r = await call('scroll', { tabId, deltaY: Number(args.dy ?? 600), deltaX: Number(args.dx || 0) })
            return { text: `已滚动 ${r.deltaY}px，当前 scrollY=${r.scrollY} / 页高 ${r.pageHeight}` }
          }
          default:
            throw new Error(`不认识的 action: ${args.action}`)
        }
      },
    }),

    // ── 导航 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_nav',
      description: '跳到某个网址（action=go，默认），或者 back 后退、forward 前进、reload 刷新。都会等页面加载完。',
      parameters: {
        action: {
          type: 'string', enum: ['go', 'back', 'forward', 'reload'],
          description: 'go 跳到 url（默认）；back / forward / reload 不用给 url',
        },
        url: { type: 'string', description: 'action=go 时的目标网址' },
        tab: { type: 'string', description: TAB_DESC },
      },
      output: textOutput,
      presentCall: present('Browser navigate'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const action = args.action || 'go'
        if (action === 'go') {
          if (!args.url) throw new Error('action=go 需要 url')
          const r = await call('nav', { tabId, url: args.url, wait: true }, 60000)
          const late = r.loaded === false ? '（页面还没加载完，需要的话 browser_wait 等一下）' : ''
          return { text: `已到 ${r.url}${r.title ? ` — ${r.title}` : ''}${late}` }
        }
        const r = await historyNav(call, tabId, action)
        const verb = { back: '已后退到', forward: '已前进到', reload: '已刷新' }[action]
        if (!verb) throw new Error(`不认识的 action: ${action}`)
        const late = r.done ? '' : '（页面还没加载完，需要的话 browser_wait 等一下）'
        return { text: `${verb} ${r.url}${r.title ? ` — ${r.title}` : ''}${late}` }
      },
    }),

    // ── 截图 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_screenshot',
      description:
        '给页面截图，图片会直接返回给你看。mode=viewport 当前视口、full 整页、element 只截某个元素（要 ref 或 selector）。' +
        '页内光标会一起入镜，所以你能和用户看到同一画面。',
      parameters: {
        mode: { type: 'string', required: true, enum: ['viewport', 'full', 'element'], description: '截多大范围' },
        tab: { type: 'string', description: TAB_DESC },
        ref: { type: 'integer', description: `mode=element 时截哪个元素：${REF_DESC}` },
        selector: { type: 'string', description: 'mode=element 时截哪个元素（CSS 选择器）' },
        format: { type: 'string', description: 'png（默认）或 jpeg' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            token: { type: 'string' },
          },
          required: ['text', 'token'],
        },
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: value.text }]
          const ref = shotRefs.get(value.token)
          if (ref) {
            shotRefs.delete(value.token)
            blocks.push({ type: 'image', attachment: ref })
          }
          return blocks
        },
      },
      presentCall: present('Browser screenshot'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const format = args.format === 'jpeg' ? 'jpeg' : 'png'
        let r
        if (args.mode === 'element') {
          const hasRef = args.ref !== undefined && args.ref !== null
          if (!hasRef && !args.selector) throw new Error('mode=element 需要 ref 或 selector')
          // 自己取框再直接截：扩展的 shot(selector) 取框只等 rAF，后台标签页里会卡满 15 秒
          const box = await elementBox(call, tabId, { ref: hasRef ? args.ref : undefined, selector: args.selector })
          if (!box || box.width < 1 || box.height < 1) throw new Error('这个元素没有大小（可能被隐藏了），截不了')
          const shot = await call('cdp', {
            tabId, method: 'Page.captureScreenshot', params: { format, clip: { ...box, scale: 1 } },
          }, 90000)
          const t = (await call('tabs')).find((x) => x.id === tabId)
          r = { data: shot.result.data, format, url: t && t.url, title: t && t.title }
        } else {
          r = await call('shot', { tabId, format, full: args.mode === 'full' }, 90000)
        }

        const buf = Buffer.from(r.data, 'base64')
        const where = `${r.title || ''} ${r.url || ''}`.trim()
        const note = `截图（${args.mode}，${Math.round(buf.length / 1024)}KB）— ${where}`

        const attachments = ctx.get('attachments')
        if (attachments) {
          try {
            const fmt = String(args.format || r.format || 'png').toLowerCase()
            const isJpeg = fmt === 'jpeg' || fmt === 'jpg'
            const [ref] = await attachments.saveImages([{
              data: buf,
              mediaType: isJpeg ? 'image/jpeg' : 'image/png',
              name: `page-${Date.now()}.${isJpeg ? 'jpg' : 'png'}`,
            }])
            const token = crypto.randomUUID()
            shotRefs.set(token, ref)
            if (shotRefs.size > 20) shotRefs.delete(shotRefs.keys().next().value)
            return { text: note, token }
          } catch {
            // 存不进附件库就退回文件，别让截图功能整个挂掉
          }
        }
        const file = path.join(os.tmpdir(), `dsh-shot-${Date.now()}.${String(args.format || '').toLowerCase().startsWith('j') ? 'jpg' : 'png'}`)
        fs.writeFileSync(file, buf)
        return { text: `${note}\n（附件库不可用，已存到 ${file}，可以用 read_image 看）`, token: '' }
      },
    }),

    // ── 跑 JS ───────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_eval',
      description:
        '在页面里执行一段 JS 并拿到返回值。适合读选择器拿不到的状态、检查 DOM、触发页面自己的函数。' +
        '返回值会被 JSON 序列化。注意：它跑在页面上下文里，别用它点击（用 browser_click）。',
      parameters: {
        expression: { type: 'string', required: true, description: '要执行的 JS 表达式；多语句请包成 IIFE 并 return' },
        tab: { type: 'string', description: TAB_DESC },
      },
      output: textOutput,
      presentCall: present('Browser eval'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const r = await call('eval', { tabId, expression: args.expression })
        const v = r.value
        return { text: typeof v === 'string' ? clip(v) : clip(JSON.stringify(v, null, 2) ?? 'undefined') }
      },
    }),

    // ── 等元素 ──────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_wait',
      description:
        '等页面变成某个样子再往下走，比 sleep 靠谱。三选一：selector 等元素出现（且可见）、' +
        'text 等页面上出现某段文字、url 等网址包含某段（跳转/登录后用）。gone=true 反过来等它消失（比如加载圈）。',
      parameters: {
        selector: { type: 'string', description: 'CSS 选择器' },
        text: { type: 'string', description: '页面可见文字里要出现的一段' },
        url: { type: 'string', description: '网址里要包含的一段' },
        gone: { type: 'boolean', description: 'true = 等它消失，默认 false' },
        tab: { type: 'string', description: TAB_DESC },
        timeoutMs: { type: 'integer', description: `超时毫秒，默认 15000，最多 ${WAIT_MAX_MS}` },
      },
      output: textOutput,
      presentCall: present('Browser wait'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const timeoutMs = Math.min(Number(args.timeoutMs || 15000), WAIT_MAX_MS)
        const has = (v) => v !== undefined && v !== null && v !== ''
        const given = [args.selector, args.text, args.url].filter(has).length
        if (given !== 1) throw new Error('selector / text / url 给且只给一个')
        if (has(args.selector) && !args.gone) {
          const r = await call('waitFor', { tabId, selector: args.selector, timeoutMs, visible: true }, timeoutMs + 15000)
          return { text: `等到了 ${args.selector} @ (${r.x}, ${r.y})「${r.text}」，用了 ${r.waitedMs}ms` }
        }
        const text = await waitUntil(call, tabId, {
          selector: has(args.selector) ? args.selector : undefined,
          text: has(args.text) ? args.text : undefined,
          url: has(args.url) ? args.url : undefined,
          gone: !!args.gone,
          timeoutMs,
        })
        return { text }
      },
    }),

    // ── 弹窗 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_dialog',
      description:
        '处理 alert / confirm / prompt 弹窗。弹窗会把页面里后续所有操作卡死，所以 browser_read(what=info) 报有弹窗时先调它。',
      parameters: {
        action: { type: 'string', required: true, enum: ['accept', 'dismiss'], description: 'accept 确定，dismiss 取消' },
        tab: { type: 'string', description: TAB_DESC },
        text: { type: 'string', description: 'prompt 弹窗要填的内容' },
      },
      output: textOutput,
      presentCall: present('Browser dialog'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const r = await call('dialog', { tabId, action: args.action, text: args.text || undefined })
        return { text: r.action === 'accept' ? '已放行弹窗' : '已取消弹窗' }
      },
    }),

    // ── 拖拽 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_drag',
      description:
        '把一个东西拖到另一个地方：排序列表、看板卡片、滑块、拖文件进框、画布等。' +
        '起点和终点各用 ref（snapshot 编号）、selector、text（可见文字）或 x/y 坐标给一个；' +
        '放置区（「拖到这里」那种框）一般没编号，用 toText 按文字找最省事。' +
        '带 draggable 的 HTML5 拖放和靠鼠标拖的组件都能处理，拖完截图或读页面确认一下结果。',
      parameters: {
        tab: { type: 'string', description: TAB_DESC },
        fromRef: { type: 'integer', description: `起点：${REF_DESC}` },
        fromSelector: { type: 'string', description: '起点：CSS 选择器' },
        fromText: { type: 'string', description: '起点：按可见文字找元素' },
        fromX: { type: 'integer', description: '起点：视口 X 坐标（配合 fromY）' },
        fromY: { type: 'integer', description: '起点：视口 Y 坐标' },
        toRef: { type: 'integer', description: '终点：元素编号' },
        toSelector: { type: 'string', description: '终点：CSS 选择器' },
        toText: { type: 'string', description: '终点：按可见文字找元素（找放置区最好用）' },
        toX: { type: 'integer', description: '终点：视口 X 坐标（配合 toY）' },
        toY: { type: 'integer', description: '终点：视口 Y 坐标' },
        steps: { type: 'integer', description: '鼠标拖动分几步走完，默认 12（滑块要细一点可以调大）' },
      },
      output: textOutput,
      presentCall: present('Browser drag'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const end = (p) => {
          const ref = args[`${p}Ref`]
          if (ref !== undefined && ref !== null) return { ref: Number(ref) }
          if (args[`${p}Selector`]) return { selector: args[`${p}Selector`] }
          if (args[`${p}Text`]) return { text: args[`${p}Text`] }
          const x = args[`${p}X`]
          const y = args[`${p}Y`]
          if (x !== undefined && x !== null && y !== undefined && y !== null) return { x: Number(x), y: Number(y) }
          throw new Error(`${p === 'from' ? '起点' : '终点'}要给 ${p}Ref、${p}Selector、${p}Text 或 ${p}X+${p}Y 之一`)
        }
        const from = end('from')
        const to = end('to')
        await emulateFocus(tabId)
        // 页内光标跟着走，让用户看得见在拖什么（脚本每次都带，扩展那边注入过就不再执行）
        const script = cursorScript()
        const cursor = script
          ? {
            move: async (x, y, o = {}) => (await call('cursor', {
              tabId, action: 'move', x: Math.round(x), y: Math.round(y), duration: o.duration, straight: o.straight, text: o.label, script,
            })).duration,
            down: () => call('cursor', { tabId, action: 'down', script }),
            up: () => call('cursor', { tabId, action: 'up', script }),
          }
          : undefined
        return { text: await drag(call, tabId, from, to, { steps: args.steps, cursor }) }
      },
    }),

    // ── 下载 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_download',
      description:
        '把链接指向的文件（发票、报表、PDF、图片……）下载到本机，带着用户在 Chrome 里的登录状态。' +
        '给 ref（snapshot 里的链接编号）、selector 或 url 三选一；相对地址按页面算，blob: / data: 链接也行。' +
        '默认存进「下载」文件夹，to=workdir 存进会话工作目录；同名不覆盖，自动加 (1)。' +
        '下载按钮不是链接（点了才生成文件）的话：先 browser_click 它，再用 browser_devtools action=network 找到文件网址，交给这里。',
      parameters: {
        ref: { type: 'integer', description: REF_DESC },
        selector: { type: 'string', description: 'CSS 选择器（指向 a / img / video / source 等带地址的元素）' },
        url: { type: 'string', description: '要下载的网址，可以是相对地址' },
        tab: { type: 'string', description: TAB_DESC },
        filename: { type: 'string', description: '存成什么名字；省略时用服务器给的名字或网址里的名字' },
        to: { type: 'string', enum: ['downloads', 'workdir'], description: 'downloads（默认）存进「下载」文件夹；workdir 存进会话工作目录' },
      },
      output: textOutput,
      presentCall: present('Download file'),
      async execute(args, exec) {
        const tabId = await resolveTab(args.tab)
        let dir = downloadsDir()
        if (args.to === 'workdir') {
          dir = sessionCwd(exec)
          if (!dir) throw new Error('拿不到会话工作目录，去掉 to=workdir 存进「下载」文件夹')
        }
        const r = await download(call, tabId, {
          url: args.url || undefined,
          ref: args.ref ?? undefined,
          selector: args.selector || undefined,
          filename: args.filename || undefined,
          dir,
        })
        const type = (r.type || '').split(';')[0].trim()
        const warn = /^text\/html/i.test(type)
          ? '\n⚠️ 下到的是网页（text/html），多半是登录页或「下载即将开始」的中转页，不是文件本身：打开看看，或者换成真正的文件链接'
          : ''
        return { text: `已下载：${r.file}（${humanSize(r.size)}${type ? `，${type}` : ''}）${warn}` }
      },
    }),

    // ── 调试：控制台 / 网络 ──────────────────────────────────────────────────
    defineTool({
      name: 'browser_devtools',
      description:
        '像开发者工具那样查网页：console 看控制台输出和 JS 报错；network 看网络请求（状态码、耗时）；' +
        'response 看某个请求的返回内容（接口返回的 JSON 等）；clear 清空这个标签页的记录。' +
        '页面「点了没反应」「数据没出来」「白屏」时先查这里。',
      parameters: {
        action: {
          type: 'string', required: true, enum: ['console', 'network', 'response', 'clear'],
          description: '要看什么',
        },
        tab: { type: 'string', description: TAB_DESC },
        level: {
          type: 'string', enum: ['all', 'warning', 'error'],
          description: 'action=console：error 只看报错，warning 报错+警告，默认 all',
        },
        filter: { type: 'string', description: 'console/network：只留包含这段文字的条目（网址、方法、内容都算）' },
        reload: {
          type: 'boolean',
          description: 'action=network：先刷新页面，抓到加载过程的全部请求（只记得到调试器接上之后的请求）',
        },
        request: { type: 'string', description: 'action=response：network 列表里 # 后面的编号' },
        limit: { type: 'integer', description: 'console/network 最多几条（默认 40）；response 最多几个字（默认 6000）' },
      },
      output: textOutput,
      presentCall: present('Browser devtools'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const limit = args.limit ? Number(args.limit) : undefined
        switch (args.action) {
          case 'console':
            return { text: await consoleLog(call, tabId, { level: args.level || 'all', filter: args.filter, limit }) }
          case 'network':
            return { text: await networkLog(call, tabId, { filter: args.filter, reload: !!args.reload, limit }) }
          case 'response':
            return { text: await responseBody(call, tabId, args.request, limit) }
          case 'clear':
            return { text: await clearLogs(call, tabId) }
          default:
            throw new Error(`不认识的 action: ${args.action}`)
        }
      },
    }),
  ]

  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
    } catch (e) {
      trace(`注册 ${tool.name} 失败: ${e && e.message}`)
      throw e
    }
  }
  trace(`已注册 ${tools.length} 个工具: ${tools.map((t) => t.name).join(', ')}`)

  // 上游报「图片太多」时卸掉最老的几张再重试（见 image-guard.js）
  installImageGuard(ctx, trace)
}

trace('模块已加载')


