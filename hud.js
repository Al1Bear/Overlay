// hud.js
const card = document.getElementById('card');
const ROI  = document.getElementById('roi');
const EDIT = document.getElementById('edit');

const L1 = document.getElementById('l1');
const L2 = document.getElementById('l2');
const L3 = document.getElementById('l3');
const L4 = document.getElementById('l4');
const L5 = document.getElementById('l5');
const L6 = document.getElementById('l6');
const L7 = document.getElementById('l7');

let interactive = false;
let dragging = false;
let start = { x:0, y:0 };
let orig = { x:0, y:0 };

window.addEventListener('mousemove', e => {
  if (!interactive || !dragging) return;
  const dx = e.screenX - start.x;
  const dy = e.screenY - start.y;
  window.bridge.hudMoveTo(orig.x + dx, orig.y + dy);
});

window.addEventListener('mouseup', () => dragging = false);

card.addEventListener('mousedown', async (e) => {
  if (!interactive) return;
  dragging = true;
  start.x = e.screenX; start.y = e.screenY;
  const b = await window.bridge.getHudBounds();
  orig.x = b.x; orig.y = b.y;
});

window.bridge.onHudText((payload) => {
  // payload: { lines: string[], pulse: boolean, roi?: {x,y,w,h}, showROI?: boolean }
  const lines = payload?.lines || [];
  L1.textContent = lines[0] || '—';
  L2.textContent = lines[1] || '';
  L3.textContent = lines[2] || '';
  L4.textContent = lines[3] || '';
  L5.textContent = lines[4] || '';
  L6.textContent = lines[5] || '';
  L7.textContent = lines[6] || '';

  if (payload?.pulse) {
    card.classList.add('active');
    setTimeout(() => card.classList.remove('active'), 800);
  }
  if (payload?.showROI && payload.roi) {
    ROI.hidden = false;
    ROI.style.left = payload.roi.x + 'px';
    ROI.style.top  = payload.roi.y + 'px';
    ROI.style.width  = payload.roi.w + 'px';
    ROI.style.height = payload.roi.h + 'px';
  } else {
    ROI.hidden = true;
  }
});

window.bridge.onHudEdit((on) => {
  interactive = !!on;
  if (interactive) {
    EDIT.hidden = false;
    window.bridge.setHudClickThrough(false);
  } else {
    EDIT.hidden = true;
    window.bridge.setHudClickThrough(true);
  }
});
