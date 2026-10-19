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

- 源码在本仓库：`plugin/vendor/extension/`（MV3 扩展）、`plugin/vendor/host/`（Node 原生宿主）、
  `plugin/vendor/cb`（CLI）、`plugin/vendor/skill/`、`plugin/vendor/in-page-cursor.js`（页内光标）
  —— 全都在插件包内，所以 `dsh plugin add <tarball>` 一个动作就把宿主带过去；插件里的
  `plugin/setup.js` 在首次加载时自动落盘并写注册文件（不再需要 python3、不再需要 clone 仓库）
- 安装产物：扩展 `~/dsh-bridge-extension`（**故意放可见目录**，Chrome 文件框点侧边栏
  点侧边栏的家目录就能选中，不用 ⌘⇧G 去开隐藏目录）；宿主 `~/.dsh/chrome-bridge/host/`；
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

---

# 2026-10-07 上午（第二轮打磨）—— v1.1.0

## 新增

- **点击/输入自动带动页内光标**：`click` / `click-el` / `click-text` / `type --into`
  会先让光标飞过去（0.45s 缓动）、冒个"点击 XX"小标签、再发真实鼠标事件。
  这才是"看得见"的完整闭环——以前只有显式 `cb cursor` 才有光标。
  加 `--no-cursor` 可关。
- **读取类操作**：`text` / `html` / `attr` / `info` / `wait-for`
- **输入类操作**：`hover` / `scroll` / `focus` / `select` / `upload`（走 `DOM.setFileInputFiles`）
- **弹窗处理**：`Page.javascriptDialogOpening` 会被记下来，`cb info` 会警告
  "有 alert 挡着"，`cb dialog accept|dismiss` 放行。**不处理的话页面会一直卡住**
  （Runtime.evaluate 会挂到超时）——这是浏览器自动化最常见的坑
- **报错人话化**：`friendly()` 把 CDP 英文错误翻成中文提示
  （chrome:// 内部页 / 标签页已关 / DevTools 占着调试器 / 上下文丢失 / 没有弹窗）
- 光标脚本升级：按压缩放（CSS `scale` 独立属性，不打架 translate）、标签气泡、`version:2`

## 实测

- `text` / `wait-for` / `hover` / `scroll` / `attr` / `info`（含视口）/ `click-el` 全通过
- 截图验证：页内光标确实出现在点击位置（`/tmp/dsh-polish.png`）
- 版本流：改 manifest → `./bridge update` → 热重载 → `cb version` 报 1.1.0 ✅

## 又踩一个坑

- **`example.com` 现在没有 `<h1>` 了**（改版成 SVG + `<p>`），拿它当测试靶子会误判
  `wait-for` 有 bug。测选择器之前先 `cb eval` 看一眼真实 DOM。

## 已知限制

- Chrome 会把后台标签页的 `alert()` 推迟到该标签页获得焦点才弹，所以弹窗路径
  在后台标签上不好测（代码路径本身是标准 CDP）
- `active` 指向 `chrome://` 页面时所有注入类命令都会失败，报错已明确提示换 tabId

---

# 2026-10-07 上午（第三轮打磨）—— v1.2.0

## 1. DSH 技能（这轮最重要的）

**问题**：桥再强，新会话也不知道 `cb` 存在——每开一个会话都得重新交代一遍。

**解法**：写了 `skill/SKILL.md`，`install.sh` / `./bridge update` 会装到
`~/.dsh/skills/browser/SKILL.md`。

- skill 根目录（rank 顺序，来自 `dsh-skill-filesystem` 的 README）：
  100 `<项目>/.dsh/skills` → 200 `<项目>/.agents/skills` → 300 custom →
  400 `~/.dsh/skills` → 500 `~/.agents/skills` → 600 随包
- 格式：目录 bundle `<name>/SKILL.md`，YAML frontmatter 必填 `name` + `description`，
  可选 `whenToUse`；**刻意不支持嵌套 `**/SKILL.md`**
- **实测：技能目录是热监视的**，写完不用重启 DSH，下一轮会话的
  `<available_skills>` 里就出现了 `browser`
- 技能里写进了全部硬规矩（chrome:// 进不去、先查弹窗、先看真实 DOM 再写选择器、
  点击会自动带光标所以别重复调、用 click-el 别用 el.click()）

## 2. 截图升级

- `cb shot <tab> --full` —— 整页（`captureBeyondViewport`）
- `cb shot <tab> --sel "<选择器>"` —— 只截元素（`clip` + 先 scrollIntoView）

## 3. 网络记录

- `cb network <tab> [--reload] [--filter 关键词] [--clear]`
- 环形缓冲 400 条，记 method/status/url/type/耗时/失败原因
- **坑**：Network 事件只在 attach 之后才产生，所以 `cb network` 会先 attach；
  想看"这个页面加载了什么"必须 `--reload`（会先清缓冲再刷新再等 2.5s）

