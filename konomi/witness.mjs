// ════════════════════════════════════════════════════════════════
// witness · a deterministic build gate — catch test-theatre and throw-on-malformed BEFORE you push
//
// Four adversarial LLM audit passes across the estate found two classes of problem over and over:
//   1. TEST-THEATRE — a test that stays green even when the behaviour it names is broken.
//   2. THROW-ON-MALFORMED — a validate/verify/classify function that crashes on hostile input
//      (null, BigInt, circular, a toxic getter, a huge array) instead of returning a safe result.
// Both are catchable WITHOUT a language model, deterministically, in seconds:
//   • MUTATION gate — flip one operator in the source, run the tests. If they still pass, that line is
//     unguarded (theatre). A surviving mutant is a hole a real regression would fall straight through.
//   • FUZZ gate — throw the hostile-input battery at a function. If it throws, it fails the never-throw
//     boundary contract.
//
// This is the witness discipline baked into the forge, so the estate stops needing a 1.5M-token audit
// per build. Zero dependencies (Node only — spawns the project's own test runner). Deterministic.
// ════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// A reviewed-equivalent baseline. Mutation testing has a well-known floor: some mutants are EQUIVALENT
// (semantically identical to the original — an idempotent max-assignment, an out-of-bounds write silently
// dropped by a typed array, a tie-break branch unreachable because ids are unique) and CANNOT be killed by
// any test. They are not test-theatre. Without a way to record them, `clean` is unreachable on real code
// and the gate cries wolf forever. A `witness.baseline.json` next to the source (or in cwd) lists reviewed
// survivors — `[{ mutation, snippet, reason }]` — which are then reported as `ignored`, not counted against
// `clean`. Each entry is a signed-off human judgement, and it is matched by the exact (mutation, code line)
// pair, so it silently stops applying the moment that line changes — you cannot baseline away a future bug.
function loadBaseline(opts, srcPath, cwd) {
  let raw = opts.baseline;
  if (typeof raw === 'string') { try { raw = JSON.parse(readFileSync(raw, 'utf8')); } catch { raw = []; } }
  else if (!Array.isArray(raw)) {
    raw = [];
    for (const p of [join(dirname(srcPath), 'witness.baseline.json'), join(cwd, 'witness.baseline.json')]) {
      try { raw = JSON.parse(readFileSync(p, 'utf8')); break; } catch { /* none here */ }
    }
  }
  const sigs = new Map();
  for (const e of (Array.isArray(raw) ? raw : [])) {
    if (e && e.mutation && e.snippet) sigs.set(`${e.mutation} :: ${e.snippet}`, e.reason || 'reviewed-equivalent');
  }
  return sigs;
}

// A child test runner must not inherit OUR test-runner context. node:test sets NODE_TEST_CONTEXT in
// every test-file process; if the `node --test` we spawn inherits it, it switches to the child-reporter
// protocol and exits 0 even when a test FAILS — so every mutant would falsely "survive" whenever witness
// itself runs under `npm test`/CI. Scrub the leak (this bug was found BY witness, running on witness).
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ── mutation operators ───────────────────────────────────────────────────────
// Spaced operators only, so we never mis-hit `=>`, `>=` inside `===`, or bit-shifts. Each flips the
// behaviour at exactly one point; a suite that can't tell the difference isn't testing that point.
export const OPERATORS = [
  [' >= ', ' > '], [' <= ', ' < '], [' > ', ' >= '], [' < ', ' <= '],
  [' === ', ' !== '], [' !== ', ' === '], [' == ', ' != '],
  [' && ', ' || '], [' || ', ' && '],
  ['return true', 'return false'], ['return false', 'return true'],
  [' + 1', ' - 1'], [' - 1', ' + 1'],
];

// codeMask(source) — a boolean array where true means "this char is executable code",
// false means it is inside a // or /* */ comment or a '…' "…" `…` string literal. A
// naive indexOf mutates operators inside comments/strings too (` < ` in a doc line,
// ` || ` in a message), and those mutants can never be killed — pure false theatre.
// Masking them out is what makes a CLEAN verdict meaningful. Lightweight lexer: good
// for kernel code; treats template literals as fully masked (conservative).
export function codeMask(source) {
  const mask = new Array(source.length).fill(true);
  let s = 'code';                                   // code | line | block | sq | dq | tpl
  for (let i = 0; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (s === 'code') {
      if (c === '/' && n === '/') { s = 'line'; }
      else if (c === '/' && n === '*') { s = 'block'; }
      else if (c === "'") { s = 'sq'; }
      else if (c === '"') { s = 'dq'; }
      else if (c === '`') { s = 'tpl'; }
      else continue;
      mask[i] = false;
    } else {
      mask[i] = false;
      if (s === 'line' && c === '\n') s = 'code';
      else if (s === 'block' && c === '*' && n === '/') { mask[i + 1] = false; i++; s = 'code'; }
      else if (s === 'sq' && c === '\\') { mask[i + 1] = false; i++; }
      else if (s === 'sq' && c === "'") s = 'code';
      else if (s === 'dq' && c === '\\') { mask[i + 1] = false; i++; }
      else if (s === 'dq' && c === '"') s = 'code';
      else if (s === 'tpl' && c === '\\') { mask[i + 1] = false; i++; }
      else if (s === 'tpl' && c === '`') s = 'code';
    }
  }
  return mask;
}

