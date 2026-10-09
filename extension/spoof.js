/**
 * 时区 / 语言伪装 —— 跑在页面的主世界里，document_start 就注入。
 *
 * 为什么需要它：
 *   VPN 只换出口 IP。但浏览器还会告诉每个网站：
 *     Intl.DateTimeFormat().resolvedOptions().timeZone  → "Asia/Shanghai"
 *     new Date().toString()                             → "...GMT+0800 (中国标准时间)"
 *     navigator.language                                → "zh-CN"
 *   IP 在首尔、浏览器说中国 —— 这个**矛盾本身就是最强的特征**，
 *   比不用 VPN 还显眼。这里把这三样对齐到出口 IP 所在时区。
 *
 * 改的是浏览器，不动系统：你机器上的日历、文件时间戳全不受影响。
 *
 * 配置存在 chrome.storage.local：
 *   spoofEnabled  true/false
 *   spoofTimezone 例如 "Asia/Seoul"
 *   spoofLanguage 例如 "en-US"
 */

(() => {
  try { console.log('[dsh-spoof] 脚本已执行', location.href) } catch {}
  try { window.__dshSpoofRan = true } catch {}
  const DEFAULTS = { spoofEnabled: true, spoofTimezone: 'Asia/Seoul', spoofLanguage: 'en-US' };

  const apply = (cfg) => {
    const { spoofEnabled, spoofTimezone, spoofLanguage } = { ...DEFAULTS, ...cfg };
    if (!spoofEnabled) return;

    const TZ = spoofTimezone;
    const LANG = spoofLanguage;
    const LANGS = [LANG, LANG.split('-')[0]];

    // 真实偏移（分钟，UTC 以西为正）→ 目标偏移
    const realOffset = new Date().getTimezoneOffset();
    const targetOffset = offsetOf(TZ);
    const SHIFT = (realOffset - targetOffset) * 60000;   // 本地时间要加多少毫秒

    // 标准算法：拿目标时区的"墙上时间"当 UTC 反推偏移
    function offsetOf(zone) {
      try {
        const dtf = new Intl.DateTimeFormat('en-US', {
          timeZone: zone, hour12: false,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        const parts = {};
        for (const p of dtf.formatToParts(new Date())) parts[p.type] = p.value;
        const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
                               +parts.hour % 24, +parts.minute, +parts.second);
        return Math.round((Date.now() - asUTC) / 60000);
      } catch { return realOffset }
    }

    // ── 1. Intl：时区 / 语言 ──────────────────────────────────────────
    const DTF = Intl.DateTimeFormat;
    const origResolved = DTF.prototype.resolvedOptions;
    DTF.prototype.resolvedOptions = function () {
      const o = origResolved.call(this);
      try { o.timeZone = TZ; o.locale = LANG; } catch {}
      return o;
    };
    try {
      Intl.DateTimeFormat = function (...a) {
        if (!a.length) a = [LANG, { timeZone: TZ }];
        return new DTF(...a);
      };
      Intl.DateTimeFormat.prototype = DTF.prototype;
      Intl.DateTimeFormat.supportedLocalesOf = DTF.supportedLocalesOf;
    } catch {}

    // ── 2. Date：本地时间偏移 + 字符串 ────────────────────────────────
    const D = Date;
    const P = D.prototype;
    const realGetOffset = P.getTimezoneOffset;
    P.getTimezoneOffset = function () { return targetOffset; };

    // 把本地 getter 整体平移，避免"时区说首尔、getHours() 还是上海时间"这种自相矛盾
    const LOCAL = ['getHours', 'getMinutes', 'getSeconds', 'getMilliseconds',
                   'getDate', 'getDay', 'getMonth', 'getFullYear'];
    for (const name of LOCAL) {
      const orig = P[name];
      if (typeof orig !== 'function') continue;
      P[name] = function (...a) {
        if (!(this instanceof D) || Number.isNaN(this.getTime())) return orig.apply(this, a);
        const shifted = new D(this.getTime() + SHIFT);
        return orig.apply(shifted, a);
      };
    }

    const zoneName = { 'Asia/Seoul': 'Korean Standard Time', 'Asia/Tokyo': 'Japan Standard Time',
                       'America/Los_Angeles': 'Pacific Daylight Time', 'UTC': 'Coordinated Universal Time' }[TZ]
                   || TZ.replace('_', ' ');
    const tzAbbr = { 'Asia/Seoul': 'GMT+0900', 'Asia/Tokyo': 'GMT+0900', 'UTC': 'GMT+0000' }[TZ] || 'GMT+0900';

    const origToString = P.toString;
    P.toString = function () {
      if (Number.isNaN(this.getTime())) return origToString.call(this);
      const s = origToString.call(new D(this.getTime() + SHIFT));
      return s.replace(/GMT[+-]\d{4}[^)]*/, `${tzAbbr} (${zoneName})`);
    };
    const origToTimeString = P.toTimeString;
    P.toTimeString = function () {
      if (Number.isNaN(this.getTime())) return origToTimeString.call(this);
      const s = origToTimeString.call(new D(this.getTime() + SHIFT));
      return s.replace(/GMT[+-]\d{4}[^)]*/, `${tzAbbr} (${zoneName})`);
    };
    const origToDateString = P.toDateString;
    P.toDateString = function () {
      if (Number.isNaN(this.getTime())) return origToDateString.call(this);
      return origToDateString.call(new D(this.getTime() + SHIFT));
    };

    // ── 3. navigator 语言 ────────────────────────────────────────────
    const nav = navigator;
    for (const [key, val] of [['language', LANG], ['languages', LANGS], ['userLanguage', LANG]]) {
      try {
        Object.defineProperty(nav, key, { get: () => val, configurable: true });
      } catch {}
    }

    // 标记一下，方便自查
    try { Object.defineProperty(window, '__dshSpoof', { value: { timeZone: TZ, language: LANG }, configurable: true }) } catch {}
  };

  try {
    chrome.storage?.local?.get(DEFAULTS, (cfg) => { try { apply(cfg) } catch {} });
  } catch {
    apply(DEFAULTS);
  }
})();
