// Reading the metrics back: summaries for the reports, GET /stats (HTML with inline SVG charts), /stats.json and
// /stats/export.csv. All three need STATS_TOKEN (Authorization: Bearer … or ?token=…); without it they answer 404.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual, createHash } from 'node:crypto';
import { openMetricsDb, dayOf, MS_BUCKETS, getMeta } from './metrics.js';

const DAY = 86400_000;

// "2026-10-19" ± n days (calendar arithmetic, no time zone involved).
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

// Upper bound of the bucket that holds the p-th percentile. buckets: { "50": n, "100": n, …, "inf": n }
export function percentile(buckets, p) {
  const order = [...MS_BUCKETS.map(String), 'inf'];
  const total = order.reduce((s, b) => s + (buckets[b] ?? 0), 0);
  if (!total) return null;
  let seen = 0;
  for (const b of order) {
    seen += buckets[b] ?? 0;
    if (seen >= p * total) return b === 'inf' ? Infinity : Number(b);
  }
  return Infinity;
}

// metric → key → summed value over [from, to] (days inclusive).
export function counts(db, from, to) {
  const out = {};
  for (const r of db.prepare('SELECT metric, key, SUM(value) v FROM daily WHERE day BETWEEN ? AND ? GROUP BY metric, key').all(from, to)) {
    (out[r.metric] ??= {})[r.key] = r.v;
  }
  return out;
}
const total = (m) => Object.values(m ?? {}).reduce((s, v) => s + v, 0);

// source → metric → { min, max, first, last } over [from, to], from the daily poll table.
export function polls(db, from, to) {
  const out = {};
  const rows = db.prepare('SELECT day, source, metric, min, max, last FROM poll_daily WHERE day BETWEEN ? AND ? ORDER BY day').all(from, to);
  for (const r of rows) {
    const m = ((out[r.source] ??= {})[r.metric] ??= { min: r.min, max: r.max, first: r.last, last: r.last });
    m.min = Math.min(m.min, r.min); m.max = Math.max(m.max, r.max); m.last = r.last;
  }
  return out;
}
const lastBefore = (db, source, metric, day) =>
  db.prepare('SELECT last FROM poll_daily WHERE source = ? AND metric = ? AND day < ? ORDER BY day DESC LIMIT 1').get(source, metric, day)?.last ?? null;

export function gauge(db, metric, key = '') {
  return db.prepare('SELECT value, day, at FROM gauges WHERE metric = ? AND key = ? ORDER BY day DESC, at DESC LIMIT 1').get(metric, key) ?? null;
}

// When this month's credits run out at the month's average daily spend so far.
export function forecast({ remaining, monthSpent, today, now = Date.now(), tz = 'America/Chicago' }) {
  if (remaining == null) return null;
  const monthStart = today.slice(0, 8) + '01';
  const nextMonth = addDays(monthStart, 32).slice(0, 8) + '01';
  const monthEnd = addDays(nextMonth, -1);
  // Days elapsed, counting today as the part of it that has passed.
  const hourNow = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  const elapsed = daysBetween(monthStart, today) + Math.max(hourNow, 1) / 24;
  const perDay = monthSpent / elapsed;
  if (perDay <= 0) return { perDay: 0, runsOut: null, lastsMonth: true, monthEnd };
  const runsOut = addDays(today, Math.floor(remaining / perDay));
  return { perDay: Math.round(perDay), runsOut, lastsMonth: runsOut > monthEnd, monthEnd };
}