## 4. 崩溃恢复实测

杀掉宿主进程 → Chrome 3 秒内重新拉起 → 扩展自动重连 → `cb status` 恢复 ✅
（扩展侧 `onDisconnect` 800ms 重连 + `chrome.alarms` 30s 保活兜底）

---

# 2026-10-07 上午（第四轮）—— DSH 原生插件

## 做成了什么

`plugin/` 是一个正经的 DSH bundle，装进 profile 后 DSH 多出 9 个原生工具
（`browser_tabs/read/click/input/nav/screenshot/eval/wait/dialog`），不用再走 bash 调 `cb`。

**传输层刻意做薄**：插件就是个 Unix socket 客户端，协议和 `cb` CLI 一模一样，
所以插件 / CLI / 宿主 / 扩展四者共用同一份实现，没有第二套逻辑。

## bundle 的写法（官方文档给的，别再猜）

```
plugin/
  package.json        # "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
  cordis.patch.yml    # - insert: [ { id, name: '@local/...' } ]
  index.js            # export function apply(ctx, config) {} / export const inject = ['tools']
  icon.svg            # package.json 顶层 "icon" 字段（≤256KiB，相对路径）
```

- 权威文档在 app.asar 里自带：
  `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`（SKILL.md + references/）
- **随包发布的包（`@deepseek-ai/*`）不用声明依赖**，loader 负责解析

## 截图直接给模型看

`output.render` 返回内容块，图片块形状是：
```js
{ type: 'image', attachment: ref }   // ref 来自 ctx.attachments.saveImages([{data, mediaType, name}])
```
`render` 是同步的，而 `saveImages` 是异步的——所以 execute 里存好 ref、
把 token 放进返回值，render 再用 token 取回来（`shotRefs` 那个 Map）。
拿不到 attachments 就退回写文件 + 提示用 `read_image`。

## 踩坑

1. **`dsh plugin add` 对 desktop profile 直接拒绝**：
   `error: profile "desktop" is managed exclusively by the Electron application`。
   只能走 GUI 侧栏「插件」→「添加插件」（**接受本地绝对路径**）。
2. **装完必须重启 DSH**。实测：app 进程 03:38 启动，插件 10:27 装好，
   package.json / node_modules 软链 / 组合后的 cordis.yml 全都正确，
   但 app 从没 import 过插件模块（lsof 查不到），新会话里也没有 `browser_*` 工具。
   结论：新 bundle 不会热加载，别指望 HMR。
3. **`@deepseek-ai/dsh-tools` 在 profile 上下文里解析不到**（裸 node 实测
   `ERR_MODULE_NOT_FOUND`）。官方说随包发布的包能从安装目录解析，但为了不让
   一行 import 把整个插件搞挂，改成动态 import + 等价兜底实现（属性表 → JSON Schema）。
4. 插件是 `link:` 装的（软链到本仓库），所以改代码不用重装，但要重启才生效。

## 验证插件是否真的活了（不靠猜）

- 组合后的配置：`cp -R` profile 到别的名字再 `--dump-config`，grep 插件 id（CLI 不让 dump desktop 本体）
- 运行时是否加载：`lsof -p <app pid> | grep 插件路径` + 新会话里看有没有 `browser_*` 工具
- **工具目录是按会话冻结的**：同一个会话里新装的工具不会中途出现，要新会话





---

# 插件为什么一开始没加载（真因，2026-10-07 11:0x）

## 结论：插件代码没问题，是模块 import 挂了

排查过程（每一轮都重启 app 太贵，所以用临时 profile 在 CLI 里验）：

```bash
cp -R ~/.dsh/profiles/headless ~/.dsh/profiles/plugtest
dsh plugin --profile plugtest add <repo>/plugin   # 非 app 独占的 profile 可以装
dsh --profile plugtest "调用 browser_tabs ..."                                   # headless 起一次，看 trace 日志
```

**这样不用动用户的 app 就能验证插件**，省掉反复重启。

## 两个坑

1. **`@deepseek-ai/dsh-tools` 在 profile 上下文解析不到**（裸 node 实测 ERR_MODULE_NOT_FOUND）。
   静态 import 它 → 整个插件模块加载失败 → 行挂掉，而错误只在 app 进程里，外面看不见。
   **修法：插件零外部依赖**，工具对象按 dsh-tools 的产出形状手搓
   （属性表 → JSON Schema；output.schema 直接写 JSON Schema 的 `required: [...]` 数组形式）。
2. **顶层 await 也不要写**（动态 import 兜底那版就是栽在这）——
   loader 怎么加载模块不完全可控，能不用就不用。

## 加自检日志

