import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';
import { SHORT_LANGS, LANGS } from '../src/query.js';

const config = { ...base, shards: 2, pool: 100, resultsPerPage: 3, searchesPerMinutePerIp: 5 };
const video = (id) => ({ id, title: `Title ${id}`, channel: 'Ch', length: '1:00', seconds: 60, views: '1 view', age: '1 day ago', live: false, cc: true });

function fakeYoutube() {
  const calls = [];
  return {
    calls,
    async search(q, limit) {
      calls.push(q);
      if (q === 'boom') throw new Error('youtube down');
      const page = (p) => ({
        videos: Array.from({ length: limit }, (_, i) => video(`${q.slice(0, 4).padEnd(4, '_')}${p}${i}`.padEnd(11, 'x').slice(0, 11))),
        more: p < 3 ? async () => page(p + 1) : null,
      });
      return page(1);
    },
    thumbnailUrl: (id) => `thumb://${id}`,
  };
}

async function start(over = {}) {
  const store = new Store({ path: ':memory:', shards: config.shards, pool: config.pool, pinHours: 24 });
  const youtube = fakeYoutube();
  const captionCalls = [];
  const captions = {
    async get(id, lang) { captionCalls.push([id, lang]); return { id, lang, available: true, source: 'manual', lines: [[0, 1, 'hi']] }; },
    async tracks(id, lang) { captionCalls.push([id, 'tracks', lang]); return { id, lang, available: true, tracks: [{ i: 0, code: 'en', name: 'English', auto: false }], track: -1 }; },
    warm(id) { this.get(id, 'native'); }, // the play route warms the free sources (src/captionchain.js)
  };
  const red = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#f7768e' } }).jpeg().toBuffer();
  const app = createApp({ config, store, youtube, captions, sheetOpts: { fetcher: async () => red }, log: () => {}, ...over });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
    const type = res.headers.get('content-type') ?? '';
    const body = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body };
  };
  return { server, get, youtube, captionCalls, store, base: `http://127.0.0.1:${port}` };
}

test('search → tickets → redirect, sheet, next page, captions', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  const q = encodeURIComponent('Type to search → rain sounds');
  const r = await s.get(`/v1/1/s?l=ja&q=${q}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.query, 'rain sounds');
  assert.equal(r.body.lang, 'ja');
  assert.equal(r.body.results.length, 3);
  assert.deepEqual(r.body.results.map((x) => x.t), [0, 1, 2]);
  assert.equal(r.body.sheet, 3);
  assert.equal(r.body.next, 4);

  const play = await s.get(`/v1/1/${r.body.results[1].t}`);
  assert.equal(play.status, 302);
  assert.equal(play.headers.get('location'), `https://www.youtube.com/watch?v=${r.body.results[1].id}`);
  assert.deepEqual(s.captionCalls.at(-1), [r.body.results[1].id, 'native']);

  const sheet = await s.get(`/v1/1/${r.body.sheet}`);
  assert.equal(sheet.status, 200);
  const meta = await sharp(sheet.body).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [1024, 720, 'jpeg']);

  const next = await s.get(`/v1/1/${r.body.next}`);
  assert.equal(next.status, 200);
  assert.equal(next.body.page, 2);
  assert.deepEqual(next.body.results.map((x) => x.t), [5, 6, 7]);
  assert.equal(next.body.next, 9);
  const last = await s.get(`/v1/1/${next.body.next}`);
  assert.equal(last.body.page, 3);
  assert.equal(last.body.next, -1);
  const gone = await s.get(`/v1/1/${next.body.next}`);
  assert.equal(gone.status, 410);

  const cc = await s.get('/v1/1/cc/ja');
  assert.equal(cc.status, 200);
  assert.equal(cc.body.t, r.body.results[1].t);
  assert.equal(cc.body.id, r.body.results[1].id);
  assert.deepEqual(cc.body.lines, [[0, 1, 'hi']]);
  const none = await s.get('/v1/0/cc/ja');
  assert.equal(none.body.error, 'nothing_playing');

  // The list alone (the tablet's CC popover), named in the visitor's language; no track is fetched for it.
  const list = await s.get('/v1/1/cc?l=ja');
  assert.equal(list.status, 200);
  assert.equal(list.body.t, r.body.results[1].t);
  assert.equal(list.body.track, -1);
  assert.deepEqual(list.body.tracks.map((x) => x.code), ['en']);
  assert.deepEqual(s.captionCalls.at(-1), [r.body.results[1].id, 'tracks', 'ja']);
  const noList = await s.get('/v1/0/cc');
  assert.equal(noList.body.error, 'nothing_playing');
});

