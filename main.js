// main.js — Frameless HUD + manual ROI + smart camera (OCR-in-memory, no files)
const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  desktopCapturer,
  nativeImage,
  globalShortcut
} = require('electron');

// === NEW: smart-camera deps (in-memory only) ===
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

// ---------------- HUD / ROI state ----------------
let hudWin = null;              // compact frameless HUD
let hudVisible = true;
const HUD_W = 460;
const HUD_H_COLLAPSED = 56;
const HUD_H_EXPANDED = 160;

let roiWin = null;              // green box overlay
let roi = { x: 220, y: 220, width: 540, height: 680 };
let roiVisible = true;
let roiEditing = false;
const MIN_W = 80, MIN_H = 80;

// ---------------- Auto-capture state -------------
let autoOn = false;
let autoTimer = null;
let sigHistory = [];
const AUTO_INTERVAL_MS = 700;
const SIG_HISTORY_N = 4;
const SIG_TRIGGER = 500;       // larger = less sensitive
const STABLE_FRAMES = 2;
let changedStreak = 0;

// ---------------- Display helpers ----------------
function displayForRect(r) {
  const all = screen.getAllDisplays();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  let best = all[0], bestDist = Number.MAX_VALUE;
  for (const d of all) {
    const b = d.bounds;
    const inside = (cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height);
    if (inside) return d;
    const dx = Math.max(b.x - cx, 0, cx - (b.x + b.width));
    const dy = Math.max(b.y - cy, 0, cy - (b.y + b.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { best = d; bestDist = dist; }
  }
  return best;
}

function clampToDisplayRect(rect) {
  const d = displayForRect(rect).bounds;
  let x = Math.max(d.x, Math.min(rect.x, d.x + d.width - MIN_W));
  let y = Math.max(d.y, Math.min(rect.y, d.y + d.height - MIN_H));
  let w = Math.max(MIN_W, Math.min(rect.width, d.x + d.width - x));
  let h = Math.max(MIN_H, Math.min(rect.height, d.y + d.height - y));
  return { x, y, width: w, height: h };
}

// ---------------- Capture helpers ----------------
async function captureDisplayImageForROI() {
  const d = displayForRect(roi);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: d.size.width, height: d.size.height }
  });
  let src = sources.find(s => s.display_id === String(d.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('No screen capture source');
  return { img: src.thumbnail, display: d };
}

function cropToRoi(img, display) {
  const rx = roi.x - display.bounds.x;
  const ry = roi.y - display.bounds.y;
  return img.crop({ x: rx, y: ry, width: roi.width, height: roi.height });
}

// --- signature for auto-change detection (fast) ---
function signatureMasked(imgNative) {
  const small = imgNative.resize({ width: 220 });
  const bmp = small.toBitmap(); // BGRA
  const { width: sw, height: sh } = small.getSize();
  const zones = [
    { x: 0.10, y: 0.02, w: 0.80, h: 0.16 }, // title/type
    { x: 0.62, y: 0.20, w: 0.36, h: 0.72 }  // numeric column
  ];
  let sum = 0, count = 0;
  for (const z of zones) {
    const x0 = Math.max(0, Math.floor(sw * z.x));
    const y0 = Math.max(0, Math.floor(sh * z.y));
    const x1 = Math.min(sw, Math.floor(sw * (z.x + z.w)));
    const y1 = Math.min(sh, Math.floor(sh * (z.y + z.h)));
    for (let y = y0; y < y1; y += 2) {
      const row = y * sw * 4;
      for (let x = x0; x < x1; x += 2) {
        const i = row + x * 4;
        const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
        sum += (r * 3 + g * 4 + b * 2);
        count++;
      }
    }
  }
  return Math.floor(sum / Math.max(1, count));
}

function median(a) {
  const b = a.slice().sort((x, y) => x - y);
  const m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : Math.floor((b[m - 1] + b[m]) / 2);
}

// ---------------- SMART CAMERA (OCR) ----------------
// rotate portrait to upright; return { buf, orientation }
async function toRotatedPNG(native) {
  const { width, height } = native.getSize();
  let buf = native.toPNG();
  let orientation = 'landscape';
  if (height > width * 1.10) {
    orientation = 'portrait';
    buf = await sharp(buf).rotate(90).png().toBuffer();
  }
  return { buf, orientation };
}

function avgColorInBox(imgNative, x0, y0, x1, y1) {
  const { width, height } = imgNative.getSize();
  const bmp = imgNative.toBitmap(); // BGRA
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  x0 = clamp(Math.floor(x0), 0, width);
  y0 = clamp(Math.floor(y0), 0, height);
  x1 = clamp(Math.ceil(x1), 0, width);
  y1 = clamp(Math.ceil(y1), 0, height);

  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width * 4;
    for (let x = x0; x < x1; x++) {
      const i = row + x * 4;
      b += bmp[i]; g += bmp[i + 1]; r += bmp[i + 2];
      n++;
    }
  }
  if (!n) return { r: 0, g: 0, b: 0 };
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

function isBlue(c) {
  return (c.b - Math.max(c.r, c.g)) > 30 && c.b > 80; // tolerant blue check
}

function groupWordsByLines(words) {
  const filtered = (words || []).filter(w => w.text && w.text.trim());
  // sort by vertical center
  filtered.sort((a, b) => ((a.bbox.y0 + a.bbox.y1) / 2) - ((b.bbox.y0 + b.bbox.y1) / 2));
  const groups = [];
  const THRESH = 18; // px between line centers
  for (const w of filtered) {
    const yc = (w.bbox.y0 + w.bbox.y1) / 2;
    let g = groups.find(G => Math.abs(G.y - yc) <= THRESH);
    if (!g) { g = { y: yc, words: [] }; groups.push(g); }
    g.words.push(w);
    g.y = (g.y * (g.words.length - 1) + yc) / g.words.length;
  }
  for (const g of groups) g.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return groups;
}

function mergeAdjacentNumericTokens(tokens) {
  const out = [];
  for (const w of tokens) {
    if (!out.length) { out.push({ ...w }); continue; }
    const prev = out[out.length - 1];
    const gap = w.bbox.x0 - prev.bbox.x1;
    if (gap <= 8) {
      prev.text += w.text;
      prev.bbox.x1 = w.bbox.x1;
      prev.bbox.y0 = Math.min(prev.bbox.y0, w.bbox.y0);
      prev.bbox.y1 = Math.max(prev.bbox.y1, w.bbox.y1);
      prev.confidence = Math.min(prev.confidence, w.confidence);
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

function normalizeLabel(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/[^\w%()+]/g, ' ')
    .trim();
}

function parseNumberToken(t) {
  if (!t) return null;
  const txt = t.text.replace(/\s+/g, '');
  const cleaned = txt.replace(/[^0-9+.%]/g, '');
  const hasPct = /%/.test(cleaned);
  const num = parseFloat(cleaned.replace(/[+%]/g, ''));
  return {
    raw: cleaned,
    value: isNaN(num) ? null : num,
    unit: hasPct ? '%' : '',
    conf: (t.confidence || 0) / 100
  };
}

async function analyzeRoiSmart(native) {
  // 1) orient
  const { buf, orientation } = await toRotatedPNG(native);
  const oriented = nativeImage.createFromBuffer(buf);

  // 2) OCR once, then work from word boxes
  const { data } = await Tesseract.recognize(buf, 'eng', {});
  const groups = groupWordsByLines(data.words);

  const lines = [];
  for (const g of groups) {
    // only consider lines that actually contain numbers
    const words = g.words;
    const numericRaw = words.filter(w => /[0-9]/.test(w.text));
    if (!numericRaw.length) continue;

    const numeric = mergeAdjacentNumericTokens(numericRaw);
    const xFirstNum = Math.min(...numeric.map(n => n.bbox.x0));

    // label = all words fully left of the first numeric token
    const labelText = normalizeLabel(
      words
        .filter(w => w.bbox.x1 <= xFirstNum + 4 && !/[0-9]/.test(w.text))
        .map(w => w.text)
        .join(' ')
    );

    // base vs upgrade (blue)
    let base = null, upgrade = null;
    if (numeric.length === 1) {
      base = numeric[0];
    } else {
      const sorted = numeric.sort((a, b) =>

        ((a.bbox.x0 + a.bbox.x1) / 2) - ((b.bbox.x0 + b.bbox.x1) / 2)
      );
      const cand = sorted.slice(-2); // rightmost 2
      const samples = cand.map(w => ({
        w,
        c: avgColorInBox(oriented, w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1)
      }));
      const blueIdx = samples.findIndex(s => isBlue(s.c));
      if (blueIdx >= 0) {
        upgrade = cand[blueIdx];
        base = cand[1 - blueIdx] || cand[0];
      } else {
        base = cand[1] || cand[0];
      }
    }

    const baseParsed = parseNumberToken(base);
    const upParsed = parseNumberToken(upgrade);

    lines.push({
      label: labelText,
      base: baseParsed ? baseParsed.value : null,
      upgrade: upParsed ? upParsed.value : 0,
      unit: baseParsed && baseParsed.unit ? baseParsed.unit : (upParsed && upParsed.unit ? upParsed.unit : ''),
      y: g.y,
      confidence: Math.round(((baseParsed?.conf || 0) + (upParsed?.conf || 0)) / (upParsed ? 2 : 1) * 100) / 100
    });
  }

  // keep order top->bottom
  lines.sort((a, b) => a.y - b.y);

  // heuristic: the first 1–2 numbered lines are usually main stat block
  const mainStats = lines.slice(0, Math.min(2, lines.length));
  const substats = lines.slice(mainStats.length);

  return {
    lines,
    mainStats,
    substats,
    meta: { orientation }
  };
}

// ---------------- Auto loop ----------------
async function autoTick() {
  if (!hudWin || hudWin.isDestroyed() || roiEditing || !roiVisible) return;
  const wasVisible = roiVisible;
  if (roiWin && !roiWin.isDestroyed()) roiWin.hide();
  try {
    const { img, display } = await captureDisplayImageForROI();
    const crop = cropToRoi(img, display);
    const sig = signatureMasked(crop);
    sigHistory.push(sig);
    if (sigHistory.length > SIG_HISTORY_N) sigHistory.shift();
    const baseline = median(sigHistory);
    const diff = Math.abs(sig - baseline);

    if (diff > SIG_TRIGGER) {
      changedStreak++;
      if (changedStreak >= STABLE_FRAMES) {
        changedStreak = 0;
        sigHistory.length = 0;

        // === NEW: smart analyze only when stable ===
        const record = await analyzeRoiSmart(crop);

        hudWin.webContents.send('auto:capture', {
          roi,
          pngBase64: crop.toPNG().toString('base64'),
          record
        });
      }
    } else {
      changedStreak = 0;
    }
  } catch (e) {
    hudWin.webContents.send('log', `[auto] ${e.message}`);
  } finally {
    if (wasVisible && roiWin && !roiWin.isDestroyed()) roiWin.showInactive();
  }
}

function startAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(autoTick, AUTO_INTERVAL_MS);
}
function stopAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  changedStreak = 0;
  sigHistory = [];
}

// ---------------- Windows ----------------
function createHUD() {
  hudWin = new BrowserWindow({
    width: HUD_W,
    height: HUD_H_COLLAPSED,
    resizable: false,
    movable: true,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  hudWin.setAlwaysOnTop(true, 'screen-saver');
  hudWin.loadFile('index.html');
}

function createROI() {
  if (roiWin && !roiWin.isDestroyed()) return;
  roiWin = new BrowserWindow({
    ...roi,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  roiWin.loadFile('roi.html');
  roiWin.setAlwaysOnTop(true, 'screen-saver');
  roiWin.setIgnoreMouseEvents(true, { forward: true }); // locked by default
}

// ---------------- IPC ----------------
function registerIPC() {
  // ROI
  ipcMain.handle('roi:get', () => ({ ...roi, visible: roiVisible, editing: roiEditing }));
  ipcMain.handle('roi:set', (_e, rect) => {
    roi = clampToDisplayRect(rect);
    if (roiWin && !roiWin.isDestroyed()) {
      roiWin.setBounds(roi);
      roiWin.webContents.send('roi:bounds', roi);
    }
    hudWin && hudWin.webContents.send('roi:bounds', roi);
    return { ...roi };
  });
  ipcMain.handle('roi:edit', () => {
    roiEditing = !roiEditing;
    if (roiWin && !roiWin.isDestroyed()) {
      roiWin.setIgnoreMouseEvents(!roiEditing, { forward: true });
      roiWin.webContents.send('roi:editing', roiEditing);
    }
    hudWin && hudWin.webContents.send('roi:editing', roiEditing);
    if (autoOn) { roiEditing ? stopAuto() : startAuto(); }
    return roiEditing;
  });
  ipcMain.handle('roi:toggle-visible', () => {
    roiVisible = !roiVisible;
    if (!roiWin || roiWin.isDestroyed()) createROI();
    if (roiVisible) {
      roiWin.setBounds(roi);
      roiWin.showInactive();
    } else {
      roiWin.hide();
    }
    hudWin && hudWin.webContents.send('roi:visible', roiVisible);
    return roiVisible;
  });
  ipcMain.on('roi:hello', e => {
    e.sender.send('roi:bounds', roi);
    e.sender.send('roi:editing', roiEditing);
  });

  // Auto
  ipcMain.handle('auto:toggle', () => {
    autoOn = !autoOn;
    autoOn ? startAuto() : stopAuto();
    hudWin && hudWin.webContents.send('auto:state', autoOn);
    return autoOn;
  });

  // Snap (shared by hotkey + button)
  async function doSnap() {
    const wasVisible = roiVisible;
    if (wasVisible && roiWin && !roiWin.isDestroyed()) roiWin.hide();
    try {
      const { img, display } = await captureDisplayImageForROI();
      const crop = cropToRoi(img, display);
      const record = await analyzeRoiSmart(crop); // === NEW ===
      return {
        roi,
        pngBase64: crop.toPNG().toString('base64'),
        record
      };
    } finally {
      if (wasVisible && roiWin && !roiWin.isDestroyed()) roiWin.showInactive();
    }
  }
  ipcMain.handle('snap', doSnap);

  // HUD controls
  ipcMain.handle('hud:toggle', () => {
    if (!hudWin) return false;
    hudVisible = !hudVisible;
    hudVisible ? hudWin.show() : hudWin.hide();
    return hudVisible;
  });
  ipcMain.handle('hud:resize', (_e, height) => {
    if (!hudWin) return;
    const [x, y] = hudWin.getPosition();
    hudWin.setBounds({ x, y, width: HUD_W, height: height });
  });
  ipcMain.handle('hud:close-overlay', async () => {
    // hide HUD + ROI; turn off auto
    hudVisible = false;
    hudWin && hudWin.hide();
    if (autoOn) {
      autoOn = false; stopAuto(); hudWin && hudWin.webContents.send('auto:state', false);
    }
    if (roiVisible) {
      roiVisible = false; roiWin && roiWin.hide(); hudWin && hudWin.webContents.send('roi:visible', roiVisible);
    }
    return true;
  });

  // Hotkey -> tell renderer to run snap via API (keeps one codepath)
  ipcMain.on('hotkey:snap', async () => {
    hudWin && hudWin.webContents.send('hotkey:snap');
  });
}

// ---------------- Hotkeys ----------------
function registerHotkeys() {
  // Show/Hide HUD
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    hudVisible = !hudVisible;
    if (!hudWin) return;
    hudVisible ? hudWin.show() : hudWin.hide();
  });

  // Show/Hide ROI box
  globalShortcut.register('CommandOrControl+Shift+B', () => {
    roiVisible = !roiVisible;
    if (!roiWin || roiWin.isDestroyed()) createROI();
    roiVisible ? roiWin.showInactive() : roiWin.hide();
    hudWin && hudWin.webContents.send('roi:visible', roiVisible);
  });

  // Edit ROI
  globalShortcut.register('CommandOrControl+Shift+E', async () => {
    if (!hudWin) return;
    const on = await ipcMain.handlers['roi:edit'](); // reuse handler
    hudWin.webContents.send('roi:editing', on);
  });

  // Auto toggle
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    autoOn = !autoOn;
    autoOn ? startAuto() : stopAuto();
    hudWin && hudWin.webContents.send('auto:state', autoOn);
  });

  // Snap
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    hudWin && hudWin.webContents.send('hotkey:snap');
  });
}

// ---------------- App lifecycle ----------------
app.whenReady().then(() => {
  createHUD();
  createROI();
  registerIPC();
  registerHotkeys();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createHUD();
      createROI();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  stopAuto();
  if (process.platform !== 'darwin') app.quit();
});