插件模块顶部和 apply() 里往 `/tmp/dsh-browser-bridge.log` 写一行。
"插件到底有没有被 import" 这个问题，看一眼日志就有答案，比 lsof 猜靠谱
（lsof 只在文件句柄还开着时才有输出，Node import 完就关了，**不能用来判断有没有加载过**）。

## 最终验证（headless，全链路）

```
2026-10-07T03:01:06 模块已加载 / apply 被调用 / 已注册 9 个工具
```
agent 回答工具列表：browser_click, browser_dialog, browser_eval, browser_input,
browser_nav, browser_read, browser_screenshot, browser_tabs, browser_wait

真调 `browser_tabs` → 读到用户真实 Chrome 的标签页 ✅
（DSH 工具 → socket → 宿主 → 扩展 → CDP → 真 Chrome 全线打通）

---

# 定位：我们不提供 agent（2026-10-07）

DSH（DeepSeek Harness）本身就是 harness —— agent 循环、模型路由、上下文、工具注册表、
权限与沙箱，全是它提供的。所以这个项目**不打包任何 agent**，只提供"手"：

- Chrome 扩展 = 手（真实 CDP 事件）
- 原生宿主 + `cb` = 神经（本地传输）
- DSH 插件 = 把手的动作注册成 `browser_*` 工具
- DSH 技能 = 给模型的说明书

**推论（改这个项目时要注意）**：

1. **不要把 agent 逻辑塞进插件。** 不要自己写决策循环、重试策略、上下文压缩、
   "自动完成多步任务"之类。那是 DSH 的活，塞进去只会和它的循环打架。
   插件的每个工具应该是**一次明确的动作**，做决定的是模型。
2. **不要把 DSH 的内部接口当稳定 API。** DSH 现在是 `0.2.0-rc.x`。插件只依赖三个东西：
   `export function apply(ctx, config)`、`ctx.tools.register(tool)`、`ctx.get('attachments')`。
   而且**刻意不 import 任何 `@deepseek-ai/*` 包**（profile 里解析不到，一挂就是整个模块挂），
   工具对象的形状按 dsh-tools 的产出**手搓**。接口要是变了，改一处就行。
3. **工具名用 `browser_` 前缀**，是通用词。DSH 哪天内置浏览器工具就可能撞名 ——
   真撞了改前缀即可，但别用 `dsh_` / `chrome_` 这种更像官方占用的前缀。
4. **装了插件 = 模型操作浏览器不再需要批准。** 插件工具跑在宿主进程里，不走 `bash`
   那套沙箱/批准（plugin-manager 的 README 也写了："已安装的 Host 代码在宿主进程内运行，
   不受工作区沙箱限制"）。这不是 bug，是"原生"的代价 —— 但必须写进 README 的安全章节，
   让用户知道停用插件才是那道闸门。
5. **技能和工具是两套入口，要同时维护、别互相矛盾。** 技能里写的是 `cb` 命令，
   装了插件后模型手里是 `browser_*` 工具。所以技能第一段就写"能用工具就用工具"，
   不然模型会在有工具的情况下绕去 shell，白白多一层转义和进程开销。

---

# 图片撞上限把会话打死（2026-10-11）

## 症状

长会话（截图多）某次请求直接红掉，且**再也发不出去**：

```
400: {"type":"invalid_request_error","message":"Upstream request failed:
      [invalid_request_error] Too many images in request: 65 > 64"}
```

每次重发还是 65 张 → 会话作废，只能新开。

## 真因

DSH 本来有这套机制：适配器预检超预算 → 抛 `IMAGE_OFFLOAD_REQUIRED` →
`dsh-compaction-image-offload` 记一条 `image/offload`，把最老的图换成占位 → 自动重试。
但 **pi-ai 这条路由（opencode-go）只预检字节数（`maxRequestImageBytes`），不管张数**
（`dsh-llm-deepseek` 那个 `maxImagesPerRequest` 默认 600，且不在 pi-ai 的配置面上），
所以上游的 64 张硬限没有任何人拦，错误直接砸到会话上。

## 修法：`plugin/image-guard.js`

1. `agent/request-error` 里自己认这个错（正则抠出 `N > M`），卸 `N-M+8` 张最老的图，
   记一条和内置同形状的 `image/offload`，返回 `{ kind: 'retry' }`；
2. **自己注册 `image/offload` 投影** —— 实测 desktop profile 里内置的
   `compaction-image-offload` 没挂，直接 append 会抛
   `requires a message projection`。投影定义是从内置那份逐行对齐抄的（纯函数，语义一致），
   已经有人注册就跳过（不重复注册）。

没有图可卸 / 记不进 session 时照旧 `next()`，所以最坏情况和不装这个守卫一样。

## 验证

- `node scratch/test-image-guard.mjs` —— 6 个用例：抠数字、跳过 assistant 节点和已卸下的图、
  投影标记 + 冻结、无图可卸放行、append 抛错放行、投影重名不炸。
