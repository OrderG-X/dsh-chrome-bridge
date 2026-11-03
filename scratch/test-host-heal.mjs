/**
 * 宿主自愈：系统清理临时目录（macOS 每天 0 点的 tmp_cleaner 删 /tmp 里 3 天没读过的文件）删掉 token 文件后，
 * 宿主要自己写回去；连 socket 文件都没了就等手上的调用回完再退出（扩展会重新拉起一个新宿主）。
 * 两个宿主同时在（两个 Chrome 资料 / Chrome + Edge）时，只有客户端正连着的那个补写 token。
 * 起真宿主进程（临时目录，不碰真实的 /tmp/dsh-bridge-*），检查间隔调成 200ms。
 *
 *   node scratch/test-host-heal.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${extra}`}`)
  if (!cond) failures++
}
async function until(fn, ms = 5000) {
  for (let t = 0; t < ms; t += 50) { if (fn()) return true; await sleep(50) }
  return false
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-heal-'))
const run = path.join(dir, 'run')
const token = path.join(run, 'dsh-bridge.token')
const sock = path.join(run, 'dsh-bridge.sock')
const logFile = path.join(run, 'dsh-bridge.log')
const hosts = []

/** 起一个宿主。stdin 用管道（不是终端）= 由浏览器拉起的正常模式，不是 --standalone */
function startHost(extraEnv = {}) {
  const env = { ...process.env, DSH_BRIDGE_DIR: run, DSH_BRIDGE_HEAL_MS: '200', ...extraEnv }
  // 外面设了这些就会盖过 DSH_BRIDGE_DIR：清掉，免得测试去动真宿主的 socket / token / 日志
  for (const k of ['DSH_BRIDGE_SOCK', 'DSH_BRIDGE_TOKEN', 'DSH_BRIDGE_LOG']) delete env[k]
  const p = spawn(process.execPath, [path.join(ROOT, 'plugin/vendor/host/host.js')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const h = { p, exited: false, toHost: [] }
  p.on('exit', () => { h.exited = true })
  p.stderr.resume()
  let buf = Buffer.alloc(0)
  p.stdout.on('data', (d) => {   // 宿主发给「扩展」的消息
    buf = Buffer.concat([buf, d])
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0)
      if (buf.length < 4 + n) break
      h.toHost.push(JSON.parse(buf.subarray(4, 4 + n).toString('utf8')))
      buf = buf.subarray(4 + n)
    }
  })
  /** 假装是扩展，往宿主的 stdin 发一条 native messaging 消息 */
  h.fromExt = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj))
    const head = Buffer.alloc(4)
    head.writeUInt32LE(payload.length, 0)
    p.stdin.write(Buffer.concat([head, payload]))
  }
  hosts.push(h)
  return h
}
const readToken = () => fs.readFileSync(token, 'utf8')
const sockPath = () => (WIN ? readToken().split('\n')[1] : sock)

/**
 * 像插件 / cb 那样连上去发一条请求；回 { lines, closed } 随到随填。
 * req 为空就只连上不发（之后用 got.send 发）；slowMs：先不读，过这么久再读（模拟读得慢的客户端）
 */
function client(req, { slowMs = 0 } = {}) {
  const s = net.connect(sockPath())
  const tok = readToken().split('\n')[0]
  const got = { lines: [], closed: false, send: (r) => s.write(JSON.stringify({ token: tok, ...r }) + '\n'), destroy: () => s.destroy() }
  let acc = ''
  s.setEncoding('utf8')
  s.on('data', (d) => {
    acc += d
    let i
    while ((i = acc.indexOf('\n')) >= 0) { got.lines.push(JSON.parse(acc.slice(0, i))); acc = acc.slice(i + 1) }
  })
  s.on('error', () => {})
  s.on('close', () => { got.closed = true })
  if (slowMs) { s.pause(); setTimeout(() => s.resume(), slowMs) }
  if (req) got.send(req)
  return got
}

