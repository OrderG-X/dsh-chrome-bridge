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
    hostInfo = null
    for (const id of [...attached]) {
      chrome.debugger.detach({ tabId: id }).catch(() => {})
    }
    attached.clear()
    updateBadge()
    setTimeout(connect, RECONNECT_MS)
  })

  log('已连上原生宿主')
  // 主动报到：宿主靠它判断扩展是否在线（否则宿主刚起来时会误判"扩展未连接"）
  post({ hello: true, version: chrome.runtime.getManifest().version })
  post({ hostPing: true })
  // connectNative 本身总是「成功」，宿主起不来要等 onDisconnect —— 稳住一会儿再把角标的 ! 收掉
  setTimeout(() => { if (port) updateBadge() }, 1500)
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
    return new Error('这个标签页空闲被断开了（或页面刚导航过）——直接重试即可，会自动重连')
  }
  if (m.includes('Cannot find context with specified id')) return new Error('页面刚跳转过，执行上下文没了——重试一次')
  if (m.includes('No dialog is showing')) return new Error('当前没有弹窗挡着（可能被 Chrome 推迟到标签页获得焦点时才弹）')
  return e instanceof Error ? e : new Error(m)
}

async function handle(msg) {
  if (!msg) return
  if (msg.hostPong) { hostInfo = { ...msg, at: Date.now() }; return }
  if (!msg.op) return
  const { id, op, args = {}, client } = msg
  const t0 = Date.now()
  try {
    const fn = OPS[op]
    if (!fn) throw new Error(`未知操作: ${op}`)
    if (paused && !PAUSE_ALLOWED.has(op) && !(await isOwnPage(op, args))) {
      throw new Error('用户在 DSH Bridge 弹窗里暂停了浏览器控制——请用户点开扩展图标、打开「允许 DSH 控制」后再试')
    }
    const result = await fn(args)
    post({ id, ok: true, result })
    track(client, op, args, result, null, Date.now() - t0)
  } catch (e) {
    const err = friendly(e).message
    post({ id, ok: false, error: err })
    track(client, op, args, null, err, Date.now() - t0)
  }
}

// ── 弹窗用的账本：哪些会话在用、动了哪些标签页、最近做了什么 ────────────────
// 全在内存里：service worker 有原生端口连着，平时不会被挂起；真重启了就从零记，不要紧。

/** 宿主自报的状态（pid、socket 是否在听、最近一次被调用） */
let hostInfo = null
/** 用户在弹窗里按了暂停：除了这几个，其它操作一律拒绝 */
let paused = false
const PAUSE_ALLOWED = new Set(['version', 'reload', 'ping', 'logs', 'detach'])

/** 暂停只管网页；扩展自己的页面（弹窗）不算，不然连「解除暂停」的自动化测试都进不去 */
async function isOwnPage(op, args) {
  const self = `chrome-extension://${chrome.runtime.id}/`
  if (op === 'open') return String(args.url || '').startsWith(self)
  if (args.tabId == null) return false
  try {
    return ((await chrome.tabs.get(Number(args.tabId))).url || '').startsWith(self)
  } catch {
    return false
  }
}
/** 用户在弹窗里关了「页面里显示光标」：真实点击照做，只是不画那只蓝色光标 */
let showCursor = true
chrome.storage.local.get(['paused', 'showCursor']).then((v) => {
  paused = !!(v && v.paused)
  showCursor = !(v && v.showCursor === false)
  updateBadge()
}).catch(() => {})

/** 受控标签页里，扩展自己的页面（弹窗被当成网页打开时）不算数 */
const controlledCount = () => [...attached].filter((id) => !ownTabs.has(id)).length

/** 不算「动作」的内部操作（版本检查、焦点模拟、光标跟随……） */
const QUIET_OPS = new Set(['version', 'reload', 'ping', 'logs'])
const QUIET_CDP = new Set(['Emulation.setFocusEmulationEnabled', 'Page.getNavigationHistory'])

/** 会话 key → { key, kind, session, pid, first, last, ops, errors, tabs:Set } */
const SESSIONS = new Map()
/** 最近动作：DSH 的一次工具调用算一条（同一个 callId 的多个 op 合并），cb 命令行一个 op 一条 */
const ACTIVITY = []
const ACTIVITY_MAX = 80

function clientKey(c) {
  if (!c) return 'cli'
  const kind = c.kind || 'dsh'
  return c.session ? `${kind}:${c.session}` : `${kind}:pid${c.pid || '?'}`
}

/** 通过 open 打开的扩展自己的页面（弹窗页）：对它们的操作不记账 */
const ownTabs = new Set()

