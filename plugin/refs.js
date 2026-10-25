/**
 * 元素编号：browser_read(what=snapshot) 给页面上能点 / 能填的元素编上号 [N]，
 * 之后 browser_click / browser_input / browser_screenshot 直接传 ref=N，不用猜 CSS 选择器。
 *
 * 全在插件这一层做，只用宿主已有的 eval op —— 不改扩展。
 * （改扩展得让用户去 chrome://extensions 重新加载；插件改了重启 DSH 就行。）
 *
 * 编号怎么记：
 *   · 元素上打 data-dsh-ref="N" → 编号本身就是选择器 [data-dsh-ref="N"]，
 *     现成的 clickEl / type / select / upload / hover / shot 全都直接能用
 *   · 开放 shadow root 里的元素、同源 iframe 里的元素 document.querySelector 够不着，另记一份 WeakRef
 *     在 window.__dshSnap.shadow，动作时退回按坐标操作（框架里的坐标加上框架在页面上的位置）
 *   · 跨站的 iframe 读不到里面（浏览器不让），只列一行提示
 *   · 同一个元素再快照沿用旧编号（模型手里的旧编号继续有效）；页面跳转后全部失效
 */

const ATTR = 'data-dsh-ref'

/** 在页面里跑：扫一遍可操作元素，打编号，返回一行一个的清单。 */
const SNAPSHOT_JS = (scope, maxItems) => `(() => {
  const S = window.__dshSnap || (window.__dshSnap = { next: 1, shadow: new Map() });
  const ATTR = ${JSON.stringify(ATTR)};
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const q = (s) => JSON.stringify(s);

  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document.body'};
  if (!root) return { error: 'scope' };

  const TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'listbox']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);
  const FORM = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

  // 框架里的元素按它自己那一页算样式
  const css = (el) => (el.ownerDocument.defaultView || window).getComputedStyle(el);
  const cursorOf = (el) => { try { return css(el).cursor } catch { return '' } };
  const shown = (el, st) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (st.visibility === 'hidden') return false;
    // 自定义样式的复选框常常把 <input> 设成透明叠在上面 —— 它照样接得住点击
    if (!FORM.has(el.tagName) && Number(st.opacity) === 0) return false;
    return true;
  };
  const interactive = (el, st) => {
    const tag = el.tagName;
    if (TAGS.has(tag)) {
      if (tag === 'A') return el.hasAttribute('href') || el.hasAttribute('onclick');
      if (tag === 'INPUT') return el.type !== 'hidden';
      return true;
    }
    const role = (el.getAttribute('role') || '').split(' ')[0];
    if (ROLES.has(role)) return true;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.getAttribute('tabindex') !== null && el.tabIndex >= 0 && role !== 'dialog') return true;
    // 手搓的 <div> 按钮：认 cursor:pointer，但只认「从这里开始变成手型」的那一层，子元素继承的不算
    if (st.cursor === 'pointer') {
      const p = el.parentElement;
      return !p || cursorOf(p) !== 'pointer';
    }
    return false;
  };
  const roleOf = (el) => {
    const r = (el.getAttribute('role') || '').split(' ')[0];
    if (r) return r;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', file: 'file', button: 'button',
        submit: 'button', reset: 'button', image: 'button', search: 'searchbox', number: 'spinbutton',
        color: 'color', date: 'date', 'datetime-local': 'date', month: 'date', week: 'date', time: 'time' })[t] || 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };
  const byId = (el, id) => {
    const r = el.getRootNode();
    return (r.getElementById && r.getElementById(id)) || document.getElementById(id);
  };
  const nameOf = (el) => {
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = norm(lb.split(/\\s+/).map((id) => { const n = byId(el, id); return n ? n.innerText || n.textContent : ''; }).join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = norm([...el.labels].map((l) => l.innerText).join(' '));
      if (t) return t;
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return norm(el.value || el.type);
    if (el.tagName === 'INPUT' && el.type === 'image') return norm(el.alt || el.title || 'image');
    if (!FORM.has(el.tagName)) {
      const t = norm(el.innerText);
      if (t) return t;
      const img = el.querySelector('img[alt]');
      if (img && norm(img.alt)) return norm(img.alt);
      const svgTitle = el.querySelector('svg title');
      if (svgTitle && norm(svgTitle.textContent)) return norm(svgTitle.textContent);
    }
    return norm(el.getAttribute('title'));
  };
  const hrefOf = (el) => {
    const h = el.getAttribute('href');
    if (!h || h.startsWith('javascript:')) return '';
    try {
      const u = new URL(h, el.baseURI);
      return u.origin === location.origin ? (u.pathname + u.search + u.hash) : (u.host + u.pathname);
    } catch { return h; }
  };
  const stateOf = (el, role) => {
    const out = [];
    const tag = el.tagName;
    if (tag === 'INPUT' && ['checkbox', 'radio'].includes(el.type)) { if (el.checked) out.push('已勾选'); }
    else if (el.getAttribute('aria-checked') === 'true') out.push('已勾选');
    if (el.getAttribute('aria-selected') === 'true') out.push('已选中');
    const ex = el.getAttribute('aria-expanded');
    if (ex === 'true') out.push('已展开'); else if (ex === 'false') out.push('已收起');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('不可用');
    if (el.readOnly) out.push('只读');
    let extra = '';
    if (tag === 'SELECT') {
      const o = el.selectedOptions && el.selectedOptions[0];
      extra = ' = ' + q(cut(norm(o ? o.textContent : ''), 40)) + '（' + el.options.length + ' 个选项）';
    } else if (tag === 'INPUT' && el.type === 'password') {
      if (el.value) extra = ' = ••••';
    } else if ((tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(el.type)) || tag === 'TEXTAREA') {
      if (el.value) extra = ' = ' + q(cut(norm(el.value), 60));
    } else if (role === 'textbox' && el.isContentEditable) {
      const t = norm(el.innerText);
      if (t) extra = ' = ' + q(cut(t, 60));
    }
    const ph = el.getAttribute('placeholder');
    if (ph && !el.value) extra += ' 提示' + q(cut(norm(ph), 40));
    if (tag === 'A') { const h = hrefOf(el); if (h) extra += ' → ' + cut(h, 70); }
    return extra + (out.length ? ' (' + out.join('，') + ')' : '');
  };

  const seen = new Set();
  const assign = (el) => {
    let n = Number(el.getAttribute(ATTR)) || 0;
    if (n && seen.has(n)) n = 0;            // cloneNode 会把属性一起抄过去 —— 撞号就重新发
    if (!n) { n = S.next++; el.setAttribute(ATTR, String(n)); }
    seen.add(n);
    if (el.getRootNode() !== document) S.shadow.set(n, new WeakRef(el));
    return n;
  };

  const lines = [];
  let count = 0, more = 0, scanned = 0;
  const MAX = ${Number(maxItems) || 300};
  const walk = (parent, depth = 0) => {
    for (const el of parent.children) {
      if (++scanned > 30000) return;
      if (SKIP.has(el.tagName) || el.id === '__dsh_cursor__') continue;
      let st;
      try { st = css(el); } catch { continue; }
      if (st.display === 'none') continue;
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        if (!shown(el, st)) continue;
        const label = '[iframe] ' + cut(el.getAttribute('src') || el.getAttribute('title') || el.getAttribute('name') || '', 80);
        let doc = null;
        try { doc = el.contentDocument; } catch {}
        if (doc && doc.body && depth < 5) {
          lines.push(label + ' ↓');
          walk(doc.body, depth + 1);
          lines.push('[/iframe]');
        } else {
          lines.push(label + '（跨站框架，读不到里面：browser_screenshot 看，按坐标 x/y 点）');
        }
        continue;
      }
      const hm = /^H([1-3])$/.exec(el.tagName);
      if (hm && shown(el, st)) {
        const t = norm(el.innerText);
        if (t) lines.push('#'.repeat(Number(hm[1])) + ' ' + cut(t, 80));
      } else if (interactive(el, st) && shown(el, st)) {
        if (count >= MAX) { more++; }
        else {
          const role = roleOf(el);
          const name = nameOf(el);
          lines.push('[' + assign(el) + '] ' + role + (name ? ' ' + q(cut(name, 80)) : '') + stateOf(el, role));
          count++;
        }
      }
      if (el.tagName === 'SELECT' || el.tagName === 'svg') continue;
      walk(el, depth);
      if (el.shadowRoot) walk(el.shadowRoot, depth);
    }
  };
  walk(root);
  if (root.shadowRoot) walk(root.shadowRoot);
  return { lines, count, more, scanned, title: document.title, url: location.href };
})()`

