// renderer.js
const $ = (sel) => document.querySelector(sel);
const btnCapture = $('#btnCapture');
const btnReset   = $('#btnReset');
const statusEl   = $('#status');
const outputEl   = $('#output');

const shotWrap   = $('#shotWrap');
const shotImg    = $('#shotImg');
const selectBox  = $('#selectBox');
const sizeBadge  = $('#sizeBadge');
const emptyShot  = $('#emptyShot');

let imgBlobURL = null;
let selecting = false;
let pointerId = null;
let startX = 0, startY = 0;
let selX = 0, selY = 0, selW = 0, selH = 0;

const MIN_SEL_W = 80;   // minimum display-px width we’ll auto-expand to
const MIN_SEL_H = 60;   // minimum display-px height we’ll auto-expand to

function setStatus(txt) { statusEl.textContent = txt; }

function clearSelection() {
  selecting = false;
  selX = selY = selW = selH = 0;
  selectBox.style.display = 'none';
  if (sizeBadge) sizeBadge.style.display = 'none';
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  if (shotWrap && pointerId != null) {
    try { shotWrap.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
  }
}

function showShot(buffer) {
  if (imgBlobURL) URL.revokeObjectURL(imgBlobURL);
  imgBlobURL = URL.createObjectURL(new Blob([buffer], { type: 'image/png' }));
  shotImg.onload = () => {
    shotWrap.style.display = 'block';
    emptyShot.style.display = 'none';
    clearSelection();
    setStatus('Drag to select an area, then release to OCR');
  };
  shotImg.src = imgBlobURL;
}

function getRelPos(e) {
  const r = shotImg.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - r.left, r.width));
  const y = Math.max(0, Math.min(e.clientY - r.top,  r.height));
  return { x, y };
}

function drawSelection() {
  const w = Math.abs(selW);
  const h = Math.abs(selH);

  selectBox.style.display = 'block';
  selectBox.style.left   = `${Math.min(selX, startX)}px`;
  selectBox.style.top    = `${Math.min(selY, startY)}px`;
  selectBox.style.width  = `${w}px`;
  selectBox.style.height = `${h}px`;

  if (w > 0 && h > 0 && sizeBadge) {
    sizeBadge.style.display = 'block';
    sizeBadge.textContent = `${Math.round(w)}×${Math.round(h)}`;
    sizeBadge.classList.toggle('tooSmall', w < MIN_SEL_W || h < MIN_SEL_H);
  }
}

async function extractCropToBuffer() {
  // current selection in display px
  let x0 = Math.min(selX, startX);
  let y0 = Math.min(selY, startY);
  let w0 = Math.abs(selW);
  let h0 = Math.abs(selH);

  // auto-expand tiny selection
  if (w0 < MIN_SEL_W || h0 < MIN_SEL_H) {
    const cx = x0 + (w0 || 1) / 2;
    const cy = y0 + (h0 || 1) / 2;
    w0 = Math.max(MIN_SEL_W, w0);
    h0 = Math.max(MIN_SEL_H, h0);
    x0 = Math.round(cx - w0 / 2);
    y0 = Math.round(cy - h0 / 2);
    const maxX = Math.max(0, shotImg.clientWidth  - w0);
    const maxY = Math.max(0, shotImg.clientHeight - h0);
    x0 = Math.max(0, Math.min(x0, maxX));
    y0 = Math.max(0, Math.min(y0, maxY));
  }

  // map to natural pixels
  const sx = Math.round(x0 * (shotImg.naturalWidth  / shotImg.clientWidth));
  const sy = Math.round(y0 * (shotImg.naturalHeight / shotImg.clientHeight));
  const sw = Math.round(Math.max(1, w0 * (shotImg.naturalWidth  / shotImg.clientWidth)));
  const sh = Math.round(Math.max(1, h0 * (shotImg.naturalHeight / shotImg.clientHeight)));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(shotImg, sx, sy, sw, sh, 0, 0, sw, sh);

  const blob = await new Promise(res => canvas.toBlob(res, 'image/png', 1));
  const u8 = new Uint8Array(await blob.arrayBuffer());
  try { await window.api.saveCrop(u8); } catch {}
  return u8;
}

function mergeTwoPass(labelText, digitsText) {
  return [
    '--- Labels ---',
    (labelText || '').trim(),
    '',
    '--- Digits ---',
    (digitsText || '').trim()
  ].join('\n');
}
/* === ADDED: parsing helpers for labels + digits === */
const KNOWN_SLOTS = [
  'Gloves','Helm','Helmet','Boots','Armor','Chest','Ring','Necklace','Belt',
  'Bracers','Shield','Weapon','Sword','Bow','Staff','Dagger'
];

