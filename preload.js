const { contextBridge, ipcRenderer } = require('electron');

// preload.js
contextBridge.exposeInMainWorld('api', {
  // Invoke primary OCR (full text)
  ocr: (imageBuffer) => ipcRenderer.invoke('ocr', imageBuffer),
  // Invoke secondary OCR (digits only)
  ocrDigits: (imageBuffer) => ipcRenderer.invoke('ocr-digits', imageBuffer),
  // Capture screen image
  grab: () => ipcRenderer.invoke('grab'),
  // Listener for OCR results from main (e.g., global shortcut)
  onOcrResult: (callback) => {
    ipcRenderer.on('ocr-result', (event, data) => {
      if (typeof callback === 'function') {
        callback(data);
      }
    });
  }
});

