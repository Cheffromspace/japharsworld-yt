// Everything-is-OK#478 / #522 (owner, 2026-11-04: 100k credits a month, load balance home and Tunelio): the month
// budget, the home-first point, home's stream capacity, the routing rule and its build_route event, and the ticket
// route's per-IP limit. No real credits: Tunelio is a fake; home is a real Relay with an in-process worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { Home } from '../src/home.js';
import { Playback } from '../src/playback.js';
import { SpendGate, spendScope } from '../src/spend.js';
import { createWorker } from '../relay/worker.js';
import { config as base } from '../src/config.js';

const TOKEN = 'secret-token';
const WMF = 'NSPlayer/12.00.26100.1234 WMFSDK/12.00.26100.1234';
const UNITY = 'UnityPlayer/6000.0.67f1-DWR (UnityWebRequest/1.0, libcurl/8.10.1-DEV)';
// Two segments listed with the end marker, one uploaded: ready to play, still uploading (an active stream), and not a
// growing playlist (so a long play isn't given up for Tunelio).
const PL = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n';
const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'route-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const vid = (i) => `Vid${String(i).padStart(8, '0')}`;

function fakeTunelio({ hang = () => false } = {}) {
  const created = [];
  return { created, enabled: true, async create(id, q) {
    created.push([id, q]);
    if (hang(id)) return new Promise(() => {});
    return { url: `https://tunelio.dev/tunnel?id=${id}&q=${q}`, expires: Math.floor(Date.now() / 1000) + 3600, quality: q, fileSize: 1e8 };
  } };
}

