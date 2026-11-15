// Huabu server: static hosting + accounts + credits + generation proxy + payment webhook.
// Zero dependencies (Node >= 22.5, uses built-in node:sqlite).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const PORT = +env.PORT || 8000;
const DB_PATH = env.DB_PATH || path.join(ROOT, 'server', 'data.db');
const SIGNUP_BONUS = +env.SIGNUP_BONUS || 100;
const DEMO_TOPUP = env.ALLOW_DEMO_TOPUP === '1';       // instant fake top-up, dev only
const PAY_URL_TEMPLATE = env.PAY_URL_TEMPLATE || '';   // e.g. https://pay.example.com/checkout?order={orderId}&amount={price}
const WEBHOOK_SECRET = env.PAY_WEBHOOK_SECRET || '';   // HMAC-SHA256 hex of raw body, header x-signature
const MODELS = JSON.parse(fs.readFileSync(env.MODELS_FILE || path.join(ROOT, 'server', 'models.json'), 'utf8'));
const PACKS = { p100: { credits: 100, price: 9.9 }, p500: { credits: 550, price: 45 }, p1000: { credits: 1200, price: 88 } };
const RATIOS = { '1:1': [1024, 1024], '4:3': [1152, 864], '3:4': [864, 1152], '16:9': [1280, 720], '9:16': [720, 1280], '3:2': [1216, 810], '2:3': [810, 1216] };

