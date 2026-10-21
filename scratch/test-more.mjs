/**
 * 控制台 / 网络 / 后退前进刷新 / 等文字等网址等消失 / 拖拽 的实机测试：
 * 在真 Chrome 里后台开本地测试页，走插件注册的 browser_* 工具，测完关掉标签页。
 *
 *   node scratch/test-more.mjs
 *
 * 要求：Chrome 开着、扩展已加载（/tmp/dsh-bridge-<uid>/dsh-bridge.sock 存在）。
 */

import assert from 'node:assert'
import http from 'node:http'
import { apply } from '../plugin/index.js'

const MAIN = `<!doctype html><meta charset="utf-8"><title>更多功能测试页</title>
<style>body{font:14px sans-serif;margin:8px} #zone{width:200px;height:50px;border:2px dashed #888}
#track{position:relative;width:300px;height:20px;background:#ddd;margin:10px 0}
#knob{position:absolute;left:0;top:0;width:20px;height:20px;background:#36c;touch-action:none}</style>
<button id="fetch" onclick="fetch('/api/data').then(r=>r.json()).then(d=>window.got=d)">拉数据</button>
<button id="load" onclick="setTimeout(()=>{document.getElementById('spinner').remove();document.getElementById('out').textContent='加载完成'},800)">加载</button>
<button id="spa" onclick="setTimeout(()=>history.pushState({},'','/spa/done'),500)">单页跳转</button>
<div id="spinner">加载中…</div><div id="out"></div>
<button id="a" draggable="true" data-v="A">A 项</button>
<button id="b" draggable="true" data-v="B">B 项</button>
<div id="zone">放这里</div>
<div id="track"><div id="knob"></div></div>
<script>
console.log('hello-log', 42);
console.log({ a: 1, b: 'x' }, [1, 2]);
console.warn('warn-x');
console.error('err-y');
setTimeout(() => { throw new Error('boom-uncaught') }, 0);

document.querySelectorAll('[draggable=true]').forEach((el) =>
  el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', el.dataset.v)));
const zone = document.getElementById('zone');
zone.addEventListener('dragover', (e) => e.preventDefault());
zone.addEventListener('drop', (e) => { e.preventDefault(); window.dropped = e.dataTransfer.getData('text/plain'); zone.textContent = '放进来了 ' + window.dropped });

const knob = document.getElementById('knob'), track = document.getElementById('track');
window.sliderVal = 0;
knob.addEventListener('pointerdown', (e) => { knob.setPointerCapture(e.pointerId); knob.dataset.drag = 1 });
knob.addEventListener('pointermove', (e) => {
  if (!knob.dataset.drag) return;
  const r = track.getBoundingClientRect();
  const x = Math.max(0, Math.min(r.width - 20, e.clientX - r.left - 10));
  knob.style.left = x + 'px';
  window.sliderVal = Math.round(x / (r.width - 20) * 100);
});
knob.addEventListener('pointerup', () => { delete knob.dataset.drag; window.sliderDone = 1 });
</script>`

const PLAIN = (n) => `<!doctype html><meta charset="utf-8"><title>第${n}页</title><h1>第${n}页</h1>`

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === '/favicon.ico') { res.writeHead(204); return res.end() }
  if (p === '/api/data') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }))
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(p === '/p1' ? PLAIN(1) : p === '/p2' ? PLAIN(2) : MAIN)
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
const run = async (name, args) => (await tools.get(name).execute(args)).text

const results = []
const check = async (title, fn) => {
  try { await fn(); results.push(`✅ ${title}`) } catch (e) { results.push(`❌ ${title}: ${e.message}`) }
}
const openTab = async (url) => String(/标签页 (\d+)/.exec(await run('browser_tabs', { action: 'open', url }))[1])
const opened = []

