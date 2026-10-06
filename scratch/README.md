# scratch —— 从旧会话搬过来的可用代码

- `cursor-overlay.swift` —— 系统级浮层光标（不抢前台 / 点击穿透 / 永远置顶）
  编译：`swiftc -O -o ~/.dsh/bin/dsh-cursor-overlay cursor-overlay.swift -framework AppKit`
  控制：`~/.dsh/bin/dsh-cursor show X Y | move X Y | click | hide`
- `in-page-cursor.js` —— 页内光标浮层（Shadow DOM 注入，出现在截图里）
  用法：CDP `Runtime.evaluate` 注入，之后调 `window.__dshCursor.move(x,y) / .click(x,y) / .hide()`
