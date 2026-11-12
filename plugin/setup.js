/**
 * 一次性安装（自动）：把插件自带的宿主落到稳定目录，并向 Chrome 注册 native messaging host。
 *
 * 为什么要有这个文件：目录收录的判据是「装完能不能直接用」。以前装法是
 *   git clone → ./install.sh（要 python3）→ 再去 Chrome 加载扩展
 * 现在 `dsh plugin add` 一个动作就够了 —— 宿主（原生宿主 + MV3 扩展 + cb + 技能）
 * 都跟着包一起发，插件加载时自动落盘并写好注册文件。
 *
 * 为什么是「落盘一份」而不是直接从 node_modules 里跑：
 *   1. 注册文件里写的是绝对路径，而插件目录会随版本升级换路径，直连会悄悄失效；
 *   2. Chrome 的「加载已解压的扩展程序」只能选一个稳定、可见的目录。
 *   所以固定两个位置（和 install.sh 完全一致）：~/.dsh/chrome-bridge、~/dsh-bridge-extension。
 *
 * 剩下唯一不能自动的一步，是把扩展装进 Chrome：要么点一次「加载已解压的扩展程序」
 * （Chrome 137+ 移除了 --load-extension，非商店扩展没法被脚本装进去），要么从 Chrome 应用商店装
 * （商店版 ID 见 STORE_EXT_IDS，注册文件同时放行两个）。装好的判据只有一个：宿主连得上。
 *
 * 纯 Node，不 import 任何外部包（profile 上下文里解析不到，踩过）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const HOST_NAME = 'com.dsh.bridge'
export const EXT_DIR_NAME = 'dsh-bridge-extension'

/**
 * 商店版扩展 ID（Chrome 应用商店自己分配，跟本地「加载已解压」的 ID 不是一个）。
 * 上架后把 32 位 item ID 填进来，注册文件的 allowed_origins 就会同时放行两个版本。
 */
export const STORE_EXT_IDS = [
  'bippcbbbipppmhjkjomgdnjbooecbimo', // 2026-10-18 建的商店条目，10-19 过审上线
]

/** 商店详情页：没装扩展时最省事的装法（不用开发者模式）。 */
export const STORE_URL = `https://chromewebstore.google.com/detail/${STORE_EXT_IDS[0]}`

/** 插件包里的自带目录（vendor/ 跟着 tgz 一起发）。 */
export function vendorDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor')
}

/** 支持的系统。Windows 的原生宿主注册走注册表，其余两家是固定目录里的 JSON。 */
export const PLATFORMS = ['darwin', 'win32', 'linux']

/** Windows 上 Chrome（和 Edge，它也能装 Chrome 应用商店的扩展）找原生宿主的注册表项 */
export const REG_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
]

/** 所有落盘位置。home、platform 可覆盖，方便测试。 */
export function paths(home = os.homedir(), platform = process.platform) {
  const win = platform === 'win32'
  const bridge = path.join(home, '.dsh/chrome-bridge')
  const extDir = path.join(home, EXT_DIR_NAME)
  const hostDir = path.join(bridge, 'host')
  const chromeDir = win
    ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
    : platform === 'linux'
      ? path.join(home, '.config/google-chrome')
      : path.join(home, 'Library/Application Support/Google/Chrome')
  // Windows 的注册文件放哪都行（注册表指过去），就放在宿主旁边
  const nmDir = win ? bridge : path.join(chromeDir, 'NativeMessagingHosts')
  return {
    home,
    bridge,
    hostDir,
    // Chrome 拉起宿主用的脚本：装的时候现写（Windows run.bat，其余 run.sh），写进 DSH 自己的 node
    launcher: path.join(hostDir, win ? 'run.bat' : 'run.sh'),
    extDir,
    chromeDir,
    nmDir,
    nmFile: path.join(nmDir, `${HOST_NAME}.json`),
    cb: path.join(home, '.dsh/bin/cb'),
    cbLink: path.join(home, '.local/bin/cb'),
    cursorFile: path.join(home, '.dsh/chrome-cursor/in-page-cursor.js'),
    skillFile: path.join(home, '.dsh/skills/browser/SKILL.md'),
    stampFile: path.join(bridge, '.vendor-stamp'),
  }
}

/**
 * 扩展 ID：由 manifest.json 里的公钥（key）推导，每台机器都一样。
 * 算法与 Chrome / install.sh 一致：sha256(DER) 前 16 字节 → 每个 nibble 映射成 a..p。
 * 这里用 Node 算，所以不再需要 python3。
 */
export function extensionId(manifestFile) {
  const key = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).key
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

function copyFile(src, dest, mode) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  if (mode) fs.chmodSync(dest, mode)
}

