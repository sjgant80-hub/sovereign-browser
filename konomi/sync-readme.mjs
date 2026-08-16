// sync-readme.mjs — WRITE THE GATE STATUS FROM THE GATE, never from memory.
//
// ⚑ The README claimed "108 tests" and "host/observe.mjs 21/21" while the suite was at 134
// and that file was at 26/26. Nobody lied; the numbers were typed once and the code moved.
// A hand-typed score is a claim about a run that happened at some point in the past, and it
// decays silently in the direction of flattering — nobody remembers to lower it.
//
//   node konomi/sync-readme.mjs           rewrite the block from a real run
//   node konomi/sync-readme.mjs --check   fail if the README disagrees with a real run (CI)
//
// It runs the actual suite and the actual mutation gate to get the numbers. That is slow,
// and it is the point: the only number worth printing is one that came out of a run.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '<!-- GATE-STATUS:BEGIN -->';
const END = '<!-- GATE-STATUS:END -->';

const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  return `${r.stdout || ''}${r.stderr || ''}`;
};

// 1. how many tests actually ran — running exactly what `npm test` runs, read out of
// package.json rather than restated here, so a new test file cannot be counted by one and
// missed by the other.
const npmTest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.test.split(/\s+/);
if (npmTest[0] !== 'node') { console.error(`the test script does not start with node: ${npmTest.join(' ')}`); process.exit(1); }
const tap = run(['--test', '--test-reporter=tap', ...npmTest.slice(1).filter(a => a !== '--test')]);
const tests = Number((tap.match(/^# tests (\d+)/m) || [])[1]);
const fail = Number((tap.match(/^# fail (\d+)/m) || [])[1]);
if (!Number.isFinite(tests) || tests === 0) { console.error('could not read a test count — refusing to write a number'); process.exit(1); }
if (fail !== 0) { console.error(`${fail} test(s) failing — refusing to write a gate status`); process.exit(1); }

// 2. what the mutation gate actually scored, per file
const gate = run(['konomi/run-gate.mjs']);
const rows = [...gate.matchAll(/^ {2}(\S+): (\d+)\/(\d+) killed  score=\S+( \(\+(\d+) baselined\))?  (CLEAN|THEATRE)$/gm)];
if (!rows.length) { console.error('could not read any mutation scores — refusing to write a gate status'); process.exit(1); }
const theatre = rows.filter(r => r[6] === 'THEATRE');
if (theatre.length) { console.error(`gate is not clean (${theatre.map(r => r[1]).join(', ')}) — refusing to write a gate status`); process.exit(1); }
if (!/ALL CLEAN/.test(gate)) { console.error('gate did not report ALL CLEAN — refusing to write a gate status'); process.exit(1); }

const scores = rows.map(r => `\`${r[1]}\` ${r[2]}/${r[3]}${r[5] ? ` (+${r[5]} reviewed equivalent)` : ''}`).join(', ');
const block = [
  BEGIN,
  `**Gate status** — ${tests} tests; mutation gate CLEAN on every gated module —`,
  `${scores}; fuzz battery: the safety kernel never throws on garbage input (I24).`,
  '`npm run gate` reproduces it, and `node konomi/sync-readme.mjs --check` fails the build',
  'if this paragraph and a real run ever disagree.',
  END,
].join('\n');

const path = join(ROOT, 'README.md');
const readme = readFileSync(path, 'utf8');
const i = readme.indexOf(BEGIN), j = readme.indexOf(END);
if (i < 0 || j < 0) { console.error(`README.md is missing the ${BEGIN} / ${END} markers`); process.exit(1); }
const current = readme.slice(i, j + END.length);

if (process.argv.includes('--check')) {
  if (current.trim() === block.trim()) { console.log(`README gate status matches a real run (${tests} tests, ${rows.length} files clean)`); process.exit(0); }
  console.error('README gate status is stale. Expected:\n\n' + block + '\n\nGot:\n\n' + current);
  process.exit(1);
}
writeFileSync(path, readme.slice(0, i) + block + readme.slice(j + END.length));
console.log(`README gate status written from a real run: ${tests} tests, ${rows.length} files clean`);
