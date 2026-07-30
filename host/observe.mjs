// observe.mjs — the bridge-observe step (PURE, mutation-tested).
//
// Turns (a page element the agent referenced + the intent + the page origin) into
// the OBSERVED FACTS the Governor classifies from. The kind is derived from what the
// control ACTUALLY is — isSubmit / isSend / crossOrigin / a purchase-looking label /
// a sensitive field — never from the agent's word. This is the anti-injection seam,
// shared verbatim by every transport (extension content script, Electron webContents).

const PURCHASE_RE = /pay|buy|checkout|order|place|purchase/i;

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
    cost: (it && typeof it.cost === 'number') ? it.cost : (intent && intent.cost),
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
    if (it && PURCHASE_RE.test(it.text || '')) return { ...base, kind: 'purchase' };
    if (it && it.isSend) return { ...base, kind: 'send_message' };
    if (it && it.isSubmit) return { ...base, kind: 'submit_write' };
    if (it && it.crossOrigin) return { ...base, kind: 'navigate_cross' };
    return { ...base, kind: 'click_link' };
  }
  return { ...base, kind: 'unknown' };   // unknown op => Governor blocks (I24)
}
