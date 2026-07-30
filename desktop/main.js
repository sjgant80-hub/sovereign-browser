// main.js — the DESKTOP adapter: the sovereign "own browser".
//
// Electron bundles a real Chromium; this process wraps it. It renders any site in a
// WebContentsView (the engine we DID NOT write), draws the browser chrome + agent
// rail, and wires the SAME shared Governor host used by the extension — proving the
// Governor is transport-agnostic. Every agent action goes through host.propose().
//
// Run:  cd desktop && npm install && npm start
'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const CHROME_H = 96;    // top chrome bar (tabs + address row)
const RAIL_W = 340;     // right-hand agent rail
// Where the shared modules live: sibling dirs in dev (repo root), copied next to
// main.js in a packaged build (electron-builder maps ../kernel -> kernel, etc.).
const ROOT = app.isPackaged ? __dirname : path.join(__dirname, '..');

let win = null, host = null, bridge = null, Store = null;
const tabs = new Map();                 // id -> { view, url, title }
let activeId = null, nextTabId = 1;

// tiny JSON store for perms + BYOK model config (in userData, never bundled)
function makeStore() {
  const file = path.join(app.getPath('userData'), 'sovereign-store.json');
  let data = {}; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  return { get: (k) => data[k], set: (k, v) => { data[k] = v; try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) {} } };
}

const activeTab = () => tabs.get(activeId) || null;

async function boot() {
  // the kernel/host/loop are ESM; import them dynamically from this CJS main
  const hostMod = await import(pathToFileURL(path.join(ROOT, 'host', 'governor-host.mjs')).href);
  const llmMod = await import(pathToFileURL(path.join(ROOT, 'agent', 'llm.mjs')).href);
  bridge = require('./bridge')(path.join(ROOT, 'page', 'agent-dom.js'));
  Store = makeStore();

  host = hostMod.makeHost({
    see: () => activeTab() ? bridge.see(activeTab().view.webContents) : Promise.resolve(null),
    act: (intent) => activeTab() ? bridge.act(activeTab().view.webContents, intent) : Promise.resolve({ error: 'no active tab' }),
    emit: (e) => { if (win && !win.isDestroyed()) win.webContents.send('host:event', e); },
    llm: async () => { const c = Store.get('llmConfig'); return (c && c.apiKey) ? llmMod.makeLLM(c) : null; },
    persistPerms: (t) => Store.set('permTable', t),
  });
  host.loadPerms(Store.get('permTable'));
}

function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return 'about:blank';
  if (/^https?:\/\//i.test(s) || s === 'about:blank') return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return 'https://' + s;      // looks like a domain
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);          // else search
}

function tabsMeta() {
  const t = activeTab();
  return { tabs: [...tabs.entries()].map(([id, x]) => ({ id, title: x.title, active: id === activeId })),
           activeId, url: t ? t.url : '', origin: (() => { try { return new URL(t.url).origin; } catch (e) { return ''; } })() };
}
function sendTabs() { if (win && !win.isDestroyed()) win.webContents.send('tabs:update', tabsMeta()); }

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  const t = activeTab();
  if (t) t.view.setBounds({ x: 0, y: CHROME_H, width: Math.max(0, w - RAIL_W), height: Math.max(0, h - CHROME_H) });
}

function newTab(url) {
  const id = nextTabId++;
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(view);
  const wc = view.webContents;
  const upd = (u) => { const t = tabs.get(id); if (t) { if (u) t.url = u; sendTabs(); } };
  wc.on('page-title-updated', (_e, title) => { const t = tabs.get(id); if (t) { t.title = title; sendTabs(); } });
  wc.on('did-navigate', (_e, u) => upd(u));
  wc.on('did-navigate-in-page', (_e, u) => upd(u));
  tabs.set(id, { view, url: url || 'about:blank', title: 'New tab' });
  setActive(id);
  if (url) wc.loadURL(normalizeUrl(url));
  return id;
}
function setActive(id) {
  activeId = id;
  for (const [tid, t] of tabs) { try { t.view.setVisible(tid === id); } catch (e) {} }
  layout(); sendTabs();
}
function closeTab(id) {
  const t = tabs.get(id); if (!t) return;
  try { win.contentView.removeChildView(t.view); t.view.webContents.destroy(); } catch (e) {}
  tabs.delete(id);
  if (activeId === id) { const first = tabs.keys().next().value; if (first) setActive(first); else newTab('https://duckduckgo.com'); }
  sendTabs();
}

function wireIPC() {
  ipcMain.handle('tabs:new', (_e, url) => newTab(url));
  ipcMain.handle('tabs:navigate', (_e, url) => { const t = activeTab(); if (t) t.view.webContents.loadURL(normalizeUrl(url)); return tabsMeta(); });
  ipcMain.handle('tabs:activate', (_e, id) => { setActive(id); return tabsMeta(); });
  ipcMain.handle('tabs:close', (_e, id) => { closeTab(id); return tabsMeta(); });
  ipcMain.handle('tabs:list', () => tabsMeta());
  ipcMain.handle('nav:back', () => { const t = activeTab(); if (t && t.view.webContents.canGoBack()) t.view.webContents.goBack(); });
  ipcMain.handle('nav:forward', () => { const t = activeTab(); if (t && t.view.webContents.canGoForward()) t.view.webContents.goForward(); });
  ipcMain.handle('nav:reload', () => { const t = activeTab(); if (t) t.view.webContents.reload(); });
  ipcMain.handle('gov:cmd', async (_e, msg) => {
    switch (msg && msg.cmd) {
      case 'arm': return host.arm();
      case 'halt': return host.halt(msg.reason);
      case 'setPerm': return host.setPerm(msg.origin, msg.perm);
      case 'setCap': return host.setCap(msg.origin, msg.cap);
      case 'propose': return host.propose(msg.intent);
      case 'consent': return host.consent(msg.id);
      case 'run_goal': return host.runGoal(msg.goal);
      case 'stop_goal': return host.stopGoal();
      case 'setLLM': Store.set('llmConfig', msg.config); return { ok: true };
      case 'getState': return host.snapshotState();
      default: return { error: 'unknown cmd' };
    }
  });
}

async function createWindow() {
  await boot();
  win = new BrowserWindow({
    width: 1360, height: 880, backgroundColor: '#0a0d13',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  wireIPC();
  await win.webContents.loadFile(path.join(__dirname, 'ui', 'chrome.html'));
  win.on('resize', layout);
  newTab('https://duckduckgo.com');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
