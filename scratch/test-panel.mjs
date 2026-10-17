/**
 * DSH 设置卡后端（plugin/panel.js）的实机测试：起一个本地 http 服务挂上 panelHandler，
 * 对着真扩展读状态、开关光标、暂停，再验几条把门规则。
 *
 *   node scratch/test-panel.mjs
 *
 * 要求：Chrome 开着、扩展 ≥1.11.0 已加载（有 panel 操作）。
 * 测完一定恢复：不暂停、光标开着（暂停只能从扩展页里解除，所以开一个扩展弹窗页来解）。
 */

import assert from 'node:assert'
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import { panelHandler, PANEL_ROUTE } from '../plugin/panel.js'

const EXT_ID = 'mhlkjkblmdleplggfengldbdmkabloce'
const SOCK = '/tmp/dsh-bridge.sock'
const WANT = JSON.parse(fs.readFileSync(new URL('../plugin/vendor/extension/manifest.json', import.meta.url), 'utf8')).version

const call = (op, args = {}, timeoutMs = 10000) => new Promise((resolve, reject) => {
  const s = net.connect(SOCK)
  let acc = ''
  const timer = setTimeout(() => { s.destroy(); reject(new Error('timeout')) }, timeoutMs)
  s.on('connect', () => s.write(JSON.stringify({
    token: fs.readFileSync('/tmp/dsh-bridge.token', 'utf8').trim(), id: String(Math.random()), op, args,
  }) + '\n'))
  s.on('data', (d) => {
    acc += d
    if (!acc.includes('\n')) return
    clearTimeout(timer)
    const m = JSON.parse(acc)
    s.destroy()
    m.ok ? resolve(m.result) : reject(new Error(m.error))
  })
  s.on('error', (e) => { clearTimeout(timer); reject(e) })
})

let port = 0
const server = http.createServer(panelHandler({ call, sock: SOCK, origin: () => `http://127.0.0.1:${port}` }))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
port = server.address().port

const req = (method, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body)
  const r = http.request({
    host: '127.0.0.1', port, path: PANEL_ROUTE, method,
    headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
  }, (res) => {
    let acc = ''
    res.on('data', (d) => { acc += d })
    res.on('end', () => resolve({ status: res.statusCode, body: acc ? JSON.parse(acc) : null }))
  })
  r.on('error', reject)
  if (data) r.write(data)
  r.end()
})

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(`✓ ${name}`) } catch (e) { results.push(`❌ ${name}: ${e.message}`) }
}

let pop
try {
  pop = (await call('open', { url: `chrome-extension://${EXT_ID}/popup.html` })).tabId

  await check('读状态：连上了、版本对、两个开关', async () => {
    const { status, body } = await req('GET')
    assert.equal(status, 200)
    assert.equal(body.connected, true)
    assert.equal(body.ext.version, WANT)
    assert.equal(body.paused, false)
    assert.equal(body.showCursor, true)
    assert.equal(typeof body.attachedCount, 'number')
    assert.ok(body.extDir.endsWith('dsh-bridge-extension'))
  })

  await check('关光标 / 开光标', async () => {
    let r = await req('POST', { action: 'cursor', on: false })
    assert.equal(r.body.showCursor, false)
    r = await req('POST', { action: 'cursor', on: true })
    assert.equal(r.body.showCursor, true)
  })

  await check('暂停：状态变暂停，网页操作被拒', async () => {
    const r = await req('POST', { action: 'pause' })
    assert.equal(r.body.paused, true)
    await assert.rejects(call('tabs'), /暂停/)
  })

  await check('socket 上不能恢复控制', async () => {
    await assert.rejects(call('panel', { action: 'pause', on: false }), /只能在 Chrome/)
  })

  await check('从扩展页解除暂停后，状态回来', async () => {
    await call('cdp', { tabId: pop, method: 'Runtime.evaluate', params: { expression: "chrome.runtime.sendMessage({ popup: 'pause', on: false })", awaitPromise: true } })
    const r = await req('GET')
    assert.equal(r.body.paused, false)
  })

  await check('全部松手', async () => {
    const r = await req('POST', { action: 'releaseAll' })
    assert.equal(r.status, 200)
    assert.equal(r.body.attachedCount, 0)
  })

  await check('把门：跨站 Origin 拒', async () => {
    assert.equal((await req('GET', undefined, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await req('POST', { action: 'pause' }, { origin: 'https://evil.example' })).status, 403)
  })

  await check('把门：自己的 Origin 放行', async () => {
    assert.equal((await req('GET', undefined, { origin: `http://127.0.0.1:${port}` })).status, 200)
    assert.equal((await req('GET', undefined, { origin: `http://localhost:${port}` })).status, 200)
  })

  await check('把门：Host 不是本机（DNS 重绑定）拒', async () => {
    assert.equal((await req('GET', undefined, { host: 'evil.example' })).status, 403)
  })

  await check('把门：POST 不是 JSON 拒', async () => {
    const r = await new Promise((resolve) => {
      const q = http.request({ host: '127.0.0.1', port, path: PANEL_ROUTE, method: 'POST', headers: { 'content-type': 'text/plain' } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      q.end('{"action":"pause"}')
    })
    assert.equal(r, 415)
  })

  await check('不认识的 action', async () => {
    assert.equal((await req('POST', { action: 'resume' })).status, 400)
  })
} finally {
  // 不管中途怎样，恢复成：不暂停、光标开着
  if (pop) {
    await call('cdp', { tabId: pop, method: 'Runtime.evaluate', params: { expression: "chrome.runtime.sendMessage({ popup: 'pause', on: false })", awaitPromise: true } }).catch(() => {})
    await call('cdp', { tabId: pop, method: 'Runtime.evaluate', params: { expression: "chrome.runtime.sendMessage({ popup: 'cursor', on: true })", awaitPromise: true } }).catch(() => {})
    await call('close', { tabId: pop }).catch(() => {})
  }
  server.close()
}

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
