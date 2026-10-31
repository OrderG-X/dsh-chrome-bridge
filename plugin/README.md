# DSH Bridge · dsh-chrome-bridge

A DeepSeek Harness (DSH) plugin that drives the Chrome you already use: real clicks and typing, a visible on-page cursor, and your own logins. It provides 12 `browser_*` tools over native messaging and the Chrome debugger, with no listening port.

让 DSH 直接操作你正在用的 Chrome：真点击、真输入，页面里看得到光标，登录状态都在。提供 12 个 `browser_*` 工具，走 native messaging 和 Chrome 调试接口，不开监听端口。

## Install / 安装

1. In DSH, open **Plugins**, click **Add plugin**, enter `dsh-chrome-bridge`, then restart DSH.
   在 DSH「插件」页点「添加插件」，填 `dsh-chrome-bridge`，重启 DSH。DSH 连不上 npm 时会自动换国内镜像。
2. Add the DSH Bridge extension to Chrome from the [Chrome Web Store](https://chromewebstore.google.com/detail/bippcbbbipppmhjkjomgdnjbooecbimo).
   从 [Chrome 应用商店](https://chromewebstore.google.com/detail/bippcbbbipppmhjkjomgdnjbooecbimo) 装上 DSH Bridge 扩展。

Requirements: macOS, Windows or Linux, Chrome 116+, Node.js 18+.
系统要求：macOS、Windows 或 Linux，Chrome 116+，Node.js 18+。

## Updating / 更新

Uninstall the plugin on the Plugins page and add it again. A new version can be installed by package name about a day after it is released, because the pnpm that DSH uses skips brand-new versions by default.

在「插件」页把它卸载，再添加一次。DSH 用 pnpm 安装插件，而 pnpm 默认不装刚发布的版本，所以新版大约发布一天后，按包名才能装到。

Full documentation / 完整说明：https://github.com/OrderG-X/dsh-chrome-bridge
