/**
 * 真浏览器端到端：在一台干净机器上把整条链路走一遍
 *   ① 插件的自动安装（真 HOME：注册文件、Windows 注册表都是真写）
 *   ② 起一个真浏览器，把扩展当「已解压」加载进去（CDP Extensions.loadUnpacked，Chrome 137+ 不再认 --load-extension）
 *   ③ 等浏览器按注册拉起宿主、扩展连上（cb status）
 *   ④ cb 开本地页面、读标题；再用插件自己的 browser_* 工具读同一页
 *   ⑤ 下载文件、同源 iframe 里的元素（e2e-features.mjs）
 *
 * CI（GitHub 的 macOS / Windows / Linux 机器）里用真 HOME、真注册、默认宿主目录，测的就是用户机器上那条路。
 * 本地跑（没有 CI 环境变量）时 HOME 和宿主目录都换成临时的，不碰你自己的 Chrome 和正在用的宿主。
 *
 *   node scratch/e2e-chrome.mjs [--headed] [--browser chrome|edge] [--cjk-home]
 *     --headed     有界面的浏览器（默认无头）
 *     --browser    edge：用 Microsoft Edge（Windows 上插件也给它写了注册）
 *     --cjk-home   用户目录换成带中文和空格的路径（模拟「C:\Users\张三」）
 * 用 Electron 跑（ELECTRON_RUN_AS_NODE=1 electron scratch/e2e-chrome.mjs）就是 DSH 桌面版的情形：宿主用 DSH 自己的程序拉起。
 *   Windows 上再给 DSH_E2E_NODE（一个真 node.exe）：模拟 DSH 自带的独立 node，看宿主换成复制到宿主目录的那份、
 *   旧的（Electron 跑的）宿主被换下、扩展重连上（issue #3：宿主别占着 DSH 安装目录）。
 * CHROME_BIN 可指定 Chrome 路径。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WIN, OS, FIXED_EXT_ID, sleep, checker, browserBin, launchBrowser, cb, dumpLogs } from './e2e-lib.mjs'
import { featureChecks } from './e2e-features.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const HEADED = argv.includes('--headed')
const BROWSER = argv.includes('--browser') ? argv[argv.indexOf('--browser') + 1] : 'chrome'
const CJK = argv.includes('--cjk-home')
const TITLE = 'DSH 桥 E2E 测试页'

const label = [
  BROWSER === 'edge' ? 'Edge' : 'Chrome',
  HEADED ? '有界面' : '无头',
  process.versions.electron ? 'Electron 当 node（同 DSH 桌面版）' : 'node',
  ...(CJK ? ['中文带空格的用户目录'] : []),
].join(' · ')
console.log(`── ${OS} · ${label} ──`)

const LOCAL = !process.env.CI
let tmpHome = null
if (LOCAL || CJK) {
  // 要在 import 插件之前改：插件和宿主都是加载时就定下目录（宿主由浏览器拉起，继承这里的环境）
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-home-'))
  const home = CJK ? path.join(tmpHome, '张三 的电脑') : tmpHome
  fs.mkdirSync(home, { recursive: true })
  process.env.HOME = process.env.USERPROFILE = home
  if (WIN && CJK) {
    // 像真的中文用户名那样，AppData 和临时目录也在用户目录下（Chrome 按 USERPROFILE 找 AppData，找不到会当成默认数据目录、不让调试）
    process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local')
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming')
    process.env.TEMP = process.env.TMP = path.join(process.env.LOCALAPPDATA, 'Temp')
    for (const d of [process.env.APPDATA, process.env.TEMP]) fs.mkdirSync(d, { recursive: true })
  }
}
if (LOCAL) {
  process.env.DSH_BRIDGE_DIR = path.join(tmpHome, 'run')
  // 这几个会盖过 DSH_BRIDGE_DIR：清掉，免得测试去动真宿主的 socket / token / 日志
  for (const k of ['DSH_BRIDGE_SOCK', 'DSH_BRIDGE_TOKEN', 'DSH_BRIDGE_LOG']) delete process.env[k]
}

const { check, failed, summary } = checker()
let browser = null
let server = null

try {
  // ① 自动安装
  const { ensureInstalled, installState, paths, REG_KEYS, regValue, listStaleHosts, hostProbe } = await import(pathToFileURL(path.join(ROOT, 'plugin/setup.js')))
  const inst = ensureInstalled()
  check('自动安装成功', inst.ok, inst.reason)
  const st = installState()
  check('宿主启动脚本已落盘', st.hostCopied, st.launcher)
  check(`native messaging 已注册${WIN ? '（注册表）' : ''}`, st.registered, st.nmFile)
  check('扩展 ID 固定', st.extId === FIXED_EXT_ID, st.extId)
  const p = paths()
  if (CJK) check('装进了中文带空格的用户目录', p.launcher.includes('张三 的电脑'), p.launcher)
  if (WIN) {
    const key = BROWSER === 'edge' ? REG_KEYS[1] : REG_KEYS[0]
    const reg = regValue(key)
    check(`注册表（${BROWSER === 'edge' ? 'Edge' : 'Chrome'}）指向注册文件`, reg === p.nmFile, reg)
    check('再装一次认得出已是最新（中文路径读注册表不乱码）', ensureInstalled().changed !== true)
    if (process.versions.electron) {
      const bat = fs.readFileSync(p.launcher, 'utf8')
      check('run.bat 用 Electron 当 node 拉宿主', bat.includes('ELECTRON_RUN_AS_NODE=1') && bat.includes(process.execPath), bat)
    }
  }

  // ② 真浏览器 + 加载已解压
  const bin = browserBin(BROWSER)
  if (!check(`找到 ${BROWSER === 'edge' ? 'Edge' : 'Chrome'}`, bin)) throw new Error('没有浏览器')
  browser = await launchBrowser({ bin, extDir: p.extDir, nmFile: p.nmFile, headed: HEADED })
  console.log(`  ${browser.product}`)
  check('扩展加载进浏览器', browser.extId === FIXED_EXT_ID, browser.extId)

  // ③ 宿主连上
  let status = null
  let lastErr = ''
  for (let i = 0; i < 60 && !(status && status.extConnected); i++) {
    await sleep(1000)
    try { status = await cb(p.cb, 'status') } catch (e) { lastErr = e.message }
  }
  if (!check('浏览器拉起宿主、扩展连上', status && status.extConnected, lastErr || JSON.stringify(status))) throw new Error('宿主没连上')
  if (WIN) check('宿主走 Windows 命名管道', String(status.socket).startsWith('\\\\.\\pipe\\'), status.socket)

  // ③b Windows 桌面版：DSH 有独立 node 时，宿主换成复制到宿主目录的那份，旧的（DSH 程序跑的）自动换下（issue #3）
  if (WIN && process.versions.electron && process.env.DSH_E2E_NODE) {
    const images = () => {
      const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ExecutablePath -and $_.CommandLine.ToLowerInvariant().Contains($env:DSH_BRIDGE_HOSTJS.ToLowerInvariant()) } | ForEach-Object { $_.ExecutablePath }"
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${ps}`],
        { env: { ...process.env, DSH_BRIDGE_HOSTJS: path.join(p.hostDir, 'host.js') }, encoding: 'utf8', windowsHide: true })
      return out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    }
    const same = (a, b) => a.toLowerCase() === b.toLowerCase()
    // 从真实的升级起点开始：换成 1.16.3 一字不差的 run.bat（没有 & exit /b，宿主一退 cmd 会接着读文件），
    // 把现在的宿主连同它的 cmd 结束，让 Chrome 按这个老脚本重新拉起
    const v1163 = ['@echo off', 'chcp 65001 >nul', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `set "N=${process.execPath}"`,
      'if defined DSH_BRIDGE_NODE set "N=%DSH_BRIDGE_NODE%"', 'if not exist "%N%" for %%I in (node.exe) do set "N=%%~$PATH:I"', '"%N%" "%~dp0host.js" %*', ''].join('\r\n')
    fs.writeFileSync(p.launcher, v1163)
    const trees = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($env:DSH_BRIDGE_HOSTJS.ToLowerInvariant()) } | ForEach-Object { $_.ParentProcessId }"],
      { env: { ...process.env, DSH_BRIDGE_HOSTJS: path.join(p.hostDir, 'host.js') }, encoding: 'utf8', windowsHide: true }).split(/\s+/).filter(Boolean)
    for (const pid of trees) { try { execFileSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' }) } catch {} }
    let before = []
    let st0 = null
    for (let i = 0; i < 30; i++) {
      await sleep(1000)
      try { before = images(); st0 = await cb(p.cb, 'status') } catch (e) { lastErr = e.message }
      if (before.length && st0 && st0.extConnected) break
    }
    check('旧脚本（1.16.3 原样）：宿主用 DSH 的程序（Electron）跑', before.some((x) => same(x, process.execPath)) && st0 && st0.extConnected, `${before.join(' | ')} ${lastErr || JSON.stringify(st0)}`)
    let listed = []
    try { listed = await listStaleHosts(p.hostDir, path.join(p.hostDir, 'node-none.exe')) } catch (e) { lastErr = e.message }
    const me = listed.find((h) => st0 && h.pid === st0.pid)
    check('列旧宿主：认出它、拉起它的 cmd、创建时刻，只有这一个浏览器连着', !!me && me.cmd > 0 && me.created > 0 && me.hosts === 1, `${JSON.stringify(listed)} ${lastErr || ''}`)
    const ver = execFileSync(process.env.DSH_E2E_NODE, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim()
    const rt = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime')
    fs.mkdirSync(path.join(rt, 'dependencies', 'node', 'bin'), { recursive: true })
    fs.copyFileSync(process.env.DSH_E2E_NODE, path.join(rt, 'dependencies', 'node', 'bin', 'node.exe'))
    fs.writeFileSync(path.join(rt, 'runtime.json'), JSON.stringify({ desktopVersion: '0.0.0-e2e', platform: 'win32', arch: process.arch, node: ver }))
    // 和插件里一样问占着管道的宿主（插件里走 call，这里走 cb）
    const probe = hostProbe(() => cb(p.cb, 'status'))
    const again = ensureInstalled({ log: (m) => console.log(`  ${m}`), probe })
    const copy = path.join(p.hostDir, `node-v${ver}.exe`)
    check('DSH 有独立 node：复制到宿主目录', again.ok && again.changed && fs.existsSync(copy), again.reason || copy)
    const bat2 = fs.readFileSync(p.launcher, 'utf8')
    check('run.bat 先用复制的 node、没了再退回 DSH 的程序', bat2.includes(`set "N=%~dp0${path.basename(copy)}"`) && bat2.includes(`if not exist "%N%" set "N=${process.execPath}"`), bat2)
    // 旧的 cmd（跑着改写前的 run.bat）也得一起走：不然宿主一退它接着读新文件，又用 DSH 的程序拉起一个（CI 实测过）
    const cmds = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($env:DSH_BRIDGE_RUNBAT.ToLowerInvariant()) }).Count"],
      { env: { ...process.env, DSH_BRIDGE_RUNBAT: p.launcher }, encoding: 'utf8', windowsHide: true }).trim()
    let now = []
    let st2 = null
    for (let i = 0; i < 70; i++) {   // 要连续闲一阵（扩展 5 秒没消息）、列两遍进程，再等扩展重连
      await sleep(1000)
      try { now = images(); st2 = await cb(p.cb, 'status') } catch (e) { lastErr = e.message }
      if (now.length && now.every((x) => same(x, copy)) && st2 && st2.extConnected) break
    }
    check('旧宿主换下了，扩展重连上新宿主', now.length > 0 && now.every((x) => same(x, copy)) && st2 && st2.extConnected, `${now.join(' | ')} ${lastErr || JSON.stringify(st2)}`)
    check('DSH 的程序不再跑宿主（不占 DSH 安装目录）', !now.some((x) => same(x, process.execPath)), now.join(' | '))
    let nCmd = ''
    try { nCmd = cmds() } catch (e) { nCmd = e.message }
    check('只剩一个 cmd 在跑 run.bat（旧的跟着宿主一起走了）', nCmd === '1', nCmd)
    check('换完了：「还有旧宿主要换」的记号删掉', !fs.existsSync(path.join(p.hostDir, 'restart-hosts.pending')), fs.readdirSync(p.hostDir).join(', '))
    if (!now.every((x) => same(x, copy))) {
      // 没换成：打出宿主和拉起它的 cmd 的命令行
      const diag = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($env:DSH_BRIDGE_HOSTJS.ToLowerInvariant()) } | ForEach-Object { $pp = Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.ParentProcessId)\"; \"HOST $($_.ProcessId): $($_.CommandLine)\"; \"PARENT $($_.ParentProcessId): $($pp.CommandLine)\" }"
      try {
        console.log(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${diag}`],
          { env: { ...process.env, DSH_BRIDGE_HOSTJS: path.join(p.hostDir, 'host.js') }, encoding: 'utf8', windowsHide: true }))
      } catch (e) { console.log(`诊断失败：${e.message}`) }
      console.log(`宿主目录：${fs.readdirSync(p.hostDir).join(', ')}`)
      console.log(`run.bat：${JSON.stringify(fs.readFileSync(p.launcher, 'utf8'))}`)
    }
  }

  // ④ 真页面
  server = http.createServer(async (req, res) => {
    // 第二页故意慢：服务器回第一个字节之前标签页的 url 是空的（地址在 pendingUrl），列标签页、不传 tab 接着用都得认得它
    if (req.url.includes('?2')) await sleep(2000)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>${TITLE}</title><h1 id="x">你好，桥</h1>`)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/`

  const before = await cb(p.cb, 'tabs')
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

  // ⑤ 新页开在单独窗口：用户的窗口不多标签页、焦点不动；再开进同一个窗口；关了窗口再开一个；开关关掉回到当前窗口
  {
    const userWin = before[0] && before[0].windowId
    const all = await cb(p.cb, 'tabs')
    const mine = all.find((t) => t.id === opened.tabId)
    check('新页开进单独的干活窗口', opened.window === 'agent' && mine && mine.agentWindow && mine.windowId !== userWin, JSON.stringify(mine))
    check('用户窗口里没多出标签页', all.filter((t) => t.windowId === userWin).length === before.filter((t) => t.windowId === userWin).length, JSON.stringify(all))
    if (HEADED) check('焦点还在用户窗口', all.some((t) => t.windowId === userWin && t.focused) && !mine.focused, JSON.stringify(all))
    const second = await tools.get('browser_tabs').execute({ action: 'open', url: url + '?2' }, {})
    const id2 = Number((/标签页 (\d+)/.exec(second.text) || [])[1])
    const all2 = await cb(p.cb, 'tabs')
    const t2 = all2.find((t) => t.id === id2)
    check('再开一页进同一个干活窗口（工具回话里说清楚）', t2 && t2.windowId === mine.windowId && second.text.includes('干活窗口'), second.text)
    const list2 = await tools.get('browser_tabs').execute({ action: 'list' }, {})
    check('列标签页时标出干活窗口（还没加载完的页也列出来）', String(list2.text).includes('（DSH 干活窗口）') && String(list2.text).includes('?2'), String(list2.text).slice(0, 400))
    const shot = await tools.get('browser_screenshot').execute({}, {})   // 不传 tab：接着用刚开的页
    check('干活窗口在后面也能截图（不传 tab 接着用刚开的页）', !!shot && !shot.isError && !/失败|超时/.test(JSON.stringify(shot).slice(0, 300)), JSON.stringify(shot).slice(0, 300))
    await cb(p.cb, 'close', String(opened.tabId))
    await cb(p.cb, 'close', String(id2))
    await sleep(500)
    const again = await cb(p.cb, 'open', url + '?3')
    const all3 = await cb(p.cb, 'tabs')
    const t3 = all3.find((t) => t.id === again.tabId)
    check('干活窗口被关掉后再开一个', again.window === 'agent' && t3 && t3.agentWindow && t3.windowId !== mine.windowId && t3.windowId !== userWin, JSON.stringify(t3))
    const off = await cb(p.cb, 'window', 'off')
    const plain = await cb(p.cb, 'open', url + '?4')
    const all4 = await cb(p.cb, 'tabs')
    const t4 = all4.find((t) => t.id === plain.tabId)
    check('开关关掉：新页回到当前窗口后台', off.ownWindow === false && !plain.window && t4 && !t4.agentWindow && !t4.active, JSON.stringify(t4))
    const on = await cb(p.cb, 'window', 'on')
    check('开关能再打开', on.ownWindow === true, JSON.stringify(on))
    await cb(p.cb, 'close', String(plain.tabId))
  }

  // ⑥ 下载文件、同源 iframe（见 e2e-features.mjs）
  await featureChecks({ check, tools, browserCdp: browser.cdp })
} catch (e) {
  check('没有异常', false, e && e.stack || e)
} finally {
  if (failed().length) dumpLogs(browser ? `── 浏览器 stderr ──\n${browser.log().split('\n').slice(-30).join('\n')}` : '')
  if (browser) await browser.close()
  if (server) server.close()
  if (tmpHome) try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  summary(`浏览器桥真机测试 · ${OS} · ${label}`)
  process.exit(failed().length ? 1 : 0)
}
