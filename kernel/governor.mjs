// governor.mjs — THE GOVERNOR. Pure, total, mutation-tested safety kernel.
//
// It sits between the agent's INTENT to act and the real synthetic event. Every
// proposed action gets one verdict — allow | confirm | block — as a deterministic
// function of (bridge-observed action, per-site perms, running spend, killswitch).
// No I/O, no clock, no crypto side effects: the bridge injects `now` and the
// observed facts; that purity is exactly what lets `witness` prove it.
//
// THE ONE IDEA that makes it injection-proof: the verdict class is derived from
// the BRIDGE-OBSERVED event (what control was actually hit, what field, what
// amount), NEVER from the agent's declared label. A prompt-injected agent can
// want to act; it cannot relabel a purchase as a scroll to dodge the gate.
//
// Design synthesized from a 3-lens threat-model panel (security / estate-doctrine
// / product). Invariant tags (I1..I25) below map to test names in test/.

import { canonicalJSON, fnv1a } from './envelope.mjs';

// ── the class lattice: allow < confirm < block; tighten = max (most-restrictive) ─
export const CLASS = Object.freeze({ allow: 0, confirm: 1, block: 2 });
const NAME = ['allow', 'confirm', 'block'];
const tighten = (a, b) => Math.max(a, b);          // I1: stages may only HOLD or LOWER (never loosen)

// ── the kind table: bridge-derived semantic kind → intrinsic class + shape ──────
// PROHIBITED kinds are terminal block — no perm/token/cap/authorization reaches them (I4).
const PROHIBITED = new Set([
  'credential_entry', 'fund_movement', 'captcha_solve', 'permanent_delete',
  'security_setting', 'execute_download', 'self_escalation',
]);
const KINDS = Object.freeze({
  // observe / navigate — the ~90% that must flow
  read:              { cls: CLASS.allow,   wl: 0 },
  navigate_same:     { cls: CLASS.allow,   wl: 0 },
  click_link:        { cls: CLASS.allow,   wl: 0 },
  type_normal:       { cls: CLASS.allow,   wl: 1 },
  submit_search:     { cls: CLASS.allow,   wl: 1 },
  // the confirm line — consequential, never auto-fires
  navigate_cross:    { cls: CLASS.confirm, wl: 0 },
  submit_write:      { cls: CLASS.confirm, wl: 1 },
  send_message:      { cls: CLASS.confirm, wl: 1 },
  purchase:          { cls: CLASS.confirm, wl: 1, spend: true },
  delete_recoverable:{ cls: CLASS.confirm, wl: 1 },
  cross_site_move:   { cls: CLASS.confirm, wl: 1 },
  oauth_grant:       { cls: CLASS.confirm, wl: 1 },
  settings_change:   { cls: CLASS.confirm, wl: 1 },
  download_file:     { cls: CLASS.confirm, wl: 1 },
  upload_file:       { cls: CLASS.confirm, wl: 1 },
  // terminal block — prohibited categories
  credential_entry:  { cls: CLASS.block,   wl: 1 },
  fund_movement:     { cls: CLASS.block,   wl: 1 },
  captcha_solve:     { cls: CLASS.block,   wl: 1 },
  permanent_delete:  { cls: CLASS.block,   wl: 1 },
  security_setting:  { cls: CLASS.block,   wl: 1 },
  execute_download:  { cls: CLASS.block,   wl: 1 },
  self_escalation:   { cls: CLASS.block,   wl: 1 },
});

// ── classifyField: sensitivity from OBSERVED input semantics, not the label ─────
export function classifyField(attrs = {}) {
  const a = attrs || {};
  const auto = String(a.autocomplete || '').toLowerCase();
  const name = String(a.name || '').toLowerCase();
  const type = String(a.type || '').toLowerCase();   // HTML type is case-insensitive; normalize it too
  if (type === 'password' || auto.includes('current-password') || auto.includes('new-password')) return 'credential';
  if (auto.includes('one-time-code') || name.includes('otp') || name.includes('2fa')) return 'otp';
  if (auto.startsWith('cc-') || name.includes('card') || name.includes('cvc') || name.includes('cvv')) return 'payment';
  if (name.includes('ssn') || name.includes('sortcode') || name.includes('iban') || name.includes('routing')) return 'pii';
  return 'normal';
}
const SENSITIVE_FIELD = new Set(['credential', 'otp', 'payment', 'pii']);

