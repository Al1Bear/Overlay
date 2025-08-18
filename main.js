// main.js
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

let sideWin = null;   // sidebar (controller)
let roiWin  = null;   // green ROI frame
let autoOn = false;
let autoTimer = null;
let autoState = 'idle';  // 'idle' | 'watching' | 'capturing'
let isEditing = false;

// ---- persistence -------------------------------------------------------------
const CFG_PATH = () => path.join(app.getPath('userData'), 'overlay.json');
function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG_PATH(), 'utf8')); } catch { return {}; } }
function saveCfg(obj) { try { fs.writeFileSync(CFG_PATH(), JSON.stringify(obj, null, 2), 'utf8'); } catch {} }

const cfg = loadCfg();
if (!cfg.roi) cfg.roi = { x: 160, y: 120, w: 640, h: 760 };
// ⚠️ Do NOT access 'screen' before app is ready.
// Put a neutral placeholder here; we’ll finalize inside createWindows().
if (!cfg.side) cfg.side = { x: 20, y: 20 };
					   
// ---- debug folder ------------------------------------------------------------
const CAP_DIR = () => {
  const p = path.join(app.getPath('userData'), 'captures');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
};
const writeBuf = (p, b) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
const writeTxt = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); };
  // Now it's safe to use 'screen' (we're inside app.whenReady())
  try {
    if (!cfg.side || typeof cfg.side.x !== 'number' || typeof cfg.side.y !== 'number') {
      const prim = screen.getPrimaryDisplay();
      cfg.side = { x: prim.bounds.x + 20, y: prim.bounds.y + 20 };
      saveCfg(cfg);
    }
  } catch {}
// ---- windows ----------------------------------------------------------------
function createWindows() {
  // Sidebar: framed, movable, close/minimize, always on top
  sideWin = new BrowserWindow({
    width: 280, height: 300,
    x: cfg.side.x, y: cfg.side.y,
    alwaysOnTop: true, frame: true, resizable: true,
    transparent: false, skipTaskbar: false, focusable: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  sideWin.setTitle('Gear OCR Overlay');
  sideWin.loadFile('index.html');

  sideWin.on('move', () => { try { cfg.side = sideWin.getBounds(); saveCfg(cfg); } catch {} });
  sideWin.on('close', (e) => { // keep process alive if sidebar closes
    e.preventDefault();
    sideWin.hide();
  });

  // ROI frame: click-through by default, focusable only when editing
  roiWin = new BrowserWindow({
    x: cfg.roi.x, y: cfg.roi.y, width: cfg.roi.w, height: cfg.roi.h,
    frame: false, resizable: false, movable: true,
    transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  roiWin.loadFile('roi.html');
  roiWin.setIgnoreMouseEvents(true, { forward: true });

  // Hotkeys
  app.whenReady().then(() => {
    try {
      // Show/Hide box
      globalShortcut.register('F7', () => {
        if (!roiWin) return;
        roiWin.isVisible() ? roiWin.hide() : roiWin.show();
        sideWin && sideWin.webContents.send('side:status', roiWin.isVisible() ? 'Box shown' : 'Box hidden');
      });
      // Toggle Edit
      globalShortcut.register('F8', () => sideWin && sideWin.webContents.send('side:editToggle'));
      // Snap
      globalShortcut.register('F9', () => sideWin && sideWin.webContents.send('side:snap'));
      // Auto on/off
      globalShortcut.register('F10', () => sideWin && sideWin.webContents.send('side:autoToggle'));
      // Panic stop (always works)
      globalShortcut.register('CommandOrControl+F10', () => {
        stopAuto();
        try { roiWin.showInactive ? roiWin.showInactive() : roiWin.show(); } catch {}
        try { roiWin.setIgnoreMouseEvents(true, { forward: true }); } catch {}
        try { sideWin.show(); } catch {}
        sideWin && sideWin.webContents.send('side:status', 'Auto stopped (panic).');
      });
    } catch {}
  });
}

app.whenReady().then(createWindows);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindows(); });

// ---- helpers ----------------------------------------------------------------
function getRoiBounds() {
  try {
    return roiWin.getBounds();          // do not mutate here
  } catch {
    return { x: cfg.roi.x, y: cfg.roi.y, width: cfg.roi.w, height: cfg.roi.h };
  }
}
ipcMain.handle('roi:get', () => getRoiBounds());

function getDisplayForRoi() {
  const b = getRoiBounds();
  const cx = b.x + Math.floor(b.width / 2);
  const cy = b.y + Math.floor(b.height / 2);
  const displays = screen.getAllDisplays();
  return displays.find(d =>
    cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width &&
    cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height
  ) || screen.getPrimaryDisplay();
}

async function captureScreenOfDisplay(display, { hideFrame = false } = {}) {
  // Only hide the ROI when we are about to OCR-capture; keep it visible during sampling.
  const roiWasVisible = hideFrame && roiWin && roiWin.isVisible();
  if (roiWasVisible) {
    try { roiWin.hide(); } catch {}
  }

  let image, width, height;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: display.size.width, height: display.size.height } // native
    });
    // pick the source that best matches this display's size
    const target = sources.find(s => {
      const sz = s.thumbnail.getSize();
      return Math.abs(sz.width - display.size.width) < 8 && Math.abs(sz.height - display.size.height) < 8;
    }) || sources[0];

    image = target.thumbnail;
    const sz = image.getSize();
    width = sz.width; height = sz.height;
  } finally {
    if (roiWasVisible) {
      try { roiWin.showInactive ? roiWin.showInactive() : roiWin.show(); } catch {}
    }
  }

  return { png: image.toPNG(), width, height, display };
}

