import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Adaptive, Pacer } from '../src/adaptive.js';
import { Playback } from '../src/playback.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { config as base } from '../src/config.js';

const SIZES = { '360p': 50e6, '720p': 200e6, '1080p': 400e6 };
const playlist = '#EXTM3U\n#EXT-X-MAP:URI="tunnel?id=x&hls=data",BYTERANGE="1394@0"\n#EXTINF:4.8,\n#EXT-X-BYTERANGE:100@1394\ntunnel?id=x&hls=data\n';

// Tunelio and its builds, with the 1080p HLS build (and the 720p one, with hold720) released by hand.
function fakes({ sizes = SIZES, hold720 = false, pbOpts = {} } = {}) {
  const created = [];
  let releaseUpper, release720, failUpper = false;
  const upperBuilt = new Promise((r) => { releaseUpper = r; });
  const built720 = new Promise((r) => { release720 = r; });
  const tunelio = { enabled: true, credits: 90_000, async create(id, q) {
    created.push([id, q]);
    return { url: `https://tunelio.dev/tunnel?id=${id}-${q}&exp=1&sig=s`, expires: 9e9, quality: q, fileSize: sizes[q] };
  } };
  const probe = async (url) => {
    if (/1080p.*hls=1/.test(url)) { await upperBuilt; return { ok: !failUpper, refused: false }; }
    if (hold720 && /720p.*hls=1/.test(url)) await built720;
    return { ok: true, refused: false };
  };
  const playback = new Playback({ tunelio, quality: '720p', probe, ...pbOpts });
  // Says which build it is (a comment line players ignore), for tests that check which rung stood in.
  const fetcher = async (url) => new Response(`${playlist}#BUILD:${String(url).match(/\d+p/)?.[0]}\n`, { status: 200 });
  return { tunelio, probe, playback, created, fetcher, releaseUpper: (fail = false) => { failUpper = fail; releaseUpper(); }, release720 };
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

async function server(over = {}, opts = {}) {
  const f = fakes(over);
  const store = new Store({ path: ':memory:', shards: 4, pool: 100, pinHours: 24 });
  const youtube = { async search() { return { videos: [{ id: 'AbCdEfGh1jK', title: 't', channel: 'c', length: '20:00', seconds: 1200, views: '', age: '', live: false }], more: null }; }, thumbnailUrl: () => '' };
  const config = { ...base, shards: 4, pool: 100, metricsPath: '', tunelioKey: '', tunelioQuality: '720p', tunelioQualities: ['720p', '1080p'],
    adaptiveHls: true, adaptiveShards: [3], adaptiveHoldMs: 200, publicUrl: 'http://pub.example' };
  const adaptive = new Adaptive({ playback: f.playback, pacer: { check: () => ({ ok: true }) }, fetcher: f.fetcher, holdMs: 200, base: 'http://pub.example/hls', ...opts });
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

test('freeze proxy: the same player loading the master again counts as a reload, after or before its step up', async (t) => {
  const events = [];
  const s = await server({}, { onEvent: (k) => events.push(k) });
  t.after(() => s.srv.close());
  s.playback.rate.progressive = 0.1;
  const n = await s.ticket(3);
  const path = new URL((await s.get(`/v1/3/${n}`)).headers.get('location')).pathname;
  const reloads = () => events.filter((k) => k.startsWith('reload_'));
  await s.get(path);
  await s.get(path, 'NSPlayer/12.00 other-player');       // a second player in the room: not a reload
  await s.get(path);                                      // the first player again, still on 720p
  assert.deepEqual(reloads(), ['reload_before_upgrade']);
  s.releaseUpper();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await s.get(path.replace('.m3u8', '/1080p.m3u8'))).status, 200);
  await s.get(path);                                      // Play again after the switch
  assert.deepEqual(reloads(), ['reload_before_upgrade', 'reload_after_upgrade']);
});

