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
 * CHROME_BIN 可指定 Chrome 路径。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
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
if (LOCAL) process.env.DSH_BRIDGE_DIR = path.join(tmpHome, 'run')

const { check, failed, summary } = checker()
let browser = null
let server = null

try {
  // ① 自动安装
  const { ensureInstalled, installState, paths, REG_KEYS, regValue } = await import(pathToFileURL(path.join(ROOT, 'plugin/setup.js')))
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

  // ⑤ 下载文件、同源 iframe（见 e2e-features.mjs）
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
