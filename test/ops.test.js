import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventRing, mask, redact, gitHead } from '../src/ops.js';
import { Playback } from '../src/playback.js';

const config = { ...base, shards: 2, pool: 100, statsToken: 'secret', metricsPath: '', tunelioKey: '' };

test('ops redaction: allowlisted fields only, IDs and query strings masked', () => {
  const e = redact({ at: 'x', event: 'play', id: 'dQw4w9WgXcQ', n: 5, shard: 1, ua: 'Mozilla/5.0', via: 'tunelio', held: 1200, nested: { a: 1 },
    message: 'ERROR: [youtube] dQw4w9WgXcQ: Sign in; see https://tunelio.dev/tunnel?id=dQw4w9WgXcQ&sig=abc' });
  assert.deepEqual(Object.keys(e).sort(), ['at', 'event', 'held', 'message', 'via']);
  assert.doesNotMatch(JSON.stringify(e), /dQw4w9WgXcQ|sig=|Mozilla/);
  assert.equal(mask('video unavailable Information'), 'video unavailable Information', 'ordinary words stay');
  assert.equal(redact({ event: 'android_av1' }).event, 'android_av1', 'an ID-shaped event name stays');
  assert.equal(redact({ event: 'dQw4w9WgXcQ' }).event, '…', 'an event field that holds an ID is still masked');
  assert.deepEqual(redact({ event: 'play', id: 'dQw4w9WgXcQ', n: 67, via: 'home', held: 0, pinned: true }),
    { event: 'play', via: 'home', held: 0, pinned: true }, 'a pinned play says so (#293)');
  assert.deepEqual(redact({ event: 'video_report', shard: 1, n: 67, kind: 'frozen', who: 'tester', device: 'android', ago: 42, via: 'tunelio', mode: 'adaptive', rung: '720p', top: 'pending', quality: '1080p', hls: true, counted: true }),
    { event: 'video_report', kind: 'frozen', who: 'tester', device: 'android', ago: 42, via: 'tunelio', mode: 'adaptive', rung: '720p', top: 'pending', quality: '1080p', hls: true, counted: true },
    'a video report keeps what it says about the play, never its shard or ticket (#353)');
  const ring = new EventRing(3);
  for (let i = 0; i < 5; i++) ring.push(JSON.stringify({ at: new Date(1000 + i).toISOString(), event: i % 2 ? 'a' : 'b', i }));
  ring.push('{"route":"ticket","status":302}'); // request lines are not events
  ring.push('not json');
  assert.equal(ring.items.length, 3);
  assert.deepEqual(ring.query({ events: ['b'] }).map((x) => x.at), [new Date(1002).toISOString(), new Date(1004).toISOString()]);
  assert.match(gitHead() ?? '', /^[0-9a-f]{40}$/);
});

