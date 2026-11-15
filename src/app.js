import { icon, hydrateIcons } from './icons.js';
import { db } from './db.js';
import { auth, PACKS, SIGNUP_BONUS } from './auth.js';
import { RATIOS, setRemoteModels, listModels, customModels, saveCustomModels, generateImage, drawArt } from './providers.js';

/* ============================== helpers ============================== */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } },
};
const isEditable = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

function toast(msg, kind = '') {
  const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = msg;
  $('#toasts').append(el); setTimeout(() => el.remove(), 3200);
}

function openModal(title, bodyHTML, mount) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-label="${esc(title)}"><header><h3>${esc(title)}</h3><button class="icon-btn" data-x aria-label="关闭">${icon('close')}</button></header><div class="body">${bodyHTML}</div></div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  bg.addEventListener('pointerdown', (e) => { if (e.target === bg) close(); });
  $('[data-x]', bg).onclick = close;
  $('#overlay').append(bg); mount?.($('.body', bg), close);
  return close;
}

const menuEl = () => $('#menu');
function closeMenu() { menuEl().hidden = true; menuEl().innerHTML = ''; }
function openMenu(anchor, html, onPick, align = 'right') {
  const m = menuEl(); m.innerHTML = html; m.hidden = false;
  const r = anchor.getBoundingClientRect();
  m.style.top = r.bottom + 8 + 'px';
  m.style.left = (align === 'right' ? Math.max(8, r.right - m.offsetWidth) : r.left) + 'px';
  m.onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) { closeMenu(); onPick(b.dataset.k); } };
}
document.addEventListener('pointerdown', (e) => { if (!menuEl().hidden && !e.target.closest('#menu') && !e.target.closest('[data-menu]')) closeMenu(); }, true);

/* ============================== state ============================== */
let user = null;
let project = null;
let nodes = [];
let view = { x: 0, y: 0, k: 1 };
let sel = new Set();
let tool = 'select';
let spaceHeld = false;
let undoStack = [], redoStack = [];
let clip = [];
const jobs = new Map();           // nodeId -> AbortController
const nodeEls = new Map();
const stage = $('#stage'), world = $('#world'), nodesLayer = $('#nodes'), edges = $('#edges');
const dockState = Object.assign({ model: 'aurora', ratio: '1:1', n: 1 }, LS.get('huabu.dock', {}));
const byId = (id) => nodes.find((n) => n.id === id);
const selNodes = () => nodes.filter((n) => sel.has(n.id));

/* ============================== history ============================== */
const cloneNodes = (l) => l.map((n) => ({ ...n, refs: n.refs ? [...n.refs] : undefined }));
function snap() { undoStack.push(cloneNodes(nodes)); if (undoStack.length > 80) undoStack.shift(); redoStack = []; syncHist(); }
function restore(list) {
  nodes = cloneNodes(list);
  for (const n of nodes) if (n.status === 'loading' && !jobs.has(n.id)) { n.status = 'error'; n.error = '已中断'; }
  sel = new Set([...sel].filter((id) => byId(id)));
  render(); changed();
}
function undo() { if (!undoStack.length) return; redoStack.push(cloneNodes(nodes)); restore(undoStack.pop()); syncHist(); }
function redo() { if (!redoStack.length) return; undoStack.push(cloneNodes(nodes)); restore(redoStack.pop()); syncHist(); }
function syncHist() { $('#btnUndo').disabled = !undoStack.length; $('#btnRedo').disabled = !redoStack.length; }

/* ============================== persistence ============================== */
let saveTimer = 0;
function changed() { $('#saveState').textContent = '保存中…'; clearTimeout(saveTimer); saveTimer = setTimeout(save, 700); }
async function makeThumb() {
  const last = [...nodes].reverse().find((n) => n.type === 'image' && n.status === 'done' && n.src?.startsWith('data:'));
  if (!last) return '';
  if (project._thumbSrc === last.src) return project.thumb || '';
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = last.src; });
    const c = document.createElement('canvas'); c.width = 320; c.height = 184;
    const g = c.getContext('2d'); const s = Math.max(320 / img.width, 184 / img.height);
    g.drawImage(img, (320 - img.width * s) / 2, (184 - img.height * s) / 2, img.width * s, img.height * s);
    project._thumbSrc = last.src; return c.toDataURL('image/jpeg', 0.6);
  } catch { return ''; }
}
async function save() {
  if (!project || !user) return;
  clearTimeout(saveTimer);
  try {
    project.thumb = await makeThumb();
    const rec = { id: project.id, uid: user.id, name: project.name, updated: Date.now(), thumb: project.thumb, view, nodes: cloneNodes(nodes) };
    project.updated = rec.updated; await db.put(rec); $('#saveState').textContent = '已保存';
  } catch (e) { $('#saveState').textContent = '保存失败'; console.error(e); }
}
window.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
window.addEventListener('pagehide', save);

async function openProject(id) {
  if (project) await save();
  const rec = await db.get(id); if (!rec) return;
  for (const c of jobs.values()) c.abort(); jobs.clear();
  project = { id: rec.id, name: rec.name, updated: rec.updated, thumb: rec.thumb };
  nodes = cloneNodes(rec.nodes || []);
  for (const n of nodes) if (n.status === 'loading') { n.status = 'error'; n.error = '已中断'; }
  view = rec.view || { x: 0, y: 0, k: 1 }; sel = new Set(); undoStack = []; redoStack = []; syncHist();
  $('#projName').value = project.name; LS.set('huabu.last.' + user.id, id);
  nodeEls.forEach((el) => el.remove()); nodeEls.clear();
  render(); applyView(); updateDock();
  if (!rec.nodes?.length) { view = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 - 60, k: 1 }; applyView(); }
}
async function newProject() {
  const id = 'p_' + uid();
  await db.put({ id, uid: user.id, name: '未命名画布', updated: Date.now(), nodes: [], view: null, thumb: '' });
  await openProject(id);
}