/** 在页面里跑：编号 → 元素。普通元素给选择器；shadow 里的给坐标（顺带滚进视口）。 */
const LOCATE_JS = (ref, wantPoint) => `(async () => {
  const sel = ${JSON.stringify(`[${ATTR}="${ref}"]`)};
  let el = document.querySelector(sel);
  let shadow = false;
  if (!el) {
    const w = window.__dshSnap && window.__dshSnap.shadow.get(${Number(ref)});
    el = w && w.deref();
    shadow = true;
  }
  // 框架跳转过的话，旧元素还「连着」它那份已经作废的文档：defaultView 没了就算失效
  if (!el || !el.isConnected || !el.ownerDocument.defaultView) return { gone: true };
  // 密码框的 value 绝不拿出来（会进工具结果、上光标名牌）
  const out = { shadow, selector: shadow ? null : sel, tag: el.tagName.toLowerCase(),
    text: (el.innerText || (el.type === 'password' ? '' : el.value) || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
  if (!${wantPoint ? 'true' : 'false'} && !shadow) return out;
  return { ...out, ...(await ${BOX_FN}(el)) };
})()`

/**
 * 页内函数：滚进视口，给出中点和框（整页视口坐标）。后台标签页会暂停 rAF，所以定时器兜底（和扩展里 __dsh_point 同一个坑）。
 * 同源 iframe 里的元素：先由外到里把每层框架滚进视口，坐标再加上每层框架内容区在外层的位置（框 + 边框 + 内边距）。
 */
