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

// ----- Preprocessing -----
// Labels: preserve glyph shape (no hard threshold)
async function preprocessLabels(buf) {
  // Read stats to auto-invert for dark UIs
  const stats = await sharp(buf).stats();
  const meta  = await sharp(buf).metadata();
  const w     = meta.width || 0;
  const mean  = (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3;
  const darkUI = mean < 140; // slightly higher cutoff for safety

  let img = sharp(buf).png();

  // Upscale small crops
  if (w && w < 1200) {
    const target = Math.min(2000, Math.round(w * 2.4));
    img = img.resize({ width: target, withoutEnlargement: false });
  }

  img = img.grayscale().normalize();
  if (darkUI) img = img.negate(); // black text on white

  // No hard threshold for labels; gentle cleanup
  img = img.gamma(1.08).sharpen({ sigma: 1.0 });

  return await img.toBuffer();
}

// Digits: crop to the right stats column (and below the header),
// then build THREE candidates. We score them and keep the one
// that contains more digits.
async function prepDigitsCandidates(buf) {
  let img = sharp(buf).png();
  const meta = await img.metadata();
  const W = meta.width  || 0;
  const H = meta.height || 0;

  // ---- Column crop (RIGHT side) ----
  // Horizontal: start slightly past mid; width ~40% (adjust if needed)
  const left  = Math.max(0, Math.floor(W * 0.58));               // was 0.56
  const width = Math.max(40, Math.min(W - left, Math.floor(W * 0.40)));

  // Vertical: drop the header/icons area above the first stat row
  const top    = Math.max(0, Math.floor(H * 0.25));               // NEW: skip top 25%
  const height = Math.max(40, H - top - Math.floor(H * 0.05));    // keep 95% of remainder

  img = img.extract({ left, top, width, height });

  // Stronger upscale for digits
  if (width && width < 1200) {
    const target = Math.min(2200, Math.round(width * 2.8));
    img = img.resize({ width: target, withoutEnlargement: false });
  }

  // Base cleanup
  const base = await img
    .grayscale()
    .normalize()
    .linear(1.25, -15)  // slight contrast boost
    .median(1)
    .toBuffer();

  // Candidate set
  const thrA = await sharp(base).threshold(182).toBuffer();           // normal@182
  const thrB = await sharp(base).negate().threshold(182).toBuffer();  // inverted@182
  const thrC = await sharp(base).threshold(170).toBuffer();           // normal@170 (keeps lighter strokes)

  return { thrA, thrB, thrC, debugBase: base };
}

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

async function ocrLabels(imgBuf) {
  const results = await Promise.all([4, 6, 3].map(psm => recognizeWithPSM(imgBuf, psm)));
  results.sort((a, b) =>
    (b.conf - a.conf) || (b.words - a.words) || (b.text.length - a.text.length)
  );
  return results[0].text;
}


// ---------- IPC: OCR (labels) ----------
// Crop three text zones for labels and OCR each with the best PSM.
async function cropLabelZones(buf) {
  const meta = await sharp(buf).metadata();
  const W = meta.width  || 0;
  const H = meta.height || 0;

  const rects = {
    // Title "Platinum Knight Gloves" (top center/right)
    title: { left: Math.floor(W * 0.26), top: Math.floor(H * 0.04),
             width: Math.floor(W * 0.70), height: Math.floor(H * 0.12) },
    // Item type "Gloves" (below the title)
    type:  { left: Math.floor(W * 0.33), top: Math.floor(H * 0.13),
             width: Math.floor(W * 0.45), height: Math.floor(H * 0.10) },
    // Left label column: "Crit Rate", "DEF%", "HP%", "Crit Damage", "ATK%"
    names: { left: Math.floor(W * 0.06), top: Math.floor(H * 0.26),
             width: Math.floor(W * 0.48), height: Math.floor(H * 0.62) }
  };

  const img = sharp(buf).png();
  return {
    title: await img.extract(rects.title).toBuffer(),
    type:  await img.extract(rects.type).toBuffer(),
    names: await img.extract(rects.names).toBuffer()
  };
}

ipcMain.handle('ocr', async (_evt, u8) => {
  try {
    ensureDir(path.join(__dirname, 'captures'));
    fs.writeFileSync(path.join(__dirname, 'captures', 'last-crop.png'), Buffer.from(u8));

    // Split into three zones
    const { title, type, names } = await cropLabelZones(Buffer.from(u8));

    // Preprocess each zone for labels
    const preTitle = await preprocessLabels(title);
    const preType  = await preprocessLabels(type);
    const preNames = await preprocessLabels(names);

    // Save what we send to Tesseract (debug)
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-label-title.png'), preTitle);
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-label-type.png'),  preType);
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-label-names.png'), preNames);

    // OCR with zone‑appropriate PSM (7: single line; 6: block)
    const [tTitle, tType, tNames] = await Promise.all([
      Tesseract.recognize(preTitle, 'eng', { user_defined_dpi: '320', tessedit_pageseg_mode: 7 }).then(r => r.data.text || ''),
      Tesseract.recognize(preType,  'eng', { user_defined_dpi: '320', tessedit_pageseg_mode: 7 }).then(r => r.data.text || ''),
      Tesseract.recognize(preNames, 'eng', { user_defined_dpi: '320', tessedit_pageseg_mode: 6, preserve_interword_spaces: 1 }).then(r => r.data.text || '')
    ]);

    const merged = [
      (tTitle || '').trim(),
      (tType  || '').trim(),
      (tNames || '').trim()
    ].filter(Boolean).join('\n');

    fs.writeFileSync(path.join(__dirname, 'captures', 'last-ocr.txt'), merged, 'utf8');
    return merged;
  } catch (e) {
    console.error('[OCR labels] error:', e);
    return '';
  }
});


// ---------- IPC: OCR (digits-only) ----------
function scoreDigits(str) {
  const digits = (str.match(/[0-9]/g) || []).length;
  const lines  = (str.split(/\n/).filter(Boolean).length);
  return digits * 10 + lines + str.length * 0.02; // prefer "more numbers"
}

ipcMain.handle('ocr-digits', async (_evt, u8) => {
  try {
    const { thrA, thrB, thrC, debugBase } = await prepDigitsCandidates(Buffer.from(u8));

    // Debug: see exactly what Tesseract saw
    ensureDir(path.join(__dirname, 'captures'));
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-digits-0-base.png'), debugBase);
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-digits-A-normal182.png'), thrA);
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-digits-B-invert182.png'), thrB);
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-digits-C-normal170.png'), thrC);

    const cfg = {
      logger: () => {},
      tessedit_pageseg_mode: 6,
      tessedit_char_whitelist: '0123456789.+%:/',
      preserve_interword_spaces: 1,
      user_defined_dpi: '340'
    };

    const [ra, rb, rc] = await Promise.all([
      Tesseract.recognize(thrA, 'eng', cfg),
      Tesseract.recognize(thrB, 'eng', cfg),
      Tesseract.recognize(thrC, 'eng', cfg)
    ]);

    const ta = ra.data.text || '';
    const tb = rb.data.text || '';
    const tc = rc.data.text || '';

    const bestText = [ta, tb, tc].sort((x, y) => scoreDigits(y) - scoreDigits(x))[0];

    fs.writeFileSync(path.join(__dirname, 'captures', 'last-ocr-digits.txt'), bestText, 'utf8');
    return bestText;
  } catch (e) {
    console.error('[OCR-digits] error:', e);
    return '';
  }
});


// Fallback: capture from main when renderer-side desktopCapturer is unavailable
ipcMain.handle('grab-main', async () => {
  const sizes = [];
  try {
    const d = screen.getPrimaryDisplay();
    const scale = d?.scaleFactor || 1;
    if (d?.size) {
      sizes.push(
        { w: Math.round(d.size.width * scale), h: Math.round(d.size.height * scale) },
        { w: Math.round(d.size.width * scale / 2), h: Math.round(d.size.height * scale / 2) }
      );
    }
  } catch {}
  sizes.push({ w: 0, h: 0 }, { w: 1920, h: 1080 }, { w: 1600, h: 900 }, { w: 1280, h: 720 });

  for (const s of sizes) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: s.w, height: s.h }
      });
      if (!sources || !sources.length) continue;
      const target = sources[0];
      const img = target?.thumbnail;
      if (!img) continue;
      if (typeof img.isEmpty === 'function' && img.isEmpty()) continue;

      const png = img.toPNG(); // Buffer
      if (png && png.length) return png;
    } catch { /* try next size */ }
  }
  throw new Error('No screen image from main desktopCapturer');
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
