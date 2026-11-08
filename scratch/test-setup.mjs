/**
 * setup.js 的自测：用一个假 HOME 完整跑一遍「插件首次加载自动安装」，确认
 *   ① 扩展 / 宿主 / 注册文件都落在约定的位置
 *   ② 注册文件里的 path 与 allowed_origins 正确（扩展 ID 固定）
 *   ③ 幂等：第二次调用不会重写（changed=false）
 *   ④ 报错文案确实给出「还差 chrome://extensions 那一次点选」
 *   ⑤ 商店版：注册文件放行商店 ID；装了商店版就不再让人「加载已解压」
 *   ⑥ 插件启动时只重载本地解压版扩展，商店版版本号对不上也不碰它（假 socket，不碰真 Chrome）
 *   ⑦ macOS / Linux 的 run.sh 是装的时候现写的：写进 DSH 自己的 node（nvm 这类 Chrome 找不到的也能用）；
 *      DSH 换了 node 会重写；Chrome 拉不起宿主时把原因写下来，报错文案读得到
 *
 * 跑法：node scratch/test-setup.mjs      （不碰真实 HOME，也不碰真实 Chrome 目录）
 */

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureInstalled, extensionId, installHint, installState, paths, STORE_EXT_IDS, STORE_URL, unixLauncher } from '../plugin/setup.js'

const FIXED_EXT_ID = 'mhlkjkblmdleplggfengldbdmkabloce'
let failures = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${extra}`}`)
  if (!cond) failures++
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-setup-'))
try {
  const p = paths(home)
  const first = ensureInstalled({ home })
  check('安装成功', first.ok === true, first.reason || '')
  check('首次落盘 changed=true', first.changed === true)
  check('扩展 ID 与线上一致', first.extId === FIXED_EXT_ID, String(first.extId))

  check('扩展已复制', fs.existsSync(path.join(p.extDir, 'manifest.json')))
  check('宿主已复制', fs.existsSync(path.join(p.hostDir, 'host.js')))
  // Windows 上 Chrome 拉起的是装的时候现写的 run.bat，没有可执行位这回事
  if (process.platform !== 'win32') check('run.sh 可执行', (fs.statSync(p.launcher).mode & 0o111) !== 0)
  check('扩展 ID 推导一致', extensionId(path.join(p.extDir, 'manifest.json')) === FIXED_EXT_ID)

  const reg = JSON.parse(fs.readFileSync(p.nmFile, 'utf8'))
  check('注册 path 指向宿主', reg.path === p.launcher, reg.path)
  check('allowed_origins 绑定扩展', reg.allowed_origins?.[0] === `chrome-extension://${FIXED_EXT_ID}/`, JSON.stringify(reg.allowed_origins))
  check('注册 name 正确', reg.name === 'com.dsh.bridge')

  const state = installState(home)
  check('installState 全绿', state.extensionCopied && state.hostCopied && state.registered)

  const second = ensureInstalled({ home })
  check('幂等：第二次 changed=false', second.ok === true && second.changed === false)

  const hint = installHint(home)
  check('报错文案含 chrome://extensions', hint.includes('chrome://extensions'))
  check('报错文案含扩展目录', hint.includes(p.extDir))
  check('报错文案提到应用商店', hint.includes('应用商店'))
  check('报错文案给出商店链接，而且排在解压装法前面', hint.includes(STORE_URL) && hint.indexOf(STORE_URL) < hint.indexOf('加载已解压的扩展程序'), hint)

  // ⑤ 商店版
  const STORE_ID = STORE_EXT_IDS[0]
  check('allowed_origins 放行商店 ID', reg.allowed_origins.includes(`chrome-extension://${STORE_ID}/`), JSON.stringify(reg.allowed_origins))
  check('没装商店版时 store=null', state.store === null)
  fs.mkdirSync(path.join(p.chromeDir, 'Profile 2/Extensions', STORE_ID, '1.10.0_0'), { recursive: true })
  const storeState = installState(home)
  check('认出商店版', storeState.store?.id === STORE_ID && storeState.store.version === '1.10.0', JSON.stringify(storeState.store))
  const storeHint = installHint(home)
  check('商店版报错不再让人加载已解压', !storeHint.includes('加载已解压的扩展程序') && !storeHint.includes(p.extDir), storeHint)
  check('商店版报错给出启用/重启引导', storeHint.includes('启用') && storeHint.includes('商店'), storeHint)
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}

