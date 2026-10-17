/**
 * DSH Bridge — MV3 service worker
 *
 * 常驻连原生宿主（connectNative）。宿主由 Chrome 拉起，同时开一个 Unix socket
 * 给 DSH 的 `cb` CLI 用，于是 DSH 就能像原生工具一样操作你正在用的 Chrome。
 *
 * 关键点：
 *   - 不用点 Connect，装一次永久可用（service worker 自愈 + alarms 保活）
 *   - 所有点击/输入都走 CDP Input.* → 真实事件（有 userGesture，弹窗不被拦）
 *   - 大结果自动分片（native messaging 单条消息有上限）
 */

const HOST_NAME = 'com.dsh.bridge'
const CDP_VERSION = '1.3'
const RECONNECT_MS = 800
const CHUNK_CHARS = 200 * 1024 // 单条 native 消息正文上限（保守取值）

let port = null
let connecting = false

/** 已 attach CDP 的 tabId */
const attached = new Set()
/** 正在等待 loadEventFired 的 tabId → resolve */
const loadWaiters = new Map()
/** 分片接收缓冲：id → string[] */
const inbox = new Map()
/** SW 日志环（CLI 可读，免得去 chrome://extensions 开控制台） */
const LOG = []
const CONSOLE = []
/** 被 alert/confirm 挡住的标签页：tabId → {type, message} */
const dialogs = new Map()
/** 网络请求环形缓冲（Network 域在 attach 时就 enable 了） */
const NET = []
const netPending = new Map()
const NET_MAX = 400

function log(...args) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + args.map(a =>
    typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()
  ).join(' ')
  LOG.push(line)
  if (LOG.length > 400) LOG.shift()
  console.log(line)
}

// ── 与原生宿主的连接 ────────────────────────────────────────────────────────

function connect() {
  if (port || connecting) return
  connecting = true
  try {
    port = chrome.runtime.connectNative(HOST_NAME)
  } catch (e) {
    connecting = false
    log('connectNative 失败:', String(e))
    return
  }
  connecting = false

  port.onMessage.addListener((msg) => {
    if (msg && msg.id && msg.chunk) {
      const buf = inbox.get(msg.id) || []
      buf[msg.chunk.seq] = msg.data
      inbox.set(msg.id, buf)
      if (buf.filter(Boolean).length >= msg.chunk.total) {
        inbox.delete(msg.id)
        try { handle(JSON.parse(buf.join(''))) } catch (e) { log('重组失败:', String(e)) }
      }
      return
    }
    handle(msg)
  })

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    if (err) log('原生宿主断开:', err.message)
    port = null
    attached.clear()
    setTimeout(connect, RECONNECT_MS)
  })

  log('已连上原生宿主')
  // 主动报到：宿主靠它判断扩展是否在线（否则宿主刚起来时会误判"扩展未连接"）
  post({ hello: true, version: chrome.runtime.getManifest().version })
}

function post(msg) {
  if (!port) return false
  try {
    const s = JSON.stringify(msg)
    if (s.length <= CHUNK_CHARS) {
      port.postMessage(msg)
      return true
    }
    const total = Math.ceil(s.length / CHUNK_CHARS)
    for (let i = 0; i < total; i++) {
      port.postMessage({ id: msg.id, chunk: { seq: i, total }, data: s.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) })
    }
    return true
  } catch (e) {
    log('postMessage 失败:', String(e))
    return false
  }
}

/** 把 CDP 的英文报错翻成人能用的提示 */
function friendly(e) {
  const m = String((e && e.message) || e)
  if (m.includes('chrome://') || m.includes('Cannot access a chrome')) {
    return new Error('这个标签页是 chrome:// 内部页，浏览器禁止注入。用 cb tabs 挑一个 http/https 的标签页')
  }
  if (m.includes('No tab with id')) return new Error('标签页已经不存在了（可能被关掉了）')
  if (m.includes('Another debugger is already attached') || m.includes('Cannot attach')) {
    return new Error('这个标签页被别的调试器占着（多半是 DevTools 开着）——关掉 DevTools 再试')
  }
  if (m.includes('Detached while handling command') || m.includes('Debugger is not attached')) {
    return new Error('调试会话断了（页面刚导航过？）——重试一次')
  }
  if (m.includes('Cannot find context with specified id')) return new Error('页面刚跳转过，执行上下文没了——重试一次')
  if (m.includes('No dialog is showing')) return new Error('当前没有弹窗挡着（可能被 Chrome 推迟到标签页获得焦点时才弹）')
  return e instanceof Error ? e : new Error(m)
}

