# The shell — wrapping a real engine (not writing one)

"Our own browser" = **our sovereign shell + agent + governor around a real
Chromium.** This is exactly how Brave, Arc, Opera, and Electron apps are built:
none of them wrote a rendering engine; they wrapped Chromium and built their
value on top. The novelty of this project is not the engine — it's the
agent-native, governed, SaaS-tax-killing shell.

## The layers, and which are real vs wrapped

| Layer | What it is | Status in this repo |
|-------|------------|---------------------|
| **engine** | Chromium — renders any site | **wrapped** (Electron/Tauri bundles it; the CDP bridge drives it) |
| **shell / UI** | tabs, address bar, the window chrome, the agent rail | Electron/Tauri app — scaffolded here as the honest seam |
| **agent rail** | the agent as a side-panel that SEES the page and ACTS on it | `bridge/cdp-bridge.js` (SEE/ACT over CDP) |
| **governor** | per-site perms, confirm, caps, kill-switch, audit | `kernel/governor.mjs` — **pure, witnessed, real** |
| **audit** | signed hash-chained ledger of everything the agent did | `kernel/envelope.mjs` — **pure, witnessed, real** |

## Why the engine is not in this repo

Writing a rendering engine is a thousand-person decade. Bundling and shipping a
signed desktop Electron/Tauri app is a real build-toolchain job (native builds,
code-signing, auto-update, per-OS packaging) — deliberately out of scope for the
*governed-core* repo, whose job is to be the correct, safe, witnessable brain.

**This is now built** — see [`desktop/`](../desktop): a real Electron app that bundles
Chromium, renders any site in a `WebContentsView`, draws the tabs + address bar + the
agent rail, and drives the page via the shared `page/agent-dom.js` over
`webContents.executeJavaScript` — wired to the same `host/governor-host.mjs` the
extension uses. Run it with `cd desktop && npm install && npm start`.

The wrap is standard and small once you want the desktop app:

```js
// electron main (sketch) — the wrap, not the engine
import { app, BrowserWindow } from 'electron';
app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { /* agent rail preload */ } });
  win.loadURL('https://any-site.example');   // Chromium renders it — we wrapped it
  // the agent rail attaches over CDP (bridge/cdp-bridge.js) and every ACT is
  // gated by kernel/governor.mjs before a synthetic event is dispatched.
});
```

Or, to drive an *existing* Chromium without packaging anything:

```
chrome --remote-debugging-port=9222 --user-data-dir=~/your-profile
# then attach the bridge over CDP — your real logged-in sessions, governed.
```

## The host: niceassos

In the estate, the shell is [niceassos](https://github.com/sjgant80-hub/niceassos)
— the sovereign OS shell — with this project's agent rail + governor as an organ
on its signed bus. The browser is "niceassos, pointed at the web": the OS shell
becomes the browser chrome, the wisp becomes the browser-frontier agent, and
fall-remember becomes per-site memory. This repo is the governed engine-room that
plugs into that shell.
