/**
 * 元素编号（snapshot + ref）的实机测试：在真 Chrome 里后台开一个本地测试页，
 * 走插件注册的 browser_* 工具（和模型调的是同一份代码），测完关掉标签页。
 *
 *   node scratch/test-refs.mjs
 *
 * 要求：Chrome 开着、扩展已加载（/tmp/dsh-bridge-<uid>/dsh-bridge.sock 存在）。
 */

import assert from 'node:assert'
import http from 'node:http'
import fs from 'node:fs'
import { apply } from '../plugin/index.js'

const PAGE = `<!doctype html><meta charset="utf-8"><title>refs 测试页</title>
<style>.fake{cursor:pointer;padding:4px;border:1px solid #888;display:inline-block}
.cb{position:relative}.cb input{position:absolute;opacity:0;width:20px;height:20px;margin:0}</style>
<h1>编号测试</h1>
<a href="/next?x=1">下一页</a>
<button id="plus" onclick="window.n=(window.n||0)+1">加一</button>
<button style="display:none">藏起来的</button>
<label>邮箱 <input id="email" placeholder="name@example.com"></label>
<input type="password" aria-label="密码" value="secret">
<span class="cb"><input type="checkbox" id="agree"><label for="agree">同意条款</label></span>
<select id="city"><option value="bj">北京</option><option value="sh">上海</option></select>
<textarea aria-label="备注"></textarea>
<div class="fake" onclick="window.fake=1"><span>手搓按钮</span></div>
<div id="dbl" ondblclick="window.dblHit=1" style="cursor:pointer">双击我</div>
<div contenteditable="true" aria-label="编辑区"></div>
<div id="swap"><button onclick="this.parentNode.innerHTML='<button>换过了</button>'">会被换掉</button></div>
<x-widget></x-widget>
<script>
customElements.define('x-widget', class extends HTMLElement {
  connectedCallback() {
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<button onclick="window.shadowHit=1">影子按钮</button><input aria-label="影子输入">';
  }
});
</script>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`

const tools = new Map()
apply({
  tools: { register: (t) => tools.set(t.name, t) },
  get: () => undefined,
  inject: () => {},
  on: () => {},
}, {})
const run = async (name, args) => (await tools.get(name).execute(args)).text

let tab
const results = []
const check = async (title, fn) => {
  try { await fn(); results.push(`✅ ${title}`) } catch (e) { results.push(`❌ ${title}: ${e.message}`) }
}

