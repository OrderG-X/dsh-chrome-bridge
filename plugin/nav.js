/**
 * 后退 / 前进 / 刷新（browser_nav），以及「等文字 / 等网址 / 等消失」（browser_wait）。
 *
 * 全在插件这层用 eval + cdp 两个现成 op 拼出来。
 * 怎么知道新页面到了：动手前在旧页面的 window 上做个记号，记号没了（换了文档）
 * 或者网址变了（单页应用只改历史记录、不换文档）并且 readyState=complete，就算到了。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function historyNav(call, tabId, action, timeoutMs = 20000) {
  // 只读的探测不带 userGesture（不白送页面一次「用户激活」）
  const ev = async (expression) => (await call('eval', { tabId, expression, userGesture: false })).value
  const before = await ev('(window.__dshNavMark = Date.now(), location.href)')

  if (action === 'reload') {
    await call('cdp', { tabId, method: 'Page.reload', params: {} })
  } else {
    const h = (await call('cdp', { tabId, method: 'Page.getNavigationHistory', params: {} })).result
    const i = h.currentIndex + (action === 'back' ? -1 : 1)
    if (i < 0 || i >= h.entries.length) {
      throw new Error(action === 'back' ? '已经是第一页了，没法后退' : '已经是最后一页了，没法前进')
    }
    await call('cdp', { tabId, method: 'Page.navigateToHistoryEntry', params: { entryId: h.entries[i].id } })
  }

  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    await sleep(250)
    try {
      last = await ev('({ mark: !!window.__dshNavMark, ready: document.readyState, url: location.href, title: document.title })')
    } catch {
      continue // 跳转途中执行上下文没了，下一轮再看
    }
    if (last && last.ready === 'complete' && (!last.mark || last.url !== before)) return { ...last, done: true }
  }
  return { ...(last || { url: before, title: '' }), done: false }
}

const VISIBLE_JS = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
})()`

/** 轮询直到条件成立（gone=true 时等它不成立）。返回等了多久；超时抛错。 */
export async function waitUntil(call, tabId, { selector, text, url, gone = false, timeoutMs = 15000 }) {
  let cond, what
  if (text !== undefined) {
    cond = `(document.body ? document.body.innerText : '').includes(${JSON.stringify(text)})`
    what = `文字「${text}」`
  } else if (url !== undefined) {
    cond = `location.href.includes(${JSON.stringify(url)})`
    what = `网址包含「${url}」`
  } else {
    cond = VISIBLE_JS(selector)
    what = selector
  }
  const expression = gone ? `!(${cond})` : `!!(${cond})`
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await call('eval', { tabId, expression, userGesture: false })).value) {
        return `${gone ? '已经没有' : '等到了'} ${what}，用了 ${Date.now() - start}ms`
      }
    } catch {
      // 页面正在跳转，执行上下文没了 —— 下一轮再看
    }
    await sleep(300)
  }
  throw new Error(`等了 ${timeoutMs}ms，${what} ${gone ? '还在' : '还没出现'}`)
}
