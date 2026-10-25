/**
 * 下载文件（browser_download）：带着用户在 Chrome 里的登录状态，把链接指向的文件存到本机。
 *
 * 只用宿主已有的 eval / cdp op —— 不改扩展，不加扩展权限（加权限得重新过商店审核，用户还要再点一次同意）。
 *
 * 两条路，先走第一条：
 *   ① 页面里 fetch（credentials: include）：和用户点链接一样走 Chrome 的网络（登录、代理、证书都一样），
 *      文件先留在页面里，再分块用 base64 读回来写盘。blob: / data: 链接只能走这条
 *   ② 跨站被 CORS / CSP 拦了：插件自己下，Cookie 用 CDP 的 Network.getCookies 按网址取（每一跳重定向都重取）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { refElementJs } from './refs.js'

const CHUNK = 2 * 1024 * 1024 // 页面里每次读回 2MB（base64 后约 2.7MB）
const PAGE_MAX = 300 * 1024 * 1024 // 页面里最多暂存这么大，再大走插件直接下
const TIMEOUT_MS = 10 * 60 * 1000

const EXT = {
  'application/pdf': '.pdf', 'text/csv': '.csv', 'application/zip': '.zip', 'application/json': '.json',
  'text/plain': '.txt', 'text/html': '.html', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-excel': '.xls', 'application/msword': '.doc',
}

/** Content-Disposition 里的文件名：filename*=UTF-8''… 优先，再 filename="…" */
export function dispositionName(header) {
  const h = String(header || '')
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(h)
  if (star) { try { return decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')) } catch {} }
  const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(h)
  if (plain) return (plain[2] !== undefined ? plain[2].replace(/\\(.)/g, '$1') : plain[1]).trim()
  return ''
}

/** 文件名能安全落盘：去掉路径分隔符、控制字符、开头的点（不做成隐藏文件），太长截断 */
export function safeName(name) {
  let n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+/, '').trim()
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 12)
    n = n.slice(0, 180 - ext.length) + ext
  }
  return n
}

/** 起名：给的名字 > 服务器给的 > 链接的 download 属性 > 网址最后一段；没扩展名就按类型补 */
export function pickName({ filename, disposition, suggested, url, type }) {
  let fromUrl = ''
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') fromUrl = decodeURIComponent(u.pathname.split('/').pop() || '')
  } catch {}
  let n = safeName(filename) || safeName(dispositionName(disposition)) || safeName(suggested) || safeName(fromUrl) || 'download'
  const ext = EXT[String(type || '').split(';')[0].trim().toLowerCase()]
  if (!path.extname(n) && ext) n += ext
  return n
}

/** 不覆盖已有文件：重名就加「 (1)」「 (2)」… */
export function uniquePath(dir, name) {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 0; i < 1000; i++) {
    const p = path.join(dir, i ? `${base} (${i})${ext}` : name)
    if (!fs.existsSync(p)) return p
  }
  throw new Error(`${dir} 里同名文件太多了：${name}`)
}

export function humanSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 默认存到「下载」文件夹（Windows、Mac、Linux 都是家目录下的 Downloads） */
export function downloadsDir() {
  return path.join(os.homedir(), 'Downloads')
}

/** 在页面里：要下载的是哪个网址（编号 / 选择器指的链接，或直接给的网址，相对地址按页面算） */
const TARGET_JS = ({ ref, selector, url }) => `(() => {
  const el = ${ref !== undefined && ref !== null ? refElementJs(ref) : selector ? `document.querySelector(${JSON.stringify(selector)})` : 'null'};
  ${(ref !== undefined && ref !== null) || selector ? "if (!el) return { error: 'gone' };" : ''}
  const raw = el ? (el.getAttribute('href') || el.getAttribute('src') || el.currentSrc || el.getAttribute('data') || '') : ${JSON.stringify(url || '')};
  if (!raw) return { error: 'nohref', tag: el ? el.tagName.toLowerCase() : '' };
  const base = el ? el.ownerDocument.baseURI : document.baseURI;
  let abs;
  try { abs = new URL(raw, base).href; } catch { return { error: 'badurl', raw }; }
  return { url: abs, page: location.href, ua: navigator.userAgent, lang: navigator.language,
    suggested: (el && el.getAttribute('download')) || '' };
})()`

/** 在页面里：fetch 下来先放在 window.__dshDl[id]，回大小和头 */
const FETCH_JS = (id, url) => `(async () => {
  try {
    const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    if (!r.ok) return { status: r.status };
    const len = Number(r.headers.get('content-length')) || 0;
    if (len > ${PAGE_MAX}) return { tooBig: true };
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > ${PAGE_MAX}) return { tooBig: true };
    (window.__dshDl || (window.__dshDl = {}))[${JSON.stringify(id)}] = buf;
    return { size: buf.length, type: r.headers.get('content-type') || '', disposition: r.headers.get('content-disposition') || '', finalUrl: r.url };
  } catch (e) {
    return { failed: String(e && e.message || e) };
  }
})()`

