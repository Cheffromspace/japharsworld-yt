import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { CaptionChain } from '../src/captionchain.js';
import { cuesFromJson3, keyFor } from '../src/cues.js';
import { createWorker } from '../relay/worker.js';
import { config as base } from '../src/config.js';

const TOKEN = 'secret-token';
const config = { ...base, shards: 2, pool: 200, relayToken: TOKEN, relayWaitMs: 1500, relayCaptionWaitMs: 5000 }; // the fake worker answers in ms; 1.5 s failed once under load (2026-10-23)
const fixture = (name) => readFileSync(new URL(`./fixtures/captions/${name}`, import.meta.url), 'utf8');
const summary = JSON.parse(fixture('info-summary.json'));

// What relay/captions.js would return, from the fixtures instead of yt-dlp.
function fakeCaptionsJob({ fail = false } = {}) {
  const calls = [];
  const job = async (j) => {
    calls.push(j);
    if (fail) throw new Error('yt-dlp exploded');
    const s = summary[j.videoId];
    if (!s) return { info: { language: null, manual: [], auto: [] }, track: null, cues: null, reason: 'no_captions' };
    const info = { language: s.language, manual: s.subtitles, auto: s.automatic_captions };
    if (!j.want) return { info, track: null, cues: null };
    const full = { subtitles: Object.fromEntries(s.subtitles.map((k) => [k, []])), automatic_captions: Object.fromEntries(s.automatic_captions.map((k) => [k, []])) };
    const want = j.want.lang ? (j.want.lang === 'native' ? { code: s.language, auto: true } : { code: j.want.lang, auto: false }) : j.want;
    let key = keyFor(full, want);
    if (!key && j.want.lang) key = keyFor(full, { code: j.want.lang, auto: true });
    if (!key) return { info, track: null, cues: null, reason: 'no_track_in_language' };
    let raw;
    try { raw = fixture(`${j.videoId}.${key}.json3`); } catch { return { info, track: { key, code: key.replace(/-orig$/, ''), auto: want.auto, format: null }, cues: null, reason: 'temporarily_unavailable' }; }
    return { info, track: { key, code: key.replace(/-orig$/, ''), auto: want.auto, format: 'json3' }, cues: cuesFromJson3(raw) };
  };
  job.calls = calls;
  return job;
}

// A TunelioCaptions stand-in: segment lines only.
function fakeTunelio() {
  const calls = [];
  const tracks = [{ code: 'en', auto: false }, { code: 'en', auto: true }];
  const lines = [[0, 2, 'Hello there'], [2, 2.5, 'how are you']];
  return {
    calls,
    async get(id, lang) { calls.push(['get', id, lang]); return { id, lang, available: true, tracks: tracks.map((t, i) => ({ i, ...t, name: t.code })), track: 0, source: 'manual', key: 'en', lines }; },
    async track(id, i) { calls.push(['track', id, i]); return { id, available: true, tracks: tracks.map((t, n) => ({ i: n, ...t, name: t.code })), track: i, source: tracks[i].auto ? 'auto' : 'manual', key: 'en', lines }; },
    async tracks() { return tracks; },
  };
}

async function start({ tunelio = fakeTunelio(), realWordsOnly = false, now } = {}) {
  const store = new Store({ path: ':memory:', shards: config.shards, pool: config.pool, pinHours: 24, ...(now ? { now } : {}) });
  const logs = [];
  const log = (l) => logs.push(typeof l === 'string' ? JSON.parse(l) : l);
  const relay = new Relay({ token: TOKEN, pollMs: 300 });
  const chain = new CaptionChain({ store, relay, tunelio, relayWaitMs: 1500, realWordsOnly, log });
  const red = await sharp({ create: { width: 32, height: 18, channels: 3, background: '#f7768e' } }).jpeg().toBuffer();
  const app = createApp({ config, store, captions: chain, relay, sheetOpts: { fetcher: async () => red }, log });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => { const res = await fetch(url + path); return { status: res.status, body: await res.json() }; };
  const workers = [];
  const startWorker = (captions, name = 'optiplex', opts = {}) => {
    const w = createWorker({ url, token: TOKEN, name, version: 'test', polls: 1, captions, log: () => {}, ...opts });
    workers.push(w); w.start(); return w;
  };
  const waitOnline = async () => { for (let i = 0; i < 100 && !relay.online().length; i++) await new Promise((r) => setTimeout(r, 10)); };
  const offline = async (w, name = 'optiplex') => {
    w.stop();
    const info = relay.workers.get(name);
    for (let i = 0; i < 100 && info.polling; i++) await new Promise((r) => setTimeout(r, 10));
    info.seen -= 60_000;
  };
  const close = () => { workers.forEach((w) => w.stop()); server.closeAllConnections(); server.close(); };
  return { app, get, store, relay, chain, logs, tunelio, startWorker, waitOnline, offline, close };
}

