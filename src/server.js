// Routes (all under the baked shard prefix):
//   GET /v1/<shard>/s?l=<lang>&q=<prompt> → <query>   search; JSON with ticket numbers
//   GET /v1/<shard>/<n>                                ticket: 302 to the video (Tunelio HD link, or YouTube), JPEG (thumbnail sheet),
//                                                      JSON (next page)
//   GET /v1/<shard>/cc/<lang>                          captions for the video last played in this shard (lang: VRChat code or
//                                                      "native"), with the list of the video's caption tracks (names in <lang>)
//   GET /v1/<shard>/q[/<720|1080>]                    the room's playback quality for search videos (read, or pick on the tablet)
//   GET /hls/<token>.m3u8, /hls/<token>/<q>.m3u8          adaptive playlists a played ticket leads to (src/adaptive.js)
//   GET /v1/<shard>/cc/<i>[?l=<lang>]                  track i of that list (the tablet's caption picker; Tunelio captions only)
//   GET /healthz
//   GET /relay/next, POST /relay/done                  search relay workers only (bearer RELAY_TOKEN; see relay.js)
//   GET /stats, /stats.json, /stats/export.csv         usage metrics (bearer or ?token= STATS_TOKEN; see stats.js)
//   GET /ops/state, /ops/events                        read-only operator view, redacted (STATS_TOKEN; see ops.js)
//   GET /ops/slots, POST /ops/slots/refill             player test slots: what they hold, refill them (src/slots.js)
//   GET /hls-test/<hex>.m3u8                           temporary adaptive-HLS test playlist (yt-dlp gets a "not a video" page)
//   GET /, /privacy, /logo.png                         home page and privacy policy (public/)
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { config as defaults } from './config.js';
import { Store } from './store.js';
import { parseQuery, youtubeIdFrom, normalizeLang, LANGS } from './query.js';
import { youtube as defaultYoutube } from './youtube.js';
import { cachedSheet } from './sheet.js';
import { Captions, errorLine } from './captions.js';
import { Tunelio } from './tunelio.js';
import { Playback, linkProbe, clientKind } from './playback.js';
import { TunelioCaptions } from './transcripts.js';
import { makeAlert } from './alert.js';
import { Relay, RelayError } from './relay.js';
import { DataApi } from './dataapi.js';
import { makeSearch } from './search.js';
import { Metrics, noMetrics, lengthBucket, secondsBucket, sizeBucket, recordPoll, getMeta, setMeta, dayOf } from './metrics.js';
import { Adaptive, Pacer } from './adaptive.js';
import { TunelioProbe } from './probe.js';
import { EventRing, opsRoute, gitHead } from './ops.js';
import { TestSlots } from './slots.js';
import { statsRoute, latestCredits, billingPeriod, daysBetween } from './stats.js';

const API = 1;
const PAGES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/privacy': ['privacy.html', 'text/html; charset=utf-8'],
  '/logo.png': ['logo.png', 'image/png'],
};
// Re-read when the file changes, so a deploy that only edits public/ needs no restart (deploy/update.sh).
const pageCache = new Map();
function page(path) {
  const file = new URL('../public/' + PAGES[path][0], import.meta.url);
  const mtime = statSync(file).mtimeMs;
  const hit = pageCache.get(path);
  if (hit?.mtime === mtime) return hit.buf;
  const buf = readFileSync(file);
  pageCache.set(path, { mtime, buf });
  return buf;
}