/* ============================== view ============================== */
function applyView() {
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`;
  world.style.setProperty('--inv', 1 / view.k);
  const gs = 24 * view.k;
  const g2 = gs < 10 ? gs * 2 : gs;
  stage.style.setProperty('--gs', g2 + 'px'); stage.style.setProperty('--gx', view.x % g2 + 'px'); stage.style.setProperty('--gy', view.y % g2 + 'px');
  $('#zVal').textContent = Math.round(view.k * 100) + '%';
  drawMinimap(); changedView();
}
let viewTimer = 0;
function changedView() { clearTimeout(viewTimer); viewTimer = setTimeout(() => project && changed(), 400); }
const toWorld = (cx, cy) => { const r = stage.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }; };
function zoomAt(cx, cy, nk) {
  nk = clamp(nk, 0.1, 4); const r = stage.getBoundingClientRect(); const px = cx - r.left, py = cy - r.top;
  view.x = px - (px - view.x) * (nk / view.k); view.y = py - (py - view.y) * (nk / view.k); view.k = nk; applyView();
}
const zoomCenter = (f) => { const r = stage.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.k * f); };
const bounds = (l) => l.length ? l.reduce((b, n) => ({ x1: Math.min(b.x1, n.x), y1: Math.min(b.y1, n.y), x2: Math.max(b.x2, n.x + n.w), y2: Math.max(b.y2, n.y + n.h) }), { x1: 1e9, y1: 1e9, x2: -1e9, y2: -1e9 }) : null;
function safeArea() { const w = stage.clientWidth, h = stage.clientHeight, dh = $('#dock').offsetHeight + 50; return { l: w < 900 ? 16 : 90, t: 70, r: 20, b: dh }; }
function fitTo(list, maxK = 1) {
  const b = bounds(list); const a = safeArea();
  if (!b) { view = { x: stage.clientWidth / 2, y: (stage.clientHeight - a.b) / 2 + 20, k: 1 }; return applyView(); }
  const aw = stage.clientWidth - a.l - a.r - 60, ah = stage.clientHeight - a.t - a.b - 60;
  const k = clamp(Math.min(aw / (b.x2 - b.x1), ah / (b.y2 - b.y1), maxK), 0.1, 4);
  view.k = k;
  view.x = a.l + 30 + (aw - (b.x2 - b.x1) * k) / 2 - b.x1 * k;
  view.y = a.t + 30 + (ah - (b.y2 - b.y1) * k) / 2 - b.y1 * k;
  applyView();
}
function ensureVisible(list) {
  const b = bounds(list); if (!b) return; const a = safeArea();
  const x1 = b.x1 * view.k + view.x, x2 = b.x2 * view.k + view.x, y1 = b.y1 * view.k + view.y, y2 = b.y2 * view.k + view.y;
  if (x1 < a.l || y1 < a.t || x2 > stage.clientWidth - a.r || y2 > stage.clientHeight - a.b) fitTo(list, Math.min(view.k, 1));
}

/* ============================== rendering ============================== */
let rafId = 0;
function render() { if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; renderNodes(); renderEdges(); drawMinimap(); $('#empty').hidden = nodes.length > 0; }); }

function makeNodeEl(n) {
  const el = document.createElement('div'); el.dataset.id = n.id;
  if (n.type === 'note') {
    el.innerHTML = `<div class="txt" spellcheck="false"></div><div class="handle" data-handle></div>`;
  } else {
    el.innerHTML = `<div class="stage-in"></div><div class="cap"></div><div class="handle" data-handle></div>`;
  }
  const items = n.type === 'image'
    ? [['variant', 'wand', '变体'], ['download', 'download', '下载'], ['copy', 'copy', '复制'], ['del', 'trash', '删除', 'd']]
    : [['copy', 'copy', '复制'], ['del', 'trash', '删除', 'd']];
  const bar = document.createElement('div'); bar.className = 'bar';
  bar.innerHTML = items.map(([a, i, t, c]) => `<button data-act="${a}" class="${c || ''}">${icon(i, 15)}${t}</button>`).join('');
  el.append(bar);
  return el;
}

function renderNodes() {
  const single = sel.size === 1;
  nodes.forEach((n, i) => {
    let el = nodeEls.get(n.id);
    if (!el) { el = makeNodeEl(n); nodeEls.set(n.id, el); nodesLayer.append(el); }
    el.className = `node ${n.type} ${n.status || ''} ${sel.has(n.id) ? 'sel' : ''} ${sel.has(n.id) && single ? 'single' : ''}${el.classList.contains('editing') ? ' editing' : ''}`;
    el.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;z-index:${i}`;
    if (n.type === 'note') {
      const t = $('.txt', el); if (document.activeElement !== t && t.textContent !== n.text) t.textContent = n.text || '';
    } else {
      const inner = $('.stage-in', el); const key = n.status + '|' + (n.src ? n.src.length : 0) + '|' + (n.error || '');
      if (inner.dataset.key !== key) {
        inner.dataset.key = key;
        inner.innerHTML = n.status === 'loading' ? `<div class="state"><div class="spin"></div><span>生成中…</span></div>`
          : n.status === 'error' ? `<div class="state">${icon('close', 22)}<span>${esc(n.error || '生成失败')}</span></div>`
            : `<img alt="" draggable="false">`;
        if (n.status === 'done') $('img', inner).src = n.src;
      }
      $('.cap', el).textContent = n.prompt ? `${n.prompt}` : '';
    }
  });
  for (const [id, el] of nodeEls) if (!byId(id)) { el.remove(); nodeEls.delete(id); }
  updateDock();
}

function renderEdges() {
  let d = '';
  for (const n of nodes) {
    if (!n.refs) continue;
    for (const rid of n.refs) {
      const s = byId(rid); if (!s) continue;
      const x1 = s.x + s.w, y1 = s.y + s.h / 2, x2 = n.x, y2 = n.y + n.h / 2, dx = Math.max(50, Math.abs(x2 - x1) / 2);
      d += `<path class="${n.status === 'loading' ? 'live' : ''}" d="M${x1} ${y1}C${x1 + dx} ${y1},${x2 - dx} ${y2},${x2} ${y2}"/>`;
    }
  }
  edges.innerHTML = d;
}

