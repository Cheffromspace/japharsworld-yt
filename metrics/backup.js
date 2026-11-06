// Daily backup to a private S3 bucket (Everything-is-OK#585; owner 2026-11-06: Grafana Cloud free keeps 14 days, "can we
// back everything up so we can run analysis over time?", "s3 is perfect"). Run by japharsworld-yt-backup.timer at 01:30
// America/Chicago, as jyt. For each reporting day not yet backed up (at most BACKUP_MAX_DAYS, oldest first) it uploads
//   s3://<bucket>/<prefix>/<yyyy>/<mm>/<dd>/events.jsonl.gz    the service's log events that day, redacted (below)
//   s3://<bucket>/<prefix>/<yyyy>/<mm>/<dd>/grafana.json.gz    hourly avg/max of the Grafana-only series (needs a read token)
//   s3://<bucket>/<prefix>/<yyyy>/<mm>/<dd>/manifest.json      what was written, sizes, sha256, counts; written last
// and, with the newest day only (a snapshot is taken now, not as of that day):
//   .../metrics.db.gz (always), .../tickets.db.gz (only with BACKUP_TICKETS=on: see the privacy note)
//
// Privacy (CLAUDE.md, public/privacy.html): the events pass the same field allowlist as /ops/events (src/ops.js redact:
// no video IDs, ticket numbers, shards or User-Agents, IDs inside messages masked), then scrub() replaces anything shaped
// like an IP address or a token. 24 h of prod events (14,252, 2026-11-06) held none before either step. tickets.db holds
// search results (video IDs, titles) the privacy page promises to keep "for up to a day", so it is off by default.
// metrics.db holds counts only.
//
// Upload: plain HTTPS PUTs signed with AWS Signature V4 (no SDK; the repo keeps two dependencies). The IAM user can only
// PutObject under the prefix, so the job keeps its own record of what landed (STATE file), which the exporter reports
// (eiok_backup_last_success_timestamp_seconds) for the Grafana rule eiok-backup-missing. A failure also posts to Discord.
import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { redact } from '../src/ops.js';
import { dayOf } from '../src/metrics.js';
import { makeAlert } from '../src/alert.js';

// ---- days -------------------------------------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// [start, end) of a reporting day in ms: the first ms whose dayOf is that day, and the next day's (DST days are 23 or 25 h).
export function dayWindow(day, tz = 'America/Chicago') {
  const first = (d) => {
    let lo = Date.parse(`${d}T00:00:00Z`) - 15 * 3600_000, hi = lo + 30 * 3600_000; // dayOf(lo) < d <= dayOf(hi)
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (dayOf(mid, tz) >= d) hi = mid; else lo = mid; }
    return hi;
  };
  return [first(day), first(addDays(day, 1))];
}
// The days to back up now: after the last one done, up to yesterday, at most `max` (the oldest that journald still has
// come first; older gaps are given up and logged).
export function daysToBackUp(lastDay, now, { tz = 'America/Chicago', max = 3 } = {}) {
  const yesterday = addDays(dayOf(now, tz), -1);
  let from = lastDay && DAY_RE.test(lastDay) ? addDays(lastDay, 1) : yesterday;
  const earliest = addDays(yesterday, -(max - 1));
  const skipped = from < earliest ? from : null;
  if (from < earliest) from = earliest;
  const days = [];
  for (let d = from; d <= yesterday; d = addDays(d, 1)) days.push(d);
  return { days, skipped };
}

// ---- events -----------------------------------------------------------------------------------------------------

