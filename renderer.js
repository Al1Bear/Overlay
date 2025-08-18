// renderer.js (controller)
const $ = (sel) => document.querySelector(sel);

const btnBind = $('#btnBind');
const selWin  = $('#winSelect');
const btnUse  = $('#btnUse');

const btnCapture = $('#btnCapture');
const btnFrame   = $('#btnFrame');
const btnAuto    = $('#btnAuto');
const btnSnap    = $('#btnSnap');
const btnOpenHUD = $('#btnOpenHUD');

const statusEl   = $('#status');
const canvas     = $('#preview');
const rectEl     = $('#rect');

const ctx        = canvas.getContext('2d', { willReadFrequently:true });

let boundOk = false;
let bmp = null;
let capW = 0, capH = 0;

let frameMode = false;
let dragging = false, sx=0, sy=0, ex=0, ey=0;

// ROI ratios (relative to bound window capture)
let roi = JSON.parse(localStorage.getItem('roiRatio') || 'null') || { left:0.53, top:0.13, w:0.43, h:0.80 };

// auto
let autoOn = false, timer = null;
const SAMPLE_MS = 700;
const STABLE_FRAMES = 2;
const DELTA = 0.010;
let prevSig = null, stableCount = 0, lastAt = 0;

const Z_DIGITS = { left: 0.62, top: 0.26, w: 0.34, h: 0.62 };

function setStatus(s){ statusEl.textContent = s || ''; }
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

btnOpenHUD.addEventListener('click', () => {
  // Nudge the HUD to show guidance
  window.bridge.hudText([
    'HUD is on top of the game',
    'F8 edit (drag for 3s), F10 auto',
    'F9 snap now',
    ''
  ], true);
});

btnBind.addEventListener('click', async () => {
  const a = await window.bridge.autoBind();
  if (a.ok) {
    boundOk = true;
    setStatus(`Bound: ${a.name}`);
    btnCapture.disabled = false;
    btnFrame.disabled   = false;
    btnAuto.disabled    = false;
    btnSnap.disabled    = false;
    return;
  }
  const list = await window.bridge.listWindows();
  if (!list.length) { setStatus('No windows found. Start the game first.'); return; }
  selWin.innerHTML = list.map(w => `<option value="${w.id}">${w.name}</option>`).join('');
  selWin.style.display = 'inline-block';
  btnUse.style.display = 'inline-block';
  setStatus('Pick the game window, then click Use.');
});
btnUse.addEventListener('click', async () => {
  const id = selWin.value;
  if (!id) return;
  const r = await window.bridge.bindWindow(id);
  boundOk = !!r.ok;
  if (boundOk) {
    setStatus('Window bound.');
    selWin.style.display = 'none';
    btnUse.style.display = 'none';
    btnCapture.disabled = false;
    btnFrame.disabled   = false;
    btnAuto.disabled    = false;
    btnSnap.disabled    = false;
  }
});

btnCapture.addEventListener('click', async () => {
  await refreshPreview();
});
btnFrame.addEventListener('click', () => {
  if (!bmp) { setStatus('Click Preview first.'); return; }
  frameMode = true;
  setStatus('Frame: drag the ROI over the panel. Min width 600 px.');
});
btnSnap.addEventListener('click', async () => {
  await doOCRFromROI();
});
btnAuto.addEventListener('click', () => {
  if (autoOn) autoOff(); else autoOnFn();
});

async function refreshPreview(){
  if (!boundOk) { setStatus('Bind first.'); return; }
  setStatus('Capturing…');
  const cap = await window.bridge.captureBound();
  const blob = new Blob([cap.png], { type:'image/png' });
  bmp = await createImageBitmap(await blob);
  capW = cap.width; capH = cap.height;

  const box = canvas.parentElement.getBoundingClientRect();
  const scale = Math.min(box.width / cap.width, 1);
  canvas.width  = Math.round(cap.width * scale);
  canvas.height = Math.round(cap.height * scale);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);

  drawRoiBox();
  setStatus(`Preview: ${cap.width}×${cap.height}`);
}

