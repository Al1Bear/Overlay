// roi.js — moving + resizing the ROI window in Edit mode

const MIN_W = 80, MIN_H = 80;
let bounds = null;

window.api.roi.hello();
window.api.roi.onBounds((b) => { bounds = b; });
window.api.roi.onEditing((on) => {
  document.getElementById('hint').style.display = on ? 'block' : 'none';
});

// Helpers
async function setBounds(b) { bounds = await window.api.roi.set(b); }
function startState(e) {
  return { mx: e.screenX, my: e.screenY, x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
}

// Move (drag inside)
document.getElementById('drag').addEventListener('mousedown', (e) => {
  const s = startState(e);
  function move(ev) {
    const dx = ev.screenX - s.mx;
    const dy = ev.screenY - s.my;
    setBounds({ x: s.x + dx, y: s.y + dy, width: s.w, height: s.h });
  }
  function up() { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); }
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up, { once: true });
});

// Resize on edges/corners
document.querySelectorAll('[data-dir]').forEach(el => {
  el.addEventListener('mousedown', (e) => {
    const dir = el.dataset.dir;
    const s = startState(e);
    function move(ev) {
      const dx = ev.screenX - s.mx;
      const dy = ev.screenY - s.my;
      let x = s.x, y = s.y, w = s.w, h = s.h;
      if (dir.includes('n')) { y = s.y + dy; h = s.h - dy; }
      if (dir.includes('s')) { h = s.h + dy; }
      if (dir.includes('w')) { x = s.x + dx; w = s.w - dx; }
      if (dir.includes('e')) { w = s.w + dx; }
      if (w < MIN_W) { if (dir.includes('w')) x -= (MIN_W - w); w = MIN_W; }
      if (h < MIN_H) { if (dir.includes('n')) y -= (MIN_H - h); h = MIN_H; }
      setBounds({ x, y, width: w, height: h });
    }
    function up() { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up, { once: true });
  });
});

// Keyboard nudge
window.addEventListener('keydown', (e) => {
  if (!bounds) return;
  const step = e.shiftKey ? 10 : 1;
  let { x, y, width, height } = bounds;
  if (e.key === 'ArrowLeft')  x -= step;
  if (e.key === 'ArrowRight') x += step;
  if (e.key === 'ArrowUp')    y -= step;
  if (e.key === 'ArrowDown')  y += step;
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
    e.preventDefault();
    setBounds({ x, y, width, height });
  }
});
