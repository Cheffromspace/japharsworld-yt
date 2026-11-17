// Everything-is-OK#764 (staging 2026-11-13 23:29Z): a queue warm started another video's home build, and its start gap
// (HOME_START_GAP_SECONDS) left a Quest's AV1 play 11 s later and a PC's 23 s later with no home worker, so both got
// Tunelio's AV1 files and the room never played. The owner's fix (2026-11-13, "D A unless we're hammering then E"):
// D a worker-cache upload gives the gap back; A an AV1 play may start home inside the gap unless home is hammering
// YouTube (a real download in the last HOME_AV1_GAP_SECONDS, 4+ real downloads in the hour, a refusal in 15 min);
// E otherwise a Quest's AV1 HLS play gets the first rung below it that isn't AV1.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { Home } from '../src/home.js';
import { RefusalWatch } from '../src/refusal.js';
import { Adaptive } from '../src/adaptive.js';
import { createWorker } from '../relay/worker.js';
import { config as base } from '../src/config.js';

const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'av1gap-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const fakeRelay = () => ({ enabled: true, capable: () => ['home'], run() { return new Promise(() => {}); } });
const MIN = 60_000;
const homeAt = (t, over = {}) => {
  const clock = { now: 1_000_000 };
  const logs = [];
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, dailyBuilds: 100, dailyMb: 1e9, hourBuilds: 8,
    startGapMs: 45_000, av1GapMs: 10_000, now: () => clock.now, log: (o) => logs.push(o), ...over });
  return { home, clock, logs };
};
const vid = (c) => ({ id: c.repeat(11), seconds: 600 });

test('#764 D: a build that turns out to be a worker-cache upload gives the start gap back', (t) => {
  const { home } = homeAt(t);
  const s = home.start(vid('a'), '1080p');
  assert.equal(home.limit(), 'gap');
  assert.equal(home.put(s.token, 'seg0.ts', Buffer.from('ts0'), { cached: true }), 204);
  assert.equal(home.limit(), null, 'nothing was asked of YouTube: no gap');
  assert.ok(home.start(vid('b'), '1080p'), 'the next build starts at once');
  // With a real download before it, the gap runs from that download, not from the cached one.
  const { home: h2, clock: c2 } = homeAt(t);
  assert.ok(h2.start(vid('a'), '1080p'));
  c2.now += 11_000;
  const cached = h2.start(vid('b'), '1080p', { av1: true }); // started inside the gap only as an AV1 play may
  assert.ok(cached);
  h2.put(cached.token, 'seg0.ts', Buffer.from('ts0'), { cached: true });
  c2.now += 33_000; // 44 s after the real one
  assert.equal(h2.limit(), 'gap');
  c2.now += 2_000; // 46 s
  assert.equal(h2.limit(), null);
});

test('#764 A: an AV1 play may start inside the gap 10 s after the last real download, not 9.9 s', (t) => {
  const { home, clock, logs } = homeAt(t);
  assert.ok(home.start(vid('a'), '1080p'));
  clock.now += 9_900;
  assert.equal(home.limit({ av1: true }), 'gap', '9.9 s: hammering');
  assert.equal(home.worker({ av1: true }), null);
  assert.equal(home.start(vid('b'), '1080p', { av1: true }), null);
  clock.now += 200; // 10.1 s
  assert.equal(home.limit({ av1: true }), null, '10.1 s: an AV1 play may start');
  assert.equal(home.limit(), 'gap', 'any other play still waits for the 45 s gap');
  assert.equal(home.worker(), null);
  assert.ok(home.start(vid('b'), '1080p', { av1: true }));
  assert.deepEqual(logs.filter((e) => e.event === 'home_av1_gap').map((e) => [e.id, e.afterMs]), [['bbbbbbbbbbb', 10_100]]);
  assert.equal(home.limit({ av1: true }), 'gap', 'and its own start counts as the last real download');
  assert.equal(home.state().av1GapS, 10);
});