/** vendor 树的内容指纹：内容没变就整段跳过，插件每次启动都调它也不会抖动。 */
function vendorStamp(dir) {
  const hash = crypto.createHash('sha256')
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name)
      const r = path.join(rel, name)
      const st = fs.statSync(abs)
      if (st.isDirectory()) walk(abs, r)
      else hash.update(`${r}\0${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}\0`)
    }
  }
  walk(dir, '')
  return hash.digest('hex')
}

/** 落盘目录里文件还都在吗（用户可能手动删过）：缺了就算指纹没变也要重拷 */
function allPresent(src, dest) {
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name)
    const d = path.join(dest, name)
    if (fs.statSync(s).isDirectory() ? !allPresent(s, d) : !fs.existsSync(d)) return false
  }
  return true
}

/**
 * Chrome 里有没有装商店版扩展：商店扩展落在 <profile>/Extensions/<id>/<版本>_0/，
 * 「加载已解压」的不在这里（只记在 Preferences 里）。只用来挑报错文案 —— 装没装好，
 * 最终还是看宿主连不连得上。返回 { id, profile, version } 或 null；读不到就当没装。
 */
export function storeExtension(home = os.homedir()) {
  const { chromeDir } = paths(home)
  let profiles = []
  try { profiles = fs.readdirSync(chromeDir).filter((n) => n === 'Default' || /^Profile \d+$/.test(n)) } catch {}
  for (const profile of profiles) {
    for (const id of STORE_EXT_IDS) {
      try {
        const vers = fs.readdirSync(path.join(chromeDir, profile, 'Extensions', id)).filter((v) => !v.startsWith('.'))
        if (vers.length) return { id, profile, version: vers.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop().replace(/_\d+$/, '') }
      } catch {}
    }
  }
  return null
}

/**
 * Windows 注册表里某一项的默认值；读不到回 null。
 * 用 reg export 导出成 UTF-16 文件再读：reg query 的输出按控制台代码页编码，DSH 桌面版里没有控制台，中文路径会变成问号。
 */
export function regValue(key) {
  const file = path.join(os.tmpdir(), `dsh-bridge-reg-${process.pid}.reg`)
  try {
    execFileSync('reg', ['export', key, file, '/y'], { stdio: 'ignore', windowsHide: true })
    return parseRegExport(fs.readFileSync(file, 'utf16le'))
  } catch { return null } finally {
    try { fs.rmSync(file, { force: true }) } catch {}
  }
}

/** reg export 导出的文本里取默认值（@="…"，反斜杠和引号是转义过的） */
export function parseRegExport(text) {
  const m = /^@="((?:[^"\\]|\\.)*)"/m.exec(text)
  return m ? m[1].replace(/\\(.)/g, '$1') : null
}

/** 批处理里原样写路径：% 要写成 %%，不然会被当成变量展开（引号挡不住） */
const bat = (s) => String(s).replace(/%/g, '%%')

/**
 * Windows 的宿主启动脚本。Chrome 用 cmd 跑它，stdout 就是 native messaging 管道，所以脚本自己一个字都不能往外打。
 * node 先用 primary（桌面版：复制到宿主目录、和这个脚本放一起的那份独立 node，只给文件名，见 hostNode），
 * 没有再用 DSH 自己的程序（桌面版是 Electron，要 ELECTRON_RUN_AS_NODE；对真 node 这个变量没影响），都没了再找 PATH 里的。
 * primary 用 %~dp0 拼：用户目录带中文时，脚本里直接写中文路径 cmd 会读错（CI 实测），%~dp0 是 cmd 自己算的，不会错。
 * DSH 升级换了路径，插件下次加载会重写这个文件。路径可能带中文，先把代码页切到 UTF-8 再读后面的行。
 */
export function winLauncher(execPath = process.execPath, electron = Boolean(process.versions.electron), primary = null) {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    ...(electron ? ['set ELECTRON_RUN_AS_NODE=1'] : []),
    ...(primary ? [`set "N=%~dp0${primary}"`, `if not exist "%N%" set "N=${bat(execPath)}"`] : [`set "N=${bat(execPath)}"`]),
    'if defined DSH_BRIDGE_NODE set "N=%DSH_BRIDGE_NODE%"',
    'if not exist "%N%" for %%I in (node.exe) do set "N=%%~$PATH:I"',
    // 宿主退出后马上 exit /b：cmd 不再回头读这个文件（文件可能已被改写，见 restartStaleHosts）
    '"%N%" "%~dp0host.js" %* & exit /b',
    '',
  ].join('\r\n')
}

