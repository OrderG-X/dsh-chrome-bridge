/**
 * 给人看的界面文字（扩展弹窗、DSH 设置卡、扩展的商店摘要）三种语言是否对齐：
 *   ① 弹窗 popup.js 的 I18N：zh / en / ru 键一样（含 tool、op 两张小表），字符串里的 %占位符一样
 *   ② popup.html 里 data-i18n / data-i18n-title 用到的键、popup.js 里 T('…') 用到的键都在字典里
 *   ③ 设置卡 client.js 的 zh / en / ru 键一样、占位符一样
 *   ④ 扩展的 _locales：每种语言都有 extDescription、不超过 132 字；manifest 走 __MSG_extDescription__
 *   ⑤ 标签组：老版本的组名「DSH agent 正在操作」也认得（不然升级后老组拆不掉）
 * 纯读文件，不碰浏览器和宿主。
 *
 *   node scratch/test-ui-i18n.mjs
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT = path.join(ROOT, 'plugin/vendor/extension')
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

let failed = 0
function check(name, fn) {
  try { fn(); console.log(`✓ ${name}`) } catch (e) { failed++; console.log(`✗ ${name}\n  ${e.message}`) }
}

const holes = (v) => (typeof v === 'string' ? [...v.matchAll(/%([a-z])/g)].map((m) => m[1]).sort().join(',') : null)
function sameShape(dicts, where) {
  const [base, ...rest] = Object.keys(dicts)
  const keys = (o) => Object.keys(o).sort()
  for (const lang of rest) {
    assert.deepStrictEqual(keys(dicts[lang]), keys(dicts[base]), `${where}：${lang} 和 ${base} 的键不一样`)
    for (const k of keys(dicts[base])) {
      const a = dicts[base][k], b = dicts[lang][k]
      if (a && typeof a === 'object') { sameShape({ [base]: a, [lang]: b }, `${where}.${k}`); continue }
      assert.ok(typeof b === 'string' || typeof b === 'function', `${where}：${lang}.${k} 不是文字`)
      // 函数（带单复数的）不比占位符；两边都是字符串时要一样
      if (typeof a === 'string' && typeof b === 'string') {
        assert.strictEqual(holes(b), holes(a), `${where}：${lang}.${k} 的占位符和 ${base} 不一样`)
      }
      assert.ok(typeof b === 'function' || b.trim(), `${where}：${lang}.${k} 是空的`)
    }
  }
}

// ① ② 弹窗
const popupJs = read(path.join(EXT, 'popup.js'))
const dictSrc = popupJs.slice(popupJs.indexOf('const plural = {'), popupJs.indexOf('const LANG = '))
const I18N = new Function(`${dictSrc}; return I18N`)()
check('弹窗：中 / 英 / 俄 三份字典键一样、占位符一样', () => {
  assert.deepStrictEqual(Object.keys(I18N).sort(), ['en', 'ru', 'zh'])
  sameShape(I18N, 'popup')
})
check('弹窗：带单复数的函数都能算出文字', () => {
  for (const lang of Object.keys(I18N)) {
    for (const [k, v] of Object.entries(I18N[lang])) {
      if (typeof v !== 'function') continue
      for (const n of [0, 1, 2, 5, 11, 21, 22]) assert.ok(/\S/.test(v({ n })) && !/undefined/.test(v({ n })), `${lang}.${k}(${n})`)
    }
  }
})
check('弹窗：popup.html 和 popup.js 用到的键都在字典里', () => {
  const html = read(path.join(EXT, 'popup.html'))
  const used = new Set([
    ...[...html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((m) => m[1]),
    ...[...popupJs.matchAll(/\bT\('([a-zA-Z]+)'/g)].map((m) => m[1]),
  ])
  assert.ok(used.size > 40, `只找到 ${used.size} 个键，正则可能没对上`)
  const missing = [...used].filter((k) => !(k in I18N.zh))
  assert.deepStrictEqual(missing, [], `字典里没有：${missing.join(', ')}`)
})
check('弹窗：字典里的键都有人用（tool / op 两张表除外）', () => {
  const html = read(path.join(EXT, 'popup.html'))
  const unused = Object.keys(I18N.zh).filter((k) => !['tool', 'op'].includes(k)
    && !html.includes(`"${k}"`) && !popupJs.includes(`T('${k}'`))
  assert.deepStrictEqual(unused, [], `没人用：${unused.join(', ')}`)
})
check('弹窗：popup.js 字典以外不再有写死的中文（注释除外）', () => {
  const rest = popupJs.slice(0, popupJs.indexOf('const plural = {')) + popupJs.slice(popupJs.indexOf('const LANG = '))
  const bad = rest.split('\n').map((l, i) => [l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, ''), i])
    .filter(([l]) => !/^\s*\*/.test(l) && /[一-鿿]/.test(l))
  assert.deepStrictEqual(bad.map(([l]) => l.trim()), [])
})

// ③ 设置卡
const clientJs = read(path.join(ROOT, 'plugin/client.js'))
const cardDict = (name) => {
  const m = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n    \\})`).exec(clientJs)
  assert.ok(m, `client.js 里找不到 ${name}`)
  return new Function(`return ${m[1]}`)()
}
check('设置卡：中 / 英 / 俄 三份字典键一样、占位符一样，都注册了', () => {
  sameShape({ zh: cardDict('zh'), en: cardDict('en'), ru: cardDict('ru') }, 'card')
  assert.match(clientJs, /ctx\.locale\.register\(NS, \{ zh, en, ru \}\)/)
})

// ④ 扩展的 _locales
check('扩展：manifest 走 _locales，每种语言的摘要都在、不超过 132 字', () => {
  const m = JSON.parse(read(path.join(EXT, 'manifest.json')))
  assert.strictEqual(m.description, '__MSG_extDescription__')
  assert.strictEqual(m.default_locale, 'en')
  const locs = fs.readdirSync(path.join(EXT, '_locales'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  for (const need of ['en', 'ru', 'zh_CN']) assert.ok(locs.includes(need), `缺 _locales/${need}`)
  for (const loc of locs) {
    const msg = JSON.parse(read(path.join(EXT, '_locales', loc, 'messages.json'))).extDescription.message
    assert.ok(msg && [...msg].length <= 132, `_locales/${loc} 摘要为空或超过 132 字`)
  }
})

// ⑤ 标签组
check('标签组：几种语言的组名和老版本的组名都认作「我们的组」', () => {
  const bg = read(path.join(EXT, 'background.js'))
  assert.match(bg, /const OUR_GROUP_TITLES = new Set\(\[\.\.\.Object\.values\(GROUP_TITLES\), 'DSH agent 正在操作'\]\)/)
  assert.doesNotMatch(bg, /tabGroups\.query\(\{ title: GROUP_TITLE/, '按单个组名查会漏掉别的语言和老版本的组')
})

console.log(failed ? `\n${failed} 项没过` : '\n全部通过')
process.exit(failed ? 1 : 0)
