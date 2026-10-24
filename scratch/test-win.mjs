/**
 * Windows / Linux 那几处分支的自测（在 Mac 上也能跑；真注册表、真 Chrome 由 CI 里的 e2e-chrome.mjs 测）：
 *   ① paths()：Windows 用 run.bat、注册文件放宿主旁边；Linux 的注册目录
 *   ② run.bat：CRLF、先关回显再切 UTF-8、Electron 才设 ELECTRON_RUN_AS_NODE、不往 stdout 打字
 *   ③ 假装成 Windows（没有 process.getuid）加载插件：不崩、工具照样注册、宿主没起来时给的是人话
 *
 * 跑法：node scratch/test-win.mjs      （不碰真实 HOME）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { paths, winLauncher } from '../plugin/setup.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${extra}`}`)
  if (!cond) failures++
}

// ① 路径
const w = paths('C:\\Users\\张三', 'win32')
check('Windows 启动脚本是 run.bat', w.launcher.endsWith('run.bat'), w.launcher)
check('Windows 注册文件放在宿主旁边', w.nmDir === w.bridge, w.nmDir)
check('Windows 的 Chrome 目录', /Google.Chrome.User Data$/.test(w.chromeDir), w.chromeDir)
const l = paths('/home/u', 'linux')
check('Linux 注册目录', l.nmDir === '/home/u/.config/google-chrome/NativeMessagingHosts', l.nmDir)
check('Mac 还是 run.sh', paths('/Users/u', 'darwin').launcher.endsWith('run.sh'))

// ② run.bat
const bat = winLauncher('C:\\Program Files\\DSH\\DSH.exe', true)
const lines = bat.split('\r\n')
check('run.bat 用 CRLF', lines.length > 5 && !lines.some((x) => x.includes('\n')), JSON.stringify(bat))
check('run.bat 先关回显、再切 UTF-8', bat.startsWith('@echo off\r\nchcp 65001 >nul\r\n'))
check('Electron 下设 ELECTRON_RUN_AS_NODE', bat.includes('set ELECTRON_RUN_AS_NODE=1'))
check('纯 node 不设 ELECTRON_RUN_AS_NODE', !winLauncher('C:\\node\\node.exe', false).includes('ELECTRON_RUN_AS_NODE'))
check('run.bat 带上 DSH 自己的 node 路径', bat.includes('set "N=C:\\Program Files\\DSH\\DSH.exe"'))
check('run.bat 跑同目录的 host.js、透传参数', bat.includes('"%N%" "%~dp0host.js" %*'))
const loud = lines.filter((x) => x && !/^(@echo off|chcp 65001 >nul|setlocal|set |if |"%N%")/.test(x))
check('run.bat 没有会往 stdout 打字的行（stdout 是 native messaging 管道）', loud.length === 0, loud.join(' | '))

// ③ 假装成 Windows 加载插件
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-win-'))
try {
  const script = `
    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.getuid
    const m = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'plugin/index.js')).href)})
    const tools = new Map()
    m.apply({ inject() {}, tools: { register: (t) => tools.set(t.name, t) }, on() {}, get() {} }, {})
    let msg = ''
    try { msg = JSON.stringify(await tools.get('browser_tabs').execute({ action: 'list' }, {})) } catch (e) { msg = (e instanceof TypeError ? 'TypeError: ' : '') + e.message }
    console.log(JSON.stringify({ tools: tools.size, msg }))
  `
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'), DSH_BRIDGE_DIR: path.join(fakeHome, 'run') }
  delete env.DSH_BRIDGE_SOCK
  let r = null
  let err = ''
  try {
    r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 30000 }).trim().split('\n').pop())
  } catch (e) { err = (e.stderr || e.message || '').slice(0, 500) }
  check('假 Windows 下插件加载不崩', r !== null, err)
  check('假 Windows 下工具照样注册', r && r.tools > 10, JSON.stringify(r))
  check('宿主没起来时报人话，不是 TypeError', r && r.msg && !r.msg.startsWith('TypeError') && /宿主|Chrome|扩展/.test(r.msg), r && r.msg)
} finally {
  fs.rmSync(fakeHome, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
