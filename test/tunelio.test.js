import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Tunelio } from '../src/tunelio.js';
import { Playback, clientKind } from '../src/playback.js';
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

function fakeTunelio({ fail = null, expires = 1_000_000, mb = {} } = {}) {
  const calls = [];
  return { calls, enabled: true, async create(id, q) {
    calls.push([id, q]);
    await new Promise((r) => setTimeout(r, 5));
    if (fail) { const e = new Error('x'); e.status = fail; throw e; }
    return { url: `https://tunelio.dev/tunnel?id=${id}&q=${q}`, expires, quality: q, fileSize: (mb[`${id}:${q}`] ?? mb[id] ?? 0) * 1e6 };
  } };
}

test('Playback: huge files are made again at 720p, and served as HLS above the progressive limit', async () => {
  const tunelio = fakeTunelio({ expires: Math.floor(Date.now() / 1000) + 3600, mb: { 'big:1080p': 3500, 'big:720p': 1700, 'huge:1080p': 4000, 'huge:720p': 2200, small: 200 } });
  const p = new Playback({ tunelio });
  assert.equal((await p.location({ id: 'small', seconds: 600 })).location, 'https://tunelio.dev/tunnel?id=small&q=1080p&progressive=1');
  assert.equal((await p.location({ id: 'big', seconds: 3600 })).location, 'https://tunelio.dev/tunnel?id=big&q=720p&progressive=1');
  assert.equal((await p.location({ id: 'huge', seconds: 3600 })).location, 'https://tunelio.dev/tunnel?id=huge&q=720p&hls=1');
  assert.deepEqual(tunelio.calls.map((c) => c.join(':')), ['small:1080p', 'big:1080p', 'big:720p', 'huge:1080p', 'huge:720p']);
  const st = p.status({ id: 'big', seconds: 3600 });
  assert.deepEqual([st.state, st.quality, st.mb], ['ready', '720p', 1700]);
});

test('Playback: live goes to YouTube, videos to a shared cached tunnel link', async () => {
  let now = 0;
  const tunelio = fakeTunelio({ expires: 3600 });
  const p = new Playback({ tunelio, now: () => now, progressiveMaxSeconds: 600 });
  assert.deepEqual(await p.location({ id: 'LIVE0000000', live: true }), { location: 'https://www.youtube.com/watch?v=LIVE0000000', via: 'youtube', reason: 'live', ready: true });
  const [a, b] = await Promise.all([p.location({ id: 'v1', seconds: 60 }), p.location({ id: 'v1', seconds: 60 })]);
  assert.equal(a.location, 'https://tunelio.dev/tunnel?id=v1&q=1080p&progressive=1');
  assert.equal(b.location, a.location);
  await p.location({ id: 'v1', seconds: 60 });
  assert.equal(tunelio.calls.length, 1, 'six viewers and replays share one paid call');
  assert.equal((await p.location({ id: 'long', seconds: 4000 })).location, 'https://tunelio.dev/tunnel?id=long&q=1080p&hls=1');
  now = (3600 - 10 * 60) * 1000; // within the 20-minute margin before expiry
  await p.location({ id: 'v1', seconds: 60 });
  assert.equal(tunelio.calls.filter((c) => c[0] === 'v1').length, 2, 'renewed before the link expires');
});

test('Playback: a refused progressive build uses HLS', async () => {
  const probed = [];
  const p = new Playback({ tunelio: fakeTunelio(), probe: async (u) => { probed.push(u); return u.includes('progressive') ? { ok: false, refused: true } : { ok: true, refused: false }; } });
  assert.ok((await p.location({ id: 'big', seconds: 60 })).location.endsWith('&hls=1'));
  assert.equal(probed.length, 2, 'progressive probed, refused, then HLS');
});