test('gitHead follows a worktree (.git is a "gitdir:" file; refs in the main git dir)', () => {
  const root = mkdtempSync(join(tmpdir(), 'githead-'));
  try {
    const sha = 'a'.repeat(40), other = 'b'.repeat(40);
    const main = join(root, 'main.git'), wt = join(main, 'worktrees', 'golive');
    mkdirSync(join(main, 'refs', 'heads'), { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(main, 'refs', 'heads', 'main'), `${sha}\n`);
    writeFileSync(join(wt, 'commondir'), '../..\n');
    writeFileSync(join(root, '.git'), `gitdir: ${wt}\n`);
    const at = pathToFileURL(join(root, '.git')); // as the service passes it: the checkout's .git, here a file
    writeFileSync(join(wt, 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(gitHead(at), sha);
    writeFileSync(join(wt, 'HEAD'), `${other}\n`); // detached
    assert.equal(gitHead(at), other);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ops routes: token required, state and redacted events', async (t) => {
  const store = new Store({ path: ':memory:', shards: 2, pool: 100, pinHours: 24 });
  const youtube = { async search() { return { videos: [{ id: 'AbCdEfGh1jK', title: 't', channel: 'c', length: '20:00', seconds: 1200, views: '', age: '', live: false }], more: null }; }, thumbnailUrl: () => '' };
  const tunelio = { enabled: true, credits: 77, async create() { return { url: 'https://tunelio.dev/tunnel?id=x&sig=y', expires: 9e9, quality: '1080p', fileSize: 500e6 }; } };
  const lines = [];
  const playback = new Playback({ tunelio, probe: async () => ({ ok: true }), log: (o) => lines.push(JSON.stringify(o)) });
  const app = createApp({ config, store, youtube, tunelio, playback, captions: { async get() { return { available: false }; } }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, token = 'secret') => {
    const r = await fetch(url + path, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: 'manual' });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  assert.equal((await get('/ops/state', null)).status, 401);
  assert.equal((await get('/ops/state', 'wrong')).status, 401);
  assert.equal((await get('/ops/nope')).status, 404);

  // A search and a play put events in the ring.
  const s = await (await fetch(`${url}/v1/1/s?l=en&q=x`)).json();
  const play = await fetch(`${url}/v1/1/${s.results[0].t}`, { redirect: 'manual', headers: { 'user-agent': 'NSPlayer/12.00' } });
  assert.equal(play.status, 302);

  const st = await get('/ops/state');
  assert.equal(st.status, 200);
  assert.equal(st.body.tunelio.credits, 77);
  assert.equal(st.body.builds.ready, 1);
  assert.equal(st.body.builds.recent[0].mb, 500);
  assert.match(st.body.version ?? '', /^[0-9a-f]{40}$/);

  const ev = await get('/ops/events?event=play,tunelio_link&minutes=60');
  assert.equal(ev.status, 200);
  assert.deepEqual(ev.body.events.map((e) => e.event), ['play']);
  assert.equal(ev.body.events[0].client, 'avpro');
  assert.equal(ev.body.events[0].via, 'tunelio');
  const all = JSON.stringify((await get('/ops/events')).body) + JSON.stringify(st.body);
  assert.doesNotMatch(all, /AbCdEfGh1jK|sig=y|NSPlayer/, 'no video IDs, link signatures or User-Agents');

  // Test plans: POST sets one (token required), GET lists them.
  const post = async (qs, token = 'secret') => {
    const r = await fetch(`${url}/ops/plan?${qs}`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  assert.equal((await post('id=AbCdEfGh1jK&mode=start', null)).status, 401);
  assert.equal((await post('id=nope&mode=start')).status, 400);
  assert.equal((await post('id=AbCdEfGh1jK&mode=fast')).status, 400);
  const set = await post('id=AbCdEfGh1jK&mode=start&minutes=999');
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.forced.map((x) => [x.id, x.mode]), [['AbCdEfGh1jK', 'start']]);
  assert.ok(Date.parse(set.body.forced[0].until) - Date.now() <= 240 * 60_000 + 1000, 'at most 4 hours');
  assert.equal((await get('/ops/plan')).body.forced.length, 1);
  assert.deepEqual((await post('id=AbCdEfGh1jK&mode=clear')).body.forced, []);

  // Without a token configured the routes don't exist.
  const off = createApp({ config: { ...config, statsToken: '' }, store, youtube, tunelio, log: () => {} });
  const res = { writeHead(s) { this.status = s; return this; }, end() {} , on() {} };
  await off({ url: '/ops/state', method: 'GET', headers: {} }, Object.assign(res, { headersSent: false }));
  assert.equal(res.status, 404);
});

test('hls-test: the resolver gets a "not a video" page, the player the playlist; unknown names 404', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'hls-test'));
  writeFileSync(join(dir, 'hls-test', '0123456789abcdef.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://t/720.m3u8\n');
  const store = new Store({ path: ':memory:', shards: 2, pool: 100, pinHours: 24 });
  const app = createApp({ config: { ...config, dbPath: join(dir, 'tickets.db') }, store, tunelio: { enabled: false }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/hls-test/`;
  const get = (p, ua) => fetch(base + p, { headers: { 'user-agent': ua } });
  const player = await get('0123456789abcdef.m3u8', 'NSPlayer/12.00');
  assert.equal(player.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.match(await player.text(), /^#EXTM3U/);
  const resolver = await get('0123456789abcdef.m3u8', 'Mozilla/5.0 (Windows NT 10.0) Chrome/149.0 Safari/537.36');
  assert.match(resolver.headers.get('content-type'), /text\/html/);
  assert.equal((await get('fedcba9876543210.m3u8', 'NSPlayer')).status, 404);
  assert.equal((await get('..%2Ftickets.db', 'NSPlayer')).status, 404);
});

test('hls-test slots: #REDIRECT files answer 302; ?resolve=1 lets the resolver through', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'hls-test'));
  writeFileSync(join(dir, 'hls-test', '7e57000000000001.m3u8'), '#REDIRECT https://tunelio.dev/tunnel?id=x&progressive=1\n');
  writeFileSync(join(dir, 'hls-test', '7e57000000000002.m3u8'), '#EXTM3U\n');
  const store = new Store({ path: ':memory:', shards: 2, pool: 100, pinHours: 24 });
  const app = createApp({ config: { ...config, dbPath: join(dir, 'tickets.db') }, store, tunelio: { enabled: false }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/hls-test/`;
  const get = (p, ua) => fetch(base + p, { headers: { 'user-agent': ua }, redirect: 'manual' });
  const chrome = 'Mozilla/5.0 (Windows NT 10.0) Chrome/149.0 Safari/537.36';
  assert.equal((await get('7e57000000000001.m3u8', 'NSPlayer/12.00')).headers.get('location'), 'https://tunelio.dev/tunnel?id=x&progressive=1');
  assert.equal((await get('7e57000000000001.m3u8', chrome)).status, 404, 'the resolver fails over to the raw URL');
  assert.equal((await get('7e57000000000001.m3u8?resolve=1', chrome)).status, 302);
  assert.match(await (await get('7e57000000000002.m3u8?resolve=1', chrome)).text(), /^#EXTM3U/);
  assert.match(await (await get('7e57000000000002.m3u8', chrome)).text(), /Not a video/);
});

test('test slots: refill writes the slots (seven, plus the Quest audio masters 08-11), caps a day and refuses while the links are fresh', async (t) => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { TestSlots, slotName } = await import('../src/slots.js');
  const dir = mkdtempSync(join(tmpdir(), 'slots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-22T18:00:00Z');
  const creates = [];
  const tunelio = { async create(id, q) { creates.push(q); return { url: `https://tunelio.dev/tunnel?id=${q}`, expires: now / 1000 + 6 * 3600, fileSize: 456e6 }; } };
  const fetcher = async (u) => ({ status: u.includes('hls=1') ? 200 : 206, text: async () => '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nseg1.m4s\n', body: null });
  const slots = new TestSlots({ dir, tunelio, fetcher, maxPerDay: 2, base: 'https://yt/hls-test', now: () => now });
  const read = (n) => readFileSync(join(dir, `${slotName(n)}.m3u8`), 'utf8');

  assert.equal(slots.refill({ id: 'bad' }).error, 'bad_id');
  assert.deepEqual(slots.refill(), { started: true });
  assert.equal(slots.refill().already, true, 'a second call joins the running refill');
  const last = await slots.running;
  assert.equal(last.ok, true);
  assert.deepEqual(creates, ['720p', '1080p']);
  assert.match(read(2), /^https:\/\/tunelio\.dev\/seg1\.m4s$/m, 'segment links are absolute');
  assert.match(read(2), /URI="https:\/\/tunelio\.dev\/init\.mp4"/);
  assert.match(read(1), /RESOLUTION=1280x720[^\n]*\nhttps:\/\/yt\/hls-test\/7e57000000000002\.m3u8\?resolve=1/);
  assert.match(read(4), /RESOLUTION=1920x1080[^\n]*\nhttps:\/\/yt\/hls-test\/7e57000000000003\.m3u8\?resolve=1/);
  assert.match(read(8), /RESOLUTION=1280x720\nhttps:\/\/yt\/hls-test\/7e57000000000002\.m3u8\?resolve=1\n#EXT-X-STREAM-INF:BANDWIDTH=5400000,RESOLUTION=1920x1080\n/, '08: no CODECS');
  assert.match(read(9), /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",[^\n]*CHANNELS="2"\n#EXT-X-STREAM-INF:[^\n]*CODECS="avc1\.4d4020,mp4a\.40\.2",AUDIO="a"\n/, '09: muxed audio declared');
  assert.equal(read(10).match(/#EXT-X-STREAM-INF/g).length, 1, '10: one variant');
  assert.doesNotMatch(read(11), /CODECS/, '11: one variant, no CODECS');
  assert.equal(read(5), '#REDIRECT https://tunelio.dev/tunnel?id=720p&progressive=1\n');
  assert.equal(read(7), '#REDIRECT https://tunelio.dev/tunnel?id=720p&hls=1\n');
  const st = slots.status();
  assert.equal(st.running, false);
  assert.equal(st.refillsToday, 1);
  assert.equal(st.last.expires['1080p'], '2026-10-23T00:00:00.000Z');

  assert.equal(slots.refill().error, 'still_valid');
  now += 5 * 3600_000; // an hour left
  assert.equal(slots.refill().started, true);
  await slots.running;
  assert.equal(slots.refill({ force: true }).error, 'daily_cap');
  now = Date.parse('2026-10-24T01:00:00Z');
  assert.equal(slots.refill().started, true, 'the cap resets at 00:00 UTC');
  await slots.running;

  // A dropped connection to Tunelio is tried again instead of failing the refill.
  let drops = 1;
  const flaky = new TestSlots({ dir, tunelio, maxPerDay: 2, base: 'https://yt/hls-test', now: () => now, retryMs: 1,
    fetcher: async (u) => { if (drops-- > 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); return fetcher(u); } });
  now = Date.parse('2026-10-25T01:00:00Z');
  flaky.refill();
  assert.equal((await flaky.running).ok, true);
});

test('ops slot routes: refill is POST only and answers 202; the slots answer what they hold', async (t) => {
  const store = new Store({ path: ':memory:', shards: 2, pool: 100, pinHours: 24 });
  const calls = [];
  const slots = { status: () => ({ running: false, refillsToday: 0 }), refill: (o) => { calls.push(o); return o.id === 'x' ? { error: 'bad_id' } : { started: true }; } };
  const app = createApp({ config, store, tunelio: { enabled: false }, slots, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const go = (path, method = 'GET', token = 'secret') => fetch(url + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await go('/ops/slots/refill', 'POST', null)).status, 401);
  assert.equal((await go('/ops/slots/refill')).status, 405);
  assert.equal((await go('/ops/state', 'POST')).status, 405);
  assert.equal((await go('/ops/slots/refill?force=1', 'POST')).status, 202);
  assert.equal((await go('/ops/slots/refill?id=x', 'POST')).status, 400);
  assert.deepEqual(calls[0], { id: undefined, force: true });
  assert.equal((await (await go('/ops/slots')).json()).refillsToday, 0);
  assert.equal((await go('/search', 'POST')).status, 405, 'other routes stay GET only');
});

test('hls-test files: segments and playlists from a folder; a missing segment is held until it arrives', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'hls-test', '0123456789abcdef');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'index.m3u8'), '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n');
  const store = new Store({ path: ':memory:', shards: 2, pool: 100, pinHours: 24 });
  const app = createApp({ config: { ...config, dbPath: join(dir, 'tickets.db') }, store, tunelio: { enabled: false }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/hls-test/0123456789abcdef/`;
  const get = (p, ua = 'NSPlayer/12.00') => fetch(base + p, { headers: { 'user-agent': ua } });
  const list = await get('index.m3u8');
  assert.equal(list.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.match(await list.text(), /EVENT/);
  assert.equal((await get('index.m3u8', 'Mozilla/5.0 (Windows NT 10.0) Chrome/149.0 Safari/537.36')).status, 404);
  const late = get('seg3.m4s');
  setTimeout(() => writeFileSync(join(folder, 'seg3.m4s'), 'abc'), 400);
  const seg = await late;
  assert.equal(seg.status, 200);
  assert.equal(seg.headers.get('content-type'), 'video/iso.segment');
  assert.equal(await seg.text(), 'abc');
  assert.equal((await get('..%2F..%2Ftickets.db')).status, 404);
});
