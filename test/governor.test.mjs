// governor.test.mjs — the Governor's safety proof, one test per invariant (I1..I25),
// plus full branch coverage so the mutation gate (npm run gate) has purchase on every
// decision point. Characterization + boundary style: exact verdicts at and around each
// threshold, so a flipped operator changes a verdict a test is watching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verdict, classifyAction, classifyField, lookupPerm, applyProvenanceBump, checkCap,
  payloadHash, validateConsent, grantConsent, consumeConsent, reserveSpend, commitSpend, releaseSpend,
  killswitchTrip, killswitchRearm, applyPermChange, initState, CLASS,
} from '../kernel/governor.mjs';

// armed state: shop.example may act (£50 site cap), read.example is read-only, £100 global cap
function S(over = {}) {
  return {
    permTable: { 'shop.example': 'act', 'read.example': 'read' },
    permsEpoch: 3,
    killswitch: { state: 'ARMED', killEpoch: 7 },
    spend: { currency: 'GBP', global_cap: 10000, global_total: 0,
             per_site: { 'shop.example': { cap: 5000, total: 0 } }, reservations: {}, committed: {} },
    consents: {}, consumedTokens: [],
    ...over,
  };
}
const OBS = (o) => ({ effectiveOrigin: 'shop.example', provenance: 'user', ...o });
const cls = (v) => v.class;

// the payload hash the kappa gate keys on for a given observed action
function hashOf(observed) {
  const d = classifyAction(observed);
  return payloadHash({ kind: d.kind, origin: d.effectiveOrigin, cost: d.cost, currency: d.currency });
}
// record a USER consent for `observed` into host-controlled state (what the side panel does)
function grant(st, observed, { exp = 100, id = 'c1' } = {}) {
  return grantConsent(st, hashOf(observed), id, exp);
}

// ── I7 HALT-DOMINANCE ─────────────────────────────────────────────────────────
test('I7 halted state blocks even a benign read (stage 1 dominates)', () => {
  const st = S({ killswitch: { state: 'HALTED', killEpoch: 8 } });
  assert.equal(cls(verdict({ observed: OBS({ kind: 'read' }) }, st, 0)), 'block');
});
test('I7 disarmed state blocks everything', () => {
  const st = S({ killswitch: { state: 'DISARMED', killEpoch: 0 } });
  assert.equal(cls(verdict({ observed: OBS({ kind: 'read' }) }, st, 0)), 'block');
});

// ── I2 DENY-BY-DEFAULT ────────────────────────────────────────────────────────
test('I2 unknown origin is off => block, including reads', () => {
  assert.equal(cls(verdict({ observed: OBS({ kind: 'read', effectiveOrigin: 'nowhere.example' }) }, S(), 0)), 'block');
});
test('I2 read allowed on a read-granted site', () => {
  assert.equal(cls(verdict({ observed: OBS({ kind: 'read', effectiveOrigin: 'read.example' }) }, S(), 0)), 'allow');
});

// ── I6 READ-SEALS-WRITES ──────────────────────────────────────────────────────
test('I6 a write on a read-only site is blocked', () => {
  const v = verdict({ observed: OBS({ kind: 'type_normal', effectiveOrigin: 'read.example' }) }, S(), 0);
  assert.equal(cls(v), 'block');
  assert.match(v.reason, /read_only_site/);
});
test('I6 the same write flows on an act site', () => {
  assert.equal(cls(verdict({ observed: OBS({ kind: 'type_normal' }) }, S(), 0)), 'allow');
});

// ── I3 CLASS-FROM-EVENT-NOT-LABEL ─────────────────────────────────────────────
test('I3 a purchase mislabeled read_dom is still gated as a purchase', () => {
  const observed = OBS({ kind: 'purchase', cost: 1000, currency: 'GBP' });
  const v = verdict({ agentLabel: 'read_dom', observed }, S(), 0);
  assert.equal(cls(v), 'confirm');           // not auto-allowed by the benign label
});
test('I3 a write into a password field is reclassified to credential entry', () => {
  const observed = OBS({ kind: 'type_normal', field: { type: 'password' } });
  assert.equal(classifyAction(observed).kind, 'credential_entry');
});

