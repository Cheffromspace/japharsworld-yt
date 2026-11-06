// Everything-is-OK#478 / #522 (owner, 2026-11-04: 100k credits a month, load balance home and Tunelio): the month
// budget, the home-first point, home's stream capacity, the routing rule and its build_route event, and the ticket
// route's per-IP limit. No real credits: Tunelio is a fake; home is a real Relay with an in-process worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { Home } from '../src/home.js';
import { Playback } from '../src/playback.js';
import { SpendGate, spendScope } from '../src/spend.js';
import { Allowance } from '../src/allowance.js';
import { Adaptive } from '../src/adaptive.js';
import { IpKeys } from '../src/ipkey.js';
import { trustedIps } from '../src/trusted.js';
import { ForcedLimits, allowedHere } from '../src/forced.js';
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
async function routeApp(t, { mediaMax = 4, spend = new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 0 }), tunelio = fakeTunelio(), config: c = {}, playbackOpts = {}, adaptive } = {}) {
  const dir = tmp(t);
  const config = { ...base, shards: 2, pool: 200, relayToken: TOKEN, homeRelay: true, homeReadyMs: 5000, homeStartGapMs: 0, homeHourBuilds: 0, homeHourMb: 0, dbPath: join(dir, 'tickets.db'), publicUrl: 'http://pub',
    metricsPath: '', tunelioQuality: '720p', ticketPlayerHoldMs: 3000, adaptiveHls: false, lookupWarm: false, videoMaxSeconds: 43200, homeFreeFloorGb: 0, ...c };
  const store = new Store({ path: ':memory:', shards: 2, pool: 200, pinHours: 24 });
  const relay = new Relay({ token: TOKEN, pollMs: 200 });
  const playback = new Playback({ tunelio, quality: '720p', probe: async () => ({ ok: true, refused: false }), spend, ...playbackOpts });
  const logs = [];
  const app = createApp({ config, store, relay, tunelio, playback, spend, adaptive, captions: { async get() { return {}; } }, log: (l) => { try { logs.push(JSON.parse(l)); } catch { /* request lines */ } } });
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
  const allocate = (item) => store.allocate(0, [item])[0];
  const get = (n, ua = WMF, ip = '192.0.2.1') => fetch(`${url}/v1/0/${n}`, { redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': ip } });
  const routes = () => logs.filter((l) => l.event === 'build_route');
  return { get, ticket, allocate, jobs, logs, routes, tunelio, spend, app, url };
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

test('spend: a state file from before the month window starts the month at its 24 h total', (t) => {
  const stateFile = join(tmp(t), 'spend-budget.json');
  writeFileSync(stateFile, JSON.stringify({ spends: [{ at: Date.now() - 3600_000, c: 30 }, { at: Date.now() - 60_000, c: 10 }], alertedAt: null, okDue: false }));
  const g = new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 45, stateFile });
  assert.equal(g.spentMonth(), 40, 'not a fresh month');
  assert.equal(g.refuse('x'), 'budget', '40 + 10 passes 45');
  // A file of another period's month keeps only this period's (none yet).
  writeFileSync(stateFile, JSON.stringify({ spends: [{ at: Date.now() - 60_000, c: 10 }], month: { key: '1999-01', c: 999 } }));
  assert.equal(new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 45, stateFile }).spentMonth(), 0);
});

test('ticket route: a video player does not count toward the ticket limit; status and other tickets do', async (t) => {
  const a = await routeApp(t, { config: { ticketsPerMinutePerIp: 2 } });
  const n = a.ticket(vid(1));
  for (let i = 0; i < 2; i++) assert.equal((await a.get(n, UNITY)).status, 200);
  assert.equal((await a.get(n, UNITY)).status, 429, 'the tablet status is limited');
  for (let i = 0; i < 3; i++) assert.equal((await a.get(n, WMF)).status, 302, 'the player still plays');
  // A player User-Agent on a ticket that isn't a video (here a More page) is limited like any request.
  const page = a.allocate({ kind: 'page', data: { page: 1 } });
  assert.equal((await a.get(page, WMF)).status, 429);
  // Player loads didn't use up another IP's or this one's count: a fresh IP gets its full 2.
  for (let i = 0; i < 3; i++) await a.get(n, WMF, '192.0.2.50');
  assert.equal((await a.get(n, UNITY, '192.0.2.50')).status, 200);
  assert.equal((await a.get(n, UNITY, '192.0.2.50')).status, 200);
});

