/**
 * 控制台 / 网络 / 返回内容 —— 调试网页用（browser_devtools）。
 *
 * 记录都在扩展里（console + JS 报错 + 浏览器日志一个环形缓冲，网络请求一个），这里只负责取和排版。
 * 只记得到调试器接上之后的事；不过接上那一刻 V8 会把之前的 console 和报错补发一遍，
 * 所以看 console 前先 attach 一下就能拿到「打开页面以来」的输出。网络请求没有补发，要 reload。
 */

const time = (ms) => new Date(ms).toTimeString().slice(0, 8)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LEVELS = {
  error: ['error', 'assert'],
  warning: ['error', 'assert', 'warning', 'warn'],
}

/** "http://x.com/static/app.js?v=3:12" → "app.js?v=3:12" */
const shortWhere = (w) => {
  const m = /([^/]+)$/.exec(String(w || ''))
  return m ? m[1].slice(0, 60) : ''
}

export async function consoleLog(call, tabId, { level = 'all', filter, limit = 40 } = {}) {
  await call('attach', { tabId })
  await sleep(300) // 等 V8 补发完旧消息
  const r = await call('console', { tabId, limit: 300 })
  let items = r.items || []
  if (LEVELS[level]) items = items.filter((c) => LEVELS[level].includes(c.level))
  if (filter) {
    const f = String(filter).toLowerCase()
    items = items.filter((c) => `${c.level} ${c.text} ${c.where || ''}`.toLowerCase().includes(f))
  }
  const total = items.length
  items = items.slice(-limit)
  if (!items.length) return level === 'all' && !filter ? '(控制台没有输出)' : '(没有匹配的条目)'
  const lines = items.map((c) => {
    const tag = c.kind === 'exception' ? '[未捕获] ' : c.kind && c.kind !== 'console' ? `[${c.kind}] ` : ''
    const where = c.where ? `  (${shortWhere(c.where)})` : ''
    return `${time(c.at)} ${String(c.level).padEnd(7)} ${tag}${c.text}${where}`
  })
  const head = total > items.length ? `最近 ${items.length} 条（共 ${total} 条）` : `${items.length} 条`
  return `${head}\n${lines.join('\n')}`
}

export async function networkLog(call, tabId, { filter, reload = false, limit = 40 } = {}) {
  const r = await call('network', { tabId, limit: 400, reload: !!reload, waitMs: 2500 }, 30000)
  let items = r.items || []
  if (filter) {
    const f = String(filter).toLowerCase()
    items = items.filter((n) => `${n.method} ${n.status} ${n.type} ${n.url}`.toLowerCase().includes(f))
  }
  const total = items.length
  items = items.slice(-limit)
  if (!items.length) {
    return filter ? '(没有匹配的请求)' : '(还没记到请求——只记调试器接上之后的；传 reload=true 刷新一次就能抓到页面加载的全部请求)'
  }
  const hasId = items.some((n) => n.id)
  const lines = items.map((n) => {
    const status = n.failed ? `✗ ${n.failed}` : String(n.status ?? '…')
    const ms = n.ms !== undefined ? `${n.ms}ms` : ''
    const url = n.url.length > 150 ? n.url.slice(0, 149) + '…' : n.url
    return `${hasId ? `#${n.id} ` : ''}${n.method} ${status} ${String(n.type || '').toLowerCase()} ${ms} ${url}`
  })
  const head = (total > items.length ? `最近 ${items.length} 个请求（共 ${total} 个）` : `${items.length} 个请求`) +
    (hasId ? '；看返回内容：action=response，request 传 # 后面的编号' : '；扩展版本旧，看不了返回内容——重载一下扩展')
  return `${head}\n${lines.join('\n')}`
}

export async function responseBody(call, tabId, requestId, limit = 6000) {
  if (!requestId) throw new Error('action=response 需要 request（action=network 列出的 # 编号）')
  const id = String(requestId).replace(/^#/, '')
  let r
  try {
    r = await call('cdp', { tabId, method: 'Network.getResponseBody', params: { requestId: id } })
  } catch (e) {
    if (/No resource|No data found|identifier/i.test(e.message)) {
      throw new Error('拿不到这个请求的返回内容（太早了被清掉、请求还没完成，或调试器断开过）——action=network reload=true 重抓一次')
    }
    throw e
  }
  const { body = '', base64Encoded } = r.result || {}
  if (base64Encoded) return `(二进制内容，约 ${Math.round((body.length * 3) / 4 / 1024)}KB——不是文字)`
  let text = body
  const t = body.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try { text = JSON.stringify(JSON.parse(t), null, 2) } catch {}
  }
  return text.length > limit ? text.slice(0, limit) + `\n…（截断，全文 ${text.length} 字）` : text || '(空)'
}

export async function clearLogs(call, tabId) {
  await call('console', { tabId, clear: true })
  await call('network', { tabId, clear: true })
  return '已清空控制台和网络记录'
}
