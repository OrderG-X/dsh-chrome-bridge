/**
 * 真浏览器里测功能（e2e-chrome.mjs 连上宿主之后调）：
 *   · browser_download：同站带登录（页面里取）、服务器给的中文文件名、5MB 分块、跨站带 Cookie + 重定向（插件直接下）、
 *     blob: 链接、框架里的链接、重名不覆盖、404 报错、下到网页时提醒、默认存进「下载」文件夹
 *   · 同源 iframe：快照里列出框架里的元素，按编号点、打字、选下拉框；读文字带上框架里的字；跨站框架给提示
 * 两个本地服务器：127.0.0.1（主页面）和 localhost（另一个站点）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { sleep } from './e2e-lib.mjs'

const BIG = Buffer.alloc(5 * 1024 * 1024 + 123)
for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 7 + (i >> 11)) & 255
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const cookieOf = (req, name) => (new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie || '') || [])[1]

function listen(server, host) {
  return new Promise((r) => server.listen(0, host, () => r(server.address().port)))
}

export async function featureChecks({ check, tools, browserCdp }) {
  let portB = 0
  const a = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, ...headers }); res.end(body) }
    switch (u.pathname) {
      case '/': return send(200, 'text/html; charset=utf-8', `<!doctype html><meta charset=utf-8><title>下载和框架</title>
<h2>下载</h2>
<a id="csv" href="/files/report.csv">报表</a>
<a id="inv" href="files/invoice">发票</a>
<a id="sec" href="http://localhost:${portB}/r">跨站文件</a>
<a id="blob" download="笔记.txt">blob 文件</a>
<div style="height:1500px"></div>
<iframe id="f1" src="/frame" style="margin:40px;border:7px solid #888;padding:5px;width:420px;height:240px"></iframe>
<iframe id="f2" src="http://localhost:${portB}/xframe" width="300" height="100"></iframe>
<script>document.cookie = 'sid=s1; path=/'; document.getElementById('blob').href = URL.createObjectURL(new Blob(['blob 内容 ✓'], { type: 'text/plain' }))</script>`)
      case '/frame': return send(200, 'text/html; charset=utf-8', `<!doctype html><meta charset=utf-8>
<p>框架里的字</p>
<div style="height:400px"></div>
<button id="fb" onclick="this.textContent='点到了'">框架按钮</button>
<input id="fi" aria-label="框架输入框">
<select id="fs" aria-label="框架下拉"><option value="a">甲</option><option value="b">乙</option></select>
<a id="fl" href="/files/report.csv">框架里的报表</a>`)
      case '/files/report.csv':
        return cookieOf(req, 'sid') === 's1' ? send(200, 'text/csv', 'a,b\n1,2\n') : send(403, 'text/plain', 'no cookie')
      case '/files/invoice':
        return send(200, 'application/pdf', '%PDF-1.4 fake', { 'content-disposition': `attachment; filename="invoice.pdf"; filename*=UTF-8''${encodeURIComponent('发票 2026.pdf')}` })
      case '/files/big.bin': return send(200, 'application/octet-stream', BIG, { 'content-length': String(BIG.length) })
      case '/files/login': return send(200, 'text/html; charset=utf-8', '<form>请先登录</form>')
      default: return send(404, 'text/plain', 'not found')
    }
  })
  const b = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/r') { res.writeHead(302, { location: '/secret.bin' }); return res.end() }
    if (u.pathname === '/secret.bin') {
      if (cookieOf(req, 'tok') !== 't2') { res.writeHead(401); return res.end('no') }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="secret.bin"' })
      return res.end('secret ✓')
    }
    if (u.pathname === '/xframe') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<p>跨站框架</p><button>外站按钮</button>') }
    res.writeHead(404); res.end()
  })
  const portA = await listen(a, '127.0.0.1')
  portB = await listen(b) // 双栈：localhost 解析成 ::1 还是 127.0.0.1 都接得住
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-dl-'))
  const exec = { agent: { session: { header: { cwd: work } } } }
  const T = (name) => tools.get(name)
  const run = async (name, args) => {
    try { return { ok: true, text: String((await T(name).execute(args, exec)).text) } } catch (e) { return { ok: false, text: String(e && e.message) } }
  }
  const inDownloads = []

  try {
    // 另一个站点的登录 Cookie（模拟用户在 localhost 那边登录过）
    await browserCdp('Storage.setCookies', { cookies: [{ name: 'tok', value: 't2', url: `http://localhost:${portB}/` }] })

    const opened = await run('browser_tabs', { action: 'open', url: `http://127.0.0.1:${portA}/` })
    const tab = (/标签页 (\d+)/.exec(opened.text) || [])[1]
    if (!check('打开下载 / 框架测试页', tab, opened.text)) return
    let ready = ''
    for (let i = 0; i < 40 && ready !== 'true'; i++) {
      await sleep(250)
      ready = (await run('browser_eval', { tab, expression: "!!(document.getElementById('f1').contentDocument && document.getElementById('f1').contentDocument.getElementById('fl'))" })).text
    }
    check('框架加载完', ready === 'true', ready)

    // ── 同源 iframe ──
    const snap = await run('browser_read', { tab, what: 'snapshot' })
    const ref = (name) => (new RegExp(`\\[(\\d+)\\] \\S+ "${name}"`).exec(snap.text) || [])[1]
    check('快照展开同源框架', snap.text.includes('[iframe] /frame ↓') && snap.text.includes('[/iframe]') && ref('框架按钮'), snap.text.slice(0, 1200))
    check('快照里跨站框架给提示', /\[iframe\] http:\/\/localhost:\d+\/xframe（跨站框架/.test(snap.text) && !snap.text.includes('外站按钮'), snap.text.slice(-600))

    const frameVal = async (js) => (await run('browser_eval', { tab, expression: `(() => { const d = document.getElementById('f1').contentDocument; return ${js} })()` })).text
    const clicked = await run('browser_click', { tab, ref: Number(ref('框架按钮')) })
    check('按编号点框架里的按钮（坐标算上框架位置和滚动）', clicked.ok && (await frameVal("d.getElementById('fb').textContent")).includes('点到了'), clicked.text)
    const typed = await run('browser_input', { tab, action: 'type', ref: Number(ref('框架输入框')), text: '你好 frame' })
    check('按编号往框架里的输入框打字', typed.ok && (await frameVal("d.getElementById('fi').value")).includes('你好 frame'), typed.text)
    const sel = await run('browser_input', { tab, action: 'select', ref: Number(ref('框架下拉')), value: '乙' })
    check('按编号选框架里的下拉框', sel.ok && (await frameVal("d.getElementById('fs').value")).includes('b'), sel.text)
    const timed = async (name, args) => { const t0 = Date.now(); const r = await run(name, args); r.text += `（${Date.now() - t0}ms）`; return r }
    const vshot = await timed('browser_screenshot', { tab, mode: 'viewport' })
    check('能截可见区域', vshot.ok, vshot.text)
    const tshot = await timed('browser_screenshot', { tab, mode: 'element', selector: '#csv' })
    check('主页面的元素能单独截图', tshot.ok, tshot.text)
    const shot = await timed('browser_screenshot', { tab, mode: 'element', ref: Number(ref('框架按钮')) })
    check('框架里的元素能单独截图', shot.ok, shot.text)
    const txt = await run('browser_read', { tab, what: 'text' })
    check('读文字带上框架里的字', txt.text.includes('框架里的字') && txt.text.includes('跨站框架，读不到'), txt.text.slice(-400))

    // ── 下载 ──
    const dl = async (args) => {
      const r = await run('browser_download', { tab, to: 'workdir', ...args })
      const file = (/已下载：(.+?)（/.exec(r.text) || [])[1]
      return { ...r, file, body: file && fs.existsSync(file) ? fs.readFileSync(file) : null }
    }
    const csv = await dl({ ref: Number(ref('报表')) })
    check('按编号下载：同站带登录 Cookie', csv.body && csv.body.toString() === 'a,b\n1,2\n' && path.basename(csv.file) === 'report.csv' && path.dirname(csv.file) === work, csv.text)
    const inv = await dl({ selector: '#inv' })
    check('用服务器给的中文文件名', inv.file && path.basename(inv.file) === '发票 2026.pdf' && inv.body.toString() === '%PDF-1.4 fake', inv.text)
    const big = await dl({ url: '/files/big.bin' })
    check('5MB 文件分块读回、一字不差', big.body && big.body.length === BIG.length && sha(big.body) === sha(BIG), big.text)
    const sec = await dl({ ref: Number(ref('跨站文件')) })
    check('跨站文件：带上那个站的 Cookie、跟着重定向', sec.body && sec.body.toString() === 'secret ✓' && path.basename(sec.file) === 'secret.bin', sec.text)
    const blob = await dl({ selector: '#blob' })
    check('blob: 链接，用 download 属性的名字', blob.body && blob.body.toString() === 'blob 内容 ✓' && path.basename(blob.file) === '笔记.txt', blob.text)
    const inFrame = await dl({ ref: Number(ref('框架里的报表')) })
    check('框架里的链接也能下；重名不覆盖', inFrame.file && path.basename(inFrame.file) === 'report (1).csv' && inFrame.body.toString() === 'a,b\n1,2\n', inFrame.text)
    const named = await dl({ url: '/files/report.csv', filename: '../逃出去?.csv' })
    check('指定文件名，去掉路径和非法字符', named.file && path.dirname(named.file) === work && path.basename(named.file) === '.._逃出去_.csv'.replace(/^\.+/, ''), named.text)
    const missing = await dl({ url: '/files/missing' })
    check('404 报错', !missing.ok && missing.text.includes('404'), missing.text)
    const login = await dl({ url: '/files/login' })
    check('下到的是网页时提醒', login.ok && login.text.includes('text/html') && login.text.includes('⚠️'), login.text)
    check('没留下 .part 临时文件', !fs.readdirSync(work).some((f) => f.endsWith('.part')), fs.readdirSync(work).join(', '))
    const def = await run('browser_download', { tab, url: '/files/report.csv', filename: `dsh-e2e-${process.pid}.csv` })
    const defFile = (/已下载：(.+?)（/.exec(def.text) || [])[1]
    if (defFile) inDownloads.push(defFile)
    check('默认存进「下载」文件夹', defFile && path.dirname(defFile) === path.join(os.homedir(), 'Downloads') && fs.existsSync(defFile), def.text)
  } finally {
    for (const f of inDownloads) try { fs.rmSync(f, { force: true }) } catch {}
    try { fs.rmSync(work, { recursive: true, force: true }) } catch {}
    a.close()
    b.close()
  }
}
