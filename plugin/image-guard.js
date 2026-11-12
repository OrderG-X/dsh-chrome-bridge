/**
 * 图片限额守卫 —— 上游报「图片太多」时，把最老的几张卸下再重试这一轮。
 *
 * 背景：上游对单次请求的图片张数有硬上限（实测 64），超了直接 400：
 *   Too many images in request: 65 > 64
 * DSH 本来就有这套机制（`image/offload` 事件 + 内置 dsh-compaction-image-offload），
 * 但它只认适配器预检出来的 IMAGE_OFFLOAD_REQUIRED；而 pi-ai 这条路由（opencode-go）
 * 只按字节数预检、不管张数，于是错误直接砸到会话上，且每次重发还是那么多张 ——
 * 会话就此卡死，只能新开会话。
 *
 * 这个模块只补一件事：自己认这个错，记一条 `image/offload` 决策（卸掉最老的 N 张），让 loop 重试。
 * 解释这条决策的投影由内置 dsh-compaction-image-offload 注册（dsh-base 里一定有）。我们不再自己注册：
 * 以前抢先注册了同名投影，内置插件注册时撞名、整个没启动，它的两个兜底监听也跟着没了（issue #4）。
 * 万一真没有这个投影，append 会抛错，下面接住、交给下游，和没装这个插件一样。
 *
 * 不 import 任何外部包：profile 上下文里 `@deepseek-ai/*` 解析不可靠（踩过）。
 */

const IMAGE_LIMIT_RE = /too many images in request[^0-9]*(\d+)\s*>\s*(\d+)/i
/** 多卸几张，给这轮之后的截图留余量。 */
const OFFLOAD_MARGIN = 8

// ── 选谁卸：按请求顺序找最老的、还没卸下的图片出现位置 ──────────────────────

/** 这次失败要卸下几张图；不是图片超限就返回 0。 */
export function imagesToOffload(failure) {
  const text = `${(failure && failure.message) || ''} ${(failure && failure.code) || ''}`
  if (!/too many images/i.test(text)) return 0
  const m = IMAGE_LIMIT_RE.exec(text)
  if (!m) return OFFLOAD_MARGIN
  return Math.max(1, Number(m[1]) - Number(m[2])) + OFFLOAD_MARGIN
}

/** 按请求顺序挑出最老的 count 张还没卸下的图片，记一条 image/offload 决策。 */
export function offloadOldestImages(session, count) {
  const targets = []
  let marked = 0
  for (const seq of session.surface.nodes) {
    if (count <= 0) break
    const event = session.eventAt(seq)
    if (!event || (event.type !== 'user/message' && event.type !== 'tool/result')) continue
    const message = session.deriveEventMessage(event)
    const imageIndexes = []
    let imageIndex = 0
    for (const block of message.content) {
      if (count <= 0) break
      if (block.type === 'image') {
        if (block.offloaded !== true) {
          imageIndexes.push(imageIndex)
          count -= 1
          marked += 1
        }
        imageIndex += 1
      }
    }
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes })
  }
  if (targets.length === 0) return 0
  session.append('image/offload', { targets })
  return marked
}

// ── 挂上去 ──────────────────────────────────────────────────────────────────

/**
 * 挂 request-error 监听器（投影交给内置插件，见文件头）。
 * @param ctx 插件上下文
 * @param trace 日志函数
 */
export function installImageGuard(ctx, trace = () => {}) {
  ctx.on('agent/request-error', ({ agent, failure }, next) => {
    const count = imagesToOffload(failure)
    if (count <= 0) return next()
    try {
      const session = agent && agent.session
      if (!session) return next()
      const marked = offloadOldestImages(session, count)
      if (marked <= 0) {
        trace(`图片守卫：没有可卸下的图了（要求 ${count} 张）`)
        return next()
      }
      const sid = session.header?.id ?? session.id ?? '?'
      const shape = `${session.constructor?.name || 'obj'}/${(session.surface?.nodes || []).length}节点`
      trace(`图片超限（要求卸 ${count}，实际 ${marked}）：会话 ${sid} ${shape} keys=${Object.keys(session).slice(0, 12).join(',')} 重试本轮｜${String(failure && failure.message).slice(0, 160)}`)
      return Promise.resolve({ kind: 'retry' })
    } catch (e) {
      trace(`图片守卫没干活: ${e && e.message}`)
      return next()
    }
  })
}
