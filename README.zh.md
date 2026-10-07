# dsh-chrome-bridge

**让 DSH agent 在你正在用的 Chrome 里动手**——带你的登录态、你的标签页、你的会话。装一次，永远不用再点 Connect。

[English](README.md) · [设计与踩坑记录](docs/NOTES.zh.md)

```bash
cb tabs                          # 列出你真实的标签页
cb text active                   # 读页面可见文字
cb click-text active "登录"       # 按文字点 —— 真实鼠标事件
cb shot active --out /tmp/x.png  # 截图（光标会一起入镜）
```

---

## 为什么还要再造一个

现有方案每次都要你点一下：

| 方案 | 毛病 |
|---|---|
| `chrome-devtools-mcp --autoConnect` | **每次**连接 Chrome 都弹"要允许远程调试吗" |
| Browser MCP（商店扩展） | **每个标签页**都要点扩展图标 → Connect |
| 各种 WebSocket 桥 | 开一个 TCP 端口，谁连上都能用 |
| **dsh-chrome-bridge** | 没有要点的东西，也没有在监听的端口 |

三点关键差异：

1. **native messaging，不开端口。** 扩展通过 Chrome 的原生消息管道跟本地 Node 宿主通信；CLI 通过一个 `0600` 的 Unix socket 找宿主，还带 token 校验。没有 TCP 端口可扫，没有 origin 可伪造。
2. **`chrome.debugger`，不是注入脚本。** 点击和按键走真实 CDP `Input.*` 事件，带 user gesture —— 弹窗能开、焦点正常、那些拒绝合成事件的站点也照常工作。顺带白拿截图、网络、console 和任意 CDP。
3. **人看得见的光标。** 每次点击都会有个页内小光标飞过去、闪个涟漪、冒个标签。它渲染在页面里，所以**会出现在截图里**——人和模型看到的是同一画面。

---

## 架构

```
DSH agent
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

扩展 ID 由 `extension/manifest.json` 里的公钥固定，所以**每台机器上装的 ID 都一样**，注册文件不用改。

---

## 安装

要求：**macOS**、**Chrome 116+**、**Node.js**、`python3`（只用于算扩展 ID）。

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

### 可选：DSH 原生工具

不装也能用，只是要从命令行敲 `cb`。装了之后 DSH 多出 **9 个原生工具**（`browser_tabs`、`browser_read`、`browser_click`、`browser_input`、`browser_nav`、`browser_screenshot`、`browser_eval`、`browser_wait`、`browser_dialog`），而且截图会**当图片返回**，模型真的看得见。

DSH 侧栏 → **插件** → **添加插件** → 粘贴本仓库 `plugin/` 目录的绝对路径 → 安装 → 启用 → **重启 DSH**。

> 新装的 bundle 不会热加载，必须重启一次 app。
> CLI 的 `dsh plugin add` 对 app 独占的 profile 会拒绝，走 GUI。

---

## 用法

### `cb` 命令

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

`active` 可以换成具体 tabId。加 `--json` 出原始 JSON。
点击和输入默认会带动可见光标，加 `--no-cursor` 可关。

### 管理命令

```bash
dsh-chrome-bridge status      # 仓库版本 / 已装版本 / 运行版本 + 连接状态
dsh-chrome-bridge update      # 同步代码 + 热重载扩展（不用点 Chrome）
dsh-chrome-bridge test        # 端到端自检
dsh-chrome-bridge logs        # 扩展日志 + 宿主日志
dsh-chrome-bridge uninstall
```

---

## 安全

说实话：**这个扩展能读和操作你所有已登录的页面。**

- 桥是**纯本地**的。原生消息是私有管道；CLI socket 是 `0600` 且额外带 token。不监听任何网络端口。
- 附加期间 Chrome 会一直显示"…正在调试此浏览器"的提示条。这条提示条正是重点——你随时能看见它在工作。
- 能以你的身份跑的程序本来就能读你的 Chrome 配置，这个不扩大边界。但它让这件事变得**很方便**——所以让 agent 无人值守地跑之前，值得想一下。
- 随时断开：点提示条上的**取消**，或 `cb detach <tab>`。

## 已知限制

- **目前只有 macOS**——原生宿主的注册路径是 macOS 专有的，Windows/Linux 需要各自的注册目录。
- **`chrome://` 内部页进不去**——浏览器禁止注入，换普通标签页。
- `alert()` 会把页面卡死：`cb info` 会警告你，`cb dialog accept` 放行。
- Chrome 会把后台标签页的 `alert()` 推迟到该标签页获得焦点才弹。
- Chrome 137+ 移除了 `--load-extension`，所以首次必须在 `chrome://extensions` 手动加载。
- **不走 Chrome 应用商店**——`debugger` 权限在那里基本不可能过审，只提供解压安装。

## 贡献

欢迎 issue 和 PR。`docs/NOTES.zh.md` 是开发过程中踩过的每一个坑的流水账——动扩展或插件之前先读它，能省你一天。

MIT 协议。
