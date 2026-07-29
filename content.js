// content.js — the agent's eyes and hands INSIDE the page (the easy transport).
//
// No CDP, no Electron, no engine to wrap: this is a content script riding in the
// user's own Chrome, on the user's own logged-in session. It does exactly two jobs
// and NO deciding — deciding is the Governor's, in the background service worker.
//
//   SEE  — snapshot the interactive elements + text, and (crucially) the OBSERVED
//          FACTS about each control (is it a submit? a payment field? cross-origin?)
//          so the Governor classifies from truth, not the agent's label.
//   ACT  — execute a single pre-approved action the background sent down. It never
//          runs unless the Governor already returned allow/confirmed.

const SEL = 'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[type="submit"]';

function fieldFacts(el) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return null;
  return { type: el.type || '', autocomplete: el.autocomplete || '', name: el.name || '' };
}

// Is this control one that commits/writes/pays? Observed from the element, not claimed.
function observeControl(el) {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const form = el.closest('form');
  const isSubmit = type === 'submit' || (tag === 'button' && (el.type === 'submit' || !el.type)) ||
    /pay|buy|checkout|order|place|purchase|subscribe/i.test(el.textContent || '');
  const isSend = /send|post|publish|reply|tweet|share|submit/i.test(el.textContent || '') && !!form;
  const href = el.getAttribute('href') || null;
  let crossOrigin = false;
  try { if (href) crossOrigin = new URL(href, location.href).origin !== location.origin; } catch {}
  return { tag, isSubmit, isSend, href, crossOrigin, field: fieldFacts(el), origin: location.origin };
}

function see() {
  const els = Array.from(document.querySelectorAll(SEL)).slice(0, 300);
  const items = els.map((el, i) => {
    el.setAttribute('data-sb-ref', String(i));            // stable ref for a later ACT
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
}

// Execute ONE approved action. Returns {done} — throws are reported, never swallowed.
function act(a) {
  const el = document.querySelector(`[data-sb-ref="${a.ref}"]`);
  if (!el && a.op !== 'navigate') return { done: false, error: 'ref not found' };
  switch (a.op) {
    case 'click': el.click(); return { done: true };
    case 'type':
      el.focus();
      if ('value' in el) { el.value = a.text; el.dispatchEvent(new Event('input', { bubbles: true }));
                           el.dispatchEvent(new Event('change', { bubbles: true })); }
      else { el.textContent = a.text; }
      return { done: true };
    case 'scroll': (el || document.scrollingElement).scrollBy(0, a.dy || 400); return { done: true };
    case 'navigate': location.assign(a.target); return { done: true };
    default: return { done: false, error: 'unknown op' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  try {
    if (msg.cmd === 'see') reply(see());
    else if (msg.cmd === 'act') reply(act(msg.action));   // only reached AFTER a Governor allow
    else reply({ error: 'unknown cmd' });
  } catch (e) { reply({ error: String(e && e.message || e) }); }
  return true;                                             // async reply
});
