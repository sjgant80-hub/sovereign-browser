// content.js — the EXTENSION's page transport. The DOM SEE/ACT logic lives in
// page/agent-dom.js (shared with the desktop app); this file is only the bridge
// between that and the service worker. It decides nothing — the Governor does.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  try {
    if (!window.__sbSee) reply({ error: 'agent-dom not injected' });
    else if (msg.cmd === 'see') reply(window.__sbSee());
    else if (msg.cmd === 'act') reply(window.__sbAct(msg.action));   // only reached AFTER a Governor allow
    else reply({ error: 'unknown cmd' });
  } catch (e) { reply({ error: String(e && e.message || e) }); }
  return true;   // async reply
});