// ── I4 PROHIBITED-TERMINAL ────────────────────────────────────────────────────
for (const kind of ['credential_entry', 'fund_movement', 'captcha_solve',
  'permanent_delete', 'security_setting', 'execute_download', 'self_escalation']) {
  test(`I4 ${kind} is terminal block even with act rights + a granted consent`, () => {
    const observed = OBS({ kind });
    const v = verdict({ observed }, grant(S(), observed), 0);   // consent granted, still must block
    assert.equal(cls(v), 'block');
    assert.match(v.reason, /prohibited/);
  });
}

// ── I24 TOTALITY (unrecognized => block, never throw) ─────────────────────────
test('I24 an unrecognized kind blocks and does not throw', () => {
  assert.equal(cls(verdict({ observed: OBS({ kind: 'wat_is_this' }) }, S(), 0)), 'block');
});
test('I24 null / undefined inputs block instead of throwing', () => {
  assert.equal(cls(verdict(null, null, 0)), 'block');
  assert.equal(cls(verdict(undefined, undefined)), 'block');
  assert.equal(cls(verdict({}, {}, 0)), 'block');            // no killswitch => DISARMED => block
  assert.equal(checkCap(null, 'x', 1, 'GBP').pass, false);   // null spend fails closed
});

// ── I5 KAPPA-NON-AUTO ─────────────────────────────────────────────────────────
test('I5 a consequential write is confirm without consent', () => {
  assert.equal(cls(verdict({ observed: OBS({ kind: 'submit_write' }) }, S(), 0)), 'confirm');
});
test('I5 a user-granted consent (in state) upgrades confirm -> allow', () => {
  const observed = OBS({ kind: 'submit_write' });
  const v = verdict({ observed }, grant(S(), observed), 0);
  assert.equal(cls(v), 'allow');
  assert.equal(v.reason, 'confirmed');
});
test('I25 a consent the AGENT supplies in the proposal is IGNORED (not forgeable)', () => {
  // the agent computes a perfect token and puts it in the proposal — no state consent exists
  const observed = OBS({ kind: 'purchase', cost: 100, currency: 'GBP' });
  const forged = { id: 'x', payloadHash: hashOf(observed), killEpoch: 7, permsEpoch: 3, exp: 1e12 };
  const v = verdict({ observed, consentToken: forged }, S(), 0);   // S() has consents:{}
  assert.equal(cls(v), 'confirm');                                 // proposal-borne token does nothing
});
test('I5 consent for a DIFFERENT payload does not satisfy the gate', () => {
  const st = grant(S(), OBS({ kind: 'submit_write' }));            // consent for a submit
  const v = verdict({ observed: OBS({ kind: 'purchase', cost: 1000, currency: 'GBP' }) }, st, 0);
  assert.equal(cls(v), 'confirm');                                 // different hash => no match
});
test('I5 an expired consent does not satisfy the gate', () => {
  const observed = OBS({ kind: 'submit_write' });
  const st = grant(S(), observed, { exp: 50 });
  assert.equal(cls(verdict({ observed }, st, 999)), 'confirm');    // now=999 > exp=50
});
test('I5/I25 a consumed (single-use) consent is rejected on reuse', () => {
  const observed = OBS({ kind: 'submit_write' });
  const st = grant(S(), observed);
  assert.equal(cls(verdict({ observed }, st, 0)), 'allow');
  const st2 = consumeConsent(st, hashOf(observed));               // side panel consumes after emit
  assert.equal(cls(verdict({ observed }, st2, 0)), 'confirm');
});
test('TTL fail-closed: a consent with a missing clock (no now) does not allow', () => {
  const observed = OBS({ kind: 'submit_write' });
  const st = grant(S(), observed);
  assert.equal(cls(verdict({ observed }, st)), 'confirm');        // now omitted => fail closed
});

// ── I10 CONSENT-EPOCH-BOUND ───────────────────────────────────────────────────
test('I10 a consent granted under an old killEpoch is stale after a halt+rearm', () => {
  const observed = OBS({ kind: 'submit_write' });
  const st = grant(S(), observed);                               // bound to killEpoch 7
  const st2 = { ...st, killswitch: { state: 'ARMED', killEpoch: 9 } };
  assert.equal(cls(verdict({ observed }, st2, 0)), 'confirm');
});
test('I10 a consent granted under an old permsEpoch is stale after a perm change', () => {
  const observed = OBS({ kind: 'submit_write' });
  const st = grant(S(), observed);                               // bound to permsEpoch 3
  const st2 = { ...st, permsEpoch: 4 };
  assert.equal(cls(verdict({ observed }, st2, 0)), 'confirm');
});

