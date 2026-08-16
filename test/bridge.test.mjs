// bridge.test.mjs — the I/O boundary's ONE safety contract, under test at last.
//
// act() is the single place a verdict becomes (or fails to become) a real synthetic
// event, and it had no test of any kind. It read `v.verdict` — a key the kernel has
// never returned — so every comparison was against undefined, every branch fell
// through, and everything dispatched. The kernel was fine. The wire was cut.
//
// So these tests are written against the only thing that matters here: WAS A REAL
// EVENT SENT. A fake cdp records every send; a blocked proposal must leave it empty.
// Asserting on the returned verdict would not have caught the original bug, because
// the returned verdict was correct the whole time — it was ignored, not wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, see, connect } from '../bridge/cdp-bridge.js';

// a cdp that records instead of driving Chromium
function fakeCdp(responses = {}) {
  const sent = [];
  return {
    sent,
    async send(method, params) {
      sent.push({ method, params });
      return responses[method] ?? { result: { value: '' }, data: '' };
    },
  };
}
const govOf = (state) => { const seen = []; return { state, seen, record: (p, v, ts) => seen.push({ p, v, ts }) }; };

const ARMED = (over = {}) => ({
  permTable: { 'shop.example': 'act' }, permsEpoch: 0,
  killswitch: { state: 'ARMED', killEpoch: 1 },
  spend: { currency: 'GBP', global_cap: 20000, global_total: 0, per_site: { 'shop.example': { cap: 5000, total: 0 } } },
  consents: {}, consumedTokens: [], ...over,
});
const yes = async () => true;
const no = async () => false;

// ── the finding, pinned ────────────────────────────────────────────────────────
test('a BLOCKED proposal dispatches no event at all', async () => {
  const cdp = fakeCdp();
  // fund_movement is a prohibited kind: terminal block, no consent path exists.
  const r = await act(cdp, govOf(ARMED()), {
    action: 'click',
    observed: { kind: 'fund_movement', effectiveOrigin: 'shop.example', provenance: 'user' },
  }, { confirmFn: yes, ts: 1 });
  assert.equal(r.done, false);
  assert.equal(r.verdict.class, 'block');
  assert.deepEqual(cdp.sent, [], 'a blocked action reached the page');
});

test('an off-domain site blocks, and the page is never touched', async () => {
  const cdp = fakeCdp();
  const r = await act(cdp, govOf(ARMED()), {
    action: 'navigate',
    observed: { kind: 'navigate_same', effectiveOrigin: 'bank.example', provenance: 'user' },
  }, { confirmFn: yes, ts: 1 });
  assert.equal(r.done, false);
  assert.equal(cdp.sent.length, 0);
});

test('a CONFIRM asks the user, and dispatches nothing until they say yes', async () => {
  const p = {
    action: 'click',
    observed: { kind: 'purchase', effectiveOrigin: 'shop.example', provenance: 'user', cost: 1299, currency: 'GBP' },
    x: 4, y: 5,
  };
  const declined = fakeCdp();
  let asked = 0;
  const r1 = await act(declined, govOf(ARMED()), p, { confirmFn: async () => { asked++; return false; }, ts: 1 });
  assert.equal(asked, 1, 'the user was not asked');
  assert.equal(r1.done, false);
  assert.equal(r1.verdict.class, 'block');
  assert.deepEqual(declined.sent, [], 'a declined purchase reached the page');

  const accepted = fakeCdp();
  const r2 = await act(accepted, govOf(ARMED()), p, { confirmFn: yes, ts: 1 });
  assert.equal(r2.done, true);
  assert.equal(accepted.sent.length, 2, 'an approved click should press and release');
});

test('a confirm with no confirmFn wired is a block, not a silent allow', async () => {
  const cdp = fakeCdp();
  const r = await act(cdp, govOf(ARMED()), {
    action: 'click',
    observed: { kind: 'purchase', effectiveOrigin: 'shop.example', provenance: 'user', cost: 1299, currency: 'GBP' },
  }, { ts: 1 });
  assert.equal(r.done, false);
  assert.equal(r.verdict.class, 'block');
  assert.deepEqual(cdp.sent, []);
});

test('an ALLOW dispatches exactly the mapped CDP call', async () => {
  const cdp = fakeCdp();
  const r = await act(cdp, govOf(ARMED()), {
    action: 'navigate', target: 'https://shop.example/x',
    observed: { kind: 'navigate_same', effectiveOrigin: 'shop.example', provenance: 'user' },
  }, { confirmFn: no, ts: 1 });
  assert.equal(r.done, true);
  assert.equal(r.verdict.class, 'allow');
  assert.deepEqual(cdp.sent, [{ method: 'Page.navigate', params: { url: 'https://shop.example/x' } }]);
});

