// Prometheus exporter for Grafana Cloud (claude/monitoring.md), run by japharsworld-yt-exporter.service.
//   GET http://127.0.0.1:9464/metrics   (loopback only; Grafana Alloy on this host scrapes it and ships it out)
//
// Reads what is already recorded at scrape time: the metrics database (read only), the link monitor's database
// (read only) and the search service's /healthz. Labels are metric keys, slot keys and verdicts that already passed
// the privacy checks in src/metrics.js; never video IDs, queries or addresses.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { METRICS, MS_BUCKETS, S_BUCKETS, dayOf } from '../src/metrics.js';
import { REFUSAL_CLASSES as FLASH_REFUSALS } from '../src/refusal.js';

// Daily bucket counters exported as Prometheus histograms (le in seconds), so histogram_quantile works.
// metric → [exported name, bucket bounds, bound units per second]
const HISTOGRAMS = {
  search_ms: ['eiok_search_seconds', MS_BUCKETS, 1000], tunelio_create_ms: ['eiok_tunelio_create_seconds', MS_BUCKETS, 1000],
  ticket_hold_ms: ['eiok_ticket_hold_seconds', MS_BUCKETS, 1000],
  build_s_progressive: ['eiok_build_progressive_seconds', S_BUCKETS, 1], build_s_hls: ['eiok_build_hls_seconds', S_BUCKETS, 1],
  home_start_s: ['eiok_home_start_seconds', S_BUCKETS, 1],
};

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmt = (v) => (v === Infinity ? '+Inf' : Number.isFinite(v) ? String(v) : 'NaN');

class Out {
  constructor() { this.families = new Map(); }
  add(name, type, help, labels, value) {
    if (value == null || Number.isNaN(Number(value))) return;
    const f = this.families.get(name) ?? { type, help, rows: [] };
    this.families.set(name, f);
    const l = Object.entries(labels ?? {}).filter(([, v]) => v != null).map(([k, v]) => `${k}="${esc(v)}"`).join(',');
    f.rows.push(`${name}${l ? `{${l}}` : ''} ${fmt(Number(value))}`);
  }
  text() {
    const out = [];
    for (const [name, f] of this.families) {
      const base = f.type === 'histogram' ? name.replace(/_bucket$|_count$/, '') : name;
      if (!out.includes(`# TYPE ${base} ${f.type}`)) out.push(`# HELP ${base} ${f.help}`, `# TYPE ${base} ${f.type}`);
      out.push(...f.rows);
    }
    return `${out.join('\n')}\n`;
  }
}

