// VRChat API (unofficial; https://vrchat.community, Creator Guidelines "API usage"):
// a descriptive User-Agent with contact, few requests, back off on 429, cookie session with TOTP 2FA,
// one re-login when the cookie stops working. Only counts are kept; instance IDs are read in memory and dropped.
import { createHmac } from 'node:crypto';

export class VRChatError extends Error {
  constructor(status, code, message, retryAfter = null) { super(message || code); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret.
export function totp(secret, now = Date.now(), step = 30, digits = 6) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('TOTP secret is not base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => Number.parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / step)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).toString();
  return code.padStart(digits, '0');
}

// Instance ID → access type, from its tags (the ID itself is never stored).
//   wrld_x:12345                         public
//   ~hidden(usr_…)                       friends+   ~friends(usr_…)   friends
//   ~private(usr_…)[~canRequestInvite]   invite(+)  ~group(grp_…)     group
export function instanceType(id) {
  const s = String(id ?? '');
  if (s.includes('~group(')) return 'group';
  if (s.includes('~private(')) return 'invite';
  if (s.includes('~friends(') || s.includes('~hidden(')) return 'friends';
  return 'public';
}

// World object → numbers worth keeping.
export function worldValues(w) {
  const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);
  const v = {
    visits: num(w.visits), favorites: num(w.favorites), occupants: num(w.occupants),
    publicOccupants: num(w.publicOccupants), privateOccupants: num(w.privateOccupants),
    popularity: num(w.popularity), heat: num(w.heat), capacity: num(w.capacity), version: num(w.version),
    updatedAt: w.updated_at ? Math.round(Date.parse(w.updated_at) / 1000) || null : null,
  };
  // `instances` lists the world's public-listed instances as [id, occupants]: summed per access type.
  if (Array.isArray(w.instances)) {
    const by = { public: 0, friends: 0, invite: 0, group: 0 };
    for (const inst of w.instances) {
      const [id, n] = Array.isArray(inst) ? inst : [inst?.id, inst?.occupants ?? inst?.n_users];
      by[instanceType(id)] += Number(n) || 0;
    }
    v.instances = w.instances.length;
    for (const [k, n] of Object.entries(by)) v[`occupants_${k}`] = n;
  }
  return v;
}

export function groupValues(g) {
  const num = (x) => (Number.isFinite(Number(x)) && x !== null ? Number(x) : null);
  return { members: num(g.memberCount), online: num(g.onlineMemberCount) };
}

// Cookies from Set-Cookie headers → { name: value }.
export function readCookies(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get?.('set-cookie')].filter(Boolean);
  const out = {};
  for (const c of list) {
    const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export class VRChat {
  constructor({ username = '', password = '', totpSecret = '', authCookie = '', twoFactorCookie = '', userAgent,
    base = 'https://api.vrchat.cloud/api/1', fetcher = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 2000 }) {
    if (!userAgent) throw new Error('VRChat needs a User-Agent with contact info');
    Object.assign(this, { username, password, totpSecret, base: base.replace(/\/$/, ''), fetch: fetcher, now, sleep, gapMs, userAgent });
    this.cookies = { auth: authCookie, twoFactorAuth: twoFactorCookie };
    this.changed = false; // cookies changed (re-login): the caller saves them
    this.requests = 0;
  }

  get canLogin() { return Boolean(this.username && this.password && this.totpSecret); }

  cookieHeader() {
    return Object.entries(this.cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(path, { method = 'GET', headers = {}, body } = {}) {
    if (this.requests++) await this.sleep(this.gapMs); // gently: one request at a time, spaced
    let res;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method, body,
        headers: { 'user-agent': this.userAgent, accept: 'application/json', ...(this.cookieHeader() ? { cookie: this.cookieHeader() } : {}), ...headers },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new VRChatError(0, 'network', String(err?.message ?? err));
    }
    Object.assign(this.cookies, Object.fromEntries(Object.entries(readCookies(res.headers)).filter(([k]) => k === 'auth' || k === 'twoFactorAuth')));
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (res.status === 429) {
      const retry = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      throw new VRChatError(429, 'rate_limited', `429, retry after ${Number.isFinite(retry) ? retry : '?'} s`, retry);
    }
    if (!res.ok) throw new VRChatError(res.status, res.status === 401 ? 'unauthorized' : 'http', json?.error?.message ?? `HTTP ${res.status}`);
    return json;
  }

  // Basic auth → (TOTP) → a fresh pair of cookies. Throws VRChatError('login_failed') with VRChat's reason.
  async login() {
    if (!this.canLogin) throw new VRChatError(0, 'no_credentials', 'VRCHAT_USERNAME / VRCHAT_PASSWORD / VRCHAT_TOTP_SECRET are not set');
    this.cookies = { auth: '', twoFactorAuth: '' };
    const basic = Buffer.from(`${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}`).toString('base64');
    let me;
    try { me = await this.request('/auth/user', { headers: { authorization: `Basic ${basic}` } }); } catch (err) {
      throw new VRChatError(err.status, err.status === 429 ? 'rate_limited' : 'login_failed', `login: ${err.message}`);
    }
    const needs = me?.requiresTwoFactorAuth ?? [];
    if (needs.length) {
      if (!needs.includes('totp')) throw new VRChatError(0, 'login_failed', `login: 2FA type ${needs.join('/')} is not TOTP`);
      try {
        const v = await this.request('/auth/twofactorauth/totp/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: totp(this.totpSecret, this.now()) }) });
        if (!v?.verified) throw new VRChatError(0, 'login_failed', 'TOTP code not accepted');
      } catch (err) {
        throw new VRChatError(err.status, err.status === 429 ? 'rate_limited' : 'login_failed', `2FA: ${err.message}`);
      }
    }
    if (!this.cookies.auth) throw new VRChatError(0, 'login_failed', 'login: no auth cookie in the answer');
    this.changed = true;
    return true;
  }

  // GET with the stored session; one re-login (if allowed) when it is no longer accepted.
  async get(path, { allowLogin = true } = {}) {
    if (!this.cookies.auth) {
      if (!allowLogin) throw new VRChatError(401, 'unauthorized', 'no session');
      await this.login();
      return this.request(path);
    }
    try { return await this.request(path); } catch (err) {
      if (err.status !== 401 || !allowLogin) throw err;
      await this.login();
      return this.request(path);
    }
  }

  world(id, opts) { return this.get(`/worlds/${encodeURIComponent(id)}`, opts); }
  group(id, opts) { return this.get(`/groups/${encodeURIComponent(id)}`, opts); }
}