// The service with a home worker taking `mediaMax` streams, a real Playback over a fake Tunelio and the given spend gate.
async function routeApp(t, { mediaMax = 4, spend = new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 0 }), tunelio = fakeTunelio(), config: c = {} } = {}) {
  const dir = tmp(t);
  const config = { ...base, shards: 2, pool: 200, relayToken: TOKEN, homeRelay: true, homeReadyMs: 5000, dbPath: join(dir, 'tickets.db'), publicUrl: 'http://pub',
    metricsPath: '', tunelioQuality: '720p', ticketPlayerHoldMs: 3000, adaptiveHls: false, lookupWarm: false, videoMaxSeconds: 43200, homeFreeFloorGb: 0, ...c };
  const store = new Store({ path: ':memory:', shards: 2, pool: 200, pinHours: 24 });
  const relay = new Relay({ token: TOKEN, pollMs: 200 });
  const playback = new Playback({ tunelio, quality: '720p', probe: async () => ({ ok: true, refused: false }), spend });
  const logs = [];
  const app = createApp({ config, store, relay, tunelio, playback, spend, captions: { async get() { return {}; } }, log: (l) => { try { logs.push(JSON.parse(l)); } catch { /* request lines */ } } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const jobs = [];
  const worker = createWorker({ url, token: TOKEN, name: 'home', polls: 2, caps: ['media'], mediaMax, log: () => {}, txBytes: () => null,
    media: async (job) => {
      jobs.push(job);
      const put = (file, body) => fetch(`${url}/relay/media/${job.token}/${file}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body });
      await put('seg0.ts', 'ts0');
      await put('index.m3u8', PL);
      return { ready: true, segments: 1, done: new Promise(() => {}) }; // still uploading
    } });
  worker.start();
  t.after(() => worker.stop());
  while (!relay.capable('media').length) await new Promise((r) => setTimeout(r, 20));
  const ticket = (id, seconds = 600) => store.allocate(0, [{ kind: 'video', data: { id, title: 'T', seconds, live: false } }])[0];
  const get = (n, ua = WMF, ip = '192.0.2.1') => fetch(`${url}/v1/0/${n}`, { redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': ip } });
  const routes = () => logs.filter((l) => l.event === 'build_route');
  return { get, ticket, jobs, logs, routes, tunelio, spend, app, url };
}

test('spend: the month budget is a hard stop per billing period, survives a restart, starts again at renewal and takes refunds', (t) => {
  const stateFile = join(tmp(t), 'spend-budget.json');
  let key = '2026-11-01';
  const logs = [];
  const a = new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 30, monthKey: () => key, stateFile, log: (o) => logs.push(o) });
  a.charge(); a.charge();
  const refund = a.charge();
  assert.equal(a.spentMonth(), 30);
  refund();
  assert.equal(a.spentMonth(), 20, 'a failed call is given back to the month too');
  a.charge();
  assert.equal(a.refuse('x'), 'budget', 'the next 10 would pass 30');
  assert.equal(logs.find((l) => l.event === 'spend_budget')?.window, 'month');
  const b = new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 30, monthKey: () => key, stateFile });
  assert.equal(b.spentMonth(), 30, 'a restart keeps the month');
  assert.equal(b.refuse('x'), 'budget');
  key = '2026-12-01';
  assert.equal(b.spentMonth(), 0, 'the plan renewed');
  assert.equal(b.refuse('x'), null);
});

test('spend: near() passes the home-first point at 75 % of the hour or day budget, not before', () => {
  const g = new SpendGate({ hourCredits: 100, dayCredits: 1000, monthCredits: 0 });
  g.charge(70);
  assert.equal(g.near(), null);
  g.charge(5);
  assert.equal(g.near(), 'hour');
  const d = new SpendGate({ hourCredits: 0, dayCredits: 100, monthCredits: 0 });
  d.charge(80);
  assert.equal(d.near(), 'day');
  assert.equal(new SpendGate({ hourCredits: 100, homeFirstPercent: 0 }).near(), null, '0 turns it off');
  assert.deepEqual(Object.keys(g.totals()), ['hour', 'day', 'month']);
});

test('home: a worker running as many streams as it announced takes no new session; one finishing frees it', async (t) => {
  const jobs = [];
  const relay = { enabled: true, capable: () => ['w'], mediaMax: () => ({ w: 2 }), run(job) { jobs.push(job); return new Promise(() => {}); } };
  const home = new Home({ relay, dir: tmp(t), base: 'https://yt/home', enabled: true });
  const a = home.start({ id: 'aaaaaaaaaaa', seconds: 600 }, '720p');
  home.start({ id: 'bbbbbbbbbbb', seconds: 600 }, '720p');
  assert.deepEqual(home.load(), { active: 2, max: 2, free: false });
  assert.equal(home.worker(), null);
  assert.equal(home.start({ id: 'ccccccccccc', seconds: 600 }, '720p'), null, 'no third stream sent to a 2-stream worker');
  assert.equal(jobs.length, 2);
  assert.equal(home.peek({ id: 'aaaaaaaaaaa' }, '720p'), a, 'a session already there is still found');
  // a finishes uploading: its stream is free again.
  home.put(a.token, 'seg0.ts', Buffer.from('ts0'));
  home.put(a.token, 'index.m3u8', Buffer.from('#EXTM3U\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n'));
  assert.equal(a.ended, true);
  assert.deepEqual(home.load(), { active: 1, max: 2, free: true });
  assert.equal(home.worker(), 'w');
  assert.deepEqual(home.state().streams, { active: 1, max: 2 });
  // A worker that announced no limit is never full by this check (the daily caps still apply).
  const open = new Home({ relay: { enabled: true, capable: () => ['w'], run: () => new Promise(() => {}) }, dir: tmp(t), enabled: true });
  for (const id of ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']) assert.ok(open.start({ id, seconds: 600 }, '720p'));
  assert.deepEqual(open.load(), { active: 3, max: null, free: true });
});

test('routing: a long video goes home; with home full the next goes to Tunelio, and both say so in build_route', async (t) => {
  const a = await routeApp(t, { mediaMax: 1 });
  const first = await a.get(a.ticket(vid(1), 3600));
  assert.match(first.headers.get('location'), /^http:\/\/pub\/home\//);
  const second = await a.get(a.ticket(vid(2), 3600));
  assert.match(second.headers.get('location'), /tunelio\.dev/, 'home is full: Tunelio, not a fifth stream that answers busy');
  assert.equal(a.jobs.length, 1, 'no job sent to the full worker');
  const [home, tun] = a.routes();
  assert.deepEqual([home.via, home.why, home.homeMax], ['home', 'long', 1]);
  assert.deepEqual([tun.via, tun.why, tun.homeActive, tun.homeMax], ['tunelio', 'home_full', 1, 1]);
  assert.ok(Number.isFinite(tun.hour) && Number.isFinite(tun.month));
});

test('routing: past 75 % of the hour budget a new play goes home first; a cached Tunelio build is still used', async (t) => {
  const spend = new SpendGate({ hourCredits: 100, dayCredits: 0, monthCredits: 0 });
  const a = await routeApp(t, { spend });
  const cached = a.ticket(vid(1));
  assert.match((await a.get(cached)).headers.get('location'), /tunelio\.dev/);
  spend.charge(70); // 80 of 100 now
  const r = await a.get(a.ticket(vid(2)));
  assert.match(r.headers.get('location'), /^http:\/\/pub\/home\//);
  assert.deepEqual(a.tunelio.created.map(([id]) => id), [vid(1)], 'no new paid build');
  assert.deepEqual(a.routes().map((e) => [e.via, e.why]), [['tunelio', 'default'], ['home', 'near_budget']]);
  // The first video, built already, plays from Tunelio again at no cost.
  assert.match((await a.get(cached, WMF, '192.0.2.9')).headers.get('location'), /tunelio\.dev/);
  assert.equal(a.tunelio.created.length, 1);
});

test('routing: with TUNELIO_BUSY_BUILDS Tunelio builds running, the next play goes home', async (t) => {
  const tunelio = fakeTunelio({ hang: (id) => id === vid(1) });
  const a = await routeApp(t, { tunelio, config: { tunelioBusyBuilds: 1 } });
  // The tablet starts a build that runs on (Tunelio slow to answer).
  const st = await (await a.get(a.ticket(vid(1)), UNITY)).json();
  assert.equal(st.state, 'building');
  const r = await a.get(a.ticket(vid(2)));
  assert.match(r.headers.get('location'), /^http:\/\/pub\/home\//);
  assert.deepEqual(a.routes().map((e) => [e.via, e.why, e.tunelioBuilding]), [['tunelio', 'default', 0], ['home', 'tunelio_busy', 1]]);
});

test('routing: home full and Tunelio over its budget: youtube.com, logged as a youtube build_route', async (t) => {
  const spend = new SpendGate({ hourCredits: 20, dayCredits: 0, monthCredits: 0, homeFirstPercent: 0 });
  const a = await routeApp(t, { mediaMax: 1, spend });
  assert.match((await a.get(a.ticket(vid(1), 3600))).headers.get('location'), /^http:\/\/pub\/home\//);
  spend.charge(20);
  const r = await a.get(a.ticket(vid(2)));
  assert.equal(r.headers.get('location'), `https://www.youtube.com/watch?v=${vid(2)}`);
  assert.deepEqual(a.routes().map((e) => [e.via, e.why]), [['home', 'long'], ['youtube', 'budget']]);
  assert.equal(a.tunelio.created.length, 0);
});

test('routing: the month budget spent sends plays home, and to youtube.com once home is full too', async (t) => {
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 10, homeFirstPercent: 0 });
  spend.charge(10);
  const a = await routeApp(t, { mediaMax: 1, spend });
  assert.match((await a.get(a.ticket(vid(1)))).headers.get('location'), /^http:\/\/pub\/home\//);
  assert.equal((await a.get(a.ticket(vid(2)))).headers.get('location'), `https://www.youtube.com/watch?v=${vid(2)}`);
  assert.deepEqual(a.routes().map((e) => [e.via, e.why]), [['home', 'budget'], ['youtube', 'budget']]);
});

test('ticket route: over TICKETS_PER_MINUTE_PER_IP a client gets 429 rate_limited; other IPs and trusted ones go on', async (t) => {
  const a = await routeApp(t, { config: { ticketsPerMinutePerIp: 3, trustedIps: '198.51.100.7', trustedIpFactor: 2 } });
  const n = a.ticket(vid(1));
  for (let i = 0; i < 3; i++) assert.equal((await a.get(n, UNITY, '192.0.2.1')).status, 200);
  const over = await a.get(n, UNITY, '192.0.2.1');
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error, 'rate_limited');
  await a.get(n, UNITY, '192.0.2.1');
  assert.equal(a.logs.filter((l) => l.event === 'ticket_limited').length, 1, 'logged once while it refuses');
  assert.equal((await a.get(n, UNITY, '192.0.2.2')).status, 200, 'another IP has its own count');
  for (let i = 0; i < 6; i++) assert.equal((await a.get(n, UNITY, '198.51.100.7')).status, 200, 'trusted: 3 x 2');
  assert.equal((await a.get(n, UNITY, '198.51.100.7')).status, 429);
});

test('spend scope: a route set by one request does not leak into another', async () => {
  const seen = [];
  await Promise.all([
    spendScope.run({ ip: 'a' }, async () => { spendScope.getStore().route = 'home_full'; await new Promise((r) => setTimeout(r, 5)); seen.push(spendScope.getStore().route); }),
    spendScope.run({ ip: 'b' }, async () => { await new Promise((r) => setTimeout(r, 1)); seen.push(spendScope.getStore().route ?? 'default'); }),
  ]);
  assert.deepEqual(seen.sort(), ['default', 'home_full']);
});
