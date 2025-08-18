// renderer.js
const $ = (sel) => document.querySelector(sel);
const btnCapture = $('#btnCapture');
const btnReset   = $('#btnReset');
const statusEl   = $('#status');
const canvas     = $('#screenCanvas');
const rectEl     = $('#rect');
const ctx        = canvas.getContext('2d', { willReadFrequently: true });

let imgBitmap = null;     // ImageBitmap of the screenshot
let naturalW = 0, naturalH = 0;
let drawing = false, sx = 0, sy = 0, ex = 0, ey = 0;

function setStatus(msg) { statusEl.textContent = msg || ''; }

function clearStage() {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  rectEl.hidden = true;
  imgBitmap = null;
  naturalW = naturalH = 0;
  btnReset.disabled = true;
  setStatus('');
  $('#output').textContent = '(no output yet)';
}

btnReset.addEventListener('click', clearStage);

// ---------- capture ----------
btnCapture.addEventListener('click', async () => {
  try {
    setStatus('Capturing screen…');
    const png = await window.bridge.captureScreen();
    const blob = new Blob([png], { type: 'image/png' });
    const bmp  = await createImageBitmap(await blob);
    imgBitmap = bmp;
    naturalW = bmp.width; naturalH = bmp.height;

    // Fit canvas to container width, keep aspect
    const box = canvas.parentElement.getBoundingClientRect();
    const scale = Math.min(box.width / bmp.width, 1);
    canvas.width  = Math.round(bmp.width  * scale);
    canvas.height = Math.round(bmp.height * scale);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);

    btnReset.disabled = false;
    setStatus('Drag to select the gear panel, then release mouse.');
  } catch (e) {
    console.error(e);
    setStatus('Capture failed.');
  }
});

// ---------- selection UI ----------
canvas.addEventListener('mousedown', (e) => {
  if (!imgBitmap) return;
  drawing = true;
  const r = canvas.getBoundingClientRect();
  sx = e.clientX - r.left; sy = e.clientY - r.top;
  ex = sx; ey = sy;
  rectEl.hidden = false;
  rectEl.style.left   = `${sx}px`;
  rectEl.style.top    = `${sy}px`;
  rectEl.style.width  = '0px';
  rectEl.style.height = '0px';
});

canvas.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const r = canvas.getBoundingClientRect();
  ex = e.clientX - r.left; ey = e.clientY - r.top;
  const x = Math.min(sx, ex), y = Math.min(sy, ey);
  const w = Math.abs(ex - sx), h = Math.abs(ey - sy);
  rectEl.style.left   = `${x}px`;
  rectEl.style.top    = `${y}px`;
  rectEl.style.width  = `${w}px`;
  rectEl.style.height = `${h}px`;
});

canvas.addEventListener('mouseup', async () => {
  if (!drawing) return;
  drawing = false;

  const x = Math.round(Math.min(sx, ex));
  const y = Math.round(Math.min(sy, ey));
  const w = Math.round(Math.abs(ex - sx));
  const h = Math.round(Math.abs(ey - sy));
  if (w < 20 || h < 20) { setStatus('Selection too small.'); return; }

  setStatus('Preparing crop…');

  // Map to natural pixels
  const scaleX = naturalW / canvas.width;
  const scaleY = naturalH / canvas.height;
  const nx = Math.max(0, Math.round(x * scaleX));
  const ny = Math.max(0, Math.round(y * scaleY));
  const nw = Math.min(naturalW - nx, Math.round(w * scaleX));
  const nh = Math.min(naturalH - ny, Math.round(h * scaleY));

  // Paint to an offscreen canvas at natural size
  const off = document.createElement('canvas');
  off.width = nw; off.height = nh;
  const octx = off.getContext('2d');
  octx.drawImage(imgBitmap, nx, ny, nw, nh, 0, 0, nw, nh);

  // Make PNG buffer
  const blob = await new Promise(res => off.toBlob(res, 'image/png', 1));
  const buf  = new Uint8Array(await blob.arrayBuffer());

  setStatus('Running OCR…');
  try {
    const { labelText, digitsText } = await window.bridge.ocrPanel(buf);
    formatAndShow(labelText, digitsText);
    setStatus('Done.');
  } catch (e) {
    console.error(e);
    setStatus('OCR failed.');
  }
});

// ---------- formatting ----------
function parseLabelsRawFromBlock(labelBlock) {
  const lines = String(labelBlock || '')
    .split(/\r?\n/).map(s => s.replace(/\s{2,}/g, ' ').trim()).filter(Boolean);

  const isTitle = s => /[A-Za-z]/.test(s) && !/[+%0-9]/.test(s) && s.split(/\s+/).length >= 2 && s.length > 3;
  const titleIdx = lines.findIndex(isTitle);
  const title = titleIdx >= 0 ? lines[titleIdx] : '';

  const TYPES = ['Helm','Helmet','Gloves','Boots','Ring','Necklace','Belt','Armor','Chest','Weapon','Shield','Bow','Sword','Staff'];
  let type = '', typeIdx = -1;
  for (let i = Math.max(0, titleIdx + 1); i < lines.length; i++) {
    const line = lines[i];
    const hit = TYPES.find(t => new RegExp(`\\b${t}\\b`, 'i').test(line));
    if (hit) { type = hit; typeIdx = i; break; }
  }

  const STATS = ['HP%','ATK%','DEF%','HP','ATK','DEF','Crit Rate','Crit Damage','Accuracy','Resistance','Enlightenment','Speed'];
  const looksStat = s => {
    const p = s.replace(/[^A-Za-z%\s]/g,'').trim();
    return STATS.some(n => p.toLowerCase().startsWith(n.toLowerCase()));
  };

  const startIdx = typeIdx >= 0 ? typeIdx + 1 : (titleIdx >= 0 ? titleIdx + 1 : 0);
  const labels = [];
  for (let i = startIdx; i < lines.length; i++) if (looksStat(lines[i])) labels.push(lines[i]);

  const mainLabel = labels[0] || '';
  const subLabels = labels.slice(1, 5);

  return { title, type, mainLabel, subLabels };
}

function formatAndShow(labelText, digitsText) {
  const L = parseLabelsRawFromBlock(labelText);
  const digitLines = String(digitsText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const mainValue = digitLines[0] || '';
  const subs = (L.subLabels || []).map((lbl, i) => ({ label: lbl, value: (digitLines[i + 1] || '') }));

  const out = [];
  if (L.title) out.push(`Title: ${L.title}`);
  if (L.type)  out.push(`Type: ${L.type}`);
  if (L.mainLabel || mainValue) out.push(`Main: ${L.mainLabel} ${mainValue}`.trim());
  for (const s of subs) out.push(`Sub: ${s.label} ${s.value}`.trim());

  $('#output').textContent = out.join('\n');

  // keep a copy for debugging
  window.bridge.saveDebug(out.join('\n')).catch(()=>{});
}