function openRo(path) {
  if (!path || !existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

// Usage counters: every day summed, so they only ever grow (use increase()/rate() in Grafana).
export function metricsDbSeries(db, o, now = Date.now()) {
  const totals = db.prepare("SELECT metric, key, SUM(value) v FROM daily GROUP BY metric, key").all();
  const hist = {};
  for (const r of totals) {
    if (HISTOGRAMS[r.metric]) { (hist[r.metric] ??= {})[r.key] = r.v; continue; }
    if (METRICS[r.metric]?.[0] !== 'daily') continue;
    o.add('eiok_events_total', 'counter', 'Usage counts from the search service, all days summed (claude/metrics.md).', { metric: r.metric, key: r.key }, r.v);
  }
  for (const [metric, [name, bounds, perSecond]] of Object.entries(HISTOGRAMS)) {
    const b = hist[metric] ?? {};
    let seen = 0;
    for (const le of [...bounds, Infinity]) {
      seen += b[le === Infinity ? 'inf' : String(le)] ?? 0;
      o.add(`${name}_bucket`, 'histogram', `${metric} from the daily buckets.`, { le: le === Infinity ? '+Inf' : String(le / perSecond) }, seen);
    }
    o.add(`${name}_count`, 'histogram', `${metric} from the daily buckets.`, {}, seen);
  }
  const credits = db.prepare("SELECT value, at FROM gauges WHERE metric = 'credits_remaining' ORDER BY day DESC, at DESC LIMIT 1").get();
  if (credits) o.add('eiok_credits_remaining', 'gauge', 'Tunelio credits left (search service, last seen).', {}, credits.value);
  for (const r of db.prepare(`SELECT key, value FROM gauges WHERE metric = 'home_today'
      AND day = (SELECT MAX(day) FROM gauges WHERE metric = 'home_today')`).all()) {
    o.add('eiok_home_today', 'gauge', 'Home relay today (mb, builds, cap_mb) and media workers connected, set every minute.', { key: r.key }, r.value);
  }
  // Bytes each host sent today and this month (Chicago days, like every daily row), for the transfer alerts: Grafana
  // Cloud keeps 14 days, too little for a month-to-date increase() (src/net.js).
  const today = dayOf(now);
  for (const host of ['linode', 'home']) {
    const sum = (where, arg) => db.prepare(`SELECT COALESCE(SUM(value), 0) v FROM daily WHERE metric = 'transfer' AND key = ? AND ${where}`).get(host, arg).v;
    o.add('eiok_transfer_bytes', 'gauge', 'Bytes sent by the host (linode, home) today and this month, from metrics.db.', { host, period: 'today' }, sum('day = ?', today) * 1e6);
    o.add('eiok_transfer_bytes', 'gauge', 'Bytes sent by the host (linode, home) today and this month, from metrics.db.', { host, period: 'month' }, sum('day LIKE ?', `${today.slice(0, 7)}-%`) * 1e6);
  }
  // Rooms: one row per (hour, shard) that saw a request, so increase() over an hour = the shards active in it.
  for (const r of db.prepare("SELECT key, COUNT(*) n FROM hourly WHERE metric = 'shard' GROUP BY key").all()) {
    o.add('eiok_shard_active_hours_total', 'counter', 'Hours each shard (room) saw a request, all days summed.', { shard: r.key }, r.n);
  }
  // Latest poll per source and metric: VRChat worlds (prod/test), group, Tunelio, GitHub.
  const polls = db.prepare(`SELECT p.source, p.metric, p.value, p.ts FROM polls p
    JOIN (SELECT source, metric, MAX(ts) ts FROM polls GROUP BY source, metric) m USING (source, metric, ts)`).all();
  const lastPoll = {};
  for (const p of polls) {
    o.add('eiok_poll', 'gauge', 'Latest value the metrics poller recorded (VRChat, group, Tunelio, GitHub, domain expiry in epoch seconds).', { source: p.source, metric: p.metric }, p.value);
    lastPoll[p.source] = Math.max(lastPoll[p.source] ?? 0, p.ts);
  }
  for (const [source, ts] of Object.entries(lastPoll)) o.add('eiok_poll_timestamp_seconds', 'gauge', 'When the poller last recorded this source.', { source }, ts / 1000);
  // One series per release, value = when: the dashboard marks each one at that time, including uploads from before
  // the exporter existed (the latest 50 are enough).
  for (const r of db.prepare('SELECT source, version, at FROM releases ORDER BY at DESC LIMIT 50').all()) {
    o.add('eiok_release_timestamp_seconds', 'gauge', 'Releases seen (world uploads, GitHub tags), the latest 50; value = when.', { source: r.source, version: r.version }, r.at / 1000);
  }
}

// Channels link monitor (monitor/slotmon): per slot, the flash checks, the job queue and the workers.
export function monitorDbSeries(db, o, now = Date.now()) {
  const slots = db.prepare(`SELECT s.key, s.kind, s.category, s.auto_hidden, s.auto_reason, s.baked_hidden,
      st.height, st.flash_verdict, st.flash_max, st.flash_at, st.last_status, st.last_seen
    FROM slots s LEFT JOIN streams st ON st.video_id = COALESCE(s.current_video, s.baked_video)
    WHERE s.idx IS NOT NULL AND s.kind IN ('live', 'video') ORDER BY s.idx`).all();
  for (const s of slots) {
    const l = { slot: s.key, kind: s.kind, category: s.category ?? '' };
    o.add('eiok_slot_hidden', 'gauge', '1 when the monitor hid the slot (down, flash fail, waiting for a check).', { ...l, reason: s.auto_hidden ? (s.auto_reason ?? 'hidden').split(':')[0].slice(0, 40) : '' }, s.auto_hidden ? 1 : 0);
    o.add('eiok_slot_spare', 'gauge', '1 for a spare slot the world bakes hidden.', l, s.baked_hidden ? 1 : 0);
    o.add('eiok_slot_up', 'gauge', '1 when the slot\'s stream was live (or the video available) at the last check.', l,
      s.last_status == null ? null : (s.last_status === 'live' || (s.kind === 'video' && s.last_status === 'video')) ? 1 : 0);
    o.add('eiok_slot_height', 'gauge', 'Vertical resolution of the slot\'s current stream at its last probe.', l, s.height);
    o.add('eiok_slot_flash_max', 'gauge', 'Most flashes in any 1 s at the last flash check (fails above 3).', l, s.flash_max);
    o.add('eiok_slot_flash_pass', 'gauge', '1 = the last flash check passed, 0 = failed.', l, s.flash_verdict == null ? null : s.flash_verdict === 'pass' ? 1 : 0);
    o.add('eiok_slot_flash_timestamp_seconds', 'gauge', 'When the slot\'s current stream was last flash-checked.', l, s.flash_at);
  }
  // YouTube refusals the flash worker met (owner, 2026-10-26: monitor/slotmon/probe.py refusal_class), as the search
  // service's yt_refusal <where>:<class> with where = flash, so the dashboard and eiok-flash-refusals see them. Only
  // the class leaves the monitor DB; anything else in detail is dropped.
  // Every class from 0, so the series exist before the first refusal and the rule has data to evaluate.
  const refused = Object.fromEntries(db.prepare("SELECT detail, COUNT(*) n FROM events WHERE kind = 'yt_refusal' GROUP BY detail").all().map((r) => [r.detail, r.n]));
  for (const cls of FLASH_REFUSALS) {
    o.add('eiok_events_total', 'counter', 'Usage counts from the search service, all days summed (claude/metrics.md).', { metric: 'yt_refusal', key: `flash:${cls}` }, refused[cls] ?? 0);
  }
  for (const r of db.prepare('SELECT verdict, COUNT(*) n FROM flash GROUP BY verdict').all()) {
    o.add('eiok_flash_checks_total', 'counter', 'Flash checks run, by verdict.', { verdict: r.verdict ?? 'none' }, r.n);
  }
  const q = db.prepare('SELECT COUNT(*) n, MIN(created) oldest FROM jobs WHERE done IS NULL').get();
  o.add('eiok_jobs_pending', 'gauge', 'Resolution + flash jobs waiting for a worker.', {}, q.n);
  // By reason (owner, 2026-10-25): the 14:00 UTC daily batch (~60 jobs) takes ~3.5 h at 6 jobs a run, so it alerts
  // later than new/candidate/manual checks.
  const ages = db.prepare(`SELECT CASE WHEN reason = 'daily' THEN 'daily' ELSE 'other' END reason, MIN(created) oldest
    FROM jobs WHERE done IS NULL GROUP BY 1`).all();
  for (const reason of ['daily', 'other']) {
    const oldest = ages.find((a) => a.reason === reason)?.oldest;
    o.add('eiok_jobs_oldest_pending_seconds', 'gauge', 'Age of the oldest waiting job, daily batch or other (0 when none).', { reason }, oldest ? Math.max(0, now / 1000 - oldest) : 0);
  }
  for (const r of db.prepare('SELECT runner, MAX(done) done FROM jobs WHERE done IS NOT NULL AND runner IS NOT NULL GROUP BY runner').all()) {
    o.add('eiok_worker_last_done_timestamp_seconds', 'gauge', 'When each worker (optiplex, pc, linode) last finished a job.', { runner: r.runner }, r.done);
  }
  const last = db.prepare("SELECT MAX(ts) ts FROM checks WHERE source IS NULL OR source NOT LIKE 'seed%'").get();
  o.add('eiok_monitor_last_check_timestamp_seconds', 'gauge', 'When the monitor last checked a slot.', {}, last?.ts);
  const quota = db.prepare('SELECT day, SUM(units) u FROM quota GROUP BY day ORDER BY day DESC LIMIT 1').get();
  if (quota) o.add('eiok_youtube_quota_units', 'gauge', 'YouTube Data API units used on the latest Pacific day (alerts past 8,000).', { day: quota.day }, quota.u);
}

// Live state from the search service itself.
export function healthSeries(h, o) {
  o.add('eiok_search_up', 'gauge', '1 when the search service answered /healthz.', {}, h?.ok ? 1 : 0);
  if (!h?.ok) return;
  o.add('eiok_relay_workers_online', 'gauge', 'Search relay workers (the Optiplex) long-polling right now.', {}, h.workers);
  o.add('eiok_tunelio_enabled', 'gauge', '1 when Tunelio playback is on.', {}, h.tunelio ? 1 : 0);
  o.add('eiok_youtube_api_units_today', 'gauge', 'YouTube Data API units the search service used today.', {}, h.apiUnitsToday);
}

export async function render({ metricsDb, monitorDb, healthUrl, now = Date.now(), fetchImpl = fetch }) {
  const o = new Out();
  for (const [name, path, fn] of [['metrics', metricsDb, metricsDbSeries], ['monitor', monitorDb, monitorDbSeries]]) {
    let db, ok = false;
    try {
      db = openRo(path);
      if (db) { fn(db, o, now); ok = true; }
    } catch (err) {
      console.error(JSON.stringify({ event: 'exporter_db_failed', db: name, message: String(err?.message ?? err).slice(0, 200) }));
    } finally { db?.close(); }
    o.add('eiok_exporter_db_ok', 'gauge', '1 when the exporter could read this database.', { db: name }, ok ? 1 : 0);
  }
  let health = null;
  if (healthUrl) {
    try { const r = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(3000) }); health = r.ok ? await r.json() : null; } catch { health = null; }
  }
  healthSeries(health, o);
  return o.text();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const e = process.env;
  const port = Number.parseInt(e.EXPORTER_PORT ?? '9464', 10);
  const opts = {
    metricsDb: e.METRICS_DB ?? '/var/lib/japharsworld-yt/metrics.db',
    monitorDb: e.MONITOR_DB ?? '/var/lib/japharsworld-yt-monitor/monitor.db',
    healthUrl: `http://127.0.0.1:${e.PORT ?? 8790}/healthz`,
  };
  http.createServer(async (req, res) => {
    if (req.url !== '/metrics') { res.writeHead(404).end(); return; }
    try {
      const body = await render(opts);
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(body);
    } catch (err) {
      res.writeHead(500).end(String(err?.message ?? err));
    }
  }).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'exporter_listening', port })));
}
