// Everything-is-OK#449: a pasted link's lookup (the tablet's string load of the search address) warms the video in the
// route's format, by the same rules as a tablet's own warm.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Playback } from '../src/playback.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { config as base } from '../src/config.js';

const UNITY = 'UnityPlayer/6000.0.67f1-DWR (UnityWebRequest/1.0, libcurl/8.10.1-DEV)';
const UNITY_ANDROID = 'UnityPlayer/6000.0.67f1-DWR (UnityWebRequest/1.0, libcurl/8.10.1-DEV) Android';
const WMF = 'NSPlayer/12.00.26100.1234 WMFSDK/12.00.26100.1234';
const ID = 'AbCdEfGh1jK';
const link = (l = `https://youtu.be/${ID}`) => encodeURIComponent(`Paste a link → ${l}`);

async function app(t, { config = {}, video = {}, restricted = false } = {}) {
  const store = new Store({ path: ':memory:', shards: 1, pool: 100, pinHours: 24 });
  const youtube = { async search(q) {
    return { videos: [{ id: /^[\w-]{11}$/.test(q) ? q : 'ZZZZZZZZZZZ', title: 't', channel: 'c', length: '20:00', seconds: 1200, views: '', age: '', live: false, cc: false, ...video }], more: null };
  }, thumbnailUrl: (id) => id };
  const created = [];
  const tunelio = { enabled: true, async create(id, q) { created.push([id, q]); return { url: `https://tunelio.dev/tunnel?id=${id}&q=${q}`, expires: Math.floor(Date.now() / 1000) + 3600, quality: q, fileSize: 1e8 }; } };
  const playback = new Playback({ tunelio, quality: '720p', probe: async () => ({ ok: true, refused: false }) });
  const starts = [];
  const start = playback.start.bind(playback);
  playback.start = (d, q, o) => { starts.push([d.id, q, Boolean(o?.hls)]); return start(d, q, o); };
  if (restricted) playback.restricted = (id) => id === ID;
  const logs = [];
  const counts = {};
  const metrics = new Proxy({ inc(m, k = '') { counts[m + (k ? ':' + k : '')] = (counts[m + (k ? ':' + k : '')] ?? 0) + 1; } }, { get: (o, k) => (k in o ? o[k] : () => {}) });
  const a = createApp({ config: { ...base, shards: 1, pool: 100, tunelioQuality: '720p', ticketPlayerHoldMs: 5000, searchesPerMinutePerIp: 50, videoMaxSeconds: 43200, lookupWarm: true, ...config },
    store, youtube, playback, tunelio, metrics, captions: { async get() { return { available: false }; } }, log: (s) => logs.push(JSON.parse(s)) });
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const get = (p, ua = UNITY, ip = null) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', headers: { 'user-agent': ua, ...(ip ? { 'x-forwarded-for': ip } : {}) } });
  // The warm runs after the answer is sent.
  const settle = () => new Promise((r) => setTimeout(r, 50));
  return { get, created, starts, logs, counts, settle, events: (e) => logs.filter((o) => o.event === e) };
}

