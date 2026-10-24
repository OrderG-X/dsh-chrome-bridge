# Chrome Web Store — listing copy (paste into the dashboard)

Everything below is meant to be copy-pasted as-is. `<…>` marks the few values you fill in yourself.

## Store listing tab

**Name** (75 chars max)

```
DSH Bridge
```

**Summary** (132 chars max — the line below is 131). The dashboard shows this as "Summary from package": `./bridge store-pack` writes it into the zip's manifest `description`, so there is nothing to paste.

```
Drive the Chrome you already use from a local DSH agent: real clicks and typing over native messaging. No ports, no Connect button.
```

**Description**

```
DSH Bridge gives a locally running DSH (DeepSeek Harness) agent hands inside the Chrome you already use — your logins, your tabs, your session.

Nothing opens a port and nothing asks you to press Connect: the extension talks to a small helper process on your computer over Chrome's native messaging pipe, and moves the mouse and keyboard through real Chrome DevTools Protocol input events.

What you get:
• Real input — clicks, typing, keys, scrolling, drags and file pickers are dispatched as trusted CDP events, not synthetic DOM hacks.
• Real screenshots — the agent sees the rendered page, including full-page and single-element captures.
• A visible cursor — every action draws an on-page cursor (with a small label saying what it is about to do) that also shows up in screenshots, so you can watch what the agent is doing.
• A control panel — the toolbar popup shows the connection status, which tabs each agent session is holding, a live log of recent actions, a switch to pause all control, and a one-click "Release all".
• Your session — you stay logged in; there is no separate automated browser and no cookie export.
• A permanent "DSH Bridge is debugging this browser" banner while attached — press Cancel on it and the bridge detaches instantly.

Requirements (important):
• macOS, Windows or Linux, with Node.js 18+.
• DSH installed, with the matching dsh-chrome-bridge plugin (it installs the helper and registers this extension for native messaging).
• The helper is a local Node process. Install it from https://github.com/OrderG-X/dsh-chrome-bridge — the plugin does it automatically on first load.
Without the helper the extension is inert: it has nothing to talk to, and it will tell you so.

Privacy: the extension has no server, no analytics and no outbound requests of its own. Page content is read on your machine only while your local agent asks for it, and is handed to that agent over a local channel only your user account can use (a 0600 Unix socket on macOS and Linux; on Windows a named pipe that needs a token kept in your own user folder). What your agent then does with it — including anything sent to the model provider you configured in DSH — is governed by DSH and your own settings.

Full privacy policy: https://github.com/OrderG-X/dsh-chrome-bridge/blob/main/PRIVACY.md
Source code, issues and the helper: https://github.com/OrderG-X/dsh-chrome-bridge
```

**Category**

```
Developer Tools
```

**Language** — English is the default. The package ships `_locales/en` and `_locales/zh_CN`, so the dashboard also offers 中文（简体）: paste the zh_CN copy below there.

**Homepage URL**

```
https://github.com/OrderG-X/dsh-chrome-bridge
```

**Support URL**

```
https://github.com/OrderG-X/dsh-chrome-bridge/issues
```

**Privacy policy URL**

```
https://github.com/OrderG-X/dsh-chrome-bridge/blob/main/PRIVACY.md
```

## 中文商品详情（zh_CN）

在「商品详情」顶部的语言下拉里选 **中文（简体）**，把下面两段贴进去（名称、类别、网址都跟英文一样，不用再填）。

**Summary (zh_CN)**（132 字以内；`./bridge store-pack` 会写进包里的 `_locales/zh_CN`，后台显示为「软件包中的摘要」，不用贴）

```
用本机的 DSH 智能体操作你正在用的 Chrome：走 native messaging 发送真实点击和输入，不开端口，也不用点 Connect。
```

**Description (zh_CN)**