/**
 * Windows 桌面版：给宿主复制一份独立的 node，放在宿主目录里（issue #3）。
 * 宿主由 Chrome 拉起、一直开着；用 DSH 安装目录里的 DeepSeek Harness.exe 跑的话，它会一直占着安装目录，
 * DSH 升级要把整个目录换名，就会失败（Windows 错误 32），安装器悄悄回滚。
 * DSH 自带一份独立的 node（primary runtime：~/.dsh/dsh-runtimes 里一份，安装目录 resources/runtime 里是源头），
 * 复制过来用，只占我们自己的目录。不直接用 ~/.dsh/dsh-runtimes 里那份：DSH 换新 runtime 时也要给那个目录换名。
 * 文件名带 node 版本：换版本写新文件，旧的删得掉就删（正在跑的删不掉，下次再删）。
 * 找不到、复制失败都返回 null，照旧用 DSH 的程序。
 */
export function hostNode(hostDir, { execPath = process.execPath, dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), now = Date.now() } = {}) {
  const roots = [
    path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime'),
    path.join(path.dirname(execPath), 'resources', 'runtime', 'primary-runtime'),
  ]
  for (const root of roots) {
    const src = path.join(root, 'dependencies', 'node', 'bin', 'node.exe')
    let st
    try { st = fs.statSync(src) } catch { continue }
    if (!st.isFile() || st.size === 0) continue
    let ver = ''
    try { const m = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8')); ver = String((m.components || m).node || '') } catch {}
    const name = `node-${/^[\w.+-]+$/.test(ver) ? `v${ver}` : st.size}.exe`
    const dest = path.join(hostDir, name)
    let have = null
    try { have = fs.statSync(dest) } catch {}
    // 接着用已有的副本：刷一下修改时间，免得另一个 DSH 按「一小时前的旧副本」把它清掉
    if (have && have.size === st.size) { try { fs.utimesSync(dest, new Date(now), new Date(now)) } catch {} }
    if (!have || have.size !== st.size) {
      const tmp = `${dest}.${process.pid}.tmp`
      try {
        fs.mkdirSync(hostDir, { recursive: true })
        fs.copyFileSync(src, tmp)
        fs.renameSync(tmp, dest)
      } catch {
        try { fs.rmSync(tmp, { force: true }) } catch {}
        continue
      }
    }
    // 旧版本的副本、没挪成的临时文件：一小时内没建过也没用过的才删（同时起来的另一个 DSH 可能刚复制好或刚用上、还没写启动脚本）
    // Windows 复制文件会带上源文件的修改时间，所以创建时间和修改时间取晚的那个
    try {
      for (const f of fs.readdirSync(hostDir)) {
        if (f === name || !/^node-[\w.+-]+\.exe(\.\d+\.tmp)?$/.test(f)) continue
        const abs = path.join(hostDir, f)
        try { const fst = fs.statSync(abs); if (now - Math.max(fst.birthtimeMs, fst.mtimeMs) > 3600_000) fs.rmSync(abs) } catch {}
      }
    } catch {}
    return dest
  }
  return null
}

/**
 * Windows：列出还在用别的程序跑着的宿主 [{ pid, cmd, created, exe }]。认得严：命令行里得有我们的 host.js（长路径或 8.3 短路径）
 * 和 Chrome 传给原生宿主的 chrome-extension:// 参数（记事本开着 host.js 不算），程序不是 keep（长短路径都比），
 * 也不是宿主目录里我们自己复制的 node（换了 node 版本时旧副本上的宿主不占 DSH 安装目录，不用去动它）。
 * cmd：拉起它的那个正在跑 run.bat 的 cmd.exe 的 pid（没有就是 0），见 restartStaleHosts 为什么要连它一起结束。
 * created：进程创建时刻（毫秒），复查时和 pid 一起认「还是不是那个进程」。
 * hosts：浏览器拉起的我们的宿主一共几个（新旧都算）——不止一个就是几个浏览器 / 用户都连着，见 restartStaleHosts。
 * 查询出任何错（WMI 坏了之类）都当失败抛出，不能当成「没有旧宿主」。
 */
export function listStaleHosts(hostDir, keep) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$fso = $null; try { $fso = New-Object -ComObject Scripting.FileSystemObject } catch {}',
    'function Short($p) { if (-not $fso) { return $null }; try { $fso.GetFile($p).ShortPath } catch { $null } }',
    '$h = $env:DSH_BRIDGE_HOSTJS; $hs = Short $h',
    '$b = $env:DSH_BRIDGE_RUNBAT; $bs = Short $b',
    '$k = $env:DSH_BRIDGE_KEEP; $ks = Short $k',
    '$d = $env:DSH_BRIDGE_HOSTDIR + [IO.Path]::DirectorySeparatorChar; $ds = $null; if ($fso) { try { $ds = $fso.GetFolder($env:DSH_BRIDGE_HOSTDIR).ShortPath + [IO.Path]::DirectorySeparatorChar } catch {} }',
    '$ic = [StringComparison]::OrdinalIgnoreCase',
    'function Has($s, $x) { $x -and $s.IndexOf($x, $ic) -ge 0 }',
    '$all = @(Get-CimInstance Win32_Process)',
    '$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }',
    '$mine = @($all | Where-Object { $_.CommandLine -and (Has $_.CommandLine \'chrome-extension://\') -and ((Has $_.CommandLine $h) -or (Has $_.CommandLine $hs)) })',
    "'OK'",
    '"HOSTS`t$($mine.Count)"',
    'foreach ($p in $mine) {',
    '  $c = $p.CommandLine; $e = $p.ExecutablePath',
    '  if (-not $e) { continue }',
    '  if ([string]::Equals($e, $k, $ic) -or ($ks -and [string]::Equals($e, $ks, $ic))) { continue }',
    '  if ($e.StartsWith($d, $ic) -or ($ds -and $e.StartsWith($ds, $ic))) { continue }',
    '  $par = $byId[[int]$p.ParentProcessId]; $cmd = 0',
    "  if ($par -and $par.Name -ieq 'cmd.exe' -and $par.CommandLine -and ((Has $par.CommandLine $b) -or (Has $par.CommandLine $bs))) { $cmd = $par.ProcessId }",
    '  $t = 0; if ($p.CreationDate) { $t = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }',
    '  "$($p.ProcessId)`t$cmd`t$t`t$e"',
    '}',
  ].join('\n')
  const env = { ...process.env, DSH_BRIDGE_HOSTJS: path.join(hostDir, 'host.js'), DSH_BRIDGE_RUNBAT: path.join(hostDir, 'run.bat'), DSH_BRIDGE_HOSTDIR: hostDir, DSH_BRIDGE_KEEP: keep }
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env, windowsHide: true, timeout: 60000, encoding: 'utf8' }, (err, stdout) => {
        if (err) return reject(err)
        const lines = String(stdout).split(/\r?\n/).map((l) => l.trim())
        // 查询本身跑完了才会先打 OK：没有这行就是半路出错了
        const total = (/^HOSTS\t(\d+)$/m.exec(lines.join('\n')) || [])[1]
        if (!lines.includes('OK') || total === undefined) return reject(new Error('列进程没有跑完'))
        resolve(lines.map((l) => l.split('\t'))
          .filter(([pid, cmd, t]) => /^\d+$/.test(pid) && /^\d+$/.test(cmd || '') && /^\d+$/.test(t || ''))
          .map(([pid, cmd, t, exe]) => ({ pid: Number(pid), cmd: Number(cmd), created: Number(t), hosts: Number(total), exe })))
      })
  })
}