// ── classifyAction: the anti-mislabel core. Derives everything from OBSERVED. ───
// `observed` are bridge-resolved FACTS (what event, what control, what origin,
// what field, what amount). `proposal.agentLabel` is deliberately never read here.
export function classifyAction(observed = {}) {
  const o = observed || {};
  let kind = typeof o.kind === 'string' && KINDS[o.kind] ? o.kind : null;
  // cost is a bridge-observed fact; sanitize to a finite number or undefined so a
  // hostile BigInt/NaN can neither reach the hasher (I24) nor loosen the cap (I15).
  const cost = (typeof o.cost === 'number' && Number.isFinite(o.cost)) ? o.cost : undefined;

  // ANY write (write_level >= 1) into a sensitive field is credential entry, no matter
  // what kind the bridge heuristically labeled it — type_normal, submit_write, OR
  // submit_search all collapse to the prohibited terminal block (I3/I4).
  if (kind !== null && KINDS[kind].wl >= 1 && SENSITIVE_FIELD.has(classifyField(o.field)))
    kind = 'credential_entry';

  if (kind === null) {                              // unrecognized/ambiguous => most-restrictive (I3, I24)
    return { kind: 'unknown', intrinsicClass: CLASS.block, write_level: 1,
             effectiveOrigin: o.effectiveOrigin || null, spend: false,
             cost, currency: o.currency, provenance: o.provenance === 'user' ? 'user' : 'observed_content',
             isCrossSite: !!o.isCrossSite, reason: 'unrecognized action' };
  }
  const spec = KINDS[kind];
  return {
    kind,
    intrinsicClass: spec.cls,
    write_level: spec.wl,
    spend: !!spec.spend,
    effectiveOrigin: o.effectiveOrigin || null,     // I12: origin of the element ACTED ON (bridge-computed)
    cost, currency: o.currency,
    provenance: o.provenance === 'user' ? 'user' : 'observed_content',
    isCrossSite: !!o.isCrossSite,
  };
}

// ── lookupPerm: deny-by-default, exact registrable-domain match (I2, I12) ───────
export function lookupPerm(permTable = {}, origin) {
  if (!origin || typeof origin !== 'string') return 'off';
  const p = permTable[origin];
  return (p === 'read' || p === 'act') ? p : 'off';   // unknown / anything else => off
}

// ── provenance bump: tighten one step if cross-site or from observed content ────
export function applyProvenanceBump(cls, provenance, isCrossSite) {
  if ((provenance !== 'user' || isCrossSite) && cls === CLASS.allow) return CLASS.confirm;  // can only tighten (I5-adjacent)
  return cls;
}

// ── checkCap: integer minor units, inclusive ceiling, fail-closed (I13/14/15) ───
export function checkCap(spend, origin, cost, currency) {
  spend = spend || {};                             // I24: total on garbage input
  const capCur = spend.currency;
  if (currency !== capCur) return { pass: false, reason: 'currency_mismatch' };            // I15: never coerce
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)                       // I15: unbounded/ambiguous
    return { pass: false, reason: 'amount_unbounded' };
  // I14/I15 fail-closed: a missing OR non-numeric cap/total is 0, never "unbounded".
  // A present-but-capless entry ({total:5}) previously left siteCap=undefined, and
  // `x > undefined` is NaN-false — so the ceiling silently vanished. Number.isFinite closes it.
  const site = spend.per_site && spend.per_site[origin];
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
  const siteCap = site ? num(site.cap) : 0;
  const siteTotal = site ? num(site.total) : 0;
  const projSite = siteTotal + cost;
  const projGlobal = num(spend.global_total) + cost;
  if (projSite > siteCap) return { pass: false, reason: 'per_site_cap_exceeded' };          // I13: inclusive (== ok, > block)
  if (projGlobal > (spend.global_cap || 0)) return { pass: false, reason: 'global_cap_exceeded' };
  return { pass: true, reason: 'within_cap' };
}

