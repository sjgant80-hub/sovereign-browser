// agent-dom.js — the agent's eyes and hands, in PAGE context. ONE copy, shared:
//   · the extension injects it as a content script (manifest, before content.js)
//   · the desktop app injects it into a tab via webContents.executeJavaScript
// It defines window.__sbSee() and window.__sbAct(action) and does no deciding — the
// Governor (in the extension service worker / the Electron main process) decides; this
// only observes the page and executes an action the Governor already allowed.
(() => {
  if (window.__sbSee) return;   // idempotent: safe to inject more than once

  const SEL = 'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[type="submit"]';

  function fieldFacts(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return null;
    return { type: el.type || '', autocomplete: el.autocomplete || '', name: el.name || '' };
  }

  // Parse an observed price near a control into integer minor units (pence/cents).
  // Best-effort: the Governor fails the cap CLOSED if no price is visible, so a miss
  // is safe, never a bypass. Looks at the control and its nearest cart/total row.
  function observePrice(el) {
    const scope = el.closest('form,[class*="cart" i],[class*="checkout" i],[class*="total" i]') || el;
    const m = String(scope.textContent || '').match(/[£$€]\s?(\d{1,6})(?:[.,](\d{2}))?/);
    if (!m) return undefined;
    return parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0);
  }

  // Observed facts about a control — what it IS, not what the agent claims.
  function observeControl(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const form = el.closest('form');
    const looksPay = /pay|buy|checkout|order|place|purchase|subscribe/i.test(el.textContent || '');
    const isSubmit = type === 'submit' || (tag === 'button' && (el.type === 'submit' || !el.type)) || looksPay;
    const isSend = /send|post|publish|reply|tweet|share|submit/i.test(el.textContent || '') && !!form;
    const href = el.getAttribute('href') || null;
    let crossOrigin = false;
    try { if (href) crossOrigin = new URL(href, location.href).origin !== location.origin; } catch (e) {}
    const out = { tag, isSubmit, isSend, href, crossOrigin, field: fieldFacts(el), origin: location.origin };
    if (looksPay) { const c = observePrice(el); if (c !== undefined) out.cost = c; }
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