- 线上：改完 HMR 就把插件重挂了（trace 里 "模块已加载" → "已注册 image/offload 投影"），
  下一次失败立刻打出 `图片超限：卸下最老的 9 张并重试本轮` —— 说明这条路真的走通了。

## 注意

- 这条守卫是**补 DSH 缺的那一环**，形状和内置插件一致，不是往插件里塞 agent 逻辑；
  上游要是给 pi-ai 加上张数预检，这个文件可以直接删。
- 会话文件里那些 `image/offload` 事件是**永久决策**：被卸下的图以后只发占位文本，
  模型再也看不到那几张老截图（这正是设计意图）。


---

# 2026-10-17 —— 装法收口：宿主随包 + 引导式手动

- 宿主全收进 `plugin/vendor/`（MV3 扩展、native host、`cb`、页内光标脚本、技能），
  插件首次加载由 `plugin/setup.js` 自动落盘并写注册文件 —— 不再需要 clone 仓库、
  `./install.sh`、`python3`；`dsh plugin add <tarball>` 一个动作就够。
- 商店路线暂缓：Chrome 137+ 无法脚本装扩展（`--load-extension` 实测已失效），
  商店又要审 `debugger` 权限。于是把那「最后一次点选」做成**引导式手动**：
  - 插件发现连不上宿主时（每进程一次）自动**后台打开 `chrome://extensions`** +
    **把扩展目录塞进剪贴板**，报错文字给出 ⌘⇧G ⌘V 回车的走法；
  - `./bridge setup` 是同一套的命令行版，装完会**轮询 socket**，扩展连上自动打 ✅。
- 顺手修了两个实测出来的 bug（v1.2.1）：
  1. `__dsh_point` 只有两次 `requestAnimationFrame` —— Chrome 在**后台标签页会暂停 rAF**，
     Promise 永不 resolve → `click-el`/`click-text` 死锁（45 秒超时且不回话）。加了 120ms 定时器兜底。
  2. 页内光标用 `sr.innerHTML` 注入 —— Gmail 这类**开了 Trusted Types** 的站点直接抛
     `This document requires 'TrustedHTML' assignment`，连带整个点击作废。改成 DOM API +
     `<style>.textContent`。

---

# 2026-10-17 晚 —— 元素编号 + 后台标签页点击修复

## 元素编号（`plugin/refs.js`）

- `browser_read what=snapshot` 列出能点/能填的元素，一行一个：`[12] button "提交"`、
  `[13] textbox "邮箱" = "a@b.c"`、`[14] link "首页" → /home`，外加 h1–h3 当路标。
- `browser_click` / `browser_input` / `browser_screenshot(element)` 都收 `ref=N`。
- **只改插件，不改扩展**：编号打成 `data-dsh-ref="N"` 属性，于是编号就是选择器，
  扩展里现成的 clickEl / type / select / upload / hover 全都直接复用。
- 开放 shadow root 里的元素选择器够不着，另记 WeakRef（`window.__dshSnap.shadow`），按坐标操作。
- 同一元素再快照沿用旧编号；元素没了报「编号 N 已失效」，让模型重拍快照。
- 认「手搓按钮」靠 `cursor:pointer`，只认从这一层开始变手型的元素（子元素继承的不算）。
- 3000 行表格的页面：45ms，默认列 300 个，剩下的提示用 selector 缩小范围。

## 后台标签页：点击/打字其实全没生效（老 bug，这次才发现）

- 症状：`browser_tabs open` 默认后台开页，之后 `browser_click` 回「已点击」，页面纹丝不动；
  `Input.insertText` 也一样。页面 `visibilityState` 是 `hidden`。
- 修法：动手前发 `Emulation.setFocusEmulationEnabled {enabled:true}`（Playwright 对每个页面都开）。
  实测：同一个后台标签页，开之前 3 次点击 0 次生效，开之后立刻生效。
- 空闲断开会清掉模拟，所以插件每次 click / input 前都补一次（走现成的 `cdp` op）。
- 同一个坑的另一面：扩展里 `shot(selector)` 取框只等 rAF，后台标签页会卡满 15 秒。
  元素截图改成插件自己取框（rAF + 定时器兜底）再直接 `Page.captureScreenshot`。
- `cb` 命令行走的是扩展，还没有这个修复；以后改扩展时把焦点模拟挪进 `ensure()`。

## 验证

`node scratch/test-refs.mjs` —— 在真 Chrome 后台开本地测试页，走插件注册的工具（和模型同一份代码），15 项。

---

# 2026-10-17 深夜 —— 调试工具、后退前进、等文字、拖拽（v1.8.0，11 个工具）

## 新工具 / 新参数

