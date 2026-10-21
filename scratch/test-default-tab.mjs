/**
 * 不传 tab 时用哪个标签页：只接着用本会话自己打开 / 点名操作过的，绝不默认去动用户正在看的那一页。
 * 在真 Chrome 里后台开本地测试页，走插件注册的 browser_* 工具，测完关掉标签页。
 *
 *   node scratch/test-default-tab.mjs
 *
 * 要求：Chrome 开着、扩展已加载。
 */

import assert from 'node:assert'
import http from 'node:http'
import { apply } from '../plugin/index.js'

const PAGE = (n) => `<!doctype html><meta charset="utf-8"><title>默认标签页测试${n}</title><h1>第${n}页</h1>`
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === '/favicon.ico') { res.writeHead(204); return res.end() }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE(p.slice(1) || '0'))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const tools = new Map()
apply({
  tools: { register: (t) => tools.set(t.name, t) },
  get: () => undefined,
  inject: () => {},
  on: () => {},
}, {})
// 两个会话：A 和 B
const run = async (name, args, session = 'A') => (await tools.get(name).execute(args, { sessionId: session, callId: String(Math.random()) })).text

const results = []
const check = async (title, fn) => {
  try { await fn(); results.push(`✅ ${title}`) } catch (e) { results.push(`❌ ${title}: ${e.message}`) }
}
const activeUrl = async () => {
  const list = await run('browser_tabs', { action: 'list' }, 'probe')
  const line = list.split('\n').find((l) => l.startsWith('*'))
  return line || ''
}
const opened = []

try {
  const before = await activeUrl()

  await check('还没打开过标签页：不传 tab 直接报错，不动用户正在看的页面', async () => {
    await assert.rejects(run('browser_nav', { url: `${base}/x` }), /没指定标签页/)
    await assert.rejects(run('browser_read', { what: 'text' }), /没指定标签页/)
    assert.equal(await activeUrl(), before)
  })

  const t1 = String(/标签页 (\d+)/.exec(await run('browser_tabs', { action: 'open', url: `${base}/1` }))[1])
  opened.push(t1)
  await run('browser_wait', { tab: t1, text: '第1页' })

  await check('打开后不传 tab：读的、跳的都是自己开的那页', async () => {
    assert.match(await run('browser_read', { what: 'text' }), /第1页/)
    assert.match(await run('browser_nav', { url: `${base}/2` }), /\/2 — 默认标签页测试2/)
    assert.match(await run('browser_read', { what: 'text' }), /第2页/)
    assert.equal(await activeUrl(), before)
  })

  await check('别的会话不会捡到 A 的标签页', async () => {
    await assert.rejects(run('browser_read', { what: 'text' }, 'B'), /没指定标签页/)
  })

  const t2 = String(/标签页 (\d+)/.exec(await run('browser_tabs', { action: 'open', url: `${base}/3` }, 'B'))[1])
  opened.push(t2)
  await run('browser_wait', { tab: t2, text: '第3页' }, 'B')

  await check('点名操作过别的标签页：之后不传 tab 就用它', async () => {
    assert.match(await run('browser_read', { what: 'text', tab: t2 }), /第3页/)
    assert.match(await run('browser_read', { what: 'text' }), /第3页/)
    assert.match(await run('browser_read', { what: 'text', tab: t1 }), /第2页/)
    assert.match(await run('browser_read', { what: 'text' }), /第2页/)
  })

  await check('tab 乱写给人话报错', async () => {
    await assert.rejects(run('browser_read', { what: 'text', tab: 'abc' }), /标签页 id/)
  })

  await check('关掉正在用的标签页：之后不传 tab 又报错', async () => {
    assert.match(await run('browser_tabs', { action: 'close' }), new RegExp(`已关闭标签页 ${t1}`))
    opened.splice(opened.indexOf(t1), 1)
    await assert.rejects(run('browser_read', { what: 'text' }), /没指定标签页/)
    assert.equal(await activeUrl(), before)
  })
} finally {
  for (const t of opened) await run('browser_tabs', { action: 'close', tab: t }, 'cleanup').catch(() => {})
  server.close()
}

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
