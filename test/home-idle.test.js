// Unused home builds are dropped (src/home.js "Unused builds", Everything-is-OK#1069): a growing session a PC player was
// moved off (markUneven) and that no player has fetched from stops at the worker's next upload once HOME_IDLE_SECONDS
// have passed since it was last handed to anyone. Staging 2026-11-27 19:23Z: a 2 h 19 min build kept uploading with no
// home_get at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { Home } from '../src/home.js';
import { createWorker } from '../relay/worker.js';
import { mediaJob } from '../relay/media.js';
import { config as base } from '../src/config.js';
import { codecFetch } from './remote-fakes.js';

const TOKEN = 'secret-token';
const GROWING = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\nseg0.ts\n';
const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'home-idle-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const VIDEO = { id: 'aaaaaaaaaaa', seconds: 7200 };
const IDLE = 60_000;

// A Home on a fake clock with one media worker of 2 streams, and a ready growing session a PC was moved off.
function setup(t, { idleMs = IDLE, mark = true, dir = tmp(t), opts = {} } = {}) {
  const clock = { now: 1_000_000 };
  const logs = [], events = [];
  const relay = { enabled: true, capable: () => ['home'], mediaMax: () => ({ home: 2 }), run: () => new Promise(() => {}) };
  const home = new Home({ relay, dir, enabled: true, idleMs, now: () => clock.now, log: (l) => logs.push(l), onEvent: (k) => events.push(k), ...opts });
  const s = home.start(VIDEO, '1080p');
  assert.equal(home.put(s.token, 'seg0.ts', Buffer.from('x'.repeat(1000))), 204);
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from(GROWING)), 204);
  assert.equal(s.state, 'ready');
  if (mark) home.markUneven(s);
  const seg = (i) => home.put(s.token, `seg${i}.ts`, Buffer.from('y'.repeat(1000)));
  return { home, s, clock, logs, events, seg, relay, dir };
}

test('#1069: a session a PC was moved off that nobody fetched is dropped 60 s on: 410 to the worker, slot freed, files gone, one home_idle', (t) => {
  const { home, s, clock, logs, events, seg, dir } = setup(t);
  assert.equal(home.load().active, 1);
  clock.now += IDLE - 1000;
  assert.equal(seg(1), 204, 'inside the window the upload goes on');
  clock.now += 2000;
  assert.equal(seg(2), 410, 'past it the worker is told to stop');
  assert.equal(home.byToken.has(s.token), false, 'dropped');
  assert.equal(home.load().active, 0, 'its stream slot is free at once');
  assert.equal(home.load().free, true);
  assert.equal(existsSync(join(dir, s.token)), false, 'its files are gone');
  assert.equal(seg(3), 410, 'every later upload too');
  const idle = logs.filter((l) => l.event === 'home_idle');
  assert.equal(idle.length, 1, 'logged once');
  assert.equal(idle[0].id, VIDEO.id);
  assert.equal(idle[0].quality, '1080p');
  assert.equal(idle[0].idleS, 61);
  assert.equal(idle[0].segments, 2);
  assert.equal(events.filter((e) => e === 'idle').length, 1, 'counted once (metric home:idle)');
  assert.equal(logs.some((l) => l.event === 'home_failed'), false, 'not a failure of the video');
});

test('#1069: a late player after the drop gets a fresh session at once (no RETRY_MS block), and the video is remembered as dropped unused', (t) => {
  const { home, s, clock, seg } = setup(t);
  clock.now += IDLE + 1000;
  assert.equal(seg(1), 410);
  assert.equal(home.peek(VIDEO, '1080p'), null, 'nothing to reuse: no frozen playlist handed out');
  assert.equal(home.wasIdle(VIDEO), true);
  const again = home.start(VIDEO, '1080p');
  assert.ok(again && again !== s && again.state === 'building', 'a new build');
  clock.now += 12 * 3600_000 + 1000;
  assert.equal(home.wasIdle(VIDEO), false, 'forgotten after keepHours');
});

