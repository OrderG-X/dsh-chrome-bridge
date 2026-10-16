/**
 * 图片限额守卫的离线测试：不跑 DSH，直接把 plugin/index.js 挂上的
 * request-error 监听器 / image-offload 投影拿出来验。
 *
 *   node scratch/test-image-guard.mjs
 */

import assert from 'node:assert'
import { apply } from '../plugin/index.js'

const image = (offloaded) => (offloaded ? { type: 'image', offloaded: true, attachment: 'x' } : { type: 'image', attachment: 'x' })
const text = () => ({ type: 'text', text: 'hi' })

/** 假 ctx：工具注册 + 事件监听 + sessions 服务（投影注册）。 */
function makeCtx({ alreadyRegistered = false } = {}) {
  const handlers = new Map()
  const registered = []
  const projections = alreadyRegistered ? [{ type: 'image/offload' }] : []
  const sessions = {
    messageProjections: projections,
    registerMessageProjection(projection) {
      if (projections.some((p) => p.type === projection.type)) {
        throw new Error(`session message projection "${projection.type}" is already registered`)
      }
      projections.push(projection)
      return () => {}
    },
  }
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    get: (name) => (name === 'sessions' ? sessions : undefined),
    inject: (_deps, cb) => cb(ctx),
    on: (event, fn) => handlers.set(event, fn),
    handlers,
    registered,
    sessions,
  }
  return ctx
}

/** 假 session：surface.nodes + eventAt/deriveEventMessage/append。 */
function makeSession(events) {
  const appended = []
  return {
    surface: { nodes: events.map((e) => e.seq) },
    eventAt: (seq) => events.find((e) => e.seq === seq),
    deriveEventMessage: (event) => ({ ...event.data, content: event.content }),
    append: (type, data) => appended.push({ type, data }),
    appended,
    events,
  }
}

const LIMIT_FAILURE = { message: '400: {"param":null,"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] Too many images in request: 65 > 64"}', code: 'INVALID_REQUEST' }

function hook(ctx, session) {
  const handler = ctx.handlers.get('agent/request-error')
  assert.ok(handler, '没注册 agent/request-error 监听器')
  let nextCalled = false
  const result = handler({ agent: { session }, failure: LIMIT_FAILURE }, () => {
    nextCalled = true
    return Promise.resolve(undefined)
  })
  return { result, nextCalled }
}

// ① 超限：65 > 64，多卸 8 张余量 → 从最老的事件开始卸 9 张，并返回 retry
{
  const events = [
    { seq: 1, type: 'user/message', data: { role: 'user' }, content: [text(), image(false)] },                        // 1 张
    { seq: 2, type: 'tool/result', data: { message: { role: 'tool' } }, content: [text(), ...Array.from({ length: 60 }, () => image(false))] }, // 60 张
    { seq: 3, type: 'assistant/message', data: { role: 'assistant' }, content: [image(false)] },                      // assistant 节点应跳过
    { seq: 4, type: 'tool/result', data: { message: { role: 'tool' } }, content: [image(false), image(false)] },       // 2 张
  ]
  const ctx = makeCtx()
  apply(ctx, {})
  assert.deepStrictEqual(ctx.sessions.messageProjections.map((p) => p.type), ['image/offload'], '应自己注册投影')

  const session = makeSession(events)
  const { result, nextCalled } = hook(ctx, session)
  assert.deepStrictEqual(await result, { kind: 'retry' }, '应返回 retry')
  assert.strictEqual(nextCalled, false, '不应把失败交给下游')
  assert.strictEqual(session.appended.length, 1, '应记一条 image/offload')
  assert.strictEqual(session.appended[0].type, 'image/offload')
  assert.deepStrictEqual(session.appended[0].data.targets, [
    { seq: 1, imageIndexes: [0] },
    { seq: 2, imageIndexes: [0, 1, 2, 3, 4, 5, 6, 7] },
  ])

  // 投影：被选中的图片要变成 offloaded: true，其它块原样
  const projection = ctx.sessions.messageProjections[0]
  const event = { type: 'image/offload', data: session.appended[0].data }
  const projected = projection.project(event, {
    nodes: events.map((e) => e.seq),
    events,
    baseSeq: 1,
    messages: new Map(events.map((e) => [e.seq, { ...e.data, content: e.content }])),
  })
  const m2 = projected.get(2)
  assert.strictEqual(m2.content.filter((b) => b.type === 'image' && b.offloaded === true).length, 8, 'seq 2 应有 8 张被卸下')
  assert.strictEqual(m2.content.filter((b) => b.type === 'image' && b.offloaded !== true).length, 52, '其余图片不动')
  assert.strictEqual(m2.content[0].type, 'text', '文本块不动')
  const m1 = projected.get(1)
  assert.strictEqual(m1.content[1].offloaded, true, 'seq 1 那张也要卸下')
  assert.strictEqual(Object.isFrozen(m1.content[1]), true, '投影结果要冻结')
  console.log('① 超限卸 9 张 + 投影标记 ✓')
}

