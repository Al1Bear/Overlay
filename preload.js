// preload.js — stable API for HUD + ROI

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  roi: {
    get: () => ipcRenderer.invoke('roi:get'),
    set: (rect) => ipcRenderer.invoke('roi:set', rect),
    edit: () => ipcRenderer.invoke('roi:edit'),
    toggleVisible: () => ipcRenderer.invoke('roi:toggle-visible'),
    hello: () => ipcRenderer.send('roi:hello'),
    onBounds: (cb) => ipcRenderer.on('roi:bounds', (_e, r) => cb(r)),
    onEditing: (cb) => ipcRenderer.on('roi:editing', (_e, on) => cb(on)),
    onVisible: (cb) => ipcRenderer.on('roi:visible', (_e, v) => cb(v)),
  },
  auto: {
    toggle: () => ipcRenderer.invoke('auto:toggle'),
    onState: (cb) => ipcRenderer.on('auto:state', (_e, on) => cb(on)),
    onCapture: (cb) => ipcRenderer.on('auto:capture', (_e, d) => cb(d)),
  },
  snap: () => ipcRenderer.invoke('snap'),
  hud: {
    toggle: () => ipcRenderer.invoke('hud:toggle'),
    resize: (h) => ipcRenderer.invoke('hud:resize', h),
    closeOverlay: () => ipcRenderer.invoke('hud:close-overlay'),
    onHotkeySnap: (cb) => ipcRenderer.on('hotkey:snap', cb),
  },
  log: (msg) => ipcRenderer.send('log', msg),
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('electronAPI', api); // alias
