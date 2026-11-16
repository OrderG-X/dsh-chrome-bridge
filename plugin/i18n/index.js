/**
 * 服务端 i18n：工具描述 / 参数说明 / 报错文案的多语言。
 *
 * 为什么不复用 DSH 的 locale 服务：那个（client-locale）只给浏览器端的界面文字用，
 * 工具是注册进模型上下文里的，注册那一刻就得是最终语言。所以这里自己拿字典，
 * 由 config.locale 选一份（见 index.js 的 apply）。
 *
 * 约定和 client.js 一致：字典是普通对象、zh 是基准、缺 key 回落 zh。
 * 占位符用 %name（不是 DSH 的 {name}，那个会跟宿主自己的插值撞），支持多字母。
 */

import zh from './zh.js'
import en from './en.js'
import ru from './ru.js'

/** 基准语言：别的字典缺 key 时回落到这里，也是 config.locale 没给/给错时的默认。 */
export const DEFAULT_LOCALE = 'zh'

export const DICTS = { zh, en, ru }
export const LOCALES = Object.keys(DICTS)

/** "en-US" / "EN" → "en"；认不出的（含空值）→ 基准语言，不报错。 */
export function normalizeLocale(value) {
  if (typeof value !== 'string') return DEFAULT_LOCALE
  const tag = value.trim().toLowerCase().split(/[-_]/)[0]
  return LOCALES.includes(tag) ? tag : DEFAULT_LOCALE
}

/** 模板里用到的占位符名字集合；t() 用它判断译文有没有漏掉参数，test-i18n.mjs 用它做对齐检查。 */
export function placeholders(template) {
  const found = String(template).match(/%[A-Za-z_]\w*/g) || []
  return new Set(found.map((s) => s.slice(1)))
}

/** %name 替换。没给值的占位符原样留着——漏参数要看得见，不能悄悄吞掉。 */
export function fmt(template, vars) {
  return String(template).replace(/%([A-Za-z_]\w*)/g, (m, key) => (vars && key in vars ? String(vars[key]) : m))
}

/**
 * 按语言造一个 t()。
 *   缺 key                → 回落 zh
 *   译文漏了 zh 用到的参数 → 同样回落 zh（不然报错里会少一段细节）
 *   key 在 zh 里也没有     → 原样返回 key（方便一眼看出是漏配）
 *
 * dicts 只在测试里传（造一份缺 key / 缺占位符的字典验证兜底），正常调用不用管。
 */
export function createT(locale, dicts = DICTS) {
  const base = dicts[DEFAULT_LOCALE] || DICTS[DEFAULT_LOCALE]
  const dict = dicts[normalizeLocale(locale)] || base
  return function t(key, vars) {
    let text = Object.hasOwn(dict, key) ? dict[key] : base[key]
    if (text === undefined) return key
    if (vars) {
      const needed = placeholders(base[key])
      if (needed.size) {
        const have = placeholders(text)
        if ([...needed].some((name) => !have.has(name))) text = base[key]
      }
      return fmt(text, vars)
    }
    return text
  }
}