test('captions come from the worker with word timing; the picker lists uploader tracks then the original auto track', async (t) => {
  const s = await start();
  t.after(s.close);
  const job = fakeCaptionsJob();
  s.startWorker(job);
  await s.waitOnline();
  s.store.markPlayed(1, 7, 'dQw4w9WgXcQ');
  const r = await s.get('/v1/1/cc/en');
  assert.equal(r.status, 200);
  assert.equal(r.body.t, 7);
  assert.equal(r.body.available, true);
  assert.equal(r.body.via, 'worker');
  assert.deepEqual(r.body.tracks.map((x) => [x.code, x.auto]), [['en', false], ['de-DE', false], ['ja', false], ['pt-BR', false], ['es-419', false], ['en', true]]);
  assert.equal(r.body.track, 0);
  assert.equal(r.body.source, 'manual');
  assert.equal(r.body.words, 'estimated', 'an uploader track has no word timing');
  assert.ok(r.body.chunks.every((c) => /^\d+:\d+(,\d+:\d+)*$/.test(c[4])), 'flag off: estimated word offsets go to the world');
  assert.ok(r.body.lines.length > 10 && r.body.chunks.length > 10);
  assert.equal(job.calls.length, 1, 'list and the visitor\'s track in one yt-dlp job');
  assert.deepEqual(job.calls[0].want, { lang: 'en' });

  // The same answer again is served from the cache; the original auto track is a second job and has real words.
  await s.get('/v1/1/cc/en');
  assert.equal(job.calls.length, 1);
  const auto = await s.get('/v1/1/cc/5');
  assert.equal(auto.body.track, 5);
  assert.equal(auto.body.source, 'auto');
  assert.equal(auto.body.words, 'real');
  assert.ok(auto.body.chunks.every((c) => c.length === 5 && /^\d+:\d+(,\d+:\d+)*$/.test(c[4])));
  assert.equal(job.calls.length, 2);
  assert.deepEqual(job.calls[1].want, { code: 'en', auto: true });
  assert.deepEqual(s.tunelio.calls, [], 'Tunelio was never asked');
  assert.deepEqual(s.logs.filter((l) => l.event === 'captions_via').map((l) => l.via), ['worker', 'worker']);
});

test('CAPTION_REAL_WORDS_ONLY: an uploader track sends no word offsets, the auto track keeps its real ones (world #260)', async (t) => {
  const s = await start({ realWordsOnly: true });
  t.after(s.close);
  s.startWorker(fakeCaptionsJob());
  await s.waitOnline();
  s.store.markPlayed(1, 7, 'dQw4w9WgXcQ');
  const r = await s.get('/v1/1/cc/en');
  assert.equal(r.body.source, 'manual');
  assert.equal(r.body.words, 'estimated', 'the field the world reads for its note is unchanged');
  assert.ok(r.body.chunks.length > 10 && r.body.chunks.every((c) => c.length === 5 && c[4] === ''));
  const auto = await s.get('/v1/1/cc/5');
  assert.equal(auto.body.words, 'real');
  assert.ok(auto.body.chunks.every((c) => /^\d+:\d+(,\d+:\d+)*$/.test(c[4])));
});

test('a language the video lacks: no_track_in_language, and the list still shows', async (t) => {
  const s = await start();
  t.after(s.close);
  // No back-off here: the "th" track has no fixture, so its download fails (temporarily_unavailable, a `rate`
  // refusal), which would pause the worker's captions and send the second video to Tunelio (test/relay.test.js).
  s.startWorker(fakeCaptionsJob(), 'optiplex', { backoffMinutes: 0 });
  await s.waitOnline();
  s.store.markPlayed(0, 3, 'dQw4w9WgXcQ');
  const r = await s.get('/v1/0/cc/th');
  assert.equal(r.body.available, false);
  assert.equal(r.body.reason, 'no_track_in_language');
  assert.equal(r.body.tracks.length, 6);
  s.store.markPlayed(1, 4, 'Sc9hJrAzBJo');
  const none = await s.get('/v1/1/cc/ko');
  assert.equal(none.body.reason, 'no_captions');
});

