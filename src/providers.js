import { auth } from './auth.js';
// Model registry + image generation adapters.

export const RATIOS = {
  '1:1': [1024, 1024], '4:3': [1152, 864], '3:4': [864, 1152], '16:9': [1280, 720],
  '9:16': [720, 1280], '3:2': [1216, 810], '2:3': [810, 1216],
};

const BUILTIN = [
  { id: 'aurora', name: 'Aurora', desc: '演示模型 · 快速', type: 'mock', cost: 2, builtin: true },
  { id: 'prism', name: 'Prism HD', desc: '演示模型 · 高精', type: 'mock', cost: 4, builtin: true },
];

const KEY = 'huabu.models';
export const customModels = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
export const saveCustomModels = (l) => localStorage.setItem(KEY, JSON.stringify(l));
let remote = null; // server-side model list (keys never reach the browser)
export const setRemoteModels = (l) => { remote = l ? l.map((m) => ({ ...m, type: 'remote' })) : null; };
export const listModels = () => remote || [...BUILTIN, ...customModels().map((m) => ({ ...m, type: 'openai', desc: '自定义 API' }))];

/* ---------- deterministic art for the demo models ---------- */
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function drawArt(prompt, w, h, seed, hd) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); const R = rng(hash(prompt) ^ seed);
  const h0 = R() * 360, span = 40 + R() * 90;
  const col = (dh, s, l, a = 1) => `hsla(${(h0 + dh + 360) % 360},${s}%,${l}%,${a})`;
  const bg = g.createLinearGradient(0, 0, w * R(), h);
  bg.addColorStop(0, col(0, 55, 14)); bg.addColorStop(1, col(span, 60, 28));
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const m = Math.max(w, h);
  g.globalCompositeOperation = 'screen';
  const blobs = hd ? 11 : 8;
  for (let i = 0; i < blobs; i++) {
    const x = R() * w, y = R() * h, r = m * (0.18 + R() * 0.42);
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const dh = (R() - 0.3) * span * 2;
    rg.addColorStop(0, col(dh, 85, 58, 0.85)); rg.addColorStop(1, col(dh, 85, 40, 0));
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
  }
  g.globalCompositeOperation = 'source-over';
  g.lineWidth = Math.max(1, m / 700);
  for (let i = 0; i < (hd ? 7 : 4); i++) { // glass rings
    g.strokeStyle = `rgba(255,255,255,${0.07 + R() * 0.12})`;
    g.beginPath(); g.arc(R() * w, R() * h, m * (0.08 + R() * 0.3), 0, Math.PI * 2); g.stroke();
  }
  const orb = g.createRadialGradient(w * 0.6, h * 0.4, 0, w * 0.6, h * 0.4, m * 0.16);
  orb.addColorStop(0, 'rgba(255,255,255,.95)'); orb.addColorStop(0.35, col(20, 90, 75, 0.55)); orb.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = orb; g.beginPath(); g.arc(w * 0.6, h * 0.4, m * 0.16, 0, Math.PI * 2); g.fill();
  const vg = g.createRadialGradient(w / 2, h / 2, m * 0.25, w / 2, h / 2, m * 0.75); // vignette
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.45)');
  g.fillStyle = vg; g.fillRect(0, 0, w, h);
  const n = g.createImageData(64, 64); // grain
  for (let i = 0; i < n.data.length; i += 4) { const v = R() * 255; n.data[i] = n.data[i + 1] = n.data[i + 2] = v; n.data[i + 3] = 14; }
  const nc = document.createElement('canvas'); nc.width = nc.height = 64; nc.getContext('2d').putImageData(n, 0, 0);
  g.fillStyle = g.createPattern(nc, 'repeat'); g.fillRect(0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.88);
}

const sleep = (ms, sig) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  sig?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('已取消', 'AbortError')); });
});

async function toDataURL(blobOrUrl) {
  let blob = blobOrUrl;
  if (typeof blobOrUrl === 'string') {
    try { blob = await (await fetch(blobOrUrl)).blob(); } catch { return blobOrUrl; } // CORS: keep the remote URL
  }
  return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
}

const dataURLToBlob = async (u) => (await fetch(u)).blob();

async function openaiGenerate(model, { prompt, ratio, refs, signal, seed }) {
  const [w, h] = RATIOS[ratio] || RATIOS['1:1'];
  const base = (model.baseUrl || '').replace(/\/$/, '');
  if (!base || !model.apiKey) throw new Error('该模型缺少接口地址或 API Key，请在「设置 → 模型接入」中补全');
  const size = model.sizeMap?.[ratio] || `${w}x${h}`;
  const auth = { Authorization: `Bearer ${model.apiKey}` };
  let r;
  if (refs?.length && model.supportsEdit !== false) {
    const fd = new FormData();
    fd.set('model', model.model); fd.set('prompt', prompt); fd.set('n', '1'); fd.set('size', size);
    for (const u of refs.slice(0, 4)) fd.append(refs.length > 1 ? 'image[]' : 'image', await dataURLToBlob(u), 'ref.png');
    r = await fetch(`${base}/images/edits`, { method: 'POST', headers: auth, body: fd, signal });
  } else {
    r = await fetch(`${base}/images/generations`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ model: model.model, prompt, n: 1, size, seed }),
    });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.message || `接口返回 ${r.status}`);
  const d = j.data?.[0]; if (!d) throw new Error('接口未返回图片');
  return d.b64_json ? `data:image/png;base64,${d.b64_json}` : toDataURL(d.url);
}

/** Generate ONE image. Resolves to a data URL (or remote URL if CORS blocks inlining). */
export async function generateImage(model, opts) {
  if (model.type === 'remote') return (await auth.generate({ model: model.id, prompt: opts.prompt, ratio: opts.ratio, refs: opts.refs })).src;
  if (model.type === 'mock') {
    await sleep(1400 + Math.random() * 1600, opts.signal);
    const [w, h] = RATIOS[opts.ratio] || RATIOS['1:1'];
    const k = 1024 / Math.max(w, h);
    return drawArt(opts.prompt + (opts.refs?.length ? '|ref' + opts.refs.length : ''), Math.round(w * k), Math.round(h * k), opts.seed, model.id === 'prism');
  }
  return openaiGenerate(model, opts);
}
