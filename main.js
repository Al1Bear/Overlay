// main.js
const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

// ---------- windows ----------
let controller = null; // index.html
let hud = null;        // hud.html
let boundSourceId = null; // desktopCapturer window id
let autoOn = false;

// ROI ratios (relative to bound window image): 0..1
let roi = { left: 0.53, top: 0.13, w: 0.43, h: 0.80 };

function capDir() {
  const p = path.join(app.getPath('userData'), 'captures');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}
function writeBuf(p, buf) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
function writeTxt(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); }

function createWindows() {
  controller = new BrowserWindow({
    width: 920, height: 680, minWidth: 720, minHeight: 560,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  controller.setTitle('Gear OCR Controller');
  controller.loadFile('index.html');

  // small HUD overlay (click-through)
  hud = new BrowserWindow({
    width: 280, height: 180,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, focusable: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  hud.loadFile('hud.html');
  hud.setIgnoreMouseEvents(true, { forward: true }); // click-through by default

  // place HUD near top-right of primary screen
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  hud.setBounds({ x: Math.max(20, width - 320), y: 80, width: 280, height: 180 });

  // global hotkeys like HDT
  app.whenReady().then(() => {
    try {
      globalShortcut.register('F7', () => {
        if (!hud) return;
        hud.isVisible() ? hud.hide() : hud.show();
      });
      globalShortcut.register('F8', () => {
        if (!hud) return;
        hud.webContents.send('hud-edit', true);
        setTimeout(() => hud && hud.webContents.send('hud-edit', false), 3000);
      });
      globalShortcut.register('F9', () => { controller && controller.webContents.send('main-event', { type: 'snap-now' }); });
      globalShortcut.register('F10', () => { controller && controller.webContents.send('main-event', { type: 'auto-toggle' }); });
    } catch {}
  });
}

app.whenReady().then(createWindows);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindows(); });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });

// ---------- binding & capture ----------
ipcMain.handle('list-windows', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'], fetchWindowIcons: true, thumbnailSize: { width: 400, height: 400 } });
  return sources.map(s => ({ id: s.id, name: s.name }));
});
ipcMain.handle('auto-bind', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'], fetchWindowIcons: true, thumbnailSize: { width: 400, height: 400 } });
  const guess = sources.find(s => /Dragonheir|Silent\s*Gods/i.test(s.name));
  if (guess) boundSourceId = guess.id;
  return { ok: !!guess, id: boundSourceId, name: guess?.name || '' };
});
ipcMain.handle('bind-window', async (_e, id) => {
  boundSourceId = id || null;
  return { ok: !!boundSourceId };
});
ipcMain.handle('capture-bound', async () => {
  if (!boundSourceId) throw new Error('No window bound');
  // Large thumb so we get good OCR pixels
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 4096, height: 4096 } });
  let src = sources.find(s => s.id === boundSourceId);
  if (!src) src = sources.find(s => /Dragonheir|Silent\s*Gods/i.test(s.name));
  if (!src) throw new Error('Bound window not found');
  const image = src.thumbnail;
  const size = image.getSize(); // {width,height}
  return { png: image.toPNG(), width: size.width, height: size.height, name: src.name };
});

// ---------- HUD IPC ----------
ipcMain.on('hud-text', (_e, { lines, pulse, roiPixels, showROI }) => {
  if (!hud) return;
  // Forward to HUD window
  hud.webContents.send('hud-update', {
    lines: Array.isArray(lines) ? lines.slice(0,7) : [],
    pulse: !!pulse,
    showROI: !!showROI,
    roi: roiPixels || null
  });
});
ipcMain.handle('hud-clickthrough', (_e, on) => {
  if (!hud) return false;
  const clickThrough = !!on;
  hud.setIgnoreMouseEvents(clickThrough, { forward: true });
  return true;
});
ipcMain.handle('hud-move', (_e, { x, y }) => {
  if (!hud) return false;
  const b = hud.getBounds();
  hud.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
  return true;
});
ipcMain.handle('hud-bounds', () => {
  if (!hud) return { x:0, y:0, width:0, height:0 };
  return hud.getBounds();
});

