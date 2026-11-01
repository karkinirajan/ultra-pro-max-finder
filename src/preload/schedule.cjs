const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scheduleApi', {
  get: (username) => ipcRenderer.invoke('schedule:get', username),
  save: (username, config) => ipcRenderer.invoke('schedule:save', { username, config }),
  remove: (username) => ipcRenderer.invoke('schedule:remove', username),
});
