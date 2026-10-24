/**
 * 真浏览器端到端：在一台干净机器上把整条链路走一遍
 *   ① 插件的自动安装（真 HOME：注册文件、Windows 注册表都是真写）
 *   ② 起一个真 Chrome，把扩展当「已解压」加载进去（CDP Extensions.loadUnpacked，Chrome 137+ 不再认 --load-extension）
 *   ③ 等 Chrome 按注册拉起宿主、扩展连上（cb status）
 *   ④ cb 开本地页面、读标题；再用插件自己的 browser_* 工具读同一页
 *
 * CI（GitHub 的 macOS / Windows / Linux 机器）里用真 HOME、真注册、默认宿主目录，测的就是用户机器上那条路。
 * 本地跑（没有 CI 环境变量）时 HOME 和宿主目录都换成临时的，不碰你自己的 Chrome 和正在用的宿主。
 *   node scratch/e2e-chrome.mjs [--headed]
 * CHROME_BIN 可指定 Chrome 路径。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform
const HEADED = process.argv.includes('--headed')
const FIXED_EXT_ID = 'mhlkjkblmdleplggfengldbdmkabloce'
const TITLE = 'DSH 桥 E2E 测试页'

const LOCAL = !process.env.CI
const tmpHome = LOCAL ? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-home-')) : null
if (LOCAL) {
  // 要在 import 插件之前改：插件和宿主都是加载时就定下目录（宿主由 Chrome 拉起，继承这里的环境）
  process.env.HOME = process.env.USERPROFILE = tmpHome
  process.env.DSH_BRIDGE_DIR = path.join(tmpHome, 'run')
}

const results = []
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra: cond ? '' : String(extra) })
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${extra}`}`)
  return !!cond
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function chromeBin() {
  const env = process.env
  const cands = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    win32: [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter(Boolean).map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  }[process.platform] || []
  return [env.CHROME_BIN, ...cands].filter(Boolean).find((p) => fs.existsSync(p)) || null
}

/** 跑 cb（装好的那份），回 JSON；失败抛错 */
function cb(cbFile, ...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cbFile, ...args, '--json'], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error(`cb 输出不是 JSON：${stdout.slice(0, 200)}`)) }
    })
  })
}

/** CDP over --remote-debugging-pipe：fd3 写给 Chrome，fd4 读 Chrome，消息以 \0 分隔 */
function pipeClient(proc) {
  const out = proc.stdio[3]
  const inp = proc.stdio[4]
  const pending = new Map()
  let seq = 0
  let buf = Buffer.alloc(0)
  inp.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    let i
    while ((i = buf.indexOf(0)) >= 0) {
      const msg = JSON.parse(buf.subarray(0, i).toString('utf8'))
      buf = buf.subarray(i + 1)
      const p = msg.id && pending.get(msg.id)
      if (!p) continue
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.message} ${msg.error.data || ''}`.trim()))
      else p.resolve(msg.result)
    }
  })
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    out.write(`${JSON.stringify({ id, method, params })}\0`)
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} 超时`)) }, 30000)
  })
}

function tail(file, n = 30) {
  try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n') } catch { return `（没有 ${file}）` }
}

let chrome = null
let server = null
let chromeLog = ''
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-chrome-'))

