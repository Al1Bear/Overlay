// main.js
// Electron main process for Gear OCR Overlay
// Fixes: missing IPC handlers, ROI window control, auto capture, safe "screen" usage

const path = require('path');
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, nativeImage } = require('electron');

let mainWin = null;
let roiWin = null;

// ---- ROI state (single source of truth) ----
const MIN_W = 80;
const MIN_H = 80;
let roiBounds = { x: 200, y: 120, width: 560, height: 720 };   // sensible default
let roiVisible = true;
let roiEditing = false;

// ---- Auto capture state ----
let autoOn = false;
let autoTimer = null;
let lastSig = null;             // last pixel signature from ROI
const AUTO_INTERVAL_MS = 800;   // lightweight cadence

// Utility: clamp ROI to any display (multi-monitor safe)
function clampToDisplays(rect) {
  const all = screen.getAllDisplays();
  // Prefer the display that contains rect center
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let best = all[0];
  for (const d of all) {
    const b = d.bounds;
    if (cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height) {
      best = d; break;
    }
  }
  const b = best.bounds;
  const clamped = {
    x: Math.max(b.x, Math.min(rect.x, b.x + b.width - MIN_W)),
    y: Math.max(b.y, Math.min(rect.y, b.y + b.height - MIN_H)),
    width: Math.max(MIN_W, Math.min(rect.width, b.x + b.width - rect.x)),
    height: Math.max(MIN_H, Math.min(rect.height, b.y + b.height - rect.y))
  };
  return clamped;
}

// Utility: capture primary/full screen as nativeImage (no sharp needed)
async function capturePrimaryAsImage() {
  const primary = screen.getPrimaryDisplay();
  const size = primary.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: size.width, height: size.height }
  });

  // Best effort to pick the primary screen source
  let src = sources.find(s => s.display_id === String(primary.id));
  if (!src) src = sources[0];

  if (!src || src.thumbnail.isEmpty()) {
    throw new Error('No desktop capture source available');
  }
  // src.thumbnail is already a nativeImage sized to the screen
  return src.thumbnail;
}

// Utility: crop a nativeImage by rect -> PNG Buffer
function cropImageToPNG(img, rect) {
  const cropped = img.crop(rect);
  return cropped.toPNG();
}

// Utility: fast signature for change detection
function quickSignature(buf) {
  // Sum a subset of bytes to keep it cheap; ignore alpha
  let sum = 0;
  for (let i = 0; i < buf.length; i += 97) {
    sum = (sum + buf[i]) & 0xffffffff;
  }
  return sum >>> 0;
}

async function snapOnceAndCrop() {
  const img = await capturePrimaryAsImage();
  const png = cropImageToPNG(img, roiBounds);
  return png; // Buffer
}

function startAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(async () => {
    try {
      const img = await capturePrimaryAsImage();
      const cropped = img.crop(roiBounds);
      const raw = cropped.toBitmap(); // BGRA
      const sig = quickSignature(raw);
      const changed = lastSig === null || Math.abs(sig - lastSig) > 50; // crude threshold

      if (changed) {
        lastSig = sig;
        const png = cropped.toPNG();
        // send the PNG up to renderer (structured raw for now)
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('auto:capture', {
            roi: { ...roiBounds },
            pngBase64: png.toString('base64')
          });
        }
      }
    } catch (err) {
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('log', `[auto] ${err.message}`);
      }
    }
  }, AUTO_INTERVAL_MS);
}

function stopAuto() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  lastSig = null;
}

// ---- Windows ----
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWin.loadFile('index.html');
}

function createRoiWindow() {
  if (roiWin && !roiWin.isDestroyed()) return;
  roiWin = new BrowserWindow({
    ...roiBounds,
    frame: false,
    transparent: true,
    resizable: false,   // we resize by setBounds while editing
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  roiWin.loadFile('roi.html');
  roiWin.setAlwaysOnTop(true, 'screen-saver');
  roiWin.setIgnoreMouseEvents(true, { forward: true }); // default: click-through
}

// ---- IPC HANDLERS (this is what was missing) ----
function registerIpc() {
  // ROI get/set
  ipcMain.handle('roi:get', async () => ({ ...roiBounds, visible: roiVisible, editing: roiEditing }));
  ipcMain.handle('roi:set', async (_e, rect) => {
    roiBounds = clampToDisplays({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height)
    });
    if (roiWin && !roiWin.isDestroyed()) {
      roiWin.setBounds(roiBounds);
      roiWin.webContents.send('roi:bounds', roiBounds);
    }
    return { ...roiBounds };
  });

  // Toggle editing (on = interactive; off = click-through)
  ipcMain.handle('roi:edit', async () => {
    roiEditing = !roiEditing;
    if (roiWin && !roiWin.isDestroyed()) {
      roiWin.setIgnoreMouseEvents(!roiEditing, { forward: true });
      roiWin.webContents.send('roi:editing', roiEditing);
    }
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('roi:editing', roiEditing);
    }
    return roiEditing;
  });

  // Show/hide overlay window
  ipcMain.handle('roi:toggle-visible', async () => {
    roiVisible = !roiVisible;
    if (!roiWin || roiWin.isDestroyed()) createRoiWindow();
    if (roiVisible) {
      roiWin.showInactive();
      roiWin.setBounds(roiBounds);
      roiWin.setAlwaysOnTop(true, 'screen-saver');
    } else {
      roiWin.hide();
    }
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('roi:visible', roiVisible);
    }
    return roiVisible;
  });

  // Manual Snap => returns PNG base64
  ipcMain.handle('snap', async () => {
    const png = await snapOnceAndCrop();
    return { roi: { ...roiBounds }, pngBase64: png.toString('base64') };
  });

  // Auto on/off
  ipcMain.handle('auto', async () => {
    autoOn = !autoOn;
    if (autoOn) startAuto(); else stopAuto();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('auto:state', autoOn);
    }
    return autoOn;
  });

  // ROI window requests its current bounds on load
  ipcMain.on('roi:hello', (e) => {
    e.sender.send('roi:bounds', roiBounds);
    e.sender.send('roi:editing', roiEditing);
  });
}

// ---- App lifecycle ----
app.whenReady().then(() => {
  createMainWindow();
  createRoiWindow();
  registerIpc();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      createRoiWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopAuto();
  if (process.platform !== 'darwin') app.quit();
});