// ── the kappa gate: a confirm becomes allow ONLY with a matching consent that the
//    USER granted out of band, recorded in HOST-CONTROLLED STATE. ────────────────
//
// This is the anti-forgery core, corrected after review: the consent does NOT ride
// in the agent-supplied proposal (an agent can compute any hash and epoch, so a
// proposal-borne token is forgeable). Instead it lives in state.consents, keyed by
// the exact payload hash. The agent cannot write state, so it cannot fabricate a
// consent — only grantConsent() (a user-only, control-plane call from the side panel)
// can. The kernel owns the CHECK; the control plane owns the GRANT (I5/I10/I25).
export function payloadHash(actionPayload) { return fnv1a(canonicalJSON(actionPayload)); }

export function validateConsent(consent, state, now) {
  if (!consent || typeof consent !== 'object') return false;
  const ks = state.killswitch || { killEpoch: 0 };
  if (consent.killEpoch !== ks.killEpoch) return false;               // halt bumped epoch => stale (I10)
  if (consent.permsEpoch !== (state.permsEpoch || 0)) return false;   // perm change => stale (TOCTOU)
  if (!(Number.isFinite(now) && now < consent.exp)) return false;     // missing/garbage clock => fail closed
  if (state.consumedTokens && state.consumedTokens.includes(consent.id)) return false;  // single-use
  return true;
}

// ── verdict: THE decision. killswitch > class > prohibited > perm > provenance >
//    cap > kappa, monotone-descent, most-restrictive-wins, total (default block). ─
// `now` has NO default: a caller that forgets to inject the clock must fail closed
// on the TTL check, not silently treat every consent as fresh.
export function verdict(proposal, state, now) {
  proposal = proposal || {};                       // I24: total — null in, well-formed block out
  state = state || {};
  const ks = state.killswitch || { state: 'DISARMED', killEpoch: 0 };
  const block = (reason) => ({ class: NAME[CLASS.block], reason });

  // (1) KILLSWITCH — stage 1, dominates everything (I7). Halted => total freeze.
  if (ks.state !== 'ARMED') return block(`halted:${ks.state}`);

  // (2) CLASS FROM OBSERVED EVENT, not the agent label (I3)
  const d = classifyAction(proposal.observed);
  let cls = d.intrinsicClass;

  // (3) PROHIBITED CATEGORY — terminal, nothing below can lift it (I4)
  if (PROHIBITED.has(d.kind)) return block(`prohibited:${d.kind}`);

  // (4) PER-SITE PERM composed with write_level (I2, I6)
  const perm = lookupPerm(state.permTable, d.effectiveOrigin);
  if (perm === 'off') return block(`site_off:${d.effectiveOrigin || 'null'}`);
  if (perm === 'read' && d.write_level >= 1) return block('read_only_site');
  // perm === 'act' removes the site block only; it never upgrades class

  // (5) PROVENANCE / CROSS-SITE bump (tighten only)
  cls = tighten(cls, applyProvenanceBump(cls, d.provenance, d.isCrossSite));

  // (6) CAP GATE — spend actions only; a cap breach outranks confirm (I13)
  if (d.spend) {
    const cap = checkCap(state.spend || {}, d.effectiveOrigin, d.cost, d.currency);
    if (!cap.pass) return block(`cap:${cap.reason}`);
  }

  // (7) KAPPA GATE — a surviving confirm needs a matching user-granted consent that
  //     lives in HOST-CONTROLLED state, not in the agent's proposal (I5/I25).
  if (cls === CLASS.confirm) {
    const hash = payloadHash({ kind: d.kind, origin: d.effectiveOrigin, cost: d.cost, currency: d.currency });
    const consent = (state.consents || {})[hash];
    if (validateConsent(consent, state, now))
      return { class: NAME[CLASS.allow], reason: 'confirmed' };
    return { class: NAME[CLASS.confirm], reason: `awaiting_consent:${d.kind}` };
  }
  return { class: NAME[cls], reason: cls === CLASS.allow ? `allow:${d.kind}` : `blocked:${d.kind}` };
}

