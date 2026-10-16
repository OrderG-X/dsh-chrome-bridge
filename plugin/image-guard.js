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
 * 这个模块补上两件事：
 *   1. 自己认这个错，记一条 `image/offload` 决策（卸掉最老的 N 张），让 loop 重试；
 *   2. 如果内置的投影插件没挂（`image/offload` 无人解释，append 会直接抛错），
 *      就把那份纯投影定义自己注册上 —— 语义和内置那份保持一致。
 *
 * 不 import 任何外部包：profile 上下文里 `@deepseek-ai/*` 解析不可靠（踩过）。
 */

const IMAGE_LIMIT_RE = /too many images in request[^0-9]*(\d+)\s*>\s*(\d+)/i
/** 多卸几张，给这轮之后的截图留余量。 */
const OFFLOAD_MARGIN = 8

// ── 选谁卸：按请求顺序找最老的、还没卸下的图片出现位置 ──────────────────────

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** 把一条消息里指定的图片出现位置标成已卸下（索引要数上已卸下的那些）。 */
function offloadMessageImages(message, indexes) {
  let imageIndex = 0
  let selected = 0
  const visit = (blocks) => {
    let next
    for (const [index, block] of blocks.entries()) {
      let projected = block
      if (block.type === 'image') {
        if (imageIndex === indexes[selected]) {
          if (block.offloaded === true) throw new Error(`image/offload: image index ${imageIndex} is already offloaded`)
          projected = { ...block, offloaded: true }
          selected += 1
        }
        imageIndex += 1
      }
      if (projected !== block) next ??= blocks.slice(0, index)
      if (next) next.push(projected)
    }
    return next ?? blocks
  }
  const content = visit(message.content)
  if (selected !== indexes.length) throw new Error(`image/offload: image index ${indexes[selected]} does not exist`)
  return deepFreeze({ ...message, content })
}

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

// ── 投影：和内置 dsh-compaction-image-offload 的纯定义同语义 ────────────────

/** 实时创建 / 恢复 / fork 都用它解释 `image/offload` 事件。 */
export const imageOffloadProjection = {
  type: 'image/offload',
  project(event, context) {
    const data = event.data
    if (!isRecord(data) || Object.keys(data).length !== 1 || !Array.isArray(data.targets) || data.targets.length === 0) {
      throw new Error('image/offload: data must contain a nonempty targets array')
    }
    const messages = new Map()
    const nodes = new Set(context.nodes)
    for (const target of data.targets) {
      if (!isRecord(target) || Object.keys(target).length !== 2 || !isIndex(target.seq) ||
          !Array.isArray(target.imageIndexes) || target.imageIndexes.length === 0) {
        throw new Error('image/offload: each target must contain a seq and nonempty imageIndexes')
      }
      const seq = target.seq
      if (messages.has(seq)) throw new Error(`image/offload: duplicate target seq ${seq}`)
      if (!nodes.has(seq)) throw new Error(`image/offload: target seq ${seq} is not a current surface node`)
      const source = context.events[seq - context.baseSeq]
      if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
        throw new Error(`image/offload: target seq ${seq} must be user/message or tool/result`)
      }
      let previous = -1
      for (const index of target.imageIndexes) {
        if (!isIndex(index) || index <= previous) {
          throw new Error('image/offload: imageIndexes must be strictly increasing non-negative safe integers')
        }
        previous = index
      }
      const message = context.messages.get(seq) ?? (source.type === 'user/message' ? source.data : source.data.message)
      messages.set(seq, offloadMessageImages(message, target.imageIndexes))
    }
    return messages
  },
}

// ── 挂上去 ──────────────────────────────────────────────────────────────────

/**
 * 注册投影 + request-error 监听器。
 * @param ctx 插件上下文
 * @param trace 日志函数
 */
export function installImageGuard(ctx, trace = () => {}) {
  const registerProjection = (sctx) => {
    const sessions = sctx.get ? sctx.get('sessions') : sctx.sessions
    if (!sessions || typeof sessions.registerMessageProjection !== 'function') return
    try {
      sessions.registerMessageProjection(imageOffloadProjection)
      trace('已注册 image/offload 投影（内置插件没挂，自己补一份）')
    } catch (e) {
      // 内置 dsh-compaction-image-offload 已经注册过，那就用它的
      trace(`image/offload 投影已存在，用内置的: ${e && e.message}`)
    }
  }
  if (typeof ctx.inject === 'function') ctx.inject(['sessions'], registerProjection)
  else registerProjection(ctx)

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
