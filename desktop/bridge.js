// bridge.js — the desktop SEE/ACT transport: drive a real Chromium tab over
// Electron's webContents API. It injects the SHARED page/agent-dom.js (the same
// file the extension content-scripts) and calls its globals. This is the "wrap a
// real engine" line for the desktop app — we drive Chromium, we don't write it.
'use strict';
const fs = require('fs');
const path = require('path');

const DOM = fs.readFileSync(path.join(__dirname, '..', 'page', 'agent-dom.js'), 'utf8');

async function inject(wc) { await wc.executeJavaScript(DOM, true); }   // idempotent

async function see(wc) {
  await inject(wc);
  return wc.executeJavaScript('window.__sbSee ? window.__sbSee() : null', true);
}

async function act(wc, action) {
  await inject(wc);
  // Only ever called after a Governor allow. JSON-encode the action so nothing is interpolated as code.
  return wc.executeJavaScript('window.__sbAct(' + JSON.stringify(action) + ')', true);
}

module.exports = { see, act };
