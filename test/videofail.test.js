// Everything-is-OK#967 stage 2: the service counts different videos it had trouble with (video_fail, src/videofail.js),
// requests it answered 5xx without meaning to (http_5xx, by route) and a Channels monitor it can't read (channel
// unreadable). The privacy page promises the video IDs behind video_fail stay in memory for up to 6 hours and are never
// stored or sent (public/privacy.html, the owner's wording of 2026-11-21); these tests hold the code to that.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { VideoFails, VIDEO_FAIL_MS } from '../src/videofail.js';
import { createApp, BY_DESIGN_5XX } from '../src/server.js';
import { Store } from '../src/store.js';
import { Playback } from '../src/playback.js';
import { Home } from '../src/home.js';
import { config as base } from '../src/config.js';
import { HTTP_ROUTES, METRICS, checkedKey } from '../src/metrics.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H = 3600_000;
const ID = 'AbCdEfGhIjK'; // a made-up video id

function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    later: (fn, ms) => timers.push({ at: now + ms, fn }),
    advance(ms) { now += ms; for (const t of timers.filter((x) => x.at <= now && !x.done)) { t.done = true; t.fn(); } },
  };
}

test('video_fail: one video counts once per kind and window, again after it; another video or kind counts on its own', () => {
  const incs = [];
  const clock = fakeClock();
  const v = new VideoFails({ metrics: { inc: (...a) => incs.push(a) }, now: clock.now, later: clock.later });
  assert.equal(v.count('captions', ID), true);
  for (let i = 0; i < 5; i++) assert.equal(v.count('captions', ID), false, 'four rooms asking again');
  assert.equal(v.count('captions', 'ZyXwVuTsRqP'), true);
  assert.equal(v.count('build', ID), true, 'a kind of its own');
  clock.advance(H);
  assert.equal(v.count('build', ID), true, 'a build failing again an hour later counts again');
  assert.equal(v.count('captions', ID), false, 'captions: still inside its 6 h');
  clock.advance(5 * H);
  assert.equal(v.count('captions', ID), true, 'and again after 6 h');
  assert.equal(v.count('nonsense', ID), false);
  assert.equal(v.count('captions', ''), false);
  assert.deepEqual(incs, [['video_fail', 'captions'], ['video_fail', 'captions'], ['video_fail', 'build'], ['video_fail', 'build'], ['video_fail', 'captions']]);
});

test('video_fail (privacy page): an ID is forgotten when its window ends, by its own timer, with no later count needed', () => {
  const clock = fakeClock();
  const v = new VideoFails({ metrics: null, now: clock.now, later: clock.later });
  v.count('captions', ID);
  v.count('home', 'ZyXwVuTsRqP');
  const held = () => [...v.seen.keys()].join(' ');
  assert.match(held(), new RegExp(ID));
  clock.advance(H - 1);
  assert.match(held(), /ZyXwVuTsRqP/);
  clock.advance(1);
  assert.doesNotMatch(held(), /ZyXwVuTsRqP/, 'home: gone after 1 h');
  clock.advance(5 * H - 1);
  assert.match(held(), new RegExp(ID));
  clock.advance(1);
  assert.equal(v.seen.size, 0, 'captions: gone after 6 h, nothing else asked');
  assert.equal(Math.max(...Object.values(VIDEO_FAIL_MS)), 6 * H, 'no window longer than the page\'s 6 hours');
  // The real timer does not keep the process alive.
  assert.match(readFileSync(new URL('../src/videofail.js', import.meta.url), 'utf8'), /setTimeout\(fn, ms\)\.unref\(\)/);
});