try {
  const tab = await openTab(`${base}/`)
  opened.push(tab)
  // 先不碰它，等页面把 console 打完：之后接上调试器时这些是 V8「补发」的（补发不带对象预览）
  await new Promise((r) => setTimeout(r, 1500))
  await run('browser_wait', { tab, selector: '#knob' })
  const ev = async (expression) => (await run('browser_eval', { tab, expression })).trim()

  // ── 控制台 ──
  await check('console：普通输出、警告、报错、未捕获异常都有', async () => {
    const t = await run('browser_devtools', { tab, action: 'console' })
    console.log(t + '\n')
    assert.match(t, /log\s+hello-log 42/)
    assert.match(t, /log\s+\{a: 1, b: "x"\} \[1, 2\]/)
    assert.match(t, /warning\s+warn-x/)
    assert.match(t, /error\s+err-y/)
    assert.match(t, /\[未捕获\] .*boom-uncaught/)
  })
  await check('console：level=error 只剩报错', async () => {
    const t = await run('browser_devtools', { tab, action: 'console', level: 'error' })
    assert.match(t, /err-y/)
    assert.match(t, /boom-uncaught/)
    assert.doesNotMatch(t, /hello-log|warn-x/)
  })
  await check('console：filter 过滤', async () => {
    const t = await run('browser_devtools', { tab, action: 'console', filter: 'WARN-X' })
    assert.match(t, /warn-x/)
    assert.doesNotMatch(t, /err-y/)
  })

  // ── 网络 ──
  let reqId
  await check('network：点按钮发的接口请求记下来了', async () => {
    await run('browser_click', { tab, selector: '#fetch' })
    for (let i = 0; i < 20 && (await ev('String(!!window.got)')) !== 'true'; i++) await new Promise((r) => setTimeout(r, 200))
    const t = await run('browser_devtools', { tab, action: 'network', filter: 'api/data' })
    console.log(t + '\n')
    const m = /^#(\S+) GET 200 fetch \d+ms .*\/api\/data$/m.exec(t)
    assert.ok(m, t)
    reqId = m[1]
  })
  await check('response：拿到接口返回的 JSON', async () => {
    const t = await run('browser_devtools', { tab, action: 'response', request: `#${reqId}` })
    assert.match(t, /"items": \[/)
    assert.match(t, /"ok": true/)
  })
  await check('response：瞎编的编号给人话报错', async () => {
    await assert.rejects(run('browser_devtools', { tab, action: 'response', request: '999999.9' }), /拿不到/)
  })
  await check('network reload=true：抓到页面本身的请求', async () => {
    const t = await run('browser_devtools', { tab, action: 'network', reload: true })
    assert.match(t, new RegExp(`GET 200 document \\d+ms ${base}/$`, 'm'), t)
    await run('browser_wait', { tab, selector: '#knob' })
  })
  await check('clear：清空后控制台是空的', async () => {
    await run('browser_devtools', { tab, action: 'clear' })
    const t = await run('browser_devtools', { tab, action: 'console' })
    assert.match(t, /没有输出/, t)
  })

  // ── 等待 ──
  await check('wait：参数不对给人话报错', async () => {
    await assert.rejects(run('browser_wait', { tab }), /给且只给一个/)
    await assert.rejects(run('browser_wait', { tab, text: 'a', url: 'b' }), /给且只给一个/)
  })
  await check('wait：等加载圈消失 + 等文字出现', async () => {
    await run('browser_click', { tab, selector: '#load' })
    const gone = await run('browser_wait', { tab, selector: '#spinner', gone: true, timeoutMs: 5000 })
    assert.match(gone, /已经没有 #spinner，用了 \d+ms/)
    const t = await run('browser_wait', { tab, text: '加载完成', timeoutMs: 3000 })
    assert.match(t, /等到了 文字「加载完成」/)
  })
  await check('wait：等网址（单页应用 pushState）', async () => {
    await run('browser_click', { tab, selector: '#spa' })
    const t = await run('browser_wait', { tab, url: 'spa/done', timeoutMs: 5000 })
    assert.match(t, /等到了 网址包含「spa\/done」/)
  })
  await check('wait：等不到会超时报错', async () => {
    await assert.rejects(run('browser_wait', { tab, text: '永远不会出现', timeoutMs: 1000 }), /还没出现/)
  })

  // ── 拖拽 ──
  await check('drag：按文字找起点和放置区（text → text）', async () => {
    const t = await run('browser_drag', { tab, fromText: 'B 项', toText: '放这里' })
    assert.match(t, /已拖拽 「B 项」 → 「放这里」（HTML5 拖放，目标接受了）/, t)
    assert.equal(await ev('window.dropped'), 'B')
  })
  await check('drag：HTML5 拖放（selector → selector）', async () => {
    const t = await run('browser_drag', { tab, fromSelector: '#a', toSelector: '#zone' })
    assert.match(t, /HTML5 拖放，目标接受了/, t)
    assert.equal(await ev('window.dropped'), 'A')
  })
  await check('drag：按编号拖（ref → selector）', async () => {
    const snap = await run('browser_read', { tab, what: 'snapshot' })
    const m = /^\[(\d+)\] button "B 项"/m.exec(snap)
    assert.ok(m, snap)
    await run('browser_drag', { tab, fromRef: Number(m[1]), toSelector: '#zone' })
    assert.equal(await ev('window.dropped'), 'B')
  })
  await check('drag：鼠标拖滑块到坐标（pointer 事件）', async () => {
    const r = JSON.parse(await run('browser_eval', { tab, expression: '(() => { const r = track.getBoundingClientRect(); return { x: Math.round(r.right - 5), y: Math.round(r.top + r.height / 2) } })()' }))
    const t = await run('browser_drag', { tab, fromSelector: '#knob', toX: r.x, toY: r.y })
    assert.match(t, /已拖拽 #knob/, t)
    assert.ok(Number(await ev('String(window.sliderVal)')) >= 95, `滑块只到 ${await ev('String(window.sliderVal)')}`)
    assert.equal(await ev('String(window.sliderDone)'), '1')
  })
  await check('drag：找不到起点给人话报错', async () => {
    await assert.rejects(run('browser_drag', { tab, fromSelector: '#nope', toSelector: '#zone' }), /没找到起点/)
  })

  // ── 后退 / 前进 / 刷新（单独开一个标签页，历史干净） ──
  const nt = await openTab(`${base}/p1`)
  opened.push(nt)
  await run('browser_wait', { tab: nt, text: '第1页' })
  await check('nav：go / back / forward / reload', async () => {
    assert.match(await run('browser_nav', { tab: nt, url: `${base}/p2` }), /已到 .*\/p2 — 第2页/)
    assert.match(await run('browser_nav', { tab: nt, action: 'back' }), /已后退到 .*\/p1 — 第1页$/)
    assert.match(await run('browser_nav', { tab: nt, action: 'forward' }), /已前进到 .*\/p2 — 第2页$/)
    await run('browser_eval', { tab: nt, expression: 'window.keep = 1' })
    assert.match(await run('browser_nav', { tab: nt, action: 'reload' }), /已刷新 .*\/p2 — 第2页$/)
    assert.equal((await run('browser_eval', { tab: nt, expression: 'String(window.keep)' })).trim(), 'undefined')
  })
  await check('nav：单页应用的后退（同一个文档只改网址）', async () => {
    await run('browser_eval', { tab: nt, expression: "history.pushState({}, '', '/p2#spa')" })
    const t = await run('browser_nav', { tab: nt, action: 'back' })
    assert.match(t, /已后退到 .*\/p2 — 第2页$/, t)
  })
  await check('nav：到头了给人话报错', async () => {
    await run('browser_nav', { tab: nt, action: 'back' })
    await assert.rejects(run('browser_nav', { tab: nt, action: 'back' }), /第一页/)
    await assert.rejects(run('browser_nav', { tab: nt }), /需要 url/)
  })
} finally {
  for (const t of opened) await run('browser_tabs', { action: 'close', tab: t }).catch(() => {})
  server.close()
}

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
