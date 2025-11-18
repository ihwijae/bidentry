const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  runEngine: (job) => ipcRenderer.invoke('engine:run', job),
  stopEngine: () => ipcRenderer.invoke('engine:stop'),
  selectPath: (opts) => ipcRenderer.invoke('dialog:selectPath', opts),
  inspectCert: (p) => ipcRenderer.invoke('cert:inspect', p),
  onEngineEvent: (cb) => ipcRenderer.on('engine:event', (_e, evt) => cb(evt)),
  onEngineExit: (cb) => ipcRenderer.on('engine:exit', (_e, data) => cb(data)),
});

