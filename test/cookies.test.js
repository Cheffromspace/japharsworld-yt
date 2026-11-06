// Everything-is-OK#575: the home relay's throwaway-account cookies (relay/cookies.js, relay/cookies-install.js,
// src/cookiewatch.js). All cookie values here are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, stat, rm, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar, readFirefox, toNetscape, signedIn } from '../relay/cookies.js';
import { install } from '../relay/cookies-install.js';
import { CookieWatch } from '../src/cookiewatch.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { createWorker } from '../relay/worker.js';
import { config as base } from '../src/config.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtemp(join(tmpdir(), 'jyt-ck-'));

// A Firefox cookies.sqlite with the columns Firefox has (moz_cookies, 2026).
function firefoxDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT,
    expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0,
    sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0, isPartitionedAttributeSet INTEGER DEFAULT 0)`);
  const ins = db.prepare('INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.oa ?? '', r.name, r.value, r.host, r.path ?? '/', r.expiry ?? 2000000000, r.secure ?? 1, r.httpOnly ?? 0);
  db.close();
}
const SIGNED_IN = [
  { name: 'SID', value: 'made-up-sid', host: '.google.com' },
  { name: '__Secure-3PSID', value: 'made-up-psid', host: '.youtube.com', httpOnly: 1, expiry: 2000000000000 }, // milliseconds (newer Firefox)
  { name: 'PREF', value: 'f6=40000000', host: '.youtube.com', secure: 0 },
  { name: 'other', value: 'x', host: '.example.com' },
  { name: 'SID', value: 'container', host: '.google.com', oa: '^userContextId=2' },
];

test('cookies: a Firefox cookies.sqlite becomes a Netscape file with Google and YouTube cookies only', async () => {
  const dir = await tmp();
  const db = join(dir, 'cookies.sqlite');
  firefoxDb(db, SIGNED_IN);
  const rows = readFirefox(db);
  assert.equal(rows.length, 4, 'container cookies left out');
  assert.equal(rows.find((r) => r.name === '__Secure-3PSID').expires, 2000000000, 'milliseconds → seconds');
  assert.ok(signedIn(rows));
  const { text, count } = toNetscape(rows);
  assert.equal(count, 3);
  assert.match(text, /^# Netscape HTTP Cookie File\n/);
  assert.match(text, /\n#HttpOnly_\.youtube\.com\tTRUE\t\/\tTRUE\t2000000000\t__Secure-3PSID\tmade-up-psid\n/);
  assert.match(text, /\n\.youtube\.com\tTRUE\t\/\tFALSE\t2000000000\tPREF\tf6=40000000\n/);
  assert.doesNotMatch(text, /example\.com|container/);
  assert.equal(signedIn([{ name: 'NID', domain: '.google.com' }]), false);
  assert.equal(signedIn([{ name: 'SID', domain: '.evil.example' }]), false);
  // Tabs and newlines can't break a line apart.
  assert.equal(toNetscape([{ name: 'a\tb', value: 'c\nd', domain: '.google.com', path: '/' }]).text.trim().split('\n').filter((l) => l && !l.startsWith('#')).length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('cookies install: writes cookies.txt mode 600, deletes the copy, prints counts only; refuses a profile that never signed in', async () => {
  const dir = await tmp();
  const src = join(dir, 'jyt-cookies.sqlite');
  const out = join(dir, 'cookies.txt');
  firefoxDb(src, SIGNED_IN);
  await writeFile(`${src}-wal`, '');
  const r = await install(src, { out, owner: null });
  assert.ok(r.ok);
  assert.equal(r.count, 3);
  assert.doesNotMatch(r.message, /made-up/);
  assert.match(await readFile(out, 'utf8'), /made-up-sid/);
  if (process.platform !== 'win32') assert.equal((await stat(out)).mode & 0o777, 0o600);
  assert.equal(existsSync(src), false, 'the copy is deleted');
  assert.equal(existsSync(`${src}-wal`), false);
  // Not signed in: nothing installed, the old file stays, the copy still goes.
  const guest = join(dir, 'guest.sqlite');
  firefoxDb(guest, [{ name: 'NID', value: 'g', host: '.google.com' }]);
  const g = await install(guest, { out, owner: null });
  assert.equal(g.ok, false);
  assert.match(g.message, /No signed-in Google session/);
  assert.match(await readFile(out, 'utf8'), /made-up-sid/);
  assert.equal(existsSync(guest), false);
  // Not a cookie database.
  const junk = join(dir, 'junk.sqlite');
  await writeFile(junk, 'not sqlite');
  assert.equal((await install(junk, { out, owner: null })).ok, false);
  assert.equal(existsSync(junk), false, 'an unreadable copy is deleted too');
  const nodir = join(dir, 'nodir.sqlite');
  firefoxDb(nodir, SIGNED_IN);
  assert.match((await install(nodir, { out: join(dir, 'missing', 'cookies.txt'), owner: null })).message, /doesn't exist yet/);
  assert.equal(existsSync(nodir), false);
  // --keep leaves the copy (tests); the owner gets the file.
  const kept = join(dir, 'kept.sqlite');
  firefoxDb(kept, SIGNED_IN);
  const chowned = [];
  const k = await install(kept, { out, owner: 'jytrelay', keep: true, ids: (u) => { chowned.push(u); return { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }; } });
  assert.ok(k.ok && existsSync(kept));
  assert.deepEqual(chowned, ['jytrelay']);
  await rm(dir, { recursive: true, force: true });
});

test('cookies: only a bot or PO-token refusal is retried with them, once; a refused retry marks them dead until a new file', async () => {
  const dir = await tmp();
  const logs = [];
  const jar = new CookieJar({ path: join(dir, 'cookies.txt'), log: (o) => logs.push(o) });
  const err = (msg) => Object.assign(new Error('Command failed'), { stderr: msg });
  const calls = [];
  let answers = [];
  const runner = jar.wrap(async (cmd, args) => { calls.push(args); const a = answers.shift(); if (a instanceof Error) throw a; return a; });
  assert.equal(await jar.state(), 'none');
  answers = [err("ERROR: Sign in to confirm you're not a bot")];
  await assert.rejects(runner('yt-dlp', ['-g', 'x']));
  assert.equal(calls.length, 1, 'no cookies: no retry');
  await writeFile(jar.path, toNetscape([{ name: 'SID', value: 'made-up', domain: '.google.com' }]).text);
  assert.equal(await jar.state(), 'ok');
  calls.length = 0; answers = ['ok'];
  assert.equal(await runner('yt-dlp', ['-g', 'x']), 'ok');
  assert.deepEqual(calls, [['-g', 'x']], 'a success never uses them');
  for (const m of ['HTTP Error 429: Too Many Requests', 'Sign in to confirm your age', 'HTTP Error 403: Forbidden']) {
    calls.length = 0; answers = [err(m)];
    await assert.rejects(runner('yt-dlp', ['-g', 'x']));
    assert.equal(calls.length, 1, m);
  }
  calls.length = 0; answers = [err("Sign in to confirm you're not a bot"), 'ok'];
  assert.equal(await runner('yt-dlp', ['-g', 'x']), 'ok');
  assert.deepEqual(calls[1], ['--cookies', jar.path, '-g', 'x']);
  calls.length = 0; answers = [err('The following content is not available: PO Token'), err("Sign in to confirm you're not a bot")];
  await assert.rejects(runner('yt-dlp', ['-g', 'x']));
  assert.equal(await jar.state(), 'dead');
  calls.length = 0; answers = [err("Sign in to confirm you're not a bot")];
  await assert.rejects(runner('yt-dlp', ['-g', 'x']));
  assert.equal(calls.length, 1, 'dead: no more retries');
  // A newly installed file is usable again.
  const later = new Date(Date.now() + 5000);
  await writeFile(jar.path, 'new');
  await utimes(jar.path, later, later);
  assert.equal(await jar.state(), 'ok');
  assert.ok(!JSON.stringify(logs).includes('made-up'));
  await rm(dir, { recursive: true, force: true });
});

test('cookie watch: asks for a sign-in after a bot refusal with missing or dead cookies, at most once per window; all-clear when they work', () => {
  const sent = [];
  const last = new Map();
  let t = 0;
  const alert = Object.assign((kind, text, quiet) => { if (t - (last.get(kind) ?? -Infinity) < quiet * 60_000) return false; last.set(kind, t); sent.push({ kind, text }); return true; },
    { resolve: (kind, text) => { sent.push({ kind: `${kind}_ok`, text }); return true; } });
  const w = new CookieWatch({ alert, hours: 12 });
  assert.equal(w.refused('bot'), false, 'no worker has said anything (staging)');
  w.set('optiplex', 'none');
  assert.equal(w.refused('rate'), false);
  assert.equal(w.refused('restricted'), false);
  assert.equal(w.refused('bot'), true);
  assert.match(sent.at(-1).text, /no cookies to retry with/);
  assert.equal(w.refused('potoken'), false, 'once per 12 h');
  t += 12 * 3_600_000;
  assert.equal(w.refused('potoken'), true);
  w.set('optiplex', 'ok');
  assert.ok(sent.some((s) => s.kind === 'cookies_missing_ok'));
  assert.equal(w.refused('bot'), false, 'working cookies: the retry handles it');
  w.set('optiplex', 'dead');
  assert.match(sent.find((s) => s.kind === 'cookies_dead').text, /no longer work/);
  w.set('optiplex', 'bogus');
  assert.deepEqual(w.state(), { optiplex: 'dead' });
  const off = new CookieWatch({ alert: () => { throw new Error('no'); }, hours: 0 });
  off.set('optiplex', 'none');
  assert.equal(off.refused('bot'), false);
});

test('cookies: the worker reports only its state word, and the server asks once after a home bot refusal', async () => {
  const dir = await tmp();
  const TOKEN = 'relay-token';
  const alerts = [];
  const alert = Object.assign((kind, text) => { alerts.push({ kind, text }); return true; }, { resolve: () => true });
  const relay = new Relay({ token: TOKEN, pollMs: 200, log: () => {} });
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const logs = [];
  const app = createApp({ config: { ...base, shards: 2, pool: 50, relayToken: TOKEN, statsToken: 'st' }, store, relay, alert,
    captions: { async get() { return {}; } }, log: (l) => logs.push(l) });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const jar = new CookieJar({ path: join(dir, 'cookies.txt') });
  const worker = createWorker({ url, token: TOKEN, name: 'optiplex', version: 'test', polls: 1, jar, log: () => {} });
  worker.start();
  try {
    const state = async () => (await (await fetch(`${url}/ops/state`, { headers: { authorization: 'Bearer st' } })).json()).cookies;
    for (let i = 0; i < 100 && (await state()).optiplex !== 'none'; i++) await wait(20);
    assert.deepEqual(await state(), { optiplex: 'none' });
    // A bot refusal from the worker (as /relay/done reports it).
    const done = (refusal) => fetch(`${url}/relay/done`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x', ok: false, error: 'e', refusal }) });
    await done('bot');
    assert.equal(alerts.filter((a) => a.kind === 'cookies_missing').length, 1);
    await writeFile(jar.path, toNetscape([{ name: 'SID', value: 'made-up', domain: '.google.com' }]).text);
    for (let i = 0; i < 100 && (await state()).optiplex !== 'ok'; i++) await wait(20);
    assert.deepEqual(await state(), { optiplex: 'ok' });
    assert.ok(!logs.join('\n').includes('made-up'));
  } finally {
    worker.stop(); server.closeAllConnections?.(); server.close();
    await wait(50);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