test('#764 A: 4 real downloads in the rolling hour is hammering, 3 is not; a cache upload is not a download', (t) => {
  const run = (cachedOne) => {
    const { home, clock } = homeAt(t);
    const starts = [];
    for (const c of ['a', 'b', 'c', 'd']) { starts.push(home.start(vid(c), '720p')); clock.now += 46_000; }
    assert.ok(starts.every(Boolean));
    if (cachedOne) home.put(starts[0].token, 'seg0.ts', Buffer.from('ts0'), { cached: true });
    clock.now -= 46_000 - 20_000; // 20 s after the 4th start: inside the 45 s gap, past the 10 s one
    return home;
  };
  const four = run(false);
  assert.equal(four.hammering(), true);
  assert.equal(four.limit({ av1: true }), 'gap', '4 real downloads in the hour');
  const three = run(true);
  assert.equal(three.hammering(), false);
  assert.equal(three.limit({ av1: true }), null, '3 real downloads and one cache upload');
  // Three alone, no cache: the same.
  const { home, clock } = homeAt(t);
  for (const c of ['a', 'b', 'c']) { assert.ok(home.start(vid(c), '720p')); clock.now += 46_000; }
  clock.now -= 26_000;
  assert.equal(home.limit({ av1: true }), null, '3 real downloads');
});

test('#764 A: a bot, rate or potoken refusal at home in the last 15 min is hammering: 14 min yes, 16 min no', (t) => {
  let now = 5_000_000;
  const watch = new RefusalWatch({ now: () => now });
  const { home, clock } = homeAt(t, { refusedRecently: () => watch.recent() });
  assert.ok(home.start(vid('a'), '1080p'));
  clock.now += 20_000;
  assert.equal(home.limit({ av1: true }), null, 'no refusal');
  watch.add('forbidden');
  assert.equal(watch.recent(), false, 'a 403 is not a refusal of the address');
  watch.add('bot');
  now += 14 * MIN;
  assert.equal(home.limit({ av1: true }), 'gap', '14 min after a bot refusal');
  now += 2 * MIN;
  assert.equal(watch.recent(), false);
  assert.equal(home.limit({ av1: true }), null, '16 min after it');
});

test('#764 A: HOME_AV1_GAP_SECONDS=0 keeps the whole gap for AV1 plays too; the day and hour caps always hold', (t) => {
  const off = homeAt(t, { av1GapMs: 0 });
  assert.ok(off.home.start(vid('a'), '1080p'));
  off.clock.now += 30_000;
  assert.equal(off.home.limit({ av1: true }), 'gap');
  assert.equal(base.homeAv1GapMs, 10_000, 'on by default, 10 s');
  const hour = homeAt(t, { hourBuilds: 1 });
  assert.ok(hour.home.start(vid('a'), '1080p'));
  hour.clock.now += 30_000;
  assert.equal(hour.home.limit({ av1: true }), 'hour');
});

// Tunelio fakes: one job per quality and format, its codec already read (adaptive.codec keeps a read codec).
// delays['hls:720p']: ms the build takes from its first ask; an ask held for less gets ready:false, a later one the
// ready build. unread: builds whose codec is unknown (adaptive.codec then reads through the fetcher, which hangs).
// askedAt: when each build was first asked, ms from the fake's creation.
function tunelioFakes({ hls = {}, mp4 = {}, delays = {}, unread = [] } = {}) {
  const jobs = {};
  const t0 = Date.now();
  const askedAt = {};
  const job = (q, isHls) => {
    const key = `${isHls ? 'hls' : 'mp4'}:${q}`;
    return (jobs[key] ??= { id: 'aaaaaaaaaaa', quality: q, format: isHls ? 'hls' : 'progressive', state: 'ready',
      url: `https://tunelio.dev/t?q=${q}&${isHls ? 'hls' : 'progressive'}=1`, ...(unread.includes(key) ? {} : { codec: (isHls ? hls : mp4)[q] ?? 'h264' }) });
  };
  const asked = [];
  const playback = { jobs: new Map(), peek: (d, q = '720p', { hls: h = false } = {}) => (d?.id === 'aaaaaaaaaaa' || !d ? job(q, h) : null),
    status: () => ({ state: 'ready' }), start() {},
    async location(d, { quality = '720p', hls: h = false, holdMs = Infinity } = {}) {
      const key = `${h ? 'hls' : 'mp4'}:${quality}`;
      asked.push(key);
      askedAt[key] ??= Date.now() - t0;
      const j = job(quality, h);
      const readyAt = t0 + askedAt[key] + (delays[key] ?? 0);
      const wait = readyAt - Date.now();
      if (wait > holdMs) { await new Promise((r) => setTimeout(r, holdMs)); return { location: j.url, via: 'tunelio', reason: 'building', ready: false }; }
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return { location: j.url, via: 'tunelio', quality, ready: true };
    } };
  return { playback, asked, askedAt };
}

