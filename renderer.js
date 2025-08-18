// renderer.js (sidebar)
const $ = s => document.querySelector(s);

const btnEdit = $('#btnEdit');
const btnAuto = $('#btnAuto');
const btnSnap = $('#btnSnap');
const btnBox  = $('#btnBox');
const out     = $('#out');
const statusEl= $('#status');

let isEditing = false;
let autoOn = false;

function setStatus(s){ statusEl.textContent = s || ''; }
function showLines(lines){ if (lines && lines.length) out.textContent = lines.join('\n'); }

// Edit toggle
async function toggleEdit() {
  isEditing = !isEditing;
  await window.bridge.editRoi(isEditing);
  btnEdit.textContent = isEditing ? 'Finish Edit' : 'Edit ROI';
  setStatus(isEditing ? 'Editing (drag/resize in the green box)…' : 'Edit done.');
}

// Auto toggle
async function toggleAuto() {
  autoOn = !autoOn;
  autoOn = await window.bridge.auto(autoOn);
  btnAuto.textContent = autoOn ? 'Stop Auto' : 'Auto';
  setStatus(autoOn ? 'Auto: watching digits…' : 'Auto: off');
}

// Snap now
async function snapNow() {
  setStatus('Capturing…');
  const lines = await window.bridge.snap();
  showLines(lines);
  setStatus('Captured ✓');
}

btnEdit.addEventListener('click', toggleEdit);
btnAuto.addEventListener('click', toggleAuto);
btnSnap.addEventListener('click', snapNow);
btnBox.addEventListener('click', async () => {
  const vis = await window.bridge.toggleBox();
  setStatus(vis ? 'Box shown' : 'Box hidden');
});

// Hotkey relays from main
window.bridge.onEditToggle(() => toggleEdit());
window.bridge.onSnap(() => snapNow());
window.bridge.onAutoToggle(() => toggleAuto());

// Main → status/results
window.bridge.onUpdate(({ lines, status }) => {
  if (lines && lines.length) showLines(lines);
  if (status) setStatus(status);
});
window.bridge.onStatus((s) => setStatus(s));
