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

const src = fs.readFileSync(new URL('../plugin/vendor/extension/background.js', import.meta.url), 'utf8')
const start = src.indexOf('async function ensureGroup(')
const end = src.indexOf('\nasync function unmarkTab(')
assert(start > 0 && end > start, 'background.js 里找不到 ensureGroup')
const TITLE = /const GROUP_TITLE = ([^\n]+)/.exec(src)[1]

function world({ tabs, groups }) {
  let nextGroup = 900
  const calls = []
  const chrome = {
    tabs: {
      get: async (id) => { const t = tabs[id]; if (!t) throw new Error('no tab'); return { id, ...t } },
      group: async ({ tabIds: [id], groupId }) => {
        calls.push(['group', id, groupId])
        const gid = groupId ?? nextGroup++
        if (!groups[gid]) groups[gid] = { id: gid, windowId: tabs[id].windowId, title: '' }
        tabs[id].groupId = gid
        tabs[id].pinned = false
        return gid
      },
    },
    tabGroups: {
      get: async (gid) => { const g = groups[gid]; if (!g) throw new Error('no group'); return g },
      query: async ({ title, windowId }) => Object.values(groups).filter((g) => g.title === title && (windowId == null || g.windowId === windowId)),
      update: async (gid, props) => { Object.assign(groups[gid], props); return groups[gid] },
    },
  }
  const ctx = vm.createContext({ chrome, console, groupedTabs: new Map(), ourGroup: new Map() })
  vm.runInContext(`const GROUP_TITLE = ${TITLE}\n${src.slice(start, end)}`, ctx)
  return { ensureGroup: (id) => vm.runInContext(`ensureGroup(${id})`, ctx), calls, ctx, tabs, groups }
}

const results = []
const check = async (title, fn) => {
  try { await fn(); results.push(`✅ ${title}`) } catch (e) { results.push(`❌ ${title}: ${e.message}`) }
}
const title = vm.runInNewContext(TITLE)

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

await check('记着的组被拖去别的窗口：不往那边塞', async () => {
  const w = world({ tabs: { 1: { windowId: 1, groupId: -1 }, 2: { windowId: 1, groupId: -1 } }, groups: {} })
  await w.ensureGroup(1)
  const gid = w.tabs[1].groupId
  w.groups[gid].windowId = 9
  await w.ensureGroup(2)
  assert.notEqual(w.tabs[2].groupId, gid)
})

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