// Generate one mutant per operator occurrence (single-point mutation), skipping any
// occurrence that overlaps a comment or string literal (see codeMask).
export function mutants(source) {
  const out = [];
  const mask = codeMask(source);
  const inCode = (idx, len) => { for (let k = idx; k < idx + len; k++) if (!mask[k]) return false; return true; };
  for (const [from, to] of OPERATORS) {
    let idx = source.indexOf(from);
    while (idx !== -1) {
      if (inCode(idx, from.length)) {
        const mutated = source.slice(0, idx) + to + source.slice(idx + from.length);
        const line = source.slice(0, idx).split('\n').length;
        out.push({ line, from: from.trim(), to: to.trim(), pos: idx, source: mutated });
      }
      idx = source.indexOf(from, idx + from.length);
    }
  }
  return out;
}

// Run the mutation gate: for each mutant, write it to srcPath, run the test command, and see if the
// tests catch it. A mutant that leaves the tests GREEN survived — that line is unguarded.
//
// CRASH-SAFE. `finally` restores on a normal finish or a thrown error, but NOT on SIGTERM/SIGKILL — a
// hard kill mid-run would leave srcPath holding a live mutant (this actually happened while dogfooding
// witness on itself). So before mutating we drop a sidecar backup holding the true original; if a prior
// run was killed, that backup is still on disk and we self-heal from it on the next run. The estate can
// never be left silently corrupted by an interrupted gate.
// opts: { testCmd?: string[], cwd?: string, cap?: number, timeout?: number, baseline?: string|array }
export function runMutations(srcPath, opts = {}) {
  const backup = srcPath + '.witnessbak';
  // Self-heal: a leftover backup means a previous run was hard-killed with srcPath mutated. The backup
  // holds the real original — restore from it before reading, so a crash never poisons the next run.
  if (existsSync(backup)) {
    writeFileSync(srcPath, readFileSync(backup, 'utf8'));
    rmSync(backup);
  }
  const original = readFileSync(srcPath, 'utf8');
  writeFileSync(backup, original);   // durable copy of truth, survives even a SIGKILL of this process
  const cwd = opts.cwd || process.cwd();
  const testCmd = opts.testCmd || ['npm', 'test'];
  const cap = opts.cap ?? 80;
  // Per-mutant timeout. Some mutants break termination (flip `lo < hi` → `lo <= hi` in a binary search and
  // the loop never exits). Without a bound, one such mutant hangs the whole gate forever — this actually
  // happened sweeping fallherd. A timed-out run is a mutant the suite could NOT survive, i.e. KILLED.
  const timeout = opts.timeout ?? 20000;
  const baseline = loadBaseline(opts, srcPath, cwd);

  // BASELINE-GREEN GUARD. If the UNMUTATED suite does not already pass, every mutant will also "fail" and be
  // counted as KILLED — a false clean. This is exactly how a missing package.json (npm test errors) or a
  // broken generated test silently produced a green verdict. Refuse to gate a red baseline.
  {
    const base = spawnSync(testCmd[0], testCmd.slice(1), { cwd, env: childEnv(), encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 26, timeout });
    if (base.status !== 0) {
      if (existsSync(backup)) rmSync(backup);
      return { total: 0, capped: false, killed: 0, survived: [], ignored: [], score: 0, clean: false,
        baselineFailed: true, reason: 'the unmutated test suite does not pass — cannot gate (a red baseline makes every mutant look killed)' };
    }
  }

  let all = mutants(original);
  const capped = all.length > cap;
  all = all.slice(0, cap);

  const survived = [], ignored = [];
  let killed = 0;
  try {
    for (const m of all) {
      writeFileSync(srcPath, m.source);
      const r = spawnSync(testCmd[0], testCmd.slice(1), { cwd, env: childEnv(), encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 26, timeout });
      // Killed unless the tests genuinely PASSED. status 0 = passed ⇒ survived. A timeout kills the child
      // (status null, signal set) ⇒ not passed ⇒ killed, which is correct: a mutant that hangs is caught.
      const passed = r.status === 0;
      if (passed) {
        const entry = { line: m.line, mutation: `${m.from} → ${m.to}`, snippet: lineOf(original, m.line) };
        const sig = `${entry.mutation} :: ${entry.snippet}`;
        if (baseline.has(sig)) ignored.push({ ...entry, reason: baseline.get(sig) });
        else survived.push(entry);
      } else killed++;
    }
  } finally {
    writeFileSync(srcPath, original);   // restore on a normal finish or a thrown error
    if (existsSync(backup)) rmSync(backup);   // and drop the sidecar — a clean exit needs no self-heal
  }

  return {
    total: all.length,
    capped: capped ? all.length : false,
    killed,
    survived,
    ignored,                                   // reviewed-equivalent survivors, with reasons — not theatre
    score: all.length ? Math.round((killed / all.length) * 1000) / 1000 : 1,
    clean: survived.length === 0,              // clean = no UNREVIEWED survivors (ignored don't count)
  };
}