test('no worker online: Tunelio answers with estimated words; a failing worker falls through to Tunelio too', async (t) => {
  const s = await start();
  t.after(s.close);
  s.store.markPlayed(1, 9, 'dQw4w9WgXcQ');
  const r = await s.get('/v1/1/cc/en');
  assert.equal(r.body.via, 'tunelio');
  assert.equal(r.body.words, 'estimated');
  assert.deepEqual(r.body.lines, [[0, 2, 'Hello there'], [2, 2.5, 'how are you']]);
  assert.deepEqual(r.body.chunks.map((c) => c[2]), ['Hello there how are you'], 'two unpunctuated segments with no gap read as one line');
  assert.deepEqual(s.tunelio.calls, [['get', 'dQw4w9WgXcQ', 'en']]);

  const w = s.startWorker(fakeCaptionsJob({ fail: true }));
  await s.waitOnline();
  s.store.markPlayed(0, 2, 'UF8uR6Z6KLc');
  const r2 = await s.get('/v1/0/cc/en');
  assert.equal(r2.body.via, 'tunelio');
  assert.equal(s.logs.filter((l) => l.event === 'captions_source_failed').at(-1).via, 'worker');
  await s.offline(w);
});

test('a cached list from one source keeps its numbering when another source fetches a track', async (t) => {
  const s = await start();
  t.after(s.close);
  // Tunelio learned the list first (worker offline)...
  s.store.markPlayed(1, 1, 'dQw4w9WgXcQ');
  const first = await s.get('/v1/1/cc/en');
  assert.equal(first.body.via, 'tunelio');
  assert.deepEqual(first.body.tracks.map((x) => [x.code, x.auto]), [['en', false], ['en', true]]);
  // ...then a worker came online: track 1 (auto) is fetched by it under the same number, with real words.
  const job = fakeCaptionsJob();
  s.startWorker(job);
  await s.waitOnline();
  const auto = await s.get('/v1/1/cc/1');
  assert.equal(auto.body.via, 'worker');
  assert.equal(auto.body.track, 1);
  assert.equal(auto.body.words, 'real');
  assert.deepEqual(job.calls[0].want, { code: 'en', auto: true });
  assert.deepEqual(auto.body.tracks.map((x) => [x.code, x.auto]), [['en', false], ['en', true]], 'the room keeps the list it already has');
});

test('tracks: the list alone comes from a free source and never from Tunelio', async (t) => {
  const s = await start();
  t.after(s.close);
  // No free source up: it says so instead of paying for a transcript.
  const dry = await s.chain.tracks('dQw4w9WgXcQ', 'ja');
  assert.equal(dry.available, false);
  assert.equal(dry.reason, 'list_unavailable');
  assert.deepEqual(s.tunelio.calls, []);
  const job = fakeCaptionsJob();
  s.startWorker(job);
  await s.waitOnline();
  const list = await s.chain.tracks('dQw4w9WgXcQ', 'ja');
  assert.equal(list.available, true);
  assert.equal(list.track, -1);
  assert.ok(list.tracks.length > 0);
  assert.ok(list.tracks.every((x, i) => x.i === i && typeof x.name === 'string' && typeof x.auto === 'boolean'));
  assert.equal(job.calls.length, 1);
  assert.equal(job.calls[0].want, null);
  assert.deepEqual(s.tunelio.calls, []);
  // Cached: a second ask costs nothing more, and a track pick keeps the same numbering.
  const again = await s.chain.tracks('dQw4w9WgXcQ', 'en');
  assert.deepEqual(again.tracks.map((x) => x.code), list.tracks.map((x) => x.code));
  assert.equal(job.calls.length, 1);
});

test('warm: the free source is asked when a video plays, Tunelio is not', async (t) => {
  const s = await start();
  t.after(s.close);
  s.chain.warm('dQw4w9WgXcQ');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.tunelio.calls, []);
  const job = fakeCaptionsJob();
  s.startWorker(job);
  await s.waitOnline();
  s.chain.warm('dQw4w9WgXcQ');
  for (let i = 0; i < 100 && job.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(job.calls[0].want, { lang: 'native' });
});

