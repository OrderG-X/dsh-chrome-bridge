/**
 * 拖拽（browser_drag）。页面有两种「拖」，拖法不一样：
 *
 *   · 元素带 draggable="true" 的 HTML5 原生拖放：CDP 的鼠标事件在有界面的 Chrome 里
 *     起不了原生拖放会话，所以在页面里合成 dragstart → dragenter → dragover → drop → dragend，
 *     共用同一个 DataTransfer（页面在 dragstart 里塞的数据 drop 时拿得到）
 *   · 其它（滑块、排序列表、看板、画布……靠鼠标/指针事件的）：发真实的
 *     按下 → 分步移动 → 松开，Chrome 会顺带生成 pointer 事件
 *
 * 起点终点都能用编号 ref / selector / 可见文字 / 坐标给。放置区（"拖到这里"那种框）
 * 往往不是可点元素、snapshot 里没编号，所以按文字找最实用。
 */

import { refElementJs } from './refs.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 按可见文字找元素：包含这段文字、看得见的元素里面积最小的那个（最贴近文字本身）。 */
const textElementJs = (text) => `((t) => {
  let best = null, area = Infinity;
  for (const el of document.body.querySelectorAll('*')) {
    if (!(el.textContent || '').includes(t) || !(el.innerText || '').includes(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.width * r.height >= area) continue;
    best = el; area = r.width * r.height;
  }
  return best;
})(${JSON.stringify(String(text))})`

const hasRef = (end) => end.ref !== undefined && end.ref !== null

/** 端点 → 页内取元素的表达式；坐标端点返回 'null'。 */
const elementJs = (end) =>
  hasRef(end) ? refElementJs(end.ref)
    : end.selector ? `document.querySelector(${JSON.stringify(end.selector)})`
      : end.text ? textElementJs(end.text)
        : 'null'

const isElementEnd = (end) => hasRef(end) || !!end.selector || !!end.text
const describe = (end) =>
  hasRef(end) ? `[${end.ref}]` : end.selector || (end.text ? `「${end.text}」` : `(${end.x}, ${end.y})`)

/** 一次 eval 算出两端的视口坐标，顺带判断是不是原生拖放。 */
const PLAN_JS = (from, to) => `(async () => {
  const src = ${elementJs(from)};
  const dst = ${elementJs(to)};
  if (${isElementEnd(from)} && !src) return { missing: 'from' };
  if (${isElementEnd(to)} && !dst) return { missing: 'to' };
  if (src) {
    src.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    // 后台标签页会暂停 rAF，定时器兜底
    await new Promise((res) => { requestAnimationFrame(() => requestAnimationFrame(res)); setTimeout(res, 120); });
  }
  const mid = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const a = src ? mid(src) : { x: ${Number(from.x) || 0}, y: ${Number(from.y) || 0} };
  const b = dst ? mid(dst) : { x: ${Number(to.x) || 0}, y: ${Number(to.y) || 0} };
  const hit = src || document.elementFromPoint(a.x, a.y);
  const native = !!(hit && hit.closest && hit.closest('[draggable="true"]'));
  const inView = (p) => p.x >= 0 && p.y >= 0 && p.x <= innerWidth && p.y <= innerHeight;
  return { a, b, native, aIn: inView(a), bIn: inView(b) };
})()`

/** HTML5 原生拖放：页面里合成整套 DragEvent。 */
const NATIVE_JS = (from, to, a, b) => `(() => {
  const start = ${elementJs(from)} || document.elementFromPoint(${a.x}, ${a.y});
  const src = start.closest('[draggable="true"]') || start;
  const tgt = ${elementJs(to)} || document.elementFromPoint(${b.x}, ${b.y});
  if (!tgt) return { error: 'no-target' };
  const dt = new DataTransfer();
  const fire = (el, type, p) => el.dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, dataTransfer: dt,
  }));
  const A = { x: ${a.x}, y: ${a.y} }, B = { x: ${b.x}, y: ${b.y} };
  fire(src, 'dragstart', A);
  fire(tgt, 'dragenter', B);
  const accepted = !fire(tgt, 'dragover', B);   // 页面 preventDefault 了 dragover = 这里能放
  fire(tgt, 'drop', B);
  fire(src, 'dragend', B);
  return { accepted };
})()`

/**
 * @param from/to  { ref?, selector?, text?, x?, y? }
 * @param cursor   可选：页内光标 { move(x, y, { duration?, straight?, label? }) → 滑行 ms, down(), up() }，
 *                 让用户看得见在拖什么；任何一步出错都不影响真实拖拽
 */
export async function drag(call, tabId, from, to, { steps = 12, cursor } = {}) {
  const plan = (await call('eval', { tabId, expression: PLAN_JS(from, to) })).value
  if (!plan) throw new Error('页面没回话（可能刚跳转，重试一次）')
  if (plan.missing) {
    const end = plan.missing === 'from' ? from : to
    throw new Error(`没找到${plan.missing === 'from' ? '起点' : '终点'} ${describe(end)}` +
      (hasRef(end) ? '（编号可能已失效，重新 snapshot）' : ''))
  }
  const { a, b } = plan
  if (!plan.bIn) throw new Error(`终点 ${describe(to)} 不在当前屏幕里——先滚动让起点和终点都露出来`)

  const cur = async (fn) => {
    if (!cursor) return 0
    try { return Number(await fn(cursor)) || 0 } catch { return 0 }
  }
  // 光标先滑到起点亮名牌，到位了再按下
  if (cursor) await sleep(Math.min(700, await cur((c) => c.move(a.x, a.y, { label: `拖拽 ${describe(from)} → ${describe(to)}` }))) + 60)

  if (plan.native) {
    await cur((c) => c.down())
    await sleep(await cur((c) => c.move(b.x, b.y, { duration: 420, straight: true })))
    const r = (await call('eval', { tabId, expression: NATIVE_JS(from, to, a, b) })).value
    await cur((c) => c.up())
    if (r && r.error) throw new Error('终点那里没有元素')
    return `已拖拽 ${describe(from)} → ${describe(to)}（HTML5 拖放${r && r.accepted ? '，目标接受了' : '，但目标没表示接受——看看结果对不对'}）`
  }

  const mouse = (type, p, extra) => call('cdp', {
    tabId,
    method: 'Input.dispatchMouseEvent',
    params: { type, x: Math.round(p.x), y: Math.round(p.y), ...extra },
  })
  await mouse('mouseMoved', a, { button: 'none', buttons: 0 })
  await cur((c) => c.down())
  await mouse('mousePressed', a, { button: 'left', buttons: 1, clickCount: 1 })
  const n = Math.max(2, Math.min(60, Number(steps) || 12))
  await cur((c) => c.move(b.x, b.y, { duration: n * 24, straight: true }))   // 光标和真实鼠标一起走
  for (let i = 1; i <= n; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }
    await mouse('mouseMoved', p, { button: 'left', buttons: 1 })
    await sleep(16)
  }
  await mouse('mouseReleased', b, { button: 'left', buttons: 0, clickCount: 1 })
  await cur((c) => c.up())
  return `已拖拽 ${describe(from)} → ${describe(to)}：(${Math.round(a.x)}, ${Math.round(a.y)}) → (${Math.round(b.x)}, ${Math.round(b.y)})`
}
