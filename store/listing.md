# Chrome Web Store — listing copy (paste into the dashboard)

Everything below is meant to be copy-pasted as-is. `<…>` marks the few values you fill in yourself.

## Store listing tab

**Name** (75 chars max)

```
DSH Bridge
```

**Summary** (132 chars max). The dashboard shows this as "Summary from package": it comes from the extension's own `plugin/vendor/extension/_locales/<lang>/messages.json` (`extDescription`), so there is nothing to paste. Edit it there.

```
Lets DSH work in the Chrome you already use: real clicks and typing, a cursor you can see, and your own logins.
```

**Description**

```
DSH Bridge lets DSH (DeepSeek Harness), the AI agent running on your computer, work in the Chrome you already use — with your logins and your tabs.

What it does:
• Real clicks and typing — clicks, typing, keys, scrolling, drag and drop and file pickers go through Chrome's own input system (the DevTools Protocol), so pages react just as they do to you.
• Sees the page — screenshots of the visible area, the whole page or a single element.
• A cursor you can watch — every action shows an on-page cursor with a small label saying what it is about to do. It shows up in screenshots too.
• A simple panel — click the toolbar icon to see whether everything is connected, which tabs DSH is working in and what it did recently. One switch stops all control; "Release all" lets go of every tab.
• Stays out of your way — pages DSH opens go into a separate background window of your Chrome (same logins), so your own window keeps its tabs and its focus. You can turn this off in the panel.
• Easy to stop — while DSH works in a tab, Chrome shows its "is debugging this browser" bar; press Cancel and DSH lets go at once.
• Your language — the panel follows Chrome's language: English, Chinese or Russian.

What you need:
• macOS, Windows or Linux, with Node.js 18 or newer.
• DSH with the dsh-chrome-bridge plugin: on DSH's Plugins page, click "Add plugin" and enter dsh-chrome-bridge. The plugin sets up a small local helper program that this extension talks to.
Without that helper the extension does nothing, and its panel tells you what is missing.

Privacy: the extension has no server and no analytics, makes no outside requests of its own and opens no network port. It reads a page only when DSH on your computer asks, and passes it to DSH over a local channel only your user account can use (a private Unix socket on macOS and Linux; on Windows a named pipe that needs a token kept in your own user folder). What DSH does next — including sending anything to the AI model provider you chose in DSH — is up to DSH and your settings.

Privacy policy: https://github.com/OrderG-X/dsh-chrome-bridge/blob/main/PRIVACY.md
Source code and issues: https://github.com/OrderG-X/dsh-chrome-bridge
```

**Category**

```
Developer Tools
```

**Language** — English is the default. The package ships `_locales/en`, `zh_CN`, `zh_TW` and `ru`, so the dashboard also offers those languages: paste the zh_CN copy below into 中文（简体） and the ru copy into Русский (中文（繁體）can stay empty — it falls back to English). The popup itself follows Chrome's UI language (Chinese, Russian, otherwise English).

**Homepage URL**

```
https://github.com/OrderG-X/dsh-chrome-bridge
```

**Support URL**

```
https://github.com/OrderG-X/dsh-chrome-bridge/issues
```

**Privacy policy URL**

```
https://github.com/OrderG-X/dsh-chrome-bridge/blob/main/PRIVACY.md
```

## 中文商品详情（zh_CN）

在「商品详情」顶部的语言下拉里选 **中文（简体）**，把下面两段贴进去（名称、类别、网址都跟英文一样，不用再填）。

**Summary (zh_CN)**（132 字以内；就是扩展里 `_locales/zh_CN/messages.json` 那句，后台显示为「软件包中的摘要」，不用贴）

```
让 DSH 直接操作你正在用的 Chrome：真点击、真输入，页面里看得到它的光标，你的登录状态都在。
```

**Description (zh_CN)**

