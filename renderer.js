// renderer.js
// Small HUD controller (no heavy parsing here)

const $ = (sel) => document.querySelector(sel);

const btnEdit = $('#btn-edit');
const btnAuto = $('#btn-auto');
const btnSnap = $('#btn-snap');
const btnBox  = $('#btn-box');
const out     = $('#out');
const status  = $('#status');

function setStatus(text) {
  status.textContent = text;
}

function appendLine(text) {
  out.value += text + '\n';
  out.scrollTop = out.scrollHeight;
}

async function refreshRoiBadge() {
  const s = await window.api.roi.get();
  $('#roi-info').textContent = `ROI ${s.width}×${s.height} @ ${s.x},${s.y}  ${s.editing ? '(Editing)' : ''}`;
}

btnEdit.addEventListener('click', async () => {
  const on = await window.api.roi.edit();
  setStatus(on ? 'ROI: editing (click-through OFF)' : 'ROI: locked (click-through ON)');
  refreshRoiBadge();
});

btnAuto.addEventListener('click', async () => {
  const on = await window.api.auto.toggle();
  btnAuto.textContent = on ? 'Auto: ON' : 'Auto: OFF';
  setStatus(on ? 'Auto capture enabled' : 'Auto capture disabled');
});

btnSnap.addEventListener('click', async () => {
  setStatus('Snapping…');
  const res = await window.api.snap();
  setStatus('Snap done');
  appendLine(`[SNAP] ${JSON.stringify(res.roi)}  png=${res.pngBase64.length}b64`);
});

btnBox.addEventListener('click', async () => {
  const s = await window.api.roi.get();
  appendLine(`[ROI] ${JSON.stringify(s)}`);
});

window.api.roi.onBounds(refreshRoiBadge);
window.api.roi.onEditing(refreshRoiBadge);
window.api.roi.onVisible((v) => setStatus(`ROI overlay ${v ? 'shown' : 'hidden'}`));

window.api.auto.onCapture((data) => {
  appendLine(`[AUTO] change detected -> ${data.pngBase64.length}b64`);
});

window.addEventListener('DOMContentLoaded', async () => {
  await refreshRoiBadge();
  setStatus('Ready');
});