test('#1069: one fetch exempts a session for good (a paused player or a long buffer never looks idle)', async (t) => {
  for (const file of ['index.m3u8', 'seg0.ts']) {
    const { home, s, clock, seg } = setup(t);
    assert.ok(await home.file(s.token, file));
    for (let i = 1; i <= 20; i++) { clock.now += 60_000; assert.equal(seg(i), 204, `${file}: minute ${i}`); }
    assert.equal(home.byToken.has(s.token), true);
  }
  // A fetch before the PC was moved off counts the same.
  const { home, s, clock, seg } = setup(t, { mark: false });
  await home.file(s.token, 'index.m3u8');
  home.markUneven(s);
  clock.now += 10 * 60_000;
  assert.equal(seg(1), 204);
});

test('#1069: a hand-out (a player answer, a pin, a tablet status) starts the window again', (t) => {
  const { home, s, clock, seg } = setup(t);
  clock.now += 50_000;
  home.used(s);
  clock.now += 50_000;
  assert.equal(seg(1), 204, '100 s after the move, 50 s after the hand-out');
  clock.now += 11_000;
  assert.equal(seg(2), 410);
});

test('#1069: never dropped: no PC moved off it (a Quest-only build, a warm no PC tablet status marked), a settle hold on it, HOME_IDLE_SECONDS=0', (t) => {
  const quest = setup(t, { mark: false });
  quest.clock.now += 30 * 60_000;
  assert.equal(quest.seg(1), 204, 'not marked: as before #1069');
  const held = setup(t);
  held.s.endWaiters.push(() => {});
  held.clock.now += 10 * 60_000;
  assert.equal(held.seg(1), 204, 'a player is held for its end (settle)');
  const off = setup(t, { idleMs: 0 });
  off.clock.now += 30 * 60_000;
  assert.equal(off.seg(1), 204, 'off');
  assert.equal(off.home.state().idleS, 0);
  assert.equal(setup(t).home.state().idleS, 60, '/ops/state shows the setting');
});

test('#1069: the day counts a dropped build at its EXPECTED MB (length x 0.57 MB/s, the 1080p rate, at every quality; a deliberate overcount, 1.6-2.1x the real size on staging), the hour keeps the build', (t) => {
  const { home, clock, seg } = setup(t);
  const expected = VIDEO.seconds * 0.57;
  assert.ok(home.state().today.mb < 1, 'before: only what was uploaded');
  clock.now += IDLE + 1000;
  seg(1);
  assert.equal(home.state().today.mb, Math.round(expected), 'the expected MB, not the real download (which the server cannot see)');
  assert.equal(home.state().today.builds, 1);
  assert.equal(home.state().hour.builds, 1);
  assert.equal(home.state().hour.mb, Math.round(expected));
});

test('#1069: a rebuild of a dropped build takes over its hour MB instead of being charged twice; another video is still held by the hour', (t) => {
  // Staging 2026-11-27 23:04Z: a late Quest ask after a drop met the hour at 13193 of 15000 MB, 2999 of it the dropped
  // build's own expected MB, and went to Tunelio (coordinator: the rebuild must not be charged to the hour again).
  const expected = VIDEO.seconds * 0.57; // 4104 MB
  const { home, clock, seg } = setup(t, { opts: { hourMb: 6000 } });
  clock.now += IDLE + 1000;
  assert.equal(seg(1), 410, 'dropped unused');
  assert.equal(home.state().hour.mb, Math.round(expected), 'the hour keeps the dropped build at its expected MB (safe side)');
  const OTHER = { id: 'bbbbbbbbbbb', seconds: VIDEO.seconds };
  assert.equal(home.blocks(OTHER, '1080p'), 'hour', 'a DIFFERENT video of the same size: still held by the hour');
  assert.equal(home.blocks(VIDEO, '720p'), 'hour', 'the same video at another quality is another build: held too');
  assert.equal(home.blocks(VIDEO, '1080p'), null, 'the same video and quality: its dropped MB are not charged again');
  const s2 = home.start(VIDEO, '1080p');
  assert.ok(s2, 'the rebuild starts at home');
  assert.equal(home.state().hour.builds, 2, 'both builds stay in the hour count (hourBuilds, the gap)');
  assert.equal(home.state().hour.mb, Math.round(expected), 'the hour holds one expected build of the video, not two');
  assert.equal(home.blocks(VIDEO, '1080p'), 'hour', 'the MB moved once: a third build of it is charged in full');
  clock.now = 1_000_000 + 3600_000 + 30_000; // the dropped build started at 1_000_000, the rebuild 61 s later
  assert.equal(home.state().hour.mb, Math.round(expected), 'the rebuild carries the MB, so they stay for its own hour after the dropped entry leaves');
  assert.equal(home.state().hour.builds, 1);
});