async function handle(msg) {
  if (!msg || !msg.op) return
  const { id, op, args = {} } = msg
  try {
    const fn = OPS[op]
    if (!fn) throw new Error(`未知操作: ${op}`)
    const result = await fn(args)
    post({ id, ok: true, result })
  } catch (e) {
    post({ id, ok: false, error: friendly(e).message })
  }
}

// ── CDP 基础设施 ────────────────────────────────────────────────────────────

// 标签页最后被用到的时间 —— 空闲了就断开，别让 Chrome 一直挂着"正在调试"提示条
const lastUsed = new Map()
const DETACH_IDLE_MS = 60_000

async function detachIdle() {
  const now = Date.now()
  for (const tabId of [...attached]) {
    if (now - (lastUsed.get(tabId) || 0) < DETACH_IDLE_MS) continue
    try { await chrome.debugger.detach({ tabId }) } catch {}
    attached.delete(tabId)
    lastUsed.delete(tabId)
    await unmarkTab(tabId)
  }
}

// ── 正在被控制的标签页：自动分组 + 扩展图标上的 🖱 角标 ──────────────────────
// 用户在标签栏上一眼就能看出"agent 正在动哪几个页面"，松手（空闲断开 / 显式 detach /
// 关掉标签页 / 点掉 Chrome 那条调试提示）就自动还原，不留痕。

const GROUP_TITLE = 'DSH agent 正在操作'
const CURSOR_ICON = { 16: 'icons/cursor16.png', 32: 'icons/cursor32.png', 48: 'icons/cursor48.png' }
// 标签页上的小鼠标：把页面 favicon 临时换成它（data URL，绕开页面 CSP 与 web_accessible_resources）
const CURSOR_FAVICON = 'data:image/png;base64,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'
const IDLE_ICON = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png' }
const groupedTabs = new Map() // tabId -> groupId（只记我们自己建的组）
let ourGroupId = null          // 我们那个组（所有受控标签页共用一个）

/** 受控标签页的 favicon 换成小鼠标（松手还原）。页面导航后 favicon 自然复原，下次控制再补。 */
async function setTabFavicon(tabId, on) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      func: (on, href) => {
        const ID = 'dsh-bridge-cursor-favicon'
        const old = document.getElementById(ID)
        if (!on) { if (old) old.remove(); return }
        if (old) return
        const l = document.createElement('link')
        l.id = ID
        l.rel = 'icon'
        l.type = 'image/png'
        l.href = href
        document.head.appendChild(l)
      },
      args: [on, CURSOR_FAVICON],
    })
  } catch {}
}

async function markTab(tabId) {
  const id = Number(tabId)
  // 分组 = "这个标签页正在被操作"；标签上的小鼠标只跟页内光标走（markCursor）
  await ensureGroup(id)
}

/**
 * 所有受控标签页共用**同一个组**（不然同时操作 3 个标签页会出现 3 个同名蓝组）。
 * 优先复用：内存里记的组 id → 按标题找现成的组 → 都没有才新建。
 */
async function ensureGroup(tabId) {
  const id = Number(tabId)
  if (groupedTabs.has(id)) return
  const candidates = []
  if (ourGroupId != null) candidates.push(ourGroupId)
  try {
    for (const g of await chrome.tabGroups.query({ title: GROUP_TITLE })) {
      if (!candidates.includes(g.id)) candidates.push(g.id)
    }
  } catch {}
  for (const gid of candidates) {
    try {
      await chrome.tabs.group({ tabIds: [id], groupId: gid })
      groupedTabs.set(id, gid)
      ourGroupId = gid
      return
    } catch {}
  }
  try {
    const gid = await chrome.tabs.group({ tabIds: [id] })
    groupedTabs.set(id, gid)
    ourGroupId = gid
    await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: 'blue' })
  } catch (e) {
    console.log('[dsh-bridge] 分组失败（不影响干活）:', String(e && e.message || e))
  }
}

async function unmarkTab(tabId) {
  const id = Number(tabId)
  await markCursor(id, false)
  if (!groupedTabs.has(id)) return
  groupedTabs.delete(id)
  try { await chrome.tabs.ungroup([id]) } catch {}
}

