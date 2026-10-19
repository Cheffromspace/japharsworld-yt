import test from 'node:test';
import assert from 'node:assert/strict';
import { openMetricsDb, recordPoll } from '../src/metrics.js';
import { dailyReport, weeklyReport, chunks } from '../metrics/report.js';

const NOW = Date.parse('2026-10-19T14:05:00Z'); // Mon 09:05 in Chicago
const at = (day, h = 18) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00Z`);

function seeded() {
  const db = openMetricsDb(':memory:');
  const put = db.prepare('INSERT INTO daily (day, metric, key, value) VALUES (?, ?, ?, ?)');
  const day = (d, rows) => { for (const [m, k, v] of rows) put.run(d, m, k, v); };
  day('2026-10-18', [
    ['search', '', 40], ['search_lang', 'en', 30], ['search_lang', 'ja', 10], ['search_source', 'worker', 38], ['search_source', 'api', 2],
    ['search_fail', '502', 1], ['search_fail', '429', 1], ['search_ms', '1000', 20], ['search_ms', '3000', 19], ['search_ms', '8000', 1],
    ['more', '', 5], ['play', '', 30], ['play_route', 'tunelio-progressive', 25], ['play_route', 'youtube-fallback', 5], ['play_fallback', 'tunelio_failed', 5],
    ['cc_list', '', 6], ['cc_list_lang', 'ko', 6], ['cc_track', '', 2], ['cc_unavailable', 'no_captions', 1],
    ['credits', 'playback', 250], ['credits', 'captions', 18], ['join', '', 12], ['join_lang', 'en', 8], ['join_lang', 'th', 4],
  ]);
  // The week before: fewer.
  for (const d of ['2026-10-05', '2026-10-06', '2026-10-07']) day(d, [['search', '', 10], ['play', '', 5], ['join', '', 3], ['credits', 'playback', 50]]);
  for (const d of ['2026-10-13', '2026-10-15']) day(d, [['search', '', 20], ['play', '', 10], ['join', '', 4], ['credits', 'playback', 100]]);
  db.prepare('INSERT INTO gauges (day, metric, key, value, at) VALUES (?, ?, ?, ?, ?)').run('2026-10-19', 'credits_remaining', '', 4000, NOW);
  // VRChat: visits 1000 at the end of the 17th, 1040 at the end of the 18th.
  recordPoll(db, { ts: at('2026-10-11'), source: 'world:prod', values: { visits: 900, favorites: 50, occupants: 3, publicOccupants: 1, privateOccupants: 2 } });
  recordPoll(db, { ts: at('2026-10-17'), source: 'world:prod', values: { visits: 1000, favorites: 60, occupants: 2, publicOccupants: 2, privateOccupants: 0 } });
  recordPoll(db, { ts: at('2026-10-18', 15), source: 'world:prod', values: { visits: 1020, favorites: 61, occupants: 6, publicOccupants: 2, privateOccupants: 4 } });
  recordPoll(db, { ts: at('2026-10-18', 22), source: 'world:prod', values: { visits: 1040, favorites: 62, occupants: 1, publicOccupants: 1, privateOccupants: 0 } });
  recordPoll(db, { ts: at('2026-10-18'), source: 'group', values: { members: 128, online: 9 } });
  return db;
}

test('daily report: VRChat deltas and peaks, search, credits with forecast, captions, languages, failures', () => {
  const db = seeded();
  const text = dailyReport(db, { day: '2026-10-18', now: NOW, monitorDb: '' });
  const lines = text.split('\n');
  assert.equal(lines[0], '**Everything is OK: Sun, Oct 18**');
  assert.equal(lines[1], 'VRChat: visits 1,040 (+40), favorites 62 (+2), peak 6 in world (public 2, private 4)');
  assert.equal(lines[2], 'Group: 128 members, up to 9 online');
  assert.equal(lines[3], 'Search: 40 searches, 5 "more results", 30 plays; 12 joins (untrusted URLs on)');
  // 2 failures of 41 attempts (40 searches + one rate-limited).
  assert.equal(lines[4], 'Sources: worker 38, api 2; failures 4.9 % (429 1, 502 1); p50 1,000 ms, p95 3,000 ms');
  assert.equal(lines[5], 'Plays: tunelio-progressive 25, youtube-fallback 5; fallbacks: tunelio_failed 5');
  assert.equal(lines[6], 'Captions: 6 shown, 2 tracks picked, not available: no_captions 1');
  // Plan period from Oct 1 (default): 268 + 150 + 200 = 618 credits over 18 days + 9/24 → 34/day; 4,000 left lasts.
  assert.equal(lines[7], 'Credits: 268 spent (playback 250, captions 18), 4,000 left; at 34/day they last to renewal (Nov 1)');
  assert.equal(lines[8], 'Languages: en, ja, ko, th');
  assert.equal(lines[9], 'Channels: no monitor data');
  assert.ok(text.length < 2000);
});

test('daily report without VRChat data says so', () => {
  const db = openMetricsDb(':memory:');
  const text = dailyReport(db, { day: '2026-10-18', now: NOW, monitorDb: '' });
  assert.match(text, /VRChat: no data/);
  assert.match(text, /Search: 0 searches/);
  assert.match(text, /Credits: 0 spent .*– left/);
});

test('credits forecast names the day they run out when they will not last', () => {
  const db = seeded();
  db.prepare('UPDATE gauges SET value = 300').run();
  assert.match(dailyReport(db, { day: '2026-10-18', now: NOW, monitorDb: '' }), /at 34\/day they run out Oct 27, before renewal \(Nov 1\)/);
});

test('credits forecast counts from the renewal day (TUNELIO_RENEWS_DAY)', () => {
  const db = seeded();
  // Period from Oct 17: only Oct 18's 268 credits, over 2 days + 9/24 → 113/day; 4,000 last past Nov 17.
  assert.match(dailyReport(db, { day: '2026-10-18', now: NOW, monitorDb: '', renewDay: 17 }), /at 113\/day they last to renewal \(Nov 17\)/);
});

test('releases appear in the daily and weekly reports, in Chicago time', () => {
  const db = seeded();
  const put = db.prepare('INSERT INTO releases (source, version, at, detected) VALUES (?, ?, ?, ?)');
  put.run('world:prod', '104', Date.parse('2026-10-18T20:02:00Z'), NOW);
  put.run('github:Everything-is-OK', 'v2026.10.18', Date.parse('2026-10-18T19:40:00Z'), NOW);
  put.run('world:test', '103', Date.parse('2026-10-16T10:00:00Z'), NOW);
  const daily = dailyReport(db, { day: '2026-10-18', now: NOW, monitorDb: '' });
  assert.match(daily, /\nReleases: GitHub v2026\.10\.18 Oct 18, 2:40 PM; production v104 uploaded Oct 18, 3:02 PM\n/);
  const weekly = weeklyReport(db, { endDay: '2026-10-18', now: NOW });
  assert.match(weekly, /Releases: TEST v103 uploaded Oct 16, 5:00 AM; GitHub v2026\.10\.18 .*; production v104/);
});

test('weekly report: week over week', () => {
  const db = seeded();
  const lines = weeklyReport(db, { endDay: '2026-10-18', now: NOW }).split('\n');
  assert.equal(lines[0], '**Everything is OK: week Oct 12–Oct 18** (vs the week before)');
  assert.equal(lines[1], 'VRChat: +140 visits (new), +12 favorites (new), peak 6 in world (was 3)');
  assert.equal(lines[2], 'Group: 128 members');
  assert.equal(lines[3], 'Search: 80 searches (+167 %), 50 plays (+233 %), 20 joins (+122 %)');
  assert.match(lines[5], /^Captions: 6 shown \(new\)$/);
  assert.match(lines[6], /^Credits: 468 spent \(\+212 %\), 4,000 left$/);
});

test('long reports are split for Discord at line breaks', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} `.repeat(10)).join('\n');
  const parts = chunks(text, 400);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 400));
  assert.equal(parts.join('\n'), text);
});