test('pasted link goes first', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  const r = await s.get(`/v1/0/s?q=${encodeURIComponent('Search → https://youtu.be/AbCdEfGhIjK')}`);
  assert.equal(r.body.pasted, true);
  assert.equal(r.body.results[0].id, 'AbCdEfGhIjK');
  assert.deepEqual(s.youtube.calls, ['AbCdEfGhIjK']);
});

test('ticket status carries the title, channel and description (Everything-is-OK#114); other links are searched as before', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  const tablet = async (path) => (await fetch(`${s.base}${path}`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0)' } })).json();
  const r = await s.get(`/v1/0/s?q=${encodeURIComponent('Search → rain')}`);
  const st = await tablet(`/v1/0/${r.body.results[0].t}`);
  assert.equal(st.t, r.body.results[0].t, 'the world matches answers by t');
  assert.deepEqual([st.title, st.channel, st.desc], [r.body.results[0].title, 'Ch', '']);

  // A non-YouTube link is searched as text, as before (owner, 2026-10-23: no redirects to other sites).
  const l = await s.get(`/v1/0/s?q=${encodeURIComponent('Search → https://cdn.example.org/clip.mp4')}`);
  assert.equal(l.status, 200);
  assert.deepEqual(s.youtube.calls, ['rain', 'https://cdn.example.org/clip.mp4']);
  assert.equal(l.body.results[0].link, undefined);
});