/**
 * 自愈：service worker 会被 Chrome 随时挂起、扩展重载也会清掉内存里的分组表，
 * 但 Chrome 那边的组是持久的。所以启动时对一遍账：
 *   · 还挂着调试会话的标签页 → 认领回分组表（继续归我们管）
 *   · 已经没会话、却还留在「🖱 DSH agent」组里的 → 拆掉还原（别留孤儿组和残留角标）
 */
async function reconcileGroups() {
  try {
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE })
    if (!groups.length) return
    let attachedIds = new Set()
    try {
      const targets = await chrome.debugger.getTargets()
      attachedIds = new Set(targets.filter(t => t.attached && t.tabId != null).map(t => t.tabId))
    } catch {}
    for (const g of groups) {
      const tabs = await chrome.tabs.query({ groupId: g.id })
      for (const t of tabs) {
        if (attachedIds.has(t.id)) {
          groupedTabs.set(t.id, g.id)
          ourGroupId = g.id
        } else {
          groupedTabs.set(t.id, g.id)   // 先认领，unmarkTab 才会真的去拆
          await unmarkTab(t.id)
        }
      }
    }
  } catch (e) {
    console.log('[dsh-bridge] 分组对账失败（不影响干活）:', String(e && e.message || e))
  }
}

async function ensure(tabId) {
  lastUsed.set(Number(tabId), Date.now())
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId: Number(tabId) }, CDP_VERSION)
    } catch (e) {
      if (!String(e && e.message || e).includes('Already attached')) throw e
    }
    attached.add(Number(tabId))
    for (const d of ['Page', 'DOM', 'Runtime', 'Network']) {
      try { await chrome.debugger.sendCommand({ tabId: Number(tabId) }, d + '.enable', {}) } catch {}
    }
    await markTab(tabId)
  }
  return Number(tabId)
}

function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params || {})
}

chrome.debugger.onDetach.addListener((src) => {
  if (src && src.tabId != null) {
    attached.delete(src.tabId)
    lastUsed.delete(src.tabId)
    unmarkTab(src.tabId)   // 用户点掉 Chrome 那条调试提示也算松手
  }
})

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method === 'Page.loadEventFired') {
    cursorReady.delete(src.tabId)
    markCursor(src.tabId, false)   // 导航后页内光标没了，标签上的小鼠标跟着灭
    const w = loadWaiters.get(src.tabId)
    if (w) { loadWaiters.delete(src.tabId); clearTimeout(w.timer); w.resolve() }
  }
  if (method === 'Page.javascriptDialogOpening') {
    dialogs.set(src.tabId, { type: params.type, message: params.message, at: Date.now() })
  }
  if (method === 'Page.javascriptDialogClosed') {
    dialogs.delete(src.tabId)
  }
  if (method === 'Network.requestWillBeSent') {
    netPending.set(params.requestId, {
      tabId: src.tabId, method: params.request.method, url: params.request.url,
      type: params.type, at: Date.now(),
    })
  }
  if (method === 'Network.responseReceived') {
    const p = netPending.get(params.requestId)
    if (p) { p.status = params.response.status; p.mime = params.response.mimeType }
  }
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    const p = netPending.get(params.requestId)
    if (p) {
      p.ms = Date.now() - p.at
      if (method === 'Network.loadingFailed') p.failed = params.errorText
      NET.push(p)
      if (NET.length > NET_MAX) NET.shift()
      netPending.delete(params.requestId)
    }
  }
  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args || []).map(a =>
      a.value !== undefined ? String(a.value) : (a.description || a.type)
    ).join(' ')
    CONSOLE.push({ tabId: src.tabId, level: params.type, text, at: Date.now() })
    if (CONSOLE.length > 300) CONSOLE.shift()
  }
})

/** 注入表达式并取值（有异常就抛，别把 undefined 当成功） */
async function evaluate(tabId, expression) {
  await ensure(tabId)
  const r = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (r.exceptionDetails) {
    const d = r.exceptionDetails
    throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || '页面 JS 抛异常')
  }
  return r.result ? r.result.value : undefined
}