- `browser_devtools`（`plugin/devtools.js`）：`console` / `network` / `response` / `clear`。
  - 记录一直都在扩展里，这次只是接成 DSH 工具，外加：网络记录带 requestId（`response` 靠它拿返回内容）、
    `Runtime.exceptionThrown`（未捕获报错）和 `Log.entryAdded`（浏览器自己报的）也进控制台缓冲。
  - 调试器接上那一刻 V8 会把旧 console **补发**一遍，但**补发不带对象预览**，只剩 `Object`。
    扩展里对这种参数回页面 `Runtime.callFunctionOn` 展开成 `{a: 1, b: "x"}`；去重改按原始文字比。
  - 网络 `clear` / `reload` 只清当前标签页，不再把别的标签页的记录一起抹掉。
- `browser_nav action=back|forward|reload`（`plugin/nav.js`）：动手前在旧页面 window 上做记号，
  记号没了（换了文档）或网址变了（单页应用）且 readyState=complete 就算到了。到头了给人话报错。
- `browser_wait` 加 `text` / `url` / `gone`：插件里轮询 eval；`selector` 且不是 gone 时仍走扩展的 waitFor。
- `browser_drag`（`plugin/drag.js`）：
  - 起点带 `draggable="true"` → 页内合成 dragstart/dragenter/dragover/drop/dragend，共用一个 DataTransfer
    （CDP 鼠标事件在有界面的 Chrome 里起不了原生拖放会话）；
  - 其它 → CDP 按下 / 分步移动 / 松开（滑块、排序列表、画布）。
  - 端点可以是 ref / selector / **text** / 坐标。DSH 实测发现放置区（「放这里」框）不在 snapshot 里，
    模型只好自己 eval 算坐标，所以加了按文字找（包含该文字、看得见、面积最小的元素）。

## 扩展自动重载

- 已解压扩展：setup 把新文件拷进扩展目录后 Chrome 不会自己重载。插件 `apply()` 里对一下
  扩展目录 manifest 版本和正在跑的版本（`version` op），不一样就发 `reload`。实测 1.7.0 → 1.8.0 自动生效。
- 所以**改了扩展代码一定要升版本号**，不然用户那边跑的还是旧扩展。

## 顺手修的

- `call()` 的超时定时器成功后没清，每次调用挂一个 60 秒定时器（测试脚本因此要等一分钟才退出）。

## 验证

- `node scratch/test-more.mjs` —— 20 项：控制台（含补发对象展开）、网络 + 返回内容、清空、
  等文字/等网址/等消失/超时、拖拽（HTML5 按 selector/ref/文字、滑块按坐标）、前进后退刷新（含单页应用）。
- `test-refs` 15 项、`test-image-guard`、`test-setup` 照旧全过。
- DSH 桌面端：重启后 11 个工具注册成功，让模型按 7 步走一遍，全部用新工具完成；修完补发对象和按文字拖拽后再复测一遍。

---

# 2026-10-17 深夜 · 二 —— 扩展弹窗（v1.9.0）

照着 WorkBuddy 的样子做了点图标弹出的面板，往前多走了几步。

## 面板上有什么

- **连接状态**：Chrome 扩展 → 本地宿主 → DSH 三段链路，各自亮绿/红/虚线；没连上时直接给出
  `dsh-chrome-bridge update` 和复制按钮、重新连接按钮。
- **活跃会话**：按 **DSH 会话**归组（不是按进程），每个会话下列出它碰过的标签页：
  操作中 / 待命（约 N 秒后自动松手）/ 有弹窗挡着 / 已松手；每行能「切过去」和「松手」。
- **最近动作**：一次工具调用一条（同一个 callId 的多个底层 op 合并），带一句提示（`[3]`、`「加载完成」`、`back`）、
  耗时、失败原因（CDP 原始 JSON 报错只留 message）。
- **暂停开关**：存在 `chrome.storage.local`，关掉后除版本检查/松手外的操作一律拒绝（报错文字告诉模型让用户去开）；
  暂停时顺手把受控标签页全部松手。扩展自己的页面（弹窗页）不受暂停限制，否则自动化测试解除不了暂停。
- **复制诊断信息**：版本、宿主 pid/socket、会话、最近失败、扩展日志 30 行。
- 工具栏角标：受控标签页数；`!` 宿主断了；`⏸` 已暂停。manifest 加了 `action`（以前没有，`chrome.action.setIcon` 一直静默失败）。

## 会话怎么认出来的

- DSH 调工具时第二个参数 `exec` 实测有：`token, callId, rootCallId, name, signal, agent, …`；
  `agent` 上能拿到 DSH 的会话 id（`sessionOf()` 依次试 `agent.sessionId / agent.session.id / agent.id`），
  实测拿到的是 `session-<uuid>`，和 `~/.dsh/sessions/…/session-<id>` 对得上。子 agent 会不会单独算一个会话还没验证。