function track(client, op, args, result, error, ms) {
  if (QUIET_OPS.has(op)) return
  if (op === 'open' && String(args.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
    if (result && result.tabId != null) ownTabs.add(Number(result.tabId))
    return
  }
  if (args.tabId != null && ownTabs.has(Number(args.tabId))) return
  // CDP 的原始报错是一段 JSON（{"code":-32000,"message":"…"}），弹窗里只留 message
  if (error && error.trim().startsWith('{')) {
    try { error = JSON.parse(error).message || error } catch {}
  }
  if (op === 'cdp' && QUIET_CDP.has(args.method)) return
  const now = Date.now()
  const key = clientKey(client)
  let s = SESSIONS.get(key)
  if (!s) {
    s = { key, kind: client ? client.kind || 'dsh' : 'cli', session: (client && client.session) || null,
      pid: (client && client.pid) || null, first: now, last: 0, ops: 0, errors: 0, tabs: new Set() }
    SESSIONS.set(key, s)
  }
  s.last = now
  s.ops++
  if (error) s.errors++
  const tabId = args.tabId != null ? Number(args.tabId) : result && result.tabId != null ? Number(result.tabId) : null
  if (tabId != null) {
    if (op === 'close') s.tabs.delete(tabId)
    else s.tabs.add(tabId)
  }

  const call = client && client.call
  const prev = call ? ACTIVITY.find((a) => a.call === call) : null
  if (prev) {
    prev.last = now
    prev.ops++
    prev.ms += ms
    if (tabId != null && prev.tabId == null) prev.tabId = tabId
    if (error) { prev.ok = false; prev.error = error }
    return
  }
  ACTIVITY.push({
    at: now, last: now, key, call: call || null, tool: (client && client.tool) || null,
    hint: (client && client.hint) || '', op: op === 'cdp' ? `cdp:${args.method}` : op,
    tabId, ok: !error, error: error || undefined, ms, ops: 1,
  })
  if (ACTIVITY.length > ACTIVITY_MAX) ACTIVITY.shift()
}

/** 工具栏图标角标：受控标签页数；暂停 ⏸；宿主断了 ! */
function updateBadge() {
  try {
    const n = controlledCount()
    let text = n ? String(n) : ''
    let color = '#4D6BFE'
    if (paused) { text = '⏸'; color = '#B7791F' } else if (!port) { text = '!'; color = '#E5484D' }
    chrome.action.setBadgeText({ text })
    chrome.action.setBadgeBackgroundColor({ color })
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#FFFFFF' })
  } catch {}
}

// ── CDP 基础设施 ────────────────────────────────────────────────────────────

// 标签页最后被用到的时间 —— 空闲了就断开，别让 Chrome 一直挂着"正在调试"提示条
const lastUsed = new Map()
const DETACH_IDLE_MS = 60_000

async function detachIdle() {
  const now = Date.now()
  for (const tabId of [...attached]) {
    if (now - (lastUsed.get(tabId) || 0) < DETACH_IDLE_MS) continue
    if (inflight.has(tabId)) continue          // 有 CDP 调用在飞（长 evaluate、截图…）
    if (loadWaiters.has(tabId)) continue       // 正在等页面加载完成

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
const CURSOR_FAVICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAGUElEQVR4AbRWbWxUVRA9u9vutnQFFFNogZogIhFqqQnGEgiEEKIoJYoEP6pCTPhjoiJCGmKboBQqIWmAP5KYEKApWIRCoRSxlCpiUWIQGiiS8EMK/bBBoZZtl919z3Nudzfb7ZYQis297907M3fmzJl5t+vEwD8HRZK7wm/tNbl9+EOB4r26bt/unu/3+9dzllCZwikw/wuIeAAMlJ86fHha7bUOd6Hb7S60bdvX29srIG4CibenaGgj1qEyTO7urlhXexrYUmHjg1IbR38CPB7PGp/PJxAehtMZ2XI59CFnES90Os+TnJw8SwLL5tYGjvxoo+YUkJqauioQCJwA3kml3sVJAz6HOOIABJNJudNmYNuyYXHqXd1gYcXnFmpPu/Jse1d3uCQPhY1YAMzlrtOy4DAACAKcxADt9T500kJ1gx0pyXpg4ZAbNA4AMXDYisyoIQsICQSjkxloX1VvYVlREH+2p6yy7eo7YTYeuEETAlB8xgTjQ2tiMG+z1oaKDV+HUHXCirDxwA2aEACTZ7bkgSjUA+oFzcg6FJZ/ezyE/XXWkBo0IQBWgRk7wDhm2vwibHBPhW3zoTVl0gvE0k8DOFjvfKAGTQhAQZSloqv2eltsBjFg1owsRizWRG/ZVB4LovK7UKQk992ggwKgbw3AYubMWqBgsu7biwfpJAP1mpXHQijeFsTVG577btBBAPTV3woh2gvKNKjMiUTrCCNixQrLgmTpwpUQ1pbdxZ6jwQgbsQ1qcMc+EgKQgcUH/UKZMa6YpwTgPQHJojpKJZON5NBB9sieIyFU1ARjGtTcGQPiDRDQn7l4bDpSpkFGknNuYbLm3uhsEIxtZAYA2ZJ9hA29y6sDWLCiB3trkRcIHKijb92e/a7wxABoqWwUNPrmhrER3dMmAkxZU91fR71spSs/FMClq8681taOFylO4oyOxACYXWy9bdY2WmuiUKaqtxgxUzIzAQOK9uA0zNCXbJ592om0tGFzGFkAoiwkBGCQ01Lowc6HnHCCtbXCX4WRcW9kADZ+7MbGlW58yVm6ygPNTas92LTGg+M7hsHn6zk/YsSirfz/EQ3OY0gIQN+1UKvWkcyVmsmaKUpnkXPVWWxQJF/InuTEiJTWfY8Oa/tmlLd972Np7XtudZ4pPHPm10/S0uYtA3r/BQ4HjHH4kRAAmJkdyRz8M1kTOFnInqgjfWuxQC15B8oPB82ytbW1MStr+eZx45aWjh+/ZMPsWcVVeXnrDgDu68DPXTSSIT1xxSFvfPUfhgGbHc7UlK3pB9Z0ypMOfPFRMizJY/SyOd8cwoU/LOTm5hQAXe3AiGt9M/MGcLQDaLjFKH7OaHCuByuBVEyMpozFBTDlKSdKWGdpsrlWCQwDLIVkWu9it/Pn23PXr+9/AajpAWrvALt91Ctwv8wpMyMxA1SZeptvW/FtvPGyCy0tNypP/nCq+K1X2MiGAek4yY5YOXcphPOXLaSnp68G8pPphikImpncDhwJARhzHo0kp8xHpXVUZGUVlM2dU/z9hLG9TVPZcLIzDNEvsfIJ7KwKgL8rn29p+Wo+BUTK5z1GHACX7XTCnjLREa1zCWs+IbO3aezYxZsBfwvgbW1uvry9YGFfL+i/JgmAgKgXzl0K4nf2w+jRj68BlrgZOy4GJTEjTjks1Nx8ZftU1vjNBcnQt61svd7894EkNlbj30Do1vTpK+t1sWRPdsGwIIdhusTEjv19LACd+s3IT0YGiaczRkwX6f7c3A/r29v/2pk/x9/UdfPsaq/3tWWArxU4Fe7i2l4g0CWbdxclwVLqpCDEntBvRrDVfrvIh3EcUh/cNwBWfbcfSLuZkVFQ4vW+9PbMGYUHAR9pb7xJf9SZu5FJeu5kZCwuyyED0yYngQIYDVPIecaFbUWp6Ojo3AHcpYQn7zFiGZAZfdV0AyPbADe/40diMjchZEOnDfzERv4jFsrWejCN93zOZCe2FKUweAomPeFvGjPm9TLgEbIVPaezA2Y8ALIgEvfx263TtclA0NUpeeSw1uS4uysj49XNbW0d5Vs/S2XgVAbuvXi68ReWbd57QE8nUKfzso+cHfCOByADHWCWBrnWksVP6hsI0tWRmbm41OGYO9PhmD3b6120fOaMokNAEq/ds+qZAA8O5oMq4D8AAAD//zouHuEAAAAGSURBVAMAYX64YuQ3mpYAAAAASUVORK5CYII='
const IDLE_ICON = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png' }
const groupedTabs = new Map() // tabId -> groupId（只记我们自己建的组）
const ourGroup = new Map()     // windowId -> groupId（标签组是 per-window 的）
const tabEpoch = new Map()     // tabId -> 递增序号，用来发现"mark 与 unmark 撞车"

/** 受控标签页的 favicon 换成小鼠标（松手还原）。页面导航后 favicon 自然复原，下次控制再补。 */
async function setTabFavicon(tabId, on) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      func: (on, href) => {
        const ID = 'dsh-bridge-cursor-favicon'
        const OFF = 'data-dsh-bridge-rel'
        const old = document.getElementById(ID)
        if (!on) {
          // 把页面自己的图标 link 换回来（rel 改回去 Chrome 就会重算）；
          // 页面一个都没写、靠默认 /favicon.ico 的，光删掉我们的 Chrome 不换回去 —— 补一个指向默认图标的
          const parked = [...document.querySelectorAll(`link[${OFF}]`)]
          if (!old && !parked.length) return
          if (old) old.remove()
          for (const l of parked) { l.rel = l.getAttribute(OFF); l.removeAttribute(OFF) }
          if (!parked.length && !document.querySelector('link[rel~="icon"]')) {
            const d = document.createElement('link')
            d.rel = 'icon'
            d.href = '/favicon.ico'
            d.setAttribute('data-dsh-bridge', 'restore')
            document.head.appendChild(d)
          }
          return
        }
        if (old) return
        // 页面自己有图标的话 Chrome 会优先用它，我们的小鼠标挂不上去 —— 先把它们的 rel 停掉，松手时原样恢复
        for (const l of document.querySelectorAll('link[rel~="icon"]')) {
          l.setAttribute(OFF, l.rel)
          l.rel = 'dsh-bridge-parked-icon'
        }
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
  tabEpoch.set(id, (tabEpoch.get(id) || 0) + 1)
  updateBadge()
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
  let wid = null
  try { wid = (await chrome.tabs.get(id)).windowId } catch {}
  const candidates = []
  if (wid != null && ourGroup.has(wid)) candidates.push(ourGroup.get(wid))
  try {
    for (const g of await chrome.tabGroups.query({ title: GROUP_TITLE })) {
      if (!candidates.includes(g.id)) candidates.push(g.id)
    }
  } catch {}
  for (const gid of candidates) {
    try {
      await chrome.tabs.group({ tabIds: [id], groupId: gid })
      groupedTabs.set(id, gid)
      if (wid != null) ourGroup.set(wid, gid)
      await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: 'blue' })
      return
    } catch {}
  }
  try {
    const gid = await chrome.tabs.group({ tabIds: [id] })
    groupedTabs.set(id, gid)
    if (wid != null) ourGroup.set(wid, gid)
    await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: 'blue' })
  } catch (e) {
    console.log('[dsh-bridge] 分组失败（不影响干活）:', String(e && e.message || e))
  }
}

