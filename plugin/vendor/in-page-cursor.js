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
        .c{position:fixed;left:0;top:0;width:30px;height:30px;pointer-events:none;
           background:linear-gradient(150deg,#16337a,#2E6EFF 30%,#7FA8FF 55%,#EAF1FF 72%,#5B8CFF 88%,#2E6EFF);
           background-size:100% 320%;
           -webkit-mask-image:url(data:image/png;base64,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);
           mask-image:url(data:image/png;base64,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);
           -webkit-mask-size:100% 100%;mask-size:100% 100%;
           -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;
           animation:dshflow 3.2s ease-in-out infinite alternate;
           transition:transform .45s cubic-bezier(.25,.65,.35,1), scale .12s ease;
           transform-origin:1px 1px;
           filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));will-change:transform}
        .c.press{scale:.88}
        .r{position:fixed;width:30px;height:30px;margin:-13px 0 0 -13px;border-radius:50%;
           border:3px solid #4D6BFE;opacity:0;pointer-events:none}
        .r.on{animation:rip .5s ease-out}
        .lbl{position:fixed;max-width:240px;padding:3px 9px;border-radius:9px;
             font:12px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
             color:#fff;background:rgba(77,107,254,.94);white-space:nowrap;overflow:hidden;
             text-overflow:ellipsis;opacity:0;transition:opacity .22s ease;
             pointer-events:none;transform:translate(20px,20px);box-shadow:0 2px 8px rgba(0,0,0,.3)}
        .lbl.on{opacity:1}
        @keyframes dshflow{from{background-position:50% 0%}to{background-position:50% 100%}}
        @keyframes rip{from{opacity:.95;transform:scale(.25)}to{opacity:0;transform:scale(1.9)}}
      </style>
      <div class="c"></div>
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
