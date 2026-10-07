# browser-agent-kit

让 DSH（DeepSeek Harness）原生地操作**浏览器**——装一次永久可用、不点 Connect、真实 CDP 事件。

## DSH Bridge（已跑通）

```
DSH(bash) → cb CLI → Unix socket → 原生宿主 ←native messaging→ Chrome 扩展 → chrome.debugger → CDP
```

| 部件 | 位置 | 说明 |
|---|---|---|
| Chrome 扩展 | `extension/` → 装到 `~/dsh-bridge-extension` | MV3，固定扩展 ID（manifest 里的 `key` 推导） |
| 原生宿主 | `host/host.js` + `run.sh` | Node，native messaging ↔ Unix socket 双向转发 |
| CLI | `bin/cb` | DSH 调它，像调本地命令一样 |

## 安装（一次性）

```bash
./install.sh
# 然后去 chrome://extensions → 开发者模式 → 加载未打包的扩展程序
# 选 ~/dsh-bridge-extension
```

装完**不用点任何 Connect**。扩展 ID 固定为 `mhlkjkblmdleplggfengldbdmkabloce`，已绑进原生宿主注册文件。

## 日常管理

```bash
./bridge status      # 仓库版本 / 已装版本 / 运行版本 + 连接状态
./bridge update      # 改完代码：同步 + 热重载扩展（不用点 Chrome 刷新）
./bridge test        # 端到端自检
./bridge logs        # 扩展日志 + 宿主日志
./bridge uninstall
```

## cb 速查

```bash
cb tabs                                   # 列标签页（* = 当前活动）
cb find 关键词                             # 按标题/URL 找
cb info   active                           # 标题/URL/视口/有没有弹窗挡着

cb text   active                           # 整页可见文字
cb text   active "article"                 # 指定元素
cb html   active "form"                    # 外层 HTML
cb attr   active "a" href
cb wait-for active "button.submit"         # 等元素出现（默认 15s）

cb eval   active "document.title"          # 页面里跑 JS
cb click-el   active "button.submit"       # 按选择器点（真实鼠标事件）
cb click-text active "登录"                # 按文字点
cb click  active 400 300                   # 按坐标点
cb type   active "hello" --into "input"    # 输入
cb key    active Enter                     # 按键；组合键写 "meta+a"
cb focus  active "#email"
cb select active "select#city" 杭州
cb upload active "input[type=file]" ~/a.pdf
cb hover  active --sel "button"
cb scroll active --dy 600
cb dialog active accept                    # 放行 alert/confirm（否则页面会卡住）

cb nav    active https://example.com
cb shot   active --out /tmp/x.png          # 截图（页内光标会一起入镜）
cb shot   active --full                    # 整页
cb shot   active --sel "svg"               # 只截某个元素
cb console active                          # 页面 console
cb network active --reload                 # 网络请求（谁 404 了、谁慢）
cb cursor active click 400 300             # 页内光标：move / click / hide
cb cdp    active Page.reload '{}'          # 原始 CDP 逃生口
cb reload / cb version                     # 热重载 / 看扩展版本
```

`active` 可以换成具体 tabId。任何命令加 `--json` 出原始 JSON。
**点击和输入默认会带动页内光标**（飞过去 → 涟漪 → 真点击），加 `--no-cursor` 关掉。

## DSH 技能

`install.sh` 会装一个 `browser` 技能到 `~/.dsh/skills/browser/SKILL.md`，
所以**新会话自己就知道 `cb` 怎么用**，不用你每次交代。
改技能内容：编辑 `skill/SKILL.md` 后跑 `./bridge update`（技能目录是热监视的，立刻生效）。

## 为什么自建

Chrome 官方 `--autoConnect`、Browser MCP、hangwin/mcp-chrome 都要**每次手点允许/连接**。
自建扩展用 `chrome.debugger`，只有一条提示条、显示自己的名字，装一次之后永远可用。

## 其他文件

- `scratch/` —— 光标浮层的两份源码（页内 / 系统级 NSPanel）
- `notes/HANDOFF.md` —— 2026-10-07 凌晨那轮调研的完整结论与踩坑