/** 结束旧宿主：有拉起它的 cmd 就连 cmd 带它一起结束（/T），没有就只结束它 */
function killHost({ pid, cmd }) {
  const args = cmd ? ['/pid', String(cmd), '/T', '/F'] : ['/pid', String(pid), '/F']
  return new Promise((r) => execFile('taskkill', args, { windowsHide: true, timeout: 15000 }, (e) => r(!e)))
}

/**
 * 问占着管道的宿主（DSH 和 cb 只连它）现在能不能换掉旧宿主 h：
 *   'idle'    就是它，手上没有在途的操作，而且最近 5 秒没收到扩展的消息——扩展的回话一到它就开始往客户端写，
 *             老宿主的 status 不报「还在写」，所以等最后一条回话过去 5 秒（本机管道上早写完了）；
 *   'busy'    就是它，但有在途的操作、或刚收到扩展的消息；
 *   'foreign' 不是它，或者问不到。
 * getStatus：问宿主 status 的函数（插件里悄悄问，e2e 里用 cb）。
 */
export function hostProbe(getStatus, { extQuietMs = 5000 } = {}) {
  return async (h) => {
    let st = null
    try { st = await getStatus() } catch {}
    if (!st || st.pid !== h.pid) return 'foreign'
    if (st.pending > 0 || Date.now() - (Number(st.lastExtMsg) || 0) < extQuietMs) return 'busy'
    return 'idle'
  }
}

