// Everything-is-OK#967: eiok-server-errors pages the owner (critical) at the first request answered 5xx that the service
// didn't mean to give (http_5xx). So the internet's noise must never reach it: this sends generated requests (paths,
// queries, Authorization headers with wrong tokens, prototype words, bad percent-encoding, odd methods) at the real
// server with test fakes, and asserts that none is counted as http_5xx and none answers 5xx except with a code the
// service gives on purpose (src/server.js BY_DESIGN_5XX). Raw sockets, so paths reach the server as written (fetch
// would normalise "//" and "..").
// What it reaches (the round 3 verifier's R3-M2): a video is played on shard 0 first, so caption requests get past
// "nothing playing" into the captions code; every word is also sent as a caption language (/v1/0/cc/<word>); tickets
// that were allocated (played and not) and ones that never were; the stats, ops and relay routes with tokens set, so
// a wrong token runs the hash compare; Channels with a monitor database that doesn't exist (the unreadable refusal).
// It does not reach: a request body, a right token, the pasted-link and More paths past their YouTube call, the home
// relay with a worker, Tunelio. The seed is FUZZ_SEED (default 967); other seeds are for runs by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, BY_DESIGN_5XX } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';

const SEED = Number(process.env.FUZZ_SEED) || 967;

// mulberry32: a small seeded generator, so every run with the same seed sends the same requests.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const WORDS = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty', 'isPrototypeOf', 'prototype', '..', '.', '%', '%00',
  '%E0%A4%A', '%2e%2e', '%2F', '%25', 'null', 'undefined', 'NaN', '-1', '0', '1', '7', '99999999999999999999', '0x10', '1e9', 'en', 'native',
  'ja', 'pt-BR', 'zh-Hans', 'cc', 's', 'r', 'o', 'q', 'ch', 'visitor', 'tester', 'frozen', 'pc', 'android', 'f5', 'index.m3u8', 'seg0.ts',
  'AbCdEfGhIjK', 'a'.repeat(300), 'wp-login.php', '.env', '.git', 'admin', 'etc', 'passwd', 'cgi-bin', 'é', '%C3%A9', '%FF', '"', "'",
  '<script>', '{}', '[]', '\\'];
const PREFIXES = ['/', '//', '///', '/v1/', '/v1/0/', '/v1/1/', '/v1/99/', '/v1/-1/', '/v1/ch/', '/v1/0/cc/', '/v1/0/cc', '/v1/0/s', '/v1/0/r/',
  '/v1/o/', '/v1/0/q/', '/home/', '/hls/', '/hls-test/', '/relay/', '/relay/next', '/ops/', '/ops/state', '/ops/events', '/stats',
  '/stats.json', '/stats/', '/healthz', '/privacy', '/privacy.html', '/feedback', '/s/', '/s/0a', '/logo.png', '/favicon.ico', '/../'];
const KEYS = ['q', 'l', 'token', 'resolve', 'minutes', 'event', 'limit', 'worker', 'version', 'caps', 'x', 'constructor', '__proto__'];
// Tokens are set in the server's config below; these are all wrong (one a letter off), so the compare runs and refuses.
const AUTH = [null, '', 'Bearer ', 'Bearer x', 'Bearer constructor', 'Bearer fuzz-stats-tokeN', 'Bearer fuzz-relay-tokeN', 'Basic Og==',
  'Basic %%%', `Bearer ${'z'.repeat(2000)}`, 'Token\tx', 'bearer AbC'];
const METHODS = ['GET', 'GET', 'GET', 'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'];

// A request line can't carry raw spaces, CR/LF or bytes over 0x7e; their percent forms are in WORDS.
const clean = (path) => path.replace(/[\s\x00-\x1f\x7f-￿]/g, (c) => encodeURIComponent(c));

// The same for every seed: every word as a caption language, tickets allocated (0-3; 1 is played) and never allocated.
function fixed() {
  const out = WORDS.map((w) => ({ method: 'GET', path: clean(`/v1/0/cc/${w}`), auth: null }));
  for (const n of ['0', '1', '2', '3', '1.m3u8', '7', '50', '99', '99.m3u8', '-1', '1e3']) {
    out.push({ method: 'GET', path: `/v1/0/${n}`, auth: null }, { method: 'GET', path: `/v1/1/${n}`, auth: null });
  }
  for (const p of ['/stats?token=fuzz-stats-tokeN', '/stats.json?token=', '/ops/state?token=%00', '/ops/events?token=fuzz-stats-token%20']) {
    out.push({ method: 'GET', path: p, auth: null });
  }
  out.push({ method: 'GET', path: '/relay/next?worker=w&version=1', auth: 'Bearer fuzz-relay-tokeN' });
  return out;
}

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
    out.push({ method: pick(METHODS), path: clean(path), auth: pick(AUTH) });
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
    // An answer with no bytes counts as no answer (0), not NaN (the round 3 verifier's R3-L2).
    c.on('end', () => done({ status: Number(d.split(' ')[1]) || 0, body: d.slice(d.indexOf('\r\n\r\n') + 4) }));
  });
}