/* ---------- minimap ---------- */
let mmMap = null;
function drawMinimap() {
  const c = $('#minimap'); if (!c || !project) return;
  const g = c.getContext('2d'), W = c.width, H = c.height; g.clearRect(0, 0, W, H);
  const vw = stage.clientWidth / view.k, vh = stage.clientHeight / view.k, vx = -view.x / view.k, vy = -view.y / view.k;
  const b = bounds(nodes) || { x1: vx, y1: vy, x2: vx + vw, y2: vy + vh };
  const x1 = Math.min(b.x1, vx), y1 = Math.min(b.y1, vy), x2 = Math.max(b.x2, vx + vw), y2 = Math.max(b.y2, vy + vh);
  const pad = 10, s = Math.min((W - pad * 2) / (x2 - x1), (H - pad * 2) / (y2 - y1));
  const ox = (W - (x2 - x1) * s) / 2 - x1 * s, oy = (H - (y2 - y1) * s) / 2 - y1 * s;
  mmMap = { s, ox, oy };
  const dark = document.documentElement.dataset.theme !== 'light';
  for (const n of nodes) {
    g.fillStyle = n.type === 'note' ? '#ffe58a' : n.status === 'done' ? (dark ? 'rgba(180,170,255,.8)' : 'rgba(110,90,240,.7)') : 'rgba(150,150,170,.5)';
    g.beginPath(); g.roundRect?.(n.x * s + ox, n.y * s + oy, Math.max(3, n.w * s), Math.max(3, n.h * s), 2); g.fill();
  }
  g.strokeStyle = '#7c6cff'; g.lineWidth = 1.5; g.fillStyle = 'rgba(124,108,255,.12)';
  g.beginPath(); g.rect(vx * s + ox, vy * s + oy, vw * s, vh * s); g.fill(); g.stroke();
}
$('#minimap').addEventListener('pointerdown', (e) => {
  const c = e.currentTarget; c.setPointerCapture(e.pointerId);
  const go = (ev) => {
    if (!mmMap) return; const r = c.getBoundingClientRect();
    const wx = ((ev.clientX - r.left) * (c.width / r.width) - mmMap.ox) / mmMap.s, wy = ((ev.clientY - r.top) * (c.height / r.height) - mmMap.oy) / mmMap.s;
    view.x = stage.clientWidth / 2 - wx * view.k; view.y = stage.clientHeight / 2 - wy * view.k; applyView();
  };
  go(e); c.onpointermove = go; c.onpointerup = () => { c.onpointermove = null; };
});

/* ============================== selection ============================== */
function setSel(ids) { sel = new Set(ids); render(); }
function bringFront(id) { const i = nodes.findIndex((n) => n.id === id); if (i >= 0 && i < nodes.length - 1) nodes.push(...nodes.splice(i, 1)); }

/* ============================== node ops ============================== */
const overlaps = (a, b, m = 24) => a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y;
function findFree(x, y, w, h) {
  const r = { x, y, w, h }; const x0 = x;
  for (let i = 1; i < 400; i++) {
    if (!nodes.some((n) => overlaps(r, n))) return r;
    r.y += 48; if (i % 12 === 0) { r.y = y; r.x += w + 40; }
  }
  r.x = x0; return r;
}
function viewCenter() {
  const a = safeArea(); const cx = a.l + (stage.clientWidth - a.l - a.r) / 2, cy = a.t + (stage.clientHeight - a.t - a.b) / 2;
  return toWorld(cx + stage.getBoundingClientRect().left, cy + stage.getBoundingClientRect().top);
}
function sizeFor(ratio) { const [w, h] = RATIOS[ratio] || RATIOS['1:1']; const r = w / h; const W = Math.round(Math.sqrt(380 * 380 * r)); return { w: W, h: Math.round(W / r) }; }

function addNote(x, y, text = '') {
  snap(); const n = { id: uid(), type: 'note', x: Math.round(x), y: Math.round(y), w: 220, h: 160, text };
  nodes.push(n); setSel([n.id]); render(); changed(); return n;
}
function startEdit(id) {
  const n = byId(id); if (!n || n.type !== 'note') return;
  if (nodeEls.get(id)?.classList.contains('editing')) return;
  renderNodes(); const el = nodeEls.get(id), t = $('.txt', el);
  const before = n.text || ''; snap(); const stackLen = undoStack.length;
  el.classList.add('editing'); t.contentEditable = 'true'; t.focus();
  const r = document.createRange(); r.selectNodeContents(t); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  t.onblur = () => {
    t.contentEditable = 'false'; el.classList.remove('editing'); n.text = t.innerText.replace(/\n$/, '');
    if (n.text === before && undoStack.length === stackLen) { undoStack.pop(); syncHist(); } else changed();
    t.onblur = null; render();
  };
}
function deleteSel() {
  if (!sel.size) return; snap();
  for (const id of sel) { jobs.get(id)?.abort(); jobs.delete(id); }
  nodes = nodes.filter((n) => !sel.has(n.id)); for (const n of nodes) if (n.refs) n.refs = n.refs.filter((r) => !sel.has(r));
  sel = new Set(); render(); changed();
}
function duplicate(list, off = 32) {
  if (!list.length) return; snap();
  const idmap = new Map(); const copies = list.filter((n) => n.status !== 'loading').map((n) => { const c = { ...n, id: uid(), x: n.x + off, y: n.y + off, refs: undefined }; idmap.set(n.id, c.id); return c; });
  nodes.push(...copies); setSel(copies.map((c) => c.id)); changed();
}
function downloadNode(n) {
  if (!n.src) return;
  if (!n.src.startsWith('data:')) return void window.open(n.src, '_blank');
  const a = document.createElement('a'); a.href = n.src; a.download = `huabu-${n.id}.${n.src.startsWith('data:image/png') ? 'png' : n.src.startsWith('data:image/svg') ? 'svg' : 'jpg'}`; a.click();
}

