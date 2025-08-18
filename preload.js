// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // ROI
  getRoi:     () => ipcRenderer.invoke('roi:get'),
  setRoi:     (b) => ipcRenderer.invoke('roi:set', b),
  editRoi:    (on) => ipcRenderer.invoke('roi:edit', !!on),
  toggleBox:  () => ipcRenderer.invoke('roi:toggle-visible'),

  // Capture / Auto
  snap:       () => ipcRenderer.invoke('snap'),
  auto:       (on) => ipcRenderer.invoke('auto', !!on),

  // Sidebar status
  onUpdate:   (cb) => ipcRenderer.on('side:update', (_e, payload) => cb(payload)),
  onStatus:   (cb) => ipcRenderer.on('side:status', (_e, s) => cb(s)),

  // Hotkey relays from main
  onEditToggle: (cb) => ipcRenderer.on('side:editToggle', () => cb()),
  onSnap:       (cb) => ipcRenderer.on('side:snap', () => cb()),
  onAutoToggle: (cb) => ipcRenderer.on('side:autoToggle', () => cb()),

  // ROI overlay edit on/off
  onRoiEdit:  (cb) => ipcRenderer.on('roi:edit', (_e, on) => cb(on)),

  // misc
  saveText:   (t) => ipcRenderer.invoke('save-text', String(t || '')),
});
