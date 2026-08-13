// build-page.mjs — GENERATE index.html FROM THE REAL KERNEL.
//
// ⚑ The page does not describe the governor. It RUNS it. The two kernel files are read off disk and
// inlined verbatim — module keywords stripped, not one line of logic re-typed — so what a visitor
// exercises in the browser is byte-for-byte the code the mutation gate proved. A page that reimplements
// its own kernel is a brochure that will drift, and the drift is invisible until it matters.
//
//   node build-page.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (s) => s
  .replace(/^import[^\n]*\n/gm, '')          // the kernel's own module wiring; both files land in one scope
  .replace(/^export (function|const|class)/gm, '$1')
  .replace(/^export \{[^}]*\};?\s*$/gm, '')
  .replace(/^export default[^\n]*\n/gm, '');

const envelope = strip(readFileSync(join(HERE, 'kernel', 'envelope.mjs'), 'utf8'));
const governor = strip(readFileSync(join(HERE, 'kernel', 'governor.mjs'), 'utf8'));

const KERNEL = `${envelope}\n\n${governor}`;
const lines = KERNEL.split('\n').length;

const html = readFileSync(join(HERE, 'page.template.html'), 'utf8')
  .replace('/*__KERNEL__*/', () => KERNEL)
  .replace(/__KERNEL_LINES__/g, String(lines));

writeFileSync(join(HERE, 'index.html'), html);
console.log(`index.html written — ${lines} lines of real kernel inlined, ${(html.length / 1024).toFixed(0)}KB total`);
