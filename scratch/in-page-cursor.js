// 页内光标浮层 —— 模仿 ChatGPT / Kimi 浏览器扩展的"小鼠标"
//
// 原理：GPT 那些扩展的页内鼠标不是系统光标，是内容脚本注入页面的 DOM 浮层。
//       我们用 Chrome 官方 CDP（Runtime.evaluate）注入同一套东西，不需要装扩展。
//
// 用法：把整段 IIFE 用 Runtime.evaluate 注入一次，之后调：
//   window.__dshCursor.move(x, y)    平滑移动到视口坐标
//   window.__dshCursor.click(x, y)   画涟漪
//   window.__dshCursor.press()       箭头按一下的反馈
//   window.__dshCursor.label("点击 登录")   光标旁边冒个小标签
//   window.__dshCursor.hide()        移除
//
// 特性：
//   * Shadow DOM 隔离 —— 不会和页面自己的 CSS 打架
//   * position:fixed + 最高 z-index —— 浮在页面最上层，跟着 viewport
//   * pointer-events:none —— 绝不挡住真实点击
//   * 移动时沿运动方向拉伸（跟桌面浮层同一套 scoot 手感），落位收回
//   * 点击有涟漪 + 按压缩放 —— 一眼看出"它在点哪儿"
//   * 会出现在截图里 —— 人和模型看到同一画面，可互相验证
//   * 箭头形状和系统浮层光标同源：从 Codex Computer Use 的资源里描出来的，
//     这里用半透明"雾状"版（对应 Codex 的 FogCursorStyle），跟桌面那个实心版区分开

(() => {
  const ID = '__dsh_cursor__';
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647';
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = `
      <style>
        .c{position:fixed;left:0;top:0;width:24px;height:37px;pointer-events:none;
           transition:transform .45s cubic-bezier(.25,.65,.35,1), scale .12s ease;
           filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));will-change:transform}
        .c.press{scale:.8}
        .r{position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;
           border:3px solid #4D6BFE;opacity:0;pointer-events:none}
        .r.on{animation:rip .5s ease-out}
        .lbl{position:fixed;max-width:240px;padding:3px 9px;border-radius:9px;
             font:12px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
             color:#fff;background:rgba(77,107,254,.94);white-space:nowrap;overflow:hidden;
             text-overflow:ellipsis;opacity:0;transition:opacity .22s ease;
             pointer-events:none;transform:translate(20px,20px);box-shadow:0 2px 8px rgba(0,0,0,.3)}
        .lbl.on{opacity:1}
        @keyframes rip{from{opacity:.95;transform:scale(.25)}to{opacity:0;transform:scale(1.9)}}
      </style>
      <img class="c" alt="" src="data:image/png;base64,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">
      <div class="r"></div>
      <div class="lbl"></div>`;
    document.documentElement.appendChild(host);
    host.__sr = sr;
  }
  const sr = host.__sr;
  const cur = sr.querySelector('.c');
  const rip = sr.querySelector('.r');
  const lbl = sr.querySelector('.lbl');
  let labelTimer = 0;

  // 移动：跟桌面浮层同一套 scoot 手感 —— 沿运动方向拉伸，落位收回
  let lastX = null, lastY = null, settleTimer = 0;
  const place = (x, y) => { cur.style.transform = `translate(${x}px, ${y}px)`; };
  const move = (x, y) => {
    const dx = lastX === null ? 0 : x - lastX;
    const dy = lastY === null ? 0 : y - lastY;
    const dist = Math.hypot(dx, dy);
    if (dist > 8) {
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      const stretch = dist > 200 ? 1.28 : 1 + Math.min(0.28, (dist / 200) * 0.28);
      const tilt = Math.max(-9, Math.min(9, (dy / Math.max(dist, 1)) * 9));
      cur.style.transition = 'transform .10s ease-out, scale .12s ease';
      cur.style.transform =
        `translate(${x}px, ${y}px) rotate(${tilt}deg) ` +
        `rotate(${ang}deg) scale(${stretch}, ${1 / stretch}) rotate(${-ang}deg)`;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        cur.style.transition = 'transform .34s cubic-bezier(.22,.9,.3,1), scale .12s ease';
        place(x, y);
      }, 110);
    } else {
      place(x, y);                       // 第一次定位 / 小幅移动：直接摆过去
    }
    lastX = x; lastY = y;
    lbl.style.left = x + 'px';
    lbl.style.top = y + 'px';
  };
  const click = (x, y) => {
    rip.style.left = x + 'px';
    rip.style.top = y + 'px';
    rip.classList.remove('on');
    void rip.offsetWidth;
    rip.classList.add('on');
  };
  const press = () => {
    cur.classList.add('press');
    setTimeout(() => cur.classList.remove('press'), 150);
  };
  const label = (text) => {
    lbl.textContent = text == null ? '' : String(text);
    lbl.classList.add('on');
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => lbl.classList.remove('on'), 1800);
  };
  const hide = () => host.remove();

  window.__dshCursor = { move, click, press, label, hide, version: 2 };
  return 'ready';
})();
