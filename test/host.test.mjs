// host.test.mjs — the shared Governor host + the pure observe step.
// deriveObserved is characterized (feeds the mutation gate); makeHost is exercised
// over a FAKE transport to prove the same governed brain drives any set of hands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveObserved } from '../host/observe.mjs';
import { makeHost } from '../host/governor-host.mjs';
import { mockLLM } from '../agent/llm.mjs';

// ── deriveObserved: kind is derived from the observed control, never the agent ──
test('deriveObserved maps read/scroll to a read', () => {
  assert.equal(deriveObserved(null, { op: 'read' }, 'a.com').kind, 'read');
  assert.equal(deriveObserved(null, { op: 'scroll' }, 'a.com').kind, 'read');
});
test('deriveObserved maps type to type_normal and carries the field', () => {
  const o = deriveObserved({ field: { type: 'password' }, origin: 'a.com' }, { op: 'type' }, 'a.com');
  assert.equal(o.kind, 'type_normal');
  assert.deepEqual(o.field, { type: 'password' });
});
test('deriveObserved distinguishes same- vs cross-origin navigation', () => {
  assert.equal(deriveObserved(null, { op: 'navigate', target: 'https://a.com/x' }, 'https://a.com').kind, 'navigate_same');
  assert.equal(deriveObserved(null, { op: 'navigate', target: 'https://evil.com' }, 'https://a.com').kind, 'navigate_cross');
  assert.equal(deriveObserved(null, { op: 'navigate', target: 'not a url' }, 'https://a.com').kind, 'navigate_same');
});
test('deriveObserved classifies a click by the control it lands on', () => {
  const O = 'shop.com';
  assert.equal(deriveObserved({ text: 'Checkout £9', origin: O }, { op: 'click' }, O).kind, 'purchase');
  assert.equal(deriveObserved({ text: 'Send', isSend: true, origin: O }, { op: 'click' }, O).kind, 'send_message');
  assert.equal(deriveObserved({ text: 'Save', isSubmit: true, origin: O }, { op: 'click' }, O).kind, 'submit_write');
  assert.equal(deriveObserved({ text: 'External', crossOrigin: true, origin: O }, { op: 'click' }, O).kind, 'navigate_cross');
  assert.equal(deriveObserved({ text: 'About', origin: O }, { op: 'click' }, O).kind, 'click_link');
});
test('deriveObserved returns unknown for an unrecognized op (Governor will block)', () => {
  assert.equal(deriveObserved(null, { op: 'teleport' }, 'a.com').kind, 'unknown');
});
test('deriveObserved takes cost from the OBSERVED item, falling back to the intent', () => {
  const O = 'shop.com';
  assert.equal(deriveObserved({ text: 'Buy', isSubmit: true, cost: 1299, origin: O }, { op: 'click', cost: 5 }, O).cost, 1299);
  assert.equal(deriveObserved({ text: 'Buy', isSubmit: true, origin: O }, { op: 'click', cost: 5 }, O).cost, 5);
  assert.equal(deriveObserved({ text: 'Buy', isSubmit: true, origin: O }, { op: 'click' }, O).cost, undefined);
});
test('deriveObserved defaults provenance to observed_content unless the user marked it', () => {
  assert.equal(deriveObserved(null, { op: 'read' }, 'a.com').provenance, 'observed_content');
  assert.equal(deriveObserved(null, { op: 'read', provenance: 'user' }, 'a.com').provenance, 'user');
});

// ── makeHost over a fake transport ────────────────────────────────────────────
function fakeHost({ items, llm } = {}) {
  const acted = [];
  const events = [];
  const snap = { origin: 'shop.example', url: 'https://shop.example/', title: 'Shop',
    items: items || [{ ref: 0, text: 'Buy now', isSubmit: true, cost: 1299, origin: 'shop.example' },
                     { ref: 1, text: 'Home', href: '/', origin: 'shop.example' }] };
  let clock = 1000;
  const host = makeHost({
    see: async () => snap,
    act: async (intent, d) => { acted.push({ intent, kind: d.kind }); return { done: true }; },
    now: () => (clock += 10),
    emit: (e) => events.push(e),
    llm: async () => llm || null,
  });
  return { host, acted, events };
}

test('host: control plane arms and grants a permission', () => {
  const { host } = fakeHost();
  assert.equal(host.snapshotState().killswitch.state, 'DISARMED');
  const s = host.arm();
  assert.equal(s.killswitch.state, 'ARMED');
});

test('host: an allowed action executes through the transport', async () => {
  const { host, acted } = fakeHost();
  host.arm(); await host.setPerm('shop.example', 'act');
  const v = await host.propose({ op: 'click', ref: 1, provenance: 'user' });   // Home link
  assert.equal(v.class, 'allow');
  assert.equal(acted.length, 1);
  assert.equal(acted[0].kind, 'click_link');
});

test('host: a purchase confirms, then consent executes it', async () => {
  const { host, acted } = fakeHost();
  host.arm(); await host.setPerm('shop.example', 'act'); host.setCap('shop.example', 5000);
  const v = await host.propose({ op: 'click', ref: 0, provenance: 'user' });    // "Buy now" => purchase
  assert.equal(v.class, 'confirm');
  assert.ok(v.pendingId);
  assert.equal(acted.length, 0);                                                // nothing fired yet
  const r = await host.consent(v.pendingId);
  assert.equal(r.ok, true);
  assert.equal(acted.length, 1);                                                // fired only after consent
  assert.equal(acted[0].kind, 'purchase');
});

test('host: a halted governor blocks even a read', async () => {
  const { host } = fakeHost();
  host.arm(); await host.setPerm('shop.example', 'act'); host.halt();
  const v = await host.propose({ op: 'read', provenance: 'user' });
  assert.equal(v.class, 'block');
});

test('host: runGoal without an LLM key asks for one', async () => {
  const { host, events } = fakeHost({ llm: null });
  host.arm(); await host.setPerm('shop.example', 'act');
  const r = await host.runGoal('do a thing');
  assert.equal(r.ok, false);
  assert.ok(events.some(e => e.evt === 'agent' && e.type === 'need_key'));
});

test('host: runGoal with a mock model drives the loop through the Governor', async () => {
  const llm = mockLLM([{ op: 'click', ref: 1, rationale: 'home' }, { op: 'done', done_reason: 'ok' }]);
  const { host, acted } = fakeHost({ llm });
  host.arm(); await host.setPerm('shop.example', 'act');
  const r = await host.runGoal('go home');
  assert.equal(r.phase, 'done');
  assert.equal(acted.length, 1);                                                // the click went through propose->act
});
