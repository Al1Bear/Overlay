const { contextBridge, ipcRenderer } = require('electron');

// Expose safe IPC methods to the renderer
contextBridge.exposeInMainWorld('api', {
  // Invoke primary OCR (capture + text)
  ocr: (imageBuffer) => ipcRenderer.invoke('ocr', imageBuffer),
  // Invoke secondary OCR (digits)
  ocrDigits: (imageBuffer) => ipcRenderer.invoke('ocr-digits', imageBuffer),
  grab: () => ipcRenderer.invoke('grab'),
  // Listen for OCR results (from global shortcut or other asynchronous triggers)
  onOcrResult: (callback) => {
    ipcRenderer.on('ocr-result', (event, data) => {
      if (callback && typeof callback === 'function') {
        callback(data);
      }
    });
  }
});