test('routing: the build_route metric counts a video once per route, though its play made two paid /create calls (a downgrade)', async (t) => {
  // 1080p is over maxMbForQuality, so the play makes it again at 720p: two paid calls, one video.
  const a = await routeApp(t, { config: { tunelioQuality: '1080p' }, playbackOpts: { quality: '1080p', lowerQuality: '720p', maxMbForQuality: 50 } });
  assert.match((await a.get(a.ticket(vid(1)))).headers.get('location'), /tunelio\.dev/);
  assert.deepEqual(a.tunelio.created.map(([, q]) => q), ['1080p', '720p']);
  assert.deepEqual(a.routes().map((e) => [e.via, e.quality, e.counted]), [['tunelio', '1080p', true], ['tunelio', '720p', false]]);
  // Another video counts on its own.
  await a.get(a.ticket(vid(2)));
  assert.equal(a.routes().filter((e) => e.counted).length, 2);
});

test('allowance: one daily allowance per IP for Tunelio credits and home builds and MB; any one used up stops every new build', () => {
  let now = Date.parse('2026-11-04T18:00:00Z');
  const logs = [];
  const a = new Allowance({ creditsPerIp: 30, homeBuildsPerIp: 2, homeMbPerIp: 1000, now: () => now, log: (o) => logs.push(o) });
  const ip = '192.0.2.1';
  assert.equal(a.over(ip, { credits: 10 }), null);
  a.charge(ip, { credits: 10 }); a.charge(ip, { credits: 10 });
  const refund = a.charge(ip, { credits: 10 });
  assert.equal(a.over(ip, { credits: 10 }), 'credits');
  assert.equal(a.over(ip, { home: true, homeMb: 10 }), 'credits', 'credits used up: no home build either');
  refund();
  assert.equal(a.over(ip, { credits: 10 }), null, 'a failed call is given back');
  assert.equal(a.over('192.0.2.2', { credits: 10 }), null, 'another IP has its own');
  // Home builds and MB.
  const h = new Allowance({ creditsPerIp: 0, homeBuildsPerIp: 2, homeMbPerIp: 1000, now: () => now });
  assert.equal(h.over(ip, { home: true, homeMb: 5000 }), null, 'a first home build always fits');
  h.charge(ip, { homeBuilds: 1, homeMb: 5000 });
  assert.equal(h.over(ip, { home: true, homeMb: 10 }), 'home_mb');
  assert.equal(h.over(ip, { credits: 10 }), 'home_mb', 'home MB used up: no Tunelio build either');
  const b = new Allowance({ creditsPerIp: 0, homeBuildsPerIp: 1, homeMbPerIp: 0, now: () => now });
  b.charge(ip, { homeBuilds: 1 });
  assert.equal(b.over(ip, { home: true }), 'home_builds');
  // Logged once per IP, day and kind, with no IP; the next day starts again.
  a.charge(ip, { credits: 10 });
  a.over(ip, { credits: 10 }); a.over(ip, { credits: 10 });
  const reached = logs.filter((l) => l.event === 'allowance_reached');
  assert.equal(reached.length, 1);
  assert.deepEqual(reached[0], { event: 'allowance_reached', kind: 'credits', route: 'youtube' });
  assert.deepEqual(a.state().reached, { credits: 1, home_builds: 0, home_mb: 0 });
  now += 24 * 3600_000;
  assert.equal(a.over(ip, { credits: 10 }), null, 'a new day');
  // Trusted: the factor on each.
  const t = new Allowance({ creditsPerIp: 10, trusted: trustedIps('198.51.100.7'), trustedFactor: 3, now: () => now });
  t.charge('198.51.100.7', { credits: 30 });
  assert.equal(t.over('198.51.100.7', { credits: 10 }), 'credits');
  t.charge('192.0.2.9', { credits: 10 });
  assert.equal(t.over('192.0.2.9', { credits: 10 }), 'credits');
});

test('routing: a visitor over their daily allowance gets youtube.com: no Tunelio, and no home even for a long video', async (t) => {
  const a = await routeApp(t, { config: { allowanceCreditsPerIp: 10 } });
  assert.match((await a.get(a.ticket(vid(1)))).headers.get('location'), /tunelio\.dev/);
  assert.equal((await a.get(a.ticket(vid(2)))).headers.get('location'), `https://www.youtube.com/watch?v=${vid(2)}`);
  assert.equal((await a.get(a.ticket(vid(3), 3600))).headers.get('location'), `https://www.youtube.com/watch?v=${vid(3)}`, 'long: home would take it, but not over the allowance');
  assert.equal(a.jobs.length, 0, 'no home work');
  assert.equal(a.tunelio.created.length, 1);
  assert.equal(a.logs.filter((l) => l.event === 'allowance_reached').length, 1);
  assert.deepEqual(a.routes().filter((e) => e.via === 'youtube').map((e) => e.why), ['allowance', 'allowance']);
  // Another visitor is unaffected; the cached first video still plays for this one.
  assert.match((await a.get(a.ticket(vid(4)), WMF, '192.0.2.2')).headers.get('location'), /tunelio\.dev/);
  assert.match((await a.get(a.ticket(vid(1)), WMF, '192.0.2.1')).headers.get('location'), /tunelio\.dev/);
});

