// envelope.mjs — the tamper-evident audit ledger primitives (PURE, TOTAL).
//
// Every action the agent takes and every verdict the Governor issues is written
// as a signed, hash-chained envelope. This is the same shape the rest of the
// estate uses (niceassos-mesh): a break anywhere in the chain is detectable, so
// the audit log cannot be silently rewritten to hide what the agent did.
//
// PURE by construction: no clock, no crypto side effects. The caller passes `ts`
// and a `signFn`/`hasher`; production wires SHA-256 + Ed25519 from the bridge,
// tests wire deterministic stand-ins. That is exactly what makes it witnessable.

export const LEDGER_VERSION = 'sovereign-browser-audit-v1';

// Deterministic JSON: object keys sorted, so the hash of equal content is equal.
// TOTAL: never throws. A BigInt/undefined/function/symbol (which JSON.stringify
// either throws on or drops) is normalized rather than crashing the hasher — a
// hostile observed value must not be able to throw the Governor (I24).
export function canonicalJSON(o) {
  if (o === null || o === undefined) return 'null';
  const t = typeof o;
  if (t === 'bigint') return JSON.stringify(o.toString());
  if (t === 'function' || t === 'symbol') return 'null';
  if (t !== 'object') return JSON.stringify(o);               // string | number | boolean
  if (Array.isArray(o)) return '[' + o.map(canonicalJSON).join(',') + ']';
  return '{' + Object.keys(o).sort()
    .map(k => JSON.stringify(k) + ':' + canonicalJSON(o[k])).join(',') + '}';
}

// fnv1a — a fast, dependency-free 32-bit hash, rendered as 8 hex chars. It is the
// DEFAULT hasher so the kernel stays pure and self-contained; the bridge swaps in
// SHA-256 for production. Tamper-evidence holds under any injective-enough hasher.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Build one audit envelope. `prevHash` links it to the previous entry; the first
// entry uses null. `signFn` is optional (bridge supplies Ed25519); when absent the
// envelope is unsigned (signature: null) — still chained, just not authenticated.
export function auditEnvelope({ kind, actor, seq, prevHash = null, payload = {}, ts, signFn = null }) {
  const env = {
    version: LEDGER_VERSION,
    kind,                 // 'proposal' | 'verdict' | 'action' | 'killswitch' | 'cap'
    actor,                // who/what emitted it (agent id / 'governor' / 'user')
    seq,                  // monotonic per-ledger counter
    ts,                   // caller-supplied timestamp (kernel takes no clock)
    prev_hash: prevHash,
    payload,
    signature: null,
  };
  if (signFn) env.signature = signFn(canonicalJSON({ ...env, signature: null }));
  return env;
}

// A monotonic, prev_hash-chained ledger. append() returns the new envelope and
// advances the chain; the instance holds only seq + lastHash (small, replayable).
export class AuditLedger {
  constructor({ hasher = fnv1a, signFn = null } = {}) {
    this.hasher = hasher;
    this.signFn = signFn;
    this.seq = 0;
    this.lastHash = null;
    this.entries = [];
  }
  append({ kind, actor, payload = {}, ts }) {
    const env = auditEnvelope({
      kind, actor, seq: this.seq, prevHash: this.lastHash, payload, ts, signFn: this.signFn,
    });
    this.seq += 1;
    this.lastHash = this.hasher(canonicalJSON(env));
    this.entries.push(env);
    return env;
  }
}

// Verify a list of envelopes is a well-formed audit chain. Checks, per entry:
//   · prev_hash linkage      — H(previous) matches (detects a broken/reordered chain)
//   · seq density (I18)      — seq == index, no gaps or reuse (a deletion shows up)
//   · ts monotonicity (I19)  — ts >= previous ts (backdating is tamper evidence)
//   · signature (I21)        — when { verify, pubkey } is supplied, every entry's
//                              signature must authenticate its content
//
// HONEST SCOPE (corrected after review): the hash chain ALONE is only integrity-
// linkage. Because the linkage hash is public and keyless, a determined holder can
// edit a past entry and RE-HASH the whole tail, and the bare chain re-verifies. The
// forgery resistance is the SIGNATURE: pass { verify, pubkey } (Ed25519 in prod) and
// a rewritten entry fails signature check, because re-signing needs the user key the
// kernel never holds (I21 CHAIN-BINDS-TAIL). Without it you get corruption/reorder
// detection, not tamper-proofing.
//
// opts is a hasher fn (back-compat) OR { hasher?, verify?, pubkey? }.
// Returns { ok, brokenAt, reason } — brokenAt is -1 when ok, else the first bad index.
export function verifyChain(envs, opts = fnv1a) {
  const hasher = typeof opts === 'function' ? opts : (opts.hasher || fnv1a);
  const verify = typeof opts === 'function' ? null : opts.verify;   // object form carries {verify,pubkey}
  const pubkey = typeof opts === 'function' ? null : opts.pubkey;
  let prev = null, prevTs = -Infinity;
  for (let i = 0; i < envs.length; i++) {
    const e = envs[i];
    if (e.prev_hash !== prev) return { ok: false, brokenAt: i, reason: 'prev_hash mismatch' };
    if (e.seq !== i) return { ok: false, brokenAt: i, reason: 'seq gap or reuse' };
    if (!(e.ts >= prevTs)) return { ok: false, brokenAt: i, reason: 'ts not monotonic' };
    if (verify) {
      const ok = e.signature != null && verify(canonicalJSON({ ...e, signature: null }), e.signature, pubkey);
      if (!ok) return { ok: false, brokenAt: i, reason: 'signature invalid' };
    }
    prev = hasher(canonicalJSON(e));
    prevTs = e.ts;
  }
  return { ok: true, brokenAt: -1, reason: 'ok' };
}