const BOX_FN = `(async (el) => {
  const frames = [];
  for (let w = el.ownerDocument.defaultView; w && w !== window && w.frameElement; w = w.parent) frames.push(w.frameElement);
  for (let i = frames.length - 1; i >= 0; i--) frames[i].scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  await new Promise((res) => { requestAnimationFrame(() => requestAnimationFrame(res)); setTimeout(res, 120); });
  const r = el.getBoundingClientRect();
  let left = r.left, top = r.top;
  for (const f of frames) {
    const fr = f.getBoundingClientRect();
    const fs = f.ownerDocument.defaultView.getComputedStyle(f);
    left += fr.left + f.clientLeft + (parseFloat(fs.paddingLeft) || 0);
    top += fr.top + f.clientTop + (parseFloat(fs.paddingTop) || 0);
  }
  return { x: Math.round(left + r.width / 2), y: Math.round(top + r.height / 2),
    box: { x: left, y: top, width: r.width, height: r.height } };
})`

/** 页内表达式：编号 → 元素（找不到是 null）。普通元素按属性找，shadow / 框架里的查 WeakRef 表。 */
export const refElementJs = (ref) => `(document.querySelector(${JSON.stringify(`[${ATTR}="${Number(ref)}"]`)}) || (() => {
  const w = window.__dshSnap && window.__dshSnap.shadow.get(${Number(ref)});
  const el = w && w.deref();
  return el && el.isConnected && el.ownerDocument.defaultView ? el : null;
})())`

const goneError = (ref) =>
  new Error(`编号 ${ref} 已失效（页面变了或跳转过）——重新 browser_read what=snapshot 拿新编号`)

/**
 * 拍快照：返回给模型看的文本。
 * @param call  与宿主通话的函数（index.js 的 call）
 */
export async function snapshot(call, tabId, { selector, limit = 8000, maxItems = 300 } = {}) {
  const r = await call('eval', { tabId, expression: SNAPSHOT_JS(selector, maxItems), userGesture: false })
  const v = r.value
  if (!v) throw new Error('页面没返回快照（可能刚跳转，重试一次）')
  if (v.error === 'scope') throw new Error(`没找到元素: ${selector}`)

  const head = `${v.title || ''}\n${v.url}\n可操作元素 ${v.count} 个（[N] 是编号：browser_click / browser_input 传 ref=N）`
  const body = v.lines.join('\n') || '(没找到可操作的元素)'
  let text = `${head}\n\n${body}`
  if (v.more) text += `\n…还有 ${v.more} 个元素没列出——传 selector 只看页面的一部分`
  if (text.length > limit) {
    const cutAt = text.lastIndexOf('\n', limit)
    text = text.slice(0, cutAt > 0 ? cutAt : limit) + `\n…（截断，全文 ${text.length} 字——传 selector 缩小范围，或调大 limit）`
  }
  return text
}