/* ---------- uploads ---------- */
async function readImage(file) {
  const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  let { width: w, height: h } = img, src = url; const m = Math.max(w, h);
  if (m > 2048 || file.size > 3e6) { // downscale to keep projects light
    const k = Math.min(1, 2048 / m); const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); src = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9); w = c.width; h = c.height;
  }
  return { src, w, h };
}
async function addImageFiles(files, at) {
  files = [...files].filter((f) => f.type.startsWith('image/')); if (!files.length) return;
  snap(); const ids = []; let p = at || viewCenter();
  for (const f of files) {
    try {
      const { src, w, h } = await readImage(f); const s = 360 / Math.max(w, h); const nw = Math.round(w * s), nh = Math.round(h * s);
      const pos = findFree(p.x - nw / 2, p.y - nh / 2, nw, nh);
      const n = { id: uid(), type: 'image', status: 'done', src, x: Math.round(pos.x), y: Math.round(pos.y), w: nw, h: nh, prompt: f.name.replace(/\.[^.]+$/, ''), ratio: '' };
      nodes.push(n); ids.push(n.id); p = { x: pos.x + nw + 60 + nw / 2, y: p.y };
    } catch { toast('无法读取图片：' + f.name, 'err'); }
  }
  if (ids.length) { setSel(ids); ensureVisible(selNodes()); changed(); } else { undoStack.pop(); syncHist(); }
}

/* ============================== generation ============================== */
const modelById = (id) => listModels().find((m) => m.id === id) || listModels()[0];
function refNodes() { return selNodes().filter((n) => n.type === 'image' && n.status === 'done' && n.src); }

function updateDock() {
  const refs = refNodes(), box = $('#refs');
  box.hidden = !refs.length;
  if (refs.length) box.innerHTML = refs.slice(0, 6).map((n) => `<div class="chip" style="background-image:url('${n.src.startsWith('data:') ? n.src : esc(n.src)}')"></div>`).join('') + `<span class="tip">${refs.length > 4 ? '最多使用 4 张参考图' : `${refs.length} 张参考图`}</span>`;
  const m = modelById(dockState.model);
  $('#genCost').textContent = m.cost * dockState.n; $('#nVal').textContent = dockState.n + ' 张';
  $('#genLabel').textContent = refs.length ? '参考生成' : '生成';
}

async function generate(o) {
  const prompt = (o.prompt || '').trim(); if (!prompt) { toast('先写点提示词吧'); $('#prompt').focus(); return; }
  const model = modelById(o.model), n = o.n, cost = model.cost * n, refs = o.refs;
  const serverBilled = auth.kind === 'remote';   // server spends/refunds per image itself
  if (user.credits < cost) { toast('算力不足，请先充值', 'err'); openRecharge(); return; }
  if (!serverBilled) {
    try { user.credits = await auth.spend(cost, `生成 ${n} 张 · ${model.name}`); setCredits(); }
    catch (e) { if (e.code === 'NO_CREDITS') { toast('算力不足，请先充值', 'err'); openRecharge(); } else toast(e.message, 'err'); return; }
  }

  snap();
  const { w, h } = sizeFor(o.ratio); const created = [];
  const rb = bounds(refs); let ax, ay;
  if (rb) { ax = rb.x2 + 90; ay = rb.y1; } else { const c = viewCenter(); ax = c.x - w / 2; ay = c.y - h / 2; }
  for (let i = 0; i < n; i++) {
    const pos = findFree(ax, ay, w, h);
    const node = { id: uid(), type: 'image', status: 'loading', x: Math.round(pos.x), y: Math.round(pos.y), w, h, prompt, model: model.id, ratio: o.ratio, refs: refs.map((r) => r.id), src: '' };
    nodes.push(node); created.push(node); ax = pos.x; ay = pos.y;
  }
  setSel([]); render(); changed(); ensureVisible(created);
  const srcs = refs.slice(0, 4).map((r) => r.src);
  await Promise.all(created.map(async (node) => {
    const ctl = new AbortController(); jobs.set(node.id, ctl);
    try {
      const src = await generateImage(model, { prompt, ratio: o.ratio, refs: srcs, signal: ctl.signal, seed: (Math.random() * 1e9) | 0 });
      const cur = byId(node.id); if (cur) { Object.assign(cur, { src, status: 'done', error: undefined }); }
    } catch (e) {
      const cur = byId(node.id);
      if (e.name !== 'AbortError' || cur) {
        if (cur) Object.assign(cur, { status: 'error', error: e.name === 'AbortError' ? '已取消' : e.message });
        if (e.name !== 'AbortError') toast('生成失败：' + e.message, 'err');
      }
      if (!serverBilled) try { user.credits = await auth.refund(model.cost, `生成失败退还 · ${model.name}`); setCredits(); } catch { /* ignore */ }
    } finally {
      jobs.delete(node.id); render(); changed();
      if (serverBilled) auth.me().then((u) => { if (u && user) { user.credits = u.credits; setCredits(); } });
    }
  }));
}
const submitDock = () => generate({ prompt: $('#prompt').value, model: dockState.model, ratio: dockState.ratio, n: dockState.n, refs: refNodes() });
function variantOf(n) {
  generate({ prompt: n.prompt || '', model: n.model || dockState.model, ratio: n.ratio || '1:1', n: 1, refs: [n] });
}

