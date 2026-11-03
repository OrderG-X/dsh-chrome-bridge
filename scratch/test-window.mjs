/**
 * 「新页开在单独窗口」的离线测试：从 background.js 里取出干活窗口那几个函数和 open 操作，
 * 配一个假的 chrome.windows / chrome.tabs / storage 跑；再从 index.js 取出 userTab 测「用户正在看的页」怎么挑。
 * 不碰真 Chrome（真浏览器里的效果由 e2e-chrome.mjs 测）。
 *
 *   node scratch/test-window.mjs
 */

import assert from 'node:assert'
import fs from 'node:fs'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../plugin/vendor/extension/background.js', import.meta.url), 'utf8')
const start = src.indexOf('const agentWindows = {')
const end = src.indexOf('\nasync function ensure(')
assert(start > 0 && end > start, 'background.js 里找不到干活窗口的代码')
const openM = /\n {2}async open\(\{ url, active = false \}\) \{\n[\s\S]*?\n {2}\},\n/.exec(src)
assert(openM, 'background.js 里找不到 open 操作')

/**
 * 假 Chrome。windows：id → {type, state, incognito, left, top, width, height}；tabs：[{id, windowId, active}]。
 * rejectBounds：带位置开窗口就报错（Chrome 的「至少一半在屏幕里」校验）；
 * closeOnCreateTab：往窗口里加标签页的那一下窗口刚好被关掉
 */
function world({ windows = {}, tabs = [], lastFocused = 1, session = {}, ownWindow = true, rejectBounds = false, closeOnCreateTab = false, tabError = null, ids = { win: 50, tab: 500 } } = {}) {
  const calls = []
  const activate = (t) => { for (const o of tabs) if (o.windowId === t.windowId) o.active = false; t.active = true }
  const chrome = {
    windows: {
      get: async (id) => { const w = windows[id]; if (!w) throw new Error(`No window with id: ${id}.`); return { id, incognito: false, ...w } },
      getLastFocused: async (q) => {
        calls.push(['windows.getLastFocused', q])
        const w = windows[lastFocused]; if (!w) throw new Error('No last-focused window'); return { id: lastFocused, incognito: false, ...w }
      },
      create: async (props) => {
        calls.push(['windows.create', props])
        await new Promise((r) => setTimeout(r, 20))   // 真 Chrome 开窗口要一会儿：并发的开页会撞上
        if (rejectBounds && props.left !== undefined) throw new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.')
        const id = ids.win++
        windows[id] = { type: props.type || 'normal', state: 'normal', incognito: !!props.incognito }
        const t = { id: ids.tab++, windowId: id, active: true }
        tabs.push(t)
        return { id, tabs: [{ ...t, url: '', pendingUrl: props.url }] }
      },
      update: async (...a) => { calls.push(['windows.update', ...a]) },
    },
    tabs: {
      query: async (q) => tabs.filter((t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.active === undefined || t.active === q.active)),
      create: async (props) => {
        calls.push(['tabs.create', props])
        if (props.windowId !== undefined && closeOnCreateTab) { delete windows[props.windowId]; closeOnCreateTab = false }
        if (props.windowId !== undefined && !windows[props.windowId]) throw new Error(`No window with id: ${props.windowId}.`)
        if (tabError) throw new Error(tabError)
        const t = { id: ids.tab++, windowId: props.windowId ?? lastFocused, active: false }
        tabs.push(t)
        if (props.active) activate(t)
        return { ...t, url: '', pendingUrl: props.url }
      },
    },
    storage: {
      session: {
        get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in session).map((k) => [k, JSON.parse(JSON.stringify(session[k]))])),
        set: async (v) => { Object.assign(session, JSON.parse(JSON.stringify(v))) },
        remove: async (k) => { delete session[k] },
      },
    },
  }
  const ctx = vm.createContext({ chrome, console, URL, ownWindow })
  vm.runInContext(`${src.slice(start, end)}\nconst OPS = {${openM[0]}}`, ctx)
  return {
    open: (args) => vm.runInContext(`OPS.open(${JSON.stringify(args)})`, ctx),
    ids: () => vm.runInContext('agentWindowIds().then((s) => [...s])', ctx),
    closeWindow: (id) => { delete windows[id] },
    restart: (more = {}) => world({ windows, tabs, lastFocused, session, ownWindow, ids, ...more }),
    focus: (id) => { lastFocused = id },
    calls, windows, tabs, session,
    kinds: () => calls.filter((c) => c[0] !== 'windows.getLastFocused').map((c) => c[0]),
  }
}

const results = []
const check = async (title, fn) => {
  try { await fn(); results.push(`✅ ${title}`) } catch (e) { results.push(`❌ ${title}: ${e.message}`) }
}
const USER = { 1: { type: 'normal', state: 'normal', left: 100, top: 60, width: 1300, height: 860 } }
const USER_TABS = [{ id: 10, windowId: 1, active: true }]
const clone = (o) => JSON.parse(JSON.stringify(o))
const created = (w) => w.calls.filter((c) => c[0] === 'windows.create').map((c) => c[1])

