#!/usr/bin/env node
/**
 * DSH Bridge 原生宿主
 *
 * 两条腿：
 *   1. stdin/stdout ← native messaging 协议（4 字节 LE 长度前缀 + JSON）→ Chrome 扩展
 *   2. /tmp/dsh-bridge-<uid>/dsh-bridge.sock ← 换行分隔 JSON → DSH 插件和 `cb` CLI
 *      （Windows 没有 Unix socket：每次起一个随机名字的命名管道，名字写在 token 文件第二行）
 *
 * 由 Chrome 拉起（扩展 connectNative 时）。stdin 关闭 = Chrome 没了 = 退出。
 * 调试时可以手动跑：node host.js --standalone
 */

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// socket / token / 日志都放进只有当前用户进得去的目录（0700）：/tmp 人人可写，
// 固定文件名会被别的用户抢先占位、或者用软链接把我们的写入引到别处。插件和 cb 用同一个约定。
// Windows 上 %TEMP% 本来就是每个用户自己的目录
const WIN = process.platform === 'win32'
const DIR = process.env.DSH_BRIDGE_DIR || (WIN ? path.join(os.tmpdir(), 'dsh-bridge') : `/tmp/dsh-bridge-${process.getuid()}`)
const SOCK = process.env.DSH_BRIDGE_SOCK ||
  (WIN ? `\\\\.\\pipe\\dsh-bridge-${crypto.randomBytes(12).toString('hex')}` : path.join(DIR, 'dsh-bridge.sock'))
const TOKEN_FILE = process.env.DSH_BRIDGE_TOKEN || path.join(DIR, 'dsh-bridge.token')
const LOG_FILE = process.env.DSH_BRIDGE_LOG || path.join(DIR, 'dsh-bridge.log')
const TIMEOUT_MS = Number(process.env.DSH_BRIDGE_TIMEOUT_MS || 45000)
const MAX_TIMEOUT_MS = 10 * 60_000
const STANDALONE = process.argv.includes('--standalone') || process.stdin.isTTY
const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_NOFOLLOW } = fs.constants

const TOKEN = crypto.randomBytes(24).toString('hex')

/** 没有就建（0700）；有的话必须是自己的真目录（不是软链接），权限多了就收回 0700 */
function privateDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e }
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || (!WIN && st.uid !== process.getuid())) throw new Error(`${dir} 不是当前用户自己的目录，拒绝使用`)
  if (!WIN && (st.mode & 0o077)) fs.chmodSync(dir, 0o700)
}

try {
  for (const d of new Set([...(WIN ? [] : [SOCK]), TOKEN_FILE, LOG_FILE].map((f) => path.dirname(f)))) privateDir(d)
} catch (e) {
  process.stderr.write(`dsh-bridge: ${e.message}\n`)   // Chrome 会把宿主的 stderr 记进它自己的日志
  process.exit(1)
}

// 日志：开一次、不跟软链接（O_NOFOLLOW），之后一直往这个 fd 写
let logFd = null
try { logFd = fs.openSync(LOG_FILE, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600); fs.fchmodSync(logFd, 0o600) } catch {}

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  try { if (logFd !== null) fs.writeSync(logFd, line + '\n') } catch {}
}

/** token 先写进新建的临时文件（O_EXCL：已存在、或是软链接都直接失败），再原子改名过去 */
function writeToken() {
  const tmp = `${TOKEN_FILE}.${process.pid}.tmp`
  try { fs.unlinkSync(tmp) } catch {}
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try { fs.writeSync(fd, TOKEN + '\n' + (WIN ? SOCK + '\n' : '')) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, TOKEN_FILE)
}

// ── 与 Chrome 扩展的 native messaging 管道 ──────────────────────────────────

let extReady = false
let lastExtMsg = 0
const STARTED_AT = Date.now()
let served = 0          // 处理过多少次 socket 请求（给扩展弹窗看）
let lastClientAt = 0
let listening = false

function toExtension(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  if (payload.length > 900 * 1024) throw new Error('发给扩展的消息过大（native messaging 单条上限）')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(payload.length, 0)
  fs.writeSync(1, Buffer.concat([head, payload]))
}

/** extension → host 的分片重组：id → string[] */
const inbox = new Map()

function onExtensionMessage(raw) {
  let msg
  try { msg = JSON.parse(raw) } catch (e) { log('扩展消息不是 JSON:', String(e)); return }
  extReady = true
  lastExtMsg = Date.now()

  if (msg.chunk) {
    const buf = inbox.get(msg.id) || []
    buf[msg.chunk.seq] = msg.data
    inbox.set(msg.id, buf)
    if (buf.filter(Boolean).length >= msg.chunk.total) {
      inbox.delete(msg.id)
      try { onExtensionMessage(buf.join('')) } catch (e) { log('重组失败:', String(e)) }
    }
    return
  }
  if (msg.keepalive) return
  if (msg.hostPing) {
    // 扩展弹窗要看的：宿主活着没、socket 在不在听、最近一次被调用是什么时候
    try {
      toExtension({ hostPong: true, pid: process.pid, startedAt: STARTED_AT, node: process.version,
        socket: SOCK, socketOk: listening && fs.existsSync(SOCK), served, lastClientAt, pending: waiting.size })
    } catch (e) { log('回 hostPong 失败:', String(e)) }
    return
  }

  const pending = waiting.get(msg.id)
  if (!pending) return
  waiting.delete(msg.id)
  clearTimeout(pending.timer)
  reply(pending.sock, { id: msg.id, ok: msg.ok !== false, result: msg.result, error: msg.error })
}