- 插件用 `AsyncLocalStorage` 把 `{kind, pid, session, tool, call, hint}` 挂到这次工具调用上，`call()` 每个请求都带着；
  宿主原样转发 `client` 字段；扩展按它记账。旧宿主会丢掉这个字段 → 弹窗里显示「来源不明」，不影响干活。
- 宿主新增 `hostPing → hostPong`（pid、启动时间、socket 在不在听、处理过多少请求），弹窗用它画中间那段。

## 测试

- 界面：`popup.html` 配一个假 `chrome.runtime` 的预览页，在浏览器里看了 连上/没连上/暂停/空 四种状态 × 亮暗两种主题。
- `node scratch/test-popup.mjs` —— 6 项：真扩展里开弹窗页，读状态卡、会话归组、最近动作、点「松手」、拨暂停开关、取诊断信息。
- DSH 桌面端实测：真实会话 id 被认出来，标签页挂在对应会话下。
- 踩到的坑：第一版暂停把「对弹窗页本身的 cdp/open」也拦了，测试脚本解除不了暂停，扩展卡在暂停状态。
  改成扩展自己的页面不受限，并且测试的 finally 先解除暂停再收尾。

---

# 2026-10-17 深夜 · 三 —— 页内光标 v3 + 面板打磨（v1.10.0）

用户说原来的光标「做的不咋地」。重做了一遍。

## 光标（`in-page-cursor.js` v3）

- **样子**：实心蓝色渐变箭头 + 白描边 + 跟着走的「DSH」名牌（学 Figma 多人光标）。
  名牌会展开成「DSH · 点击 登录」「DSH · 输入「…」」「DSH · 拖拽 [3] → [7]」，2.6 秒后收回。
- **动**：沿一条轻微的弧线滑过去，先快后慢，距离越远越久（0.22–0.65 秒），箭头顺着方向微微歪一下。
  旧版是 0.1 秒瞬移再抖一下。
- **点**：两圈涟漪 + 中心点；双击两组。按下时箭头缩一下。
- **拖**：按住时箭头外面一圈光晕，跟着真实鼠标一起走（时长 ≈ 步数 × 24ms）。
- **滚动**：箭头旁边冒个上/下箭头，名牌写「向下滚动」。
- **悬停**：以前悬停不画光标，现在也画。
- **闲着**：6 秒没动作就变淡、名牌收起。系统开了「减少动态效果」就不做动画。
- **技术点**：
  - 全用 Web Animations（按时间算）——后台标签页 rAF 停了也不会卡半路，截图永远拍到该在的位置；终点先写进 inline style。
  - 进 top layer（`popover="manual"`）：页面开了 `<dialog>` 模态框 / 全屏也盖不住它（实测在模态框遮罩上面）。
  - 自定义元素 `<dsh-cursor>` + Shadow DOM + `all:initial !important`：页面 CSS 动不了它。
  - 还是只用 DOM API 搭（Trusted Types 站点能注入）。
  - 页面里有旧版本光标就换掉。

## 扩展这边

- 点击前**等光标真的到位**再发事件（按 `move()` 返回的时长等，120–700ms），不再固定 300ms。
- 每个标签页记住光标位置：页面跳转后重新注入时从原处出现再滑过去；松手后清掉。
- `cursorDo()`：先探一下页面里有没有 v3 光标，没有（刚跳转 / 旧版本）就重注再调，不再靠可能过期的 `cursorReady`。
- `cursor` op 加了 `down / up / label`，`move` 支持 `duration / straight / text`，返回时长。拖拽用它。
- 名牌文字：输入框没 innerText 时用 placeholder / aria-label；**密码框的 value 绝不拿出来**（以前点一个填好的密码框，
  结果文字里会带出密码）；输入密码时名牌只显示圆点。

## 面板

- 新开关「页面里显示 DSH 光标」：关掉后点击照做、只是不画；已经画在页面上的当场收掉。存在 `chrome.storage.local`。
- 两个开关下面各加一行小字说明。
- 「正在控制 N 个标签页」和角标数字不再把扩展自己的页面算进去。
- 受控标签页的图标被我们换成了小鼠标，面板里不再拿它当网站图标（显示小地球）。

## 验证

- 真 Chrome 后台标签页截图逐帧看：滑行中、涟漪、输入名牌、模态框之上、拖拽光晕、滚动提示、变淡、刷新后接着出现。
- `test-popup` 加了第 7 项：关光标 → 点击照常、页面里没有 `<dsh-cursor>`；开光标 → 回来且是 v3。
- 其它回归：refs 15 / more 20 / image-guard / setup 全过。
- DSH 桌面端：新会话里让它「输入 → 点搜索 → 拖拽 → 悬停」，43 秒做完，结果对；过程截图里光标每步都在。测完已还原。
- README 的动图重录了（`assets/cursor-demo.gif`）。

## 标签页小鼠标（追加）

