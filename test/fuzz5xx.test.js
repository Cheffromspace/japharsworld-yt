// Everything-is-OK#967: eiok-server-errors pages the owner (critical) at the first request answered 5xx that the service
// didn't mean to give (http_5xx). So the internet's noise must never reach it: this sends a few hundred generated
// requests (paths, queries, Authorization headers, prototype words, bad percent-encoding, odd methods) at the real
// server with test fakes, from a fixed seed, and asserts that none is counted as http_5xx and none answers 5xx except
// with a code the service gives on purpose (src/server.js BY_DESIGN_5XX). Raw sockets, so paths reach the server as
// written (fetch would normalise "//" and "..").
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createApp, BY_DESIGN_5XX } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';

// mulberry32: a small seeded generator, so every run sends the same requests.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const WORDS = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty', 'prototype', '..', '.', '%', '%00', '%E0%A4%A',
  '%2e%2e', '%2F', '%25', 'null', 'undefined', 'NaN', '-1', '0', '1', '7', '99999999999999999999', '0x10', '1e9', 'en', 'native', 'ja',
  'cc', 's', 'r', 'o', 'q', 'ch', 'visitor', 'tester', 'frozen', 'pc', 'android', 'f5', 'index.m3u8', 'seg0.ts', 'AbCdEfGhIjK', 'a'.repeat(300),
  'wp-login.php', '.env', '.git', 'admin', 'etc', 'passwd', 'cgi-bin', 'é', '%C3%A9', '%FF', '"', "'", '<script>', '{}', '[]', '\\'];
const PREFIXES = ['/', '//', '///', '/v1/', '/v1/0/', '/v1/1/', '/v1/99/', '/v1/-1/', '/v1/ch/', '/v1/0/cc/', '/v1/0/cc', '/v1/0/s', '/v1/0/r/',
  '/v1/o/', '/v1/0/q/', '/home/', '/hls/', '/hls-test/', '/relay/', '/relay/next', '/ops/', '/ops/state', '/ops/events', '/stats',
  '/stats.json', '/stats/', '/healthz', '/privacy', '/privacy.html', '/feedback', '/s/', '/s/0a', '/logo.png', '/favicon.ico', '/../'];
const KEYS = ['q', 'l', 'token', 'resolve', 'minutes', 'event', 'limit', 'worker', 'version', 'caps', 'x', 'constructor', '__proto__'];
const AUTH = [null, '', 'Bearer ', 'Bearer x', 'Bearer constructor', 'Basic Og==', 'Basic %%%', `Bearer ${'z'.repeat(2000)}`, 'Token\tx', 'bearer AbC'];
const METHODS = ['GET', 'GET', 'GET', 'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'];

function requests(n, seed) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    let path = pick(PREFIXES);
    for (let k = Math.floor(r() * 3); k > 0; k--) path += `${pick(WORDS)}${r() < 0.5 ? '/' : ''}`;
    if (r() < 0.5) {
      const q = [];
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) q.push(r() < 0.2 ? pick(WORDS) : `${pick(KEYS)}=${pick(WORDS)}`);
      path += `?${q.join('&')}`;
    }
    // A request line can't carry raw spaces, CR/LF or bytes over 0x7e; percent forms of those are in WORDS.
    path = path.replace(/[\s\x00-\x1f\x7f-￿]/g, (c) => encodeURIComponent(c));
    out.push({ method: pick(METHODS), path, auth: pick(AUTH) });
  }
  return out;
}

function send(port, { method, path, auth }) {
  return new Promise((done) => {
    const c = net.connect(port, '127.0.0.1', () => {
      c.write(`${method} ${path} HTTP/1.1\r\nHost: x\r\n${auth != null ? `Authorization: ${auth}\r\n` : ''}${method === 'POST' || method === 'PUT' ? 'Content-Length: 0\r\n' : ''}Connection: close\r\n\r\n`);
    });
    let d = '';
    c.setTimeout(3000, () => { c.destroy(); done({ status: 0, body: '' }); });
    c.on('data', (b) => { d += b; });
    c.on('error', () => done({ status: 0, body: d }));
    c.on('end', () => done({ status: Number(d.split(' ')[1]), body: d.slice(d.indexOf('\r\n\r\n') + 4) }));
  });
}

test('fuzz (#967): 300 generated requests from a fixed seed answer no 5xx the service did not mean, and count no http_5xx', async (t) => {
  const config = { ...base, shards: 2, pool: 100, resultsPerPage: 3, searchesPerMinutePerIp: 1000, ticketsPerMinutePerIp: 1000 };
  const incs = [];
  const metrics = { inc: (m, k) => incs.push(`${m}:${k}`), gauge() {}, latency() {}, shard() {}, flush() { return 0; }, start() { return this; }, close() {} };
  const video = (id) => ({ id, title: 'T', channel: 'C', length: '1:00', seconds: 60, views: '1', age: '1 day ago', live: false, cc: true });
  const youtube = { async search(q, limit) { return { videos: Array.from({ length: limit }, (_, i) => video(`AbCdEfGhIj${i}`)), more: null }; }, thumbnailUrl: (id) => `thumb://${id}` };
  const captions = { async get(id, lang) { return { id, lang, available: true, source: 'manual', lines: [[0, 1, 'hi']] }; },
    async tracks(id, lang) { return { id, lang, available: true, tracks: [{ i: 0, code: 'en', name: 'English', auto: false }], track: -1 }; }, warm() {} };
  const app = createApp({ config, store: new Store({ path: ':memory:', shards: 2, pool: 100, pinHours: 24 }), youtube, captions, metrics,
    sheetOpts: { fetcher: async () => Buffer.alloc(0) }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  // Something to play first, so ticket and caption paths have a video behind them.
  await send(port, { method: 'GET', path: '/v1/0/s?q=rain', auth: null });
  const bad = [];
  const statuses = {};
  for (const req of requests(300, 967)) {
    const res = await send(port, req);
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    let code = null;
    try { code = JSON.parse(res.body).error ?? null; } catch {}
    if (res.status >= 500 && !BY_DESIGN_5XX.has(code)) bad.push(`${req.method} ${req.path} -> ${res.status} ${code}`);
  }
  assert.deepEqual(bad, [], 'answered 5xx without meaning to');
  // The harness reached the routes: answers of several kinds, and no silent connection failures (first run, 2026-11-21:
  // 200 x15, 301 x4, 400 x1, 401 x19, 404 x155, 405 x105, 503 x1 by design).
  assert.ok(!statuses[0], `no answer for ${statuses[0]} requests`);
  assert.ok(statuses[200] >= 10 && statuses[404] >= 50 && statuses[405] >= 50, JSON.stringify(statuses));
  assert.deepEqual(incs.filter((x) => x.startsWith('http_5xx:')), []);
});
