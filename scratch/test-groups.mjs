/**
 * 扩展里「受控标签页进蓝色组」的离线测试：从 background.js 里取出 ensureGroup，
 * 配一个假的 chrome.tabs / chrome.tabGroups 跑，确认用户固定的、在用户自己组里的标签页不挪，
 * 别的窗口里的同名组不复用。不碰真 Chrome。
 *
 *   node scratch/test-groups.mjs
 */

import assert from 'node:assert'
import fs from 'node:fs'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../plugin/vendor/extension/background.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')   // Windows 检出是 CRLF
const start = src.indexOf('async function ensureGroup(')
const end = src.indexOf('\nasync function unmarkTab(')
assert(start > 0 && end > start, 'background.js 里找不到 ensureGroup')
// 组名那几行（跟 Chrome 界面语言走、几种语言和老版本组名都认）原样取出来，配假的 chrome.i18n 跑
const tStart = src.indexOf('const UI_LANG = ')
const tEnd = src.indexOf('\n', src.indexOf('const OUR_GROUP_TITLES = '))
assert(tStart > 0 && tEnd > tStart, 'background.js 里找不到组名定义')
const TITLES = src.slice(tStart, tEnd)

function world({ tabs, groups, lang = 'zh-CN' }) {
  let nextGroup = 900
  const calls = []
  const chrome = {
    i18n: { getUILanguage: () => lang },
    tabs: {
      get: async (id) => { const t = tabs[id]; if (!t) throw new Error('no tab'); return { id, ...t } },
      // 和真 Chrome 一样：新建的组不写 createProperties.windowId 就建在「当前窗口」（这里是 1），标签页跟着挪过去
      group: async ({ tabIds: [id], groupId, createProperties }) => {
        calls.push(['group', id, groupId])
        const gid = groupId ?? nextGroup++
        if (!groups[gid]) groups[gid] = { id: gid, windowId: (createProperties && createProperties.windowId) ?? 1, title: '' }
        tabs[id].windowId = groups[gid].windowId
        tabs[id].groupId = gid
        tabs[id].pinned = false
        return gid
      },
    },
    tabGroups: {
      get: async (gid) => { const g = groups[gid]; if (!g) throw new Error('no group'); return g },
      query: async ({ title, windowId } = {}) => Object.values(groups).filter((g) => (title == null || g.title === title) && (windowId == null || g.windowId === windowId)),
      update: async (gid, props) => { Object.assign(groups[gid], props); return groups[gid] },
    },
  }
  const ctx = vm.createContext({ chrome, console, groupedTabs: new Map(), ourGroup: new Map() })
  vm.runInContext(`${TITLES}\n${src.slice(start, end)}`, ctx)
  return { ensureGroup: (id) => vm.runInContext(`ensureGroup(${id})`, ctx), calls, ctx, tabs, groups }
}

const results = []
const check = async (title, fn) => {
  try { await fn(); results.push(`✅ ${title}`) } catch (e) { results.push(`❌ ${title}: ${e.message}`) }
}
const title = 'DSH 正在操作'

await check('用户固定的标签页不进组、不取消固定', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: -1, pinned: true } }, groups: {} })
  await w.ensureGroup(1)
  assert.equal(w.calls.length, 0)
  assert.equal(w.tabs[1].pinned, true)
})

await check('在用户自己组里的标签页不挪', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: 5 } }, groups: { 5: { id: 5, windowId: 1, title: '我的工作' } } })
  await w.ensureGroup(1)
  assert.equal(w.calls.length, 0)
  assert.equal(w.tabs[1].groupId, 5)
})

await check('本来就在我们组里的（worker 重启过）：认领，不重新分组', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: 7 } }, groups: { 7: { id: 7, windowId: 1, title } } })
  await w.ensureGroup(1)
  assert.equal(w.calls.length, 0)
  assert.equal(w.ctx.groupedTabs.get(1), 7)
})

await check('普通标签页进新建的蓝组', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: -1 } }, groups: {} })
  await w.ensureGroup(1)
  const gid = w.tabs[1].groupId
  assert.equal(w.groups[gid].title, title)
  assert.equal(w.groups[gid].color, 'blue')
})

await check('同一窗口第二个标签页复用同一个组', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: -1 }, 2: { windowId: 1, groupId: -1 } }, groups: {} })
  await w.ensureGroup(1)
  await w.ensureGroup(2)
  assert.equal(w.tabs[1].groupId, w.tabs[2].groupId)
})

await check('别的窗口里的同名组不复用（不把标签页拽过去）', async () => {
  const w = world({ tabs: { 1: { windowId: 2, groupId: -1 } }, groups: { 3: { id: 3, windowId: 1, title } } })
  await w.ensureGroup(1)
  assert.notEqual(w.tabs[1].groupId, 3)
  assert.equal(w.groups[w.tabs[1].groupId].windowId, 2)
})

