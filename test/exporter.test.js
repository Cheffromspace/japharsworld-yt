import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMetricsDb, recordPoll } from '../src/metrics.js';
import { render } from '../metrics/exporter.js';

const NOW = Date.parse('2026-10-20T15:00:00Z');

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'exporter-'));
  const metricsDb = join(dir, 'metrics.db');
  const db = openMetricsDb(metricsDb);
  const put = db.prepare('INSERT INTO daily (day, metric, key, value) VALUES (?, ?, ?, ?)');
  for (const [d, m, k, v] of [
    ['2026-10-18', 'search', '', 40], ['2026-10-19', 'search', '', 10], ['2026-10-19', 'play_route', 'tunelio-hls', 3],
    ['2026-10-19', 'search_ms', '1000', 4], ['2026-10-19', 'search_ms', '3000', 1], ['2026-10-19', 'search_ms', 'inf', 1],
  ]) put.run(d, m, k, v);
  db.prepare('INSERT INTO gauges (day, metric, key, value, at) VALUES (?, ?, ?, ?, ?)').run('2026-10-19', 'credits_remaining', '', 4000, NOW);
  for (const [d, k, v] of [['2026-10-19', 'mb', 9000], ['2026-10-20', 'mb', 2500], ['2026-10-20', 'workers', 1]]) {
    db.prepare('INSERT INTO gauges (day, metric, key, value, at) VALUES (?, ?, ?, ?, ?)').run(d, 'home_today', k, v, NOW);
  }
  for (const [h, k] of [['2026-10-20T09', '3'], ['2026-10-20T10', '3'], ['2026-10-20T10', '0']]) {
    db.prepare('INSERT INTO hourly (hour, metric, key, value) VALUES (?, ?, ?, 1)').run(h, 'shard', k);
  }
  put.run('2026-10-19', 'home_start_s', '5', 2);
  recordPoll(db, { ts: NOW - 60_000, source: 'world:prod', values: { visits: 1040, occupants: 2 } });
  recordPoll(db, { ts: NOW - 3600_000, source: 'world:prod', values: { visits: 1000 } });
  db.prepare('INSERT INTO releases (source, version, at, detected) VALUES (?, ?, ?, ?)').run('world:prod', '104', NOW - 86400_000, NOW);
  db.close();

  const monitorDb = join(dir, 'monitor.db');
  const m = new DatabaseSync(monitorDb);
  m.exec(`CREATE TABLE slots (key TEXT PRIMARY KEY, idx INTEGER, playlist TEXT, baked_video TEXT, current_video TEXT, kind TEXT,
      category TEXT, title TEXT, channel TEXT, channel_id TEXT, baked_hidden INTEGER, auto_hidden INTEGER DEFAULT 0, auto_reason TEXT);
    CREATE TABLE streams (video_id TEXT PRIMARY KEY, height INTEGER, flash_verdict TEXT, flash_max INTEGER, flash_at REAL, last_status TEXT, last_seen REAL);
    CREATE TABLE checks (id INTEGER PRIMARY KEY, ts REAL, slot_key TEXT, status TEXT, source TEXT);
    CREATE TABLE flash (id INTEGER PRIMARY KEY, ts REAL, verdict TEXT);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, created REAL, video_id TEXT, claimed REAL, runner TEXT, done REAL);
    CREATE TABLE quota (day TEXT, ts REAL, units INTEGER, what TEXT);
    INSERT INTO slots VALUES ('lofi-study', 0, 'PL1', 'vidA', 'vidB', 'live', 'music', 't', 'c', 'UC', 0, 0, NULL);
    INSERT INTO slots VALUES ('jack-retro', 1, NULL, 'vidC', NULL, 'live', 'games', 't', 'c', 'UC', 0, 1, 'flash: 9/s');
    INSERT INTO streams VALUES ('vidB', 1080, 'pass', 1, 1760970000, 'live', 1760970000);
    INSERT INTO streams VALUES ('vidC', 720, 'fail', 9, 1760960000, 'live', 1760960000);
    INSERT INTO checks (ts, slot_key, status, source) VALUES (1760970500, 'lofi-study', 'live', 'api');
    INSERT INTO flash (ts, verdict) VALUES (1, 'pass'), (2, 'pass'), (3, 'fail');
    INSERT INTO jobs (created, video_id, claimed, runner, done) VALUES (1760970000, 'vidB', 1760970100, 'optiplex', 1760970200);
    INSERT INTO jobs (created, video_id) VALUES (${NOW / 1000 - 600}, 'vidD');
    INSERT INTO quota VALUES ('2026-10-20', 1, 66, 'daily');`);
  m.close();
  return { dir, metricsDb, monitorDb };
}

