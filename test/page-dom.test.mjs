// page-dom.test.mjs — the page-context observer, and the seam where it meets the host.
//
// page/agent-dom.js is the FIRST thing in the chain: whatever it fails to observe, the
// Governor cannot possibly judge on. It was the file where the purchase hole really lived
// — the host now treats an observed price as proof that a click spends money, but this
// file only bothered to look for a price on controls that already said "buy". A label
// deciding whether the fact gets collected is the label deciding, one step earlier.
//
// It ran with no tests and outside the mutation gate; both are fixed here. It runs in page
// context, so it is loaded into a vm with a small fake DOM, as desktop/smoke.js does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { PURCHASE_PATTERN, deriveObserved } from '../host/observe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'page', 'agent-dom.js'), 'utf8');

// ── the two lists, checked rather than trusted ─────────────────────────────────
test('the page observer and the host share one purchase vocabulary', () => {
  const between = SRC.split('__PURCHASE_RE_BEGIN__')[1]?.split('__PURCHASE_RE_END__')[0];
  assert.ok(between, 'the marked PURCHASE_RE block is missing from page/agent-dom.js');
  const literal = between.match(/\/(.*)\/i;/);
  assert.ok(literal, 'no /…/i regex literal inside the marked block');
  assert.equal(literal[1], PURCHASE_PATTERN,
    'page/agent-dom.js and host/observe.mjs disagree about what a purchase control looks like');
});

// ── a fake DOM, small enough to read ───────────────────────────────────────────
// The vm gets real HTMLInputElement / HTMLTextAreaElement constructors so that
// `el instanceof …` inside the observer means what it means in a browser; elements are
// built from those constructors rather than plain objects.
function page() {
  const scrolled = [];
  const ctx = {
    window: {},
    location: { href: 'https://shop.example/c', origin: 'https://shop.example' },
    HTMLInputElement: function () {}, HTMLTextAreaElement: function () {},
    Event: function (name) { this.type = name; }, URL,
  };
  ctx.document = {
    querySelectorAll: () => ctx.__els,
    querySelector: (sel) => {
      const m = /\[data-sb-ref="(.*)"\]/.exec(sel);
      return ctx.__els.find(e => String(e.__ref) === m[1]) || null;
    },
    body: { innerText: 'page text' }, title: 'Shop',
    scrollingElement: { scrollBy: (x, y) => scrolled.push(['document', x, y]) },
  };
  ctx.globalThis = ctx;
  ctx.__els = [];
  vm.createContext(ctx);

  const el = ({ tag = 'button', type, text, value, ariaLabel, role, href, container, ref } = {}) => {
    const Ctor = tag === 'input' ? ctx.HTMLInputElement : tag === 'textarea' ? ctx.HTMLTextAreaElement : Object;
    const e = Ctor === Object ? {} : Object.create(Ctor.prototype);
    const attrs = { type: type ?? null, role: role ?? null, href: href ?? null };
    Object.assign(e, {
      tagName: tag.toUpperCase(), textContent: text, value, __ref: ref ?? 0,
      autocomplete: undefined, name: undefined,
      getAttribute: (k) => (k === 'aria-label' ? (ariaLabel ?? null) : attrs[k] ?? null),
      setAttribute: () => {},
      closest: (sel) => (container && /form|cart|checkout|total/.test(sel) ? container : null),
      getBoundingClientRect: () => ({ x: 2, y: 4, width: 10, height: 10 }),
      focus() { e.__focused = true; },
      click() { e.__clicked = true; },
      dispatchEvent(ev) { (e.__events ||= []).push(ev.type); },
      scrollBy: (x, y) => scrolled.push(['el', x, y]),
    });
    if (type !== undefined) e.type = type;
    return e;
  };

  const load = (els) => { ctx.__els = els; vm.runInContext(SRC, ctx); return ctx.window; };
  return { ctx, el, load, scrolled, see: (els) => load(els).__sbSee().items };
}
const one = (spec) => { const p = page(); return { it: p.see([p.el(spec)])[0], p }; };
// Objects built inside the vm carry that realm's Object.prototype, so deepEqual against a
// literal here fails on identity alone. Compare shape, which is what these assertions mean.
const plain = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

// ── the finding, end to end ────────────────────────────────────────────────────
test('a priced control is observed WITH its price even when the label is bland', () => {
  const { it } = one({ tag: 'button', text: 'Get it now — £49.99' });
  assert.equal(it.cost, 4999, 'the price on the button was not observed');
  assert.equal(deriveObserved(it, { op: 'click', provenance: 'user' }, 'https://shop.example').kind, 'purchase');
});

test('a submit button inherits the price of the checkout row it commits', () => {
  const { it } = one({ tag: 'button', text: 'Continue', container: { textContent: 'Blue widget  Total £12.99' } });
  assert.equal(it.cost, 1299);
});

