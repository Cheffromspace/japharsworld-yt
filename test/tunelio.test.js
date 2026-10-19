import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Tunelio } from '../src/tunelio.js';
import { Playback } from '../src/playback.js';
import { TunelioCaptions, orderTracks, pickTrack, displayName } from '../src/transcripts.js';
import { makeAlert } from '../src/alert.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { config as base } from '../src/config.js';

const respond = (status, body, credits) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...(credits != null ? { 'x-credits-remaining': String(credits) } : {}) } });

test('Tunelio client: create, transcript, credits, errors', async () => {
  const seen = [];
  const t = new Tunelio({ key: 'tnl_x', fetcher: async (url, opts) => {
    seen.push([url, opts.headers.authorization]);
    if (url.includes('/create')) return respond(200, { url: 'https://tunelio.dev/tunnel?id=a&exp=1&sig=b', expires: 1000, quality: '720p', file_size: 5, status: 'ok' }, 90);
    if (url.includes('nope')) return respond(404, { error: 'not_found', message: 'gone' });
    return respond(200, { language: 'ja', type: 'manual', is_generated: false,
      available_languages: [{ code: 'en', is_generated: true, type: 'auto' }, { code: 'ja', is_generated: false, type: 'manual' }],
      segments: [{ start: 1.234, duration: 2, text: ' hi \n there ' }, { start: 3, duration: 1, text: '  ' }], status: 'ok' }, 84);
  } });
  const c = await t.create('AbCdEfGhIjK', '1080p');
  assert.equal(c.expires, 1000);
  assert.ok(seen[0][0].includes('quality=1080p'));
  assert.equal(seen[0][1], 'Bearer tnl_x');
  assert.equal(t.credits, 90);
  const tr = await t.transcript('AbCdEfGhIjK', 'ja');
  assert.deepEqual(tr.lines, [[1.23, 2, 'hi\nthere']]);
  assert.deepEqual(tr.tracks.map((x) => [x.code, x.auto]), [['en', true], ['ja', false]]);
  assert.equal(t.credits, 84);
  await assert.rejects(t.transcript('nope', 'en'), (e) => e.status === 404 && e.code === 'not_found');
  await assert.rejects(new Tunelio({ key: '' }).create('x', '720p'), (e) => e.code === 'no_key');
});

function fakeTunelio({ fail = null, expires = 1_000_000 } = {}) {
  const calls = [];
  return { calls, enabled: true, async create(id, q) {
    calls.push([id, q]);
    await new Promise((r) => setTimeout(r, 5));
    if (fail) { const e = new Error('x'); e.status = fail; throw e; }
    return { url: `https://tunelio.dev/tunnel?id=${id}`, expires, quality: '720p' };
  } };
}

test('Playback: live goes to YouTube, videos to a shared cached tunnel link', async () => {
  let now = 0;
  const tunelio = fakeTunelio({ expires: 3600 });
  const p = new Playback({ tunelio, now: () => now, progressiveMaxSeconds: 600 });
  assert.deepEqual(await p.location({ id: 'LIVE0000000', live: true }), { location: 'https://www.youtube.com/watch?v=LIVE0000000', via: 'youtube', reason: 'live' });
  const [a, b] = await Promise.all([p.location({ id: 'v1', seconds: 60 }), p.location({ id: 'v1', seconds: 60 })]);
  assert.equal(a.location, 'https://tunelio.dev/tunnel?id=v1&progressive=1');
  assert.equal(b.location, a.location);
  await p.location({ id: 'v1', seconds: 60 });
  assert.equal(tunelio.calls.length, 1, 'six viewers and replays share one paid call');
  assert.equal((await p.location({ id: 'long', seconds: 4000 })).location, 'https://tunelio.dev/tunnel?id=long&hls=1');
  now = (3600 - 10 * 60) * 1000; // within the 20-minute margin before expiry
  await p.location({ id: 'v1', seconds: 60 });
  assert.equal(tunelio.calls.filter((c) => c[0] === 'v1').length, 2, 'renewed before the link expires');
});

