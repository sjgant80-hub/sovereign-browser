// agent.test.mjs — the agent loop's proof. The pure normalizing/control layer is
// mutation-tested; the runner is driven by fakes to prove the central safety
// property: every action the model picks goes through the Governor (`propose`),
// and no malformed model output ever becomes a synthetic event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toIntent, interpretVerdict, summarizeSnapshot, initLoop, advance, isRunning, AGENT_OPS,
} from '../agent/tools.mjs';
import { runAgent } from '../agent/loop.mjs';
import { mockLLM } from '../agent/llm.mjs';

// ── toIntent: bounded normalization, total on garbage ─────────────────────────
test('toIntent normalizes a valid click and marks provenance user', () => {
  const i = toIntent({ op: 'click', ref: 3, rationale: 'the buy button' });
  assert.equal(i.op, 'click');
  assert.equal(i.ref, 3);
  assert.equal(i.provenance, 'user');
});
test('toIntent clamps type text and navigate target lengths', () => {
  assert.equal(toIntent({ op: 'type', text: 'x'.repeat(9000) }).text.length, 4000);
  assert.equal(toIntent({ op: 'navigate', target: 'y'.repeat(9000) }).target.length, 2000);
});
test('toIntent rejects an unknown op to a safe invalid intent (no event)', () => {
  assert.equal(toIntent({ op: 'exfiltrate' }).op, 'invalid');
  assert.equal(toIntent(null).op, 'invalid');
  assert.equal(toIntent({ op: 'click', ref: -5 }).ref, undefined);   // bad ref dropped
});
test('toIntent keeps ref 0 (the first element is a valid target)', () => {
  assert.equal(toIntent({ op: 'click', ref: 0 }).ref, 0);            // >= 0, not > 0
});
test('toIntent passes done through WITH its reason (not rebuilt as an action)', () => {
  const d = toIntent({ op: 'done', done_reason: 'goal met' });
  assert.equal(d.op, 'done');
  assert.equal(d.done_reason, 'goal met');                          // done_reason survives the early return
});

// ── interpretVerdict: verdict -> loop move ────────────────────────────────────
test('interpretVerdict maps allow/confirm/block/garbage', () => {
  assert.equal(interpretVerdict({ class: 'allow' }).next, 'continue');
  assert.equal(interpretVerdict({ class: 'confirm', pendingId: 'c1' }).next, 'await_consent');
  assert.equal(interpretVerdict({ class: 'confirm', pendingId: 'c1' }).pendingId, 'c1');
  assert.equal(interpretVerdict({ class: 'block', reason: 'prohibited' }).next, 'feedback');
  assert.equal(interpretVerdict({ class: 'block', reason: 'prohibited:fund_movement' }).reason, 'prohibited:fund_movement');
  assert.equal(interpretVerdict({ class: 'block' }).reason, 'blocked');   // fallback when no reason
  assert.equal(interpretVerdict(null).next, 'stop');
});

// ── summarizeSnapshot: bounded, hostile-page-safe ─────────────────────────────
test('summarizeSnapshot trims item count and text, classifies kinds', () => {
  const snap = { url: 'https://x/', title: 't', text: 'z'.repeat(9000),
    items: Array.from({ length: 200 }, (_, r) => ({ ref: r, text: 'e' + r, isSubmit: r === 0 })) };
  const s = summarizeSnapshot(snap, { maxItems: 60, maxText: 4000 });
  assert.equal(s.items.length, 60);
  assert.equal(s.text.length, 4000);
  assert.equal(s.items[0].kind, 'submit');
});