const QUEST = 'AVProMobileVideo/2026.4.1p2 (Linux;Android 14) ExoPlayer';
const PC_PLAYER = 'NSPlayer/12.00.26100 WMFSDK/12.00';
const TABLET = 'UnityPlayer/2022.3 (UnityWebRequest/1.0)';
const TOKEN = 'secret-token';
const PL1 = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\nseg0.ts\n';

// The real server with a home worker on the relay. cachedIds: videos the worker uploads from its own cache.
async function gapApp(t, { config: c = {}, fakes = {}, cachedIds = [], mediaDelayMs = {} } = {}) {
  const dir = tmp(t);
  const config = { ...base, shards: 2, pool: 50, relayToken: TOKEN, homeRelay: true, homeAndroid: true, homeReadyMs: 5000, homeHourBuilds: 8,
    homeHourMb: 0, homeLongMinutes: 60, ticketPin: true, ticketPinMarginMs: 60_000, dbPath: join(dir, 'tickets.db'), publicUrl: 'http://pub', metricsPath: '', ...c };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const relay = new Relay({ token: TOKEN, pollMs: 200 });
  const f = tunelioFakes(fakes);
  const logs = [];
  // A codec read of an unread build (fakes.unread) hangs, as a slow Tunelio playlist would.
  const adaptive = new Adaptive({ playback: f.playback, fetcher: () => new Promise(() => {}), base: 'http://pub/hls' });
  const app = createApp({ config, store, relay, playback: f.playback, adaptive, tunelio: { enabled: true }, captions: { async get() { return {}; } },
    log: (line) => logs.push(JSON.parse(line)) });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const jobs = [];
  const worker = createWorker({ url, token: TOKEN, name: 'home', polls: 1, caps: ['media'], log: () => {}, txBytes: () => null,
    media: async (job) => {
      jobs.push(job);
      if (mediaDelayMs[job.videoId]) await new Promise((r) => setTimeout(r, mediaDelayMs[job.videoId]));
      const headers = { authorization: `Bearer ${TOKEN}`, ...(cachedIds.includes(job.videoId) ? { 'x-media-cached': '1' } : {}) };
      const put = (file, body) => fetch(`${url}/relay/media/${job.token}/${file}`, { method: 'PUT', headers, body });
      await put('seg0.ts', 'ts0');
      await put('index.m3u8', PL1);
      return { ready: true, segments: 1, done: Promise.resolve() };
    } });
  worker.start();
  t.after(() => worker.stop());
  while (!relay.capable('media').length) await new Promise((r) => setTimeout(r, 20));
  const [n] = store.allocate(0, [{ kind: 'video', data: { id: 'aaaaaaaaaaa', title: 'AV1', seconds: 600, live: false } }]);
  const [warmN] = store.allocate(0, [{ kind: 'video', data: { id: 'bbbbbbbbbbb', title: 'Long', seconds: 6000, live: false } }]);
  store.setQuality(0, '1080p'); // the room's 1080p pick: a direct 1080p play, as tonight's
  const ask = (ua, ticket, ext = '') => fetch(`${url}/v1/0/${ticket}${ext}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  // The world's warm of a queued long video: its status ask starts that video's home build (why long). → when that
  // ask was answered (the build's start). Fails by name if the build is never ready, rather than hanging the suite.
  const warm = async () => {
    await (await ask(TABLET, warmN)).text();
    const at = Date.now();
    const deadline = at + 10_000;
    while (!logs.some((e) => e.event === 'home_ready' && e.id === 'bbbbbbbbbbb')) {
      if (Date.now() > deadline) assert.fail("the warm's home build was never ready (10 s)");
      await new Promise((r) => setTimeout(r, 20));
    }
    return at;
  };
  return { url, n, ask, warm, jobs, logs, store, asked: f.asked, askedAt: f.askedAt };
}
const sleepUntil = (t0, ms) => new Promise((r) => setTimeout(r, Math.max(0, t0 + ms - Date.now())));

test("#764 tonight's shape: a warm's real build at T, a Quest's AV1 ask at T+11 s and a PC's at T+23 s both get home (A)", async (t) => {
  // Scaled so the test takes seconds: HOME_AV1_GAP_SECONDS 1 s, the asks at T+1.1 s and T+2.3 s, T taken after the
  // warm's ask returned (so a slow suite can only make them later, not earlier); the gap a full minute.
  const app = await gapApp(t, { config: { homeStartGapMs: 60_000, homeAv1GapMs: 1000 },
    fakes: { hls: { '1080p': 'av1' }, mp4: { '1080p': 'av1', '720p': 'av1' } } });
  const t0 = await app.warm();
  assert.equal(app.logs.find((e) => e.event === 'build_route' && e.via === 'home')?.why, 'long');
  await sleepUntil(t0, 1100);
  const quest = await app.ask(QUEST, app.n, '.m3u8');
  assert.match(quest.headers.get('location') ?? '', /\/home\/[a-f0-9]{18}\/index\.m3u8$/, "the Quest's AV1 play goes home inside the gap");
  await sleepUntil(t0, 2300);
  const pc = await app.ask(PC_PLAYER, app.n);
  assert.match(pc.headers.get('location') ?? '', /\/home\//, "the PC's AV1 play reuses that session");
  assert.deepEqual(app.jobs.map((j) => j.videoId), ['bbbbbbbbbbb', 'aaaaaaaaaaa'], 'one build per video');
  assert.equal(app.logs.filter((e) => e.event === 'home_av1_gap').length, 1);
});

test('#764 A: a PC alone, its AV1 play inside the gap past HOME_AV1_GAP_SECONDS: home (why av1), not the 720p rung', async (t) => {
  const app = await gapApp(t, { config: { homeStartGapMs: 60_000, homeAv1GapMs: 1000 },
    fakes: { mp4: { '1080p': 'av1', '720p': 'h264' } } });
  const t0 = await app.warm();
  await sleepUntil(t0, 1100);
  const pc = await app.ask(PC_PLAYER, app.n);
  assert.match(pc.headers.get('location') ?? '', /\/home\//);
  assert.equal(app.logs.find((e) => e.event === 'build_route' && e.id === 'aaaaaaaaaaa')?.why, 'av1');
  assert.equal(app.logs.filter((e) => e.event === 'home_av1_gap').length, 1);
  assert.ok(!app.asked.includes('mp4:720p'), 'no 720p rung was built');
});

test('#764 E: home took the AV1 play but missed HOME_READY_SECONDS: the H.264 rung (a plain pin); the home build goes on', async (t) => {
  const app = await gapApp(t, { config: { homeStartGapMs: 0, homeReadyMs: 300 }, mediaDelayMs: { aaaaaaaaaaa: 2000 },
    fakes: { hls: { '1080p': 'av1', '720p': 'h264' } } });
  const quest = await app.ask(QUEST, app.n, '.m3u8');
  assert.match(quest.headers.get('location') ?? '', /^http:\/\/pub\/hls\/[a-f0-9]{18}\/720p\.m3u8$/);
  assert.deepEqual(app.jobs.map((j) => j.videoId), ['aaaaaaaaaaa'], 'one home build, still running for the next play');
});

test("#764 tonight's shape with A off: a warm's cached build gives the gap back, so the Quest's AV1 play still goes home (D)", async (t) => {
  const app = await gapApp(t, { config: { homeStartGapMs: 60_000, homeAv1GapMs: 0 }, cachedIds: ['bbbbbbbbbbb'],
    fakes: { hls: { '1080p': 'av1' } } });
  await app.warm();
  const quest = await app.ask(QUEST, app.n, '.m3u8');
  assert.match(quest.headers.get('location') ?? '', /\/home\//);
  assert.equal(app.logs.filter((e) => e.event === 'home_av1_gap').length, 0, 'no gap left to bypass');
});

test('#764 E: home hammering (a bot refusal at home): the Quest gets the 720p H.264 HLS rung, not the AV1 1080p; the PC youtube.com', async (t) => {
  const app = await gapApp(t, { config: { homeStartGapMs: 60_000, homeAv1GapMs: 1000 },
    fakes: { hls: { '1080p': 'av1', '720p': 'h264' }, mp4: { '1080p': 'av1', '720p': 'av1' } } });
  await app.warm();
  const r = await fetch(`${app.url}/relay/done`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'none', error: 'refused', refusal: 'bot' }) });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 1100)); // past HOME_AV1_GAP_SECONDS: only the refusal holds the gap now
  const quest = await app.ask(QUEST, app.n, '.m3u8');
  const loc = quest.headers.get('location') ?? '';
  assert.doesNotMatch(loc, /\/home\//, 'home is hammering: no new build');
  assert.match(loc, /^http:\/\/pub\/hls\/[a-f0-9]{18}\/720p\.m3u8$/, "our copy of Tunelio's 720p HLS build");
  assert.ok(app.asked.includes('hls:720p'), 'the 720p HLS rung was built');
  assert.deepEqual(app.logs.filter((e) => e.event === 'quest_av1').map((e) => [e.quality, e.rung, e.to, e.hls, e.declined]), [['1080p', '720p', 'lower', true, 'hammering']]);
  // The Quest's next ask: the same rung (a plain pin), not the AV1 build.
  assert.equal((await app.ask(QUEST, app.n, '.m3u8')).headers.get('location'), loc);
  // The PC: #741's ladder, 720p AV1 too: youtube.com.
  const pc = await app.ask(PC_PLAYER, app.n);
  assert.equal(pc.headers.get('location'), 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
  assert.equal(app.jobs.length, 1, "only the warm's build");
});

test('#764 E: every rung below the AV1 build AV1 too: the AV1 answer as before', async (t) => {
  const app = await gapApp(t, { config: { homeStartGapMs: 60_000, homeAv1GapMs: 60_000 },
    fakes: { hls: { '1080p': 'av1', '720p': 'av1', '480p': 'av1', '360p': 'av1' } } });
  await app.warm();
  const quest = await app.ask(QUEST, app.n, '.m3u8');
  const loc = quest.headers.get('location') ?? '';
  assert.doesNotMatch(loc, /\/home\//);
  assert.match(loc, /\/1080p\.m3u8$/, 'the AV1 1080p build, as before');
  assert.deepEqual(app.asked.filter((q) => q.startsWith('hls:')), ['hls:1080p', 'hls:720p', 'hls:480p', 'hls:360p']);
  assert.deepEqual(app.logs.filter((e) => e.event === 'quest_av1').map((e) => [e.rung ?? null, e.to]), [[null, 'none']]);
});

// Round 2 (verifier 2026-11-14 M1; the owner's "mostly worried about latency to first frame"). Timings are scaled: builds
// of 600-1500 ms stand for 10-30 s ones.
const questPlay = async (app) => {
  const t0 = Date.now();
  const r = await app.ask(QUEST, app.n, '.m3u8');
  return { location: r.headers.get('location') ?? '', ms: Date.now() - t0 };
};

test('#764 E round 2: the rungs build at once when the read says AV1; 720p AV1, 480p H.264: answered after one build, not two', async (t) => {
  const app = await gapApp(t, { config: { homeStartGapMs: 60_000, homeAv1GapMs: 60_000 },
    fakes: { hls: { '1080p': 'av1', '720p': 'av1' }, delays: { 'hls:720p': 700, 'hls:480p': 700, 'hls:360p': 700 } } });
  await app.warm();
  const { location, ms } = await questPlay(app);
  assert.match(location, /\/480p\.m3u8$/);
  const at = ['hls:720p', 'hls:480p', 'hls:360p'].map((k) => app.askedAt[k]);
  assert.ok(Math.max(...at) - Math.min(...at) < 100, `the three rungs were asked together: ${at}`);
  assert.ok(ms < 1300, `one build's time (700 ms), not two in a row (1400 ms): ${ms} ms`);
  assert.equal(app.logs.find((e) => e.event === 'quest_av1')?.declined, 'hammering');
});