function drawRoiBox(){
  if (!bmp) return;
  const x = Math.round(roi.left * canvas.width);
  const y = Math.round(roi.top  * canvas.height);
  const w = Math.round(roi.w    * canvas.width);
  const h = Math.round(roi.h    * canvas.height);
  rectEl.hidden = false;
  rectEl.style.left = `${x}px`; rectEl.style.top = `${y}px`;
  rectEl.style.width = `${w}px`; rectEl.style.height = `${h}px`;
}

canvas.addEventListener('mousedown', (e) => {
  if (!bmp) return;
  if (!frameMode) return;
  const r = canvas.getBoundingClientRect();
  sx = e.clientX - r.left; sy = e.clientY - r.top; ex = sx; ey = sy;
  dragging = true;
  rectEl.hidden = false;
  rectEl.style.left = `${sx}px`; rectEl.style.top = `${sy}px`;
  rectEl.style.width = `0px`; rectEl.style.height = `0px`;
});
canvas.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const r = canvas.getBoundingClientRect();
  ex = e.clientX - r.left; ey = e.clientY - r.top;
  const x = Math.min(sx, ex), y = Math.min(sy, ey);
  const w = Math.abs(ex - sx), h = Math.abs(ey - sy);
  rectEl.style.left = `${x}px`; rectEl.style.top = `${y}px`;
  rectEl.style.width = `${w}px`; rectEl.style.height = `${h}px`;
});
canvas.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  const x = Math.round(Math.min(sx, ex));
  const y = Math.round(Math.min(sy, ey));
  const w = Math.round(Math.abs(ex - sx));
  const h = Math.round(Math.abs(ey - sy));
  if (w < 20 || h < 20) { setStatus('Selection too small.'); return; }

  // Map to capture ratios
  const scaleX = capW / canvas.width;
  const scaleY = capH / canvas.height;
  const nx = Math.max(0, Math.round(x * scaleX));
  const ny = Math.max(0, Math.round(y * scaleY));
  const nw = Math.min(capW - nx, Math.round(w * scaleX));
  const nh = Math.min(capH - ny, Math.round(h * scaleY));

  if (nw < 600) { setStatus('ROI too small (<600px). Select a wider area.'); return; }

  roi.left = nx / capW; roi.top = ny / capH;
  roi.w    = nw / capW; roi.h   = nh / capH;
  localStorage.setItem('roiRatio', JSON.stringify(roi));
  frameMode = false;
  drawRoiBox();
  setStatus('ROI set. Turn Auto on.');
});

async function doOCRFromROI(){
  if (!bmp) { await refreshPreview(); if (!bmp) return; }
  const rx = Math.round(roi.left * capW);
  const ry = Math.round(roi.top  * capH);
  const rw = Math.round(roi.w    * capW);
  const rh = Math.round(roi.h    * capH);

  // crop ROI from bound capture bitmap into PNG buffer
  const off = document.createElement('canvas');
  off.width = rw; off.height = rh;
  const octx = off.getContext('2d');
  octx.drawImage(bmp, rx, ry, rw, rh, 0, 0, rw, rh);
  const blob = await new Promise(res => off.toBlob(res, 'image/png', 1));
  const buf  = new Uint8Array(await blob.arrayBuffer());

  await runOCR(buf);
}

async function runOCR(panelBuf){
  try {
    setStatus('OCR…');
    const { labelText, digitsText } = await window.bridge.ocrPanel(panelBuf);
    const lines = formatLines(labelText, digitsText);
    // Update HUD text (pulse = true). Also pass ROI pixels for optional outline.
    const roiPixels = {
      x: Math.round(roi.left * capW), y: Math.round(roi.top * capH),
      w: Math.round(roi.w * capW),    h: Math.round(roi.h * capH)
    };
    window.bridge.hudText(lines, true, roiPixels, false);
    setStatus('Done.');
  } catch (e) {
    console.error(e);
    setStatus('OCR failed.');
    window.bridge.hudText(['OCR failed'], false);
  }
}

