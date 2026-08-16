// agent-loop.mjs — the full agent loop, deterministically. `npm run demo:agent`.
//
// A SCRIPTED model (no network) pursues a goal across a fake page. Every action it
// picks is gated by the real Governor; a purchase pauses for consent, the user
// approves, and the loop resumes — exactly the extension's flow, minus the network.
import {
  verdict, classifyAction, payloadHash, initState, applyPermChange, grantConsent, consumeConsent,
} from '../kernel/governor.mjs';
import { runAgent } from '../agent/loop.mjs';
import { mockLLM } from '../agent/llm.mjs';
import { deriveObserved as observe } from '../host/observe.mjs';

let clock = 1_700_000_000_000; const now = () => (clock += 1000);

// governor state: armed, shop.example may act, £50 site cap
let gov = applyPermChange({ ...initState({ currency: 'GBP', globalCap: 20000 }), killswitch: { state: 'ARMED', killEpoch: 1 } }, 'shop.example', 'act');
gov = { ...gov, spend: { ...gov.spend, per_site: { 'shop.example': { cap: 5000, total: 0 } } } };

// a fake page the "bridge" observes. `cost` on the checkout control is a PAGE fact —
// the price the bridge scraped off that button — not a number the agent supplied.
const PAGE = {
  origin: 'shop.example',
  url: 'https://shop.example/widgets', title: 'Widgets — shop.example', text: 'Blue widget £12.99. Returns within 30 days.',
  items: [
    { ref: 0, text: 'Returns policy', href: '/returns', origin: 'shop.example' },
    { ref: 1, text: 'Search', field: { type: 'text', name: 'q' }, origin: 'shop.example' },
    { ref: 2, text: 'Checkout £12.99', isSubmit: true, origin: 'shop.example', cost: 1299 },
  ],
};
const see = async () => PAGE;

// the bridge: derive OBSERVED facts from (item + intent), then the Governor decides.
//
// ⚑ This demo used to carry its OWN copy of that derivation — a different purchase
// regex, a hardcoded £12.99 applied to whatever matched, and none of the sensitive-field
// or cross-origin branches. So the demo that exists to show the safety story was not
// running the shipped safety path: host/observe.mjs could have rotted to nothing and this
// still printed its confident ✓, because it was grading its own private copy. The two
// were already apart — the shipped regex had `place|purchase`, this one did not. It now
// calls the real one, which is the only version of this demo that is evidence.
const deriveObserved = (intent) =>
  observe(typeof intent.ref === 'number' ? PAGE.items.find(i => i.ref === intent.ref) : null, intent, PAGE.origin);
let pending = null;
async function propose(intent) {                    // runAgent calls propose(intent) directly
  const observed = deriveObserved(intent);
  const v = verdict({ observed }, gov, now());
  if (v.class === 'confirm') {
    const d = classifyAction(observed);
    pending = { hash: payloadHash({ kind: d.kind, origin: d.effectiveOrigin, cost: d.cost, currency: d.currency }), descriptor: d };
    return { ...v, pendingId: 'p1' };
  }
  return v;
}

const bar = () => console.log('  ' + '─'.repeat(58));
function onEvent(e) {
  if (e.type === 'start') console.log(`\n\x1b[1mGOAL\x1b[0m  ${e.goal}\n`);
  else if (e.type === 'step') {
    const mark = { allow: '\x1b[32m✓\x1b[0m', confirm: '\x1b[33m⏸\x1b[0m', block: '\x1b[31m✗\x1b[0m' }[e.verdict.class];
    const act = `${e.intent.op}${e.intent.ref != null ? ' #' + e.intent.ref : ''}`.padEnd(10);
    console.log(`  ${mark} ${act} ${e.verdict.class.toUpperCase().padEnd(8)} ${e.verdict.reason}   \x1b[2m«${e.intent.rationale}»\x1b[0m`);
  } else if (e.type === 'await_consent') console.log(`    \x1b[33m↳ pauses for your approval in the rail…\x1b[0m`);
  else if (e.type === 'done') console.log(`  \x1b[1m■ done\x1b[0m — ${e.intent.done_reason}`);
}

// the model's plan: look, read returns, search, check out (pauses), then finish
const script = [
  { op: 'read', rationale: 'see what is on the page' },
  { op: 'click', ref: 0, rationale: 'open the returns policy' },
  { op: 'type', ref: 1, text: 'blue widget', rationale: 'search for the item' },
  { op: 'click', ref: 2, rationale: 'check out the £12.99 widget' },
  { op: 'done', done_reason: 'widget purchased after your approval' },
];
const llm = mockLLM(script);
const deps = { see, llm, propose, onEvent };

const main = async () => {
  let state = await runAgent({ goal: 'buy the blue widget, and check the returns policy first', deps, budget: 12 });
  // the user approves the pending purchase in the rail; grant consent + resume
  if (state.phase === 'awaiting_consent' && pending) {
    bar();
    console.log('  \x1b[33m● you approve the £12.99 checkout in the side panel\x1b[0m');
    gov = grantConsent(gov, pending.hash, 'con1', now() + 60000);
    const v = verdict({ observed: deriveObserved({ op: 'click', ref: 2 }) }, gov, now());
    console.log(`  \x1b[32m✓\x1b[0m checkout   ${v.class.toUpperCase()}   ${v.reason}   \x1b[2m(consent honoured, within cap)\x1b[0m`);
    gov = consumeConsent(gov, pending.hash); pending = null;
    bar();
    state = await runAgent({ goal: 'confirm the purchase completed', deps, budget: 4 });
  }
  console.log(`\n  loop ended: \x1b[1m${state.phase}\x1b[0m — every action passed through the Governor.\n`);
};
main();