test('exporter: usage counters, histograms, polls, slots, flash checks, jobs, health', async () => {
  const f = fixtures();
  try {
    const health = { ok: true, workers: 1, tunelio: true, apiUnitsToday: 12 };
    const text = await render({ metricsDb: f.metricsDb, monitorDb: f.monitorDb, healthUrl: 'http://x/healthz', now: NOW,
      fetchImpl: async () => ({ ok: true, json: async () => health }) });
    const has = (line) => assert.ok(text.split('\n').includes(line), `missing: ${line}\n${text}`);
    has('# TYPE eiok_events_total counter');
    has('eiok_events_total{metric="search",key=""} 50');
    has('eiok_events_total{metric="play_route",key="tunelio-hls"} 3');
    has('# TYPE eiok_search_seconds histogram');
    has('eiok_search_seconds_bucket{le="1"} 4');
    has('eiok_search_seconds_bucket{le="3"} 5');
    has('eiok_search_seconds_bucket{le="+Inf"} 6');
    has('eiok_search_seconds_count 6');
    has('eiok_credits_remaining 4000');
    has('eiok_home_today{key="mb"} 2500');
    has('eiok_home_today{key="workers"} 1');
    assert.ok(!text.includes('eiok_home_today{key="mb"} 9000'), 'only the latest day');
    has('eiok_shard_active_hours_total{shard="3"} 2');
    has('eiok_shard_active_hours_total{shard="0"} 1');
    has('eiok_home_start_seconds_bucket{le="5"} 2');
    has('eiok_poll{source="world:prod",metric="visits"} 1040');
    has('eiok_release_timestamp_seconds{source="world:prod",version="104"} ' + (NOW - 86400_000) / 1000);
    has('eiok_slot_hidden{slot="jack-retro",kind="live",category="games",reason="flash"} 1');
    has('eiok_slot_flash_max{slot="lofi-study",kind="live",category="music"} 1');
    has('eiok_slot_flash_pass{slot="jack-retro",kind="live",category="games"} 0');
    has('eiok_slot_height{slot="lofi-study",kind="live",category="music"} 1080');
    has('eiok_flash_checks_total{verdict="fail"} 1');
    has('eiok_jobs_pending 1');
    has('eiok_jobs_oldest_pending_seconds 600');
    has('eiok_worker_last_done_timestamp_seconds{runner="optiplex"} 1760970200');
    has('eiok_youtube_quota_units{day="2026-10-20"} 66');
    has('eiok_search_up 1');
    has('eiok_relay_workers_online 1');
    has('eiok_exporter_db_ok{db="monitor"} 1');
    // Privacy: no video IDs in the output.
    assert.doesNotMatch(text, /vid[A-D]/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('exporter: missing databases and a down search service still answer', async () => {
  const text = await render({ metricsDb: '/nope/metrics.db', monitorDb: '', healthUrl: 'http://x/healthz',
    fetchImpl: async () => { throw new Error('refused'); } });
  assert.match(text, /^eiok_exporter_db_ok\{db="metrics"\} 0$/m);
  assert.match(text, /^eiok_search_up 0$/m);
});