test("#1069: a rebuild that turns out a cache upload gives the dropped build's hour MB back (that build did download)", (t) => {
  const expected = VIDEO.seconds * 0.57;
  const { home, clock, seg } = setup(t, { opts: { hourMb: 6000 } });
  clock.now += IDLE + 1000;
  assert.equal(seg(1), 410);
  const s2 = home.start(VIDEO, '1080p');
  assert.equal(home.state().hour.mb, Math.round(expected));
  assert.equal(home.put(s2.token, 'seg0.ts', Buffer.from('x'), { cached: true }), 204, "from the worker's cache");
  assert.equal(home.state().hour.builds, 1, 'the cache upload leaves the hour (as before #1069)');
  assert.equal(home.state().hour.mb, Math.round(expected), "the dropped build's MB are back, not lost with it");
  assert.equal(home.blocks(VIDEO, '1080p'), null, 'and a next real rebuild can take them over again');
});

test('#1069: a restart keeps the PC move and the dropped mark, and gives a reloaded session a whole window from the restart', (t) => {
  const dir = tmp(t);
  const { s, clock } = setup(t, { dir });
  clock.now += 50_000;
  const meta = JSON.parse(readFileSync(join(dir, s.token, 'meta.json'), 'utf8'));
  assert.equal(meta.leftMs, 1_000_000, 'saved');
  const relay = { enabled: true, capable: () => ['home'], mediaMax: () => ({ home: 2 }), run: () => new Promise(() => {}) };
  const home2 = new Home({ relay, dir, enabled: true, idleMs: IDLE, now: () => clock.now });
  const r = home2.byToken.get(s.token);
  assert.equal(r.leftMs, 1_000_000);
  clock.now += 30_000;
  assert.equal(home2.put(s.token, 'seg1.ts', Buffer.from('y')), 204, '80 s after the move, 30 s after the restart');
  clock.now += 31_000;
  assert.equal(home2.put(s.token, 'seg2.ts', Buffer.from('y')), 410);
  const home3 = new Home({ relay, dir, enabled: true, idleMs: IDLE, now: () => clock.now });
  assert.equal(home3.wasIdle(VIDEO), true, 'idle.json');
});

