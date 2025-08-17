// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Try to access desktopCapturer from renderer; if not present we call main.
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

  async function tryGrab(size) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      // Electron behaviour: width/height == 0 → full-resolution thumbnail
      thumbnailSize: size
    });
    if (!sources || !sources.length) return null;

    // Pick the source with the largest thumbnail area
    const target = sources.reduce((best, s) => {
      const b = best?.thumbnail?.getSize?.() || { width: 0, height: 0 };
      const t = s.thumbnail?.getSize?.() || { width: 0, height: 0 };
      const bArea = b.width * b.height;
      const tArea = t.width * t.height;
      return tArea > bArea ? s : best;
    }, sources[0]);

    const img = target?.thumbnail;
    if (!img) return null;
    if (typeof img.isEmpty === 'function' && img.isEmpty()) return null;

    const png = img.toPNG();
    if (!png || !png.length) return null;

    // Return as Uint8Array
    return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
  }

  // Try in order: full-res → device size → half → fixed fallback
  let buf =
    (await tryGrab({ width: 0, height: 0 })) ||
    (await (async () => {
      const dpr = Number(globalThis.devicePixelRatio || 1);
      const scr = globalThis.screen || {};
      const baseW = Math.max(1, Math.floor((scr.width  || 1280) * dpr));
      const baseH = Math.max(1, Math.floor((scr.height || 720)  * dpr));
      return (await tryGrab({ width: baseW, height: baseH })) ||
             (await tryGrab({ width: Math.round(baseW / 2), height: Math.round(baseH / 2) }));
    })()) ||
    (await tryGrab({ width: 1920, height: 1080 })) ||
    (await tryGrab({ width: 1600, height: 900 }));

  return buf;
}

async function captureScreen() {
  // 1) Renderer capture if available
  const r = await captureFromRenderer();
  if (r) return r;

  // 2) Fallback to main-process capture
  const pngBuffer = await ipcRenderer.invoke('grab-main'); // returns Node.js Buffer
  if (!pngBuffer || !pngBuffer.length) throw new Error('desktopCapturer returned an empty image');
  return new Uint8Array(pngBuffer.buffer, pngBuffer.byteOffset, pngBuffer.byteLength);
}

contextBridge.exposeInMainWorld('api', {
  grab: () => captureScreen(),

  // OCR passes (return strings)
  ocr:       (u8) => ipcRenderer.invoke('ocr', u8),
  ocrDigits: (u8) => ipcRenderer.invoke('ocr-digits', u8),

  // optional debug helpers
  saveDebug:        (txt) => ipcRenderer.invoke('save-debug', String(txt || '')),
  saveDebugDigits:  (txt) => ipcRenderer.invoke('save-debug-digits', String(txt || '')),
  saveCrop:         (u8)  => ipcRenderer.invoke('save-crop', u8)
});