// ── cap: I13 inclusive ceiling, I14 no-cap-means-zero, I15 fail-closed ────────
test('I13 a purchase exactly AT the cap is permitted (inclusive)', () => {
  const observed = OBS({ kind: 'purchase', cost: 5000, currency: 'GBP' });
  assert.equal(cls(verdict({ observed }, grant(S(), observed), 0)), 'allow');
});
test('I13 one penny over the cap is blocked', () => {
  const observed = OBS({ kind: 'purchase', cost: 5001, currency: 'GBP' });
  const v = verdict({ observed }, grant(S(), observed), 0);
  assert.equal(cls(v), 'block');
  assert.match(v.reason, /cap/);
});
test('I13 global cap binds even when the per-site cap has room', () => {
  const observed = OBS({ kind: 'purchase', cost: 6000, currency: 'GBP', effectiveOrigin: 'shop.example' });
  const st = S({ spend: { currency: 'GBP', global_cap: 4000, global_total: 0,
    per_site: { 'shop.example': { cap: 9000, total: 0 } }, reservations: {}, committed: {} } });
  assert.equal(cls(verdict({ observed }, grant(st, observed), 0)), 'block');
});
test('I14 a purchase on a site with no per-site cap is blocked (cap defaults 0)', () => {
  const base = S({ permTable: { 'newshop.example': 'act' } });
  const observed = OBS({ kind: 'purchase', cost: 100, currency: 'GBP', effectiveOrigin: 'newshop.example' });
  assert.equal(cls(verdict({ observed }, grant(base, observed), 0)), 'block');
});
test('I14 a per-site entry present but with NO numeric cap fails closed (not unlimited)', () => {
  // regression: {total:0} left siteCap=undefined and `x > undefined` silently passed
  assert.equal(checkCap({ currency: 'GBP', global_cap: 1e6, global_total: 0,
    per_site: { 'shop.example': { total: 0 } } }, 'shop.example', 100, 'GBP').pass, false);
  // and a missing `total` must not let cost sail past via NaN
  assert.equal(checkCap({ currency: 'GBP', global_cap: 1e6, global_total: 0,
    per_site: { 'shop.example': { cap: 5000 } } }, 'shop.example', 6000, 'GBP').pass, false);
});
test('I15 a mismatched currency is blocked, never coerced', () => {
  assert.equal(checkCap(S().spend, 'shop.example', 100, 'USD').pass, false);
});
test('I15 an unbounded/ambiguous amount fails closed', () => {
  assert.equal(checkCap(S().spend, 'shop.example', Infinity, 'GBP').pass, false);
  assert.equal(checkCap(S().spend, 'shop.example', undefined, 'GBP').pass, false);
});

// ── provenance bump (cross-site / observed-content) ───────────────────────────
test('a click_link whose target came from observed content is bumped to confirm', () => {
  const v = verdict({ observed: OBS({ kind: 'click_link', provenance: 'observed_content' }) }, S(), 0);
  assert.equal(cls(v), 'confirm');
});
test('a cross-site read is bumped to confirm (off-domain caution)', () => {
  const v = verdict({ observed: OBS({ kind: 'read', isCrossSite: true }) }, S(), 0);
  assert.equal(cls(v), 'confirm');
});
test('navigate_cross is confirm on its own', () => {
  assert.equal(cls(verdict({ observed: OBS({ kind: 'navigate_cross' }) }, S(), 0)), 'confirm');
});

// ── I12 EFFECTIVE-ORIGIN: exact registrable-domain, no subdomain inheritance ──
test('I12 a subdomain of a granted site does NOT inherit the grant', () => {
  assert.equal(lookupPerm({ 'shop.example': 'act' }, 'evil.shop.example'), 'off');
});
test('lookupPerm returns off for null/garbage origin', () => {
  assert.equal(lookupPerm({}, null), 'off');
  assert.equal(lookupPerm({}, 42), 'off');
});