test('routing: home builds count against the allowance too; over it, neither home nor Tunelio', async (t) => {
  const a = await routeApp(t, { config: { allowanceHomeBuildsPerIp: 1 } });
  assert.match((await a.get(a.ticket(vid(1), 3600))).headers.get('location'), /^http:\/\/pub\/home\//);
  assert.equal((await a.get(a.ticket(vid(2), 3600))).headers.get('location'), `https://www.youtube.com/watch?v=${vid(2)}`);
  assert.equal((await a.get(a.ticket(vid(3)))).headers.get('location'), `https://www.youtube.com/watch?v=${vid(3)}`, 'a short one: no Tunelio either');
  assert.equal(a.jobs.length, 1);
  assert.equal(a.tunelio.created.length, 0);
});

test('routing: the per-minute build cap refuses home as well as Tunelio (youtube.com), and logs once per stretch', async (t) => {
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 0, perIpPerMinute: 1, perShardPerMinute: 0, log: (o) => capLogs.push(o) });
  const capLogs = [];
  const a = await routeApp(t, { spend });
  assert.match((await a.get(a.ticket(vid(1), 3600))).headers.get('location'), /^http:\/\/pub\/home\//, 'the first: home (long)');
  assert.equal((await a.get(a.ticket(vid(2), 3600))).headers.get('location'), `https://www.youtube.com/watch?v=${vid(2)}`, 'not a second home build');
  assert.equal((await a.get(a.ticket(vid(3)))).headers.get('location'), `https://www.youtube.com/watch?v=${vid(3)}`, 'nor Tunelio');
  assert.equal(a.tunelio.created.length, 0);
  assert.equal(a.jobs.length, 1);
  assert.equal(capLogs.filter((l) => l.event === 'spend_cap').length, 1, 'one spend_cap for the stretch');
  assert.deepEqual(a.routes().map((e) => [e.via, e.why]), [['home', 'long'], ['youtube', 'cap'], ['youtube', 'cap']]);
});

test('ticket route: video players have their own per-IP limit, far above the tablet\'s', async (t) => {
  const a = await routeApp(t, { config: { ticketsPerMinutePerIp: 1, ticketPlayerPerMinutePerIp: 3 } });
  const n = a.ticket(vid(1));
  for (let i = 0; i < 3; i++) assert.equal((await a.get(n, WMF)).status, 302);
  assert.equal((await a.get(n, WMF)).status, 429);
  assert.equal((await a.get(n, UNITY)).status, 200, 'the tablet\'s count is apart');
  assert.deepEqual(a.logs.filter((l) => l.event === 'ticket_limited').map((l) => l.kind), ['player']);
});

const QUEST = 'AVProMobileVideo/2026.3.3p2 (Linux;Android 14) ExoPlayer';

// A fake Playback for Adaptive: the 720p job is there; start() builds a rung only once `allow()` says so.
function upgradePlayback({ allow = () => true } = {}) {
  const lowerJob = { id: vid(1), requested: '720p', quality: '720p', state: 'ready', mb: 100, seconds: 600, fixed: true };
  const jobs = new Map([['720p', lowerJob]]);
  const seen = [];
  return { lowerJob, seen, peek: (d, q) => jobs.get(q) ?? null, knownMb: () => null, measured: () => false, predict: () => 0,
    start(data, q) {
      seen.push({ q, scope: spendScope.getStore() });
      if (!allow(q)) return null;
      const j = { id: data.id, requested: q, quality: q, state: 'building', mb: 0, seconds: 600, fixed: true };
      jobs.set(q, j);
      return j;
    } };
}

