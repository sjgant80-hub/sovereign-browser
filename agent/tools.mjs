// tools.mjs — the PURE core of the agent loop (no I/O, mutation-tested).
//
// The loop is SEE -> THINK(LLM) -> PROPOSE -> (Governor) -> ACT. The LLM's job is
// only to pick the next action from what it observes. Its output is DATA, never
// authority: everything it proposes is normalized here and then handed to the
// Governor, which decides. This file is the normalizing + control layer, kept pure
// so `witness` can prove it, and so a prompt-injected model cannot smuggle a
// malformed or over-privileged action past the type boundary.

// The single tool the model calls each turn (Anthropic tool-use shape; an
// OpenAI-compatible function schema is derivable from the same fields).
export const AGENT_OPS = ['read', 'click', 'type', 'scroll', 'navigate', 'done'];
export const ACTION_TOOL = {
  name: 'browser_action',
  description: 'Take ONE action toward the goal, or finish. You never confirm or spend on your own — the Governor gates every action and the user approves anything consequential.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'rationale'],
    properties: {
      op: { type: 'string', enum: AGENT_OPS, description: 'read=re-observe; click/type/scroll target an element by ref; navigate a url; done when the goal is met or impossible' },
      ref: { type: 'integer', description: 'index of the target element from the latest snapshot (for click/type/scroll)' },
      text: { type: 'string', description: 'text to type (op=type)' },
      target: { type: 'string', description: 'url to navigate to (op=navigate)' },
      rationale: { type: 'string', description: 'one short sentence: why this action serves the goal' },
      done_reason: { type: 'string', description: 'when op=done: what was accomplished, or why it cannot proceed' },
    },
  },
};

// toIntent — normalize an LLM tool call into a bounded intent. TOTAL: any garbage
// call becomes a safe { op:'invalid' } that the loop treats as a stop, never a
// synthetic event. The agent chooses ref/op/text only; the bridge (not the model)
// resolves what that element actually IS, so the Governor still classifies from truth.
export function toIntent(call) {
  const c = (call && typeof call === 'object') ? call : {};
  const op = AGENT_OPS.includes(c.op) ? c.op : 'invalid';
  if (op === 'invalid' || op === 'done') return { op, rationale: safeStr(c.rationale, 200), done_reason: safeStr(c.done_reason, 300) };
  // provenance='user': the user launched this goal. Consequential acts still CONFIRM
  // and prohibited still BLOCKs by CLASS, so containment does not rest on provenance.
  const intent = { op, provenance: 'user', rationale: safeStr(c.rationale, 200) };
  if (Number.isInteger(c.ref) && c.ref >= 0) intent.ref = c.ref;
  if (op === 'type') intent.text = safeStr(c.text, 4000);
  if (op === 'navigate') intent.target = safeStr(c.target, 2000);
  return intent;
}
function safeStr(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }

// interpretVerdict — turn a Governor verdict into the loop's next move. The loop
// NEVER acts here; the Governor already executed an allow and audited everything.
export function interpretVerdict(v) {
  if (!v || typeof v !== 'object') return { next: 'stop', reason: 'no verdict' };
  if (v.class === 'allow') return { next: 'continue', reason: v.reason };
  if (v.class === 'confirm') return { next: 'await_consent', reason: v.reason, pendingId: v.pendingId || null };
  return { next: 'feedback', reason: v.reason || 'blocked' };   // block -> tell the model, keep going
}

// summarizeSnapshot — trim a page snapshot to what the model needs, bounding size
// so a hostile page cannot blow the context. Pure.
export function summarizeSnapshot(snap, { maxItems = 60, maxText = 4000 } = {}) {
  const s = snap || {};
  const items = Array.isArray(s.items) ? s.items.slice(0, maxItems).map(it => ({
    ref: it.ref, text: safeStr(it.text, 80),
    kind: it.isSubmit ? 'submit' : it.isSend ? 'send' : it.href ? 'link' : it.field ? 'field' : 'control',
    crossOrigin: !!it.crossOrigin,
  })) : [];
  return { url: safeStr(s.url, 300), title: safeStr(s.title, 200), text: safeStr(s.text, maxText), items };
}

// loop control — a small pure state machine so the runner stays a thin shell.
export function initLoop({ goal, budget = 12 } = {}) {
  return { phase: 'running', goal: safeStr(goal, 2000), steps: 0, budget: Math.max(1, budget | 0), history: [], last: null };
}
// advance() folds one (intent, verdict-interpretation) into the loop state. Pure.
export function advance(state, intent, decision) {
  const st = { ...state, history: [...state.history, { intent, decision }], last: { intent, decision }, steps: state.steps + 1 };
  if (intent.op === 'done') st.phase = 'done';
  else if (intent.op === 'invalid') st.phase = 'stopped';
  else if (decision.next === 'await_consent') st.phase = 'awaiting_consent';
  else if (decision.next === 'stop') st.phase = 'stopped';
  else if (st.steps >= st.budget) st.phase = 'budget_exhausted';
  else st.phase = 'running';
  return st;
}
export function isRunning(state) { return !!state && state.phase === 'running'; }
