const { contextBridge, ipcRenderer } = require('electron');

// Minimal, typed-ish surface. Every call resolves to {ok, data|error} so the
// renderer never has to try/catch IPC.
contextBridge.exposeInMainWorld('maha', {
  quote: (symbols) => ipcRenderer.invoke('yahoo:quote', symbols),
  history: (symbol, range, interval) => ipcRenderer.invoke('yahoo:history', symbol, range, interval),
  search: (query) => ipcRenderer.invoke('yahoo:search', query),
  summary: (symbol) => ipcRenderer.invoke('yahoo:summary', symbol),
  fredAll: () => ipcRenderer.invoke('fred:all'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url)
});