// ── spend accumulator: reserve-before-token, so concurrent buys can't both slip ─
export function reserveSpend(spend, seq, origin, amount) {
  const per = { ...(spend.per_site || {}) };
  const site = per[origin] || { cap: 0, total: 0 };
  per[origin] = { ...site, total: site.total + amount };
  return { ...spend, global_total: (spend.global_total || 0) + amount,
           per_site: per, reservations: { ...(spend.reservations || {}), [seq]: { origin, amount } } };
}
export function commitSpend(spend, seq) {                 // idempotent per seq (I16)
  const r = (spend.reservations || {})[seq];
  if (!r) return spend;
  const reservations = { ...(spend.reservations || {}) }; delete reservations[seq];
  const committed = { ...(spend.committed || {}), [seq]: r };
  return { ...spend, reservations, committed };
}
export function releaseSpend(spend, seq) {
  const r = (spend.reservations || {})[seq];
  if (!r) return spend;
  const per = { ...(spend.per_site || {}) };
  const site = per[r.origin] || { cap: 0, total: 0 };
  per[r.origin] = { ...site, total: site.total - r.amount };
  const reservations = { ...(spend.reservations || {}) }; delete reservations[seq];
  return { ...spend, global_total: (spend.global_total || 0) - r.amount, per_site: per, reservations };
}

// ── killswitch: user-only control plane. NEVER invoked from verdict() (I8/I25). ─
export function killswitchTrip(ks, reason = 'user_halt') {   // legal from any state, idempotent
  return { state: 'HALTED', killEpoch: (ks.killEpoch || 0) + 1, reason };
}
export function killswitchRearm(ks, userNonce) {             // HALTED->ARMED only, strictly-greater nonce (I9)
  if (ks.state !== 'HALTED') return ks;
  if (typeof userNonce !== 'number' || userNonce <= (ks.killEpoch || 0)) return ks;  // reject stale/equal replay
  return { state: 'ARMED', killEpoch: userNonce, reason: 'user_rearm' };
}

// ── perm change: user-only control plane; bumps permsEpoch (defeats TOCTOU) ──────
export function applyPermChange(state, origin, perm) {
  const permTable = { ...(state.permTable || {}) };
  if (perm === 'off') delete permTable[origin]; else permTable[origin] = perm;
  return { ...state, permTable, permsEpoch: (state.permsEpoch || 0) + 1 };
}

// ── consent: user-only control plane. grantConsent is the ONLY way a confirm can
//    ever become allow, and it is reachable only from the side panel (the user),
//    never from the verdict/action path — so the agent cannot mint its own (I25). ─
export function grantConsent(state, hash, id, exp) {
  const ks = state.killswitch || { killEpoch: 0 };
  const consents = { ...(state.consents || {}),
    [hash]: { id, killEpoch: ks.killEpoch, permsEpoch: state.permsEpoch || 0, exp } };
  return { ...state, consents };
}
export function consumeConsent(state, hash) {                 // single-use: gone after one redemption
  const consents = { ...(state.consents || {}) };
  const c = consents[hash];
  delete consents[hash];
  const consumedTokens = c ? [...(state.consumedTokens || []), c.id] : (state.consumedTokens || []);
  return { ...state, consents, consumedTokens };
}

// initial governor state — DISARMED until the user arms it this session
export function initState({ permTable = {}, currency = 'GBP', globalCap = 0 } = {}) {
  return {
    permTable, permsEpoch: 0,
    killswitch: { state: 'DISARMED', killEpoch: 0 },
    spend: { currency, global_cap: globalCap, global_total: 0, per_site: {}, reservations: {}, committed: {} },
    consents: {},
    consumedTokens: [],
  };
}