// ── killswitch state machine: I8/I9 ───────────────────────────────────────────
test('killswitchTrip halts from ARMED and bumps the epoch', () => {
  const ks = killswitchTrip({ state: 'ARMED', killEpoch: 7 });
  assert.equal(ks.state, 'HALTED');
  assert.equal(ks.killEpoch, 8);
});
test('killswitchTrip is legal and idempotent-forward from any state', () => {
  assert.equal(killswitchTrip({ state: 'HALTED', killEpoch: 2 }).state, 'HALTED');
  assert.equal(killswitchTrip({ state: 'HALTED', killEpoch: 2 }).killEpoch, 3);
});
test('I9 rearm needs a strictly-greater nonce; stale/equal is rejected', () => {
  const halted = { state: 'HALTED', killEpoch: 5 };
  assert.equal(killswitchRearm(halted, 6).state, 'ARMED');   // 6 > 5 ok
  assert.equal(killswitchRearm(halted, 5).state, 'HALTED');  // equal rejected
  assert.equal(killswitchRearm(halted, 4).state, 'HALTED');  // stale rejected
});
test('rearm from ARMED is a no-op (only HALTED->ARMED)', () => {
  assert.equal(killswitchRearm({ state: 'ARMED', killEpoch: 5 }, 99).state, 'ARMED');
});

// ── spend accumulator: reserve / commit(idempotent) / release ─────────────────
test('reserveSpend books into both site and global totals', () => {
  const sp = reserveSpend(S().spend, 1, 'shop.example', 1200);
  assert.equal(sp.global_total, 1200);
  assert.equal(sp.per_site['shop.example'].total, 1200);
  assert.deepEqual(sp.reservations[1], { origin: 'shop.example', amount: 1200 });
});
test('I16 commitSpend is idempotent per seq (retry does not double count)', () => {
  let sp = reserveSpend(S().spend, 1, 'shop.example', 1200);
  sp = commitSpend(sp, 1);
  const once = sp.global_total;
  sp = commitSpend(sp, 1);   // retry
  assert.equal(sp.global_total, once);
  assert.ok(sp.committed[1]);
});
test('releaseSpend frees a reservation back to the budget', () => {
  let sp = reserveSpend(S().spend, 1, 'shop.example', 1200);
  sp = releaseSpend(sp, 1);
  assert.equal(sp.global_total, 0);
  assert.equal(sp.per_site['shop.example'].total, 0);
  assert.equal(sp.reservations[1], undefined);
});

// ── field classifier ─────────────────────────────────────────────────────────
test('classifyField reads sensitivity from observed semantics', () => {
  assert.equal(classifyField({ type: 'password' }), 'credential');
  assert.equal(classifyField({ autocomplete: 'one-time-code' }), 'otp');
  assert.equal(classifyField({ autocomplete: 'cc-number' }), 'payment');
  assert.equal(classifyField({ name: 'ssn' }), 'pii');
  assert.equal(classifyField({ type: 'text', name: 'query' }), 'normal');
});

// ── I8 self-escalation is not agent-addressable (proposed => block) ───────────
test('I8 an agent-proposed self-escalation is blocked', () => {
  assert.equal(cls(verdict({ observed: OBS({ kind: 'self_escalation' }) }, S(), 0)), 'block');
});

// ── applyPermChange bumps permsEpoch (control-plane only) ─────────────────────
test('applyPermChange grants a site and bumps permsEpoch', () => {
  const st2 = applyPermChange(S(), 'new.example', 'act');
  assert.equal(st2.permTable['new.example'], 'act');
  assert.equal(st2.permsEpoch, 4);
});

// ── initState is disarmed until the user arms it ──────────────────────────────
test('initState starts DISARMED with deny-by-default everything', () => {
  const st = initState();
  assert.equal(st.killswitch.state, 'DISARMED');
  assert.equal(cls(verdict({ observed: OBS({ kind: 'read' }) }, st, 0)), 'block');
});

