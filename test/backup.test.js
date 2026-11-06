import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { sigV4, makeS3, makeLocal, dayWindow, daysToBackUp, addDays, scrub, eventsJsonl, journalArgs, promSummary, snapshotDb, run, readState, configFrom } from '../metrics/backup.js';
import { dayOf } from '../src/metrics.js';

const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'eiok-backup-test-')); return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }; };

test('sigV4 matches the AWS documentation example (S3 GET Object, signature f0e8bdb8…)', () => {
  const auth = sigV4({
    method: 'GET', path: '/test.txt', region: 'us-east-1', amzDate: '20130524T000000Z',
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  });
  assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('makeS3 PUTs with SSE, a payload hash and a signature, and reports S3 errors without the key', async () => {
  const calls = [];
  const ok = makeS3({ bucket: 'b', region: 'us-east-2', accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETVALUE', now: () => Date.parse('2026-11-06T07:30:00Z'),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('', { status: 200 }); } });
  const r = await ok('eiok/2026/11/05/events.jsonl.gz', Buffer.from('x'));
  assert.equal(calls[0].url, 'https://b.s3.us-east-2.amazonaws.com/eiok/2026/11/05/events.jsonl.gz');
  const h = calls[0].init.headers;
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(h['x-amz-server-side-encryption'], 'AES256');
  assert.equal(h['x-amz-date'], '20261106T073000Z');
  assert.equal(h['x-amz-content-sha256'], r.sha256);
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20261106\/us-east-2\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-server-side-encryption, Signature=[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(calls).includes('SECRETVALUE'));
  const denied = makeS3({ bucket: 'b', region: 'us-east-2', accessKeyId: 'AKIDTEST', secretAccessKey: 'SECRETVALUE',
    fetchImpl: async () => new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 }) });
  await assert.rejects(denied('eiok/x', Buffer.from('x')), (err) => /HTTP 403 AccessDenied/.test(err.message) && !err.message.includes('SECRET'));
});

test('dayWindow: Chicago days, 23 and 25 hours on the DST changes', () => {
  const [s, e] = dayWindow('2026-11-05');
  assert.equal(new Date(s).toISOString(), '2026-11-05T06:00:00.000Z');
  assert.equal(new Date(e).toISOString(), '2026-11-06T06:00:00.000Z');
  const [s2, e2] = dayWindow('2026-11-01'); // DST ends: 25 h
  assert.equal((e2 - s2) / 3600_000, 25);
  const [s3, e3] = dayWindow('2026-03-08'); // DST starts: 23 h
  assert.equal((e3 - s3) / 3600_000, 23);
  assert.equal(dayOf(s3 - 1), '2026-03-07');
  assert.equal(dayOf(e3 - 1), '2026-03-08');
});

test('daysToBackUp: yesterday; catches up after a missed run, at most max days; nothing twice', () => {
  const now = Date.parse('2026-11-06T07:30:00Z'); // 01:30 Chicago on 11-06
  assert.deepEqual(daysToBackUp(undefined, now), { days: ['2026-11-05'], skipped: null });
  assert.deepEqual(daysToBackUp('2026-11-04', now), { days: ['2026-11-05'], skipped: null });
  assert.deepEqual(daysToBackUp('2026-11-02', now), { days: ['2026-11-03', '2026-11-04', '2026-11-05'], skipped: null });
  assert.deepEqual(daysToBackUp('2026-10-20', now, { max: 3 }), { days: ['2026-11-03', '2026-11-04', '2026-11-05'], skipped: '2026-10-21' });
  assert.deepEqual(daysToBackUp('2026-11-05', now).days, []);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('scrub: IP addresses and token-like values are replaced and counted; times, sizes and words stay', () => {
  const counts = { ip: 0, secret: 0 };
  const o = scrub({ event: 'x', at: '2026-11-06T01:02:03.000Z', message: 'from 203.0.113.9 and 2001:db8::1 and ::ffff:198.51.100.7 at 12:34:56', url: 'https://h/p?token=abc123&x=1',
    auth: 'Bearer eyJhbGciOi', blob: 'k'.repeat(40), ms: 1234, version: '1.2.3', mb: '12.5', mac: 'a1:b2', text: 'ordinary words stay' }, counts);
  assert.equal(o.message, 'from …ip and …ip and ::ffff:…ip at 12:34:56'); // the mapped address's IPv4 part goes
  assert.equal(o.url, 'https://h/p?token=…&x=1');
  assert.equal(o.auth, '…');
  assert.equal(o.blob, '…');
  assert.equal(o.version, '1.2.3');
  assert.equal(o.ms, 1234);
  assert.equal(o.mac, 'a1:b2');
  assert.equal(o.text, 'ordinary words stay');
  assert.equal(o.at, '2026-11-06T01:02:03.000Z');
  assert.deepEqual(counts, { ip: 3, secret: 3 });
});

test('eventsJsonl: only event lines, through the /ops/events allowlist: no video ID, ticket, shard, UA or IP leaves', async () => {
  const lines = [
    'Listening on 127.0.0.1:8790',
    JSON.stringify({ at: '2026-11-05T10:00:00Z', event: 'play', shard: 3, n: 17, id: 'dQw4w9WgXcQ', via: 'home', client: 'avpro', ua: 'NSPlayer/12.00 WMFSDK/12.00', held: 120 }),
    JSON.stringify({ at: '2026-11-05T10:00:01Z', event: 'tunelio_link', message: 'failed for https://tunelio.dev/v?id=dQw4w9WgXcQ&sig=zzz from 198.51.100.4', ip: '198.51.100.4' }),
    '[1,2]', '{"no":"event"}', 'not json {',
  ];
  const counts = { lines: 0, events: 0, ip: 0, secret: 0 };
  const text = await eventsJsonl(lines, counts);
  const rows = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { at: '2026-11-05T10:00:00Z', event: 'play', via: 'home', client: 'avpro', held: 120 });
  for (const leak of ['dQw4w9WgXcQ', '198.51.100.4', 'NSPlayer', 'zzz', '"shard"', '"n"']) assert.ok(!text.includes(leak), leak);
  assert.equal(counts.lines, 6);
  assert.equal(counts.events, 2);
  assert.equal(counts.ip, 1);
  assert.equal(await eventsJsonl([]), '');
});

test('promSummary: hourly avg and max per series, basic auth, failures recorded per query', async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push({ url, auth: init.headers.authorization });
    if (url.includes('max_over_time')) return new Response(JSON.stringify({ status: 'error', error: 'bad' }), { status: 400 });
    return Response.json({ status: 'success', data: { result: [{ metric: { host: 'linode' }, values: [[1762408800, '0.25']] }] } });
  };
  const [start, end] = dayWindow('2026-11-05');
  const s = await promSummary({ url: 'https://prom.example/api/prom/', user: '123', token: 'glc_x', start, end, fetchImpl, series: { load1: 'max by (host) (node_load1)' } });
  assert.deepEqual(s.series.load1.avg, [{ labels: { host: 'linode' }, values: [[1762408800, 0.25]] }]);
  assert.match(s.errors['load1:max'], /HTTP 400 bad/);
  const q = new URL(urls[0].url);
  assert.equal(q.origin + q.pathname, 'https://prom.example/api/prom/api/v1/query_range');
  assert.equal(q.searchParams.get('query'), 'avg_over_time((max by (host) (node_load1))[1h:1m])');
  assert.equal(Number(q.searchParams.get('start')) * 1000, start + 3600_000);
  assert.equal(Number(q.searchParams.get('end')) * 1000, end);
  assert.equal(urls[0].auth, `Basic ${Buffer.from('123:glc_x').toString('base64')}`);
});

test('snapshotDb: a consistent gzipped copy of a WAL database while a writer has it open', (t) => {
  const f = tmp();
  t.after(f.done);
  const path = join(f.dir, 'live.db');
  const w = new DatabaseSync(path);
  w.exec('PRAGMA journal_mode=WAL; CREATE TABLE daily (day, metric, key, value); INSERT INTO daily VALUES (\'2026-11-05\', \'play\', \'\', 7);');
  const gz = snapshotDb(path, f.dir);
  w.exec('INSERT INTO daily VALUES (\'2026-11-05\', \'search\', \'\', 1);');
  w.close();
  const out = join(f.dir, 'restored.db');
  writeFileSync(out, gunzipSync(gz));
  const db = new DatabaseSync(out, { readOnly: true });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily').get().n, 1);
  db.close();
  assert.deepEqual(readdirSync(f.dir).filter((x) => x.startsWith('snap-')), [], 'the temporary copy is removed');
});

function fakeRun(f, { failOn = null, tickets = false, journal = 'full' } = {}) {
  const puts = [];
  const metricsDb = join(f.dir, 'metrics.db'), ticketsDb = join(f.dir, 'tickets.db'), deploysLog = join(f.dir, 'deploys.log');
  for (const p of [metricsDb, ticketsDb]) { const d = new DatabaseSync(p); d.exec('CREATE TABLE IF NOT EXISTS t (x); INSERT INTO t VALUES (1);'); d.close(); }
  writeFileSync(deploysLog, '1762400000 60cf3d0 restarted\n');
  const cfg = { ...configFrom({}), prefix: 'eiok', state: join(f.dir, 'state.json'), metricsDb, ticketsDb, deploysLog, tickets, tmpDir: f.dir };
  const put = async (key, body) => { if (failOn && key.includes(failOn)) throw new Error('S3 PUT: HTTP 403 AccessDenied'); puts.push({ key, body }); return { key, bytes: body.length, sha256: 'h' }; };
  // full: an event at the day's start; empty: the journal unreadable; late: it starts 5 h into the day (rotated).
  const events = async ({ start, counts }) => eventsJsonl(journal === 'empty' ? [] : [
    'Started japharsworld-yt.service',
    JSON.stringify({ at: new Date(start + (journal === 'late' ? 5 * 3600_000 : 60_000)).toISOString(), event: 'play', id: 'dQw4w9WgXcQ', via: 'home' }),
  ], counts);
  const logs = [], alerts = [];
  return { cfg, puts, put, events, logs, alerts, log: (o) => logs.push(o), alert: (k, text) => alerts.push({ k, text }) };
}
const go = (r, extra = {}) => run({ cfg: r.cfg, put: r.put, events: r.events, prom: null, log: r.log, alert: r.alert, ...extra });

test('run: uploads each due day by date, deploys and DB snapshot with the newest only, manifest last; tickets.db off by default', async (t) => {
  const f = tmp();
  t.after(f.done);
  const r = fakeRun(f);
  writeFileSync(r.cfg.state, JSON.stringify({ lastDay: '2026-11-03' }));
  const out = await go(r, { now: Date.parse('2026-11-06T07:30:00Z') });
  assert.deepEqual(out, { ok: true, days: ['2026-11-04', '2026-11-05'] });
  assert.deepEqual(r.puts.map((p) => p.key), [
    'eiok/2026/11/04/events.jsonl.gz', 'eiok/2026/11/04/deploys.log', 'eiok/2026/11/04/manifest.json',
    'eiok/2026/11/05/events.jsonl.gz', 'eiok/2026/11/05/deploys.log', 'eiok/2026/11/05/metrics.db.gz', 'eiok/2026/11/05/manifest.json',
  ]);
  assert.equal(r.puts[1].body.toString(), '1762400000 60cf3d0 restarted\n');
  const manifest = JSON.parse(r.puts.at(-1).body.toString());
  assert.equal(manifest.day, '2026-11-05');
  assert.deepEqual(manifest.notes, ['grafana: no BACKUP_PROM_TOKEN, skipped', 'tickets.db.gz: off']);
  assert.deepEqual(manifest.events, { lines: 2, events: 1, ip: 0, secret: 0, id: 0 });
  const ev = gunzipSync(r.puts[0].body).toString();
  assert.ok(!ev.includes('dQw4w9WgXcQ'));
  assert.equal(JSON.parse(ev).event, 'play');
  const state = readState(r.cfg.state);
  assert.equal(state.lastDay, '2026-11-05');
  assert.ok(Date.now() - state.lastSuccessMs < 10_000);
  // The same night again: nothing due, nothing uploaded.
  const again = await go(r, { now: Date.parse('2026-11-06T09:00:00Z') });
  assert.deepEqual(again.days, []);
  assert.equal(r.puts.length, 7);
  assert.deepEqual(r.alerts, []);
});

test('run: BACKUP_TICKETS=on adds tickets.db; a failed upload alerts, keeps the last good day and retries next run', async (t) => {
  const f = tmp();
  t.after(f.done);
  const r = fakeRun(f, { tickets: true, failOn: '2026/11/05/metrics' });
  writeFileSync(r.cfg.state, JSON.stringify({ lastDay: '2026-11-03', lastSuccessMs: 1 }));
  const out = await go(r, { now: Date.parse('2026-11-06T07:30:00Z') });
  assert.deepEqual(out, { ok: false, days: ['2026-11-04'], failed: '2026-11-05' });
  assert.equal(readState(r.cfg.state).lastDay, '2026-11-04');
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].k, 'backup_failed');
  assert.match(r.alerts[0].text, /2026-11-05: S3 PUT: HTTP 403 AccessDenied/);
  assert.ok(r.logs.some((l) => l.event === 'backup_failed' && l.day === '2026-11-05'));
  // Next run, S3 fine: 11-05 again, with both snapshots.
  const ok = fakeRun(f, { tickets: true });
  const again = await go(ok, { now: Date.parse('2026-11-06T09:00:00Z') });
  assert.deepEqual(again.days, ['2026-11-05']);
  assert.deepEqual(ok.puts.map((p) => p.key.split('/').pop()), ['events.jsonl.gz', 'deploys.log', 'metrics.db.gz', 'tickets.db.gz', 'manifest.json']);
});

