// renderer.js — Frameless HUD controller

const $ = (s) => document.querySelector(s);
const hud = $('#hud');
const btnEdit = $('#btn-edit');
const btnAuto = $('#btn-auto');
const btnSnap = $('#btn-snap');
const btnBox  = $('#btn-box');
const btnClose = $('#btn-close');
const btnCollapse = $('#btn-collapse');
const statusEl = $('#status');
const dot = $('#dot');
const out = $('#out');
const roiInfo = $('#roi-info');

// --- smart-cam formatters (compact, fits at ≥600px) ---
function fmtLine(l) {
  if (!l) return '';
  const base = (l.base ?? '?') + (l.unit || '');
  const up   = l.upgrade ? ` (+${l.upgrade}${l.unit || ''})` : '';
  const lbl  = l.label && l.label.length ? l.label : '(?)';
  return `${lbl}: ${base}${up}`;
}
function fmtRecord(r) {
  if (!r || !Array.isArray(r.mainStats)) return '';
  const main = r.mainStats.map(fmtLine);
  const subs = r.substats.map(fmtLine);
  return [...main, ...subs].join(' | ');
}


let expanded = false;

function log(line) {
  out.value += line + '\n';
  out.scrollTop = out.scrollHeight;
}
function setStatus(t) { statusEl.textContent = t; }
function setDot(state) {
  dot.className = 'dot' + (state ? ' on' : '');
}
async function refreshRoi() {
  const s = await window.api.roi.get();
  roiInfo.textContent = `ROI ${s.width}×${s.height} @ ${s.x},${s.y} ${s.editing ? '• Editing' : '• Locked'}`;
  btnEdit.textContent = s.editing ? 'Edit ROI (On)' : 'Edit ROI (Off)';
}
async function resizeHud() {
  const titleH = document.querySelector('.title').offsetHeight;   // top bar (drag region)
  const barH   = document.querySelector('.bar').offsetHeight;     // controls row

  // Match the CSS height of #out (only when expanded)
  const outH   = expanded ? 120 : 0;

  // Small bottom breathing room so borders/shadows never clip
  const chrome = 10; // px

  const total = titleH + barH + outH + chrome;
  await window.api.hud.resize(total);
}

btnCollapse.addEventListener('click', async () => {
  expanded = !expanded;
  hud.classList.toggle('expanded', expanded);
  btnCollapse.textContent = expanded ? '▴' : '▾';
  await resizeHud();
});

btnClose.addEventListener('click', async () => {
  await window.api.hud.closeOverlay(); // hides HUD + box, disables auto
});

btnEdit.addEventListener('click', async () => {
  const on = await window.api.roi.edit();
  setStatus(on ? 'Editing ROI (drag to move; edges resize). Press again to lock.' : 'ROI locked.');
  await refreshRoi();
});

btnAuto.addEventListener('click', async () => {
  const on = await window.api.auto.toggle();
  setDot(on);
  btnAuto.textContent = on ? 'Auto (On)' : 'Auto (Off)';
  setStatus(on ? 'Auto capture armed (debounced).' : 'Auto disabled.');
});
function fmtSmartLine(r){
  if (!r || !Array.isArray(r.mainStats)) return '';
  const fmt = (l) => `${l.label}: ${l.base}${l.unit||''}${l.upgrade ? ` (+${l.upgrade}${l.unit||''})` : ''}`;
  return [...r.mainStats.map(fmt), ...r.substats.map(fmt)].join(' | ');
}
async function doSnap() {
  setStatus('Snapping…'); dot.classList.add('wait');
  const res = await window.api.snap();
  dot.classList.remove('wait');
  setStatus('Snap ✓');
  log(`[SNAP] ${res.pngBase64.length} b64  ROI=${JSON.stringify(res.roi)}`);
if (res.record) { log('[smartcam] ' + res.record.mainStats.concat(res.record.substats)
  .map(l => `${l.label}: ${l.base}${l.unit || ''}${l.upgrade ? ` (+${l.upgrade}${l.unit || ''})` : ''}`)
  .join(' | ')); }
}
btnSnap.addEventListener('click', doSnap);

btnBox.addEventListener('click', async () => {
  const vis = await window.api.roi.toggleVisible();
  btnBox.textContent = vis ? 'Box (Hide)' : 'Box (Show)';
  setStatus(`Box ${vis ? 'visible' : 'hidden'}.`);
});

// Events from main
window.api.auto.onCapture((d) => {
  setStatus('Change detected ✓');
  log(`[AUTO] ${d.pngBase64.length} b64  ROI=${JSON.stringify(d.roi)}`);
if (d.record) { log('[auto/smartcam] ' + d.record.mainStats.concat(d.record.substats)
  .map(l => `${l.label}: ${l.base}${l.unit || ''}${l.upgrade ? ` (+${l.upgrade}${l.unit || ''})` : ''}`)
  .join(' | ')); }
});
window.api.auto.onState((on) => { setDot(on); btnAuto.textContent = on ? 'Auto (On)' : 'Auto (Off)'; });
window.api.roi.onBounds(refreshRoi);
window.api.roi.onEditing(refreshRoi);
window.api.roi.onVisible((v) => { btnBox.textContent = v ? 'Box (Hide)' : 'Box (Show)'; });

// Hotkey: Ctrl+Shift+S
window.api.hud.onHotkeySnap(async () => { await doSnap(); });

window.addEventListener('DOMContentLoaded', async () => {
  const s = await window.api.roi.get();
  btnBox.textContent = s.visible ? 'Box (Hide)' : 'Box (Show)';
  await refreshRoi();
  await resizeHud();
  setStatus('Ready');
});
