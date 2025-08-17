// preload.js
const { contextBridge, ipcRenderer, desktopCapturer } = require('electron');

// Robust renderer-side capture that avoids Electron's 'screen' module.
// Reads size from window.screen + devicePixelRatio and retries with
// smaller thumbnails on GPUs that reject large requests.
async function captureScreen() {
  const dpr = Number(globalThis.devicePixelRatio || 1);
  const scr = globalThis.screen || {};
  const baseW = Math.max(1, Math.floor((scr.width  || 1280) * dpr));
  const baseH = Math.max(1, Math.floor((scr.height || 720)  * dpr));

  async function tryGrab(w, h) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h }
    });
    const target = sources[0];
    if (!target) return null;
    const img = target.thumbnail;
    // Some GPUs return an empty nativeImage at large sizes
    if (typeof img.isEmpty === 'function' && img.isEmpty()) return null;

    const png = img.toPNG();
    if (!png || !png.length) return null;
    return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
  }

  // Try at full, then half, then a fixed fallback
  let buf = await tryGrab(baseW, baseH);
  if (!buf) buf = await tryGrab(Math.round(baseW / 2), Math.round(baseH / 2));
  if (!buf) buf = await tryGrab(1600, 900); // last resort size

  if (!buf) throw new Error('desktopCapturer returned an empty image');
  return buf;
}

contextBridge.exposeInMainWorld('api', {
  // screenshot -> PNG buffer (Uint8Array)
  grab: () => captureScreen(),

  // OCR passes (return strings)
  ocr:       (u8) => ipcRenderer.invoke('ocr', u8),
  ocrDigits: (u8) => ipcRenderer.invoke('ocr-digits', u8),

  // optional debug helpers
  saveDebug:        (txt) => ipcRenderer.invoke('save-debug', String(txt || '')),
  saveDebugDigits:  (txt) => ipcRenderer.invoke('save-debug-digits', String(txt || '')),
  saveCrop:         (u8)  => ipcRenderer.invoke('save-crop', u8)
});