/* ============================== pointer interaction ============================== */
let drag = null;
stage.addEventListener('pointerdown', (e) => {
  closeMenu();
  if (e.target.closest('.bar') || e.target.closest('.recipes')) return;
  if (e.target.closest('.txt')?.isContentEditable) return;
  stage.focus({ preventScroll: true }); if (document.activeElement !== stage) document.activeElement?.blur?.();
  const pan = e.button === 1 || tool === 'hand' || spaceHeld;
  if (e.button === 2) return;
  stage.setPointerCapture(e.pointerId);
  const sx = e.clientX, sy = e.clientY;
  if (pan) { drag = { kind: 'pan', sx, sy, vx: view.x, vy: view.y }; stage.classList.add('panning'); e.preventDefault(); return; }

  const nodeEl = e.target.closest('.node'); const id = nodeEl?.dataset.id; const n = id && byId(id);
  if (n && e.target.closest('[data-handle]')) {
    drag = { kind: 'resize', n, sx, sy, w: n.w, h: n.h, ratio: n.w / n.h, moved: false }; return;
  }
  if (n) {
    if (e.shiftKey) { sel.has(id) ? sel.delete(id) : sel.add(id); } else if (!sel.has(id)) sel = new Set([id]);
    bringFront(id);
    drag = { kind: 'move', sx, sy, items: selNodes().map((m) => ({ m, x: m.x, y: m.y })), moved: false, clickId: id, shift: e.shiftKey };
    render(); return;
  }
  if (tool === 'note') { const p = toWorld(sx, sy); const nn = addNote(p.x - 110, p.y - 30); setTool('select'); drag = null; setTimeout(() => startEdit(nn.id), 30); return; }
  const base = e.shiftKey ? new Set(sel) : new Set(); if (!e.shiftKey) { sel = new Set(); render(); }
  drag = { kind: 'marquee', sx, sy, base, moved: false };
});

stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (drag.kind === 'pan') { view.x = drag.vx + dx; view.y = drag.vy + dy; applyView(); return; }
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  if (drag.kind === 'move') {
    if (!drag.moved) { drag.moved = true; undoStack.push(cloneNodes(nodes).map((c) => { const it = drag.items.find((i) => i.m.id === c.id); return it ? { ...c, x: it.x, y: it.y } : c; })); redoStack = []; syncHist(); }
    for (const it of drag.items) { it.m.x = Math.round(it.x + dx / view.k); it.m.y = Math.round(it.y + dy / view.k); }
    render();
  } else if (drag.kind === 'resize') {
    if (!drag.moved) { drag.moved = true; undoStack.push(cloneNodes(nodes).map((c) => c.id === drag.n.id ? { ...c, w: drag.w, h: drag.h } : c)); redoStack = []; syncHist(); }
    const n = drag.n; n.w = Math.max(80, Math.round(drag.w + dx / view.k));
    n.h = n.type === 'image' ? Math.round(n.w / drag.ratio) : Math.max(60, Math.round(drag.h + dy / view.k)); render();
  } else if (drag.kind === 'marquee') {
    drag.moved = true; const r = stage.getBoundingClientRect(); const m = $('#marquee');
    const x = Math.min(drag.sx, e.clientX) - r.left, y = Math.min(drag.sy, e.clientY) - r.top, w = Math.abs(dx), h = Math.abs(dy);
    m.hidden = false; Object.assign(m.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    const a = toWorld(Math.min(drag.sx, e.clientX), Math.min(drag.sy, e.clientY)), b = toWorld(Math.max(drag.sx, e.clientX), Math.max(drag.sy, e.clientY));
    sel = new Set([...drag.base, ...nodes.filter((n) => n.x < b.x && n.x + n.w > a.x && n.y < b.y && n.y + n.h > a.y).map((n) => n.id)]); render();
  }
});
const endDrag = () => {
  if (!drag) return;
  if (drag.kind === 'move' && !drag.moved && !drag.shift && sel.size > 1) setSel([drag.clickId]);
  if ((drag.kind === 'move' || drag.kind === 'resize') && drag.moved) changed();
  $('#marquee').hidden = true; stage.classList.remove('panning'); drag = null;
};
stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);

stage.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.node'); const n = el && byId(el.dataset.id);
  if (n?.type === 'note') return startEdit(n.id);
  if (n) return fitTo([n], 1.5);
  if (!e.target.closest('.bar')) { const p = toWorld(e.clientX, e.clientY); const nn = addNote(p.x - 110, p.y - 30); startEdit(nn.id); }
});

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const mode = LS.get('huabu.wheel', 'zoom');
  if (e.ctrlKey || e.metaKey || mode === 'zoom') {
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : (e.deltaMode ? 0.05 : 0.0015))); zoomAt(e.clientX, e.clientY, view.k * f);
  } else { view.x -= e.shiftKey ? e.deltaY : e.deltaX; view.y -= e.shiftKey ? 0 : e.deltaY; applyView(); }
}, { passive: false });

nodesLayer.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const n = byId(b.closest('.node').dataset.id); if (!n) return;
  ({ del: deleteSel, copy: () => duplicate([n]), download: () => downloadNode(n), variant: () => variantOf(n) })[b.dataset.act]?.();
});
stage.addEventListener('contextmenu', (e) => e.preventDefault());

stage.addEventListener('dragover', (e) => { e.preventDefault(); });
stage.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) addImageFiles(e.dataTransfer.files, toWorld(e.clientX, e.clientY)); });
document.addEventListener('paste', (e) => {
  if (!user) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); return addImageFiles(files); }
  if (isEditable(e.target)) return;
  if (clip.length) { e.preventDefault(); const c = clip.map((n) => ({ ...n })); snap(); const ids = c.map((n) => { const x = { ...n, id: uid(), x: n.x + 32, y: n.y + 32, refs: undefined }; nodes.push(x); return x.id; }); clip = c.map((n) => ({ ...n, x: n.x + 32, y: n.y + 32 })); setSel(ids); changed(); }
});

/* ============================== tools & keyboard ============================== */
function setTool(t) { tool = t; stage.classList.toggle('hand', t === 'hand' || spaceHeld); stage.classList.toggle('note', t === 'note'); document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t)); }
document.querySelectorAll('.tool[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
$('#btnUpload').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addImageFiles(e.target.files); e.target.value = ''; };

