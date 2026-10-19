import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Relay, tokenMatches } from '../src/relay.js';
import { DataApi, mapApiVideo, parseDuration, lengthText, shortCount, ageText } from '../src/dataapi.js';
import { createWorker } from '../relay/worker.js';
import { config as base } from '../src/config.js';

const TOKEN = 'secret-token';
const config = { ...base, shards: 2, pool: 200, resultsPerPage: 3, searchesPerMinutePerIp: 50, relayToken: TOKEN, relayWaitMs: 1500 };
const video = (id) => ({ id, title: `Title ${id}`, channel: 'Ch', length: '1:00', seconds: 60, views: '1 view', age: '1 day ago', live: false, cc: true });

// A fake InnerTube: pages of `limit` videos named <tag><page><i>, three pages deep. `fail` = how many calls throw.
function fakeYoutube(tag, { fail = 0, error = 'Request failed with status code 403' } = {}) {
  const calls = [];
  let resets = 0;
  return {
    calls, get resets() { return resets; },
    resetClient() { resets++; },
    async search(q, limit) {
      calls.push(q);
      if (fail-- > 0) throw new Error(error);
      const page = (p) => ({
        videos: Array.from({ length: limit }, (_, i) => video(`${tag}${p}${i}`.padEnd(11, 'x'))),
        more: p < 3 ? async () => page(p + 1) : null,
      });
      return page(1);
    },
    thumbnailUrl: (id) => `thumb://${id}`,
  };
}

async function start({ youtube = fakeYoutube('L'), api, alert } = {}) {
  const store = new Store({ path: ':memory:', shards: config.shards, pool: config.pool, pinHours: 24 });
  const logs = [];
  const red = await sharp({ create: { width: 32, height: 18, channels: 3, background: '#f7768e' } }).jpeg().toBuffer();
  const relay = new Relay({ token: TOKEN, pollMs: 300 });
  const captions = { async get() { return {}; } };
  const app = createApp({ config, store, youtube, captions, relay, api, alert, sheetOpts: { fetcher: async () => red },
    log: (l) => logs.push(JSON.parse(l)) });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, init) => {
    const res = await fetch(url + path, { redirect: 'manual', ...init });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? await res.json() : null };
  };
  const workers = [];
  const startWorker = (yt, name = 'optiplex') => {
    const w = createWorker({ url, token: TOKEN, name, version: 'test', polls: 2, youtube: yt, log: () => {} });
    workers.push(w);
    w.start();
    return w;
  };
  const waitOnline = async (n = 1) => { for (let i = 0; i < 100 && relay.online().length < n; i++) await new Promise((r) => setTimeout(r, 10)); };
  const close = () => { workers.forEach((w) => w.stop()); server.closeAllConnections(); server.close(); };
  return { url, get, relay, app, logs, startWorker, waitOnline, close };
}

const searches = (logs) => logs.filter((l) => l.event === 'search');