```
DSH Bridge 让你电脑上的 DSH（DeepSeek Harness）智能体直接操作你正在用的 Chrome——用你的登录状态、你的标签页。

能做什么：
• 真点击、真输入——点击、打字、按键、滚动、拖拽、选文件，都走 Chrome 自己的输入通道（开发者工具协议），网页的反应和你亲手操作一样。
• 看得见页面——能截可见区域、整页或单个元素。
• 看得见它在干什么——每一步都会在页面上显示一个光标，旁边写着它要做什么，截图里也看得到。
• 简单的面板——点工具栏图标，就能看到连没连上、DSH 正在操作哪些标签页、最近做了什么。一个开关停掉所有控制，「全部放开」一键放开所有标签页。
• 不打扰你——DSH 新开的页放进你 Chrome 里一个单独的后台窗口（登录状态一样），你自己的窗口不多标签页、不抢焦点。不想要可以在面板里关掉。
• 随时能叫停——DSH 操作期间，Chrome 会一直显示「正在调试此浏览器」的提示条，点「取消」它立刻放手。
• 跟着你的语言——面板跟随 Chrome 的语言：中文、英文、俄文。

需要什么：
• macOS、Windows 或 Linux，装有 Node.js 18 或更新版本。
• DSH 装上 dsh-chrome-bridge 插件：在 DSH「插件」页点「添加插件」，填 dsh-chrome-bridge。插件会装好一个本机程序，扩展就是和它对话。
没有这个本机程序时，扩展什么也不做，面板会告诉你差哪一步。

隐私：扩展没有服务器、没有统计，自己不发任何外部请求，也不开网络端口。只有你电脑上的 DSH 要求时，它才读取页面，并通过只有你这个系统用户能用的本地通道交给 DSH（macOS、Linux 上是私有的 Unix socket；Windows 上是要凭你用户目录里的令牌才能用的命名管道）。DSH 之后怎么用这些内容——包括发给你在 DSH 里选的模型服务商——由 DSH 和你的设置决定。

完整隐私政策：https://github.com/OrderG-X/dsh-chrome-bridge/blob/main/PRIVACY.md
源码和问题反馈：https://github.com/OrderG-X/dsh-chrome-bridge
```

## Русское описание (ru)

在「商品详情」顶部的语言下拉里选 **Русский**，把下面这段贴进「说明」（摘要来自扩展里的 `_locales/ru/messages.json`，不用贴）。

**Description (ru)**

```
DSH Bridge позволяет DSH (DeepSeek Harness) — ИИ-агенту, который работает на вашем компьютере, — действовать в вашем обычном Chrome: с вашими входами в аккаунты и вашими вкладками.

Что умеет:
• Настоящие клики и ввод — клики, набор текста, клавиши, прокрутка, перетаскивание и выбор файлов идут через собственный механизм ввода Chrome (DevTools Protocol), поэтому страница реагирует так же, как на ваши действия.
• Видит страницу — снимки видимой области, всей страницы или отдельного элемента.
• Видно, что он делает — при каждом действии на странице появляется курсор с подписью о том, что он собирается сделать. Его видно и на снимках.
• Простая панель — нажмите значок на панели инструментов: видно, всё ли подключено, в каких вкладках работает DSH и что он делал недавно. Один переключатель останавливает всё управление, «Отпустить все» освобождает все вкладки.
• Не мешает — страницы, которые открывает DSH, попадают в отдельное фоновое окно вашего Chrome (с теми же входами), а ваше окно сохраняет свои вкладки и фокус. Это можно отключить в панели.
• Легко остановить — пока DSH работает во вкладке, Chrome показывает полосу «…отлаживает этот браузер»; нажмите «Отмена», и DSH сразу отпустит вкладку.
• На вашем языке — панель следует языку Chrome: русский, английский или китайский.

Что нужно:
• macOS, Windows или Linux с Node.js 18 или новее.
• DSH с плагином dsh-chrome-bridge: на странице «Плагины» (Plugins) в DSH нажмите «Добавить плагин» (Add plugin) и введите dsh-chrome-bridge. Плагин установит небольшую локальную программу, с которой и общается это расширение.
Без этой программы расширение ничего не делает, а панель подскажет, чего не хватает.

Конфиденциальность: у расширения нет сервера и аналитики, оно само не делает внешних запросов и не открывает сетевых портов. Страницу оно читает только по запросу DSH на вашем компьютере и передаёт её DSH по локальному каналу, доступному только вашей учётной записи (закрытый Unix-сокет в macOS и Linux; в Windows — именованный канал, для доступа к которому нужен токен из вашей папки пользователя). Что DSH делает дальше — в том числе отправляет ли что-то выбранному в DSH поставщику ИИ-модели, — зависит от DSH и ваших настроек.

Политика конфиденциальности: https://github.com/OrderG-X/dsh-chrome-bridge/blob/main/PRIVACY.md
Исходный код и вопросы: https://github.com/OrderG-X/dsh-chrome-bridge
```

