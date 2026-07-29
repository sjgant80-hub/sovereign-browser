// envelope.test.mjs — the audit ledger's tamper-evidence proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJSON, fnv1a, auditEnvelope, AuditLedger, verifyChain } from '../kernel/envelope.mjs';

test('canonicalJSON is key-order independent (equal content => equal string)', () => {
  assert.equal(canonicalJSON({ a: 1, b: 2 }), canonicalJSON({ b: 2, a: 1 }));
  assert.equal(canonicalJSON({ a: 1, b: 2 }), '{"a":1,"b":2}');
});
test('canonicalJSON handles null, arrays, nesting without throwing', () => {
  assert.equal(canonicalJSON(null), 'null');
  assert.equal(canonicalJSON([3, 1, 2]), '[3,1,2]');
  assert.equal(canonicalJSON({ z: [{ y: 1 }] }), '{"z":[{"y":1}]}');
});
test('canonicalJSON is total on BigInt / undefined / function / symbol (never throws, always a string)', () => {
  assert.equal(canonicalJSON(10n), '"10"');
  assert.equal(canonicalJSON(undefined), 'null');
  assert.equal(canonicalJSON(() => {}), 'null');       // function => 'null' (kills the || guard)
  assert.equal(canonicalJSON(Symbol('x')), 'null');    // symbol => 'null'
  assert.equal(canonicalJSON({ cost: 5n }), '{"cost":"5"}');
});

test('a ledger appends a dense, monotonic, prev_hash-linked chain', () => {
  const led = new AuditLedger();
  led.append({ kind: 'decision', actor: 'governor', payload: { a: 1 }, ts: 10 });
  led.append({ kind: 'effect_emitted', actor: 'agent', payload: { a: 2 }, ts: 11 });
  led.append({ kind: 'decision', actor: 'governor', payload: { a: 3 }, ts: 12 });
  assert.equal(led.entries.length, 3);
  assert.deepEqual(led.entries.map(e => e.seq), [0, 1, 2]);
  assert.equal(led.entries[0].prev_hash, null);
  const v = verifyChain(led.entries);
  assert.equal(v.ok, true);
});

test('editing a past payload invalidates the chain (whole-tail break)', () => {
  const led = new AuditLedger();
  led.append({ kind: 'decision', actor: 'governor', payload: { amount: 5 }, ts: 1 });
  led.append({ kind: 'effect_emitted', actor: 'agent', payload: { amount: 5 }, ts: 2 });
  led.entries[0].payload.amount = 9999;     // tamper
  const v = verifyChain(led.entries);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);              // the NEXT entry's prev_hash no longer matches
});

test('I18 a deleted entry surfaces as a seq gap', () => {
  const led = new AuditLedger();
  for (let i = 0; i < 3; i++) led.append({ kind: 'decision', actor: 'g', payload: { i }, ts: i });
  const withGap = [led.entries[0], led.entries[2]];   // drop the middle
  const v = verifyChain(withGap);
  assert.equal(v.ok, false);
});

test('I19 a backdated timestamp is rejected', () => {
  const led = new AuditLedger();
  led.append({ kind: 'decision', actor: 'g', payload: {}, ts: 100 });
  // hand-forge a chained-but-backdated successor
  const bad = auditEnvelope({ kind: 'decision', actor: 'g', seq: 1, prevHash: led.lastHash, payload: {}, ts: 50 });
  const v = verifyChain([led.entries[0], bad]);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'ts not monotonic');
});

test('auditEnvelope signs over its content when a signFn is injected', () => {
  const signFn = (bytes) => 'sig:' + fnv1a(bytes);
  const env = auditEnvelope({ kind: 'decision', actor: 'g', seq: 0, prevHash: null, payload: { x: 1 }, ts: 1, signFn });
  assert.match(env.signature, /^sig:[0-9a-f]{8}$/);
  // signature covers the content: a changed payload would change the signature
  const env2 = auditEnvelope({ kind: 'decision', actor: 'g', seq: 0, prevHash: null, payload: { x: 2 }, ts: 1, signFn });
  assert.notEqual(env.signature, env2.signature);
});

test('fnv1a is deterministic, 8 hex chars, and matches a pinned value', () => {
  assert.equal(fnv1a('hello'), '4f9f2cab');    // characterization: pins the exact loop bound
  assert.equal(fnv1a('a'), 'e40c292c');
  assert.match(fnv1a('hello'), /^[0-9a-f]{8}$/);
  assert.notEqual(fnv1a('a'), fnv1a('b'));
});

test('I19 equal (non-decreasing) timestamps are allowed', () => {
  const led = new AuditLedger();
  led.append({ kind: 'decision', actor: 'g', payload: { a: 1 }, ts: 42 });
  led.append({ kind: 'decision', actor: 'g', payload: { a: 2 }, ts: 42 });   // same ts, legal
  assert.equal(verifyChain(led.entries).ok, true);
});

test('an empty chain verifies ok', () => {
  assert.equal(verifyChain([]).ok, true);
});

// R5 (adversarial-review): the bare hash chain is only integrity-linkage — a keyless
// holder can edit an entry and RE-HASH the tail, and it re-verifies. The SIGNATURE is
// the real tamper-evidence: with { verify, pubkey } the rewrite is caught.
test('a signed chain rejects a tamper-and-rehash that the bare chain accepts', () => {
  const SECRET = 'user-key';                          // toy MAC stands in for Ed25519
  const signFn = (bytes) => 'sig:' + fnv1a(SECRET + bytes);
  const verify = (bytes, sig, key) => sig === 'sig:' + fnv1a(key + bytes);

  const led = new AuditLedger({ signFn });
  led.append({ kind: 'verdict', actor: 'governor', payload: { class: 'block', cost: 0 }, ts: 1 });
  led.append({ kind: 'verdict', actor: 'governor', payload: { class: 'allow', cost: 0 }, ts: 2 });
  assert.equal(verifyChain(led.entries, { verify, pubkey: SECRET }).ok, true);   // honest chain verifies

  // keyless holder rewrites a recorded BLOCK into a big ALLOW and re-hashes the tail
  const forged = led.entries.map(e => ({ ...e, payload: { ...e.payload } }));
  forged[0].payload = { class: 'allow', cost: 99999 };
  forged[0].signature = 'sig:bogus';                  // no key => cannot re-sign
  for (let i = 1; i < forged.length; i++) forged[i].prev_hash = fnv1a(canonicalJSON(forged[i - 1]));

  assert.equal(verifyChain(forged).ok, true);                                    // bare chain is fooled (documented)
  const v = verifyChain(forged, { verify, pubkey: SECRET });
  assert.equal(v.ok, false);                                                     // signature check catches it
  assert.equal(v.brokenAt, 0);
});
