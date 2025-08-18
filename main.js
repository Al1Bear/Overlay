// main.js
const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

// ---------- paths & utils ----------
let win;
const CAP_DIR = () => {
  const p = path.join(app.getPath('userData'), 'captures');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
};
const ensure = (p) => { const d = path.dirname(p); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };
const writeBuf = (p, buf) => { ensure(p); fs.writeFileSync(p, buf); };
const writeTxt = (p, s) => { ensure(p); fs.writeFileSync(p, s, 'utf8'); };

// ---------- ratio helpers ----------
function clampRect(x, y, width, height, imageWidth, imageHeight) {
  if (x < 0) { width += x; x = 0; }
  if (y < 0) { height += y; y = 0; }
  if (x + width > imageWidth) { width = imageWidth - x; }
  if (y + height > imageHeight) { height = imageHeight - y; }
  if (width < 0) width = 0;
  if (height < 0) height = 0;
  return { x, y, width, height };
}
function rr(meta, r) {
  const W = meta.width, H = meta.height;
  return clampRect(
    Math.round(r.left * W),
    Math.round(r.top  * H),
    Math.round(r.w    * W),
    Math.round(r.h    * H),
    W, H
  );
}

// ---------- label zones (ratios) ----------
// tuned to your samples; adjust a hair if a theme shifts
const Z_TITLE = { left: 0.26, top: 0.04, w: 0.70, h: 0.12 };
const Z_TYPE  = { left: 0.33, top: 0.21, w: 0.40, h: 0.05 }; // single line
const Z_NAMES = { left: 0.06, top: 0.26, w: 0.48, h: 0.62 };

// digits area (right column values)
const Z_DIGITS = { left: 0.62, top: 0.26, w: 0.34, h: 0.62 };

// ---------- preprocessing ----------
async function prepLabel(buf) {
  return await sharp(buf).greyscale().normalize().gamma(1.2).sharpen().png().toBuffer();
}
async function prepDigitsVariant(buf, variant) {
  let s = sharp(buf).greyscale().normalize().gamma(1.15).sharpen();
  if (variant === 'invert') s = s.negate();            // strong contrast
  if (variant === 'hard')   s = s.linear(1.25, -10).threshold(150);
  return await s.png().toBuffer();
}

// ---------- OCR helpers ----------
async function ocrText(buf, { psm = 6, wl } = {}) {
  const cfg = {
    tessedit_pageseg_mode: psm,
    user_defined_dpi: '340'
  };
  if (wl) cfg.tessedit_char_whitelist = wl;
  const { data } = await Tesseract.recognize(buf, 'eng', cfg);
  return (data.text || '').replace(/\r/g, '').trim();
}
function pickBestDigits(cands) {
  // choose the one with most numeric tokens
  const score = (t) => (t.match(/\d/g) || []).length + (t.match(/\+/g) || []).length + (t.match(/%/g) || []).length;
  let best = cands[0], bestScore = score(cands[0] || '');
  for (let i = 1; i < cands.length; i++) {
    const sc = score(cands[i] || '');
    if (sc > bestScore) { best = cands[i]; bestScore = sc; }
  }
  return best || '';
}

// ---------- main window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: true
  });
  win.setTitle('Gear OCR Overlay');
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------- IPC: capture full screen ----------
ipcMain.handle('capture-screen', async () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  });
  const src = sources[0]; // primary (good enough for overlay)
  const png = src.thumbnail.toPNG();
  return png;
});

// ---------- IPC: OCR on provided panel buffer ----------
ipcMain.handle('ocr', async (_evt, u8) => {
  const capDir = CAP_DIR();
  const panelBuf = Buffer.from(u8);
  writeBuf(path.join(capDir, 'last-crop.png'), panelBuf);

  // metadata
  const meta = await sharp(panelBuf).metadata();

  // crop label zones
  const tRect = rr(meta, Z_TITLE);
  const yRect = rr(meta, Z_TYPE);
  const nRect = rr(meta, Z_NAMES);

  const titleBuf = await sharp(panelBuf).extract({ left: tRect.x, top: tRect.y, width: tRect.width, height: tRect.height }).png().toBuffer();
  const typeBuf  = await sharp(panelBuf).extract({ left: yRect.x, top: yRect.y, width: yRect.width, height: yRect.height }).png().toBuffer();
  const namesBuf = await sharp(panelBuf).extract({ left: nRect.x, top: nRect.y, width: nRect.width, height: nRect.height }).png().toBuffer();

  const preTitle = await prepLabel(titleBuf);
  const preType  = await prepLabel(typeBuf);
  const preNames = await prepLabel(namesBuf);

  writeBuf(path.join(capDir, 'pre-label-title.png'), preTitle);
  writeBuf(path.join(capDir, 'pre-label-type.png'),  preType);
  writeBuf(path.join(capDir, 'pre-label-names.png'), preNames);

  // OCR labels (zones only)
  const titleText = await ocrText(preTitle, { psm: 6 });
  const typeText  = await ocrText(preType,  { psm: 7 });
  const namesText = await ocrText(preNames, { psm: 6 });

  // digits crop
  const dRect = rr(meta, Z_DIGITS);
  const digitsCrop = await sharp(panelBuf).extract({ left: dRect.x, top: dRect.y, width: dRect.width, height: dRect.height }).png().toBuffer();

  // digits variants
  const dA = await prepDigitsVariant(digitsCrop, 'base');
  const dB = await prepDigitsVariant(digitsCrop, 'invert');
  const dC = await prepDigitsVariant(digitsCrop, 'hard');

  writeBuf(path.join(capDir, 'pre-digits-A-normal.png'), dA);
  writeBuf(path.join(capDir, 'pre-digits-B-invert.png'), dB);
  writeBuf(path.join(capDir, 'pre-digits-C-normal.png'), dC);

  // OCR digits on each; choose best
  const DA = await ocrText(dA, { psm: 6, wl: '0123456789+.%' });
  const DB = await ocrText(dB, { psm: 6, wl: '0123456789+.%' });
  const DC = await ocrText(dC, { psm: 6, wl: '0123456789+.%' });
  const digitsText = pickBestDigits([DA, DB, DC])
    .split(/\n+/).map(s => s.trim()).filter(Boolean).join('\n');

  writeTxt(path.join(capDir, 'last-ocr-digits.txt'), digitsText);

  // Build a single label block (title, type, then names)
  const labelLines = [];
  if (titleText) labelLines.push(titleText.trim());
  if (typeText)  labelLines.push(typeText.trim());
  if (namesText) {
    const lines = namesText.split(/\n+/).map(s => s.trim()).filter(Boolean);
    labelLines.push(...lines);
  }
  const labelText = labelLines.join('\n');
  writeTxt(path.join(capDir, 'last-ocr-labels.txt'), labelText);

  return { labelText, digitsText };
});

// ---------- optional save helpers ----------
ipcMain.on('set-title', (_e, t) => { if (win && t) win.setTitle(String(t)); });

ipcMain.handle('save-text', async (_e, txt) => {
  const p = path.join(CAP_DIR(), 'last-ocr.txt');
  writeTxt(p, String(txt || ''));
  return [p];
});

ipcMain.handle('save-json', async (_e, jsonish) => {
  const p = path.join(CAP_DIR(), 'gear.json');
  let obj;
  try { obj = typeof jsonish === 'string' ? JSON.parse(jsonish) : jsonish; }
  catch { obj = jsonish; }
  writeTxt(p, JSON.stringify(obj, null, 2));
  return [p];
});
