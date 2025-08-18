// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // controller (index.html)
  autoBind:     () => ipcRenderer.invoke('auto-bind'),
  listWindows:  () => ipcRenderer.invoke('list-windows'),
  bindWindow:   (id) => ipcRenderer.invoke('bind-window', id),
  captureBound: () => ipcRenderer.invoke('capture-bound'),
  ocrPanel:     (u8) => ipcRenderer.invoke('ocr', u8),

  // HUD control from controller
  hudText: (lines, pulse = false, roiPixels = null, showROI = false) =>
    ipcRenderer.send('hud-text', { lines, pulse, roiPixels, showROI }),

  toggleAuto: (on) => ipcRenderer.send('auto-toggle', !!on),
  snapNow:    () => ipcRenderer.send('snap-now'),

  // receive hotkey relays from main
  onMain: (cb) => ipcRenderer.on('main-event', (_e, msg) => cb(msg)),

  // HUD window APIs (hud.html)
  onHudText: (cb) => ipcRenderer.on('hud-update', (_e, payload) => cb(payload)),
  onHudEdit: (cb) => ipcRenderer.on('hud-edit', (_e, on) => cb(on)),
  setHudClickThrough: (on) => ipcRenderer.invoke('hud-clickthrough', on),
  hudMoveTo: (x, y) => ipcRenderer.invoke('hud-move', { x, y }),
  getHudBounds: () => ipcRenderer.invoke('hud-bounds'),

  // misc
  saveText: (t) => ipcRenderer.invoke('save-text', String(t || '')),
  setTitle: (t) => ipcRenderer.send('set-title', t)
});
