// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Try to access desktopCapturer from the renderer context.
// Some setups expose it, others don't; we fallback to main.
function getDesktopCapturer() {
  try {
    const el = require('electron');
    return el && el.desktopCapturer ? el.desktopCapturer : undefined;
  } catch {
    return undefined;
  }
}

async function captureFromRenderer() {
  const desktopCapturer = getDesktopCapturer();
  if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') return null;

  const dpr = Number(globalThis.devicePixelRatio || 1);
  const scr = globalThis.screen || {};
  const baseW = Math.max(1, Math.floor((scr.width  || 1280) * dpr));
  const baseH = Math.max(1, Math.floor((scr.height || 720)  * dpr));

  async function tryGrab(w, h) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h }
    });
    const target = sources && sources[0];
    if (!target || !target.thumbnail) return null;

    if (typeof target.thumbnail.isEmpty === 'function' && target.thumbnail.isEmpty()) return null;
    const png = target.thumbnail.toPNG();
    if (!png || !png.length) return null;

    return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
  }

  // Try full, half, then a fixed size fallback
  return (await tryGrab(baseW, baseH)) ||
         (await tryGrab(Math.round(baseW/2), Math.round(baseH/2))) ||
         (await tryGrab(1600, 900));
}

async function captureScreen() {
  // 1) Try renderer-side capture
  const fromRenderer = await captureFromRenderer();
  if (fromRenderer) return fromRenderer;

  // 2) Fallback to main-process capture
  const fromMain = await ipcRenderer.invoke('grab-main'); // new IPC we add in main.js below
  if (!fromMain || !fromMain.length) throw new Error('desktopCapturer returned an empty image');
  return new Uint8Array(fromMain.buffer, fromMain.byteOffset, fromMain.byteLength);
}

contextBridge.exposeInMainWorld('api', {
  grab: () => captureScreen(),

  // OCR (return strings)
  ocr:       (u8) => ipcRenderer.invoke('ocr', u8),
  ocrDigits: (u8) => ipcRenderer.invoke('ocr-digits', u8),

  // debug helpers
  saveDebug:        (txt) => ipcRenderer.invoke('save-debug', String(txt || '')),
  saveDebugDigits:  (txt) => ipcRenderer.invoke('save-debug-digits', String(txt || '')),
  saveCrop:         (u8)  => ipcRenderer.invoke('save-crop', u8)
});