document.addEventListener('keydown', (e) => {
  if (!user) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (isEditable(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === ' ') { if (!spaceHeld) { spaceHeld = true; stage.classList.add('hand'); } e.preventDefault(); return; }
  if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && k === 'y') { e.preventDefault(); return redo(); }
  if (mod && k === 'a') { e.preventDefault(); return setSel(nodes.map((n) => n.id)); }
  if (mod && k === 'c') { clip = selNodes().filter((n) => n.status !== 'loading').map((n) => ({ ...n })); return; }
  if (mod && k === 'd') { e.preventDefault(); return duplicate(selNodes()); }
  if (mod && k === 'u') { e.preventDefault(); return $('#fileInput').click(); }
  if (mod) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return deleteSel(); }
  if (e.key === 'Escape') { setSel([]); setTool('select'); return; }
  if (e.key.startsWith('Arrow') && sel.size) {
    e.preventDefault(); const s = e.shiftKey ? 10 : 1; snap();
    for (const n of selNodes()) { if (e.key === 'ArrowLeft') n.x -= s; if (e.key === 'ArrowRight') n.x += s; if (e.key === 'ArrowUp') n.y -= s; if (e.key === 'ArrowDown') n.y += s; }
    render(); return changed();
  }
  if (k === 'v') setTool('select'); else if (k === 'h') setTool('hand'); else if (k === 't') setTool('note');
  else if (e.key === '=' || e.key === '+') zoomCenter(1.25); else if (e.key === '-') zoomCenter(0.8);
  else if (e.key === '0') fitTo(sel.size ? selNodes() : nodes); else if (e.key === '1') { zoomCenter(1 / view.k); }
  else if (e.key === '/' || e.key === 'Enter') { e.preventDefault(); $('#prompt').focus(); }
  else if (e.key === '?') openHelp();
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceHeld = false; setTool(tool); } });

/* ============================== dock ============================== */
const promptEl = $('#prompt');
const autogrow = () => { promptEl.style.height = 'auto'; promptEl.style.height = Math.min(160, promptEl.scrollHeight) + 'px'; };
promptEl.addEventListener('input', autogrow);
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submitDock(); }
});
$('#btnGen').onclick = submitDock;
function fillDockSelects() {
  const ms = listModels(); if (!ms.some((m) => m.id === dockState.model)) dockState.model = ms[0].id;
  $('#modelName').textContent = modelById(dockState.model).name;
  $('#selRatio').innerHTML = Object.keys(RATIOS).map((r) => `<option>${r}</option>`).join(''); $('#selRatio').value = dockState.ratio;
}
function closeModelPop() { $('#mpop').hidden = true; }
function openModelPop() {
  const pop = $('#mpop'); pop.hidden = false;
  pop.innerHTML = `<input placeholder="搜索模型…" id="mq" spellcheck="false"><div class="list" id="mlist"></div><div class="foot"><button id="mManage">+ 接入我的模型 API</button></div>`;
  const draw = () => {
    const q = $('#mq').value.trim().toLowerCase();
    $('#mlist').innerHTML = listModels().filter((m) => !q || (m.name + m.desc + (m.model || '')).toLowerCase().includes(q)).map((m) =>
      `<button class="mi ${m.id === dockState.model ? 'on' : ''}" data-id="${esc(m.id)}"><span class="dot"></span><span class="t"><b>${esc(m.name)}</b><small>${esc(m.desc)}</small></span><em>${m.cost} 算力/张</em></button>`).join('') || '<p style="color:var(--mute);padding:12px">没有匹配的模型</p>';
  };
  draw(); $('#mq').oninput = draw; $('#mq').focus();
  $('#mlist').onclick = (e) => { const b = e.target.closest('[data-id]'); if (!b) return; dockState.model = b.dataset.id; LS.set('huabu.dock', dockState); fillDockSelects(); updateDock(); closeModelPop(); };
  if (auth.kind === 'remote') $('.foot', pop).remove(); else $('#mManage').onclick = () => { closeModelPop(); openSettings('models'); };
}
$('#modelBtn').onclick = () => ($('#mpop').hidden ? openModelPop() : closeModelPop());
document.addEventListener('pointerdown', (e) => { if (!$('#mpop').hidden && !e.target.closest('#mpop') && !e.target.closest('#modelBtn')) closeModelPop(); }, true);
$('#selRatio').onchange = (e) => { dockState.ratio = e.target.value; LS.set('huabu.dock', dockState); };
$('#nDec').onclick = () => { dockState.n = clamp(dockState.n - 1, 1, 4); LS.set('huabu.dock', dockState); updateDock(); };
$('#nInc').onclick = () => { dockState.n = clamp(dockState.n + 1, 1, 4); LS.set('huabu.dock', dockState); updateDock(); };

/* ============================== inspiration recipes ============================== */
const RECIPES = [
  ['雨夜霓虹街头', '赛博朋克风格的雨夜东京街头，霓虹灯倒映在湿润的路面，电影感', '16:9'],
  ['极简产品海报', '极简风格的香水瓶产品海报，柔和渐变背景，高级质感，留白构图', '3:4'],
  ['治愈系插画', '治愈系水彩插画，一只橘猫趴在窗台晒太阳，暖色调，柔和光线', '1:1'],
  ['未来感角色设定', '未来机能风少女角色设定图，银白色外骨骼，冷色调，细节丰富', '2:3'],
  ['东方山水', '中国水墨山水长卷，云雾缭绕的群山，留白意境，淡雅', '16:9'],
  ['3D 等距小屋', '3D 等距视角的可爱小木屋，圆润建模，柔和光影，粉彩配色', '1:1'],
];
function renderRecipes() {
  const box = $('#recipes'); if (!box || box.dataset.ready) return; box.dataset.ready = 1;
  box.innerHTML = RECIPES.map(([t, p, r], i) => `<button class="recipe" data-i="${i}"><div class="th" style="background-image:url('${drawArt(p, 300, 200, i + 7, false)}')"></div><div class="tx"><b>${t}</b><small>${r} · 点击使用</small></div></button>`).join('');
  box.onclick = (e) => {
    const b = e.target.closest('.recipe'); if (!b) return; const [, p, r] = RECIPES[+b.dataset.i];
    promptEl.value = p; autogrow(); dockState.ratio = r; $('#selRatio').value = r; LS.set('huabu.dock', dockState); promptEl.focus();
  };
}

