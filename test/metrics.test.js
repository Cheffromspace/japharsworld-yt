import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Metrics, checkedKey, msBucket, lengthBucket, dayOf, hourOf, openMetricsDb, recordPoll } from '../src/metrics.js';
import { percentile, forecast, billingPeriod, exportCsv } from '../src/stats.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Tunelio } from '../src/tunelio.js';
import { config as base } from '../src/config.js';

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jyt-metrics-'));
  return { path: join(dir, 'metrics.db'), done: () => rmSync(dir, { recursive: true, force: true }) };
};
// 2026-10-19 14:30 UTC = 09:30 in Chicago (CDT).
const T = Date.parse('2026-10-19T14:30:00Z');

test('days and hours follow the reporting time zone', () => {
  assert.equal(dayOf(Date.parse('2026-10-19T04:59:00Z')), '2026-10-18'); // 23:59 CDT
  assert.equal(dayOf(Date.parse('2026-10-19T05:00:00Z')), '2026-10-19');
  assert.equal(hourOf(T), '2026-10-19T09');
  assert.equal(dayOf(T, 'UTC'), '2026-10-19');
});

test('counters add up in memory and across flushes; gauges keep the last value; shards count once per hour', () => {
  const f = tmp();
  let now = T;
  const m = new Metrics({ path: f.path, now: () => now });
  m.inc('search'); m.inc('search'); m.inc('search_lang', 'ja');
  m.gauge('credits_remaining', '', 900); m.gauge('credits_remaining', '', 880);
  m.shard(3); m.shard(3); m.shard(5);
  assert.equal(m.flush(), 5);
  m.inc('search'); m.shard(3);
  m.flush();
  now += 3600_000; m.shard(3); // next hour
  m.close();
  const db = openMetricsDb(f.path);
  const daily = db.prepare('SELECT metric, key, value FROM daily ORDER BY metric, key').all().map((r) => ({ ...r }));
  assert.deepEqual(daily, [{ metric: 'search', key: '', value: 3 }, { metric: 'search_lang', key: 'ja', value: 1 }]);
  assert.equal(db.prepare('SELECT value FROM gauges WHERE metric = ?').get('credits_remaining').value, 880);
  const hours = db.prepare(`SELECT hour, COUNT(*) n FROM hourly WHERE metric = 'shard' GROUP BY hour ORDER BY hour`).all().map((r) => [r.hour, r.n]);
  assert.deepEqual(hours, [['2026-10-19T09', 2], ['2026-10-19T10', 1]]);
  db.close(); f.done();
});

test('a failed flush keeps the counts for the next one', () => {
  const m = new Metrics({ path: '/nonexistent\0bad/metrics.db', log: () => {} });
  m.inc('play'); m.inc('play');
  assert.equal(m.flush(), 0);
  m.inc('play');
  assert.equal([...m.pending.values()][0], 3);
});

test('keys outside each metric\'s allowed set are counted as "other"', () => {
  assert.equal(checkedKey('search_lang', 'ja'), 'ja');
  assert.equal(checkedKey('search_lang', 'rain sounds'), 'other');
  assert.equal(checkedKey('search_lang', '203.0.113.7'), 'other');
  assert.equal(checkedKey('cc_track_lang', 'pt-BR'), 'pt-BR');
  assert.equal(checkedKey('cc_track_lang', 'zh-Hans'), 'zh-Hans');
  assert.equal(checkedKey('cc_track_lang', 'es-419'), 'es-419');
  assert.equal(checkedKey('cc_track_lang', 'dQw4w9WgXcQ'), 'other');
  assert.equal(checkedKey('search_fail', '502'), '502');
  assert.equal(checkedKey('search_fail', '2001:db8::1'), 'other');
  assert.equal(checkedKey('search', 'anything'), 'other');
  assert.equal(checkedKey('shard', '7'), '7');
  assert.equal(checkedKey('shard', '1234'), 'other');
  assert.equal(checkedKey('yt_refusal', 'home:bot'), 'home:bot');
  assert.equal(checkedKey('yt_refusal', 'linode:potoken'), 'linode:potoken');
  assert.equal(checkedKey('yt_refusal', 'home:dQw4w9WgXcQ'), 'other'); // a worker can't send a video ID through it
  assert.equal(checkedKey('yt_refusal', 'Sign in to confirm you are not a bot'), 'other');
  assert.equal(checkedKey('video_report', 'tester:frozen'), 'tester:frozen'); // world #353: who:kind, fixed sets
  assert.equal(checkedKey('video_report', 'visitor:autoresync'), 'visitor:autoresync');
  assert.equal(checkedKey('video_report', 'owner:frozen'), 'other');
  assert.equal(checkedKey('video_report', 'tester:bogus'), 'other');
  assert.equal(checkedKey('tunelio_drop', 'reopen_fail'), 'reopen_fail'); // #361: fixed keys
  assert.equal(checkedKey('tunelio_drop', 'open_fail'), 'open_fail');
  assert.equal(checkedKey('tunelio_drop', 'dQw4w9WgXcQ'), 'other');
  assert.throws(() => checkedKey('query_text', 'x'));
});

