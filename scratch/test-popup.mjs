/**
 * 扩展弹窗的实机测试：后台开一个演示页 + 一个弹窗页（chrome-extension://…/popup.html），
 * 用插件工具（带假的 DSH exec：会话 id、callId）干几件事，再在弹窗页里读界面、点按钮。
 *
 *   node scratch/test-popup.mjs
 *
 * 要求：Chrome 开着、扩展 ≥1.10.0 已加载。
 */

import assert from 'node:assert'
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import { apply } from '../plugin/index.js'

const EXT_ID = 'mhlkjkblmdleplggfengldbdmkabloce'
const SESSION = 'session-popup-test-7c41e2a9'

const tools = new Map()
apply({ tools: { register: (t) => tools.set(t.name, t) }, get: () => undefined, inject: () => {}, on: () => {} }, {})
let n = 0
const run = async (name, a) =>
  (await tools.get(name).execute(a, { agent: { sessionId: SESSION }, callId: `popup-test-${Date.now()}-${++n}` })).text

/** 不经插件、直接说 socket 协议（弹窗页的开/关/读不该算进被测会话） */
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

const server = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  r.end('<title>弹窗测试页</title><button id=b onclick="this.textContent=\'点过了\'">点我</button>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`

const results = []
const check = async (title, fn) => {
  try { await fn(); results.push(`✅ ${title}`) } catch (e) { results.push(`❌ ${title}: ${e.message}`) }
}

let tab
let pop
try {
  tab = /标签页 (\d+)/.exec(await run('browser_tabs', { action: 'open', url }))[1]
  await run('browser_wait', { tab, selector: '#b' })
  await run('browser_click', { tab, selector: '#b' })
  await run('browser_devtools', { tab, action: 'response', request: '1.1' }).catch(() => {})

  pop = (await raw('open', { url: `chrome-extension://${EXT_ID}/popup.html` })).tabId
  const ev = async (expression) =>
    (await raw('cdp', { tabId: pop, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })).result.result.value
  const textOf = () => ev('document.body.innerText')
  await sleep(1500)

  await check('状态卡：已连接 + 三段链路 + 版本号', async () => {
    const t = await textOf()
    assert.match(t, /已连接/)
    assert.match(t, /Chrome[\s\S]*本地宿主[\s\S]*DSH/)
    assert.match(t, /v1\.1?\d\.\d/)
  })
  await check('会话：按 DSH 会话 id 归组，标签页和计数都对', async () => {
    const t = await textOf()
    assert.match(t, /会话 popup-te…e2a9/, t)
    assert.match(t, /1 个 Tab/)
    assert.match(t, /弹窗测试页/)
    assert.doesNotMatch(t, /chrome-extension/)   // 弹窗页自己不算
  })
  await check('最近动作：一次工具调用一条，带提示和失败原因（人话）', async () => {
    const t = await textOf()
    assert.match(t, /点击\s+#b/)
    assert.match(t, /等待\s+#b/)
    assert.match(t, /调试\s+response/)
    assert.match(t, /No resource/)
    assert.doesNotMatch(t, /"code"/)
  })
  await check('松手按钮：断开调试、标签页留着、记一条「你松手了」', async () => {
    await ev(`document.querySelector('[data-act="release"][data-tab="${tab}"]').click()`)
    await sleep(800)
    const t = await textOf()
    assert.match(t, /0 个 Tab/)
    assert.match(t, /已松手/)
    assert.match(t, /你松手了/)
    const tabs = await raw('tabs', {})
    assert.ok(tabs.some((x) => String(x.id) === tab), '标签页不该被关掉')
  })
  await check('暂停开关：暂停后工具调用被拒，恢复后又能用', async () => {
    await ev(`(() => { const i = document.querySelector('input[data-act="pause"]'); i.checked = false; i.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await sleep(600)
    assert.match(await textOf(), /已暂停/)
    await assert.rejects(run('browser_read', { tab, what: 'info' }), /暂停/)
    await ev(`(() => { const i = document.querySelector('input[data-act="pause"]'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await sleep(600)
    assert.match(await textOf(), /已连接/)
    assert.match(await run('browser_read', { tab, what: 'info' }), /弹窗测试页/)
  })
  await check('光标开关：关掉后照样点得动、页面里没有光标；打开后光标 v4 回来', async () => {
    const flip = (on) => ev(`(() => { const i = document.querySelector('input[data-act="cursor"]'); i.checked = ${on}; i.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    const inPage = async () => JSON.parse(await run('browser_eval', { tab, expression: 'JSON.stringify({ el: !!document.querySelector("dsh-cursor"), v: window.__dshCursor ? window.__dshCursor.version : 0 })' }))
    await flip(false)
    await sleep(600)
    assert.match(await run('browser_click', { tab, selector: '#b' }), /已点击/)
    assert.equal((await inPage()).el, false)
    await flip(true)
    await sleep(600)
    await run('browser_click', { tab, selector: '#b' })
    const c = await inPage()
    assert.ok(c.el && c.v === 4, JSON.stringify(c))
  })
  await check('诊断信息：版本、宿主、会话、日志都在', async () => {
    const r = await ev(`chrome.runtime.sendMessage({ popup: 'diagnostics' })`)
    assert.match(r.text, /DSH Bridge 1\.1?\d\.\d/)
    assert.match(r.text, /宿主：已连接，pid \d+，socket 在听/)
    assert.match(r.text, /popup-test/)
    assert.match(r.text, /扩展日志/)
  })
} finally {
  // 万一中途失败停在暂停状态，恢复掉，别把用户的浏览器控制关了
  if (pop) {
    await raw('cdp', { tabId: pop, method: 'Runtime.evaluate', params: { expression: "chrome.runtime.sendMessage({ popup: 'pause', on: false })", awaitPromise: true } }).catch(() => {})
    await raw('cdp', { tabId: pop, method: 'Runtime.evaluate', params: { expression: "chrome.runtime.sendMessage({ popup: 'cursor', on: true })", awaitPromise: true } }).catch(() => {})
    await raw('close', { tabId: pop }).catch(() => {})
  }
  if (tab) await raw('close', { tabId: Number(tab) }).catch(() => {})
  server.close()
}

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