const IPV4 = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/g;
// Eight groups, or fewer around a "::" (with at least two groups or a group on each side); not times such as 12:34:56.
const IPV6 = /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?=[0-9a-f:]*::)(?:[0-9a-f]{1,4}:){0,6}:?(?::[0-9a-f]{1,4}){1,7}(?=[^\w:]|$)|(?:[0-9a-f]{1,4}:){2,7}:)(?![\w:])/gi;
const SECRET = /\b(token|key|secret|sig|signature|password|passwd|auth|authorization|cookie|session)=[^\s&"']+|\bBearer\s+\S+|[A-Za-z0-9_\-+/]{32,}={0,2}/gi;
// Strings only; counts what it replaced so the manifest can say so (never what).
export function scrub(o, counts = { ip: 0, secret: 0 }) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'string' || k === 'event' || k === 'at') { out[k] = v; continue; }
    out[k] = v.replace(IPV4, () => { counts.ip++; return '…ip'; }).replace(IPV6, () => { counts.ip++; return '…ip'; })
      .replace(SECRET, (m, name) => { counts.secret++; return name ? `${name}=…` : '…'; });
  }
  return out;
}
// Journal lines (the service's stdout) → redacted, scrubbed JSONL. Only lines that are JSON objects with an `event`.
export async function eventsJsonl(lines, counts = { lines: 0, events: 0, ip: 0, secret: 0 }) {
  const out = [];
  for await (const line of lines) {
    counts.lines++;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.event !== 'string') continue;
    counts.events++;
    out.push(JSON.stringify(scrub(redact(o), counts)));
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
export function journalLines({ unit, start, end, spawnImpl = spawn }) {
  const p = spawnImpl('journalctl', ['-u', unit, '--since', `@${Math.floor(start / 1000)}`, '--until', `@${Math.floor((end - 1) / 1000)}`, '-o', 'cat', '--no-pager', '-q'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (c) => { err += c; });
  const done = new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`journalctl exit ${code}: ${err.trim().slice(0, 200)}`))));
  });
  return { lines: createInterface({ input: p.stdout, crlfDelay: Infinity }), done };
}

// ---- Grafana-only series ----------------------------------------------------------------------------------------

