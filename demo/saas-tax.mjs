// saas-tax.mjs — the pitch, made runnable. `npm run demo`.
//
// Part 1: ONE governed agent runs a real task across THREE sites — drafting on a
//         docs app, buying within a cap on a shop, and being STOPPED cold at a bank
//         and a login form. Every action gets a Governor verdict; the audit chain
//         is verified at the end. No twenty per-app AIs; one agent, gated.
// Part 2: the money — what that one agent replaces, and what it saves.
//
// Pure kernel only (no browser needed): deterministic, so the numbers are checkable.
import {
  verdict, classifyAction, payloadHash, initState,
  killswitchTrip, applyPermChange, reserveSpend, commitSpend, grantConsent,
} from '../kernel/governor.mjs';
import { AuditLedger, verifyChain, canonicalJSON, fnv1a } from '../kernel/envelope.mjs';

const money = (p) => '£' + (p / 100).toFixed(2);
let clock = 1_700_000_000_000;
const now = () => (clock += 1000);

// The user's signing key. In the product this is Ed25519 held by the host; here it is a
// deterministic keyed stand-in so the demo has no dependencies and the same numbers come
// out every run. What is being demonstrated is structural and does not depend on which
// primitive it is: signing needs the key, and whoever rewrites the log does not have it.
const KEY = 'user-key-not-held-by-the-agent';
const signFn = (msg) => fnv1a(KEY + '|' + msg);
const verify = (msg, sig) => sig === fnv1a(KEY + '|' + msg);

// ── set up a governed session: arm, grant per-site rights + caps ───────────────
let gov = initState({ currency: 'GBP', globalCap: 20000 });        // £200 global cap
gov = { ...gov, killswitch: { state: 'ARMED', killEpoch: 1 } };     // user arms the agent
gov = applyPermChange(gov, 'docs.example', 'act');                  // full act on the docs app
gov = applyPermChange(gov, 'shop.example', 'act');                  // full act on the shop
gov = applyPermChange(gov, 'news.example', 'read');                 // read-only on the news site
gov = { ...gov, spend: { ...gov.spend, per_site: { 'shop.example': { cap: 5000, total: 0 } } } };  // £50 shop cap

const ledger = new AuditLedger({ signFn });
const line = (label, v) => {
  const mark = { allow: '✓', confirm: '⏸', block: '✗' }[v.class];
  const pad = label.padEnd(52);
  console.log(`  ${mark} ${pad} ${v.class.toUpperCase().padEnd(8)} ${v.reason}`);
  ledger.append({ kind: 'decision', actor: 'governor', payload: { label, verdict: v }, ts: now() });
};
const decide = (observed) => verdict({ observed }, gov, now());
// the user approving in the rail == granting a consent into host-controlled state
const withConsent = (observed) => {
  const d = classifyAction(observed);
  const hash = payloadHash({ kind: d.kind, origin: d.effectiveOrigin, cost: d.cost, currency: d.currency });
  gov = grantConsent(gov, hash, `con${ledger.seq}`, now() + 60000);
  return verdict({ observed }, gov, now());
};

console.log('\n\x1b[1mPART 1 — one governed agent, three sites, one task\x1b[0m\n');

// docs.example — read the doc, then draft into it. Reversible → flows.
line('docs: read the current document', decide({ kind: 'read', effectiveOrigin: 'docs.example', provenance: 'user' }));
line('docs: type a drafted paragraph', decide({ kind: 'type_normal', effectiveOrigin: 'docs.example', provenance: 'user', field: { type: 'text', name: 'body' } }));

// news.example — read-only site. Reading is fine; a write is sealed off.
line('news: read the article', decide({ kind: 'read', effectiveOrigin: 'news.example', provenance: 'user' }));
line('news: post a comment (site is read-only)', decide({ kind: 'submit_write', effectiveOrigin: 'news.example', provenance: 'user' }));

// shop.example — buy a £12.99 item. Consequential → confirm, then user consents, within the £50 cap.
const buy = { kind: 'purchase', effectiveOrigin: 'shop.example', provenance: 'user', cost: 1299, currency: 'GBP' };
line('shop: add to cart & checkout £12.99 (needs OK)', decide(buy));
line('shop: …user approves in the rail → within cap', withConsent(buy));
gov = { ...gov, spend: reserveSpend(gov.spend, 1, 'shop.example', 1299) };
gov = { ...gov, spend: commitSpend(gov.spend, 1) };

// shop.example — a £60.00 buy would break the £50 site cap. Blocked even WITH consent.
const bigBuy = { kind: 'purchase', effectiveOrigin: 'shop.example', provenance: 'user', cost: 6000, currency: 'GBP' };
line('shop: buy £60.00 (over the £50 cap, even approved)', withConsent(bigBuy));

// bank.example — never granted, and moving money is prohibited outright.
line('bank: transfer £500 (prohibited + off-domain)', decide({ kind: 'fund_movement', effectiveOrigin: 'bank.example', provenance: 'user' }));

// a login form on the shop — entering the password is a terminal block, no confirm path.
line('shop: type into the password field', decide({ kind: 'type_normal', effectiveOrigin: 'shop.example', provenance: 'user', field: { type: 'password' } }));

// a prompt-injected agent tries to relabel a purchase as a harmless scroll. The label it
// declares is passed in alongside the observed event, and the verdict comes back purchase-
// shaped — because verdict() reads `observed`, never `agentLabel`. (This line used to pass
// no label at all while its caption claimed a mislabel had been defeated: a caption
// describing a defence the code was not exercising.)
line('injected: purchase mislabeled "scroll"', verdict({
  agentLabel: 'scroll',
  observed: { kind: 'purchase', effectiveOrigin: 'shop.example', provenance: 'observed_content', cost: 999, currency: 'GBP' },
}, gov, now()));

