// Service unit tests from the suite catalogue (world repo Tests/SUITE.md, group "Service unit tests"): one test per SV-
// row, its ID first in the name, so a failing run names the scenario. Written 2026-10-28 for the ten best-value rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, shutdown } from '../src/server.js';
import { Store } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { Home } from '../src/home.js';
import { Playback } from '../src/playback.js';
import { Adaptive } from '../src/adaptive.js';
import { dayOf } from '../src/metrics.js';
import { createWorker } from '../relay/worker.js';
import { alertRules } from '../tools/grafana.mjs';
import { config as base } from '../src/config.js';

const TOKEN = 'secret-token';
const PL1 = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\nseg0.ts\n';
const PC = 'NSPlayer/12.00.26100 WMFSDK/12.00';
const QUEST = 'AVProMobileVideo/2026.3.3p2 (Linux;Android 14) ExoPlayer';
const TABLET = 'UnityPlayer/2022.3 (UnityWebRequest/1.0)';
const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'sv-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const watch = (id) => `https://www.youtube.com/watch?v=${id}`;

function fakeTunelio({ fail = null } = {}) {
  const calls = [];
  return { calls, enabled: true, async create(id, q) {
    calls.push([id, q]);
    if (fail) { const e = new Error(`answered ${fail}`); e.status = fail; throw e; }
    return { url: `https://tunelio.dev/tunnel?id=${id}&q=${q}`, expires: Math.floor(Date.now() / 1000) + 3600, quality: q, fileSize: 100e6 };
  } };
}
const fakeMetrics = () => {
  const counts = [];
  return { counts, closed: false, inc(m, k, n = 1) { counts.push([m, k, n]); }, gauge() {}, latency() {}, shard() {}, flush() { return 0; }, start() { return this; },
    close() { this.closed = true; }, has(m, k) { return counts.some(([a, b]) => a === m && b === k); } };
};
// A real app on port 0 with one video ticket; with `worker`, a home relay media worker that uploads seg0 and a playlist.
async function app(t, { worker = false, video = {}, pool = 50, config: c = {}, playlist = PL1, ...over } = {}) {
  const dir = tmp(t);
  const lines = [];
  const metrics = fakeMetrics();
  const config = { ...base, shards: 2, pool, relayToken: TOKEN, homeRelay: true, homeReadyMs: 5000, dbPath: join(dir, 'tickets.db'), publicUrl: 'http://pub', metricsPath: '', ...c };
  const store = new Store({ path: ':memory:', shards: 2, pool, pinHours: 24 });
  const relay = new Relay({ token: TOKEN, pollMs: 200 });
  const a = createApp({ config, store, relay, metrics, tunelio: { enabled: false }, captions: { async get() { return {}; } },
    log: (l) => lines.push(typeof l === 'string' ? JSON.parse(l) : l), ...over });
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const jobs = [];
  if (worker) {
    const w = createWorker({ url, token: TOKEN, name: 'home', polls: 1, caps: ['media'], log: () => {}, txBytes: () => null,
      media: async (job) => {
        jobs.push(job);
        const put = (file, body) => fetch(`${url}/relay/media/${job.token}/${file}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body });
        await put('seg0.ts', 'ts0');
        await put('index.m3u8', playlist);
        return { ready: true, segments: 1, done: Promise.resolve() };
      } });
    w.start();
    t.after(() => w.stop());
    while (!relay.capable('media').length) await new Promise((r) => setTimeout(r, 20));
  }
  const [n] = store.allocate(0, [{ kind: 'video', data: { id: 'aaaaaaaaaaa', title: 'T', seconds: 600, live: false, ...video } }]);
  const play = (ua, ext = '') => fetch(`${url}/v1/0/${n}${ext}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  return { a, server, url, play, jobs, lines, metrics, store, n, dir, relay };
}
// A playback whose every build fails part way (Tunelio's link answered, the build then broke).
const failingPlayback = () => ({ jobs: new Map(), pausedUntil: 0, peek: () => null, status: () => ({ state: 'failed', reason: 'build_failed' }), start() {},
  async location(data) { return { location: watch(data.id), via: 'youtube', reason: 'build_failed', ready: true }; } });
const okPacer = (playback) => { const ad = new Adaptive({ playback, base: 'http://pub/hls' }); ad.pacer = { check: () => ({ ok: true }) }; return ad; };

test('SV-022 a Tunelio build that fails part way: build_failed with its status, the player to youtube, a new job only after 30 s', async () => {
  let now = 1_000_000;
  const logs = [];
  const tunelio = fakeTunelio();
  let probes = 0;
  const p = new Playback({ tunelio, now: () => now, log: (o) => logs.push(o), probe: async () => { probes++; return { ok: false, refused: false, status: 0, error: 'TimeoutError' }; } });
  const r = await p.location({ id: 'midway00001', seconds: 600 });
  assert.deepEqual([r.via, r.reason, r.location, r.ready], ['youtube', 'build_failed', watch('midway00001'), true]);
  const failed = logs.find((o) => o.event === 'build_failed');
  assert.deepEqual([failed?.reason, failed?.status, failed?.error], ['build_failed', 0, 'TimeoutError']);
  now += 20_000;
  assert.equal((await p.location({ id: 'midway00001', seconds: 600 })).reason, 'build_failed', 'within 30 s: the failed job answers');
  assert.deepEqual([tunelio.calls.length, probes], [1, 1], 'within 30 s: no new /create and no new build');
  now += 11_000;
  await p.location({ id: 'midway00001', seconds: 600 });
  assert.equal(probes, 2, 'after 30 s the build is tried again');
  assert.equal(tunelio.calls.length, 1, 'on the same cached link: one paid /create per video while it lasts');
});

test('SV-023 a failed Tunelio build goes home when a media worker is free (home_why tunelio_failed), else to youtube (play_fallback build_failed)', async (t) => {
  const playback = failingPlayback();
  const withWorker = await app(t, { worker: true, playback, adaptive: okPacer(playback), tunelio: { enabled: true } });
  const r = await withWorker.play(PC);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^http:\/\/pub\/home\/[a-f0-9]{18}\/index\.m3u8$/);
  assert.ok(withWorker.metrics.has('home_why', 'tunelio_failed'));
  const play = withWorker.lines.find((l) => l.event === 'play');
  assert.deepEqual([play?.via, play?.reason], ['home', 'tunelio_failed']);
  assert.equal(withWorker.jobs.length, 1);

  const playback2 = failingPlayback();
  const noWorker = await app(t, { playback: playback2, adaptive: okPacer(playback2), tunelio: { enabled: true } });
  const y = await noWorker.play(PC);
  assert.equal(y.headers.get('location'), watch('aaaaaaaaaaa'));
  assert.ok(noWorker.metrics.has('play_fallback', 'build_failed'));
  assert.equal(noWorker.lines.find((l) => l.event === 'play')?.reason, 'build_failed');
});

test('SV-037 PC and Quest on one growing home session: after the PC leaves, the worker\'s PUT stays 204 and the Quest\'s GETs keep working', async (t) => {
  const job = { id: 'aaaaaaaaaaa', quality: '1080p', state: 'ready', url: 'https://tunelio.dev/t?id=x' };
  const playback = { jobs: new Map(), peek: () => job, status: () => ({ state: 'ready' }), start() {},
    async location() { return { location: job.url, via: 'tunelio', ready: true }; } };
  const s = await app(t, { worker: true, playback, adaptive: okPacer(playback), tunelio: { enabled: true },
    config: { homeLongMinutes: 5, homeAndroid: true, homeAndroidGrowing: true } });
  const loc = (await s.play(QUEST, '.m3u8')).headers.get('location');
  assert.match(loc, /\/home\/[a-f0-9]{18}\/index\.m3u8$/);
  assert.equal((await s.play(PC)).headers.get('location'), job.url, 'the PC leaves for Tunelio');
  assert.ok(s.lines.some((l) => l.event === 'home_uneven' && l.kept === true));
  assert.ok(!s.lines.some((l) => l.event === 'home_failed'));
  assert.ok(JSON.parse(readFileSync(join(s.dir, 'home', 'uneven.json'), 'utf8')).aaaaaaaaaaa > Date.now(), 'remembered as uneven');
  for (const seg of ['seg1.ts', 'seg2.ts']) {
    const put = await fetch(`${s.url}/relay/media/${s.jobs[0].token}/${seg}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body: seg });
    assert.equal(put.status, 204, `${seg}: 204, not 410`);
    const get = await fetch(s.url + loc.replace('http://pub', '').replace('index.m3u8', seg), { headers: { 'user-agent': QUEST } });
    assert.equal(get.status, 200);
    assert.equal(await get.text(), seg);
  }
  const gets = s.lines.filter((l) => l.event === 'home_get' && /^seg[12]\.ts$/.test(l.file));
  assert.deepEqual(gets.map((l) => [l.file, l.found]), [['seg1.ts', true], ['seg2.ts', true]]);
});

test('SV-053 shutdown (SIGTERM): the relay drains, metrics close, today\'s home use is written to day.json, then the process exits', async (t) => {
  const s = await app(t, { worker: true });
  let drained = 0;
  const drain = s.relay.drain.bind(s.relay);
  s.relay.drain = () => { drained++; return drain(); };
  const home = s.a.home;
  const sess = home.start({ id: 'bbbbbbbbbbb', seconds: 3600 }, '1080p');
  home.put(sess.token, 'seg0.ts', Buffer.alloc(1_000_000));
  home.put(sess.token, 'index.m3u8', Buffer.from(PL1));
  home.put(sess.token, 'seg1.ts', Buffer.alloc(2_000_000)); // within 30 s of the last save: only in memory
  const day = () => JSON.parse(readFileSync(join(s.dir, 'home', 'day.json'), 'utf8'));
  assert.equal(Math.round(day().mb), 1, 'not yet on disk');
  const exited = new Promise((r) => shutdown(s.a, null, { exit: r, waitMs: 10 }));
  assert.equal(await exited, 0, 'exits with 0');
  assert.equal(drained, 1);
  assert.equal(s.metrics.closed, true);
  assert.equal(Math.round(day().mb), 3, 'the in-memory MB written');
});

test('SV-051 the home day follows Chicago across both DST changes: one reset per calendar day', (t) => {
  const at = (iso) => dayOf(Date.parse(iso));
  // 2026-03-08: CST until 08:00Z (02:00 local), CDT after. Midnight was 06:00Z that day, 05:00Z the next.
  assert.deepEqual(['2026-03-08T05:59Z', '2026-03-08T06:00Z', '2026-03-08T07:59Z', '2026-03-08T08:01Z', '2026-03-09T04:59Z', '2026-03-09T05:00Z'].map((x) => at(x.replace('Z', ':00Z'))),
    ['2026-03-07', '2026-03-08', '2026-03-08', '2026-03-08', '2026-03-08', '2026-03-09']);
  // 2026-11-01: CDT until 07:00Z (02:00 local), CST after. Midnight was 05:00Z that day, 06:00Z the next.
  assert.deepEqual(['2026-11-01T04:59Z', '2026-11-01T05:00Z', '2026-11-01T06:59Z', '2026-11-01T07:01Z', '2026-11-02T05:59Z', '2026-11-02T06:00Z'].map((x) => at(x.replace('Z', ':00Z'))),
    ['2026-10-31', '2026-11-01', '2026-11-01', '2026-11-01', '2026-11-01', '2026-11-02']);
  // Home's count: a build on the 25-hour day of 2026-11-01 counts until Chicago midnight, then a new day starts.
  let now = Date.parse('2026-11-01T05:30:00Z');
  const home = new Home({ relay: { enabled: true, capable: () => ['home'], run() { return new Promise(() => {}); } }, dir: tmp(t), base: 'https://yt/home', enabled: true, now: () => now });
  home.start({ id: 'ccccccccccc', seconds: 600 }, '720p');
  now = Date.parse('2026-11-02T05:59:00Z');
  assert.equal(home.state().today.builds, 1, '23:59 CST, same day');
  now = Date.parse('2026-11-02T06:00:00Z');
  assert.equal(home.state().today.builds, 0, 'midnight CST: a new day');
});

test('SV-072 concurrent searches on one shard get disjoint tickets', async (t) => {
  const videos = (q) => Array.from({ length: 5 }, (_, i) => ({ id: `${q.padEnd(9, 'x').slice(0, 9)}${String(i).padStart(2, '0')}`, title: q, channel: 'c', length: '1:00', seconds: 60, views: '', age: '', live: false }));
  const youtube = { async search(q) { await new Promise((r) => setTimeout(r, Math.random() * 20)); return { videos: videos(String(q)), more: null }; }, thumbnailUrl: () => '' };
  const s = await app(t, { youtube, pool: 100 }); // 10 × (5 videos + sheet) fits; a smaller pool wraps round-robin by design
  const pages = await Promise.all(Array.from({ length: 10 }, (_, i) => fetch(`${s.url}/v1/0/s?l=en&q=q${i}`, { headers: { 'user-agent': TABLET } }).then((r) => r.json())));
  const tickets = pages.flatMap((p) => p.results.map((r) => r.t));
  assert.equal(tickets.length, 50, 'every search answered with its 5 results');
  assert.equal(new Set(tickets).size, tickets.length, 'no ticket handed to two searches');
  assert.ok(!s.lines.some((l) => /SQLITE_BUSY/.test(JSON.stringify(l))));
});

test('SV-084 /healthz carries its documented fields, and busy counts a held player until it is answered', async (t) => {
  let release;
  const held = new Promise((r) => { release = r; });
  const playback = { jobs: new Map(), pausedUntil: 0, peek: () => null, status: () => ({ state: 'building' }), start() {},
    async location() { await held; return { location: 'https://tunelio.dev/t?id=x&progressive=1', via: 'tunelio', ready: true }; } };
  const s = await app(t, { playback, adaptive: okPacer(playback), tunelio: { enabled: true, credits: 7 }, config: { homeRelay: false } });
  const health = async () => (await fetch(`${s.url}/healthz`)).json();
  const idle = await health();
  for (const k of ['ok', 'v', 'tunelio', 'credits', 'workers', 'lastSearchVia', 'apiUnitsToday', 'busy']) assert.ok(k in idle, k);
  assert.deepEqual([idle.ok, idle.busy, idle.credits], [true, 0, 7]);
  const playing = s.play(PC);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await health()).busy, 1, 'a held player keeps deploy/update.sh waiting');
  release();
  assert.equal((await playing).status, 302);
  assert.equal((await health()).busy, 0);
});

test('SV-025 SV-080 Tunelio errors: 401 alerts auth and pauses, 503 alerts tunelio_down, a 404 or 400 alerts nothing and does not pause', async () => {
  const run = async (status) => {
    const alerts = [];
    const alert = Object.assign((kind) => alerts.push(kind), { resolve() {} });
    const logs = [];
    const p = new Playback({ tunelio: fakeTunelio({ fail: status }), alert, log: (o) => logs.push(o) });
    const r = await p.location({ id: `err${status}00000`.slice(0, 11), seconds: 600 });
    return { alerts, logs, r, paused: p.pausedUntil > Date.now() };
  };
  const auth = await run(401);
  assert.deepEqual(auth.alerts, ['auth']);
  assert.equal(auth.paused, true);
  assert.equal(auth.logs.find((o) => o.event === 'tunelio_error')?.status, 401);
  const down = await run(503);
  assert.deepEqual(down.alerts, ['tunelio_down']);
  assert.equal(down.paused, false, 'a 5xx alerts but does not pause');
  for (const status of [404, 400]) {
    const quiet = await run(status);
    assert.deepEqual(quiet.alerts, [], `${status}: no alert`);
    assert.equal(quiet.paused, false);
    assert.deepEqual([quiet.r.via, quiet.r.reason], ['youtube', 'tunelio_failed']);
  }
});

test('SV-093 alert thresholds are pinned (a change has to change this table)', () => {
  const rules = Object.fromEntries(alertRules('${ds}').map((r) => [r.uid, r]));
  const want = {
    'eiok-home-egress-day': ['> 100e9', '5m'],      // no ISP cap (owner, 2026-10-27)
    'eiok-home-egress-month': ['> 2000e9', '5m'],
    'eiok-linode-egress-month': ['> 700e9', '5m'],  // of the Linode's 1 TB
    'eiok-linode-disk-80': ['> 0.8', '15m'],
    'eiok-linode-disk-88': ['> 0.88', '15m'],
    'eiok-disk-low': ['> 0.9', '15m'],
    'eiok-home-cap': ['>= 0.9', '5m'],
    'eiok-ssh-failed-spike': ['> 20', '0m'],
    'eiok-cert-expiry': ['14 - ', '60m'],
    'eiok-domain-expiry': ['30 - ', '60m'],
    'eiok-domain-expiry-urgent': ['7 - ', '60m'],
  };
  for (const [uid, [lit, forM]] of Object.entries(want)) {
    assert.ok(rules[uid], `${uid} exists`);
    assert.ok(rules[uid].data[0].model.expr.includes(lit), `${uid}: ${lit}`);
    assert.equal(rules[uid].for, forM, `${uid}: for ${forM}`);
  }
});

test('SV-012 /ops/plan validates id, mode and minutes, and needs the token', async (t) => {
  const s = await app(t, { config: { statsToken: 'tok', adaptiveHls: true } });
  const post = (qs, auth = true) => fetch(`${s.url}/ops/plan?${qs}`, { method: 'POST', headers: auth ? { authorization: 'Bearer tok' } : {} });
  assert.equal((await post('id=short&mode=start')).status, 400);
  assert.equal((await (await post('id=short&mode=start')).json()).error, 'bad_id');
  assert.equal((await (await post('id=aaaaaaaaaaa&mode=fast')).json()).error, 'bad_mode');
  const before = Date.now();
  const ok = await (await post('id=aaaaaaaaaaa&mode=start&minutes=9999')).json();
  const until = Date.parse(ok.forced.find((f) => f.id === 'aaaaaaaaaaa')?.until);
  assert.ok(until <= before + 240 * 60_000 + 5_000 && until > before + 239 * 60_000, 'minutes capped at 240');
  assert.notEqual((await post('id=aaaaaaaaaaa&mode=start', false)).status, 200, 'no token: refused');
  const cleared = await (await post('id=aaaaaaaaaaa&mode=clear')).json();
  assert.ok(!cleared.forced.some((f) => f.id === 'aaaaaaaaaaa'), 'clear removes it');
  assert.ok(existsSync(s.dir));
});
