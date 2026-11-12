/**
 * Windows / Linux 那几处分支的自测（在 Mac 上也能跑；真注册表、真 Chrome 由 CI 里的 e2e-chrome.mjs 测）：
 *   ① paths()：Windows 用 run.bat、注册文件放宿主旁边；Linux 的注册目录
 *   ② run.bat：CRLF、先关回显再切 UTF-8、Electron 才设 ELECTRON_RUN_AS_NODE、不往 stdout 打字
 *   ③ 读注册表的导出文件（UTF-16，中文路径不乱码）
 *   ④ 假装成 Windows（没有 process.getuid）加载插件：不崩、工具照样注册、宿主没起来时给的是人话
 *   ⑤ 桌面版给宿主复制一份独立 node（不占 DSH 安装目录，issue #3）
 *   ⑥ 换下旧宿主：等它闲下来、结束前再确认一遍，一直忙就留着下次；不占管道的等够请求上限
 *   ⑦ 复用已有的 node 副本时刷新修改时间
 *
 * 跑法：node scratch/test-win.mjs      （不碰真实 HOME）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { paths, winLauncher, parseRegExport, hostNode, restartStaleHosts, hostProbe } from '../plugin/setup.js'

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
check('Linux 注册目录', l.nmDir === path.join('/home/u', '.config/google-chrome/NativeMessagingHosts'), l.nmDir)   // 测试跑在 Windows 上时分隔符是 \
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
check('宿主一退马上 exit /b（cmd 不回头读可能已被改写的 run.bat）', lines.includes('"%N%" "%~dp0host.js" %* & exit /b'), JSON.stringify(bat))
const loud = lines.filter((x) => x && !/^(@echo off|chcp 65001 >nul|setlocal|set |if |"%N%")/.test(x))
check('run.bat 没有会往 stdout 打字的行（stdout 是 native messaging 管道）', loud.length === 0, loud.join(' | '))

// ②b 有独立 node 时先用它，没了再退回 DSH 自己的程序
{
  const b = winLauncher('D:\\DSH\\DeepSeek Harness.exe', true, 'node-v24.21.0.exe')
  const ls = b.split('\r\n')
  const iN = ls.indexOf('set "N=%~dp0node-v24.21.0.exe"')
  check('有独立 node：先用它（按脚本所在目录找，脚本里不写中文路径）', iN > 0, b)
  check('独立 node 没了退回 DSH 的程序', ls[iN + 1] === 'if not exist "%N%" set "N=D:\\DSH\\DeepSeek Harness.exe"', ls[iN + 1])
  check('DSH_BRIDGE_NODE 还能盖过去', ls.indexOf('if defined DSH_BRIDGE_NODE set "N=%DSH_BRIDGE_NODE%"') > iN + 1, b)
  const pct = winLauncher('C:\\Users\\a%b%\\DSH.exe', true, 'node-v1.exe')
  check('路径里的 % 写成 %%（不被当变量展开）', pct.includes('set "N=C:\\Users\\a%%b%%\\DSH.exe"') && pct.includes('"%N%" "%~dp0host.js" %*'), pct)
  check('没有独立 node 时 % 也转义', winLauncher('C:\\50%\\DSH.exe', true).includes('set "N=C:\\50%%\\DSH.exe"'))
}

// ③ 读注册表：reg export 导出的是 UTF-16 文件，中文路径不会变问号
const nm = 'C:\\Users\\张三 的电脑\\.dsh\\chrome-bridge\\com.dsh.bridge.json'
const exported = Buffer.from(`\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dsh.bridge]\r\n@="${nm.replace(/\\/g, '\\\\')}"\r\n\r\n`, 'utf16le')
check('读注册表导出：中文、空格、反斜杠都对', parseRegExport(exported.toString('utf16le')) === nm, parseRegExport(exported.toString('utf16le')))
check('读注册表导出：没有默认值 → null', parseRegExport('Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\x]\r\n"a"="b"\r\n') === null)

// ④ 假装成 Windows 加载插件
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

// ⑤ 复制独立 node 到宿主目录
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-node-'))
  try {
    const dshHome = path.join(t, '.dsh')
    const hostDir = path.join(dshHome, 'chrome-bridge', 'host')
    const rt = path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime')
    const put = (root, ver, body) => {
      fs.mkdirSync(path.join(root, 'dependencies', 'node', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(root, 'dependencies', 'node', 'bin', 'node.exe'), body)
      fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.2', platform: 'win32', node: ver }))
    }
    const exe = path.join(t, 'DSH', 'DeepSeek Harness.exe')
    check('没有独立 node → null（照旧用 DSH 的程序）', hostNode(hostDir, { execPath: exe, dshHome }) === null)

    // 安装目录里的源头
    put(path.join(t, 'DSH', 'resources', 'runtime', 'primary-runtime'), '24.20.0', 'from-install-dir')
    const a = hostNode(hostDir, { execPath: exe, dshHome })
    check('只有安装目录里的源头：复制过来用', a === path.join(hostDir, 'node-v24.20.0.exe') && fs.readFileSync(a, 'utf8') === 'from-install-dir', a)

    // ~/.dsh 里的那份优先；换了版本写新文件、删旧的
    put(rt, '24.21.0', 'node-24.21.0-bytes')
    const b = hostNode(hostDir, { execPath: exe, dshHome })
    check('~/.dsh 里的优先、文件名带版本', b === path.join(hostDir, 'node-v24.21.0.exe') && fs.readFileSync(b, 'utf8') === 'node-24.21.0-bytes', b)
    check('旧版本的副本刚建不到一小时：先留着（另一个 DSH 可能正要用）', fs.existsSync(a), fs.readdirSync(hostDir).join(','))
    hostNode(hostDir, { execPath: exe, dshHome, now: Date.now() + 2 * 3600_000 })
    check('旧版本的副本过了一小时：删掉', !fs.existsSync(a), fs.readdirSync(hostDir).join(','))
    const i1 = fs.statSync(b).ino   // 重新复制是先写临时文件再换名，文件号会变
    const b2 = hostNode(hostDir, { execPath: exe, dshHome })
    check('已经有了：不重复复制', b2 === b && fs.statSync(b).ino === i1)

    // 复制坏了（大小对不上）就重抄
    fs.writeFileSync(b, 'x')
    hostNode(hostDir, { execPath: exe, dshHome })
    check('大小不对：重新复制', fs.readFileSync(b, 'utf8') === 'node-24.21.0-bytes')

    // runtime.json 读不出版本：用文件大小当名字
    fs.writeFileSync(path.join(rt, 'runtime.json'), '{')
    const c = hostNode(hostDir, { execPath: exe, dshHome })
    check('没有版本号：按大小起名', c === path.join(hostDir, `node-${'node-24.21.0-bytes'.length}.exe`), c)
    check('不留临时文件', !fs.readdirSync(hostDir).some((f) => f.endsWith('.tmp')), fs.readdirSync(hostDir).join(','))
    // 别的 DSH 复制到一半的临时文件：新的不动，旧的清掉
    const tmpNew = path.join(hostDir, 'node-v9.9.9.exe.123.tmp')
    fs.writeFileSync(tmpNew, 'half')
    hostNode(hostDir, { execPath: exe, dshHome })
    check('刚建的临时文件不删', fs.existsSync(tmpNew))
    hostNode(hostDir, { execPath: exe, dshHome, now: Date.now() + 2 * 3600_000 })
    check('过了一小时的临时文件删掉', !fs.existsSync(tmpNew))
  } finally {
    fs.rmSync(t, { recursive: true, force: true })
  }
}

// ⑥ 换下旧宿主（列进程、问宿主、结束进程都换成假的）
{
  const hold = setInterval(() => {}, 1000)   // 它的计时器不拖住进程（unref），测试时得自己吊着
  const run = async ({ answers, lists, waitMs = 3000, idleMs = 0 }) => {
    const logs = []
    const killed = []
    const asked = []
    let n = 0
    let doneCalled = false
    await restartStaleHosts('H', 'K', {
      log: (m) => logs.push(m),
      probe: async (h) => { const a = typeof answers === 'function' ? answers(h, asked.length) : answers[Math.min(asked.length, answers.length - 1)]; asked.push(a); return a },
      list: async () => { const l = lists[Math.min(n++, lists.length - 1)]; if (l instanceof Error) throw l; return l },
      kill: async (h) => { killed.push(h.cmd ? `${h.pid}+cmd${h.cmd}` : h.pid); return true },
      done: () => { doneCalled = true },
      pollMs: 10, waitMs, idleMs,
    })
    return { logs, killed, asked: asked.join(','), done: doneCalled }
  }
  const old = { pid: 8900, cmd: 0, created: 1000, exe: 'C:\\DSH\\DeepSeek Harness.exe' }
  let r = await run({ answers: ['idle'], lists: [[old], [{ ...old, cmd: 4242 }]] })
  check('有拉起它的 cmd：按复查时新列出来的那条，连 cmd 一起结束', r.killed.join() === '8900+cmd4242', JSON.stringify(r))
  r = await run({ answers: ['idle'], lists: [[old], [old]] })
  check('它占着管道、闲着：再确认一次就结束，记号清掉', r.killed.join() === '8900' && r.asked === 'idle,idle' && r.done, JSON.stringify(r))
  r = await run({ answers: ['busy', 'busy', 'idle', 'idle'], lists: [[old]] })
  check('忙着：等到闲了再结束', r.killed.join() === '8900' && r.asked === 'busy,busy,idle,idle', JSON.stringify(r))
  r = await run({ answers: ['idle', 'busy', 'busy', 'idle', 'idle'], lists: [[old]] })
  check('第一次闲、复查时又忙了：不结束，接着等', r.killed.join() === '8900' && r.asked === 'idle,busy,busy,idle,idle', JSON.stringify(r))
  {
    const t0 = Date.now()
    r = await run({ answers: (h, i) => (i === 3 ? 'busy' : 'idle'), lists: [[old]], idleMs: 300 })
    const took = Date.now() - t0
    check('闲着也要连续闲够一阵才结束，中间忙过就重新计', r.killed.join() === '8900' && r.asked.includes('busy') && took >= 300 + 1000, JSON.stringify(r).slice(0, 160) + ` ${took}ms`)
  }
  {
    // 闲够了 → 末次复查碰上忙 → 又闲：得重新闲够一阵，不能马上结束
    const t0 = Date.now()
    let phase = 0
    const answers = () => {
      if (phase === 1) { phase = 2; return 'busy' }
      if (phase === 0 && Date.now() - t0 >= 1500) phase = 1
      return 'idle'
    }
    r = await run({ answers, lists: [[old]], idleMs: 1500, waitMs: 9000 })
    const took = Date.now() - t0
    // 重新计：1.5 闲 + 1 复查 + 1.5 重新闲 + 1 复查 ≈ 5 秒；不重新计的话约 3.5 秒
    check('末次复查碰上忙：闲的计时重来', r.killed.join() === '8900' && r.asked.includes('busy') && took >= 4500, JSON.stringify(r).slice(0, 120) + ` ${took}ms`)
  }
  r = await run({ answers: ['idle'], lists: [[{ ...old, hosts: 2 }]] })
  check('几个浏览器都连着宿主：整个不换（结束一个，DSH 的操作可能跑到另一个浏览器）、记号留着', r.killed.length === 0 && !r.done && r.asked === '' && r.logs.some((m) => m.includes('重启')), JSON.stringify(r))
  r = await run({ answers: ['idle'], lists: [[{ ...old, hosts: 1 }], [{ ...old, hosts: 2 }]] })
  check('等的时候又多连上一个浏览器：复查时发现，不结束', r.killed.length === 0 && !r.done, JSON.stringify(r))
  r = await run({ answers: ['busy'], lists: [[old]], waitMs: 200 })
  check('一直忙：不结束、记号留着（下次加载再试）', r.killed.length === 0 && !r.done && r.logs.some((m) => m.includes('下次')), JSON.stringify(r))
  r = await run({ answers: ['foreign'], lists: [[old]] })
  check('不占管道（后台那个浏览器的）：问几次都不是它就不动、记号留着', r.killed.length === 0 && !r.done && r.asked === 'foreign,foreign,foreign', JSON.stringify(r))
  r = await run({ answers: ['foreign', 'idle'], lists: [[old]] })
  check('偶尔问不到一次：不放弃，接着等', r.killed.join() === '8900', JSON.stringify(r))
  r = await run({ answers: ['idle'], lists: [[old], new Error('WMI 坏了')] })
  check('复查列不出进程：不结束（宁可留着）、记号留着', r.killed.length === 0 && !r.done && r.logs.some((m) => m.includes('WMI')), JSON.stringify(r))
  r = await run({ answers: ['idle'], lists: [[old], [{ ...old, created: 2000 }]] })
  check('pid 还在但进程换了（创建时刻不同）：当它已经走了，不乱杀', r.killed.length === 0 && r.done, JSON.stringify(r))
  r = await run({ answers: ['idle'], lists: [[old], []] })
  check('要结束前它自己走了：不乱杀，算换完', r.killed.length === 0 && r.done, JSON.stringify(r))
  r = await run({ answers: ['idle'], lists: [[]] })
  check('没有旧宿主：什么都不做，记号清掉', r.killed.length === 0 && r.asked === '' && r.done, JSON.stringify(r))
  const logs = []
  let d = false
  await restartStaleHosts('H', 'K', { log: (m) => logs.push(m), list: async () => { throw new Error('no powershell') }, done: () => { d = true } })
  check('列不出进程：记一句、不抛、记号留着', logs.some((m) => m.includes('no powershell')) && !d, logs.join())
  clearInterval(hold)
}

// ⑥b 问宿主：是它、没在途的、最近 5 秒没收到扩展的消息才算闲
{
  const h = { pid: 7 }
  const now = Date.now()
  const p = (st) => hostProbe(async () => { if (st instanceof Error) throw st; return st })(h)
  check('问宿主：是它、没活、扩展好一阵没消息 → 闲', await p({ pid: 7, pending: 0, lastExtMsg: now - 60_000 }) === 'idle')
  check('问宿主：有在途的 → 忙', await p({ pid: 7, pending: 1, lastExtMsg: now - 60_000 }) === 'busy')
  check('问宿主：刚收到扩展的回话（可能还在往客户端写）→ 忙', await p({ pid: 7, pending: 0, lastExtMsg: now - 1000 }) === 'busy')
  check('问宿主：占着管道的是别人 → 不是它', await p({ pid: 8, pending: 0, lastExtMsg: 0 }) === 'foreign')
  check('问宿主：问不到 → 不是它', await p(new Error('down')) === 'foreign')
}

// ⑦ 记号：换了 node 写下，换完删掉；没换完下次加载接着换（Windows 才走这条，这里只看 hostNode 复用时刷时间）
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-touch-'))
  try {
    const dshHome = path.join(t, '.dsh')
    const hostDir = path.join(dshHome, 'chrome-bridge', 'host')
    const rt = path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime')
    fs.mkdirSync(path.join(rt, 'dependencies', 'node', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(rt, 'dependencies', 'node', 'bin', 'node.exe'), 'n')
    fs.writeFileSync(path.join(rt, 'runtime.json'), JSON.stringify({ node: '1.0.0' }))
    const exe = path.join(t, 'DSH', 'DeepSeek Harness.exe')
    const a = hostNode(hostDir, { execPath: exe, dshHome })
    const old = new Date(Date.now() - 5 * 3600_000)
    fs.utimesSync(a, old, old)
    hostNode(hostDir, { execPath: exe, dshHome })
    check('接着用已有的副本：刷新修改时间（另一个 DSH 不会当旧副本清掉）', Date.now() - fs.statSync(a).mtimeMs < 60_000)
  } finally {
    fs.rmSync(t, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