// The summary the reports and /stats share, for days [from, to].
export function summary(db, { from, to, now = Date.now(), tz = 'America/Chicago' }) {
  const c = counts(db, from, to);
  const p = polls(db, from, to);
  const today = dayOf(now, tz);
  const worlds = {};
  for (const [source, m] of Object.entries(p)) {
    if (!source.startsWith('world:')) continue;
    const prevVisits = lastBefore(db, source, 'visits', from);
    const prevFav = lastBefore(db, source, 'favorites', from);
    worlds[source.slice(6)] = {
      visits: m.visits?.last ?? null, visitsDelta: m.visits ? m.visits.last - (prevVisits ?? m.visits.first) : null,
      favorites: m.favorites?.last ?? null, favoritesDelta: m.favorites ? m.favorites.last - (prevFav ?? m.favorites.first) : null,
      peakOccupants: m.occupants?.max ?? null, peakPublic: m.publicOccupants?.max ?? null, peakPrivate: m.privateOccupants?.max ?? null,
      popularity: m.popularity?.last ?? null, heat: m.heat?.last ?? null, version: m.version?.last ?? null,
    };
  }
  const searches = total(c.search);
  const fails = total(c.search_fail);
  const attempts = searches + (c.search_fail?.['429'] ?? 0);
  const monthStart = today.slice(0, 8) + '01';
  const month = counts(db, monthStart, today).credits ?? {};
  const left = gauge(db, 'credits_remaining');
  const tun = p.tunelio?.credits;
  const remaining = left?.value ?? tun?.last ?? null;
  const shards = db.prepare(`SELECT hour, COUNT(*) n FROM hourly WHERE metric = 'shard' AND hour BETWEEN ? AND ? GROUP BY hour`).all(`${from}T00`, `${to}T23`);
  return {
    from, to,
    vrchat: worlds,
    group: p.group ? { members: p.group.members?.last ?? null, online: p.group.online?.max ?? null } : null,
    searches, joins: total(c.join), more: total(c.more), plays: total(c.play),
    searchLang: c.search_lang ?? {}, joinLang: c.join_lang ?? {}, captionLang: c.cc_list_lang ?? {},
    languages: [...new Set([...Object.keys(c.search_lang ?? {}), ...Object.keys(c.join_lang ?? {}), ...Object.keys(c.cc_list_lang ?? {})])].filter((k) => k !== 'native' && k !== 'other').sort(),
    sources: c.search_source ?? {}, failures: c.search_fail ?? {}, failureRate: attempts ? fails / attempts : 0,
    searchMs: { p50: percentile(c.search_ms ?? {}, 0.5), p95: percentile(c.search_ms ?? {}, 0.95) },
    playRoutes: c.play_route ?? {}, fallbacks: c.play_fallback ?? {}, lengths: c.play_length ?? {},
    createMs: { p50: percentile(c.tunelio_create_ms ?? {}, 0.5), p95: percentile(c.tunelio_create_ms ?? {}, 0.95) },
    captions: { lists: total(c.cc_list), tracks: total(c.cc_track), trackLang: c.cc_track_lang ?? {}, unavailable: c.cc_unavailable ?? {} },
    credits: {
      playback: c.credits?.playback ?? 0, captions: c.credits?.captions ?? 0, remaining, plan: getMeta(db, 'tunelio_plan'),
      forecast: forecast({ remaining, monthSpent: total(month), today, now, tz }),
    },
    activeInstancesPeakHour: shards.reduce((m, r) => Math.max(m, r.n), 0),
    github: Object.fromEntries(Object.entries(p).filter(([s]) => s.startsWith('github:')).map(([s, m]) => [s.slice(7),
      { stars: m.stars?.last ?? null, downloads: m.release_downloads?.last ?? null }])),
  };
}

// Channels monitor (its own database, read only): per-slot uptime, restarts, flash checks since `sinceMs`; slots down now.
export function channels(monitorDb, sinceMs) {
  if (!monitorDb || !existsSync(monitorDb)) return null;
  let db;
  try {
    db = new DatabaseSync(monitorDb, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000;');
    const since = sinceMs / 1000;
    const slots = db.prepare(`SELECT key, kind, title, auto_hidden, auto_reason, baked_hidden FROM slots
      WHERE idx IS NOT NULL AND kind IN ('live', 'video') ORDER BY idx`).all();
    const out = [];
    for (const s of slots) {
      const ck = db.prepare(`SELECT status, video_id, started_at FROM checks WHERE slot_key = ? AND ts > ? AND status <> 'error'
        AND (source IS NULL OR source NOT LIKE 'seed%')`).all(s.key, since);
      const up = ck.filter((x) => (s.kind === 'live' ? x.status === 'live' : x.status === 'video' || x.status === 'live')).length;
      const starts = new Set(ck.filter((x) => x.started_at).map((x) => `${x.video_id}|${Math.round(x.started_at / 3600)}`));
      const events = db.prepare(`SELECT COUNT(*) n FROM events WHERE slot_key = ? AND kind IN ('replaced', 'down') AND ts > ?`).get(s.key, since).n;
      const fl = db.prepare(`SELECT COUNT(*) n, SUM(verdict = 'fail') f FROM flash WHERE slot_key = ? AND ts > ?`).get(s.key, since);
      out.push({ slot: s.key, kind: s.kind, spare: Boolean(s.baked_hidden), checks: ck.length, uptime: ck.length ? up / ck.length : null,
        restarts: Math.max(0, starts.size - 1) + events, flashRuns: fl.n, flashFails: fl.f ?? 0,
        down: Boolean(s.auto_hidden), reason: s.auto_hidden ? s.auto_reason : null });
    }
    return out;
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 200) };
  } finally { db?.close(); }
}