test('#449: a PC lookup of a pasted link warms its plain-ticket build once; the answer is unchanged for the current world', async (t) => {
  const a = await app(t);
  const r = await a.get(`/v1/0/s?l=en&q=${link()}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual([body.pasted, body.results[0].id, typeof body.results[0].t], [true, ID, 'number'], 'the v2026.11.03 world reads the same answer');
  await a.settle();
  assert.deepEqual(a.starts, [[ID, '720p', false]], 'the PC format: what a plain ticket builds');
  assert.deepEqual(a.created, [[ID, '720p']]);
  assert.equal(a.counts.warm, 1);
  assert.deepEqual(a.events('warm').map((o) => [o.reason, o.hls]), [['lookup', false]]);
  assert.deepEqual(a.events('lookup_warm').map((o) => [o.reason, o.hls, o.device, o.warm, o.via]), [['lookup', false, 'unity', 'building', 'tunelio']]);

  // Play now: the tablet's status and the player find the same build; no second paid call.
  const st = await (await a.get(`/v1/0/${body.results[0].t}`)).json();
  assert.ok(['building', 'ready'].includes(st.state));
  const play = await a.get(`/v1/0/s?l=en&q=${link()}`, WMF);
  assert.equal(play.status, 302);
  assert.match(play.headers.get('location'), /id=AbCdEfGh1jK&q=720p&progressive=1$/);
  assert.equal(a.created.length, 1, 'one /create for the lookup, the status and the play');
  assert.equal(a.counts.warm_played, 1, 'the lookup warm counts as played');
  assert.deepEqual(a.events('warm').map((o) => o.reason), ['lookup'], 'the status load found the build: no tablet warm');

  // The same link looked up again (another preview): the build is there, nothing new is spent.
  await a.get(`/v1/0/s?l=en&q=${link()}`);
  await a.settle();
  assert.equal(a.created.length, 1);
  assert.equal(a.events('warm').length, 1);
  assert.equal(a.events('lookup_warm').at(-1).warm, 'ready');
});

test('#449: the .m3u8 route (compact or /v1) or an Android tablet warms the Quest format, the .m3u8 ticket build', async (t) => {
  for (const [path, ua] of [[`/s/0e.m3u8?q=${link()}`, UNITY], [`/v1/0/s.m3u8?q=${link()}`, UNITY], [`/s/0e?q=${link()}`, UNITY_ANDROID]]) {
    const a = await app(t);
    const body = await (await a.get(path, ua)).json();
    assert.equal(body.results[0].id, ID, path);
    await a.settle();
    assert.deepEqual(a.starts, [[ID, '720p', true]], `${path}: HLS, what a .m3u8 ticket's player opens`);
    assert.deepEqual(a.events('warm').map((o) => [o.reason, o.hls]), [['lookup', true]], path);
    // The Quest tablet's .m3u8 status load and the player then share it.
    const st = await (await a.get(`/v1/0/${body.results[0].t}.m3u8`, UNITY)).json();
    assert.ok(['building', 'ready'].includes(st.state), path);
    assert.equal(a.created.length, 1, path);
  }
});

