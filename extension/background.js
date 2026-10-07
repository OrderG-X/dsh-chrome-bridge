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

async function ensure(tabId) {
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
  }
  return Number(tabId)
}

function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params || {})
}

chrome.debugger.onDetach.addListener((src) => {
  if (src && src.tabId != null) attached.delete(src.tabId)
})

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method === 'Page.loadEventFired') {
    cursorReady.delete(src.tabId)
    const w = loadWaiters.get(src.tabId)
    if (w) { loadWaiters.delete(src.tabId); clearTimeout(w.timer); w.resolve() }
  }
  if (method === 'Page.javascriptDialogOpening') {
    dialogs.set(src.tabId, { type: params.type, message: params.message, at: Date.now() })
  }
  if (method === 'Page.javascriptDialogClosed') {
    dialogs.delete(src.tabId)
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
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    res({ x: r.left + r.width / 2, y: r.top + r.height / 2,
          tag: el.tagName.toLowerCase(),
          text: __dsh_norm(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 80) });
  })));
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
  }
  return true
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
      }))
  },

  async attach({ tabId }) {
    await ensure(tabId)
    return { tabId: Number(tabId), attached: true }
  },

  async detach({ tabId }) {
    try { await chrome.debugger.detach({ tabId: Number(tabId) }) } catch {}
    attached.delete(Number(tabId))
    return { tabId: Number(tabId), attached: false }
  },

  async activate({ tabId }) {
    const t = await chrome.tabs.get(Number(tabId))
    await chrome.tabs.update(Number(tabId), { active: true })
    await chrome.windows.update(t.windowId, { focused: true })
    return { tabId: Number(tabId), windowId: t.windowId }
  },

  async open({ url, active = true }) {
    const t = await chrome.tabs.create({ url, active })
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

  async shot({ tabId, format = 'png', quality }) {
    await ensure(tabId)
    const params = { format, captureBeyondViewport: false }
    if (format === 'jpeg' && quality) params.quality = quality
    const r = await send(tabId, 'Page.captureScreenshot', params)
    const t = await chrome.tabs.get(Number(tabId)).catch(() => null)
    return { data: r.data, format, url: t && t.url, title: t && t.title }
  },

  /** 页内光标：CLI 把脚本内容传进来，这里只负责注入 + 调用 */
  async cursor({ tabId, script, action, x, y, duration }) {
    if (script) {
      await evaluate(tabId, script)
      await evaluate(tabId, '(() => { if (!window.__dshCursor) throw new Error("光标脚本没装上"); return "ok" })()')
    }
    if (action === 'hide') { await evaluate(tabId, 'window.__dshCursor.hide()'); return { action } }
    if (action === 'move') { await evaluate(tabId, `window.__dshCursor.move(${Number(x)}, ${Number(y)})`); return { action, x, y } }
    if (action === 'click') {
      await evaluate(tabId, `window.__dshCursor.move(${Number(x)}, ${Number(y)})`)
      await evaluate(tabId, `window.__dshCursor.click(${Number(x)}, ${Number(y)})`)
      return { action, x, y }
    }
    if (action === 'clear') { await evaluate(tabId, 'window.__dshCursor && window.__dshCursor.hide()'); return { action } }
    throw new Error(`不认识的光标动作: ${action}（move/click/hide/clear）`)
  },
}

// ── 保活 / 启动 ─────────────────────────────────────────────────────────────

chrome.alarms.create('dsh-keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'dsh-keepalive') return
  if (!port) connect()
  else post({ id: 'ka-' + Date.now(), ok: true, keepalive: true })
})

chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId))
connect()