test('adaptive: upgrades are charged to the latest picker (a play request), not to a warm or whoever loads the master', async (t) => {
  const pb = upgradePlayback({ allow: () => false });
  const adaptive = new Adaptive({ playback: pb, base: 'http://pub/hls' });
  const data = { id: vid(1), seconds: 600 };
  const s = spendScope.run({ ip: 'code-A', shard: 1, play: true, answer: 'youtube' }, () => adaptive.session(data, pb.lowerJob));
  spendScope.run({ ip: 'code-W', shard: 1, answer: 'warm_skip' }, () => adaptive.session(data, pb.lowerJob)); // a warm: no change
  assert.equal(s.payer.ip, 'code-A');
  spendScope.run({ ip: 'code-C', shard: 1, play: true, answer: 'youtube' }, () => adaptive.session(data, pb.lowerJob)); // a later pick
  assert.equal(adaptive.shardOf(s.token), 1);
  assert.equal(JSON.stringify(s).includes('code-C'), false, 'the payer is not an enumerable field');
  const a = await routeApp(t, { adaptive });
  // A follower (another IP) loads the master first.
  const r = await fetch(`${a.url}/hls/${s.token}.m3u8`, { headers: { 'user-agent': WMF, 'x-forwarded-for': '192.0.2.5' } });
  assert.equal(r.status, 200);
  assert.deepEqual(pb.seen.map((x) => [x.q, x.scope?.ip, x.scope?.shard, x.scope?.answer]), [['1080p', 'code-C', 1, 'lower_rung']]);
});

test('adaptive: the payer is let go once every rung has started, or after 12 hours', () => {
  let now = 0, open = false;
  const pb = upgradePlayback({ allow: () => open });
  const adaptive = new Adaptive({ playback: pb, base: 'http://pub/hls', now: () => now });
  const one = spendScope.run({ ip: 'code-A', shard: 1, play: true }, () => adaptive.session({ id: vid(1), seconds: 600 }, pb.lowerJob));
  adaptive.master(one.token, 'v1');
  assert.equal(one.payer?.ip, 'code-A', 'kept while a rung is still to start');
  now += 12 * 3600_000;
  adaptive.sweep();
  assert.equal(one.payer, null, 'let go after 12 h');
  open = true;
  const pb2 = upgradePlayback();
  const a2 = new Adaptive({ playback: pb2, base: 'http://pub/hls', now: () => now });
  const two = spendScope.run({ ip: 'code-B', shard: 1, play: true }, () => a2.session({ id: vid(2), seconds: 600 }, pb2.lowerJob));
  a2.master(two.token, 'v1');
  assert.equal(two.payer, null, 'every rung started: nothing left to charge');
});

test('playback: jobs carry no payer, and spend_refused is logged once per stretch', () => {
  let now = 0;
  const logs = [];
  const spend = new SpendGate({ hourCredits: 10, dayCredits: 0, monthCredits: 0, now: () => now });
  spend.charge(10);
  const pb = new Playback({ tunelio: fakeTunelio(), quality: '720p', probe: async () => ({ ok: true }), spend, now: () => now, log: (o) => logs.push(o) });
  for (let i = 0; i < 3; i++) assert.equal(pb.start({ id: vid(1), seconds: 600 }, '1080p', { hls: true }), null);
  assert.equal(logs.filter((l) => l.event === 'spend_refused').length, 1);
  now += 61_000;
  pb.start({ id: vid(1), seconds: 600 }, '1080p', { hls: true });
  assert.equal(logs.filter((l) => l.event === 'spend_refused').length, 2, 'a new stretch');
  const ok = new Playback({ tunelio: fakeTunelio({ hang: () => true }), quality: '720p', probe: async () => ({ ok: true }) });
  const job = spendScope.run({ ip: 'code-A', shard: 1, play: true }, () => ok.start({ id: vid(2), seconds: 600 }, '720p'));
  assert.equal('payer' in job, false);
});

test('adaptive: a rung refused at the first master load is tried again at the next and listed once it starts', async (t) => {
  let open = false;
  const pb = upgradePlayback({ allow: () => open });
  const adaptive = new Adaptive({ playback: pb, base: 'http://pub/hls' });
  const s = spendScope.run({ ip: '192.0.2.1', shard: 1 }, () => adaptive.session({ id: vid(1), seconds: 600 }, pb.lowerJob));
  const first = adaptive.master(s.token, 'v1');
  assert.doesNotMatch(first, /1080p\.m3u8/, 'refused now: not listed');
  open = true; // say the per-minute cap cleared
  const second = adaptive.master(s.token, 'v2');
  assert.match(second, /1080p\.m3u8/, 'tried again and listed');
  assert.deepEqual(pb.seen.map((x) => x.q), ['1080p', '1080p']);
  adaptive.master(s.token, 'v3');
  assert.equal(pb.seen.length, 2, 'not started again once there');
});

test('adaptive: a player\'s reload mark lasts 12 hours at most', () => {
  let now = 0;
  const pb = upgradePlayback();
  const events = [];
  const adaptive = new Adaptive({ playback: pb, base: 'http://pub/hls', now: () => now, onEvent: (k) => events.push(k) });
  const s = adaptive.session({ id: vid(1), seconds: 600 }, pb.lowerJob);
  adaptive.master(s.token, 'v1');
  now += 11 * 3600_000;
  adaptive.master(s.token, 'v1');
  assert.equal(events.filter((e) => e.startsWith('reload_')).length, 1, 'a reload within 12 h');
  now += 2 * 3600_000;
  adaptive.sweep();
  assert.equal(s.viewers.size, 0, 'swept after 12 h');
});