async function unmarkTab(tabId) {
  const id = Number(tabId)
  const epoch = tabEpoch.get(id) || 0      // 竞态守卫：await 期间如果有新的 mark，就放弃这次 unmark
  updateBadge()
  cursorReady.delete(id)      // 必修：不清的话，松手后小鼠标灭了就再也不亮（页面里的光标其实还在）
  cursorPos.delete(id)        // 松手后再接手，光标从新目标处冒出来，不从老地方飞
  await hidePageCursor(id)    // 尽力把页内光标收掉（松手不留痕）
  await markCursor(id, false)
  if ((tabEpoch.get(id) || 0) !== epoch) return   // 期间又被 mark 了，别拆
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
          if (t.windowId != null) ourGroup.set(t.windowId, g.id)
        } else if (!attached.has(t.id)) {   // 重新确认一次：启动瞬间并发进来的 op 别被误拆
          groupedTabs.set(t.id, g.id)       // 先认领，unmarkTab 才会真的去拆
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
    // Runtime.enable 会把接上之前的 console 和 JS 报错补发一遍（V8 自己存着），Log.enable 同理补发浏览器日志
    for (const d of ['Page', 'DOM', 'Runtime', 'Network', 'Log']) {
      try { await chrome.debugger.sendCommand({ tabId: Number(tabId) }, d + '.enable', {}) } catch {}
    }
    // 后台标签页 / 被挡住的窗口里页面是 hidden，不开焦点模拟的话 CDP 鼠标键盘事件会被直接丢掉
    try { await chrome.debugger.sendCommand({ tabId: Number(tabId) }, 'Emulation.setFocusEmulationEnabled', { enabled: true }) } catch {}
    await markTab(tabId)
  }
  return Number(tabId)
}

