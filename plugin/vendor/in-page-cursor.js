// 页内光标浮层（v4）—— 让用户一眼看出 DSH 在页面里干什么
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
//   * 外观学多人协作工具（Figma 那种）：箭头 + 跟着走的名牌，谁在动一眼就知道
//   * 跟桌面光标（dsh-mac-computer-use）同一个箭头、同一个蓝、同一套动效；区分靠两样：
//     浏览器这边半透明、淡一些，名牌带地球图标；桌面那边实心，名牌带显示器图标
//   * 动效走克制路线，跟桌面光标同一个弹簧、同一套算法：沿轻微的弧线滑过去，先快后慢，
//     顺着速度方向轻轻拉长、略侧倾，名牌晚半拍跟上，到了冲过头最多 3px 再落回；
//     点击时以尖端为支点缩一下，一圈淡波纹
//   * 距离越远走得越久（上限 0.62 秒），跟扩展里点击前的等待（≤0.7 秒）配套
//   * 动画全用 Web Animations（按时间算，不靠 requestAnimationFrame）：后台标签页 rAF 停了也不会卡在半路，
//     截图拍到的永远是该在的位置
//   * 进浏览器 top layer（popover）：页面开了模态框 / 全屏也盖不住它
//   * 自定义元素 + Shadow DOM + all:initial：页面 CSS 影响不到它；pointer-events:none：绝不挡真实点击
//   * 全用 DOM API 搭（不碰 innerHTML）：Gmail 这类开了 Trusted Types 的站点也能注入
//   * 一会儿没动作就变淡、名牌收起，不挡用户视线；系统开了「减少动态效果」就不做动画