test('Quest and an AV1 1080p rung: the Quest gets the 720p playlist (H.264) instead; PC players and HOME_ANDROID off get 1080p', async (t) => {
  const events = [];
  // Each build's playlist names its own init segment; the 1080p one is AV1.
  const fetcher = async (u) => {
    if (u.includes('init-')) return new Response(`....ftyp....moov....stsd....${u.includes('init-1080p') ? 'av01' : 'avc1'}....`, { status: 206 });
    const q = u.match(/-(\d+p)&/)?.[1];
    return new Response(`#EXTM3U\n#EXT-X-MAP:URI="init-${q}.mp4"\n#EXTINF:4.8,\nseg-${q}.m4s\n`, { status: 200 });
  };
  const QUEST = 'AVProMobileVideo/2026.3.3p2 (Linux;Android 14) ExoPlayer';
  for (const [androidNoAv1, ua, expect] of [[true, QUEST, '720p'], [true, 'NSPlayer/12.00', '1080p'], [false, QUEST, '1080p']]) {
    const s = await server({}, { onEvent: (k) => events.push(k), fetcher, androidNoAv1 });
    t.after(() => s.srv.close());
    s.playback.rate.progressive = 0.1;
    const n = await s.ticket(3);
    const path = new URL((await s.get(`/v1/3/${n}`)).headers.get('location')).pathname;
    await s.get(path, ua);
    s.releaseUpper();
    await new Promise((r) => setTimeout(r, 60));
    const v = await s.get(path.replace('.m3u8', '/1080p.m3u8'), ua);
    assert.equal(v.status, 200);
    assert.match(await v.text(), new RegExp(`seg-${expect}\\.m4s`), `${ua}, androidNoAv1=${androidNoAv1}`);
  }
  assert.equal(events.filter((k) => k === 'android_av1_rung').length, 1);
});