// Days with any daily row, newest last, and per-day series for the charts.
function series(db, from, to, metric, key = null) {
  const rows = key === null
    ? db.prepare('SELECT day, SUM(value) v FROM daily WHERE metric = ? AND day BETWEEN ? AND ? GROUP BY day').all(metric, from, to)
    : db.prepare('SELECT day, value v FROM daily WHERE metric = ? AND key = ? AND day BETWEEN ? AND ?').all(metric, key, from, to);
  return fill(from, to, rows);
}
function pollSeries(db, from, to, source, metric, col = 'last') {
  const rows = db.prepare(`SELECT day, ${col === 'max' ? 'max' : 'last'} v FROM poll_daily WHERE source = ? AND metric = ? AND day BETWEEN ? AND ?`).all(source, metric, from, to);
  return fill(from, to, rows, null);
}
function fill(from, to, rows, empty = 0) {
  const by = new Map(rows.map((r) => [r.day, r.v]));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push([d, by.has(d) ? by.get(d) : empty]);
  return out;
}

export function statsData(db, { days = 30, now = Date.now(), tz = 'America/Chicago', monitorDb } = {}) {
  const to = dayOf(now, tz);
  const from = addDays(to, -(days - 1));
  const hours = db.prepare(`SELECT hour, COUNT(*) n FROM hourly WHERE metric = 'shard' AND hour >= ? GROUP BY hour ORDER BY hour`).all(`${addDays(to, -2)}T00`);
  return {
    generated: new Date(now).toISOString(), tz,
    today: summary(db, { from: to, to, now, tz }),
    last7: summary(db, { from: addDays(to, -6), to, now, tz }),
    lastN: summary(db, { from, to, now, tz }),
    series: {
      searches: series(db, from, to, 'search'), plays: series(db, from, to, 'play'), joins: series(db, from, to, 'join'),
      credits: series(db, from, to, 'credits'), captions: series(db, from, to, 'cc_list'),
      visits: pollSeries(db, from, to, 'world:prod', 'visits'), favorites: pollSeries(db, from, to, 'world:prod', 'favorites'),
      peakOccupants: pollSeries(db, from, to, 'world:prod', 'occupants', 'max'),
    },
    activeInstancesByHour: hours.map((h) => [h.hour, h.n]),
    channels: channels(monitorDb, now - DAY),
  };
}

