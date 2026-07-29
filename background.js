// background.js — the service worker that HOLDS THE GOVERNOR.
//
// This is where the pure kernel meets the browser. The kernel decides; this file
// supplies the impure edges the kernel refuses to touch: the clock (Date.now),
// the page facts (from content.js), token custody, and the audit sink. Every path
// an agent could act through funnels into propose() -> verdict() -> (maybe) act.
//
// The agent (the sidepanel rail, or later an LLM) can only PROPOSE. It cannot arm,
// halt, grant a permission, raise a cap, or mint a consent token — those are
// control-plane messages that originate from the side panel (the user), never from
// a page event. That boundary is invariant I8/I25 made physical.

import {
  verdict, classifyAction, payloadHash, initState,
  killswitchTrip, killswitchRearm, applyPermChange, reserveSpend, commitSpend,
  grantConsent, consumeConsent,
} from './kernel/governor.mjs';
import { AuditLedger } from './kernel/envelope.mjs';

// ── governor state (in-memory; perms persisted to chrome.storage) ──────────────
let gov = initState({ currency: 'GBP', globalCap: 20000 });   // £200 global cap default
const ledger = new AuditLedger();
const pending = new Map();                                     // id -> { observed, hash, tabId, action }
let pendingSeq = 0;

const now = () => Date.now();
const audit = (kind, payload) => { const e = ledger.append({ kind, actor: 'governor', payload, ts: now() }); notifyPanel(); return e; };

async function loadPerms() {
  const { permTable } = await chrome.storage.local.get('permTable');
  if (permTable) gov = { ...gov, permTable };
}
loadPerms();

// ── bridge-observe: turn (page item + agent intent) into OBSERVED FACTS ─────────
// The kind is derived from what the control ACTUALLY is (item.isSubmit / isSend /
// crossOrigin / field), never from the agent's word. This is the anti-injection core.
function deriveObserved(item, intent, pageOrigin) {
  const base = { effectiveOrigin: item ? item.origin : pageOrigin, provenance: intent.provenance || 'user',
                 isCrossSite: !!(item && item.crossOrigin), field: item && item.field, cost: intent.cost, currency: 'GBP' };
  if (intent.op === 'scroll' || intent.op === 'read') return { ...base, kind: 'read' };
  if (intent.op === 'type') return { ...base, kind: 'type_normal' };   // classifier upgrades if field is sensitive
  if (intent.op === 'navigate') {
    let cross = false; try { cross = new URL(intent.target).origin !== pageOrigin; } catch {}
    return { ...base, kind: cross ? 'navigate_cross' : 'navigate_same', isCrossSite: cross, effectiveOrigin: pageOrigin };
  }
  if (intent.op === 'click') {
    if (item && /pay|buy|checkout|order|place|purchase/i.test(item.text)) return { ...base, kind: 'purchase' };
    if (item && item.isSend) return { ...base, kind: 'send_message' };
    if (item && item.isSubmit) return { ...base, kind: 'submit_write' };
    if (item && item.crossOrigin) return { ...base, kind: 'navigate_cross' };
    return { ...base, kind: 'click_link' };
  }
  return { ...base, kind: 'unknown' };
}

async function tabSee(tabId) {
  return chrome.tabs.sendMessage(tabId, { cmd: 'see' });
}

// ── propose: the ONE way an action reaches the page ─────────────────────────────
async function propose({ tabId, intent }) {
  const snap = await tabSee(tabId).catch(() => null);
  if (!snap) return { class: 'block', reason: 'no page snapshot' };
  const item = typeof intent.ref === 'number' ? snap.items.find(i => i.ref === intent.ref) : null;
  const observed = deriveObserved(item, intent, snap.origin);
  const d = classifyAction(observed);

  const v = verdict({ observed, agentLabel: intent.op }, { ...gov, killswitch: gov.killswitch }, now());
  audit('decision', { intent, observed: { kind: d.kind, origin: d.effectiveOrigin }, verdict: v });

  if (v.class === 'allow') { await execute(tabId, intent, d); return v; }
  if (v.class === 'confirm') {                    // hold for OOB user consent from the side panel
    const id = `c${++pendingSeq}`;
    const hash = payloadHash({ kind: d.kind, origin: d.effectiveOrigin, cost: d.cost, currency: d.currency });
    pending.set(id, { observed, hash, tabId, intent, descriptor: d });
    audit('confirm_request', { id, kind: d.kind, origin: d.effectiveOrigin, cost: d.cost });
    return { ...v, pendingId: id };
  }
  return v;                                        // block — already audited
}