/**
 * 编号 → 怎么操作它。
 * 普通元素：{ selector } —— 调用方照常走选择器那条路（wantPoint=true 时另给坐标）。
 * shadow DOM 里的：{ shadow: true, x, y } —— 调用方按坐标操作。
 */
export async function locate(call, tabId, ref, { wantPoint = false } = {}) {
  const n = Number(ref)
  if (!Number.isInteger(n) || n < 1) throw new Error(`编号要是正整数，收到的是 ${ref}`)
  const r = await call('eval', { tabId, expression: LOCATE_JS(n, wantPoint), userGesture: false })
  const v = r.value
  if (!v || v.gone) throw goneError(n)
  return v
}

/**
 * 元素截图要的框：ref 或 selector 都行（shadow DOM 里的也行）。
 * 不走扩展的 shot(selector)：它取框只等 rAF，后台标签页里 rAF 是停的，会卡满 15 秒。
 */
export async function elementBox(call, tabId, { ref, selector }) {
  if (ref !== undefined && ref !== null) {
    const el = await locate(call, tabId, ref, { wantPoint: true })
    return el.box
  }
  const r = await call('eval', {
    tabId,
    expression: `(async () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? (await ${BOX_FN}(el)).box : null;
    })()`,
    userGesture: false,
  })
  if (!r.value) throw new Error(`没找到元素: ${selector}`)
  return r.value
}

/** shadow DOM 里的元素：直接在页面里聚焦（document.querySelector 够不着它）。 */
export async function focusShadow(call, tabId, ref) {
  const n = Number(ref)
  const r = await call('eval', {
    tabId,
    expression: `(() => {
      const w = window.__dshSnap && window.__dshSnap.shadow.get(${n});
      const el = w && w.deref();
      if (!el || !el.isConnected || !el.ownerDocument.defaultView) return null;
      el.focus();
      return el.getRootNode().activeElement === el;
    })()`,
  })
  if (r.value === null) throw goneError(n)
  if (!r.value) throw new Error(`编号 ${n} 聚焦失败（元素可能不可聚焦）`)
}

/** shadow DOM / 框架里的下拉框：直接在页面里选（扩展的 select 只认 document.querySelector 找得到的）。 */
export async function selectInPage(call, tabId, ref, value) {
  const n = Number(ref)
  const r = await call('eval', {
    tabId,
    expression: `(() => {
      const el = ${refElementJs(n)};
      if (!el) return null;
      if (el.tagName !== 'SELECT') return { ok: false, why: '不是 <select> 元素' };
      const v = ${JSON.stringify(String(value))};
      const opts = [...el.options];
      const hit = opts.find((o) => o.value === v) || opts.find((o) => (o.textContent || '').trim() === v);
      if (!hit) return { ok: false, why: '没有这个选项', options: opts.map((o) => o.value).slice(0, 20) };
      el.value = hit.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: hit.value, label: (hit.textContent || '').trim() };
    })()`,
    userGesture: false,
  })
  const v = r.value
  if (v === null) throw goneError(n)
  if (!v.ok) throw new Error(`选择失败：${v.why}${v.options ? '（可选值：' + v.options.join(', ') + '）' : ''}`)
  return v
}

/** 同源 iframe 里的可见文字（document.body.innerText 不含框架内容）；跨站的只给一行提示。 */
export async function frameTexts(call, tabId) {
  const r = await call('eval', {
    tabId,
    expression: `(() => {
      const out = [];
      const walk = (doc, depth) => {
        for (const f of doc.querySelectorAll('iframe, frame')) {
          const b = f.getBoundingClientRect();
          if (b.width < 2 || b.height < 2) continue;
          const src = (f.getAttribute('src') || f.getAttribute('title') || f.getAttribute('name') || '').slice(0, 120);
          let d = null;
          try { d = f.contentDocument; } catch {}
          if (!d || !d.body) { out.push({ src, cross: true }); continue; }
          out.push({ src, text: (d.body.innerText || '').trim() });
          if (depth < 4) walk(d, depth + 1);
        }
      };
      walk(document, 0);
      return out.slice(0, 30);
    })()`,
    userGesture: false,
  })
  return Array.isArray(r.value) ? r.value : []
}