test('allowance: a home session that only does not fit the MB left is not a use-up; a real use-up logs the caller\'s route', () => {
  const logs = [];
  const a = new Allowance({ creditsPerIp: 0, homeBuildsPerIp: 0, homeMbPerIp: 3000, log: (o) => logs.push(o) });
  a.charge('192.0.2.1', { homeBuilds: 1, homeMb: 2000 });
  assert.equal(a.over('192.0.2.1', { home: true, homeMb: 2000 }), 'home_mb_fit');
  assert.equal(a.over('192.0.2.1', { credits: 10 }), null, 'Tunelio may take it');
  assert.equal(logs.length, 0, 'nothing logged, nothing marked');
  assert.deepEqual(a.state().reached.home_mb, 0);
  a.charge('192.0.2.1', { homeBuilds: 1, homeMb: 1000 });
  assert.equal(a.over('192.0.2.1', { credits: 10, route: 'daily_limit' }), 'home_mb');
  assert.deepEqual(logs.map((l) => [l.kind, l.route]), [['home_mb', 'daily_limit']]);
});

test('routing: a home session counts its MB at its own quality (720p at 720p\'s rate)', async (t) => {
  // 1 h at 720p = 1368 MB; at 1080p's rate it would be 2052, and two of those don't fit 3000.
  const a = await routeApp(t, { config: { homeQuality: '720p', allowanceHomeMbPerIp: 3000, allowanceHomeBuildsPerIp: 0 } });
  assert.match((await a.get(a.ticket(vid(1), 3600))).headers.get('location'), /^http:\/\/pub\/home\//);
  assert.match((await a.get(a.ticket(vid(2), 3600))).headers.get('location'), /^http:\/\/pub\/home\//);
  assert.deepEqual(a.jobs.map((j) => j.quality), ['720p', '720p']);
});

test('routing: a home session too big for what is left of the MB allowance goes to Tunelio, labelled home_mb', async (t) => {
  const a = await routeApp(t, { config: { allowanceHomeMbPerIp: 3000, allowanceHomeBuildsPerIp: 0 } }); // 1 h at 1080p: 2052 MB
  assert.match((await a.get(a.ticket(vid(1), 3600))).headers.get('location'), /^http:\/\/pub\/home\//);
  assert.match((await a.get(a.ticket(vid(2), 3600))).headers.get('location'), /tunelio\.dev/);
  assert.deepEqual(a.routes().map((e) => [e.via, e.why]), [['home', 'long'], ['tunelio', 'home_mb']]);
});

test('routing: a Quest (.m3u8 ticket) or Android player over its allowance gets a fast 403 daily_limit; the tablet a failed status; a PC youtube.com', async (t) => {
  const a = await routeApp(t, { config: { allowanceCreditsPerIp: 10 } });
  assert.match((await a.get(a.ticket(vid(1)))).headers.get('location'), /tunelio\.dev/);
  const n = a.ticket(vid(2));
  const t0 = Date.now();
  const quest = await a.get(`${n}.m3u8`, QUEST);
  assert.equal(quest.status, 403);
  assert.equal((await quest.json()).error, 'daily_limit');
  assert.ok(Date.now() - t0 < 1500, 'answered at once, no hold');
  const android = await a.get(n, QUEST);
  assert.deepEqual([android.status, (await android.json()).error], [403, 'daily_limit']);
  const st = await (await a.get(`${n}.m3u8`, UNITY)).json();
  assert.deepEqual([st.state, st.reason, st.error], ['failed', 'daily_limit', 'daily_limit']);
  assert.equal((await a.get(n, WMF)).headers.get('location'), `https://www.youtube.com/watch?v=${vid(2)}`, 'a PC keeps the youtube.com link');
  assert.equal(a.tunelio.created.length, 1);
  assert.ok(a.logs.some((l) => l.event === 'play_daily_limit' && l.by === 'allowance'));
});

test('routing: a Quest over a per-minute build cap gets the same daily_limit answer', async (t) => {
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 0, perIpPerMinute: 1, perShardPerMinute: 0 });
  const a = await routeApp(t, { spend });
  assert.match((await a.get(a.ticket(vid(1)))).headers.get('location'), /tunelio\.dev/);
  const r = await a.get(`${a.ticket(vid(2))}.m3u8`, QUEST);
  assert.deepEqual([r.status, (await r.json()).error], [403, 'daily_limit']);
  assert.ok(a.logs.some((l) => l.event === 'play_daily_limit' && l.by === 'cap'));
});

test('routing: a Tunelio refusal for a per-minute cap is not sent home by the failure fallback', async (t) => {
  // The fallback after a Tunelio failure (homeFor tunelio_failed) takes budget refusals only; startHome's own cap
  // check refuses the same session too, so this test fails only with both removed.
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 0, perIpPerMinute: 1, perShardPerMinute: 0 });
  const a = await routeApp(t, { spend });
  assert.match((await a.get(a.ticket(vid(1)))).headers.get('location'), /tunelio\.dev/);
  assert.equal((await a.get(a.ticket(vid(2)))).headers.get('location'), `https://www.youtube.com/watch?v=${vid(2)}`);
  assert.equal(a.jobs.length, 0, 'no home session for the capped play');
});