function clampRect(x, y, width, height, imageWidth, imageHeight) {
  if (x < 0) { width += x; x = 0; }
  if (y < 0) { height += y; y = 0; }
  if (x + width > imageWidth) { width = imageWidth - x; }
  if (y + height > imageHeight) { height = imageHeight - y; }
  if (width < 0) width = 0;
  if (height < 0) height = 0;
  return { x, y, width, height };
}

async function cropRoiFromPng(screenPng, screenW, screenH, display, roiBounds) {
  // ROI is in global DIP coords (same as BrowserWindow); thumbnails are raw pixels per display
  const dx = roiBounds.x - display.bounds.x;
  const dy = roiBounds.y - display.bounds.y;
  const rect = clampRect(dx, dy, roiBounds.width, roiBounds.height, screenW, screenH);
  return await sharp(screenPng).extract({
    left: rect.x, top: rect.y, width: rect.width, height: rect.height
  }).png().toBuffer();
}

// ---- OCR (zones) ------------------------------------------------------------
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
const Z_TITLE = { left: 0.26, top: 0.04, w: 0.70, h: 0.12 };
const Z_TYPE  = { left: 0.33, top: 0.21, w: 0.40, h: 0.05 };
const Z_NAMES = { left: 0.06, top: 0.26, w: 0.48, h: 0.62 };
const Z_DIGITS= { left: 0.62, top: 0.26, w: 0.34, h: 0.62 };

async function prepLabel(buf) {
  return await sharp(buf).greyscale().normalize().gamma(1.2).sharpen().png().toBuffer();
}
async function prepDigitsVariant(buf, variant) {
  let s = sharp(buf).greyscale().normalize().gamma(1.15).sharpen();
  if (variant === 'invert') s = s.negate();
  if (variant === 'hard')   s = s.linear(1.25, -10).threshold(150);
  return await s.png().toBuffer();
}
async function ocrText(buf, { psm = 6, wl } = {}) {
  const cfg = { tessedit_pageseg_mode: psm, user_defined_dpi: '340' };
  if (wl) cfg.tessedit_char_whitelist = wl;
  const { data } = await Tesseract.recognize(buf, 'eng', cfg);
  return (data.text || '').replace(/\r/g, '').trim();
}
function bestDigits(cands) {
  const score = (t) => (t.match(/\d/g) || []).length + (t.match(/\+/g) || []).length + (t.match(/%/g) || []).length;
  let best = cands[0], bestScore = score(cands[0] || '');
  for (let i=1;i<cands.length;i++){ const sc=score(cands[i]||''); if (sc>bestScore){best=cands[i]; bestScore=sc;} }
  return best || '';
}

