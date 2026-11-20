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
import { ensureInstalled, installHint, assistInstall, paths, extensionId, hostProbe } from './setup.js'
import { snapshot, locate, focusShadow, elementBox, selectInPage, frameTexts } from './refs.js'
import { consoleLog, networkLog, responseBody, clearLogs } from './devtools.js'
import { historyNav, waitUntil } from './nav.js'
import { PANEL_ROUTE, panelHandler } from './panel.js'
import { drag } from './drag.js'
import { download, downloadsDir, humanSize } from './download.js'
import { createT, DEFAULT_LOCALE, normalizeLocale } from './i18n/index.js'

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
    throw new Error(t('err.dirNotOwned', { dir }))
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
 * 工具描述 / 参数说明 / 报错文案的当前语言。apply 里按 config.locale 换掉；
 * 模块级的报错（call、resolveTab、uploadable 这些）也用同一个 t。
 * 默认 zh：没配 locale 的安装行为和以前逐字一致。
 */
let t = createT(DEFAULT_LOCALE)

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
    if (r.opened) notes.push(t('hint.extOpened', { store: r.store ? t('hint.extOpenedStore') : '' }))
    if (r.clipboard) notes.push(t('hint.copied', { how: WIN ? t('hint.copiedWin') : t('hint.copiedMac') }))
    return notes.length ? t('hint.notes', { notes: notes.join(t('hint.notesSep')) }) : ''
  } catch {
    return ''
  }
}

/** 报错时带上「还差哪一步」——宿主和 native 注册已由 setup.js 自动装好。 */
const HINT = () => installHint() + firstAid()

// ── 与宿主通话 ──────────────────────────────────────────────────────────────

/**
 * 一次请求一个连接，协议是换行分隔的 JSON（和 cb CLI 完全一致）。
 * quiet：后台自己问的（不是用户/模型要做的事）——出错不带「还差哪一步」，那里面会去打开扩展页、改剪贴板。
 */