// A relay stand-in that answers caption jobs from `answers` in turn (the last one repeats), after `delayMs`.
function scriptedRelay(answers, delayMs = 0) {
  const calls = [];
  return {
    calls, enabled: true, online: () => ['optiplex'],
    async captions(videoId, want) {
      calls.push(want);
      await new Promise((r) => setTimeout(r, delayMs));
      return answers[Math.min(calls.length - 1, answers.length - 1)];
    },
  };
}
const emptyInfo = { info: { language: null, manual: [], auto: [] }, track: null, cues: null, reason: 'no_captions' };
const someInfo = { info: { language: 'en', manual: [], auto: ['en', 'de'] }, track: null, cues: null };

test('an empty list is suspect: looked up once more after 3 minutes, then kept for 30 minutes only (2026-10-25)', async () => {
  let now = 1_000_000;
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 24, now: () => now });
  const relay = scriptedRelay([emptyInfo, emptyInfo, someInfo]);
  const chain = new CaptionChain({ store, relay, log: () => {} });
  assert.equal((await chain.tracks('aaaaaaaaaaa')).reason, 'no_captions');
  assert.equal(relay.calls.length, 1);
  assert.equal((await chain.tracks('aaaaaaaaaaa')).reason, 'no_captions', 'within 3 minutes: the first answer stands');
  assert.equal(relay.calls.length, 1);
  now += 3 * 60_000 + 1;
  assert.equal((await chain.tracks('aaaaaaaaaaa')).reason, 'no_captions', 'after 3 minutes the next request looks once more');
  assert.equal(relay.calls.length, 2);
  assert.equal((await chain.tracks('aaaaaaaaaaa')).reason, 'no_captions', 'twice empty: kept');
  assert.equal(relay.calls.length, 2);
  now += 31 * 60_000;
  const later = await chain.tracks('aaaaaaaaaaa');
  assert.equal(relay.calls.length, 3, 'looked up again after 30 minutes');
  assert.equal(later.available, true);
  assert.ok(later.tracks.length > 0);

  // An empty answer and then the real list on the retry: the list is kept for the usual 7 days.
  const flaky = scriptedRelay([emptyInfo, someInfo]);
  const chain2 = new CaptionChain({ store, relay: flaky, log: () => {} });
  assert.equal((await chain2.tracks('bbbbbbbbbbb')).reason, 'no_captions');
  now += 3 * 60_000 + 1;
  assert.equal((await chain2.tracks('bbbbbbbbbbb')).available, true);
  now += 6 * 86400_000;
  assert.equal((await chain2.tracks('bbbbbbbbbbb')).available, true);
  assert.equal(flaky.calls.length, 2);
});

test('the CC list waits for the play\'s warm-up instead of a second lookup (2026-10-25)', async () => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 24 });
  const relay = scriptedRelay([someInfo], 50);
  const chain = new CaptionChain({ store, relay, log: () => {} });
  chain.warm('ccccccccccc');
  await new Promise((r) => setTimeout(r, 10));
  const list = await chain.tracks('ccccccccccc');
  assert.equal(list.available, true);
  assert.ok(!relay.calls.includes(null), 'the list did not look up on its own');
  assert.deepEqual(relay.calls[0], { lang: 'native' });
});

// World #428: distinct videos over 6 h, as two counts, for eiok-captions-empty.
test('cc_outcome: once per video and result per 6 h, nothing for a lookup with no list, no ID in the count', () => {
  const incs = [];
  const chain = new CaptionChain({ store: {}, metrics: { inc: (m, k) => incs.push([m, k]) } });
  const H = 3600_000;
  chain.countOutcome('vidA', 0, 0);
  chain.countOutcome('vidA', 0, H);
  chain.countOutcome('vidB', 0, H);
  chain.countOutcome('vidA', 3, H);
  chain.countOutcome('vidA', 5, 2 * H);
  chain.countOutcome('vidC', null, H);
  chain.countOutcome('vidC', undefined, H);
  assert.deepEqual(incs, [['cc_outcome', 'none'], ['cc_outcome', 'none'], ['cc_outcome', 'tracks']]);
  chain.countOutcome('vidA', 0, 6 * H - 1);
  assert.equal(incs.length, 3, 'still inside the window');
  chain.countOutcome('vidA', 0, 6 * H);
  assert.equal(incs.length, 4, 'counts again once the window has passed');
  chain.countOutcome('vidZ', 0, 100 * H);
  assert.deepEqual([...chain.outcomes.keys()], ['vidZ:none'], 'old IDs are dropped');
});

