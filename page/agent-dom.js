// agent-dom.js — the agent's eyes and hands, in PAGE context. ONE copy, shared:
//   · the extension injects it as a content script (manifest, before content.js)
//   · the desktop app injects it into a tab via webContents.executeJavaScript
// It defines window.__sbSee() and window.__sbAct(action) and does no deciding — the
// Governor (in the extension service worker / the Electron main process) decides; this
// only observes the page and executes an action the Governor already allowed.
(() => {
  if (window.__sbSee) return;   // idempotent: safe to inject more than once

  const SEL = 'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[type="submit"]';

  // ⚑ SHARED VOCABULARY — kept byte-identical to PURCHASE_RE in host/observe.mjs.
  // This file is injected into page context and cannot import a module, so the pattern
  // has to be written twice. It was already written twice and had already drifted: this
  // one had `place|order` bare and no `top up|donate|reserve`, the other had `purchase`.
  // The test 'the page observer and the host share one purchase vocabulary' reads this
  // literal and fails the build if the two ever part again. Do not edit one alone.
  // __PURCHASE_RE_BEGIN__
  const PURCHASE_RE = /\b(?:pay|paying|pre-?order|buy|buying|purchase|purchasing|checkout|check\s?out|subscribe|donate|rent|reserve|top\s?-?\s?up|deposit|tip)\b|\b(?:place|complete|confirm|submit|finish|authorise|authorize)\s+(?:the\s+|my\s+|your\s+)?(?:order|purchase|payment|booking|checkout|transaction)\b|\b(?:add\s+to\s+(?:cart|bag|basket)|order\s+now|book\s+now|buy\s+now|proceed\s+to\s+(?:pay|checkout))\b/i;
  // __PURCHASE_RE_END__

  function fieldFacts(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return null;
    return { type: el.type || '', autocomplete: el.autocomplete || '', name: el.name || '' };
  }

  // Parse an observed price into integer minor units (pence/cents). Best-effort: the
  // Governor fails the cap CLOSED when no price is visible, so a miss is safe, never a
  // bypass.
  function priceIn(text) {
    const m = String(text || '').match(/[£$€]\s?(\d{1,6})(?:[.,](\d{2}))?/);
    return m ? parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0) : undefined;
  }

  // A price ON the control is a fact about that control. A price in the surrounding
  // cart or checkout row is the page's total, and it belongs to the control that COMMITS
  // the form — not to the Cancel link sitting next to it. So the container is only
  // consulted for controls that commit something; otherwise every link inside a checkout
  // would inherit the total, and the user would face a purchase confirm for pressing Back.
  function observePrice(el, useContainer) {
    const own = priceIn(el.textContent);
    if (own !== undefined || !useContainer) return own;
    const scope = el.closest('form,[class*="cart" i],[class*="checkout" i],[class*="total" i]');
    return scope ? priceIn(scope.textContent) : undefined;
  }

  // Which controls are worth pricing: things a person clicks to commit something. Not
  // text inputs, textareas or selects — you do not spend money by typing into a box, and
  // pricing all 300 elements on a heavy page is wasted work.
  const CLICKABLE = new Set(['a', 'button']);
  const isClickable = (el, tag, type) =>
    CLICKABLE.has(tag) || type === 'submit' || type === 'button' ||
    ['button', 'link'].includes((el.getAttribute('role') || '').toLowerCase());

  // Observed facts about a control — what it IS, not what the agent claims.
  function observeControl(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const form = el.closest('form');
    const looksPay = PURCHASE_RE.test(el.textContent || '');
    const isSubmit = type === 'submit' || (tag === 'button' && (el.type === 'submit' || !el.type)) || looksPay;
    const isSend = /send|post|publish|reply|tweet|share|submit/i.test(el.textContent || '') && !!form;
    const href = el.getAttribute('href') || null;
    let crossOrigin = false;
    try { if (href) crossOrigin = new URL(href, location.href).origin !== location.origin; } catch (e) {}
    const out = { tag, isSubmit, isSend, href, crossOrigin, field: fieldFacts(el), origin: location.origin };
    // ⚑ The price used to be scraped only `if (looksPay)` — only for controls that already
    // said one of the magic words. The host treats an observed price as proof that a click
    // spends money, so gating the price on the label handed the label back its authority:
    // a checkout button reading "Get it now" was never priced, so it was never a purchase,
    // so it was allowed outright with no cap check. Every clickable control is priced now;
    // whether it is a purchase is the host's decision, made on the facts collected here.
    if (isClickable(el, tag, type)) { const c = observePrice(el, isSubmit || looksPay); if (c !== undefined) out.cost = c; }
    return out;
  }

  // SEE — snapshot interactive elements (tagged with a stable ref) + text.
  window.__sbSee = function () {
    const els = Array.from(document.querySelectorAll(SEL)).slice(0, 300);
    const items = els.map((el, i) => {
      el.setAttribute('data-sb-ref', String(i));
      const r = el.getBoundingClientRect();
      return {
        ref: i,
        text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
        ...observeControl(el),
        rect: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
      };
    });
    return { url: location.href, origin: location.origin, title: document.title,
             text: document.body ? document.body.innerText.slice(0, 8000) : '', items };
  };

  // ACT — execute ONE approved action. Only ever called after a Governor allow.
  window.__sbAct = function (a) {
    const el = document.querySelector('[data-sb-ref="' + a.ref + '"]');
    if (!el && a.op !== 'navigate') return { done: false, error: 'ref not found' };
    switch (a.op) {
      case 'click': el.click(); return { done: true };
      case 'type':
        el.focus();
        if ('value' in el) { el.value = a.text; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
        else { el.textContent = a.text; }
        return { done: true };
      case 'scroll': (el || document.scrollingElement).scrollBy(0, a.dy || 400); return { done: true };
      case 'navigate': location.assign(a.target); return { done: true };
      default: return { done: false, error: 'unknown op' };
    }
  };
})();