await check('第一次开页：新开一个后台窗口（不抢焦点），跟用户窗口一样大、错开一点', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  const r = await w.open({ url: 'https://a.example/' })
  assert.equal(r.window, 'agent')
  assert.equal(r.url, 'https://a.example/')
  assert.deepEqual(created(w), [{ url: 'https://a.example/', focused: false, type: 'normal', incognito: false, left: 140, top: 100, width: 1300, height: 860 }])
  assert.equal(w.session.agentWindows.normal, 50)
})

await check('看「用户最后在用的窗口」只看普通窗口（不拿弹出的登录小窗当参照）', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  await w.open({ url: 'https://a.example/' })
  assert.deepEqual(w.calls.find((c) => c[0] === 'windows.getLastFocused')[1], { windowTypes: ['normal'] })
})

await check('再开页：进同一个干活窗口，在那个窗口里切过去，不碰窗口焦点', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  await w.open({ url: 'https://a.example/' })
  const r = await w.open({ url: 'https://b.example/' })
  assert.equal(r.window, 'agent')
  assert.deepEqual(w.kinds(), ['windows.create', 'tabs.create'])
  assert.deepEqual(w.calls.at(-1)[1], { windowId: 50, url: 'https://b.example/', active: true })
})

await check('两个会话同时开页：只开一个干活窗口，两页都进它', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  const [a, b] = await Promise.all([w.open({ url: 'https://a.example/' }), w.open({ url: 'https://b.example/' })])
  assert.deepEqual(w.kinds(), ['windows.create', 'tabs.create'])
  assert.equal(w.calls.at(-1)[1].windowId, 50)
  assert.equal(a.window, 'agent')
  assert.equal(b.window, 'agent')
})

await check('用户把干活窗口关了：下次再开一个新的', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  await w.open({ url: 'https://a.example/' })
  w.closeWindow(50)
  await w.open({ url: 'https://b.example/' })
  assert.deepEqual(w.kinds(), ['windows.create', 'windows.create'])
  assert.equal(w.session.agentWindows.normal, 51)
})

await check('往干活窗口加页的那一下窗口刚好被关：这次就重开一个，不报错', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  await w.open({ url: 'https://a.example/' })
  const w2 = w.restart({ closeOnCreateTab: true })
  const r = await w2.open({ url: 'https://b.example/' })
  assert.equal(r.window, 'agent')
  assert.deepEqual(w2.kinds(), ['tabs.create', 'windows.create'])
  assert.equal(w2.session.agentWindows.normal, 51)
})

await check('窗口还在、只是这个网址开不了：照实报错，不丢掉干活窗口', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  await w.open({ url: 'https://a.example/' })
  const w2 = w.restart({ tabError: 'Cannot navigate to javascript URL' })
  await assert.rejects(w2.open({ url: 'https://b.example/' }), /Cannot navigate/)
  assert.equal(w2.session.agentWindows.normal, 50)
  assert.deepEqual(w2.kinds(), ['tabs.create'])
})

await check('用户窗口贴着屏幕边、错开后 Chrome 不让开：不带位置再开一次', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS), rejectBounds: true })
  const r = await w.open({ url: 'https://a.example/' })
  assert.equal(r.window, 'agent')
  assert.deepEqual(created(w).map((p) => 'left' in p), [true, false])
  assert.deepEqual(created(w)[1], { url: 'https://a.example/', focused: false, type: 'normal', incognito: false })
})

await check('用户把自己的页拖进干活窗口、正看着它：新页在后台开，不把它切走', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  await w.open({ url: 'https://a.example/' })
  // 用户把标签页 10 拖进窗口 50 并选中
  const t10 = w.tabs.find((t) => t.id === 10)
  for (const o of w.tabs) if (o.windowId === 50) o.active = false
  Object.assign(t10, { windowId: 50, active: true })
  await w.open({ url: 'https://b.example/' })
  assert.deepEqual(w.calls.at(-1)[1], { windowId: 50, url: 'https://b.example/', active: false })
  assert.equal(t10.active, true)
})

await check('干活窗口里正显示 DSH 的页（扩展后台重启过也认得）：照常切到新页', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  await w.open({ url: 'https://a.example/' })
  const w2 = w.restart()
  await w2.open({ url: 'https://b.example/' })
  assert.deepEqual(w2.calls.at(-1)[1], { windowId: 50, url: 'https://b.example/', active: true })
})