if (!STANDALONE) {
  let buf = Buffer.alloc(0)
  process.stdin.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0)
      if (buf.length < 4 + len) break
      const raw = buf.subarray(4, 4 + len).toString('utf8')
      buf = buf.subarray(4 + len)
      onExtensionMessage(raw)
    }
  })
  process.stdin.on('end', () => { log('stdin 关闭，Chrome 走了'); shutdown(0) })
  process.stdin.on('close', () => shutdown(0))
  process.stdin.resume()
}

// ── CLI 侧：Unix socket ─────────────────────────────────────────────────────

/** 请求 id → {sock, timer} */
const waiting = new Map()

function reply(sock, obj) {
  try {
    sock.write(JSON.stringify(obj) + '\n', () => { try { sock.end() } catch {} })
  } catch (e) { log('回写 CLI 失败:', String(e)) }
}

function forwardToExtension(sock, req) {
  const id = req.id || crypto.randomUUID()
  if (!extReady) {
    reply(sock, { id, ok: false, error: 'Chrome 扩展未连接：Chrome 没开，或 DSH Bridge 扩展没装/被停用' })
    return
  }
  // 客户端带了自己的超时（等元素、截图这类慢操作）就按它来，比它早一点点回话，免得客户端先放弃、只看到「超时」
  const asked = Number(req.timeoutMs)
  const ms = asked > 0 ? Math.min(Math.max(asked - 1500, 1000), MAX_TIMEOUT_MS) : TIMEOUT_MS
  const timer = setTimeout(() => {
    waiting.delete(id)
    reply(sock, { id, ok: false, error: `扩展 ${ms}ms 没回（操作太慢，或者标签页已关闭）` })
  }, ms)
  waiting.set(id, { sock, timer })
  try {
    toExtension({ id, op: req.op, args: req.args || {}, ...(req.client ? { client: req.client } : {}) })
  } catch (e) {
    clearTimeout(timer)
    waiting.delete(id)
    reply(sock, { id, ok: false, error: String(e && e.message || e) })
  }
}

function handleLine(sock, line) {
  let req
  try { req = JSON.parse(line) } catch { return reply(sock, { ok: false, error: '不是合法 JSON' }) }
  if (req.token !== TOKEN) {
    log('token 不匹配，拒绝')
    return reply(sock, { id: req.id, ok: false, error: 'token 不匹配' })
  }
  served++
  lastClientAt = Date.now()
  if (req.op === 'status') {
    return reply(sock, {
      id: req.id, ok: true,
      result: { pid: process.pid, extConnected: extReady, lastExtMsg,
                socket: SOCK, standalone: STANDALONE, pending: waiting.size },
    })
  }
  forwardToExtension(sock, req)
}

function startServer() {
  try {
    if (!WIN && fs.existsSync(SOCK)) {
      // 探测一下是不是活着的旧实例；活着也让路（接管），否则清掉陈旧文件
      try {
        const probe = net.connect(SOCK)
        probe.on('connect', () => probe.end())
        probe.on('error', () => {})
      } catch {}
      fs.unlinkSync(SOCK)
    }
  } catch (e) { log('清理旧 socket 失败:', String(e)) }

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8')
    let acc = ''
    sock.on('data', (d) => {
      acc += d
      let i
      while ((i = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, i).trim()
        acc = acc.slice(i + 1)
        if (line) handleLine(sock, line)
      }
    })
    sock.on('error', () => {})
  })

  server.on('error', (e) => { log('socket 服务出错:', String(e)); shutdown(1) })
  server.listen(SOCK, () => {
    listening = true
    if (!WIN) {
      fs.chmodSync(SOCK, 0o600)
      try { const st = fs.lstatSync(SOCK); ownSock = { dev: st.dev, ino: st.ino } } catch {}
    }
    try { writeToken() } catch (e) { log('写 token 失败:', String(e)); shutdown(1) }
    log(`监听 ${SOCK}（pid ${process.pid}, standalone=${STANDALONE}）`)
  })

  return server
}

let server = null
/** 自己建的那个 socket 文件（dev+inode）：退出时只删它，别把后来接管的新宿主的 socket 删了 */
let ownSock = null
function shutdown(code) {
  // 不调 server.close()：Node 关 Unix socket 服务时会按路径无条件 unlink（实测），
  // 正好会删掉后来接管的新宿主的 socket。反正马上退出，fd 由系统回收。
  try {
    if (WIN) {
      // 命名管道随进程消失；token 文件还指着自己的管道就删掉，免得客户端连一个不存在的管道
      if (fs.readFileSync(TOKEN_FILE, 'utf8').split('\n')[1] === SOCK) fs.unlinkSync(TOKEN_FILE)
    } else {
      const st = fs.lstatSync(SOCK)
      if (ownSock && st.dev === ownSock.dev && st.ino === ownSock.ino) fs.unlinkSync(SOCK)
    }
  } catch {}
  process.exit(code)
}

server = startServer()
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
log('宿主启动', { STANDALONE, node: process.version })
