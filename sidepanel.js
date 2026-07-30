// sidepanel.js — the si-didy rail. Talks to the Governor (background.js) over
// chrome.runtime messages. Every button here is a CONTROL-PLANE action (arm/halt,
// grant a perm, approve a pending confirm) — the things the agent structurally
// cannot do. If chrome.* is absent (opened as a plain page), it runs a preview mock
// so the layout is inspectable without loading the extension.

const HAS_CHROME = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;

const send = (msg) => new Promise((res) => {
  if (!HAS_CHROME) return res(mockReply(msg));
  chrome.runtime.sendMessage(msg, res);
});

// ---- preview mock (no extension host) ---------------------------------------
let MOCK = {
  killswitch: { state: 'ARMED', killEpoch: 3 }, permsEpoch: 2,
  permTable: { 'shop.example': 'act' },
  spend: { currency: 'GBP', global_cap: 20000, global_total: 4250, per_site: { 'shop.example': { cap: 5000, total: 4250 } } },
  pending: [{ id: 'c1', kind: 'purchase', origin: 'shop.example', cost: 1299 }],
  audit: [
    { seq: 0, kind: 'decision', payload: { verdict: { class: 'allow', reason: 'allow:read' }, observed: { kind: 'read', origin: 'shop.example' } } },
    { seq: 1, kind: 'decision', payload: { verdict: { class: 'confirm', reason: 'awaiting_consent:purchase' }, observed: { kind: 'purchase', origin: 'shop.example' } } },
    { seq: 2, kind: 'confirm_request', payload: { kind: 'purchase', cost: 1299 } },
    { seq: 3, kind: 'decision', payload: { verdict: { class: 'block', reason: 'prohibited:fund_movement' }, observed: { kind: 'fund_movement', origin: 'bank.example' } } },
  ],
};
function mockReply(msg) {
  if (msg.cmd === 'halt') MOCK.killswitch = { state: 'HALTED', killEpoch: MOCK.killswitch.killEpoch + 1 };
  if (msg.cmd === 'arm') MOCK.killswitch = { state: 'ARMED', killEpoch: MOCK.killswitch.killEpoch + 1 };
  if (msg.cmd === 'setPerm') MOCK.permTable = { ...MOCK.permTable, [msg.origin]: msg.perm };
  if (msg.cmd === 'consent') { MOCK.pending = MOCK.pending.filter(p => p.id !== msg.id); return { ok: true }; }
  if (msg.cmd === 'propose') return { class: 'confirm', reason: 'awaiting_consent (preview)' };
  return MOCK;
}

const $ = (id) => document.getElementById(id);
const money = (p, cur) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'GBP' }).format((p || 0) / 100);
let currentOrigin = null;

async function currentTabOrigin() {
  if (!HAS_CHROME || !chrome.tabs) return 'shop.example';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { return new URL(tab.url).origin; } catch { return null; }
}

function render(st) {
  const armed = st.killswitch.state === 'ARMED';
  $('statusDot').style.background = armed ? 'var(--allow)' : 'var(--block)';
  $('ks').textContent = `${st.killswitch.state} · epoch ${st.killswitch.killEpoch}`;
  const kb = $('killBtn');
  kb.textContent = armed ? '■  HALT — freeze the agent' : '▶  ARM — allow the agent';
  kb.className = 'kill ' + (armed ? 'armed' : 'halted');

  $('site').textContent = currentOrigin || '—';
  const perm = (currentOrigin && st.permTable[currentOrigin]) || 'off';
  $('perm').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.perm === perm)));

  const s = st.spend;
  $('spendTxt').textContent = `${money(s.global_total, s.currency)} of ${money(s.global_cap, s.currency)}`;
  $('spendBar').style.width = Math.min(100, s.global_cap ? (s.global_total / s.global_cap) * 100 : 0) + '%';

  const pend = st.pending || [];
  $('pendingSection').hidden = pend.length === 0;
  $('pending').innerHTML = pend.map(p => `
    <div class="pending">
      <div><span class="k">${p.kind}</span> on <b>${p.origin}</b>${p.cost ? ' · ' + money(p.cost, s.currency) : ''}</div>
      <div class="acts"><button class="approve" data-consent="${p.id}">approve</button>
      <button class="deny" data-deny="${p.id}">deny</button></div>
    </div>`).join('');

  $('log').innerHTML = (st.audit || []).slice().reverse().map(e => {
    const v = e.payload && e.payload.verdict;
    const cls = v ? `v-${v.class}` : 'muted';
    const what = v ? `${e.payload.observed?.kind || ''} — ${v.reason}` : e.kind;
    return `<div class="e"><span class="muted">${e.seq}</span><span class="${cls}">${what}</span><span class="muted">${e.kind}</span></div>`;
  }).join('');
}

