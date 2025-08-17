// main.js (Tesseract-only build; pointer-safe capture + split pre-processing)
const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs   = require('fs');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => (mainWindow = null));
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

// ---------- Utils ----------
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// Auto‑invert (dark UI → light background), upscale small crops,
// split pipelines for labels vs digits.
async function preprocess(buf, mode = 'labels') {
  // Get stats first (mean brightness) & width for upscale
  const stats = await sharp(buf).stats();
  const meta  = await sharp(buf).metadata();
  const w     = meta.width || 0;
  const mean  = (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3;
  const lightOnDark = mean < 128; // typical game UIs are dark → invert helps Tesseract

  let img = sharp(buf).png();

  // Upscale small selections to give Tesseract more pixels
  if (w && w < 1200) {
    const target = Math.min(1800, Math.round(w * 2.2));
    img = img.resize({ width: target, withoutEnlargement: false });
  }

  // Common base
  img = img.grayscale().normalize();
  if (lightOnDark) img = img.negate(); // black text on white background

  if (mode === 'labels') {
    // Preserve glyph shapes: no hard threshold; mild gamma + sharpen
    img = img.gamma(1.1).sharpen({ sigma: 1.1 });
  } else {
    // Digits benefit from clean binarization
    img = img.threshold(185);
  }
  return await img.toBuffer();
}
// Run recognize with a given PSM and return text + a quality signal
async function recognizeWithPSM(imgBuf, psm) {
  const { data } = await Tesseract.recognize(imgBuf, 'eng', {
    logger: () => {},
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: 1,
    user_defined_dpi: '300'
  });
  return {
    text: data.text || '',
    conf: typeof data.confidence === 'number' ? data.confidence : 0,
    words: Array.isArray(data.words) ? data.words.length : 0
  };
}

// Try PSM 4/6/3 and pick the result with highest confidence,
// then words count, then text length.
async function ocrLabels(imgBuf) {
  const results = await Promise.all([4, 6, 3].map(psm => recognizeWithPSM(imgBuf, psm)));
  results.sort((a, b) =>
    (b.conf - a.conf) || (b.words - a.words) || (b.text.length - a.text.length)
  );
  return results[0].text;
}

// ---------- IPC: OCR (labels) ----------
ipcMain.handle('ocr', async (_evt, u8) => {
  try {
    ensureDir(path.join(__dirname, 'captures'));
    fs.writeFileSync(path.join(__dirname, 'captures', 'last-crop.png'), Buffer.from(u8));

    const pre  = await preprocess(Buffer.from(u8), 'labels');
    const text = await ocrLabels(pre); // best-of-three (PSM 4/6/3)

    fs.writeFileSync(path.join(__dirname, 'captures', 'last-ocr.txt'), text, 'utf8');
    return text;
  } catch (e) {
    console.error('[OCR] error:', e);
    return '';
  }
});

// ---------- IPC: OCR (digits-only) ----------
ipcMain.handle('ocr-digits', async (_evt, u8) => {
  try {
    const pre = await preprocess(Buffer.from(u8), 'digits');
    const { data } = await Tesseract.recognize(pre, 'eng', {
      logger: () => {},
      tessedit_pageseg_mode: 6,
      tessedit_char_whitelist: '0123456789.+%:/',
      preserve_interword_spaces: 1,
      user_defined_dpi: '300'
    });
    const text = data.text || '';
    fs.writeFileSync(path.join(__dirname, 'captures', 'last-ocr-digits.txt'), text, 'utf8');
    return text;
  } catch (e) {
    console.error('[OCR-digits] error:', e);
    return '';
  }
});

// ---------- IPC: optional debug saves ----------
ipcMain.handle('save-debug', async (_evt, txt) => {
  try { ensureDir(path.join(__dirname, 'captures'));
        fs.writeFileSync(path.join(__dirname, 'captures', 'last-ocr.txt'), String(txt || ''), 'utf8'); return true; }
  catch { return false; }
});
ipcMain.handle('save-debug-digits', async (_evt, txt) => {
  try { ensureDir(path.join(__dirname, 'captures'));
        fs.writeFileSync(path.join(__dirname, 'captures', 'last-ocr-digits.txt'), String(txt || ''), 'utf8'); return true; }
  catch { return false; }
});
ipcMain.handle('save-crop', async (_evt, u8) => {
  try { ensureDir(path.join(__dirname, 'captures'));
        fs.writeFileSync(path.join(__dirname, 'captures', 'last-crop.png'), Buffer.from(u8)); return true; }
  catch { return false; }
});