function parseGearTexts(labelText, digitsText) {
  // Labels come as: [title] \n [type?] \n [left-column stat names...]
  const L = String(labelText || '').split(/\n+/).map(s => s.trim()).filter(Boolean);

  const title = L[0] || '';
  const looksLikeType = (s) =>
    KNOWN_SLOTS.includes(s) || (/^[A-Z][A-Za-z]+s?$/.test(s || '') && (s || '').length <= 12);
  const type = looksLikeType(L[1]) ? L[1] : '';

  const nameStart = type ? 2 : 1;

  // Normalise common variants
  const normalise = (s) => {
    s = (s || '').replace(/[:·•]+/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/\b(ATK|HP|DEF)\s*%\b/g, '$1%');  // ATK % -> ATK%
    if (/^atk%?$/i.test(s)) return 'ATK%';
    if (/^atk$/i.test(s)) return 'ATK';
    if (/^def%?$/i.test(s)) return 'DEF%';
    if (/^def(ense)?$/i.test(s)) return 'Defense';
    if (/^hp%?$/i.test(s)) return 'HP%';
    if (/crit\s*rate/i.test(s)) return 'Crit Rate';
    if (/crit\s*(dmg|damage)/i.test(s)) return 'Crit Damage';
    if (/accuracy/i.test(s)) return 'Accuracy';
    if (/enlight(enment|henment|hthenment)/i.test(s)) return 'Enlightenment';
    return s;
  };

  const statNames = L.slice(nameStart).map(normalise).filter(Boolean);

  // Digits: +12, +12.5%, 16.9%, -3, etc.
  const values = String(digitsText || '')
    .replace(/[^\d.+%\-\/\n]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .filter(tok => /^(?:\+|-)?\d+(?:\.\d+)?%?$/.test(tok));

  const main = statNames[0] ? { label: statNames[0], value: values[0] || '' } : null;

  const subs = [];
  const n = Math.min(Math.max(0, statNames.length - 1), Math.max(0, values.length - 1));
  for (let i = 0; i < n; i++) subs.push({ label: statNames[i + 1], value: values[i + 1] || '' });

  return { title, type, main, subs, raw: { labels: labelText, digits: digitsText } };
}

function renderParsed(p, labelText, digitsText) {
  if (!p || !p.main || !p.main.label || !p.main.value) {
    return mergeTwoPass(labelText, digitsText);
  }
  const out = [];
  if (p.title) out.push(`Title: ${p.title}`);
  if (p.type)  out.push(`Type: ${p.type}`);
  out.push(`Main: ${p.main.label} ${p.main.value}`);
  if (p.subs.length) {
    out.push('Subs:');
    for (const s of p.subs) out.push(` - ${s.label} ${s.value}`);
  }
  // Keep raw OCR under the parsed block for debugging
  out.push('\n--- RAW ---\n' + mergeTwoPass(labelText, digitsText));
  return out.join('\n');
}
/* === /ADDED === */


// ---------- Pointer event handlers ----------
function onPtrDown(e) {
  if (!shotImg.src) return;
  e.preventDefault();
  selecting = true;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'crosshair';
  if (shotWrap && e.pointerId != null) {
    try { shotWrap.setPointerCapture(e.pointerId); pointerId = e.pointerId; } catch {}
  }
  const { x, y } = getRelPos(e);
  startX = x; startY = y;
  selX = x; selY = y; selW = 0; selH = 0;
  drawSelection();
}

function onPtrMove(e) {
  if (!selecting) return;
  e.preventDefault();
  const { x, y } = getRelPos(e);
  selX = x; selY = y;
  selW = selX - startX;
  selH = selY - startY;
  drawSelection();
}

async function onPtrUp(e) {
  if (!selecting) return;
  e.preventDefault();
  try { await finalizeSelection(); } finally { clearSelection(); }
}

async function finalizeSelection() {
  try {
    setStatus((Math.abs(selW) < MIN_SEL_W || Math.abs(selH) < MIN_SEL_H) ? 'Selection small — auto-expanding…' : 'Preparing crop…');
    const u8 = await extractCropToBuffer();

    setStatus('OCR (labels)…');
    const text = await window.api.ocr(u8);
    try { await window.api.saveDebug(text); } catch {}

    setStatus('OCR (digits)…');
    const digitsText = await window.api.ocrDigits(u8);
    try { await window.api.saveDebugDigits(digitsText); } catch {}

    const parsed = parseGearTexts(text, digitsText);
outputEl.textContent = renderParsed(parsed, text, digitsText);
    setStatus('Done');
  } catch (e) {
    console.error(e);
    setStatus('Selection/OCR failed');
  }
}

// ---------- Buttons ----------
btnCapture.addEventListener('click', async () => {
  try {
    setStatus('Capturing…');
    if (!window.api?.grab) throw new Error('grab() not available from preload');
    const buf = await window.api.grab();
    showShot(buf);
  } catch (e) {
    console.error(e);
    setStatus('Capture failed');
  }
});

btnReset.addEventListener('click', () => {
  clearSelection();
  shotWrap.style.display = 'none';
  emptyShot.style.display = 'block';
  outputEl.textContent = '(no output)';
  setStatus('Ready');
  if (imgBlobURL) { URL.revokeObjectURL(imgBlobURL); imgBlobURL = null; }
});

// Hook pointer events on the wrapper (prevents native image dragging)
shotWrap.addEventListener('pointerdown', onPtrDown);
shotWrap.addEventListener('pointermove', onPtrMove);
shotWrap.addEventListener('pointerup', onPtrUp);
shotWrap.addEventListener('pointerleave', onPtrUp);
shotWrap.addEventListener('pointercancel', onPtrUp);