/**
 * Windows：启动脚本换了 node 之后，把还在用别的程序跑着的宿主换下来（比如老版本用 DSH 安装目录里的程序拉起的）。
 * 不换的话它要等 Chrome 完全退出才会走，这期间照样占着 DSH 安装目录。结束掉之后扩展马上重连，Chrome 按新脚本拉起新宿主。
 *
 * 别的 DSH / cb 可能正通过它操作浏览器，老宿主在 Windows 上又不会自己排空退出，只能从外面结束，所以只换「占着管道、闲着」的：
 * probe（见 hostProbe）连续答 'idle' 够 idleMs，再列一遍进程确认它还在（pid 和创建时刻都对得上），隔一秒再问一次还闲，马上结束。
 * 答案一变计时重来（末次复查也算）。几个旧宿主同时等，互不耽误。
 * 浏览器拉起的宿主不止一个（Chrome 和 Edge / 两个 Chrome 用户都装了扩展）就整个不换：结束哪个都可能让另一个接过管道
 * （被结束的重连后变成最新的那个，或者后台那个在空档里按自愈逻辑把 token 改成自己的），DSH 接下来的操作就跑到另一个浏览器去了。
 * 这种只能等用户重启浏览器；记号留着，下次加载只剩一个时再换。问不到 / 不是它（'foreign'）连着几次也放弃这次。
 * 有没换下的就不调 done：记号留着，下次加载再试。
 * 连拉起它的 cmd 一起结束：cmd 跑批处理是一行一行现读的，宿主一退它会按原来的位置接着读 run.bat——
 * 而 run.bat 刚被我们改写过，接着读到的正是新脚本里拉宿主的那行，变量还是旧的，于是又用 DSH 的程序拉起一个宿主，
 * 还接在 Chrome 原来那条管道上（CI 实测）。cmd 一走管道就断了，扩展重连，Chrome 按新脚本拉起新宿主。
 * 剩下的风险：「最后一次问还闲」和「结束」之间几十毫秒里正好进来的操作、或者一个卡住 5 秒以上不读回话的客户端，会断掉
 * （客户端看到连接被关）。只在第一次换宿主时有这么一下，老宿主没有别的办法让它排空。
 */
export async function restartStaleHosts(hostDir, keep, {
  log = () => {}, probe = async () => 'foreign', list = listStaleHosts, kill = killHost,
  done = () => {}, waitMs = 15 * 60_000, idleMs = 5000, pollMs = 2000, foreignTries = 3,
} = {}) {
  // 计时器不拖住进程：DSH 命令行这类很快就退出的场合，等不完就算了（记号还在，下次再来）
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })
  let stale
  try { stale = await list(hostDir, keep) } catch (e) { return log(`查旧宿主失败：${e.message}`) }
  const multi = (h) => `有 ${h.hosts} 个浏览器（或用户）连着宿主，这次不换旧宿主：结束一个的空档里另一个可能接过管道，`
    + 'DSH 的操作就跑到别的浏览器去了。把浏览器都重启一次就好'
  if (stale.some((h) => h.hosts > 1)) return log(multi(stale.find((h) => h.hosts > 1)))

  const one = async (host) => {
    const { pid, exe } = host
    const until = Date.now() + waitMs
    let idleSince = null
    let foreign = 0
    const ask = async () => {
      const st = await probe(host)
      idleSince = st === 'idle' ? (idleSince ?? Date.now()) : null
      foreign = st === 'foreign' ? foreign + 1 : 0
      return st
    }
    const ready = () => idleSince !== null && Date.now() - idleSince >= idleMs
    while (Date.now() < until) {
      await ask()
      if (foreign >= foreignTries) { log(`问不到旧宿主 ${pid}，这次不动它（${exe}），下次加载再看`); return false }
      if (ready()) {
        // 慢的（PowerShell 列进程）放在前面，最后一次问和结束之间不夹别的
        let fresh
        try { fresh = (await list(hostDir, keep)).find((h) => h.pid === pid && h.created === host.created) } catch (e) {
          log(`复查旧宿主 ${pid} 失败，这次不结束：${e.message}`)
          return false
        }
        if (!fresh) return true   // 自己走了
        if (fresh.hosts > 1) { log(multi(fresh)); return false }
        await sleep(1000)
        if (await ask() === 'idle' && ready()) {
          const ok = await kill(fresh)
          log(ok ? `换下了还在用旧程序跑的宿主 ${pid}（${exe}）` : `结束旧宿主 ${pid} 失败（${exe}）`)
          return ok
        }
      }
      await sleep(pollMs)
    }
    log(`旧宿主 ${pid} 一直没空，这次不换（${exe}），下次加载再试`)
    return false
  }

  const results = await Promise.all(stale.map((h) => one(h).catch((e) => { log(`换旧宿主 ${h.pid} 出错：${e.message}`); return false })))
  if (results.every(Boolean)) done()
}

/** 单引号包起来给 sh 用（路径里的单引号拆开转义） */
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * macOS / Linux 的宿主启动脚本。Chrome 拉起宿主时 PATH 很干净：nvm / fnm / volta / asdf / mise 装的 node 都不在里面，
 * 只按固定路径找的话这些用户一装就连不上（issue #2）。所以和 Windows 一样，先用装的时候 DSH 自己的 node
 * （桌面版是 Electron，要 ELECTRON_RUN_AS_NODE）；DSH 升级换了路径，插件下次加载会重写这个文件。
 * 那个 node 没了再按固定路径和常见的版本管理器目录找；都找不到就把原因写进 launch-error.txt，DSH 报错时读出来给人看
 * （Chrome 那边只知道「断开了」，stderr 谁也看不到）。
 */
