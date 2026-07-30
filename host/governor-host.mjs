// governor-host.mjs — the Governor's HOST, shared by every transport.
//
// It supplies the impure edges the pure kernel refuses to touch: the clock, the page
// facts, consent custody, the audit sink, the LLM. Every path an agent could act
// through funnels into propose() -> verdict() -> (maybe) act. The agent can only
// PROPOSE; arm/halt/perm/cap/consent are control-plane calls that come from the UI
// (the user), never from a page event (I8/I25).
//
// Transports wire their own { see, act, emit, llm } and get the SAME governed brain:
//   · the extension (background.js)  -> chrome.tabs messaging + chrome.storage
//   · the desktop app (desktop/main) -> Electron webContents.executeJavaScript
// This module is the concrete proof that the Governor is transport-agnostic.

import {
  verdict, classifyAction, payloadHash, initState,
  killswitchTrip, killswitchRearm, applyPermChange, reserveSpend, commitSpend,
  grantConsent, consumeConsent,
} from '../kernel/governor.mjs';
import { AuditLedger } from '../kernel/envelope.mjs';
import { runAgent } from '../agent/loop.mjs';
import { deriveObserved } from './observe.mjs';

// makeHost(deps) — deps:
//   see()                     -> page snapshot { origin, items, ... } (async)
//   act(intent, descriptor)   -> perform an approved action, return a result (async)
//   now()                     -> ms timestamp   (default Date.now)
//   emit(evt)                 -> UI sink for { evt:'state'|'agent', ... }
//   llm()                     -> async () => a model client or null (BYOK)
//   persistPerms(permTable)   -> optional async persistence
export function makeHost(deps = {}) {
  const { see, act, now = () => Date.now(), emit = () => {}, llm = async () => null, persistPerms = async () => {} } = deps;

  let gov = initState({ currency: 'GBP', globalCap: 20000 });   // £200 default global cap
  const ledger = new AuditLedger();
  const pending = new Map();
  let pendingSeq = 0;
  let activeGoal = null;

  const audit = (kind, payload) => { const e = ledger.append({ kind, actor: 'governor', payload, ts: now() }); emit({ evt: 'state', state: snapshotState() }); return e; };

  async function execute(intent, descriptor) {
    const r = await Promise.resolve(act(intent, descriptor)).catch(e => ({ error: String(e && e.message || e) }));
    audit('effect_emitted', { kind: descriptor.kind, origin: descriptor.effectiveOrigin, result: r });
    return r;
  }

  // propose — the ONE way an action reaches the page. Gates + audits, executes an allow.
  async function propose(intent) {
    const snap = await Promise.resolve(see()).catch(() => null);
    if (!snap) return { class: 'block', reason: 'no page snapshot' };
    const item = (intent && typeof intent.ref === 'number') ? (snap.items || []).find(i => i.ref === intent.ref) : null;
    const observed = deriveObserved(item, intent || {}, snap.origin);
    const d = classifyAction(observed);
    const v = verdict({ observed, agentLabel: intent && intent.op }, gov, now());
    audit('decision', { intent, observed: { kind: d.kind, origin: d.effectiveOrigin }, verdict: v });

    if (v.class === 'allow') { await execute(intent, d); return v; }
    if (v.class === 'confirm') {
      const id = `c${++pendingSeq}`;
      const hash = payloadHash({ kind: d.kind, origin: d.effectiveOrigin, cost: d.cost, currency: d.currency });
      pending.set(id, { observed, hash, intent, descriptor: d });
      audit('confirm_request', { id, kind: d.kind, origin: d.effectiveOrigin, cost: d.cost });
      return { ...v, pendingId: id };
    }
    return v;   // block — already audited
  }

  // consent — the user approves a pending confirm from the UI (control plane). This is
  // the only way a confirm becomes allow: grantConsent writes it into host state, which
  // the agent cannot touch. Resumes the agent loop after the approved action fires.
  async function consent(id) {
    const p = pending.get(id);
    if (!p) return { ok: false, reason: 'no such pending action' };
    gov = grantConsent(gov, p.hash, `con_${id}`, now() + 60000);
    const v = verdict({ observed: p.observed }, gov, now());
    if (v.class !== 'allow') { gov = consumeConsent(gov, p.hash); audit('verdict_block', { id, reason: v.reason }); pending.delete(id); return { ok: false, reason: v.reason }; }
    if (p.descriptor.spend) gov = { ...gov, spend: reserveSpend(gov.spend, ledger.seq, p.descriptor.effectiveOrigin, p.descriptor.cost || 0) };
    audit('consent_granted', { id, kind: p.descriptor.kind });
    await execute(p.intent, p.descriptor);
    if (p.descriptor.spend) gov = { ...gov, spend: commitSpend(gov.spend, ledger.seq - 1) };
    gov = consumeConsent(gov, p.hash);
    pending.delete(id);
    if (activeGoal) runGoal(activeGoal);   // resume the loop after approval
    return { ok: true };
  }

  // the agent loop — SEE -> THINK(LLM) -> PROPOSE(Governor) -> ACT. The model only proposes.
  async function runGoal(goal) {
    const client = await llm();
    if (!client) { emit({ evt: 'agent', type: 'need_key' }); return { ok: false, reason: 'set an LLM key first' }; }
    activeGoal = goal;
    const state = await runAgent({
      goal, budget: 14,
      deps: { see: () => see(), llm: client, propose: (intent) => propose(intent), onEvent: (e) => emit({ evt: 'agent', ...e }) },
    });
    if (state.phase !== 'awaiting_consent') activeGoal = null;
    return { ok: true, phase: state.phase };
  }
  function stopGoal() { activeGoal = null; audit('agent_stopped', {}); return { ok: true }; }

  // control plane — user-only. Never reachable from the verdict/action path.
  function arm() { gov = { ...gov, killswitch: killswitchRearm({ state: 'HALTED', killEpoch: gov.killswitch.killEpoch }, gov.killswitch.killEpoch + 1) }; audit('killswitch_transition', { to: 'ARMED' }); return snapshotState(); }
  function halt(reason) { gov = { ...gov, killswitch: killswitchTrip(gov.killswitch, reason || 'user_halt') }; audit('killswitch_transition', { to: 'HALTED' }); return snapshotState(); }
  async function setPerm(origin, perm) { gov = applyPermChange(gov, origin, perm); await persistPerms(gov.permTable); audit('perm_changed', { origin, perm }); return snapshotState(); }
  function setCap(origin, cap) { const per = { ...gov.spend.per_site, [origin]: { cap, total: (gov.spend.per_site[origin] || {}).total || 0 } }; gov = { ...gov, spend: { ...gov.spend, per_site: per } }; audit('cap_changed', { origin, cap }); return snapshotState(); }
  function loadPerms(permTable) { if (permTable) gov = { ...gov, permTable }; }

  function snapshotState() {
    return {
      killswitch: gov.killswitch, permTable: gov.permTable, permsEpoch: gov.permsEpoch,
      spend: { currency: gov.spend.currency, global_cap: gov.spend.global_cap, global_total: gov.spend.global_total, per_site: gov.spend.per_site },
      pending: [...pending.entries()].map(([id, p]) => ({ id, kind: p.descriptor.kind, origin: p.descriptor.effectiveOrigin, cost: p.descriptor.cost })),
      audit: ledger.entries.slice(-40),
    };
  }

  return { propose, consent, runGoal, stopGoal, arm, halt, setPerm, setCap, loadPerms, snapshotState };
}
