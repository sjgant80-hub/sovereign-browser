// preload.js — the safe bridge between the chrome renderer (ui/chrome.*) and main.
// contextIsolation is on; the renderer only gets this narrow, typed surface.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sb', {
  tabsNew: (url) => ipcRenderer.invoke('tabs:new', url),
  tabsNavigate: (url) => ipcRenderer.invoke('tabs:navigate', url),
  tabsActivate: (id) => ipcRenderer.invoke('tabs:activate', id),
  tabsClose: (id) => ipcRenderer.invoke('tabs:close', id),
  tabsList: () => ipcRenderer.invoke('tabs:list'),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),
  gov: (msg) => ipcRenderer.invoke('gov:cmd', msg),          // arm/halt/setPerm/propose/consent/run_goal/...
  onEvent: (cb) => ipcRenderer.on('host:event', (_e, evt) => cb(evt)),   // {evt:'state'|'agent',...}
  onTabs: (cb) => ipcRenderer.on('tabs:update', (_e, data) => cb(data)),
});
