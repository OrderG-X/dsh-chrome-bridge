/**
 * setup.js 的自测：用一个假 HOME 完整跑一遍「插件首次加载自动安装」，确认
 *   ① 扩展 / 宿主 / 注册文件都落在约定的位置
 *   ② 注册文件里的 path 与 allowed_origins 正确（扩展 ID 固定）
 *   ③ 幂等：第二次调用不会重写（changed=false）
 *   ④ 报错文案确实给出「还差 chrome://extensions 那一次点选」
 *
 * 跑法：node scratch/test-setup.mjs      （不碰真实 HOME，也不碰真实 Chrome 目录）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureInstalled, extensionId, installHint, installState, paths } from '../plugin/setup.js'

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
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