// 正在执行的 CDP 调用计数：空闲断开不能把"正干着活"的标签页掐了
const inflight = new Map()

async function send(tabId, method, params) {
  const id = Number(tabId)
  // 必修：以前只有 evaluate 之前才 ensure，key/hover/scroll/dialog 这些直接 send 的 op
  // 在空闲松手后永远失败。统一在这里 ensure：既能自动重连，也顺带刷新 lastUsed。
  await ensure(id)
  inflight.set(id, (inflight.get(id) || 0) + 1)
  const p = chrome.debugger.sendCommand({ tabId: id }, method, params || {})
  try {
    // 兜底：任何 CDP 命令都不该把 op 挂死（历史上 mouseWheel 就不回包）
    return await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`CDP ${method} 15 秒没回应`)), 15000)),
    ])
  } finally {
    const n = (inflight.get(id) || 1) - 1
    if (n <= 0) inflight.delete(id); else inflight.set(id, n)
  }
}

/**
 * 发出去、不要求回包的 CDP 命令。
 * 实测：Input.dispatchMouseEvent 的 mouseWheel 在 Chrome 155 上**事件生效但不回包**，
 * 用 send() 等回复会把 scroll 挂死（客户端 45 秒超时）。这里等一小会儿就走。
 */
async function sendNoReply(tabId, method, params, graceMs = 1500) {
  const id = Number(tabId)
  await ensure(id)
  inflight.set(id, (inflight.get(id) || 0) + 1)
  try {
    await Promise.race([
      chrome.debugger.sendCommand({ tabId: id }, method, params || {}).catch(() => {}),
      new Promise((res) => setTimeout(res, graceMs)),
    ])
  } finally {
    const n = (inflight.get(id) || 1) - 1
    if (n <= 0) inflight.delete(id); else inflight.set(id, n)
  }
}

