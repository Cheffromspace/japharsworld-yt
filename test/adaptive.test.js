import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Adaptive, Pacer } from '../src/adaptive.js';
import { Playback } from '../src/playback.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { config as base } from '../src/config.js';

const SIZES = { '720p': 200e6, '1080p': 400e6 };
const playlist = '#EXTM3U\n#EXT-X-MAP:URI="tunnel?id=x&hls=data",BYTERANGE="1394@0"\n#EXTINF:4.8,\n#EXT-X-BYTERANGE:100@1394\ntunnel?id=x&hls=data\n';

// Tunelio and its builds, with the 1080p HLS build released by hand.
function fakes({ sizes = SIZES } = {}) {
  const created = [];
  let releaseUpper, failUpper = false;
  const upperBuilt = new Promise((r) => { releaseUpper = r; });
  const tunelio = { enabled: true, credits: 90_000, async create(id, q) {
    created.push([id, q]);
    return { url: `https://tunelio.dev/tunnel?id=${id}-${q}&exp=1&sig=s`, expires: 9e9, quality: q, fileSize: sizes[q] };
  } };
  const probe = async (url) => {
    if (/1080p.*hls=1/.test(url)) { await upperBuilt; return { ok: !failUpper, refused: false }; }
    return { ok: true, refused: false };
  };
  const playback = new Playback({ tunelio, quality: '720p', probe });
  const fetcher = async () => new Response(playlist, { status: 200 });
  return { tunelio, playback, created, fetcher, releaseUpper: (fail = false) => { failUpper = fail; releaseUpper(); } };
}

test('pacer: an even share of what is left until renewal, minus the reserve', () => {
  const p = new Pacer({ remaining: () => 35_000, spentToday: () => 900, daysLeft: () => 10, reserve: 5000 });
  assert.deepEqual(p.check(), { ok: true, allowance: 3000, spent: 900 });
  const tight = new Pacer({ remaining: () => 35_000, spentToday: () => 2995, daysLeft: () => 10, reserve: 5000 });
  assert.equal(tight.check().ok, false);
  assert.equal(new Pacer({ remaining: () => null, spentToday: () => 0, daysLeft: () => 1 }).check().ok, true, 'unknown balance: allow');
});

test('plans: 720p pick or no budget → lower without the 1080p /create; fast → direct; slow → adaptive', async () => {
  const f = fakes();
  const pacerOk = { check: () => ({ ok: true }) }, pacerNo = { check: () => ({ ok: false, allowance: 0, spent: 5 }) };
  const a = new Adaptive({ playback: f.playback, pacer: pacerOk, fetcher: f.fetcher });
  assert.equal(await a.plan({ id: 'never000001', seconds: 1200 }, 'never'), 'lower');
  assert.equal(await new Adaptive({ playback: f.playback, pacer: pacerNo }).plan({ id: 'nobudget001', seconds: 1200 }), 'lower');
  assert.deepEqual(f.created, [], 'no credits spent to decide "lower"');

  // Priors: 2 s + 17 ms/MB → 400 MB ≈ 8.8 s ≤ 10 s.
  assert.equal(await a.plan({ id: 'fast0000001', seconds: 1200 }), 'direct');
  f.playback.rate.progressive = 0.1; // Tunelio slow: 400 MB ≈ 42 s
  assert.equal(await a.plan({ id: 'slow0000001', seconds: 1200 }), 'adaptive');
  assert.equal(await a.plan({ id: 'slow0000001', seconds: 1200 }), 'adaptive', 'decided once');
  assert.deepEqual(f.created, [['fast0000001', '1080p'], ['slow0000001', '1080p']]);
  // A room that picked 1080p is not paced.
  assert.equal(await new Adaptive({ playback: f.playback, pacer: pacerNo }).plan({ id: 'always00001', seconds: 1200 }, 'always'), 'adaptive');
});