// ── consent: user approves a pending confirm IN THE SIDE PANEL (control plane) ──
// grantConsent writes the consent into host-controlled state — the ONLY way a
// confirm becomes allow. The agent never supplies a token; it cannot write state.
async function consent(id) {
  const p = pending.get(id);
  if (!p) return { ok: false, reason: 'no such pending action' };
  gov = grantConsent(gov, p.hash, `con_${id}`, now() + 60000);       // user grants (OOB, control plane)
  const v = verdict({ observed: p.observed }, gov, now());
  if (v.class !== 'allow') { gov = consumeConsent(gov, p.hash); audit('verdict_block', { id, reason: v.reason }); pending.delete(id); return { ok: false, reason: v.reason }; }
  if (p.descriptor.spend) gov = { ...gov, spend: reserveSpend(gov.spend, ledger.seq, p.descriptor.effectiveOrigin, p.descriptor.cost || 0) };
  audit('consent_granted', { id, kind: p.descriptor.kind });
  await execute(p.tabId, p.intent, p.descriptor);
  if (p.descriptor.spend) gov = { ...gov, spend: commitSpend(gov.spend, ledger.seq - 1) };
  gov = consumeConsent(gov, p.hash);                                 // single-use: consent gone after emit
  pending.delete(id);
  return { ok: true };
}

async function execute(tabId, intent, descriptor) {
  const r = await chrome.tabs.sendMessage(tabId, { cmd: 'act', action: intent }).catch(e => ({ error: String(e) }));
  audit('effect_emitted', { kind: descriptor.kind, origin: descriptor.effectiveOrigin, result: r });
  return r;
}

// ── control plane: side-panel-only messages (the user, out of band) ─────────────
function notifyPanel() { chrome.runtime.sendMessage({ evt: 'state', state: snapshotState() }).catch(() => {}); }
function snapshotState() {
  return {
    killswitch: gov.killswitch, permTable: gov.permTable, permsEpoch: gov.permsEpoch,
    spend: { currency: gov.spend.currency, global_cap: gov.spend.global_cap, global_total: gov.spend.global_total,
             per_site: gov.spend.per_site },
    pending: [...pending.entries()].map(([id, p]) => ({ id, kind: p.descriptor.kind, origin: p.descriptor.effectiveOrigin, cost: p.descriptor.cost })),
    audit: ledger.entries.slice(-40),
  };
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    switch (msg.cmd) {
      case 'arm':    gov = { ...gov, killswitch: killswitchRearm({ state: 'HALTED', killEpoch: gov.killswitch.killEpoch }, gov.killswitch.killEpoch + 1) };
                     audit('killswitch_transition', { to: 'ARMED' }); reply(snapshotState()); break;
      case 'halt':   gov = { ...gov, killswitch: killswitchTrip(gov.killswitch, msg.reason || 'user_halt') };
                     audit('killswitch_transition', { to: 'HALTED' }); reply(snapshotState()); break;
      case 'setPerm': { gov = applyPermChange(gov, msg.origin, msg.perm);
                        await chrome.storage.local.set({ permTable: gov.permTable });
                        audit('perm_changed', { origin: msg.origin, perm: msg.perm }); reply(snapshotState()); break; }
      case 'setCap': { const per = { ...gov.spend.per_site, [msg.origin]: { cap: msg.cap, total: (gov.spend.per_site[msg.origin] || {}).total || 0 } };
                       gov = { ...gov, spend: { ...gov.spend, per_site: per } };
                       audit('cap_changed', { origin: msg.origin, cap: msg.cap }); reply(snapshotState()); break; }
      case 'propose': reply(await propose(msg)); break;
      case 'consent': reply(await consent(msg.id)); break;
      case 'getState': reply(snapshotState()); break;
      default: reply({ error: 'unknown cmd' });
    }
  })();
  return true;
});

// open the side panel when the toolbar icon is clicked
chrome.action?.onClicked.addListener((tab) => chrome.sidePanel?.open({ tabId: tab.id }).catch(() => {}));
