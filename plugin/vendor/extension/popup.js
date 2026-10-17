/**
 * DSH Bridge 弹窗：连没连上、哪些会话在用、动了哪些标签页、最近做了什么。
 * 数据全在 background.js 里（buildState），这里每秒拉一次。
 * 状态卡和开关是固定骨架、只改文字和 class（整块重画会让呼吸灯、流动线、开关动画每秒从头播）；
 * 会话和动作列表内容变了才重画。
 */

const $ = (id) => document.getElementById(id)

const svg = (body, view = '0 0 16 16', attrs = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"') =>
  `<svg viewBox="${view}" ${attrs}>${body}</svg>`

const ICON = {
  check: svg('<path d="M3.6 8.4l2.9 2.9 5.9-6.4"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"'),
  pause: svg('<rect x="4.2" y="3.5" width="2.6" height="9" rx="1"/><rect x="9.2" y="3.5" width="2.6" height="9" rx="1"/>', '0 0 16 16', 'fill="currentColor"'),
  bang: svg('<path d="M8 3.6v5.6"/><path d="M8 12.2v.1"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"'),
  dots: svg('<circle cx="4" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12" cy="8" r="1.3"/>', '0 0 16 16', 'fill="currentColor"'),
  open: svg('<path d="M6 3.5h6.5V10"/><path d="M12.5 3.5 4 12"/>'),
  release: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  x: svg('<path d="M5 5l6 6M11 5l-6 6"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"'),
  person: svg('<circle cx="8" cy="5.4" r="2.4"/><path d="M3.6 13.2c.6-2.4 2.3-3.7 4.4-3.7s3.8 1.3 4.4 3.7"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"'),
  bubble: svg('<path d="M3 11.5V6.2a3.2 3.2 0 0 1 3.2-3.2h3.6A3.2 3.2 0 0 1 13 6.2v1.6a3.2 3.2 0 0 1-3.2 3.2H6l-3 2.5z"/><path d="M6.2 7.2h.01M9.8 7.2h.01"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'),
  term: svg('<path d="M3.5 5l3 3-3 3"/><path d="M8.5 11.5h4"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'),
  question: svg('<path d="M5.8 6a2.3 2.3 0 1 1 3.3 2c-.7.4-1.1.9-1.1 1.7"/><path d="M8 12.3v.1"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"'),
  globe: svg('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.3"'),
  cursor: svg('<path fill="currentColor" d="M5 3.4v15.4c0 .75.9 1.12 1.42.58l3.6-3.76 2.9 5.94c.24.48.82.68 1.3.45l1.9-.92c.48-.23.68-.8.45-1.28l-2.88-5.9 5.2-.18c.77-.03 1.13-.97.56-1.5L6.64 2.7C6.08 2.18 5 2.6 5 3.4z"/>', '0 0 24 24', ''),
}

const TOOL = {
  browser_tabs: '标签页', browser_read: '读页面', browser_click: '点击', browser_input: '输入',
  browser_nav: '导航', browser_screenshot: '截图', browser_eval: '跑脚本', browser_wait: '等待',
  browser_dialog: '弹窗', browser_drag: '拖拽', browser_devtools: '调试',
}
const OP = {
  tabs: '列标签页', open: '开标签页', close: '关标签页', activate: '切标签页', text: '读文字', html: '读 HTML',
  attr: '读属性', info: '页面信息', eval: '跑脚本', click: '点击', clickEl: '点击', clickText: '点击',
  type: '打字', key: '按键', select: '选下拉', upload: '传文件', focus: '聚焦', hover: '悬停', scroll: '滚动',
  nav: '跳转', shot: '截图', waitFor: '等元素', dialog: '处理弹窗', console: '看控制台', network: '看网络',
  cursor: '光标', attach: '接管', detach: '松手', screencast: '录屏', userRelease: '你松手了',
  'cdp:Input.dispatchMouseEvent': '鼠标', 'cdp:Page.captureScreenshot': '截图', 'cdp:Page.reload': '刷新',
  'cdp:Page.navigateToHistoryEntry': '后退/前进', 'cdp:Network.getResponseBody': '看返回内容',
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 5) return '刚刚'
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

function span(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`
  return `${Math.floor(s / 3600)} 小时`
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8)

function host(url) {
  try {
    const u = new URL(url)
    return u.protocol.startsWith('http') ? u.host : u.protocol.replace(':', '')
  } catch {
    return ''
  }
}

const shortId = (raw) => {
  const id = String(raw).replace(/^session-/, '')
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

/** 内容真变了才动 DOM：不打断悬停、按下、动画 */
function setHTML(el, html) {
  if (el.__html === html) return
  el.__html = html
  el.innerHTML = html
}
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text
}
function setClass(el, cls) {
  if (el.className !== cls) el.className = cls
}

// ── 状态卡 ──────────────────────────────────────────────────────────────────

function renderStatus(st) {
  const h = st.host
  const dshRecent = h && h.lastClientAt && st.now - h.lastClientAt < 10 * 60e3
  const lastDsh = st.sessions.find((s) => s.kind === 'dsh')

  const hostSub = !st.connected ? '没连上' : h ? (h.socketOk ? `运行 ${span(st.now - h.startedAt)}` : 'socket 没开') : '已连接'
  const hostCls = !st.connected || (h && !h.socketOk) ? 'off' : 'on'
  const dshSub = !st.connected ? '—' : lastDsh ? `${ago(lastDsh.last, st.now)}用过` : dshRecent ? '已连上' : '等它来调用'
  const dshCls = !st.connected ? 'idle' : lastDsh || dshRecent ? 'on' : 'idle'

  const node = (id, cls, sub, tip = sub) => {
    const el = $(id)
    setClass(el, `node ${cls}`)
    const small = el.querySelector('small')
    setText(small, sub)
    small.title = tip
  }
  node('nExt', 'on', `扩展 v${st.version}`)
  node('nHost', hostCls, hostSub, h ? `pid ${h.pid}，已处理 ${h.served} 次请求\n${h.socket}` : hostSub)
  node('nDsh', dshCls, dshSub)
  setClass($('w1'), `wire ${st.connected ? 'on' : 'off'}`)
  setClass($('w2'), `wire ${hostCls === 'on' && dshCls === 'on' ? 'on' : ''}`)

  let mood, icon, title, sub, extra = ''
  if (!st.connected) {
    mood = 'bad'; icon = 'bang'; title = '没连上本地宿主'; sub = 'DSH 现在用不了浏览器'
    extra = `<p class="explain">多半是宿主没装好，或者 Node 换了位置。在终端里跑一下，跑完点右上角重新连接：</p>
      <div class="cmd"><code>dsh-chrome-bridge update</code><button class="link" type="button" data-act="copyCmd">复制</button></div>`
  } else if (st.paused) {
    mood = 'warn'; icon = 'pause'; title = '已暂停'; sub = 'DSH 现在动不了你的浏览器'
  } else {
    const n = st.attachedCount
    mood = 'ok'; icon = 'check'; title = '已连接'; sub = n ? `正在控制 ${n} 个标签页` : '待命中，没有在控制标签页'
  }
  setClass($('status'), `card hero ${mood}`)
  setHTML($('orb'), ICON[icon])
  setText($('stTitle'), title)
  setText($('stSub'), sub)
  setHTML($('stExtra'), extra)
}

function renderSettings(st) {
  const pause = document.querySelector('input[data-act="pause"]')
  const cursor = document.querySelector('input[data-act="cursor"]')
  if (pause.checked !== !st.paused) pause.checked = !st.paused
  const showCursor = st.showCursor !== false
  if (cursor.checked !== showCursor) cursor.checked = showCursor
}

// ── 会话 ────────────────────────────────────────────────────────────────────

function tabState(t, st) {
  if (t.dialog) return `<span class="state warn">有 ${esc(t.dialog.type)} 弹窗挡着</span>`
  if (!t.attached) return '<span class="state gone">已松手</span>'
  if (t.busy || st.now - t.lastUsed < 2500) return '<span class="state busy">操作中</span>'
  const left = Math.max(0, Math.ceil((st.idleMs - (st.now - t.lastUsed)) / 1000))
  return `<span class="state idle">待命 · ${left > 0 ? `${left} 秒后自动松手` : '马上自动松手'}</span>`
}

/** 加载失败过的 favicon：每秒重画时别再试一次（不然会一闪一闪） */
const badFav = new Set()

function favicon(t) {
  const u = t.favIconUrl
  const inner = u && /^(https?:|data:)/.test(u) && !badFav.has(u) ? `<img class="fav" src="${esc(u)}" alt="">` : ICON.globe
  return `<span class="fav-tile">${inner}</span>`
}

function tabRow(t, st) {
  const where = host(t.url)
  return `<div class="row tab ${t.attached ? '' : 'released'}">
    ${favicon(t)}
    <span class="row-main">
      <span class="row-title" title="${esc(t.title)}">${esc(t.title || t.url || '(无标题)')}</span>
      <span class="row-sub">${esc(where)}${where ? ' · ' : ''}${tabState(t, st)}</span>
    </span>
    <span class="acts">
      <button class="icon-btn" type="button" data-act="focus" data-tab="${t.id}" title="切过去看看" aria-label="切到这个标签页">${ICON.open}</button>
      ${t.attached ? `<button class="icon-btn danger" type="button" data-act="release" data-tab="${t.id}" title="松手：断开调试，标签页留着" aria-label="松手">${ICON.release}</button>` : ''}
    </span>
  </div>`
}

function who(s) {
  if (s.kind === 'cli') return { tile: '<span class="tile gray">' + ICON.term + '</span>', name: 'cb 命令行' }
  if (s.kind === 'other') return { tile: '<span class="tile orange">' + ICON.question + '</span>', name: '来源不明（旧版本宿主）' }
  return {
    tile: '<span class="tile blue">' + ICON.bubble + '</span>',
    name: s.session ? `会话 <code title="${esc(s.session)}">${esc(shortId(s.session))}</code>`
      : `DSH 桌面端${s.pid ? ` <code>pid ${s.pid}</code>` : ''}`,
  }
}

const meta = (s, st) => s.kind === 'other' ? '扩展知道它们在被控制，但不知道是谁'
  : `${ago(s.last, st.now)} · ${s.ops} 次操作${s.errors ? ` · <span class="err">${s.errors} 次失败</span>` : ''}`

/** 半小时没动静、手上也没标签页的会话不占地方 */
const STALE_MS = 30 * 60e3

function renderSessions(st) {
  const list = st.sessions.filter((s) => s.tabs.length || st.now - s.last < STALE_MS)
  if (st.orphans.length) {
    list.unshift({ key: 'orphans', kind: 'other', session: null, pid: null, last: 0, ops: 0, errors: 0, tabs: st.orphans })
  }
  setText($('sessCount'), String(list.length))
  if (!list.length) {
    setHTML($('sessions'), `<div class="card empty">
      <span class="tile blue">${ICON.cursor}</span>
      <b>还没有会话</b>
      <span>在 DSH 里让它操作浏览器，这里会实时显示它在动哪些标签页。</span>
    </div>`)
    return
  }
  // 手上有标签页的会话各占一张卡；只是最近来过、手上空着的，挤进同一张卡里一行一个
  const busy = list.filter((s) => s.tabs.length)
  const idle = list.filter((s) => !s.tabs.length)
  const cards = busy.map((s) => {
    const live = s.tabs.filter((t) => t.attached).length
    const w = who(s)
    return `<div class="card list sess">
      <div class="row sess-head">
        ${w.tile}
        <span class="row-main"><span class="row-title">${w.name}</span><span class="row-sub">${meta(s, st)}</span></span>
        <span class="cap ${live ? 'on' : ''}">${live} 个 Tab</span>
      </div>
      ${s.tabs.map((t) => tabRow(t, st)).join('')}
    </div>`
  })
  if (idle.length) {
    cards.push(`<div class="card list sess">${idle.map((s) => {
      const w = who(s)
      return `<div class="row">
        ${w.tile}
        <span class="row-main"><span class="row-title">${w.name}</span><span class="row-sub">${s.ops} 次操作${s.errors ? ` · <span class="err">${s.errors} 次失败</span>` : ''} · 没在控制标签页</span></span>
        <span class="ago">${ago(s.last, st.now)}</span>
      </div>`
    }).join('')}</div>`)
  }
  setHTML($('sessions'), cards.join(''))
}

// ── 最近动作 ────────────────────────────────────────────────────────────────

let showAllActivity = false

function renderActivity(st) {
  const all = st.activity
  const items = showAllActivity ? all : all.slice(0, 6)
  $('moreAct').hidden = all.length <= 6
  setText($('moreAct'), showAllActivity ? '收起' : `全部 ${all.length}`)
  if (!all.length) {
    setHTML($('activity'), '<li class="row act-empty">还没有动作</li>')
    return
  }
  setHTML($('activity'), items.map((a) => {
    const label = a.tool ? TOOL[a.tool] || a.tool : OP[a.op] || a.op
    const user = a.key === 'user'
    const ms = a.ms >= 1000 ? `${(a.ms / 1000).toFixed(1)}s` : `${a.ms}ms`
    const sub = [a.title, clock(a.at)].filter(Boolean).map(esc).join(' · ')
    return `<li class="row act ${a.ok ? '' : 'fail'} ${user ? 'user' : ''}" title="${esc([a.hint, a.title, a.error].filter(Boolean).join('\n'))}">
      <span class="mk">${user ? ICON.person : a.ok ? ICON.check : ICON.x}</span>
      <span class="main"><b>${esc(label)}</b> <span class="hint">${esc(a.hint || '')}</span></span>
      <span class="ms">${user ? '' : ms}</span>
      <span class="sub">${sub}</span>
      ${a.ok ? '' : `<span class="why">${esc(a.error || '失败')}</span>`}
    </li>`
  }).join(''))
}

// ── 主循环 ──────────────────────────────────────────────────────────────────

let last = null

function render(st) {
  if (!st || st.error) {
    setClass($('status'), 'card hero bad')
    setHTML($('orb'), ICON.bang)
    setText($('stTitle'), '扩展后台没回话')
    setText($('stSub'), (st && st.error) || '去 chrome://extensions 重新加载一下 DSH Bridge')
    return
  }
  last = st
  setText($('ver'), `v${st.version}`)
  renderStatus(st)
  renderSettings(st)
  renderSessions(st)
  renderActivity(st)
  $('releaseAll').disabled = !st.attachedCount
}

async function ask(popup, extra = {}) {
  try {
    return await chrome.runtime.sendMessage({ popup, ...extra })
  } catch (e) {
    return { error: String((e && e.message) || e) }
  }
}

let timer = null
async function tick() {
  render(await ask('state'))
}

function toast(text) {
  const t = $('toast')
  t.textContent = text
  t.classList.add('show')
  clearTimeout(toast.h)
  toast.h = setTimeout(() => t.classList.remove('show'), 1800)
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text)
    toast(done)
  } catch {
    toast('复制失败，浏览器没给剪贴板权限')
  }
}

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]')
  if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'LABEL') return
  const act = btn.dataset.act
  const tabId = btn.dataset.tab ? Number(btn.dataset.tab) : undefined
  switch (act) {
    case 'reconnect':
      btn.classList.add('spin')
      render(await ask('reconnect'))
      setTimeout(() => btn.classList.remove('spin'), 500)
      toast(last && last.connected ? '已重新连接' : '还是没连上')
      break
    case 'focus':
      render(await ask('focus', { tabId }))
      break
    case 'release':
      render(await ask('release', { tabId }))
      toast('已松手，标签页还在')
      break
    case 'releaseAll':
      render(await ask('releaseAll'))
      toast('全部松手了')
      break
    case 'copyCmd':
      copy('dsh-chrome-bridge update', '命令已复制，去终端粘贴运行')
      break
    case 'diagnostics': {
      const r = await ask('diagnostics')
      if (r && r.text) copy(r.text, '诊断信息已复制，可以直接发给开发者')
      else toast('拿不到诊断信息')
      break
    }
  }
})

document.addEventListener('change', async (ev) => {
  const input = ev.target.closest('input[data-act]')
  if (!input) return
  if (input.dataset.act === 'pause') {
    const pause = !input.checked
    render(await ask('pause', { on: pause }))
    toast(pause ? '已暂停：DSH 动不了浏览器了' : '已恢复：DSH 可以用浏览器了')
  } else if (input.dataset.act === 'cursor') {
    render(await ask('cursor', { on: input.checked }))
    toast(input.checked ? '页面里会显示 DSH 的光标' : '光标藏起来了，DSH 照常干活')
  }
})

// 列表里 favicon 加载失败就换成小地球（CSP 不让写 onerror，只能在这里接）
document.addEventListener('error', (ev) => {
  const img = ev.target
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('fav')) return
  badFav.add(img.getAttribute('src'))
  const s = document.createElement('span')
  s.innerHTML = ICON.globe
  img.replaceWith(s.firstChild)
}, true)

$('moreAct').addEventListener('click', () => {
  showAllActivity = !showAllActivity
  if (last) renderActivity(last)
})

tick()
timer = setInterval(tick, 1000)
addEventListener('unload', () => clearInterval(timer))