async function server(over = {}) {
  const f = fakes(over);
  const store = new Store({ path: ':memory:', shards: 4, pool: 100, pinHours: 24 });
  const youtube = { async search() { return { videos: [{ id: 'AbCdEfGh1jK', title: 't', channel: 'c', length: '20:00', seconds: 1200, views: '', age: '', live: false }], more: null }; }, thumbnailUrl: () => '' };
  const config = { ...base, shards: 4, pool: 100, metricsPath: '', tunelioKey: '', tunelioQuality: '720p', tunelioQualities: ['720p', '1080p'],
    adaptiveHls: true, adaptiveShards: [3], adaptiveHoldMs: 200, publicUrl: 'http://pub.example' };
  const adaptive = new Adaptive({ playback: f.playback, pacer: { check: () => ({ ok: true }) }, fetcher: f.fetcher, holdMs: 200, base: 'http://pub.example/hls' });
  const app = createApp({ config, store, youtube, tunelio: f.tunelio, playback: f.playback, adaptive, captions: { async get() { return { available: false }; } }, log: () => {} });
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const get = (p, ua = 'NSPlayer/12.00') => fetch(url + p, { headers: { 'user-agent': ua }, redirect: 'manual' });
  const ticket = async (shard) => (await (await get(`/v1/${shard}/s?l=en&q=x`, 'UnityPlayer/2022')).json()).results[0].t;
  return { ...f, srv, get, ticket };
}
const YTDLP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/149.0.0.0 Safari/537.36';

test('adaptive play: resolver sent on at once, player → our master, 720p now, 1080p held until built', async (t) => {
  const s = await server();
  t.after(() => s.srv.close());
  s.playback.rate.progressive = 0.1; // slow → adaptive
  const n = await s.ticket(3);

  const st = await (await s.get(`/v1/3/${n}`, 'UnityPlayer/2022')).json();
  assert.equal(st.plan, 'adaptive');
  const r = await s.get(`/v1/3/${n}`, YTDLP);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const p = await s.get(`/v1/3/${n}`);
  assert.equal(p.status, 302);
  const master = p.headers.get('location');
  assert.match(master, /^http:\/\/pub\.example\/hls\/[a-f0-9]{18}\.m3u8$/);
  const path = new URL(master).pathname;

  const m = await (await s.get(path)).text();
  // Absolute: a player that came through the ticket's redirect resolves relative links against the ticket URL.
  assert.match(m, /RESOLUTION=1280x720[^\n]*\nhttp:\/\/pub\.example\/hls\/[a-f0-9]{18}\/720p\.m3u8/);
  assert.match(m, /RESOLUTION=1920x1080[^\n]*\nhttp:\/\/pub\.example\/hls\/[a-f0-9]{18}\/1080p\.m3u8/);
  assert.match(await (await s.get(path, YTDLP)).text(), /Not a video/, 'a resolver never gets the master');

  const v720 = await (await s.get(path.replace('.m3u8', '/720p.m3u8'))).text();
  assert.match(v720, /URI="https:\/\/tunelio\.dev\/tunnel\?id=x&hls=data"/);
  assert.match(v720, /\nhttps:\/\/tunelio\.dev\/tunnel\?id=x&hls=data\n/);

  const held = Date.now();
  assert.equal((await s.get(path.replace('.m3u8', '/1080p.m3u8'))).status, 404, 'still building after the hold');
  assert.ok(Date.now() - held >= 180, 'held before answering');
  s.releaseUpper();
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal((await s.get(path.replace('.m3u8', '/1080p.m3u8'))).status, 200);
  assert.deepEqual(s.created.map(([, q]) => q).sort(), ['1080p', '720p'], 'one /create per quality (the 1080p one reused for its HLS)');
});

test('adaptive play: a failed 1080p build serves the 720p playlist (ends the retries)', async (t) => {
  const s = await server();
  t.after(() => s.srv.close());
  s.playback.rate.progressive = 0.1;
  const n = await s.ticket(3);
  const path = new URL((await s.get(`/v1/3/${n}`)).headers.get('location')).pathname;
  await s.get(path);
  s.releaseUpper(true);
  await new Promise((r) => setTimeout(r, 20));
  const v = await s.get(path.replace('.m3u8', '/1080p.m3u8'));
  assert.equal(v.status, 200);
  assert.match(await v.text(), /EXTINF/);
});

