// main.js — Frameless HUD, movable ROI, debounced auto-capture, hotkeys

const path = require('path');
const {
  app, BrowserWindow, ipcMain, screen, desktopCapturer, nativeImage, globalShortcut
} = require('electron');

// ---------------- HUD / ROI state ----------------
let hudWin = null;          // compact frameless HUD
let hudVisible = true;
const HUD_W = 460;
const HUD_H_COLLAPSED = 56;
const HUD_H_EXPANDED  = 160;

let roiWin = null;          // green box overlay
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
const SIG_TRIGGER = 500;     // larger = less sensitive
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
  let x = Math.max(d.x, Math.min(rect.x, d.x + d.width  - MIN_W));
  let y = Math.max(d.y, Math.min(rect.y, d.y + d.height - MIN_H));
  let w = Math.max(MIN_W, Math.min(rect.width,  d.x + d.width  - x));
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

// masked, downscaled signature to ignore shimmer; focuses on title + numeric column
function signatureMasked(imgNative) {
  const small = imgNative.resize({ width: 220 });
  const bmp = small.toBitmap(); // BGRA
  const { width: sw, height: sh } = small.getSize();

  const zones = [
    { x: 0.10, y: 0.02, w: 0.80, h: 0.16 }, // title/type
    { x: 0.62, y: 0.20, w: 0.36, h: 0.72 }  // numeric values
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

// ---------------- Auto loop ----------------
async function autoTick() {
  if (!hudWin || hudWin.isDestroyed() || roiEditing || !roiVisible) return;

  const wasVisible = roiVisible;
  if (roiWin && !roiWin.isDestroyed()) roiWin.hide();

  try {
    const { img, display } = await captureDisplayImageForROI();
    const crop = cropToRoi(img, display);
    const sig  = signatureMasked(crop);

    sigHistory.push(sig);
    if (sigHistory.length > SIG_HISTORY_N) sigHistory.shift();

    const baseline = median(sigHistory);
    const diff = Math.abs(sig - baseline);

    if (diff > SIG_TRIGGER) {
      changedStreak++;
      if (changedStreak >= STABLE_FRAMES) {
        changedStreak = 0;
        sigHistory.length = 0;
        hudWin.webContents.send('auto:capture', {
          roi, pngBase64: crop.toPNG().toString('base64')
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
    width: HUD_W, height: HUD_H_COLLAPSED,
    resizable: false, movable: true, show: true,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  hudWin.setAlwaysOnTop(true, 'screen-saver');
  hudWin.loadFile('index.html');
}
function createROI() {
  if (roiWin && !roiWin.isDestroyed()) return;
  roiWin = new BrowserWindow({
    ...roi, frame: false, transparent: true, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  roiWin.loadFile('roi.html');
  roiWin.setAlwaysOnTop(true, 'screen-saver');
  roiWin.setIgnoreMouseEvents(true, { forward: true }); // locked by default
}

// ---------------- IPC ----------------
function registerIPC() {
  // ROI
  ipcMain.handle('roi:get',  () => ({ ...roi, visible: roiVisible, editing: roiEditing }));
  ipcMain.handle('roi:set',  (_e, rect) => {
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
    if (roiVisible) { roiWin.setBounds(roi); roiWin.showInactive(); }
    else { roiWin.hide(); }
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
      const png = cropToRoi(img, display).toPNG();
      return { roi, pngBase64: png.toString('base64') };
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
    if (autoOn) { autoOn = false; stopAuto(); hudWin && hudWin.webContents.send('auto:state', false); }
    if (roiVisible) {
      roiVisible = false; roiWin && roiWin.hide();
      hudWin && hudWin.webContents.send('roi:visible', roiVisible);
    }
    return true;
  });

  // Hotkey -> tell renderer to run snap via API (keeps one codepath for saving)
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
    autoOn = !autoOn; autoOn ? startAuto() : stopAuto();
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
      createHUD(); createROI();
    }
  });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => {
  stopAuto();
  if (process.platform !== 'darwin') app.quit();
});
