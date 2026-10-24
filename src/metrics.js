// Usage metrics (claude/metrics.md). Counts per day, per hour at most; never per-person events.
// The search service counts in memory and writes to SQLite every minute and at shutdown; the poller
// (metrics/poll.js) adds VRChat, Tunelio and GitHub numbers to the same file.
//
// Privacy: every key passes a strict per-metric check before it is counted. Anything that fails it is
// counted as "other", so free text (queries), video IDs, ticket numbers and addresses can't reach the database.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LANGS } from './query.js';

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, metric TEXT NOT NULL, key TEXT NOT NULL DEFAULT '',
    value REAL NOT NULL, PRIMARY KEY (day, metric, key));
  CREATE TABLE IF NOT EXISTS hourly (hour TEXT NOT NULL, metric TEXT NOT NULL, key TEXT NOT NULL DEFAULT '',
    value REAL NOT NULL, PRIMARY KEY (hour, metric, key));
  CREATE TABLE IF NOT EXISTS gauges (day TEXT NOT NULL, metric TEXT NOT NULL, key TEXT NOT NULL DEFAULT '',
    value REAL NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (day, metric, key));
  CREATE TABLE IF NOT EXISTS polls (ts INTEGER NOT NULL, source TEXT NOT NULL, metric TEXT NOT NULL, value REAL,
    PRIMARY KEY (ts, source, metric));
  CREATE TABLE IF NOT EXISTS poll_daily (day TEXT NOT NULL, source TEXT NOT NULL, metric TEXT NOT NULL,
    min REAL, max REAL, last REAL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, source, metric));
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS releases (source TEXT NOT NULL, version TEXT NOT NULL, at INTEGER NOT NULL, detected INTEGER NOT NULL,
    PRIMARY KEY (source, version));