try {
  // ── 单个宿主：token 被删就写回 ──
  const a = startHost()
  check('宿主起来、写了 token', await until(() => fs.existsSync(token)), fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  const before = readToken()
  if (!WIN) check('监听用的临时名字改成了正式的 socket，没留下', fs.existsSync(sock) && !fs.readdirSync(run).some((f) => f.startsWith('.s')), fs.readdirSync(run).join(','))

  // 清理程序按「多久没用」删：在用的宿主一直刷新 token 文件的时间，它就永远不算旧
  const old = new Date(Date.now() - 5 * 86400_000)
  fs.utimesSync(token, old, old)
  check('token 文件的时间一直被刷新（不会被当成几天没用的旧文件）', await until(() => Date.now() - fs.statSync(token).mtimeMs < 60_000, 3000))

  fs.unlinkSync(token)
  check('token 文件被删后自己写回来', await until(() => fs.existsSync(token), 3000))
  check('写回的内容和原来一样（客户端拿它照样连得上）', fs.existsSync(token) && readToken() === before)
  check('日志里说了一声', /token 文件被删了/.test(fs.readFileSync(logFile, 'utf8')))
  check('宿主还活着', !a.exited)
  const st = client({ id: 's1', op: 'status' })
  check('写回后客户端连得上', await until(() => st.lines.length) && st.lines[0].ok, JSON.stringify(st.lines))

  // ── 两个宿主：后起的接管；token 被删时只有它补写 ──
  const b = startHost()
  check('第二个宿主起来、写了自己的 token', await until(() => fs.existsSync(token) && readToken() !== before))
  const bToken = readToken()
  fs.unlinkSync(token)   // 马上删：旧宿主还没来得及看到新 token，单靠「上次见到的是不是自己的」会补错
  await until(() => fs.existsSync(token), 3000)
  await sleep(600)   // 多给几轮：旧宿主也有机会动手
  check('两个宿主都在时：补回的是客户端正连着的那个的 token', fs.existsSync(token) && readToken() === bToken,
    fs.existsSync(token) ? readToken() : '(没有)')
  const st2 = client({ id: 's2', op: 'status' })
  check('补回后客户端照样连得上', await until(() => st2.lines.length) && st2.lines[0].ok && st2.lines[0].result.pid === b.p.pid, JSON.stringify(st2.lines))
  check('旧宿主没被误杀', !a.exited)

  // 两个宿主几乎同时起来，旧宿主的 token 晚一步写进去（socket 却是新宿主的）：新宿主改回自己的，旧宿主不跟它抢
  fs.writeFileSync(token, before)
  await sleep(800)
  check('token 被换成旧宿主的：客户端连着的宿主一轮内改回自己的', readToken() === bToken, readToken())
  await sleep(600)
  check('之后就稳住了，不来回抢', readToken() === bToken && !a.exited && !b.exited)

  // 坏请求不能把宿主弄崩
  const raw = net.connect(sockPath())
  let rawOut = ''
  raw.setEncoding('utf8')
  raw.on('data', (d) => { rawOut += d })
  raw.on('error', () => {})
  raw.write('null\n')
  await until(() => rawOut.includes('\n'))
  await sleep(200)
  check('收到 null 这种请求：回错、宿主不崩', /JSON 对象/.test(rawOut) && !b.exited, rawOut)

  if (!WIN) {
    // ── socket 文件没了：手上有没回话的调用就等它回完再退 ──
    b.fromExt({ hello: true })   // 「扩展」连上了
    await sleep(100)

    // 两个客户端碰巧用同一个 id：各拿各的结果
    const x1 = client({ id: 'same', op: 'eval', args: { tabId: 1, expression: '"一"' } })
    const x2 = client({ id: 'same', op: 'eval', args: { tabId: 2, expression: '"二"' } })
    await until(() => b.toHost.filter((m) => m.op === 'eval' && m.args && (m.args.tabId === 1 || m.args.tabId === 2)).length === 2)
    const fwd = b.toHost.filter((m) => m.op === 'eval' && m.args && (m.args.tabId === 1 || m.args.tabId === 2))
    check('转给扩展时用宿主自己的 id（不撞）', fwd.length === 2 && fwd[0].id !== fwd[1].id && fwd.every((m) => m.id !== 'same'), JSON.stringify(fwd))
    for (const m of fwd.reverse()) b.fromExt({ id: m.id, ok: true, result: { value: m.args.tabId === 1 ? '一' : '二' } })
    await until(() => x1.lines.length && x2.lines.length)
    check('同一个 id 的两个客户端各拿各的结果、id 还是它自己的', x1.lines[0]?.result?.value === '一' && x2.lines[0]?.result?.value === '二' && x1.lines[0].id === 'same' && x2.lines[0].id === 'same',
      JSON.stringify([x1.lines, x2.lines]))
    const pend = client({ id: 'p1', op: 'shot', args: { tabId: 1 }, timeoutMs: 20000 }, { slowMs: 1500 })
    const late = client(null)   // 早就连上、晚点才发请求的客户端
    const gone = client({ id: 'p4', op: 'eval', args: { tabId: 1, expression: '1' }, timeoutMs: 20000 })   // 发完就走的客户端
    // 宿主转给扩展时换成了自己的 id：按内容认
    const p1 = () => b.toHost.find((m) => m.op === 'shot')
    const p4 = () => b.toHost.find((m) => m.op === 'eval' && m.args.expression === '1')
    check('请求转给了扩展', await until(() => p1() && p4()), JSON.stringify(b.toHost))
    gone.destroy()
    await until(() => gone.closed)
    fs.unlinkSync(sock)
    await sleep(1800)   // 发现没了以后隔一秒再确认一次，才开始收尾
    check('socket 被删、但还有调用没回：先不退', !b.exited)
    late.send({ id: 'p3', op: 'click', args: { tabId: 1, x: 1, y: 1 } })
    check('退出前新来的操作：不转给扩展，明说没执行', await until(() => late.lines.length) && /没执行/.test(late.lines[0].error) && !b.toHost.some((m) => m.op === 'click'),
      JSON.stringify(late.lines))
    b.fromExt({ id: p4().id, ok: true, result: { value: 1 } })   // 回给已经走了的客户端：不该让宿主一直等它
    const big = 'x'.repeat(4 * 1024 * 1024)   // 一张大截图那么大
    b.fromExt({ id: p1().id, ok: true, result: { data: big } })
    check('扩展回的大回话完整送到（客户端读得慢也不截断）、id 换回客户端自己的', await until(() => pend.lines.length, 8000) && pend.lines[0].ok && pend.lines[0].result.data.length === big.length && pend.lines[0].id === 'p1',
      `${pend.lines.length} 行，${pend.closed ? '连接已断' : '连接还在'}`)
    check('回完就退出，让扩展重新拉起', await until(() => b.exited, 3000))

    // 旧宿主 a：socket 路径一直是 b 的，b 删了自己的那个 → a 也看到没了，退出（它那边的扩展会拉起新宿主接管）
    check('被接管的旧宿主在 socket 没了以后也退出', await until(() => a.exited, 3000))

    // ── 一直不回：等到上限就告诉客户端「结果未知」再退 ──
    const c = startHost({ DSH_BRIDGE_DRAIN_MS: '600' })
    await until(() => fs.existsSync(sock) && !c.exited)
    await sleep(300)
    c.fromExt({ hello: true })
    await sleep(100)
    const stuck = client({ id: 'p2', op: 'eval', args: { tabId: 1, expression: '1' }, timeoutMs: 20000 })
    await until(() => c.toHost.some((m) => m.op === 'eval'))
    fs.unlinkSync(sock)
    check('等不到回话：明确告诉客户端结果未知', await until(() => stuck.lines.length, 4000) && /不确定/.test(stuck.lines[0].error) && stuck.lines[0].id === 'p2', JSON.stringify(stuck.lines))
    check('然后退出', await until(() => c.exited, 3000))

    // ── socket 只是被挪开一瞬间（别的宿主退出时会这样）：不当成被删了 ──
    const f = startHost()
    await until(() => fs.existsSync(sock) && fs.existsSync(token))
    await sleep(300)
    const tmpName = path.join(run, 'moved')
    for (let i = 0; i < 10; i++) { fs.renameSync(sock, tmpName); await sleep(30); fs.renameSync(tmpName, sock); await sleep(170) }
    await sleep(1500)
    const st4 = client({ id: 's4', op: 'status' })
    check('socket 被挪开一瞬间又放回：宿主照常干活，不退出', !f.exited && await until(() => st4.lines.length) && st4.lines[0].ok, JSON.stringify(st4.lines))
    f.p.kill('SIGTERM')
    await until(() => f.exited)

    // ── socket 的位置被一个目录占着：起不来就退，别把那个目录挪走 ──
    fs.mkdirSync(sock)
    const g = startHost()
    check('socket 位置被占：宿主起不来就退出', await until(() => g.exited, 5000))
    check('占位的目录原样留着，没被挪走', fs.statSync(sock).isDirectory() && !fs.readdirSync(run).some((x) => x.startsWith('.s')), fs.readdirSync(run).join(','))
    fs.rmdirSync(sock)

    // ── 正常退出只删自己的 socket：被接管的旧宿主退出不能删掉新宿主的 ──
    const d = startHost()
    await until(() => fs.existsSync(sock) && fs.existsSync(token))
    const e = startHost()
    const dTok = readToken()
    await until(() => readToken() !== dTok)
    await sleep(200)
    d.p.kill('SIGTERM')
    await until(() => d.exited)
    const st3 = client({ id: 's3', op: 'status' })
    check('被接管的旧宿主退出后，新宿主的 socket 还在、连得上', fs.existsSync(sock) && await until(() => st3.lines.length) && st3.lines[0].result?.pid === e.p.pid, JSON.stringify(st3.lines))
    e.p.kill('SIGTERM')
    await until(() => e.exited)
    check('正在用的宿主退出时删掉自己的 socket，不留临时文件', !fs.existsSync(sock) && !fs.readdirSync(run).some((f) => f.startsWith('.s')), fs.readdirSync(run).join(','))
  }
} finally {
  for (const h of hosts) if (!h.exited) h.p.kill()
  await sleep(150)
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}

if (failures) {
  console.log(`\n❌ ${failures} 项没过`)
  process.exit(1)
}
console.log('\n✅ 全部通过')
