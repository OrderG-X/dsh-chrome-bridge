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

/**
 * 这里刻意不 import 任何外部包——不碰 `@deepseek-ai/dsh-tools`。
 *
 * 原因：profile 上下文里那个包解析不到（裸 node 实测 ERR_MODULE_NOT_FOUND），
 * 一旦解析失败，整个插件模块加载失败、行直接挂掉，而且错误只留在 app 进程里，
 * 外面完全看不到。所以工具对象在这里按 dsh-tools 的产出形状手搓：
 *   parameters —— 属性表编译成 JSON Schema（等价 parameterSchemaSpecToJsonSchema）
 *   output     —— { schema, render }，schema 直接写成 JSON Schema
 */

const TRACE = '/tmp/dsh-browser-bridge.log'
function trace(line) {
  try { fs.appendFileSync(TRACE, `${new Date().toISOString()} ${line}\n`) } catch {}
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

/** 等价于 dsh-tools 的 defineTool（只用它的产出形状，不依赖它） */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: specToJsonSchema(options.parameters),
    output: { schema: options.output.schema, render: options.output.render },
    ...(options.presentCall ? { presentCall: options.presentCall } : {}),
    execute: options.execute,
  }
}

export const name = 'browser-bridge'
export const inject = ['tools']

const SOCK = process.env.DSH_BRIDGE_SOCK || '/tmp/dsh-bridge.sock'
const TOKEN_FILE = process.env.DSH_BRIDGE_TOKEN || '/tmp/dsh-bridge.token'
const HINT = '跑 `~/Projects/browser-agent-kit/bridge status` 看看宿主和扩展状态'

// ── 与宿主通话 ──────────────────────────────────────────────────────────────

/** 一次请求一个连接，协议是换行分隔的 JSON（和 cb CLI 完全一致）。 */
function call(op, args = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let token = null
    try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch {}
    if (!fs.existsSync(SOCK)) {
      return reject(new Error(`浏览器桥没在跑（找不到 ${SOCK}）：Chrome 没开，或扩展没装。${HINT}`))
    }
    const id = crypto.randomUUID()
    const sock = net.connect(SOCK)
    let acc = ''
    let done = false
    const finish = (fn, v) => { if (!done) { done = true; try { sock.destroy() } catch {}; fn(v) } }
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ token, id, op, args }) + '\n'))
    sock.on('data', (d) => {
      acc += d
      const i = acc.indexOf('\n')
      if (i < 0) return
      let msg
      try { msg = JSON.parse(acc.slice(0, i)) } catch { return finish(reject, new Error('宿主回了坏 JSON')) }
      if (msg.ok) finish(resolve, msg.result)
      else finish(reject, new Error(msg.error || '未知错误'))
    })
    sock.on('error', (e) => finish(reject, new Error(`连不上浏览器桥：${e.message}。${HINT}`)))
    sock.on('close', () => finish(reject, new Error('浏览器桥连接被关掉了')))
    setTimeout(() => finish(reject, new Error(`等浏览器桥超时（${timeoutMs}ms）`)), timeoutMs)
  })
}

/** tab 参数：数字 id 或 'active'（省略时按 active 处理）。 */
async function resolveTab(tab) {
  if (tab !== undefined && tab !== null && tab !== '' && String(tab) !== 'active') return Number(tab)
  const tabs = await call('tabs')
  const active = tabs.find((t) => t.active)
  if (!active) throw new Error('没有活动标签页')
  return active.id
}

/** 页内光标脚本：点东西时让用户看得见。读不到就静默降级。 */
let cursorCache
function cursorScript() {
  if (cursorCache !== undefined) return cursorCache
  const file = path.join(os.homedir(), '.dsh/chrome-cursor/in-page-cursor.js')
  try { cursorCache = fs.readFileSync(file, 'utf8') } catch { cursorCache = '' }
  return cursorCache
}
const withCursor = (extra = {}) => {
  const script = cursorScript()
  return script ? { ...extra, script } : extra
}

const clip = (s, n = 6000) => (s.length > n ? s.slice(0, n) + `\n…（截断，全文 ${s.length} 字）` : s)

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