## Privacy practices tab

**Single purpose description**

```
Bridge the user's own Chrome to a locally running DSH agent, so that agent can read and operate the pages the user points it at.
```

**Justification per permission** (one box each; paste the matching line)

- `debugger`:
```
Required to dispatch real Chrome DevTools Protocol input events (mouse, keyboard, scrolling, drag, file chooser) and to read the DOM, console and network activity of the tab the user asked the agent to work on. Chrome shows a permanent debugging banner while attached and the user can cancel it at any time.
```
- `tabGroups`:
```
Puts the tabs an agent is currently driving into one labelled tab group, and takes the group apart as soon as it lets go, so the user can see at a glance which pages are under control. No tab data leaves the machine.
```
- `tabs`:
```
Required to list the user's tabs (title and URL) so the agent can pick the right one, and to open, close, focus or reload a tab when the user asks for it.
```
- `scripting`:
```
Injects the on-page cursor overlay and a temporary favicon link into the tab the user's own agent is currently working on, so the tab strip shows a small mouse while that cursor is on the page. No other tab is touched, and nothing is sent anywhere.
```
- `nativeMessaging`:
```
The only channel to the local helper process that performs the work. It is a stdio pipe to an executable the user installed on the same machine; the extension never talks to a remote server.
```
- `alarms`:
```
Keeps the MV3 service worker alive while a debugging session is attached, so long-running user actions do not get interrupted when the worker would otherwise be suspended.
```
- `storage`:
```
Stores the extension's own small local settings (for example whether the on-page cursor is enabled).
```
- Host permission `<all_urls>`:
```
The agent works on whatever page the user points it at, and the on-page cursor overlay must be able to draw on any page. The extension reads a page only while the user's own local agent is operating on it.
```

**Remote code** — answer **No** (all code ships in the package; nothing is fetched or eval'd).

**Data usage** — the extension itself collects and transmits nothing; it reads page content locally and hands it to the locally running agent the user installed. Tick the data types the extension *accesses* (website content, browsing activity) and answer "no" to selling/transferring for unrelated purposes; the privacy policy above states exactly that.

## Test instructions tab (for the reviewer)

The dashboard box ("其他说明") takes **500 characters max**; this is the text that is in it now (2026-11-17):

```
Needs a local helper; without it the panel shows "not connected" (expected). No login needed.
On macOS with Node.js 18+:
git clone https://github.com/OrderG-X/dsh-chrome-bridge
cd dsh-chrome-bridge && ./install.sh
Open the toolbar panel: it turns green (press reconnect if not). Then:
~/.dsh/bin/cb open https://example.com --front
~/.dsh/bin/cb click-text active "Learn more"
You will see the on-page cursor click, a tab group and the debug banner.
More: see store/listing.md in the repo.
```

## After the item is created

The dashboard URL contains the store item ID:

```
https://chrome.google.com/webstore/devconsole/<account>/<slug>/<32-char-ITEM-ID>/edit
```

Send that 32-character ID back: the plugin needs it in the native-messaging registration
(`allowed_origins`), because the Web Store assigns the extension its own ID.
Until that lands, a store-installed extension will be refused by the host.