test('latency buckets, percentiles and length buckets', () => {
  assert.equal(msBucket(40), '50');
  assert.equal(msBucket(51), '100');
  assert.equal(msBucket(99_999), 'inf');
  assert.equal(percentile({ 100: 50, 1000: 45, 5000: 5 }, 0.5), 100);
  assert.equal(percentile({ 100: 50, 1000: 45, 5000: 5 }, 0.95), 1000);
  assert.equal(percentile({ 100: 50, 1000: 44, 5000: 6 }, 0.95), 5000);
  assert.equal(percentile({}, 0.5), null);
  assert.deepEqual(['live', 'unknown', 'lt10m', 'lt1h', 'lt3h', 'longer'],
    [{ live: true }, { seconds: 0 }, { seconds: 599 }, { seconds: 600 }, { seconds: 3 * 3600 - 1 }, { seconds: 3 * 3600 }].map(lengthBucket));
});

test('plan periods renew on the given day of the month (clamped to short months)', () => {
  assert.deepEqual(billingPeriod('2026-10-19', 17), { start: '2026-10-17', renews: '2026-11-17' });
  assert.deepEqual(billingPeriod('2026-10-16', 17), { start: '2026-09-17', renews: '2026-10-17' });
  assert.deepEqual(billingPeriod('2026-10-17', 17), { start: '2026-10-17', renews: '2026-11-17' });
  assert.deepEqual(billingPeriod('2026-12-20', 17), { start: '2026-12-17', renews: '2027-01-17' });
  assert.deepEqual(billingPeriod('2026-02-28', 31), { start: '2026-02-28', renews: '2026-03-31' });
  assert.deepEqual(billingPeriod('2026-10-19'), { start: '2026-10-01', renews: '2026-11-01' });
});

test('credits forecast at the plan period\'s average daily spend', () => {
  // Oct 19, 09:00 Chicago, period from Oct 17: 2 days + 9/24 elapsed; 2,375 spent → 1,000 a day.
  const now = Date.parse('2026-10-19T14:00:00Z');
  const a = forecast({ remaining: 5000, spent: 2375, today: '2026-10-19', renewDay: 17, now });
  assert.deepEqual(a, { perDay: 1000, runsOut: '2026-10-24', lastsPeriod: false, renews: '2026-11-17' });
  assert.equal(forecast({ remaining: 90_000, spent: 2375, today: '2026-10-19', renewDay: 17, now }).lastsPeriod, true);
  assert.equal(forecast({ remaining: 10, spent: 0, today: '2026-10-19', renewDay: 17, now }).lastsPeriod, true);
  assert.equal(forecast({ remaining: null, spent: 5, today: '2026-10-19', now }), null);
});

test('Tunelio reports every call (path, ok, ms) for the metrics', async () => {
  const calls = [];
  const fetcher = async (url) => url.includes('/create')
    ? new Response(JSON.stringify({ status: 'ok', url: 'https://t/x?a=1', expires: 9e9 }), { headers: { 'x-credits-remaining': '90' } })
    : new Response(JSON.stringify({ error: 'nope' }), { status: 402 });
  const t = new Tunelio({ key: 'k', fetcher, onCall: (c) => calls.push(c) });
  await t.create('AAAAAAAAAAA', '1080p');
  await assert.rejects(t.transcript('AAAAAAAAAAA', 'en'));
  assert.deepEqual(calls.map((c) => [c.path, c.ok, c.status]), [['/create', true, 200], ['/transcript', false, 402]]);
  assert.ok(calls.every((c) => Number.isFinite(c.ms)));
});

