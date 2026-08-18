// The only bridge between the overlay UI and the host process. Node stays out of the
// renderer, so the surface below is the complete list of privileged things the UI can do.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onConfig: (handler) => ipcRenderer.on('overlay:config', (_event, payload) => handler(payload)),
  onMenuState: (handler) => ipcRenderer.on('overlay:menu-state', (_event, open) => handler(open)),

  closeMenu: () => ipcRenderer.invoke('overlay:close-menu'),
  saveConfig: (patch) => ipcRenderer.invoke('overlay:save-config', patch),
  captureScreen: () => ipcRenderer.invoke('overlay:capture-screen'),
  itemDb: () => ipcRenderer.invoke('overlay:item-db'),
  logAnalysis: (payload) => ipcRenderer.invoke('overlay:log-analysis', payload),
  quit: () => ipcRenderer.invoke('overlay:quit'),
});