test('#449: no warm for plain text, a non-YouTube host, a player load, over-cap or restricted videos, or with LOOKUP_WARM=off', async (t) => {
  const cases = [
    ['text search', {}, `/v1/0/s?q=${encodeURIComponent('→ rain sounds')}`, UNITY, null],
    ['another host with a YouTube-shaped id', {}, `/v1/0/s?q=${link(`https://evil.example/watch?v=${ID}`)}`, UNITY, null],
    ['over the 12 h cap', { video: { seconds: 43201, length: '12:00:01' } }, `/v1/0/s?q=${link()}`, UNITY, 'too_long'],
    ['age-restricted', { restricted: true }, `/v1/0/s?q=${link()}`, UNITY, 'restricted'],
    ['LOOKUP_WARM=off', { config: { lookupWarm: false } }, `/v1/0/s?q=${link()}`, UNITY, null],
  ];
  for (const [name, opts, path, ua, skipped] of cases) {
    const a = await app(t, opts);
    assert.equal((await a.get(path, ua)).status, 200, name);
    await a.settle();
    assert.deepEqual(a.starts, [], name);
    assert.deepEqual(a.created, [], name);
    assert.equal(a.counts.warm, undefined, name);
    assert.deepEqual(a.events('warm_skip').map((o) => o.skipped), skipped ? [skipped] : [], name);
  }
  // A player loading the address plays it (#136); the lookup warm is the tablet's alone, so it adds no log line.
  const a = await app(t);
  assert.equal((await a.get(`/v1/0/s?q=${link()}`, WMF)).status, 302);
  assert.deepEqual(a.events('lookup_warm'), []);
  assert.equal(a.created.length, 1);
});

test('#449: the lookup counts against the per-IP search limit; over it nothing is warmed', async (t) => {
  const a = await app(t, { config: { searchesPerMinutePerIp: 1 } });
  assert.equal((await a.get('/v1/0/s?q=x')).status, 200);
  assert.equal((await a.get(`/v1/0/s?q=${link()}`)).status, 429);
  await a.settle();
  assert.deepEqual(a.created, []);
});

test('#449: uncached lookup warms are capped per IP and in all; over a cap the lookup still answers, with no warm', async (t) => {
  const ids = ['AAAAAAAAAA1', 'AAAAAAAAAA2', 'AAAAAAAAAA3', 'AAAAAAAAAA4'];
  const a = await app(t, { config: { lookupWarmsPerMinutePerIp: 2, lookupWarmsPerMinute: 3 } });
  for (const id of ids.slice(0, 3)) {
    const r = await a.get(`/v1/0/s?q=${link(`https://youtu.be/${id}`)}`, UNITY, '10.0.0.1');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).results[0].id, id, 'the lookup answers as usual');
    await a.settle();
  }
  assert.deepEqual(a.created.map(([id]) => id), ids.slice(0, 2), 'the per-IP cap: two uncached warms');
  assert.deepEqual(a.events('warm_skip').map((o) => [o.reason, o.skipped, o.id]), [['lookup', 'cap', ids[2]]]);
  // A cached build doesn't count: the first link again is looked up and found ready, nothing new is spent.
  await a.get(`/v1/0/s?q=${link(`https://youtu.be/${ids[0]}`)}`, UNITY, '10.0.0.1');
  await a.settle();
  assert.equal(a.events('lookup_warm').at(-1).warm, 'ready');
  assert.equal(a.events('warm_skip').length, 1);
  // The global cap: another IP gets one (3 in all), then a third IP none.
  await a.get(`/v1/0/s?q=${link(`https://youtu.be/${ids[2]}`)}`, UNITY, '10.0.0.2');
  await a.settle();
  await a.get(`/v1/0/s?q=${link(`https://youtu.be/${ids[3]}`)}`, UNITY, '10.0.0.3');
  await a.settle();
  assert.deepEqual(a.created.map(([id]) => id), ids.slice(0, 3));
  assert.deepEqual(a.events('warm_skip').map((o) => o.id), [ids[2], ids[3]]);
  // The tablet's own status load of a capped video still warms it (the cap is the lookup's alone).
  const r = await (await a.get(`/v1/0/s?q=${link(`https://youtu.be/${ids[3]}`)}`, UNITY, '10.0.0.3')).json();
  await a.settle();
  await a.get(`/v1/0/${r.results[0].t}`, UNITY, '10.0.0.3');
  assert.deepEqual(a.created.map(([id]) => id), [...ids.slice(0, 3), ids[3]]);
});

test('uaDevice: a User-Agent naming Quest without Android is android; UnityWebRequest alone is not', async (t) => {
  const a = await app(t);
  await a.get('/v1/0/s?q=x', 'VRChat/2026.4 (Meta Quest 3)');
  await a.get('/v1/0/s?q=x', UNITY);
  assert.deepEqual(a.events('search_shape').map((o) => o.device), ['android', 'unity']);
});

test('a pasted mobile or share link with its own & or + plays, not searched as text (verifier, 2026-11-03)', async (t) => {
  const pre = '/v1/0/s?l=en&q=YouTube%20link%20%E2%86%92%20';
  for (const l of [`www.youtube.com/watch?feature=share&v=${ID}`, `m.youtube.com/watch?app=desktop&v=${ID}`,
    `www.youtube.com/watch?list=PLx1&v=${ID}`, `youtu.be/${ID}?x=a+b`]) {
    const a = await app(t);
    const body = await (await a.get(pre + l)).json();
    assert.deepEqual([body.pasted, body.results?.[0]?.id], [true, ID], `${l}: the tablet's lookup finds the link`);
    const play = await a.get(pre + l, WMF);
    assert.equal(play.status, 302, `${l}: the player is sent to the video, not given JSON`);
  }
});