- 图标重画成和页内光标同一个箭头（同一条路径、同一套蓝色渐变 + 白描边），用 Chrome 自己栅格化成 16/32/48/128；
  旧的是 Codex 那种雾面三角，和新光标对不上。favicon 的 data URL 也换成新的 32px。
- 修了两个老毛病（实测发现）：
  - 页面自己写了 `<link rel=icon>` 的，Chrome 优先用它，**小鼠标根本挂不上去**。现在控制时先把页面的图标 link 的 rel 停掉（记在 data 属性里），松手原样恢复。
  - 页面没写图标、靠默认 `/favicon.ico` 的，松手后**小鼠标一直挂着不走**。现在松手时补一个指向默认图标的 link 逼 Chrome 重算。
- 新测试 `scratch/test-favicon.mjs`：两种页面各测「控制前 → 控制中是小鼠标 → 松手后换回原样」。

## 面板改成 iOS 玻璃质感（追加）

- 背后垫三团柔和色块，卡片半透明 + 毛玻璃 + 一圈从左上到右下渐隐的亮边（液态玻璃那道边）；亮暗两套系统色（iOS 的 green/blue/red/orange）。
- 状态卡：带高光的状态球（绿 ✓ / 橙 ⏸ / 红 !），连通时外圈呼吸；三段链路连通时线上有光点流过。
- 开关做成 iOS 系统开关（51×31，弹簧动画，按住时圆钮拉长）；两行前面是「设置」那种彩色方块图标，说明文字挪到组下面。
- 会话：手上有标签页的各一张卡；只是来过、手上空着的挤进同一张卡、一行一个，不再每个都占一张大卡写「此会话暂未控制任何 Tab」。
- 最近动作：前面一个有色小圆（✓ / ✕ / 人），第二行是标签页标题和时间。
- 底部两个胶囊按钮浮在内容上（内容滚到后面会被糊掉）；提示条也是玻璃胶囊，弹出带回弹。
- 滚动条藏了（iOS 没有常驻滚动条；常驻的还会把 368px 宽挤出横向滚动）。
- 技术上：状态卡和开关改成固定骨架、只改文字和 class，列表内容变了才重画 —— 以前每秒整块 innerHTML，呼吸灯、流动线、开关动画都会被打断。

# 2026-10-18 —— 认得商店版扩展（v1.10.1，只改插件）

商店条目 `bippcbbbipppmhjkjomgdnjbooecbimo` 已在审核。这一版让插件对「从商店装扩展」的用户也顺：

- **装好的判据只有一个：宿主连得上。** 连得上就不提示任何安装步骤，不管扩展是解压的还是商店的。
- **连不上时按情况给引导**（`setup.js` 的 `storeExtension()` 去 Chrome 各 profile 的 `Extensions/` 下找商店 ID）：
  - 装了商店版：不再让人「加载已解压」，改成「确认 Chrome 开着 → 扩展是启用的 → 重启 Chrome」；也不往剪贴板塞解压目录。
  - 没装：原来的三步照旧，末尾加一句「或从 Chrome 应用商店安装」。商店链接等审核通过再补（代码里留了 TODO）。
- **自动重载只管解压版**：启动时 `version` 回来的 ID 不是本地解压版的，就不发 `reload`。
  否则商店版本号一落后本地，每次启动都会白白重载一次、掐断宿主。
- 扩展代码没动，manifest 仍是 1.10.0。
- 测试：`test-setup` 加了商店场景（认出商店版、文案不再让人加载已解压）和重载判断（假 socket，四种组合）。

已知：同一个 Chrome 里解压版和商店版都开着时，两个都会拉起宿主、抢同一个 socket。让用户只留一个。

# 2026-10-18 —— DSH 里的插件卡片和设置页（v1.11.0）

以前插件页里只有一行英文包名。现在：

- **卡片**：中文标题「Chrome 浏览器控制」+ 一句中文说明（英文环境显示 Chrome Bridge）。
  DSH 读的是 `locale/<语言>.json` 里的 `meta.title/description`（要在 exports 里放出 `./locale/*.json`），package.json 的 `meta` 字段它不看。
- **设置页**（点进插件详情就有，组件行的「配置」里也有一份）：
  - 状态：已连接 / 没连上 / 已暂停，扩展是本地版还是商店版、版本号，正在控制的标签页（最多列 8 个）+「全部松手」。
  - 开关：允许 DSH 控制浏览器（这里只能关，关了以后提示去 Chrome 面板里开）、页面里显示 DSH 光标。
  - 没连上时：按本地版 / 商店版给安装步骤，「帮我打开安装页」按钮。
  - 扩展较旧（商店里还没更新的版本没有 `panel` 操作）：能看状态，开关点不了，提示更新。