// --- The search service end to end: counts land in the database, and nothing personal does. ---

const QUERY = 'secret rain sounds for sleeping';
const IP = '203.0.113.77';
const IDS = ['AAAAAAAAAA1', 'BBBBBBBBBB2', 'CCCCCCCCCC3', 'DDDDDDDDDD4'];

async function startApp(path) {
  const config = { ...base, shards: 4, pool: 200, resultsPerPage: 4, searchesPerMinutePerIp: 4, metricsPath: path, statsToken: 'tok-123', monitorDb: '' };
  const store = new Store({ path: ':memory:', shards: 4, pool: 200, pinHours: 24 });
  const youtube = {
    async search(q) {
      if (q.includes('boom')) throw new Error('down');
      return { videos: IDS.map((id, i) => ({ id, title: `t${i}`, channel: 'c', length: '', seconds: [120, 1800, 7200, 0][i], views: '', age: '', live: i === 3, cc: true })), more: async () => ({ videos: [], more: null }) };
    },
    thumbnailUrl: (id) => id,
  };
  const playback = { async location(d) {
    if (d.live) return { location: `https://www.youtube.com/watch?v=${d.id}`, via: 'youtube', reason: 'live' };
    if (d.seconds > 3600) return { location: `https://tunelio.dev/t?id=${d.id}&hls=1`, via: 'tunelio' };
    if (d.seconds > 600) return { location: `https://www.youtube.com/watch?v=${d.id}`, via: 'youtube', reason: 'tunelio_failed' };
    return { location: `https://tunelio.dev/t?id=${d.id}&progressive=1`, via: 'tunelio' };
  } };
  const captions = {
    async get(id, lang) { if (lang === 'pl') return { id, lang, available: false, reason: QUERY }; return lang === 'ko' ? { id, lang, available: false, reason: 'no_track_in_language', tracks: [], track: -1 } : { id, lang, available: true, source: 'manual', key: 'en', lines: [[0, 1, QUERY]] }; },
    // Hostile answers (as if upstream misbehaved): track 2 is labelled with the video ID, Polish gets the query as its reason.
    async track(id, i, lang) { return { id, lang, available: true, key: i === 1 ? 'pt-BR' : i === 2 ? id : 'ja', lines: [], track: i }; },
  };
  const metrics = new Metrics({ path, tz: config.metricsTz });
  const app = createApp({ config, store, youtube, playback, captions, metrics, tunelio: { enabled: true, credits: 1 }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async (p, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', headers: { 'x-forwarded-for': IP, ...headers } });
  return { server, get, metrics };
}

test('search service counts searches, joins, plays, captions, failures and shards per day', async (t) => {
  const f = tmp();
  const s = await startApp(f.path);
  t.after(() => { s.server.close(); s.metrics.close(); f.done(); });
  await s.get('/v1/1/s?l=ja&q=' + encodeURIComponent('Type to search → '));     // join ping
  await s.get('/v1/2/s?l=he&q=');                                                // join ping
  const r = await (await s.get('/v1/1/s?l=ja&q=' + encodeURIComponent('→ ' + QUERY))).json();
  await s.get('/v1/3/s?l=fr&q=boom');                                            // 502
  await s.get('/v1/3/s?l=fr&q=again');                                           // rate limited (4th search from the IP)
  for (const x of r.results) await s.get(`/v1/1/${x.t}`);
  await s.get(`/v1/1/${r.next}`);                                                // more results
  await s.get('/v1/1/cc/ja');
  await s.get('/v1/1/cc/ko');
  await s.get('/v1/1/cc/1?l=ja');
  await s.get('/v1/0/cc/en');                                                    // nothing played in shard 0
  s.metrics.flush();
  const db = openMetricsDb(f.path);
  const by = {};
  for (const row of db.prepare('SELECT metric, key, value FROM daily').all()) (by[row.metric] ??= {})[row.key] = row.value;
  assert.deepEqual(by.join, { '': 2 });
  assert.deepEqual(by.join_lang, { ja: 1, he: 1 });
  assert.deepEqual(by.search, { '': 2 });
  assert.deepEqual(by.search_lang, { ja: 1, fr: 1 });
  assert.deepEqual(by.search_fail, { 502: 1, 429: 1 });
  assert.deepEqual(by.search_source, { local: 1 });
  assert.equal(by.play[''], 4);
  // Every player in the room loads the ticket; the room's play counts once.
  for (let i = 0; i < 5; i++) await s.get(`/v1/1/${r.results[0].t}`);
  await s.get(`/v1/2/s?l=ja&q=${encodeURIComponent('→ other room')}`, { 'x-forwarded-for': '198.51.100.9' }).then((x) => x.json()).then((r2) => s.get(`/v1/2/${r2.results[0].t}`));
  s.metrics.flush();
  assert.equal(db.prepare("SELECT value FROM daily WHERE metric = 'play'").get().value, 5); // + the same video in another room
  // Platform: once per room and platform, from the player's User-Agent (the resolver's can't tell).
  const pc = { 'user-agent': 'NSPlayer/12.00.26100.1 WMFSDK/12.00.26100.1' }, quest = { 'user-agent': 'stagefright/1.2 (Linux;Android 12)' };
  for (const h of [pc, pc, quest, quest, { 'user-agent': 'Mozilla/5.0 Chrome/120' }]) await s.get(`/v1/1/${r.results[0].t}`, h);
  s.metrics.flush();
  assert.deepEqual(Object.fromEntries(db.prepare("SELECT key, value FROM daily WHERE metric = 'play_platform'").all().map((x) => [x.key, x.value])), { pc: 1, android: 1 });
  assert.deepEqual(by.play_route, { 'tunelio-progressive': 1, 'tunelio-hls': 1, 'youtube-fallback': 1, 'youtube-live': 1 });
  assert.deepEqual(by.play_fallback, { tunelio_failed: 1 });
  assert.deepEqual(by.play_length, { lt10m: 1, lt1h: 1, lt3h: 1, live: 1 });
  assert.deepEqual(by.more, { '': 1 });
  assert.deepEqual(by.cc_list, { '': 3 });
  assert.deepEqual(by.cc_list_lang, { ja: 1, ko: 1, en: 1 });
  assert.deepEqual(by.cc_track, { '': 1 });
  assert.deepEqual(by.cc_track_lang, { 'pt-BR': 1 });
  assert.deepEqual(by.cc_unavailable, { no_track_in_language: 1, nothing_playing: 1 });
  const shards = db.prepare(`SELECT key FROM hourly WHERE metric = 'shard' ORDER BY key`).all().map((x) => x.key);
  assert.deepEqual(shards, ['0', '1', '2', '3']);
  db.close();
});

test('privacy: no IP, query text, video ID or ticket number reaches the metrics database', async (t) => {
  const f = tmp();
  const s = await startApp(f.path);
  t.after(() => { s.server.close(); s.metrics.close(); f.done(); });
  const r = await (await s.get('/v1/1/s?l=ja&q=' + encodeURIComponent('→ ' + QUERY))).json();
  await s.get('/v1/1/s?l=' + encodeURIComponent(IP) + '&q=' + encodeURIComponent('https://youtu.be/' + IDS[0]));
  await s.get('/v1/1/s?l=x&q=');
  for (const x of r.results) await s.get(`/v1/1/${x.t}`);
  await s.get(`/v1/1/cc/${encodeURIComponent(IDS[1])}`);
  await s.get('/v1/1/cc/2?l=ja');
  await s.get('/v1/1/cc/pl');
  await s.get('/v1/1/cc/1?l=ja');
  await s.get('/v1/1/r/tester/frozen');                                          // a video report about the play (#353)
  s.metrics.flush();
  // Every string and number in every table.
  const db = openMetricsDb(f.path);
  const cells = [];
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) for (const [col, v] of Object.entries(row)) cells.push({ table: name, col, v: String(v) });
  }
  db.close();
  assert.ok(cells.length > 10);
  const forbidden = [IP, QUERY, 'secret', 'rain', 'youtu.be', ...IDS];
  for (const c of cells) for (const bad of forbidden) assert.ok(!c.v.includes(bad), `${bad} found in ${c.table}.${c.col}: ${c.v}`);
  // Keys are never ticket numbers: the only numeric keys are shards, HTTP statuses and latency buckets.
  const tickets = new Set([...r.results.map((x) => String(x.t)), String(r.sheet), String(r.next)]);
  for (const c of cells.filter((x) => x.col === 'key')) {
    const row = cells.find((x) => x === c);
    if (/^\d+$/.test(c.v) && tickets.has(c.v)) {
      // allowed only as a shard number (< 4)
      assert.ok(Number(c.v) < 4, `ticket-like key ${c.v} in ${row.table}`);
    }
  }
  // The table layout itself has no column that could hold such things.
  const cols = cells.map((c) => c.col);
  for (const bad of ['ip', 'query', 'video', 'ticket', 'user', 'name']) assert.ok(!cols.some((c) => c.toLowerCase().includes(bad)), bad);
});

test('/stats, /stats.json and /stats/export.csv need the token', async (t) => {
  const f = tmp();
  const s = await startApp(f.path);
  t.after(() => { s.server.close(); s.metrics.close(); f.done(); });
  await s.get('/v1/1/s?l=ja&q=' + encodeURIComponent('→ hello'));
  const db = openMetricsDb(f.path);
  recordPoll(db, { ts: Date.now(), source: 'world:prod', values: { visits: 100, favorites: 7, occupants: 2 } });
  db.close();
  assert.equal((await s.get('/stats')).status, 401);
  assert.equal((await s.get('/stats.json?token=wrong')).status, 401);
  const j = await s.get('/stats.json', { authorization: 'Bearer tok-123' });
  assert.equal(j.status, 200);
  const data = await j.json();
  assert.equal(data.today.searches, 1);
  assert.equal(data.today.vrchat.prod.visits, 100);
  const html = await s.get('/stats?token=tok-123');
  assert.equal(html.status, 200);
  const text = await html.text();
  assert.match(text, /<svg/);
  assert.match(text, /href="stats\.json\?token=tok-123"/);
  assert.doesNotMatch(text, /<script|https?:\/\/(?!github)/); // no scripts, no external resources
  const csv = await (await s.get('/stats/export.csv', { authorization: 'Bearer tok-123' })).text();
  assert.match(csv, /^table,period,source,metric,key,value,min,max,last\n/);
  assert.match(csv, /daily,\d{4}-\d\d-\d\d,,search,,1/);
  assert.match(csv, /poll_daily,\d{4}-\d\d-\d\d,world:prod,visits,,,100,100,100/);
});

test('/stats is off (404) without a token configured', async (t) => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 24 });
  const app = createApp({ config: { ...base, shards: 1, pool: 10, statsToken: '', metricsPath: '' }, store, captions: {}, tunelio: { enabled: false }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/stats`)).status, 404);
});

test('poll rows: one per poll, daily min/max/last, old rows pruned after 90 days', () => {
  const db = openMetricsDb(':memory:');
  const day0 = Date.parse('2026-07-01T17:00:00Z');
  recordPoll(db, { ts: day0, source: 'world:prod', values: { occupants: 2, visits: 10 } });
  recordPoll(db, { ts: day0 + 900_000, source: 'world:prod', values: { occupants: 5, visits: 11, heat: null } });
  recordPoll(db, { ts: day0 + 1800_000, source: 'world:prod', values: { occupants: 1, visits: 12 } });
  const d = db.prepare(`SELECT min, max, last, n FROM poll_daily WHERE metric = 'occupants'`).get();
  assert.deepEqual({ ...d }, { min: 1, max: 5, last: 1, n: 3 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM polls').get().n, 6);
  recordPoll(db, { ts: day0 + 91 * 86400_000, source: 'world:prod', values: { occupants: 3 } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM polls').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM poll_daily').get().n, 3); // kept forever
  assert.match(exportCsv(db), /poll_daily,2026-07-01,world:prod,occupants,,,1,5,1/);
});