// The search service with a worker whose uploads the test makes, Tunelio ready, HOME_ANDROID(_GROWING) on.
async function app(t, { idleMs = 300, logs = [], hourMb = 0 } = {}) {
  const dir = tmp(t);
  const { Adaptive } = await import('../src/adaptive.js');
  const job = { id: 'aaaaaaaaaaa', quality: '1080p', state: 'ready', url: 'https://tunelio.dev/t?id=x' };
  const playback = { jobs: new Map(), peek: () => job, status: () => ({ state: 'ready' }), start() {},
    async location() { return { location: job.url, via: 'tunelio', ready: true }; } };
  const adaptive = new Adaptive({ playback, fetcher: codecFetch(), base: 'http://pub/hls' });
  adaptive.pacer = { check: () => ({ ok: true }) };
  const config = { ...base, shards: 2, pool: 50, relayToken: TOKEN, homeRelay: true, homeReadyMs: 5000, homeStartGapMs: 0, homeHourBuilds: 0, homeHourMb: hourMb,
    dbPath: join(dir, 'tickets.db'), publicUrl: 'http://pub', metricsPath: '', homeLongMinutes: 5, homeAndroid: true, homeAndroidGrowing: true, homeIdleMs: idleMs, ticketPin: true };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const relay = new Relay({ token: TOKEN, pollMs: 200 });
  const a = createApp({ adaptiveFetch: codecFetch(), config, store, relay, tunelio: { enabled: true }, playback, adaptive,
    captions: { async get() { return {}; } }, log: (l) => logs.push(typeof l === 'string' ? JSON.parse(l) : l) });
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const jobs = [];
  const put = (token, file, body) => fetch(`${url}/relay/media/${token}/${file}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body });
  const worker = createWorker({ url, token: TOKEN, name: 'home', polls: 1, caps: ['media'], log: () => {}, txBytes: () => null,
    media: async (j) => {
      jobs.push(j);
      await put(j.token, 'seg0.ts', 'ts0');
      await put(j.token, 'index.m3u8', GROWING);
      return { ready: true, segments: 1, done: Promise.resolve() };
    } });
  worker.start();
  t.after(() => worker.stop());
  while (!relay.capable('media').length) await new Promise((r) => setTimeout(r, 20));
  const [n] = store.allocate(0, [{ kind: 'video', data: { id: 'aaaaaaaaaaa', title: 'T', seconds: 7200, live: false } }]);
  const [n2] = store.allocate(1, [{ kind: 'video', data: { id: 'aaaaaaaaaaa', title: 'T', seconds: 7200, live: false } }]);
  const play = (ua, ext = '.m3u8', shard = 0, ticket = n) => fetch(`${url}/v1/${shard}/${ticket}${ext}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  return { play, jobs, url, n, n2, put, home: a.home, logs, tunelio: job.url };
}
const PC = 'NSPlayer/12.00.26100 WMFSDK/12.00';
const QUEST = 'AVProMobileVideo/2026.3.3p2 (Linux;Android 14) ExoPlayer';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#1069 ticket → home: the PC moved to Tunelio leaves a build nobody fetched; it stops; a late PC ask builds nothing, a late Quest ask builds home again', async (t) => {
  const s = await app(t);
  assert.equal((await s.play(PC, '')).headers.get('location'), s.tunelio, 'the PC goes to Tunelio (#127, as before)');
  assert.equal(s.jobs.length, 1, 'the home build it started');
  const token = s.jobs[0].token;
  assert.ok(s.logs.some((l) => l.event === 'home_uneven'));
  assert.equal((await s.put(token, 'seg1.ts', 'ts1')).status, 204, 'inside the window');
  await sleep(450);
  assert.equal((await s.put(token, 'seg2.ts', 'ts2')).status, 410, 'nobody fetched: the worker is stopped');
  assert.equal(s.logs.filter((l) => l.event === 'home_idle').length, 1);
  assert.equal((await fetch(`${s.url}/home/${token}/index.m3u8`)).status, 404, 'the token is gone, not a frozen playlist');
  // A PC in another room: Tunelio, no second home build (no loop).
  assert.equal((await s.play(PC, '', 1, s.n2)).headers.get('location'), s.tunelio);
  assert.equal(s.jobs.length, 1, 'late PC ask: no home build');
  // A Quest arriving late in the first room: a fresh home build, as it would have had the kept copy before.
  const loc = (await s.play(QUEST)).headers.get('location');
  assert.match(loc, /\/home\/[a-f0-9]{18}\/index\.m3u8$/, 'late Quest ask: home again');
  assert.equal(s.jobs.length, 2);
  assert.notEqual(s.jobs[1].token, token);
});

test('#1069 ticket → home: a late Quest ask after a drop gets home although the hour is nearly full with that drop\'s own MB', async (t) => {
  // 7200 s at 1080p is 4104 expected MB; HOME_HOUR_MB 6000 has room for one, as staging's hour had at 23:04Z.
  const s = await app(t, { hourMb: 6000 });
  assert.equal((await s.play(PC, '')).headers.get('location'), s.tunelio, 'the PC goes to Tunelio');
  const token = s.jobs[0].token;
  await sleep(450);
  assert.equal((await s.put(token, 'seg1.ts', 'ts1')).status, 410, 'dropped unused');
  assert.equal(s.home.state().hour.mb, 4104);
  const loc = (await s.play(QUEST)).headers.get('location');
  assert.match(loc, /\/home\/[a-f0-9]{18}\/index\.m3u8$/, 'late Quest ask: home, not held off by the hour');
  assert.equal(s.jobs.length, 2);
  assert.equal(s.home.state().hour.mb, 4104, 'one expected build in the hour');
});