// What Grafana Cloud keeps for 14 days only (the poller's numbers and the counters are in metrics.db): the Alloy host
// series of both hosts, the public probes and the exporter's live gauges. Each is summarized per hour (avg and max).
export const PROM_SERIES = {
  cpu_busy: '1 - avg by (host) (rate(node_cpu_seconds_total{mode="idle"}[5m]))',
  load1: 'max by (host) (node_load1)',
  mem_available_ratio: 'min by (host) (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
  disk_used_ratio: 'max by (host, mountpoint) (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"})',
  net_rx_bytes_per_s: 'sum by (host) (rate(node_network_receive_bytes_total{device!="lo"}[5m]))',
  net_tx_bytes_per_s: 'sum by (host) (rate(node_network_transmit_bytes_total{device!="lo"}[5m]))',
  units_failed: 'sum by (host) (node_systemd_unit_state{state="failed"})',
  probe_success: 'min by (job) (probe_success)',
  probe_seconds: 'max by (job) (probe_duration_seconds)',
  search_up: 'min(eiok_search_up)',
  relay_workers: 'max(eiok_relay_workers_online)',
  service_memory_bytes: 'max by (kind) (eiok_service_memory_bytes)',
  home_today: 'max by (key) (eiok_home_today)',
};
// Hourly points at the end of each hour of the day: avg_over_time / max_over_time of the expression over that hour.
export async function promSummary({ url, user, token, start, end, fetchImpl = fetch, series = PROM_SERIES }) {
  const auth = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
  const out = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), step: '1h', series: {}, errors: {} };
  for (const [name, expr] of Object.entries(series)) {
    out.series[name] = {};
    for (const agg of ['avg', 'max']) {
      const q = new URLSearchParams({ query: `${agg}_over_time((${expr})[1h:1m])`, start: String((start + 3600_000) / 1000), end: String(end / 1000), step: '3600' });
      try {
        const r = await fetchImpl(`${url.replace(/\/$/, '')}/api/v1/query_range?${q}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(30_000) });
        const body = await r.json().catch(() => null);
        if (!r.ok || body?.status !== 'success') throw new Error(`HTTP ${r.status} ${body?.error ?? ''}`.trim());
        out.series[name][agg] = body.data.result.map((x) => ({ labels: x.metric, values: x.values.map(([t, v]) => [t, Number(v)]) }));
      } catch (err) { out.errors[`${name}:${agg}`] = String(err?.message ?? err).slice(0, 200); }
    }
  }
  return out;
}

// ---- S3 ---------------------------------------------------------------------------------------------------------

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
// RFC 3986 per path segment, as SigV4 wants it for S3 (no double encoding).
const encodePath = (p) => p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
// AWS Signature Version 4 for one request. headers: lower-case names → values (host included). Returns the
// Authorization header value.
export function sigV4({ method, path, query = '', headers, payloadHash, region, service = 's3', accessKeyId, secretAccessKey, amzDate }) {
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonical = [method, path, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', key).update(toSign).digest('hex')}`;
}
export function makeS3({ bucket, region, accessKeyId, secretAccessKey, sessionToken = '', fetchImpl = fetch, now = () => Date.now() }) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  return async function put(key, body, contentType = 'application/octet-stream') {
    const amzDate = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadHash = sha256(body);
    const headers = { host, 'content-type': contentType, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, 'x-amz-server-side-encryption': 'AES256' };
    if (sessionToken) headers['x-amz-security-token'] = sessionToken;
    const path = `/${encodePath(key)}`;
    const authorization = sigV4({ method: 'PUT', path, headers, payloadHash, region, accessKeyId, secretAccessKey, amzDate });
    const { host: _h, ...send } = headers;
    const r = await fetchImpl(`https://${host}${path}`, { method: 'PUT', headers: { ...send, authorization }, body, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) {
      // S3's error XML names the code (AccessDenied, SignatureDoesNotMatch …); never the credentials.
      const text = await r.text().catch(() => '');
      throw new Error(`S3 PUT ${key}: HTTP ${r.status} ${text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? ''}`.trim());
    }
    return { key, bytes: body.length, sha256: payloadHash };
  };
}

// ---- the job ----------------------------------------------------------------------------------------------------

// A consistent copy of a live SQLite database (WAL): VACUUM INTO from a read-only connection, then gzip.
export function snapshotDb(path, dir) {
  const dest = join(dir, `snap-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); } finally { db.close(); }
  try { return gzipSync(readFileSync(dest), { level: 9 }); } finally { rmSync(dest, { force: true }); }
}

export function readState(path) {
  try { const s = JSON.parse(readFileSync(path, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}
function writeState(path, s) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(s)}\n`, { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
}

export async function backupDay(day, { cfg, put, events, prom, snapshot, newest, log }) {
  const [start, end] = dayWindow(day, cfg.tz);
  const prefix = `${cfg.prefix}/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}`;
  const files = [];
  const manifest = { day, tz: cfg.tz, start: new Date(start).toISOString(), end: new Date(end).toISOString(), at: null, files, notes: [] };
  const counts = { lines: 0, events: 0, ip: 0, secret: 0 };
  const jsonl = await events({ start, end, counts });
  files.push({ name: 'events.jsonl.gz', ...(await put(`${prefix}/events.jsonl.gz`, gzipSync(jsonl, { level: 9 }), 'application/gzip')) });
  manifest.events = counts;
  if (prom) {
    const summary = await prom({ start, end });
    const errors = Object.keys(summary.errors).length;
    files.push({ name: 'grafana.json.gz', ...(await put(`${prefix}/grafana.json.gz`, gzipSync(JSON.stringify(summary)), 'application/gzip')) });
    if (errors) manifest.notes.push(`grafana: ${errors} queries failed`);
  } else manifest.notes.push('grafana: no BACKUP_PROM_TOKEN, skipped');
  if (newest) {
    for (const [name, path, on] of [['metrics.db.gz', cfg.metricsDb, true], ['tickets.db.gz', cfg.ticketsDb, cfg.tickets]]) {
      if (!on) { manifest.notes.push(`${name}: off`); continue; }
      if (!path || !existsSync(path)) { manifest.notes.push(`${name}: missing`); continue; }
      manifest.snapshotAt = new Date().toISOString();
      files.push({ name, ...(await put(`${prefix}/${name}`, snapshot(path), 'application/gzip')) });
    }
  }
  manifest.at = new Date().toISOString();
  files.push({ name: 'manifest.json', ...(await put(`${prefix}/manifest.json`, Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`), 'application/json')) });
  log({ event: 'backup_day', day, files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0), events: counts.events, scrubbed: counts.ip + counts.secret, notes: manifest.notes.length });
  return manifest;
}

export function configFrom(e = process.env) {
  return {
    bucket: e.BACKUP_S3_BUCKET ?? '', region: e.BACKUP_S3_REGION || 'us-east-1', prefix: (e.BACKUP_S3_PREFIX || 'eiok').replace(/^\/+|\/+$/g, ''),
    accessKeyId: e.BACKUP_AWS_ACCESS_KEY_ID ?? '', secretAccessKey: e.BACKUP_AWS_SECRET_ACCESS_KEY ?? '',
    promUrl: e.BACKUP_PROM_URL ?? '', promUser: e.BACKUP_PROM_USER ?? '', promToken: e.BACKUP_PROM_TOKEN ?? '',
    tickets: e.BACKUP_TICKETS === 'on',
    maxDays: Math.max(1, Math.min(7, Number.parseInt(e.BACKUP_MAX_DAYS ?? '3', 10) || 3)),
    metricsDb: e.METRICS_DB || '/var/lib/japharsworld-yt/metrics.db',
    ticketsDb: e.DB_PATH || '/var/lib/japharsworld-yt/tickets.db',
    state: e.BACKUP_STATE || '/var/lib/japharsworld-yt/backup-state.json',
    unit: e.BACKUP_UNIT || 'japharsworld-yt',
    tz: e.METRICS_TZ || 'America/Chicago',
    webhook: e.DISCORD_WEBHOOK || e.ALERT_WEBHOOK || '',
  };
}

// One run: every day due (or `onlyDay`, for a manual re-run), state written after each day that landed.
export async function run({ cfg, now = Date.now(), onlyDay = null, put, events, prom, snapshot = snapshotDb, log = (o) => console.log(JSON.stringify(o)), alert = () => {} }) {
  const state = readState(cfg.state);
  let days;
  if (onlyDay) days = [onlyDay];
  else {
    const due = daysToBackUp(state.lastDay, now, { tz: cfg.tz, max: cfg.maxDays });
    if (due.skipped) log({ event: 'backup_gap', from: due.skipped, to: addDays(due.days[0], -1) });
    days = due.days;
  }
  if (!days.length) { log({ event: 'backup_nothing_due', lastDay: state.lastDay ?? null }); return { ok: true, days: [] }; }
  const tmp = mkdtempSync(join(cfg.tmpDir ?? tmpdir(), 'eiok-backup-'));
  const done = [];
  try {
    for (const day of days) {
      try {
        await backupDay(day, { cfg, put, events, prom, newest: day === days[days.length - 1], snapshot: (p) => snapshot(p, tmp), log });
      } catch (err) {
        const message = String(err?.message ?? err).slice(0, 300);
        log({ event: 'backup_failed', day, message });
        alert('backup_failed', `Backup to S3 failed for ${day}: ${message}. It retries at the next run (01:30 Chicago); \`journalctl -u japharsworld-yt-backup\` on the Linode.`);
        return { ok: false, days: done, failed: day };
      }
      done.push(day);
      if (!onlyDay || !state.lastDay || day > state.lastDay) {
        Object.assign(state, { lastDay: onlyDay && state.lastDay > day ? state.lastDay : day, lastSuccessAt: new Date().toISOString(), lastSuccessMs: Date.now() });
        writeState(cfg.state, state);
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return { ok: true, days: done };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = configFrom();
  const dayArg = process.argv.indexOf('--day');
  const onlyDay = dayArg > 0 ? process.argv[dayArg + 1] : null;
  if (onlyDay && !DAY_RE.test(onlyDay)) { console.error('usage: backup.js [--day YYYY-MM-DD]'); process.exit(2); }
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    console.log(JSON.stringify({ event: 'backup_off', reason: 'BACKUP_S3_BUCKET and the BACKUP_AWS_* key are not all set' }));
    process.exit(0);
  }
  const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
  const put = makeS3(cfg);
  const events = async ({ start, end, counts }) => {
    const j = journalLines({ unit: cfg.unit, start, end });
    const [text] = await Promise.all([eventsJsonl(j.lines, counts), j.done]);
    return text;
  };
  const prom = cfg.promUrl && cfg.promUser && cfg.promToken
    ? ({ start, end }) => promSummary({ url: cfg.promUrl, user: cfg.promUser, token: cfg.promToken, start, end }) : null;
  const alert = makeAlert({ webhook: cfg.webhook, username: 'Everything is OK backup', log });
  const r = await run({ cfg, onlyDay, put, events, prom, log, alert });
  // Give the Discord post a moment; it is fire-and-forget in makeAlert.
  if (!r.ok) await new Promise((res) => setTimeout(res, 3000));
  process.exitCode = r.ok ? 0 : 1;
}
