<div align="center">

<img src="assets/hero.svg" alt="dsh-chrome-bridge — 让 DSH 的 agent 在你正在用的 Chrome 里动手" width="760" />

<p>
  <a href="https://github.com/OrderG-X/dsh-chrome-bridge/releases"><img src="https://img.shields.io/github/v/release/OrderG-X/dsh-chrome-bridge?label=release&color=4D6BFE" alt="release" /></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" />
  <a href="https://chromewebstore.google.com/detail/bippcbbbipppmhjkjomgdnjbooecbimo"><img src="https://img.shields.io/chrome-web-store/v/bippcbbbipppmhjkjomgdnjbooecbimo?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white&color=4285F4" alt="Chrome Web Store" /></a>
  <img src="https://img.shields.io/badge/chrome-%E2%89%A5%20116-4285F4?logo=googlechrome&logoColor=white" alt="Chrome >= 116" />
  <img src="https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white" alt="macOS" />
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2018-43853d?logo=node.js&logoColor=white" alt="Node >= 18" />
  <img src="https://img.shields.io/badge/CDP-chrome.debugger-4D6BFE" alt="chrome.debugger" />
</p>

<p>
  <a href="README.md">English</a> ·
  <a href="README.zh.md"><b>简体中文</b></a> ·
  <a href="docs/NOTES.zh.md">开发踩坑记录</a>
</p>

</div>

---

**让 DSH 的 agent 在你正在用的 Chrome 里动手**——带你的登录态、你的标签页、你的会话。装一次，永远不用再点 Connect。