// ── gate hardening: every sensitive-field keyword must be detected on its own ──
// (each keyword is a separate OR arm; a single-keyword input proves that arm fires)
test('classifyField detects every credential/otp/payment/pii keyword', () => {
  for (const a of [{ type: 'password' }, { autocomplete: 'current-password' }, { autocomplete: 'new-password' }])
    assert.equal(classifyField(a), 'credential');
  for (const a of [{ autocomplete: 'one-time-code' }, { name: 'otp' }, { name: '2fa' }])
    assert.equal(classifyField(a), 'otp');
  for (const a of [{ autocomplete: 'cc-number' }, { name: 'card' }, { name: 'cvc' }, { name: 'cvv' }])
    assert.equal(classifyField(a), 'payment');
  for (const a of [{ name: 'ssn' }, { name: 'sortcode' }, { name: 'iban' }, { name: 'routing' }])
    assert.equal(classifyField(a), 'pii');
});

// ── classifyAction propagates the observed facts (not defaults) ───────────────
test('classifyAction carries the effective origin and provenance through', () => {
  const d = classifyAction({ kind: 'read', effectiveOrigin: 'shop.example', provenance: 'user' });
  assert.equal(d.effectiveOrigin, 'shop.example');   // known path: kills `o.effectiveOrigin || null`
  const u = classifyAction({ kind: 'nope', effectiveOrigin: 'x.example', provenance: 'user' });
  assert.equal(u.provenance, 'user');                // unknown path keeps a real provenance
  assert.equal(u.effectiveOrigin, 'x.example');      // unknown path also carries the origin
});
test('a sensitive field also traps a submit_write, not just a keystroke', () => {
  // exercises the second arm of the (type_normal || submit_write) reclassification
  assert.equal(classifyAction({ kind: 'submit_write', field: { type: 'password' } }).kind, 'credential_entry');
});
test('an allowed verdict reports an allow reason (not a blocked one)', () => {
  const v = verdict({ observed: OBS({ kind: 'read', effectiveOrigin: 'read.example' }) }, S(), 0);
  assert.equal(v.class, 'allow');
  assert.match(v.reason, /^allow:/);                 // kills the reason-string ternary flip
});

// ── checkCap: each guard arm + a nonzero running total ────────────────────────
test('checkCap fails closed on non-number, NaN, and negative costs', () => {
  const sp = { currency: 'GBP', global_cap: 9999, global_total: 0, per_site: { s: { cap: 9999, total: 0 } } };
  assert.equal(checkCap(sp, 's', '5', 'GBP').pass, false);       // string cost
  assert.equal(checkCap(sp, 's', NaN, 'GBP').pass, false);       // NaN
  assert.equal(checkCap(sp, 's', -100, 'GBP').pass, false);      // negative
  assert.equal(checkCap(sp, 's', 0, 'GBP').pass, true);          // a free (£0) item is allowed, not blocked
  assert.equal(checkCap(sp, 's', 100, 'GBP').pass, true);        // a real cost passes
});
test('checkCap adds the cost onto a NONZERO running total (global bucket)', () => {
  const sp = { currency: 'GBP', global_cap: 5000, global_total: 3000, per_site: { s: { cap: 9000, total: 0 } } };
  assert.equal(checkCap(sp, 's', 3000, 'GBP').pass, false);      // 3000+3000 > 5000
  assert.equal(checkCap(sp, 's', 2000, 'GBP').pass, true);       // 3000+2000 == 5000 (inclusive)
});

// ── validateConsent is total on garbage (never throws) ────────────────────────
test('validateConsent returns false (never throws) on null / non-object consents', () => {
  assert.equal(validateConsent(null, S(), 0), false);
  assert.equal(validateConsent('nope', S(), 0), false);
  assert.equal(validateConsent(42, S(), 0), false);
});
test('validateConsent TTL is exclusive: valid strictly before expiry, expired AT expiry', () => {
  const c = { id: 't', killEpoch: 7, permsEpoch: 3, exp: 100 };
  assert.equal(validateConsent(c, S(), 99), true);     // now < exp => valid
  assert.equal(validateConsent(c, S(), 100), false);   // now == exp => expired (kills < -> <=)
  assert.equal(validateConsent(c, S()), false);        // no now => fail closed (Number.isFinite)
});