function call(op, args = {}, timeoutMs = 60000, quiet = false) {
  const hint = () => (quiet ? '' : HINT())
  return new Promise((resolve, reject) => {
    const SOCK = hostSock()
    if (!hostUp()) {
      return reject(new Error(t('err.bridgeDown', { sock: SOCK || TOKEN_FILE, hint: hint() })))
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
      try { msg = JSON.parse(acc.slice(0, i)) } catch { return finish(reject, new Error(t('err.badJson'))) }
      if (msg.ok) finish(resolve, msg.result)
      else finish(reject, new Error(msg.error || t('err.unknownHostError')))
    })
    sock.on('error', (e) => finish(reject, new Error(t('err.connect', { message: e.message, hint: hint() }))))
    sock.on('close', () => finish(reject, new Error(t('err.closed'))))
    timer = setTimeout(() => finish(reject, new Error(t('err.timeout', { ms: `${timeoutMs}ms` }))), timeoutMs)
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

/**
 * 用户正在看的那一页。窗口不止一个时每个窗口都有一个 active：先挑用户最后在用的窗口里的，
 * 再挑不在 DSH 干活窗口里的。老扩展不给 focused / agentWindow，就退回第一个 active（以前的做法）。
 */
function userTab(tabs) {
  return tabs.find((t) => t.active && t.focused) ||
    tabs.find((t) => t.active && !t.agentWindow) ||
    tabs.find((t) => t.active)
}

async function resolveTab(tab) {
  if (tab !== undefined && tab !== null && tab !== '') {
    if (String(tab) === 'active') {
      const active = userTab(await call('tabs'))
      if (!active) throw new Error(t('err.noActiveTab'))
      rememberTab(active.id)
      return active.id
    }
    const id = Number(tab)
    if (!Number.isInteger(id)) throw new Error(t('err.badTab', { tab }))
    rememberTab(id)
    return id
  }
  const id = currentTab.get(sessionKey())
  if (id !== undefined) {
    if ((await call('tabs')).some((t) => t.id === id)) return id
    currentTab.delete(sessionKey())
  }
  throw new Error(t('err.noTab'))
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
 * 点击 / 按键让页面要选文件时，扩展已把系统的选文件窗口拦下、回一个 id。记在「会话 + 标签页」名下：
 * 之后这个会话 upload 不给目标就带着它去，别的会话拿不到（不会把文件塞进人家刚点开的框）。
 */
const chooserIds = new Map()
const chooserKey = (tabId) => `${sessionKey()}:${Number(tabId)}`

/** 点击 / 按键回话后面补的那句。老扩展不回 fileChooser，就什么也不加 */
function chooserNote(r, tabId) {
  const c = r && r.fileChooser
  if (!c) return ''
  if (c.unsupported) return '\n' + t('note.fileChooserUnsupported')
  if (c.folder) return '\n' + t('note.fileChooserFolder')
  chooserIds.set(chooserKey(tabId), c.id)
  return '\n' + t('note.fileChooser', { multi: c.mode === 'selectMultiple' ? t('note.fileChooserMulti') : '' })
}

/**
 * upload 的报错换成说得清的话：
 *   没开「允许访问文件网址」：新扩展报 FILE_ACCESS_OFF（带详情页地址），老扩展只回 CDP 的一句 Not allowed（issue #7）
 *   单选框给了多个文件 / 页面没在等选文件 / 用户自己已经选好 / 选文件夹的框（新扩展的记号）
 *   不给目标时老扩展的参数错（它不认这种用法）→ 还是「要 ref 或 selector」
 * 别的错原样抛。
 */
function uploadError(e, noTarget) {
  const msg = String(e && e.message || e)
  if (/FILE_ACCESS_OFF|Not allowed/.test(msg)) {
    const url = (/chrome:\/\/extensions\/\?id=[a-p]{32}/.exec(msg) || [])[0] || 'chrome://extensions'
    return new Error(t('err.fileAccessOff', { url }))
  }
  if (msg.includes('MULTI_NOT_ALLOWED')) return new Error(t('err.uploadSingle'))
  if (msg.includes('NO_FILE_CHOOSER')) return new Error(t('err.uploadNoChooser'))
  if (msg.includes('USER_PICKED')) return new Error(t('err.uploadUserPicked'))
  if (msg.includes('FOLDER_INPUT')) return new Error(t('err.uploadFolder'))
  if (noTarget && /params\.selector|mandatory field|Invalid parameters|没找到文件输入框/.test(msg)) return new Error(t('err.uploadNeedsTarget'))
  return e
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
    if (!path.isAbsolute(raw) && !cwd) throw new Error(t('err.uploadAbs', { path: raw }))
    const abs = path.resolve(cwd || '/', raw)
    let real
    try { real = fs.realpathSync(abs) } catch { throw new Error(t('err.uploadMissing', { path: raw })) }
    if (hidden(abs) || hidden(real)) throw new Error(t('err.uploadHidden', { path: raw }))
    if (!roots.some((r) => real.startsWith(r + path.sep))) {
      throw new Error(cwd ? t('err.uploadOutsideCwd', { cwd, path: raw }) : t('err.uploadOutside', { path: raw }))
    }
    if (!fs.statSync(real).isFile()) throw new Error(t('err.uploadNotFile', { path: raw }))
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

const present = (title) => (args) => ({ card: 'generic', title, kind: 'other', rawInput: args })

// ── 截图：把图直接给模型看 ──────────────────────────────────────────────────

/** render 是同步的，所以 execute 把附件引用存在这里，render 取出来用。 */
const shotRefs = new Map()

export function apply(ctx, config) {
  // 工具描述是写进模型上下文的那一层，注册那一刻就得是最终语言：
  // config.locale 给 en / ru，缺省或认不出就是 zh（见 i18n/index.js）。
  t = createT(config && config.locale)
  trace(`apply 被调用（locale: ${normalizeLocale(config && config.locale)}）`)

  // 一次性安装：宿主 + native 注册自动落地，用户只剩把扩展装进 Chrome（加载已解压，或商店装）
  try {
    // Windows 换旧宿主前问一下占着管道的宿主（DSH 和 cb 只连它）：是不是那个旧宿主、手上有没有活（见 hostProbe）。
    // 悄悄问：问不到不能去打开扩展页、改剪贴板
    const probe = hostProbe(() => call('status', {}, 5000, true))
    const s = ensureInstalled({ log: trace, probe })
    trace(s.ok ? `setup:${s.changed ? '已落盘' : '已是最新'} ext=${s.extId}` : `setup 跳过: ${s.reason}`)
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

  // 好几处参数说明共用这两段，按当前语言取一次
  const TAB = t('param.tab')
  const REF = t('param.ref')

  const tools = [
    // ── 标签页 ──────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_tabs',
      description: t('tool.tabs.desc'),
      parameters: {
        action: {
          type: 'string', required: true, enum: ['list', 'find', 'open', 'close', 'activate'],
          description: t('tool.tabs.action'),
        },
        query: { type: 'string', description: t('tool.tabs.query') },
        url: { type: 'string', description: t('tool.tabs.url') },
        tab: { type: 'string', description: t('tool.tabs.tab') },
      },
      output: textOutput,
      presentCall: present('Browser tabs'),
      async execute(args) {
        switch (args.action) {
          case 'list': {
            const tabs = await call('tabs')
            const mine = userTab(tabs)
            const lines = tabs.map((t) =>
              `${t === mine ? '*' : ' '} ${String(t.id).padStart(5)} ${(t.title || '').slice(0, 50)} — ${t.url.slice(0, 80)}${t.agentWindow ? '（DSH 干活窗口）' : ''}`)
            const text = lines.join('\n') || '(没有标签页)'
            return { text: lines.length ? `${text}\n（* = 用户正在看的页）` : text }
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
            if (!args.url) throw new Error(t('err.openNeedsUrl'))
            const r = await call('open', { url: args.url })
            rememberTab(r.tabId)
            const where = r.window === 'agent' ? '（在单独的 DSH 干活窗口里，后台打开，没打扰用户正在看的页）' : '（后台标签页）'
            return { text: `已打开标签页 ${r.tabId}${where}：${r.url}` }
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
            throw new Error(t('err.unknownAction', { action: args.action }))
        }
      },
    }),

    // ── 读页面 ──────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_read',
      description: t('tool.read.desc'),
      parameters: {
        what: { type: 'string', required: true, enum: ['snapshot', 'text', 'html', 'attr', 'info'], description: t('tool.read.what') },
        tab: { type: 'string', description: TAB },
        selector: { type: 'string', description: t('tool.read.selector') },
        name: { type: 'string', description: t('tool.read.name') },
        limit: { type: 'integer', description: t('tool.read.limit') },
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
            if (!args.selector || !args.name) throw new Error(t('err.attrNeeds'))
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
            throw new Error(t('err.unknownWhat', { what: args.what }))
        }
      },
    }),

    // ── 点击 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_click',
      description: t('tool.click.desc'),
      parameters: {
        tab: { type: 'string', description: TAB },
        ref: { type: 'integer', description: REF },
        selector: { type: 'string', description: t('tool.click.selector') },
        text: { type: 'string', description: t('tool.click.text') },
        x: { type: 'integer', description: t('tool.click.x') },
        y: { type: 'integer', description: t('tool.click.y') },
        count: { type: 'integer', description: t('tool.click.count') },
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
            const r = await call('clickEl', { tabId, selector: el.selector, ...withCursor(), chooser: true })
            return { text: `已点击 [${args.ref}] ${r.target.tag}「${r.target.text}」@ (${r.x}, ${r.y})${chooserNote(r, tabId)}` }
          }
          // shadow DOM / iframe 里的元素（选择器够不着），或者要双击：按坐标点
          const r = await call('click', { tabId, x: el.x, y: el.y, clickCount: count, ...withCursor(), chooser: true })
          return { text: `已点击 [${args.ref}] ${el.tag}「${el.text}」@ (${r.x}, ${r.y})${count > 1 ? ` ×${count}` : ''}${chooserNote(r, tabId)}` }
        }
        if (args.selector) {
          const r = await call('clickEl', { tabId, selector: args.selector, ...withCursor(), chooser: true })
          return { text: `已点击 ${r.target.tag}「${r.target.text}」@ (${r.x}, ${r.y})${chooserNote(r, tabId)}` }
        }
        if (args.text) {
          const r = await call('clickText', { tabId, text: args.text, exact: false, ...withCursor(), chooser: true })
          return { text: `已点击 ${r.target.tag}「${r.target.text}」@ (${r.x}, ${r.y})${chooserNote(r, tabId)}` }
        }
        if (args.x !== undefined && args.y !== undefined) {
          const r = await call('click', { tabId, x: Number(args.x), y: Number(args.y), clickCount: count, ...withCursor(), chooser: true })
          return { text: `已点击坐标 (${r.x}, ${r.y})${chooserNote(r, tabId)}` }
        }
        throw new Error(t('err.clickNeeds'))
      },
    }),

    // ── 输入 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_input',
      description: t('tool.input.desc'),
      parameters: {
        action: {
          type: 'string', required: true, enum: ['type', 'key', 'select', 'upload', 'focus', 'hover', 'scroll'],
          description: t('tool.input.action'),
        },
        tab: { type: 'string', description: TAB },
        text: { type: 'string', description: t('tool.input.text') },
        ref: { type: 'integer', description: t('tool.input.ref', { ref: REF }) },
        selector: { type: 'string', description: t('tool.input.selector') },
        key: { type: 'string', description: t('tool.input.key') },
        value: { type: 'string', description: t('tool.input.value') },
        files: { type: 'array', items: { type: 'string' }, description: t('tool.input.files') },
        dy: { type: 'integer', description: t('tool.input.dy') },
        dx: { type: 'integer', description: t('tool.input.dx') },
        x: { type: 'integer', description: t('tool.input.x') },
        y: { type: 'integer', description: t('tool.input.y') },
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
          if (el && el.shadow) throw new Error(t('err.shadowUnsupported', { ref: args.ref, action: what }))
        }
        switch (args.action) {
          case 'type': {
            if (args.text === undefined) throw new Error(t('err.typeNeedsText'))
            if (el && el.shadow) {
              await call('click', { tabId, x: el.x, y: el.y, ...withCursor() })
              const r = await call('type', { tabId, text: args.text })
              return { text: `已输入 ${r.typed} 个字符（先点了 ${target}）` }
            }
            const r = await call('type', { tabId, text: args.text, selector: selector || undefined, ...withCursor() })
            return { text: `已输入 ${r.typed} 个字符${selector ? `（先聚焦了 ${target}）` : ''}` }
          }
          case 'key': {
            if (!args.key) throw new Error(t('err.keyNeedsKey'))
            const r = await call('key', { tabId, key: args.key, chooser: true })
            return { text: `已按键 ${args.key}${chooserNote(r, tabId)}` }
          }
          case 'select': {
            if (!selector && !el) throw new Error(t('err.selectNeedsTarget'))
            if (args.value === undefined) throw new Error(t('err.selectNeedsValue'))
            if (el && el.shadow) {
              const r = await selectInPage(call, tabId, args.ref, args.value)
              return { text: `已选择「${r.label}」(${r.value})` }
            }
            const r = await call('select', { tabId, selector, value: args.value })
            return { text: `已选择「${r.label}」(${r.value})` }
          }
          case 'upload': {
            if (!args.files?.length) throw new Error(t('err.uploadNeedsFiles'))
            noShadow('upload')
            const files = uploadable(args.files, sessionCwd(exec))
            if (!selector && !el) {
              // 没给目标：塞给本会话刚才点击时拦下的那个选文件框（带着点击回话里的 id 去，扩展核对）
              const key = chooserKey(tabId)
              const used = chooserIds.get(key)
              let r
              try { r = await call('upload', { tabId, files, chooserId: used }) } catch (e) { throw uploadError(e, true) }
              if (!r || !r.chooser) throw new Error(t('err.uploadNeedsTarget'))
              // 等回包时这个会话可能又点开了新框（存了新 id）：只删这次用掉的
              if (chooserIds.get(key) === used) chooserIds.delete(key)
              return { text: `已把 ${r.files.length} 个文件交给页面刚才打开的选文件框` }
            }
            let r
            try { r = await call('upload', { tabId, selector, files }) } catch (e) { throw uploadError(e) }
            return { text: `已把 ${r.files.length} 个文件塞进 ${target}` }
          }
          case 'focus': {
            if (!selector && !el) throw new Error(t('err.focusNeedsTarget'))
            if (el && el.shadow) await focusShadow(call, tabId, args.ref)
            else await call('focus', { tabId, selector })
            return { text: `已聚焦 ${target}` }
          }
          case 'hover': {
            const byPoint = el && el.shadow
            if (!selector && !byPoint && (args.x === undefined || args.y === undefined)) {
              throw new Error(t('err.hoverNeedsTarget'))
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
            throw new Error(t('err.unknownAction', { action: args.action }))
        }
      },
    }),

    // ── 导航 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_nav',
      description: t('tool.nav.desc'),
      parameters: {
        action: {
          type: 'string', enum: ['go', 'back', 'forward', 'reload'],
          description: t('tool.nav.action'),
        },
        url: { type: 'string', description: t('tool.nav.url') },
        tab: { type: 'string', description: TAB },
      },
      output: textOutput,
      presentCall: present('Browser navigate'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const action = args.action || 'go'
        if (action === 'go') {
          if (!args.url) throw new Error(t('err.navNeedsUrl'))
          const r = await call('nav', { tabId, url: args.url, wait: true }, 60000)
          const late = r.loaded === false ? '（页面还没加载完，需要的话 browser_wait 等一下）' : ''
          return { text: `已到 ${r.url}${r.title ? ` — ${r.title}` : ''}${late}` }
        }
        const r = await historyNav(call, tabId, action)
        const verb = { back: '已后退到', forward: '已前进到', reload: '已刷新' }[action]
        if (!verb) throw new Error(t('err.unknownAction', { action }))
        const late = r.done ? '' : '（页面还没加载完，需要的话 browser_wait 等一下）'
        return { text: `${verb} ${r.url}${r.title ? ` — ${r.title}` : ''}${late}` }
      },
    }),

    // ── 截图 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_screenshot',
      description: t('tool.screenshot.desc'),
      parameters: {
        mode: { type: 'string', required: true, enum: ['viewport', 'full', 'element'], description: t('tool.screenshot.mode') },
        tab: { type: 'string', description: TAB },
        ref: { type: 'integer', description: t('tool.screenshot.ref', { ref: REF }) },
        selector: { type: 'string', description: t('tool.screenshot.selector') },
        format: { type: 'string', description: t('tool.screenshot.format') },
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
          if (!hasRef && !args.selector) throw new Error(t('err.shotNeedsTarget'))
          // 自己取框再直接截：扩展的 shot(selector) 取框只等 rAF，后台标签页里会卡满 15 秒
          const box = await elementBox(call, tabId, { ref: hasRef ? args.ref : undefined, selector: args.selector })
          if (!box || box.width < 1 || box.height < 1) throw new Error(t('err.shotZeroSize'))
          const capture = () => call('cdp', {
            tabId, method: 'Page.captureScreenshot', params: { format, clip: { ...box, scale: 1 } },
          }, 90000)
          // Edge 无头偶尔第一次带 clip 的截图一直不回（之后的都正常）：15 秒没回就再截一次，先发的那个结果不要了
          const first = capture()
          first.catch(() => {})
          let timer
          const late = new Promise((r) => { timer = setTimeout(r, 15000, null) })
          const shot = (await Promise.race([first, late]).finally(() => clearTimeout(timer))) || (await capture())
          const tabInfo = (await call('tabs')).find((x) => x.id === tabId)
          r = { data: shot.result.data, format, url: tabInfo && tabInfo.url, title: tabInfo && tabInfo.title }
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
      description: t('tool.eval.desc'),
      parameters: {
        expression: { type: 'string', required: true, description: t('tool.eval.expression') },
        tab: { type: 'string', description: TAB },
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
      description: t('tool.wait.desc'),
      parameters: {
        selector: { type: 'string', description: t('tool.wait.selector') },
        text: { type: 'string', description: t('tool.wait.text') },
        url: { type: 'string', description: t('tool.wait.url') },
        gone: { type: 'boolean', description: t('tool.wait.gone') },
        tab: { type: 'string', description: TAB },
        timeoutMs: { type: 'integer', description: t('tool.wait.timeoutMs', { max: WAIT_MAX_MS }) },
      },
      output: textOutput,
      presentCall: present('Browser wait'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const timeoutMs = Math.min(Number(args.timeoutMs || 15000), WAIT_MAX_MS)
        const has = (v) => v !== undefined && v !== null && v !== ''
        const given = [args.selector, args.text, args.url].filter(has).length
        if (given !== 1) throw new Error(t('err.waitNeedsOne'))
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
      description: t('tool.dialog.desc'),
      parameters: {
        action: { type: 'string', required: true, enum: ['accept', 'dismiss'], description: t('tool.dialog.action') },
        tab: { type: 'string', description: TAB },
        text: { type: 'string', description: t('tool.dialog.text') },
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
      description: t('tool.drag.desc'),
      parameters: {
        tab: { type: 'string', description: TAB },
        fromRef: { type: 'integer', description: t('tool.drag.fromRef', { ref: REF }) },
        fromSelector: { type: 'string', description: t('tool.drag.fromSelector') },
        fromText: { type: 'string', description: t('tool.drag.fromText') },
        fromX: { type: 'integer', description: t('tool.drag.fromX') },
        fromY: { type: 'integer', description: t('tool.drag.fromY') },
        toRef: { type: 'integer', description: t('tool.drag.toRef') },
        toSelector: { type: 'string', description: t('tool.drag.toSelector') },
        toText: { type: 'string', description: t('tool.drag.toText') },
        toX: { type: 'integer', description: t('tool.drag.toX') },
        toY: { type: 'integer', description: t('tool.drag.toY') },
        steps: { type: 'integer', description: t('tool.drag.steps') },
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
          throw new Error(t('err.dragNeedsEnd', {
            which: p === 'from' ? t('which.start') : t('which.end'),
            ref: `${p}Ref`, sel: `${p}Selector`, txt: `${p}Text`, xy: `${p}X+${p}Y`,
          }))
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
      description: t('tool.download.desc'),
      parameters: {
        ref: { type: 'integer', description: REF },
        selector: { type: 'string', description: t('tool.download.selector') },
        url: { type: 'string', description: t('tool.download.url') },
        tab: { type: 'string', description: TAB },
        filename: { type: 'string', description: t('tool.download.filename') },
        to: { type: 'string', enum: ['downloads', 'workdir'], description: t('tool.download.to') },
      },
      output: textOutput,
      presentCall: present('Download file'),
      async execute(args, exec) {
        const tabId = await resolveTab(args.tab)
        let dir = downloadsDir()
        if (args.to === 'workdir') {
          dir = sessionCwd(exec)
          if (!dir) throw new Error(t('err.noWorkdir'))
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
      description: t('tool.devtools.desc'),
      parameters: {
        action: {
          type: 'string', required: true, enum: ['console', 'network', 'response', 'clear'],
          description: t('tool.devtools.action'),
        },
        tab: { type: 'string', description: TAB },
        level: {
          type: 'string', enum: ['all', 'warning', 'error'],
          description: t('tool.devtools.level'),
        },
        filter: { type: 'string', description: t('tool.devtools.filter') },
        reload: {
          type: 'boolean',
          description: t('tool.devtools.reload'),
        },
        request: { type: 'string', description: t('tool.devtools.request') },
        limit: { type: 'integer', description: t('tool.devtools.limit') },
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
            throw new Error(t('err.unknownAction', { action: args.action }))
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


