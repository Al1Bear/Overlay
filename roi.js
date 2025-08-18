// roi.js — DPI‑aware, throttled drag/resize with 8 handles
const frame = document.getElementById('frame');
const hint  = document.getElementById('hint');

// handles
const H = id => document.getElementById(id);
const handles = {
  tl: H('tl'), tr: H('tr'), bl: H('bl'), br: H('br'),
  tm: H('tm'), bm: H('bm'), lm: H('lm'), rm: H('rm'),
};

let editing = false;
let dragging = false;
let mode = 'move';
let start = { sx:0, sy:0, x:0, y:0, w:0, h:0 };

const DPR = () => window.devicePixelRatio || 1;
const MIN_W = 60, MIN_H = 60;

// API
function enableEdit(on){
  editing = !!on;
  document.body.classList.toggle('edit', editing);
  hint.style.display = editing ? 'block' : 'none';
}
window.bridge.onRoiEdit((on) => enableEdit(on));

async function getBounds(){ return await window.bridge.getRoi(); }

// throttle setRoi to ~60fps
let pending = null, sending = false;
async function scheduleSet(b){
  pending = b;
  if (sending) return;
  sending = true;
  const tick = async () => {
    if (!pending) { sending = false; return; }
    const next = pending; pending = null;
    await window.bridge.setRoi(next);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Begin drag
function begin(modeName) {
  return async (e) => {
    if (!editing) return;
    dragging = true; mode = modeName;
    const b = await getBounds();
    start = { sx: e.screenX, sy: e.screenY, x: b.x, y: b.y, w: b.width, h: b.height };
    e.stopPropagation();
  };
}
frame.addEventListener('mousedown', begin('move'));
handles.tl.addEventListener('mousedown', begin('tl'));
handles.tr.addEventListener('mousedown', begin('tr'));
handles.bl.addEventListener('mousedown', begin('bl'));
handles.br.addEventListener('mousedown', begin('br'));
handles.tm.addEventListener('mousedown', begin('t'));
handles.bm.addEventListener('mousedown', begin('b'));
handles.lm.addEventListener('mousedown', begin('l'));
handles.rm.addEventListener('mousedown', begin('r'));

// During drag
window.addEventListener('mousemove', async (e) => {
  if (!dragging) return;

  const dx = (e.screenX - start.sx) / DPR();
  const dy = (e.screenY - start.sy) / DPR();

  let { x, y, w, h } = { x:start.x, y:start.y, w:start.w, h:start.h };

  switch (mode) {
    case 'move':
      x = Math.round(start.x + dx);
      y = Math.round(start.y + dy);
      break;
    case 'tl':
      x = Math.round(start.x + dx);
      y = Math.round(start.y + dy);
      w = Math.round(start.w - dx);
      h = Math.round(start.h - dy);
      break;
    case 'tr':
      y = Math.round(start.y + dy);
      w = Math.round(start.w + dx);
      h = Math.round(start.h - dy);
      break;
    case 'bl':
      x = Math.round(start.x + dx);
      w = Math.round(start.w - dx);
      h = Math.round(start.h + dy);
      break;
    case 'br':
      w = Math.round(start.w + dx);
      h = Math.round(start.h + dy);
      break;
    case 'l':
      x = Math.round(start.x + dx);
      w = Math.round(start.w - dx);
      break;
    case 'r':
      w = Math.round(start.w + dx);
      break;
    case 't':
      y = Math.round(start.y + dy);
      h = Math.round(start.h - dy);
      break;
    case 'b':
      h = Math.round(start.h + dy);
      break;
  }

  if (w < MIN_W) w = MIN_W;
  if (h < MIN_H) h = MIN_H;

  scheduleSet({ x, y, width: w, height: h });
});

window.addEventListener('mouseup', () => { dragging = false; });

// Arrow key nudges (1px / 10px with Shift)
window.addEventListener('keydown', async (e) => {
  if (!editing) return;
  const step = e.shiftKey ? 10 : 1;
  const b = await getBounds();
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Escape'].includes(e.key)) e.preventDefault();
  if (e.key === 'ArrowLeft')  scheduleSet({ x: b.x - step, y: b.y, width: b.width, height: b.height });
  if (e.key === 'ArrowRight') scheduleSet({ x: b.x + step, y: b.y, width: b.width, height: b.height });
  if (e.key === 'ArrowUp')    scheduleSet({ x: b.x, y: b.y - step, width: b.width, height: b.height });
  if (e.key === 'ArrowDown')  scheduleSet({ x: b.x, y: b.y + step, width: b.width, height: b.height });
  if (e.key === 'Escape')     window.bridge.editRoi(false);
});