test('direct and off: a fast 1080p plays progressive; other shards keep the old path', async (t) => {
  const s = await server();
  t.after(() => s.srv.close());
  const n = await s.ticket(3);
  const d = await s.get(`/v1/3/${n}`);
  assert.equal(d.headers.get('location'), 'https://tunelio.dev/tunnel?id=AbCdEfGh1jK-1080p&exp=1&sig=s&progressive=1');
  const n0 = await s.ticket(0);
  const o = await s.get(`/v1/0/${n0}`);
  assert.equal(o.headers.get('location'), 'https://tunelio.dev/tunnel?id=AbCdEfGh1jK-720p&exp=1&sig=s&progressive=1', 'shard 0: plans off, the room default');
});

test('speed estimate: the median of recent builds wins over the long-run average, old ones expire', () => {
  let now = 10 * 3600_000;
  const p = new Playback({ tunelio: { enabled: true }, now: () => now });
  assert.equal(Math.round(p.predict('progressive', 300)), 7, 'priors: ~60 MB/s');
  p.speed(300, 60_000); p.speed(200, 40_000); p.speed(10, 100); // 5, 5 MB/s; the 10 MB one is ignored
  assert.equal(Math.round(p.predict('progressive', 300)), 62, 'slow period: 2 s + 300 / 5');
  now += 3 * 3600_000;
  assert.equal(Math.round(p.predict('progressive', 300)), 7, 'two hours later the slow builds no longer count');
});

test('a plain HLS build (a video over 3 hours) reached through the redirect goes to our copy with absolute links', async (t) => {
  const f = fakes();
  const long = { id: 'LongRain001', title: 't', channel: 'c', length: '10:00:00', seconds: 36000, views: '', age: '', live: false };
  const store = new Store({ path: ':memory:', shards: 4, pool: 100, pinHours: 24 });
  const app = createApp({ config: { ...base, shards: 4, pool: 100, metricsPath: '', tunelioKey: '', tunelioQuality: '720p', tunelioQualities: ['720p', '1080p'] },
    store, youtube: { async search() { return { videos: [long], more: null }; }, thumbnailUrl: () => '' }, tunelio: f.tunelio, playback: f.playback,
    adaptive: new Adaptive({ playback: f.playback, fetcher: f.fetcher, base: 'http://pub.example/hls' }), captions: { async get() { return { available: false }; } }, log: () => {} });
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}`;
  const n = (await (await fetch(`${url}/v1/0/s?l=en&q=rain`)).json()).results[0].t;
  const p = await fetch(`${url}/v1/0/${n}`, { headers: { 'user-agent': 'NSPlayer/12.00' }, redirect: 'manual' });
  const loc = p.headers.get('location');
  assert.match(loc, /^http:\/\/pub\.example\/hls\/[a-f0-9]{18}\/720p\.m3u8$/);
  const text = await (await fetch(url + new URL(loc).pathname, { headers: { 'user-agent': 'NSPlayer/12.00' } })).text();
  assert.match(text, /\nhttps:\/\/tunelio\.dev\/tunnel\?id=x&hls=data\n/);
  // VRChat's resolver still gets Tunelio's own link once the build is ready (VRChat hands AVPro that final URL, which works).
  const y = await fetch(`${url}/v1/0/${n}`, { headers: { 'user-agent': YTDLP }, redirect: 'manual' });
  assert.match(y.headers.get('location'), /^https:\/\/tunelio\.dev\/.*&hls=1$/);
});

test('switching off: a slow 1080p plays 720p instead of adaptive', async () => {
  const f = fakes();
  f.playback.rate.progressive = 0.1;
  const a = new Adaptive({ playback: f.playback, pacer: { check: () => ({ ok: true }) }, switching: false });
  assert.equal(await a.plan({ id: 'slowNoSwit1', seconds: 1200 }), 'lower');
  assert.equal(await a.plan({ id: 'fastShort01', seconds: 120 }, 'paced'), 'lower', 'rate still slow');
  f.playback.rate.progressive = 0.017;
  assert.equal(await a.plan({ id: 'fastNoSwit1', seconds: 1200 }), 'direct');
});

test('switching off: a room that picked 1080p still gets 1080p when it is slow', async () => {
  const f = fakes();
  f.playback.rate.progressive = 0.1;
  const a = new Adaptive({ playback: f.playback, pacer: { check: () => ({ ok: true }) }, switching: false });
  assert.equal(await a.plan({ id: 'slowPicked1', seconds: 1200 }, 'always'), 'direct');
});
