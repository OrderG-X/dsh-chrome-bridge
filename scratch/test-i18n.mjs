// 校验 plugin/i18n/ 的三种语言字典和 index.js 的调用点是否一致。
// 用法：node scratch/test-i18n.mjs
//
// 证明这些事：
// ① zh / en / ru 的键完全一致（谁少一个键，运行时就悄悄退回中文，很难发现）
// ② 同一条文案的 %占位符集合一致（少一个占位符，那句英文/俄文就丢了参数）
// ③ 每个值都非空；en 里没有中文；ru 里是西里尔字母
// ④ 字典是扁平的「键 → 字符串」，没有嵌套（t() 只做一次查表）
// ⑤ index.js 里 t('…') 引用的键全都在 zh 里有；反过来 zh 里的键也都被用到（防拼错键名）
// ⑥ index.js 里工具描述 / 参数说明 / 报错这层不再有写死的中文
// ⑦ createT() / normalizeLocale() 的兜底：认不出的语言回 zh，缺键回 zh，缺占位符回 zh，未知键返回键名

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DICTS, LOCALES, DEFAULT_LOCALE, normalizeLocale, placeholders, fmt, createT } from '../plugin/i18n/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const INDEX_JS = path.join(here, '..', 'plugin', 'index.js')
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/

let failures = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`✓ ${name}`)
  } else {
    console.log(`✗ ${name}${extra ? `\n    ${extra}` : ''}`)
    failures++
  }
}

const zhKeys = Object.keys(DICTS.zh).sort()

// ① 键一致
for (const locale of LOCALES) {
  const keys = Object.keys(DICTS[locale]).sort()
  const missing = zhKeys.filter((k) => !(k in DICTS[locale]))
  const extra = keys.filter((k) => !(k in DICTS.zh))
  check(`${locale}: 键和 zh 一致（${keys.length} 个）`, missing.length === 0 && extra.length === 0,
    `缺少 ${missing.length}: ${missing.slice(0, 8).join(', ')} | 多出 ${extra.length}: ${extra.slice(0, 8).join(', ')}`)
}

// ② 占位符一致
for (const locale of LOCALES) {
  const bad = []
  for (const k of zhKeys) {
    const want = [...placeholders(DICTS.zh[k])].sort().join(',')
    const got = [...placeholders(DICTS[locale][k] ?? '')].sort().join(',')
    if (want !== got) bad.push(`${k}: zh=[${want}] ${locale}=[${got}]`)
  }
  check(`${locale}: %占位符和 zh 一致`, bad.length === 0, bad.slice(0, 8).join('\n    '))
}

// ③ 值非空 / 语言特征
for (const locale of LOCALES) {
  const empties = zhKeys.filter((k) => !String(DICTS[locale][k] ?? '').trim())
  check(`${locale}: 没有空值`, empties.length === 0, empties.slice(0, 8).join(', '))
}
const enCjk = zhKeys.filter((k) => CJK.test(DICTS.en[k] ?? ''))
check('en: 没有残留中文', enCjk.length === 0, enCjk.map((k) => `${k}=${JSON.stringify(DICTS.en[k])}`).join('\n    '))
// 只有标点/占位符的值（hint.notes 这种）不需要翻译，跳过
const ruNoCyr = zhKeys.filter((k) => {
  const bare = String(DICTS.ru[k] ?? '').replace(/%[A-Za-z_]\w*/g, '')
  return /[A-Za-z\u3400-\u4dbf\u4e00-\u9fff]/.test(bare) && !/[\u0400-\u04ff]/.test(bare)
})
check('ru: 都是西里尔字母', ruNoCyr.length === 0, ruNoCyr.slice(0, 8).join(', '))
const ruCjk = zhKeys.filter((k) => CJK.test(DICTS.ru[k] ?? ''))
check('ru: 没有残留中文', ruCjk.length === 0, ruCjk.map((k) => `${k}=${JSON.stringify(DICTS.ru[k])}`).join('\n    '))