test('run: an unreadable or empty journal is a failure, never an empty backup marked done', async (t) => {
  const f = tmp();
  t.after(f.done);
  const r = fakeRun(f, { journal: 'empty' });
  const out = await go(r, { now: Date.parse('2026-11-06T07:30:00Z') });
  assert.deepEqual(out, { ok: false, days: [], failed: '2026-11-05' });
  assert.deepEqual(r.puts, [], 'nothing uploaded');
  assert.deepEqual(readState(r.cfg.state), {}, 'no state');
  assert.match(r.alerts[0].text, /no events in the journal for 2026-11-05/);
});

test('run --day: an ended day only; no snapshots; the last day never moves back; a rotated day is not overwritten without --force', async (t) => {
  const f = tmp();
  t.after(f.done);
  const r = fakeRun(f);
  writeFileSync(r.cfg.state, JSON.stringify({ lastDay: '2026-11-05' }));
  const now = Date.parse('2026-11-06T12:00:00Z'); // 06:00 Chicago on 11-06
  const out = await go(r, { onlyDay: '2026-11-01', now });
  assert.deepEqual(out.days, ['2026-11-01']);
  assert.equal(readState(r.cfg.state).lastDay, '2026-11-05');
  assert.deepEqual(r.puts.map((p) => p.key.split('/').pop()), ['events.jsonl.gz', 'deploys.log', 'manifest.json']);
  assert.ok(JSON.parse(r.puts.at(-1).body.toString()).notes.includes('snapshots: not on a --day re-run'));
  for (const day of ['2026-11-06', '2027-01-01']) {
    const bad = await go(r, { onlyDay: day, now });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /only a day that has ended/);
  }
  assert.equal(readState(r.cfg.state).lastDay, '2026-11-05');
  const late = fakeRun(f, { journal: 'late' });
  const refused = await go(late, { onlyDay: '2026-11-02', now });
  assert.equal(refused.ok, false);
  assert.match(late.alerts[0].text, /the journal starts at .* after 2026-11-02 began: not overwriting \(--force\)/);
  assert.deepEqual(late.puts, []);
  const forced = await go(late, { onlyDay: '2026-11-02', now, force: true });
  assert.equal(forced.ok, true);
  assert.ok(JSON.parse(late.puts.at(-1).body.toString()).notes.some((n) => /^events: the journal starts at/.test(n)));
  // A nightly run with a rotated start notes it and goes on.
  const nightly = fakeRun(f, { journal: 'late' });
  writeFileSync(nightly.cfg.state, JSON.stringify({ lastDay: '2026-11-04' }));
  assert.equal((await go(nightly, { now: Date.parse('2026-11-06T07:30:00Z') })).ok, true);
});


