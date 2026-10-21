/**
 * 扩展弹窗相关的实机测试。
 *
 * 弹窗页（chrome-extension://…/popup.html）现在任何时候都不让自动化碰（不然模型能在里面跑脚本、
 * 自己把「暂停」解除），所以这里不再开弹窗页读界面，改测：
 *   ① 扩展页面打不开、跳不过去、CDP 参数里带它也不行
 *   ② 暂停后工具调用被拒、socket 上解不开；恢复要你亲手点工具栏的 DSH Bridge 图标（脚本在这儿等你）
 * 弹窗界面本身（会话归组、最近动作、松手按钮……）跑完后按最后打印的清单手动看一眼。
 *
 *   node scratch/test-popup.mjs
 *
 * 要求：Chrome 开着、扩展 ≥1.12.0 已加载（扩展页面一律不让碰是 1.12.0 起才有的）。
 */

import assert from 'node:assert'
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import { apply } from '../plugin/index.js'

const EXT_ID = 'mhlkjkblmdleplggfengldbdmkabloce'
const SESSION = 'session-popup-test-7c41e2a9'
const RUN = process.env.DSH_BRIDGE_DIR || `/tmp/dsh-bridge-${process.getuid()}`

const tools = new Map()
apply({ tools: { register: (t) => tools.set(t.name, t) }, get: () => undefined, inject: () => {}, on: () => {} }, {})
let n = 0
const run = async (name, a) =>
  (await tools.get(name).execute(a, { agent: { sessionId: SESSION }, callId: `popup-test-${Date.now()}-${++n}` })).text

/** 不经插件、直接说 socket 协议 */
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

const server = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  r.end('<title>弹窗测试页</title><button id=b onclick="this.textContent=\'点过了\'">点我</button>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`
const POPUP = `chrome-extension://${EXT_ID}/popup.html`

const results = []
const check = async (title, fn) => {
  try { await fn(); results.push(`✅ ${title}`) } catch (e) { results.push(`❌ ${title}: ${e.message}`) }
}

let tab
try {
  tab = /标签页 (\d+)/.exec(await run('browser_tabs', { action: 'open', url }))[1]
  await run('browser_wait', { tab, selector: '#b' })
  await run('browser_click', { tab, selector: '#b' })
  await run('browser_input', { tab, action: 'type', selector: '#b', text: 'secret-typed-text' }).catch(() => {})

  await check('扩展页面：打不开（含相对地址）、跳不过去、CDP 网址参数里带它也不行；只是提到它不拦', async () => {
    await assert.rejects(raw('open', { url: POPUP }), /扩展页面/)
    await assert.rejects(raw('open', { url: 'popup.html' }), /完整网址/)
    await assert.rejects(raw('nav', { tabId: Number(tab), url: POPUP }), /扩展页面/)
    await assert.rejects(raw('cdp', { tabId: Number(tab), method: 'Page.navigate', params: { url: 'chrome-ext\nension://' + EXT_ID + '/popup.html' } }), /扩展页面/)
    await assert.rejects(raw('cdp', { tabId: Number(tab), method: 'Target.createTarget', params: { url: POPUP } }), /扩展页面/)
    // 只看网址的协议头：表达式文本里、查询串里提到 chrome-extension: 不算
    await raw('cdp', { tabId: Number(tab), method: 'Runtime.evaluate', params: { expression: `'${POPUP}'` } })
    await raw('nav', { tabId: Number(tab), url: `${url}?from=${POPUP}` })
  })

  await check('暂停：工具调用被拒，socket 上解不开；工具栏弹窗里恢复后又能用', async () => {
    await raw('panel', { action: 'pause', on: true })
    await assert.rejects(run('browser_read', { tab, what: 'info' }), /暂停/)
    await assert.rejects(raw('panel', { action: 'pause', on: false }), /只能在 Chrome/)
    console.log('\n👉 现在请点 Chrome 工具栏上的 DSH Bridge 图标，打开「允许 DSH 控制」（最多等 3 分钟）…')
    const deadline = Date.now() + 180_000
    while ((await raw('panel', {})).paused) {
      if (Date.now() > deadline) throw new Error('3 分钟内没等到恢复')
      await sleep(1000)
    }
    assert.match(await run('browser_read', { tab, what: 'info' }), /弹窗测试页/)
  })
} finally {
  await raw('panel', { action: 'cursor', on: true }).catch(() => {})
  if (tab) await raw('close', { tabId: Number(tab) }).catch(() => {})
  server.close()
  const st = await raw('panel', {}).catch(() => null)
  if (st && st.paused) console.log('\n⚠️ 浏览器控制还停在「暂停」：点 Chrome 工具栏的 DSH Bridge 图标打开「允许 DSH 控制」')
}

console.log(results.join('\n'))
console.log(`
手动看一眼弹窗（点工具栏的 DSH Bridge 图标）：
  · 状态卡「已连接」、三段链路、版本号
  · 会话「popup-te…e2a9」下面有「弹窗测试页」，最近动作里有「点击 #b」「等待 #b」「输入 打字 17 字」（看不到打的原文）
  · 松手按钮能断开、标签页留着、记一条「你松手了」；光标开关、复制诊断信息都能用`)
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
