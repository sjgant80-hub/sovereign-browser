// observe.mjs — the bridge-observe step (PURE, mutation-tested).
//
// Turns (a page element the agent referenced + the intent + the page origin) into
// the OBSERVED FACTS the Governor classifies from. The kind is derived from what the
// control ACTUALLY is — isSubmit / isSend / crossOrigin / a purchase-looking label /
// a sensitive field — never from the agent's word. This is the anti-injection seam,
// shared verbatim by every transport (extension content script, Electron webContents).

// A purchase control is recognised two ways, and the WORD is the weaker of them.
//
// ⚑ This was one bare alternation of six unanchored words, and it was the ONLY route
// to kind 'purchase' — the only kind the spend cap is checked on. It failed in both
// directions. Unanchored, `place` fired on "Marketplace" and "Replace", `order` on
// "Order history" and "Sort order", `pay` on "Payment history" — read-only links
// demanding a purchase confirm, which is how people learn to click through the rail.
// And a checkout button that simply does not use one of the six words — "Complete",
// "Confirm", "Subscribe", "Donate", "Top up", "Book now", "Get it now" — was never a
// purchase at all: it fell through to submit_write, or to click_link, which is ALLOW.
// A one-click buy on any site whose button says "Get it now" spent money with no
// confirm and no cap check.
//
// So the vocabulary below is bounded and widened, and — the part that actually closes
// it — an observed price attached to the control is treated as a purchase regardless of
// what the control is called. A price is a fact the bridge read off the page; the label
// is a word someone chose. Where they disagree, the fact wins.
const PURCHASE_RE = new RegExp([
  // `payment` is deliberately NOT here on its own — "Payment history" and "Payment
  // methods" are pages you read. It is reachable only through the verb phrases below
  // ("Authorise payment", "Confirm payment"), where a verb makes it an action.
  '\\b(?:pay|paying|pre-?order|buy|buying|purchase|purchasing|checkout|check\\s?out',
  '|subscribe|donate|rent|reserve|top\\s?-?\\s?up|deposit|tip)\\b',
  '|\\b(?:place|complete|confirm|submit|finish|authorise|authorize)\\s+(?:the\\s+|my\\s+|your\\s+)?',
  '(?:order|purchase|payment|booking|checkout|transaction)\\b',
  '|\\b(?:add\\s+to\\s+(?:cart|bag|basket)|order\\s+now|book\\s+now|buy\\s+now|proceed\\s+to\\s+(?:pay|checkout))\\b',
].join(''), 'i');

// page/agent-dom.js runs in page context and cannot import this module, so it carries the
// same pattern as a literal. That is two lists that can part, so they are not trusted to
// stay together: test/host.test.mjs reads that file and fails if its literal is not this
// exact source. Exported for that test, and for anything else that needs the vocabulary.
export const PURCHASE_PATTERN = PURCHASE_RE.source;

// A price the bridge read off the control itself. Zero is not a purchase; a negative or
// non-finite number is not a price at all.
const hasObservedPrice = (it) => !!it && typeof it.cost === 'number' && Number.isFinite(it.cost) && it.cost > 0;

export function deriveObserved(item, intent, pageOrigin) {
  const it = item || null;
  const base = {
    effectiveOrigin: it ? it.origin : pageOrigin,
    provenance: (intent && intent.provenance) === 'user' ? 'user' : 'observed_content',
    isCrossSite: !!(it && it.crossOrigin),
    field: it && it.field,
    // cost is an OBSERVED page fact (the amount on the control/checkout surface),
    // scraped by the bridge — not the agent's word. Absent => the Governor fails
    // the cap closed (I15), so a purchase with no visible price cannot slip through.
    //
    // ⚑ The comment above was right and the code under it did the opposite: it fell back
    // to the agent's own number whenever the page had none. The spend cap is checked
    // against this value, so an agent that wanted a £600 item could declare it cost 1p
    // and pass a £50 cap — the one number the whole cap gate rests on was supplied by the
    // party the gate exists to restrain. The fallback is gone. No observed price means no
    // number, and checkCap fails closed on 'amount_unbounded', which is what was promised.
    cost: (it && typeof it.cost === 'number') ? it.cost : undefined,
    currency: 'GBP',
  };
  const op = intent && intent.op;

  if (op === 'scroll' || op === 'read') return { ...base, kind: 'read' };
  if (op === 'type') return { ...base, kind: 'type_normal' };   // classifier upgrades if the field is sensitive
  if (op === 'navigate') {
    let cross = false;
    try { cross = new URL(intent.target).origin !== pageOrigin; } catch { cross = false; }
    return { ...base, kind: cross ? 'navigate_cross' : 'navigate_same', isCrossSite: cross, effectiveOrigin: pageOrigin };
  }
  if (op === 'click') {
    if (hasObservedPrice(it) || (it && PURCHASE_RE.test(it.text || ''))) return { ...base, kind: 'purchase' };
    if (it && it.isSend) return { ...base, kind: 'send_message' };
    if (it && it.isSubmit) return { ...base, kind: 'submit_write' };
    if (it && it.crossOrigin) return { ...base, kind: 'navigate_cross' };
    return { ...base, kind: 'click_link' };
  }
  return { ...base, kind: 'unknown' };   // unknown op => Governor blocks (I24)
}
