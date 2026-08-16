// run-gate.mjs — the proof-of-play gate for the Governor kernel.
//
// Two checks, both must pass:
//   1. MUTATION — witness breaks each kernel file one operator at a time and re-runs
//      the suite; a surviving mutant is a decision point no test guards (test-theatre).
//   2. FUZZ — the hostile-input battery is thrown at the total functions; a safety
//      kernel must NEVER throw on garbage (invariant I24 TOTALITY).
import { runMutations, fuzz } from './witness.mjs';
import { verdict, classifyAction, checkCap, lookupPerm } from '../kernel/governor.mjs';

const TEST = ['node', '--test', 'test/governor.test.mjs', 'test/envelope.test.mjs', 'test/agent.test.mjs', 'test/host.test.mjs', 'test/bridge.test.mjs', 'test/page-dom.test.mjs'];
// bridge/cdp-bridge.js is in this list now. It was not, which is how its one
// load-bearing line — the dispatch gate — sat wrong with no test and no mutant.
// The mutation gate only covers files someone remembered to name.
const FILES = ['kernel/governor.mjs', 'kernel/envelope.mjs', 'agent/tools.mjs', 'host/observe.mjs', 'bridge/cdp-bridge.js', 'page/agent-dom.js'];

let clean = true;

console.log('── mutation gate ─────────────────────────────────────────');
for (const f of FILES) {
  const r = runMutations(f, { testCmd: TEST });
  if (r.baselineFailed) { console.log(`  ${f}: BASELINE RED — ${r.reason}`); clean = false; continue; }
  const ig = r.ignored.length ? ` (+${r.ignored.length} baselined)` : '';
  console.log(`  ${f}: ${r.killed}/${r.total} killed  score=${r.score}${ig}  ${r.clean ? 'CLEAN' : 'THEATRE'}`);
  for (const s of r.survived) console.log(`     SURVIVED L${s.line}  ${s.mutation}  | ${s.snippet}`);
  clean = clean && r.clean;
}

console.log('\n── fuzz gate (safety kernel must never throw) ────────────');
const targets = {
  'verdict(garbage, garbage)': (x) => verdict(x, x, 0),
  'classifyAction(garbage)': (x) => classifyAction(x),
  'checkCap(garbage)': (x) => checkCap(x, x, x, x),
  'lookupPerm(garbage)': (x) => lookupPerm(x, x),
};
for (const [name, fn] of Object.entries(targets)) {
  const r = await fuzz(fn);
  console.log(`  ${name}: ${r.neverThrows ? 'never throws — OK' : 'THREW on ' + r.throwsOn.map(t => t.input).join(', ')}`);
  clean = clean && r.neverThrows;
}

console.log(clean ? '\n=== ALL CLEAN ===' : '\n=== SURVIVORS / THROWS REMAIN ===');
process.exit(clean ? 0 : 1);
