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

import { verdict, classifyAction } from '../kernel/governor.mjs';

// Which concrete CDP actions may serve which OBSERVED kind. The Governor judges the
// observed event; dispatch() performs a concrete one. Nothing used to tie the two
// together, so a proposal could be judged as a `read` and then dispatched as a form
// submit — the gate passing on one event while a different event fired. The verdict
// only means something if the thing dispatched is the thing that was judged.
const ACTION_KINDS = Object.freeze({
  navigate:    ['navigate_same', 'navigate_cross'],
  click_link:  ['click_link', 'submit_search'],
  click:       ['click_link', 'submit_search', 'purchase', 'send_message', 'submit_write',
                'delete_recoverable', 'oauth_grant', 'settings_change', 'download_file',
                'upload_file', 'cross_site_move', 'navigate_cross'],
  type_text:   ['type_normal', 'submit_search'],
  scroll:      ['read'],
  submit_form: ['submit_write', 'submit_search', 'send_message', 'purchase', 'settings_change'],
});

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
// ⚑ THE FIELD IS `class`, AND THIS READ `v.verdict`. verdict() has always returned
// { class, reason } — there is no `verdict` key on it — so both comparisons compared
// undefined against a string, both were false, and execution fell straight through to
// dispatch(). Every proposal fired: a fund_movement at a bank, a password into a login
// form, an over-cap purchase. confirmFn was never once called. The kernel was computing
// correct verdicts the whole time and this line threw every one of them away, in the one
// function whose stated job is that the bridge cannot dispatch without a verdict.
//
// Rewritten so the failure cannot recur in that shape: there is ONE dispatch, it is
// reached only by `cleared`, and `cleared` is set only by an explicit 'allow' or by a
// user's yes. Any other verdict — block, a class this file does not know, a malformed
// return — leaves it false and refuses. A typo now blocks instead of dispatching.
export async function act(cdp, gov, proposal, { confirmFn, ts } = {}) {
  const v = verdict(proposal, gov && gov.state, ts);   // pure decision
  if (gov && typeof gov.record === 'function') gov.record(proposal, v, ts);  // audit BEFORE side effect

  // No `v &&` guards below. verdict() is total — the fuzz gate throws hostile garbage at it
  // and it always returns a { class, reason } — so a null check here is unreachable code that
  // reads as caution while testing nothing. The mutation gate found it: flipping its && to ||
  // changed no behaviour, which is what an unreachable branch looks like from the outside.
  let cleared = v.class === 'allow';
  if (v.class === 'confirm') {
    if (typeof confirmFn !== 'function')             // a confirm with nobody to ask is a block
      return { done: false, verdict: { class: 'block', reason: 'confirm required, no confirmFn wired' } };
    const ok = await confirmFn(proposal, v);         // user is the only upgrade path
    if (!ok) return { done: false, verdict: { class: 'block', reason: 'user declined' } };
    cleared = true;
  }
  if (!cleared) return { done: false, verdict: v };

  // The verdict was issued about the OBSERVED event; refuse to dispatch a different one.
  const kind = classifyAction(proposal && proposal.observed).kind;
  const allowedFor = ACTION_KINDS[proposal && proposal.action];
  if (!allowedFor || !allowedFor.includes(kind))
    return { done: false, verdict: { class: 'block', reason: `action '${proposal && proposal.action}' does not serve observed kind '${kind}'` } };

  await dispatch(cdp, proposal);                     // only now: the real event
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
