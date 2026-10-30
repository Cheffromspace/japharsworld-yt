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
  assert.deepEqual(values, { ok: 1, warm: 0, create_s: 0.8, mb: 900, minutes: 20, height: 1080, start_s: 30, mb_per_s: 30 });

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

test('probe: every 3rd run builds the same video at 720p and 1080p at once', async () => {
  const s = setup();
  await s.probe.runOnce(); // progressive
  await s.probe.runOnce(); // hls
  s.probe.seen.clear();
  const c = await s.probe.runOnce();
  assert.equal(c.pair, true);
  assert.equal(c.format, 'progressive');
  assert.deepEqual(s.created.slice(2).map(([id, q]) => [id, q]).sort(), [['AAAAAAAAAAA', '1080p'], ['AAAAAAAAAAA', '720p']], 'one video, both qualities');
  assert.deepEqual(s.rows.slice(2).map(([src, v]) => [src, v.height, v.hls]).sort(), [['tunelio:pair1080', 1080, 0], ['tunelio:pair720', 720, 0]]);
  s.probe.seen.clear();
  for (let i = 0; i < 3; i++) { s.probe.seen.clear(); await s.probe.runOnce(); }
  assert.equal(s.rows.at(-1)[0].startsWith('tunelio:pair'), true, 'run 6 is a pair again');
  assert.equal(s.rows.at(-1)[1].hls, 1, 'pairs alternate format too');
  assert.equal(new TunelioProbe({ pairEvery: 0 }).pairEvery, 0);
});