async function runOCRFromRoiBuffer(roiBuf) {
  const capDir = CAP_DIR();
  writeBuf(path.join(capDir, 'last-crop.png'), roiBuf);

  const meta = await sharp(roiBuf).metadata();

  const tRect = rr(meta, Z_TITLE);
  const yRect = rr(meta, Z_TYPE);
  const nRect = rr(meta, Z_NAMES);
  const dRect = rr(meta, Z_DIGITS);

  const titleBuf = await sharp(roiBuf).extract({ left: tRect.x, top: tRect.y, width: tRect.width, height: tRect.height }).png().toBuffer();
  const typeBuf  = await sharp(roiBuf).extract({ left: yRect.x, top: yRect.y, width: yRect.width, height: yRect.height }).png().toBuffer();
  const namesBuf = await sharp(roiBuf).extract({ left: nRect.x, top: nRect.y, width: nRect.width, height: nRect.height }).png().toBuffer();
  const digitsCrop = await sharp(roiBuf).extract({ left: dRect.x, top: dRect.y, width: dRect.width, height: dRect.height }).png().toBuffer();

  const preTitle = await prepLabel(titleBuf);
  const preType  = await prepLabel(typeBuf);
  const preNames = await prepLabel(namesBuf);

  writeBuf(path.join(capDir, 'pre-label-title.png'), preTitle);
  writeBuf(path.join(capDir, 'pre-label-type.png'),  preType);
  writeBuf(path.join(capDir, 'pre-label-names.png'), preNames);

  const titleText = await ocrText(preTitle, { psm: 6 });
  const typeText  = await ocrText(preType,  { psm: 7 });
  const namesText = await ocrText(preNames, { psm: 6 });

  const dA = await prepDigitsVariant(digitsCrop, 'base');
  const dB = await prepDigitsVariant(digitsCrop, 'invert');
  const dC = await prepDigitsVariant(digitsCrop, 'hard');
  writeBuf(path.join(capDir, 'pre-digits-A-normal.png'), dA);
  writeBuf(path.join(capDir, 'pre-digits-B-invert.png'), dB);
  writeBuf(path.join(capDir, 'pre-digits-C-normal.png'), dC);
  const DA = await ocrText(dA, { psm: 6, wl: '0123456789+.%' });
  const DB = await ocrText(dB, { psm: 6, wl: '0123456789+.%' });
  const DC = await ocrText(dC, { psm: 6, wl: '0123456789+.%' });
  const digitsText = bestDigits([DA, DB, DC]).split(/\n+/).map(s=>s.trim()).filter(Boolean).join('\n');

  writeTxt(path.join(capDir, 'last-ocr-labels.txt'), [titleText, typeText, namesText].join('\n'));
  writeTxt(path.join(capDir, 'last-ocr-digits.txt'), digitsText);

  const labelLines = [titleText, typeText, ...String(namesText).split(/\n+/).map(s=>s.trim()).filter(Boolean)];
  const D = String(digitsText).split(/\n+/).map(s=>s.trim()).filter(Boolean);

  const title = labelLines[0] || '—';
  const type  = labelLines[1] || '';
  const names = labelLines.slice(type ? 2 : 1);
  const main  = (names[0] || '') + (D[0] ? (' ' + D[0]) : '');
  const subs  = [];
  for (let i=1;i<Math.min(5, names.length, D.length); i++) subs.push(`${names[i]} ${D[i]}`);

  const out = [`Title: ${title}`];
  if (type) out.push(`Type: ${type}`);
  out.push(`Main: ${main}`);
  for (const s of subs) out.push(`Sub: ${s}`);

  return out;
}

// ---- Auto sampling (hash-stabilized) ----------------------------------------
let lastStableHash = null;      // most recent stable hash
let lastCapturedHash = null;    // hash used for the last OCR capture
let stableCount = 0;            // how many consecutive frames the hash stayed the same

const SAMPLE_MS = 500;          // sample interval
const STABLE_FRAMES = 2;        // frames required to consider ROI "stable"

// quick helper: compute a tiny hash of the digits area so we can detect changes cheaply
async function computeDigitsHashFromRoi(roiBuf) {
  const meta = await sharp(roiBuf).metadata();
  const z = rr(meta, Z_DIGITS);  // safe rect but still clamp just in case
  const minW = 16, minH = 10;
  const w = Math.max(minW, Math.min(z.width,  meta.width  - z.x));
  const h = Math.max(minH, Math.min(z.height, meta.height - z.y));
  const x = Math.max(0, Math.min(z.x, meta.width  - w));
  const y = Math.max(0, Math.min(z.y, meta.height - h));

  const { data } = await sharp(roiBuf)
    .extract({ left: x, top: y, width: w, height: h })
    .greyscale()
    .resize(64, 16, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: false });

  let h1 = 0, h2 = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] > 128 ? 1 : 0;
    h1 = ((h1 << 5) - h1 + v) >>> 0;
    h2 = ((h2 << 7) - h2 + ((i & 7) ? v : (v ^ 1))) >>> 0;
  }
  return h1.toString(16) + ':' + h2.toString(16);
}

