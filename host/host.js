#!/usr/bin/env node
/**
 * DSH Bridge 原生宿主
 *
 * 两条腿：
 *   1. stdin/stdout ← native messaging 协议（4 字节 LE 长度前缀 + JSON）→ Chrome 扩展
 *   2. /tmp/dsh-bridge.sock ← 换行分隔 JSON → DSH 的 `cb` CLI
 *
 * 由 Chrome 拉起（扩展 connectNative 时）。stdin 关闭 = Chrome 没了 = 退出。
 * 调试时可以手动跑：node host.js --standalone
 */

import net from 'node:net'
import fs from 'node:fs'
import crypto from 'node:crypto'

const SOCK = process.env.DSH_BRIDGE_SOCK || '/tmp/dsh-bridge.sock'
const TOKEN_FILE = process.env.DSH_BRIDGE_TOKEN || '/tmp/dsh-bridge.token'
const LOG_FILE = process.env.DSH_BRIDGE_LOG || '/tmp/dsh-bridge.log'
const TIMEOUT_MS = Number(process.env.DSH_BRIDGE_TIMEOUT_MS || 45000)
const STANDALONE = process.argv.includes('--standalone') || process.stdin.isTTY

const TOKEN = crypto.randomBytes(24).toString('hex')

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
}

try { fs.writeFileSync(LOG_FILE, '') } catch {}
fs.chmodSync(LOG_FILE, 0o600)

// ── 与 Chrome 扩展的 native messaging 管道 ──────────────────────────────────

let extReady = false
let lastExtMsg = 0

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
  const timer = setTimeout(() => {
    waiting.delete(id)
    reply(sock, { id, ok: false, error: `扩展 ${TIMEOUT_MS}ms 没回（标签页可能已关闭）` })
  }, TIMEOUT_MS)
  waiting.set(id, { sock, timer })
  try {
    toExtension({ id, op: req.op, args: req.args || {} })
  } catch (e) {
    clearTimeout(timer)
    waiting.delete(id)
    reply(sock, { id, ok: false, error: String(e && e.message || e) })
  }
}

function handleLine(sock, line) {
  let req
  try { req = JSON.parse(line) } catch { return reply(sock, { ok: false, error: '不是合法 JSON' }) }
  if (req.token !== TOKEN && req.token !== 'local') {
    log('token 不匹配，拒绝')
    return reply(sock, { id: req.id, ok: false, error: 'token 不匹配' })
  }
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
    if (fs.existsSync(SOCK)) {
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
    fs.chmodSync(SOCK, 0o600)
    fs.writeFileSync(TOKEN_FILE, TOKEN + '\n')
    fs.chmodSync(TOKEN_FILE, 0o600)
    log(`监听 ${SOCK}（pid ${process.pid}, standalone=${STANDALONE}）`)
  })

  return server
}

let server = null
function shutdown(code) {
  try { server && server.close() } catch {}
  try { fs.existsSync(SOCK) && fs.unlinkSync(SOCK) } catch {}
  process.exit(code)
}

server = startServer()
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
log('宿主启动', { STANDALONE, node: process.version })