test('#764 E round 2: a higher rung ready within QUEST_AV1_GRACE_SECONDS of a lower one wins; one later does not', async (t) => {
  const run = async (delay720) => {
    const app = await gapApp(t, { config: { homeStartGapMs: 60_000, homeAv1GapMs: 60_000, questAv1GraceMs: 800 },
      fakes: { hls: { '1080p': 'av1' }, delays: { 'hls:720p': delay720, 'hls:480p': 200, 'hls:360p': 100 } } });
    await app.warm();
    return questPlay(app);
  };
  const within = await run(600); // 480p good at 200 ms, 720p at 600 ms: inside the 800 ms grace
  assert.match(within.location, /\/720p\.m3u8$/);
  assert.ok(within.ms < 900, `${within.ms} ms`);
  const late = await run(3000); // 720p only at 3 s: 480p at the grace's end (~1 s)
  assert.match(late.location, /\/480p\.m3u8$/);
  assert.ok(late.ms >= 900 && late.ms < 2000, `the grace's end, not the 720p build: ${late.ms} ms`);
});

test('#764 E round 2: home started for the AV1 play but missed HOME_READY_SECONDS: the rungs built during the home wait', async (t) => {
  const app = await gapApp(t, { config: { homeStartGapMs: 0, homeReadyMs: 800 }, mediaDelayMs: { aaaaaaaaaaa: 3000 },
    fakes: { hls: { '1080p': 'av1' }, delays: { 'hls:720p': 700, 'hls:480p': 700, 'hls:360p': 700 } } });
  const { location, ms } = await questPlay(app);
  assert.match(location, /\/720p\.m3u8$/);
  assert.ok(app.askedAt['hls:720p'] < 300, `720p asked at the AV1 read, before the home wait: ${app.askedAt['hls:720p']} ms`);
  assert.ok(ms < 1300, `the home wait (800 ms), not the wait plus a build (1500 ms): ${ms} ms`);
  assert.equal(app.logs.find((e) => e.event === 'quest_av1')?.declined, 'home_ready');
});