(() => {
  const VERSION = 4;
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
    .cur { position: fixed; left: 0; top: 0; width: 0; height: 0; pointer-events: none; opacity: .9;
           transition: opacity .35s ease; will-change: transform; }
    .cur.idle { opacity: .6; }
    .cur.idle .what { max-width: 0; opacity: 0; padding-left: 0; }
    .arrow { position: absolute; left: -4px; top: -3px; width: 26px; height: 26px; overflow: visible;
             filter: drop-shadow(0 1.5px 2.5px rgba(16, 24, 64, .3)); transform-origin: 4px 3px; }
    .halo { position: absolute; left: -11px; top: -11px; width: 22px; height: 22px; border-radius: 50%;
            background: rgba(111, 139, 255, .2); border: 1.5px solid rgba(111, 139, 255, .65);
            opacity: 0; transform: scale(.4); transition: opacity .15s ease, transform .18s ease; }
    .cur.down .halo { opacity: 1; transform: scale(1); }
    .tag { position: absolute; left: 17px; top: 21px; display: flex; align-items: center; max-width: 280px;
           height: 22px; padding: 0 8px 0 7px; border-radius: 4px 11px 11px 11px; box-sizing: border-box;
           background: linear-gradient(135deg, rgba(111, 139, 255, .92), rgba(77, 107, 254, .9)); color: #fff; white-space: nowrap;
           font: 600 11.5px/22px -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", system-ui, sans-serif;
           letter-spacing: .2px; box-shadow: 0 2px 8px rgba(30, 50, 160, .28), 0 0 0 1px rgba(255, 255, 255, .55);
           transition: opacity .2s ease; }
    .ico { flex: none; width: 12px; height: 12px; margin-right: 5px; }
    .who { flex: none; }
    .what { display: inline-block; max-width: 0; opacity: 0; overflow: hidden; text-overflow: ellipsis;
            font-weight: 500; padding-left: 0;
            transition: max-width .32s cubic-bezier(.2, .8, .2, 1), opacity .2s ease, padding .32s ease; }
    .tag.open .what { max-width: 230px; opacity: 1; padding-left: 6px; }
    .what::before { content: "·"; margin-right: 6px; opacity: .7; }
    .ring { position: fixed; left: 0; top: 0; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%;
            border: 1.5px solid rgba(111, 139, 255, .75); background: rgba(111, 139, 255, .12);
            box-sizing: border-box; pointer-events: none; opacity: 0;
            box-shadow: 0 0 0 1px rgba(255, 255, 255, .55); }
    .dot { position: fixed; left: 0; top: 0; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%;
           background: rgba(111, 139, 255, .85); box-shadow: 0 0 0 2px rgba(255, 255, 255, .85); pointer-events: none; opacity: 0; }
    .wheel { position: absolute; left: 20px; top: -26px; width: 20px; height: 20px; border-radius: 50%;
             background: rgba(111, 139, 255, .85); color: #fff; display: grid; place-items: center; opacity: 0;
             box-shadow: 0 2px 6px rgba(30, 50, 160, .28); }
    .wheel svg { width: 12px; height: 12px; }
  `;

  const cur = el('div', 'cur');
  const halo = el('div', 'halo');

  // 箭头：圆角经典指针，淡蓝渐变 + 白描边；尖端在 (4, 3)。形状跟桌面光标一模一样
  const arrow = svgEl('svg', { class: 'arrow', viewBox: '0 0 24 24', width: '26', height: '26' });
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: 'dshg', x1: '0', y1: '0', x2: '1', y2: '1' });
  grad.append(svgEl('stop', { offset: '0', 'stop-color': '#9fb2ff' }), svgEl('stop', { offset: '1', 'stop-color': '#6f8bff' }));
  defs.append(grad);
  arrow.append(defs, svgEl('path', {
    d: 'M4 3.2v16.1c0 .8.95 1.2 1.5.62l3.86-4.02 3.07 6.3c.25.5.86.71 1.36.47l2.04-.98c.5-.24.71-.84.47-1.34l-3.05-6.25 5.5-.2c.82-.03 1.2-1.03.6-1.6L5.65 2.5C5.06 1.95 4 2.37 4 3.2z',
    fill: 'url(#dshg)', stroke: '#fff', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'paint-order': 'stroke',
  }));

  // 名牌：地球图标 = 浏览器里的 DSH（桌面那边是显示器图标）
  const tag = el('div', 'tag');
  const ico = svgEl('svg', { class: 'ico', viewBox: '0 0 12 12', fill: 'none', stroke: '#fff', 'stroke-width': '1.3' });
  ico.append(
    svgEl('circle', { cx: '6', cy: '6', r: '4.8' }),
    svgEl('path', { d: 'M1.2 6h9.6M6 1.2c1.6 1.4 2.4 3 2.4 4.8S7.6 9.4 6 10.8M6 1.2C4.4 2.6 3.6 4.2 3.6 6S4.4 9.4 6 10.8' }),
  );
  const who = el('span', 'who');
  who.textContent = 'DSH';
  const what = el('span', 'what');
  tag.append(ico, who, what);

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
      arrow.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1.04)', opacity: 1, offset: .7 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 280, easing: 'ease-out' });
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

    const place = (px, py) => {
    raise();
    if (glide) { glide.cancel(); glide = null; }
    x = Math.round(px); y = Math.round(py);
    cur.style.transform = at(x, y);
    appear();
    wake();
  };

  // 弹簧：跟桌面光标同一个模型（阻尼比 0.86 上下，几乎不回弹）。这里按时长反推刚度，
  // 保证 duration 时已经落到 0.5px 以内；回弹量按距离把阻尼调一调，最多冲过头 3px。
  const spring = (dist, T) => {
    const f = Math.min(0.005, 3 / dist);                       // 允许冲过头的比例
    const lf = Math.log(f);
    const zeta = Math.min(0.95, -lf / Math.sqrt(Math.PI * Math.PI + lf * lf));
    const zw = Math.log(Math.max(8, 4 * dist)) / T;            // 到 T 时离终点不到 0.5px
    const wd = (zw / zeta) * Math.sqrt(1 - zeta * zeta);
    const r = zeta / Math.sqrt(1 - zeta * zeta);
    return (t) => 1 - Math.exp(-zw * t) * (Math.cos(wd * t) + r * Math.sin(wd * t));
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
    const duration = Math.round(opts.duration != null ? opts.duration : Math.min(620, 240 + dist * 0.42));
    if (opts.straight) {                // 拖拽：匀速直线，跟真实的拖动步子对齐
      glide = cur.animate([{ transform: at(from.x, from.y) }, { transform: at(px, py) }], { duration, easing: 'linear' });
      return duration;
    }
    // 二次贝塞尔弧线：控制点在中点往一侧偏，偏移量随距离走、有上限（桌面光标同一个弯法）
    const ux = dx / dist, uy = dy / dist;
    const bend = Math.min(44, dist * 0.12) * (dx >= 0 ? -1 : 1);
    const cx = (from.x + px) / 2 - uy * bend;
    const cy = (from.y + py) / 2 + ux * bend;
    const curve = (p) => {             // p 略大于 1 时沿着到达方向冲出去一点 —— 回弹就是这么来的
      const q = 1 - p;
      return [q * q * from.x + 2 * q * p * cx + p * p * px, q * q * from.y + 2 * q * p * cy + p * p * py];
    };
    const P = spring(dist, duration / 1000);
    // 按帧采样：位置、速度 → 拉伸 / 侧倾 / 名牌落后，全跟桌面光标一个算法
    const N = 30;
    const pts = [];
    for (let i = 0; i <= N; i++) pts.push(i === N ? [px, py] : curve(P((i / N) * duration / 1000)));
    const dt = duration / 1000 / N;
    const posF = [], armF = [], tagF = [];
    for (let i = 0; i <= N; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N, i + 1)];
      const span = (Math.min(N, i + 1) - Math.max(0, i - 1)) * dt;
      const vx = i === 0 || i === N ? 0 : (b[0] - a[0]) / span;
      const vy = i === 0 || i === N ? 0 : (b[1] - a[1]) / span;
      const v = Math.hypot(vx, vy);
      const amt = Math.min(1, v / 2600);
      const k = 1 + 0.07 * amt;                                // 顺着方向最多拉长 7%
      const th = v > 1 ? Math.atan2(vy, vx) * 180 / Math.PI : 0;
      const tilt = v > 1 ? (vx / v) * 5.7 * amt : 0;           // 侧倾最多 5.7°（0.1 弧度）
      const lx = Math.max(-5, Math.min(5, -vx * 0.004));       // 名牌晚半拍，最多落后 5px
      const ly = Math.max(-5, Math.min(5, -vy * 0.004));
      const offset = i / N;
      posF.push({ offset, transform: at(pts[i][0], pts[i][1]) });
      armF.push({ offset, transform: `rotate(${th.toFixed(2)}deg) scale(${k.toFixed(4)}, ${(1 / Math.sqrt(k)).toFixed(4)}) rotate(${(-th + tilt).toFixed(2)}deg)` });
      tagF.push({ offset, translate: `${lx.toFixed(1)}px ${ly.toFixed(1)}px` });
    }
    glide = cur.animate(posF, { duration, easing: 'linear' });
    arrow.animate(armF, { duration, easing: 'linear' });
    tag.animate(tagF, { duration, easing: 'linear' });
    return duration;
  };

  const press = () => {
    wake();
    if (reduce()) return;
    arrow.animate([
      { transform: 'scale(1)' },
      { transform: 'scale(.86)', offset: .35 },
      { transform: 'scale(1.03)', offset: .75 },
      { transform: 'scale(1)' },
    ], { duration: 260, easing: 'ease-out' });
  };

  const ripple = (px, py, delay) => {
    const ring = el('div', 'ring');
    const dot = el('div', 'dot');
    for (const n of [ring, dot]) { n.style.left = px + 'px'; n.style.top = py + 'px'; }
    sr.append(ring, dot);
    if (!reduce()) {
      ring.animate([{ transform: 'scale(.3)', opacity: .9 }, { transform: 'scale(1)', opacity: 0 }],
        { duration: 560, delay, easing: 'cubic-bezier(.2, .7, .3, 1)', fill: 'both' });
      dot.animate([{ transform: 'scale(.5)', opacity: 1 }, { transform: 'scale(1)', opacity: 1, offset: .3 }, { transform: 'scale(1)', opacity: 0 }],
        { duration: 600, delay, easing: 'ease-out', fill: 'both' });
    }
    setTimeout(() => { ring.remove(); dot.remove(); }, 800 + delay);
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
    cur.animate([{ opacity: getComputedStyle(cur).opacity }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
    setTimeout(() => host.remove(), 200);
  };

  const pos = () => (x === null ? null : { x, y });

  window.__dshCursor = { move, place, click, press, down, up, label, scroll, hide, pos, version: VERSION };
  if (keep) place(keep.x, keep.y);
  return 'ready';
})();
