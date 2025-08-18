// roi.js
// Handles editing the ROI window bounds by dragging its edges/corners.

const MIN_W = 80;
const MIN_H = 80;

const hintEl = document.getElementById('hint');

// Let main know we're alive and request initial bounds
window.api.roi.hello();

// Keep local cache of bounds (Electron window bounds)
let bounds = null;
window.api.roi.onBounds((b) => { bounds = b; updateHint(); });
window.api.roi.onEditing((on) => {
  hintEl.style.display = on ? 'block' : 'none';
});

// Utilities to ask main to set new bounds
async function setBounds(newB) {
  bounds = await window.api.roi.set(newB);
  updateHint();
}
function updateHint() {
  if (!bounds) return;
  hintEl.textContent = `Editing ROI ${bounds.width}×${bounds.height}`;
}

// Drag logic
let dragging = false;
let dragDir = null;
let start = null;

function startDrag(dir, e) {
  dragging = true;
  dragDir = dir;
  start = {
    mx: e.screenX, my: e.screenY,
    x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height
  };
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', stopDrag, { once: true });
}

function onDragMove(e) {
  if (!dragging || !bounds) return;
  const dx = e.screenX - start.mx;
  const dy = e.screenY - start.my;

  let x = start.x, y = start.y, w = start.w, h = start.h;

  // corners
  if (dragDir.includes('n')) { y = start.y + dy; h = start.h - dy; }
  if (dragDir.includes('s')) { h = start.h + dy; }
  if (dragDir.includes('w')) { x = start.x + dx; w = start.w - dx; }
  if (dragDir.includes('e')) { w = start.w + dx; }

  // clamp min size
  if (w < MIN_W) { if (dragDir.includes('w')) x -= (MIN_W - w); w = MIN_W; }
  if (h < MIN_H) { if (dragDir.includes('n')) y -= (MIN_H - h); h = MIN_H; }

  setBounds({ x, y, width: w, height: h });
}

function stopDrag() {
  dragging = false;
  window.removeEventListener('mousemove', onDragMove);
}

// Bind all hit areas
document.querySelectorAll('[data-dir]').forEach(el => {
  el.addEventListener('mousedown', (e) => {
    // Only when editing (the main process sets click-through OFF)
    startDrag(el.dataset.dir, e);
    e.preventDefault();
  });
});