- **怎么接的**：
  - 浏览器那半是 `client.js`（DSH 的 lazy-CJS 格式，`window.__ModuleLoader__.load`），往 `plugins.bundle.config` 和 `plugins.row.config` 两个槽里各挂一个组件；
    package.json 里 `dsh.client` 声明 `platform: 'web'` 和要注入的三个包，exports 放出 `./client`。
  - 数据走一条 HTTP 路由 `/dsh-chrome-bridge/panel`，挂在 DSH 自带的 `webServer` 上（`ctx.inject(['webServer'])`，没有这个服务就不挂，工具照常注册）。
    路由再转成 socket 上新加的 `panel` 操作。没用 DSH 的 schemastery 配置，因为那要 import `@deepseek-ai/*`，在插件进程里拿不到。
- **把门**（webServer 本身不鉴权，Chrome 里任何网页都摸得到 127.0.0.1）：
  只收本机连接；Host 必须是本机名（防 DNS 重绑定）；带了 Origin 就必须是 DSH 自己；POST 必须是 JSON（跨站发不出来）；body ≤ 4KB。
  **恢复控制不开放**：socket 上的 `panel` 只能暂停，恢复只能在 Chrome 扩展面板里点 —— 模型也摸得到这条路。
- 扩展里把暂停 / 光标 / 全部松手抽成共用函数，面板和设置页走同一套（日志里会写「DSH 设置页」）。
- 测试：新加 `test-panel`（读状态、开关光标、暂停后网页操作被拒、socket 上恢复不了、全部松手、五条把门规则，最后还原）。
  DSH 桌面端实测：卡片、设置页、光标开关来回切都对，路由没拒过 DSH 自己的请求。

已知：商店版还是 1.10.0（没有 `panel`），商店用户在设置页会看到「扩展版本较旧」，等下一次传商店包。

---

# 2026-10-18 —— 页内光标 v4：跟桌面光标统一样式（v1.12.0）

用户要求浏览器光标和桌面光标（dsh-mac-computer-use）**样式统一、一眼能分开**，动效好看但不浮夸。定的是：
同一个箭头、同一个蓝、同一套动效；**桌面实心、浏览器半透明**（像 Codex 一黑一灰），名牌里加小图标：**地球 = 浏览器、显示器 = 桌面**。

- **外观**：箭头渐变 `#9fb2ff → #6f8bff`，名牌半透明蓝，整层不透明度 .9（闲下来 .6）—— 一开始给的 .74 / .36 用户嫌太透明；涟漪、圆点、滚轮提示都换成同色系淡蓝。
- **动效**（全是 Web Animations，后台标签页也不卡）—— 跟桌面光标**同一个弹簧、同一套算法**：
  - 位置：阻尼比 ≈0.86 的弹簧（按距离微调，最多冲过头 3px），刚度按时长反推，保证时长到了离终点不到 0.5px；
    弹簧进度喂给二次贝塞尔弧线，进度略过 1 时就沿到达方向冲出去一点，回弹自然顺着弧线；
  - 拉伸 / 侧倾 / 名牌落后都按采样出来的速度算（速度 2600px/s 封顶：拉长 7%、侧倾 5.7°、名牌最多落后 5px），
    跟桌面浮层 tick 里的公式一字不差；
  - 点击：缩到 .86 → 弹到 1.03 → 归位；双圈涟漪改成一圈淡波纹 + 小圆点。
  - 时长 240ms + 0.42ms/px，封顶 620ms，跟扩展里 `settle()` 的 700ms 等待对齐；拖拽仍是匀速直线。
- **安装冲突修掉**：dsh-mac-computer-use 的旧 install.sh 会把它自己那份 v1 光标拷进 `~/.dsh/chrome-cursor/`，盖掉我们的。
  插件现在**先读自带的 `vendor/in-page-cursor.js`**，`~/.dsh/chrome-cursor/` 只留给 `cb` 命令行；对面那一步也删了。
- 测试：`test-popup` 的光标版本改成 4；其余套件不用动，全过。演示动图重录。

---

# 2026-10-19 —— 商店过审，安装改成商店优先（v1.12.1）

DSH Bridge 在 Chrome 应用商店过审上线了（商店上是扩展 1.10.0；1.11.0 的包已打好，等上传）。

- 宿主连不上时的报错：先给商店链接（不用开发者模式），再给「加载已解压」三步。
- DSH 设置页「还差一步」卡片：多一句「更省事：直接从商店装」和一个「去商店装」按钮（在 Chrome 前台打开商店页，不碰剪贴板）。
  走原来的 `install` 路由，带 `via: 'store'`。
- README（中英）安装第 2 步改成两种装法，商店推荐；「不走商店」那条限制删掉。
- 测试：`test-setup` 加一条「报错给出商店链接、排在解压装法前面」。
  设置卡在本地拿 React 离线渲染了没装 / 商店版没连上两种状态，按钮发出去的是 `{"action":"install","via":"store"}`；
  DSH 桌面端实测：插件正常加载，已连接状态的设置页照常。