test('Playback: a refused progressive build uses HLS', async () => {
  const p = new Playback({ tunelio: fakeTunelio(), checkProgressive: async () => false });
  assert.ok((await p.location({ id: 'big', seconds: 60 })).location.endsWith('&hls=1'));
});

test('Playback: out of credits falls back to YouTube, alerts once, pauses', async () => {
  const alerts = [];
  const tunelio = fakeTunelio({ fail: 402 });
  const p = new Playback({ tunelio, alert: (k) => alerts.push(k) });
  const r = await p.location({ id: 'v2' });
  assert.deepEqual([r.via, r.reason], ['youtube', 'tunelio_failed']);
  assert.equal((await p.location({ id: 'v3' })).reason, 'paused');
  assert.equal(tunelio.calls.length, 1);
  assert.deepEqual(alerts, ['credits_out']);
});

test('alerts are throttled per kind', () => {
  let t = 0; const sent = [];
  const alert = makeAlert({ webhook: 'https://example/hook', fetcher: async (u, o) => sent.push(JSON.parse(o.body).content), now: () => t });
  assert.equal(alert('a', 'one'), true);
  assert.equal(alert('a', 'two'), false);
  assert.equal(alert('b', 'three'), true);
  t = 61 * 60_000;
  assert.equal(alert('a', 'four'), true);
  assert.deepEqual(sent, ['one', 'three', 'four']);
});

const raw = [
  { code: 'en', auto: true }, { code: 'en', auto: false }, { code: 'de-DE', auto: false }, { code: 'ja', auto: false },
  { code: 'ar', auto: false }, { code: 'hi', auto: false }, { code: 'zh-Hant', auto: false }, { code: 'iw', auto: false }, { code: 'ja', auto: false },
];

test('track list: uploader tracks first, unsupported scripts and duplicates dropped', () => {
  assert.deepEqual(orderTracks(raw).map((t) => `${t.code}${t.auto ? '*' : ''}`), ['en', 'de-DE', 'ja', 'zh-Hant', 'iw', 'en*']);
});

test('picking a track for a visitor language', () => {
  const tracks = orderTracks(raw);
  const code = (l) => { const i = pickTrack(tracks, l); return i < 0 ? null : `${tracks[i].code}${tracks[i].auto ? '*' : ''}`; };
  assert.equal(code('ja'), 'ja');
  assert.equal(code('de'), 'de-DE');
  assert.equal(code('he'), 'iw');
  assert.equal(code('zh-HK'), 'zh-Hant');
  assert.equal(code('zh-CN'), null, 'traditional is not offered for simplified');
  assert.equal(code('fr'), null, 'no machine translation');
  assert.equal(code('native'), 'en', 'manual in the spoken language beats auto');
  assert.equal(pickTrack([{ code: 'ko', auto: true }], 'native'), 0);
  assert.equal(pickTrack([{ code: 'en', auto: true }], 'en'), 0);
});

test('display names follow the asking language', () => {
  assert.equal(displayName('ja', 'en'), 'Japanese');
  assert.equal(displayName('ja', 'ja'), '日本語');
  assert.equal(displayName('de-DE', 'tok'), 'German (Germany)');
});

function fakeTranscripts(tracks) {
  const calls = [];
  return { calls, enabled: true, async transcript(id, lang, type) {
    calls.push([lang, type]);
    // Tunelio's behaviour: an unknown language quietly answers with English.
    const hit = tracks.find((t) => t.code === lang && (type === 'any' || (type === 'auto') === t.auto)) ?? tracks.find((t) => t.code === 'en');
    return { language: hit.code, type: hit.auto ? 'auto' : 'manual', tracks, lines: [[0, 1, `${hit.code} line`]] };
  } };
}

