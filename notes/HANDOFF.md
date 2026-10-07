# 交接笔记（2026-10-07 凌晨那一轮）

## 一、目标

让 DSH 能：
1. 操作**用户正在用的** Chrome（带登录态、不新开浏览器）
2. 操作**桌面 App**（点击、输入、看屏幕）
3. 操作时**看得见**（页内光标 / 屏幕浮层光标），且**不抢前台**

## 二、实测结论：三条通道

| 通道 | 结论 |
|---|---|
| **Chrome 官方**（`chrome://inspect/#remote-debugging` + `chrome-devtools-mcp --autoConnect`） | 能用。读 DOM/点击/截图都行。**毛病：每次连接 Chrome 弹"要允许远程调试吗？"，提示条写"自动测试软件正在控制 Chrome"**，用户每次要点允许 |
| **Browser MCP**（商店扩展 + `@browsermcp/mcp`） | 能用。**毛病：每个标签页都要手点扩展图标 → Connect**，不是原生手感 |
| **hangwin/mcp-chrome**（扩展 + `mcp-chrome-bridge`） | 未实测。README 说要"点连接"，推测也是手动（但可能只要一次） |
| **自建扩展 + 原生宿主** | ✅ **已跑通**。装一次永久可用、无 Connect、真实 CDP 事件。架构见第四节 |

**用户裁决：以上"垃圾插件"全部删除，转向自建方案。**

## 三、Computer Use（桌面操作）

- 官方**只有接口层**：`@deepseek-ai/dsh-computer-use@0.1.6-alpha.1`，描述是
  "Exclusive named computer-use provider registration"。
  `-darwin/-macos/-native/-local` 变体在 npm 上**全部 404** → **官方没有 macOS 实现**。
- 可用的是社区包 **`@anionex/dsh-computer-use`**（macOS 14+，Accessibility-first，
  不移动系统光标、不抢前台、有 stale-observation 保护和确认机制）。
- 重要**行为**（不是 bug，是设计）：
  - 它的 Agent 光标**只在目标应用处于前台时显示**（README「独立 Agent 光标」段，
    CHANGELOG 0.3.3 甚至专门改成"失去焦点立即隐藏"）
  - 用辅助功能通道（AXPress）点元素时**不产生指针**，所以没有光标
  - 配置只有 `cursorVisualization: hidden | visible`，没有"后台也显示"这一档
- 已知 bug：Chrome 窗口贴在屏幕左边缘时 `window.frame.x = -0`，
  DSH 的无损 JSON 校验**拒收负零**（`Object.is(current, -0)`）→ 整条观测被拒，
  报 `value is not lossless JSON`。修法：在插件观测出口做归一化
  （`-0`→`0`、稀疏数组补洞、剔除 symbol/非枚举键、断环、非有限数转 null）。
  同一条校验还拒收：undefined/NaN/Infinity/BigInt、类实例、Date/Map/Set、循环引用。
- **工具挂在技能后面**：每次 DSH 重启后，要先加载 `dsh-computer-use` 技能，`computer_*` 工具才出现。

## 四、自建 DSH Bridge 架构（已跑通，文件已删，可按此重建）

```
DSH(bash) → cb CLI → Unix socket → 原生消息宿主 ←stdio(native messaging)→ Chrome 扩展(SW)
                                                                          ↓ chrome.debugger
                                                                    真实 CDP 事件
```

**三个部件：**

1. **扩展**（MV3）`permissions: ["debugger","tabs","scripting","alarms","nativeMessaging"]`
   - 固定扩展 ID：manifest 里写 `key`（= RSA 公钥 base64 DER），
     ID = sha256(DER) 前 16 字节，每位 hex 映射 a–p
   - background service worker：`chrome.runtime.connectNative('com.dsh.bridge')` 常驻；
     `chrome.alarms` 保活；`chrome.debugger.attach({tabId},'1.3')` 后 `sendCommand`
   - 关键 op：`tabs / eval / click(Input.dispatchMouseEvent) / text(Input.insertText)
     / nav / shot(Page.captureScreenshot) / key / activate / detach`
   - **好处**：真实事件（有 userGesture，弹窗不被拦）、提示条显示扩展自己的名字、
     **不用任何手点 Connect**
2. **原生宿主**（Node）：stdin/stdout 走 native messaging 协议（4 字节 LE 长度前缀 + JSON），
   同时监听 `/tmp/dsh-bridge.sock` 给 CLI 用；socket 0600 + token 文件校验
3. **CLI** `cb`：`cb tabs / cb text <id> / cb click-el <id> <选择器> / cb click-text <id> <文字>
   / cb cursor / cb shot / cb eval / cb cdp`

