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
import { execFileSync } from 'node:child_process'
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

/** 所有落盘位置。home 可覆盖，方便测试。 */
export function paths(home = os.homedir()) {
  const bridge = path.join(home, '.dsh/chrome-bridge')
  const extDir = path.join(home, EXT_DIR_NAME)
  const chromeDir = path.join(home, 'Library/Application Support/Google/Chrome')
  const nmDir = path.join(chromeDir, 'NativeMessagingHosts')
  return {
    home,
    bridge,
    hostDir: path.join(bridge, 'host'),
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

/** 装好了没有（只看落盘结果，不管 Chrome 有没有加载扩展）。 */
export function installState(home = os.homedir()) {
  const p = paths(home)
  let extId = null
  try { extId = extensionId(path.join(p.extDir, 'manifest.json')) } catch {}
  return {
    ...p,
    extId,
    extensionCopied: !!extId,
    hostCopied: fs.existsSync(path.join(p.hostDir, 'run.sh')),
    registered: fs.existsSync(p.nmFile),
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

  try {
    if (process.platform !== 'darwin') {
      return { ...out, reason: 'macOS only（native messaging 路径是 macOS 专有）' }
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
      path: path.join(p.hostDir, 'run.sh'),
      type: 'stdio',
      allowed_origins: [extId, ...STORE_EXT_IDS].map((id) => `chrome-extension://${id}/`),
    }, null, 2)}\n`

    let nmPrev = null
    try { nmPrev = fs.readFileSync(p.nmFile, 'utf8') } catch {}
    const upToDate = prev === stamp && nmPrev === nmBody && allPresent(vExt, p.extDir) && allPresent(vHost, p.hostDir)
    if (!upToDate) {
      fs.mkdirSync(p.extDir, { recursive: true })
      fs.cpSync(vExt, p.extDir, { recursive: true, force: true })
      fs.mkdirSync(p.hostDir, { recursive: true })
      fs.cpSync(vHost, p.hostDir, { recursive: true, force: true })
      fs.chmodSync(path.join(p.hostDir, 'run.sh'), 0o755)
      fs.mkdirSync(p.nmDir, { recursive: true })
      fs.writeFileSync(p.nmFile, nmBody)
      fs.writeFileSync(p.stampFile, `${stamp}\n`)
      out.changed = true
    }

    // ── 可选件：cb CLI、页内光标脚本 —— 失败只是少个便利，不该让安装失败 ──
    // 刻意不动 ~/.dsh/skills：那是全局 agent 行为，装了插件就有原生 browser_* 工具，不需要它。
    try {
      copyFile(path.join(vendor, 'cb'), p.cb, 0o755)
      fs.mkdirSync(path.dirname(p.cbLink), { recursive: true })
      // ~/.local/bin/cb 可能是用户自己的另一个 cb：只在还没有时建链接；指向我们的链接本来就对，
      // 别的东西（用户自己的文件 / 指向别处的链接）一律不碰
      let cur = null
      try { cur = fs.lstatSync(p.cbLink) } catch {}
      if (!cur) fs.symlinkSync(p.cb, p.cbLink)
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
  if (process.platform !== 'darwin') {
    return '浏览器桥只支持 macOS：native messaging 的注册路径是 macOS 专有的，其他系统上装不了宿主（插件本身不会静默失败）。'
  }
  if (!s.hostCopied || !s.registered) {
    return [
      '宿主或 native messaging 注册没写成功（多半是权限问题）：',
      `宿主目录 ${s.hostDir}${s.hostCopied ? ' ✅' : ' ❌'}`,
      `注册文件 ${s.nmFile}${s.registered ? ' ✅' : ' ❌'}`,
      '可以手动跑一次：./bridge setup（源码仓库里），或者用源码的 install.sh。',
    ].join('\n')
  }
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
    '  3. 点「加载已解压的扩展程序」，在文件框里按 ⌘⇧G、粘贴、回车，选这个文件夹：',
    `     ${s.extDir}`,
    '装好后回到这里重试；宿主和 native 注册已经自动装好了，不用再跑任何脚本。',
  ].join('\n')
}

/** Chrome 在不在跑（决定要不要顺手把设置页打开）。 */
function chromeRunning() {
  try { execFileSync('/usr/bin/pgrep', ['-x', 'Google Chrome'], { stdio: 'ignore' }); return true } catch { return false }
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
      execFileSync('/usr/bin/open', ['-a', 'Google Chrome', STORE_URL])
      out.opened = true
    } catch {}
    return out
  }
  if (!store) {
    try {
      execFileSync('/usr/bin/pbcopy', [], { input: `${p.extDir}\n` })
      out.clipboard = true
    } catch {}
  }
  if (out.chromeRunning) {
    try {
      execFileSync('/usr/bin/open', ['-g', '-a', 'Google Chrome', 'chrome://extensions'])
      out.opened = true
    } catch {}
  }
  return out
}
