// preload.js
const { contextBridge, ipcRenderer, desktopCapturer, screen } = require('electron');

// Capture the primary screen to a PNG (Uint8Array) from the renderer side.
// This avoids the intermittent "blank/empty" thumbnails some Windows builds
// return when desktopCapturer is called from the main process.
async function captureScreen() {
  const d = screen.getPrimaryDisplay();
  const { width, height } = d.size;
  const scale = d.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * scale),
      height: Math.round(height * scale)
    }
  });

  const target = sources.find(s => s.display_id === String(d.id)) || sources[0];
  if (!target) throw new Error('No screen sources returned by desktopCapturer');

  const png = target.thumbnail.toPNG(); // Buffer
  // return Uint8Array so the renderer can create a Blob/URL easily
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

contextBridge.exposeInMainWorld('api', {
  // screenshot -> PNG buffer
  grab: () => captureScreen(),

  // OCR passes (return strings)
  ocr:       (u8) => ipcRenderer.invoke('ocr', u8),
  ocrDigits: (u8) => ipcRenderer.invoke('ocr-digits', u8),

  // optional debug helpers
  saveDebug:        (txt) => ipcRenderer.invoke('save-debug', String(txt || '')),
  saveDebugDigits:  (txt) => ipcRenderer.invoke('save-debug-digits', String(txt || '')),
  saveCrop:         (u8)  => ipcRenderer.invoke('save-crop', u8)
});
