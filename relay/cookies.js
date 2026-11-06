// The throwaway account's cookies on the home relay (Everything-is-OK#575). They are a secret: on the Optiplex only, in
// the worker's state dir, mode 600, never logged, never sent to the server (polls carry a state word only).
// How they get there (owner, 2026-11-06): the owner signs the throwaway account in on their PC (the same home IP) in a
// fresh Firefox profile, closes Firefox, copies the profile's cookies.sqlite over, and relay/cookies-install.js turns it
// into cookies.txt and deletes the copy. Firefox, because its cookie store is a plain SQLite file; Chrome's is encrypted.
// Use (owner, 2026-11-06): yt-dlp runs without them first; only a bot or PO-token refusal is retried once with
// --cookies. A retry that is bot-walled again marks them dead until a new file is installed.
import { open, rename, stat, chmod, chown, readFile, writeFile, rm, copyFile, mkdtemp } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { refusalClass } from '../src/refusal.js';

// Domains yt-dlp needs for YouTube; everything else the profile collected stays behind.
const KEEP = /(^|\.)(youtube\.com|google\.com)$/i;
const YOUTUBE = /(^|\.)youtube\.com$/i;
// A signed-in session carries these on youtube.com (yt-dlp sends youtube.com's cookies); a profile that never signed
// in to YouTube has none of them.
export const LOGIN_NAMES = ['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];
const keep = (c, nowS) => KEEP.test(String(c.domain ?? '').replace(/^\./, '')) && Boolean(c.name) && !(c.expires > 0 && c.expires < nowS);

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

export const signedIn = (cookies, nowS = Date.now() / 1000) => (cookies ?? []).some((c) => LOGIN_NAMES.includes(c.name) && keep(c, nowS)
  && YOUTUBE.test(String(c.domain).replace(/^\./, '')));

const clean = (s) => String(s ?? '').replace(/[\t\r\n]/g, '');
// → a Netscape cookies.txt, the format yt-dlp's --cookies reads. Expired cookies are left out.
export function toNetscape(cookies, nowS = Date.now() / 1000) {
  const lines = ['# Netscape HTTP Cookie File', '# The home relay\'s throwaway YouTube account (Everything-is-OK#575). Secret: do not share.', ''];
  let count = 0;
  for (const c of cookies ?? []) {
    if (!keep(c, nowS)) continue;
    const domain = clean(c.domain);
    lines.push([c.httpOnly ? `#HttpOnly_${domain}` : domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', clean(c.path) || '/', c.secure ? 'TRUE' : 'FALSE',
      String(c.expires > 0 ? Math.floor(c.expires) : 0), clean(c.name), clean(c.value)].join('\t'));
    count++;
  }
  return { text: lines.join('\n') + '\n', count };
}

// Atomic write, mode 600 from the start (the temporary file never exists with wider rights), owned by `ids` before it
// is renamed into place (so the worker never sees a file it can't read). A failed write leaves no temporary file.
export async function writeCookies(path, text, ids = null) {
  const tmp = join(dirname(path), `.cookies-${process.pid}-${Date.now()}.tmp`);
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
    await chmod(tmp, 0o600);
    if (ids) await chown(tmp, ids.uid, ids.gid);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// yt-dlp echoes a cookie line it can't parse ("skipping cookie file entry …: '<the line>'"), even with --no-warnings
// (verifier, 2026-11-06). Lines like that, or with a tab (the cookie file's separator), never leave this process.
export const scrub = (text) => String(text ?? '').split('\n').filter((l) => !/cookie file entry|\t/i.test(l)).join('\n');

// The worker's view: none (no file), ok, or dead. Dead is a marker file next to cookies.txt naming the installed file's
// mtime and size, so it survives worker restarts and ends when a new file is installed. yt-dlp gets a private copy
// for each run (it rewrites its cookie file when it exits), so the installed file only ever changes by an install.
export class CookieJar {
  constructor({ path = null, log = () => {}, tmp = tmpdir() } = {}) {
    this.path = path;
    this.log = log;
    this.tmp = tmp;
    this.marker = path ? `${path}.dead` : null;
  }

  async #id() {
    if (!this.path) return null;
    try { const s = await stat(this.path); return `${Math.round(s.mtimeMs)}:${s.size}`; } catch { return null; }
  }

  async state() {
    const id = await this.#id();
    if (id == null) return 'none';
    let dead = null;
    try { dead = (await readFile(this.marker, 'utf8')).trim(); } catch { /* none */ }
    return dead === id ? 'dead' : 'ok';
  }

  // The retry's outcome. Only a bot wall on the retry marks them dead: a PO-token wall isn't something fresh cookies fix.
  async retried(err) {
    if (!err) { this.log({ event: 'cookie_retry', ok: true }); return 'ok'; }
    const cls = refusalClass(err);
    this.log({ event: 'cookie_retry', ok: false, refusal: cls });
    if (cls !== 'bot') return 'other';
    const id = await this.#id();
    if (id) await writeFile(this.marker, id, { mode: 0o600 }).catch(() => {});
    this.log({ event: 'cookies_dead' });
    return 'dead';
  }

  // A yt-dlp runner (cmd, args, timeoutMs) → result that retries a bot/PO-token refusal once with a private copy of the
  // cookies. Whatever that retry prints is scrubbed of cookie lines before it goes anywhere.
  wrap(runner) {
    return async (cmd, args, timeoutMs) => {
      try { return await runner(cmd, args, timeoutMs); } catch (err) {
        const cls = refusalClass(err);
        if ((cls !== 'bot' && cls !== 'potoken') || (await this.state()) !== 'ok') throw err;
        const dir = await mkdtemp(join(this.tmp, 'jyt-ck-'));
        const copy = join(dir, 'cookies.txt');
        try {
          await copyFile(this.path, copy);
          await chmod(copy, 0o600);
          let r;
          try { r = await runner(cmd, ['--cookies', copy, ...args], timeoutMs); } catch (err2) {
            err2.message = scrub(err2.message);
            if (err2.stderr) err2.stderr = scrub(err2.stderr);
            await this.retried(err2);
            throw err2;
          }
          await this.retried(null);
          if (r && typeof r === 'object' && Array.isArray(r.warnings)) r.warnings = r.warnings.filter((w) => scrub(w) === w);
          return r;
        } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
      }
    };
  }
}