// user hits the kill-switch; the agent freezes — even reads stop.
gov = { ...gov, killswitch: killswitchTrip(gov.killswitch) };
line('after HALT: read the page', decide({ kind: 'read', effectiveOrigin: 'docs.example', provenance: 'user' }));

// ── audit chain is tamper-evident — DEMONSTRATED, not asserted ─────────────────
//
// ⚑ This step used to be one verifyChain() call on an untouched ledger, printing
// "chain VERIFIED ✓". Nothing was ever tampered with, so the ✓ meant only that append()
// and verifyChain() agree about a log neither had reason to disagree about — and a
// verifyChain that did nothing but `return { ok: true }` would have printed exactly the
// same line. Tamper-evidence is a claim about what happens WHEN the log is edited, so the
// demo now edits it: the only honest way to show a detector works is to make it fire.
const chain = verifyChain(ledger.entries, { verify, pubkey: null });
console.log(`\n  audit ledger: ${ledger.entries.length} signed entries · intact chain ${chain.ok ? 'VERIFIED ✓' : 'BROKEN ✗ @' + chain.brokenAt}`);

const clone = () => ledger.entries.map(e => JSON.parse(JSON.stringify(e)));
const capBlock = ledger.entries.findIndex(e => e.payload.verdict && String(e.payload.verdict.reason || '').startsWith('cap:'));

// attack 1 — restate the over-cap block as an allow, and change nothing else. This is the
// edit someone hiding an action would make. Both layers catch it, at different places and
// for different reasons: the edited entry no longer matches its own signature, and even
// unsigned its hash has moved, so the FOLLOWING entry's prev_hash stops lining up. The
// two indices differ by one, which is the linkage saying where the log was cut.
const edited = clone();
edited[capBlock].payload.verdict = { class: 'allow', reason: 'within_cap' };
const t1link = verifyChain(edited);
const t1 = verifyChain(edited, { verify, pubkey: null });
console.log(`  attack 1 · rewrite the £60 block as an allow       → linkage ${t1link.ok ? 'MISSED ✗' : `caught @${t1link.brokenAt}`} · signatures ${t1.ok ? 'MISSED ✗' : `CAUGHT ✓ @${t1.brokenAt} (${t1.reason})`}`);

// attack 2 — the same edit, but the forger also re-hashes the whole tail so every
// prev_hash lines up again. Linkage alone cannot see this; envelope.mjs says so in its own
// header. What stops it is the signature, which cannot be recomputed without the user key
// the agent never holds — so the rewritten entry authenticates as nothing.
const rewritten = clone();
rewritten[capBlock].payload.verdict = { class: 'allow', reason: 'within_cap' };
let prev = null;
for (const e of rewritten) { e.prev_hash = prev; prev = fnv1a(canonicalJSON(e)); }
const linkOnly = verifyChain(rewritten);                                   // no key: linkage only
const withSig = verifyChain(rewritten, { verify, pubkey: null });           // key: signatures too
console.log(`  attack 2 · same edit, whole tail re-hashed         → linkage alone ${linkOnly.ok ? 'MISSED ✗ (honest limit)' : 'caught'} · signatures ${withSig.ok ? 'MISSED ✗' : `CAUGHT ✓ @${withSig.brokenAt} (${withSig.reason})`}`);

const tamperEvident = chain.ok && !t1.ok && !t1link.ok && !withSig.ok;
console.log(`  spend booked: ${money(gov.spend.global_total)} of ${money(gov.spend.global_cap)} global cap`);

// ── PART 2 — the money ─────────────────────────────────────────────────────────
console.log('\n\x1b[1mPART 2 — the SaaS-AI tax it collapses\x1b[0m\n');
const APPS = [
  ['Notion AI', 2000], ['CRM AI add-on', 2500], ['Email AI', 1500], ['Design tool AI', 2000],
  ['Support-desk AI', 1900], ['Docs AI', 1000], ['Analytics AI', 2400], ['Meeting-notes AI', 1600],
  ['Social scheduler AI', 1500], ['Spreadsheet AI', 1000], ['PM tool AI', 1800], ['Code assistant', 1900],
];
const siloedMonthly = APPS.reduce((s, [, p]) => s + p, 0);
const sovereignMonthly = 2000;                                      // one owned agent
for (const [name, p] of APPS) console.log(`  · ${name.padEnd(22)} ${money(p)}/mo`);
console.log('  ' + '─'.repeat(40));
console.log(`  siloed (rent AI in every app):   ${money(siloedMonthly)}/mo   ${money(siloedMonthly * 12)}/yr`);
console.log(`  sovereign (one owned agent):     ${money(sovereignMonthly)}/mo   ${money(sovereignMonthly * 12)}/yr`);
const savedYr = (siloedMonthly - sovereignMonthly) * 12;
console.log(`\n  \x1b[1msaved: ${money(savedYr)}/yr  ·  ${(siloedMonthly / sovereignMonthly).toFixed(1)}× cheaper\x1b[0m`);
console.log('  (keep the apps — you just stop renting their bolted-on AI)\n');

// CI runs this demo. It fails if the intact chain does not verify AND if either attack
// goes undetected — a detector that stops detecting has to break the build, not print a ✓.
if (!tamperEvident) {
  console.error('  audit chain is not tamper-evident — a forged ledger passed verification');
  process.exit(1);
}
