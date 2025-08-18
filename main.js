// main.js (Tesseract-only build; pointer-safe capture + split pre-processing)
const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs   = require('fs');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

// ---- Geometry knobs (tweak if your UI shifts) ----
const DIGITS_LEFT_RATIO  = 0.58; // right column start (0.57–0.60)
const DIGITS_WIDTH_RATIO = 0.40; // right column width (0.38–0.42)
const DIGITS_TOP_RATIO   = 0.25; // skip header area    (0.25–0.30)

// Label zones (ratios of the full crop)
const Z_TITLE = { left: 0.26, top: 0.04, w: 0.70, h: 0.12 };
// ⬇️ REPLACE your old Z_TYPE with this (lower & slimmer so it's only one line)
const Z_TYPE  = { left: 0.33, top: 0.21, w: 0.40, h: 0.05 };
const Z_NAMES = { left: 0.06, top: 0.26, w: 0.48, h: 0.62 };

// ---- Safe rectangle clamp ----
function clampRect(W, H, rect) {
  let { left, top, width, height } = rect;
  // round first
  left   = Math.round(left);
  top    = Math.round(top);
  width  = Math.round(width);
  height = Math.round(height);
  // clamp to bounds
  left   = Math.max(0, Math.min(left,  Math.max(0, W - 2)));
  top    = Math.max(0, Math.min(top,   Math.max(0, H - 2)));
  width  = Math.max(2, Math.min(width,  W - left));
  height = Math.max(2, Math.min(height, H - top));
  return { left, top, width, height };
}