/* ============================== top bar ============================== */
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#zIn').onclick = () => zoomCenter(1.25); $('#zOut').onclick = () => zoomCenter(0.8);
$('#zVal').onclick = () => zoomCenter(1 / view.k); $('#zFit').onclick = () => fitTo(nodes);
$('#projName').addEventListener('change', (e) => { project.name = e.target.value.trim() || '未命名画布'; e.target.value = project.name; changed(); });
$('#projName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
function setTheme(t) { document.documentElement.dataset.theme = t; LS.set('huabu.theme', t); $('#btnTheme').innerHTML = icon(t === 'dark' ? 'sun' : 'moon'); drawMinimap(); }
$('#btnTheme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
$('#btnHelp').onclick = () => openHelp();
function setCredits() { $('#creditsNum').textContent = user.credits; }

$('#btnUser').setAttribute('data-menu', ''); $('#btnUser').onclick = (e) => {
  openMenu(e.currentTarget, `<div class="who"><b>${esc(user.name)}</b><span>${esc(user.email)}</span></div><div class="line"></div>
    <button class="it" data-k="credits">${icon('coin', 16)}算力与充值</button>
    <button class="it" data-k="settings">${icon('settings', 16)}设置与模型接入</button>
    <button class="it" data-k="export">${icon('file', 16)}导出项目 JSON</button>
    <button class="it" data-k="help">${icon('keyboard', 16)}快捷键</button><div class="line"></div>
    <button class="it d" data-k="logout">${icon('logout', 16)}退出登录</button>`,
    (k) => ({ credits: openRecharge, settings: openSettings, help: openHelp, logout: doLogout,
      export: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ name: project.name, view, nodes }, null, 1)], { type: 'application/json' })); a.download = project.name + '.huabu.json'; a.click(); } })[k]());
};
$('#btnCredits').onclick = () => openRecharge();
$('#btnProjects').onclick = () => openProjects();

/* ============================== modals ============================== */
function openHelp() {
  const rows = [['选择 / 抓手 / 便签', 'V / H / T'], ['临时抓手', '按住 空格'], ['缩放', '滚轮 / Ctrl+滚轮'], ['适应屏幕', '0'], ['100%', '1'], ['撤销 / 重做', 'Ctrl+Z / ⇧Z'], ['复制 / 粘贴', 'Ctrl+C / V'], ['创建副本', 'Ctrl+D'], ['全选', 'Ctrl+A'], ['删除', 'Delete'], ['微调位置', '方向键'], ['聚焦提示词', '/ 或 Enter'], ['上传图片', 'Ctrl+U'], ['双击画布', '新建便签']];
  openModal('快捷键', `<div class="keys">${rows.map(([a, b]) => `<div><span>${a}</span><kbd>${b}</kbd></div>`).join('')}</div>`);
}

async function openRecharge() {
  openModal('算力', `<div class="row" style="border:0;padding-top:0"><div><small>当前余额</small><b style="font-size:30px" id="rcBal">${user.credits}</b></div></div>
    ${auth.kind === 'local' ? `<div class="note-box">演示模式：充值为模拟到账，账户数据仅存于本机浏览器。正式收费请对接后端（见 docs/PLAN.md）。</div>` : ''}
    <div class="packs">${PACKS.map((p) => `<button class="pack" data-pack="${p.id}">${p.tag ? `<i>${p.tag}</i>` : ''}<b>${p.credits}</b><span>算力</span><div>¥${p.price}</div></button>`).join('')}</div>
    <div class="hd" style="color:var(--mute);font-size:12px;margin-bottom:4px">最近流水</div><ul class="ledger" id="ledger"><li>加载中…</li></ul>`, (body) => {
    const loadLedger = async () => {
      try { const l = (await auth.ledger()).slice(0, 30); $('#ledger', body).innerHTML = l.length ? l.map((x) => `<li><div>${esc(x.note)}<small>${new Date(x.ts).toLocaleString()}</small></div><span class="${x.delta > 0 ? 'pos' : 'neg'}">${x.delta > 0 ? '+' : ''}${x.delta}</span></li>`).join('') : '<li>暂无记录</li>'; } catch { $('#ledger', body).innerHTML = '<li>流水加载失败</li>'; }
    };
    loadLedger();
    body.querySelectorAll('[data-pack]').forEach((b) => (b.onclick = async () => {
      try { const r = await auth.checkout(b.dataset.pack); if (r.credits != null) { user.credits = r.credits; setCredits(); $('#rcBal', body).textContent = r.credits; toast('充值成功（演示）', 'ok'); loadLedger(); } }
      catch (e) { toast(e.message, 'err'); }
    }));
  });
}

