/**
 * setup.js 的自测：用一个假 HOME 完整跑一遍「插件首次加载自动安装」，确认
 *   ① 扩展 / 宿主 / 注册文件都落在约定的位置
 *   ② 注册文件里的 path 与 allowed_origins 正确（扩展 ID 固定）
 *   ③ 幂等：第二次调用不会重写（changed=false）
 *   ④ 报错文案确实给出「还差 chrome://extensions 那一次点选」
 *   ⑤ 商店版：注册文件放行商店 ID；装了商店版就不再让人「加载已解压」
 *   ⑥ 插件启动时只重载本地解压版扩展，商店版版本号对不上也不碰它（假 socket，不碰真 Chrome）
 *
 * 跑法：node scratch/test-setup.mjs      （不碰真实 HOME，也不碰真实 Chrome 目录）
 */

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { ensureInstalled, extensionId, installHint, installState, paths, STORE_EXT_IDS, STORE_URL } from '../plugin/setup.js'

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
  const runSh = fs.statSync(path.join(p.hostDir, 'run.sh'))
  check('run.sh 可执行', (runSh.mode & 0o111) !== 0)
  check('扩展 ID 推导一致', extensionId(path.join(p.extDir, 'manifest.json')) === FIXED_EXT_ID)

  const reg = JSON.parse(fs.readFileSync(p.nmFile, 'utf8'))
  check('注册 path 指向宿主', reg.path === path.join(p.hostDir, 'run.sh'), reg.path)
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

// ⑥ 重载只针对本地解压版：假 HOME + 假 socket 跑一遍 apply()，看插件发了哪些 op
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-refresh-'))
  const sock = path.join(fakeHome, 'bridge.sock')
  process.env.HOME = fakeHome
  process.env.DSH_BRIDGE_SOCK = sock
  process.env.DSH_BRIDGE_TOKEN = path.join(fakeHome, 'token')
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
