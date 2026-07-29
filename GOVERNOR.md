# The Governor — threat model & design

The Governor is the safety kernel between the agent's *intent* to act and the real
synthetic event. It is pure and total: one deterministic `verdict(proposal, state, now)`
over `state = { permTable, permsEpoch, killswitch, spend, consumedTokens }`. This
spec was synthesized from a three-lens threat-model panel (security auditor /
estate-doctrine / product) and is enforced by the mutation-gated tests in `test/`.

## The one idea

**Class is derived from the bridge-observed event, never the agent's label.** A
prompt-injected agent can *want* to act; it cannot relabel a purchase as a scroll,
because `classifyAction()` reads what control was actually hit, what field, what
amount — from the DOM, not the agent's word. Everything else follows from this.

## The verdict rule (7 stages, monotone-descent, most-restrictive-wins)

Class lattice `allow ‹ confirm ‹ block`; every stage may only *hold or tighten*.

1. **killswitch** — evaluated first. `!= ARMED ⇒ block` for everything (even reads). Dominates all.
2. **event class** — `classifyAction()` derives kind + intrinsic class from observed facts, not the label.
3. **prohibited category** — credential entry / fund movement / captcha / permanent delete / security setting / execute download / self-escalation ⇒ terminal `block`. No confirm path.
4. **per-site perm** — deny-by-default, exact registrable-domain. `off ⇒ block` (incl. reads); `read ⇒ block` any write; `act` removes the site block only (never upgrades class).
5. **provenance bump** — cross-site, or a target sourced from observed page content, tightens one step (`allow → confirm`). Can only tighten.
6. **cap gate** (spend only) — inclusive ceiling, missing per-site cap = 0, unbounded/mismatched amount fails closed. A cap breach outranks confirm (you cannot confirm past a cap).
7. **kappa gate** — a surviving `confirm` becomes `allow` only when host-controlled state carries a matching user-granted consent, keyed by `H(exact payload)`, bound to the current killEpoch + permsEpoch + unexpired TTL, single-use. The consent lives in **state**, granted by the side panel (the user) — it does **not** ride in the agent-supplied proposal, so the agent cannot forge one (it cannot write state).

## Invariants (each maps to a test in `test/governor.test.mjs` / `envelope.test.mjs`)

