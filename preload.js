// preload.js
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  roi: {
    get: () => ipcRenderer.invoke('roi:get'),
    set: (rect) => ipcRenderer.invoke('roi:set', rect),
    edit: () => ipcRenderer.invoke('roi:edit'),
    toggleVisible: () => ipcRenderer.invoke('roi:toggle-visible'),
    onBounds: (cb) => ipcRenderer.on('roi:bounds', (_e, rect) => cb(rect)),
    onEditing: (cb) => ipcRenderer.on('roi:editing', (_e, on) => cb(on)),
    onVisible: (cb) => ipcRenderer.on('roi:visible', (_e, v) => cb(v)),
    hello: () => ipcRenderer.send('roi:hello')
  },
  snap: () => ipcRenderer.invoke('snap'),
  auto: {
    toggle: () => ipcRenderer.invoke('auto'),
    onState: (cb) => ipcRenderer.on('auto:state', (_e, on) => cb(on)),
    onCapture: (cb) => ipcRenderer.on('auto:capture', (_e, data) => cb(data))
  },
  log: (msg) => ipcRenderer.send('log', msg)
};

contextBridge.exposeInMainWorld('api', api);
// compatibility alias if existing renderer used electronAPI
contextBridge.exposeInMainWorld('electronAPI', api);