export function createApp({ config = defaults, store, youtube = defaultYoutube, captions, playback, tunelio, alert, relay, api, sheetOpts, metrics, probe, adaptive, slots, log = console.log } = {}) {
  // Recent events for /ops/events, redacted as they are kept.
  const ring = new EventRing();
  const rawLog = log;
  log = (line) => { rawLog(line); ring.push(line); };
  const startedAt = Date.now();
  store ??= new Store({ path: config.dbPath, shards: config.shards, pool: config.pool, pinHours: config.pinHours });
  const logJson = (o) => log(JSON.stringify({ at: new Date().toISOString(), ...o }));
  metrics ??= config.metricsPath ? new Metrics({ path: config.metricsPath, tz: config.metricsTz, log: logJson }).start() : noMetrics;
  alert ??= makeAlert({ webhook: config.alertWebhook, log: logJson });
  tunelio ??= new Tunelio({ key: config.tunelioKey, onCredits: (left) => {
    metrics.gauge('credits_remaining', '', left);
    if (left < config.lowCredits) alert('credits_low', `Tunelio credits are running low: ${left} left this month.`, 24 * 60);
  }, onCall: ({ path, ok, ms }) => {
    if (!ok) return; // failed calls cost nothing
    if (path === '/create') { metrics.inc('credits', 'playback', 10); metrics.latency('tunelio_create_ms', ms); }
    if (path === '/transcript') metrics.inc('credits', 'captions', 6);
  } });
  playback ??= new Playback({ tunelio, quality: config.tunelioQuality, lowerQuality: config.tunelioLowerQuality, maxMbForQuality: config.tunelioMaxMb,
    progressiveMaxMb: config.progressiveMaxMb, progressiveMaxSeconds: config.progressiveMaxSeconds,
    probe: tunelio.enabled ? linkProbe() : null, alert, log: logJson,
    onBuild: ({ format, quality, seconds, mb, buildMs, ok }) => {
      metrics.inc('build', ok ? 'ok' : 'failed');
      if (ok) { metrics.inc(format === 'hls' ? 'build_s_hls' : 'build_s_progressive', secondsBucket(buildMs)); metrics.inc('build_length', lengthBucket({ seconds })); metrics.inc('build_size', sizeBucket(mb)); metrics.inc('build_quality', quality); }
    } });
  // Adaptive HLS, paced against the credits left until renewal (claude/play-latency.md).
  const metricsDb = () => (config.metricsPath && metrics.open ? metrics.open() : null);
  // Seed the speed estimate with the probe's builds of the last two hours, so a restart doesn't forget a slow period.
  try {
    const db = metricsDb();
    for (const r of db?.prepare(`SELECT p.ts, p.value mbps FROM polls p WHERE p.source LIKE 'tunelio:%' AND p.metric = 'mb_per_s' AND p.ts > ? ORDER BY p.ts`).all(Date.now() - 2 * 3600_000) ?? []) {
      playback.speeds?.push({ at: r.ts, mbps: r.mbps });
    }
  } catch (err) { logJson({ event: 'speed_seed_failed', message: String(err?.message ?? err).slice(0, 200) }); }
  const today = () => dayOf(Date.now(), config.metricsTz);
  adaptive ??= new Adaptive({
    playback, log: logJson, onEvent: (k) => metrics.inc('adaptive', k), holdMs: config.adaptiveHoldMs, directSeconds: config.adaptiveDirectSeconds,
    base: `${config.publicUrl}/hls`, switching: config.adaptiveSwitch,
    lower: config.tunelioQuality, upper: config.tunelioQualities.at(-1) ?? '1080p', maxUpperMb: config.tunelioMaxMb,
    pacer: new Pacer({
      reserve: config.adaptiveReserve,
      remaining: () => { if (tunelio.credits != null) return tunelio.credits; const db = metricsDb(); return db ? latestCredits(db) : null; },
      spentToday: () => { const db = metricsDb(); return db ? db.prepare("SELECT COALESCE(SUM(value), 0) v FROM daily WHERE day = ? AND metric = 'credits'").get(today()).v : 0; },
      daysLeft: () => { const d = today(); return daysBetween(d, billingPeriod(d, config.tunelioRenewsDay).renews); },
    }),
  });
  if (!captions && tunelio.enabled) captions = new TunelioCaptions({ store, tunelio, cacheDays: config.captionCacheDays, scripts: config.captionScripts, alert, log: logJson });
  const warmCaptions = !tunelio.enabled; // yt-dlp captions are free to warm; Tunelio's cost credits, so only on demand
  captions ??= new Captions({ store, ytdlp: config.ytdlp, extraArgs: config.ytdlpExtraArgs, cacheDays: config.captionCacheDays,
    sourcePrefix: config.sourcePrefix, blockedMinutes: config.blockedMinutes });
  relay ??= new Relay({ token: config.relayToken, log: logJson });
  api ??= new DataApi({ key: config.youtubeApiKey, dailyUnits: config.youtubeApiDailyUnits, alert, log: logJson });
  const searcher = makeSearch({ relay, youtube, api, alert, log: logJson, workerTimeoutMs: config.relayWaitMs });
  function checkWorkers() {
    if (relay.enabled && relay.idleMs() >= config.relayIdleAlertMinutes * 60_000) {
      alert('no_worker', `No search worker for ${config.relayIdleAlertMinutes} minutes: YouTube search runs from the Linode, which YouTube often blocks.`);
    }
  }
  setInterval(checkWorkers, 60_000).unref();
  // `${shard}:${n}` → () => Promise<page>. For worker pages the function carries { via: "worker", worker, cont }
  // and is answered 410 expired once that worker is gone.
  const continuations = new Map();
  const MAX_CONTINUATIONS = 2000;
  const hits = new Map(); // ip → timestamps of recent searches
  const warmed = new Set(); // "shard:videoId" warmed by a tablet and not played yet (warm_played metric)

  function rateLimited(ip) {
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 10_000) hits.clear();
    return list.length > config.searchesPerMinutePerIp;
  }

  // Binds a page of results to tickets: one per video, one for the sheet, one for the next page.
  function publish(shard, page, extra = {}) {
    const items = page.videos.map((v) => ({ kind: 'video', data: { id: v.id, live: Boolean(v.live), seconds: v.seconds ?? 0 } }));
    items.push({ kind: 'sheet', data: { ids: page.videos.map((v) => v.id) } });
    if (page.more) items.push({ kind: 'page', data: { page: extra.page ?? 1 } });
    const tickets = store.allocate(shard, items);
    const sheet = tickets[page.videos.length];
    const next = page.more ? tickets[page.videos.length + 1] : -1;
    if (page.more) {
      continuations.set(`${shard}:${next}`, page.more);
      while (continuations.size > MAX_CONTINUATIONS) continuations.delete(continuations.keys().next().value);
    }
    const { cols, rows, cellW, cellH } = config.sheet;
    return {
      v: API, shard, ...extra,
      sheet, sheetCols: cols, sheetRows: rows, cellW, cellH,
      next,
      results: page.videos.map((video, i) => ({ t: tickets[i], ...video })),
    };
  }

  const json = (res, status, body) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
    res.end(buf);
  };
  const fail = (res, status, error, message) => json(res, status, { v: API, error, message });

  function clientIp(req) {
    const remote = req.socket.remoteAddress ?? '';
    const fwd = req.headers['x-forwarded-for'];
    if (fwd && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) return String(fwd).split(',')[0].trim();
    return remote;
  }

  async function search(req, res, shard, url) {
    if (rateLimited(clientIp(req))) { metrics.inc('search_fail', '429'); return fail(res, 429, 'rate_limited', 'Too many searches, wait a minute.'); }
    const lang = normalizeLang(url.searchParams.get('l'));
    const query = parseQuery(url.searchParams.get('q') ?? '');
    // The world loads the bare search address once after join (visitors who allow untrusted URLs).
    if (!query) { metrics.inc('join'); metrics.inc('join_lang', lang); return fail(res, 400, 'empty_query', 'Type something after the arrow.'); }
    metrics.inc('search');
    metrics.inc('search_lang', lang);
    let page;
    const pasted = youtubeIdFrom(query);
    const started = Date.now();
    try {
      page = await searcher.search(pasted ?? query, config.resultsPerPage);
    } catch {
      metrics.inc('search_fail', '502');
      return fail(res, 502, 'youtube_failed', 'YouTube search is not answering right now.');
    }
    metrics.inc('search_source', page.via);
    metrics.latency('search_ms', Date.now() - started);
    if (pasted) {
      const exact = page.videos.find((v) => v.id === pasted);
      const rest = page.videos.filter((v) => v.id !== pasted);
      page = { videos: [exact ?? { id: pasted, title: pasted, channel: '', length: '', seconds: 0, views: '', age: '', live: false, cc: false }, ...rest], more: page.more };
    }
    return json(res, 200, publish(shard, page, { query, lang, page: 1, pasted: Boolean(pasted) }));
  }

  // Players held on a ticket and Tunelio builds in flight. A restart drops both (the visitor's video falls back to
  // youtube.com, or never starts), so deploy/update.sh waits while /healthz reports busy > 0.
  let holding = 0;
  const busy = () => {
    let building = 0;
    for (const j of playback.jobs?.values?.() ?? []) if (j.state === 'building') building++;
    return holding + building;
  };

  // Tunelio speed over time (src/probe.js): its own client so its credits count as `probe`, not playback. It searches
  // only through the relay worker, and waits while a visitor's build or held player is in flight.
  if (probe === undefined && config.tunelioProbeMinutes > 0 && config.tunelioKey) {
    const probeDb = () => (config.metricsPath && metrics.open ? metrics.open() : null);
    const kept = new Map();
    const probeTunelio = new Tunelio({ key: config.tunelioKey, onCredits: (left) => metrics.gauge('credits_remaining', '', left),
      onCall: ({ path, ok }) => { if (ok && path === '/create') metrics.inc('credits', 'probe', 10); } });
    probe = new TunelioProbe({
      tunelio: probeTunelio, quality: config.tunelioQuality, intervalMinutes: config.tunelioProbeMinutes, log: logJson,
      search: (query, limit) => (relay.enabled && relay.online().length ? relay.search(query, limit, { timeoutMs: config.relayWaitMs }) : null),
      busy: () => busy() + (Date.now() < (playback.pausedUntil ?? 0) ? 1 : 0),
      record: (source, values) => {
        // The probe's builds teach the same speed estimate visitors' builds do (it plans "1080p at once" vs adaptive).
        if (values.start_s) playback.learn(source.split(':')[1], values.mb, values.start_s * 1000);
        const db = probeDb(); if (db) recordPoll(db, { ts: Date.now(), source, values, tz: config.metricsTz });
      },
      meta: {
        get: (k) => { const db = probeDb(); return db ? getMeta(db, k) : kept.get(k) ?? null; },
        set: (k, v) => { const db = probeDb(); if (db) setMeta(db, k, v); else kept.set(k, String(v)); },
      },
    }).start();
  }

  // Player test slots (src/slots.js): the test session refills them itself through /ops/slots/refill. Its own
  // Tunelio client, so its credits count as `test`.
  if (slots === undefined && config.slotRefillsPerDay > 0 && config.tunelioKey) {
    slots = new TestSlots({
      dir: join(dirname(config.dbPath), 'hls-test'), base: `${config.publicUrl}/hls-test`, maxPerDay: config.slotRefillsPerDay, log: logJson,
      tunelio: new Tunelio({ key: config.tunelioKey, timeoutMs: 30_000, onCredits: (left) => metrics.gauge('credits_remaining', '', left),
        onCall: ({ path, ok }) => { if (ok && path === '/create') metrics.inc('credits', 'test', 10); } }),
    });
  }

  // Adaptive playlists (src/adaptive.js). Only a player gets here (through a ticket's redirect); a resolver that does
  // gets the "not a video" page, so it can't reduce the master to one variant.
  async function hlsRoute(req, res, url) {
    const m = url.pathname.match(/^\/hls\/([a-f0-9]{18})(?:\/(\d{3,4}p))?\.m3u8$/);
    if (!m) return fail(res, 404, 'not_found', 'Unknown path.');
    if (clientKind(req.headers['user-agent']) === 'ytdlp') {
      const page = Buffer.from('<!doctype html><title>Video</title><p>Not a video page.</p>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': page.length, 'cache-control': 'no-store' });
      return res.end(page);
    }
    const body = m[2] ? await adaptive.variant(m[1], m[2]) : adaptive.master(m[1]);
    if (body == null) return fail(res, 404, 'not_found', m[2] ? 'Not ready.' : 'Unknown path.');
    const buf = Buffer.from(body);
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': buf.length, 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }

  // Temporary (2026-10-22): adaptive HLS test (a master playlist over Tunelio's 720p and 1080p HLS links, written by
  // hand into <db dir>/hls-test/<random name>.m3u8; see claude/play-latency.md). VRChat's yt-dlp would pick one variant
  // from a master playlist and hand AVPro only that, so it gets the "not a video" page like a ticket, and AVPro gets the
  // master itself. The unguessable name is the only protection: the playlist holds signed links for a few hours.
  function hlsTest(req, res, url) {
    const m = url.pathname.match(/^\/hls-test\/([a-f0-9]{16,64})\.m3u8$/);
    let body = null;
    if (m) { try { body = readFileSync(join(dirname(config.dbPath), 'hls-test', `${m[1]}.m3u8`)); } catch { body = null; } }
    if (!body) return fail(res, 404, 'not_found', 'Unknown path.');
    const kind = clientKind(req.headers['user-agent']);
    logJson({ event: 'hls_test', name: m[1].slice(0, 6), client: kind, range: req.headers.range, ua: String(req.headers['user-agent'] ?? '').slice(0, 80) });
    // Player test slots (owner, 2026-10-22: the VRPlayer TEST world bakes fixed slot URLs; what a slot plays is changed
    // here): a file "#REDIRECT <url>" answers 302 to that URL; ?resolve=1 lets VRChat's yt-dlp through too, to test the
    // path where VRChat hands the player yt-dlp's result instead of the raw URL.
    const text = body.toString('utf8');
    if (text.startsWith('#REDIRECT ')) {
      if (kind === 'ytdlp' && url.searchParams.get('resolve') !== '1') return fail(res, 404, 'not_found', 'Not for the resolver.');
      res.writeHead(302, { location: text.slice(10).trim(), 'cache-control': 'no-store' });
      return res.end();
    }
    if (kind === 'ytdlp' && url.searchParams.get('resolve') !== '1') {
      const page = Buffer.from('<!doctype html><title>Preparing</title><p>Not a video page.</p>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': page.length, 'cache-control': 'no-store' });
      return res.end(page);
    }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length, 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  // /ops/state: what is in flight right now, without video IDs.
  function opsState() {
    const now = Date.now();
    const jobs = [...(playback.jobs?.values?.() ?? [])];
    const count = (st) => jobs.filter((j) => j.state === st).length;
    return {
      version: gitHead(), uptimeS: Math.round((now - startedAt) / 1000), busy: busy(), holding,
      tunelio: { enabled: tunelio.enabled, credits: tunelio.credits, pausedS: Math.max(0, Math.round(((playback.pausedUntil ?? 0) - now) / 1000)) },
      builds: { building: count('building'), ready: count('ready'), failed: count('failed'),
        inFlight: jobs.filter((j) => j.state === 'building').map((j) => ({ format: j.format, quality: j.quality, mb: j.mb, seconds: j.seconds,
          elapsedS: Math.round((now - j.startedMs) / 1000), etaS: playback.etaSeconds?.(j) ?? null })),
        recent: jobs.filter((j) => j.state !== 'building' && now - j.endedMs < 24 * 3600_000).sort((a, b) => a.endedMs - b.endedMs).slice(-30)
          .map((j) => ({ at: new Date(j.endedMs).toISOString(), state: j.state, reason: j.reason, format: j.format, quality: j.quality, mb: j.mb, seconds: j.seconds, buildS: Math.round((j.endedMs - j.startedMs) / 100) / 10 })),
        learned: { rate: playback.rate, fixed: playback.fixed } },
      relay: { enabled: relay.enabled, workers: relay.online(), idleS: Math.round(relay.idleMs() / 1000) },
      search: { lastVia: searcher.state.lastVia, apiUnitsToday: api.unitsToday },
      plans: {
        on: config.adaptiveHls, shards: config.adaptiveShards, directSeconds: config.adaptiveDirectSeconds,
        // What the estimate says a 1080p build of 300 MB (a typical 20-minute video) would take right now.
        predict300MbS: Math.round(playback.predict?.('progressive', 300) * 10) / 10,
        pacer: (() => { try { return adaptive.pacer?.check() ?? null; } catch { return null; } })(),
        recent: [...adaptive.plans.values()].filter((p) => p.mode).reduce((o, p) => ({ ...o, [p.mode]: (o[p.mode] ?? 0) + 1 }), {}),
      },
      probe: probe ? { next: new Date(Number(probe.meta.get('tunelio_probe_next')) || 0).toISOString(), runs: Number(probe.meta.get('tunelio_probe_runs')) || 0, running: probe.running } : null,
    };
  }

  // Playback quality per room (owner, 2026-10-22: a resolution picker for search videos, 720p by default). The tablet
  // loads /v1/<shard>/q/720 or /q/1080 (baked URLs, like everything else) and /v1/<shard>/q to read it back.
  const roomQuality = (shard) => store.quality(shard, config.qualityHours * 3600_000) ?? config.tunelioQuality;
  // Playback plans for this shard and video (off unless ADAPTIVE_HLS=on; live streams and paused Tunelio go the old way).
  const adaptiveFor = (shard, data) => config.adaptiveHls && (!config.adaptiveShards.length || config.adaptiveShards.includes(shard))
    && !data.live && tunelio.enabled && Date.now() >= (playback.pausedUntil ?? 0);
  // The room's pick decides the 1080p upgrade; with no pick the pacer does.
  const upgradeMode = (shard) => {
    const pick = store.quality(shard, config.qualityHours * 3600_000);
    return pick == null ? 'paced' : pick === adaptive.upper ? 'always' : 'never';
  };
  // Which build a ticket uses: { quality, hls, mode } (mode null = plans off: the room's quality, progressive).
  async function choice(shard, data) {
    if (!adaptiveFor(shard, data)) return { quality: roomQuality(shard), hls: false, mode: null };
    const mode = await adaptive.plan(data, upgradeMode(shard));
    if (mode === 'direct') return { quality: adaptive.upper, hls: false, mode };
    if (mode === 'adaptive') return { quality: adaptive.lower, hls: true, mode };
    return { quality: adaptive.lower, hls: false, mode };
  }
  function quality(res, shard, raw) {
    if (raw === 'auto') {
      // No pick: the playback plan decides (1080p when Tunelio is fast, else the default), or the default when plans are off.
      store.setQuality(shard, null);
      metrics.inc('quality_pick', 'auto');
    } else if (raw) {
      const q = `${raw}p`;
      if (!config.tunelioQualities.includes(q)) return fail(res, 400, 'bad_quality', 'Unknown quality.');
      store.setQuality(shard, q);
      metrics.inc('quality_pick', q);
    }
    const pick = store.quality(shard, config.qualityHours * 3600_000);
    return json(res, 200, { v: API, shard, quality: roomQuality(shard), pick: pick ?? 'auto', default: config.tunelioQuality, options: config.tunelioQualities });
  }

  async function ticket(req, res, shard, n) {
    const t = store.get(shard, n);
    if (!t) return fail(res, 404, 'unknown_ticket', 'Nothing here yet. Search again.');
    if (t.kind === 'video') {
      const kind = clientKind(req.headers['user-agent']);
      metrics.inc('ticket_client', kind);
      // The tablet asking (a row selected, or watching a build): start the build, report it, never redirect.
      if (kind === 'string') {
        const c = await choice(shard, t.data);
        const before = playback.peek?.(t.data, c.quality, { hls: c.hls })?.state;
        const st = playback.status(t.data, { quality: c.quality, hls: c.hls });
        if (c.mode) st.plan = c.mode;
        if (st.state === 'building' && before !== 'building') { metrics.inc('warm'); warmed.add(`${shard}:${t.data.id}`); }
        return json(res, 200, { v: API, shard, t: n, room: roomQuality(shard), ...st });
      }
      // A player (VRChat's resolver, then AVPro). The resolver gives up after 20 s, so it is held only briefly and
      // then told "this is not a video" (a plain page), which makes VRChat hand the URL straight to AVPro.
      const resolver = kind === 'ytdlp';
      const c = await choice(shard, t.data);
      if (c.hls && resolver) {
        // yt-dlp would pick one variant of the master and hand AVPro only that: send it on at once, start the build.
        playback.start(t.data, adaptive.lower, { hls: true });
        metrics.inc('adaptive', 'defer');
        logJson({ event: 'play_defer', shard, n, id: t.data.id, held: 0, adaptive: true });
        const body = Buffer.from('<!doctype html><title>Preparing</title><p>The video is still being prepared. Play it again in a moment.</p>');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
        return res.end(body);
      }
      const started = Date.now();
      holding++;
      let where;
      try {
        where = await playback.location(t.data, { holdMs: resolver ? config.ticketResolverHoldMs : config.ticketPlayerHoldMs,
          quality: c.quality, hls: c.hls });
      } finally { holding--; }
      if (c.hls && where.ready && where.via === 'tunelio') {
        where = { ...where, location: adaptive.url(adaptive.session(t.data)) };
      } else if (!resolver && where.ready && where.via === 'tunelio' && /[?&]hls=1$/.test(where.location)) {
        // A plain HLS build reached through the redirect: our copy with absolute links (see src/adaptive.js).
        const job = playback.peek(t.data, c.quality, { hls: c.hls });
        if (job?.url === where.location) where = { ...where, location: adaptive.single(t.data, job) };
      }
      const held = Date.now() - started;
      metrics.latency('ticket_hold_ms', held);
      if (where.ready === false && resolver) {
        metrics.inc('ticket_fastfail');
        logJson({ event: 'play_defer', shard, n, id: t.data.id, held, ua: String(req.headers['user-agent'] ?? '').slice(0, 80) });
        const body = Buffer.from('<!doctype html><title>Preparing</title><p>The video is still being prepared. Play it again in a moment.</p>');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
        return res.end(body);
      }
      store.markPlayed(shard, n, t.data.id);
      // Warm the original-language captions so the overlay is ready when people look for it.
      if (warmCaptions) captions.get(t.data.id, 'native').catch(() => {});
      let location = where.location;
      let via = where.via, reason = where.reason;
      if (where.ready === false) { location = `https://www.youtube.com/watch?v=${t.data.id}`; via = 'youtube'; reason = 'build_timeout'; metrics.inc('ticket_timeout'); }
      logJson({ event: 'play', shard, n, id: t.data.id, via, reason, client: kind, held, ua: String(req.headers['user-agent'] ?? '').slice(0, 80) });
      countPlay(shard, t.data, { via, reason, location });
      if (warmed.delete(`${shard}:${t.data.id}`)) metrics.inc('warm_played');
      res.writeHead(302, { location, 'cache-control': 'no-store' });
      return res.end();
    }
    if (t.kind === 'sheet') {
      const buf = await cachedSheet(`${shard}:${n}:${t.created}`, t.data.ids.map(youtube.thumbnailUrl), config.sheet, sheetOpts);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store' });
      return res.end(buf);
    }
    if (t.kind === 'page') {
      metrics.inc('more');
      const more = continuations.get(`${shard}:${n}`);
      if (!more) { metrics.inc('more_fail', '410'); return fail(res, 410, 'expired', 'These results expired. Search again.'); }
      continuations.delete(`${shard}:${n}`);
      let page;
      try { page = await more(); } catch (err) {
        logJson({ event: 'youtube_error', route: 'more', via: more.via, message: String(err?.message ?? err).slice(0, 300) });
        if (err instanceof RelayError && err.code === 'expired') { metrics.inc('more_fail', '410'); return fail(res, 410, 'expired', 'These results expired. Search again.'); }
        metrics.inc('more_fail', '502');
        return fail(res, 502, 'youtube_failed', 'YouTube search is not answering right now.');
      }
      return json(res, 200, publish(shard, page, { page: (t.data.page ?? 1) + 1 }));
    }
    return fail(res, 404, 'unknown_ticket', 'Nothing here yet. Search again.');
  }

  async function caption(req, res, shard, raw, url) {
    const byTrack = /^\d+$/.test(raw);
    // "Show captions" (the list, in the visitor's language) vs a track picked on the tablet.
    if (byTrack) metrics.inc('cc_track');
    else { metrics.inc('cc_list'); metrics.inc('cc_list_lang', raw === 'native' ? 'native' : normalizeLang(raw)); }
    if (byTrack && typeof captions.track !== 'function') { metrics.inc('cc_unavailable', 'no_tracks'); return fail(res, 404, 'no_tracks', 'Caption tracks are not available.'); }
    const lang = byTrack ? normalizeLang(url.searchParams.get('l')) : raw === 'native' ? 'native' : (LANGS[raw] ? raw : normalizeLang(raw));
    const last = store.lastPlayed(shard);
    if (!last) { metrics.inc('cc_unavailable', 'nothing_playing'); return fail(res, 404, 'nothing_playing', 'Nothing from search has played here yet.'); }
    try {
      const c = byTrack ? await captions.track(last.videoId, Number(raw), lang) : await captions.get(last.videoId, lang);
      if (!c.available) metrics.inc('cc_unavailable', c.reason ?? 'none');
      else if (byTrack) metrics.inc('cc_track_lang', String(c.key ?? '').replace(/-orig$/, ''));
      return json(res, 200, { v: API, shard, t: last.n, ...c });
    } catch (err) {
      log(JSON.stringify({ at: new Date().toISOString(), event: 'captions_error', id: last.videoId, lang, message: errorLine(err) }));
      metrics.inc('cc_unavailable', 'failed');
      return fail(res, 502, 'captions_failed', 'Captions are not available right now.');
    }
  }

  // A play counts once per room: the first time a video loads in a shard, not again for every player in the instance
  // (or a late joiner, or a replay) until ROOM_PLAY_MS after it was counted. Held in memory only; video IDs never reach the metrics.
  const ROOM_PLAY_MS = 3 * 3600_000;
  const roomPlays = new Map(); // "shard:videoId" → when it was last counted (ms)
  function countPlay(shard, data, where) {
    const key = `${shard}:${data.id}`;
    const now = Date.now();
    const counted = roomPlays.get(key);
    if (counted && now - counted < ROOM_PLAY_MS) return;
    roomPlays.set(key, now);
    if (roomPlays.size > 5000) for (const [k, t] of roomPlays) if (now - t >= ROOM_PLAY_MS) roomPlays.delete(k);
    metrics.inc('play');
    metrics.inc('play_length', lengthBucket(data));
    if (where.via === 'tunelio') metrics.inc('play_route', /\/hls\/[a-f0-9]+\.m3u8$/.test(where.location) ? 'tunelio-adaptive' : /[?&]hls=1|\/hls\/[a-f0-9]+\/\d+p\.m3u8$/.test(where.location) ? 'tunelio-hls' : 'tunelio-progressive');
    else if (where.reason === 'live') metrics.inc('play_route', 'youtube-live');
    else { metrics.inc('play_route', 'youtube-fallback'); metrics.inc('play_fallback', where.reason); }
  }

  async function readJson(req, max = 1 << 20) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > max) throw new Error('body too large');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function relayRoute(req, res, url) {
    if (!relay.authorized(req.headers.authorization)) return fail(res, 401, 'unauthorized', 'Bad relay token.');
    if (url.pathname === '/relay/next' && req.method === 'GET') {
      const name = (url.searchParams.get('worker') ?? '').slice(0, 64) || 'worker';
      const version = (url.searchParams.get('version') ?? '').slice(0, 64);
      const gone = new AbortController();
      res.on('close', () => gone.abort());
      const job = await relay.next(name, version, gone.signal);
      if (!job) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
      return json(res, 200, { job });
    }
    if (url.pathname === '/relay/done' && req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch { return fail(res, 400, 'bad_body', 'Expected JSON.'); }
      return json(res, 200, { ok: true, accepted: relay.done(body) });
    }
    return fail(res, 404, 'not_found', 'Unknown path.');
  }

  async function handler(req, res) {
    const started = Date.now();
    let route = 'other';
    res.on('finish', () => {
      if (route === 'relay' && res.statusCode === 204) return; // idle long polls, several a minute
      log(JSON.stringify({ at: new Date().toISOString(), route, status: res.statusCode, ms: Date.now() - started }));
    });
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname.startsWith('/relay/')) { route = 'relay'; return await relayRoute(req, res, url); }
      if (url.pathname === '/stats' || url.pathname.startsWith('/stats.') || url.pathname.startsWith('/stats/')) {
        route = 'stats';
        return statsRoute(req, res, url, { token: config.statsToken, metricsPath: config.metricsPath, monitorDb: config.monitorDb, tz: config.metricsTz, renewDay: config.tunelioRenewsDay, metrics });
      }
      if (url.pathname.startsWith('/ops/')) { route = 'ops'; return opsRoute(req, res, url, { token: config.statsToken, ring, state: opsState, slots }); }
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method', 'GET only.');
      if (url.pathname.startsWith('/hls-test/')) { route = 'hls-test'; return hlsTest(req, res, url); }
      if (url.pathname.startsWith('/hls/')) { route = 'hls'; return await hlsRoute(req, res, url); }
      if (url.pathname === '/healthz') {
        route = 'health';
        return json(res, 200, { ok: true, v: API, tunelio: tunelio.enabled, credits: tunelio.credits,
          workers: relay.online().length, lastSearchVia: searcher.state.lastVia, apiUnitsToday: api.unitsToday, busy: busy() });
      }
      const pagePath = url.pathname === '/privacy.html' ? '/privacy' : url.pathname;
      if (PAGES[pagePath]) {
        route = 'page';
        const buf = page(pagePath);
        res.writeHead(200, { 'content-type': PAGES[pagePath][1], 'content-length': buf.length, 'cache-control': 'public, max-age=3600' });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      }
      const m = url.pathname.match(/^\/v1\/(\d+)\/(s|q(?:\/(?:\d{3,4}|auto))?|cc\/(?:[A-Za-z-]+|\d{1,3})|\d+)\/?$/);
      if (!m) return fail(res, 404, 'not_found', 'Unknown path.');
      const shard = Number(m[1]);
      if (!store.validShard(shard)) return fail(res, 404, 'bad_shard', 'Unknown shard.');
      metrics.shard(shard);
      if (m[2] === 's') { route = 'search'; return await search(req, res, shard, url); }
      if (m[2].startsWith('cc/')) { route = 'captions'; return await caption(req, res, shard, m[2].slice(3), url); }
      if (m[2] === 'q' || m[2].startsWith('q/')) { route = 'quality'; return quality(res, shard, m[2].slice(2)); }
      const n = Number(m[2]);
      if (!store.validTicket(n)) return fail(res, 404, 'unknown_ticket', 'Unknown ticket.');
      route = 'ticket';
      return await ticket(req, res, shard, n);
    } catch (err) {
      log(JSON.stringify({ at: new Date().toISOString(), event: 'error', route, message: String(err?.stack ?? err).slice(0, 500) }));
      if (!res.headersSent) fail(res, 500, 'server_error', 'Something went wrong.');
      else res.end();
    }
  }
  return Object.assign(handler, { relay, checkWorkers, metrics, probe });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const app = createApp();
  // Write the last minute's counts before systemd stops us (deploys restart the service).
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { app.metrics.close(); process.exit(0); });
  http.createServer(app).listen(defaults.port, defaults.host, () => {
    console.log(`japharsworld-yt listening on ${defaults.host}:${defaults.port} (${defaults.shards} shards × ${defaults.pool} tickets)`);
  });
}
