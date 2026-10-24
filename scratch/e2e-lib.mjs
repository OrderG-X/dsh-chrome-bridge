/**
 * 真机端到端测试的公共件：找浏览器、用 --remote-debugging-pipe 起浏览器并加载已解压扩展、跑 cb、记结果。
 * 不 import 插件代码：调用方要先定好 HOME 等环境再加载插件。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'

export const WIN = process.platform === 'win32'
export const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform
export const FIXED_EXT_ID = 'mhlkjkblmdleplggfengldbdmkabloce'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 结果收集：check() 打一行，summary() 写进 GitHub 的步骤摘要 */
export function checker() {
  const results = []
  const check = (name, cond, extra = '') => {
    results.push({ name, ok: !!cond, extra: cond ? '' : String(extra) })
    console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${extra}`}`)
    return !!cond
  }
  const failed = () => results.filter((r) => !r.ok)
  const summary = (title) => {
    const md = [`## ${title}`, '', ...results.map((r) => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `：${r.extra.split('\n')[0]}`}`), '']
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`)
    console.log(failed().length ? `\n❌ ${failed().length} 项没过` : '\n✅ 全部通过')
  }
  return { check, failed, summary, results }
}

/** 浏览器路径：chrome 或 edge（CHROME_BIN 优先） */
export function browserBin(kind = 'chrome') {
  const env = process.env
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
  const cands = kind === 'edge'
    ? {
        darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
        win32: roots.map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
        linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
      }
    : {
        darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        win32: roots.map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
        linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
      }
  return [kind === 'chrome' ? env.CHROME_BIN : null, ...(cands[process.platform] || [])].filter(Boolean).find((p) => fs.existsSync(p)) || null
}

/** CDP over --remote-debugging-pipe：fd3 写给浏览器，fd4 读浏览器，消息以 \0 分隔 */
function pipeClient(proc) {
  const out = proc.stdio[3]
  const inp = proc.stdio[4]
  const pending = new Map()
  let seq = 0
  let buf = Buffer.alloc(0)
  inp.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    let i
    while ((i = buf.indexOf(0)) >= 0) {
      const msg = JSON.parse(buf.subarray(0, i).toString('utf8'))
      buf = buf.subarray(i + 1)
      const p = msg.id && pending.get(msg.id)
      if (!p) continue
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.message} ${msg.error.data || ''}`.trim()))
      else p.resolve(msg.result)
    }
  })
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    out.write(`${JSON.stringify({ id, method, params })}\0`)
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} 超时`)) }, 30000)
  })
}

/**
 * 起一个干净的浏览器（临时数据目录）并把扩展当「已解压」加载进去。
 * Mac / Linux 的浏览器在「数据目录/NativeMessagingHosts」里找注册，把 nmFile 抄一份过去；Windows 走注册表。
 */
export async function launchBrowser({ bin, extDir, nmFile, headed = false }) {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-browser-'))
  if (!WIN && nmFile) {
    fs.mkdirSync(path.join(udd, 'NativeMessagingHosts'), { recursive: true })
    fs.copyFileSync(nmFile, path.join(udd, 'NativeMessagingHosts', path.basename(nmFile)))
  }
  const args = [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${udd}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    ...(headed ? [] : ['--headless=new']),
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...(process.platform === 'linux' ? ['--no-sandbox', '--password-store=basic'] : []),
    'about:blank',
  ]
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true })
  let log = ''
  proc.stderr.on('data', (d) => { log = (log + d).slice(-20000) })
  const cdp = pipeClient(proc)
  const close = async () => {
    if (proc.exitCode === null) {
      if (WIN) await new Promise((r) => execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => r()))
      else proc.kill('SIGKILL')
    }
    await sleep(1000)
    try { fs.rmSync(udd, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  }
  try {
    const ver = await cdp('Browser.getVersion')
    const { id } = await cdp('Extensions.loadUnpacked', { path: extDir })
    return { proc, cdp, product: ver.product, extId: id, log: () => log, close }
  } catch (e) {
    await close()
    throw new Error(`${e.message}\n── 浏览器 stderr ──\n${log.split('\n').slice(-20).join('\n')}`)
  }
}

/** 跑装好的 cb，回 JSON；失败抛错 */
export function cb(cbFile, ...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cbFile, ...args, '--json'], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error(`cb 输出不是 JSON：${stdout.slice(0, 200)}`)) }
    })
  })
}

/** 宿主和插件的日志目录（和宿主同一个约定） */
export function bridgeDir() {
  return process.env.DSH_BRIDGE_DIR || (WIN ? path.join(os.tmpdir(), 'dsh-bridge') : `/tmp/dsh-bridge-${process.getuid()}`)
}

export function tail(file, n = 30) {
  try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n') } catch { return `（没有 ${file}）` }
}

export function dumpLogs(extra = '') {
  const dir = bridgeDir()
  console.log(`\n── 宿主日志 ──\n${tail(path.join(dir, 'dsh-bridge.log'))}`)
  console.log(`\n── 插件日志 ──\n${tail(path.join(dir, 'plugin.log'))}`)
  if (extra) console.log(`\n${extra}`)
}