chrome.debugger.onDetach.addListener((src) => {
  if (src && src.tabId != null) {
    attached.delete(src.tabId)
    lastUsed.delete(src.tabId)
    unmarkTab(src.tabId).catch((e) => log('unmark 失败:', String(e && e.message || e)))   // 用户点掉调试提示也算松手
  }
})

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method === 'Page.loadEventFired') {
    cursorReady.delete(src.tabId)
    markCursor(src.tabId, false).catch(() => {})   // 导航后页内光标没了，标签上的小鼠标跟着灭
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
    // WebSocket/SSE 这类连接永不 finished，netPending 得有个上限（NET 有 400，它原来没有）
    if (netPending.size > NET_MAX) {
      const oldest = netPending.keys().next().value
      netPending.delete(oldest)
    }
    netPending.set(params.requestId, {
      id: params.requestId, tabId: src.tabId, method: params.request.method, url: params.request.url,
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
    const args = params.args || []
    const f = params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0]
    const item = { tabId: src.tabId, level: params.type, kind: 'console', text: args.map(fmtArg).join(' '),
      at: params.timestamp, where: f && f.url ? `${f.url}:${f.lineNumber + 1}` : '' }
    // 调试器接上前打的旧消息是 V8 补发的，补发不带对象预览（只剩 "Object"）——回页面里展开一下
    if (pushConsole(item) && args.some(needsExpand)) {
      expandArgs(src.tabId, args).then((t) => { item.text = t.slice(0, 2000) }).catch(() => {})
    }
  }
  if (method === 'Runtime.exceptionThrown') {
    // 没被 catch 的 JS 报错 —— 调试网页时最要紧的一类，console API 那条路收不到
    const d = params.exceptionDetails || {}
    pushConsole({ tabId: src.tabId, level: 'error', kind: 'exception',
      text: (d.exception && (d.exception.description || d.exception.value)) || d.text || 'Uncaught',
      at: params.timestamp, where: d.url ? `${d.url}:${(d.lineNumber || 0) + 1}` : '' })
  }
  if (method === 'Log.entryAdded') {
    // 浏览器自己报的：请求失败、CSP 拦截、废弃 API 警告……
    const e = params.entry || {}
    if (e.level !== 'verbose') {
      pushConsole({ tabId: src.tabId, level: e.level, kind: e.source || 'browser', text: e.text || '',
        at: e.timestamp, where: e.url || '' })
    }
  }
})

/** console 参数 → 一段字。对象/数组用 V8 带的预览拼成 {a: 1, b: "x"}，不然只看得到 "Object"。 */
function fmtArg(a) {
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value)
  if (a.unserializableValue) return a.unserializableValue
  const p = a.preview
  if (p && p.properties && (p.subtype === 'array' || (p.type === 'object' && !p.subtype))) {
    const val = (x) => (x.type === 'string' ? JSON.stringify(x.value) : x.value ?? x.type)
    const more = p.overflow ? ', …' : ''
    return p.subtype === 'array'
      ? `[${p.properties.map(val).join(', ')}${more}]`
      : `{${p.properties.map((x) => `${x.name}: ${val(x)}`).join(', ')}${more}}`
  }
  return a.description || a.type
}

const needsExpand = (a) => a.objectId && !a.preview && a.type === 'object' && (!a.subtype || a.subtype === 'array')

/** 页内把对象拼成和预览一样的样子：{a: 1, b: "x"} / [1, 2] */
const EXPAND_FN = `function () {
  const v = (x) => typeof x === 'string' ? JSON.stringify(x) : x === null ? 'null'
    : Array.isArray(x) ? 'Array(' + x.length + ')'
    : typeof x === 'object' ? ((x.constructor && x.constructor.name) || 'Object')
    : typeof x === 'function' ? 'ƒ' : String(x);
  if (Array.isArray(this)) return '[' + this.slice(0, 20).map(v).join(', ') + (this.length > 20 ? ', …' : '') + ']';
  const ks = Object.keys(this);
  return '{' + ks.slice(0, 20).map((k) => k + ': ' + v(this[k])).join(', ') + (ks.length > 20 ? ', …' : '') + '}';
}`

async function expandArgs(tabId, args) {
  const parts = []
  for (const a of args) {
    if (!needsExpand(a)) { parts.push(fmtArg(a)); continue }
    try {
      const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn',
        { objectId: a.objectId, functionDeclaration: EXPAND_FN, returnByValue: true, silent: true })
      parts.push(r && r.result && typeof r.result.value === 'string' ? r.result.value : fmtArg(a))
    } catch {
      parts.push(fmtArg(a))
    }
  }
  return parts.join(' ')
}