test('ip keys: a keyed daily code, the same for an address all day, new at the day boundary, never the address', () => {
  let now = Date.parse('2026-11-04T18:00:00Z'); // 12:00 in Chicago
  const k = new IpKeys({ now: () => now, trusted: trustedIps('198.51.100.7') });
  const a = k.code('192.0.2.1');
  assert.equal(k.code('192.0.2.1'), a, 'same address, same day: same code');
  assert.notEqual(k.code('192.0.2.2'), a);
  assert.doesNotMatch(a, /192|0\.2/);
  assert.equal(a.length, 22, '16 bytes, base64url');
  assert.ok(k.trusted.has(k.code('198.51.100.7')), 'a trusted address code is trusted');
  assert.equal(k.trusted.has(a), false);
  now = Date.parse('2026-11-05T05:59:00Z'); // 23:59 Chicago
  assert.equal(k.code('192.0.2.1'), a);
  now = Date.parse('2026-11-05T06:01:00Z'); // 00:01 Chicago: a new key
  assert.notEqual(k.code('192.0.2.1'), a);
  assert.ok(k.trusted.has(k.code('198.51.100.7')));
});

// Every string anywhere in a structure (Map/Set keys and values, non-enumerable properties too).
function strings(x, out = [], seen = new Set()) {
  if (typeof x === 'string') { out.push(x); return out; }
  if (!x || typeof x !== 'object' || seen.has(x)) return out;
  seen.add(x);
  if (x instanceof Map) for (const [k, v] of x) { strings(k, out, seen); strings(v, out, seen); }
  else if (x instanceof Set) for (const v of x) strings(v, out, seen);
  else for (const k of Object.getOwnPropertyNames(x)) { let v; try { v = x[k]; } catch { continue; } if (typeof v !== 'function') { strings(k, out, seen); strings(v, out, seen); } }
  return out;
}

test('no raw client IP in anything the service keeps after the request; limits and the allowance still count per visitor', async (t) => {
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, monthCredits: 0, perIpPerMinute: 2, perShardPerMinute: 0 });
  const a = await routeApp(t, { spend, config: { allowanceCreditsPerIp: 20, searchesPerMinutePerIp: 50 } });
  const ips = ['192.0.2.41', '192.0.2.42', '198.51.100.43'];
  for (const ip of ips) {
    await fetch(`${a.url}/v1/0/s?l=en&q=x`, { headers: { 'user-agent': UNITY, 'x-forwarded-for': ip } });
    for (let i = 0; i < 3; i++) await a.get(a.ticket(vid(100 + ips.indexOf(ip) * 10 + i)), WMF, ip);
    await a.get(a.ticket(vid(200)), UNITY, ip);
  }
  // The allowance and caps still told the visitors apart: each IP got 2 Tunelio builds (20 credits, and 2 a minute).
  assert.equal(a.tunelio.created.length, 6);
  const all = strings(a.app.kept());
  for (const ip of ips) assert.equal(all.some((x) => x.includes(ip)), false, `${ip} kept somewhere`);
  assert.ok(a.app.kept().allowance.state().ips >= 3, 'counted per visitor, by code');
});

test('allowance defaults (owner, 2026-11-04): 1500 credits, 25 home sessions, 60000 MB per IP, each under the home daily caps (40, 120000)', () => {
  const env = ['ALLOWANCE_CREDITS_PER_IP', 'ALLOWANCE_HOME_BUILDS_PER_IP', 'ALLOWANCE_HOME_MB_PER_IP', 'HOME_DAILY_BUILDS', 'HOME_DAILY_MB'].filter((k) => process.env[k] != null);
  assert.deepEqual(env, [], 'no env override while testing the defaults');
  assert.deepEqual([base.allowanceCreditsPerIp, base.allowanceHomeBuildsPerIp, base.allowanceHomeMbPerIp], [1500, 25, 60000]);
  assert.deepEqual([base.homeDailyBuilds, base.homeDailyMb], [40, 120000]);
  assert.ok(base.allowanceHomeBuildsPerIp < base.homeDailyBuilds && base.allowanceHomeMbPerIp < base.homeDailyMb, 'one visitor never takes all of home');
  assert.deepEqual(new Allowance().state().perIp, { credits: 1500, homeBuilds: 25, homeMb: 60000 });
});