try {
  // ① 自动安装
  const { ensureInstalled, installState, paths, REG_KEYS } = await import(pathToFileURL(path.join(ROOT, 'plugin/setup.js')))
  const inst = ensureInstalled()
  check('自动安装成功', inst.ok, inst.reason)
  const st = installState()
  check('宿主启动脚本已落盘', st.hostCopied, st.launcher)
  check(`native messaging 已注册${WIN ? '（注册表）' : ''}`, st.registered, st.nmFile)
  check('扩展 ID 固定', st.extId === FIXED_EXT_ID, st.extId)
  const p = paths()
  if (WIN) {
    const reg = await new Promise((r) => execFile('reg', ['query', REG_KEYS[0], '/ve'], (e, o) => r(o || '')))
    check('注册表指向注册文件', reg.includes(p.nmFile), reg.trim())
  }
  // Mac / Linux 的 Chrome 在「用户数据目录/NativeMessagingHosts」里找注册：测试用的是临时数据目录，抄一份过去
  if (!WIN) {
    fs.mkdirSync(path.join(udd, 'NativeMessagingHosts'), { recursive: true })
    fs.copyFileSync(p.nmFile, path.join(udd, 'NativeMessagingHosts', path.basename(p.nmFile)))
  }

  // ② 真 Chrome + 加载已解压
  const bin = chromeBin()
  if (!check('找到 Chrome', bin)) throw new Error('没有 Chrome')
  const args = [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${udd}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    ...(HEADED ? [] : ['--headless=new']),
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...(process.platform === 'linux' ? ['--no-sandbox', '--password-store=basic'] : []),
    'about:blank',
  ]
  chrome = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true })
  chrome.stderr.on('data', (d) => { chromeLog = (chromeLog + d).slice(-20000) })
  const cdp = pipeClient(chrome)
  const ver = await cdp('Browser.getVersion')
  console.log(`  ${ver.product}`)
  const { id } = await cdp('Extensions.loadUnpacked', { path: p.extDir })
  check('扩展加载进 Chrome', id === FIXED_EXT_ID, id)

  // ③ 宿主连上
  let status = null
  let lastErr = ''
  for (let i = 0; i < 60 && !(status && status.extConnected); i++) {
    await sleep(1000)
    try { status = await cb(p.cb, 'status') } catch (e) { lastErr = e.message }
  }
  if (!check('Chrome 拉起宿主、扩展连上', status && status.extConnected, lastErr || JSON.stringify(status))) throw new Error('宿主没连上')
  if (WIN) check('宿主走 Windows 命名管道', String(status.socket).startsWith('\\\\.\\pipe\\'), status.socket)

  // ④ 真页面
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>${TITLE}</title><h1 id="x">你好，桥</h1>`)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/`

  const opened = await cb(p.cb, 'open', url)
  check('cb 开新标签页', Number.isInteger(opened.tabId), JSON.stringify(opened))
  let title = null
  for (let i = 0; i < 20 && title !== TITLE; i++) {
    await sleep(500)
    try { title = (await cb(p.cb, 'eval', String(opened.tabId), 'document.title')).value } catch (e) { lastErr = e.message }
  }
  check('cb eval 读到页面标题（中文不乱码）', title === TITLE, title ?? lastErr)

  // 插件自己的工具：DSH 里模型调的就是这条路
  const plugin = await import(pathToFileURL(path.join(ROOT, 'plugin/index.js')))
  const tools = new Map()
  plugin.apply({ inject() {}, tools: { register: (t) => tools.set(t.name, t) }, on() {}, get() {} }, {})
  check('插件注册了 browser_* 工具', tools.has('browser_tabs') && tools.has('browser_eval'), [...tools.keys()].join(','))
  const list = await tools.get('browser_tabs').execute({ action: 'list' }, {})
  check('browser_tabs 列出测试页', String(list.text).includes(TITLE), String(list.text).slice(0, 300))
  const ev = await tools.get('browser_eval').execute({ expression: "document.querySelector('#x').textContent", tab: String(opened.tabId) }, {})
  check('browser_eval 读到页面内容', String(ev.text).includes('你好，桥'), String(ev.text).slice(0, 300))
} catch (e) {
  check('没有异常', false, e && e.stack || e)
} finally {
  if (results.some((r) => !r.ok)) {
    const dir = process.env.DSH_BRIDGE_DIR || (WIN ? path.join(os.tmpdir(), 'dsh-bridge') : `/tmp/dsh-bridge-${process.getuid()}`)
    console.log(`\n── 宿主日志 ──\n${tail(path.join(dir, 'dsh-bridge.log'))}`)
    console.log(`\n── 插件日志 ──\n${tail(path.join(dir, 'plugin.log'))}`)
    console.log(`\n── Chrome stderr ──\n${chromeLog.split('\n').slice(-30).join('\n')}`)
  }
  if (chrome && chrome.exitCode === null) {
    if (WIN) await new Promise((r) => execFile('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], () => r()))
    else chrome.kill('SIGKILL')
  }
  if (server) server.close()
  await sleep(1000)
  for (const d of [udd, tmpHome]) try { if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }) } catch {}

  const bad = results.filter((r) => !r.ok)
  const md = [`## 浏览器桥真机测试 · ${OS}`, '', ...results.map((r) => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `：${r.extra.split('\n')[0]}`}`), '']
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`)
  console.log(bad.length ? `\n❌ ${bad.length} 项没过` : '\n✅ 全部通过')
  process.exit(bad.length ? 1 : 0)
}