// ── loop state machine ────────────────────────────────────────────────────────
test('advance moves running -> done on op=done', () => {
  const st = advance(initLoop({ goal: 'g', budget: 5 }), { op: 'done' }, { next: 'stop' });
  assert.equal(st.phase, 'done');
});
test('advance moves running -> awaiting_consent on a confirm', () => {
  const st = advance(initLoop({ goal: 'g', budget: 5 }), { op: 'click' }, { next: 'await_consent' });
  assert.equal(st.phase, 'awaiting_consent');
  assert.equal(isRunning(st), false);
});
test('advance exhausts the budget', () => {
  let st = initLoop({ goal: 'g', budget: 2 });
  st = advance(st, { op: 'read' }, { next: 'continue' });
  assert.equal(st.phase, 'running');
  st = advance(st, { op: 'read' }, { next: 'continue' });
  assert.equal(st.phase, 'budget_exhausted');
});
test('advance stops on an invalid op', () => {
  const st = advance(initLoop({ goal: 'g' }), { op: 'invalid' }, { next: 'stop' });
  assert.equal(st.phase, 'stopped');
});

// ── runAgent: the safety property — every action goes through the Governor ─────
function harness({ script, verdicts }) {
  const proposed = [];
  const events = [];
  const see = async () => ({ url: 'https://shop.example/', title: 'Shop', text: 'a page',
    items: [{ ref: 0, text: 'Buy now', isSubmit: true }] });
  let vi = 0;
  const propose = async (intent) => { proposed.push(intent); return verdicts[vi++] || { class: 'allow', reason: 'allow' }; };
  return { deps: { see, llm: mockLLM(script), propose, onEvent: (e) => events.push(e) }, proposed, events };
}

test('runAgent: allow path runs the action then finishes on done', async () => {
  const h = harness({ script: [{ op: 'click', ref: 0, rationale: 'buy' }, { op: 'done', done_reason: 'bought' }],
    verdicts: [{ class: 'allow', reason: 'allow:submit_write' }] });
  const st = await runAgent({ goal: 'buy the thing', deps: h.deps, budget: 8 });
  assert.equal(st.phase, 'done');
  assert.equal(h.proposed.length, 1);                 // the click went through the Governor
  assert.equal(h.proposed[0].op, 'click');
});

test('runAgent: a confirm pauses the loop for out-of-band consent', async () => {
  const h = harness({ script: [{ op: 'click', ref: 0, rationale: 'checkout' }],
    verdicts: [{ class: 'confirm', reason: 'awaiting_consent:purchase', pendingId: 'c1' }] });
  const st = await runAgent({ goal: 'check out', deps: h.deps, budget: 8 });
  assert.equal(st.phase, 'awaiting_consent');
  assert.ok(h.events.some(e => e.type === 'await_consent' && e.pendingId === 'c1'));
});

test('runAgent: a blocked action becomes feedback and the loop continues', async () => {
  const h = harness({ script: [{ op: 'navigate', target: 'https://bank.example', rationale: 'x' }, { op: 'done', done_reason: 'cannot' }],
    verdicts: [{ class: 'block', reason: 'prohibited:fund_movement' }] });
  const st = await runAgent({ goal: 'move money', deps: h.deps, budget: 8 });
  assert.equal(st.phase, 'done');
  assert.equal(h.proposed.length, 1);                 // blocked action still went through the Governor
});

test('runAgent: never exceeds the step budget', async () => {
  // a model that only ever reads and never finishes
  const h = harness({ script: Array.from({ length: 50 }, () => ({ op: 'read', rationale: 'look' })),
    verdicts: Array.from({ length: 50 }, () => ({ class: 'allow', reason: 'allow:read' })) });
  const st = await runAgent({ goal: 'loop forever', deps: h.deps, budget: 4 });
  assert.equal(st.phase, 'budget_exhausted');
  assert.equal(st.steps, 4);
  assert.equal(h.proposed.length, 4);
});

test('runAgent: a garbage model call stops WITHOUT ever calling the Governor/acting', async () => {
  const h = harness({ script: [{ op: 'HACK_THE_MAINFRAME' }], verdicts: [] });
  const st = await runAgent({ goal: 'anything', deps: h.deps, budget: 8 });
  assert.equal(st.phase, 'stopped');
  assert.equal(h.proposed.length, 0);                 // invalid never reaches propose -> never acts
});

test('AGENT_OPS is the closed set the model may pick from', () => {
  assert.deepEqual(AGENT_OPS, ['read', 'click', 'type', 'scroll', 'navigate', 'done']);
});
