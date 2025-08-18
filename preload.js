// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // Take a full-screen PNG from main
  captureScreen: () => ipcRenderer.invoke('capture-screen'),

  // Send a cropped panel (Uint8Array) for OCR; returns {labelText, digitsText}
  ocrPanel: (u8) => ipcRenderer.invoke('ocr', u8),

  // Save helpers (optional); return saved file paths
  save: (textOrJson) => ipcRenderer.invoke('save-json', textOrJson),
  saveDebug: (text) => ipcRenderer.invoke('save-text', text),

  // basic status pings (optional)
  setTitle: (t) => ipcRenderer.send('set-title', t)
});