// --- CSV export of the daily tables ---
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function exportCsv(db) {
  const lines = ['table,period,source,metric,key,value,min,max,last'];
  for (const r of db.prepare('SELECT day, metric, key, value FROM daily ORDER BY day, metric, key').all()) lines.push(['daily', r.day, '', r.metric, r.key, r.value, '', '', ''].map(csvCell).join(','));
  for (const r of db.prepare('SELECT day, metric, key, value FROM gauges ORDER BY day, metric, key').all()) lines.push(['gauge', r.day, '', r.metric, r.key, r.value, '', '', ''].map(csvCell).join(','));
  for (const r of db.prepare('SELECT day, source, metric, min, max, last FROM poll_daily ORDER BY day, source, metric').all()) lines.push(['poll_daily', r.day, r.source, r.metric, '', '', r.min, r.max, r.last].map(csvCell).join(','));
  for (const r of db.prepare(`SELECT hour, COUNT(*) n FROM hourly WHERE metric = 'shard' GROUP BY hour ORDER BY hour`).all()) lines.push(['hourly', r.hour, '', 'active_instances', '', r.n, '', '', ''].map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

// --- HTML ---
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '–' : Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '∞');

// One series of daily bars (null = no data). Native <title> tooltips per bar.
export function barChart(title, points, { unit = '' } = {}) {
  const W = 420, H = 150, pad = { l: 40, r: 6, t: 8, b: 20 };
  const vals = points.map((p) => p[1]).filter((v) => v != null);
  const max = Math.max(1, ...vals);
  const n = points.length || 1;
  const step = (W - pad.l - pad.r) / n;
  const bw = Math.max(2, step - 2);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const bars = points.map(([d, v], i) => {
    if (v == null) return '';
    const x = pad.l + i * step + 1, top = y(v), h = Math.max(0, H - pad.b - top);
    const r = Math.min(4, bw / 2, h);
    // Rounded at the data end, square at the baseline.
    const path = h <= 0 ? '' : `M${x},${H - pad.b}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${H - pad.b}Z`;
    return `<g><rect x="${x}" y="${pad.t}" width="${step}" height="${H - pad.t - pad.b}" fill="transparent"/><path d="${path}" class="bar"/><title>${esc(d)}: ${fmt(v)}${unit}</title></g>`;
  }).join('');
  const ticks = [0, max / 2, max].map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${fmt(v)}</text>`).join('');
  const labels = points.length ? `<text x="${pad.l}" y="${H - 6}" class="tick">${esc(points[0][0].slice(5))}</text><text x="${W - pad.r}" y="${H - 6}" class="tick" text-anchor="end">${esc(points.at(-1)[0].slice(5))}</text>` : '';
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${ticks}${bars}${labels}</svg></figure>`;
}

const kv = (o) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${fmt(v)}`).join(' · ') || '–';

export function renderHtml(d) {
  const t = d.today, w = d.last7, prod = w.vrchat.prod ?? {};
  const tile = (label, value, sub = '') => `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const f = t.credits.forecast;
  const ch = Array.isArray(d.channels) ? d.channels : [];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Everything is OK stats</title><style>
:root{--bg:#1a1b26;--panel:#24283b;--line:#414868;--ink:#c0caf5;--muted:#a9b1d6;--dim:#787c99;--accent:#7aa2f7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif;padding:16px}
main{max-width:980px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;color:var(--muted)}
.meta{color:var(--dim);font-size:13px}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(160px,100%),1fr));gap:10px;margin-top:14px}
.tile{background:var(--panel);border-radius:8px;padding:10px 12px}.label{color:var(--dim);font-size:12px}.value{font-size:22px;font-variant-numeric:tabular-nums}.sub{color:var(--muted);font-size:12px}
.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:12px}figure{margin:0;background:var(--panel);border-radius:8px;padding:10px}
figcaption{font-size:13px;color:var(--muted);margin-bottom:4px}svg{width:100%;height:auto;display:block}.bar{fill:var(--accent)}g:hover .bar{opacity:.75}
.grid{stroke:var(--line);stroke-width:1}.tick{fill:var(--dim);font-size:12px}table{border-collapse:collapse;width:100%;font-size:13px}
td,th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line)}th{color:var(--dim);font-weight:normal}p{margin:6px 0}a{color:var(--accent)}
.down{color:#f7768e}
</style></head><body><main>
<h1>Everything is OK: stats</h1><div class="meta">Generated ${esc(d.generated)} · days in ${esc(d.tz)} · counts only, no per-person data · <a href="stats.json">JSON</a> · <a href="stats/export.csv">CSV</a></div>
<div class="tiles">
${tile('Visits (production)', fmt(prod.visits), `${prod.visitsDelta == null ? '' : '+' + fmt(prod.visitsDelta) + ' in 7 days'}`)}
${tile('Favorites', fmt(prod.favorites), `${prod.favoritesDelta == null ? '' : (prod.favoritesDelta >= 0 ? '+' : '') + fmt(prod.favoritesDelta) + ' in 7 days'}`)}
${tile('Peak occupants (7 d)', fmt(prod.peakOccupants), `public ${fmt(prod.peakPublic)} · private ${fmt(prod.peakPrivate)}`)}
${tile('Searches today', fmt(t.searches), `${fmt(w.searches)} in 7 days`)}
${tile('Plays today', fmt(t.plays), `${fmt(w.plays)} in 7 days`)}
${tile('Joins today', fmt(t.joins), 'visitors allowing untrusted URLs')}
${tile('Tunelio credits', fmt(t.credits.remaining), f ? (f.lastsMonth ? `last the month at ${fmt(f.perDay)}/day` : `run out ${esc(f.runsOut)} at ${fmt(f.perDay)}/day`) : '')}
${tile('Busiest hour (today)', fmt(t.activeInstancesPeakHour), 'active instances (lower bound)')}
</div>
<h2>Last ${d.series.searches.length} days</h2><div class="charts">
${barChart('Searches per day', d.series.searches)}
${barChart('Plays per day', d.series.plays)}
${barChart('Joins per day (untrusted URLs allowed)', d.series.joins)}
${barChart('Show captions per day', d.series.captions)}
${barChart('Tunelio credits spent per day', d.series.credits)}
${barChart('Peak occupants per day (production)', d.series.peakOccupants)}
${barChart('Visits (production, end of day)', d.series.visits)}
${barChart('Active instances per hour (last 3 days)', d.activeInstancesByHour)}
</div>
<h2>Last 7 days</h2>
<p>Languages: ${esc(w.languages.join(', ') || '–')}</p>
<p>Search sources: ${kv(w.sources)} · failures: ${kv(w.failures)} (${(w.failureRate * 100).toFixed(1)} %) · p50 ${fmt(w.searchMs.p50)} ms, p95 ${fmt(w.searchMs.p95)} ms</p>
<p>Play routes: ${kv(w.playRoutes)} · fallbacks: ${kv(w.fallbacks)} · lengths: ${kv(w.lengths)} · Tunelio /create p50 ${fmt(w.createMs.p50)} ms, p95 ${fmt(w.createMs.p95)} ms</p>
<p>Captions: ${fmt(w.captions.lists)} shown, ${fmt(w.captions.tracks)} tracks picked (${kv(w.captions.trackLang)}) · not available: ${kv(w.captions.unavailable)}</p>
<p>Credits spent: playback ${fmt(w.credits.playback)}, captions ${fmt(w.credits.captions)}</p>
<p>Search languages: ${kv(w.searchLang)} · join languages: ${kv(w.joinLang)}</p>
${w.group ? `<p>Group: ${fmt(w.group.members)} members, up to ${fmt(w.group.online)} online</p>` : ''}
${Object.keys(w.github).length ? `<p>GitHub: ${Object.entries(w.github).map(([r, g]) => `${esc(r)} ★${fmt(g.stars)} ⬇${fmt(g.downloads)}`).join(' · ')}</p>` : ''}
<h2>Channels (last 24 h)</h2>
${ch.length ? `<table><tr><th>Slot</th><th>Uptime</th><th>Restarts</th><th>Flash checks</th><th>Now</th></tr>${ch.map((s) => `<tr><td>${esc(s.slot)}${s.spare ? ' (spare)' : ''}</td><td>${s.uptime == null ? '–' : (s.uptime * 100).toFixed(0) + ' %'}</td><td>${s.restarts}</td><td>${s.flashRuns}${s.flashFails ? `, <span class="down">${s.flashFails} failed</span>` : ''}</td><td>${s.down ? `<span class="down">down (${esc(s.reason ?? '')})</span>` : 'up'}</td></tr>`).join('')}</table>` : '<p>No monitor data.</p>'}
</main></body></html>`;
}

function tokenOk(req, url, token) {
  if (!token) return false;
  const auth = String(req.headers.authorization ?? '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('token') ?? '');
  const h = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(given), h(token));
}

export function statsRoute(req, res, url, { token, metricsPath, monitorDb, tz, metrics }) {
  const send = (status, type, body) => {
    const buf = Buffer.from(body);
    res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  if (!token || !metricsPath) return send(404, 'application/json; charset=utf-8', JSON.stringify({ v: 1, error: 'not_found', message: 'Unknown path.' }));
  if (!tokenOk(req, url, token)) return send(401, 'application/json; charset=utf-8', JSON.stringify({ v: 1, error: 'unauthorized', message: 'Bad stats token.' }));
  metrics?.flush?.(); // show the last minute too
  let db;
  try {
    db = openMetricsDb(metricsPath);
    const p = url.pathname.replace(/\/$/, '');
    if (p === '/stats/export.csv') {
      res.setHeader('content-disposition', 'attachment; filename="everything-is-ok-metrics.csv"');
      return send(200, 'text/csv; charset=utf-8', exportCsv(db));
    }
    const days = Math.min(365, Math.max(7, Number.parseInt(url.searchParams.get('days') ?? '30', 10) || 30));
    const data = statsData(db, { days, tz, monitorDb });
    if (p === '/stats.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(data, (k, v) => (v === Infinity ? null : v)));
    if (p === '/stats') {
      // Relative links (stats.json, stats/export.csv) keep the token when it came as ?token=.
      let html = renderHtml(data);
      const q = url.searchParams.get('token');
      if (q) html = html.replace(/href="(stats\.json|stats\/export\.csv)"/g, (m, href) => `href="${href}?token=${encodeURIComponent(q)}"`);
      return send(200, 'text/html; charset=utf-8', html);
    }
    return send(404, 'application/json; charset=utf-8', JSON.stringify({ v: 1, error: 'not_found', message: 'Unknown path.' }));
  } finally { db?.close(); }
}