const TAB_DESC = '标签页 id（数字），或 "active" 表示当前活动标签页；省略等于 active'
const present = (title) => (args) => ({ card: 'generic', title, kind: 'other', rawInput: args })

// ── 截图：把图直接给模型看 ──────────────────────────────────────────────────

/** render 是同步的，所以 execute 把附件引用存在这里，render 取出来用。 */
const shotRefs = new Map()

export function apply(ctx, config) {
  trace('apply 被调用')
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
            return { text: `已打开标签页 ${r.tabId}：${r.url}` }
          }
          case 'close': {
            const tabId = await resolveTab(args.tab)
            await call('close', { tabId })
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
        '读页面内容。what=text 取可见文字（最常用，抓内容首选）；html 取外层 HTML；' +
        'attr 取某个属性；info 取标题/URL/视口，并会告诉你有没有 alert 弹窗挡着（挡着的话先调 browser_dialog）。',
      parameters: {
        what: { type: 'string', required: true, enum: ['text', 'html', 'attr', 'info'], description: '读什么' },
        tab: { type: 'string', description: TAB_DESC },
        selector: { type: 'string', description: 'CSS 选择器；text/html 省略时取整页/body' },
        name: { type: 'string', description: 'what=attr 时要读的属性名，例如 href' },
        limit: { type: 'integer', description: '最多返回多少字符，默认 6000' },
      },
      output: textOutput,
      presentCall: present('Read page'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const limit = Number(args.limit || 6000)
        switch (args.what) {
          case 'text': {
            const r = await call('text', { tabId, selector: args.selector || undefined, limit })
            return { text: clip(r.text, limit) || '(页面没有可见文字)' }
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
        '在页面里点击。优先用 selector 或 text（按文字找元素），找不到再退回坐标 x/y。' +
        '发的是真实鼠标事件（能触发新窗口、弹窗、焦点），不是 JS 假点击。点击时用户屏幕上会出现一个小光标。',
      parameters: {
        tab: { type: 'string', description: TAB_DESC },
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
        if (args.selector) {
          const r = await call('clickEl', { tabId, selector: args.selector, ...withCursor() })
          return { text: `已点击 ${r.target.tag}「${r.target.text}」@ (${r.x}, ${r.y})` }
        }
        if (args.text) {
          const r = await call('clickText', { tabId, text: args.text, exact: false, ...withCursor() })
          return { text: `已点击 ${r.target.tag}「${r.target.text}」@ (${r.x}, ${r.y})` }
        }
        if (args.x !== undefined && args.y !== undefined) {
          const r = await call('click', { tabId, x: Number(args.x), y: Number(args.y), clickCount: Number(args.count || 1), ...withCursor() })
          return { text: `已点击坐标 (${r.x}, ${r.y})` }
        }
        throw new Error('要给出 selector、text 或 x+y 之一')
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
        selector: { type: 'string', description: 'CSS 选择器（type 时先点它聚焦；select/upload/focus/hover 必需）' },
        key: { type: 'string', description: 'action=key 的按键，例如 Enter / Escape / "meta+a" / "ctrl+shift+k"' },
        value: { type: 'string', description: 'action=select 时要选的 value 或选项文字' },
        files: { type: 'array', items: { type: 'string' }, description: 'action=upload 的本地文件绝对路径' },
        dy: { type: 'integer', description: 'action=scroll 的纵向滚动量，默认 600（向下为正）' },
        dx: { type: 'integer', description: 'action=scroll 的横向滚动量，默认 0' },
      },
      output: textOutput,
      presentCall: present('Browser input'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        switch (args.action) {
          case 'type': {
            if (args.text === undefined) throw new Error('action=type 需要 text')
            const r = await call('type', { tabId, text: args.text, selector: args.selector || undefined, ...withCursor() })
            return { text: `已输入 ${r.typed} 个字符${args.selector ? `（先聚焦了 ${args.selector}）` : ''}` }
          }
          case 'key': {
            if (!args.key) throw new Error('action=key 需要 key')
            await call('key', { tabId, key: args.key })
            return { text: `已按键 ${args.key}` }
          }
          case 'select': {
            if (!args.selector || args.value === undefined) throw new Error('action=select 需要 selector 和 value')
            const r = await call('select', { tabId, selector: args.selector, value: args.value })
            return { text: `已选择「${r.label}」(${r.value})` }
          }
          case 'upload': {
            if (!args.selector || !args.files?.length) throw new Error('action=upload 需要 selector 和 files')
            const r = await call('upload', { tabId, selector: args.selector, files: args.files })
            return { text: `已把 ${r.files.length} 个文件塞进 ${r.selector}` }
          }
          case 'focus': {
            if (!args.selector) throw new Error('action=focus 需要 selector')
            await call('focus', { tabId, selector: args.selector })
            return { text: `已聚焦 ${args.selector}` }
          }
          case 'hover': {
            const r = await call('hover', { tabId, x: Number(args.dx || 0), y: Number(args.dy || 0), selector: args.selector || undefined })
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
      description: '让某个标签页跳到指定网址，默认等页面加载完成。',
      parameters: {
        url: { type: 'string', required: true, description: '目标网址' },
        tab: { type: 'string', description: TAB_DESC },
      },
      output: textOutput,
      presentCall: present('Browser navigate'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const r = await call('nav', { tabId, url: args.url, wait: true }, 60000)
        return { text: `已到 ${r.url}${r.title ? ` — ${r.title}` : ''}` }
      },
    }),

    // ── 截图 ────────────────────────────────────────────────────────────────
    defineTool({
      name: 'browser_screenshot',
      description:
        '给页面截图，图片会直接返回给你看。mode=viewport 当前视口、full 整页、element 只截某个元素（要 selector）。' +
        '页内光标会一起入镜，所以你能和用户看到同一画面。',
      parameters: {
        mode: { type: 'string', required: true, enum: ['viewport', 'full', 'element'], description: '截多大范围' },
        tab: { type: 'string', description: TAB_DESC },
        selector: { type: 'string', description: 'mode=element 时截哪个元素' },
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
        if (args.mode === 'element' && !args.selector) throw new Error('mode=element 需要 selector')
        const r = await call('shot', {
          tabId,
          format: args.format === 'jpeg' ? 'jpeg' : 'png',
          full: args.mode === 'full',
          selector: args.mode === 'element' ? args.selector : undefined,
        }, 90000)

        const buf = Buffer.from(r.data, 'base64')
        const where = `${r.title || ''} ${r.url || ''}`.trim()
        const note = `截图（${args.mode}，${Math.round(buf.length / 1024)}KB）— ${where}`

        const attachments = ctx.get('attachments')
        if (attachments) {
          try {
            const [ref] = await attachments.saveImages([{
              data: buf, mediaType: 'image/png', name: `page-${Date.now()}.png`,
            }])
            const token = crypto.randomUUID()
            shotRefs.set(token, ref)
            if (shotRefs.size > 20) shotRefs.delete(shotRefs.keys().next().value)
            return { text: note, token }
          } catch {
            // 存不进附件库就退回文件，别让截图功能整个挂掉
          }
        }
        const file = path.join(os.tmpdir(), `dsh-shot-${Date.now()}.png`)
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
      description: '等某个元素出现（默认还要可见）。页面异步渲染时用它，比 sleep 靠谱。',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS 选择器' },
        tab: { type: 'string', description: TAB_DESC },
        timeoutMs: { type: 'integer', description: '超时毫秒，默认 15000' },
      },
      output: textOutput,
      presentCall: present('Browser wait'),
      async execute(args) {
        const tabId = await resolveTab(args.tab)
        const timeoutMs = Number(args.timeoutMs || 15000)
        const r = await call('waitFor', { tabId, selector: args.selector, timeoutMs, visible: true }, timeoutMs + 15000)
        return { text: `等到了 ${args.selector} @ (${r.x}, ${r.y})「${r.text}」，用了 ${r.waitedMs}ms` }
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
}

trace('模块已加载')