// World #136: the tablet's YouTube field hands its search address straight to the video player.
test('pasted YouTube link (#136): a player or resolver gets the ticket answer, the tablet the search with the same ticket; other hosts never redirect', async (t) => {
  const s = await start({ config: { ...config, searchesPerMinutePerIp: 50 } });
  t.after(() => s.server.close());
  const as = (ua) => async (path) => fetch(`${s.base}${path}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  const avpro = as('NSPlayer/12.00.19041.1 WMFSDK/12.00.19041.1'), ytdlp = as('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0'), tablet = as('UnityPlayer/2022.3 (UnityWebRequest/1.0)');
  const q = `/v1/0/s?l=en&q=${encodeURIComponent('Paste a link → https://youtu.be/AbCdEfGhIjK')}`;

  const resolved = await ytdlp(q);
  assert.equal(resolved.status, 302);
  assert.equal(resolved.headers.get('location'), 'https://www.youtube.com/watch?v=AbCdEfGhIjK', 'no Tunelio here: the youtube.com answer a ticket gives');
  assert.equal((await avpro(q)).status, 302);
  const st = await (await tablet(q)).json();
  assert.equal(st.pasted, true);
  assert.equal(st.results[0].id, 'AbCdEfGhIjK');
  const played = s.store.get(0, st.results[0].t);
  assert.equal(played.data.id, 'AbCdEfGhIjK', 'the first result is the ticket the player played');
  assert.ok(played.pinnedUntil > Date.now(), 'and it was played (pinned for late joiners)');
  assert.deepEqual(s.youtube.calls, ['AbCdEfGhIjK', 'AbCdEfGhIjK'], 'the player and resolver shared one lookup; the tablet ran its own search');
  const status = await (await tablet(`/v1/0/${st.results[0].t}`)).json();
  assert.deepEqual([status.t, status.title], [st.results[0].t, 'AbCdEfGhIjK'], 'the tablet follows it like a late joiner (#114); the fake search has no exact match, so the title is the id');
  // The compact address and its .m3u8 form answer a player the same way.
  assert.equal((await avpro(`/s/0e.m3u8?q=${encodeURIComponent('youtube.com/watch?v=AbCdEfGhIjK')}`)).status, 302);
  assert.equal((await avpro(`/v1/0/s.m3u8?q=${encodeURIComponent('→ https://youtu.be/AbCdEfGhIjK')}`)).status, 302);

  // Never a redirect for another host, even one carrying a YouTube-shaped id, nor for plain text: the search JSON.
  for (const link of ['https://evil.example/watch?v=AbCdEfGhIjK', 'https://youtube.com.evil.example/watch?v=AbCdEfGhIjK',
    'https://youtube.com@evil.example/watch?v=AbCdEfGhIjK', 'https://evil.example/?u=https://youtu.be/AbCdEfGhIjK', 'rain sounds']) {
    for (const load of [avpro, ytdlp]) {
      const r = await load(`/v1/0/s?q=${encodeURIComponent(`→ ${link}`)}`);
      assert.equal(r.status, 200, link);
      assert.equal(r.headers.get('location'), null, link);
      assert.match(r.headers.get('content-type'), /json/, link);
    }
  }
});

// The compact search address for Quest (#143, 2026-10-25): /s/<shard><letter>?q=, the same search as /v1/<shard>/s.
test('compact search /s/<shard><letter>: the same answer as /v1, with or without the arrow prompt', async (t) => {
  const roomy = { config: { ...config, searchesPerMinutePerIp: 50 } };
  const a = await start(roomy), b = await start(roomy);
  t.after(() => { a.server.close(); b.server.close(); });
  const old = await a.get(`/v1/1/s?l=ja&q=${encodeURIComponent('Type to search → rain sounds')}`);
  const compact = await b.get(`/s/1j?q=${encodeURIComponent('rain sounds')}`);
  assert.equal(compact.status, 200);
  assert.deepEqual(compact.body, old.body);
  assert.equal(compact.body.lang, 'ja');
  assert.equal((await b.get(`/s/1j?q=${encodeURIComponent('Type to search → rain sounds')}`)).body.query, 'rain sounds');
  const next = await b.get(`/v1/1/${compact.body.next}`); // tickets and continuation are the /v1 ones
  assert.equal(next.status, 200);
  assert.equal(next.body.page, 2);
  assert.equal((await b.get(`/s/0b?q=${encodeURIComponent('https://youtu.be/AbCdEfGhIjK')}`)).body.results[0].id, 'AbCdEfGhIjK'); // the Link field
  assert.equal((await b.get('/s/0?q=x')).body.lang, 'en');
  assert.equal((await b.get('/s/0e')).body.error, 'empty_query');
  assert.equal((await b.get('/s/0z?q=x')).body.error, 'not_found');
  assert.equal((await b.get(`/s/${config.shards}e?q=x`)).body.error, 'bad_shard');
  assert.equal((await b.get('/s/12e?q=x')).status, 404);
});

test('compact search letters: one per VRChat language, never changed (README, Compact search address)', () => {
  assert.deepEqual(SHORT_LANGS, { e: 'en', f: 'fr', s: 'es', i: 'it', k: 'ko', d: 'de', j: 'ja', p: 'pl', r: 'ru', b: 'pt-BR',
    c: 'zh-CN', h: 'zh-HK', v: 'he', t: 'tok', u: 'uk', a: 'th' });
  assert.deepEqual(Object.values(SHORT_LANGS).sort(), Object.keys(LANGS).sort());
});

test('searches log their shape, never their text (#143)', async (t) => {
  const lines = [];
  const s = await start({ log: (l) => lines.push(l) });
  t.after(() => s.server.close());
  const q = encodeURIComponent(' '.repeat(240) + 'Type to search → rain secretword');
  await fetch(`${s.base}/v1/0/s?l=en&q=${q}`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0; Android)' } });
  await s.get('/v1/0/s?q=' + encodeURIComponent('Search →  '));
  const shapes = lines.map((l) => JSON.parse(l)).filter((e) => e.event === 'search_shape');
  assert.equal(shapes.length, 2);
  assert.equal(shapes[0].device, 'android');
  assert.equal(shapes[0].arrow, '→');
  assert.equal(shapes[0].len, 15);
  assert.equal(shapes[1].chars, 'empty');
  assert.ok(!lines.some((l) => l.includes('secretword')));
});

test('errors are JSON with codes', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  assert.equal((await s.get('/v1/0/s?q=' + encodeURIComponent('Search →  '))).body.error, 'empty_query');
  assert.equal((await s.get('/v1/0/s?q=boom')).body.error, 'youtube_failed');
  assert.equal((await s.get('/v1/9/s?q=x')).body.error, 'bad_shard');
  assert.equal((await s.get('/v1/0/42')).body.error, 'unknown_ticket');
  assert.equal((await s.get('/v1/0/100')).body.error, 'unknown_ticket');
  assert.equal((await s.get('/nope')).status, 404);
  assert.equal((await s.get('/healthz')).body.ok, true);
  assert.equal((await s.get('/healthz')).body.busy, 0); // deploy/update.sh waits for 0 before restarting
});

test('rate limits searches per IP', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  for (let i = 0; i < 5; i++) assert.equal((await s.get('/v1/0/s?q=a' + i)).status, 200);
  assert.equal((await s.get('/v1/0/s?q=again')).body.error, 'rate_limited');
});

test('serves the home page, privacy policy and logo', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  for (const [path, type, text] of [['/', 'text/html', 'Everything is OK'], ['/privacy', 'text/html', 'YouTube API Services'], ['/privacy.html', 'text/html', 'Privacy policy']]) {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}${path}`);
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-type').startsWith(type), path);
    assert.ok((await res.text()).includes(text), path);
  }
  const logo = await fetch(`http://127.0.0.1:${s.server.address().port}/logo.png`);
  assert.equal(logo.headers.get('content-type'), 'image/png');
});

