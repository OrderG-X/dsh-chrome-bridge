/**
 * 装进真 DSH 里走一遍（用户真正的用法）：
 *   ① 打包插件，装进一个全新的 DSH（dsh plugin add），启动网页版 —— 插件在 DSH 里加载时自己装好宿主、写好注册
 *   ② 起一个真浏览器，加载扩展，等它按注册拉起宿主
 *   ③ 问 DSH 网页端上插件的设置页接口：插件（在 DSH 进程里）→ 宿主 → 扩展 整条线连上了没有
 *
 *   node scratch/e2e-dsh.mjs [--dsh latest|next|<版本>] [--headed]
 * CI 里用真 HOME 和默认宿主目录；本地跑时 HOME、宿主目录、DSH_HOME 全换成临时的。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WIN, OS, FIXED_EXT_ID, sleep, checker, browserBin, launchBrowser, dumpLogs } from './e2e-lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const DSH_SPEC = argv.includes('--dsh') ? argv[argv.indexOf('--dsh') + 1] : 'latest'
const HEADED = argv.includes('--headed')
const REGISTRY = 'https://registry.npmjs.org/'
const LOCAL = !process.env.CI

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-dsh-')))
if (LOCAL) {
  process.env.HOME = process.env.USERPROFILE = path.join(tmp, 'home')
  process.env.DSH_BRIDGE_DIR = path.join(tmp, 'run')
  fs.mkdirSync(process.env.HOME, { recursive: true })
}
const env = { ...process.env, DSH_HOME: path.join(tmp, 'dsh-home'), npm_config_registry: REGISTRY }
const PATH_KEY = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
env[PATH_KEY] = `${path.join(tmp, 'cli', 'node_modules', '.bin')}${path.delimiter}${env[PATH_KEY]}`
const npm = WIN ? 'npm.cmd' : 'npm'
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', maxBuffer: 64 << 20, shell: WIN && cmd === npm, ...opts })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const { check, failed, summary } = checker()
let web = null
let browser = null
let webLog = ''
let dshVersion = DSH_SPEC

try {
  // ① 打包、装 DSH、装插件、起网页版
  fs.mkdirSync(path.join(tmp, 'cli'), { recursive: true })
  const pack = run(npm, ['pack', '--pack-destination', tmp, '--silent'], { cwd: path.join(ROOT, 'plugin') })
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'))
  if (!check('打包插件', pack.code === 0 && tgz, pack.out.slice(-500))) throw new Error('打包失败')

  fs.writeFileSync(path.join(tmp, 'cli', 'package.json'), '{"private":true}')
  const inst = run(npm, ['i', `@deepseek-ai/dsh@${DSH_SPEC}`, 'pnpm@11', `--registry=${REGISTRY}`, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: path.join(tmp, 'cli') })
  if (!check(`装 DSH ${DSH_SPEC}`, inst.code === 0, inst.out.slice(-1500))) throw new Error('DSH 没装上')
  const cliDir = path.join(tmp, 'cli', 'node_modules', '@deepseek-ai', 'dsh')
  dshVersion = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8')).version
  console.log(`  DSH ${dshVersion}`)

  const add = run(process.execPath, [path.join(cliDir, 'lib', 'bin.js'), 'plugin', '--profile', 'web', 'add', path.join(tmp, tgz)], { cwd: tmp })
  if (!check('DSH 装上插件', add.code === 0, add.out.slice(-1500))) throw new Error('插件没装上')

  const url = await new Promise((resolve) => {
    web = spawn(process.execPath, [path.join(cliDir, 'lib', 'bin.js'), 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'], { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
    const on = (d) => { webLog = (webLog + d).slice(-50000); const m = /dsh web: (http:\/\/\S+)/.exec(webLog); if (m) resolve(m[1]) }
    web.stdout.on('data', on)
    web.stderr.on('data', on)
    web.on('exit', () => resolve(null))
    setTimeout(() => resolve(null), 180_000)
  })
  if (!check('DSH 网页版起来了', url, webLog.slice(-2000))) throw new Error('网页版没起来')

  // 插件在 DSH 里加载时会自己装宿主、写注册：等它写完
  const { paths, installState } = await import(pathToFileURL(path.join(ROOT, 'plugin/setup.js')))
  const p = paths()
  let st = null
  for (let i = 0; i < 30 && !(st && st.hostCopied && st.registered); i++) { await sleep(1000); st = installState() }
  check(`DSH 里的插件装好了宿主和注册${WIN ? '（注册表）' : ''}`, st && st.hostCopied && st.registered && st.extId === FIXED_EXT_ID, JSON.stringify(st && { hostCopied: st.hostCopied, registered: st.registered, extId: st.extId }))
  if (WIN) {
    const bat = fs.readFileSync(p.launcher, 'utf8')
    check('run.bat 用的是 DSH 跑插件的那个 node', bat.includes(process.execPath), bat)
  }

  // ② 真浏览器
  const bin = browserBin('chrome')
  if (!check('找到 Chrome', bin)) throw new Error('没有 Chrome')
  browser = await launchBrowser({ bin, extDir: p.extDir, nmFile: p.nmFile, headed: HEADED })
  console.log(`  ${browser.product}`)
  check('扩展加载进 Chrome', browser.extId === FIXED_EXT_ID, browser.extId)

  // ③ 问 DSH 上插件的设置页接口（带上网页版的登录 cookie）
  const u = new URL(url)
  const first = await fetch(url, { redirect: 'manual' })
  const cookie = (first.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ')
  const token = u.searchParams.get('token')
  let state = null
  let lastErr = ''
  for (let i = 0; i < 60 && !(state && state.connected); i++) {
    await sleep(1000)
    try {
      const r = await fetch(`${u.origin}/dsh-chrome-bridge/panel`, { headers: { ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } })
      const text = await r.text()
      lastErr = `HTTP ${r.status} ${text.slice(0, 200)}`
      if (r.ok) state = JSON.parse(text)
    } catch (e) { lastErr = e.message }
  }
  check('DSH 里的插件 → 宿主 → 扩展 连上了（设置页显示已连接）', state && state.connected, lastErr)
  if (state) {
    check('设置页报的插件版本对', state.plugin === JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/package.json'), 'utf8')).version, state.plugin)
    check('设置页认出的是本地解压版扩展', state.ext && state.ext.id === FIXED_EXT_ID, JSON.stringify(state.ext))
  }
} catch (e) {
  check('没有异常', false, e && e.stack || e)
} finally {
  if (failed().length) dumpLogs(`── DSH 网页版日志 ──\n${webLog.split('\n').slice(-40).join('\n')}${browser ? `\n── 浏览器 stderr ──\n${browser.log().split('\n').slice(-20).join('\n')}` : ''}`)
  if (browser) await browser.close()
  if (web && web.exitCode === null) {
    if (WIN) await new Promise((r) => execFile('taskkill', ['/pid', String(web.pid), '/T', '/F'], () => r()))
    else web.kill('SIGTERM')
  }
  await sleep(1500)
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  summary(`浏览器桥真机测试 · ${OS} · 装进真 DSH ${dshVersion}`)
  process.exit(failed().length ? 1 : 0)
}