try {
  const opened = await run('browser_tabs', { action: 'open', url })
  tab = String(/标签页 (\d+)/.exec(opened)[1])
  await run('browser_wait', { tab, selector: 'x-widget', timeoutMs: 15000 })
  const ev = async (expression) => (await run('browser_eval', { tab, expression })).trim()

  const snap = await run('browser_read', { tab, what: 'snapshot' })
  console.log(snap + '\n')
  const ref = (re) => {
    const m = new RegExp(`^\\[(\\d+)\\] ${re}`, 'm').exec(snap)
    assert.ok(m, `快照里没找到 ${re}`)
    return Number(m[1])
  }

  await check('快照：标题、链接、表单状态都列出来了', async () => {
    assert.match(snap, /^# 编号测试$/m)
    assert.match(snap, /link "下一页" → \/next\?x=1/)
    assert.match(snap, /textbox "邮箱" 提示"name@example.com"/)
    assert.match(snap, /textbox "密码" = ••••/)
    assert.doesNotMatch(snap, /secret/)
    assert.match(snap, /combobox = "北京"（2 个选项）/)
    assert.doesNotMatch(snap, /藏起来的/)
  })

  await check('点按钮（ref）', async () => {
    await run('browser_click', { tab, ref: ref('button "加一"') })
    assert.equal(await ev('String(window.n)'), '1')
  })

  await check('往输入框打字（ref）', async () => {
    await run('browser_input', { tab, action: 'type', ref: ref('textbox "邮箱"'), text: 'a@b.c' })
    assert.equal(await ev('document.querySelector("#email").value'), 'a@b.c')
  })

  await check('勾选透明的复选框（ref）', async () => {
    await run('browser_click', { tab, ref: ref('checkbox "同意条款"') })
    assert.equal(await ev('String(document.querySelector("#agree").checked)'), 'true')
  })

  await check('下拉选择（ref）', async () => {
    await run('browser_input', { tab, action: 'select', ref: ref('combobox'), value: '上海' })
    assert.equal(await ev('document.querySelector("#city").value'), 'sh')
  })

  await check('手搓的 div 按钮能认出来并点到', async () => {
    await run('browser_click', { tab, ref: ref('clickable "手搓按钮"') })
    assert.equal(await ev('String(window.fake)'), '1')
  })

  await check('双击（ref + count=2）', async () => {
    await run('browser_click', { tab, ref: ref('clickable "双击我"'), count: 2 })
    assert.equal(await ev('String(window.dblHit)'), '1')
  })

  await check('密码框按编号双击：明文不进工具结果', async () => {
    const t = await run('browser_click', { tab, ref: ref('textbox "密码"'), count: 2 })
    assert.doesNotMatch(t, /secret/, t)
  })

  await check('shadow DOM 里的按钮', async () => {
    await run('browser_click', { tab, ref: ref('button "影子按钮"') })
    assert.equal(await ev('String(window.shadowHit)'), '1')
  })

  await check('shadow DOM 里的输入框', async () => {
    await run('browser_input', { tab, action: 'type', ref: ref('textbox "影子输入"'), text: 'hi' })
    assert.equal(await ev('document.querySelector("x-widget").shadowRoot.querySelector("input").value'), 'hi')
  })

  await check('再拍一次快照，同一个元素编号不变', async () => {
    const again = await run('browser_read', { tab, what: 'snapshot' })
    assert.match(again, new RegExp(`^\\[${ref('button "加一"')}\\] button "加一"$`, 'm'))
    assert.match(again, /textbox "邮箱" = "a@b.c"/)
    assert.match(again, /checkbox "同意条款" \(已勾选\)/)
  })

  await check('元素被换掉后，旧编号报「已失效」', async () => {
    const old = ref('button "会被换掉"')
    await run('browser_click', { tab, ref: old })
    await assert.rejects(run('browser_click', { tab, ref: old }), /已失效/)
  })

  await check('元素截图（ref）', async () => {
    const t = await run('browser_screenshot', { tab, mode: 'element', ref: ref('button "加一"') })
    const file = /已存到 (\S+)，/.exec(t)?.[1]
    assert.ok(file && fs.statSync(file).size > 100, t)
    fs.unlinkSync(file)
  })

  // 下面两条测的是老路子（selector），确认后台标签页的修复对它们也生效
  await check('后台标签页：selector 点击真的生效', async () => {
    const before = Number(await ev('String(window.n)'))
    await run('browser_click', { tab, selector: '#plus' })
    assert.equal(Number(await ev('String(window.n)')), before + 1)
  })

  await check('后台标签页：selector 元素截图不卡', async () => {
    const t = await run('browser_screenshot', { tab, mode: 'element', selector: '#city' })
    const file = /已存到 (\S+)，/.exec(t)?.[1]
    assert.ok(file && fs.statSync(file).size > 100, t)
    fs.unlinkSync(file)
  })

  await check('selector 缩小范围', async () => {
    const part = await run('browser_read', { tab, what: 'snapshot', selector: 'x-widget' })
    assert.match(part, /影子按钮/)
    assert.doesNotMatch(part, /加一/)
  })
} finally {
  if (tab) await run('browser_tabs', { action: 'close', tab }).catch(() => {})
  server.close()
}

console.log(results.join('\n'))
if (results.some((r) => r.startsWith('❌'))) process.exit(1)
