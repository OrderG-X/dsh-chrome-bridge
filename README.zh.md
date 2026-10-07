<div align="center">

<img src="assets/hero.svg" alt="dsh-chrome-bridge — 让 DSH 的 agent 在你正在用的 Chrome 里动手" width="760" />

<p>
  <a href="https://github.com/OrderG-X/dsh-chrome-bridge/releases"><img src="https://img.shields.io/github/v/release/OrderG-X/dsh-chrome-bridge?label=release&color=4D6BFE" alt="release" /></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" />
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
- 👀 **人看得见的光标** —— 每次点击都会有个页内小光标飞过去、闪个涟漪、冒个标签。它渲染在页面里，所以**会出现在截图里**

## 🏗 架构

```
DSH 的 agent（harness 自带，本仓库不提供）
  ├── browser_* 原生工具（DSH 插件） ─┐
  └── cb CLI          （命令行）     ─┤
                                     ▼
                    Unix socket  /tmp/dsh-bridge.sock   (0600 + token)
                                     ▼
                    Node 原生宿主  ←─ native messaging (stdio) ─→  Chrome 扩展 (MV3)
                                                                        │ chrome.debugger
                                                                        ▼
                                                                   真实 CDP
```

**本仓库不含 agent** —— 上面那个 agent 是 DSH（harness）自带的，我们只给它一双手。

扩展 ID 由 `extension/manifest.json` 里的公钥固定，所以**每台机器上装的 ID 都一样**，注册文件不用改。

## 🚀 安装

要求：**macOS**、**Chrome 116+**、**Node.js 18+**、`python3`（只用于算扩展 ID）。

```bash
git clone https://github.com/OrderG-X/dsh-chrome-bridge.git
cd dsh-chrome-bridge
./install.sh
```

然后一次性手动步骤（一辈子就一次）：

1. 打开 `chrome://extensions`
2. 右上角打开**开发者模式**
3. **加载未打包的扩展程序** → 选 `~/dsh-bridge-extension`

验证：

```bash
cb status     # 宿主 pid … | 扩展连接: ✅
cb tabs
```

### 🧩 可选：DSH 原生工具

不装也能用，只是要从命令行敲 `cb`。装了之后 DSH 多出 **9 个原生工具**，而且截图会**当图片返回**，模型真的看得见。

侧栏 → **插件** → **添加插件** → 粘贴下面任一个 → 安装 → 启用 → **重启 DSH**：

```
/本仓库绝对路径/plugin                          # 本地路径（开发时推荐）
github:OrderG-X/dsh-chrome-bridge#path:plugin   # 直接装 GitHub，不用 clone
```

| 工具 | 干什么 |
|---|---|
| `browser_tabs` | 列 / 找 / 开 / 关 / 切标签页 |
| `browser_read` | 读文字 / HTML / 属性 / 页面信息 |
| `browser_click` | 按选择器、文字或坐标点 |
| `browser_input` | 输入 / 按键 / 选下拉 / 传文件 / 悬停 / 滚动 |
| `browser_nav` | 跳转并等加载 |
| `browser_screenshot` | 截图，**以图片返回**（视口 / 整页 / 元素） |
| `browser_eval` | 页面里跑 JS |
| `browser_wait` | 等元素出现 |
| `browser_dialog` | 放行 alert / confirm / prompt |

> 新装的 bundle 不会热加载，必须重启一次 app。
> CLI 的 `dsh plugin add` 对 app 独占的 profile 会拒绝，走 GUI。
> DSH 目前**不支持插件自动更新**：升级要卸载后重装。用**本地路径**装的是 `link:`，`git pull` 一下就够。

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

- 桥是**纯本地**的。原生消息是私有管道；CLI socket 是 `0600` 且额外带 token。**不监听任何网络端口**
- 附加期间 Chrome 一直显示"…正在调试此浏览器"的提示条 —— 这条提示条正是重点，你随时看得见它在工作
- 能以你的身份跑的程序本来就能读你的 Chrome 配置，这个不扩大边界。但它让这件事变得**很方便**，所以让 agent 无人值守地跑之前值得想一下
- **装了 DSH 插件之后，模型操作你的浏览器不会再问你要批准。** 插件工具跑在 DSH 宿主进程里，**不走** `bash` 那套沙箱和批准流程 —— 这正是"原生"的意义，但也意味着一个无人看管的 agent 手里握着你的浏览器。想要那道闸门，就在侧栏把插件停用
- 随时断开：点提示条上的**取消**，或 `cb detach <tab>`

## ⚠️ 已知限制

- **目前只有 macOS** —— 原生宿主的注册路径是 macOS 专有的，Windows/Linux 需要各自的注册目录
- **`chrome://` 内部页进不去** —— 浏览器禁止注入，换普通标签页
- `alert()` 会把页面卡死：`cb info` 会警告，`cb dialog accept` 放行
- Chrome 会把后台标签页的 `alert()` 推迟到该标签页获得焦点才弹
- Chrome 137+ 移除了 `--load-extension`，首次必须在 `chrome://extensions` 手动加载
- **不走 Chrome 应用商店** —— `debugger` 权限在那里基本不可能过审

## 🤝 贡献

欢迎 issue 和 PR。

`docs/NOTES.zh.md` 是开发过程中踩过的每一个坑的流水账——动扩展或插件之前先读它，能省你一天。里面还写了一套**不用重启你的 app 就能验证插件**的办法（临时 profile + headless）。

MIT 协议。