// Seeds 967 and 1 by default (seed 1 holds a HEAD that meets a by-design 503, so the HEAD rule below stays covered);
// FUZZ_SEED runs one other seed by hand.
const SEEDS = process.env.FUZZ_SEED ? [SEED] : [967, 1];

for (const seed of SEEDS) {
  test(`fuzz (#967): generated requests (seed ${seed}) answer no 5xx the service did not mean, and count no http_5xx`, async (t) => {
    // Fixed here, so the shell's STATS_TOKEN, RELAY_TOKEN, MONITOR_DB or CHANNELS_UPSTREAM can't change which paths run.
    const config = { ...base, shards: 2, pool: 100, resultsPerPage: 3, searchesPerMinutePerIp: 1000, ticketsPerMinutePerIp: 1000,
      statsToken: 'fuzz-stats-token', relayToken: 'fuzz-relay-token', monitorDb: join(tmpdir(), 'eiok-fuzz-no-monitor.db'), channelsUpstream: '' };
    const incs = [];
    const metrics = { inc: (m, k) => incs.push(`${m}:${k}`), gauge() {}, latency() {}, shard() {}, flush() { return 0; }, start() { return this; }, close() {} };
    const video = (id) => ({ id, title: 'T', channel: 'C', length: '1:00', seconds: 60, views: '1', age: '1 day ago', live: false, cc: true });
    const youtube = { async search(q, limit) { return { videos: Array.from({ length: limit }, (_, i) => video(`AbCdEfGhIj${i}`)), more: null }; }, thumbnailUrl: (id) => `thumb://${id}` };
    const asked = []; // the captions fake's calls: a caption request that got past "nothing playing"
    const captions = { async get(id, lang) { asked.push(lang); return { id, lang, available: true, source: 'manual', lines: [[0, 1, 'hi']] }; },
      async tracks(id, lang) { return { id, lang, available: true, tracks: [{ i: 0, code: 'en', name: 'English', auto: false }], track: -1 }; },
      async track(id, i, lang) { asked.push(i); return { id, lang, available: i === 0, reason: i === 0 ? undefined : 'no_track_in_language', lines: [[0, 1, 'hi']] }; }, warm() {} };
    const app = createApp({ config, store: new Store({ path: ':memory:', shards: 2, pool: 100, pinHours: 24 }), youtube, captions, metrics,
      sheetOpts: { fetcher: async () => Buffer.alloc(0) }, log: () => {} });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const { port } = server.address();
    // A search allocates tickets 0-3 on shard 0; playing ticket 1 puts a video behind shard 0's caption requests.
    const search = await send(port, { method: 'GET', path: '/v1/0/s?q=rain', auth: null });
    assert.equal(search.status, 200);
    const played = await send(port, { method: 'GET', path: '/v1/0/1', auth: null });
    assert.equal(played.status, 302, 'ticket 1 played');
    const bad = [];
    const statuses = {};
    const http5xx = () => incs.filter((x) => x.startsWith('http_5xx:')).length;
    for (const req of [...fixed(), ...requests(300, seed)]) {
      const before = http5xx();
      const res = await send(port, req);
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (res.status < 500) continue;
      let code = null;
      try { code = JSON.parse(res.body).error ?? null; } catch {}
      // A HEAD answer has no body to read the code from (seed 1, 2026-11-21: HEAD on a Channels slot, the by-design
      // 503 for a monitor status that can't be read). So the same path is asked again as GET: its answer must be 5xx
      // with a by-design code, and neither request may count an http_5xx (the coordinator's rule: a by-design code is
      // read, not assumed).
      if (req.method === 'HEAD') {
        const twin = await send(port, { ...req, method: 'GET' });
        try { code = JSON.parse(twin.body).error ?? null; } catch { code = null; }
        if (twin.status < 500) code = `GET twin answered ${twin.status}`;
      }
      if (!BY_DESIGN_5XX.has(code) || http5xx() !== before) bad.push(`${req.method} ${req.path} -> ${res.status} ${code}${http5xx() !== before ? ' (counted as http_5xx)' : ''}`);
    }
    assert.deepEqual(bad, [], 'answered 5xx without meaning to');
    assert.deepEqual(incs.filter((x) => x.startsWith('http_5xx:')), []);
    // The harness reached the routes: answers of several kinds, no silent connection failures, and the token routes
    // refusing (401).
    assert.ok(!statuses[0], `no answer for ${statuses[0]} requests`);
    assert.ok(statuses[200] >= 40 && statuses[404] >= 50 && statuses[405] >= 50 && statuses[401] >= 5, JSON.stringify(statuses));
    // Every word the /cc/<lang> route accepts (src/server.js: [A-Za-z-]+, or a track number of 1-3 digits) reached the
    // captions code with shard 0's played video behind it (seed 967, 2026-11-21: 36 of them, plus the random ones).
    const asCaption = WORDS.filter((w) => /^(?:[A-Za-z-]+|\d{1,3})$/.test(w)).length;
    assert.ok(asked.length >= asCaption, `${asked.length} caption requests reached the captions code, of at least ${asCaption}`);
  });
}
