// Sandboxed preload for the main window. It exposes a fixed set of calls and nothing else: no
// ipcRenderer, no Node.js, and no path or channel name chosen by the page.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel, callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  accounts: {
    list: () => invoke('accounts:list'),
    login: (username, password) => invoke('accounts:login', { username, password }),
    remove: (username) => invoke('accounts:remove', username),
    onChanged: (callback) => subscribe('accounts:changed', callback),
  },
  run: {
    now: (username) => invoke('run:now', username),
    onDone: (callback) => subscribe('run:done', callback),
  },
  sheet: { read: (username) => invoke('sheet:read', username) },
  templates: {
    get: () => invoke('templates:get'),
    saveProposal: (title, text) => invoke('templates:saveProposal', { title, text }),
    deleteProposal: (title) => invoke('templates:deleteProposal', title),
    saveMessage: (text) => invoke('templates:saveMessage', text),
    saveSheetUrl: (url) => invoke('templates:saveSheetUrl', url),
  },
  schedule: { open: (username) => invoke('schedule:open', username) },
});
