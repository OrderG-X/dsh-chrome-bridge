# Privacy Policy — DSH Bridge (Chrome extension)

_Last updated: 2026-10-17_

DSH Bridge is a local bridge. **It has no server, no analytics, and no network endpoint of its own.** Nothing it reads is sent anywhere by the extension.

## What the extension can see

When you turn it on, it can read and control the pages in your Chrome — that is its entire purpose:

- page content, DOM, console and network activity of tabs (via `chrome.debugger` / CDP),
- tab list, titles and URLs (`tabs`),
- the pages you are signed into, including form fields if an agent types into them.

It reads these **only while a local agent (DSH) asks it to**, over Chrome's native-messaging pipe to a helper process running as your own OS user.

## Where the data goes

1. Chrome → native host: over Chrome's native messaging pipe (stdio). **Local only.**
2. Native host → your DSH agent: over a Unix socket (`/tmp/dsh-bridge-<uid>/dsh-bridge.sock`, inside a per-user `0700` directory, plus a token file). **Local only.**
3. What your DSH agent then does with that content — including sending it to whichever model provider you configured in DSH — is decided by **DSH and your own configuration, not by this extension**. Please read DSH's own privacy terms for that.

The extension itself makes no outbound requests: no telemetry, no update pings, no third-party scripts. All code is in this repository; the extension loads no remote code.

## What is stored

- The extension keeps a small amount of local state (`chrome.storage`) for its own settings.
- The native host writes nothing to disk except its own log (`/tmp/dsh-bridge-<uid>/dsh-bridge.log`) and the socket/token files listed above; the DSH plugin keeps its own trace log (`plugin.log`) in the same directory.
- Uninstalling the extension and running `./bridge uninstall` (or `install.sh --uninstall`) removes all of it.

## Permissions and why they are needed

| Permission | Why |
|---|---|
| `debugger` | Dispatches real CDP input events (clicks, typing, navigation, screenshots) and reads DOM/console/network on the tabs the agent works with. |
| `tabs` | Lists your tabs so the agent can pick the right one; switches/closes tabs on request. |
| `tabGroups` | Puts the tabs an agent is currently driving into one labelled tab group (and takes the group apart when it lets go), so you can see at a glance which pages are under control. |
| `scripting` | Injects two page-side things into the tab the agent is working on: the on-page cursor overlay, and a temporary favicon link so the tab strip shows a small mouse while that cursor is present. Nothing is injected into any other tab. |
| `nativeMessaging` | The only channel to the local helper process. |
| `alarms`, `storage` | Keeps the service worker alive while attached and stores local settings. |
| `<all_urls>` (host permission) | The agent works on whatever page you point it at, and the page-side cursor overlay must be able to draw on any page. |

## Control and revocation

- Chrome shows a permanent “*DSH Bridge is debugging this browser*” banner while attached — click **Cancel** to detach instantly.
- Turn the extension off (or uninstall it) in `chrome://extensions` and the bridge stops working immediately.
- `cb detach <tab>` detaches a single tab.

## Contact

Open an issue at <https://github.com/OrderG-X/dsh-chrome-bridge/issues>.