test('a Cancel link inside that same priced form does NOT inherit the total', () => {
  const { it } = one({ tag: 'a', text: 'Cancel', href: '/basket', container: { textContent: 'Total £12.99' } });
  assert.equal(it.cost, undefined, 'a back-out link was priced as if it spent the total');
  assert.equal(deriveObserved(it, { op: 'click', provenance: 'user' }, 'https://shop.example').kind, 'click_link');
});

test('a control with no price anywhere reports none, and the cap fails closed', () => {
  const { it } = one({ tag: 'button', text: 'Buy now' });
  assert.equal(it.cost, undefined);
  const o = deriveObserved(it, { op: 'click', provenance: 'user' }, 'https://shop.example');
  assert.equal(o.kind, 'purchase');       // the word still makes it a purchase
  assert.equal(o.cost, undefined);        // with no number, checkCap blocks it
});

// ── which controls get priced at all ───────────────────────────────────────────
test('every clickable shape is priced: button, submit, button-typed input, role=button, link', () => {
  const row = { textContent: 'Total £12.99' };
  const cases = [
    ['plain button',        { tag: 'button', text: 'Continue', container: row }],
    ['input type=submit',   { tag: 'input',  type: 'submit', text: 'Continue', container: row }],
    ['input type=button',   { tag: 'input',  type: 'button', text: 'Pay', container: row }],
    ['role=button div',     { tag: 'div',    role: 'button', text: 'Checkout', container: row }],
    ['priced link',         { tag: 'a',      href: '/x', text: 'Widget £5.00' }],
  ];
  for (const [name, spec] of cases) {
    const { it } = one(spec);
    assert.ok(typeof it.cost === 'number', `${name} was not priced`);
  }
});

test('a select is not priced — a dropdown does not commit a purchase', () => {
  const { it } = one({ tag: 'select', text: 'Quantity', container: { textContent: 'Total £12.99' } });
  assert.equal(it.cost, undefined);
});

test('text fields are never priced — you do not spend money by typing', () => {
  const { it } = one({ tag: 'input', type: 'text', text: '', container: { textContent: 'Total £12.99' } });
  assert.equal(it.cost, undefined);
});

// ── isSubmit / isSend, the other observed facts ────────────────────────────────
test('an input type=submit is observed as a submit', () => {
  const { it } = one({ tag: 'input', type: 'submit', text: 'Save' });
  assert.equal(it.isSubmit, true);
});

test('a typeless button is a submit; a type=button one is not', () => {
  assert.equal(one({ tag: 'button', text: 'Save' }).it.isSubmit, true);
  assert.equal(one({ tag: 'button', type: 'button', text: 'Close' }).it.isSubmit, false);
});

test('isSend needs both a sending word and a form around it', () => {
  assert.equal(one({ tag: 'button', type: 'button', text: 'Send', container: { textContent: '' } }).it.isSend, true);
  assert.equal(one({ tag: 'button', type: 'button', text: 'Send' }).it.isSend, false, 'no form, so nothing to send');
  assert.equal(one({ tag: 'button', type: 'button', text: 'Close', container: { textContent: '' } }).it.isSend, false);
});

test('a control with no text at all is observed without throwing', () => {
  const { it } = one({ tag: 'button' });
  assert.equal(it.text, '');
  assert.equal(it.isSubmit, true);        // typeless button, regardless of wording
  assert.equal(it.isSend, false);
});

test('the visible text falls back through textContent, value, then aria-label', () => {
  assert.equal(one({ tag: 'button', text: '  Pay now  ' }).it.text, 'Pay now');
  assert.equal(one({ tag: 'input', type: 'text', value: 'typed value' }).it.text, 'typed value');
  assert.equal(one({ tag: 'button', ariaLabel: 'Close dialog' }).it.text, 'Close dialog');
});

// ── fieldFacts: what the credential classifier upstream depends on ─────────────
test('field facts are reported for inputs and textareas, and for nothing else', () => {
  const p = page();
  const input = p.el({ tag: 'input', type: 'password', ref: 0 });
  input.autocomplete = 'current-password'; input.name = 'pw';
  const area = p.el({ tag: 'textarea', type: 'textarea', ref: 1 });
  const btn = p.el({ tag: 'button', text: 'Go', ref: 2 });
  const items = p.see([input, area, btn]);
  assert.deepEqual(plain(items[0].field), { type: 'password', autocomplete: 'current-password', name: 'pw' });
  assert.deepEqual(plain(items[1].field), { type: 'textarea', autocomplete: '', name: '' });
  assert.equal(items[2].field, null, 'a button reported a form field');
  // and the host turns those facts into a terminal block
  assert.equal(deriveObserved(items[0], { op: 'type', provenance: 'user' }, 'https://shop.example').field.type, 'password');
});

