# Chrome Web Store — listing copy (paste into the dashboard)

Everything below is meant to be copy-pasted as-is. `<…>` marks the few values you fill in yourself.

## Store listing tab

**Name** (75 chars max)

```
DSH Bridge
```

**Summary** (132 chars max — the line below is 131). The dashboard shows this as "Summary from package": `./bridge store-pack` writes it into the zip's manifest `description`, so there is nothing to paste.

```
Drive the Chrome you already use from a local DSH agent: real clicks and typing over native messaging. No ports, no Connect button.
```

**Description**

```
DSH Bridge gives a locally running DSH (DeepSeek Harness) agent hands inside the Chrome you already use — your logins, your tabs, your session.

Nothing opens a port and nothing asks you to press Connect: the extension talks to a small helper process on your Mac over Chrome's native messaging pipe, and moves the mouse and keyboard through real Chrome DevTools Protocol input events.

What you get:
• Real input — clicks, typing, keys, scrolling, drags and file pickers are dispatched as trusted CDP events, not synthetic DOM hacks.
• Real screenshots — the agent sees the rendered page, including full-page and single-element captures.
• A visible cursor — every action draws an on-page cursor (with a small label saying what it is about to do) that also shows up in screenshots, so you can watch what the agent is doing.
• A control panel — the toolbar popup shows the connection status, which tabs each agent session is holding, a live log of recent actions, a switch to pause all control, and a one-click "Release all".
• Your session — you stay logged in; there is no separate automated browser and no cookie export.
• A permanent "DSH Bridge is debugging this browser" banner while attached — press Cancel on it and the bridge detaches instantly.

Requirements (important):
• macOS. The native helper is macOS-only for now.
• DSH installed, with the matching dsh-chrome-bridge plugin (it installs the helper and registers this extension for native messaging).
• The helper is a local Node process. Install it from https://github.com/OrderG-X/dsh-chrome-bridge — the plugin does it automatically on first load.
Without the helper the extension is inert: it has nothing to talk to, and it will tell you so.

Privacy: the extension has no server, no analytics and no outbound requests of its own. Page content is read on your machine only while your local agent asks for it, and is handed to that agent over a 0600 Unix socket. What your agent then does with it — including anything sent to the model provider you configured in DSH — is governed by DSH and your own settings.

Full privacy policy: https://github.com/OrderG-X/dsh-chrome-bridge/blob/main/PRIVACY.md
Source code, issues and the helper: https://github.com/OrderG-X/dsh-chrome-bridge
```

**Category**

```
Developer Tools
```

**Language** — English. (Add 中文 as a second language if you want the localized listing.)

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
- Content script `<all_urls>` (MAIN world, document_start):
```
The content script only patches automation-detection fingerprints (navigator.webdriver and similar) so ordinary sites do not misbehave when a page is driven by the user's own agent. It collects nothing and sends nothing anywhere.
```

**Remote code** — answer **No** (all code ships in the package; nothing is fetched or eval'd).

**Data usage** — the extension itself collects and transmits nothing; it reads page content locally and hands it to the locally running agent the user installed. Tick the data types the extension *accesses* (website content, browsing activity) and answer "no" to selling/transferring for unrelated purposes; the privacy policy above states exactly that.

## Test instructions tab (for the reviewer)

```
This extension is the browser half of a local tool. It only talks to a native-messaging helper on the same Mac, so on its own its toolbar panel shows "helper not connected" - that is expected. No account or login is needed.

To test on macOS (needs Node.js 18+ and git):
1. Install this extension from the store.
2. In Terminal:
   git clone https://github.com/OrderG-X/dsh-chrome-bridge
   cd dsh-chrome-bridge && ./install.sh
   (installs the helper and registers it for this extension's ID; ./install.sh --uninstall removes it)
3. Open the extension's toolbar panel: the status turns green ("已连接" = connected); if not, press its reconnect button or restart Chrome.
4. In Terminal, drive the browser the way the local agent does:
   ~/.dsh/bin/cb tabs
   ~/.dsh/bin/cb open https://example.com --front
   ~/.dsh/bin/cb click-text active "Learn more"
   You will see the on-page cursor move and click, the tab placed in a labelled tab group, and Chrome's debugging banner. The panel lists the controlled tab and the recent actions; "全部松手" (Release all) detaches everything.
```

## After the item is created

The dashboard URL contains the store item ID:

```
https://chrome.google.com/webstore/devconsole/<account>/<slug>/<32-char-ITEM-ID>/edit
```

Send that 32-character ID back: the plugin needs it in the native-messaging registration
(`allowed_origins`), because the Web Store assigns the extension its own ID.
Until that lands, a store-installed extension will be refused by the host.