// ── fuzz gate ────────────────────────────────────────────────────────────────
// The hostile-input battery — every value class that crashed a verify/classify/validate in the audits.
export function hostileInputs() {
  const circular = {}; circular.self = circular;
  const toxicGetter = { get x() { throw new Error('toxic getter'); }, get id() { throw new Error('toxic id'); } };
  const toxicToString = { toString() { throw new Error('toxic toString'); } };
  return [
    ['null', null], ['undefined', undefined], ['NaN', NaN], ['Infinity', Infinity],
    ['empty string', ''], ['whitespace', '   '], ['empty array', []], ['empty object', {}],
    ['true', true], ['false', false], ['BigInt', 10n], ['function', () => {}],
    ['huge string', 'x'.repeat(200000)], ['huge array', new Array(200000).fill(0)],
    ['circular object', circular], ['toxic getter', toxicGetter], ['toxic toString', toxicToString],
    ['negative', -1], ['zero', 0], ['nested', { a: { b: { c: null } } }],
  ];
}

// Throw the battery at `fn`; return the inputs that made it THROW (empty ⇒ it honours the never-throw
// boundary). Async-aware. Use for functions documented as tolerant (verify/validate/classify/parse).
export async function fuzz(fn) {
  const throwsOn = [];
  for (const [label, value] of hostileInputs()) {
    try { await fn(value); }
    catch (e) { throwsOn.push({ input: label, error: String(e && e.message || e).slice(0, 80) }); }
  }
  return { throwsOn, neverThrows: throwsOn.length === 0 };
}

function lineOf(src, n) { return (src.split('\n')[n - 1] || '').trim().slice(0, 90); }

// ── CLI ──────────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'mutate') {
    const [srcPath] = rest;
    if (!srcPath) { console.error('usage: witness mutate <sourceFile> [--cap N] [--baseline <file>] [--test <cmd...>]'); process.exit(2); }
    const capArg = rest.indexOf('--cap');
    const cap = capArg !== -1 ? Number(rest[capArg + 1]) : 80;
    const baseArg = rest.indexOf('--baseline');   // else auto-detects witness.baseline.json by the source
    const baseline = baseArg !== -1 ? rest[baseArg + 1] : undefined;
    // Everything after `--test` is the target project's test command (put it LAST). Defaults to `npm test`,
    // so the gate can target any repo's own runner — that's what makes witness usable as a CI Action.
    const testArg = rest.indexOf('--test');
    const testCmd = testArg !== -1 && rest.length > testArg + 1 ? rest.slice(testArg + 1) : undefined;
    console.error(`mutation gate: ${srcPath}${testCmd ? ` · tests: ${testCmd.join(' ')}` : ''} …`);
    const r = runMutations(srcPath, { cap, testCmd, baseline });
    console.log(JSON.stringify(r, null, 2));
    const ign = r.ignored.length ? `, ${r.ignored.length} reviewed-equivalent ignored` : '';
    if (!r.clean) console.error(`\n✗ ${r.survived.length} mutant(s) SURVIVED — those lines are test-theatre.${ign}`);
    else console.error(`\n✓ ${r.killed}/${r.total} killed${ign} — no test-theatre.`);
    process.exit(r.clean ? 0 : 1);
  }
  if (cmd === 'fuzz') {
    const [modulePath, exportName] = rest;
    if (!modulePath || !exportName) { console.error('usage: witness fuzz <module.mjs> <exportedFnName>'); process.exit(2); }
    const mod = await import(new URL(modulePath, `file://${process.cwd()}/`).href);
    const fn = mod[exportName];
    if (typeof fn !== 'function') { console.error(`${exportName} is not an exported function`); process.exit(2); }
    const r = await fuzz(fn);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.neverThrows ? 0 : 1);
  }
  console.error('witness — deterministic build gate\n  witness mutate <sourceFile> [--cap N]\n  witness fuzz <module.mjs> <exportedFnName>');
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main();
}

export default { mutants, runMutations, fuzz, OPERATORS, hostileInputs };