test('an input with no autocomplete or name reports empty strings, not undefined', () => {
  const { it } = one({ tag: 'input', type: 'text' });
  assert.deepEqual(plain(it.field), { type: 'text', autocomplete: '', name: '' });
});

test('observed facts about a control survive the trip to the host', () => {
  const { it } = one({ tag: 'a', text: 'Elsewhere', href: 'https://other.example/x' });
  assert.equal(it.crossOrigin, true);
  assert.equal(deriveObserved(it, { op: 'click', provenance: 'user' }, 'https://shop.example').kind, 'navigate_cross');
});

test('a same-origin link is not cross-origin, and an unparseable href does not throw', () => {
  assert.equal(one({ tag: 'a', text: 'Home', href: '/home' }).it.crossOrigin, false);
  // a javascript: href has origin "null", so it IS off-origin — the safe reading, and the
  // one the Governor should get: clicking it is a cross-site move, not a same-site link.
  assert.equal(one({ tag: 'a', text: 'Odd', href: 'javascript:void 0' }).it.crossOrigin, true);
  // and an href the URL parser rejects outright must not take the whole snapshot down
  assert.equal(one({ tag: 'a', text: 'Broken', href: 'http://[' }).it.crossOrigin, false);
});

test('each item carries a stable ref and the centre of its box', () => {
  const { it } = one({ tag: 'button', text: 'Go' });
  assert.equal(it.ref, 0);
  assert.deepEqual(plain(it.rect), { x: 7, y: 9 });
});

// ── __sbAct: the hands. Only ever called after a Governor allow. ───────────────
test('act clicks the element the ref points at', () => {
  const p = page();
  const el = p.el({ tag: 'button', text: 'Go', ref: 0 });
  const w = p.load([el]);
  w.__sbSee();
  assert.deepEqual(plain(w.__sbAct({ op: 'click', ref: 0 })), { done: true });
  assert.equal(el.__clicked, true);
});

test('act types into a value-bearing element and fires input + change', () => {
  const p = page();
  const el = p.el({ tag: 'input', type: 'text', value: '', ref: 0 });
  const w = p.load([el]);
  w.__sbSee();
  w.__sbAct({ op: 'type', ref: 0, text: 'hello' });
  assert.equal(el.value, 'hello');
  assert.equal(el.__focused, true);
  assert.deepEqual(el.__events, ['input', 'change']);
});

test('act types into a contenteditable by setting its text, with no events', () => {
  const p = page();
  const el = p.el({ tag: 'div', text: 'old', ref: 0 });
  delete el.value;
  const w = p.load([el]);
  w.__sbSee();
  w.__sbAct({ op: 'type', ref: 0, text: 'new' });
  assert.equal(el.textContent, 'new');
  assert.equal(el.__events, undefined);
});

test('act scrolls the element, defaulting the distance when none is given', () => {
  const p = page();
  const el = p.el({ tag: 'div', text: 'x', ref: 0 });
  const w = p.load([el]);
  w.__sbSee();
  w.__sbAct({ op: 'scroll', ref: 0, dy: 120 });
  w.__sbAct({ op: 'scroll', ref: 0 });
  assert.deepEqual(p.scrolled, [['el', 0, 120], ['el', 0, 400]]);
});

test('a missing ref stops a click, but navigation needs no element', () => {
  const p = page();
  const w = p.load([p.el({ tag: 'button', ref: 0 })]);
  w.__sbSee();
  assert.deepEqual(plain(w.__sbAct({ op: 'click', ref: 99 })), { done: false, error: 'ref not found' });
  let went = null;
  p.ctx.location.assign = (u) => { went = u; };
  assert.deepEqual(plain(w.__sbAct({ op: 'navigate', ref: 99, target: 'https://shop.example/y' })), { done: true });
  assert.equal(went, 'https://shop.example/y');
});

test('an unknown op is refused rather than guessed at', () => {
  const p = page();
  const w = p.load([p.el({ tag: 'button', ref: 0 })]);
  w.__sbSee();
  assert.deepEqual(plain(w.__sbAct({ op: 'teleport', ref: 0 })), { done: false, error: 'unknown op' });
});

test('injecting twice does not redefine the hands', () => {
  const p = page();
  const w = p.load([p.el({ tag: 'button', ref: 0 })]);
  const first = w.__sbSee;
  vm.runInContext(SRC, p.ctx);
  assert.equal(p.ctx.window.__sbSee, first);
});

test('the snapshot reports where it is and what the page says', () => {
  const p = page();
  const snap = p.load([p.el({ tag: 'button', text: 'Go', ref: 0 })]).__sbSee();
  assert.equal(snap.origin, 'https://shop.example');
  assert.equal(snap.url, 'https://shop.example/c');
  assert.equal(snap.title, 'Shop');
  assert.equal(snap.text, 'page text');
});