export function unixLauncher(execPath = process.execPath, electron = Boolean(process.versions.electron)) {
  return [
    '#!/bin/sh',
    '# Chrome 通过这个脚本拉起原生宿主。浏览器桥插件装的时候现写的，别手改（DSH 下次加载会重写）。',
    '',
    'HERE="$(cd "$(dirname "$0")" && pwd)"',
    'ERR="$HERE/launch-error.txt"',
    `DSH_NODE=${shQuote(execPath)}`,
    'go() { N="$1"; shift; rm -f "$ERR"; exec "$N" "$HERE/host.js" "$@"; }',
    '',
    'if [ -n "$DSH_BRIDGE_NODE" ] && [ -x "$DSH_BRIDGE_NODE" ]; then go "$DSH_BRIDGE_NODE" "$@"; fi',
    `if [ -x "$DSH_NODE" ]; then ${electron ? 'export ELECTRON_RUN_AS_NODE=1; ' : ''}go "$DSH_NODE" "$@"; fi`,
    '',
    'for N in /usr/local/bin/node "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/bin/node \\',
    '  "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node" "$HOME/.local/share/mise/shims/node"; do',
    '  if [ -x "$N" ]; then go "$N" "$@"; fi',
    'done',
    'for N in "$HOME"/.nvm/versions/node/*/bin/node; do',
    '  if [ -x "$N" ]; then LAST="$N"; fi',
    'done',
    'if [ -n "$LAST" ]; then go "$LAST" "$@"; fi',
    'N="$(command -v node 2>/dev/null)"',
    'if [ -n "$N" ]; then go "$N" "$@"; fi',
    '',
    'MSG="找不到可用的 node：装插件时 DSH 用的 $DSH_NODE 已经不在了，常见位置也都没有。重启一次 DSH 会按它现在用的 node 重写启动脚本。"',
    'echo "$MSG" > "$ERR" 2>/dev/null',
    'echo "dsh-bridge: $MSG" >&2',
    'exit 1',
    '',
  ].join('\n')
}

/** 装好了没有（只看落盘结果，不管 Chrome 有没有加载扩展）。 */
export function installState(home = os.homedir()) {
  const p = paths(home)
  let extId = null
  try { extId = extensionId(path.join(p.extDir, 'manifest.json')) } catch {}
  return {
    ...p,
    extId,
    extensionCopied: !!extId,
    hostCopied: fs.existsSync(p.launcher),
    registered: fs.existsSync(p.nmFile) && (process.platform !== 'win32' || regValue(REG_KEYS[0]) !== null),
    vendor: fs.existsSync(vendorDir()),
    store: storeExtension(home),
  }
}

/**
 * 幂等安装。返回 { ok, changed, ... }；出错不抛（调用方是插件加载路径，绝不能拖垮 DSH）。
 *
 * 做四件事：
 *   1. 扩展 → ~/dsh-bridge-extension（Chrome「加载已解压」要选它，所以必须可见、稳定）
 *   2. 原生宿主 → ~/.dsh/chrome-bridge/host/（注册文件指向这里）
 *   3. 写注册文件 NativeMessagingHosts/com.dsh.bridge.json（allowed_origins 绑定固定扩展 ID）
 *   4. 顺带落一个 cb CLI + 页内光标脚本（可选，失败不影响主流程；不碰 ~/.dsh/skills）
 */