```
DSH Bridge 让本机运行的 DSH（DeepSeek Harness）智能体直接操作你正在用的 Chrome —— 用你的登录状态、你的标签页、你的会话。

不开任何端口，也不用点 Connect：扩展通过 Chrome 的 native messaging 管道和你电脑上的一个小助手进程通信，再用真实的 Chrome DevTools Protocol 输入事件来移动鼠标、敲键盘。

你会得到：
• 真实输入 —— 点击、输入、按键、滚动、拖拽、选文件，都以可信的 CDP 事件发出，不是模拟的 DOM 小把戏。
• 真实截图 —— 智能体看到的是渲染后的页面，支持整页截图和单个元素截图。
• 看得见的光标 —— 每个操作都会在页面上画一个光标（带一个小标签，写着它要做什么），截图里也看得到，你能清楚看到智能体在干嘛。
• 控制面板 —— 点工具栏图标能看到连接状态、每个智能体会话正在控制哪些标签页、最近操作的实时日志，还有一键暂停全部控制和「全部松手」。
• 你的会话 —— 你一直保持登录；没有另开一个自动化浏览器，也不导出 Cookie。
• 接管期间 Chrome 会一直显示「DSH Bridge 正在调试此浏览器」的提示条 —— 点上面的「取消」，桥接立刻断开。

使用要求（重要）：
• macOS、Windows 或 Linux，需要 Node.js 18+。
• 已安装 DSH，并装好配套的 dsh-chrome-bridge 插件（它会装好助手，并为本扩展注册 native messaging）。
• 助手是一个本地 Node 进程。来源：https://github.com/OrderG-X/dsh-chrome-bridge —— 插件首次加载时会自动装好。
没有助手时扩展什么也不做：它没有可以对话的对象，并会明确告诉你。

隐私：扩展没有服务器、没有统计，自己也不发任何外部请求。只有当本机的智能体请求时，页面内容才会在你的电脑上被读取，并通过只有你这个系统用户能用的本地通道交给这个智能体（macOS、Linux 上是权限 0600 的 Unix socket；Windows 上是命名管道，要凭存放在你自己用户目录里的令牌才能用）。智能体之后怎么用这些内容 —— 包括发给你在 DSH 里配置的模型服务商 —— 由 DSH 和你自己的设置决定。

完整隐私政策：https://github.com/OrderG-X/dsh-chrome-bridge/blob/main/PRIVACY.md
源码、问题反馈和助手：https://github.com/OrderG-X/dsh-chrome-bridge
```

## Privacy practices tab

**Single purpose description**

```
Bridge the user's own Chrome to a locally running DSH agent, so that agent can read and operate the pages the user points it at.
```

**Justification per permission** (one box each; paste the matching line)

- `debugger`:
```
Required to dispatch real Chrome DevTools Protocol input events (mouse, keyboard, scrolling, drag, file chooser) and to read the DOM, console and network activity of the tab the user asked the agent to work on. Chrome shows a permanent debugging banner while attached and the user can cancel it at any time.
```
- `tabGroups`:
```
Puts the tabs an agent is currently driving into one labelled tab group, and takes the group apart as soon as it lets go, so the user can see at a glance which pages are under control. No tab data leaves the machine.
```
- `tabs`:
```
Required to list the user's tabs (title and URL) so the agent can pick the right one, and to open, close, focus or reload a tab when the user asks for it.
```
- `scripting`:
```
Injects the on-page cursor overlay and a temporary favicon link into the tab the user's own agent is currently working on, so the tab strip shows a small mouse while that cursor is on the page. No other tab is touched, and nothing is sent anywhere.
```
- `nativeMessaging`:
```
The only channel to the local helper process that performs the work. It is a stdio pipe to an executable the user installed on the same machine; the extension never talks to a remote server.
```
- `alarms`:
```
Keeps the MV3 service worker alive while a debugging session is attached, so long-running user actions do not get interrupted when the worker would otherwise be suspended.
```
- `storage`:
```
Stores the extension's own small local settings (for example whether the on-page cursor is enabled).
```
- Host permission `<all_urls>`:
```
The agent works on whatever page the user points it at, and the on-page cursor overlay must be able to draw on any page. The extension reads a page only while the user's own local agent is operating on it.
```

**Remote code** — answer **No** (all code ships in the package; nothing is fetched or eval'd).

**Data usage** — the extension itself collects and transmits nothing; it reads page content locally and hands it to the locally running agent the user installed. Tick the data types the extension *accesses* (website content, browsing activity) and answer "no" to selling/transferring for unrelated purposes; the privacy policy above states exactly that.

## Test instructions tab (for the reviewer)

```
This extension is the browser half of a local tool. It only talks to a native-messaging helper on the same computer, so on its own its toolbar panel shows "helper not connected" - that is expected. No account or login is needed.

To test on macOS (needs Node.js 18+ and git):
1. Install this extension from the store.
2. In Terminal:
   git clone https://github.com/OrderG-X/dsh-chrome-bridge
   cd dsh-chrome-bridge && ./install.sh
   (installs the helper and registers it for this extension's ID; ./install.sh --uninstall removes it)
3. Open the extension's toolbar panel: the status turns green ("已连接" = connected); if not, press its reconnect button or restart Chrome.
4. In Terminal, drive the browser the way the local agent does:
   ~/.dsh/bin/cb tabs
   ~/.dsh/bin/cb open https://example.com --front
   ~/.dsh/bin/cb click-text active "Learn more"
   You will see the on-page cursor move and click, the tab placed in a labelled tab group, and Chrome's debugging banner. The panel lists the controlled tab and the recent actions; "全部松手" (Release all) detaches everything.
```

## After the item is created

The dashboard URL contains the store item ID:

```
https://chrome.google.com/webstore/devconsole/<account>/<slug>/<32-char-ITEM-ID>/edit
```

Send that 32-character ID back: the plugin needs it in the native-messaging registration
(`allowed_origins`), because the Web Store assigns the extension its own ID.
Until that lands, a store-installed extension will be refused by the host.