async function tickAuto() {
  if (!autoOn) return;
  try {
    const dpy = getDisplayForRoi();
    // During sampling: DO NOT hide the ROI frame (no flicker, less work)
    const { png, width, height } = await captureScreenOfDisplay(dpy, { hideFrame: false });
    const roiB = getRoiBounds();
    const roiBuf = await cropRoiFromPng(png, width, height, dpy, roiB);

    const hash = await computeDigitsHashFromRoi(roiBuf);

    // accumulate stability
    if (hash === lastStableHash) {
      stableCount++;
    } else {
      lastStableHash = hash;
      stableCount = 1;
    }

    // When stable for N frames AND the content changed versus last capture -> capture & OCR
    if (stableCount >= STABLE_FRAMES && hash !== lastCapturedHash) {
      // Do the *real* capture with frame hidden
      const cap = await captureScreenOfDisplay(dpy, { hideFrame: true });
      const capBuf = await cropRoiFromPng(cap.png, cap.width, cap.height, dpy, roiB);
      const lines = await runOCRFromRoiBuffer(capBuf);
      lastCapturedHash = hash;
      sideWin && sideWin.webContents.send('side:update', { lines, status: 'Captured ✓' });
    }
  } catch (e) {
    sideWin && sideWin.webContents.send('side:update', { lines: ['(auto error)'], status: 'Auto error → stopped' });
    stopAuto();
  }
}
const r = getRoiBounds();
if (r.width < 120 || r.height < 80) {
  sideWin && sideWin.webContents.send('side:status', 'Auto: ROI too small (<120×80)');
  stopAuto();
  return false;
}

function startAuto() {
  if (autoOn) return true;
  autoOn = true;
  lastStableHash = null;
  lastCapturedHash = null;
  stableCount = 0;
  autoTimer = setInterval(tickAuto, SAMPLE_MS);
  sideWin && sideWin.webContents.send('side:status', 'Auto: watching digits…');
  return true;
}
function stopAuto() {
  if (!autoOn) return false;
  autoOn = false;
  clearInterval(autoTimer);
  autoTimer = null;
  sideWin && sideWin.webContents.send('side:status', 'Auto: off');
  return true;
}


// ---- IPC --------------------------------------------------------------------
ipcMain.handle('roi:set', async (_e, b) => {
  // Keep these in sync with roi.js
  const MIN_W = 60, MIN_H = 60;

  // Normalize / round to DIP
  let x = Math.round(b.x);
  let y = Math.round(b.y);
  let w = Math.max(MIN_W, Math.round(b.width));
  let h = Math.max(MIN_H, Math.round(b.height));

  // Constrain to virtual desktop bounds (all monitors)
  const displays = screen.getAllDisplays();
  const maxRight  = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
  const maxBottom = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > maxRight)  x = Math.max(0, maxRight  - w);
  if (y + h > maxBottom) y = Math.max(0, maxBottom - h);

  cfg.roi = { x, y, w, h };
  try {
    roiWin.setBounds({ x, y, width: w, height: h }, false);
  } catch {}
  saveCfg(cfg);
  return cfg.roi;
});

ipcMain.handle('roi:edit', (_e, on) => {
  isEditing = !!on;
  // pause auto while editing
  if (isEditing && autoOn) stopAuto();

  roiWin.setIgnoreMouseEvents(!isEditing, { forward: true });
  roiWin.setFocusable(isEditing);
  if (isEditing) { try { roiWin.focus(); } catch {} }
  roiWin.webContents.send('roi:edit', isEditing);
  return true;
});

ipcMain.handle('roi:toggle-visible', () => {
  if (!roiWin) return false;
  if (roiWin.isVisible()) roiWin.hide(); else roiWin.show();
  return roiWin.isVisible();
});

ipcMain.handle('snap', async () => {
  const dpy = getDisplayForRoi();
  const { png, width, height } = await captureScreenOfDisplay(dpy, { hideFrame: true });
  const roiB = getRoiBounds();
  const roiBuf = await cropRoiFromPng(png, width, height, dpy, roiB);
  const lines = await runOCRFromRoiBuffer(roiBuf);
  sideWin && sideWin.webContents.send('side:update', { lines, status: 'Captured ✓' });
  return lines;
});


ipcMain.handle('auto', (_e, on) => {
  if (on) return startAuto();
  return stopAuto();
});

// Sidebar convenience (button relays)
ipcMain.handle('save-text', (_e, t) => {
  const p = path.join(CAP_DIR(), 'last-ocr.txt');
  writeTxt(p, String(t || ''));
  return [p];
});
