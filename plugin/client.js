/**
 * dsh-chrome-bridge 的网页端：DSH「插件」页里我们这张卡的设置页。
 *
 *   连接状态（扩展 / 本地宿主、版本、正在控制哪些标签页）+ 全部松手
 *   两个开关：允许 DSH 控制浏览器（这里只能关）、页面里显示 DSH 光标
 *   没连上时：差哪一步、一键帮你打开安装页
 *
 * 数据全走插件自己挂在 DSH webServer 上的路由（plugin/panel.js），每 2.5 秒刷一次。
 * 走官方客户端插件机制：window.__ModuleLoader__.load({ id, factory })，factory 里 apply(ctx)
 * → 注册到 plugins.bundle.config（包详情页）和 plugins.row.config（行详情页）两个 keyed slot。
 * 拿不到 react 或 DSH 的组件就安静退出 / 用最朴素的替身，别把宿主页面搞崩。
 */
window.__ModuleLoader__.load({
  id: 'dsh-chrome-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const opt = (id) => { try { return require(id) } catch (_) { return null } }
    const React = opt('react')
    if (!React) {
      exports.apply = () => {}
      exports.inject = ['slots', 'locale']
      return module.exports
    }
    const UI = opt('@deepseek-ai/dsh-client-ui-primitives') || {}
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const PKG = 'dsh-chrome-bridge'
    const ROW = 'chrome-bridge'
    const NS = 'dsh-chrome-bridge'
    const ROUTE = '/dsh-chrome-bridge/panel'
    const REPO = 'https://github.com/OrderG-X/dsh-chrome-bridge'

    // 占位符用 %x：不跟 DSH 自己的 {name} 插值撞
    const zh = {
      title: 'Chrome 浏览器控制',
      checking: '正在检查…',
      connected: '已连接',
      paused: '已暂停',
      disconnected: '未连接',
      unsupported: '目前只支持 macOS',
      summaryOn: '已连接 · 正在控制 %n 个标签页',
      summaryIdle: '已连接，没有在控制的标签页',
      summaryOff: '还没连上 Chrome，点开看怎么装',
      summaryPaused: '已暂停：DSH 暂时不能操作浏览器',
      storeBuild: '商店版',
      localBuild: '本地版',
      controlling: '正在控制 %n 个标签页',
      controllingIdle: '没有在控制的标签页',
      releaseAll: '全部松手',
      released: '已全部松手',
      allowControl: '允许 DSH 控制浏览器',
      allowControlHint: '关掉后，DSH 的浏览器操作会被直接拒绝。重新打开要到 Chrome 工具栏的 DSH Bridge 面板里点 —— 这样模型自己没法把它打开。',
      resumeInChrome: '要恢复，请点 Chrome 工具栏上的 DSH Bridge 图标，打开「允许 DSH 控制浏览器」。',
      showCursor: '页面里显示 DSH 光标',
      showCursorHint: '关掉只是不画光标，点击、输入照做。',
      outdated: 'Chrome 里的扩展版本较旧，更新后才能在这里切换开关。',
      setupTitle: '还差一步：把扩展装进 Chrome',
      setupStoreTitle: '扩展装了，但没连上',
      setupStep1: '打开 Chrome，地址栏进入 chrome://extensions，右上角打开「开发者模式」',
      setupStep2: '点「加载已解压的扩展程序」，选这个文件夹：',
      setupStep3: '装好后这里会自动变成「已连接」',
      setupStoreAlt: '更省事：直接从 Chrome 应用商店装，不用开发者模式。',
      openStore: '去商店装',
      storeOpened: '已在 Chrome 里打开商店页，点「添加至 Chrome」就行',
      setupStore1: '确认 Chrome 开着，并且 DSH Bridge 扩展是启用状态',
      setupStore2: '还不行就重启一下 Chrome',
      openInstall: '帮我打开安装页',
      installOpened: '已在 Chrome 里打开扩展页',
      pathCopied: '，文件夹路径也复制好了（文件框里按 ⌘⇧G 再 ⌘V）',
      plugin: '插件 v%v',
      guide: '使用说明',
      failed: '操作没成功：%e',
      unreachable: '读不到插件状态，重启 DSH 后再试',
    }
    const en = {
      title: 'Chrome Bridge',
      checking: 'Checking…',
      connected: 'Connected',
      paused: 'Paused',
      disconnected: 'Not connected',
      unsupported: 'macOS only for now',
      summaryOn: 'Connected · controlling %n tab(s)',
      summaryIdle: 'Connected, no tabs under control',
      summaryOff: 'Not connected to Chrome yet — open for setup steps',
      summaryPaused: 'Paused: DSH cannot operate the browser',
      storeBuild: 'Web Store',
      localBuild: 'Local',
      controlling: 'Controlling %n tab(s)',
      controllingIdle: 'No tabs under control',
      releaseAll: 'Release all',
      released: 'Released all tabs',
      allowControl: 'Allow DSH to control the browser',
      allowControlHint: 'When off, DSH browser actions are refused. Turning it back on is done from the DSH Bridge panel in Chrome\'s toolbar, so the model cannot re-enable it itself.',
      resumeInChrome: 'To resume, click the DSH Bridge icon in Chrome\'s toolbar and turn on "Allow DSH to control the browser".',
      showCursor: 'Show the DSH cursor on pages',
      showCursorHint: 'Off only hides the cursor; clicks and typing still happen.',
      outdated: 'The extension in Chrome is outdated; update it to change these switches here.',
      setupTitle: 'One step left: add the extension to Chrome',
      setupStoreTitle: 'The extension is installed but not connected',
      setupStep1: 'Open chrome://extensions in Chrome and turn on Developer mode (top right)',
      setupStep2: 'Click "Load unpacked" and choose this folder:',
      setupStep3: 'This page turns to "Connected" once it is loaded',
      setupStoreAlt: 'Easier: install it from the Chrome Web Store, no Developer mode needed.',
      openStore: 'Get it from the store',
      storeOpened: 'Opened the store page in Chrome; click "Add to Chrome"',
      setupStore1: 'Make sure Chrome is running and the DSH Bridge extension is enabled',
      setupStore2: 'If it still does not connect, restart Chrome',
      openInstall: 'Open the install page for me',
      installOpened: 'Opened the extensions page in Chrome',
      pathCopied: '; the folder path is on the clipboard (⌘⇧G then ⌘V in the file picker)',
      plugin: 'Plugin v%v',
      guide: 'Guide',
      failed: 'That did not work: %e',
      unreachable: 'Could not read the plugin status; restart DSH and try again',
    }

    const fmt = (s, vars) => String(s).replace(/%([a-z])/g, (m, k) => (vars && k in vars ? String(vars[k]) : m))

    const CSS = `
.dcb{display:grid;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dcb-card{border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l));background:var(--dsw-alias-settings-card-fill,transparent);border-radius:12px;overflow:hidden}
.dcb-row{display:flex;align-items:flex-start;gap:12px;padding:12px 14px}
.dcb-row+.dcb-row{border-top:1px solid var(--dsw-alias-border-l)}
.dcb-main{flex:1;min-width:0;display:grid;gap:2px}
.dcb-title{font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dcb-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.dcb-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.dcb-dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:6px;background:var(--dsw-alias-label-tertiary)}
.dcb-dot[data-s=on]{background:var(--dsw-alias-state-success-primary,#34c759);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c759) 22%,transparent)}
.dcb-dot[data-s=paused]{background:var(--dsw-alias-state-warn-primary,#ff9f0a)}
.dcb-dot[data-s=off]{background:var(--dsw-alias-state-error-primary,#ff453a)}
.dcb-tabs{margin:6px 0 0;padding:0;list-style:none;display:grid;gap:2px}
.dcb-tabs li{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcb-steps{margin:6px 0 0;padding-left:18px;display:grid;gap:4px;color:var(--dsw-alias-label-secondary)}
.dcb-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);user-select:all}
.dcb-note{font-size:12px;padding:8px 12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ff9f0a) 12%,transparent);color:var(--dsw-alias-label-primary)}
.dcb-note[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c759) 12%,transparent)}
.dcb-note[data-tone=err]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff453a) 12%,transparent)}
.dcb-foot{display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dcb-foot a{color:var(--dsw-alias-link);text-decoration:none}
.dcb-foot a:hover{text-decoration:underline}
.dcb-tag{font-size:11px;font-weight:500;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l);color:var(--dsw-alias-label-secondary)}
.dcb-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.dcb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dcb-btn:disabled{opacity:.45;cursor:default}
.dcb-switch{flex:none;margin-top:2px}`
    function ensureCss() {
      if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="dsh-chrome-bridge"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PKG
      tag.dataset.pluginCss = 'dsh-chrome-bridge'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── DSH 组件，拿不到就用朴素替身 ────────────────────────────────────────
    function Toggle({ checked, disabled, label, onChange }) {
      if (UI.Switch) return h('span', { className: 'dcb-switch' }, h(UI.Switch, { checked, disabled, label, onChange }))
      return h('input', { className: 'dcb-switch', type: 'checkbox', role: 'switch', 'aria-label': label, checked, disabled, onChange: (e) => onChange(e.target.checked) })
    }
    function Btn({ onClick, disabled, children, primary }) {
      if (UI.Button) return h(UI.Button, { variant: primary ? 'primary' : 'outline', size: 'sm', disabled, onClick }, children)
      return h('button', { type: 'button', className: 'dcb-btn', disabled, onClick }, children)
    }

    // ── 数据 ──────────────────────────────────────────────────────────────
    async function fetchState(action) {
      const res = await fetch(ROUTE, action
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action), credentials: 'same-origin' }
        : { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    /** 2.5 秒刷一次；页面藏起来时不刷。 */
    function useBridgeState() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const alive = useRef(true)
      const load = useCallback(async () => {
        try {
          const s = await fetchState()
          if (alive.current) { setState(s); setError('') }
        } catch (e) {
          if (alive.current) setError(String((e && e.message) || e))
        }
      }, [])
      useEffect(() => {
        alive.current = true
        load()
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load()
        }, 2500)
        return () => { alive.current = false; clearInterval(timer) }
      }, [load])
      const act = useCallback(async (action) => {
        const s = await fetchState(action)
        if (alive.current) setState(s)
        return s
      }, [])
      return { state, error, act }
    }

    function phaseOf(s) {
      if (!s) return 'checking'
      if (s.platform && s.platform !== 'darwin') return 'unsupported'
      if (!s.connected) return 'off'
      return s.paused ? 'paused' : 'on'
    }

    // ── 概要（行卡片上的一句话）────────────────────────────────────────────
    function Summary({ t }) {
      const { state } = useBridgeState()
      const p = phaseOf(state)
      if (p === 'checking') return t('checking')
      if (p === 'unsupported') return t('unsupported')
      if (p === 'off') return t('summaryOff')
      if (p === 'paused') return t('summaryPaused')
      return state.attachedCount ? fmt(t('summaryOn'), { n: state.attachedCount }) : t('summaryIdle')
    }

    // ── 设置页 ────────────────────────────────────────────────────────────
    function Page({ t }) {
      const { state, error, act } = useBridgeState()
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const p = phaseOf(state)
      const can = !!state && state.connected && !state.outdated && !busy

      const run = async (action, ok) => {
        setBusy(true)
        try {
          const s = await act(action)
          if (s.actionError) setNote({ tone: 'err', text: fmt(t('failed'), { e: s.actionError }) })
          else setNote(ok ? { tone: 'ok', text: typeof ok === 'function' ? ok(s) : ok } : null)
        } catch (e) {
          setNote({ tone: 'err', text: fmt(t('failed'), { e: String((e && e.message) || e) }) })
        } finally {
          setBusy(false)
        }
      }

      const statusTitle = { checking: t('checking'), on: t('connected'), paused: t('paused'), off: t('disconnected'), unsupported: t('unsupported') }[p]
      const ext = state && state.ext
      const status = h('div', { className: 'dcb-card' },
        h('div', { className: 'dcb-row' },
          h('span', { className: 'dcb-dot', 'data-s': p === 'unsupported' ? 'off' : p }),
          h('div', { className: 'dcb-main' },
            h('div', { className: 'dcb-title' }, statusTitle,
              ext ? h('span', { className: 'dcb-tag' }, `${ext.store ? t('storeBuild') : t('localBuild')} v${ext.version}`) : null),
            state && state.connected
              ? h('div', { className: 'dcb-sub' }, state.attachedCount ? fmt(t('controlling'), { n: state.attachedCount }) : t('controllingIdle'))
              : null,
            state && state.tabs && state.tabs.length
              ? h('ul', { className: 'dcb-tabs' }, state.tabs.map((tab, i) => h('li', { key: i, title: tab.url }, tab.title || tab.url)))
              : null,
            p === 'paused' ? h('p', { className: 'dcb-hint' }, t('resumeInChrome')) : null),
          state && state.connected
            ? h(Btn, { disabled: !can || !state.attachedCount, onClick: () => run({ action: 'releaseAll' }, t('released')) }, t('releaseAll'))
            : null))

      const setup = p === 'off' ? h('div', { className: 'dcb-card' },
        h('div', { className: 'dcb-row' },
          h('div', { className: 'dcb-main' },
            h('div', { className: 'dcb-title' }, state.store ? t('setupStoreTitle') : t('setupTitle')),
            state.store
              ? h('ol', { className: 'dcb-steps' }, h('li', null, t('setupStore1')), h('li', null, t('setupStore2')))
              : h('ol', { className: 'dcb-steps' },
                h('li', null, t('setupStep1')),
                h('li', null, t('setupStep2'), ' ', h('span', { className: 'dcb-path' }, state.extDir)),
                h('li', null, t('setupStep3'))),
            state.store ? null : h('p', { className: 'dcb-hint' }, t('setupStoreAlt'))),
          state.store ? null : h(Btn, { primary: true, disabled: busy, onClick: () => run({ action: 'install', via: 'store' }, t('storeOpened')) }, t('openStore')),
          h(Btn, { primary: !!state.store, disabled: busy, onClick: () => run({ action: 'install' }, (s) => t('installOpened') + (s.assist && s.assist.clipboard ? t('pathCopied') : '')) }, t('openInstall')))) : null

      const switches = state && state.connected ? h('div', { className: 'dcb-card' },
        h('div', { className: 'dcb-row' },
          h('div', { className: 'dcb-main' },
            h('div', { className: 'dcb-title' }, t('allowControl')),
            h('p', { className: 'dcb-hint' }, t('allowControlHint'))),
          h(Toggle, {
            label: t('allowControl'),
            checked: !state.paused,
            // 只能往「关」的方向拨：打开要去 Chrome 里点
            disabled: !can || state.paused,
            onChange: (on) => { if (!on) run({ action: 'pause' }) },
          })),
        h('div', { className: 'dcb-row' },
          h('div', { className: 'dcb-main' },
            h('div', { className: 'dcb-title' }, t('showCursor')),
            h('p', { className: 'dcb-hint' }, t('showCursorHint'))),
          h(Toggle, { label: t('showCursor'), checked: state.showCursor !== false, disabled: !can, onChange: (on) => run({ action: 'cursor', on }) }))) : null

      const notes = [
        error && !state ? { tone: 'err', text: t('unreachable') } : null,
        state && state.outdated ? { tone: 'warn', text: t('outdated') } : null,
        note,
      ].filter(Boolean)

      return h('div', { className: 'dcb' },
        status,
        setup,
        switches,
        ...notes.map((n, i) => h('div', { key: `n${i}`, className: 'dcb-note', 'data-tone': n.tone }, n.text)),
        h('div', { className: 'dcb-foot' },
          state && state.plugin ? h('span', null, fmt(t('plugin'), { v: state.plugin })) : null,
          h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, t('guide'))))
    }

    function makeCard(boundT) {
      return function ChromeBridgeCard(props) {
        ensureCss()
        const t = typeof props.t === 'function' ? props.t : boundT
        return props.view === 'summary' ? h(Summary, { t }) : h(Page, { t })
      }
    }

    function apply(ctx) {
      const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (k) => zh[k] || k
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chrome-bridge: dictionaries')
      }
      const Card = makeCard(t)
      const mount = (name, key) => {
        const reg = () => ctx.slots.register({ name, key, locale: NS }, Card)
        ctx.effect(() => (typeof ctx.slots.inject === 'function' ? ctx.slots.inject(name, reg) : reg()), `dsh-chrome-bridge: ${name}`)
      }
      mount('plugins.bundle.config', PKG)
      mount('plugins.row.config', `${PKG}#${ROW}`)
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