const CHUNK_JS = (id, offset) => `(() => {
  const b = window.__dshDl && window.__dshDl[${JSON.stringify(id)}];
  if (!b) return null;
  const part = b.subarray(${offset}, ${offset + CHUNK});
  let s = '';
  for (let i = 0; i < part.length; i += 0x8000) s += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
  return btoa(s);
})()`

const DROP_JS = (id) => `(() => { if (window.__dshDl) delete window.__dshDl[${JSON.stringify(id)}]; return true; })()`

/** ① 页面里取：成功回 { size, type, disposition, finalUrl }；被拦了回 null（换第二条路） */
async function viaPage(call, tabId, url, file) {
  const id = crypto.randomUUID()
  const r = (await call('eval', { tabId, expression: FETCH_JS(id, url), awaitPromise: true, userGesture: false }, TIMEOUT_MS)).value || {}
  if (r.status) throw new Error(`下载失败：服务器回 HTTP ${r.status}`)
  if (r.failed || r.tooBig) return null
  try {
    const fd = fs.openSync(file, 'w')
    try {
      for (let off = 0; off < r.size; off += CHUNK) {
        const b64 = (await call('eval', { tabId, expression: CHUNK_JS(id, off), userGesture: false })).value
        if (typeof b64 !== 'string') throw new Error('页面跳走了，下载中断')
        fs.writeSync(fd, Buffer.from(b64, 'base64'))
      }
    } finally {
      fs.closeSync(fd)
    }
  } finally {
    call('eval', { tabId, expression: DROP_JS(id), userGesture: false }).catch(() => {})
  }
  return r
}

/** ② 插件自己下，带上 Chrome 里这个网址的 Cookie（重定向每一跳都按新网址取） */
async function viaNode(call, tabId, target, file, fetchImpl = globalThis.fetch) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    let url = target.url
    let referer = target.page
    for (let hop = 0; hop < 10; hop++) {
      let cookie = ''
      try {
        const r = await call('cdp', { tabId, method: 'Network.getCookies', params: { urls: [url] } })
        cookie = ((r.result && r.result.cookies) || []).map((c) => `${c.name}=${c.value}`).join('; ')
      } catch {}
      const res = await fetchImpl(url, {
        redirect: 'manual',
        signal: ctl.signal,
        headers: {
          'user-agent': target.ua || 'Mozilla/5.0',
          'accept-language': target.lang || 'en',
          accept: '*/*',
          ...(referer ? { referer } : {}),
          ...(cookie ? { cookie } : {}),
        },
      })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        referer = url
        url = new URL(res.headers.get('location'), url).href
        continue
      }
      if (!res.ok || !res.body) throw new Error(`下载失败：服务器回 HTTP ${res.status}`)
      const out = fs.createWriteStream(file)
      let size = 0
      try {
        for await (const chunk of res.body) {
          size += chunk.length
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
        }
      } finally {
        await new Promise((r) => out.end(r))
      }
      return { size, type: res.headers.get('content-type') || '', disposition: res.headers.get('content-disposition') || '', finalUrl: url }
    }
    throw new Error('下载失败：重定向太多次')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @returns {{ file, size, type, via }}
 * @param opts.dir  存到哪个文件夹（调用方已经定好）
 */
export async function download(call, tabId, { url, ref, selector, filename, dir }, deps = {}) {
  if ((ref === undefined || ref === null) && !selector && !url) throw new Error('要给出 url、ref 或 selector 之一')
  const target = (await call('eval', { tabId, expression: TARGET_JS({ ref, selector, url }), userGesture: false })).value
  if (!target) throw new Error('页面没回应（可能刚跳转，重试一次）')
  if (target.error === 'gone') throw new Error(ref !== undefined && ref !== null ? `编号 ${ref} 已失效——重新 browser_read what=snapshot` : `没找到元素: ${selector}`)
  if (target.error === 'nohref') throw new Error(`这个 ${target.tag} 元素没有链接地址（href / src）。是按钮的话，先 browser_click 它，看会不会打开下载链接`)
  if (target.error === 'badurl') throw new Error(`网址不对：${target.raw}`)
  const proto = new URL(target.url).protocol
  if (!['http:', 'https:', 'blob:', 'data:'].includes(proto)) throw new Error(`不支持这种网址：${proto}`)

  fs.mkdirSync(dir, { recursive: true })
  const part = path.join(dir, `.dsh-download-${crypto.randomUUID()}.part`)
  try {
    let via = 'page'
    let meta = await viaPage(call, tabId, target.url, part)
    if (!meta) {
      if (proto === 'blob:' || proto === 'data:') throw new Error('页面里读不出这个文件（blob 链接可能已经失效：重新点一次生成它的按钮再试）')
      via = 'direct'
      meta = await viaNode(call, tabId, target, part, deps.fetch)
    }
    const name = pickName({ filename, disposition: meta.disposition, suggested: target.suggested, url: meta.finalUrl || target.url, type: meta.type })
    const file = uniquePath(dir, name)
    fs.renameSync(part, file)
    return { file, size: meta.size, type: meta.type, via }
  } finally {
    try { fs.rmSync(part, { force: true }) } catch {}
  }
}
