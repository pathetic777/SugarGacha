/**
 * SugarGacha — preload bridge.
 * Exposes a tiny, explicit API to the renderer (contextIsolation on, no Node in the page).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sugar', {
  setExpanded: (expanded) => ipcRenderer.send('set-widget-state', expanded),
  dragStart: () => ipcRenderer.send('window-drag-start'),
  dragMove: () => ipcRenderer.send('window-drag-move'),
  dragEnd: () => ipcRenderer.send('window-drag-end'),
  deliver: (text) => ipcRenderer.invoke('deliver-prompt', text),
  copyOnly: (text) => ipcRenderer.invoke('copy-only', text),
  recordSpin: () => ipcRenderer.invoke('record-spin'),
  openRepo: () => ipcRenderer.send('open-repo'),
  getTarget: () => ipcRenderer.invoke('get-target'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  onSettings: (cb) => ipcRenderer.on('settings-changed', (e, s) => cb(s)),
  onForceCollapse: (cb) => ipcRenderer.on('force-collapse', () => cb()),
  hide: () => ipcRenderer.send('hide-widget'),
  quit: () => ipcRenderer.send('quit-app')
});