/** 重新 attach 时 V8 会把旧消息补发一遍 —— 按「标签页 + 时间 + 内容」去重。 */
function pushConsole(item) {
  item.text = String(item.text || '').slice(0, 2000)
  item.at = Math.round(Number(item.at) || Date.now())
  item.key = item.text   // 去重按原始文字比：text 之后可能被 expandArgs 改写
  const dup = CONSOLE.some(c => c.tabId === item.tabId && c.at === item.at && c.key === item.key)
  if (dup) return false
  CONSOLE.push(item)
  if (CONSOLE.length > 300) CONSOLE.shift()
  return true
}

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
            // 输入框没 innerText，退到 aria-label / placeholder；密码框的 value 绝不拿出来（会上名牌、进工具结果）
            text: __dsh_norm(el.innerText || (el.type === 'password' ? '' : el.value) || el.getAttribute('aria-label') ||
              el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').slice(0, 80) });
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

/** 页内光标：注入过一次就记住，导航后失效要重注；位置按标签页记着，换了页面从原处接着出现 */
const cursorReady = new Set()
const cursorPos = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function injectCursor(tabId, script) {
  if (!script || !showCursor) return false
  const id = Number(tabId)
  if (!cursorReady.has(id)) {
    await evaluate(tabId, script)
    const p = cursorPos.get(id)
    if (p) await evaluate(tabId, `window.__dshCursor.pos() || window.__dshCursor.place(${p.x}, ${p.y})`).catch(() => {})
    cursorReady.add(id)
    // 语义：标签页上出现小鼠标 = 这个页面里真的有一只鼠标（页内光标已就位）
    await markCursor(tabId, true)
  }
  return true
}

/**
 * 调页内光标。cursorReady 可能已经过期（页面刚跳走、loadEventFired 还没到；或者页面里还是旧版光标），
 * 所以表达式里先探一下 v3 光标在不在，不在就重注一次再来。光标装不上返回 undefined。
 */
async function cursorDo(tabId, script, expr) {
  const id = Number(tabId)
  const NONE = '__dsh_no_cursor__'
  const probe = `((window.__dshCursor && window.__dshCursor.version >= 3) ? (${expr}) : ${JSON.stringify(NONE)})`
  if (!cursorReady.has(id) && !(await injectCursor(tabId, script))) return undefined
  let r = await evaluate(tabId, probe)
  if (r === NONE) {
    cursorReady.delete(id)
    if (!(await injectCursor(tabId, script))) return undefined
    r = await evaluate(tabId, probe)
  }
  return r === NONE ? undefined : r
}

/** 光标滑到 (x, y)，可顺带亮出名牌文字。返回滑行时长 ms；光标装不上返回 null（不影响真实操作）。 */
async function cursorMove(tabId, script, x, y, opts = {}) {
  const px = Math.round(Number(x))
  const py = Math.round(Number(y))
  const mo = { straight: !!opts.straight }
  if (opts.duration != null) mo.duration = Math.max(0, Math.round(Number(opts.duration)))
  const say = opts.label ? `c.label(${JSON.stringify(String(opts.label).slice(0, 80))});` : ''
  try {
    const d = await cursorDo(tabId, script, `(() => { const c = window.__dshCursor; ${say} return c.move(${px}, ${py}, ${JSON.stringify(mo)}) })()`)
    if (d === undefined) return null
    cursorPos.set(Number(tabId), { x: px, y: py })
    return Number(d) || 0
  } catch { return null }
}

/** 光标的其它表情（click / down / up / label / scroll）：只在光标已经在页面里时做，出错不管 */
async function cursorFx(tabId, expr) {
  if (!cursorReady.has(Number(tabId))) return undefined
  try { return await cursorDo(tabId, '', expr) } catch { return undefined }
}

/** 等光标飞到位：人眼先看到"要点这儿"，再发真实事件 */
const settle = (d) => sleep(Math.min(700, Math.max(120, d || 0)) + 40)

/** 用 scripting 在 MAIN world 收掉页内光标（不依赖 CDP，调试器已断开时也能收）。 */
async function hidePageCursor(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: 'MAIN',
      func: () => { try { window.__dshCursor && window.__dshCursor.hide() } catch {} },
    })
  } catch {}
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