`;

export function openMetricsDb(path, { readOnly = false } = {}) {
  if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly });
  db.exec('PRAGMA busy_timeout = 5000;');
  if (!readOnly) { db.exec('PRAGMA journal_mode = WAL;'); db.exec(SCHEMA); }
  return db;
}

// Calendar day / hour in the reporting time zone (default America/Chicago): "2026-10-19", "2026-10-19T09".
const fmts = new Map();
function parts(ms, tz) {
  if (!fmts.has(tz)) fmts.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }));
  const p = Object.fromEntries(fmts.get(tz).formatToParts(ms).map((x) => [x.type, x.value]));
  return p;
}
export const dayOf = (ms, tz = 'America/Chicago') => { const p = parts(ms, tz); return `${p.year}-${p.month}-${p.day}`; };
export const hourOf = (ms, tz = 'America/Chicago') => { const p = parts(ms, tz); return `${p.year}-${p.month}-${p.day}T${p.hour}`; };

// Latency buckets (upper bounds, ms). Percentiles are read back from these, so they merge across restarts.
export const MS_BUCKETS = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 8000, 12000, 20000];
export const msBucket = (ms) => String(MS_BUCKETS.find((b) => ms <= b) ?? 'inf');
// Build-time buckets (upper bounds, seconds): Tunelio builds run 5–60 s.
export const S_BUCKETS = [2, 5, 8, 12, 16, 20, 25, 30, 40, 50, 60, 90, 120];
export const secondsBucket = (ms) => String(S_BUCKETS.find((b) => ms / 1000 <= b) ?? 'inf');
// File-size buckets (upper bounds, MB) for Tunelio builds.
export const MB_BUCKETS = [100, 250, 500, 1000, 1500, 2000, 3000, 5000];
export const sizeBucket = (mb) => String(MB_BUCKETS.find((b) => mb <= b) ?? 'inf');

export function lengthBucket({ live, seconds }) {
  if (live) return 'live';
  if (!seconds) return 'unknown';
  if (seconds < 600) return 'lt10m';
  if (seconds < 3600) return 'lt1h';
  if (seconds < 3 * 3600) return 'lt3h';
  return 'longer';
}

const oneOf = (...xs) => { const s = new Set(xs); return (k) => s.has(k); };
const isLang = (k) => Object.hasOwn(LANGS, k);
const isStatus = (k) => /^[1-5]\d\d$/.test(k);
const isBucket = oneOf(...MS_BUCKETS.map(String), 'inf');
const isSBucket = oneOf(...S_BUCKETS.map(String), 'inf');
// Caption track languages as YouTube names them: "en", "pt-BR", "zh-Hans", "es-419".
const isTrackLang = (k) => /^[a-z]{2,3}(-(?:[A-Z]{2}|[A-Z][a-z]{3}|\d{3}))?$/.test(k);
const none = (k) => k === '';

// metric → [table, key check]
export const METRICS = {
  search: ['daily', none],
  search_lang: ['daily', isLang],
  search_source: ['daily', oneOf('worker', 'local', 'api')],
  search_fail: ['daily', isStatus],
  search_ms: ['daily', isBucket],
  more: ['daily', none],
  more_fail: ['daily', isStatus],
  play: ['daily', none],
  play_platform: ['daily', oneOf('pc', 'android')], // once per room and platform: the player's User-Agent or a .m3u8 ticket
  play_route: ['daily', oneOf('tunelio-progressive', 'tunelio-hls', 'tunelio-adaptive', 'home', 'youtube-live', 'youtube-fallback')],
  // Home relay (src/home.js): sessions started / ready / failed, new sessions refused by the daily cap, and why a play
  // started home (Tunelio off, a long video, the credit pacer, Tunelio's build failed), counted once per session.
  home: ['daily', oneOf('start', 'ready', 'failed', 'capped', 'defer', 'timeout', 'cache_hit', 'settled', 'settle_timeout', 'other_quality', 'uneven')],
  home_why: ['daily', oneOf('tunelio_off', 'long', 'pacer', 'tunelio_failed', 'av1', 'tunelio_slow')],
  home_start_s: ['daily', isSBucket],
  // Today's home relay use against its cap and the media workers connected, set every minute (numbers only).
  channel: ['daily', oneOf('redirect', 'unavailable', 'unknown')], // /v1/ch/<key> (src/channels.js)
  transfer: ['daily', oneOf('linode', 'home')], // MB sent by each host (src/net.js)
  home_today: ['gauge', oneOf('mb', 'builds', 'cap_mb', 'workers', 'cache_mb')],
  // Playback plans (src/adaptive.js): which plan each video got, masters served, 1080p upgrades started / served /
  // failed, plays the pacer kept at 720p, resolvers sent on to the player. plan_start: adaptive from a 360p first rung.
  adaptive: ['daily', oneOf('plan_lower', 'plan_direct', 'plan_adaptive', 'plan_start', 'master', 'upgrade', 'upgrade_served', 'upgrade_failed', 'paced_off', 'defer', 'android_progressive', 'hls_ticket',
    'reload_before_upgrade', 'reload_after_upgrade', 'android_av1', 'android_av1_rung', 'start_one_step', 'start_mid')], // reloads: the freeze proxy (src/adaptive.js master)
  play_fallback: ['daily', oneOf('disabled', 'paused', 'tunelio_failed', 'build_failed', 'build_timeout')],
  play_length: ['daily', oneOf('live', 'unknown', 'lt10m', 'lt1h', 'lt3h', 'longer')],
  tunelio_create_ms: ['daily', isBucket],
  // Playback latency (claude/play-latency.md): who asks for tickets, how long they were held, Tunelio build times.
  ticket_client: ['daily', oneOf('string', 'ytdlp', 'avpro', 'other')],
  ticket_hold_ms: ['daily', isBucket],
  ticket_fastfail: ['daily', none],   // resolver told "not a video" while the build ran on
  ticket_timeout: ['daily', none],    // a player waited the whole hold and got youtube.com instead
  build: ['daily', oneOf('ok', 'failed')],
  build_s_progressive: ['daily', isSBucket],
  build_s_hls: ['daily', isSBucket],
  build_length: ['daily', oneOf('live', 'unknown', 'lt10m', 'lt1h', 'lt3h', 'longer')],
  build_size: ['daily', oneOf(...MB_BUCKETS.map(String), 'inf')],
  build_quality: ['daily', (k) => /^\d{3,4}p$/.test(k)],
  quality_pick: ['daily', (k) => /^\d{3,4}p$/.test(k) || k === 'auto'], // a room picked this playback quality (or Auto) on its tablet
  warm: ['daily', none],              // builds started by a tablet before Play (10 credits each)
  warm_played: ['daily', none],       // …of which a player then asked for the video
  cc_list: ['daily', none],
  cc_tracks: ['daily', none],         // the picker's list alone (free sources only; the tablet's CC popover)
  cc_list_lang: ['daily', (k) => isLang(k) || k === 'native'],
  cc_track: ['daily', none],
  cc_track_lang: ['daily', isTrackLang],
  cc_unavailable: ['daily', oneOf('no_captions', 'no_track_in_language', 'temporarily_unavailable', 'translation_unavailable',
    'nothing_playing', 'no_tracks', 'list_unavailable', 'failed', 'none')],
  cc_via: ['daily', oneOf('worker', 'local', 'tunelio')],  // which caption source answered a fetch (src/captionchain.js)
  cc_words: ['daily', oneOf('real', 'estimated')],         // word timing in a served track: YouTube's, or spread by character
  credits: ['daily', oneOf('playback', 'captions', 'probe', 'test')],
  join: ['daily', none],
  join_lang: ['daily', isLang],
  credits_remaining: ['gauge', none],
  shard: ['hourly', (k) => /^\d{1,3}$/.test(k)],
};

export function checkedKey(metric, key = '') {
  const def = METRICS[metric];
  if (!def) throw new Error(`unknown metric ${metric}`);
  const k = String(key ?? '');
  return def[1](k) ? k : 'other';
}

export class Metrics {
  constructor({ path, tz = 'America/Chicago', now = () => Date.now(), log = () => {} }) {
    this.path = path;
    this.tz = tz;
    this.now = now;
    this.log = log;
    this.db = null;
    this.pending = new Map(); // "table\tperiod\tmetric\tkey" → number
    this.timer = null;
  }

  #add(metric, key, value, mode) {
    const [table] = METRICS[metric] ?? [];
    const k = checkedKey(metric, key);
    const t = this.now();
    const period = table === 'hourly' ? hourOf(t, this.tz) : dayOf(t, this.tz);
    const id = `${table}\t${period}\t${metric}\t${k}`;
    this.pending.set(id, mode === 'add' ? (this.pending.get(id) ?? 0) + value : value);
  }

  inc(metric, key = '', n = 1) { this.#add(metric, key, n, 'add'); }
  gauge(metric, key, value) { if (Number.isFinite(value)) this.#add(metric, key, value, 'set'); }
  latency(metric, ms) { this.inc(metric, msBucket(ms)); }
  // Distinct shards per hour: one row per (hour, shard) that saw a request.
  shard(shard) { this.#add('shard', String(shard), 1, 'set'); }

  open() {
    this.db ??= openMetricsDb(this.path);
    return this.db;
  }

  flush() {
    if (!this.pending.size) return 0;
    const batch = this.pending;
    this.pending = new Map();
    try {
      const db = this.open();
      const q = {
        daily: db.prepare(`INSERT INTO daily (day, metric, key, value) VALUES (?, ?, ?, ?)
          ON CONFLICT(day, metric, key) DO UPDATE SET value = value + excluded.value`),
        hourly: db.prepare(`INSERT INTO hourly (hour, metric, key, value) VALUES (?, ?, ?, ?)
          ON CONFLICT(hour, metric, key) DO UPDATE SET value = MAX(value, excluded.value)`),
        gauge: db.prepare(`INSERT INTO gauges (day, metric, key, value, at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(day, metric, key) DO UPDATE SET value = excluded.value, at = excluded.at`),
      };
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [id, value] of batch) {
          const [table, period, metric, key] = id.split('\t');
          if (table === 'gauge') q.gauge.run(period, metric, key, value, this.now());
          else q[table].run(period, metric, key, value);
        }
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      return batch.size;
    } catch (err) {
      // Keep the counts for the next try.
      for (const [id, v] of batch) {
        if (!this.pending.has(id)) this.pending.set(id, v);
        else if (!id.startsWith('gauge\t') && !id.startsWith('hourly\t')) this.pending.set(id, this.pending.get(id) + v);
      }
      this.log({ event: 'metrics_flush_failed', message: String(err?.message ?? err).slice(0, 200) });
      return 0;
    }
  }

  start(intervalMs = 60_000) {
    this.timer ??= setInterval(() => this.flush(), intervalMs);
    this.timer.unref?.();
    return this;
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    this.flush();
    this.db?.close();
    this.db = null;
  }
}

// For tests and METRICS_DB= (off): counts nothing.
export const noMetrics = { inc() {}, gauge() {}, latency() {}, shard() {}, flush() { return 0; }, start() { return this; }, close() {} };

// Poller rows (metrics/poll.js): one row per poll and source, kept `keepDays`; daily min/max/last kept forever.
// values: { metric: number|null }.
export function recordPoll(db, { ts, source, values, tz = 'America/Chicago', keepDays = 90 }) {
  const day = dayOf(ts, tz);
  const put = db.prepare('INSERT OR REPLACE INTO polls (ts, source, metric, value) VALUES (?, ?, ?, ?)');
  const daily = db.prepare(`INSERT INTO poll_daily (day, source, metric, min, max, last, n) VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(day, source, metric) DO UPDATE SET min = MIN(min, excluded.min), max = MAX(max, excluded.max),
    last = excluded.last, n = n + 1`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [metric, v] of Object.entries(values)) {
      if (!Number.isFinite(v)) continue;
      put.run(ts, source, metric, v);
      daily.run(day, source, metric, v, v, v);
    }
    db.prepare('DELETE FROM polls WHERE ts < ?').run(ts - keepDays * 86400_000);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export const getMeta = (db, k) => db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
export const setMeta = (db, k, v) => db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