test('ip keys: the minute sweep replaces the key at the day boundary with no request', () => {
  let now = Date.parse('2026-11-05T05:59:00Z'); // 23:59 Chicago
  let made = 0;
  const k = new IpKeys({ now: () => now, random: () => Buffer.alloc(32, ++made) });
  const yesterday = k.key;
  now = Date.parse('2026-11-05T06:01:00Z'); // 00:01 Chicago, no code() asked
  k.sweep();
  assert.notEqual(k.key, yesterday, 'yesterday\'s key is gone');
  assert.equal(made, 2);
  k.sweep();
  assert.equal(made, 2, 'once a day, not every sweep');
});

// Everything-is-OK#545: forced limits for tests, staging only (src/forced.js).
const STAGING = 'https://staging-yt.eiok.cc';
const opsLimit = (a, qs, ip = '192.0.2.1', method = 'POST') => fetch(`${a.url}/ops/limit?${qs}`, { method,
  headers: { authorization: 'Bearer ops-token', 'x-forwarded-for': ip } }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('forced limits: allowed only when PUBLIC_URL is a staging host; production and the unset default refuse', () => {
  assert.equal(allowedHere(STAGING), true);
  assert.equal(allowedHere('https://staging.example.org/'), true);
  assert.equal(allowedHere('https://yt.japharsworld.com'), false);
  for (const u of ['', 'http://pub', 'https://eiok.cc', 'https://notstaging-yt.eiok.cc', 'https://yt.japharsworld.com/?staging-', 'garbage', undefined]) {
    assert.equal(allowedHere(u), false, String(u));
  }
});

test('forced limits: the default PUBLIC_URL (unset env) is production, so it fails closed', async () => {
  const saved = process.env.PUBLIC_URL;
  delete process.env.PUBLIC_URL;
  try {
    const { config: fresh } = await import(`../src/config.js?unset=${Date.now()}`);
    assert.equal(fresh.publicUrl, 'https://yt.japharsworld.com');
    assert.equal(allowedHere(fresh.publicUrl), false);
  } finally { if (saved !== undefined) process.env.PUBLIC_URL = saved; }
});

test('forced limits: lapse by themselves, at most 240 minutes, clear by mode null; the list never shows a visitor key', () => {
  let now = 1_000_000;
  const f = new ForcedLimits({ now: () => now });
  f.force({ id: vid(1), mode: 'daily_limit', minutes: 10 });
  f.force({ visitor: 'code-a', mode: 'rate_limited', minutes: 9999 });
  assert.equal(f.has('daily_limit', { id: vid(1) }), true);
  assert.equal(f.has('rate_limited', { id: vid(1) }), false, 'only its own mode');
  assert.equal(f.has('rate_limited', { visitor: 'code-a' }), true);
  assert.equal(f.has('rate_limited', { visitor: 'code-b' }), false);
  assert.deepEqual(f.list('code-a').map((x) => [x.target, x.you ?? x.id, x.mode]), [['video', vid(1), 'daily_limit'], ['visitor', true, 'rate_limited']]);
  assert.doesNotMatch(JSON.stringify(f.list('code-b')), /code-a/);
  now += 10 * 60_000;
  assert.equal(f.has('daily_limit', { id: vid(1) }), false, 'lapsed after 10 min');
  now += 230 * 60_000 - 1;
  assert.equal(f.has('rate_limited', { visitor: 'code-a' }), true);
  now += 1;
  assert.equal(f.has('rate_limited', { visitor: 'code-a' }), false, 'capped at 240 min');
  f.force({ id: vid(2), mode: 'daily_limit' });
  f.force({ id: vid(2), mode: null });
  assert.equal(f.has('daily_limit', { id: vid(2) }), false);
});

test('forced limits: on a production config /ops/limit answers 403 not_staging and plays are untouched', async (t) => {
  const a = await routeApp(t, { config: { statsToken: 'ops-token', publicUrl: 'https://yt.japharsworld.com', trustedIps: '198.51.100.7' } });
  const r = await opsLimit(a, 'me=1&mode=daily_limit', '198.51.100.7');
  assert.deepEqual([r.status, r.body.error], [403, 'not_staging']);
  assert.equal((await opsLimit(a, '', '198.51.100.7', 'GET')).status, 403);
  assert.equal((await opsLimit(a, `id=${vid(1)}&mode=daily_limit`)).status, 403);
  const n = a.ticket(vid(1));
  assert.equal((await a.get(`${n}.m3u8`, UNITY, '198.51.100.7')).status, 200);
  assert.match((await a.get(n, WMF, '198.51.100.7')).headers.get('location'), /tunelio\.dev/);
  assert.ok(!a.logs.some((l) => l.event === 'forced_limits' || l.event === 'forced_limit'));
});

test('forced limits (staging): daily_limit for the caller, a trusted IP, answers as over the allowance and spends nothing; others play', async (t) => {
  const a = await routeApp(t, { config: { statsToken: 'ops-token', publicUrl: STAGING, trustedIps: '198.51.100.7' } });
  const T = '198.51.100.7';
  assert.equal((await opsLimit(a, 'me=1&mode=fast', T)).status, 400);
  assert.equal((await opsLimit(a, 'mode=daily_limit', T)).status, 400, 'a target is needed');
  assert.equal((await opsLimit(a, `me=1&id=${vid(9)}&mode=daily_limit`, T)).status, 400);
  const set = await opsLimit(a, 'me=1&mode=daily_limit&minutes=15', T);
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.forced.map((x) => [x.target, x.you, x.mode]), [['visitor', true, 'daily_limit']]);
  assert.doesNotMatch(JSON.stringify(set.body), /198\.51/);
  const n = a.ticket(vid(1));
  const quest = await a.get(`${n}.m3u8`, QUEST, T);
  assert.deepEqual([quest.status, (await quest.json()).error], [403, 'daily_limit']);
  const android = await a.get(n, QUEST, T);
  assert.deepEqual([android.status, (await android.json()).error], [403, 'daily_limit']);
  const st = await (await a.get(`${n}.m3u8`, UNITY, T)).json();
  assert.deepEqual([st.state, st.reason, st.error], ['failed', 'daily_limit', 'daily_limit']);
  const plain = await (await a.get(n, UNITY, T)).json();
  assert.deepEqual([plain.state, plain.reason], ['youtube', 'allowance']);
  assert.equal((await a.get(n, WMF, T)).headers.get('location'), `https://www.youtube.com/watch?v=${vid(1)}`, 'a PC gets youtube.com');
  assert.equal(a.tunelio.created.length, 0, 'nothing spent');
  assert.ok(a.logs.some((l) => l.event === 'play_daily_limit' && l.forced === true));
  assert.equal(a.routes().length, 0, 'no build_route counted for a forced answer');
  // Another visitor isn't affected.
  assert.match((await a.get(n, WMF, '192.0.2.5')).headers.get('location'), /tunelio\.dev/);
  // Cleared: the trusted caller plays again.
  assert.deepEqual((await opsLimit(a, 'me=1&mode=clear', T)).body.forced, []);
  assert.match((await a.get(a.ticket(vid(2)), WMF, T)).headers.get('location'), /tunelio\.dev/);
});