test('Playback: status, warm, hold cap and learned ETA', async () => {
  let now = 0;
  let release;
  const probe = () => new Promise((r) => { release = () => r({ ok: true, refused: false }); });
  const builds = [];
  const p = new Playback({ tunelio: fakeTunelio({ expires: 3600, mb: { warm1: 900 } }), now: () => now, probe, onBuild: (b) => builds.push(b) });
  // A tablet warms the video: the build starts, the answer never waits.
  const st = p.status({ id: 'warm1', seconds: 1200 });
  assert.equal(st.state, 'building');
  assert.ok(st.eta >= 2 && st.progress >= 0 && st.progress < 1);
  // The resolver asks while it builds: held for the cap, then told it is not ready.
  const t0 = Date.now();
  const r = await p.location({ id: 'warm1', seconds: 1200 }, { holdMs: 30 });
  assert.equal(r.ready, false);
  assert.ok(Date.now() - t0 < 500);
  // The build finishes: everyone waiting is released with the link, the status says ready, the build is reported.
  now = 20_000;
  const wait = p.location({ id: 'warm1', seconds: 1200 }, { holdMs: 10_000 });
  release();
  const done = await wait;
  assert.deepEqual([done.ready, done.via, done.location], [true, 'tunelio', 'https://tunelio.dev/tunnel?id=warm1&q=1080p&progressive=1']);
  assert.equal(p.status({ id: 'warm1', seconds: 1200 }).state, 'ready');
  assert.deepEqual(builds.map((b) => [b.id, b.format, b.ok, b.buildMs]), [['warm1', 'progressive', true, 20_000]]);
  assert.ok(p.fixed.progressive !== 2 || p.rate.progressive !== 0.017, 'the ETA model learned from the build');
  // Live and disabled answers carry a state the tablet can show, and cost nothing.
  assert.equal(p.status({ id: 'LIVE', live: true }).state, 'live');
  assert.equal(new Playback({ tunelio: { enabled: false } }).status({ id: 'x' }).state, 'youtube');
});