// ② 已卸下的图片不重复计数（索引仍要数上它们）
{
  const events = [
    { seq: 1, type: 'tool/result', data: { message: {} }, content: [image(true), image(false), image(false)] },
    { seq: 2, type: 'tool/result', data: { message: {} }, content: [image(false)] },
  ]
  const ctx = makeCtx()
  apply(ctx, {})
  const session = makeSession(events)
  const { result } = hook(ctx, session)
  assert.deepStrictEqual(await result, { kind: 'retry' })
  assert.deepStrictEqual(session.appended[0].data.targets, [
    { seq: 1, imageIndexes: [1, 2] },
    { seq: 2, imageIndexes: [0] },
  ])
  console.log('② 跳过已卸下的 ✓')
}

// ③ 别的错误：原样交给下游
{
  const events = [{ seq: 1, type: 'tool/result', data: { message: {} }, content: [image(false)] }]
  const ctx = makeCtx()
  apply(ctx, {})
  const session = makeSession(events)
  const handler = ctx.handlers.get('agent/request-error')
  let nextCalled = false
  const action = await handler(
    { agent: { session }, failure: { message: 'context window exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' } },
    () => { nextCalled = true; return Promise.resolve(undefined) },
  )
  assert.strictEqual(nextCalled, true, '非图片错误应 next()')
  assert.strictEqual(action, undefined)
  assert.strictEqual(session.appended.length, 0)
  console.log('③ 别的错误放行 ✓')
}

// ④ 图片全卸完了：交给下游（不再无限重试）
{
  const events = [{ seq: 1, type: 'tool/result', data: { message: {} }, content: [image(true), image(true)] }]
  const ctx = makeCtx()
  apply(ctx, {})
  const session = makeSession(events)
  const { result, nextCalled } = hook(ctx, session)
  assert.strictEqual(nextCalled, true)
  assert.strictEqual(await result, undefined)
  console.log('④ 无图可卸放行 ✓')
}

// ⑤ 记不进 session（append 抛错）：别把整个轮次搞挂
{
  const events = [{ seq: 1, type: 'tool/result', data: { message: {} }, content: [image(false)] }]
  const ctx = makeCtx()
  apply(ctx, {})
  const session = makeSession(events)
  session.append = () => { throw new Error('requires a message projection') }
  const { nextCalled } = hook(ctx, session)
  assert.strictEqual(nextCalled, true)
  console.log('⑤ append 报错时放行 ✓')
}

// ⑥ 内置插件已经注册过投影：不能因为重名把插件搞挂
{
  const ctx = makeCtx({ alreadyRegistered: true })
  apply(ctx, {})
  assert.strictEqual(ctx.sessions.messageProjections.length, 1, '不该重复注册')
  const events = [{ seq: 1, type: 'tool/result', data: { message: {} }, content: [image(false)] }]
  const session = makeSession(events)
  const { result } = hook(ctx, session)
  assert.deepStrictEqual(await result, { kind: 'retry' })
  console.log('⑥ 投影已存在时不重复注册 ✓')
}

console.log('\n全部通过')
