import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';

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
  const captions = { async get(id, lang) { captionCalls.push([id, lang]); return { id, lang, available: true, source: 'manual', lines: [[0, 1, 'hi']] }; } };
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
  return { server, get, youtube, captionCalls, store };
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
});

test('pasted link goes first', async (t) => {
  const s = await start();
  t.after(() => s.server.close());
  const r = await s.get(`/v1/0/s?q=${encodeURIComponent('Search → https://youtu.be/AbCdEfGhIjK')}`);
  assert.equal(r.body.pasted, true);
  assert.equal(r.body.results[0].id, 'AbCdEfGhIjK');
  assert.deepEqual(s.youtube.calls, ['AbCdEfGhIjK']);
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