**注册**：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<name>.json`，
`allowed_origins: ["chrome-extension://<扩展ID>/"]`。

**页内光标**：`cb cursor` 往页面注入 Shadow DOM 浮层（fixed + 最高 z-index + pointer-events:none），
点击时画涟漪。优势：**它会出现在截图里**，人和模型看到同一画面。
（保留的代码：`~/.dsh/chrome-cursor/in-page-cursor.js`）

## 五、两个很好用的"歪招"（省掉大量手点）

1. **用 CDP 装解压扩展，不用点文件选择器**：
   连上 browser 级 CDP 端点（端口从 `~/Library/Application Support/Google/Chrome/DevToolsActivePort` 读），
   调 `Extensions.loadUnpacked { path }` → 返回 `{id}`。**这一招直接绕过了
   chrome://extensions 的按钮点不动问题**。
   （注：该域对**商店扩展**无效——`Extensions.uninstall` 对非解压扩展会拒绝。）
2. **CDP + shadow DOM 穿透点 chrome:// 页面**：
   chrome://extensions 是嵌套 shadow DOM（`extensions-manager` → `extensions-item-list` →
   `extensions-item`），必须逐层进 `shadowRoot` 才能拿到卡片和按钮。
   靠这个成功移除了商店装的扩展（SkyLight 坐标点击点不动 WebUI）。

## 六、DSH 插件机制的关键事实

- profile 根：`~/.dsh/profiles/desktop/`，插件配置在 `cordis.patch.yml`（patch 层）
- **新增条目必须用 `insert:`**；顶层 `- id: xxx` 是"覆盖已有条目"，
  写错会报 `patch: entry "xxx" not found`
- 插件包用官方 pnpm 装（`/Applications/DeepSeek Harness.app/.../runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs`）
- **Node 的 ESM 缓存不会因为插件启停而失效**：改插件源码必须重启 DSH，
  或把插件复制成新包名再挂（`insert` 一个不同 `name`）
- 用 app 自带 CLI dump 配置（`desktop` profile 被占，要先 `cp -R` 成别的名字）：
  `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" <app.asar>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile <副本> --dump-config`
- 这个 profile 里 `~/.dsh/profiles/node_modules` 是 **203 个断掉的符号链接**（指向已改名的
  `/Applications/DSH Desktop.app`），目前不影响运行，但动插件安装时要留意

## 七、现状（本轮结束时）

- **已删**：`@anionex/dsh-computer-use`（含 -fixed 副本）、`@deepseek-ai/dsh-mcp-client`、
  `chrome-devtools-mcp`、`@browsermcp/mcp`；Chrome 扩展 2 个（DSH Bridge / Browser MCP）；
  原生宿主注册、`~/.dsh/chrome-bridge`、`~/.dsh/patches`、`~/.dsh/bin/cb`
- `cordis.patch.yml` 已还原为原始 9 条，`bundles` 还原为 6 个
- **保留**：光标浮层（用户认可）
  - 源码 `~/.dsh/cursor-overlay/cursor-overlay.swift`
  - 二进制 `~/.dsh/bin/dsh-cursor-overlay`，控制 CLI `~/.dsh/bin/dsh-cursor`
  - 特性：NSPanel + `.nonactivatingPanel` + `orderFrontRegardless` → **不抢前台**；
    `ignoresMouseEvents` → 点击穿透；`level = .screenSaver` → 永远置顶；颜色 `#4D6BFE`
  - 启动：`~/.dsh/bin/dsh-cursor-overlay &`

## 八、下一步可选

- [ ] 按第四节重建 DSH Bridge（代码约 300 行，当时已验证可跑）
- [ ] 给 `@anionex/dsh-computer-use` 提 issue：`-0` 兼容性 + 增加 `cursorVisualization: always`
- [ ] 给 DeepSeek 反馈：官方 computer-use 只有注册层、没有实现
- [ ] 若还想走现成方案，优先试 `hangwin/mcp-chrome`（确认是否只需连接一次）

---

# 2026-10-07 上午 —— 第四节已重建完成（实测可用）

## 落地位置

- 源码在本仓库：`extension/`（MV3 扩展）、`host/`（Node 原生宿主）、`bin/cb`（CLI）
- 安装产物：扩展 `~/dsh-bridge-extension`（**故意放可见目录**，Chrome 文件框点侧边栏
  「guo」就能选中，不用 ⌘⇧G 去开隐藏目录）；宿主 `~/.dsh/chrome-bridge/host/`；
  CLI `~/.dsh/bin/cb`
- 扩展 ID **`mhlkjkblmdleplggfengldbdmkabloce`**，由 manifest 里的 `key`（RSA 公钥
  base64 DER）推导，永久固定，已写进 `allowed_origins`

## 与第四节设计的两处不同

1. **大结果分片**：native messaging 单条消息有上限，截图 base64 会超。
   扩展 → 宿主方向按 200KB 分片（`{id, chunk:{seq,total}, data}`），宿主重组。
2. **热重载**：加了 `reload` op（`chrome.runtime.reload()`）+ `./bridge update`，
   改完扩展代码不用再去 chrome://extensions 点刷新。

## 实测结论（2026-10-07 09:2x）

- ✅ 读到用户真实 Chrome 的 8 个标签页、真实登录态
- ✅ `cb eval` / `cb shot`（263KB PNG）/ `cb cursor`（页内光标入镜）全部通过
- ✅ 装完无 Connect、无弹窗，只有一条"DSH Bridge 正在调试此标签页"提示条
- ⚠️ `active` 指向 `chrome://` 页面时 CDP 拒绝（`Cannot access a chrome:// URL`），
  要用具体 tabId 换一个普通网页

## 踩坑记录（新增）

- **Chrome 137+ 已移除 `--load-extension`**，首次必须手动"加载未打包"（3 步，一辈子一次）
- **`chrome://extensions` 无法用 `open` 命令打开**（LaunchServices 不认 chrome:// scheme），
  要用 AppleScript `make new tab with properties {URL:"chrome://extensions/"}`
- **bash 里 `$VAR` 紧跟中文标点会被当成变量名的一部分**（`$EXT_DIR）` → unbound variable），
  必须写 `${EXT_DIR}`
- **MV3 SW 刚重启时宿主会误判"扩展未连接"**：宿主只在上次收到扩展消息后才置 `extReady`。
  修法：扩展 connectNative 成功后主动发一条 `{hello:true}`
- **CLI 用 `sock.end()` 收尾进程不退出**（对端不关连接，句柄一直挂着），改 `sock.destroy()`
  + `process.exit(0)`