test('#1069 ticket → home: a PC moved off and a Quest in the same room inside the window: the Quest\'s fetch keeps the build going', async (t) => {
  const s = await app(t);
  assert.equal((await s.play(PC, '')).headers.get('location'), s.tunelio);
  const token = s.jobs[0].token;
  const loc = (await s.play(QUEST)).headers.get('location');
  assert.match(loc, new RegExp(`/home/${token}/index\\.m3u8$`), 'the Quest gets the same session');
  assert.equal((await fetch(s.url + loc.replace('http://pub', ''))).status, 200, 'and fetches its playlist');
  await sleep(450);
  assert.equal((await s.put(token, 'seg1.ts', 'ts1')).status, 204, 'past the window, still uploading');
  await sleep(450);
  assert.equal((await s.put(token, 'seg2.ts', 'ts2')).status, 204);
  assert.equal(s.logs.some((l) => l.event === 'home_idle'), false);
  assert.equal(s.jobs.length, 1, 'nothing built twice');
});

test('#1069 ticket → home: a Quest handed the session (not yet fetching) restarts the window; a Quest tablet showing it does too', async (t) => {
  const s = await app(t, { idleMs: 400 });
  assert.equal((await s.play(PC, '')).headers.get('location'), s.tunelio);
  const token = s.jobs[0].token;
  await sleep(250);
  assert.match((await s.play(QUEST)).headers.get('location'), /\/home\//);
  await sleep(250);
  assert.equal((await s.put(token, 'seg1.ts', 'ts1')).status, 204, '500 ms after the move, 250 ms after the Quest was handed it');
  const tablet = await (await fetch(`${s.url}/v1/0/${s.n}.m3u8`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0)' } })).json();
  assert.equal(tablet.plan, 'home');
  await sleep(250);
  assert.equal((await s.put(token, 'seg2.ts', 'ts2')).status, 204, '250 ms after the tablet was shown it');
  await sleep(500);
  assert.equal((await s.put(token, 'seg3.ts', 'ts3')).status, 410, 'then nobody: stopped');
});

test('#1069 worker: a 410 for a growing build kills ffmpeg and keeps no half copy in the cache (a guard: as before #1069)', async (t) => {
  // ffmpeg's stand-in makes segments until it is killed; the upload refuses the third one.
  const { EventEmitter } = await import('node:events');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = tmp(t);
  let killed = null;
  const spawnFn = (cmd, args) => {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    const out = args.at(-1).replace(/index\.m3u8$/, '');
    mkdirSync(out, { recursive: true });
    let i = 0;
    const timer = setInterval(() => {
      writeFileSync(join(out, `seg${i}.ts`), 'x'.repeat(100));
      const lines = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:EVENT'];
      for (let k = 0; k <= i; k++) lines.push(`#EXTINF:${(k % 3) + 2}.0,`, `seg${k}.ts`); // uneven: growing
      writeFileSync(join(out, 'index.m3u8'), `${lines.join('\n')}\n`);
      i++;
    }, 20);
    proc.kill = (sig) => { killed = sig; clearInterval(timer); setImmediate(() => proc.emit('close', null)); return true; };
    return proc;
  };
  const puts = [];
  const cachePuts = [];
  const cache = { get: () => null, staging: () => { const d = join(dir, 'stage'); mkdirSync(d, { recursive: true }); return d; }, put: (...a) => { cachePuts.push(a); return true; } };
  const fetcher = async () => new Response('', { status: 200 });
  const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '1080p', token: 't', seconds: 7200 }, {
    ytdlp: 'yt-dlp', runner: async () => 'https://r.example/videoplayback?clen=100&dur=7200\n', spawnFn, fetcher, pollMs: 10, cache, retryMs: 1,
    upload: async (file) => { puts.push(file); return puts.filter((f) => f !== 'index.m3u8').length > 2 && file !== 'index.m3u8' ? 410 : 204; } });
  await first.done;
  assert.equal(killed, 'SIGKILL', 'ffmpeg is killed');
  assert.equal(cachePuts.length, 0, 'no half copy in the cache (#781)');
  assert.equal(existsSync(join(dir, 'stage')), false, 'its folder is removed');
});