// relay hotkeys from controller (if needed)
ipcMain.on('auto-toggle', (_e, on) => {
  controller && controller.webContents.send('main-event', { type: 'auto-toggle', on: !!on });
});
ipcMain.on('snap-now', () => {
  controller && controller.webContents.send('main-event', { type: 'snap-now' });
});

// ---------- OCR pipeline: zones only + digits 3-pass ----------
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

// label/digits zone ratios (tuned for your panel)
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

ipcMain.handle('ocr', async (_evt, u8) => {
  const dir = capDir();
  const panelBuf = Buffer.from(u8);
  writeBuf(path.join(dir, 'last-crop.png'), panelBuf);

  const meta = await sharp(panelBuf).metadata();

  const tRect = rr(meta, Z_TITLE);
  const yRect = rr(meta, Z_TYPE);
  const nRect = rr(meta, Z_NAMES);

  const titleBuf = await sharp(panelBuf).extract({ left: tRect.x, top: tRect.y, width: tRect.width, height: tRect.height }).png().toBuffer();
  const typeBuf  = await sharp(panelBuf).extract({ left: yRect.x, top: yRect.y, width: yRect.width, height: yRect.height }).png().toBuffer();
  const namesBuf = await sharp(panelBuf).extract({ left: nRect.x, top: nRect.y, width: nRect.width, height: nRect.height }).png().toBuffer();

  const preTitle = await prepLabel(titleBuf);
  const preType  = await prepLabel(typeBuf);
  const preNames = await prepLabel(namesBuf);

  writeBuf(path.join(dir, 'pre-label-title.png'), preTitle);
  writeBuf(path.join(dir, 'pre-label-type.png'),  preType);
  writeBuf(path.join(dir, 'pre-label-names.png'), preNames);

  const titleText = await ocrText(preTitle, { psm: 6 });
  const typeText  = await ocrText(preType,  { psm: 7 });
  const namesText = await ocrText(preNames, { psm: 6 });

  const dRect = rr(meta, Z_DIGITS);
  const digitsCrop = await sharp(panelBuf).extract({ left: dRect.x, top: dRect.y, width: dRect.width, height: dRect.height }).png().toBuffer();
  const dA = await prepDigitsVariant(digitsCrop, 'base');
  const dB = await prepDigitsVariant(digitsCrop, 'invert');
  const dC = await prepDigitsVariant(digitsCrop, 'hard');

  writeBuf(path.join(dir, 'pre-digits-A-normal.png'), dA);
  writeBuf(path.join(dir, 'pre-digits-B-invert.png'), dB);
  writeBuf(path.join(dir, 'pre-digits-C-normal.png'), dC);

  const DA = await ocrText(dA, { psm: 6, wl: '0123456789+.%' });
  const DB = await ocrText(dB, { psm: 6, wl: '0123456789+.%' });
  const DC = await ocrText(dC, { psm: 6, wl: '0123456789+.%' });
  const digitsText = bestDigits([DA, DB, DC])
    .split(/\n+/).map(s=>s.trim()).filter(Boolean).join('\n');

  writeTxt(path.join(dir, 'last-ocr-labels.txt'), [titleText, typeText, namesText].join('\n'));
  writeTxt(path.join(dir, 'last-ocr-digits.txt'), digitsText);

  return { labelText: [titleText, typeText, namesText].join('\n'), digitsText };
});

// ---------- save text ----------
ipcMain.handle('save-text', async (_e, txt) => {
  const p = path.join(capDir(), 'last-ocr.txt');
  writeTxt(p, String(txt || ''));
  return [p];
});
ipcMain.on('set-title', (_e, t) => controller && controller.setTitle(String(t)));
