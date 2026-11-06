// The throwaway account's cookies on the home relay (Everything-is-OK#575). They are a secret: on the Optiplex only, in
// the worker's state dir, mode 600, never logged, never sent to the server (polls carry a state word only).
// How they get there (owner, 2026-11-06): the owner signs the throwaway account in on their PC (the same home IP) in a
// fresh Firefox profile, closes Firefox, copies the profile's cookies.sqlite over, and relay/cookies-install.js turns it
// into cookies.txt and deletes the copy. Firefox, because its cookie store is a plain SQLite file; Chrome's is encrypted.
// Use (owner, 2026-11-06): yt-dlp runs without them first; only a bot or PO-token refusal is retried once with
// --cookies. A retry that is still refused marks them dead until a new file is installed.
import { open, rename, stat, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { refusalClass } from '../src/refusal.js';

// Domains yt-dlp needs for YouTube; everything else the profile collected stays behind.
const KEEP = /(^|\.)(youtube\.com|google\.com)$/i;
// A signed-in Google session carries these; a profile that never signed in has none of them.
export const LOGIN_NAMES = ['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];
const keep = (c) => KEEP.test(String(c.domain ?? '').replace(/^\./, '')) && Boolean(c.name);

// Firefox's cookies.sqlite (moz_cookies) → [{ domain, name, value, path, secure, httpOnly, expires (s) }]. Container and
// partitioned cookies (originAttributes set) are left out: yt-dlp wouldn't send them either. Newer Firefox stores the
// expiry in milliseconds, older in seconds.
export function readFirefox(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT host, name, value, path, expiry, isSecure, isHttpOnly FROM moz_cookies WHERE originAttributes = ''").all()
      .map((r) => ({ domain: String(r.host), name: String(r.name), value: String(r.value), path: String(r.path || '/'), secure: Boolean(r.isSecure),
        httpOnly: Boolean(r.isHttpOnly), expires: Number(r.expiry) > 1e11 ? Math.floor(Number(r.expiry) / 1000) : Number(r.expiry) || 0 }));
  } finally { db.close(); }
}

export const signedIn = (cookies) => (cookies ?? []).some((c) => LOGIN_NAMES.includes(c.name) && keep(c));

const clean = (s) => String(s ?? '').replace(/[\t\r\n]/g, '');
// → a Netscape cookies.txt, the format yt-dlp's --cookies reads.
export function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# The home relay\'s throwaway YouTube account (Everything-is-OK#575). Secret: do not share.', ''];
  let count = 0;
  for (const c of cookies ?? []) {
    if (!keep(c)) continue;
    const domain = clean(c.domain);
    lines.push([c.httpOnly ? `#HttpOnly_${domain}` : domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', clean(c.path) || '/', c.secure ? 'TRUE' : 'FALSE',
      String(c.expires > 0 ? Math.floor(c.expires) : 0), clean(c.name), clean(c.value)].join('\t'));
    count++;
  }
  return { text: lines.join('\n') + '\n', count };
}

// Atomic write, mode 600 from the start (the temporary file never exists with wider rights).
export async function writeCookies(path, text) {
  const tmp = join(dirname(path), `.cookies-${process.pid}-${Date.now()}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

// The worker's view: none (no file), ok, or dead (a cookie retry was refused since the file was last written).
export class CookieJar {
  constructor({ path = null, log = () => {} } = {}) {
    this.path = path;
    this.log = log;
    this.deadAt = null; // mtime of the file that was found dead
  }

  async #mtime() {
    if (!this.path) return null;
    try { return (await stat(this.path)).mtimeMs; } catch { return null; }
  }

  async state() {
    const m = await this.#mtime();
    if (m == null) return 'none';
    return this.deadAt != null && this.deadAt === m ? 'dead' : 'ok';
  }

  // ['--cookies', path] when this refusal is worth one retry with the cookies, else null.
  async retryArgs(err) {
    const cls = refusalClass(err);
    if (cls !== 'bot' && cls !== 'potoken') return null;
    return (await this.state()) === 'ok' ? ['--cookies', this.path] : null;
  }

  // The retry's outcome; a refusal of the same kind marks this file dead.
  async retried(err) {
    if (!err) { this.log({ event: 'cookie_retry', ok: true }); return 'ok'; }
    const cls = refusalClass(err);
    this.log({ event: 'cookie_retry', ok: false, refusal: cls });
    if (cls !== 'bot' && cls !== 'potoken') return 'other';
    // yt-dlp writes the cookies back after a run, so the file's time is read after the failure.
    this.deadAt = await this.#mtime();
    this.log({ event: 'cookies_dead' });
    return 'dead';
  }

  // A yt-dlp runner (cmd, args, timeoutMs) → result that retries a bot/PO-token refusal once with the cookies.
  wrap(runner) {
    return async (cmd, args, timeoutMs) => {
      try { return await runner(cmd, args, timeoutMs); } catch (err) {
        const extra = await this.retryArgs(err);
        if (!extra) throw err;
        try {
          const r = await runner(cmd, [...extra, ...args], timeoutMs);
          await this.retried(null);
          return r;
        } catch (err2) { await this.retried(err2); throw err2; }
      }
    };
  }
}
