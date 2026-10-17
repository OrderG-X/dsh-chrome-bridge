// 页内光标浮层（v3）—— 让用户一眼看出 DSH 在页面里干什么
//
// 不是系统光标，是注进页面的一层 DOM：扩展用 Runtime.evaluate 注入一次，之后调：
//   window.__dshCursor.move(x, y, { duration?, straight? })  沿弧线滑到视口坐标，返回动画时长（ms）
//   window.__dshCursor.place(x, y)        直接摆过去（新页面接着上一页的位置出现）
//   window.__dshCursor.click(x, y, n)     按下 + 涟漪（n=2 双击两圈）
//   window.__dshCursor.press()            只做按下反馈
//   window.__dshCursor.down() / up()      拖拽：按住 / 松开
//   window.__dshCursor.label(text, ms)    名牌从「DSH」展开成「DSH · 点击 登录」，过会儿收回
//   window.__dshCursor.scroll(dy)         滚动提示
//   window.__dshCursor.pos()              当前位置 { x, y }
//   window.__dshCursor.hide()             淡出并移除
//
// 设计要点：
//   * 外观学多人协作工具（Figma 那种）：实心箭头 + 跟着走的名牌，谁在动一眼就知道
//   * 移动走一条轻微的弧线、先快后慢，距离越远走得越久（上限 0.65 秒）；跟点击的等待时间配套
//   * 动画全用 Web Animations（按时间算，不靠 requestAnimationFrame）：后台标签页 rAF 停了也不会卡在半路，
//     截图拍到的永远是该在的位置
//   * 进浏览器 top layer（popover）：页面开了模态框 / 全屏也盖不住它
//   * 自定义元素 + Shadow DOM + all:initial：页面 CSS 影响不到它；pointer-events:none：绝不挡真实点击
//   * 全用 DOM API 搭（不碰 innerHTML）：Gmail 这类开了 Trusted Types 的站点也能注入
//   * 一会儿没动作就变淡、名牌收起，不挡用户视线；系统开了「减少动态效果」就不做动画

