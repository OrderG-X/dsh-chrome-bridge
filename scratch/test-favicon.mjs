/**
 * 标签页小鼠标：控制时 favicon 换成光标图标，松手后换回网站自己的。
 * 两种页面各测一遍：自己写了 <link rel=icon> 的，和靠默认 /favicon.ico 的。
 *
 *   node scratch/test-favicon.mjs
 *
 * 要求：Chrome 开着、扩展 ≥1.10.0 已加载。
 */

import assert from 'node:assert'
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import { apply } from '../plugin/index.js'

const EXT_ID = 'mhlkjkblmdleplggfengldbdmkabloce'
const tools = new Map()
apply({ tools: { register: (t) => tools.set(t.name, t) }, get: () => undefined, inject: () => {}, on: () => {} }, {})
let n = 0
const run = async (name, a) =>
  (await tools.get(name).execute(a, { agent: { sessionId: 'session-favicon-test-0001' }, callId: `fav-${++n}` })).text
const raw = (op, args) => new Promise((resolve, reject) => {
  const s = net.connect('/tmp/dsh-bridge.sock')
  let acc = ''
  s.on('connect', () => s.write(JSON.stringify({
    token: fs.readFileSync('/tmp/dsh-bridge.token', 'utf8').trim(), id: String(Math.random()), op, args,
  }) + '\n'))
  s.on('data', (d) => {
    acc += d
    if (!acc.includes('\n')) return
    const m = JSON.parse(acc)
    s.destroy()
    m.ok ? resolve(m.result) : reject(new Error(m.error))
  })
  s.on('error', reject)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PNG = fs.readFileSync(new URL('../plugin/vendor/extension/icons/icon16.png', import.meta.url))
const server = http.createServer((q, r) => {
  if (q.url === '/own.png') { r.writeHead(200, { 'content-type': 'image/png' }); return r.end(PNG) }
  if (q.url === '/favicon.ico') { r.writeHead(404); return r.end() }
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  r.end(q.url.startsWith('/own')
    ? '<title>有图标</title><link rel=icon href="/own.png"><button id=b>点</button>'
    : '<title>没图标</title><button id=b>点</button>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const results = []
const tabs = []
let pop
try {
  pop = (await raw('open', { url: `chrome-extension://${EXT_ID}/popup.html` })).tabId
  const fav = async (id) => (await raw('cdp', {
    tabId: pop, method: 'Runtime.evaluate',
    params: { expression: `chrome.tabs.get(${id}).then((t) => t.favIconUrl || '')`, awaitPromise: true, returnByValue: true },
  })).result.result.value
  const kind = (u) => (u.startsWith('data:image/png') ? 'cursor' : u.endsWith('/own.png') ? 'own' : u ? 'other' : 'default')

  for (const [path, title, orig] of [['/own', '有自己图标的页面', 'own'], ['/plain', '没写图标的页面', 'default']]) {
    try {
      const tab = /标签页 (\d+)/.exec(await run('browser_tabs', { action: 'open', url: base + path }))[1]
      tabs.push(Number(tab))
      await run('browser_wait', { tab, selector: '#b' })
      await sleep(600)
      assert.equal(kind(await fav(tab)), orig, '控制前')
      await run('browser_click', { tab, selector: '#b' })
      await sleep(800)
      assert.equal(kind(await fav(tab)), 'cursor', '控制中应该是小鼠标')
      await raw('detach', { tabId: Number(tab) })
      await sleep(1200)
      assert.equal(kind(await fav(tab)), orig, '松手后应该换回原样')
      results.push(`✅ ${title}：控制中是小鼠标，松手后换回原样`)
    } catch (e) {
      results.push(`❌ ${title}: ${e.message}`)
    }
  }
} finally {
  for (const id of tabs) await raw('close', { tabId: id }).catch(() => {})
  if (pop) await raw('close', { tabId: pop }).catch(() => {})
  server.close()
}

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