const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, salt TEXT, hash TEXT, credits INTEGER NOT NULL DEFAULT 0 CHECK(credits>=0), created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, ts INTEGER, delta INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pack_id TEXT, credits INTEGER, price REAL, status TEXT, created INTEGER);`);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const pub = (u) => ({ id: u.id, email: u.email, name: u.name, credits: u.credits });
const q = (sql, ...a) => db.prepare(sql).get(...a);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
function move(userId, delta, note) {
  return tx(() => {
    const r = db.prepare('UPDATE users SET credits=credits+? WHERE id=? AND credits+?>=0').run(delta, userId, delta);
    if (r.changes !== 1) throw new HttpError(402, '算力不足，请先充值');
    db.prepare('INSERT INTO ledger(user_id,ts,delta,note) VALUES(?,?,?,?)').run(userId, Date.now(), delta, note);
    return q('SELECT credits FROM users WHERE id=?', userId).credits;
  });
}

/* ---------- tiny login throttle (per ip+email) ---------- */
const fails = new Map();
function throttle(key) { const f = fails.get(key); if (f && f.n >= 8 && Date.now() - f.t < 10 * 60e3) throw new HttpError(429, '尝试次数过多，请 10 分钟后再试'); }
function fail(key) { const f = fails.get(key); fails.set(key, { n: (f && Date.now() - f.t < 10 * 60e3 ? f.n : 0) + 1, t: Date.now() }); }

/* ---------- generation ---------- */
function mockArt(prompt, w, h) {
  let s = 2166136261; for (const c of prompt) s = Math.imul(s ^ c.charCodeAt(0), 16777619); s >>>= 0;
  const r = () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) >>> 0) / 4294967296);
  const h0 = r() * 360; const b = [];
  for (let i = 0; i < 8; i++) b.push(`<circle cx="${r() * w | 0}" cy="${r() * h | 0}" r="${(0.15 + r() * 0.4) * Math.max(w, h) | 0}" fill="url(#g${i})"/>`);
  const defs = Array.from({ length: 8 }, (_, i) => { const hh = (h0 + (r() - 0.3) * 120 + 360) % 360; return `<radialGradient id="g${i}"><stop offset="0" stop-color="hsl(${hh},85%,58%)" stop-opacity=".85"/><stop offset="1" stop-color="hsl(${hh},85%,40%)" stop-opacity="0"/></radialGradient>`; }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h0},55%,14%)"/><stop offset="1" stop-color="hsl(${(h0 + 70) % 360},60%,28%)"/></linearGradient>${defs}</defs><rect width="100%" height="100%" fill="url(#bg)"/><g style="mix-blend-mode:screen">${b.join('')}</g></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
async function upstream(model, { prompt, ratio, refs }) {
  const [w, h] = RATIOS[ratio];
  if (model.type === 'mock') { await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1200)); return mockArt(prompt + refs.length + rid(4), w, h); }
  const key = env[model.apiKeyEnv || '']; if (!key) throw new Error('服务端未配置该模型的 Key');
  const base = model.baseUrl.replace(/\/$/, ''), size = model.sizeMap?.[ratio] || `${w}x${h}`, auth = { Authorization: `Bearer ${key}` };
  const ctl = AbortSignal.timeout(180000); let r;
  if (refs.length && model.supportsEdit !== false) {
    const fd = new FormData(); fd.set('model', model.model); fd.set('prompt', prompt); fd.set('n', '1'); fd.set('size', size);
    for (const u of refs) { const m = /^data:([^;]+);base64,(.*)$/.exec(u); if (m) fd.append(refs.length > 1 ? 'image[]' : 'image', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'ref.png'); }
    r = await fetch(`${base}/images/edits`, { method: 'POST', headers: auth, body: fd, signal: ctl });
  } else r = await fetch(`${base}/images/generations`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.model, prompt, n: 1, size }), signal: ctl });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `上游返回 ${r.status}`);
  const d = j.data?.[0]; if (!d) throw new Error('上游未返回图片');
  if (d.b64_json) return `data:image/png;base64,${d.b64_json}`;
  const img = await fetch(d.url); return `data:${img.headers.get('content-type') || 'image/png'};base64,${Buffer.from(await img.arrayBuffer()).toString('base64')}`;
}

/* ---------- routes ---------- */
const routes = {
  'POST /auth/register': async ({ body, ip }) => {
    const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, '请输入有效的邮箱');
    if (pw.length < 6 || pw.length > 200) throw new HttpError(400, '密码至少 6 位');
    if (q('SELECT 1 x FROM users WHERE email=?', email)) throw new HttpError(409, '该邮箱已注册，请直接登录');
    const id = 'u_' + rid(6), salt = rid(8), name = String(body.name || '').trim().slice(0, 30) || email.split('@')[0];
    tx(() => { db.prepare('INSERT INTO users(id,email,name,salt,hash,credits,created) VALUES(?,?,?,?,?,?,?)').run(id, email, name, salt, hashPw(pw, salt), SIGNUP_BONUS, Date.now());
      db.prepare('INSERT INTO ledger(user_id,ts,delta,note) VALUES(?,?,?,?)').run(id, Date.now(), SIGNUP_BONUS, '新用户注册赠送'); });
    return session(id);
  },
  'POST /auth/login': async ({ body, ip }) => {
    const email = String(body.email || '').trim().toLowerCase(), key = ip + '|' + email; throttle(key);
    const u = q('SELECT * FROM users WHERE email=?', email);
    const ok = u && crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(hashPw(String(body.password || ''), u.salt), 'hex'));
    if (!ok) { fail(key); throw new HttpError(401, '邮箱或密码错误'); }
    fails.delete(key); return session(u.id);
  },
  'GET /me': async ({ user }) => ({ user: pub(user) }),
  'GET /models': async () => ({ models: MODELS.map(({ id, name, desc, cost }) => ({ id, name, desc, cost })) }),
  'GET /credits/ledger': async ({ user }) => ({ items: db.prepare('SELECT ts,delta,note FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100').all(user.id) }),
  'POST /billing/checkout': async ({ user, body }) => {
    const p = PACKS[body.packId]; if (!p) throw new HttpError(400, '套餐不存在');
    const orderId = 'o_' + rid(8);
    db.prepare('INSERT INTO orders(id,user_id,pack_id,credits,price,status,created) VALUES(?,?,?,?,?,?,?)').run(orderId, user.id, body.packId, p.credits, p.price, 'pending', Date.now());
    if (PAY_URL_TEMPLATE) return { orderId, url: PAY_URL_TEMPLATE.replace('{orderId}', orderId).replace('{price}', p.price) };
    if (DEMO_TOPUP) return { orderId, credits: settle(orderId, '演示充值') };
    throw new HttpError(501, '支付通道尚未配置（需设置 PAY_URL_TEMPLATE 与 PAY_WEBHOOK_SECRET）');
  },
  'POST /generate': async ({ user, body }) => {
    const model = MODELS.find((m) => m.id === body.model); if (!model) throw new HttpError(400, '模型不存在');
    const prompt = String(body.prompt || '').trim(); if (!prompt || prompt.length > 2000) throw new HttpError(400, '提示词为空或过长');
    if (!RATIOS[body.ratio]) throw new HttpError(400, '比例不支持');
    const refs = (Array.isArray(body.refs) ? body.refs : []).filter((x) => typeof x === 'string' && x.startsWith('data:image/')).slice(0, 4);
    move(user.id, -model.cost, `生成 1 张 · ${model.name}`);
    try { const src = await upstream(model, { prompt, ratio: body.ratio, refs }); return { src, credits: q('SELECT credits FROM users WHERE id=?', user.id).credits }; }
    catch (e) { move(user.id, model.cost, `生成失败退还 · ${model.name}`); throw new HttpError(502, '生成失败：' + e.message); }
  },
};

function session(userId) {
  const token = rid(24); db.prepare('INSERT INTO sessions(th,user_id,created) VALUES(?,?,?)').run(sha(token), userId, Date.now());
  return { token, user: pub(q('SELECT * FROM users WHERE id=?', userId)) };
}
function settle(orderId, note) { // idempotent: only a pending order can credit
  return tx(() => {
    const o = q('SELECT * FROM orders WHERE id=?', orderId); if (!o) throw new HttpError(404, '订单不存在');
    if (o.status === 'paid') return q('SELECT credits FROM users WHERE id=?', o.user_id).credits;
    db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(orderId);
    db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(o.credits, o.user_id);
    db.prepare('INSERT INTO ledger(user_id,ts,delta,note) VALUES(?,?,?,?)').run(o.user_id, Date.now(), o.credits, `${note} ${o.credits} 算力 (${orderId})`);
    return q('SELECT credits FROM users WHERE id=?', o.user_id).credits;
  });
}

/* ---------- http plumbing ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const readBody = (req, limit) => new Promise((res, rej) => {
  const c = []; let n = 0;
  req.on('data', (d) => { n += d.length; if (n > limit) { rej(new HttpError(413, '请求过大')); req.destroy(); } else c.push(d); });
  req.on('end', () => res(Buffer.concat(c))); req.on('error', rej);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const ip = req.socket.remoteAddress;
  const send = (status, obj, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
  try {
    if (url.pathname === '/api/billing/webhook' && req.method === 'POST') {
      const raw = await readBody(req, 1e6);
      const sig = crypto.createHmac('sha256', WEBHOOK_SECRET || rid()).update(raw).digest('hex');
      const given = String(req.headers['x-signature'] || '');
      if (!WEBHOOK_SECRET || given.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(sig))) throw new HttpError(401, '签名无效');
      const j = JSON.parse(raw.toString()); if (j.status !== 'paid') return send(200, { ok: true });
      return send(200, { ok: true, credits: settle(String(j.orderId), '在线充值') });
    }
    if (url.pathname.startsWith('/api/')) {
      const key = `${req.method} ${url.pathname.slice(4)}`, h = routes[key];
      if (!h) throw new HttpError(404, '接口不存在');
      let user = null;
      if (!['POST /auth/register', 'POST /auth/login', 'GET /models'].includes(key) || key === 'GET /models') {
        const t = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (t) user = q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.th=?', sha(t));
        if (!user && key !== 'GET /models') throw new HttpError(401, '请先登录');
      }
      const body = req.method === 'POST' ? JSON.parse((await readBody(req, 16e6)).toString() || '{}') : {};
      return send(200, await h({ body, user, ip }));
    }
    if (url.pathname === '/config.js') return send(200, 'window.HUABU_CONFIG={apiBase:"/api"};', MIME['.js']);
    let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
    if (!(rel === '/index.html' || rel.startsWith('/src/'))) throw new HttpError(404, 'Not found');
    const file = path.join(ROOT, rel); if (!file.startsWith(path.join(ROOT) + path.sep)) throw new HttpError(404, 'Not found');
    const data = fs.readFileSync(file); res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data);
  } catch (e) {
    if (e instanceof SyntaxError) return send(400, { message: '请求格式错误' });
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return send(404, { message: 'Not found' });
    if (!(e instanceof HttpError)) console.error(e);
    send(e.status || 500, { message: e.status ? e.message : '服务器错误' });
  }
});
server.listen(PORT, () => console.log(`Huabu server on http://localhost:${PORT}  (demo top-up: ${DEMO_TOPUP ? 'ON' : 'off'})`));