test('clientKind tells the tablet, the resolver and the player apart', () => {
  assert.equal(clientKind('UnityPlayer/2022.3.22f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)'), 'string');
  assert.equal(clientKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'), 'ytdlp');
  assert.equal(clientKind('NSPlayer/12.00.26100.1234 WMFSDK/12.00.26100.1234'), 'avpro');
  assert.equal(clientKind(''), 'avpro');
  assert.equal(clientKind('curl/8.5.0'), 'other');
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

test('server: tickets answer the tablet, the resolver and the player differently while a video builds', async (t) => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 50, pinHours: 24 });
  const youtube = { async search() { return { videos: [{ id: 'AAAAAAAAAAA', title: 'a', channel: '', length: '20:00', seconds: 1200, views: '', age: '', live: false, cc: false }], more: null }; }, thumbnailUrl: (id) => id };
  let release;
  const probe = () => new Promise((r) => { release = () => r({ ok: true, refused: false }); });
  const playback = new Playback({ tunelio: fakeTunelio({ expires: Math.floor(Date.now() / 1000) + 3600 }), probe });
  const counted = [];
  const metrics = { inc: (m, k) => counted.push(k ? `${m}:${k}` : m), gauge() {}, latency(m) { counted.push(m); }, shard() {}, flush() {}, start() { return this; }, close() {} };
  const app = createApp({ config: { ...base, shards: 1, pool: 50, ticketResolverHoldMs: 50, ticketPlayerHoldMs: 5000 }, store, youtube, playback, metrics, tunelio: { enabled: true }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const get = (p, ua) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  const unity = 'UnityPlayer/2022.3.22f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)';
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
  const mf = 'NSPlayer/12.00.26100.1234 WMFSDK/12.00.26100.1234';
  const r = await (await get('/v1/0/s?q=x', unity)).json();
  const ticket = `/v1/0/${r.results[0].t}`;
  // The tablet selects the row: a warm answer, the build starts, nothing is "played" yet.
  const w = await (await get(ticket, unity)).json();
  assert.deepEqual([w.state, w.format, typeof w.eta], ['building', 'progressive', 'number']);
  assert.equal(store.lastPlayed(0), null);
  assert.ok(counted.includes('warm'));
  // The resolver gets a plain page quickly instead of waiting 20 s.
  const t0 = Date.now();
  const y = await get(ticket, chrome);
  assert.equal(y.status, 200);
  assert.ok((y.headers.get('content-type') ?? '').startsWith('text/html'));
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(counted.includes('ticket_fastfail'));
  // The player is held until the build is ready, then redirected to the link; the warm counts as played.
  const pending = get(ticket, mf);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const a = await pending;
  assert.equal(a.status, 302);
  assert.equal(a.headers.get('location'), 'https://tunelio.dev/tunnel?id=AAAAAAAAAAA&q=720p&progressive=1'); // the room's quality: 720p by default
  assert.equal(store.lastPlayed(0).videoId, 'AAAAAAAAAAA');
  assert.ok(counted.includes('warm_played'));
  assert.ok(counted.includes('ticket_client:string') && counted.includes('ticket_client:ytdlp') && counted.includes('ticket_client:avpro'));
  // Once ready, the resolver gets the redirect at once and the tablet sees ready.
  assert.equal((await get(ticket, chrome)).status, 302);
  assert.equal((await (await get(ticket, unity)).json()).state, 'ready');
});

test('room quality: 720p by default, a pick per shard, builds kept apart per quality', async (t) => {
  const store = new Store({ path: ':memory:', shards: 2, pool: 100, pinHours: 24 });
  const created = [];
  const tunelio = { enabled: true, credits: 1, async create(id, q) { created.push([id, q]); return { url: `https://tunelio.dev/tunnel?id=${id}&q=${q}`, expires: 9e9, quality: q, fileSize: 1e8 }; } };
  const playback = new Playback({ tunelio, quality: '720p', probe: async () => ({ ok: true }) });
  const youtube = { async search() { return { videos: [{ id: 'AbCdEfGh1jK', title: 't', channel: 'c', length: '20:00', seconds: 1200, views: '', age: '', live: false }], more: null }; }, thumbnailUrl: () => '' };
  const app = createApp({ config: { ...base, shards: 2, pool: 100, tunelioQuality: '720p', tunelioQualities: ['720p', '1080p'], metricsPath: '', tunelioKey: '' },
    store, youtube, tunelio, playback, captions: { async get() { return { available: false }; } }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (p, ua = 'UnityPlayer/2022.3.22f1') => fetch(url + p, { headers: { 'user-agent': ua }, redirect: 'manual' });

  assert.deepEqual(await (await get('/v1/1/q')).json(), { v: 1, shard: 1, quality: '720p', default: '720p', options: ['720p', '1080p'] });
  const s = await (await get('/v1/1/s?l=en&q=x')).json();
  const t0 = s.results[0].t;
  assert.equal((await (await get(`/v1/1/${t0}`)).json()).room, '720p');
  const play720 = await get(`/v1/1/${t0}`, 'NSPlayer/12.00');
  assert.match(play720.headers.get('location'), /q=720p&progressive=1$/);

  assert.equal((await (await get('/v1/1/q/1080')).json()).quality, '1080p');
  assert.equal((await (await get('/v1/0/q')).json()).quality, '720p', 'other shards keep the default');
  const st = await (await get(`/v1/1/${t0}`)).json();
  assert.equal(st.room, '1080p');
  const play1080 = await get(`/v1/1/${t0}`, 'NSPlayer/12.00');
  assert.match(play1080.headers.get('location'), /q=1080p&progressive=1$/);
  assert.deepEqual(created, [['AbCdEfGh1jK', '720p'], ['AbCdEfGh1jK', '1080p']], 'one build per quality');

  assert.equal((await get('/v1/1/q/480')).status, 400);
  assert.equal((await (await get('/v1/1/q/480')).json()).error, 'bad_quality');
  assert.equal((await get('/v1/9/q/720')).status, 404);

  // A pick expires (another instance may land on the shard later).
  const old = new Store({ path: ':memory:', shards: 2, pool: 100, pinHours: 24, now: () => 0 });
  old.setQuality(1, '1080p');
  assert.equal(old.quality(1, 3600_000), '1080p');
  old.now = () => 2 * 3600_000;
  assert.equal(old.quality(1, 3600_000), null);
});
