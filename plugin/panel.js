/**
 * DSH 插件页里那张设置卡的后端：一条 HTTP 路由，挂在 DSH 自己的 webServer 上。
 *
 *   GET  /dsh-chrome-bridge/panel            → 状态（连没连上、扩展版本、正在控制几个标签页、两个开关）
 *   POST /dsh-chrome-bridge/panel {action}   → pause（只能暂停）/ cursor / releaseAll / install，回新状态
 *
 * 页面（client.js）跑在 DSH 的网页端，只能走 HTTP；这里再转成 socket 上的 `panel` 操作。
 * webServer 本身不做鉴权，而用户的 Chrome 里随便哪个网页都摸得到 127.0.0.1，所以自己把门：
 * 只收本机来的连接、跨站的 Origin 一律拒、POST 必须是 JSON（跨站发不出来，会先被预检挡住）。
 * 「恢复控制」故意不开放 —— 这条路模型也摸得到，那一下只能用户在 Chrome 的扩展面板里点。
 */

import fs from 'node:fs'
import { installState, assistInstall, paths, STORE_EXT_IDS } from './setup.js'

export const PANEL_ROUTE = '/dsh-chrome-bridge/panel'

const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version } catch { return '' }
})()

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/**
 * 当前状态。连不上时也要答得出「差哪一步」，所以安装情况单独给。
 * @param call - socket 调用（index.js 的 call）
 * @param sock - socket 路径；文件都不在就是宿主没起（= 扩展没在 Chrome 里跑）
 */
export async function panelState(call, sock) {
  const inst = installState()
  const base = {
    plugin: PKG_VERSION,
    platform: process.platform,
    store: inst.store ? { version: inst.store.version } : null,
    extDir: paths().extDir,
    connected: false,
  }
  if (!fs.existsSync(sock)) return base
  let ver
  try {
    ver = await call('version', {}, 3000)
  } catch (e) {
    return { ...base, error: String((e && e.message) || e) }
  }
  const ext = { version: ver.version, id: ver.id, store: STORE_EXT_IDS.includes(ver.id) }
  try {
    return { ...base, connected: true, ext, ...(await call('panel', {}, 3000)) }
  } catch (e) {
    // 老扩展（商店里还没更新的那版）没有 panel：能看状态，开关点不了
    return { ...base, connected: true, ext, outdated: true }
  }
}

/** 跨站请求一律拒：没带 Origin（同源 GET、curl）放行；带了就必须是 DSH 自己。 */
function allowed(req, origin) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false
  if (!LOOPBACK_HOST.test(req.headers.host || '')) return false
  const from = req.headers.origin
  if (!from) return true
  if (from === 'null') return false
  let own
  try { own = origin() } catch { own = '' }
  if (from === own) return true
  try {
    const a = new URL(from), b = new URL(own)
    return LOOPBACK_HOST.test(a.host) && a.port === b.port && a.protocol === b.protocol
  } catch {
    return false
  }
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求太大')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('不是 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * @param deps.call - socket 调用
 * @param deps.sock - socket 路径
 * @param deps.origin - DSH 网页端自己的 origin（webServer.getOrigin）
 * @param deps.trace - 日志
 */
export function panelHandler({ call, sock, origin, trace = () => {} }) {
  return async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (!allowed(req, origin)) {
      trace(`设置页路由拒绝了一个请求：${req.socket.remoteAddress} host=${req.headers.host} origin=${req.headers.origin}`)
      return send(403, { error: 'forbidden' })
    }
    if (req.method === 'GET') return send(200, await panelState(call, sock))
    if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(415, { error: 'expect application/json' })

    let body
    try { body = await readJson(req) } catch (e) { return send(400, { error: e.message }) }
    try {
      switch (body.action) {
        case 'pause':
          await call('panel', { action: 'pause', on: true }, 8000)
          break
        case 'cursor':
          await call('panel', { action: 'cursor', on: !!body.on }, 8000)
          break
        case 'releaseAll':
          await call('panel', { action: 'releaseAll' }, 15000)
          break
        case 'install': {
          const r = assistInstall()
          return send(200, { ...(await panelState(call, sock)), assist: { opened: !!r.opened, clipboard: !!r.clipboard, store: !!r.store } })
        }
        default:
          return send(400, { error: `不认识的 action: ${body.action}` })
      }
    } catch (e) {
      return send(200, { ...(await panelState(call, sock)), actionError: String((e && e.message) || e) })
    }
    return send(200, await panelState(call, sock))
  }
}
