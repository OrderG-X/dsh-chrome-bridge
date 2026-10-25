---
name: browser
description: 操作用户正在使用的真实 Chrome —— 读页面、点击、输入、截图、看 console 和网络请求。需要打开网页、抓页面内容、填表单、点按钮、验证网页行为时用它。
whenToUse: 任务要在"用户已经登录的那个浏览器"里做事情，或者需要真实 DOM/点击而不是 HTTP 请求。
---

# 浏览器操作（Chrome Bridge）

你有一台**真实 Chrome** 的遥控器 —— 连着用户正在用的浏览器（带登录态、不新开窗口），装一次永久可用。

**两种用法，能用第一种就用第一种。**

## 首选：`browser_*` 原生工具

装了 Chrome Bridge 插件就有这 12 个工具，比走 shell 快、也不用引号转义：

| 工具 | 用途 |
|---|---|
| `browser_tabs` | 列 / 找 / 开 / 关 / 切标签页（**先拿 tabId**） |
| `browser_read` | **`what=snapshot` 给能点/能填的元素编号 [N]**（要操作页面先调它；同源 iframe 里的元素也在里面，夹在 `[iframe] … ↓` 和 `[/iframe]` 之间）；`text` 读可见文字；`html` / `attr` / `info`（info 会告诉你有没有弹窗挡着） |
| `browser_click` | 按 `ref`（编号，最稳）/ `selector` / `text` / 坐标点（真实鼠标事件） |
| `browser_input` | `type` / `key` / `select` / `upload` / `focus` / `hover` / `scroll` |
| `browser_nav` | `go` 跳转 / `back` 后退 / `forward` 前进 / `reload` 刷新，都等加载完 |
| `browser_screenshot` | 截图，**图片直接返回给你看**（`viewport` / `full` / `element`） |
| `browser_eval` | 页面里跑 JS |
| `browser_wait` | 等 `selector` 元素 / `text` 文字 / `url` 网址出现；`gone=true` 等它消失（加载圈） |
| `browser_dialog` | 放行 alert / confirm / prompt |
| `browser_drag` | 拖拽：起点终点各用 `ref` / `selector` / `text` / 坐标；放置区一般没编号，用 `toText` |
| `browser_download` | 下载文件：`ref` / `selector` / `url` 三选一，带用户的登录状态；默认存「下载」文件夹，`to=workdir` 存会话工作目录。下载按钮不是链接时，先点它，再从 `browser_devtools network` 里找文件网址 |
| `browser_devtools` | `console` 控制台 + JS 报错（`level=error` 只看报错）/ `network` 请求列表（`reload=true` 抓整页加载）/ `response` 看某个请求的返回内容 / `clear` |

## 备用：`cb` 命令行

没有那些工具（插件没装、或你在用 shell）时用它：

```bash
cb status                          # 要看到「扩展连接: ✅」
cb tabs                            # 列所有标签页（* = 当前活动）
cb info  <tab>                     # 标题/URL/视口/有没有弹窗挡着 ← 先看这个
cb text  <tab> [选择器]             # 可见文字（抓内容首选）
cb eval  <tab> "<js>"              # 跑 JS
cb click-el   <tab> "<选择器>"      # 点（真实鼠标事件）
cb click-text <tab> "登录"          # 按文字点
cb type   <tab> "内容" --into "<选择器>"
cb key    <tab> Enter              # 组合键写 "meta+a"
cb nav   <tab> <url>
cb shot  <tab> --out /tmp/x.png    # 截图；--full 整页，--sel "<选择器>" 只截元素
cb console <tab> / cb network <tab> # console / 网络请求
cb cdp   <tab> <方法> '{...}'       # 原始 CDP 逃生口
```

`<tab>` 写 `active` 或具体 id。加 `--json` 出原始 JSON。

❌ 连不上：让用户跑 `dsh-chrome-bridge update`，别自己瞎折腾。
（万一 `cb` 说 command not found，用绝对路径 `~/.dsh/bin/cb`。）

## 硬规矩（都是踩过的坑）

1. **`chrome://` 页面进不去**，换一个 http/https 的 tabId。
2. **先看有没有弹窗**（`browser_read what=info` / `cb info`）—— 有 alert 会把后面所有操作卡死，
   先 `browser_dialog` / `cb dialog <tab> accept`。
3. **先 `browser_read what=snapshot` 拿编号，再用 `ref` 操作**。没有工具时先读真实 DOM 再写选择器，别猜。
4. **点击和输入会自动带动页内光标**（用户看得见），不要再手动驱动光标。
5. 点东西用真实点击（`browser_click` / `click-el` / `click-text`）；
   **不要**用 `eval` 里的 `el.click()`，那是假点击，弹窗会被拦、焦点也不对。
6. 自己开的标签页，用完收拾干净；**别乱关用户的页面**。
7. **页面不对劲（点了没反应、数据没出来、白屏）先查 `browser_devtools`**：`console level=error` 看报错，
   `network` 看接口是不是 4xx/5xx，再 `response` 看返回内容——别靠猜。
8. 等异步内容用 `browser_wait`（等文字 / 网址 / 加载圈消失），别干等。
9. **要文件就用 `browser_download`**，别去点浏览器的下载（存到哪、叫什么你都拿不到）。快照里写着「跨站框架」的 iframe 读不到里面：截图看，按坐标点。

## 什么时候别用它

- 只是抓公开数据 → `web_fetch` 更快更省
- 要同时跑几十个页面 → 这不是它的强项