test('cc_outcome: a real list lookup through the chain counts its result', async () => {
  const incs = [];
  const store = { captionGet: () => null, captionPut: () => {} };
  const chain = new CaptionChain({ store, metrics: { inc: (m, k) => { if (m === 'cc_outcome') incs.push(k); } } });
  chain.sources = () => [['worker', async () => ({ tracks: [], cues: null })]];
  await chain.resolve('vidA', null);
  chain.sources = () => [['worker', async () => ({ tracks: [{ code: 'en', auto: true }], cues: null })]];
  await chain.resolve('vidB', null);
  assert.deepEqual(incs, ['none', 'tracks']);
});

// World #428: what eiok-captions-failing reads. Every source throwing counts nothing in cc_outcome.
test('every source throwing: temporarily_unavailable from get and tracks, no cc_outcome', async () => {
  const incs = [];
  const store = { captionGet: () => null, captionPut: () => {} };
  const chain = new CaptionChain({ store, local: { blocked: false }, metrics: { inc: (m, k) => incs.push([m, k]) } });
  chain.sources = () => [['worker', async () => { throw new Error('a'); }], ['local', async () => { throw new Error('b'); }]];
  assert.equal((await chain.get('vidA', 'en')).reason, 'temporarily_unavailable');
  assert.equal((await chain.tracks('vidA', 'en')).reason, 'temporarily_unavailable');
  assert.deepEqual(incs, []);
});

// Everything-is-OK#680: nothing called Store.pruneCaptions, so tickets.db kept every caption track ever fetched.
test('the sweep removes caption rows older than the cache reads (CAPTION_CACHE_DAYS), keeps fresh ones, about hourly', async (t) => {
  const DAY = 86400_000;
  let now = Date.parse('2026-11-01T00:00:00Z');
  const s = await start({ now: () => now });
  t.after(s.close);
  const rows = (id) => s.store.db.prepare('SELECT COUNT(*) n FROM captions WHERE video_id = ?').get(id).n;
  const fetches = (id) => s.tunelio.calls.filter((c) => c[1] === id).length;
  const cc = async (id) => { s.store.markPlayed(0, 1, id); return (await s.get('/v1/0/cc/en')).body; };
  assert.equal(config.captionCacheDays, 7);

  assert.equal((await cc('oldVideo001')).available, true);
  now += 6 * DAY;
  assert.equal((await cc('newVideo002')).available, true);
  assert.ok(rows('oldVideo001') > 0 && rows('newVideo002') > 0);
  assert.deepEqual([fetches('oldVideo001'), fetches('newVideo002')], [1, 1]);

  // Two days on: the first video's rows are 8 days old, past any reader; the second's are 2 days old.
  now += 2 * DAY;
  let prunes = 0;
  const prune = s.store.pruneCaptions.bind(s.store);
  s.store.pruneCaptions = (ms) => { prunes++; return prune(ms); };
  s.app.sweep();
  assert.equal(rows('oldVideo001'), 0, 'rows older than CAPTION_CACHE_DAYS are gone');
  assert.ok(rows('newVideo002') > 0, 'fresh rows stay');
  assert.deepEqual(s.logs.filter((l) => l.event === 'captions_pruned').map((l) => l.rows > 0), [true]);
  assert.equal((await cc('newVideo002')).available, true);
  assert.equal(fetches('newVideo002'), 1, 'and are still answered from the cache');

  // A pruned video's captions are fetched and cached again like any new video's.
  const again = await cc('oldVideo001');
  assert.deepEqual([again.available, again.lines.length > 0], [true, true]);
  assert.equal(fetches('oldVideo001'), 2);
  assert.ok(rows('oldVideo001') > 0);
  await cc('oldVideo001');
  assert.equal(fetches('oldVideo001'), 2, 'cached again');

  // The sweep runs every minute; the prune reads the whole table, so it runs at most hourly. A failing prune is logged
  // and never thrown out of the timer.
  s.app.sweep();
  assert.equal(prunes, 1);
  const quiet = await start();
  t.after(quiet.close);
  quiet.store.pruneCaptions = () => { throw new Error('database is locked'); };
  quiet.app.sweep();
  assert.deepEqual(quiet.logs.filter((l) => l.event === 'captions_prune_failed').map((l) => l.message), ['database is locked']);
});