function openSettings(tab = 'pref') {
  openModal('设置', `<div class="tabs"><button class="on" data-t="pref">偏好</button><button data-t="models">模型接入</button></div><div id="stBody"></div>`, (body) => {
    const host = $('#stBody', body);
    const pref = () => {
      host.innerHTML = `<div class="row" style="border:0"><div>滚轮行为<small>鼠标滚轮缩放，或像 Figma 一样平移（Ctrl+滚轮始终缩放）</small></div>
        <div class="field" style="margin:0"><select id="stWheel"><option value="zoom">缩放画布</option><option value="pan">平移画布</option></select></div></div>
        <div class="row"><div>外观<small>深色 / 浅色主题</small></div><button class="btn" id="stTheme">切换主题</button></div>`;
      $('#stWheel', host).value = LS.get('huabu.wheel', 'zoom'); $('#stWheel', host).onchange = (e) => LS.set('huabu.wheel', e.target.value);
      $('#stTheme', host).onclick = () => $('#btnTheme').click();
    };
    const models = () => {
      const l = customModels();
      host.innerHTML = `<div class="note-box">API Key 保存在本机浏览器，仅供个人调试。对外收费的线上版本，请把调用放到你的服务端代理，避免 Key 泄露与算力被绕过。</div>
        ${l.map((m, i) => `<div class="mcard"><div><b>${esc(m.name)}</b><small>${esc(m.baseUrl)} · ${esc(m.model)} · ${m.cost}/张</small></div><button class="icon-btn" data-del="${i}">${icon('trash', 16)}</button></div>`).join('') || '<p style="color:var(--mute);margin:0 0 12px">还没有自定义模型。支持任何 OpenAI 兼容的 /images/generations 接口。</p>'}
        <div class="grid2"><label class="field"><span>显示名称</span><input id="mName" placeholder="如 GPT-Image"></label><label class="field"><span>模型 ID</span><input id="mModel" placeholder="gpt-image-1"></label></div>
        <label class="field"><span>接口地址 (Base URL)</span><input id="mBase" placeholder="https://api.openai.com/v1"></label>
        <div class="grid2"><label class="field"><span>API Key</span><input id="mKey" type="password" placeholder="sk-…"></label><label class="field"><span>每张消耗算力</span><input id="mCost" type="number" min="1" value="5"></label></div>
        <button class="btn primary" id="mAdd">添加模型</button>`;
      host.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { l.splice(+b.dataset.del, 1); saveCustomModels(l); fillDockSelects(); updateDock(); models(); }));
      $('#mAdd', host).onclick = () => {
        const m = { id: 'c_' + uid(), name: $('#mName', host).value.trim(), model: $('#mModel', host).value.trim(), baseUrl: $('#mBase', host).value.trim(), apiKey: $('#mKey', host).value.trim(), cost: Math.max(1, +$('#mCost', host).value || 5) };
        if (!m.name || !m.model || !/^https?:\/\//.test(m.baseUrl) || !m.apiKey) return toast('请完整填写名称、模型 ID、http(s) 接口地址和 Key', 'err');
        l.push(m); saveCustomModels(l); fillDockSelects(); updateDock(); toast('已添加', 'ok'); models();
      };
    };
    if (auth.kind === 'remote') { $('[data-t=models]', body).remove(); tab = 'pref'; }
    body.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.t === tab)); tab === 'models' ? models() : pref();
    body.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { body.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); b.dataset.t === 'pref' ? pref() : models(); }));
  });
}

async function openProjects() {
  await save();
  const list = (await db.byUser(user.id)).sort((a, b) => b.updated - a.updated);
  openModal('我的项目', `<div class="proj-grid"><button class="proj new" data-new><div class="th">${icon('plus', 28)}</div><div class="nm">新建画布</div><small>从空白开始</small></button>
    ${list.map((p) => `<div class="proj" style="position:relative" data-open="${p.id}"><div class="th" style="${p.thumb ? `background-image:url('${p.thumb}')` : ''}">${p.thumb ? '' : icon('image', 26)}</div><div class="nm">${esc(p.name)}</div><small>${p.nodes?.length || 0} 个元素 · ${new Date(p.updated).toLocaleDateString()}</small>
    <button class="icon-btn" data-rm="${p.id}" title="删除" style="position:absolute;top:6px;right:6px;background:var(--panel-solid)">${icon('trash', 15)}</button></div>`).join('')}</div>`, (body, close) => {
    body.onclick = async (e) => {
      if (e.target.closest('[data-new]')) { close(); return newProject(); }
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        if (!confirm('删除这个项目？此操作不可恢复。')) return;
        const id = rm.dataset.rm; await db.remove(id); rm.closest('.proj').remove();
        if (id === project.id) { close(); const rest = (await db.byUser(user.id)).sort((a, b) => b.updated - a.updated); rest.length ? openProject(rest[0].id) : newProject(); }
        return;
      }
      const op = e.target.closest('[data-open]'); if (op) { close(); if (op.dataset.open !== project.id) openProject(op.dataset.open); }
    };
  });
}

/* ============================== auth flow ============================== */
let authMode = 'login';
function setAuthMode(m) {
  authMode = m; $('#authErr').textContent = '';
  document.querySelectorAll('#authTabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('.name-only').hidden = m !== 'register';
  $('#authTitle').textContent = m === 'login' ? '欢迎回来' : '创建账号';
  $('#authSub').textContent = m === 'login' ? '登录后继续你的创作' : '几秒钟即可开始';
  $('#authSubmit').textContent = m === 'login' ? '登录' : '注册并开始';
  $('#authFine').innerHTML = m === 'register' ? `新用户注册即送 <b>${SIGNUP_BONUS}</b> 算力` : '还没有账号？点击上方「注册」';
  $('#authForm').password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
}
document.querySelectorAll('#authTabs button').forEach((b) => (b.onclick = () => setAuthMode(b.dataset.mode)));
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target, btn = $('#authSubmit'); $('#authErr').textContent = ''; btn.disabled = true;
  try {
    const body = { email: f.email.value, password: f.password.value, name: f.name.value };
    user = await (authMode === 'login' ? auth.login(body) : auth.register(body)); f.reset(); await enterApp();
  } catch (err) { $('#authErr').textContent = err.message; } finally { btn.disabled = false; }
});
async function doLogout() {
  await save(); for (const c of jobs.values()) c.abort(); jobs.clear();
  await auth.logout(); user = null; project = null; nodes = [];
  nodeEls.forEach((el) => el.remove()); nodeEls.clear(); $('#app').hidden = true; $('#auth').hidden = false; setAuthMode('login');
}
async function enterApp() {
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#btnUser').textContent = (user.name || '?').slice(0, 1).toUpperCase(); setCredits();
  if (auth.kind === 'remote') { try { setRemoteModels(await auth.models()); } catch { toast('模型列表加载失败', 'err'); } }
  fillDockSelects(); updateDock(); renderRecipes(); setTool('select'); setTheme(document.documentElement.dataset.theme);
  const list = (await db.byUser(user.id)).sort((a, b) => b.updated - a.updated);
  const last = LS.get('huabu.last.' + user.id); const pick = list.find((p) => p.id === last) || list[0];
  pick ? await openProject(pick.id) : await newProject();
  if (!list.length) { setTimeout(() => $('#prompt').focus(), 100); }
}

/* ============================== boot ============================== */
hydrateIcons();
window.addEventListener('resize', () => { if (project) applyView(); });
(async () => {
  user = await auth.me(); setAuthMode('login');
  if (user) await enterApp(); else $('#auth').hidden = false;
})();
window.__huabu = { get nodes() { return nodes; }, get view() { return view; }, get user() { return user; } }; // debug hook
