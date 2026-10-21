/**
 * 标签页小鼠标：控制时 favicon 换成光标图标，松手后换回网站自己的。
 * 两种页面各测一遍：自己写了 <link rel=icon> 的，和靠默认 /favicon.ico 的。
 * 扩展页面不让自动化碰，所以不再借弹窗页读 Chrome 的 favIconUrl，改看页面里的图标 <link>
 * （标签栏上实际显示的图标，跑的时候顺便用眼睛看一下）。
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

const RUN = process.env.DSH_BRIDGE_DIR || `/tmp/dsh-bridge-${process.getuid()}`
const tools = new Map()
apply({ tools: { register: (t) => tools.set(t.name, t) }, get: () => undefined, inject: () => {}, on: () => {} }, {})
let n = 0
const run = async (name, a) =>
  (await tools.get(name).execute(a, { agent: { sessionId: 'session-favicon-test-0001' }, callId: `fav-${++n}` })).text
const raw = (op, args) => new Promise((resolve, reject) => {
  const s = net.connect(`${RUN}/dsh-bridge.sock`)
  let acc = ''
  s.on('connect', () => s.write(JSON.stringify({
    token: fs.readFileSync(`${RUN}/dsh-bridge.token`, 'utf8').trim(), id: String(Math.random()), op, args,
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
try {
  const links = async (tab) => JSON.parse(await run('browser_eval', { tab, expression: `JSON.stringify({
    cursor: !!document.getElementById('dsh-bridge-cursor-favicon'),
    own: !!document.querySelector('link[rel~="icon"][href$="/own.png"]'),
    restore: !!document.querySelector('link[data-dsh-bridge="restore"]') })` }))
  const fav = async (tab) => {
    const f = await links(tab)
    return f.cursor ? 'cursor' : f.own ? 'own' : f.restore ? 'restored-default' : 'default'
  }
  const kind = (k) => (k === 'restored-default' ? 'default' : k)

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
      const after = await fav(tab)
      assert.equal(kind(after), orig, '松手后应该换回原样')
      if (orig === 'default') assert.equal(after, 'restored-default', '没写图标的页面要补一个指向 /favicon.ico 的链接')
      results.push(`✅ ${title}：控制中是小鼠标，松手后换回原样`)
    } catch (e) {
      results.push(`❌ ${title}: ${e.message}`)
    }
  }
} finally {
  for (const id of tabs) await raw('close', { tabId: id }).catch(() => {})
  server.close()
}

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