// Drop check (#361): scripted connections, a clock that sleep advances, one chunk = 1 s at 0.45 MB/s.
const CHUNK = new Uint8Array(450_000);
const cutErr = () => Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } });
function dropSetup({ conns = [], fileSize = 900e6, seconds = 1200, busy = () => 0, dropMinutes = 10, total = 900_000_000, ...opts } = {}) {
  let t = 1_000_000;
  const logs = [], counts = {}, opens = [], created = [];
  const script = [...conns];
  const tunelio = { async create(id, q) { created.push(q); return { url: `https://tunelio.dev/tunnel?id=${id}&q=${q}`, expires: 9e9, quality: q, fileSize }; } };
  const fetcher = async (url, o = {}) => {
    const range = o.headers?.range;
    if (range === 'bytes=0-0') { t += 30_000; return new Response('x', { status: 206 }); }
    if (!range) return new Response('#EXTM3U\n#EXTINF:4,\nseg0.ts\n', { status: 200 });
    const start = Number(/bytes=(\d+)-/.exec(range)[1]);
    opens.push({ url, start });
    const c = script.shift() ?? {};
    if (c.throws) throw c.throws;
    if (c.status) return new Response('', { status: c.status, headers: { 'content-range': `bytes ${start}-${total - 1}/${total}` } });
    const reported = c.wrongOffset ? start + 1 : start;
    let sent = 0;
    const body = new ReadableStream({
      pull(ctl) {
        if (c.hang && sent >= c.hang) return new Promise((_, no) => { o.signal.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError'))); });
        if (c.cutAfter != null && sent >= c.cutAfter) { ctl.error(cutErr()); return undefined; }
        if (c.closeAfter != null && sent >= c.closeAfter) { ctl.close(); return undefined; }
        if (start + sent >= total) { ctl.close(); return undefined; }
        sent += CHUNK.length;
        ctl.enqueue(CHUNK);
        return undefined;
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: 206, headers: { 'content-range': `bytes ${reported}-${total - 1}/${total}` } });
  };
  const probe = new TunelioProbe({ tunelio, fetcher, now: () => t, random: () => 0, busy, log: (e) => logs.push(e), dropMinutes,
    sleep: async (ms) => { t += ms; }, dropCount: (k, n) => { counts[k] = (counts[k] ?? 0) + n; },
    search: async () => ({ videos: [video('AAAAAAAAAAA', seconds), video('BBBBBBBBBBB', seconds), video('EEEEEEEEEEE', seconds)] }), ...opts });
  return { probe, logs, counts, opens, created, ev: (name) => logs.filter((e) => e.event === name) };
}

test('drop check: off by default, and HLS runs read nothing', async () => {
  const off = dropSetup({ dropMinutes: 0 });
  assert.equal((await off.probe.runOnce()).drop, null);
  assert.equal(off.opens.length, 0);
  const hls = dropSetup();
  hls.probe.meta.set('tunelio_probe_runs', 1);
  assert.equal((await hls.probe.runOnce()).format, 'hls');
  assert.equal(hls.opens.length, 0);
});

test('drop check: reads the paid link at the paced rate for 10 minutes, no more credits', async () => {
  const s = dropSetup({ conns: [{}] });
  const r = await s.probe.runOnce();
  assert.equal(s.created.length, 1, 'one /create: the read reuses its link');
  assert.deepEqual(s.opens, [{ url: 'https://tunelio.dev/tunnel?id=AAAAAAAAAAA&q=1080p&progressive=1', start: 0 }]);
  assert.equal(r.drop.ended, 'time');
  assert.equal(r.drop.minutes, 10);
  assert.ok(Math.abs(r.drop.readMb - 270) <= 1, `270 MB, got ${r.drop.readMb}`);
  assert.ok(Math.abs(s.counts.minutes - 10) < 0.05, `minutes counted ${s.counts.minutes}`);
  assert.equal(s.counts.cut, undefined);
});

test('drop check: a file with a lower bitrate reads at its own rate; a pair reads its 720p', async () => {
  const s = dropSetup({ conns: [{}], fileSize: 120e6, seconds: 1200 });
  const r = await s.probe.runOnce();
  assert.ok(Math.abs(r.drop.readMb - 60) <= 1, `0.1 MB/s for 10 min, got ${r.drop.readMb}`);
  assert.equal(s.ev('tunelio_drop')[0].rate, 0.1);

  const pair = dropSetup({ conns: [{}] });
  pair.probe.meta.set('tunelio_probe_runs', 2);
  await pair.probe.runOnce();
  assert.match(pair.opens[0].url, /q=720p/);
});

test('drop check: a cut resumes at the byte reached, with the numbers to line it up by clock time', async () => {
  const s = dropSetup({ conns: [{ cutAfter: 450_000 * 100 }, {}] });
  const r = await s.probe.runOnce();
  assert.deepEqual(s.opens.map((o) => o.start), [0, 450_000 * 100]);
  assert.equal(r.drop.cuts, 1);
  assert.equal(r.drop.reopenOk, 1);
  assert.equal(r.drop.ended, 'time');
  assert.equal(r.drop.minutes, 10, 'the reopen gap is not read time');
  assert.equal(s.counts.cut, 1);
  assert.equal(s.counts.reopen_ok, 1);
  const [cut] = s.ev('tunelio_drop_cut');
  assert.equal(cut.kind, 'reset');
  assert.equal(cut.error, 'ECONNRESET');
  assert.equal(cut.readMb, 45);
  assert.equal(cut.pos, 0.05);
  assert.ok(Math.abs(cut.connS - 100) <= 1, `connS ${cut.connS}`);
  assert.ok(Date.parse(cut.lastByteAt) > 0);
  const [re] = s.ev('tunelio_drop_reopen');
  assert.deepEqual([re.ok, re.status, re.offsetOk, re.attempt], [true, 206, true, 1]);
  assert.doesNotMatch(JSON.stringify([...s.ev('tunelio_drop_cut'), ...s.ev('tunelio_drop_reopen'), ...s.ev('tunelio_drop')]), /AAAAAAAAAAA|tunnel/, 'no video or link in its lines');
});

test('drop check: a wrong status, wrong offset or thrown reopen fails; three in a row end the read', async () => {
  const s = dropSetup({ conns: [{ cutAfter: 450_000 * 10 }, { status: 503 }, { wrongOffset: true }, { throws: Object.assign(new Error('x'), { name: 'TimeoutError' }) }] });
  const r = await s.probe.runOnce();
  assert.equal(r.drop.ended, 'reopen_fail');
  assert.equal(r.drop.reopenFail, 3);
  assert.equal(s.counts.reopen_fail, 3);
  assert.equal(s.counts.reopen_ok, undefined);
  const re = s.ev('tunelio_drop_reopen');
  assert.deepEqual(re.map((e) => [e.ok, e.attempt, e.status ?? null, e.offsetOk ?? null]), [[false, 1, 503, true], [false, 2, 206, false], [false, 3, null, null]]);
  assert.equal(re[2].error, 'TimeoutError');
});

test('drop check: one failed reopen and then a good one carries on', async () => {
  const s = dropSetup({ conns: [{ cutAfter: 450_000 * 10 }, { status: 502 }, {}] });
  const r = await s.probe.runOnce();
  assert.equal(r.drop.ended, 'time');
  assert.deepEqual([s.counts.reopen_fail, s.counts.reopen_ok], [1, 1]);
  assert.deepEqual(s.opens.map((o) => o.start), [0, 4_500_000, 4_500_000]);
});

test('drop check: a hang and a clean early close count as cuts', async () => {
  const hang = dropSetup({ conns: [{ hang: 450_000 * 5 }, {}], dropStallMs: 20 });
  assert.equal((await hang.probe.runOnce()).drop.cuts, 1);
  assert.equal(hang.ev('tunelio_drop_cut')[0].kind, 'stall');

  const short = dropSetup({ conns: [{ closeAfter: 450_000 * 5 }, {}] });
  assert.equal((await short.probe.runOnce()).drop.cuts, 1);
  assert.equal(short.ev('tunelio_drop_cut')[0].kind, 'short');
});

test('drop check: the end of the file is no cut; a link that keeps cutting stops at the wall', async () => {
  const eof = dropSetup({ conns: [{}], total: 450_000 * 5 });
  const r = await eof.probe.runOnce();
  assert.equal(r.drop.ended, 'eof');
  assert.equal(r.drop.cuts, 0);
  assert.equal(eof.opens.length, 1);

  const cutting = dropSetup({ conns: Array.from({ length: 200 }, () => ({ cutAfter: 450_000 })), dropMinutes: 1 });
  const w = await cutting.probe.runOnce();
  assert.equal(w.drop.ended, 'wall');
  assert.ok(cutting.opens.length < 200);
});

test('drop check: skipped while a visitor build is in flight, and a failed first open counts as no reopen', async () => {
  let builds = 0;
  const s = dropSetup({ busy: () => builds });
  s.probe.tunelio.create = async (id, q) => { builds = 1; return { url: `https://tunelio.dev/tunnel?id=${id}`, quality: q, fileSize: 900e6 }; };
  assert.equal((await s.probe.runOnce()).drop, null);
  assert.equal(s.opens.length, 0);
  assert.equal(s.ev('tunelio_drop')[0].skipped, 'busy');

  const bad = dropSetup({ conns: [{ status: 503 }] });
  assert.equal((await bad.probe.runOnce()).drop.ended, 'open_failed');
  assert.deepEqual(bad.counts, {});
});

test('drop check: stop() ends the read with its counts and no false failure', async () => {
  const s = dropSetup({ conns: [{}] });
  let ticks = 0;
  const inner = s.probe.sleep;
  s.probe.sleep = async (ms) => { if (++ticks === 120) s.probe.stop(); return inner(ms); };
  const r = await s.probe.runOnce();
  assert.equal(r.drop.ended, 'stopped');
  assert.ok(r.drop.minutes > 1.5 && r.drop.minutes < 2.5, `${r.drop.minutes}`);
  assert.equal(s.counts.reopen_fail, undefined);
  assert.ok(s.counts.minutes > 1.5, 'the minutes read so far are counted');
});
