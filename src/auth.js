// Account + credits adapters.
// LocalAdapter  : demo only, everything lives in this browser (NOT secure for real billing).
// RemoteAdapter : talks to your backend; enabled by window.HUABU_CONFIG.apiBase (see docs/PLAN.md §4).

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(s) {
  if (crypto.subtle) return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return String(h); // insecure-context fallback
}
const rid = () => Math.random().toString(36).slice(2, 10);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const SIGNUP_BONUS = 100;
export const PACKS = [
  { id: 'p100', credits: 100, price: 9.9, tag: '' },
  { id: 'p500', credits: 550, price: 45, tag: '送 50' },
  { id: 'p1000', credits: 1200, price: 88, tag: '最划算' },
];

class LocalAdapter {
  kind = 'local';
  users() { return LS.get('huabu.users', {}); }
  save(u) { const all = this.users(); all[u.email] = u; LS.set('huabu.users', all); }
  pub(u) { return { id: u.id, email: u.email, name: u.name, credits: u.credits }; }
  find(id) { return Object.values(this.users()).find((u) => u.id === id); }

  async register({ email, password, name }) {
    email = (email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error('请输入有效的邮箱');
    if ((password || '').length < 6) throw new Error('密码至少 6 位');
    if (this.users()[email]) throw new Error('该邮箱已注册，请直接登录');
    const salt = rid();
    const u = {
      id: 'u_' + rid(), email, name: (name || '').trim() || email.split('@')[0],
      salt, hash: await sha256(salt + password), credits: SIGNUP_BONUS,
      ledger: [{ ts: Date.now(), delta: SIGNUP_BONUS, note: '新用户注册赠送' }],
    };
    this.save(u); LS.set('huabu.session', u.id);
    return this.pub(u);
  }
  async login({ email, password }) {
    email = (email || '').trim().toLowerCase();
    const u = this.users()[email];
    if (!u || u.hash !== await sha256(u.salt + (password || ''))) throw new Error('邮箱或密码错误');
    LS.set('huabu.session', u.id);
    return this.pub(u);
  }
  async me() { const u = this.find(LS.get('huabu.session')); return u ? this.pub(u) : null; }
  async logout() { localStorage.removeItem('huabu.session'); }
  async ledger() { const u = this.find(LS.get('huabu.session')); return u ? [...u.ledger].reverse() : []; }
  async _move(delta, note) {
    const u = this.find(LS.get('huabu.session'));
    if (!u) throw new Error('请先登录');
    if (u.credits + delta < 0) { const e = new Error('算力不足，请先充值'); e.code = 'NO_CREDITS'; throw e; }
    u.credits += delta; u.ledger.push({ ts: Date.now(), delta, note });
    if (u.ledger.length > 300) u.ledger.splice(0, u.ledger.length - 300);
    this.save(u); return u.credits;
  }
  spend(amount, note) { return this._move(-amount, note); }
  refund(amount, note) { return this._move(amount, note); }
  async checkout(packId) { // demo: credit instantly. Real: return a payment URL.
    const p = PACKS.find((x) => x.id === packId);
    const credits = await this._move(p.credits, `演示充值 ${p.credits} 算力`);
    return { credits, demo: true };
  }
}

class RemoteAdapter {
  kind = 'remote';
  constructor(base) { this.base = base.replace(/\/$/, ''); }
  get token() { return localStorage.getItem('huabu.token'); }
  async req(path, body, method = body ? 'POST' : 'GET') {
    const r = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || j.error || `请求失败 (${r.status})`); if (r.status === 402) e.code = 'NO_CREDITS'; throw e; }
    return j;
  }
  async register(b) { const j = await this.req('/auth/register', b); localStorage.setItem('huabu.token', j.token); return j.user; }
  async login(b) { const j = await this.req('/auth/login', b); localStorage.setItem('huabu.token', j.token); return j.user; }
  async me() { if (!this.token) return null; try { return (await this.req('/me')).user; } catch { return null; } }
  async logout() { localStorage.removeItem('huabu.token'); }
  async ledger() { return (await this.req('/credits/ledger')).items; }
  async spend(amount, note) { return (await this.req('/credits/spend', { amount, note })).credits; }
  async refund(amount, note) { return (await this.req('/credits/refund', { amount, note })).credits; }
  async checkout(packId) { const j = await this.req('/billing/checkout', { packId }); if (j.url) location.href = j.url; return j; }
}

const cfg = window.HUABU_CONFIG || {};
export const auth = cfg.apiBase ? new RemoteAdapter(cfg.apiBase) : new LocalAdapter();