test('the verdict is recorded BEFORE any side effect, blocked or not', async () => {
  const gov = govOf(ARMED());
  const cdp = fakeCdp();
  await act(cdp, gov, { action: 'click', observed: { kind: 'fund_movement', effectiveOrigin: 'shop.example' } }, { confirmFn: yes, ts: 77 });
  assert.equal(gov.seen.length, 1);
  assert.equal(gov.seen[0].ts, 77);
  assert.equal(gov.seen[0].v.class, 'block');
});

// ── the second half of the same finding: judged one event, dispatched another ───
test('the dispatched action must serve the kind that was judged', async () => {
  const cdp = fakeCdp();
  // judged as a read (allow), then asked to submit a form. The old code would have
  // dispatched the submit on the strength of a verdict about scrolling.
  const r = await act(cdp, govOf(ARMED()), {
    action: 'submit_form', selector: '#f',
    observed: { kind: 'read', effectiveOrigin: 'shop.example', provenance: 'user' },
  }, { confirmFn: yes, ts: 1 });
  assert.equal(r.done, false);
  assert.match(r.verdict.reason, /does not serve observed kind/);
  assert.deepEqual(cdp.sent, []);
});

test('an unmapped concrete action is refused before dispatch', async () => {
  const cdp = fakeCdp();
  const r = await act(cdp, govOf(ARMED()), {
    action: 'exfiltrate',
    observed: { kind: 'read', effectiveOrigin: 'shop.example', provenance: 'user' },
  }, { confirmFn: yes, ts: 1 });
  assert.equal(r.done, false);
  assert.deepEqual(cdp.sent, []);
});

test('a matching action/kind pair for each mapped action does dispatch', async () => {
  const cases = [
    [{ action: 'type_text', text: 'hi', observed: { kind: 'type_normal' } }, 'Input.insertText'],
    [{ action: 'scroll', x: 1, y: 2, dy: 30, observed: { kind: 'read' } }, 'Input.dispatchMouseEvent'],
    [{ action: 'click_link', x: 1, y: 2, observed: { kind: 'click_link' } }, 'Input.dispatchMouseEvent'],
  ];
  for (const [p, method] of cases) {
    const cdp = fakeCdp();
    const r = await act(cdp, govOf(ARMED()), { ...p, observed: { ...p.observed, effectiveOrigin: 'shop.example', provenance: 'user' } }, { confirmFn: no, ts: 1 });
    assert.equal(r.done, true, `${p.action} should have dispatched`);
    assert.equal(cdp.sent[0].method, method);
  }
});

// ── totality: the boundary must not throw its way past the gate ────────────────
test('act is total on garbage — it blocks rather than throwing', async () => {
  for (const junk of [null, undefined, 0, 'x', [], { action: null }, { observed: { kind: 'nope' } }]) {
    const cdp = fakeCdp();
    const r = await act(cdp, govOf(ARMED()), junk, { confirmFn: yes, ts: 1 });
    assert.equal(r.done, false);
    assert.deepEqual(cdp.sent, [], `garbage ${JSON.stringify(junk)} reached the page`);
  }
});

test('a missing governor blocks (no state means DISARMED means frozen)', async () => {
  const cdp = fakeCdp();
  const r = await act(cdp, undefined, { action: 'scroll', observed: { kind: 'read', effectiveOrigin: 'shop.example' } }, { confirmFn: yes, ts: 1 });
  assert.equal(r.done, false);
  assert.deepEqual(cdp.sent, []);
});

test('a HALTED killswitch freezes even a read', async () => {
  const cdp = fakeCdp();
  const r = await act(cdp, govOf(ARMED({ killswitch: { state: 'HALTED', killEpoch: 2 } })),
    { action: 'scroll', observed: { kind: 'read', effectiveOrigin: 'shop.example', provenance: 'user' } },
    { confirmFn: yes, ts: 1 });
  assert.equal(r.done, false);
  assert.match(r.verdict.reason, /^halted:/);
  assert.deepEqual(cdp.sent, []);
});

// ── see() and connect(): the rest of the boundary ──────────────────────────────
test('see() returns the three things the agent consumes', async () => {
  const cdp = fakeCdp({
    'Runtime.evaluate': { result: { value: 'https://shop.example/' } },
    'Page.captureScreenshot': { data: 'PNGDATA' },
  });
  const s = await see(cdp);
  assert.equal(s.url, 'https://shop.example/');
  assert.equal(s.screenshot, 'PNGDATA');
  assert.equal(cdp.sent.filter(c => c.method === 'Page.captureScreenshot').length, 1);
});

test('connect() refuses rather than pretending to be attached', async () => {
  await assert.rejects(() => connect(), /wrap seam/);
});
