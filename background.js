// background.js — the EXTENSION adapter over the shared Governor host.
//
// All the governed logic lives in host/governor-host.mjs; this file only wires the
// extension's transport into it: SEE/ACT via chrome.tabs messaging to content.js,
// events via chrome.runtime, BYOK config + perms via chrome.storage. The desktop app
// (desktop/main.js) wires the SAME host to Electron — one brain, two sets of hands.

import { makeHost } from './host/governor-host.mjs';
import { makeLLM } from './agent/llm.mjs';

const activeTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

const host = makeHost({
  see: async () => { const t = await activeTab(); return t ? chrome.tabs.sendMessage(t.id, { cmd: 'see' }) : null; },
  act: async (intent) => { const t = await activeTab(); return t ? chrome.tabs.sendMessage(t.id, { cmd: 'act', action: intent }) : { error: 'no active tab' }; },
  emit: (e) => { chrome.runtime.sendMessage(e).catch(() => {}); },
  llm: async () => { const { llmConfig } = await chrome.storage.local.get('llmConfig'); return (llmConfig && llmConfig.apiKey) ? makeLLM(llmConfig) : null; },
  persistPerms: (permTable) => chrome.storage.local.set({ permTable }),
});

chrome.storage.local.get('permTable').then(({ permTable }) => host.loadPerms(permTable)).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    switch (msg && msg.cmd) {
      case 'arm': reply(host.arm()); break;
      case 'halt': reply(host.halt(msg.reason)); break;
      case 'setPerm': reply(await host.setPerm(msg.origin, msg.perm)); break;
      case 'setCap': reply(host.setCap(msg.origin, msg.cap)); break;
      case 'propose': reply(await host.propose(msg.intent)); break;
      case 'consent': reply(await host.consent(msg.id)); break;
      case 'run_goal': reply(await host.runGoal(msg.goal)); break;
      case 'stop_goal': reply(host.stopGoal()); break;
      case 'setLLM': await chrome.storage.local.set({ llmConfig: msg.config }); reply({ ok: true }); break;
      case 'getState': reply(host.snapshotState()); break;
      default: reply({ error: 'unknown cmd' });
    }
  })();
  return true;   // async reply
});

// open the side-panel rail when the toolbar icon is clicked
chrome.action?.onClicked.addListener((tab) => chrome.sidePanel?.open({ tabId: tab.id }).catch(() => {}));