async function clickPoint(tabId, x, y, opts = {}) {
  const n = Number(opts.clickCount || 1)
  const button = opts.button || 'left'
  const base = { x: Math.round(x), y: Math.round(y), button, clickCount: n }

  // 先让光标飞过去，人眼看得见，再发真实点击
  if (opts.cursor && opts.cursor.script) {
    const d = await cursorMove(tabId, opts.cursor.script, base.x, base.y, { label: opts.cursor.label })
    if (d !== null) {
      await settle(d)
      await cursorFx(tabId, `(window.__dshCursor.click(${base.x}, ${base.y}, ${n}), 1)`)
    }
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

  async console({ limit = 40, tabId, clear = false } = {}) {
    if (clear) {
      for (let i = CONSOLE.length - 1; i >= 0; i--) {
        if (tabId == null || CONSOLE[i].tabId === Number(tabId)) CONSOLE.splice(i, 1)
      }
      return { cleared: true }
    }
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
    // 名牌写上在输什么；密码框只显示圆点，不把密码亮在屏幕上
    const shown = JSON.stringify(text.length > 24 ? text.slice(0, 24) + '…' : text)
    await cursorFx(tabId, `(() => { const a = document.activeElement; window.__dshCursor.label(a && a.type === 'password' ? '输入 ••••••' : '输入「' + ${shown} + '」'); return 1 })()`)
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

  async hover({ tabId, x, y, selector, script }) {
    let px = Number(x) || 0, py = Number(y) || 0, target = null
    if (selector) {
      const pt = await pointOf(tabId, `const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; return __dsh_point(el);`)
      px = pt.x; py = pt.y; target = pt
    }
    if (script) {
      const d = await cursorMove(tabId, script, px, py, { label: `悬停 ${target ? target.text || target.tag : `(${Math.round(px)}, ${Math.round(py)})`}` })
      if (d !== null) await settle(d)
    }
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(px), y: Math.round(py), buttons: 0 })
    return { x: Math.round(px), y: Math.round(py), target }
  },

  async scroll({ tabId, x = 200, y = 200, deltaY = 600, deltaX = 0 }) {
    const before = await evaluate(tabId, 'Math.round(window.scrollY)')
    await cursorFx(tabId, `(window.__dshCursor.label(${JSON.stringify(deltaY < 0 ? '向上滚动' : '向下滚动')}, 1400), window.__dshCursor.scroll(${deltaY < 0 ? -1 : 1}), 1)`)
    await sendNoReply(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(x), y: Math.round(y),
      deltaX: Math.round(deltaX), deltaY: Math.round(deltaY),
    })
    let after = await evaluate(tabId, '({ scrollY: Math.round(window.scrollY), pageHeight: Math.round(document.documentElement.scrollHeight) })')
    let via = 'wheel'
    if (after.scrollY === before) {
      // 后台/不可见标签页里 Chrome 不会为滚轮合成帧（实测 mouseWheel 事件发了但页面不动），
      // 退回 JS 滚动 —— 想要的效果是"页面滚下去"，不是"必须是合成事件"。
      after = await evaluate(tabId, `(() => { window.scrollBy(0, ${Math.round(deltaY)}); return { scrollY: Math.round(window.scrollY), pageHeight: Math.round(document.documentElement.scrollHeight) } })()`)
      via = 'js'
    }
    return { deltaY, via, ...after }
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
        // 后台标签页会暂停 rAF —— 只等 rAF 会卡满 15 秒，定时器兜底（同 __dsh_point）
        return new Promise((res) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            const r = el.getBoundingClientRect();
            res({ x: r.left, y: r.top, width: r.width, height: r.height });
          };
          requestAnimationFrame(() => requestAnimationFrame(finish));
          setTimeout(finish, 120);
        });
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
    // 只清这个标签页的；不给 tabId 才全清（别把别的标签页的记录也抹了）
    const dropTab = (id) => { for (let i = NET.length - 1; i >= 0; i--) if (NET[i].tabId === id) NET.splice(i, 1) }
    if (clear) { if (tabId != null) dropTab(Number(tabId)); else NET.length = 0; return { cleared: true } }
    // Network 事件只在 attach 之后才有，所以先 attach；要历史就 --reload 刷一次
    if (tabId != null && reload) {
      await ensure(tabId)
      dropTab(Number(tabId))
      await send(tabId, 'Page.reload', {})
      await new Promise(r => setTimeout(r, Number(waitMs)))
    } else if (tabId != null) {
      await ensure(tabId)
    }
    let items = tabId != null ? NET.filter(n => n.tabId === Number(tabId)) : NET
    if (filter) items = items.filter(n => (n.url || '').includes(filter) || (n.method || '').includes(filter))
    return {
      items: items.slice(-limit).map(n => ({
        id: n.id, method: n.method, status: n.status, url: n.url, type: n.type, mime: n.mime, ms: n.ms, failed: n.failed,
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

  /** 页内光标：调用方把脚本内容传进来（每次都带也没事，注入过就不再执行），这里负责注入 + 调用 */
  async cursor({ tabId, script, action, x, y, duration, straight, text }) {
    const id = Number(tabId)
    if (action === 'hide' || action === 'clear') {
      try { await evaluate(tabId, 'window.__dshCursor && window.__dshCursor.hide()') }
      finally { cursorReady.delete(id); cursorPos.delete(id); await markCursor(tabId, false) }
      return { action }
    }
    if (!showCursor) return { action, skipped: '用户在弹窗里关了页内光标', duration: 0 }
    const missing = () => new Error('光标脚本没装上（第一次调用要带 script）')
    if (action === 'move' || action === 'click') {
      const d = await cursorMove(tabId, script, x, y, { duration, straight, label: text })
      if (d === null) throw missing()
      if (action === 'click') {
        await settle(d)
        await cursorDo(tabId, script, `(window.__dshCursor.click(${Math.round(x)}, ${Math.round(y)}), 1)`)
      }
      return { action, x, y, duration: d }
    }
    const fx = { down: 'down()', up: 'up()', label: `label(${JSON.stringify(String(text || ''))})` }[action]
    if (!fx) throw new Error(`不认识的光标动作: ${action}（move/click/down/up/label/hide/clear）`)
    if ((await cursorDo(tabId, script, `(window.__dshCursor.${fx}, 1)`)) === undefined) throw missing()
    return { action }
  },
}

// ── 弹窗（popup.html）的接口 ─────────────────────────────────────────────────

async function buildState() {
  if (port && (!hostInfo || Date.now() - hostInfo.at > 5000)) post({ hostPing: true })
  const now = Date.now()
  const tabInfo = new Map()
  for (const t of await chrome.tabs.query({})) tabInfo.set(t.id, t)
  const self = `chrome-extension://${chrome.runtime.id}/`
  const tabView = (id) => {
    const t = tabInfo.get(id)
    if (!t || (t.url || '').startsWith(self)) return null   // 弹窗页自己不算
    return {
      // 我们给受控标签页换上的小鼠标图标不是网站自己的，别拿来当它的图标
      id, title: t.title || '', url: t.url || '', favIconUrl: t.favIconUrl === CURSOR_FAVICON ? '' : t.favIconUrl || '',
      attached: attached.has(id), busy: inflight.has(id), lastUsed: lastUsed.get(id) || 0,
      dialog: dialogs.get(id) || null,
    }
  }
  const owned = new Set()
  const sessions = []
  for (const [k, s] of [...SESSIONS].sort((a, b) => b[1].last - a[1].last)) {
    for (const id of s.tabs) if (!tabInfo.has(id)) s.tabs.delete(id)
    const tabs = [...s.tabs].map(tabView).filter(Boolean)
      .sort((a, b) => (b.attached - a.attached) || (b.lastUsed - a.lastUsed))
    // 两小时没动静、手上也没有标签页的会话就不显示了
    if (!tabs.some((t) => t.attached) && now - s.last > 2 * 3600e3) { SESSIONS.delete(k); continue }
    tabs.forEach((t) => owned.add(t.id))
    sessions.push({ key: s.key, kind: s.kind, session: s.session, pid: s.pid,
      first: s.first, last: s.last, ops: s.ops, errors: s.errors, tabs })
  }
  const orphans = [...attached].filter((id) => !owned.has(id)).map(tabView).filter(Boolean)
  return {
    now,
    version: chrome.runtime.getManifest().version,
    connected: !!port,
    paused,
    host: hostInfo,
    idleMs: DETACH_IDLE_MS,
    attachedCount: controlledCount(),
    showCursor,
    sessions,
    orphans,
    activity: ACTIVITY.slice(-30).reverse().map((a) => ({
      ...a, title: a.tabId != null && tabInfo.has(a.tabId) ? tabInfo.get(a.tabId).title : '',
    })),
  }
}

async function releaseTab(tabId) {
  await OPS.detach({ tabId })
  ACTIVITY.push({ at: Date.now(), last: Date.now(), key: 'user', call: null, tool: null, hint: '',
    op: 'userRelease', tabId: Number(tabId), ok: true, ms: 0, ops: 1 })
  if (ACTIVITY.length > ACTIVITY_MAX) ACTIVITY.shift()
}

async function diagnostics() {
  const st = await buildState()
  const h = st.host
  const lines = [
    `DSH Bridge ${st.version}（${chrome.runtime.id}）`,
    `浏览器：${navigator.userAgent}`,
    `宿主：${st.connected ? '已连接' : '没连上'}${h ? `，pid ${h.pid}，socket ${h.socketOk ? '在听' : '没在听'}（${h.socket}），已处理 ${h.served} 次请求` : ''}`,
    `暂停：${st.paused ? '是' : '否'}；页内光标：${st.showCursor ? '显示' : '关闭'}；受控标签页：${st.attachedCount}`,
    `会话：${st.sessions.map((s) => `${s.key}（${s.ops} 次操作，${s.errors} 次失败，${s.tabs.length} 个标签页）`).join('；') || '无'}`,
    '',
    '最近失败：',
    ...ACTIVITY.filter((a) => !a.ok).slice(-10).map((a) =>
      `  ${new Date(a.at).toTimeString().slice(0, 8)} ${a.tool || a.op} ${a.hint || ''} → ${a.error}`),
    '',
    '扩展日志（最近 30 行）：',
    ...LOG.slice(-30).map((l) => `  ${l}`),
  ]
  return lines.join('\n')
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.popup || sender.id !== chrome.runtime.id) return
  const run = async () => {
    switch (msg.popup) {
      case 'state':
        return buildState()
      case 'reconnect':
        if (port) { try { port.disconnect() } catch {} ; port = null; hostInfo = null }
        connect()
        await new Promise((r) => setTimeout(r, 700))
        return buildState()
      case 'release':
        await releaseTab(msg.tabId)
        return buildState()
      case 'releaseAll':
        for (const id of [...attached]) await releaseTab(id)
        return buildState()
      case 'focus':
        await OPS.activate({ tabId: msg.tabId })
        return buildState()
      case 'pause':
        paused = !!msg.on
        await chrome.storage.local.set({ paused })
        log(paused ? '用户暂停了浏览器控制' : '用户恢复了浏览器控制')
        if (paused) for (const id of [...attached]) await releaseTab(id)
        updateBadge()
        return buildState()
      case 'cursor':
        showCursor = !!msg.on
        await chrome.storage.local.set({ showCursor })
        log(showCursor ? '用户打开了页内光标' : '用户关掉了页内光标')
        if (!showCursor) {
          for (const id of [...cursorReady]) {
            cursorReady.delete(id)
            cursorPos.delete(id)
            await hidePageCursor(id)
            await markCursor(id, false)
          }
        }
        return buildState()
      case 'diagnostics':
        return { text: await diagnostics() }
      default:
        throw new Error(`弹窗发了不认识的请求: ${msg.popup}`)
    }
  }
  run().then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }))
  return true
})

// ── 保活 / 启动 ─────────────────────────────────────────────────────────────

chrome.alarms.create('dsh-keepalive', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'dsh-keepalive') return
  detachIdle().catch((e) => log('detachIdle 失败:', String(e && e.message || e)))   // 空闲超过 60 秒的标签页断开调试
  if (!port) connect()
  else post({ id: 'ka-' + Date.now(), ok: true, keepalive: true })
})

chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
// 每次 worker 起来都对一次账：认领还活着的分组、拆掉孤儿组和残留角标
reconcileGroups()
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const sess of SESSIONS.values()) sess.tabs.delete(tabId)
  ownTabs.delete(tabId)
  attached.delete(tabId)
  updateBadge()
  lastUsed.delete(tabId)
  groupedTabs.delete(tabId)   // 标签页都没了，组也轮不到我们拆
  cursorReady.delete(tabId)
  cursorPos.delete(tabId)
  tabEpoch.delete(tabId)
  dialogs.delete(tabId)
  loadWaiters.delete(tabId)
})
connect()
