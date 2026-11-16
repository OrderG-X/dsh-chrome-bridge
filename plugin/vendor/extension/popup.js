/**
 * DSH Bridge 弹窗：连没连上、哪些会话在用、动了哪些标签页、最近做了什么。
 * 数据全在 background.js 里（buildState），这里每秒拉一次。
 * 状态卡和开关是固定骨架、只改文字和 class（整块重画会让呼吸灯、流动线、开关动画每秒从头播）；
 * 会话和动作列表内容变了才重画。
 */

const $ = (id) => document.getElementById(id)

const svg = (body, view = '0 0 16 16', attrs = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"') =>
  `<svg viewBox="${view}" ${attrs}>${body}</svg>`

const ICON = {
  check: svg('<path d="M3.6 8.4l2.9 2.9 5.9-6.4"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"'),
  pause: svg('<rect x="4.2" y="3.5" width="2.6" height="9" rx="1"/><rect x="9.2" y="3.5" width="2.6" height="9" rx="1"/>', '0 0 16 16', 'fill="currentColor"'),
  bang: svg('<path d="M8 3.6v5.6"/><path d="M8 12.2v.1"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"'),
  dots: svg('<circle cx="4" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12" cy="8" r="1.3"/>', '0 0 16 16', 'fill="currentColor"'),
  open: svg('<path d="M6 3.5h6.5V10"/><path d="M12.5 3.5 4 12"/>'),
  release: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  x: svg('<path d="M5 5l6 6M11 5l-6 6"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"'),
  person: svg('<circle cx="8" cy="5.4" r="2.4"/><path d="M3.6 13.2c.6-2.4 2.3-3.7 4.4-3.7s3.8 1.3 4.4 3.7"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"'),
  bubble: svg('<path d="M3 11.5V6.2a3.2 3.2 0 0 1 3.2-3.2h3.6A3.2 3.2 0 0 1 13 6.2v1.6a3.2 3.2 0 0 1-3.2 3.2H6l-3 2.5z"/><path d="M6.2 7.2h.01M9.8 7.2h.01"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'),
  term: svg('<path d="M3.5 5l3 3-3 3"/><path d="M8.5 11.5h4"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'),
  question: svg('<path d="M5.8 6a2.3 2.3 0 1 1 3.3 2c-.7.4-1.1.9-1.1 1.7"/><path d="M8 12.3v.1"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"'),
  globe: svg('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12"/>', '0 0 16 16', 'fill="none" stroke="currentColor" stroke-width="1.3"'),
  cursor: svg('<path fill="currentColor" d="M5 3.4v15.4c0 .75.9 1.12 1.42.58l3.6-3.76 2.9 5.94c.24.48.82.68 1.3.45l1.9-.92c.48-.23.68-.8.45-1.28l-2.88-5.9 5.2-.18c.77-.03 1.13-.97.56-1.5L6.64 2.7C6.08 2.18 5 2.6 5 3.4z"/>', '0 0 24 24', ''),
}

// ── 文字：按 Chrome 的界面语言选 中 / 英 / 俄（zh* → 中文，ru* → 俄文，其它 → 英文）──────────
// 值是字符串（%n、%a 之类单个字母的占位符会被替换）或函数。三份的键要一致（scratch/test-ui-i18n.mjs 会查）。

const plural = {
  zh: (n, w) => w,
  en: (n, [one, many]) => (n === 1 ? one : many),
  ru: (n, [one, few, many]) => {
    const a = n % 10, b = n % 100
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many
  },
}

const I18N = {
  zh: {
    tagline: '让 DSH 用你的 Chrome 干活',
    checking: '正在检查…',
    reconnect: '重新连接',
    nodeHost: '本机程序',
    pause: '允许 DSH 控制浏览器',
    pauseHint: '关掉后，DSH 碰不了浏览器',
    cursor: '页面里显示 DSH 光标',
    cursorHint: '只管显示，关掉也照常操作',
    window: '新页开在单独窗口',
    windowHint: '关掉就开在你当前窗口的后台',
    sessions: '正在用浏览器的对话',
    activity: '最近操作',
    releaseAll: '全部放开',
    copyReport: '复制问题报告',
    extReady: '已就绪',
    hostOk: '正常',
    hostUp: '已运行 %t',
    hostOff: '没连上',
    hostNotReady: '没准备好',
    hostLinked: '已连接',
    dshUsed: '%a用过',
    dshLinked: '已连上',
    dshWait: '等它来用',
    offTitle: '还没连上 DSH',
    offSub: 'DSH 现在用不了浏览器',
    offExplain: '先在 DSH 的「插件」页装上「Chrome 浏览器控制」，重启 DSH，再点右上角的 ↻（重新连接）。还不行，就在 DSH 里让它用一下浏览器，它会告诉你差哪一步。',
    pausedTitle: '已暂停',
    pausedSub: 'DSH 现在碰不了你的浏览器',
    onTitle: '已连接',
    onSub: '正在控制 %n 个标签页',
    idleSub: '待命中，没在控制标签页',
    noReply: '扩展没响应',
    noReplySub: '到 chrome://extensions 里把 DSH Bridge 关掉再打开',
    tabDialog: '被弹窗挡住了',
    tabReleased: '已放开',
    tabBusy: '操作中',
    tabIdle: '空闲 · %t后自动放开',
    tabIdleNow: '空闲 · 马上自动放开',
    showTab: '切过去看看',
    releaseTab: '放开：不再控制，标签页留着',
    untitled: '（无标题）',
    cli: '命令行工具',
    unknown: '来源不明',
    unknownMeta: '正被控制，但不知道是哪个对话',
    conv: '对话 %i',
    dshApp: 'DSH 桌面端',
    ops: '%n 次操作',
    fails: '%n 次失败',
    tabsN: '%n 个标签页',
    noTabs: '没在控制标签页',
    emptyTitle: '还没有对话在用浏览器',
    emptySub: '在 DSH 里让它操作浏览器，这里会实时显示它在动哪些标签页。',
    showAll: '全部 %n',
    collapse: '收起',
    noActivity: '还没有操作',
    failed: '失败',
    reconnected: '已重新连接',
    stillOff: '还是没连上',
    released: '已放开，标签页还在',
    releasedAll: '全部放开了',
    copied: '问题报告已复制，可以直接发给开发者',
    noReport: '拿不到问题报告',
    copyFail: '复制失败，浏览器没给剪贴板权限',
    pausedToast: '已暂停：DSH 碰不了浏览器了',
    resumedToast: '已恢复：DSH 可以用浏览器了',
    cursorOn: '页面里会显示 DSH 的光标',
    cursorOff: '光标藏起来了，DSH 照常干活',
    windowOn: 'DSH 新开的页会放进一个单独窗口',
    windowOff: 'DSH 新开的页会开在你当前窗口的后台',
    agoNow: '刚刚',
    agoS: '%n 秒前', agoM: '%n 分钟前', agoH: '%n 小时前', agoD: '%n 天前',
    spanS: '%n 秒', spanM: '%n 分钟', spanH: '%n 小时',
    tool: {
      browser_tabs: '标签页', browser_read: '读页面', browser_click: '点击', browser_input: '输入',
      browser_nav: '跳转', browser_screenshot: '截图', browser_eval: '运行脚本', browser_wait: '等待',
      browser_dialog: '弹窗', browser_drag: '拖拽', browser_devtools: '开发者工具', browser_download: '下载',
    },
    op: {
      tabs: '列标签页', open: '开标签页', close: '关标签页', activate: '切标签页', text: '读文字', html: '读网页源码',
      attr: '读属性', info: '页面信息', eval: '运行脚本', click: '点击', clickEl: '点击', clickText: '点击',
      type: '打字', key: '按键', select: '选下拉', upload: '传文件', focus: '聚焦', hover: '悬停', scroll: '滚动',
      nav: '跳转', shot: '截图', waitFor: '等元素', dialog: '处理弹窗', console: '看控制台', network: '看网络请求',
      cursor: '光标', attach: '开始控制', detach: '放开', screencast: '录屏', userRelease: '你放开了',
      'cdp:Input.dispatchMouseEvent': '鼠标', 'cdp:Page.captureScreenshot': '截图', 'cdp:Page.reload': '刷新',
      'cdp:Page.navigateToHistoryEntry': '后退/前进', 'cdp:Network.getResponseBody': '看返回内容',
    },
  },
  en: {
    tagline: 'Lets DSH work in your Chrome',
    checking: 'Checking…',
    reconnect: 'Reconnect',
    nodeHost: 'Local helper',
    pause: 'Let DSH control the browser',
    pauseHint: 'Off: DSH can\'t touch the browser',
    cursor: 'Show the DSH cursor',
    cursorHint: 'Off: just hidden; DSH keeps working',
    window: 'New pages in a separate window',
    windowHint: 'Off: background tabs in your current window',
    sessions: 'Conversations using the browser',
    activity: 'Recent actions',
    releaseAll: 'Release all',
    copyReport: 'Copy report',
    extReady: 'Ready',
    hostOk: 'Running',
    hostUp: 'Up for %t',
    hostOff: 'Not connected',
    hostNotReady: 'Not ready',
    hostLinked: 'Connected',
    dshUsed: 'Used %a',
    dshLinked: 'Linked',
    dshWait: 'Waiting',
    offTitle: 'Not connected to DSH',
    offSub: 'DSH can\'t use the browser right now',
    offExplain: 'Add "Chrome Bridge" on the Plugins page in DSH, restart DSH, then click ↻ (Reconnect) at the top right. Still stuck? Ask DSH to use the browser and it will tell you which step is missing.',
    pausedTitle: 'Paused',
    pausedSub: 'DSH can\'t touch your browser right now',
    onTitle: 'Connected',
    onSub: (v) => `Controlling ${v.n} ${plural.en(v.n, ['tab', 'tabs'])}`,
    idleSub: 'Standing by, no tabs under control',
    noReply: 'The extension isn\'t responding',
    noReplySub: 'Turn DSH Bridge off and on again in chrome://extensions',
    tabDialog: 'Blocked by a dialog',
    tabReleased: 'Released',
    tabBusy: 'Working',
    tabIdle: 'Idle · auto-release in %t',
    tabIdleNow: 'Idle · releasing now',
    showTab: 'Show this tab',
    releaseTab: 'Release: stop controlling it, keep the tab',
    untitled: '(untitled)',
    cli: 'Command-line tool',
    unknown: 'Unknown source',
    unknownMeta: 'Under control, but by which conversation is unknown',
    conv: 'Conversation %i',
    dshApp: 'DSH desktop',
    ops: (v) => `${v.n} ${plural.en(v.n, ['action', 'actions'])}`,
    fails: '%n failed',
    tabsN: (v) => `${v.n} ${plural.en(v.n, ['tab', 'tabs'])}`,
    noTabs: 'no tabs under control',
    emptyTitle: 'No conversation is using the browser',
    emptySub: 'Ask DSH to use the browser and you\'ll see here which tabs it is working in.',
    showAll: 'All %n',
    collapse: 'Less',
    noActivity: 'Nothing yet',
    failed: 'Failed',
    reconnected: 'Reconnected',
    stillOff: 'Still not connected',
    released: 'Released; the tab stays open',
    releasedAll: 'Released all tabs',
    copied: 'Report copied; paste it into your bug report',
    noReport: 'Couldn\'t build the report',
    copyFail: 'Copy failed: no clipboard permission',
    pausedToast: 'Paused: DSH can\'t touch the browser',
    resumedToast: 'Resumed: DSH can use the browser',
    cursorOn: 'The DSH cursor will show on pages',
    cursorOff: 'Cursor hidden; DSH keeps working',
    windowOn: 'New pages from DSH go into a separate window',
    windowOff: 'New pages from DSH open as background tabs here',
    agoNow: 'just now',
    agoS: '%ns ago', agoM: '%n min ago', agoH: '%n h ago', agoD: '%n d ago',
    spanS: '%ns', spanM: '%n min', spanH: '%n h',
    tool: {
      browser_tabs: 'Tabs', browser_read: 'Read page', browser_click: 'Click', browser_input: 'Type',
      browser_nav: 'Navigate', browser_screenshot: 'Screenshot', browser_eval: 'Run script', browser_wait: 'Wait',
      browser_dialog: 'Dialog', browser_drag: 'Drag', browser_devtools: 'DevTools', browser_download: 'Download',
    },
    op: {
      tabs: 'List tabs', open: 'Open tab', close: 'Close tab', activate: 'Switch tab', text: 'Read text', html: 'Read HTML',
      attr: 'Read attribute', info: 'Page info', eval: 'Run script', click: 'Click', clickEl: 'Click', clickText: 'Click',
      type: 'Type', key: 'Key press', select: 'Select', upload: 'Upload', focus: 'Focus', hover: 'Hover', scroll: 'Scroll',
      nav: 'Navigate', shot: 'Screenshot', waitFor: 'Wait for element', dialog: 'Handle dialog', console: 'Console', network: 'Network',
      cursor: 'Cursor', attach: 'Take control', detach: 'Release', screencast: 'Record', userRelease: 'You released it',
      'cdp:Input.dispatchMouseEvent': 'Mouse', 'cdp:Page.captureScreenshot': 'Screenshot', 'cdp:Page.reload': 'Reload',
      'cdp:Page.navigateToHistoryEntry': 'Back/forward', 'cdp:Network.getResponseBody': 'Response body',
    },
  },
  ru: {
    tagline: 'DSH работает в вашем Chrome',
    checking: 'Проверка…',
    reconnect: 'Переподключить',
    nodeHost: 'Помощник',
    pause: 'Разрешить управлять браузером',
    pauseHint: 'Выкл.: DSH не может трогать браузер',
    cursor: 'Показывать курсор DSH',
    cursorHint: 'Выкл.: курсор скрыт, работа идёт',
    window: 'Новые страницы в отдельном окне',
    windowHint: 'Выкл.: фоновые вкладки в текущем окне',
    sessions: 'Диалоги, которые работают с браузером',
    activity: 'Последние действия',
    releaseAll: 'Отпустить все',
    copyReport: 'Копировать отчёт',
    extReady: 'Готово',
    hostOk: 'Работает',
    hostUp: 'Работает %t',
    hostOff: 'Нет связи',
    hostNotReady: 'Не готов',
    hostLinked: 'Подключён',
    dshUsed: '%a',
    dshLinked: 'На связи',
    dshWait: 'Ожидание',
    offTitle: 'Нет связи с DSH',
    offSub: 'Сейчас DSH не может работать с браузером',
    offExplain: 'Добавьте «Chrome Bridge» на странице «Плагины» в DSH, перезапустите DSH и нажмите ↻ («Переподключить») справа вверху. Не помогло — попросите DSH открыть браузер, и он скажет, чего не хватает.',
    pausedTitle: 'Пауза',
    pausedSub: 'Сейчас DSH не может трогать ваш браузер',
    onTitle: 'Подключено',
    onSub: 'Вкладок под управлением: %n',
    idleSub: 'Ожидание, вкладок под управлением нет',
    noReply: 'Расширение не отвечает',
    noReplySub: 'Выключите и снова включите DSH Bridge в chrome://extensions',
    tabDialog: 'Мешает диалоговое окно',
    tabReleased: 'Отпущена',
    tabBusy: 'В работе',
    tabIdle: 'Простой · отпустит через %t',
    tabIdleNow: 'Простой · сейчас отпустит',
    showTab: 'Показать вкладку',
    releaseTab: 'Отпустить: перестать управлять, вкладка останется',
    untitled: '(без названия)',
    cli: 'Командная строка',
    unknown: 'Источник неизвестен',
    unknownMeta: 'Под управлением, но неизвестно, какого диалога',
    conv: 'Диалог %i',
    dshApp: 'DSH (приложение)',
    ops: 'действий: %n',
    fails: 'ошибок: %n',
    tabsN: 'вкладок: %n',
    noTabs: 'вкладок нет',
    emptyTitle: 'Пока ни один диалог не работает с браузером',
    emptySub: 'Попросите DSH поработать в браузере — здесь будет видно, какие вкладки он трогает.',
    showAll: 'Все %n',
    collapse: 'Свернуть',
    noActivity: 'Пока ничего',
    failed: 'Ошибка',
    reconnected: 'Переподключено',
    stillOff: 'Связи по-прежнему нет',
    released: 'Отпущено, вкладка осталась',
    releasedAll: 'Все вкладки отпущены',
    copied: 'Отчёт скопирован — вставьте его в сообщение об ошибке',
    noReport: 'Не удалось собрать отчёт',
    copyFail: 'Не удалось скопировать: нет доступа к буферу обмена',
    pausedToast: 'Пауза: DSH не может трогать браузер',
    resumedToast: 'Возобновлено: DSH может работать с браузером',
    cursorOn: 'Курсор DSH будет виден на страницах',
    cursorOff: 'Курсор скрыт, DSH продолжает работу',
    windowOn: 'Новые страницы DSH откроются в отдельном окне',
    windowOff: 'Новые страницы DSH откроются фоном в текущем окне',
    agoNow: 'только что',
    agoS: '%n сек. назад', agoM: '%n мин. назад', agoH: '%n ч. назад', agoD: '%n дн. назад',
    spanS: '%n сек.', spanM: '%n мин.', spanH: '%n ч.',
    tool: {
      browser_tabs: 'Вкладки', browser_read: 'Чтение', browser_click: 'Клик', browser_input: 'Ввод',
      browser_nav: 'Переход', browser_screenshot: 'Скриншот', browser_eval: 'Скрипт', browser_wait: 'Ожидание',
      browser_dialog: 'Диалог', browser_drag: 'Перетаскивание', browser_devtools: 'DevTools', browser_download: 'Загрузка',
    },
    op: {
      tabs: 'Список вкладок', open: 'Открыть вкладку', close: 'Закрыть вкладку', activate: 'Переключить вкладку', text: 'Текст', html: 'HTML',
      attr: 'Атрибут', info: 'Сведения', eval: 'Скрипт', click: 'Клик', clickEl: 'Клик', clickText: 'Клик',
      type: 'Ввод', key: 'Клавиша', select: 'Выбор', upload: 'Файл', focus: 'Фокус', hover: 'Наведение', scroll: 'Прокрутка',
      nav: 'Переход', shot: 'Скриншот', waitFor: 'Ожидание элемента', dialog: 'Диалог', console: 'Консоль', network: 'Сеть',
      cursor: 'Курсор', attach: 'Начало управления', detach: 'Отпустить', screencast: 'Запись', userRelease: 'Вы отпустили',
      'cdp:Input.dispatchMouseEvent': 'Мышь', 'cdp:Page.captureScreenshot': 'Скриншот', 'cdp:Page.reload': 'Обновить',
      'cdp:Page.navigateToHistoryEntry': 'Назад/вперёд', 'cdp:Network.getResponseBody': 'Ответ сервера',
    },
  },
}

const LANG = (() => {
  let l = ''
  try { l = String(chrome.i18n.getUILanguage() || '') } catch {}
  if (!l) l = navigator.language || ''
  l = l.toLowerCase()
  return l.startsWith('zh') ? 'zh' : l.startsWith('ru') ? 'ru' : 'en'
})()
const D = I18N[LANG]

/** 取文字：缺键回落中文；%x（单个字母）换成 vars.x —— 「%ns ago」里的 s 不算占位符 */
function T(key, vars = {}) {
  const v = key in D ? D[key] : I18N.zh[key]
  if (typeof v === 'function') return v(vars)
  return String(v ?? key).replace(/%([a-z])/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

/** 静态文字：popup.html 里带 data-i18n / data-i18n-title 的 */
function applyStatic() {
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : LANG
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = T(el.dataset.i18nTitle)
    el.setAttribute('aria-label', el.title)
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 5) return T('agoNow')
  if (s < 60) return T('agoS', { n: s })
  if (s < 3600) return T('agoM', { n: Math.floor(s / 60) })
  if (s < 86400) return T('agoH', { n: Math.floor(s / 3600) })
  return T('agoD', { n: Math.floor(s / 86400) })
}

function span(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return T('spanS', { n: s })
  if (s < 3600) return T('spanM', { n: Math.floor(s / 60) })
  return T('spanH', { n: Math.floor(s / 3600) })
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8)

function host(url) {
  try {
    const u = new URL(url)
    return u.protocol.startsWith('http') ? u.host : u.protocol.replace(':', '')
  } catch {
    return ''
  }
}

/** 会话编号只留前 4 位（够分辨同时在跑的几个），全称放悬停提示里 */
const shortId = (raw) => String(raw).replace(/^session-/, '').slice(0, 4)

/** 内容真变了才动 DOM：不打断悬停、按下、动画 */
function setHTML(el, html) {
  if (el.__html === html) return
  el.__html = html
  el.innerHTML = html
}
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text
}
function setClass(el, cls) {
  if (el.className !== cls) el.className = cls
}

// ── 状态卡 ──────────────────────────────────────────────────────────────────

function renderStatus(st) {
  const h = st.host
  const dshRecent = h && h.lastClientAt && st.now - h.lastClientAt < 10 * 60e3
  const lastDsh = st.sessions.find((s) => s.kind === 'dsh')

  const hostSub = !st.connected ? T('hostOff') : h ? (h.socketOk ? T('hostOk') : T('hostNotReady')) : T('hostLinked')
  const hostTip = h && h.socketOk && h.startedAt ? T('hostUp', { t: span(st.now - h.startedAt) }) : hostSub
  const hostCls = !st.connected || (h && !h.socketOk) ? 'off' : 'on'
  const dshSub = !st.connected ? '—' : lastDsh ? T('dshUsed', { a: ago(lastDsh.last, st.now) }) : dshRecent ? T('dshLinked') : T('dshWait')
  const dshCls = !st.connected ? 'idle' : lastDsh || dshRecent ? 'on' : 'idle'

  const node = (id, cls, sub, tip = sub) => {
    const el = $(id)
    setClass(el, `node ${cls}`)
    const small = el.querySelector('small')
    setText(small, sub)
    small.title = tip
  }
  node('nExt', 'on', T('extReady'), `DSH Bridge v${st.version}`)
  node('nHost', hostCls, hostSub, hostTip)
  node('nDsh', dshCls, dshSub)
  setClass($('w1'), `wire ${st.connected ? 'on' : 'off'}`)
  setClass($('w2'), `wire ${hostCls === 'on' && dshCls === 'on' ? 'on' : ''}`)

  let mood, icon, title, sub, extra = ''
  if (!st.connected) {
    mood = 'bad'; icon = 'bang'; title = T('offTitle'); sub = T('offSub')
    extra = `<p class="explain">${esc(T('offExplain'))}</p>`
  } else if (st.paused) {
    mood = 'warn'; icon = 'pause'; title = T('pausedTitle'); sub = T('pausedSub')
  } else {
    const n = st.attachedCount
    mood = 'ok'; icon = 'check'; title = T('onTitle'); sub = n ? T('onSub', { n }) : T('idleSub')
  }
  setClass($('status'), `card hero ${mood}`)
  setHTML($('orb'), ICON[icon])
  setText($('stTitle'), title)
  setText($('stSub'), sub)
  setHTML($('stExtra'), extra)
}

function renderSettings(st) {
  const pause = document.querySelector('input[data-act="pause"]')
  const cursor = document.querySelector('input[data-act="cursor"]')
  if (pause.checked !== !st.paused) pause.checked = !st.paused
  const showCursor = st.showCursor !== false
  if (cursor.checked !== showCursor) cursor.checked = showCursor
  const win = document.querySelector('input[data-act="window"]')
  const ownWindow = st.ownWindow !== false
  if (win.checked !== ownWindow) win.checked = ownWindow
}

// ── 会话 ────────────────────────────────────────────────────────────────────

function tabState(t, st) {
  if (t.dialog) return `<span class="state warn">${esc(T('tabDialog'))}</span>`
  if (!t.attached) return `<span class="state gone">${esc(T('tabReleased'))}</span>`
  if (t.busy || st.now - t.lastUsed < 2500) return `<span class="state busy">${esc(T('tabBusy'))}</span>`
  const left = Math.max(0, st.idleMs - (st.now - t.lastUsed))
  return `<span class="state idle">${esc(left >= 1000 ? T('tabIdle', { t: span(Math.ceil(left / 1000) * 1000) }) : T('tabIdleNow'))}</span>`
}

/** 加载失败过的 favicon：每秒重画时别再试一次（不然会一闪一闪） */
const badFav = new Set()

function favicon(t) {
  const u = t.favIconUrl
  const inner = u && /^(https?:|data:)/.test(u) && !badFav.has(u) ? `<img class="fav" src="${esc(u)}" alt="">` : ICON.globe
  return `<span class="fav-tile">${inner}</span>`
}

function tabRow(t, st) {
  const where = host(t.url)
  return `<div class="row tab ${t.attached ? '' : 'released'}">
    ${favicon(t)}
    <span class="row-main">
      <span class="row-title" title="${esc(t.title)}">${esc(t.title || t.url || T('untitled'))}</span>
      <span class="row-sub">${esc(where)}${where ? ' · ' : ''}${tabState(t, st)}</span>
    </span>
    <span class="acts">
      <button class="icon-btn" type="button" data-act="focus" data-tab="${t.id}" title="${esc(T('showTab'))}" aria-label="${esc(T('showTab'))}">${ICON.open}</button>
      ${t.attached ? `<button class="icon-btn danger" type="button" data-act="release" data-tab="${t.id}" title="${esc(T('releaseTab'))}" aria-label="${esc(T('releaseTab'))}">${ICON.release}</button>` : ''}
    </span>
  </div>`
}

function who(s) {
  if (s.kind === 'cli') return { tile: '<span class="tile gray">' + ICON.term + '</span>', name: esc(T('cli')) }
  if (s.kind === 'other') return { tile: '<span class="tile orange">' + ICON.question + '</span>', name: esc(T('unknown')) }
  return {
    tile: '<span class="tile blue">' + ICON.bubble + '</span>',
    name: s.session ? `<span title="${esc(s.session)}">${esc(T('conv', { i: shortId(s.session) }))}</span>` : esc(T('dshApp')),
  }
}

const opsText = (s) => `${esc(T('ops', { n: s.ops }))}${s.errors ? ` · <span class="err">${esc(T('fails', { n: s.errors }))}</span>` : ''}`
const meta = (s, st) => s.kind === 'other' ? esc(T('unknownMeta')) : `${esc(ago(s.last, st.now))} · ${opsText(s)}`

/** 半小时没动静、手上也没标签页的会话不占地方 */
const STALE_MS = 30 * 60e3

function renderSessions(st) {
  const list = st.sessions.filter((s) => s.tabs.length || st.now - s.last < STALE_MS)
  if (st.orphans.length) {
    list.unshift({ key: 'orphans', kind: 'other', session: null, pid: null, last: 0, ops: 0, errors: 0, tabs: st.orphans })
  }
  setText($('sessCount'), String(list.length))
  if (!list.length) {
    setHTML($('sessions'), `<div class="card empty">
      <span class="tile blue">${ICON.cursor}</span>
      <b>${esc(T('emptyTitle'))}</b>
      <span>${esc(T('emptySub'))}</span>
    </div>`)
    return
  }
  // 手上有标签页的会话各占一张卡；只是最近来过、手上空着的，挤进同一张卡里一行一个
  const busy = list.filter((s) => s.tabs.length)
  const idle = list.filter((s) => !s.tabs.length)
  const cards = busy.map((s) => {
    const live = s.tabs.filter((t) => t.attached).length
    const w = who(s)
    return `<div class="card list sess">
      <div class="row sess-head">
        ${w.tile}
        <span class="row-main"><span class="row-title">${w.name}</span><span class="row-sub">${meta(s, st)}</span></span>
        <span class="cap ${live ? 'on' : ''}">${esc(T('tabsN', { n: live }))}</span>
      </div>
      ${s.tabs.map((t) => tabRow(t, st)).join('')}
    </div>`
  })
  if (idle.length) {
    cards.push(`<div class="card list sess">${idle.map((s) => {
      const w = who(s)
      return `<div class="row">
        ${w.tile}
        <span class="row-main"><span class="row-title">${w.name}</span><span class="row-sub">${opsText(s)} · ${esc(T('noTabs'))}</span></span>
        <span class="ago">${esc(ago(s.last, st.now))}</span>
      </div>`
    }).join('')}</div>`)
  }
  setHTML($('sessions'), cards.join(''))
}

// ── 最近动作 ────────────────────────────────────────────────────────────────

let showAllActivity = false

function renderActivity(st) {
  const all = st.activity
  const items = showAllActivity ? all : all.slice(0, 6)
  $('moreAct').hidden = all.length <= 6
  setText($('moreAct'), showAllActivity ? T('collapse') : T('showAll', { n: all.length }))
  if (!all.length) {
    setHTML($('activity'), `<li class="row act-empty">${esc(T('noActivity'))}</li>`)
    return
  }
  setHTML($('activity'), items.map((a) => {
    const label = a.tool ? D.tool[a.tool] || a.tool : D.op[a.op] || a.op
    const user = a.key === 'user'
    const ms = a.ms >= 1000 ? `${(a.ms / 1000).toFixed(1)}s` : `${a.ms}ms`
    const sub = [a.title, clock(a.at)].filter(Boolean).map(esc).join(' · ')
    return `<li class="row act ${a.ok ? '' : 'fail'} ${user ? 'user' : ''}" title="${esc([a.hint, a.title, a.error].filter(Boolean).join('\n'))}">
      <span class="mk">${user ? ICON.person : a.ok ? ICON.check : ICON.x}</span>
      <span class="main"><b>${esc(label)}</b> <span class="hint">${esc(a.hint || '')}</span></span>
      <span class="ms">${user ? '' : ms}</span>
      <span class="sub">${sub}</span>
      ${a.ok ? '' : `<span class="why">${esc(a.error || T('failed'))}</span>`}
    </li>`
  }).join(''))
}

// ── 主循环 ──────────────────────────────────────────────────────────────────

let last = null

function render(st) {
  if (!st || st.error) {
    setClass($('status'), 'card hero bad')
    setHTML($('orb'), ICON.bang)
    setText($('stTitle'), T('noReply'))
    setText($('stSub'), T('noReplySub'))
    $('stSub').title = st && st.error ? String(st.error) : ''   // 原始报错放悬停里，排查时有线索
    return
  }
  last = st
  $('stSub').title = ''
  setText($('ver'), `v${st.version}`)
  renderStatus(st)
  renderSettings(st)
  renderSessions(st)
  renderActivity(st)
  $('releaseAll').disabled = !st.attachedCount
}

async function ask(popup, extra = {}) {
  try {
    return await chrome.runtime.sendMessage({ popup, ...extra })
  } catch (e) {
    return { error: String((e && e.message) || e) }
  }
}

let timer = null
async function tick() {
  render(await ask('state'))
}

function toast(text) {
  const t = $('toast')
  t.textContent = text
  t.classList.add('show')
  clearTimeout(toast.h)
  toast.h = setTimeout(() => t.classList.remove('show'), 1800)
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text)
    toast(done)
  } catch {
    toast(T('copyFail'))
  }
}

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]')
  if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'LABEL') return
  const act = btn.dataset.act
  const tabId = btn.dataset.tab ? Number(btn.dataset.tab) : undefined
  switch (act) {
    case 'reconnect':
      btn.classList.add('spin')
      render(await ask('reconnect'))
      setTimeout(() => btn.classList.remove('spin'), 500)
      toast(last && last.connected ? T('reconnected') : T('stillOff'))
      break
    case 'focus':
      render(await ask('focus', { tabId }))
      break
    case 'release':
      render(await ask('release', { tabId }))
      toast(T('released'))
      break
    case 'releaseAll':
      render(await ask('releaseAll'))
      toast(T('releasedAll'))
      break
    case 'diagnostics': {
      const r = await ask('diagnostics')
      if (r && r.text) copy(r.text, T('copied'))
      else toast(T('noReport'))
      break
    }
  }
})

document.addEventListener('change', async (ev) => {
  const input = ev.target.closest('input[data-act]')
  if (!input) return
  if (input.dataset.act === 'pause') {
    const pause = !input.checked
    render(await ask('pause', { on: pause }))
    toast(pause ? T('pausedToast') : T('resumedToast'))
  } else if (input.dataset.act === 'cursor') {
    render(await ask('cursor', { on: input.checked }))
    toast(input.checked ? T('cursorOn') : T('cursorOff'))
  } else if (input.dataset.act === 'window') {
    render(await ask('window', { on: input.checked }))
    toast(input.checked ? T('windowOn') : T('windowOff'))
  }
})

// 列表里 favicon 加载失败就换成小地球（CSP 不让写 onerror，只能在这里接）
document.addEventListener('error', (ev) => {
  const img = ev.target
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('fav')) return
  badFav.add(img.getAttribute('src'))
  const s = document.createElement('span')
  s.innerHTML = ICON.globe
  img.replaceWith(s.firstChild)
}, true)

$('moreAct').addEventListener('click', () => {
  showAllActivity = !showAllActivity
  if (last) renderActivity(last)
})

applyStatic()
tick()
timer = setInterval(tick, 1000)
addEventListener('unload', () => clearInterval(timer))