test('/feedback answers 301 to the feedback form (world #224)', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  for (const method of ['GET', 'HEAD']) {
    const res = await fetch(`http://127.0.0.1:${s.server.address().port}/feedback`, { method, redirect: 'manual' });
    assert.equal(res.status, 301, method);
    assert.equal(res.headers.get('location'), 'https://docs.google.com/forms/d/1UXMXbqXXXtClqTAnQAVKA1niKKsIdOLMGjCPCH-yZFA/viewform', method);
  }
});

// The world's video reports (world #353): the Tester tab's problem buttons and every visitor's Resync presses.
test('video reports /v1/<shard>/r/<who>/<kind>: 200 at once, logged with the shard\'s play, counted once per 10 s (#353)', async (t) => {
  const lines = [];
  const incs = [];
  const metrics = { inc: (m, k) => incs.push(`${m}:${k}`), gauge() {}, latency() {}, shard() {}, flush() { return 0; }, start() { return this; }, close() {} };
  const s = await start({ log: (l) => lines.push(l), metrics });
  t.after(() => s.server.close());
  const reports = () => lines.map((l) => JSON.parse(l)).filter((e) => e.event === 'video_report');
  const counted = () => incs.filter((x) => x.startsWith('video_report:'));

  for (const who of ['tester', 'visitor']) {
    for (const kind of ['frozen', 'stutter', 'sync', 'sound', 'load', 'quality', 'resync', 'autoresync']) {
      const r = await s.get(`/v1/0/r/${who}/${kind}`);
      assert.equal(r.status, 200, `${who}/${kind}`);
      assert.deepEqual(r.body, { ok: true });
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(reports().length, 16);
  assert.equal(counted().length, 16);
  assert.ok(counted().includes('video_report:tester:frozen') && counted().includes('video_report:visitor:autoresync'));
  // Nothing playing yet: the report says so.
  assert.equal(reports()[0].n, null);

  // Anything off the allowlist is a 404, and neither logged nor counted.
  for (const p of ['/v1/0/r/tester/bogus', '/v1/0/r/owner/frozen', '/v1/0/r/frozen', '/v1/0/r/tester', '/v1/0/r/tester/frozen/x', '/v1/0/r/TESTER/frozen']) {
    assert.equal((await s.get(p)).status, 404, p);
  }
  assert.equal((await s.get('/v1/9/r/tester/frozen')).body.error, 'bad_shard');
  assert.equal(reports().length, 16);

  // Play a video in shard 1, then report: the event carries that ticket, the UA class and who.
  const r = (await s.get('/v1/1/s?q=rain')).body;
  await fetch(`${s.base}/v1/1/${r.results[0].t}`, { redirect: 'manual', headers: { 'user-agent': 'AVProVideo/2.9 (Linux; Android 12)' } });
  await fetch(`${s.base}/v1/1/r/tester/stutter`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0; Android)' } });
  const e = reports().at(-1);
  assert.equal(e.shard, 1);
  assert.equal(e.kind, 'stutter');
  assert.equal(e.who, 'tester');
  assert.equal(e.device, 'android');
  assert.equal(e.n, r.results[0].t);
  assert.equal(typeof e.ago, 'number');
  assert.ok('via' in e && 'mode' in e && 'rung' in e && 'quality' in e && 'hls' in e);

  // Counting (not logging) is limited to one per shard, who and kind per 10 s.
  const before = counted().length;
  await s.get('/v1/1/r/tester/stutter');
  await s.get('/v1/1/r/tester/stutter');
  await s.get('/v1/1/r/visitor/stutter');  // another who
  await s.get('/v1/0/r/tester/stutter');   // another shard, but shard 0 counted it above
  await s.get('/v1/1/r/tester/frozen');    // another kind
  assert.equal(counted().length - before, 2);
  assert.equal(reports().at(-1).counted, true);
  assert.equal(reports().at(-2).counted, false);
});

test('video reports count again after the gap (reportGapMs)', async (t) => {
  const incs = [];
  const metrics = { inc: (m, k) => incs.push(`${m}:${k}`), gauge() {}, latency() {}, shard() {}, flush() { return 0; }, start() { return this; }, close() {} };
  const s = await start({ metrics, config: { ...config, reportGapMs: 0 } });
  t.after(() => s.server.close());
  await s.get('/v1/0/r/visitor/resync');
  await s.get('/v1/0/r/visitor/resync');
  assert.equal(incs.filter((x) => x === 'video_report:visitor:resync').length, 2);
});

// A pasted link that search doesn't list (an unlisted clip, staging 2026-10-29): its ticket got seconds 0, so the
// ≥30-min home rule never applied. One Data API lookup fills it in; without one (no key, failed) it stays as before.
test('pasted link search doesn\'t list: its length, live state and title come from one Data API lookup, else as before', async (t) => {
  const asked = [];
  const api = { enabled: true, async video(id) { asked.push(id); return id === 'UnlistedAbc' ? { ...video(id), title: 'Unlisted clip', seconds: 2700 } : null; } };
  const s = await start({ api, config: { ...config, searchesPerMinutePerIp: 50 } });
  t.after(() => s.server.close());
  const avpro = (q) => fetch(`${s.base}/v1/0/s?q=${encodeURIComponent(q)}`, { redirect: 'manual', headers: { 'user-agent': 'NSPlayer/12.00.19041.1 WMFSDK/12.00.19041.1' } });

  // The tablet's search: the first result is the looked-up video.
  const r = (await s.get(`/v1/0/s?q=${encodeURIComponent('→ https://youtu.be/UnlistedAbc')}`)).body;
  assert.deepEqual([r.results[0].id, r.results[0].title], ['UnlistedAbc', 'Unlisted clip']);
  assert.equal(s.store.get(0, r.results[0].t).data.seconds, 2700);
  // The player's load of the same address: the same ticket, no second lookup for a ticket already made.
  assert.equal((await avpro('→ https://youtu.be/UnlistedAbc')).status, 302);
  assert.deepEqual(asked, ['UnlistedAbc']);

  // A player first, for another video: looked up too.
  await avpro('→ https://youtu.be/UnlistedAbd');
  assert.deepEqual(asked, ['UnlistedAbc', 'UnlistedAbd']);

  // A video search does list: no lookup (the fake search lists ids starting with the query's first 4 characters).
  const listed = 'Abcd10xxxxx'; // the fake search's first result for that query
  await s.get(`/v1/0/s?q=${encodeURIComponent('https://youtu.be/' + listed)}`);
  assert.equal(asked.length, 2);

  // No video, a failed lookup, or no key: seconds 0, title = id, as before.
  api.video = async () => { throw new Error('quota'); };
  const f = (await s.get(`/v1/1/s?q=${encodeURIComponent('https://youtu.be/FailedLook1')}`)).body;
  assert.equal(f.results[0].title, 'FailedLook1');
  assert.equal(s.store.get(1, f.results[0].t).data.seconds, 0);
  api.enabled = false;
  api.video = async () => { throw new Error('not called'); };
  const n = (await s.get(`/v1/1/s?q=${encodeURIComponent('https://youtu.be/NoKeyLook01')}`)).body;
  assert.equal(n.results[0].title, 'NoKeyLook01');
});