// simple “structured raw” formatter (labels come first, digits lined-up in order)
function formatLines(labelText, digitsText) {
  const L = String(labelText || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  const D = String(digitsText || '').split(/\n+/).map(s => s.trim()).filter(Boolean);

  const title = L[0] || '';
  const type  = (L[1] && /^[A-Z][a-z]+s?$/.test(L[1])) ? L[1] : '';
  const names = type ? L.slice(2) : L.slice(1);

  const mainName  = names[0] || '';
  const mainValue = D[0] || '';
  const subs = [];
  for (let i=1;i<names.length && i<D.length;i++) subs.push(`${names[i]} ${D[i]}`);

  const out = [];
  if (title) out.push(`Title: ${title}`); else out.push('Title: —');
  if (type)  out.push(`Type: ${type}`);
  out.push(`Main: ${mainName} ${mainValue}`.trim());
  for (let i=0;i<Math.min(4, subs.length); i++) out.push(`Sub: ${subs[i]}`);

  // pad to 6–7 lines for a stable HUD height
  while (out.length < 6) out.push('');
  return out;
}

// ---------------- auto (digits diff) ----------------
function autoOnFn(){
  autoOn = true; prevSig = null; stableCount = 0; lastAt = 0;
  btnAuto.textContent = 'Auto (On)';
  setStatus('Auto: watching digits…');
  timer = setInterval(tick, SAMPLE_MS);
}
function autoOff(){
  autoOn = false; clearInterval(timer); timer=null;
  btnAuto.textContent = 'Auto';
  setStatus('Auto: off');
}
async function tick(){
  try {
    const cap = await window.bridge.captureBound();
    const blob = new Blob([cap.png], { type:'image/png' });
    bmp = await createImageBitmap(await blob);
    capW = cap.width; capH = cap.height;

    const rx = Math.round(roi.left * capW);
    const ry = Math.round(roi.top  * capH);
    const rw = Math.round(roi.w    * capW);
    const rh = Math.round(roi.h    * capH);

    // digits patch inside ROI
    const dx = rx + Math.round(Z_DIGITS.left * rw);
    const dy = ry + Math.round(Z_DIGITS.top  * rh);
    const dw = Math.round(Z_DIGITS.w * rw);
    const dh = Math.round(Z_DIGITS.h * rh);

    const off = document.createElement('canvas');
    off.width = dw; off.height = dh;
    const octx = off.getContext('2d', { willReadFrequently:true });
    octx.drawImage(bmp, dx, dy, dw, dh, 0, 0, dw, dh);
    const id = octx.getImageData(0,0,dw,dh).data;

    let sum=0;
    for (let i=0;i<id.length;i+=4) sum += (id[i]*0.299 + id[i+1]*0.587 + id[i+2]*0.114);
    const mean = sum / (dw*dh*255);

    if (prevSig == null){ prevSig = mean; return; }
    const delta = Math.abs(mean - prevSig);
    prevSig = mean;

    if (delta > DELTA){ stableCount = 0; return; }
    stableCount++;
    if (stableCount >= STABLE_FRAMES && Date.now()-lastAt>1500){
      stableCount = 0; lastAt = Date.now();
      const crop = document.createElement('canvas');
      crop.width = rw; crop.height = rh;
      const cctx = crop.getContext('2d');
      cctx.drawImage(bmp, rx, ry, rw, rh, 0, 0, rw, rh);
      const blob2 = await new Promise(res => crop.toBlob(res, 'image/png', 1));
      const buf2  = new Uint8Array(await blob2.arrayBuffer());
      await runOCR(buf2);
    }

  } catch (e) {
    console.error(e);
    setStatus('Auto: capture failed.');
  }
}

// receive hotkey relays from main (F9/F10)
window.bridge.onMain((msg) => {
  if (msg?.type === 'snap-now') btnSnap.click();
  if (msg?.type === 'auto-toggle') btnAuto.click();
});

// boot hint
setStatus('Bind → Preview → Frame → Auto');