> **一句话**：DeepSeek Harness（DSH）插件，让模型直接操作你平时用的 Chrome：打开网页、点击、打字、填表、读网页、截图、多标签页，用的是你已有的登录状态。
>
> **什么时候用**：「帮我在网页上填个表」「打开这个后台看一下」「给这个网站截个图」，凡是要在浏览器里动手的事。
>
> **安装**：`dsh plugin add https://github.com/OrderG-X/dsh-chrome-bridge/releases/latest/download/dsh-chrome-bridge.tgz`，重启 DSH，再从 [Chrome 应用商店](https://chromewebstore.google.com/detail/bippcbbbipppmhjkjomgdnjbooecbimo) 装 DSH Bridge 扩展。需要 macOS、Chrome 116+、Node.js 18+。

![页内光标在真实页面上操作](assets/cursor-demo.gif)

<sub>每次点击都会有个小光标飞到目标上，并标出它在干什么。它渲染在**页面里**，所以**会进截图**——人和模型看到的是同一画面。</sub>

## ✨ 为什么还要再造一个

现有方案每次都要你点一下：

| 方案 | 毛病 |
|---|---|
| `chrome-devtools-mcp --autoConnect` | **每次**连接 Chrome 都弹"要允许远程调试吗" |
| Browser MCP（商店扩展） | **每个标签页**都要点扩展图标 → Connect |
| 各种 WebSocket 桥 | 开一个 TCP 端口，谁连上都能用 |
| **dsh-chrome-bridge** | 没有要点的东西，也没有在监听的端口 |

三点关键差异：

- 🔌 **native messaging，不开端口** —— 扩展通过 Chrome 的原生消息管道跟本地 Node 宿主通信；CLI 通过一个 `0600` 的 Unix socket 找宿主，还带 token 校验。没有 TCP 端口可扫，没有 origin 可伪造
- 🎯 **`chrome.debugger`，不是注入脚本** —— 点击和按键走真实 CDP `Input.*` 事件，带 user gesture：弹窗能开、焦点正常、那些拒绝合成事件的站点也照常工作。顺带白拿截图、网络、console 和任意 CDP
- 👀 **人看得见的光标** —— 半透明的淡蓝箭头带个「🌐 DSH」名牌，沿弧线滑到目标，名牌写着它在干什么（点击 / 输入 / 拖拽 / 滚动），点下去有一圈淡波纹。跟 [dsh-mac-computer-use](https://github.com/OrderG-X/dsh-mac-computer-use) 的桌面光标是同一套样式（那边实心、名牌是显示器图标），一眼分得清是在浏览器里还是桌面上。盖得住弹框和全屏，换页面也接着上一页的位置。它渲染在页面里，所以**会出现在截图里**

## 🏗 架构

```
DSH 的 agent（harness 自带，本仓库不提供）
  ├── browser_* 原生工具（DSH 插件） ─┐
  └── cb CLI          （命令行）     ─┤
                                     ▼
                    Unix socket  /tmp/dsh-bridge-<uid>/   (0700 目录 + token)
                                     ▼
                    Node 原生宿主  ←─ native messaging (stdio) ─→  Chrome 扩展 (MV3)
                                                                        │ chrome.debugger
                                                                        ▼
                                                                   真实 CDP
```

**本仓库不含 agent** —— 上面那个 agent 是 DSH（harness）自带的，我们只给它一双手。

扩展 ID 由 `plugin/vendor/extension/manifest.json` 里的公钥固定，所以**每台机器上装的 ID 都一样**，注册文件不用改。商店版有商店分配的 ID，宿主两个都认。

## 🚀 安装

**宿主就在插件包里。** 装插件时它会把原生宿主和 MV3 扩展复制到固定位置、并替你写好 native messaging 注册 —— 不用 `git clone`、不用跑 `install.sh`、不用 `python3`。

要求：**macOS**、**Chrome 116+**、**Node.js 18+**。

**1.** 侧栏 → **插件** → **添加插件** → 粘贴这个 → 安装 → 启用 → **重启 DSH**：

```
https://github.com/OrderG-X/dsh-chrome-bridge/releases/latest/download/dsh-chrome-bridge.tgz
```

**2.** 插件首次加载会自己装好宿主（`~/.dsh/chrome-bridge`、`~/dsh-bridge-extension`，以及 Chrome `NativeMessagingHosts` 里的 `com.dsh.bridge.json`）。剩下只差把扩展装进 Chrome，两种装法选一个：

**推荐：从 Chrome 应用商店装** —— 打开 [DSH Bridge 商店页](https://chromewebstore.google.com/detail/bippcbbbipppmhjkjomgdnjbooecbimo) → **添加至 Chrome**。不用开发者模式，扩展以后也会自动更新。

**或者：加载未打包的扩展**（想用仓库里最新的扩展时）。Chrome 137+ 移除了 `--load-extension`，这一下得你自己点，插件会把你送到那一下面前：

- 第一次有 `browser_*` 工具发现没宿主可连时，它会**在后台标签页打开 `chrome://extensions`**，并**把 `~/dsh-bridge-extension` 复制进剪贴板**（每个会话只做一次；报错文字里也写着这几步）；
- 文件框里按 **⌘⇧G** → **⌘V** → 回车 就选好了，不用在目录树里翻。

一辈子做一次：

1. 打开 `chrome://extensions`
2. 右上角打开**开发者模式**
3. **加载未打包的扩展程序** → **⌘⇧G** → **⌘V** → 回车（路径已经在剪贴板里）

用源码装的话，一条 `./bridge setup` 就把这套走完：装宿主、打开页面、复制路径，然后**等你点完自动检测**，连上会打 ✅。

**3.** 验证（`cb` 命令行也顺带装好了）：

```bash
cb status     # 宿主 pid … | 扩展连接: ✅
cb tabs
```

第 2 步没做之前，`browser_*` 工具会**带着这几步明确报错**，不会静默失败。

### 🧩 十一个原生工具

| 工具 | 干什么 |
|---|---|
| `browser_tabs` | 列 / 找 / 开 / 关 / 切标签页 |
| `browser_read` | **给能点/能填的元素编号**（`snapshot`）/ 读文字 / HTML / 属性 / 页面信息 |
| `browser_click` | 按编号（`ref`）、选择器、文字或坐标点 |
| `browser_input` | 输入 / 按键 / 选下拉 / 传文件 / 悬停 / 滚动 |
| `browser_nav` | 跳转网址、**后退 / 前进 / 刷新**，都等加载完 |
| `browser_screenshot` | 截图，**以图片返回**（视口 / 整页 / 元素） |
| `browser_eval` | 页面里跑 JS |
| `browser_wait` | 等元素、**等某段文字、等网址**出现，或等它消失（`gone`） |
| `browser_dialog` | 放行 alert / confirm / prompt |
| `browser_drag` | 拖拽：按编号、选择器、**可见文字**或坐标；HTML5 拖放和靠鼠标拖的组件（滑块、排序列表）都行 |
| `browser_devtools` | **控制台输出 + 未捕获的 JS 报错、网络请求（状态码、耗时）、某个请求的返回内容** |

> 新装的 bundle 不会热加载，必须重启一次 app。
> CLI 的 `dsh plugin add` 对 app 独占的 profile 会拒绝，那种情况走侧栏。
> DSH 目前**不支持插件自动更新**：升级要卸载后重装。

### 👀 它干活的时候你能看见什么

- **点工具栏上的扩展图标**有个实时面板：Chrome ↔ 本地宿主 ↔ DSH 三段连没连上；**哪个 DSH 会话在动哪几个标签页**（一键切过去看、一键松手）；最近做了什么、哪步失败了为什么；**暂停开关**——关掉后 DSH 一律动不了浏览器，直到你再打开；还有「复制诊断信息」方便报 bug。图标角标是正在控制的标签页数（`!` = 宿主断了，`⏸` = 已暂停）。
- **DSH 侧栏「插件」→「Chrome 浏览器控制」**也有一张设置卡：连没连上、扩展是本地版还是商店版、正在控制哪些标签页（一键全部松手）；可以在这里暂停、开关页内光标。没连上时会告诉你差哪一步，并能一键打开安装页。**恢复控制只能在 Chrome 的扩展面板里点** —— 模型也摸得到 DSH 这边，那一下必须是你本人。
- **agent 不会默认去动你正在看的那一页。** `browser_*` 工具不传 `tab` 时，只接着用这个会话自己打开或点名操作过的标签页；一个都没有就报错说明。要操作你当前这页，得明确传 `tab="active"`。
- agent 碰过的标签页会**自动进一个蓝色标签组「DSH agent 正在操作」**（固定的、已经在你自己分组里的标签页不挪）；一松手就自动拆掉 —— 空闲 60 秒、`cb detach`、标签页被关、或者你点掉 Chrome 那条调试提示，都算松手。
- 标签上那只小鼠标（favicon + 工具栏图标）的意思是**这个页面里真的有一只鼠标**：agent 画出页内光标（点击、输入）时才亮，光标被收掉、页面导航、或松手就灭 —— 光读页面不会亮。
- 页面里还有页内光标把每次点击、输入、拖拽、滚动画出来，而且会进截图 —— 你和模型看到的是同一张画面。嫌它碍眼可以在面板里关掉（真实操作照做，只是不画）。密码框只显示圆点。

### 🛠 从源码装（开发用）

```bash
git clone https://github.com/OrderG-X/dsh-chrome-bridge.git
cd dsh-chrome-bridge
./install.sh        # 和插件自动安装的落盘位置一致，另外多一个管理命令
./bridge status     # 仓库版本 / 已装版本 / 运行版本 + 连接状态
```

想要原生工具就把本地路径填进 DSH：**插件 → 添加插件** → `/本仓库绝对路径/plugin`（装的是 `link:`，`git pull` 一下就更新）。

## 📖 用法

### `cb` 命令行

```bash
cb status / cb version / cb reload      # 健康检查 / 改完扩展热重载

cb tabs                                 # 列标签页（* = 当前活动）
cb find 关键词                           # 按标题/URL 找
cb info   active                        # 标题/URL/视口/有没有弹窗挡着

cb text   active [选择器]                # 可见文字（抓内容首选）
cb html   active [选择器]
cb attr   active <选择器> <属性名>
cb wait-for active "<选择器>"            # 等元素出现且可见

cb eval   active "<js>"                 # 页面里跑 JS
cb click-el   active "<选择器>"          # 真实鼠标事件
cb click-text active "登录"
cb click  active <x> <y>
cb type   active "内容" --into "<选择器>"
cb key    active Enter                  # 组合键写 "meta+a"
cb focus / cb select / cb upload / cb hover / cb scroll
cb dialog active accept                 # 放行 alert/confirm，否则页面会一直卡死

cb nav    active https://example.com
cb shot   active --out /tmp/x.png       # --full 整页，--sel "<选择器>" 只截元素
cb console active / cb network active --reload
cb cursor active click 400 300          # 手动驱动光标
cb cdp    active Page.reload '{}'       # 原始 CDP 逃生口
```

`active` 可以换成具体 tabId。加 `--json` 出原始 JSON。点击和输入默认带动光标，`--no-cursor` 可关。

### 管理命令

```bash
dsh-chrome-bridge status      # 仓库版本 / 已装版本 / 运行版本 + 连接状态
dsh-chrome-bridge update      # 同步代码 + 热重载扩展（不用点 Chrome）
dsh-chrome-bridge test        # 端到端自检
dsh-chrome-bridge logs        # 扩展日志 + 宿主日志
dsh-chrome-bridge uninstall
```

## 🔒 安全

说实话：**这个扩展能读和操作你所有已登录的页面。**

- 桥是**纯本地**的。原生消息是私有管道；CLI socket 是 `0600` 且额外带 token。**自己不监听任何网络端口**（DSH 设置卡走的是 DSH 自带的本机网页服务，那条路由只收本机、拒跨站请求，也不能恢复控制）
- 附加期间 Chrome 一直显示"…正在调试此浏览器"的提示条 —— 这条提示条正是重点，你随时看得见它在工作
- 能以你的身份跑的程序本来就能读你的 Chrome 配置，这个不扩大边界。但它让这件事变得**很方便**，所以让 agent 无人值守地跑之前值得想一下
- **装了 DSH 插件之后，模型操作你的浏览器不会再问你要批准。** 插件工具跑在 DSH 宿主进程里，**不走** `bash` 那套沙箱和批准流程 —— 这正是"原生"的意义，但也意味着一个无人看管的 agent 手里握着你的浏览器。想要那道闸门，就在侧栏把插件停用
- 随时断开：点提示条上的**取消**，或 `cb detach <tab>`

## ⚠️ 已知限制

- **目前只有 macOS** —— 原生宿主的注册路径是 macOS 专有的，Windows/Linux 需要各自的注册目录
- **`chrome://` 内部页进不去** —— 浏览器禁止注入，换普通标签页
- `alert()` 会把页面卡死：`cb info` 会警告，`cb dialog accept` 放行
- Chrome 会把后台标签页的 `alert()` 推迟到该标签页获得焦点才弹
- 不走商店的话，Chrome 137+ 移除了 `--load-extension`，首次得在 `chrome://extensions` 手动加载
- 商店版会比仓库版晚一点：新版扩展要等商店审核

## 🔎 相关项目

DSH 浏览器插件这个方向已经挺热闹，值得一看：

- [dsh-plugin-browser-use](https://github.com/fatmind/dsh-plugin-browser-use) —— 复用已登录的 Chrome，暴露 `wc3_*` 工具
- [dsh-plugin-browser](https://github.com/menotbobbybrown/dsh-plugin-browser) —— 基于 Playwright 的浏览器自动化插件
- [dsh-browser-bridge](https://github.com/liyongzheng666/dsh-browser-bridge) —— localhost WebSocket 桥 + Firefox 扩展
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) —— DSH 插件精选目录

**这里的区别**：**不开监听端口**（走 native messaging）、**真实 CDP 输入事件**（`chrome.debugger`）、**页内光标会出现在截图里**。

## 🤝 贡献

欢迎 issue 和 PR。

`docs/NOTES.zh.md` 是开发过程中踩过的每一个坑的流水账——动扩展或插件之前先读它，能省你一天。里面还写了一套**不用重启你的 app 就能验证插件**的办法（临时 profile + headless）。

MIT 协议。