// ④ 扁平结构
const nested = LOCALES.flatMap((locale) => Object.entries(DICTS[locale])
  .filter(([, v]) => typeof v !== 'string' || v === null)
  .map(([k, v]) => `${locale}.${k}=${typeof v}`))
check('字典是扁平的键→字符串', nested.length === 0, nested.slice(0, 8).join(', '))
check(`DICTS / LOCALES 覆盖 zh、en、ru（默认 ${DEFAULT_LOCALE}）`,
  LOCALES.join(',') === 'zh,en,ru' && DEFAULT_LOCALE === 'zh' && LOCALES.every((l) => DICTS[l] && (l in DICTS)))

// ⑤ index.js 引用的键都在字典里；字典里的键也都被引用
const source = fs.readFileSync(INDEX_JS, 'utf8')
const used = new Set([...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]))
const unknown = [...used].filter((k) => !(k in DICTS.zh))
check('index.js 用到的键都在字典里', unknown.length === 0, unknown.join(', '))
const unusedKeys = zhKeys.filter((k) => !used.has(k))
check('字典里的键都被 index.js 用到（防多余 / 拼错）', unusedKeys.length === 0, unusedKeys.join(', '))

// ⑥ 模型可见的那层没有写死中文：描述 / 参数说明 / 报错都走 t()
const cjkDescriptions = [...source.matchAll(/(?:^\s*description:|[{,]\s*description:)\s*([^\n]*)/gm)]
  .map((m) => m[1])
  .filter((tail) => CJK.test(tail))
check('没有写死中文的 description', cjkDescriptions.length === 0, cjkDescriptions.slice(0, 5).join('\n    '))
const cjkErrors = [...source.matchAll(/new Error\(([^\n]*)/g)]
  .map((m) => m[1])
  .filter((tail) => CJK.test(tail))
check('没有写死中文的 new Error', cjkErrors.length === 0, cjkErrors.slice(0, 5).join('\n    '))
check('description 都从 t() 取（12 个工具 × 参数）',
  (source.match(/description: t\(/g) || []).length >= 70,
  `实际 ${(source.match(/description: t\(/g) || []).length} 处`)

// ⑦ 兜底行为
const tZh = createT(undefined)
const tEn = createT('en')
const tRu = createT('ru_RU')
check('createT(undefined) 就是中文', tZh('param.tab') === DICTS.zh['param.tab'])
check('createT("en") 生效', tEn('param.tab') === DICTS.en['param.tab'] && tEn('param.tab') !== DICTS.zh['param.tab'])
check('createT("ru_RU") 认成 ru', tRu('param.tab') === DICTS.ru['param.tab'])
check('认不出的语言退回中文', createT('de')('param.tab') === DICTS.zh['param.tab'] && createT('')('param.tab') === DICTS.zh['param.tab'])
check('未知键返回键名（不抛错、不返回 undefined）', tZh('no.such.key') === 'no.such.key')
const tMissing = createT('en', { ...DICTS, en: {} })
check('缺键的翻译退回中文', tMissing('param.tab') === DICTS.zh['param.tab'])
const tDropped = createT('en', { ...DICTS, en: { ...DICTS.en, 'err.badTab': 'Tab must be a tab id or "active"' } })
check('翻译漏了 %占位符时退回中文',
  tDropped('err.badTab', { tab: 'x' }) === fmt(DICTS.zh['err.badTab'], { tab: 'x' }))
check('fmt() 替换 %name，缺变量原样留着',
  fmt('%a-%b', { a: 1 }) === '1-%b' && fmt('%a', {}) === '%a')
check('normalizeLocale: en-US / EN / ru_RU / ru-RU / 空',
  normalizeLocale('en-US') === 'en' && normalizeLocale('EN') === 'en' && normalizeLocale('ru_RU') === 'ru' &&
  normalizeLocale('ru-RU') === 'ru' && normalizeLocale(undefined) === DEFAULT_LOCALE && normalizeLocale(null) === DEFAULT_LOCALE)
check('占位符支持多字母、不吃普通百分号',
  [...placeholders('%how 就到，100% 完成，%max')].join(',') === 'how,max')

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
