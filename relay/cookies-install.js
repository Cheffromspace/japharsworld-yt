// Installs the throwaway account's cookies for the home relay worker (Everything-is-OK#575), on the Optiplex, as root:
//   sudo node /opt/japharsworld-yt-relay/relay/cookies-install.js ~/jyt-cookies.sqlite
// Reads a Firefox cookies.sqlite (copied from the owner's fresh, closed sign-in profile), keeps the YouTube and Google
// cookies, refuses a profile with no signed-in Google session, writes cookies.txt into the worker's state dir (mode 600,
// owned by jytrelay) and deletes the copy. Prints counts only, never a cookie. The worker picks the file up at its next
// poll; no restart. --out <path> and --owner <user> for other places; --keep leaves the copy (tests).
import { rm, chown } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readFirefox, signedIn, toNetscape, writeCookies } from './cookies.js';

export const DEFAULT_OUT = '/var/lib/japharsworld-yt-relay/cookies.txt';

export async function install(source, { out = DEFAULT_OUT, owner = 'jytrelay', keep = false, ids = (u) => idsOf(u) } = {}) {
  if (!existsSync(dirname(out))) {
    if (!keep) for (const f of [source, `${source}-wal`, `${source}-shm`]) await rm(f, { force: true }).catch(() => {});
    return { ok: false, message: `${dirname(out)} doesn't exist yet: the worker's unit creates it (StateDirectory) once the #575 update is on this host. Nothing installed; the copy was deleted.` };
  }
  try {
    let cookies;
    try { cookies = readFirefox(source); } catch (err) {
      return { ok: false, message: `Couldn't read ${source} as a Firefox cookies.sqlite (${String(err?.message ?? err).slice(0, 120)}). Was Firefox closed before the copy?` };
    }
    if (!signedIn(cookies)) return { ok: false, message: 'No signed-in Google session in that profile: nothing installed. Sign in at youtube.com first, then close Firefox and copy again.' };
    const { text, count } = toNetscape(cookies);
    await writeCookies(out, text);
    if (owner) { const { uid, gid } = ids(owner); await chown(out, uid, gid); }
    return { ok: true, count, message: `Installed ${count} cookies to ${out} (mode 600${owner ? `, owner ${owner}` : ''}).` };
  } finally {
    if (!keep) for (const f of [source, `${source}-wal`, `${source}-shm`]) await rm(f, { force: true }).catch(() => {});
  }
}

function idsOf(user) {
  const n = (flag) => Number(execFileSync('id', [flag, user], { encoding: 'utf8' }).trim());
  return { uid: n('-u'), gid: n('-g') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const out = opt('out') ?? DEFAULT_OUT;
  const owner = opt('owner') ?? 'jytrelay';
  const keep = args.includes('--keep');
  const source = args.find((a) => !a.startsWith('--'));
  if (!source) { console.error('usage: sudo node relay/cookies-install.js <cookies.sqlite> [--out PATH] [--owner USER] [--keep]'); process.exit(2); }
  const r = await install(source, { out, owner, keep });
  console.log(r.message + (r.ok && !keep ? ' Deleted the copy.' : ''));
  process.exit(r.ok ? 0 : 1);
}