(() => {
  const VERSION = 3;
  const TAG = 'dsh-cursor';
  const old = document.querySelector(TAG) || document.getElementById('__dsh_cursor__');
  if (old && window.__dshCursor && window.__dshCursor.version === VERSION && old.isConnected) return 'ready';
  let keep = null;
  if (old) {
    try { keep = window.__dshCursor && window.__dshCursor.pos && window.__dshCursor.pos(); } catch {}
    old.remove();   // 旧版本的光标换掉
  }

  const reduce = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const SVG = 'http://www.w3.org/2000/svg';
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  const host = document.createElement(TAG);
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'all:initial', 'display:block', 'position:fixed', 'inset:0 auto auto 0', 'width:0', 'height:0',
    'margin:0', 'padding:0', 'border:0', 'background:transparent', 'overflow:visible',
    'pointer-events:none', 'z-index:2147483647', 'contain:layout style',
  ].map((s) => s + ' !important').join(';');
  const sr = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .cur { position: fixed; left: 0; top: 0; width: 0; height: 0; pointer-events: none;
           transition: opacity .35s ease; will-change: transform; }
    .cur.idle { opacity: .45; }
    .cur.idle .what { max-width: 0; opacity: 0; padding-left: 0; }
    .arrow { position: absolute; left: -4px; top: -3px; width: 26px; height: 26px; overflow: visible;
             filter: drop-shadow(0 1.5px 2.5px rgba(16, 24, 64, .38)); transform-origin: 4px 3px; }
    .halo { position: absolute; left: -11px; top: -11px; width: 22px; height: 22px; border-radius: 50%;
            background: rgba(77, 107, 254, .22); border: 1.5px solid rgba(77, 107, 254, .7);
            opacity: 0; transform: scale(.4); transition: opacity .15s ease, transform .18s ease; }
    .cur.down .halo { opacity: 1; transform: scale(1); }
    .tag { position: absolute; left: 17px; top: 21px; display: flex; align-items: center; max-width: 280px;
           height: 22px; padding: 0 8px; border-radius: 4px 11px 11px 11px; box-sizing: border-box;
           background: linear-gradient(135deg, #5b77ff, #3e5cf5); color: #fff; white-space: nowrap;
           font: 600 11.5px/22px -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", system-ui, sans-serif;
           letter-spacing: .2px; box-shadow: 0 2px 8px rgba(30, 50, 160, .35), 0 0 0 1px rgba(255, 255, 255, .55);
           transition: opacity .2s ease; }
    .who { flex: none; }
    .what { display: inline-block; max-width: 0; opacity: 0; overflow: hidden; text-overflow: ellipsis;
            font-weight: 500; padding-left: 0;
            transition: max-width .32s cubic-bezier(.2, .8, .2, 1), opacity .2s ease, padding .32s ease; }
    .tag.open .what { max-width: 230px; opacity: 1; padding-left: 6px; }
    .what::before { content: "·"; margin-right: 6px; opacity: .7; }
    .ring { position: fixed; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
            border: 2px solid #4d6bfe; box-sizing: border-box; pointer-events: none; opacity: 0;
            box-shadow: 0 0 0 1px rgba(255, 255, 255, .7), inset 0 0 0 1px rgba(255, 255, 255, .5); }
    .dot { position: fixed; left: 0; top: 0; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
           background: #4d6bfe; box-shadow: 0 0 0 2px rgba(255, 255, 255, .9); pointer-events: none; opacity: 0; }
    .wheel { position: absolute; left: 20px; top: -26px; width: 20px; height: 20px; border-radius: 50%;
             background: #4d6bfe; color: #fff; display: grid; place-items: center; opacity: 0;
             box-shadow: 0 2px 6px rgba(30, 50, 160, .35); }
    .wheel svg { width: 12px; height: 12px; }
  `;

  const cur = el('div', 'cur');
  const halo = el('div', 'halo');

  // 箭头：圆角经典指针，蓝色渐变 + 白描边；尖端在 (4, 3)
  const arrow = svgEl('svg', { class: 'arrow', viewBox: '0 0 24 24', width: '26', height: '26' });
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: 'dshg', x1: '0', y1: '0', x2: '1', y2: '1' });
  grad.append(svgEl('stop', { offset: '0', 'stop-color': '#6f8bff' }), svgEl('stop', { offset: '1', 'stop-color': '#3552f2' }));
  defs.append(grad);
  arrow.append(defs, svgEl('path', {
    d: 'M4 3.2v16.1c0 .8.95 1.2 1.5.62l3.86-4.02 3.07 6.3c.25.5.86.71 1.36.47l2.04-.98c.5-.24.71-.84.47-1.34l-3.05-6.25 5.5-.2c.82-.03 1.2-1.03.6-1.6L5.65 2.5C5.06 1.95 4 2.37 4 3.2z',
    fill: 'url(#dshg)', stroke: '#fff', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'paint-order': 'stroke',
  }));

  const tag = el('div', 'tag');
  const who = el('span', 'who');
  who.textContent = 'DSH';
  const what = el('span', 'what');
  tag.append(who, what);

  const wheel = el('div', 'wheel');
  const wheelSvg = svgEl('svg', { viewBox: '0 0 12 12', fill: 'none', stroke: '#fff', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const wheelPath = svgEl('path', { d: 'M3 4.5 6 7.5 9 4.5' });
  wheelSvg.append(wheelPath);
  wheel.append(wheelSvg);

  cur.append(halo, arrow, tag, wheel);
  sr.append(style, cur);
  (document.body || document.documentElement).appendChild(host);

  // top layer：模态框、全屏元素也在 top layer 里，后进的在上面 —— 有它们的时候重新进一次，保证我们在最上面
  const raise = () => {
    try {
      if (!host.hasAttribute('popover')) host.setAttribute('popover', 'manual');
      const covered = document.fullscreenElement || document.querySelector('dialog:modal');
      if (host.matches(':popover-open')) {
        if (!covered) return;
        host.hidePopover();
      }
      host.showPopover();
    } catch {}
  };
  raise();

  // ── 状态 ──
  let x = keep ? keep.x : null;
  let y = keep ? keep.y : null;
  let shown = false;
  let idleTimer = 0;
  let labelTimer = 0;
  let glide = null;

  const at = (px, py) => `translate3d(${px}px, ${py}px, 0)`;
  const wake = () => {
    cur.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => cur.classList.add('idle'), 6000);
  };
  const appear = () => {
    if (shown) return;
    shown = true;
    if (!reduce()) {
      arrow.animate([{ transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: .7 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 260, easing: 'ease-out' });
      tag.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 60, easing: 'ease-out', fill: 'backwards' });
    }
  };
  /** 正在飞的话，取它此刻的位置（动画值），好从半路接着飞 */
  const current = () => {
    if (glide && glide.playState === 'running') {
      try {
        const m = new DOMMatrixReadOnly(getComputedStyle(cur).transform);
        return { x: m.m41, y: m.m42 };
      } catch {}
    }
    return { x, y };
  };

  const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const place = (px, py) => {
    raise();
    if (glide) { glide.cancel(); glide = null; }
    x = Math.round(px); y = Math.round(py);
    cur.style.transform = at(x, y);
    appear();
    wake();
  };

  const move = (px, py, opts = {}) => {
    px = Math.round(px); py = Math.round(py);
    raise();
    wake();
    if (x === null) { place(px, py); return 0; }
    const from = current();
    if (glide) { glide.cancel(); glide = null; }
    x = px; y = py;
    cur.style.transform = at(px, py);   // 先把终点写死：动画结束（哪怕没帧可画）就停在这
    appear();
    const dx = px - from.x, dy = py - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 2 || reduce()) return 0;
    const duration = Math.round(opts.duration != null ? opts.duration : Math.min(650, 220 + dist * 0.42));
    // 二次贝塞尔弧线：控制点在中点往一侧偏，偏移量随距离走、有上限
    const bend = opts.straight ? 0 : Math.min(60, dist * 0.16) * (dx >= 0 ? -1 : 1);
    const cx = (from.x + px) / 2 - (dy / dist) * bend;
    const cy = (from.y + py) / 2 + (dx / dist) * bend;
    const tilt = opts.straight ? 0 : Math.max(-9, Math.min(9, (dx / dist) * 9));
    const frames = [];
    const N = 14;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = opts.straight ? t : ease(t);
      const q = 1 - p;
      const fx = q * q * from.x + 2 * q * p * cx + p * p * px;
      const fy = q * q * from.y + 2 * q * p * cy + p * p * py;
      frames.push({ offset: t, transform: at(fx, fy) });
    }
    glide = cur.animate(frames, { duration, easing: 'linear' });
    if (tilt) {
      arrow.animate([{ rotate: '0deg' }, { rotate: `${tilt}deg`, offset: .35 }, { rotate: '0deg' }],
        { duration, easing: 'ease-in-out' });
    }
    return duration;
  };

  const press = () => {
    wake();
    if (reduce()) return;
    arrow.animate([{ transform: 'scale(1)' }, { transform: 'scale(.82)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
  };

  const ripple = (px, py, delay) => {
    const ring = el('div', 'ring');
    const ring2 = el('div', 'ring');
    const dot = el('div', 'dot');
    for (const n of [ring, ring2, dot]) { n.style.left = px + 'px'; n.style.top = py + 'px'; }
    sr.append(ring, ring2, dot);
    if (!reduce()) {
      const grow = [{ transform: 'scale(.25)', opacity: .95 }, { transform: 'scale(1)', opacity: 0 }];
      ring.animate(grow, { duration: 520, delay, easing: 'cubic-bezier(.2, .7, .3, 1)', fill: 'both' });
      ring2.animate(grow, { duration: 620, delay: delay + 90, easing: 'cubic-bezier(.2, .7, .3, 1)', fill: 'both' });
      dot.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(1)', opacity: 1, offset: .3 }, { transform: 'scale(1)', opacity: 0 }],
        { duration: 650, delay, easing: 'ease-out', fill: 'both' });
    }
    setTimeout(() => { ring.remove(); ring2.remove(); dot.remove(); }, 900 + delay);
  };

  const click = (px, py, count = 1) => {
    if (px == null) { px = x; py = y; }
    press();
    const n = Math.max(1, Math.min(3, Number(count) || 1));
    for (let i = 0; i < n; i++) ripple(Math.round(px), Math.round(py), i * 130);
  };

  const down = () => { wake(); cur.classList.add('down'); if (!reduce()) arrow.animate([{ transform: 'scale(1)' }, { transform: 'scale(.88)' }], { duration: 120, fill: 'forwards' }); };
  const up = () => { wake(); cur.classList.remove('down'); arrow.getAnimations().forEach((a) => a.cancel()); };

  const label = (text, ms = 2600) => {
    wake();
    what.textContent = text == null ? '' : String(text);
    tag.classList.toggle('open', !!what.textContent);
    clearTimeout(labelTimer);
    if (what.textContent) labelTimer = setTimeout(() => tag.classList.remove('open'), ms);
  };

  const scroll = (dy = 1) => {
    wake();
    wheelPath.setAttribute('d', dy < 0 ? 'M3 7.5 6 4.5 9 7.5' : 'M3 4.5 6 7.5 9 4.5');
    if (reduce()) return;
    const s = dy < 0 ? -1 : 1;
    wheel.animate([
      { opacity: 0, transform: `translateY(${-4 * s}px)` },
      { opacity: 1, transform: 'translateY(0)', offset: .25 },
      { opacity: 1, transform: `translateY(${3 * s}px)`, offset: .75 },
      { opacity: 0, transform: `translateY(${5 * s}px)` },
    ], { duration: 900, easing: 'ease-in-out' });
  };

  const hide = () => {
    clearTimeout(idleTimer);
    clearTimeout(labelTimer);
    if (reduce() || !shown) { host.remove(); return; }
    cur.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
    setTimeout(() => host.remove(), 200);
  };

  const pos = () => (x === null ? null : { x, y });

  window.__dshCursor = { move, place, click, press, down, up, label, scroll, hide, pos, version: VERSION };
  if (keep) place(keep.x, keep.y);
  return 'ready';
})();