test('video_fail (privacy page): nothing the counter touches writes an ID: the metric gets the kind only, and the module logs, stores and sends nothing', () => {
  const calls = [];
  const v = new VideoFails({ metrics: { inc: (...a) => calls.push(a) } });
  for (const kind of ['captions', 'build', 'home']) v.count(kind, ID);
  assert.ok(calls.length === 3 && calls.every((a) => a.length === 2 && a[0] === 'video_fail' && !JSON.stringify(a).includes(ID)));
  const src = readFileSync(new URL('../src/videofail.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /\bimport\b|\blog\b|console|writeFile|fetch\(|store\./, 'no import, log, file, network or store');
  // The metric's key check takes the three kinds only, so an ID could not become a key.
  assert.equal(checkedKey('video_fail', ID), 'other');
  assert.deepEqual(['captions', 'build', 'home'].map((k) => checkedKey('video_fail', k)), ['captions', 'build', 'home']);
});

test('privacy page: the owner\'s sentence for these counts is on the page as given (2026-11-21), and the page date moved with it', () => {
  const page = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');
  assert.ok(page.includes('how videos were served, how many requests the service could not answer because of a fault on its side (by kind of request, such as search, play or captions), and how many different videos the service had trouble fetching or captioning (a count only; to count each video once, its ID is kept in memory for up to 6 hours and is never stored or sent), and PC or Quest'));
  assert.match(page, /updated 2026-11-21</);
});

test('http_5xx: the routes are the server\'s own names, and the by-design 5xx answers are the four the code gives on purpose', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const named = [...new Set([...src.matchAll(/\broute = '([a-z-]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(named, [...HTTP_ROUTES].sort(), 'every route = \'…\' in src/server.js is a key, and no other');
  const byDesign = [...src.matchAll(/fail\(res, 5\d\d, '([a-z_]+)'/g)].map((m) => m[1]).filter((c) => c !== 'server_error');
  assert.deepEqual([...new Set(byDesign)].sort(), [...BY_DESIGN_5XX].sort(), 'each by-design 5xx is listed, and nothing else');
  assert.equal(checkedKey('http_5xx', '/v1/0/AbCdEfGhIjK'), 'other');
  assert.ok(METRICS.channel[1]('unreadable'));
});

// The real server with fakes, as test/server.test.js does.
async function start(over = {}, captions = null) {
  const config = { ...base, shards: 2, pool: 100, resultsPerPage: 3, searchesPerMinutePerIp: 5 };
  const store = over.store ?? new Store({ path: ':memory:', shards: config.shards, pool: config.pool, pinHours: 24 });
  const incs = [];
  const lines = [];
  const metrics = { inc: (m, k) => incs.push(`${m}:${k}`), gauge() {}, latency() {}, shard() {}, flush() { return 0; }, start() { return this; }, close() {} };
  const video = (id) => ({ id, title: 'T', channel: 'C', length: '1:00', seconds: 60, views: '1', age: '1 day ago', live: false, cc: true });
  const youtube = { async search(q, limit) { return { videos: Array.from({ length: limit }, (_, i) => video(i ? `ZyXwVuTsRq${i}` : ID)), more: null }; }, thumbnailUrl: (id) => `thumb://${id}` };
  const app = createApp({ config, store, youtube, metrics, log: (l) => lines.push(l), captions: captions ?? { async get() { throw new Error('x'); }, async tracks() { throw new Error('x'); }, warm() {} }, ...over });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const get = async (path) => { const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' }); return { status: res.status, body: await res.text() }; };
  return { server, get, incs, lines, store };
}

test('captions: four requests for one video that gets none count one video; a second video counts again; no ID in any count or the request line', async (t) => {
  const s = await start({}, { async get(id) { return { id, available: false, reason: 'temporarily_unavailable', tracks: [], track: -1 }; },
    async tracks(id) { return { id, available: false, reason: 'temporarily_unavailable', tracks: [], track: -1 }; }, warm() {} });
  t.after(() => s.server.close());
  const r = JSON.parse((await s.get('/v1/0/s?q=rain')).body);
  await s.get(`/v1/0/${r.results[0].t}`);
  for (let i = 0; i < 4; i++) assert.equal((await s.get('/v1/0/cc')).status, 200);
  assert.deepEqual(s.incs.filter((x) => x.startsWith('video_fail:')), ['video_fail:captions']);
  assert.equal(s.incs.filter((x) => x === 'cc_unavailable:temporarily_unavailable').length, 4, 'the request count is unchanged');
  await s.get(`/v1/0/${r.results[1].t}`);
  await s.get('/v1/0/cc');
  assert.deepEqual(s.incs.filter((x) => x.startsWith('video_fail:')), ['video_fail:captions', 'video_fail:captions'], 'a second video');
  assert.ok(!s.incs.some((x) => x.includes(ID) || x.includes('ZyXwVuTsRq')), 'no ID in any count');
  assert.ok(!s.incs.some((x) => x.startsWith('http_5xx:')), 'a 200 answer');
});

test('captions that threw (502 captions_failed): one video counted, and not an http_5xx (by design)', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  const r = JSON.parse((await s.get('/v1/0/s?q=rain')).body);
  await s.get(`/v1/0/${r.results[0].t}`);
  assert.equal((await s.get('/v1/0/cc/en')).status, 502);
  assert.equal((await s.get('/v1/0/cc/en')).status, 502);
  assert.deepEqual(s.incs.filter((x) => x.startsWith('video_fail:') || x.startsWith('http_5xx:')), ['video_fail:captions']);
});

test('http_5xx: a route that throws counts once per answer, by route; nothing else in a normal search and play does', async (t) => {
  const store = new Store({ path: ':memory:', shards: 2, pool: 100, pinHours: 24 });
  store.lastPlayed = () => { throw new Error('database is locked'); };
  const s = await start({ store });
  t.after(() => s.server.close());
  const r = JSON.parse((await s.get('/v1/0/s?q=rain')).body);
  assert.equal((await s.get(`/v1/0/${r.results[0].t}`)).status, 302);
  assert.ok(!s.incs.some((x) => x.startsWith('http_5xx:')), 'search and play answered normally');
  assert.equal((await s.get('/v1/0/cc')).status, 500);
  assert.deepEqual(s.incs.filter((x) => x.startsWith('http_5xx:')), ['http_5xx:captions']);
  assert.ok(s.lines.some((l) => /"event":"error","route":"captions"/.test(l)));
});

test('http_5xx: scanner-shaped paths (//, bad percent-encoding, traversal) answer 4xx and count nothing; "//" answered 500 before', async (t) => {
  const net = await import('node:net');
  const s = await start();
  t.after(() => s.server.close());
  const { port } = s.server.address();
  const raw = (path) => new Promise((done) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let d = '';
    c.on('data', (b) => { d += b; });
    c.on('end', () => done(Number(d.split(' ')[1])));
  });
  for (const p of ['//', '//etc/passwd', '/%', '/v1/0/%E0%A4%A', '/v1/0/s?q=%', '/v1/ch/%', '/v1/0/cc/%', '/../../etc/passwd', '/home/%', '/hls/%']) {
    assert.ok((await raw(p)) < 500, p);
  }
  assert.equal(await raw('//'), 404);
  assert.deepEqual(s.incs.filter((x) => x.startsWith('http_5xx:')), []);
});

test('captions (the stage 2 verifier\'s L7): "constructor", "toString" and other inherited names are not languages: they get English as an unknown language does, and count nothing', async (t) => {
  const { normalizeLang } = await import('../src/query.js');
  const asked = [];
  const s = await start({}, { async get(id, lang) { asked.push(lang); return { id, lang, available: true, source: 'manual', lines: [[0, 1, 'hi']] }; },
    async tracks(id, lang) { return { id, lang, available: true, tracks: [], track: -1 }; }, warm() {} });
  t.after(() => s.server.close());
  const r = JSON.parse((await s.get('/v1/0/s?q=rain')).body);
  await s.get(`/v1/0/${r.results[0].t}`);
  asked.length = 0;
  for (const w of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'xyz']) {
    assert.equal((await s.get(`/v1/0/cc/${w}`)).status, 200, w);
    assert.equal(normalizeLang(w), 'en', w);
  }
  assert.deepEqual(asked, ['en', 'en', 'en', 'en', 'en', 'en']);
  assert.deepEqual(s.incs.filter((x) => x.startsWith('video_fail:') || x.startsWith('http_5xx:')), []);
});

test('channels: a monitor status the service can\'t read is counted as unreadable, a hidden slot as unavailable; neither 503 is an http_5xx', async (t) => {
  const answers = { 'a-slot': { error: 'monitor_unreadable' }, 'b-slot': { error: 'channel_unavailable' }, 'c-slot': { error: 'unknown_channel' } };
  const s = await start({ channels: { resolve: async (key) => answers[key] } });
  t.after(() => s.server.close());
  assert.equal((await s.get('/v1/ch/a-slot')).status, 503);
  assert.equal((await s.get('/v1/ch/b-slot')).status, 503);
  assert.equal((await s.get('/v1/ch/c-slot')).status, 404);
  assert.deepEqual(s.incs.filter((x) => x.startsWith('channel:') || x.startsWith('http_5xx:')), ['channel:unreadable', 'channel:unavailable', 'channel:unknown']);
});

test('builds: Playback tells onBuild why a build failed, so only a build /create accepted and then lost (build_failed) is a video_fail', async () => {
  const builds = [];
  const ok = (id, q) => ({ url: `https://tunelio.dev/tunnel?id=${id}&q=${q}`, expires: 1e12, quality: q, fileSize: 1e8 });
  const timedOut = new Playback({ tunelio: { enabled: true, async create(id, q) { return ok(id, q); } }, probe: async () => ({ ok: false, refused: false, status: 524 }), onBuild: (b) => builds.push(b) });
  assert.equal((await timedOut.location({ id: ID, seconds: 60 }, { hls: true })).reason, 'build_failed');
  const refused = new Playback({ tunelio: { enabled: true, async create() { const e = new Error('not ready'); e.status = 409; throw e; } }, alert: () => {}, onBuild: (b) => builds.push(b) });
  assert.equal((await refused.location({ id: 'ZyXwVuTsRqP', seconds: 60 })).reason, 'tunelio_failed');
  assert.deepEqual(builds.map((b) => [b.ok, b.reason]), [[false, 'build_failed'], [false, 'tunelio_failed']]);
  // The server's onBuild counts the first kind only (src/server.js).
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!ok && reason === 'build_failed'\) videoFails\.count\('build', id\)/);
});

test('home: a failed session hands its video to onEvent for the count; a growing playlist given up on purpose does not count', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'videofail-home-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  const events = [];
  const relay = { enabled: true, capable: () => ['home'], run() { return new Promise(() => {}); } };
  const home = new Home({ relay, dir, base: 'https://yt/home', enabled: true, onEvent: (k, d) => events.push([k, d?.id]) });
  const s = home.start({ id: ID, seconds: 40 }, '720p');
  const pl = (n) => `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n${Array.from({ length: n }, (_, i) => `#EXTINF:4.000000,\nseg${i}.ts\n`).join('')}#EXT-X-ENDLIST\n`;
  home.put(s.token, 'seg0.ts', Buffer.from('a'));
  home.put(s.token, 'index.m3u8', Buffer.from(pl(10)));
  home.put(s.token, 'seg1.ts', Buffer.from('b'));
  home.put(s.token, 'index.m3u8', Buffer.from(pl(2))); // cut short: failed (#780)
  assert.equal(s.state, 'failed');
  assert.deepEqual(events.filter(([k]) => k === 'failed'), [['failed', ID]]);
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(src, /if \(k === 'failed'\) videoFails\.count\('home', d\?\.id\)/);
  assert.match(readFileSync(new URL('../src/home.js', import.meta.url), 'utf8'), /giveUp\(s, reason = 'uneven'\) \{[\s\S]*?this\.onEvent\(reason\);/, 'giveUp still reports its own reason, not failed');
});