// ---- Normalization for digits text (fix stray bullets, spacing, long dashes) ----
function normalizeDigits(text) {
  return String(text || '')
    .replace(/^[\s·•∙*]+(?=\d)/gm, '+')  // bullets at start of line → '+'
    .replace(/—/g, '-')                  // em dash → hyphen
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Remove adjacent duplicate lines (e.g., double "Gloves")
function dedupAdjacentLines(s) {
  const out = [];
  for (const line of String(s || '').split(/\n+/).map(l => l.trim()).filter(Boolean)) {
    if (!out.length || out[out.length - 1] !== line) out.push(line);
  }
  return out.join('\n');
}
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
// Digits: crop the right stats column (below the header), upscale, then
// make THREE candidates: normal@150, invert@150, normal@150 (keeps faint strokes).
async function prepDigitsCandidates(buf) {
  let img = sharp(buf).png();
  const meta = await img.metadata();
  const W = meta.width  || 0;
  const H = meta.height || 0;

  // Column crop (safe‑clamped)
  const raw = {
    left:   W * DIGITS_LEFT_RATIO,
    top:    H * DIGITS_TOP_RATIO,      // skip header rows
    width:  W * DIGITS_WIDTH_RATIO,
    height: H * (1 - DIGITS_TOP_RATIO) - H * 0.05
  };
  const rect = clampRect(W, H, raw);
  img = img.extract(rect);

  // Upscale for thin glyphs
  if (rect.width && rect.width < 1200) {
    const target = Math.min(2200, Math.round(rect.width * 2.8));
    img = img.resize({ width: target, withoutEnlargement: false });
  }

  // Base cleanup
  const base = await img
    .grayscale()
    .normalize()
    .linear(1.25, -15)
    .median(1)
    .toBuffer();

  // Candidates
  const thrA = await sharp(base).threshold(100).toBuffer();           // normal@150
  const thrB = await sharp(base).negate().threshold(100).toBuffer();  // inverted@150
  const thrC = await sharp(base).threshold(100).toBuffer();           // normal@150

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
async function cropLabelZones(buf) {
  const meta = await sharp(buf).metadata();
  const W = meta.width  || 0;
  const H = meta.height || 0;

  const toPx = (z) => clampRect(W, H, {
    left: W * z.left, top: H * z.top, width: W * z.w, height: H * z.h
  });

  const rTitle = toPx(Z_TITLE);
  const rType  = toPx(Z_TYPE);
  const rNames = toPx(Z_NAMES);

  const img = sharp(buf).png();
  const safeExtract = async (rect) => {
    try { return await img.clone().extract(rect).toBuffer(); }
    catch { return null; }
  };

  return {
    title: await safeExtract(rTitle),  // can include 2 lines (name + wrap)
    type:  await safeExtract(rType),   // single "Gloves"
    names: await safeExtract(rNames)   // left column stat names
  };
}
// Try PSM 7 (single line) and PSM 6 (block), keep the better-looking line
async function ocrLineSmart(imgBuf) {
  const runs = await Promise.all([7, 6].map(async psm => {
    const { data } = await Tesseract.recognize(imgBuf, 'eng', {
      user_defined_dpi: '340',
      tessedit_pageseg_mode: psm
    });
    const text = (data.text || '').trim().replace(/\s{2,}/g, ' ');
    const lines = text.split(/\n+/).filter(Boolean);
    const score = (lines.length === 1 ? 100 : 0) + (data.confidence || 0) + text.length * 0.5;
    return { psm, text, lines, score };
  }));
  runs.sort((a, b) => b.score - a.score);
  // Return only one line (the most plausible one if PSM6 produced multi-line)
  return runs[0].lines[0] || runs[0].text;
}

// ---------- IPC: OCR (labels) ----------
ipcMain.handle('ocr', async (_evt, u8) => {
  try {
    ensureDir(path.join(__dirname, 'captures'));
    const raw = Buffer.from(u8);
    fs.writeFileSync(path.join(__dirname, 'captures', 'last-crop.png'), raw);

    // --- crop zones (bound-safe) ---
    const { title, type, names } = await cropLabelZones(raw);

    // --- preprocess per zone (labels pipeline you already have) ---
    const preTitle = title ? await preprocessLabels(title) : null;
    const preType  = type  ? await preprocessLabels(type)  : null;
    const preNames = names ? await preprocessLabels(names) : null;

    if (preTitle) fs.writeFileSync(path.join(__dirname, 'captures', 'pre-label-title.png'), preTitle);
    if (preType)  fs.writeFileSync(path.join(__dirname, 'captures', 'pre-label-type.png'),  preType);
    if (preNames) fs.writeFileSync(path.join(__dirname, 'captures', 'pre-label-names.png'), preNames);

    // --- OCR each zone with the best page segmentation for it ---
    // Title can wrap into two lines → PSM 6 then keep ONLY its first line as the item name
    const tTitleFirst = preTitle
      ? ((await Tesseract.recognize(preTitle, 'eng', {
            user_defined_dpi: '340',
            tessedit_pageseg_mode: 6
          })).data.text || '').split(/\n+/).map(s => s.trim()).filter(Boolean)[0] || ''
      : '';

    // TYPE must be a single line → use ocrLineSmart (prefers PSM 7, falls back to 6)
    const tType = preType ? await ocrLineSmart(preType) : '';

    // Left stat names → block text (PSM 6)
    const tNames = preNames
      ? ((await Tesseract.recognize(preNames, 'eng', {
            user_defined_dpi: '340',
            tessedit_pageseg_mode: 6,
            preserve_interword_spaces: 1
          })).data.text || '').trim()
      : '';

    // Merge & de‑duplicate (prevents "Gloves" twice if it sneaks through)
    let merged = [tTitleFirst, tType, tNames].filter(Boolean).join('\n');
    merged = dedupAdjacentLines(merged);

    // Fallback: if zones produced nothing useful, OCR the full panel (best‑of 4/6/3)
    if (!/[A-Za-z]/.test(merged) || merged.length < 8) {
      const preFull = await preprocessLabels(raw);
      fs.writeFileSync(path.join(__dirname, 'captures', 'pre-label-full.png'), preFull);
      merged = await ocrLabels(preFull);
    }

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

    // Save candidates so you can see what won
    ensureDir(path.join(__dirname, 'captures'));
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-digits-0-base.png'), debugBase);
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-digits-A-normal150.png'), thrA);
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-digits-B-invert150.png'), thrB);
    fs.writeFileSync(path.join(__dirname, 'captures', 'pre-digits-C-normal150.png'), thrC);

    const cfg = {
      logger: () => {},
      tessedit_pageseg_mode: 6,
      tessedit_char_whitelist: '0123456789.+%:-/',  // allow + and - just in case
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
const cleaned  = normalizeDigits(bestText);
fs.writeFileSync(path.join(__dirname, 'captures', 'last-ocr-digits.txt'), cleaned, 'utf8');
return cleaned;

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