test('relay routes need the bearer token', async (t) => {
  const s = await start();
  t.after(s.close);
  assert.equal((await s.get('/relay/next?worker=x')).status, 401);
  assert.equal((await s.get('/relay/next?worker=x', { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await s.get('/relay/done', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await s.get('/relay/next?worker=x', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 204);
  assert.equal(tokenMatches(`Bearer ${TOKEN}`, ''), false);
});

test('search goes through the worker; More results goes back to the same worker', async (t) => {
  const s = await start();
  t.after(s.close);
  const home = fakeYoutube('W');
  s.startWorker(home);
  await s.waitOnline();
  const r = await s.get(`/v1/1/s?l=en&q=${encodeURIComponent('x → dangerouslyfunny')}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((v) => v.id), ['W10xxxxxxxx', 'W11xxxxxxxx', 'W12xxxxxxxx']);
  assert.deepEqual(r.body.results[0], { t: r.body.results[0].t, ...video('W10xxxxxxxx') });
  assert.deepEqual(home.calls, ['dangerouslyfunny']);
  assert.equal(searches(s.logs).at(-1).via, 'worker');
  assert.equal(searches(s.logs).at(-1).worker, 'optiplex');

  const next = await s.get(`/v1/1/${r.body.next}`);
  assert.equal(next.status, 200);
  assert.equal(next.body.results[0].id, 'W20xxxxxxxx');
  const health = (await s.get('/healthz')).body;
  assert.equal(health.workers, 1);
  assert.equal(health.lastSearchVia, 'worker');
  assert.equal(health.apiUnitsToday, 0);
});

test('worker gone: More results is 410 expired; new searches run locally', async (t) => {
  const s = await start();
  t.after(s.close);
  const w = s.startWorker(fakeYoutube('W'));
  await s.waitOnline();
  const r = await s.get('/v1/0/s?q=rain');
  assert.equal(searches(s.logs).at(-1).via, 'worker');
  w.stop();
  const info = s.relay.workers.get('optiplex');
  for (let i = 0; i < 100 && info.polling; i++) await new Promise((r2) => setTimeout(r2, 10));
  info.seen -= 60_000; // last poll a minute ago
  assert.deepEqual(s.relay.online(), []);
  assert.equal((await s.get(`/v1/0/${r.body.next}`)).body.error, 'expired');
  const again = await s.get('/v1/0/s?q=rain');
  assert.equal(again.status, 200);
  assert.equal(again.body.results[0].id, 'L10xxxxxxxx');
  assert.equal(searches(s.logs).at(-1).via, 'local');
});

test('worker that does not answer in time: falls through to local', async (t) => {
  const s = await start();
  t.after(s.close);
  const slow = { ...fakeYoutube('W'), search: () => new Promise(() => {}) };
  s.startWorker(slow);
  await s.waitOnline();
  const r = await s.get('/v1/0/s?q=slow');
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].id, 'L10xxxxxxxx');
  assert.deepEqual(s.logs.filter((l) => l.event === 'youtube_error').map((l) => l.via), ['worker']);
});

test('worker error: falls through to local', async (t) => {
  const s = await start();
  t.after(s.close);
  s.startWorker(fakeYoutube('W', { fail: 99, error: 'boom' }));
  await s.waitOnline();
  const r = await s.get('/v1/0/s?q=err');
  assert.equal(r.body.results[0].id, 'L10xxxxxxxx');
  assert.equal(searches(s.logs).at(-1).via, 'local');
});

test('local 403: fresh session, one retry', async (t) => {
  const yt = fakeYoutube('L', { fail: 1 });
  const s = await start({ youtube: yt });
  t.after(s.close);
  const r = await s.get('/v1/0/s?q=retry');
  assert.equal(r.status, 200);
  assert.equal(yt.resets, 1);
  assert.equal(yt.calls.length, 2);
  // Two 403s in a row (and no API key): the usual 502.
  const yt2 = fakeYoutube('L', { fail: 2 });
  const s2 = await start({ youtube: yt2 });
  t.after(s2.close);
  assert.equal((await s2.get('/v1/0/s?q=retry')).body.error, 'youtube_failed');
  assert.equal(yt2.calls.length, 2);
});

function fakeFetch(sample) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const body = url.pathname.endsWith('/search') ? sample.search : sample.videos;
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetcher };
}
const sample = JSON.parse(readFileSync(new URL('./fixtures/dataapi-sample.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-19T03:00:00Z');

test('Data API fallback when the worker and the Linode both fail; alert; units', async (t) => {
  const f = fakeFetch(sample);
  const alerts = [];
  const alert = (kind, text) => { alerts.push(kind); return true; };
  const api = new DataApi({ key: 'k', fetcher: f.fetcher, alert, now: () => NOW });
  const s = await start({ youtube: fakeYoutube('L', { fail: 99 }), api, alert });
  t.after(s.close);
  const r = await s.get('/v1/0/s?q=rick');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((v) => v.id), ['vkBC2msYpDY', 'jfKfPfyJRdk', 'dQw4w9WgXcQ']);
  assert.equal(searches(s.logs).at(-1).via, 'api');
  assert.ok(alerts.includes('api_fallback'));
  assert.equal(f.calls[0].searchParams.get('maxResults'), '3');
  assert.equal(f.calls[0].searchParams.get('type'), 'video');
  assert.equal(f.calls[1].searchParams.get('id'), 'vkBC2msYpDY,jfKfPfyJRdk,dQw4w9WgXcQ');
  assert.equal((await s.get('/healthz')).body.apiUnitsToday, 101);
  // More results uses the page token.
  const next = await s.get(`/v1/0/${r.body.next}`);
  assert.equal(next.status, 200);
  assert.equal(f.calls[2].searchParams.get('pageToken'), 'CBQQAA');
  assert.equal(api.unitsToday, 202);
});

test('Data API mapping matches mapVideo()', () => {
  const details = new Map(sample.videos.items.map((v) => [v.id, v]));
  const m = sample.search.items.map((i) => mapApiVideo(i, details.get(i.id.videoId), NOW));
  assert.deepEqual(m[0], { id: 'vkBC2msYpDY', title: 'An Incremental Game About Upgrading Shapes & Things', channel: 'DangerouslyFunny',
    length: '1:14:09', seconds: 4449, views: '251K views', age: '1 month ago', live: false, cc: false });
  assert.deepEqual(m[1], { id: 'jfKfPfyJRdk', title: 'lofi hip hop radio 📚 beats to relax/study to', channel: 'Lofi Girl',
    length: '', seconds: 0, views: '15K watching', age: '', live: true, cc: false });
  assert.deepEqual(m[2], { id: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', channel: 'Rick Astley',
    length: '3:34', seconds: 214, views: '1.7B views', age: '16 years ago', live: false, cc: true });
  // Without videos.list details, the search snippet is unescaped.
  assert.equal(mapApiVideo(sample.search.items[0], undefined, NOW).title, 'An Incremental Game About Upgrading Shapes & Things');
  assert.equal(parseDuration('PT45S'), 45);
  assert.equal(parseDuration('P1DT2H'), 93600);
  assert.equal(lengthText(3600), '1:00:00');
  assert.equal(lengthText(65), '1:05');
  assert.deepEqual([999, 1000, 1534, 15234, 251873, 1_234_567, 25_000_000].map(shortCount), ['999', '1K', '1.5K', '15K', '251K', '1.2M', '25M']);
  assert.equal(ageText('2026-10-18T03:00:00Z', NOW), '1 day ago');
  assert.equal(ageText('2026-10-19T02:58:00Z', NOW), '2 minutes ago');
});

test('Data API quota alert above 80 %', async () => {
  const alerts = [];
  const api = new DataApi({ key: 'k', dailyUnits: 250, fetcher: fakeFetch(sample).fetcher, alert: (k) => alerts.push(k), now: () => NOW });
  await api.search('a', 20);
  assert.deepEqual(alerts, []);
  await api.search('b', 20);
  assert.deepEqual([...new Set(alerts)], ['api_quota']);
});

test('no API key: Data API never called', async (t) => {
  let called = false;
  const api = new DataApi({ key: '', fetcher: async () => { called = true; } });
  const s = await start({ youtube: fakeYoutube('L', { fail: 99 }), api });
  t.after(s.close);
  assert.equal((await s.get('/v1/0/s?q=x')).body.error, 'youtube_failed');
  assert.equal(called, false);
});

test('"no search worker" alert after 10 minutes without a worker', async (t) => {
  const alerts = [];
  const s = await start({ alert: (k) => alerts.push(k) });
  t.after(s.close);
  s.app.checkWorkers();
  assert.deepEqual(alerts, []);
  s.relay.lastSeenAny -= 11 * 60_000;
  s.app.checkWorkers();
  assert.deepEqual(alerts, ['no_worker']);
});

test('worker keeps continuations and answers expired for unknown ones', async () => {
  const w = createWorker({ url: 'http://x', token: 't', youtube: fakeYoutube('W'), log: () => {} });
  const r = await w.handle({ id: '1', kind: 'search', query: 'q', limit: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.page.videos.length, 2);
  const more = await w.handle({ id: '2', kind: 'more', cont: r.page.cont });
  assert.equal(more.page.videos[0].id, 'W20xxxxxxxx');
  assert.deepEqual(await w.handle({ id: '3', kind: 'more', cont: r.page.cont }), { id: '3', ok: false, error: 'expired' });
});
