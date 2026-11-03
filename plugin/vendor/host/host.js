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
const TOKEN_FILE = process.env.DSH_BRIDGE_TOKEN || path.join(DIR, 'dsh-bridge.token')
const UNIX_SOCK = process.env.DSH_BRIDGE_SOCK || path.join(DIR, 'dsh-bridge.sock')
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
  for (const d of new Set([...(WIN ? [] : [UNIX_SOCK]), TOKEN_FILE, LOG_FILE].map((f) => path.dirname(f)))) privateDir(d)
} catch (e) {
  process.stderr.write(`dsh-bridge: ${e.message}\n`)   // Chrome 会把宿主的 stderr 记进它自己的日志
  process.exit(1)
}

// Windows 管道名：dsh-bridge-<哪个 token 文件>-<启动时刻，微秒>-<随机>。管道在全机共用的命名空间里，
// 带上 token 文件真实路径的指纹（目录建好后取 realpath：短文件名 / 链接这些别名都归到一处），同一个 token 文件的宿主才互相比先后（见 isCurrentHost）
let realToken = TOKEN_FILE
try { realToken = path.join(fs.realpathSync.native(path.dirname(TOKEN_FILE)), path.basename(TOKEN_FILE)) } catch {}
const PIPE_SCOPE = crypto.createHash('sha256').update(path.resolve(realToken).toLowerCase()).digest('hex').slice(0, 10)
const PIPE_RE = new RegExp(`^dsh-bridge-${PIPE_SCOPE}-\\d{17}-[0-9a-f]+$`)
const SOCK = WIN
  ? process.env.DSH_BRIDGE_SOCK || `\\\\.\\pipe\\dsh-bridge-${PIPE_SCOPE}-${String(Math.round((performance.timeOrigin + performance.now()) * 1000)).padStart(17, '0')}-${crypto.randomBytes(12).toString('hex')}`
  : UNIX_SOCK
// Unix：先在同目录一个只属于自己的临时名字上监听、记下 inode，再原子改名成公开路径。
// 直接在公开路径上监听的话，监听完、记 inode 之前要是另一个宿主刚好接管，就会把人家的 inode 记成自己的
const BIND_PATH = WIN ? SOCK : path.join(path.dirname(SOCK), `.s${process.pid}`)

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
  reply(pending.sock, { id: pending.cid, ok: msg.ok !== false, result: msg.result, error: msg.error })
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

/** 还没送到客户端手里的回话（连接还没关）：宿主要退出时等它们，免得大截图只送出去一截 */
let writing = 0

function reply(sock, obj) {
  if (sock.destroyed) return   // 客户端早走了（close 已经发生过，不会再来）
  writing++
  let done = false
  const fin = () => { if (!done) { done = true; writing-- } }
  sock.once('close', fin)
  try {
    sock.write(JSON.stringify(obj) + '\n', (err) => { if (err) fin(); try { sock.end() } catch {} })
  } catch (e) { fin(); log('回写 CLI 失败:', String(e)) }
}

function forwardToExtension(sock, req) {
  // 和扩展之间用宿主自己生成的 id：两个客户端碰巧用了同一个 id 也不会拿错对方的结果；回给客户端时换回它自己的
  const id = crypto.randomUUID()
  const cid = req.id ?? id
  if (!extReady) {
    reply(sock, { id: cid, ok: false, error: 'Chrome 扩展未连接：Chrome 没开，或 DSH Bridge 扩展没装/被停用' })
    return
  }
  // 客户端带了自己的超时（等元素、截图这类慢操作）就按它来，比它早一点点回话，免得客户端先放弃、只看到「超时」
  const asked = Number(req.timeoutMs)
  const ms = asked > 0 ? Math.min(Math.max(asked - 1500, 1000), MAX_TIMEOUT_MS) : TIMEOUT_MS
  const timer = setTimeout(() => {
    waiting.delete(id)
    reply(sock, { id: cid, ok: false, error: `扩展 ${ms}ms 没回（操作太慢，或者标签页已关闭；做没做成不确定）` })
  }, ms)
  waiting.set(id, { sock, timer, cid })
  try {
    toExtension({ id, op: req.op, args: req.args || {}, ...(req.client ? { client: req.client } : {}) })
  } catch (e) {
    clearTimeout(timer)
    waiting.delete(id)
    reply(sock, { id: cid, ok: false, error: String(e && e.message || e) })
  }
}

