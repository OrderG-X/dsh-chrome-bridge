// 页内光标浮层 —— 模仿 ChatGPT / Kimi 浏览器扩展的"小鼠标"
//
// 原理：GPT 那些扩展的页内鼠标不是系统光标，是内容脚本注入页面的 DOM 浮层。
//       我们用 Chrome 官方 CDP（Runtime.evaluate）注入同一套东西，不需要装扩展。
//
// 用法（在 MCP 的 evaluate_script 里）：
//   1) 首次注入：把下面 IIFE 整段作为 function 传进去（坐标可改）
//   2) 之后只需调用：window.__dshCursor.move(x, y) / .click(x, y) / .hide()
//
// 特性：
//   * Shadow DOM 隔离 —— 不会和页面自己的 CSS 打架
//   * position:fixed + 最高 z-index —— 浮在页面最上层，跟着 viewport
//   * pointer-events:none —— 绝不挡住真实点击
//   * 点击有涟漪动画 —— 一眼看出"它在点哪儿"
//   * 会出现在截图里 —— 我能和你看到同一画面，可互相验证

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
           transition:transform .55s cubic-bezier(.25,.65,.35,1);
           filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));will-change:transform}
        .r{position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;
           border:3px solid #4D6BFE;opacity:0;pointer-events:none}
        .r.on{animation:rip .5s ease-out}
        @keyframes rip{from{opacity:.95;transform:scale(.25)}to{opacity:0;transform:scale(1.9)}}
      </style>
      <svg class="c" viewBox="0 0 30 30">
        <path d="M2 1 L2 22 L7.6 16.6 L12 28.4 L17 26.1 L12.6 14.6 L20.4 14.2 Z"
              fill="#4D6BFE" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
      <div class="r"></div>`;
    document.documentElement.appendChild(host);
    host.__sr = sr;
  }
  const sr = host.__sr;
  const cur = sr.querySelector('.c');
  const rip = sr.querySelector('.r');
  const move = (x, y) => { cur.style.transform = `translate(${x}px, ${y}px)`; };
  const click = (x, y) => {
    rip.style.left = x + 'px'; rip.style.top = y + 'px';
    rip.classList.remove('on'); void rip.offsetWidth; rip.classList.add('on');
  };
  window.__dshCursor = { move, click, hide: () => host.remove() };
  return 'ready';
})();