/** 页内找一个元素的中点（顺带滚动到可视区），返回视口坐标 */
const POINT_HELPER = `
const __dsh_norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
const __dsh_visible = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const st = getComputedStyle(el);
  if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
  return true;
};
const __dsh_point = (el) => {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  return new Promise((res) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const r = el.getBoundingClientRect();
      res({ x: r.left + r.width / 2, y: r.top + r.height / 2,
            tag: el.tagName.toLowerCase(),
            text: __dsh_norm(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 80) });
    };
    // 后台标签页里 Chrome 会暂停 requestAnimationFrame —— 只等 rAF 的话这个 Promise
    // 永远不 resolve，整个 click-el / click-text 就卡死（45 秒超时、还不回话）。
    // 所以 rAF 之外再挂一个定时器兜底。
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 120);
  });
};
`

async function pointOf(tabId, finderJs) {
  const pt = await evaluate(tabId, `(async () => { ${POINT_HELPER} ${finderJs} })()`)
  if (!pt) throw new Error('没找到目标元素（可能不可见或文字不匹配）')
  return pt
}

/** 页内光标：注入过一次就记住，导航后失效要重注 */
const cursorReady = new Set()

async function injectCursor(tabId, script) {
  if (!script) return false
  if (!cursorReady.has(Number(tabId))) {
    await evaluate(tabId, script)
    cursorReady.add(Number(tabId))
    // 语义：标签页上出现小鼠标 = 这个页面里真的有一只鼠标（页内光标已就位）
    await markCursor(tabId, true)
  }
  return true
}

/** 标签上的小鼠标只跟"页内光标在不在"：在 → 亮；hide / 导航 / 松手 → 灭。 */
async function markCursor(tabId, on) {
  const id = Number(tabId)
  try {
    await chrome.action.setIcon({ tabId: id, path: on ? CURSOR_ICON : IDLE_ICON })
    await chrome.action.setTitle({ tabId: id, title: on ? 'DSH agent 正在操作这个标签页（页内有一只鼠标）' : '' })
  } catch {}
  await setTabFavicon(id, on)
}

async function paintCursor(tabId, script, x, y, text) {
  if (!(await injectCursor(tabId, script))) return false
  try {
    await evaluate(tabId, `window.__dshCursor.move(${Math.round(x)}, ${Math.round(y)})`)
    if (text) await evaluate(tabId, `window.__dshCursor.label(${JSON.stringify(text)})`)
  } catch {}
  return true
}

async function flashCursor(tabId, x, y) {
  if (!cursorReady.has(Number(tabId))) return
  try {
    await evaluate(tabId, 'window.__dshCursor.press()')
    await evaluate(tabId, `window.__dshCursor.click(${Math.round(x)}, ${Math.round(y)})`)
  } catch {}
}

async function clickPoint(tabId, x, y, opts = {}) {
  const n = Number(opts.clickCount || 1)
  const button = opts.button || 'left'
  const base = { x: Math.round(x), y: Math.round(y), button, clickCount: n }

  // 先让光标飞过去，人眼看得见，再发真实点击
  if (opts.cursor && opts.cursor.script) {
    await paintCursor(tabId, opts.cursor.script, base.x, base.y, opts.cursor.label)
    await new Promise(r => setTimeout(r, 300))
    await flashCursor(tabId, base.x, base.y)
  }

  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 })
  await new Promise(r => setTimeout(r, 12))
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
  await new Promise(r => setTimeout(r, 24))
  await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
  return { x: base.x, y: base.y, button }
}

const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
const NAMED_KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27], backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46], arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34], space: [' ', 'Space', 32, ' '],
}

async function pressKey(tabId, spec) {
  const parts = String(spec).split('+').map(s => s.trim()).filter(Boolean)
  const keyName = parts.pop()
  let modifiers = 0
  for (const p of parts) {
    const m = MODS[p.toLowerCase()]
    if (!m) throw new Error(`不认识修饰键: ${p}（可用 alt/ctrl/meta/shift）`)
    modifiers |= m
  }
  const lower = keyName.toLowerCase()
  let key, code, keyCode, text
  if (NAMED_KEYS[lower]) {
    ;[key, code, keyCode, text] = NAMED_KEYS[lower]
  } else if (keyName.length === 1) {
    key = keyName
    keyCode = keyName.toUpperCase().charCodeAt(0)
    code = /[a-z]/i.test(keyName) ? 'Key' + keyName.toUpperCase()
         : /[0-9]/.test(keyName) ? 'Digit' + keyName
         : ''
    text = keyName
  } else {
    throw new Error(`不认识按键: ${keyName}`)
  }
  const suppressText = modifiers !== 0 || !text
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
  await send(tabId, 'Input.dispatchKeyEvent', {
    ...base, type: suppressText ? 'rawKeyDown' : 'keyDown',
    ...(suppressText ? {} : { text, unmodifiedText: text }),
  })
  await new Promise(r => setTimeout(r, 12))
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  return { key: spec, modifiers }
}

