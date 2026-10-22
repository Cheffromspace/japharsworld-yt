import test from 'node:test';
import assert from 'node:assert/strict';
import { TunelioProbe } from '../src/probe.js';
import { openMetricsDb, recordPoll } from '../src/metrics.js';

const MIN = 60_000;
const video = (id, seconds, live = false) => ({ id, seconds, live });

// A clock that each fetch advances, so build times are deterministic.
function setup({ videos = [video('AAAAAAAAAAA', 1200), video('BBBBBBBBBBB', 1500), video('CCCCCCCCCCC', 300)], firstByteMs = 30_000,
  status = 200, busy = 0, search, hls = 'segment' } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const rows = [], logs = [], fetched = [], created = [];
  const tunelio = { async create(id, q) { created.push([id, q]); t += 800; return { url: `https://tunelio.dev/tunnel?id=${id}`, expires: 9e9, quality: q, fileSize: 900e6 }; } };
  const fetcher = async (url, opts = {}) => {
    fetched.push([url, opts.headers?.range ?? null]);
    if (/hls=1$/.test(url)) { t += 5000; return new Response(hls === 'master' ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/index.m3u8\n' : '#EXTM3U\n#EXTINF:4,\nseg0.ts\n', { status }); }
    if (/index\.m3u8$/.test(url)) { t += 1000; return new Response('#EXTM3U\n#EXTINF:4,\nseg0.ts\n', { status }); }
    t += /seg0/.test(url) ? 2000 : firstByteMs;
    return new Response('x', { status: status === 200 ? 206 : status });
  };
  const probe = new TunelioProbe({ tunelio, fetcher, now, random: () => 0, busy: () => busy, log: (o) => logs.push(o),
    search: search ?? (async () => ({ videos })), record: (source, values) => rows.push([source, values]) });
  return { probe, rows, logs, fetched, created, advance: (ms) => { t += ms; } };
}

test('probe: a fresh 12–30 min video, progressive first byte, then HLS on the next run', async () => {
  const s = setup();
  const a = await s.probe.runOnce();
  assert.equal(a.format, 'progressive');
  assert.deepEqual(s.created[0], ['AAAAAAAAAAA', '1080p']);
  assert.deepEqual(s.fetched[0], ['https://tunelio.dev/tunnel?id=AAAAAAAAAAA&progressive=1', 'bytes=0-0']);
  const [source, values] = s.rows[0];
  assert.equal(source, 'tunelio:progressive');
  assert.deepEqual(values, { ok: 1, warm: 0, create_s: 0.8, mb: 900, minutes: 20, start_s: 30, mb_per_s: 30 });

  const b = await s.probe.runOnce();
  assert.equal(b.format, 'hls');
  assert.equal(s.created[1][0], 'BBBBBBBBBBB', 'never the same video twice; the 5-minute one never');
  assert.deepEqual(s.fetched.slice(1).map(([u]) => u), ['https://tunelio.dev/tunnel?id=BBBBBBBBBBB&hls=1', 'https://tunelio.dev/seg0.ts']);
  assert.equal(s.rows[1][0], 'tunelio:hls');
  assert.equal(s.rows[1][1].playlist_s, 5);
  assert.equal(s.rows[1][1].start_s, 7);

  // Rows carry numbers only: no video ID reaches the database.
  const db = openMetricsDb(':memory:');
  for (const [src, v] of s.rows) recordPoll(db, { ts: 1, source: src, values: v });
  const dump = JSON.stringify(db.prepare('SELECT * FROM polls').all()) + JSON.stringify(db.prepare('SELECT * FROM poll_daily').all());
  assert.doesNotMatch(dump, /AAAAAAAAAAA|BBBBBBBBBBB/);
});

test('probe: master playlist → first variant → first segment', async () => {
  const s = setup({ hls: 'master' });
  await s.probe.runOnce(); // progressive
  await s.probe.runOnce();
  assert.deepEqual(s.fetched.slice(1).map(([u]) => u), ['https://tunelio.dev/tunnel?id=BBBBBBBBBBB&hls=1', 'https://tunelio.dev/v/index.m3u8', 'https://tunelio.dev/v/seg0.ts']);
  assert.equal(s.rows[1][1].playlist_s, 6);
});

test('probe: a warm answer is not a speed sample; failures are recorded', async () => {
  const warm = setup({ firstByteMs: 300 });
  await warm.probe.runOnce();
  assert.equal(warm.rows[0][1].warm, 1);
  assert.equal(warm.rows[0][1].start_s, undefined);
  assert.equal(warm.rows[0][1].mb_per_s, undefined);

  const bad = setup({ status: 503 });
  await bad.probe.runOnce();
  assert.equal(bad.rows[0][1].ok, 0);
  assert.equal(bad.rows[0][1].start_s, undefined);
});

test('probe: no relay worker or nothing that fits → no credits spent, retried in 15 min', async () => {
  const none = setup({ search: async () => null });
  assert.equal(await none.probe.runOnce(), null);
  assert.equal(none.created.length, 0);
  const short = setup({ videos: [video('CCCCCCCCCCC', 300), video('DDDDDDDDDDD', 0, true)] });
  assert.equal(await short.probe.runOnce(), null);
  assert.equal(short.created.length, 0);
  assert.equal(Number(short.probe.meta.get('tunelio_probe_next')), 1_000_000 + 15 * MIN);
});

test('probe schedule: not at start-up, every 20 min at most with jitter, never while a visitor build runs', async () => {
  const s = setup();
  assert.equal(await s.probe.tick(), null, 'first tick only books the first run');
  assert.equal(s.created.length, 0);
  s.advance(9 * MIN);
  assert.equal(await s.probe.tick(), null);
  s.advance(1 * MIN);
  assert.equal((await s.probe.tick()).format, 'progressive');
  s.advance(19 * MIN);
  assert.equal(await s.probe.tick(), null, 'every 20 minutes at most');
  s.advance(2 * MIN);
  assert.equal((await s.probe.tick()).format, 'hls');
  assert.equal(s.created.length, 2);

  const busy = setup({ busy: 1 });
  busy.probe.meta.set('tunelio_probe_next', 1);
  assert.equal(await busy.probe.tick(), null);
  assert.equal(busy.created.length, 0);

  assert.equal(new TunelioProbe({ intervalMinutes: 5 }).intervalMs, 20 * MIN, 'clamped to 20 minutes');
  assert.equal(new TunelioProbe({ intervalMinutes: 0 }).intervalMs, 0, '0 = off');
});
