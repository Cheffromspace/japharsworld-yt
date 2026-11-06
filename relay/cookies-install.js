// Installs the throwaway account's cookies for the home relay worker (Everything-is-OK#575), on the Optiplex, run as the
// worker's own user (never root: the file is the worker's without a chown, and root never runs code from the
// jytrelay-owned checkout):
//   sudo -u jytrelay node /opt/japharsworld-yt-relay/relay/cookies-install.js - < jyt-cookies.sqlite; rm -f jyt-cookies.sqlite
// Reads a Firefox cookies.sqlite (copied from the owner's fresh, closed sign-in profile) from stdin, keeps the YouTube and
// Google cookies, refuses a profile with no signed-in YouTube session, and writes cookies.txt into the worker's state dir
// (mode 600; a new file also ends a "dead" mark). Prints counts only, never a cookie. The worker picks the file up at its
// next poll; no restart. Its own temporary copy of the input is deleted; the owner deletes theirs (the command above).
// A path instead of `-` reads that file (tests); --out <path> writes elsewhere.
import { rm, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readFirefox, signedIn, toNetscape, writeCookies } from './cookies.js';

export const DEFAULT_OUT = '/var/lib/japharsworld-yt-relay/cookies.txt';

export async function install(source, { out = DEFAULT_OUT } = {}) {
  if (!existsSync(dirname(out))) {
    return { ok: false, message: `${dirname(out)} doesn't exist (or this user can't see it): the worker's unit creates it (StateDirectory) once the #575 update is on this host. Nothing installed.` };
  }
  let cookies;
  try { cookies = readFirefox(source); } catch (err) {
    return { ok: false, message: `That isn't a readable Firefox cookies.sqlite (${String(err?.code ?? err?.message ?? 'error').slice(0, 60)}). Was Firefox closed before the copy? Nothing installed.` };
  }
  if (!signedIn(cookies)) return { ok: false, message: 'No signed-in YouTube session in that profile: nothing installed. Sign in at youtube.com first, then close Firefox and copy again.' };
  const { text, count } = toNetscape(cookies);
  await writeCookies(out, text);
  await rm(`${out}.dead`, { force: true }).catch(() => {});
  return { ok: true, count, message: `Installed ${count} cookies to ${out} (mode 600).` };
}

// stdin → a private temporary file (SQLite needs a file), read, then deleted whatever happens.
export async function installFromStream(stream, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jyt-ckin-'));
  try {
    const chunks = [];
    let size = 0;
    for await (const c of stream) { size += c.length; if (size > 64 << 20) return { ok: false, message: 'Input over 64 MB: not a cookies.sqlite. Nothing installed.' }; chunks.push(c); }
    const file = join(dir, 'cookies.sqlite');
    await writeFile(file, Buffer.concat(chunks), { mode: 0o600 });
    return await install(file, opts);
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = i >= 0 ? args.splice(i, 2)[1] : DEFAULT_OUT;
  const source = args.find((a) => a === '-' || !a.startsWith('--'));
  if (!source) { console.error('usage: sudo -u jytrelay node relay/cookies-install.js - < cookies.sqlite   [--out PATH]'); process.exit(2); }
  if (process.getuid?.() === 0) { console.error('Run this as the worker\'s user, not root: sudo -u jytrelay node … - < cookies.sqlite'); process.exit(2); }
  let r;
  try { r = source === '-' ? await installFromStream(process.stdin, { out }) : await install(source, { out }); }
  catch (err) { r = { ok: false, message: `Install failed (${String(err?.code ?? 'error')}); nothing installed.` }; }
  console.log(r.message);
  process.exit(r.ok ? 0 : 1);
}