test('codec: read from the playlist head and the init segment, without waiting for the whole playlist; one read per build', async () => {
  let playlistFetches = 0;
  const fetcher = async (u) => {
    if (u.includes('init')) return new Response('....stsd....av01....', { status: 206 });
    playlistFetches++;
    // The head arrives, the rest never does (a fresh 1080p playlist that took over 15 s, 2026-10-23).
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg0.m4s\n')); } });
    return new Response(body, { status: 200 });
  };
  const a = new Adaptive({ playback: {}, fetcher });
  const job = { id: 'x', quality: '1080p', state: 'ready', url: 'https://tunelio.dev/t?id=x&hls=1' };
  const [c1, c2] = await Promise.all([a.codec(job), a.codec(job)]);
  assert.equal(c1, 'av1');
  assert.equal(c2, 'av1');
  assert.equal(playlistFetches, 1, 'concurrent asks share one read');
  assert.equal(await a.codec(job), 'av1');
  assert.equal(playlistFetches, 1, 'cached on the build');
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

const QUEST = 'AVProMobileVideo/2026.3.3p2-1921-15c4a824b2-Release (Linux;Android 14) ExoPlayer';

test('.m3u8 ticket (the world\'s Android build): always HLS, the plan\'s quality as a plain playlist', async (t) => {
  const s = await server();
  t.after(() => s.srv.close());
  s.releaseUpper();
  const n = await s.ticket(3); // fast: plan direct, 1080p
  const st = await (await s.get(`/v1/3/${n}.m3u8`, 'UnityPlayer/2022')).json();
  assert.equal(st.plan, 'direct');
  assert.equal(st.format, 'hls', 'the tablet warms the HLS build the player will open');
  assert.match(await (await s.get(`/v1/3/${n}.m3u8`, YTDLP)).text(), /being prepared/, 'the resolver is sent on, so AVPro opens the .m3u8 ticket itself');
  const q = await s.get(`/v1/3/${n}.m3u8`, QUEST);
  assert.equal(q.status, 302);
  assert.match(q.headers.get('location'), /^http:\/\/pub\.example\/hls\/[a-f0-9]{18}\/1080p\.m3u8$/, 'a plain playlist, no master');
  assert.match(await (await s.get(new URL(q.headers.get('location')).pathname, QUEST)).text(), /EXTINF/);
  assert.match((await s.get(`/v1/3/${n}`, QUEST)).headers.get('location'), /&progressive=1$/, 'an extensionless ticket (older builds) stays progressive');
  assert.match((await s.get(`/v1/3/${n}`)).headers.get('location'), /&progressive=1$/, 'the PC player keeps the mp4');
  const n0 = await s.ticket(0); // plans off
  assert.match((await s.get(`/v1/0/${n0}.m3u8`, QUEST)).headers.get('location'), /^http:\/\/pub\.example\/hls\/[a-f0-9]{18}\/720p\.m3u8$/);
  assert.equal((await s.get(`/v1/0/${n0}.mp4`, QUEST)).status, 404);
});

test('.m3u8 ticket on an adaptive plan: the master, without CODECS', async (t) => {
  const s = await server();
  t.after(() => s.srv.close());
  s.playback.rate.progressive = 0.1; // slow → adaptive
  const n = await s.ticket(3);
  const p = await s.get(`/v1/3/${n}.m3u8`, QUEST);
  assert.match(p.headers.get('location'), /^http:\/\/pub\.example\/hls\/[a-f0-9]{18}\.m3u8$/);
  const m = await (await s.get(new URL(p.headers.get('location')).pathname, QUEST)).text();
  assert.match(m, /RESOLUTION=1280x720\n/);
  assert.doesNotMatch(m, /CODECS/);
  // The tablet's status on the .m3u8 ticket reports the rung like a PC play's.
  const base = new URL(p.headers.get('location')).pathname;
  await s.get(base.replace('.m3u8', '/720p.m3u8'), QUEST);
  const st = await (await s.get(`/v1/3/${n}.m3u8`, 'UnityPlayer/2022')).json();
  assert.deepEqual([st.plan, st.rung, st.top], ['adaptive', '720p', 'pending']);
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

test('speed estimate: builds Tunelio already had (seconds for hundreds of MB) teach nothing', () => {
  const p = new Playback({ tunelio: { enabled: true } });
  p.learn('hls', 170, 33_000); p.learn('hls', 613, 84_000); // fresh: ~5 and ~7 MB/s
  const before = { predicted: p.predict('hls', 600), rate: p.rate.hls, fixed: p.fixed.hls };
  // 2026-10-23, 3FJctU--OxI played again: 751 MB in 1.8 s, 456 MB in 1.7 s, 93 MB in 2 s, 751 MB in 0.47 s.
  p.learn('hls', 751, 1829); p.learn('hls', 456, 1735); p.learn('hls', 93, 2036); p.learn('hls', 751, 471);
  p.learn('hls', 900, 4000); // over 120 MB/s
  assert.deepEqual({ predicted: p.predict('hls', 600), rate: p.rate.hls, fixed: p.fixed.hls }, before);
  assert.ok(before.predicted > 60, `still predicts a slow build (${before.predicted} s)`);
});

test('speed estimate survives a restart (stateFile); old or impossible speeds are dropped on load', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'speeds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'build-speeds.json');
  const a = new Playback({ tunelio: { enabled: true }, stateFile });
  assert.equal(a.measured(), false);
  a.learn('hls', 170, 33_000); a.learn('hls', 613, 84_000);
  const b = new Playback({ tunelio: { enabled: true }, stateFile });
  assert.equal(b.measured(), true, 'the deploy kept the two slow builds');
  assert.equal(b.predict('hls', 580), a.predict('hls', 580));
  assert.ok(b.predict('hls', 580) > 60);
  assert.deepEqual(b.rate, a.rate);
  writeFileSync(stateFile, JSON.stringify({ speeds: [{ at: Date.now() - 3 * 3600_000, mbps: 5 }, { at: Date.now(), mbps: 900 }], rate: { hls: -1 } }));
  const c = new Playback({ tunelio: { enabled: true }, stateFile });
  assert.deepEqual(c.speeds, []);
  assert.equal(c.rate.hls, 0.03, 'a bad rate keeps the prior');
  writeFileSync(stateFile, 'not json');
  assert.equal(new Playback({ tunelio: { enabled: true }, stateFile }).measured(), false);
});

test('a restart mid-play keeps the session, its builds and the paid links: the player steps up afterwards', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const liveFile = join(dir, 'playback-live.json'), stateFile = join(dir, 'adaptive-live.json');
  const f = fakes({ pbOpts: { liveFile } });
  const opts = { fetcher: f.fetcher, holdMs: 50, base: 'http://pub/hls', start: '360p', stateFile };
  const a = new Adaptive({ playback: f.playback, ...opts });
  const data = { id: 'restart0001', seconds: 1200 };
  a.force(data.id, 'start', 30);
  const job = f.playback.start(data, '360p', { hls: true });
  await f.playback.wait(job);
  const s = a.session(data, job);
  assert.ok(a.master(s.token));
  assert.equal(await a.variant(s.token, '1080p'), null, '1080p building');
  const paid = f.created.length;

  // The deploy: a new process with the same files. The 1080p build was in flight, so it starts again on the same link.
  const p2 = new Playback({ tunelio: f.tunelio, quality: '720p', probe: f.probe, liveFile });
  const b = new Adaptive({ playback: p2, ...opts });
  assert.deepEqual(b.forcedPlans().map((x) => x.mode), ['start'], 'the test plan too');
  assert.ok(b.master(s.token), 'the token still works');
  assert.equal(p2.peek(data, '360p', { hls: true }).state, 'ready');
  assert.equal(p2.peek(data, '1080p', { hls: true }).state, 'building');
  f.releaseUpper();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(await b.variant(s.token, '1080p'), /#BUILD:1080p/, 'and the step up still comes');
  assert.equal(f.created.length, paid, 'no /create paid again');
  assert.equal(await b.variant('0123456789abcdef01', '1080p'), null, 'unknown tokens stay unknown');
});

test('forced plan: a test plan for one video wins over the prediction, a room pick and the pacer, until it expires', async () => {
  let now = Date.now();
  const f = fakes();
  const no = { check: () => ({ ok: false, allowance: 0, spent: 5 }) };
  const events = [];
  const a = new Adaptive({ playback: f.playback, pacer: no, start: '360p', now: () => now, log: (o) => events.push(o) });
  assert.equal(await a.plan({ id: 'fjords20000', seconds: 1211 }), 'lower', 'the pacer says no');
  a.force('fjords20000', 'start', 30);
  assert.equal(await a.plan({ id: 'fjords20000', seconds: 1211 }), 'start', 'fast Tunelio, no budget: forced anyway');
  assert.equal(await a.plan({ id: 'fjords20000', seconds: 1211 }, 'never'), 'start', 'and over a room pick');
  assert.deepEqual(events.at(-1), { event: 'play_plan', id: 'fjords20000', mode: 'start', seconds: 1211, why: 'forced', mb: 400, lowerMb: 200 });
  assert.deepEqual(a.forcedPlans().map((x) => [x.id, x.mode]), [['fjords20000', 'start']]);
  assert.equal(await a.plan({ id: 'otherVideo1', seconds: 1211 }), 'lower', 'other videos as usual');
  now += 31 * 60_000;
  assert.deepEqual(a.forcedPlans(), []);
  assert.equal(await a.plan({ id: 'fjords20000', seconds: 1211 }), 'lower', 'expired: back to the pacer');
  a.force('fjords20000', 'direct', 30);
  assert.equal(await a.plan({ id: 'fjords20000', seconds: 1211 }), 'direct');
  a.force('fjords20000', null);
  assert.equal(await a.plan({ id: 'fjords20000', seconds: 1211 }), 'lower', 'cleared');
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

test('start rung: a slow 720p build starts on 360p; no 360p when 720p is quick or the rung is off', async () => {
  const f = fakes();
  const ok = { check: () => ({ ok: true }) };
  f.playback.rate.progressive = 0.1; // 1080p 400 MB ≈ 42 s: adaptive
  const a = new Adaptive({ playback: f.playback, pacer: ok, start: '360p', startSeconds: 10 });
  // Two recent builds at 10 MB/s: 720p HLS 200 MB ≈ 23 s > 10 s.
  f.playback.speed(100, 10_000); f.playback.speed(100, 10_000);
  assert.equal(await a.plan({ id: 'slow720p001', seconds: 1200 }), 'start');
  assert.deepEqual(f.created.map(([, q]) => q), ['1080p', '720p'], 'decided on the 1080p and 720p /creates; no 360p yet');
  f.playback.speeds = [{ at: Date.now(), mbps: 80 }, { at: Date.now(), mbps: 80 }]; // 720p ≈ 5.5 s
  assert.equal(await new Adaptive({ playback: f.playback, pacer: ok, start: '360p', directSeconds: 1 }).plan({ id: 'quick720p01', seconds: 1200 }), 'adaptive');
  f.playback.speeds = [];
  assert.equal(await new Adaptive({ playback: f.playback, pacer: ok }).plan({ id: 'noStartRung', seconds: 1200 }), 'adaptive', 'off without ADAPTIVE_START');
});

// mbps: two recent measured builds at this speed (null: none). 20: 720p HLS 200 MB ≈ 13 s (> 10 s: a start plan),
// 1080p 400 MB ≈ 23 s (≤ 30 s: one switch). 5: 720p ≈ 43 s, 1080p ≈ 83 s (two steps).
async function startPlay(opts = {}, mbps = 20) {
  const s = await server({ hold720: true }, { start: '360p', startSeconds: 10, ...opts });
  s.playback.rate.progressive = 0.1;
  s.playback.rate.hls = 0.2;
  if (mbps) s.playback.speeds = [{ at: Date.now(), mbps }, { at: Date.now(), mbps }];
  const n = await s.ticket(3);
  assert.equal((await (await s.get(`/v1/3/${n}`, 'UnityPlayer/2022')).json()).plan, 'start');
  assert.match((await s.get(`/v1/3/${n}`, YTDLP)).headers.get('content-type'), /text\/html/);
  const p = await s.get(`/v1/3/${n}`);
  assert.equal(p.status, 302);
  const path = new URL(p.headers.get('location')).pathname;
  const m = await (await s.get(path)).text();
  const rung = (q, ua) => s.get(path.replace('.m3u8', `/${q}.m3u8`), ua);
  const status = async () => { const j = await (await s.get(`/v1/3/${n}`, 'UnityPlayer/2022')).json(); return { plan: j.plan, rung: j.rung, top: j.top }; };
  return { ...s, m, order: [...m.matchAll(/\/(\d+p)\.m3u8/g)].map((x) => x[1]), rung, status };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('start rung play, 1080p due soon: master with 360p and 1080p only (one switch), the unlisted 720p for a failed 1080p', async (t) => {
  const events = [];
  const s = await startPlay({ onEvent: (k) => events.push(k) });
  t.after(() => s.srv.close());
  assert.deepEqual(s.order, ['360p', '1080p'], 'the built 360p first, no 720p step (#104)');
  assert.ok(events.includes('start_one_step'));
  assert.match(s.m, /RESOLUTION=640x360$/m);
  assert.doesNotMatch(s.m, /CODECS/, 'no CODECS: Quest plays a master that lists mp4a muted');
  assert.equal((await s.rung('360p')).status, 200);
  assert.equal((await s.rung('720p')).status, 404, 'not a rung of this master');
  assert.equal((await s.rung('1080p')).status, 404, '1080p still building');
  s.release720();
  await settle();
  assert.equal((await s.rung('1080p')).status, 404, 'a ready 720p is never served under a building 1080p');
  s.releaseUpper(true);
  await settle();
  const r = await s.rung('1080p');
  assert.equal(r.status, 200, 'failed 1080p: the 720p playlist ends the retries');
  assert.match(await r.text(), /#BUILD:720p/, 'the 720p build, not the 360p one');
  assert.deepEqual(await s.status(), { plan: 'start', rung: '720p', top: 'failed' }, 'the fallback counts as what it is');
  assert.deepEqual(s.created.map(([, q]) => q).sort(), ['1080p', '360p', '720p'], 'one /create per quality: 30 credits');
});

test('start rung play, 1080p predicted over ADAPTIVE_START_STEP_SECONDS: 360p, 720p, 1080p (two steps, reaches 1080p)', async (t) => {
  const events = [];
  const s = await startPlay({ startStepSeconds: 30, onEvent: (k) => events.push(k) }, 5);
  t.after(() => s.srv.close());
  assert.deepEqual(s.order, ['360p', '720p', '1080p']);
  assert.ok(events.includes('start_mid'));
  // The tablet's ticket status follows what the players were actually given (AVPro reports the top size from the start).
  assert.deepEqual(await s.status(), { plan: 'start', rung: null, top: 'pending' }, 'master loaded, no variant yet');
  assert.equal((await s.rung('360p')).status, 200);
  assert.deepEqual(await s.status(), { plan: 'start', rung: '360p', top: 'pending' });
  assert.equal((await s.rung('720p')).status, 404, '720p still building');
  s.release720();
  await settle();
  assert.match(await (await s.rung('720p')).text(), /#BUILD:720p/);
  assert.deepEqual(await s.status(), { plan: 'start', rung: '720p', top: 'pending' });
  assert.equal((await s.rung('1080p')).status, 404, '1080p still building');
  s.releaseUpper();
  await settle();
  assert.match(await (await s.rung('1080p')).text(), /#BUILD:1080p/);
  assert.deepEqual(await s.status(), { plan: 'start', rung: '1080p', top: 'served' });
});

test('start rung play with no measured builds (after a restart): two steps, whatever the prior says', async (t) => {
  const s = await startPlay({}, null);
  t.after(() => s.srv.close());
  assert.deepEqual(s.order, ['360p', '720p', '1080p']);
});

test('start rung play with ADAPTIVE_START_MID=on: 360p, 720p, 1080p', async (t) => {
  const s = await startPlay({ startMid: true });
  t.after(() => s.srv.close());
  assert.deepEqual(s.order, ['360p', '720p', '1080p']);
  assert.equal((await s.rung('720p')).status, 404, '720p still building');
  s.release720();
  await settle();
  assert.equal((await s.rung('720p')).status, 200);
});