test('captions: one call for list + own track, picker by number, cached', async () => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 });
  const tunelio = fakeTranscripts([{ code: 'en', auto: false }, { code: 'ja', auto: false }, { code: 'en', auto: true }]);
  const c = new TunelioCaptions({ store, tunelio });
  const ja = await c.get('vid', 'ja');
  assert.equal(ja.available, true);
  assert.deepEqual(ja.lines, [[0, 1, 'ja line']]);
  assert.deepEqual(ja.tracks.map((t) => t.name), ['英語', '日本語', '英語']);
  assert.equal(ja.track, 1);
  assert.equal(tunelio.calls.length, 1);
  const auto = await c.track('vid', 2, 'en');
  assert.equal(auto.source, 'auto');
  assert.equal(auto.tracks[2].auto, true);
  assert.equal(tunelio.calls.length, 2);
  await c.get('vid', 'ja'); await c.track('vid', 2);
  assert.equal(tunelio.calls.length, 2, 'cached');
  const fr = await c.get('vid', 'fr');
  assert.deepEqual([fr.available, fr.reason, fr.tracks.length], [false, 'no_track_in_language', 3]);
  assert.equal((await c.track('vid', 9)).available, false);
});

test('captions: a silently substituted track is not shown as the one asked for', async () => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 });
  const tracks = [{ code: 'en', auto: false }, { code: 'ko', auto: false }];
  const tunelio = { enabled: true, calls: 0, async transcript(id, lang) {
    this.calls++;
    return { language: 'en', type: 'manual', tracks, lines: [[0, 1, 'english']] }; // always English, like a broken track
  } };
  const c = new TunelioCaptions({ store, tunelio });
  const ko = await c.get('v', 'ko');
  assert.deepEqual([ko.available, ko.reason], [false, 'temporarily_unavailable']);
  assert.equal((await c.get('v', 'en')).lines[0][2], 'english');
});

test('server: played ticket redirects through playback; caption track by number', async (t) => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 50, pinHours: 24 });
  const youtube = { async search(q) { return { videos: [
    { id: 'AAAAAAAAAAA', title: 'a', channel: '', length: '1:00', seconds: 60, views: '', age: '', live: false, cc: true },
    { id: 'BBBBBBBBBBB', title: 'b', channel: '', length: '', seconds: 0, views: '', age: '', live: true, cc: false }], more: null }; },
    thumbnailUrl: (id) => id };
  const seen = [];
  const playback = { async location(d) { seen.push(d); return { location: d.live ? 'https://www.youtube.com/watch?v=' + d.id : 'https://tunelio.dev/tunnel?id=' + d.id + '&progressive=1', via: 'x' }; } };
  const captions = { async get(id, lang) { return { id, lang, available: true, lines: [], tracks: [{ i: 0 }], track: 0 }; },
    async track(id, i, lang) { return { id, lang, available: true, lines: [[0, 1, `track ${i}`]], track: i }; } };
  const app = createApp({ config: { ...base, shards: 1, pool: 50 }, store, youtube, playback, captions, tunelio: { enabled: true, credits: 7 }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual' });
  const r = await (await get('/v1/0/s?q=x')).json();
  const play = await get(`/v1/0/${r.results[0].t}`);
  assert.equal(play.headers.get('location'), 'https://tunelio.dev/tunnel?id=AAAAAAAAAAA&progressive=1');
  assert.deepEqual(seen[0], { id: 'AAAAAAAAAAA', live: false, seconds: 60 });
  await get(`/v1/0/${r.results[1].t}`);
  assert.equal(seen[1].live, true);
  const cc = await (await get('/v1/0/cc/12?l=ja')).json();
  assert.deepEqual([cc.track, cc.lang, cc.lines[0][2]], [12, 'ja', 'track 12']);
  const health = await (await get('/healthz')).json();
  assert.deepEqual([health.tunelio, health.credits], [true, 7]);
});