await check('不在当前窗口的标签页（比如干活窗口里的）：组建在它自己的窗口，不被拽到当前窗口', async () => {
  const w = world({ tabs: { 1: { windowId: 4, groupId: -1 } }, groups: {} })
  await w.ensureGroup(1)
  assert.equal(w.tabs[1].windowId, 4)
  assert.equal(w.groups[w.tabs[1].groupId].windowId, 4)
})

await check('记着的组被拖去别的窗口：不往那边塞', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: -1 }, 2: { windowId: 1, groupId: -1 } }, groups: {} })
  await w.ensureGroup(1)
  const gid = w.tabs[1].groupId
  w.groups[gid].windowId = 9
  await w.ensureGroup(2)
  assert.notEqual(w.tabs[2].groupId, gid)
})

await check('Chrome 是英文：新组叫 DSH at work', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: -1 } }, groups: {}, lang: 'en-US' })
  await w.ensureGroup(1)
  assert.equal(w.groups[w.tabs[1].groupId].title, 'DSH at work')
})

await check('Chrome 是俄文：新组叫 DSH работает', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: -1 } }, groups: {}, lang: 'ru' })
  await w.ensureGroup(1)
  assert.equal(w.groups[w.tabs[1].groupId].title, 'DSH работает')
})

await check('老版本留下的「DSH agent 正在操作」组：认作我们的，认领不重新分组', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: 7 } }, groups: { 7: { id: 7, windowId: 1, title: 'DSH agent 正在操作' } } })
  await w.ensureGroup(1)
  assert.equal(w.calls.length, 0)
  assert.equal(w.ctx.groupedTabs.get(1), 7)
})

await check('换了语言：同窗口里别的语言的我们的组也复用，不再新建一个', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: -1 } }, groups: { 3: { id: 3, windowId: 1, title: 'DSH 正在操作' } }, lang: 'en' })
  await w.ensureGroup(1)
  assert.equal(w.tabs[1].groupId, 3)
})

// 启动对账（reconcileGroups → unmarkTab）：升级 / 换语言后，留在我们组里、已经没在控制的标签页要拆出来
const rStart = src.indexOf('async function unmarkTab(')
const rEnd = src.indexOf('\n}\n', src.indexOf('async function reconcileGroups(')) + 2
assert(rStart > 0 && rEnd > rStart, 'background.js 里找不到 unmarkTab / reconcileGroups')
function reconcileWorld({ tabs, groups, debugged = [], lang = 'zh-CN' }) {
  const ungrouped = []
  const chrome = {
    i18n: { getUILanguage: () => lang },
    debugger: { getTargets: async () => debugged.map((tabId) => ({ tabId, attached: true })) },
    tabs: {
      get: async (id) => ({ id, ...tabs[id] }),
      query: async ({ groupId }) => Object.entries(tabs).filter(([, t]) => t.groupId === groupId).map(([id, t]) => ({ id: Number(id), ...t })),
      ungroup: async (ids) => { for (const id of ids) { tabs[id].groupId = -1; ungrouped.push(id) } },
    },
    tabGroups: { query: async () => Object.values(groups) },
  }
  const ctx = vm.createContext({
    chrome, console, groupedTabs: new Map(), ourGroup: new Map(), attached: new Map(), tabEpoch: new Map(),
    cursorReady: new Set(), cursorPos: new Map(), updateBadge() {}, hidePageCursor: async () => {}, markCursor: async () => {},
  })
  vm.runInContext(`${TITLES}\n${src.slice(rStart, rEnd)}`, ctx)
  return { run: () => vm.runInContext('reconcileGroups()', ctx), ctx, tabs, ungrouped }
}

await check('启动对账：老版本「DSH agent 正在操作」组里没在控制的标签页被拆出来', async () => {
  const w = reconcileWorld({ tabs: { 1: { windowId: 1, groupId: 7 } }, groups: { 7: { id: 7, windowId: 1, title: 'DSH agent 正在操作' } } })
  await w.run()
  assert.deepEqual(w.ungrouped, [1])
})

await check('启动对账：换了语言，另一种语言的我们的组照样拆；还在控制的认领回来不拆', async () => {
  const w = reconcileWorld({
    tabs: { 1: { windowId: 1, groupId: 7 }, 2: { windowId: 1, groupId: 7 } },
    groups: { 7: { id: 7, windowId: 1, title: 'DSH работает' } }, debugged: [2], lang: 'en-US',
  })
  await w.run()
  assert.deepEqual(w.ungrouped, [1])
  assert.equal(w.ctx.groupedTabs.get(2), 7)
})

await check('启动对账：用户自己的组不碰', async () => {
  const w = reconcileWorld({ tabs: { 1: { windowId: 1, groupId: 5 } }, groups: { 5: { id: 5, windowId: 1, title: '我的工作' } } })
  await w.run()
  assert.deepEqual(w.ungrouped, [])
})

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