test('run: a failure outside a day (the temp folder) is logged and alerted too', async (t) => {
  const f = tmp();
  t.after(f.done);
  const r = fakeRun(f);
  r.cfg.tmpDir = join(f.dir, 'missing', 'deeper');
  const out = await go(r, { now: Date.parse('2026-11-06T07:30:00Z') });
  assert.equal(out.ok, false);
  assert.equal(r.alerts.length, 1);
  assert.ok(r.logs.some((l) => l.event === 'backup_failed' && l.day === null));
});

test('journalArgs: both units, the day from its first second to the next day\'s first (inclusive), message text only', () => {
  const [start, end] = dayWindow('2026-11-05');
  assert.deepEqual(journalArgs({ units: ['japharsworld-yt', 'japharsworld-yt-metrics'], start, end }),
    ['-u', 'japharsworld-yt', '-u', 'japharsworld-yt-metrics', '--since', '@1793858400', '--until', '@1793944800', '-o', 'cat', '--no-pager', '-q']);
  assert.deepEqual(configFrom({}).units, ['japharsworld-yt', 'japharsworld-yt-metrics']);
  assert.deepEqual(configFrom({ BACKUP_UNITS: 'a, b;rm -rf /,c' }).units, ['a', 'c']);
});

test('makeLocal: the same keys under a folder, never outside it', async (t) => {
  const f = tmp();
  t.after(f.done);
  const put = makeLocal(join(f.dir, 'out'));
  const r = await put('eiok/2026/11/05/manifest.json', Buffer.from('{}'));
  assert.equal(r.bytes, 2);
  assert.equal(readFileSync(join(f.dir, 'out', 'eiok', '2026', '11', '05', 'manifest.json'), 'utf8'), '{}');
  await assert.rejects(put('../escape.txt', Buffer.from('x')), /bad key/);
});