await check('用户在隐身窗口里：新页开进隐身的干活窗口；回到普通窗口再开，进普通的那个', async () => {
  const w = world({ windows: { ...clone(USER), 2: { type: 'normal', state: 'normal', incognito: true, left: 0, top: 0, width: 1000, height: 700 } }, tabs: clone(USER_TABS), lastFocused: 2 })
  await w.open({ url: 'https://secret.example/' })
  assert.equal(created(w)[0].incognito, true)
  const inc = w.session.agentWindows.incognito
  assert.equal(w.windows[inc].incognito, true)
  w.focus(1)
  await w.open({ url: 'https://a.example/' })
  assert.equal(created(w)[1].incognito, false)
  const norm = w.session.agentWindows.normal
  assert.notEqual(norm, inc)
  w.focus(2)
  await w.open({ url: 'https://secret2.example/' })
  assert.deepEqual(w.calls.at(-1), ['tabs.create', { windowId: inc, url: 'https://secret2.example/', active: true }])
  assert.deepEqual((await w.ids()).sort(), [inc, norm].sort())
})

await check('扩展后台被挂起再起来：认得原来的干活窗口', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  await w.open({ url: 'https://a.example/' })
  const w2 = w.restart()
  await w2.open({ url: 'https://b.example/' })
  assert.deepEqual(w2.calls.filter((c) => c[0] !== 'windows.getLastFocused').map((c) => [c[0], c[1].windowId]), [['tabs.create', 50]])
})

await check('记着的 id 现在是个弹出窗（不是普通窗口）：不往里塞，另开', async () => {
  const w = world({ windows: { ...clone(USER), 9: { type: 'popup', state: 'normal' } }, tabs: clone(USER_TABS), session: { agentWindows: { normal: 9 } } })
  await w.open({ url: 'https://a.example/' })
  assert.equal(w.kinds()[0], 'windows.create')
})

await check('用户窗口是最大化 / 全屏：不照抄大小，交给 Chrome', async () => {
  const w = world({ windows: { 1: { type: 'normal', state: 'maximized', left: 0, top: 0, width: 1920, height: 1080 } }, tabs: clone(USER_TABS) })
  await w.open({ url: 'https://a.example/' })
  assert.deepEqual(created(w), [{ url: 'https://a.example/', focused: false, type: 'normal', incognito: false }])
})

await check('一个窗口都没有（Mac 上 Chrome 开着但窗口全关了）也能开', async () => {
  const w = world({ windows: {}, lastFocused: 7 })
  const r = await w.open({ url: 'https://a.example/' })
  assert.equal(r.window, 'agent')
  assert.deepEqual(created(w), [{ url: 'https://a.example/', focused: false, type: 'normal', incognito: false }])
})

await check('关了「单独窗口」：照旧在当前窗口后台开标签页', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS), ownWindow: false })
  const r = await w.open({ url: 'https://a.example/' })
  assert.equal(r.window, undefined)
  assert.deepEqual(w.calls, [['tabs.create', { url: 'https://a.example/', active: false }]])
})

await check('cb open --front（active）：有意要它跳到眼前，开在当前窗口前台', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  await w.open({ url: 'https://a.example/', active: true })
  assert.deepEqual(w.calls, [['tabs.create', { url: 'https://a.example/', active: true }]])
})

await check('不是完整网址照样拒（不会开出扩展自己的页面）', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  await assert.rejects(w.open({ url: 'example.com' }), /完整网址/)
  assert.equal(w.calls.length, 0)
})

await check('整个过程从不去聚焦窗口', async () => {
  const w = world({ windows: clone(USER), tabs: clone(USER_TABS) })
  for (const u of ['https://a.example/', 'https://b.example/', 'https://c.example/']) await w.open({ url: u })
  assert(!w.calls.some((c) => c[0] === 'windows.update'))
})

// ── 插件这边：tab="active" 挑哪一页 ──────────────────────────────────────────
const idx = fs.readFileSync(new URL('../plugin/index.js', import.meta.url), 'utf8')
const um = /\nfunction userTab\(tabs\) \{\n[\s\S]*?\n\}\n/.exec(idx)
assert(um, 'index.js 里找不到 userTab')
const userTab = vm.runInNewContext(`(${um[0].trim()})`)

await check('tab="active"：挑用户最后在用的窗口里的那页，不是干活窗口的', async () => {
  const tabs = [
    { id: 1, active: true, focused: false, agentWindow: true },
    { id: 2, active: false, focused: true },
    { id: 3, active: true, focused: true },
  ]
  assert.equal(userTab(tabs).id, 3)
})

await check('tab="active"：没有 focused 信息时，至少避开干活窗口', async () => {
  const tabs = [{ id: 1, active: true, agentWindow: true }, { id: 4, active: true }]
  assert.equal(userTab(tabs).id, 4)
})

await check('tab="active"：老扩展（没有这些字段）照旧取第一个 active', async () => {
  assert.equal(userTab([{ id: 8, active: false }, { id: 9, active: true }]).id, 9)
})

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