export function ensureInstalled(options = {}) {
  const home = options.home || os.homedir()
  const vendor = options.vendor || vendorDir()
  const p = paths(home)
  const out = { ok: false, changed: false, home, vendor, ...p }

  const win = process.platform === 'win32'
  try {
    if (!PLATFORMS.includes(process.platform)) {
      return { ...out, reason: `浏览器桥暂不支持 ${process.platform}（只支持 macOS、Windows、Linux）` }
    }
    const vExt = path.join(vendor, 'extension')
    const vHost = path.join(vendor, 'host')
    if (!fs.existsSync(path.join(vExt, 'manifest.json')) || !fs.existsSync(path.join(vHost, 'host.js'))) {
      return { ...out, reason: `插件包里没有自带宿主（${vendor}），请用 release tarball 安装` }
    }

    const extId = extensionId(path.join(vExt, 'manifest.json'))
    const stamp = vendorStamp(vendor)
    let prev = null
    try { prev = fs.readFileSync(p.stampFile, 'utf8').trim() } catch {}

    const nmBody = `${JSON.stringify({
      name: HOST_NAME,
      description: 'dsh-chrome-bridge native host (local browser control)',
      path: p.launcher,
      type: 'stdio',
      allowed_origins: [extId, ...STORE_EXT_IDS].map((id) => `chrome-extension://${id}/`),
    }, null, 2)}\n`

    let nmPrev = null
    try { nmPrev = fs.readFileSync(p.nmFile, 'utf8') } catch {}
    // 桌面版（Electron）在 Windows 上：宿主改用复制到宿主目录的独立 node，别占着 DSH 安装目录（issue #3）
    const primary = win && process.versions.electron ? hostNode(p.hostDir) : null
    const launcherBody = win ? winLauncher(process.execPath, Boolean(process.versions.electron), primary && path.basename(primary)) : unixLauncher()
    let launcherPrev = null
    try { launcherPrev = fs.readFileSync(p.launcher, 'utf8') } catch {}
    const restartMark = path.join(p.hostDir, 'restart-hosts.pending')
    const regOk = !win || REG_KEYS.every((k) => regValue(k) === p.nmFile)
    const upToDate = prev === stamp && nmPrev === nmBody && launcherPrev === launcherBody && regOk
      && allPresent(vExt, p.extDir) && allPresent(vHost, p.hostDir)
    if (!upToDate) {
      fs.mkdirSync(p.extDir, { recursive: true })
      fs.cpSync(vExt, p.extDir, { recursive: true, force: true })
      fs.mkdirSync(p.hostDir, { recursive: true })
      fs.cpSync(vHost, p.hostDir, { recursive: true, force: true })
      // 换了 node：先记一笔「还有旧宿主要换」再写启动脚本（后面哪步失败了，下次加载也还记得要换），换完才删
      if (primary && launcherPrev !== launcherBody) fs.writeFileSync(restartMark, `${primary}\n`)
      fs.writeFileSync(p.launcher, launcherBody)
      if (!win) fs.chmodSync(p.launcher, 0o755)
      fs.rmSync(path.join(p.hostDir, 'launch-error.txt'), { force: true })   // 上回拉不起来的原因：脚本重写了就作废
      fs.mkdirSync(p.nmDir, { recursive: true })
      fs.writeFileSync(p.nmFile, nmBody)
      if (win) {
        for (const k of REG_KEYS) {
          execFileSync('reg', ['add', k, '/ve', '/t', 'REG_SZ', '/d', p.nmFile, '/f'], { stdio: 'ignore', windowsHide: true })
        }
      }
      fs.writeFileSync(p.stampFile, `${stamp}\n`)
      out.changed = true
    }
    if (primary && fs.existsSync(restartMark)) {
      restartStaleHosts(p.hostDir, primary, {
        log: options.log || undefined, probe: options.probe,
        done: () => { try { fs.rmSync(restartMark, { force: true }) } catch {} },
      }).catch((e) => options.log && options.log(`换旧宿主出错：${e.message}`))
    }

    // ── 可选件：cb CLI、页内光标脚本 —— 失败只是少个便利，不该让安装失败 ──
    // 刻意不动 ~/.dsh/skills：那是全局 agent 行为，装了插件就有原生 browser_* 工具，不需要它。
    try {
      copyFile(path.join(vendor, 'cb'), p.cb, win ? undefined : 0o755)
      if (win) {
        // Windows 没有 shebang：旁边放个 cb.cmd（用 PATH 里的 node），也不去建 ~/.local/bin 的软链接
        fs.writeFileSync(`${p.cb}.cmd`, '@echo off\r\nnode "%~dp0cb" %*\r\n')
      } else {
        fs.mkdirSync(path.dirname(p.cbLink), { recursive: true })
        // ~/.local/bin/cb 可能是用户自己的另一个 cb：只在还没有时建链接；指向我们的链接本来就对，
        // 别的东西（用户自己的文件 / 指向别处的链接）一律不碰
        let cur = null
        try { cur = fs.lstatSync(p.cbLink) } catch {}
        if (!cur) fs.symlinkSync(p.cb, p.cbLink)
      }
    } catch {}
    try {
      copyFile(path.join(vendor, 'in-page-cursor.js'), p.cursorFile)
    } catch {}

    return { ...out, ok: true, changed: out.changed, extId, nmFile: p.nmFile }
  } catch (e) {
    return { ...out, reason: (e && e.message) || String(e) }
  }
}

/**
 * 出错时给模型/用户看的话（只在宿主连不上时才会走到这里）。宿主和注册已经自动装好了，
 * 所以只剩 Chrome 那一下 —— 那一下谁都替不了（Chrome 137+ 移除了 --load-extension），
 * 那就把它铺到用户手边：路径给全、⌘⇧G 粘贴的走法写清楚。
 * 已经从商店装了扩展的，就别再让人去「加载已解压」，改成查启用 / 重启 Chrome。
 */
export function installHint(home = os.homedir()) {
  const s = installState(home)
  if (!s.vendor) return '插件包里没有自带宿主：请重新用 release tarball 安装本插件（README 的 Install 一节）。'
  if (!PLATFORMS.includes(process.platform)) {
    return `浏览器桥暂不支持 ${process.platform}（只支持 macOS、Windows、Linux）。`
  }
  if (!s.hostCopied || !s.registered) {
    return [
      '宿主或 native messaging 注册没写成功（多半是权限问题）：',
      `宿主目录 ${s.hostDir}${s.hostCopied ? ' ✅' : ' ❌'}`,
      `注册${process.platform === 'win32' ? '（注册表 + 文件）' : '文件'} ${s.nmFile}${s.registered ? ' ✅' : ' ❌'}`,
      '重启一次 DSH 会再试一遍；还不行就在 GitHub 提 issue。',
    ].join('\n')
  }
  let launchErr = ''
  try { launchErr = fs.readFileSync(path.join(s.hostDir, 'launch-error.txt'), 'utf8').trim() } catch {}
  if (launchErr) return `Chrome 拉起宿主失败：${launchErr}\n重启 DSH 之后，完全退出 Chrome 再打开一次。`
  if (s.store) {
    return [
      `扩展已经从 Chrome 应用商店装好了（DSH Bridge ${s.store.version}），但宿主没连上：`,
      '1. 确认 Chrome 开着',
      '2. chrome://extensions 里 DSH Bridge 是启用状态',
      '3. 还不行就完全退出 Chrome 再打开一次',
      '不用再「加载已解压」；宿主和 native 注册已经自动装好了。',
    ].join('\n')
  }
  return [
    '浏览器桥还差最后一步（一次性），两种装法选一个：',
    '· 最省事：从 Chrome 应用商店装 DSH Bridge（不用开发者模式）：',
    `  ${STORE_URL}`,
    '· 或者加载已解压的扩展：',
    '  1. Chrome 打开 chrome://extensions',
    '  2. 右上角打开「开发者模式」',
    `  3. 点「加载已解压的扩展程序」，${PASTE_TIP[process.platform] || PASTE_TIP.darwin}，选这个文件夹：`,
    `     ${s.extDir}`,
    '装好后回到这里重试；宿主和 native 注册已经自动装好了，不用再跑任何脚本。',
  ].join('\n')
}

/** 文件框里怎么直接粘路径 */
const PASTE_TIP = {
  darwin: '在文件框里按 ⌘⇧G、粘贴、回车',
  win32: '把路径粘进文件框顶上的地址栏、回车',
  linux: '在文件框里按 Ctrl+L、粘贴、回车',
}

/** Chrome 在不在跑（决定要不要顺手把设置页打开）。 */
function chromeRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
      return /chrome\.exe/i.test(out)
    }
    execFileSync('/usr/bin/pgrep', ['-x', process.platform === 'linux' ? 'chrome' : 'Google Chrome'], { stdio: 'ignore' })
    return true
  } catch { return false }
}

/** Windows / Linux 上 Chrome 的可执行文件（打开网址用）；找不到回 null */
function chromeBin() {
  const c = process.platform === 'win32'
    ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
      .map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
  return c.find((f) => fs.existsSync(f)) || null
}

/** 用 Chrome 打开一个网址（macOS 可以不抢前台） */
function openInChrome(url, { background = false } = {}) {
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/open', [...(background ? ['-g'] : []), '-a', 'Google Chrome', url])
    return
  }
  const bin = chromeBin()
  if (!bin) throw new Error('找不到 Chrome')
  spawn(bin, [url], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
}

/**
 * 引导式安装：那一下点选替不了，但可以把用户送到那一下面前 ——
 *   · 扩展目录塞进剪贴板：文件框里 ⌘⇧G ⌘V 回车就到，不用手点目录树
 *     （已经从商店装了就不塞：用不上解压目录，别白占用户剪贴板）
 *   · Chrome 在跑的话，顺手把 chrome://extensions 用后台标签页打开（不抢前台）
 * 只在「宿主连不上」时调用，且每个进程只做一次（见 index.js 的 firstAid）。
 *
 * viaStore：设置页上用户点了「去商店装」—— 在 Chrome 前台打开商店页（Chrome 没开也会拉起来），不碰剪贴板。
 */
export function assistInstall(home = os.homedir(), { viaStore = false } = {}) {
  const p = paths(home)
  const store = storeExtension(home)
  const out = { clipboard: false, opened: false, chromeRunning: chromeRunning(), store: !!store }
  if (viaStore) {
    try {
      openInChrome(STORE_URL)
      out.opened = true
    } catch {}
    return out
  }
  // 剪贴板：macOS 用 pbcopy，Windows 用 clip（Linux 不一定有 xclip，就不塞了）
  if (!store && process.platform !== 'linux') {
    try {
      if (process.platform === 'win32') execFileSync('clip', [], { input: p.extDir, windowsHide: true })
      else execFileSync('/usr/bin/pbcopy', [], { input: `${p.extDir}\n` })
      out.clipboard = true
    } catch {}
  }
  // 只有 macOS 能在后台开标签页；别的系统会把 Chrome 拉到前台，就不主动开了
  if (out.chromeRunning && process.platform === 'darwin') {
    try {
      openInChrome('chrome://extensions', { background: true })
      out.opened = true
    } catch {}
  }
  return out
}
