// smoke.js — headless verification of the desktop wiring, WITHOUT launching Electron
// (no display here). It proves the parts that don't need a GUI: the bridge loads the
// shared page/agent-dom.js, and that injectable defines and runs SEE/ACT. The GUI
// itself is verified by running `npm start`. Runs in CI (node-only, no electron).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 1) the bridge factory loads and reads the shared page script
const makeBridge = require('./bridge');
const bridge = makeBridge(path.join(__dirname, '..', 'page', 'agent-dom.js'));
assert.equal(typeof bridge.see, 'function', 'bridge.see');
assert.equal(typeof bridge.act, 'function', 'bridge.act');

// 2) page/agent-dom.js defines window.__sbSee / __sbAct and they run on a DOM
const dom = fs.readFileSync(path.join(__dirname, '..', 'page', 'agent-dom.js'), 'utf8');
let clicked = false;
const el = {
  tagName: 'BUTTON', type: '', value: '',
  getAttribute: () => null, setAttribute: () => {}, closest: () => null,
  textContent: 'Checkout £12.99', getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 10 }),
  focus() {}, click() { clicked = true; }, dispatchEvent() {},
};
const ctx = {
  window: {}, document: { querySelectorAll: () => [el], querySelector: () => el, body: { innerText: 'Buy the widget' }, title: 'Shop' },
  location: { href: 'https://shop.example/', origin: 'https://shop.example' },
  HTMLInputElement: function () {}, HTMLTextAreaElement: function () {}, Event: function () {}, URL,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(dom, ctx);

assert.equal(typeof ctx.window.__sbSee, 'function', '__sbSee defined');
assert.equal(typeof ctx.window.__sbAct, 'function', '__sbAct defined');

const snap = ctx.window.__sbSee();
assert.equal(snap.origin, 'https://shop.example', 'snapshot origin');
assert.equal(snap.items.length, 1, 'one item');
assert.equal(snap.items[0].isSubmit, true, 'purchase-looking control flagged submit');
assert.equal(snap.items[0].cost, 1299, 'price scraped to pence');   // £12.99 -> 1299

const r = ctx.window.__sbAct({ op: 'click', ref: 0 });
assert.equal(r.done, true, 'act click done');
assert.equal(clicked, true, 'the real element was clicked');

console.log('✓ desktop smoke OK — bridge loads the shared page script; SEE/ACT define and run (price £12.99 → 1299).');
