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
import { AuditLedger, verifyChain } from '../kernel/envelope.mjs';

const money = (p) => '£' + (p / 100).toFixed(2);
let clock = 1_700_000_000_000;
const now = () => (clock += 1000);

// ── set up a governed session: arm, grant per-site rights + caps ───────────────
let gov = initState({ currency: 'GBP', globalCap: 20000 });        // £200 global cap
gov = { ...gov, killswitch: { state: 'ARMED', killEpoch: 1 } };     // user arms the agent
gov = applyPermChange(gov, 'docs.example', 'act');                  // full act on the docs app
gov = applyPermChange(gov, 'shop.example', 'act');                  // full act on the shop
gov = applyPermChange(gov, 'news.example', 'read');                 // read-only on the news site
gov = { ...gov, spend: { ...gov.spend, per_site: { 'shop.example': { cap: 5000, total: 0 } } } };  // £50 shop cap

const ledger = new AuditLedger();
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

// a prompt-injected agent tries to relabel a purchase as a harmless scroll.
line('injected: purchase mislabeled "scroll"', decide({ kind: 'purchase', effectiveOrigin: 'shop.example', provenance: 'observed_content', cost: 999, currency: 'GBP' }));

// user hits the kill-switch; the agent freezes — even reads stop.
gov = { ...gov, killswitch: killswitchTrip(gov.killswitch) };
line('after HALT: read the page', decide({ kind: 'read', effectiveOrigin: 'docs.example', provenance: 'user' }));

// ── audit chain is tamper-evident ──────────────────────────────────────────────
const chain = verifyChain(ledger.entries);
console.log(`\n  audit ledger: ${ledger.entries.length} signed entries · chain ${chain.ok ? 'VERIFIED ✓' : 'BROKEN ✗ @' + chain.brokenAt}`);
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

if (!chain.ok) process.exit(1);
