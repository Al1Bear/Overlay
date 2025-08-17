// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  grab: () => ipcRenderer.invoke('grab'),

  // OCR passes (return strings)
  ocr:       (u8) => ipcRenderer.invoke('ocr', u8),
  ocrDigits: (u8) => ipcRenderer.invoke('ocr-digits', u8),

  // optional debug helpers (no-ops if you ignore results)
  saveDebug:        (txt) => ipcRenderer.invoke('save-debug', String(txt || '')),
  saveDebugDigits:  (txt) => ipcRenderer.invoke('save-debug-digits', String(txt || '')),
  saveCrop:         (u8)  => ipcRenderer.invoke('save-crop', u8)
});
