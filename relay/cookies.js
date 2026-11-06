// The throwaway account's cookies on the home relay (Everything-is-OK#575). They are a secret: on the Optiplex only, in
// the worker's state dir, mode 600, never logged, never sent to the server (polls carry a state word only).
// How they get there (owner, 2026-11-06): the owner signs the throwaway account in on their PC (the same home IP) in a
// fresh Firefox profile, closes Firefox, copies the profile's cookies.sqlite over, and relay/cookies-install.js turns it
// into cookies.txt and deletes the copy. Firefox, because its cookie store is a plain SQLite file; Chrome's is encrypted.
// Use (owner, 2026-11-06): yt-dlp runs without them first; only a bot or PO-token refusal is retried once with
// --cookies. A retry that is bot-walled again marks them dead until a new file is installed.
import { open, rename, stat, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
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

// Atomic write, mode 600 from the start (the temporary file never exists with wider rights). relay/cookies-install.js
// runs as the worker's own user, so the file is the worker's without a chown. A failed write leaves no temporary file.
export async function writeCookies(path, text) {
  const tmp = join(dirname(path), `.cookies-${process.pid}-${Date.now()}.tmp`);
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try { await fh.writeFile(text); await fh.chmod(0o600); await fh.sync(); } finally { await fh.close(); }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// What yt-dlp prints about a cookie file can quote a line of it: "skipping cookie file entry …: '<line>'" (even with
// --no-warnings) and "invalid Netscape format cookies file …: '<line>'" with a LoadError traceback line, the tabs shown
// as \t (verifiers, 2026-11-06, yt-dlp 2026.08.19). Such lines are dropped, and the file's own values (`secrets`) are
// masked wherever else they turn up, so nothing that leaves the worker carries a cookie.
const COOKIE_LINE = /cookie file entry|cookies file|LoadError|\t|\t/i;
export function scrub(text, secrets = []) {
  let out = String(text ?? '').split('\n').filter((l) => !COOKIE_LINE.test(l)).join('\n');
  for (const v of secrets) out = out.split(v).join('…');
  return out;
}
// The values in a cookies.txt worth masking (short ones like "1" would mask ordinary text and say nothing).
export const secretsOf = (text) => [...new Set(String(text).split('\n').filter((l) => l && !l.startsWith('# ') && l !== '# Netscape HTTP Cookie File')
  .map((l) => l.split('\t')[6] ?? '').filter((v) => v.length >= 6))];

// The worker's view: none (no file), ok, or dead. Dead is a marker file next to cookies.txt naming the installed file's
// mtime and size, so it survives worker restarts and ends when a new file is installed (kept in memory too, in case the
// marker can't be written). yt-dlp gets a private copy for each run (it rewrites its cookie file when it exits), so the
// installed file only ever changes by an install.
export class CookieJar {
  constructor({ path = null, log = () => {}, tmp = tmpdir() } = {}) {
    this.path = path;
    this.log = log;
    this.tmp = tmp;
    this.marker = path ? `${path}.dead` : null;
    this.deadId = null;
  }

  async #id() {
    if (!this.path) return null;
    try { const s = await stat(this.path); return `${Math.round(s.mtimeMs)}:${s.size}`; } catch { return null; }
  }

  async state() {
    const id = await this.#id();
    if (id == null) return 'none';
    if (id === this.deadId) return 'dead';
    let dead = null;
    try { dead = (await readFile(this.marker, 'utf8')).trim(); } catch { /* none */ }
    return dead === id ? 'dead' : 'ok';
  }

  // The retry's outcome, for the file `usedId` (the installed file the retry's copy came from). Only a bot wall marks it
  // dead (a PO-token wall isn't something fresh cookies fix), and only if that file is still the installed one: a file
  // installed while the retry ran is never marked by it.
  async retried(err, usedId = null) {
    if (!err) { this.log({ event: 'cookie_retry', ok: true }); return 'ok'; }
    const cls = refusalClass(err);
    this.log({ event: 'cookie_retry', ok: false, refusal: cls });
    if (cls !== 'bot') return 'other';
    if (!usedId || (await this.#id()) !== usedId) return 'replaced';
    this.deadId = usedId;
    try { await writeFile(this.marker, usedId, { mode: 0o600 }); } catch { this.log({ event: 'cookies_dead_unmarked' }); }
    this.log({ event: 'cookies_dead' });
    return 'dead';
  }

  // A yt-dlp runner (cmd, args, timeoutMs) → result that retries a bot/PO-token refusal once with a private copy of the
  // cookies. Whatever that retry prints is scrubbed before it goes anywhere. If the copy can't be made, the original
  // refusal stands (so the worker still backs off and the server still counts it).
  wrap(runner) {
    return async (cmd, args, timeoutMs) => {
      try { return await runner(cmd, args, timeoutMs); } catch (err) {
        const cls = refusalClass(err);
        if ((cls !== 'bot' && cls !== 'potoken') || (await this.state()) !== 'ok') throw err;
        let dir, copy, usedId, secrets;
        try {
          usedId = await this.#id();
          const text = await readFile(this.path, 'utf8');
          secrets = secretsOf(text);
          dir = await mkdtemp(join(this.tmp, 'jyt-ck-'));
          copy = join(dir, 'cookies.txt');
          await writeFile(copy, text, { mode: 0o600, flag: 'wx' });
        } catch {
          if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
          this.log({ event: 'cookie_retry', ok: false, refusal: 'no_copy' });
          throw err;
        }
        try {
          let r;
          try { r = await runner(cmd, ['--cookies', copy, ...args], timeoutMs); } catch (err2) {
            err2.message = scrub(err2.message, secrets);
            if (err2.stderr) err2.stderr = scrub(err2.stderr, secrets);
            await this.retried(err2, usedId);
            throw err2;
          }
          await this.retried(null);
          if (r && typeof r === 'object' && Array.isArray(r.warnings)) r.warnings = r.warnings.map((w) => scrub(w, secrets)).filter(Boolean);
          else if (typeof r === 'string') r = scrub(r, secrets);
          return r;
        } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
      }
    };
  }
}