test('#764 E round 2: a rung whose codec read hangs plays unread after QUEST_AV1_HLS_READ_SECONDS, not pinned', { timeout: 15_000 }, async (t) => {
  const app = await gapApp(t, { config: { homeStartGapMs: 60_000, homeAv1GapMs: 60_000, questAv1HlsReadMs: 400 },
    fakes: { hls: { '1080p': 'av1' }, unread: ['hls:720p'] } });
  await app.warm();
  const { location, ms } = await questPlay(app);
  assert.match(location, /\/720p\.m3u8$/, 'the 720p, unread (480p and 360p were read H.264 but rank lower)');
  assert.ok(ms >= 350 && ms < 1500, `the read's cap: ${ms} ms`);
  assert.equal(app.logs.find((e) => e.event === 'quest_av1')?.reason, 'unread');
  const again = await app.ask(QUEST, app.n, '.m3u8');
  assert.ok(!app.logs.some((e) => e.event === 'play' && e.pinned), 'not pinned: the next ask reads again');
  assert.match(again.headers.get('location') ?? '', /\/720p\.m3u8$/);
});

test('#764 E round 2 (verifier M1): every rung still building at the hold: the AV1 answer, NOT pinned; the retry gets the rung', async (t) => {
  const app = await gapApp(t, { config: { homeStartGapMs: 60_000, homeAv1GapMs: 60_000, ticketPlayerHoldMs: 500 },
    fakes: { hls: { '1080p': 'av1' }, delays: { 'hls:720p': 900, 'hls:480p': 900, 'hls:360p': 900 } } });
  await app.warm();
  const first = await questPlay(app);
  assert.match(first.location, /\/1080p\.m3u8$/, 'nothing better within the hold');
  assert.equal(app.logs.find((e) => e.event === 'quest_av1')?.to, 'building');
  await new Promise((r) => setTimeout(r, 600)); // the rungs are ready now
  const second = await questPlay(app);
  assert.match(second.location, /\/720p\.m3u8$/, 'the retry reaches E and gets the rung');
});