// ── regressions for the adversarial-review findings ───────────────────────────
test('R1 a sensitive field traps EVERY write kind, not just type_normal (submit_search/submit_write)', () => {
  for (const kind of ['type_normal', 'submit_write', 'submit_search']) {
    const observed = OBS({ kind, field: { type: 'password' } });
    assert.equal(classifyAction(observed).kind, 'credential_entry', `${kind} must reclassify`);
    // and with a granted consent it STILL blocks (prohibited-terminal)
    assert.equal(cls(verdict({ observed }, grant(S(), observed), 0)), 'block');
  }
  // card / OTP / PII fields on an allow-class write also trap
  assert.equal(cls(verdict({ observed: OBS({ kind: 'submit_search', field: { autocomplete: 'cc-number' } }) }, S(), 0)), 'block');
});
test('R2 field type detection is case-insensitive (type: "Password")', () => {
  assert.equal(classifyField({ type: 'Password' }), 'credential');
  assert.equal(cls(verdict({ observed: OBS({ kind: 'type_normal', field: { type: 'PASSWORD' } }) }, S(), 0)), 'block');
});
test('R6 a hostile BigInt/NaN cost does not throw the Governor (I24 totality)', () => {
  // the crash was at payloadHash(canonicalJSON({...cost:1n})); with no consent it must
  // reach 'confirm' without throwing, and the BigInt must never reach the hasher or cap.
  assert.doesNotThrow(() => verdict({ observed: OBS({ kind: 'submit_write', cost: 1n }) }, S(), 0));
  assert.equal(cls(verdict({ observed: OBS({ kind: 'submit_write', cost: 1n }) }, S(), 0)), 'confirm');
  assert.equal(checkCap(S().spend, 'shop.example', 5n, 'GBP').pass, false);   // BigInt cost fails closed
});
test('R6 classifyAction sanitizes a non-finite cost to undefined', () => {
  assert.equal(classifyAction(OBS({ kind: 'purchase', cost: NaN })).cost, undefined);
  assert.equal(classifyAction(OBS({ kind: 'purchase', cost: Infinity })).cost, undefined);
  assert.equal(classifyAction(OBS({ kind: 'purchase', cost: 1n })).cost, undefined);
  assert.equal(classifyAction(OBS({ kind: 'purchase', cost: 250 })).cost, 250);   // a real cost survives
});
test('R3 checkCap treats a NaN cap/total as 0 (fail closed), not a bypass', () => {
  assert.equal(checkCap({ currency: 'GBP', global_cap: 1e6, global_total: 0,
    per_site: { 'shop.example': { cap: NaN, total: 0 } } }, 'shop.example', 100, 'GBP').pass, false);
  assert.equal(checkCap({ currency: 'GBP', global_cap: 1e6, global_total: 0,
    per_site: { 'shop.example': { cap: 5000, total: NaN } } }, 'shop.example', 6000, 'GBP').pass, false);
});

// ── spend accumulator actually accumulates onto pre-existing totals ───────────
test('reserveSpend accumulates onto existing site AND global totals', () => {
  const sp = { currency: 'GBP', global_cap: 99999, global_total: 500,
    per_site: { 'shop.example': { cap: 5000, total: 800 } }, reservations: {}, committed: {} };
  const r = reserveSpend(sp, 1, 'shop.example', 1200);
  assert.equal(r.global_total, 1700);                            // 500 + 1200
  assert.equal(r.per_site['shop.example'].total, 2000);          // 800 + 1200
});
test('reserveSpend preserves other reservations (no clobber)', () => {
  let sp = reserveSpend(S().spend, 1, 'shop.example', 100);
  sp = reserveSpend(sp, 2, 'shop.example', 200);
  assert.ok(sp.reservations[1] && sp.reservations[2]);           // both present
});
test('commitSpend preserves other reservations and prior commits', () => {
  let sp = reserveSpend(S().spend, 1, 'shop.example', 100);
  sp = reserveSpend(sp, 2, 'shop.example', 200);
  sp = commitSpend(sp, 1);
  assert.ok(sp.reservations[2]);                                 // seq2 reservation intact
  assert.ok(sp.committed[1]);
  sp = commitSpend(sp, 2);
  assert.ok(sp.committed[1] && sp.committed[2]);                 // both commits kept
});
test('releaseSpend preserves other reservations', () => {
  let sp = reserveSpend(S().spend, 1, 'shop.example', 100);
  sp = reserveSpend(sp, 2, 'shop.example', 200);
  sp = releaseSpend(sp, 1);
  assert.equal(sp.reservations[1], undefined);
  assert.ok(sp.reservations[2]);                                 // seq2 survives seq1's release
});