function handleLine(sock, line) {
  let req
  try { req = JSON.parse(line) } catch { return reply(sock, { ok: false, error: '不是合法 JSON' }) }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return reply(sock, { ok: false, error: '请求要是一个 JSON 对象' })
  if (req.token !== TOKEN) {
    log('token 不匹配，拒绝')
    return reply(sock, { id: req.id, ok: false, error: 'token 不匹配' })
  }
  served++
  lastClientAt = Date.now()
  if (draining && req.op !== 'status') {
    return reply(sock, { id: req.id, ok: false, error: '宿主正要重启（临时目录被系统清理了），这次操作没执行：过几秒再试' })
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
  if (!WIN) { try { fs.unlinkSync(BIND_PATH) } catch {} }   // 同 pid 的上一个进程留下的

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
  server.listen(BIND_PATH, () => {
    if (!WIN) {
      try {
        fs.chmodSync(BIND_PATH, 0o600)
        const st = fs.lstatSync(BIND_PATH)
        ownSock = { dev: st.dev, ino: st.ino }
        fs.renameSync(BIND_PATH, SOCK)   // 原子换上：旧宿主的 socket 文件（活的死的都一样）被顶掉，旧宿主自己会发现
        published = true
      } catch (e) { log('放 socket 失败:', String(e)); return shutdown(1) }
    }
    listening = true
    try { writeToken() } catch (e) { log('写 token 失败:', String(e)); shutdown(1) }
    log(`监听 ${SOCK}（pid ${process.pid}, standalone=${STANDALONE}）`)
    setInterval(healFiles, HEAL_MS).unref()
  })

  return server
}

/**
 * 系统会清临时目录：macOS 每天 0 点的 tmp_cleaner 删掉 /tmp 里 3 天没读过的文件，Windows 的存储感知也会清 %TEMP%。
 * token 文件没了宿主还活着，插件和 cb 只会报「token 不匹配」，一直到 Chrome 重启才好（实测：Chrome 开了 5 天，第 4 天 0 点起就连不上）。
 * 所以定时看一眼：客户端正连着的宿主（见 isCurrentHost）发现 token 文件没了、或者不是自己的，就写成自己的；
 * 别的宿主一概不动它，所以几个宿主同时在（两个 Chrome 资料、Chrome + Edge）也不会互相抢，最多一轮就对上。
 * 连 socket 文件都没了（整个目录被清掉）就等手上的调用回完再退出 —— 扩展会马上重新拉起一个宿主，socket 和 token 都是新的。
 */
const HEAL_MS = Number(process.env.DSH_BRIDGE_HEAL_MS || 60_000)
const DRAIN_MS = Number(process.env.DSH_BRIDGE_DRAIN_MS || 120_000)
let ownsToken = true   // 上次看到的 token 文件是不是自己写的
let draining = false

/**
 * 客户端现在连的是不是自己（同一时刻只有一个宿主是）。Unix：socket 文件还是自己建的那个（后来的宿主会删掉它换成自己的）。
 * Windows：每个宿主有自己的管道，客户端按 token 文件里写的管道去连；约定同一个 token 文件的宿主里最晚起来的那个算数，
 * 管道名里带着启动时刻，列一下 \\.\pipe\ 就知道。
 */
function isCurrentHost() {
  if (!WIN) {
    try {
      const st = fs.lstatSync(SOCK)
      return !!ownSock && st.dev === ownSock.dev && st.ino === ownSock.ino
    } catch { return false }
  }
  const me = path.win32.basename(SOCK)
  if (!PIPE_RE.test(me)) return ownsToken   // 自己指定的管道名，比不了先后：只在上次见到的 token 是自己的时候补
  try {
    return !fs.readdirSync('\\\\.\\pipe\\').some((n) => PIPE_RE.test(n) && n > me)
  } catch (e) {
    if (!pipeListFailed) log('列不出命名管道，退回看上次见到的 token 是不是自己的:', String(e))
    pipeListFailed = true
    return ownsToken
  }
}
let pipeListFailed = false

let sockGone = false
function healFiles() {
  if (draining || sockGone) return
  if (!WIN && !fs.existsSync(SOCK)) {
    // 隔一秒再看一眼：别的宿主退出时会把 socket 挪开一瞬间（见 shutdown），别被这一下骗了
    sockGone = true
    setTimeout(() => {
      sockGone = false
      if (fs.existsSync(SOCK)) return
      log('socket 文件被删了（系统清理临时目录？）')
      if (!STANDALONE) drainThenExit()   // 扩展那边断开就会重连、拉起新宿主
    }, 1000).unref()
    return
  }
  let cur = null
  try {
    cur = fs.readFileSync(TOKEN_FILE, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') return
  }
  if (cur !== null) ownsToken = cur.split('\n')[0] === TOKEN
  if (cur !== null && ownsToken) {
    // 顺手刷一下时间：清理程序按「多久没用」删，一直是新的就不会被删
    try { const now = new Date(); fs.utimesSync(TOKEN_FILE, now, now) } catch {}
    return
  }
  if (!isCurrentHost()) return
  try {
    privateDir(path.dirname(TOKEN_FILE))
    writeToken()
    ownsToken = true
    log(cur === null ? 'token 文件被删了（系统清理临时目录？），已写回' : 'token 文件不是自己的（几个宿主同时起来？），已改回')
  } catch (err) {
    log('写回 token 失败:', String(err))
  }
}

/**
 * 等已经转给扩展、还没回话的调用回完、回话也送到客户端了再退（最多 DRAIN_MS）：直接退的话客户端只看到连接断了，
 * 操作其实可能已经做了，模型一重试就做两遍。等不到的明确告诉它「结果未知」。这期间新来的操作不转，回「没执行」。
 */
function drainThenExit() {
  draining = true
  const until = Date.now() + DRAIN_MS
  const tick = () => {
    if ((waiting.size || writing) && Date.now() < until) return setTimeout(tick, 200)
    for (const w of waiting.values()) {
      clearTimeout(w.timer)
      reply(w.sock, { id: w.cid, ok: false, error: '宿主要重启（临时目录被系统清理了），这次操作做没做成不确定：先看看页面现在的样子，再决定要不要重做' })
    }
    waiting.clear()
    const flushBy = Date.now() + 5000
    const flush = () => (writing && Date.now() < flushBy ? setTimeout(flush, 100) : shutdown(0))
    flush()
  }
  tick()
}

let server = null
/** 自己建的那个 socket 文件（dev+inode）：退出时只删它，别把后来接管的新宿主的 socket 删了 */
let ownSock = null
let published = false   // 已经改名成公开路径了（没成功的话公开路径上的东西跟自己无关，退出时别碰）
function shutdown(code) {
  // 不调 server.close()：Node 关 Unix socket 服务时会按路径无条件 unlink（实测），
  // 正好会删掉后来接管的新宿主的 socket。反正马上退出，fd 由系统回收。
  try {
    if (WIN) {
      // 命名管道随进程消失；token 文件还指着自己的管道就删掉，免得客户端连一个不存在的管道
      if (fs.readFileSync(TOKEN_FILE, 'utf8').split('\n')[1] === SOCK) fs.unlinkSync(TOKEN_FILE)
    } else {
      try { fs.unlinkSync(BIND_PATH) } catch {}   // 还没来得及改名就退了
      // 只删自己的 socket 文件：先原子挪到自己的临时名再看是谁的（先看再删的话，中间新宿主刚好换上来就会删错）。
      // 挪下来的是新宿主的就放回去（link 不覆盖：放回之前又来了更新的，就不用放了）
      if (published) {
        fs.renameSync(SOCK, BIND_PATH)
        const st = fs.lstatSync(BIND_PATH)
        if (st.dev !== ownSock.dev || st.ino !== ownSock.ino) {
          try {
            fs.linkSync(BIND_PATH, SOCK)
          } catch (e) {
            // 放不回去（不是因为已经有更新的了）：改名挪回去，挪不回也别删，那是别人的
            if (e.code !== 'EEXIST') { try { fs.renameSync(BIND_PATH, SOCK) } catch {} ; process.exit(code) }
          }
        }
        fs.unlinkSync(BIND_PATH)
      }
    }
  } catch {}
  process.exit(code)
}

server = startServer()
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
log('宿主启动', { STANDALONE, node: process.version })
