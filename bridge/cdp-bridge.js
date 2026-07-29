// cdp-bridge.js — the I/O boundary: the agent's eyes and hands on a REAL browser.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ THE WRAP-DON'T-WRITE LINE LIVES HERE.                                     │
// │ We do NOT implement a rendering engine. We drive a real Chromium over the │
// │ Chrome DevTools Protocol (CDP) — the exact mechanism Puppeteer/Playwright │
// │ and computer-use agents use. This file is the CDP *client*; the engine is │
// │ Chromium itself. In the desktop product the same Chromium is bundled by   │
// │ an Electron/Tauri shell (like Brave/Arc). Everything above this file is   │
// │ pure and witnessed; everything this file touches is real, external I/O.   │
// └─────────────────────────────────────────────────────────────────────────┘
//
// To run live: launch Chrome with a debugging port, e.g.
//     chrome --remote-debugging-port=9222 --user-data-dir=/path/to/your/profile
// (the --user-data-dir carries YOUR authenticated sessions — that is the point,
// and precisely why the Governor is load-bearing). Then connect() below attaches
// to it. No engine is written; a real one is wrapped.

import { verdict } from '../kernel/governor.mjs';

// --- SEE: snapshot the live page for the agent (DOM + screenshot) -------------
// Real CDP calls. Kept thin: the agent's model consumes {url, domText, screenshot}.
export async function see(cdp) {
  const { result: url } = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  const dom = await cdp.send('Runtime.evaluate', {
    expression: 'document.body.innerText.slice(0, 20000)', returnByValue: true,
  });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return { url: url.value, domText: dom.result.value, screenshot: shot.data };
}

// --- ACT: the agent's hands — but EVERY act passes through the Governor -------
// This is the whole safety contract in one function: the bridge cannot dispatch a
// synthetic event without a verdict, and it physically cannot turn a 'confirm' into
// an 'allow' on its own — it must call out to the user (confirmFn) for that.
export async function act(cdp, gov, proposal, { confirmFn, ts }) {
  const v = verdict(proposal, gov.state, ts);      // pure decision
  gov.record(proposal, v, ts);                     // audit BEFORE side effect

  if (v.verdict === 'block') return { done: false, verdict: v };
  if (v.verdict === 'confirm') {
    const ok = await confirmFn(proposal, v);       // user is the only upgrade path
    if (!ok) return { done: false, verdict: { ...v, verdict: 'block', reason: 'user declined' } };
  }
  await dispatch(cdp, proposal);                   // only now: the real event
  return { done: true, verdict: v };
}

// Map an abstract proposal to concrete CDP input. Real synthetic events.
async function dispatch(cdp, p) {
  switch (p.action) {
    case 'navigate':
      return cdp.send('Page.navigate', { url: p.target });
    case 'click_link':
    case 'click':
      return cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
        .then(() => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }));
    case 'type_text':
      return cdp.send('Input.insertText', { text: p.text });
    case 'scroll':
      return cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: p.dy });
    case 'submit_form':
      return cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(p.selector)})?.submit()` });
    default:
      // Unknown concrete action: the Governor should have blocked it; refuse anyway.
      throw new Error(`bridge refuses unmapped action: ${p.action}`);
  }
}

// connect() — attach to a running Chromium's DevTools endpoint. Left as the single
// documented seam: wire your CDP transport of choice (chrome-remote-interface,
// playwright's CDPSession, or a raw ws to ws://127.0.0.1:9222/...). The kernel and
// the act()/see() contract above do not change when you swap the transport.
export async function connect(/* { port = 9222 } = {} */) {
  throw new Error(
    'connect() is the wrap seam — attach a real Chromium over CDP here ' +
    '(e.g. playwright.chromium.connectOverCDP or a ws to the --remote-debugging-port). ' +
    'The engine is Chromium; this repo wraps it, it does not write it.');
}