// ⑦ run.sh（Windows 的 run.bat 在 test-win.mjs 里测）
if (process.platform !== 'win32') {
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-launcher-'))
  try {
    const p = paths(home2)
    ensureInstalled({ home: home2 })
    const sh = fs.readFileSync(p.launcher, 'utf8')
    check('run.sh 写进了 DSH 自己的 node', sh.includes(`DSH_NODE='${process.execPath}'`), sh.split('\n').find((l) => l.startsWith('DSH_NODE')))
    check('run.sh 是合法的 sh', (() => { try { execFileSync('/bin/sh', ['-n', p.launcher]); return true } catch { return false } })())
    const quoted = unixLauncher("/Users/o'neil/my node/bin/node", false)
    check('路径里有单引号、空格也照样引对', (() => {
      const f = path.join(home2, 'q.sh')
      fs.writeFileSync(f, `${quoted.split('\n').filter((l) => l.startsWith('DSH_NODE=')).join('\n')}\nprintf %s "$DSH_NODE"\n`)
      return execFileSync('/bin/sh', [f], { encoding: 'utf8' }) === "/Users/o'neil/my node/bin/node"
    })())
    check('Electron 才设 ELECTRON_RUN_AS_NODE', unixLauncher('/x', true).includes('ELECTRON_RUN_AS_NODE=1') && !unixLauncher('/x', false).includes('ELECTRON_RUN_AS_NODE'))
    // DSH 换了 node（升级 / 换了 nvm 版本）：下次加载要重写
    fs.writeFileSync(p.launcher, unixLauncher('/old/node', false))
    const again = ensureInstalled({ home: home2 })
    check('node 换了就重写 run.sh', again.changed === true && fs.readFileSync(p.launcher, 'utf8') === sh)
    check('重写后还是可执行', (fs.statSync(p.launcher).mode & 0o111) !== 0)
    // Chrome 拉不起宿主：真跑一次，装时的 node 和别处都找不到（PATH 清空、HOME 换成空目录、固定路径换掉）
    const broken = unixLauncher('/no/such/node', false)
      .replace(/\/usr\/local\/bin\/node|\/opt\/homebrew\/bin\/node|\/usr\/bin\/node/g, '/nonexistent')
      .replace('N="$(command -v node 2>/dev/null)"', 'N=""')
    fs.writeFileSync(p.launcher, broken, { mode: 0o755 })
    let code = 0
    try { execFileSync(p.launcher, [], { env: { HOME: home2, PATH: '/usr/bin:/bin' }, stdio: 'ignore' }) } catch (e) { code = e.status }
    const errFile = path.join(p.hostDir, 'launch-error.txt')
    check('找不到 node：退出码 1、原因写进 launch-error.txt', code === 1 && fs.readFileSync(errFile, 'utf8').includes('找不到可用的 node'), code)
    const hint = installHint(home2)
    check('报错文案读出拉不起来的原因', hint.includes('找不到可用的 node') && hint.includes('重启 DSH'), hint)
    // 能拉起来时把旧的原因删掉（不真起宿主：host.js 换成立刻退出的空脚本）
    fs.writeFileSync(p.launcher, unixLauncher(process.execPath, false), { mode: 0o755 })
    const hostJs = path.join(p.hostDir, 'host.js')
    const realHost = fs.readFileSync(hostJs)
    fs.writeFileSync(hostJs, '')
    try { execFileSync(p.launcher, [], { env: { HOME: home2, PATH: '/usr/bin:/bin' }, stdio: 'ignore' }) } finally { fs.writeFileSync(hostJs, realHost) }
    check('拉起来了就删掉旧的失败原因', !fs.existsSync(errFile))
    fs.writeFileSync(errFile, '旧的失败原因')
    fs.writeFileSync(p.launcher, unixLauncher('/old/node', false))
    ensureInstalled({ home: home2 })
    check('DSH 重写启动脚本时也删掉旧的失败原因', !fs.existsSync(errFile))
  } finally {
    fs.rmSync(home2, { recursive: true, force: true })
  }
}

// ⑥ 重载只针对本地解压版：假 HOME + 假 socket 跑一遍 apply()，看插件发了哪些 op
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-refresh-'))
  // Windows 没有 Unix socket，用命名管道
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-bridge-test-${process.pid}` : path.join(fakeHome, 'bridge.sock')
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome   // Windows 上 os.homedir() 看的是它
  process.env.DSH_BRIDGE_SOCK = sock
  process.env.DSH_BRIDGE_TOKEN = path.join(fakeHome, 'token')
  process.env.DSH_BRIDGE_DIR = fakeHome   // 插件的 trace 日志也落进假 HOME
  let answer = null
  const ops = []
  const server = net.createServer((c) => {
    c.setEncoding('utf8')
    let acc = ''
    c.on('data', (d) => {
      acc += d
      const i = acc.indexOf('\n')
      if (i < 0) return
      const req = JSON.parse(acc.slice(0, i))
      ops.push(req.op)
      const result = req.op === 'version' ? answer : { reloading: true }
      c.end(JSON.stringify({ id: req.id, ok: true, result }) + '\n')
    })
  })
  await new Promise((r) => server.listen(sock, r))
  const { apply } = await import('../plugin/index.js')
  const ctx = { tools: { register: () => {} }, get: () => undefined, inject: () => {}, on: () => {} }
  const startOps = async (a) => {
    answer = a
    ops.length = 0
    apply(ctx, {})
    await new Promise((r) => setTimeout(r, 300))
    return [...ops]
  }
  try {
    let got = await startOps({ version: '0.0.1', id: STORE_EXT_IDS[0] })
    check('商店版版本不同：不重载', got.join() === 'version', got.join())
    const manifest = path.join(fakeHome, 'dsh-bridge-extension/manifest.json')
    check('apply 落盘到假 HOME', fs.existsSync(manifest))
    const want = JSON.parse(fs.readFileSync(manifest, 'utf8')).version
    got = await startOps({ version: want, id: STORE_EXT_IDS[0] })
    check('商店版版本相同：不重载', got.join() === 'version', got.join())
    got = await startOps({ version: '0.0.1', id: FIXED_EXT_ID })
    check('解压版版本不同：重载', got.join() === 'version,reload', got.join())
    got = await startOps({ version: want, id: FIXED_EXT_ID })
    check('解压版版本相同：不重载', got.join() === 'version', got.join())
  } finally {
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