| | invariant |
|---|---|
| I1 | MONOTONE-DESCENT — no stage loosens the class |
| I2 | DENY-BY-DEFAULT — an ungranted domain is `off ⇒ block`, including reads |
| I3 | CLASS-FROM-EVENT-NOT-LABEL — verdict derived from observed control, mislabel fails closed |
| I4 | PROHIBITED-TERMINAL — prohibited kinds block regardless of perm/token/cap/authorization |
| I5 | KAPPA-NON-AUTO — confirm→allow only with a single-use, payload-bound, epoch-bound, unexpired consent held in host state (not the agent's proposal) |
| I6 | READ-SEALS-WRITES — `read` perm blocks every write |
| I7 | HALT-DOMINANCE — killswitch checked first, forces block |
| I8 | AGENT-CANNOT-TOUCH-SWITCH — killswitch/perm/cap changes never reachable from the verdict path |
| I9 | RE-ARM-NEEDS-FRESH-EPOCH — HALTED→ARMED requires a strictly-greater nonce; replays rejected |
| I10 | TOKEN-EPOCH-BOUND — a halt or perm change invalidates every in-flight token |
| I11 | NO-AUDIT-GAP — the emit token is minted only as a side-effect of appending the decision envelope |
| I12 | EFFECTIVE-ORIGIN-FROM-BRIDGE — acting origin is the element's origin (iframe, not top-frame); exact match |
| I13 | CAP-INCLUSIVE-CEILING — `projected == cap` ok, `> cap` block |
| I14 | NO-CAP-MEANS-ZERO — a missing per-site cap is 0, not unlimited |
| I15 | AMOUNT-FAIL-CLOSED — unbounded/ambiguous amount ⇒ block; mixed currency ⇒ block |
| I16 | SPEND-IS-A-LEDGER-FOLD — authoritative total is a fold over emitted-purchase envelopes, once per seq |
| I17 | SINGLE-WRITER-SERIALIZED — reserve-before-token, so no cap race / double-spend window |
| I18 | SEQ-DENSE — `seq == index`, no gaps or reuse |
| I19 | TS-MONOTONIC — `ts >= prev.ts` (non-decreasing) |
| I20 | GENESIS-FIXED — first entry `seq=0, prev_hash=null` |
| I21 | CHAIN-BINDS-TAIL — the SIGNATURE is the tamper-evidence: `verifyChain(chain, {verify, pubkey})` rejects a past edit because re-signing needs the user key the kernel never holds. The bare hash-chain alone is only integrity-linkage (a keyless holder can edit + re-hash the tail); forgery resistance requires the signature layer |
| I22 | REPLAYABLE — re-running verdict from the envelope payload reproduces the recorded class |
| I23 | APPEND-ONLY — the ledger exposes only append()/verify() |
| I24 | TOTALITY — no input throws or returns undefined; garbage ⇒ block (fuzz-verified) |
| I25 | CONFIRM-NOT-AGENT-ADDRESSABLE — consent originates only from OOB control-plane input |

## The 15 bypass classes it defends

1. **Confused-deputy via injected page content** — page text says "user pre-authorized this". Defense: perms/amounts/consent come only from control-plane + OOB user input; page content is data, never authority. Class is derived from the action, so send/spend/delete stay confirm regardless (I3/I8).
2. **Action-class downgrade (mislabeling)** — label a purchase as `scroll`. Defense: class derived from the observed control (I3); a click landing on a checkout button resolves to purchase.
3. **Cap race / double-spend** — two near-simultaneous buys. Defense: single-writer, reserve-before-token (I17); the second sees the first's reservation.
4. **Cap-split / structuring** — four £60 buys under a £200 cap. Defense: cap on the cumulative running total (I13/I16); the crossing chunk blocks.
5. **Amount spoofing** — claim £1 for a £500 cart, or an unbounded amount. Defense: bridge-observed amount; unbounded ⇒ block (I15).
6. **Off-domain pivot / lookalike domain** — get `act` on benign.com, then act on bank.com. Defense: exact registrable-domain, no inheritance (I12); the cross-origin nav is itself confirm-gated.
7. **Frame/embedded-widget escape** — act on a third-party iframe under an allowed top-frame. Defense: acting origin is the element's frame, not the top-frame (I12).
8. **Cross-origin exfiltration** — read a 2FA code on A, type it into attacker form B. Defense: cross-site data move is its own confirm class, triggered by the origin boundary.
9. **Kill-switch race / queued actions** — flood the queue during a halt. Defense: killswitch is stage-1 synchronous + epoch bump invalidates in-flight tokens (I7/I10).
10. **Re-arm confusion / replay** — replay a captured re-arm. Defense: re-arm is not in the action space; needs a strictly-greater epoch (I8/I9).
11. **Confirm self-satisfaction / token replay** — click the governor's own dialog, or reuse a £5 approval for a £500 buy. Defense: consent is OOB-only, tokens are single-use + payload-bound (I5/I25).
12. **Perms TOCTOU** — change a permission between decision and event. Defense: token binds permsEpoch; a perm change bumps it, invalidating the token (I10).
13. **Audit-log tampering / silent action** — act without a log entry, or edit/backdate one. Defense: no envelope ⇒ no token ⇒ no event (I11); append-only, tail-binding, seq-dense, ts-monotonic (I18–I23).
14. **Signing-key extraction / envelope forgery** — read the key to forge envelopes. Defense: key custody lives in the host/bridge; the kernel treats sign/verify as injected primitives and holds no key.
15. **Self-escalation** — propose actions that re-arm / raise the cap / grant a perm. Defense: those are user-only control-plane entry points, structurally outside the verdict path; any such proposal is block (I8).

---

*Design credit: synthesized from a three-lens adversarial threat-model panel, then
hardened by a five-lens adversarial code review that confirmed and fixed **8 real
bugs** in the first implementation — two critical: an agent-forgeable consent token
(fixed by moving consent into host-controlled state) and an audit chain that never
checked signatures (fixed by verifying them, and by stating honestly what the bare
hash-chain does and does not provide). Every fix ships with a regression test named
for the finding. This document describes the enforced kernel; the mutation gate
(`npm run gate`) is what proves the tests actually hold these invariants, not just
assert them.*