test('forced limits (staging): a video target answers daily_limit to every visitor; rate_limited gives 429 on tickets and searches', async (t) => {
  const a = await routeApp(t, { config: { statsToken: 'ops-token', publicUrl: STAGING, trustedIps: '198.51.100.7' } });
  assert.equal((await opsLimit(a, `id=${vid(1)}&mode=daily_limit`)).status, 200);
  const n1 = a.ticket(vid(1)), n2 = a.ticket(vid(2));
  for (const ip of ['192.0.2.8', '198.51.100.7']) assert.equal((await a.get(`${n1}.m3u8`, QUEST, ip)).status, 403, ip);
  assert.match((await a.get(n2, WMF, '192.0.2.8')).headers.get('location'), /tunelio\.dev/, 'other videos play');
  assert.equal((await opsLimit(a, 'me=1&mode=rate_limited', '198.51.100.7')).status, 200);
  const r = await a.get(n2, WMF, '198.51.100.7');
  assert.deepEqual([r.status, (await r.json()).error], [429, 'rate_limited']);
  const s = await fetch(`${a.url}/v1/0/s?l=en&q=x`, { headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.deepEqual([s.status, (await s.json()).error], [429, 'rate_limited']);
  assert.equal((await a.get(n2, UNITY, '192.0.2.8')).status, 200, 'not for another visitor');
  const list = await opsLimit(a, '', '192.0.2.8', 'GET');
  assert.deepEqual(list.body.forced.map((x) => [x.target, x.you ?? x.id]), [['video', vid(1)], ['visitor', false]]);
});
