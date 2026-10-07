---
name: browser
description: 操作用户正在使用的真实 Chrome —— 读页面、点击、输入、截图、看 console 和网络请求。需要打开网页、抓页面内容、填表单、点按钮、验证网页行为时用它。
whenToUse: 任务要在"用户已经登录的那个浏览器"里做事情，或者需要真实 DOM/点击而不是 HTTP 请求。
---

# 浏览器操作（DSH Bridge）

你有一台**真实 Chrome** 的遥控器：命令 `cb`（也有原生的 `browser_*` 工具，能用就优先用工具）。
它连着用户正在用的浏览器（带登录态、不新开窗口），装一次永久可用。

## 第一步永远是确认它活着

```bash
cb status        # 要看到「扩展连接: ✅」
cb tabs          # 列所有标签页（* = 当前活动）
```

❌ 连不上：让用户跑 `dsh-chrome-bridge update`，别自己瞎折腾。

## 命令

```bash
cb info  <tab>                     # 标题/URL/视口/有没有弹窗挡着 ← 先看这个
cb text  <tab> [选择器]             # 可见文字（抓内容首选）
cb html  <tab> [选择器]             # 外层 HTML
cb attr  <tab> <选择器> <属性名>
cb wait-for <tab> "<选择器>"        # 等元素出现
cb eval  <tab> "<js>"              # 跑 JS，返回值直接给你

cb click-el   <tab> "<选择器>"      # 点（真实鼠标事件）
cb click-text <tab> "登录"          # 按文字点
cb click  <tab> <x> <y>            # 按坐标点
cb type   <tab> "内容" --into "<选择器>"
cb key    <tab> Enter              # 组合键写 "meta+a"
cb hover / cb scroll <tab> --dy 600 / cb focus / cb select / cb upload
cb dialog <tab> accept             # 放行 alert/confirm

cb nav   <tab> <url>
cb shot  <tab> --out /tmp/x.png    # 截图；--full 整页，--sel "<选择器>" 只截元素
cb console <tab>                   # 页面 console
cb network <tab>                   # 网络请求（谁 404 了、谁慢）
cb cdp   <tab> <方法> '{...}'       # 原始 CDP 逃生口
```

`<tab>` 写 `active` 或具体 id。任何命令加 `--json` 出原始 JSON。

## 硬规矩（都是踩过的坑）

1. **`chrome://` 页面进不去**，换一个 http/https 的 tabId。
2. **先 `cb info` 看有没有弹窗**——有 alert 会把后面所有命令卡死，先 `cb dialog <tab> accept`。
3. **先 `cb text` / `cb eval` 看真实 DOM，再写选择器**。别猜，页面早改版了。
4. **点击和输入会自动带动页内光标**（用户看得见），不要再手动调 `cb cursor`。
5. 点东西用 `click-el` / `click-text`（真实事件，能触发新窗口和弹窗）；
   不要用 `cb eval "el.click()"`，那是假点击。
6. 自己 `cb open` 开的标签页，用完 `cb close` 收拾干净；别乱关用户的页面。

## 什么时候别用它

- 只是抓公开数据 → `web_fetch` 更快更省
- 要同时跑几十个页面 → 这不是它的强项
