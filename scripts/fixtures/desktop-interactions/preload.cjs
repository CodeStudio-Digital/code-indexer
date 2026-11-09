const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: url => ipcRenderer.send('shell:openExternal', url),
});
