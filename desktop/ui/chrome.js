// chrome.js — the browser-chrome + rail renderer. Talks to main over window.sb
// (preload). It is a THIN client: every governed action is an sb.gov(msg) call that
// main routes into the shared Governor host. No decisions happen here.
const $ = (id) => document.getElementById(id);
const money = (p, c) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: c || 'GBP' }).format((p || 0) / 100);
let currentOrigin = '';

// ── top chrome: tabs + address bar + nav ──────────────────────────────────────
function renderTabs(meta) {
  currentOrigin = meta.origin || '';
  $('addr').value = meta.url || '';
  $('site').textContent = currentOrigin || '—';
  $('tabs').innerHTML = meta.tabs.map(t =>
    `<div class="tab ${t.active ? 'active' : ''}" data-id="${t.id}"><span class="t">${(t.title || 'New tab').slice(0, 40)}</span><span class="x" data-close="${t.id}">✕</span></div>`).join('');
  refreshState();
}
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.close) { await sb.tabsClose(Number(t.dataset.close)); }
  else if (t.closest('.tab')) { await sb.tabsActivate(Number(t.closest('.tab').dataset.id)); }
  else if (t.id === 'back') sb.back();
  else if (t.id === 'forward') sb.forward();
  else if (t.id === 'reload') sb.reload();
  else if (t.id === 'newtab') sb.tabsNew('https://duckduckgo.com');
  else if (t.id === 'killBtn') { const s = await sb.gov({ cmd: 'getState' }); await sb.gov({ cmd: s.killswitch.state === 'ARMED' ? 'halt' : 'arm' }); refreshState(); }
  else if (t.dataset.perm) { await sb.gov({ cmd: 'setPerm', origin: currentOrigin, perm: t.dataset.perm }); refreshState(); }
  else if (t.dataset.consent) { await sb.gov({ cmd: 'consent', id: t.dataset.consent }); refreshState(); }
  else if (t.dataset.deny) { logAgent('✗ you declined ' + t.dataset.deny); refreshState(); }
  else if (t.id === 'runBtn') { const g = $('goal').value.trim(); if (g) { logAgent('▶ ' + g); const r = await sb.gov({ cmd: 'run_goal', goal: g }); if (r && r.reason) logAgent('· ' + r.reason); } }
  else if (t.id === 'stopBtn') { await sb.gov({ cmd: 'stop_goal' }); logAgent('■ stopped'); }
  else if (t.id === 'keyBtn') {
    const provider = (prompt('provider: anthropic | openai', 'anthropic') || '').trim(); if (!provider) return;
    const apiKey = prompt(provider + ' API key (stored locally in this app only)'); if (!apiKey) return;
    const model = prompt('model id (blank = default)', provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-5') || undefined;
    await sb.gov({ cmd: 'setLLM', config: { provider, apiKey, model } }); logAgent('⚙ ' + provider + ' key set');
  }
});
$('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') sb.tabsNavigate($('addr').value); });
$('goal').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('runBtn').click(); });

// ── the rail (governor state) ─────────────────────────────────────────────────
function renderState(st) {
  const armed = st.killswitch.state === 'ARMED';
  $('dot').style.background = armed ? 'var(--allow)' : 'var(--block)';
  $('ks').textContent = `${st.killswitch.state} · e${st.killswitch.killEpoch}`;
  const kb = $('killBtn'); kb.textContent = armed ? '■  HALT — freeze the agent' : '▶  ARM — allow the agent'; kb.className = 'kill ' + (armed ? 'armed' : 'halted');
  const perm = (currentOrigin && st.permTable[currentOrigin]) || 'off';
  $('perm').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.perm === perm)));
  const s = st.spend;
  $('spendTxt').textContent = `${money(s.global_total, s.currency)} / ${money(s.global_cap, s.currency)}`;
  $('spendBar').style.width = Math.min(100, s.global_cap ? (s.global_total / s.global_cap) * 100 : 0) + '%';
  const pend = st.pending || [];
  $('pendSec').hidden = pend.length === 0;
  $('pending').innerHTML = pend.map(p => `<div class="pending"><div><span class="k">${p.kind}</span> on <b>${p.origin}</b>${p.cost ? ' · ' + money(p.cost, s.currency) : ''}</div><div class="acts"><button class="approve" data-consent="${p.id}">approve</button><button class="deny" data-deny="${p.id}">deny</button></div></div>`).join('');
  $('log').innerHTML = (st.audit || []).slice().reverse().map(e => {
    const v = e.payload && e.payload.verdict; const cls = v ? (v.class === 'allow' ? 'va' : v.class === 'confirm' ? 'vc' : 'vb') : 'dim';
    const what = v ? `${(e.payload.observed && e.payload.observed.kind) || ''} — ${v.reason}` : e.kind;
    return `<div class="e"><span class="dim">${e.seq}</span><span class="${cls}">${what}</span></div>`;
  }).join('');
}
async function refreshState() { renderState(await sb.gov({ cmd: 'getState' })); }

function logAgent(line) { const el = $('agentOut'); el.textContent = (el.textContent ? el.textContent + '\n' : '') + line; el.scrollTop = el.scrollHeight; }
function showAgent(e) {
  if (e.type === 'need_key') return logAgent('⚙ set a model key first (⚙)');
  if (e.type === 'step') { const i = e.intent, v = e.verdict; const m = v.class === 'allow' ? '✓' : v.class === 'confirm' ? '⏸' : '✗'; return logAgent(`${m} ${i.op}${i.ref != null ? ' #' + i.ref : ''} — ${v.class}  «${i.rationale || ''}»`); }
  if (e.type === 'await_consent') return logAgent('⏸ approve above to continue…');
  if (e.type === 'done') return logAgent('■ done: ' + (e.intent.done_reason || ''));
  if (e.type === 'end') return logAgent(`— ${e.phase} (${e.steps} steps)`);
  if (e.type === 'error') return logAgent('✗ ' + e.error);
}

sb.onTabs(renderTabs);
sb.onEvent((e) => { if (e.evt === 'state') renderState(e.state); else if (e.evt === 'agent') showAgent(e); });
sb.tabsList().then(renderTabs);