test('#1069: HOME_IDLE_SECONDS defaults to 0, off (coordinator, 2026-11-28: a late Quest rebuild is out of sync; staging sets 30)', { skip: process.env.HOME_IDLE_SECONDS != null }, () => {
  assert.equal(base.homeIdleMs, 0);
  const relay = { enabled: true, capable: () => [], mediaMax: () => ({}), run: () => new Promise(() => {}) };
  assert.equal(new Home({ relay, enabled: true, idleMs: base.homeIdleMs }).state().idleS, 0);
});

test('#1069 default off: a build a PC was moved off and nobody fetches keeps going past 30 s and 10 min, nothing is marked dropped, and a late Quest gets the kept session (as before #1069)', { skip: process.env.HOME_IDLE_SECONDS != null }, async (t) => {
  // Home with the default config's idleMs, on a fake clock.
  const { home, s, clock, logs, events, seg, dir } = setup(t, { idleMs: base.homeIdleMs, opts: { hourMb: 6000 } });
  for (const step of [31_000, 60_000, 600_000]) {
    clock.now += step;
    assert.equal(seg(Math.round(clock.now / 1000)), 204, `still building ${step / 1000} s on`);
  }
  assert.equal(logs.filter((l) => l.event === 'home_idle').length, 0, 'no home_idle');
  assert.ok(!events.includes('idle'), 'no idle event');
  assert.equal(home.wasIdle(VIDEO), false, 'not marked dropped');
  assert.equal(home.idle.size, 0);
  assert.equal(existsSync(join(dir, 'idle.json')), false, 'no idle.json written');
  assert.ok(home.recent.every((r) => !r.dropped && !r.movedTo), 'no hour entry tagged');
  assert.equal(home.peek(VIDEO, '1080p'), s, 'a late ask finds the kept session');
  // Ticket level: the PC moved off, a pause, then a Quest: the same build (no second job, the first token).
  const a = await app(t, { idleMs: base.homeIdleMs });
  assert.equal((await a.play(PC, '')).headers.get('location'), a.tunelio);
  const token = a.jobs[0].token;
  await sleep(450);
  assert.equal((await a.put(token, 'seg1.ts', 'ts1')).status, 204, 'not stopped');
  const loc = (await a.play(QUEST)).headers.get('location');
  assert.match(loc, new RegExp(`/home/${token}/index\\.m3u8$`), 'the late Quest gets the kept session');
  assert.equal(a.jobs.length, 1, 'no rebuild');
});

test('#1069 ticket → home: a PC ask that is moved to Tunelio does not restart the window: two PC asks apart, the stop still comes from the first move', async (t) => {
  const s = await app(t, { idleMs: 400 });
  assert.equal((await s.play(PC, '')).headers.get('location'), s.tunelio, 'room 1\'s PC: Tunelio, the session marked');
  const t0 = Date.now();
  const token = s.jobs[0].token;
  await sleep(200);
  assert.equal((await s.play(PC, '', 1, s.n2)).headers.get('location'), s.tunelio, 'room 2\'s PC, 200 ms on: reuse, then moved to Tunelio too');
  assert.equal(s.jobs.length, 1);
  await sleep(Math.max(0, t0 + 480 - Date.now()));
  assert.equal((await s.put(token, 'seg1.ts', 'ts1')).status, 410, '480 ms after the first move: stopped, although the second PC ask was 280 ms ago');
  assert.equal(s.logs.filter((l) => l.event === 'home_idle').length, 1);
});