// ── 操作表 ──────────────────────────────────────────────────────────────────

const OPS = {
  async ping() {
    return { pong: true, at: Date.now(), attached: [...attached] }
  },

  async version() {
    return { version: chrome.runtime.getManifest().version, id: chrome.runtime.id }
  },

  /** 改完扩展代码：拷文件 → cb reload，不用去 chrome://extensions 点刷新 */
  async reload() {
    setTimeout(() => chrome.runtime.reload(), 250)
    return { reloading: true }
  },

  async logs({ limit = 60 } = {}) {
    return { lines: LOG.slice(-limit) }
  },

  async console({ limit = 40, tabId } = {}) {
    const items = tabId != null ? CONSOLE.filter(c => c.tabId === Number(tabId)) : CONSOLE
    return { items: items.slice(-limit) }
  },

  async tabs() {
    const tabs = await chrome.tabs.query({})
    return tabs
      .filter(t => t.url && !t.url.startsWith('chrome-extension://'))
      .map(t => ({
        id: t.id, windowId: t.windowId, active: t.active, pinned: t.pinned,
        title: t.title, url: t.url, attached: attached.has(t.id),
        // 这个标签页是不是被我们自动分进「🖱 DSH agent」组（面板和自检都用得上）
        grouped: groupedTabs.has(t.id), groupId: t.groupId >= 0 ? t.groupId : null,
      }))
  },

  async attach({ tabId }) {
    await ensure(tabId)
    return { tabId: Number(tabId), attached: true }
  },

  async detach({ tabId }) {
    try { await chrome.debugger.detach({ tabId: Number(tabId) }) } catch {}
    attached.delete(Number(tabId))
    lastUsed.delete(Number(tabId))
    await unmarkTab(tabId)
    return { tabId: Number(tabId), attached: false }
  },

  async activate({ tabId }) {
    const t = await chrome.tabs.get(Number(tabId))
    await chrome.tabs.update(Number(tabId), { active: true })
    await chrome.windows.update(t.windowId, { focused: true })
    return { tabId: Number(tabId), windowId: t.windowId }
  },

  async open({ url, active = false }) {
    // 默认后台开页：DSH 干活不该顶掉用户正在看的标签页
    const t = await chrome.tabs.create({ url, active: !!active })
    return { tabId: t.id, url: t.url }
  },

  async close({ tabId }) {
    await chrome.tabs.remove(Number(tabId))
    return { closed: Number(tabId) }
  },

  async eval({ tabId, expression }) {
    return { value: await evaluate(tabId, expression) }
  },

  async cdp({ tabId, method, params }) {
    await ensure(tabId)
    return { result: await send(tabId, method, params || {}) }
  },

  async nav({ tabId, url, wait = true, timeoutMs = 30000 }) {
    await ensure(tabId)
    const p = new Promise((resolve) => {
      const timer = setTimeout(() => { loadWaiters.delete(Number(tabId)); resolve() }, timeoutMs)
      loadWaiters.set(Number(tabId), { resolve, timer })
    })
    const r = await send(tabId, 'Page.navigate', { url })
    if (wait) await p
    const t = await chrome.tabs.get(Number(tabId)).catch(() => null)
    return { url: (t && t.url) || url, title: t && t.title, frameId: r.frameId, waited: !!wait }
  },

  async click({ tabId, x, y, clickCount, button, script }) {
    return clickPoint(tabId, x, y, { clickCount, button, cursor: { script, label: `点击 (${Math.round(x)}, ${Math.round(y)})` } })
  },

  async clickEl({ tabId, selector, script }) {
    const pt = await pointOf(tabId, `
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      let target = el;
      const r0 = el.getBoundingClientRect();
      if (r0.width < 1 || r0.height < 1) {
        const inner = [...el.querySelectorAll('*')].find(__dsh_visible);
        if (inner) target = inner;
      }
      if (!__dsh_visible(target) && !target.getBoundingClientRect().width) return null;
      return __dsh_point(target);
    `)
    const hit = await clickPoint(tabId, pt.x, pt.y, { cursor: { script, label: `点击 ${pt.text || pt.tag}` } })
    return { ...hit, target: pt }
  },

  async clickText({ tabId, text, exact = true, index = 0, script }) {
    const pt = await pointOf(tabId, `
      const want = __dsh_norm(${JSON.stringify(text)});
      const SEL = 'a,button,input,textarea,select,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],[contenteditable=true],li,td,th,h1,h2,h3,h4,span,div,p';
      const all = [...document.querySelectorAll(SEL)].filter(__dsh_visible);
      const label = (el) => __dsh_norm(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
      let hit = all.filter((el) => label(el) === want);
      if (!hit.length && ${exact ? 'false' : 'true'}) hit = all.filter((el) => label(el).includes(want));
      if (!hit.length) return null;
      hit.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return ra.width * ra.height - rb.width * rb.height; });
      const el = hit[Math.min(${Number(index) || 0}, hit.length - 1)];
      // 元素框常常比可见按钮大得多（<a> 里塞满空白），点框中心会落在按钮外面。
      // 所以先找承载这段文字的文本节点，用 Range 拿它的**精确**位置。
      const textRect = (root, needle) => {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const t = __dsh_norm(n.nodeValue || '');
          if (!t) continue;
          if (t === needle || t.includes(needle)) {
            const rg = document.createRange();
            rg.selectNodeContents(n);
            const rc = rg.getBoundingClientRect();
            if (rc.width > 0 && rc.height > 0) return rc;
          }
        }
        return null;
      };
      const tr = textRect(el, want);
      if (tr) {
        const pr = el.getBoundingClientRect();
        return { x: Math.round(tr.x + tr.width / 2), y: Math.round(tr.y + tr.height / 2),
                 text: (el.innerText || '').trim().slice(0, 60), tag: el.tagName.toLowerCase(),
                 rect: [Math.round(pr.x), Math.round(pr.y), Math.round(pr.width), Math.round(pr.height)],
                 textRect: [Math.round(tr.x), Math.round(tr.y), Math.round(tr.width), Math.round(tr.height)] };
      }
      return __dsh_point(el);
    `)
    const hit = await clickPoint(tabId, pt.x, pt.y, { cursor: { script, label: `点击 ${pt.text || pt.tag}` } })
    return { ...hit, target: pt }
  },

  async type({ tabId, text, selector, script }) {
    if (selector) await OPS.clickEl({ tabId, selector, script })
    await ensure(tabId)
    await send(tabId, 'Input.insertText', { text })
    return { typed: text.length, selector: selector || null }
  },

  // ── 读取类：让模型能"看"页面 ──────────────────────────────────────────────

  async text({ tabId, selector, limit = 8000 }) {
    const js = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : null })()`
      : `document.body ? (document.body.innerText || '') : ''`
    const t = await evaluate(tabId, js)
    if (t === null) throw new Error(`没找到元素: ${selector}`)
    const s = String(t)
    const cut = s.length > limit
    return { text: cut ? s.slice(0, limit) + `\n…（截断，全文 ${s.length} 字）` : s, length: s.length, truncated: cut }
  },

  async html({ tabId, selector = 'body', limit = 4000 }) {
    const t = await evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : null })()`)
    if (t === null) throw new Error(`没找到元素: ${selector}`)
    const s = String(t)
    const cut = s.length > limit
    return { html: cut ? s.slice(0, limit) + `…（截断，全文 ${s.length} 字）` : s, length: s.length, truncated: cut }
  },

  async attr({ tabId, selector, name }) {
    const value = await evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.getAttribute(${JSON.stringify(name)}) : null })()`)
    return { selector, name, value }
  },

  async info({ tabId }) {
    const t = await chrome.tabs.get(Number(tabId))
    let viewport = null
    try {
      await ensure(tabId)
      const m = await send(tabId, 'Page.getLayoutMetrics')
      const v = m.cssVisualViewport
      viewport = { w: Math.round(v.clientWidth), h: Math.round(v.clientHeight), scrollY: Math.round(v.pageY) }
    } catch {}
    return {
      tabId: Number(tabId), url: t.url, title: t.title, status: t.status,
      windowId: t.windowId, active: t.active, attached: attached.has(Number(tabId)),
      viewport, pendingDialog: dialogs.get(Number(tabId)) || null,
    }
  },

  async waitFor({ tabId, selector, timeoutMs = 15000, visible = true }) {
    const deadline = Date.now() + Number(timeoutMs)
    const js = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const vis = r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      return { found: true, visible: vis, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (el.innerText || '').trim().slice(0, 60) };
    })()`
    let last = null
    while (Date.now() < deadline) {
      last = await evaluate(tabId, js)
      if (last && (!visible || last.visible)) return { ...last, waitedMs: Number(timeoutMs) - (deadline - Date.now()) }
      await new Promise(r => setTimeout(r, 250))
    }
    throw new Error(`等了 ${timeoutMs}ms 还没等到 ${selector}${last ? '（元素在，但不可见）' : ''}`)
  },

  // ── 输入类 ───────────────────────────────────────────────────────────────

  async hover({ tabId, x, y, selector }) {
    let px = Number(x) || 0, py = Number(y) || 0, target = null
    if (selector) {
      const pt = await pointOf(tabId, `const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; return __dsh_point(el);`)
      px = pt.x; py = pt.y; target = pt
    }
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(px), y: Math.round(py), buttons: 0 })
    return { x: Math.round(px), y: Math.round(py), target }
  },

  async scroll({ tabId, x = 200, y = 200, deltaY = 600, deltaX = 0 }) {
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(x), y: Math.round(y),
      deltaX: Math.round(deltaX), deltaY: Math.round(deltaY),
    })
    const after = await evaluate(tabId, '({ scrollY: Math.round(window.scrollY), pageHeight: Math.round(document.documentElement.scrollHeight) })')
    return { deltaY, ...after }
  },

  async focus({ tabId, selector }) {
    const ok = await evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return document.activeElement === el })()`)
    if (!ok) throw new Error(`聚焦失败: ${selector}`)
    return { focused: selector }
  },

  async select({ tabId, selector, value }) {
    const r = await evaluate(tabId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, why: '找不到元素' };
      if (el.tagName !== 'SELECT') return { ok: false, why: '不是 <select> 元素' };
      const opts = [...el.options];
      const hit = opts.find(o => o.value === ${JSON.stringify(value)}) || opts.find(o => (o.textContent || '').trim() === ${JSON.stringify(value)});
      if (!hit) return { ok: false, why: '没有这个选项', options: opts.map(o => o.value).slice(0, 20) };
      el.value = hit.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: hit.value, label: (hit.textContent || '').trim() };
    })()`)
    if (!r.ok) throw new Error(`选择失败：${r.why}${r.options ? '（可选值：' + r.options.join(', ') + '）' : ''}`)
    return r
  },

  async upload({ tabId, selector, files }) {
    await ensure(tabId)
    const list = Array.isArray(files) ? files : [files]
    const { root } = await send(tabId, 'DOM.getDocument', { depth: -1, pierce: true })
    const { nodeId } = await send(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) throw new Error(`没找到文件输入框: ${selector}`)
    await send(tabId, 'DOM.setFileInputFiles', { files: list, nodeId })
    return { selector, files: list }
  },

  /** 被 alert/confirm 挡住时用这个放行，否则页面会一直卡住 */
  async dialog({ tabId, action, text }) {
    const accept = action !== 'dismiss'
    await send(tabId, 'Page.handleJavaScriptDialog', { accept, ...(text ? { promptText: text } : {}) })
    dialogs.delete(Number(tabId))
    return { action: accept ? 'accept' : 'dismiss' }
  },

  async key({ tabId, key, times = 1 }) {
    const out = []
    for (let i = 0; i < times; i++) out.push(await pressKey(tabId, key))
    return { pressed: key, times, modifiers: out[0] && out[0].modifiers }
  },

  async shot({ tabId, format = 'png', quality, full = false, selector }) {
    await ensure(tabId)
    const params = { format, captureBeyondViewport: !!full }
    if (format === 'jpeg' && quality) params.quality = quality
    let clip = null
    if (selector) {
      const rect = await evaluate(tabId, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          res({ x: r.left, y: r.top, width: r.width, height: r.height });
        })));
      })()`)
      if (!rect) throw new Error(`没找到元素: ${selector}`)
      clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
      params.clip = clip
      params.captureBeyondViewport = false
    }
    const r = await send(tabId, 'Page.captureScreenshot', params)
    const t = await chrome.tabs.get(Number(tabId)).catch(() => null)
    return { data: r.data, format, url: t && t.url, title: t && t.title, full: !!full, clip }
  },

  async network({ tabId, limit = 40, filter, clear, reload = false, waitMs = 2500 }) {
    if (clear) { NET.length = 0; return { cleared: true } }
    // Network 事件只在 attach 之后才有，所以先 attach；要历史就 --reload 刷一次
    if (tabId != null && reload) {
      await ensure(tabId)
      NET.length = 0
      await send(tabId, 'Page.reload', {})
      await new Promise(r => setTimeout(r, Number(waitMs)))
    } else if (tabId != null) {
      await ensure(tabId)
    }
    let items = tabId != null ? NET.filter(n => n.tabId === Number(tabId)) : NET
    if (filter) items = items.filter(n => (n.url || '').includes(filter) || (n.method || '').includes(filter))
    return {
      items: items.slice(-limit).map(n => ({
        method: n.method, status: n.status, url: n.url, type: n.type, ms: n.ms, failed: n.failed,
      })),
    }
  },

  /**
   * 录一段屏幕（CDP screencast），用来做演示 GIF。
   * 帧以 base64 JPEG 返回；调用方自己写文件、自己合成。
   */
  async screencast({ tabId, durationMs = 5000, maxWidth = 900, quality = 70, maxFrames = 140 }) {
    await ensure(tabId)
    const id = Number(tabId)
    const frames = []
    const onEvent = (src, method, params) => {
      if (src.tabId !== id) return
      if (method !== 'Page.screencastFrame') return
      frames.push(params.data)
      chrome.debugger
        .sendCommand({ tabId: id }, 'Page.screencastFrameAck', { sessionId: params.sessionId })
        .catch(() => {})
    }
    chrome.debugger.onEvent.addListener(onEvent)
    try {
      await send(tabId, 'Page.startScreencast', {
        format: 'jpeg', quality, maxWidth, maxHeight: Math.round(maxWidth * 1.4), everyNthFrame: 1,
      })
      const deadline = Date.now() + Number(durationMs)
      // 帧太多会把一条 native message 撑爆（也拖慢回传），到上限就提前收工
      while (Date.now() < deadline && frames.length < Number(maxFrames)) {
        await new Promise((r) => setTimeout(r, 100))
      }
      await send(tabId, 'Page.stopScreencast')
    } finally {
      chrome.debugger.onEvent.removeListener(onEvent)
    }
    return { count: frames.length, frames }
  },

  /** 页内光标：CLI 把脚本内容传进来，这里只负责注入 + 调用 */
  async cursor({ tabId, script, action, x, y, duration }) {
    if (script) {
      await evaluate(tabId, script)
      await evaluate(tabId, '(() => { if (!window.__dshCursor) throw new Error("光标脚本没装上"); return "ok" })()')
    }
    if (action === 'hide') { await evaluate(tabId, 'window.__dshCursor.hide()'); cursorReady.delete(Number(tabId)); await markCursor(tabId, false); return { action } }
    if (action === 'move') { await evaluate(tabId, `window.__dshCursor.move(${Number(x)}, ${Number(y)})`); return { action, x, y } }
    if (action === 'click') {
      await evaluate(tabId, `window.__dshCursor.move(${Number(x)}, ${Number(y)})`)
      await evaluate(tabId, `window.__dshCursor.click(${Number(x)}, ${Number(y)})`)
      return { action, x, y }
    }
    if (action === 'clear') { await evaluate(tabId, 'window.__dshCursor && window.__dshCursor.hide()'); cursorReady.delete(Number(tabId)); await markCursor(tabId, false); return { action } }
    throw new Error(`不认识的光标动作: ${action}（move/click/hide/clear）`)
  },
}

// ── 保活 / 启动 ─────────────────────────────────────────────────────────────

chrome.alarms.create('dsh-keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'dsh-keepalive') return
  detachIdle()                       // 空闲超过 60 秒的标签页断开调试
  if (!port) connect()
  else post({ id: 'ka-' + Date.now(), ok: true, keepalive: true })
})

chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
// 每次 worker 起来都对一次账：认领还活着的分组、拆掉孤儿组和残留角标
reconcileGroups()
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId)
  lastUsed.delete(tabId)
  groupedTabs.delete(tabId)   // 标签页都没了，组也轮不到我们拆
})
connect()