async function refresh() { render(await send({ cmd: 'getState' })); }

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.id === 'killBtn') { const st = await send({ cmd: 'getState' }); await send({ cmd: st.killswitch.state === 'ARMED' ? 'halt' : 'arm' }); refresh(); }
  else if (t.dataset.perm) { await send({ cmd: 'setPerm', origin: currentOrigin, perm: t.dataset.perm }); refresh(); }
  else if (t.dataset.consent) { await send({ cmd: 'consent', id: t.dataset.consent }); refresh(); }
  else if (t.dataset.deny) { const p = (await send({ cmd: 'getState' })).pending.find(x => x.id === t.dataset.deny); if (HAS_CHROME) await send({ cmd: 'getState' }); MOCK.pending = (MOCK.pending || []).filter(x => x.id !== t.dataset.deny); refresh(); }
  else if (t.id === 'runBtn') {
    const goal = $('goal').value.trim();
    if (!goal) return;
    const [tab] = HAS_CHROME && chrome.tabs ? await chrome.tabs.query({ active: true, currentWindow: true }) : [{ id: 0 }];
    logAgent(`▶ goal: ${goal}`);
    const r = await send({ cmd: 'run_goal', tabId: tab.id, goal });
    if (r && r.reason) logAgent(`· ${r.reason}`);
  }
  else if (t.id === 'stopBtn') { await send({ cmd: 'stop_goal' }); logAgent('■ stopped'); }
  else if (t.id === 'keyBtn') {
    const provider = (prompt('provider: anthropic | openai', 'anthropic') || '').trim();
    if (!provider) return;
    const apiKey = prompt(`${provider} API key (stored locally, never leaves your machine except to the model)`);
    if (!apiKey) return;
    const model = prompt('model id (blank = provider default)', provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-5') || undefined;
    await send({ cmd: 'setLLM', config: { provider, apiKey, model } });
    logAgent(`⚙ ${provider} key set`);
  }
  else if (t.id === 'proposeBtn') {
    const op = $('op').value, arg = $('arg').value;
    const [tab] = HAS_CHROME && chrome.tabs ? await chrome.tabs.query({ active: true, currentWindow: true }) : [{ id: 0 }];
    const intent = { op, ref: 0, provenance: 'user', ...(op === 'type' ? { text: arg } : {}), ...(op === 'navigate' ? { target: arg } : {}) };
    const v = await send({ cmd: 'propose', tabId: tab.id, intent });
    $('proposeOut').innerHTML = `<span class="v-${v.class}">${v.class}</span> — ${v.reason}`;
    refresh();
  }
});

function logAgent(line) {
  const el = $('agentOut'); if (!el) return;
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}
function showAgent(e) {
  if (e.type === 'need_key') return logAgent('⚙ set a model key first (⚙ key)');
  if (e.type === 'start') return logAgent('· thinking…');
  if (e.type === 'step') {
    const i = e.intent, v = e.verdict;
    const mark = v.class === 'allow' ? '✓' : v.class === 'confirm' ? '⏸' : '✗';
    return logAgent(`${mark} ${i.op}${i.ref != null ? ' #' + i.ref : ''}${i.target ? ' ' + i.target : ''} — ${v.class}${i.rationale ? '  «' + i.rationale + '»' : ''}`);
  }
  if (e.type === 'await_consent') return logAgent('⏸ waiting for your approval above…');
  if (e.type === 'done') return logAgent(`■ done: ${e.intent.done_reason || ''}`);
  if (e.type === 'end') return logAgent(`— ${e.phase} (${e.steps} steps)`);
  if (e.type === 'error') return logAgent(`✗ ${e.error}`);
}

if (HAS_CHROME) chrome.runtime.onMessage.addListener((msg) => {
  if (msg.evt === 'state') render(msg.state);
  if (msg.evt === 'agent') showAgent(msg);
});

(async () => { currentOrigin = await currentTabOrigin(); refresh(); })();