test('scrub: glued video IDs, name: value and JSON tokens, AWS key IDs and padded IPs go; error codes stay', () => {
  const c = {};
  const s = (m) => scrub({ m }, c).m;
  assert.equal(s('dQw4w9WgXcQ_720.mp4'), '….mp4');
  assert.equal(s('/home/dQw4w9WgXcQ-720/'), '/home/…/');
  assert.equal(s('token: abc'), 'token: …');
  assert.equal(s('{"token":"xyz"}'), '{"token":"…"}');
  assert.equal(s('Cookie: SID=x'), 'Cookie: …');
  assert.equal(s('key AKIAIOSFODNN7EXAMPLE'), 'key …');
  assert.equal(s('from 010.001.002.003'), 'from …ip');
  for (const keep of ['ERR_STREAM_PREMATURE_CLOSE', 'S3 PUT: HTTP 403 AccessDenied', 'SignatureDoesNotMatch', 'tunelio_create_timeout', 'fetch failed: ECONNRESET', 'seg_00012.m4s', 'ses 3fa9c1d2e4b5a6c7d8']) assert.equal(s(keep), keep);
});

test('configFrom: off without a bucket, prefix trimmed, BACKUP_MAX_DAYS bounded, tickets only when on', () => {
  const c = configFrom({ BACKUP_S3_BUCKET: 'b', BACKUP_S3_PREFIX: '/eiok/', BACKUP_MAX_DAYS: '99', BACKUP_TICKETS: 'yes' });
  assert.equal(c.prefix, 'eiok');
  assert.equal(c.maxDays, 7);
  assert.equal(c.tickets, false);
  assert.equal(configFrom({}).bucket, '');
  assert.equal(configFrom({ BACKUP_TICKETS: 'on' }).tickets, true);
});
