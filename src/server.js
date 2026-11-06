// Routes (all under the baked shard prefix):
//   GET /v1/<shard>/s?l=<lang>&q=<prompt> → <query>   search; JSON with ticket numbers
//   GET /s/<shard><letter>?q=<query>                  the same search, compact (Quest; language letters in src/query.js)
//                                                      a video player or resolver whose q is a YouTube link (#136) gets
//                                                      that video's ticket answer instead (s.m3u8: as a .m3u8 ticket)
//   GET /v1/<shard>/<n>                                ticket: 302 to the video (Tunelio HD link, or YouTube), JPEG (thumbnail sheet),
//                                                      JSON (next page)
//   GET /v1/<shard>/cc/<lang>                          captions for the video last played in this shard (lang: VRChat code or
//                                                      "native"), with the list of the video's caption tracks (names in <lang>);
//                                                      `lines` (cue timing) and `chunks` (readable lines with word timing,
//                                                      src/blocks.js), from the first source in src/captionchain.js that answers
//   GET /v1/<shard>/q[/<720|1080>]                    the room's playback quality for search videos (read, or pick on the tablet)
//   GET /v1/<shard>/r/<who>/<kind>                    a video report (world #353): 200 {"ok":true} at once; logged with this
//                                                      shard's play and counted (who: visitor|tester; kinds in src/metrics.js)
//   GET /v1/o/<who>/<platform>/<plan>/<outcome>       one play's outcome (world #274): 200 {"ok":true} at once, counted,
//                                                      with no shard, ticket or video (sets in src/metrics.js)
//   GET /v1/ch/<key>                                  a Channels slot (key from channels.json): 302 to its current
//                                                      youtube.com/watch link, for Quest (src/channels.js)
//   GET /hls/<token>.m3u8, /hls/<token>/<q>.m3u8          adaptive playlists a played ticket leads to (src/adaptive.js)
//   GET /home/<token>/index.m3u8, /home/<token>/seg<n>.ts  home relay playback (src/home.js; uploads: PUT /relay/media/...)
//   GET /v1/<shard>/cc/<i>[?l=<lang>]                  track i of that list (the tablet's caption picker)
//   GET /v1/<shard>/cc[?l=<lang>]                      the track list alone, named in <lang>; free sources only, so it
//                                                        never spends credits (the picker opens onto it)
//   GET /healthz
//   GET /relay/next, POST /relay/done                  search relay workers only (bearer RELAY_TOKEN; see relay.js)
//   GET /stats, /stats.json, /stats/export.csv         usage metrics (bearer or ?token= STATS_TOKEN; see stats.js)
//   GET /ops/state, /ops/events                        read-only operator view, redacted (STATS_TOKEN; see ops.js)
//   GET /ops/slots, POST /ops/slots/refill             player test slots: what they hold, refill them (src/slots.js)
//   GET /ops/plan, POST /ops/plan                      test plans: force a video's play plan for up to 4 h (src/adaptive.js)
//   GET /ops/limit, POST /ops/limit                    staging only: force daily_limit / rate_limited for a while (src/forced.js)
//   GET /hls-test/<hex>.m3u8                           player test kit: test playlists and slots (yt-dlp gets a "not a video" page)
//   GET /hls-test/<hex>/<file>                         player test kit: hand-copied segments and playlists (missing segments held 10 s)
//   GET /, /privacy, /logo.png                         home page and privacy policy (public/)
//   GET /feedback                                      301 to the feedback form (FEEDBACK_URL), for eiok.cc/feedback
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { config as defaults } from './config.js';
import { Store } from './store.js';
import { parseQuery, rawQuery, queryShape, youtubeIdFrom, youtubeLinkId, normalizeLang, LANGS, SHORT_LANGS } from './query.js';
import { youtube as defaultYoutube } from './youtube.js';
import { cachedSheet } from './sheet.js';
import { Captions, errorLine } from './captions.js';
import { Tunelio } from './tunelio.js';
import { Playback, linkProbe, clientKind, isAndroidPlayer } from './playback.js';
import { TunelioCaptions } from './transcripts.js';
import { CaptionChain } from './captionchain.js';
import { makeAlert } from './alert.js';
import { Relay, RelayError } from './relay.js';
import { DataApi } from './dataapi.js';
import { makeSearch } from './search.js';
import { RefusalWatch } from './refusal.js';
import { Metrics, noMetrics, lengthBucket, secondsBucket, sizeBucket, recordPoll, getMeta, setMeta, dayOf, REPORT_WHO, REPORT_KINDS, OUTCOME_WHO, OUTCOME_PLATFORMS, OUTCOME_PLANS, OUTCOMES } from './metrics.js';
import { Adaptive, Pacer } from './adaptive.js';
import { TunelioProbe } from './probe.js';
import { EventRing, opsRoute, gitHead } from './ops.js';
import { TestSlots } from './slots.js';
import { Home, mbPerSecond } from './home.js';
import { txBytes, TxDelta } from './net.js';
import { ChannelSlots } from './channels.js';
import { statsRoute, latestCredits, billingPeriod, daysBetween } from './stats.js';
import { SpendGate, spendScope, touch } from './spend.js';
import { Allowance } from './allowance.js';
import { IpKeys } from './ipkey.js';
import { trustedIps, limitFor } from './trusted.js';
import { ForcedLimits, allowedHere } from './forced.js';

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

const HOME_REFUSED_MS = 5 * 60_000;
// A video's build_route is counted once per via in this long (routeEvent): a play's /create calls fall well within it.
const ROUTE_COUNT_MS = 3600_000;

export function createApp({ config = defaults, store, youtube = defaultYoutube, captions, playback, tunelio, alert, relay, api, sheetOpts, metrics, probe, adaptive, slots, home, channels, spend, allowance, log = console.log } = {}) {
  // Recent events for /ops/events, redacted as they are kept.
  const ring = new EventRing();
  const rawLog = log;
  log = (line) => { rawLog(line); ring.push(line); };
  const startedAt = Date.now();
  store ??= new Store({ path: config.dbPath, shards: config.shards, pool: config.pool, pinHours: config.pinHours });
  const logJson = (o) => log(JSON.stringify({ at: new Date().toISOString(), ...o }));
  metrics ??= config.metricsPath ? new Metrics({ path: config.metricsPath, tz: config.metricsTz, log: logJson }).start() : noMetrics;
  alert ??= makeAlert({ webhook: config.alertWebhook, log: logJson });
  tunelio ??= new Tunelio({ key: config.tunelioKey, createTimeoutMs: config.tunelioCreateTimeoutMs, onCredits: (left) => {
    metrics.gauge('credits_remaining', '', left);
    if (left < config.lowCredits) alert('credits_low', `Tunelio credits are running low: ${left} left this month.`, 24 * 60);
  }, onCall: ({ path, ok, ms }) => {
    if (!ok) return; // failed calls cost nothing
    if (path === '/create') { metrics.inc('credits', 'playback', 10); metrics.latency('tunelio_create_ms', ms); }
    if (path === '/transcript') metrics.inc('credits', 'captions', 6);
  } });
  // Trusted client IPs (TRUSTED_IPS, src/trusted.js): every per-IP limit times TRUSTED_IP_FACTOR. Logged as counts only.
  // Client IPs are kept only as the day's keyed codes (src/ipkey.js): every limit below gets clientKey(req), and
  // `trusted` answers for codes too. The raw address is read per request and never kept.
  const ipKeys = new IpKeys({ tz: config.metricsTz, trusted: trustedIps(config.trustedIps) });
  const trusted = ipKeys.trusted;
  const clientKey = (req) => ipKeys.code(clientIp(req));
  const trustedFactor = config.trustedIpFactor ?? 10;
  const perIp = (limit, ip) => limitFor(limit, trusted.has(ip), trustedFactor);
  if (trusted.size || trusted.bad) logJson({ event: 'trusted_ips', count: trusted.size, bad: trusted.bad, factor: trustedFactor });
  // Each visitor's daily allowance for new builds, Tunelio and home together (src/allowance.js). Injected (tests), or
  // made here; the spend gate charges it for Tunelio calls, startHome for home sessions.
  allowance ??= new Allowance({ creditsPerIp: config.allowanceCreditsPerIp, homeBuildsPerIp: config.allowanceHomeBuildsPerIp,
    homeMbPerIp: config.allowanceHomeMbPerIp, trusted, trustedFactor, maxKeys: config.rateKeysMax, tz: config.metricsTz, log: logJson,
    onReached: (kind) => metrics.inc('allowance', kind) });
  // Forced limits for tests (Everything-is-OK#545, src/forced.js): staging only, by PUBLIC_URL. On production `forced` is
  // null, so nothing below can match and /ops/limit answers 403 not_staging.
  const forced = allowedHere(config.publicUrl) ? new ForcedLimits() : null;
  if (forced) logJson({ event: 'forced_limits', ok: true });
  const forcedHit = (mode, req, id = null) => Boolean(forced?.has(mode, { id, visitor: clientKey(req) }));
  // Spend limits (src/spend.js), shared by this server's Playback and Tunelio captions. Injected (tests), or the injected
  // Playback's own, or made here when the server makes its Playback.
  spend ??= playback ? playback.spend ?? null : new SpendGate({ hourCredits: config.spendHourCredits, dayCredits: config.spendDayCredits,
    monthCredits: config.spendMonthCredits, homeFirstPercent: config.spendHomeFirstPercent,
    // The billing period's first day: the month budget starts again when the plan renews (TUNELIO_RENEWS_DAY).
    monthKey: () => billingPeriod(dayOf(Date.now(), config.metricsTz), config.tunelioRenewsDay).start,
    perIpPerMinute: config.spendBuildsPerMinutePerIp, perShardPerMinute: config.spendBuildsPerMinutePerShard,
    transcriptsPerIpPerMinute: config.spendTranscriptsPerMinutePerIp, maxKeys: config.rateKeysMax, alert, log: logJson, trusted, trustedFactor,
    stateFile: config.metricsPath ? join(dirname(config.metricsPath), 'spend-budget.json') : null });
  if (spend && !spend.allowance) spend.allowance = allowance;
  if (spend && !playback) setInterval(() => spend.check(), 60_000).unref(); // the all-clear comes without waiting for a play
  playback ??= new Playback({ tunelio, quality: config.tunelioQuality, spend, lowerQuality: config.tunelioLowerQuality, maxMbForQuality: config.tunelioMaxMb,
    progressiveMaxMb: config.progressiveMaxMb, progressiveMaxSeconds: config.progressiveMaxSeconds,
    probe: tunelio.enabled ? linkProbe() : null, alert, log: logJson,
    // Next to metrics.db (tests run without one, so they write nothing).
    stateFile: config.metricsPath ? join(dirname(config.metricsPath), 'build-speeds.json') : null,
    liveFile: config.metricsPath ? join(dirname(config.metricsPath), 'playback-live.json') : null,
    onBuild: ({ format, quality, seconds, mb, buildMs, ok }) => {
      metrics.inc('build', ok ? 'ok' : 'failed');
      if (ok) { metrics.inc(format === 'hls' ? 'build_s_hls' : 'build_s_progressive', secondsBucket(buildMs)); metrics.inc('build_length', lengthBucket({ seconds })); metrics.inc('build_size', sizeBucket(mb)); metrics.inc('build_quality', quality); }
    } });
  // Every paid /create, on this server's Playback or an injected one: a Tunelio build_route, with why the play's
  // request didn't go home (spendScope's route).
  if (playback instanceof Playback) playback.onPaid = ({ id, quality }) => routeEvent('tunelio', spendScope.getStore()?.route ?? 'default', { id, quality });
  // Adaptive HLS, paced against the credits left until renewal (claude/play-latency.md).
  const metricsDb = () => (config.metricsPath && metrics.open ? metrics.open() : null);
  // Seed the speed estimate with the probe's builds of the last two hours, so a restart doesn't forget a slow period.
  try {
    const db = metricsDb();
    const rows = db?.prepare(`SELECT p.ts, p.value mbps FROM polls p WHERE p.source IN ('tunelio:progressive', 'tunelio:hls') AND p.metric = 'mb_per_s' AND p.ts > ? ORDER BY p.ts`).all(Date.now() - 2 * 3600_000) ?? [];
    playback.seedSpeeds?.(rows.map((r) => ({ at: r.ts, mbps: r.mbps })));
  } catch (err) { logJson({ event: 'speed_seed_failed', message: String(err?.message ?? err).slice(0, 200) }); }
  const today = () => dayOf(Date.now(), config.metricsTz);
  adaptive ??= new Adaptive({
    playback, log: logJson, onEvent: (k) => metrics.inc('adaptive', k), holdMs: config.adaptiveHoldMs, directSeconds: config.adaptiveDirectSeconds,
    base: `${config.publicUrl}/hls`, switching: config.adaptiveSwitch, start: config.adaptiveStart, startSeconds: config.adaptiveStartSeconds,
    startMid: config.adaptiveStartMid, startStepSeconds: config.adaptiveStartStepSeconds,
    stateFile: config.metricsPath ? join(dirname(config.metricsPath), 'adaptive-live.json') : null, androidNoAv1: config.homeAndroid,
    lower: config.tunelioQuality, upper: config.tunelioQualities.at(-1) ?? '1080p', maxUpperMb: config.tunelioMaxMb,
    pacer: new Pacer({
      reserve: config.adaptiveReserve,
      remaining: () => { if (tunelio.credits != null) return tunelio.credits; const db = metricsDb(); return db ? latestCredits(db) : null; },
      spentToday: () => { const db = metricsDb(); return db ? db.prepare("SELECT COALESCE(SUM(value), 0) v FROM daily WHERE day = ? AND metric = 'credits'").get(today()).v : 0; },
      daysLeft: () => { const d = today(); return daysBetween(d, billingPeriod(d, config.tunelioRenewsDay).renews); },
    }),
  });
  relay ??= new Relay({ token: config.relayToken, log: logJson });
  home ??= new Home({ relay, dir: join(dirname(config.dbPath), 'home'), base: `${config.publicUrl}/home`, enabled: config.homeRelay && relay.enabled,
    dailyBuilds: config.homeDailyBuilds, dailyMb: config.homeDailyMb, hourBuilds: config.homeHourBuilds, hourMb: config.homeHourMb,
    hourMbExemptSeconds: config.homeHourMbExemptHours * 3600, startGapMs: config.homeStartGapMs,
    itemMaxMb: config.homeItemTooBig === 'tunelio' ? config.homeItemMaxGb * 1000 : 0, keepHours: config.homeKeepHours, maxGb: config.homeMaxGb, freeFloorGb: config.homeFreeFloorGb, readyMs: config.homeReadyMs,
    segmentHoldMs: config.homeSegmentHoldMs,
    startPrecise: config.homeAndroidGrowing, tz: config.metricsTz, log: logJson, onEvent: (k, d) => { metrics.inc('home', k); if (k === 'ready') metrics.inc('home_start_s', secondsBucket(d.ms)); } });
  if (home.enabled) setInterval(() => home.sweep(), 10 * 60_000).unref();
  channels ??= new ChannelSlots({ monitorDb: config.monitorDb, baked: new URL('../monitor/channels.json', import.meta.url),
    upstream: config.channelsUpstream, log: logJson });
  // The Linode's own bytes sent, every minute (the transfer alerts, src/net.js).
  const txDelta = new TxDelta();
  if (txBytes() != null) {
    txDelta.mb('self', txBytes());
    setInterval(() => metrics.inc('transfer', 'linode', txDelta.mb('self', txBytes())), 60_000).unref();
  }
  if (home.enabled) setInterval(() => {
    const s = home.state();
    metrics.gauge('home_today', 'mb', s.today.mb);
    metrics.gauge('home_today', 'builds', s.today.builds);
    metrics.gauge('home_today', 'cap_mb', s.cap.mb);
    metrics.gauge('home_today', 'workers', s.workers.length);
    metrics.gauge('home_today', 'cache_mb', s.today.cacheMb);
    metrics.gauge('home_today', 'hour_mb', s.hour.mb);
    metrics.gauge('home_today', 'hour_builds', s.hour.builds);
  }, 60_000).unref();
  // YouTube refusals (src/refusal.js): counted by where and class; 3 or more bot/rate/potoken refusals at the home relay
  // within 15 minutes alert Discord, and an hour without one sends the all-clear (checkWorkers).
  const refusals = new RefusalWatch();
  function refused(where, cls) {
    metrics.inc('yt_refusal', `${where}:${cls}`);
    if (where === 'home' && refusals.add(cls)) {
      alert('yt_refused', `YouTube refused the home relay ${refusals.times.length} times in 15 minutes (${refusals.summary()}): searches go to the Linode, captions to Tunelio, home plays to Tunelio or youtube.com.`, 60);
    }
  }
  // Captions: relay worker → yt-dlp here (when turned on, or when there is no Tunelio) → Tunelio (src/captionchain.js).
  captions ??= new CaptionChain({ store, relay, metrics, log: logJson, cacheDays: config.captionCacheDays, emptyMinutes: config.captionEmptyMinutes, scripts: config.captionScripts,
    relayWaitMs: config.relayCaptionWaitMs, realWordsOnly: config.captionRealWordsOnly,
    local: config.captionLocalYtdlp || !tunelio.enabled ? new Captions({ store, ytdlp: config.ytdlp, extraArgs: config.ytdlpExtraArgs, cacheDays: config.captionCacheDays,
      sourcePrefix: config.sourcePrefix, blockedMinutes: config.blockedMinutes, onRefusal: (cls) => refused('linode', cls) }) : null,
    tunelio: tunelio.enabled ? new TunelioCaptions({ store, tunelio, cacheDays: config.captionCacheDays, scripts: config.captionScripts, alert, log: logJson, spend }) : null });
  api ??= new DataApi({ key: config.youtubeApiKey, dailyUnits: config.youtubeApiDailyUnits, alert, log: logJson });
  const searcher = makeSearch({ relay, youtube, api, alert, log: logJson, workerTimeoutMs: config.relayWaitMs, refused });
  function checkWorkers() {
    if (relay.enabled && relay.idleMs() >= config.relayIdleAlertMinutes * 60_000) {
      alert('no_worker', `No search worker for ${config.relayIdleAlertMinutes} minutes: YouTube search runs from the Linode, which YouTube often blocks.`);
    } else if (relay.online().length) {
      alert.resolve?.('no_worker', 'Search worker is back: YouTube search runs through it again.');
    }
    if (refusals.quiet()) alert.resolve?.('yt_refused', 'No YouTube refusals at the home relay for an hour.');
  }
  setInterval(checkWorkers, 60_000).unref();
  // `${shard}:${n}` → () => Promise<page>. For worker pages the function carries { via: "worker", worker, cont }
  // and is answered 410 expired once that worker is gone.
  const continuations = new Map();
  const MAX_CONTINUATIONS = 2000;
  const hits = new Map(); // ip → timestamps of recent searches
  const warmed = new Set(); // "shard:videoId" warmed by a tablet and not played yet (warm_played metric)

  // Where each new build went and why, with the load behind it (owner, 2026-11-04: home vs Tunelio share and credits a
  // day on the dashboard): via home (a new home session; why is home_why's reason), tunelio (a paid /create; why is
  // default; home_full when home had no free stream; home_day, home_hour or home_gap when a home limit held it back;
  // home_big for one over HOME_ITEM_MAX_GB with HOME_ITEM_TOO_BIG=tunelio, #576) or youtube (a play no source could take:
  // a spend limit with home
  // full). The event adds home's streams, Tunelio's builds and the spend so far, and comes for every paid /create. The
  // build_route metric counts videos, not calls: each video once an hour per via (counted: true on that event), so a
  // play's several /create calls (adaptive's two qualities, a downgrade) count Tunelio once.
  function routeEvent(via, why, extra = {}) {
    const now = Date.now();
    const key = `${via}:${extra.id ?? ''}`;
    const counted = !(now - (routed.get(key) ?? -Infinity) < ROUTE_COUNT_MS);
    if (counted) {
      routed.delete(key);
      routed.set(key, now);
      if (routed.size > 5000) routed.delete(routed.keys().next().value);
      metrics.inc('build_route', via);
    }
    const l = home?.load?.() ?? {};
    const t = spend?.totals?.() ?? {};
    logJson({ event: 'build_route', via, why, ...extra, counted, homeActive: l.active ?? null, homeMax: l.max ?? null,
      tunelioBuilding: playback?.building?.() ?? null, hour: t.hour ?? null, day: t.day ?? null, month: t.month ?? null });
  }

  // Ticket requests a minute per IP (TICKETS_PER_MINUTE_PER_IP): status loads, players, sheets and More pages. Bounded
  // without dropping an active IP's count (src/spend.js touch). Logged once per IP and minute when it starts refusing.
  const routed = new Map(); // "via:videoId" → when its build_route was last counted
  // Every minute: per-minute IP counts older than a minute go (here, in the spend gate, the lookup-warm cap), and the
  // day's allowance at the day's end, so the privacy page's "about a minute" and "the end of the day" hold.
  setInterval(() => {
    const now = Date.now();
    for (const map of [hits, ticketHits, playerHits, lookupWarms]) for (const [k, l] of map) if (!l.some((at) => now - at < 60_000)) map.delete(k);
    spend?.sweep?.();
    allowance.sweep?.();
    adaptive.sweep?.();
    ipKeys.sweep(); // a new day's key even with no request
  }, 60_000).unref();
  const ticketHits = new Map(); // ip → timestamps
  const playerHits = new Map(); // the same for video players' loads (their own limit)
  function ticketLimited(ip, hits = ticketHits, perMinute = config.ticketsPerMinutePerIp, kind = 'ticket') {
    const ticketHits = hits;
    const limit = perIp(perMinute ?? 0, ip);
    if (!(limit > 0)) return false;
    const now = Date.now();
    const prev = ticketHits.get(ip) ?? [];
    const list = prev.filter((t) => now - t < 60_000);
    if (list.length >= limit) {
      if (!prev.logged) logJson({ event: 'ticket_limited', kind, limit, ...(trusted.has(ip) ? { trusted: true } : {}) });
      list.logged = true; // until the window drops back under the limit (a new list)
      ticketHits.set(ip, list);
      return true;
    }
    list.push(now);
    return !touch(ticketHits, ip, list, config.rateKeysMax ?? 10_000, now);
  }

  function rateLimited(ip) {
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 10_000) hits.clear();
    return list.length > perIp(config.searchesPerMinutePerIp, ip);
  }

  // Uncached lookup warms in the last minute, per IP and in all (Everything-is-OK#449): each is a paid Tunelio build
  // (10 credits) for a preview that may never play, and SEARCHES_PER_MINUTE alone let one visitor pasting a new link
  // each time start 20 a minute. Over either cap the lookup is answered as usual with no warm. Cached and home builds
  // don't count.
  // Per IP, bounded without dropping an active IP's count (src/spend.js touch: a new IP is refused while every kept one
  // was active in the last minute); the global list is kept apart from the per-IP map.
  const lookupWarms = new Map(); // ip → timestamps
  let lookupWarmsAll = [];
  function lookupWarmAllowed(ip) {
    const now = Date.now();
    const mine = (lookupWarms.get(ip) ?? []).filter((t) => now - t < 60_000);
    lookupWarmsAll = lookupWarmsAll.filter((t) => now - t < 60_000);
    if (mine.length >= perIp(config.lookupWarmsPerMinutePerIp, ip) || lookupWarmsAll.length >= config.lookupWarmsPerMinute) return false;
    if (!touch(lookupWarms, ip, [...mine, now], config.rateKeysMax ?? 10_000, now)) return false;
    lookupWarmsAll.push(now);
    return true;
  }

  // Binds a page of results to tickets: one per video, one for the sheet, one for the next page.
  // A video ticket keeps its title, channel and the start of its description, so the tablet's status answer can show
  // them to everyone in the room, not only to whoever pressed Play (Everything-is-OK#114).
  const ticketData = (v) => ({ kind: 'video', data: { id: v.id, live: Boolean(v.live), seconds: v.seconds ?? 0, title: v.title ?? '', channel: v.channel ?? '', desc: (v.desc ?? '').slice(0, 240) } });
  // seconds as in a search row: the video's length, 0 when not known (live, an older ticket, a pasted link not looked up).
  const meta = (data) => ({ title: data.title ?? '', channel: data.channel ?? '', desc: data.desc ?? '', seconds: data.seconds ?? 0 });

  function publish(shard, page, extra = {}) {
    const items = page.videos.map(ticketData);
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

  // World #136: a YouTube link typed in the tablet's YouTube field, whose search address the world hands straight to the
  // video player. "shard:videoId" → { n: Promise<ticket>, until }, so the player, VRChat's resolver and the tablet's own
  // load of that address share one ticket (and its TICKET_PIN) instead of binding one each; kept 30 min after last use.
  const pastedTickets = new Map();
  const PASTED_MS = 30 * 60_000;
  async function pastedTicket(shard, id, make) {
    const key = `${shard}:${id}`;
    const e = pastedTickets.get(key);
    if (e && Date.now() < e.until) {
      const n = await e.n.catch(() => null);
      if (n != null && store.get(shard, n)?.data?.id === id) { e.until = Date.now() + PASTED_MS; return n; }
    }
    const fresh = { n: make(), until: Date.now() + PASTED_MS };
    pastedTickets.set(key, fresh);
    if (pastedTickets.size > 2000) pastedTickets.delete(pastedTickets.keys().next().value);
    try { return await fresh.n; } catch (err) { if (pastedTickets.get(key) === fresh) pastedTickets.delete(key); throw err; }
  }
  // The pasted video as search listed it; else one Data API lookup (1 unit), so an unlisted clip still has its length
  // for the home rule and the pin window (staging, 2026-10-29: one played with seconds 0); else the id alone, as before.
  async function pastedVideo(page, id) {
    const listed = page.videos.find((v) => v.id === id);
    if (listed) return listed;
    if (api.enabled) {
      try {
        const v = await api.video(id);
        logJson({ event: 'pasted_lookup', found: Boolean(v), seconds: v?.seconds ?? null });
        if (v) return v;
      } catch (err) { logJson({ event: 'pasted_lookup', found: false, message: String(err?.message ?? err).slice(0, 200) }); }
    }
    return { id, title: id, channel: '', length: '', seconds: 0, views: '', age: '', live: false, cc: false };
  }

  // The User-Agent's class only, never the UA itself (search_shape, video_report).
  // \bQuest\b: /Quest/i also matched "UnityWebRequest", so every PC string load counted as android (world #353; the PC's
  // UA, 2026-10-30: "UnityPlayer/6000.0.67f1-DWR (UnityWebRequest…").
  const uaDevice = (ua) => /Android|\bQuest\b|Oculus/i.test(ua) ? 'android' : /UnityPlayer/i.test(ua) ? 'unity' : ua ? 'other' : 'none';

  // `lang`: from l= on /v1/<shard>/s, or from the compact address's language letter (/s/<shard><letter>, src/query.js).
  // `hlsTicket`: the address ends in .m3u8 (/v1/<shard>/s.m3u8, /s/<shard><letter>.m3u8), for a pasted link's play (#136).
  async function search(req, res, shard, url, lang = normalizeLang(url.searchParams.get('l')), hlsTicket = false) {
    if (forcedHit('rate_limited', req)) { logJson({ event: 'forced_limit', mode: 'rate_limited', route: 'search' }); return fail(res, 429, 'rate_limited', 'Too many searches, wait a minute.'); }
    if (rateLimited(clientKey(req))) { metrics.inc('search_fail', '429'); return fail(res, 429, 'rate_limited', 'Too many searches, wait a minute.'); }
    // q is the raw rest of the address after q= (rawQuery): a pasted link's own & and + stay in it.
    const rawQ = rawQuery(url.search) ?? '';
    const query = parseQuery(rawQ);
    const ua = String(req.headers['user-agent'] ?? '');
    logJson({ event: 'search_shape', lang, device: uaDevice(ua), ...queryShape(rawQ) });
    // The world loads the bare search address once after join (visitors who allow untrusted URLs).
    if (!query) { metrics.inc('join'); metrics.inc('join_lang', lang); return fail(res, 400, 'empty_query', 'Type something after the arrow.'); }
    // A video player or VRChat's resolver loading the address of a YouTube link (#136): play it as its ticket would be
    // played. Only a link on YouTube's own hosts (youtubeLinkId); anything else, and every string load (the tablet),
    // gets the search answer below, so this never redirects to another site.
    const kind = clientKind(ua);
    const linkId = kind === 'avpro' || kind === 'ytdlp' ? youtubeLinkId(query) : null;
    if (linkId) {
      let n;
      try {
        n = await pastedTicket(shard, linkId, async () => store.allocate(shard, [ticketData(await pastedVideo(await searcher.search(linkId, config.resultsPerPage), linkId))])[0]);
      } catch {
        metrics.inc('search_fail', '502');
        return fail(res, 502, 'youtube_failed', 'YouTube search is not answering right now.');
      }
      logJson({ event: 'pasted_play', shard, n, id: linkId, client: kind, hls: hlsTicket });
      return await ticket(req, res, shard, n, hlsTicket);
    }
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
      const rest = page.videos.filter((v) => v.id !== pasted);
      page = { videos: [await pastedVideo(page, pasted), ...rest], more: page.more };
    }
    const body = publish(shard, page, { query, lang, page: 1, pasted: Boolean(pasted) });
    // A YouTube link's first result is the ticket its player plays (#136), whichever of the two loads came first.
    const linked = pasted && youtubeLinkId(query) === pasted ? pasted : null;
    if (linked) body.results[0].t = await pastedTicket(shard, linked, async () => body.results[0].t);
    json(res, 200, body);
    if (linked && kind === 'string' && config.lookupWarm) {
      const device = uaDevice(ua);
      lookupWarm(shard, body.results[0].t, hlsTicket || device === 'android', device, clientKey(req))
        .catch((err) => logJson({ event: 'lookup_warm_failed', message: String(err?.message ?? err).slice(0, 200) }));
    }
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
      tunelio: probeTunelio, quality: config.tunelioProbeQuality, intervalMinutes: config.tunelioProbeMinutes, log: logJson,
      dropMinutes: config.tunelioDropMinutes, dropCount: (key, n) => metrics.inc('tunelio_drop', key, n),
      search: (query, limit) => (relay.enabled && relay.online('search').length ? relay.search(query, limit, { timeoutMs: config.relayWaitMs }) : null),
      busy: () => busy() + (Date.now() < (playback.pausedUntil ?? 0) ? 1 : 0),
      record: (source, values) => {
        // The probe's builds teach the same speed estimate visitors' builds do (it plans "1080p at once" vs adaptive).
        // Pair rows (two builds at once) don't: the estimate predicts a build on its own.
        if (values.start_s && !source.includes(':pair')) playback.learn(source.split(':')[1], values.mb, values.start_s * 1000);
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
    try { slots.writeMasters(); } catch (err) { logJson({ event: 'test_slots_masters_failed', message: String(err?.message ?? err).slice(0, 200) }); }
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
    // Which player this is, only to tell a reload from a new player (src/adaptive.js master); never stored or logged.
    const viewer = ipKeys.code(clientIp(req), req.headers['user-agent'] ?? '');
    // The master's first load starts the upgrade builds (src/adaptive.js): run in the spend scope of the player loading
    // it (the ticket's player, redirected here) and the session's shard, so they meet that visitor's allowance and the
    // per-minute caps like any build.
    const scope = { ip: clientKey(req), shard: adaptive.shardOf?.(m[1]) ?? null, answer: 'lower_rung' };
    const body = await spendScope.run(scope, () => (m[2] ? adaptive.variant(m[1], m[2], viewer, { android: isAndroidPlayer(req.headers['user-agent']) }) : adaptive.master(m[1], viewer, { android: isAndroidPlayer(req.headers['user-agent']) })));
    if (body == null) return fail(res, 404, 'not_found', m[2] ? 'Not ready.' : 'Unknown path.');
    const buf = Buffer.from(body);
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': buf.length, 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }

  // Player test kit (started 2026-10-22 as the adaptive HLS test; kept as a standing kit, owner 2026-10-23, YT#21): a
  // master playlist over Tunelio's 720p and 1080p HLS links, written by hand or by src/slots.js into
  // <db dir>/hls-test/<random name>.m3u8 (claude/play-latency.md). VRChat's yt-dlp would pick one variant from a master
  // playlist and hand AVPro only that, so it gets the "not a video" page like a ticket, and AVPro gets the master itself. The unguessable name is the only protection: the playlist holds signed links for a few hours.
  async function hlsTest(req, res, url) {
    const f = url.pathname.match(/^\/hls-test\/([a-f0-9]{16,64})\/([\w-]{1,64}\.(m3u8|m4s|mp4|ts))$/);
    if (f) return hlsTestFile(req, res, url, f);
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

  // Player test kit (2026-10-23, started as the home streaming test). Segments and a growing playlist copied by hand into
  // <db dir>/hls-test/<name>/ while ffmpeg writes them, to see whether AVPro plays an EVENT playlist from the start with a
  // seek bar (home relay design, claude/play-latency.md). A segment that isn't there yet is held up to 10 s, which also
  // tests the other design: a finished playlist published up front, segments held until they arrive.
  async function hlsTestFile(req, res, url, [, name, file, ext]) {
    const path = join(dirname(config.dbPath), 'hls-test', name, file);
    const kind = clientKind(req.headers['user-agent']);
    if (ext === 'm3u8' && kind === 'ytdlp' && url.searchParams.get('resolve') !== '1') return fail(res, 404, 'not_found', 'Not for the resolver.');
    let body = null;
    const until = Date.now() + (ext === 'm3u8' ? 0 : 10_000);
    for (;;) {
      try { body = readFileSync(path); break; } catch { if (Date.now() >= until) break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    logJson({ event: 'hls_test_file', name: name.slice(0, 6), file, client: kind, found: Boolean(body) });
    if (!body) return fail(res, 404, 'not_found', 'Not there.');
    const type = { m3u8: 'application/vnd.apple.mpegurl', m4s: 'video/iso.segment', mp4: 'video/mp4', ts: 'video/mp2t' }[ext];
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  // Home relay playback (src/home.js). Like /hls/, a resolver that gets here is told "not a video" for the playlist.
  async function homeRoute(req, res, url) {
    const m = url.pathname.match(/^\/home\/([a-f0-9]{18})\/([\w.-]{1,32})$/);
    if (m && m[2] === 'index.m3u8' && clientKind(req.headers['user-agent']) === 'ytdlp') {
      const page = Buffer.from('<!doctype html><title>Video</title><p>Not a video page.</p>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': page.length, 'cache-control': 'no-store' });
      return res.end(page);
    }
    const asked = Date.now();
    const f = m ? await home.file(m[1], m[2]) : null;
    // Which segment each player asks for (#128, 2026-10-24: a late joiner stayed at 0:00 and the log couldn't show
    // whether its seek ever reached us). The token cut to 4 characters, enough to tell sessions apart in one play.
    if (m) logJson({ event: 'home_get', ses: m[1].slice(0, 4), file: m[2], seg: /^seg(\d+)\.ts$/.exec(m[2])?.[1] ?? null,
      found: Boolean(f), range: Boolean(req.headers.range), ms: Date.now() - asked });
    if (!f) return fail(res, 404, 'not_found', 'Unknown path.');
    res.writeHead(200, { 'content-type': f.type, 'content-length': f.body.length, 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : f.body);
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
      // paused: { worker: { kind: seconds left } }, the workers' back-off after a YouTube refusal (relay/worker.js).
      relay: { enabled: relay.enabled, workers: relay.online(), idleS: Math.round(relay.idleMs() / 1000), paused: relay.paused(), mediaMax: relay.mediaMax() },
      home: home.state(),
      allowance: allowance.state(),
      spend: spend ? { ...spend.totals(), near: spend.near?.() ?? null, over: spend.over ?? null,
        budget: { hour: spend.hourCredits, day: spend.dayCredits, month: spend.monthCredits, homeFirstPercent: spend.homeFirstPercent } } : null,
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
  // What home builds for this room: its pick, else HOME_QUALITY (1080p).
  const homePick = (shard) => store.quality(shard, config.qualityHours * 3600_000) ?? config.homeQuality;
  // 720p instead of 1080p for a video whose 1080p files would be over HOME_ITEM_MAX_GB (world #240). 1080p home files
  // ran 0.46-0.57 MB/s of video (2026-10-26, a 4.1 h mix 8404 MB); 720p ones far less (a 6 h mix ~2.5 GB, 2026-10-23).
  const tooBigAt1080 = (data) => config.homeItemMaxGb > 0 && (data.seconds ?? 0) * 0.57 > config.homeItemMaxGb * 1000;
  const homeQuality = (shard, data) => { const q = homePick(shard); return q === '1080p' && tooBigAt1080(data) ? '720p' : q; };
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
    if (mode === 'start') return { quality: adaptive.start, hls: true, mode };
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

  // Whether a play goes to the home relay (src/home.js), and why; null = the Tunelio path. Tunelio comes first while
  // today's credits are within the pacer's allowance (owner, 2026-10-23); live streams stay on youtube.com. A session
  // already there (late joiners, replays) is reused whatever the reason.
  const tooBig = new Map(); // video id → when home:too_big was last counted for it
  function homeWhy(data, quality, hlsTicket = false) {
    if (!home.enabled || data.live) return null;
    const s = home.peek(data, quality);
    // A session the race started for a Quest (raceHome) isn't a reason for a PC player to reuse it: a growing playlist
    // opens as live there (#111), and its own build is what it would have had without the race. Once finished it is a
    // plain VOD. Only this reuse, so only the normal Tunelio path: a PC play with its own reason (long, pacer, Tunelio off
    // or slow) still starts home, which is that same session, growing.
    if (s && s.state !== 'failed' && (hlsTicket || s.why !== 'slow_build' || s.ended)) return 'reuse';
    // A session of this video already there (a growing slow_build one, for a PC player) is reused by home.start whatever
    // the limits, so they don't apply to it: only to a play that would start a new build (#576 review).
    const existing = Boolean(s && s.state !== 'failed');
    // No worker for this quality (home off, capped or every stream taken: src/home.js worker): the video's session at
    // another quality, if it has one (homeKeep), else Tunelio. The request's Tunelio build_route says home was full.
    if (!existing && !home.worker()) {
      // home_full: every stream taken; home_day / home_hour / home_gap: a daily or burst limit (src/home.js limit, #576).
      if (home.enabled) { const ctx = spendScope.getStore(); const l = home.limit?.(); if (ctx) ctx.route = l ? `home_${l}` : 'home_full'; }
      return home.other?.(data, quality) ? 'reuse' : null;
    }
    // Its MB would take the rolling hour over HOME_HOUR_MB, or (HOME_ITEM_TOO_BIG=tunelio) it is over HOME_ITEM_MAX_GB
    // even at 720p (#576): Tunelio, or its session at another quality. too_big is counted once per video an hour.
    const blocked = existing ? null : home.blocks?.(data, quality);
    if (blocked) {
      if (blocked === 'big' && !(Date.now() - (tooBig.get(data.id) ?? -Infinity) < 3600_000)) {
        tooBig.delete(data.id); tooBig.set(data.id, Date.now());
        if (tooBig.size > 2000) tooBig.delete(tooBig.keys().next().value);
        metrics.inc('home', 'too_big');
      }
      const ctx = spendScope.getStore(); if (ctx) ctx.route = blocked === 'big' ? 'home_big' : 'home_hour';
      return home.other?.(data, quality) ? 'reuse' : null;
    }
    if (!tunelio.enabled || Date.now() < (playback.pausedUntil ?? 0)) return 'tunelio_off';
    if (tunelioSlow()) return 'tunelio_slow';
    // Many Tunelio builds at once (TUNELIO_BUSY_BUILDS) while home has a free stream: spread the load (owner, 2026-11-04:
    // "load balance home and tunelio ... while not blowing up either").
    if (config.tunelioBusyBuilds > 0 && (playback.building?.() ?? 0) >= config.tunelioBusyBuilds) return 'tunelio_busy';
    // Long, unless home already found its keyframes uneven (src/home.js giveUp): then Tunelio while the pacer allows.
    if ((data.seconds ?? 0) >= config.homeLongMinutes * 60 && !home.isUneven?.(data)) return 'long';
    const p = adaptive.pacer?.check?.();
    if (p && !p.ok) return 'pacer';
    // Over a spend limit (src/spend.js): home instead of a new paid build. A Tunelio build already there is still used.
    // Only the shared budget (hour, day, month) sends a play home; this visitor's own limits (their allowance, the
    // per-minute caps) send it to youtube.com, never to home instead (owner, 2026-11-04).
    const refused = playback.spendRefusal?.(data, undefined, { peek: true });
    if (refused === 'budget') return 'budget';
    if (refused) { const ctx = spendScope.getStore(); if (ctx) ctx.route = refused; return null; }
    // Past SPEND_HOME_FIRST_PERCENT of the hour or day budget: home first, so the budget lasts (Tunelio when home is
    // full, through the path above). Only for a play that would make a new build: a cached one costs nothing.
    if (spend?.near?.() && playback.wouldBuild?.(data, playback.quality ?? config.tunelioQuality)) return 'near_budget';
    return null;
  }
  // Tunelio timed out within the last TUNELIO_SUSPECT_SECONDS: another /create would likely time out too.
  const tunelioSlow = () => tunelio.enabled && Date.now() - (tunelio.timedOutAt || -Infinity) < config.tunelioSuspectMs;
  // A ready home session for a player: wait for its playlist to finish when that is due within HOME_SETTLE_SECONDS
  // (src/home.js settle), then where to send the player.
  async function homeWhere(s) {
    if (s.state !== 'ready') return null;
    holding++;
    try { await home.settle?.(s, config.homeSettleMs); } finally { holding--; }
    return { location: home.url(s), via: 'home', reason: s.why, ready: true, session: s };
  }
  // One source per ticket once playing (TICKET_PIN, #293). Each request used to decide again from the sessions' state,
  // so a PC ticket went home, then Tunelio when the growing playlist was marked uneven, then home again once it ended
  // (prod 2026-10-28 04:48–04:49Z), and every change was a new URL its players loaded from 0. Kept per ticket and client
  // kind (plain or .m3u8 ticket; resolver, player): a resolver gets a progressive link where a player of the same plan
  // gets a master. The start-time choice and the adaptive masters' own steps are unchanged. A pin ends when its window
  // runs out (the video's length plus the margin after its last play: a later play gets the best source then) or when
  // its source died (home session failed or stale, Tunelio link gone or expiring). youtube.com fallbacks aren't kept, so
  // a ready build replaces them.
  const pins = new Map(); // "shard:n:plain|m3u8:kind" → { id, via, reason, location, playlist, session, quality, hls, jobUrl, mode, until }
  // What each shard's last play was answered with, for its video report: a youtube.com fallback has no pin, so a report
  // after one showed nothing (world #374, staging 2026-10-30: a 9.5 h video, home refused, Tunelio 413). In memory, like
  // the pins, so a restart still empties both.
  const lastAnswer = new Map(); // shard → { n, via, reason, quality, hls, mode }
  const pinKey = (shard, n, hlsTicket, kind) => `${shard}:${n}:${hlsTicket ? 'm3u8' : 'plain'}:${kind}`;
  const pinWindow = (data) => (data.seconds ?? 0) * 1000 + config.ticketPinMarginMs;
  function pinned(key, data, { touch = true } = {}) {
    if (!config.ticketPin) return null;
    const p = pins.get(key);
    if (!p) return null;
    const now = Date.now();
    let alive = p.id === data.id && now < p.until;
    if (alive && p.session) alive = p.session.state === 'ready' && home.peek(data, p.session.quality) === p.session;
    else if (alive) {
      const job = playback.peek?.(data, p.quality, { hls: p.hls });
      alive = job?.state === 'ready' && job.url === p.jobUrl && !(job.expiresMs - now < 60_000);
    }
    if (!alive) {
      pins.delete(key);
      if (p.id === data.id) logJson({ event: 'ticket_unpin', id: data.id, via: p.via, reason: now >= p.until ? 'window' : 'dead' });
      return null;
    }
    if (touch) p.until = now + pinWindow(data);
    return p;
  }
  // A home session for this play, counted once by why it went home (a session that is already there is just used),
  // and once as `stepdown` when it is 720p only for its length.
  // A video home just refused for room is not asked about again for a while (world #420, staging 2026-10-31: 52
  // home_no_room / home_over_cap pairs in 5 min from one Quest's retries and tablet polls, for an answer that can't change
  // that fast). Any video, PC too: a refusal only sends it on to Tunelio. In memory. A session already there is still found.
  const homeRefused = new Map(); // video id → until
  function startHome(shard, data, quality, why) {
    const until = homeRefused.get(data.id);
    if (until > Date.now() && !home.peek(data, quality)) return null;
    if (until) homeRefused.delete(data.id);
    // A new session meets this visitor's limits as a Tunelio build does: their daily allowance (home builds and MB, one
    // allowance with their credits) and the per-minute build caps, shared with Tunelio's count. Over either: no home
    // session (the play then gets youtube.com; Tunelio refuses it by the same limits). A session already there is free.
    const fresh = !home.peek(data, quality);
    const ip = spendScope.getStore()?.ip;
    const homeMb = Math.round((data.seconds ?? 0) * mbPerSecond(quality)); // at the session's own quality
    if (fresh && home.worker()) {
      // The route a refusal hands on: 'home_mb' when only this session's size doesn't fit (the allowance isn't used up,
      // so Tunelio may still take the play within its credits), else 'allowance' or 'cap' (no build anywhere).
      const over = allowance.over(ip, { home: true, homeMb, route: spendScope.getStore()?.answer });
      const no = over === 'home_mb_fit' ? 'home_mb' : over ? 'allowance' : spend?.rateCap?.(data.id) ?? null;
      if (no) { const ctx = spendScope.getStore(); if (ctx) ctx.route = no; return null; }
    }
    const s = home.start(data, quality);
    // null with a worker free: home.start's #room said no (a size or hourly MB limit, home.refusal big/hour, isn't kept). Without a worker it has made no room check.
    if (!s && home.worker() && (home.refusal ?? 'room') === 'room') {
      homeRefused.set(data.id, Date.now() + HOME_REFUSED_MS);
      if (homeRefused.size > 5000) homeRefused.delete(homeRefused.keys().next().value);
    }
    if (s && !s.why) {
      if (fresh) { allowance.charge(ip, { homeBuilds: 1, homeMb }); spend?.rateCap?.(data.id, { record: true }); }
      s.why = why; home.save?.(s); metrics.inc('home_why', why);
      routeEvent('home', why, { id: data.id, quality });
      if (quality !== homePick(shard)) { metrics.inc('home', 'stepdown'); logJson({ event: 'home_stepdown', id: data.id, from: homePick(shard), quality, seconds: data.seconds }); }
    }
    return s;
  }
  // A ready home session that went home only for being long and whose playlist grows (uneven keyframes, not due to
  // finish within HOME_SETTLE_SECONDS): given up for Tunelio while the pacer allows (#127 a, owner 2026-10-24). Home
  // keeps even-keyframe videos (their whole playlist goes up at once) and every play while over budget.
  // count: a play, not a tablet poll (tabletStatus asks the same question on every poll).
  function leaveHome(s, hlsTicket = false, { count = true } = {}) {
    if (s?.state === 'failed' && s.reason === 'uneven') return true; // another player of it gave it up meanwhile
    if (hlsTicket && config.homeAndroidGrowing) return false; // the Quest stays on the growing playlist (world #250)
    if (s?.state !== 'ready' || s.why !== 'long' || s.ended || s.endlist) return false;
    const eta = home.eta(s);
    if (eta != null && eta <= config.homeSettleMs) return false;
    // A PC player of a video of HOME_STAY_HOURS and longer stays on its ready home session (Everything-is-OK#577, prod 2026-11-06: two PC players of an 11.9 h video left a home session ready since 8.7 s
    // and were held 72-77 s for a Tunelio build that ended in a 413; a 10 h video's players were held ~90 s and got
    // youtube.com when Tunelio took 106 s). The growing playlist plays as live (no seek bar) but at once; Tunelio's
    // builds of such lengths take longer than a player is held, or are refused for size. No exception for a Tunelio build
    // already there: the one a player would get is decided later (choice), so a ready one at another quality or format,
    // or an expired one, would only start the same wait (#577 verifier); home's playlist gets its seek bar once it ends.
    // Not for a .m3u8 ticket (a Quest): HOME_ANDROID_GROWING decides that above.
    if (!hlsTicket && config.homeStayHours > 0 && (s.seconds ?? 0) >= config.homeStayHours * 3600) {
      if (count) metrics.inc('home', 'stayed');
      return false;
    }
    const p = adaptive.pacer?.check?.();
    if (p && !p.ok) return false;
    // A Quest player may be on this session (world #250): the PC goes to Tunelio and the video is remembered as uneven,
    // but the session keeps growing.
    if (config.homeAndroidGrowing) home.markUneven(s);
    else home.giveUp(s, 'uneven');
    return true;
  }
  // A home play whose quality can't be built (the worker busy or failing, or no worker): the video's session at another
  // quality instead of the Tunelio path (src/home.js other; #127). Otherwise the session as it was.
  function homeKeep(data, quality, s) {
    if (s && s.state !== 'failed') return s;
    const alt = home.other?.(data, quality);
    if (!alt) return s;
    metrics.inc('home', 'other_quality');
    logJson({ event: 'home_other_quality', id: data.id, quality, from: alt.quality });
    return alt;
  }
  // The tablet's view of a home session (the fields of playback.status). A home stream starts in ~5 s (2026-10-23).
  // growing (world #393): the playlist listed so far has no end marker, which a Quest treats as live (infinite
  // duration). Not a build still uploading a predicted (whole) playlist, which has its ENDLIST from the start; not
  // before any playlist is here, when it can still turn out either way. A hint, not exact: it describes the next player
  // to open the session, and that one may still get the end marker, as the settle hold can keep it until the rest is
  // here (HOME_SETTLE_SECONDS). A Quest already on the session probably stays on an infinite duration after this turns
  // false (inferred, not yet seen in a client).
  function homeStatus(s) {
    const growing = s.segments > 0 && !s.endlist;
    if (s.state === 'ready') return { state: 'ready', format: 'hls', quality: s.quality, plan: 'home', growing, elapsed: Math.round((s.readyMs - s.startedMs) / 1000) };
    const elapsed = (Date.now() - s.startedMs) / 1000;
    const eta = Math.max(2, Math.round(6 - elapsed));
    return { state: 'building', format: 'hls', quality: s.quality, plan: 'home', growing, elapsed: Math.round(elapsed), eta,
      progress: Math.round(Math.min(0.95, elapsed / (elapsed + eta)) * 100) / 100 };
  }

  // The hold of a Quest player (.m3u8 ticket) when its Tunelio build runs long: home starts too, and the player gets
  // whichever is ready first (Everything-is-OK#398). Size predictions can't pick these videos (2026-10-31: 44 s predicted,
  // 96.6 s actual; 94 s predicted, 12.9 s actual), so it goes by the build's age. Prod journal, 10-26 to 10-31: 182 Quest
  // waits, 17 with a hold over 20 s, 7 over 40 s, up to 97 s; home ready p50 6.6 s, max 15.2 s. Age, not this hold's own
  // time, so that a build warmed from the tablet counts, players of a room change over together and a player's retry
  // doesn't start the clock again. The build carries on: its credits are spent, and the next play can use the link.
  async function raceHome(req, shard, data, c, hq, key) {
    const hold = playback.location(data, { holdMs: config.ticketPlayerHoldMs, quality: c.quality, hls: c.hls });
    const job = playback.peek?.(data, c.quality, { hls: c.hls });
    if (job?.state !== 'building') return hold;
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, config.homeRaceMs - (Date.now() - job.startedMs))); });
    const first = await Promise.race([hold, late]);
    clearTimeout(timer);
    if (first) return first;
    if (req.socket.destroyed) return hold; // the player left: no download from home for nobody
    const s = homeKeep(data, hq, startHome(shard, data, hq, 'slow_build'));
    if (!s || s.state === 'failed') return hold;
    const tunelio = await Promise.race([hold, home.wait(s, config.homeReadyMs).then(() => null)]);
    if (tunelio) return tunelio;
    if (s.state !== 'ready') return hold; // home failed or missed its time: Tunelio's hold goes on
    // Another player of this ticket was answered meanwhile: the ticket's last check gives this one that answer, so this
    // is no win (#293).
    if (!pinned(key, data, { touch: false })) {
      metrics.inc('home', 'race_won');
      logJson({ event: 'home_race_won', id: data.id, quality: s.quality, ms: Date.now() - job.startedMs });
    }
    return homeWhere(s);
  }

  // A ticket ending in .m3u8 (`hlsTicket`) is the world's Android build: Quest's player (ExoPlayer) picks the format from
  // the URL's extension, so it opens an extensionless ticket as a file and fails on HLS behind it, and opens a .m3u8 one
  // as HLS and fails on an mp4 behind it. So a .m3u8 ticket is always answered with HLS: a plain HLS build of the plan's
  // quality (a separate build from a PC player's mp4 in the same room), never a master. An adaptive or start plan (the
  // 1080p build slow) is the 720p alone there, reported as plan "lower": a Quest master listed rungs still building,
  // whose 404 after the 1 s hold turned the picture grey (#209, owner 2026-10-26); a fast 1080p is a direct plan, so
  // the 1080p alone. PC players keep the plan's master. The tablet's status requests on it report that HLS build, so
  // its warm-up builds what the player will open.
  const hlsChoice = (c) => (c.hls ? { quality: adaptive.lower, hls: true, single: true, mode: 'lower' } : { ...c, hls: true, single: true });

  // Everything-is-OK#584. A Quest's VizVid plays a .m3u8 ticket with two players in turn (desk Quest, staging
  // 2026-11-06): AVPro (ExoPlayer) twice, then Unity's own Android player (User-Agent "stagefright", MediaExtractor), then
  // alternating, six loads in all. AVPro takes the extension and needs HLS: an mp4 behind it failed 6/6 in ~2 s ("Input
  // does not start with the #EXTM3U header"). Unity's player plays only files: the mp4 behind the same ticket played
  // (finite duration, in sync), the HLS playlist failed (-10000). Tunelio's HLS build answers only once the whole file is
  // built and is cut off at ~125 s; its mp4 streams within ~20 s (prod 2026-11-06: 720p HLS builds failed from 816 MB /
  // 99 min and every one from 1.7 GB; builds over 60 s from ~700 MB; the mp4 of a failed one was ready in 19 s). So with
  // QUEST_MP4 on, for a .m3u8 ticket: Unity's player always gets the mp4, and a long video (QUEST_MP4_MIN_MINUTES or
  // QUEST_MP4_MIN_MB) or one whose HLS build failed has AVPro sent on at once (questSkip in the ticket route), so VizVid
  // reaches Unity's player in ~13 s instead of after a 90 s hold. A ready HLS build still goes to AVPro.
  // The Quest's mp4 ({ quality, hls: false, mode: 'quest_mp4' }) for a .m3u8 ticket's HLS choice c: at most the lower
  // rung (720p), since a 1080p file may be AV1, which the Quest 2 can't decode (#101).
  const questMp4Of = (c) => ({ quality: c.quality === adaptive.upper ? adaptive.lower ?? c.quality : c.quality, hls: false, single: true, mode: 'quest_mp4' });
  // That mp4 for a .m3u8 ticket's long play, or one whose HLS build failed and isn't due for a retry yet, else null.
  // Null too once the video or that mp4 is known refused or failed (not yet due for a retry): the usual path then answers
  // (too_long, restricted, #584's no-source answer), not another "not a video".
  function questMp4(data, c, hlsTicket) {
    if (!config.questMp4 || !hlsTicket || data.live || !c.hls) return null;
    if (playback.tooLong?.(data.id) || playback.restricted?.(data.id)) return null;
    const hlsJob = playback.peek?.(data, c.quality, { hls: true });
    if (hlsJob?.state === 'ready') return null;
    const mp4 = questMp4Of(c);
    if (playback.peek?.(data, mp4.quality)?.state === 'failed' && !playback.wouldBuild?.(data, mp4.quality)) return null;
    const mb = playback.knownMb?.(data.id, c.quality) ?? 0;
    const long = (data.seconds ?? 0) >= config.questMp4MinMinutes * 60 || (config.questMp4MinMb > 0 && mb >= config.questMp4MinMb);
    const failed = hlsJob?.state === 'failed' && /^(build_failed|tunelio_failed|too_long)$/.test(hlsJob.reason ?? '')
      && !playback.wouldBuild?.(data, c.quality, { hls: true });
    return long || failed ? mp4 : null;
  }

  // An age-restricted video (world #305): no source can play it, youtube.com included (VRChat can't sign in), so the
  // tablet gets `error: "restricted"` in its status and a player a fast 403 with that code instead of a youtube.com link
  // it would retry every few seconds.
  // Over VIDEO_MAX_HOURS, on every platform: a real 48 h video's youtube.com link answered 500 on PC and both clients looped
  // six failed loads (2026-10-31). Under it, too long or too big for Tunelio with no home build, for a .m3u8 ticket or an
  // Android player only (world #420): a Quest can't open that link and retried it every 6 s. A PC keeps the link, status
  // state "youtube", reason "too_long" (src/playback.js tooLongIds). The same shape as restrictedAnswer.
  function tooLongAnswer(res, kind, shard, n, t) {
    metrics.inc('ticket_too_long');
    if (kind === 'string') return json(res, 200, { v: API, shard, t: n, room: roomQuality(shard), state: 'failed', reason: 'too_long', error: 'too_long', ...meta(t.data) });
    logJson({ event: 'play_too_long', shard, n, id: t.data.id, client: kind });
    return fail(res, 403, 'too_long', "This video is too long to play here.");
  }
  // Tunelio builds nothing over 12 h: see VIDEO_MAX_HOURS in src/config.js. Live streams have no length to go by.
  const overCap = (data) => !data.live && config.videoMaxSeconds > 0 && (data.seconds ?? 0) > config.videoMaxSeconds;
  // A visitor over their own limits (their daily allowance, src/allowance.js, or a per-minute build cap) on a Quest
  // (.m3u8 ticket) or an Android player: no youtube.com link, which a Quest can't open and retried every 6 s (world #420),
  // but a fast failed answer with reason daily_limit (owner, 2026-11-04), the shape of tooLongAnswer. The player gets
  // 403: the request itself is fine and asking again won't change the answer today, which is what a Quest should take
  // from it (a 429 says "retry after a while"); the world handles a player 403 for restricted and too_long already.
  // PC players keep the youtube.com 360p link.
  const overOwnLimit = (reason) => reason === 'allowance' || reason === 'cap';
  // isForced (#545): a forced test answer; no metric or build_route, so the counts stay real visitors' own.
  function dailyLimitAnswer(res, kind, shard, n, t, why, isForced = false) {
    if (!isForced) metrics.inc('ticket_daily_limit');
    if (kind === 'string') return json(res, 200, { v: API, shard, t: n, room: roomQuality(shard), state: 'failed', reason: 'daily_limit', error: 'daily_limit', ...meta(t.data) });
    logJson({ event: 'play_daily_limit', shard, n, id: t.data.id, client: kind, by: why, ...(isForced ? { forced: true } : {}) });
    if (!isForced) routeEvent('youtube', why, { id: t.data.id, answer: 'daily_limit' });
    return fail(res, 403, 'daily_limit', "You've started a lot of new videos today. Try one that's already playing, or come back tomorrow.");
  }
  function restrictedAnswer(res, kind, shard, n, t) {
    metrics.inc('ticket_restricted');
    if (kind === 'string') return json(res, 200, { v: API, shard, t: n, room: roomQuality(shard), state: 'failed', reason: 'restricted', error: 'restricted', ...meta(t.data) });
    logJson({ event: 'play_restricted', shard, n, id: t.data.id, client: kind });
    return fail(res, 403, 'restricted', "This video is age-restricted on YouTube and can't be played here.");
  }

  // A video report from the world (world #353): the Tester tab's problem buttons, every visitor's Resync presses and the
  // stall watchdog's reloads. It answers at once and does no work; the log line carries what the service knows about
  // the shard's play (its last played ticket and that ticket's pin: route, plan, quality, rung), for the /ops timeline.
  // Counting is limited to one per shard, who and kind per 10 s (a button pressed over and over is one report); every
  // press is still logged.
  const reportGapMs = config.reportGapMs ?? 10_000;
  const reportCounted = new Map(); // "shard:who:kind" → when it was last counted (ms)
  function report(req, res, shard, who, kind) {
    const now = Date.now();
    const key = `${shard}:${who}:${kind}`;
    const seen = reportCounted.get(key);
    const counted = seen == null || now - seen >= reportGapMs;
    if (counted) {
      reportCounted.set(key, now);
      if (reportCounted.size > 1000) for (const [k, at] of reportCounted) if (now - at >= reportGapMs) reportCounted.delete(k);
      metrics.inc('video_report', `${who}:${kind}`);
    }
    const last = store.lastPlayed(shard);
    const t = last ? store.get(shard, last.n) : null;
    // The ticket's pin, as a PC player (plain) or a Quest one (.m3u8) was given it; raw, without pinned()'s checks.
    const pin = last ? [...pins].find(([k]) => k.startsWith(`${shard}:${last.n}:`))?.[1] : null;
    const answer = lastAnswer.get(shard);
    // The pin if there is one (a home pin carries its quality in the session), else what the ticket's last play was answered with.
    const got = pin ? { ...pin, quality: pin.quality ?? pin.session?.quality, hls: pin.hls ?? (pin.session ? true : null) } : answer?.n === last?.n ? answer : null;
    const progress = pin && pin.hls && t?.kind === 'video' ? adaptive.progress(playback.peek?.(t.data, pin.quality, { hls: true })) : null;
    logJson({ event: 'video_report', shard, kind, who, device: uaDevice(String(req.headers['user-agent'] ?? '')), counted,
      n: last?.n ?? null, ago: last ? Math.round((now - last.at) / 1000) : null,
      via: got?.via ?? null, reason: got?.reason ?? null, mode: got?.mode ?? null, quality: got?.quality ?? null, hls: got?.hls ?? null,
      rung: progress?.rung ?? null, top: progress?.top ?? null });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    return res.end('{"ok":true}');
  }

  // One play's outcome from the world (world #274): a count, with nothing about the room or the video. The world can only
  // load baked addresses, so the address is the whole message. A fixed ceiling per minute keeps a script from swamping the
  // rate on the dashboard; over it the answer is the same and nothing is counted. Only a tester's outcome gets a log line,
  // for lining up a test run: a visitor's leaves the plain request line alone.
  const outcomeCap = config.outcomeCapPerMinute ?? 600;
  let outcomeMinute = 0, outcomeSeen = 0;
  function playOutcome(req, res, who, platform, plan, outcome) {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== outcomeMinute) { outcomeMinute = minute; outcomeSeen = 0; }
    const counted = ++outcomeSeen <= outcomeCap;
    if (counted) metrics.inc('play_outcome', `${who}:${platform}:${plan}:${outcome}`);
    if (who === 'tester') logJson({ event: 'play_outcome', who, platform, plan, outcome, counted });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    return res.end('{"ok":true}');
  }

  // A video ticket's status for the tablet: starts its build (a warm) unless one is there, and says how it goes; or
  // 'too_long' for a .m3u8 ticket Tunelio and home both refused. The restricted and over-cap checks come before it.
  // `reason` names who asked, for the warm's log line: 'tablet' (a ticket's own status load: a row selected, a queued
  // row, the Play bar's polls; the world sends no reason, so the service can't tell those apart) or 'lookup' (a pasted
  // link's search, Everything-is-OK#449). A cached build is no warm and costs nothing.
  // `gate` (lookups only): asked before a new Tunelio build starts; false skips it and the answer is 'cap'.
  async function tabletStatus(shard, n, t, hlsTicket, reason, gate = null) {
    // A ticket being played reports the source its players were given (TICKET_PIN), not a new decision.
    const pin = pinned(pinKey(shard, n, hlsTicket, 'avpro'), t.data, { touch: false });
    if (pin?.session) return { v: API, shard, t: n, room: roomQuality(shard), ...homeStatus(pin.session), ...meta(t.data) };
    if (pin) {
      const st = playback.status(t.data, { warm: false, quality: pin.quality, hls: pin.hls });
      if (pin.mode) st.plan = pin.mode;
      if (pin.hls && (pin.mode === 'adaptive' || pin.mode === 'start')) {
        Object.assign(st, adaptive.progress(playback.peek?.(t.data, pin.quality, { hls: true })) ?? { rung: null, top: 'pending' });
      }
      return { v: API, shard, t: n, room: roomQuality(shard), ...st, ...meta(t.data) };
    }
    const hq = homeQuality(shard, t.data);
    const hw = hlsTicket && !config.homeAndroid ? null : homeWhy(t.data, hq, hlsTicket);
    const hs = hw ? homeKeep(t.data, hq, startHome(shard, t.data, hq, hw)) : null;
    if (hs && hs.state !== 'failed' && !leaveHome(hs, hlsTicket, { count: false })) return { v: API, shard, t: n, room: roomQuality(shard), ...homeStatus(hs), ...meta(t.data) };
    if (hlsTicket && playback.tooLong?.(t.data.id)) return 'too_long';
    let c = await choice(shard, t.data);
    if (hlsTicket && !t.data.live) c = hlsChoice(c); // live: the watch link, as on a plain ticket (world #270)
    // A long video or a failed HLS build on a .m3u8 ticket (#584): its players end on Unity's player, so the tablet warms
    // and reports the mp4. When that fails too, too_long: the world shows "can't be played here" and stops this client.
    const mp4 = questMp4(t.data, c, hlsTicket);
    if (mp4) c = mp4;
    if (gate && playback.wouldBuild?.(t.data, c.quality, { hls: c.hls }) && !gate()) return 'cap';
    const before = playback.peek?.(t.data, c.quality, { hls: c.hls })?.state;
    const st = playback.status(t.data, { quality: c.quality, hls: c.hls });
    if (hlsTicket && st.reason === 'too_long') return 'too_long';
    // Both formats failed (the mp4 first or after the HLS build): no source a Quest opens.
    if (config.questMp4 && hlsTicket && !t.data.live && st.state === 'failed' && /^(build_failed|tunelio_failed)$/.test(st.reason ?? '')) {
      const other = c.hls ? playback.peek?.(t.data, questMp4Of(c).quality) : playback.peek?.(t.data, hlsChoice(c).quality, { hls: true });
      if (!c.hls || (other?.state === 'failed' && /^(build_failed|tunelio_failed)$/.test(other.reason ?? ''))) return 'too_long';
    }
    if (c.mode) st.plan = c.mode;
    // Adaptive and start plays: the rung their players have reached (src/adaptive.js progress). Both fields are
    // always there for those plans: rung null and top 'pending' before the session's master is first loaded.
    if (c.hls && !c.single && (c.mode === 'adaptive' || c.mode === 'start')) {
      Object.assign(st, adaptive.progress(playback.peek?.(t.data, c.quality, { hls: true })) ?? { rung: null, top: 'pending' });
    }
    if (st.state === 'building' && before !== 'building') {
      metrics.inc('warm');
      warmed.add(`${shard}:${t.data.id}`);
      logJson({ event: 'warm', shard, n, id: t.data.id, reason, quality: c.quality, hls: c.hls, plan: c.mode ?? null });
    }
    return { v: API, shard, t: n, room: roomQuality(shard), ...st, ...meta(t.data) };
  }

  // Everything-is-OK#449: a pasted link's lookup (the tablet's string load of the search address, as the preview card
  // and a queued link make it) also warms the video, so Play now after the card finds the build started. The format is
  // the route's: the .m3u8 address (or an Android User-Agent) builds what a .m3u8 ticket's player opens, the plain one
  // what a PC player of a plain ticket opens. The same rules as a tablet's own warm: restricted and over-cap videos
  // are never warmed, a cached build costs nothing, and the lookup already counted against the per-IP search limit.
  // Run after the answer is sent: the card never waits on it. LOOKUP_WARM=off turns it off.
  // Uncached Tunelio warms are capped (LOOKUP_WARMS_PER_MINUTE_PER_IP, LOOKUP_WARMS_PER_MINUTE): over a cap,
  // warm_skip with skipped 'cap'.
  function lookupWarm(shard, n, hls, device, ip) {
    return spendScope.run({ ip, shard, answer: 'warm_skip' }, () => lookupWarmIn(shard, n, hls, device, ip));
  }
  async function lookupWarmIn(shard, n, hls, device, ip) {
    const t = store.get(shard, n);
    if (t?.kind !== 'video') return;
    const skip = playback.restricted?.(t.data.id) ? 'restricted' : overCap(t.data) ? 'too_long' : null;
    if (skip) return logJson({ event: 'warm_skip', shard, n, id: t.data.id, reason: 'lookup', skipped: skip, hls, device });
    const st = await tabletStatus(shard, n, t, hls, 'lookup', () => lookupWarmAllowed(ip));
    if (st === 'cap') return logJson({ event: 'warm_skip', shard, n, id: t.data.id, reason: 'lookup', skipped: 'cap', hls, device, ...(trusted.has(ip) ? { trusted: true } : {}) });
    // `warm`: the build's state after it (building, ready, youtube...), in fields /ops/events already carries.
    logJson({ event: 'lookup_warm', shard, n, id: t.data.id, reason: 'lookup', hls, device, warm: st === 'too_long' ? 'too_long' : st.state ?? null,
      via: st === 'too_long' ? null : st.plan === 'home' ? 'home' : 'tunelio' });
  }

  // Every new paid build a ticket starts (tablet warm, player, adaptive planning) is counted against its client IP and
  // shard (src/spend.js) and their daily allowance (src/allowance.js); over the shared budget the play may go home, over
  // their own limits it gets youtube.com.
  function ticket(req, res, shard, n, hlsTicket = false) {
    // answer: where a play over this visitor's own limits goes (allowance_reached's route): a Quest's .m3u8 ticket or an
    // Android player gets daily_limit, a PC youtube.com.
    const answer = hlsTicket || isAndroidPlayer(req.headers['user-agent']) ? 'daily_limit' : 'youtube';
    // play: a player's request (not the tablet's status, which warms), the one that may set an adaptive session's payer.
    const play = clientKind(req.headers['user-agent']) !== 'string';
    return spendScope.run({ ip: clientKey(req), shard, answer, play }, () => ticketIn(req, res, shard, n, hlsTicket));
  }
  async function ticketIn(req, res, shard, n, hlsTicket = false) {
    const t = store.get(shard, n);
    if (!t) return fail(res, 404, 'unknown_ticket', 'Nothing here yet. Search again.');
    if (t.kind === 'video') {
      const kind = clientKind(req.headers['user-agent']);
      metrics.inc('ticket_client', kind);
      if (playback.restricted?.(t.data.id)) return restrictedAnswer(res, kind, shard, n, t);
      // Before anything that could spend: no /create, no home build, whoever asks.
      if (overCap(t.data)) return tooLongAnswer(res, kind, shard, n, t);
      // A forced daily limit (#545, staging only): answered as over the allowance before anything that could spend.
      const forcedDaily = forcedHit('daily_limit', req, t.data.id);
      // The tablet asking (a row selected, or watching a build): start the build, report it, never redirect.
      if (kind === 'string') {
        if (forcedDaily) {
          logJson({ event: 'forced_limit', mode: 'daily_limit', client: kind, hls: hlsTicket });
          if (hlsTicket) return dailyLimitAnswer(res, kind, shard, n, t, 'allowance', true);
          return json(res, 200, { v: API, shard, t: n, room: roomQuality(shard), state: 'youtube', reason: 'allowance', ...meta(t.data) });
        }
        const body = await tabletStatus(shard, n, t, hlsTicket, 'tablet');
        if (body === 'too_long') return tooLongAnswer(res, kind, shard, n, t);
        if (hlsTicket && body?.state === 'youtube' && overOwnLimit(body.reason)) return dailyLimitAnswer(res, kind, shard, n, t, body.reason);
        return json(res, 200, body);
      }
      // A player (VRChat's resolver, then AVPro). The resolver gives up after 20 s, so it is held only briefly and
      // then told "this is not a video" (a plain page), which makes VRChat hand the URL straight to AVPro.
      const resolver = kind === 'ytdlp';
      const android = isAndroidPlayer(req.headers['user-agent']);
      const started = Date.now();
      const key = pinKey(shard, n, hlsTicket, kind);
      const answerPin = (pin, held = 0) => {
        if (resolver && pin.playlist) {
          // A playlist behind the ticket: sent on at once, as when it was first answered, so AVPro asks itself.
          logJson({ event: 'play_defer', shard, n, id: t.data.id, held, pinned: true });
          const body = Buffer.from('<!doctype html><title>Preparing</title><p>The video is still being prepared. Play it again in a moment.</p>');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
          return res.end(body);
        }
        store.markPlayed(shard, n, t.data.id);
        captions.warm?.(t.data.id);
        logJson({ event: 'play', shard, n, id: t.data.id, via: pin.via, reason: pin.reason, client: kind, held, pinned: true, ua: String(req.headers['user-agent'] ?? '').slice(0, 80) });
        countPlay(shard, t.data, { via: pin.via, reason: pin.reason, location: pin.location }, android || hlsTicket ? 'android' : kind === 'avpro' ? 'pc' : null);
        res.writeHead(302, { location: pin.location, 'cache-control': 'no-store' });
        return res.end();
      };
      if (forcedDaily) {
        // As over the allowance: a Quest or Android player daily_limit, a PC (and VRChat's resolver) youtube.com. No pin.
        if (hlsTicket || android) return dailyLimitAnswer(res, kind, shard, n, t, 'allowance', true);
        logJson({ event: 'play', shard, n, id: t.data.id, via: 'youtube', reason: 'allowance', client: kind, held: 0, forced: true });
        res.writeHead(302, { location: `https://www.youtube.com/watch?v=${t.data.id}`, 'cache-control': 'no-store' });
        return res.end();
      }
      const pin = pinned(key, t.data);
      if (pin) return answerPin(pin);
      let where = null;
      // Home relay first when it applies. HLS only, so never for an Android player on a plain ticket (f331bcc); on a
      // .m3u8 ticket (the world's Android build, which opens HLS) only with HOME_ANDROID=on (2026-10-23, to be verified
      // on the Quest). The resolver is sent on at once (it would only pick the playlist apart); the player waits for
      // the first segments.
      const hq = homeQuality(shard, t.data);
      // Unity's Android player on a .m3u8 ticket (#584): it plays only files, so never home's HLS; always the mp4 below.
      const unityPlayer = config.questMp4 && hlsTicket && android && kind === 'other' && !t.data.live;
      const homeOk = hlsTicket ? config.homeAndroid && !unityPlayer : !android;
      const why = homeOk ? homeWhy(t.data, hq, hlsTicket) : null;
      let hs = why ? homeKeep(t.data, hq, startHome(shard, t.data, hq, why)) : null;
      if (hs && hs.state !== 'failed') {
        if (resolver) {
          metrics.inc('home', 'defer');
          logJson({ event: 'play_defer', shard, n, id: t.data.id, held: 0, home: true });
          const body = Buffer.from('<!doctype html><title>Preparing</title><p>The video is still being prepared. Play it again in a moment.</p>');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
          return res.end(body);
        }
        holding++;
        try { await home.wait(hs, config.homeReadyMs); } finally { holding--; }
        // Another player of this ticket was answered during the wait, say by Tunelio from raceHome: one source per ticket (#293).
        const answered = pinned(key, t.data);
        if (answered) return answerPin(answered, Date.now() - started);
        if (hs.state === 'failed') hs = homeKeep(t.data, hq, hs); // the worker said "busy" only now
        if (hs.state === 'ready') where = await homeWhere(hs);
        else metrics.inc('home', 'timeout');
        if (where && leaveHome(hs, hlsTicket)) where = null;
      }
      let c = null;
      if (!where) {
        c = await choice(shard, t.data);
        // The plan's own /create (or another play's) just timed out: home now, not another /create that would likely
        // time out too (2026-10-23: two 12 s timeouts in a row, 48 s from pick to picture).
        const slow = homeOk && !hs && tunelioSlow() && home.worker() ? startHome(shard, t.data, hq, 'tunelio_slow') : null;
        if (slow && slow.state !== 'failed') {
          if (resolver) {
            metrics.inc('home', 'defer');
            logJson({ event: 'play_defer', shard, n, id: t.data.id, held: Date.now() - started, home: true });
            const body = Buffer.from('<!doctype html><title>Preparing</title><p>The video is still being prepared. Play it again in a moment.</p>');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
            return res.end(body);
          }
          holding++;
          try { await home.wait(slow, config.homeReadyMs); } finally { holding--; }
          if (slow.state === 'ready') where = await homeWhere(slow);
        }
      }
      if (!where) {
        // Android players can't open HLS behind a ticket (src/playback.js isAndroidPlayer): the progressive build of the
        // default quality instead. The PC players in the same room keep the adaptive plan. Videos too long for a
        // progressive build still get HLS, which an Android player can't play. A .m3u8 ticket (the world's Android build)
        // always gets HLS instead. Its resolver request is sent on at once like an adaptive one below, so VRChat hands the
        // .m3u8 ticket itself to AVPro (2026-10-23, Quest: the resolver got the finished mp4 link and AVPro hung loading).
        // Not for a live stream: the resolver gets the watch link at once and VRChat resolves YouTube's live HLS itself,
        // as for Channels and the default video (world #270, staging 2026-10-28: sent on, AVPro got the watch page and
        // the Quest errored in a loop, each try another Tunelio "Live streams are not supported").
        let questSkip = false;
        if (hlsTicket && !t.data.live) {
          if (!c.hls && !resolver) metrics.inc('adaptive', 'hls_ticket');
          c = hlsChoice(c);
          // #584 (see questMp4): Unity's player gets the mp4 whatever the plan; AVPro and the resolver are sent on at once
          // for a long or HLS-failed play, with the mp4 started for Unity's player.
          const mp4 = unityPlayer ? questMp4Of(c) : questMp4(t.data, c, hlsTicket);
          if (mp4) { questSkip = !unityPlayer; c = mp4; }
        } else if (c.hls && !resolver && android) {
          c = { quality: adaptive.lower, hls: false, mode: 'android' };
          metrics.inc('adaptive', 'android_progressive');
        }
        if ((c.hls && resolver) || questSkip) {
          // yt-dlp would pick one variant of the master and hand AVPro only that: send it on at once, start the build.
          // questSkip: AVPro on a .m3u8 ticket can't play the mp4; "not a video" fails it at once, so VizVid moves on.
          playback.start(t.data, c.quality, { hls: c.hls });
          metrics.inc('adaptive', questSkip && !resolver ? 'quest_skip' : 'defer');
          logJson({ event: 'play_defer', shard, n, id: t.data.id, ...(questSkip ? { held: Date.now() - started, quest: 'skip', client: kind } : { held: 0, adaptive: true }) });
          const body = Buffer.from('<!doctype html><title>Preparing</title><p>The video is still being prepared. Play it again in a moment.</p>');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
          return res.end(body);
        }
        if (unityPlayer) metrics.inc('adaptive', 'quest_mp4');
        holding++;
        try {
          if (config.homeRaceMs > 0 && hlsTicket && homeOk && c.hls) where = await raceHome(req, shard, t.data, c, hq, key);
          else where = await playback.location(t.data, { holdMs: resolver ? config.ticketResolverHoldMs : config.ticketPlayerHoldMs,
            quality: c.quality, hls: c.hls });
        } finally { holding--; }
        if (c.hls && !c.single && where.ready && where.via === 'tunelio') {
          where = { ...where, location: adaptive.url(adaptive.session(t.data, playback.peek(t.data, c.quality, { hls: true }))) };
        } else if (!resolver && where.ready && where.via === 'tunelio' && /[?&]hls=1$/.test(where.location)) {
          // A plain HLS build reached through the redirect: our copy with absolute links (see src/adaptive.js).
          const job = playback.peek(t.data, c.quality, { hls: c.hls });
          if (job?.url === where.location) where = { ...where, location: adaptive.single(t.data, job) };
        }
        // An AV1 build on a .m3u8 ticket: the Quest 2 can't decode AV1 (Everything-is-OK #101), and home is always
        // H.264 + AAC (relay/media.js). Counted whether or not HOME_ANDROID is on, to show how often it happens.
        let homeFor = null;
        if (hlsTicket && !resolver && where.ready && where.via === 'tunelio' && c.hls) {
          const codec = await adaptive.codec?.(playback.peek(t.data, c.quality, { hls: true }));
          if (codec === 'av1') {
            metrics.inc('adaptive', 'android_av1');
            logJson({ event: 'android_av1', shard, n, id: t.data.id, quality: c.quality, home: homeOk && home.enabled });
            if (homeOk && home.enabled && home.worker()) homeFor = 'av1';
          }
        }
        // Tunelio's build failed: home before youtube.com's 360p, for a player that can take home's HLS, when a worker is free.
        if (!homeFor && !resolver && homeOk && where.ready && where.via === 'youtube' && /^(tunelio_failed|build_failed|too_long|budget)$/.test(where.reason ?? '') && home.worker()) homeFor = 'tunelio_failed';
        if (homeFor) {
          const fallback = startHome(shard, t.data, hq, homeFor);
          if (fallback && fallback.state !== 'failed') {
            holding++;
            try { await home.wait(fallback, config.homeReadyMs); } finally { holding--; }
            if (fallback.state === 'ready') where = await homeWhere(fallback);
          }
        }
      }
      const held = Date.now() - started;
      metrics.latency('ticket_hold_ms', held);
      if (where.via === 'restricted') return restrictedAnswer(res, kind, shard, n, t);
      // #584: a .m3u8 ticket's Tunelio build failed (AVPro's HLS, or Unity's player's mp4). After AVPro's HLS failure the
      // mp4 starts for Unity's player's turn. Once the mp4 failed as well, no source this Quest can open is left: too_long's
      // answer (the world shows "can't be played here" and stops this client) instead of youtube.com, which neither player
      // opens (prod 2026-11-06: a Quest re-asked every ~6 s).
      if (config.questMp4 && hlsTicket && !t.data.live && c && where.via === 'youtube' && /^(build_failed|tunelio_failed)$/.test(where.reason ?? '')) {
        const q = c.hls ? questMp4Of(c).quality : c.quality;
        if (c.hls) playback.start(t.data, q);
        const mp4Job = playback.peek?.(t.data, q);
        if (mp4Job?.state === 'failed' && /^(build_failed|tunelio_failed)$/.test(mp4Job.reason ?? '')) {
          logJson({ event: 'quest_no_source', shard, n, id: t.data.id, client: kind, reason: where.reason });
          return tooLongAnswer(res, kind, shard, n, t);
        }
      }
      if (where.via === 'youtube' && where.reason === 'too_long' && (hlsTicket || android)) return tooLongAnswer(res, kind, shard, n, t);
      if (where.via === 'youtube' && overOwnLimit(where.reason) && (hlsTicket || android)) return dailyLimitAnswer(res, kind, shard, n, t, where.reason);
      // The last check: from here to pins.set nothing awaits, so of the players of a ticket that held at once the first to
      // get here sets its source and the others follow it. The checks above can't do this alone: the codec read and
      // homeWhere await after them (#293, Everything-is-OK#398).
      const answered = pinned(key, t.data);
      if (answered) return answerPin(answered, held);
      if (where.ready === false && resolver) {
        metrics.inc('ticket_fastfail');
        logJson({ event: 'play_defer', shard, n, id: t.data.id, held, ua: String(req.headers['user-agent'] ?? '').slice(0, 80) });
        const body = Buffer.from('<!doctype html><title>Preparing</title><p>The video is still being prepared. Play it again in a moment.</p>');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
        return res.end(body);
      }
      store.markPlayed(shard, n, t.data.id);
      // Warm the original-language captions (free sources only) so the overlay is ready when people look for it.
      captions.warm?.(t.data.id);
      let location = where.location;
      let via = where.via, reason = where.reason;
      if (where.ready === false) { location = `https://www.youtube.com/watch?v=${t.data.id}`; via = 'youtube'; reason = 'build_timeout'; metrics.inc('ticket_timeout'); }
      logJson({ event: 'play', shard, n, id: t.data.id, via, reason, client: kind, held, ua: String(req.headers['user-agent'] ?? '').slice(0, 80) });
      if (via === 'youtube' && /^(budget|cap|allowance)$/.test(reason ?? '')) routeEvent('youtube', reason, { id: t.data.id });
      countPlay(shard, t.data, { via, reason, location }, android || hlsTicket ? 'android' : kind === 'avpro' ? 'pc' : null);
      lastAnswer.set(shard, { n, via, reason, quality: where.session?.quality ?? c?.quality, hls: where.session ? true : c?.hls, mode: c?.mode });
      if (warmed.delete(`${shard}:${t.data.id}`)) metrics.inc('warm_played');
      if (config.ticketPin && via !== 'youtube') {
        const session = via === 'home' ? where.session ?? null : null;
        const job = !session && c ? playback.peek?.(t.data, c.quality, { hls: c.hls }) : null;
        if (session || job?.url) {
          pins.set(key, { id: t.data.id, via, reason, location, playlist: session ? true : Boolean(c.hls), session,
            quality: c?.quality, hls: c?.hls, jobUrl: job?.url, mode: c?.mode ?? null, until: Date.now() + pinWindow(t.data) });
        }
      }
      res.writeHead(302, { location, 'cache-control': 'no-store' });
      return res.end();
    }
    if (t.kind === 'sheet') {
      const buf = await cachedSheet(`${shard}:${n}:${t.created}`, t.data.ids.map(youtube.thumbnailUrl), config.sheet, sheetOpts);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store' });
      return res.end(buf);
    }
    if (t.kind === 'page') {
      // A More page is a search: it counts against SEARCHES_PER_MINUTE, checked before the continuation is used up.
      if (forcedHit('rate_limited', req)) { logJson({ event: 'forced_limit', mode: 'rate_limited', route: 'more' }); return fail(res, 429, 'rate_limited', 'Too many searches, wait a minute.'); }
      if (rateLimited(clientKey(req))) { metrics.inc('more_fail', '429'); return fail(res, 429, 'rate_limited', 'Too many searches, wait a minute.'); }
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

  // Run in the spend scope: an uncached Tunelio transcript counts against the client IP (src/spend.js).
  function caption(req, res, shard, raw, url) {
    return spendScope.run({ ip: clientKey(req), shard, answer: 'captions_unavailable' }, () => captionIn(req, res, shard, raw, url));
  }
  async function captionIn(req, res, shard, raw, url) {
    const byTrack = /^\d+$/.test(raw);
    const listOnly = raw === ''; // the picker's list (free sources only; Everything is OK #76)
    // The list with the visitor's own track ("captions on"), the list alone, or a track picked on the tablet.
    if (byTrack) metrics.inc('cc_track');
    else if (listOnly) metrics.inc('cc_tracks');
    else { metrics.inc('cc_list'); metrics.inc('cc_list_lang', raw === 'native' ? 'native' : normalizeLang(raw)); }
    if ((byTrack && typeof captions.track !== 'function') || (listOnly && typeof captions.tracks !== 'function')) { metrics.inc('cc_unavailable', 'no_tracks'); return fail(res, 404, 'no_tracks', 'Caption tracks are not available.'); }
    const lang = byTrack || listOnly ? normalizeLang(url.searchParams.get('l')) : raw === 'native' ? 'native' : (LANGS[raw] ? raw : normalizeLang(raw));
    const last = store.lastPlayed(shard);
    if (!last) { metrics.inc('cc_unavailable', 'nothing_playing'); return fail(res, 404, 'nothing_playing', 'Nothing from search has played here yet.'); }
    try {
      const c = byTrack ? await captions.track(last.videoId, Number(raw), lang) : listOnly ? await captions.tracks(last.videoId, lang) : await captions.get(last.videoId, lang);
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
  // The platform (pc / android, from the player's User-Agent or a .m3u8 ticket) counts once per room and platform, so a
  // room with PC and Quest players counts one of each; the resolver's requests can't tell, so they don't count it.
  function countPlay(shard, data, where, platform) {
    const key = `${shard}:${data.id}`;
    const now = Date.now();
    if (platform) {
      const pk = `${key}:${platform}`;
      const seen = roomPlays.get(pk);
      if (!seen || now - seen >= ROOM_PLAY_MS) { roomPlays.set(pk, now); metrics.inc('play_platform', platform); }
    }
    const counted = roomPlays.get(key);
    if (counted && now - counted < ROOM_PLAY_MS) return;
    roomPlays.set(key, now);
    if (roomPlays.size > 5000) for (const [k, t] of roomPlays) if (now - t >= ROOM_PLAY_MS) roomPlays.delete(k);
    metrics.inc('play');
    metrics.inc('play_length', lengthBucket(data));
    if (where.via === 'home') metrics.inc('play_route', 'home');
    else if (where.via === 'tunelio') metrics.inc('play_route', /\/hls\/[a-f0-9]+\.m3u8$/.test(where.location) ? 'tunelio-adaptive' : /[?&]hls=1|\/hls\/[a-f0-9]+\/\d+p\.m3u8$/.test(where.location) ? 'tunelio-hls' : 'tunelio-progressive');
    else if (where.reason === 'live') metrics.inc('play_route', 'youtube-live');
    else { metrics.inc('play_route', 'youtube-fallback'); metrics.inc('play_fallback', where.reason); }
  }

  async function readBody(req, max) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > max) throw new Error('body too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  async function readJson(req, max = 1 << 20) { return JSON.parse((await readBody(req, max)).toString('utf8')); }

  async function relayRoute(req, res, url) {
    if (!relay.authorized(req.headers.authorization)) return fail(res, 401, 'unauthorized', 'Bad relay token.');
    if (url.pathname === '/relay/next' && req.method === 'GET') {
      const name = (url.searchParams.get('worker') ?? '').slice(0, 64) || 'worker';
      const version = (url.searchParams.get('version') ?? '').slice(0, 64);
      const caps = (url.searchParams.get('caps') ?? '').split(',').map((c) => c.trim()).filter((c) => /^[a-z]{1,16}$/.test(c)).slice(0, 8);
      // The home worker's bytes sent (src/net.js): its polls carry the counter, counted per worker name.
      const tx = Number(url.searchParams.get('tx'));
      if (/^\d{1,20}$/.test(url.searchParams.get('tx') ?? '')) metrics.inc('transfer', 'home', txDelta.mb(`w:${name}`, tx));
      const gone = new AbortController();
      res.on('close', () => gone.abort());
      const mediaMax = /^\d{1,2}$/.test(url.searchParams.get('mediaMax') ?? '') ? Number(url.searchParams.get('mediaMax')) : null;
      const job = await relay.next(name, version, gone.signal, caps, (url.searchParams.get('paused') ?? '').slice(0, 200), mediaMax);
      if (!job) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
      return json(res, 200, { job });
    }
    if (url.pathname === '/relay/done' && req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch { return fail(res, 400, 'bad_body', 'Expected JSON.'); }
      if (body?.refusal) refused('home', String(body.refusal));
      return json(res, 200, { ok: true, accepted: relay.done(body) });
    }
    const m = url.pathname.match(/^\/relay\/media\/([a-f0-9]{18})\/([\w.-]{1,32})$/);
    if (m && req.method === 'PUT') {
      let body;
      // Only a body over the limit is a 413 (the worker gives up on it); a read that broke off is worth another try (503).
      try { body = await readBody(req, 64 << 20); } catch (err) {
        return err?.message === 'body too large' ? fail(res, 413, 'too_large', 'Too large.') : fail(res, 503, 'upload_broken', 'Upload broke off.');
      }
      const status = home.put(m[1], m[2], body, { cached: req.headers['x-media-cached'] === '1' });
      // The segment players are waiting for, so the worker sends it next (Everything-is-OK#367, src/home.js).
      if (status === 204) { const want = home.want(m[1]); res.writeHead(204, want == null ? {} : { 'x-media-want': String(want) }); return res.end(); }
      return fail(res, status, status === 410 ? 'gone' : status === 413 ? 'too_large' : 'bad_file', 'Not stored.');
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
      if (url.pathname.startsWith('/ops/')) { route = 'ops'; return opsRoute(req, res, url, { token: config.statsToken, ring, state: opsState, slots, adaptive, playback, forced, caller: () => clientKey(req) }); }
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method', 'GET only.');
      if (url.pathname.startsWith('/hls-test/')) { route = 'hls-test'; return await hlsTest(req, res, url); }
      if (url.pathname.startsWith('/hls/')) { route = 'hls'; return await hlsRoute(req, res, url); }
      if (url.pathname.startsWith('/home/')) { route = 'home'; return await homeRoute(req, res, url); }
      if (url.pathname.startsWith('/v1/ch/')) {
        // A Channels slot for Quest (src/channels.js): 302 to its current watch link, which VRChat resolves itself.
        route = 'channel';
        const r = await channels.resolve(url.pathname.slice(7).replace(/\/$/, ''));
        metrics.inc('channel', r.id ? 'redirect' : r.error === 'unknown_channel' ? 'unknown' : 'unavailable');
        if (!r.id) {
          if (r.error === 'unknown_channel') return fail(res, 404, 'unknown_channel', 'No such channel.');
          return fail(res, 503, 'channel_unavailable', 'This channel is not playing right now.');
        }
        res.writeHead(302, { location: `https://www.youtube.com/watch?v=${r.id}`, 'cache-control': 'no-store' });
        return res.end();
      }
      if (url.pathname === '/healthz') {
        route = 'health';
        return json(res, 200, { ok: true, v: API, tunelio: tunelio.enabled, credits: tunelio.credits,
          workers: relay.online().length, lastSearchVia: searcher.state.lastVia, apiUnitsToday: api.unitsToday, busy: busy() });
      }
      if (url.pathname === '/feedback' && config.feedbackUrl) {
        // eiok.cc/feedback, the same form as japharsworld.com/feedback (owner, world #224, 2026-10-26).
        route = 'page';
        res.writeHead(301, { location: config.feedbackUrl });
        return res.end();
      }
      const pagePath = url.pathname === '/privacy.html' ? '/privacy' : url.pathname;
      if (PAGES[pagePath]) {
        route = 'page';
        const buf = page(pagePath);
        res.writeHead(200, { 'content-type': PAGES[pagePath][1], 'content-length': buf.length, 'cache-control': 'public, max-age=3600' });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      }
      // The compact search address for Quest's short Enter URL line (Everything-is-OK#143): /s/<shard><language letter>?q=…
      const c = url.pathname.match(/^\/s\/(\d)([a-z])?(\.m3u8)?\/?$/);
      if (c) {
        const shard = Number(c[1]);
        const lang = c[2] ? SHORT_LANGS[c[2]] : 'en';
        if (!store.validShard(shard)) return fail(res, 404, 'bad_shard', 'Unknown shard.');
        if (!lang) return fail(res, 404, 'not_found', 'Unknown path.');
        metrics.shard(shard);
        route = 'search';
        return await search(req, res, shard, url, lang, Boolean(c[3]));
      }
      const o = url.pathname.match(/^\/v1\/o\/([a-z]{1,16})\/([a-z]{1,16})\/([a-z]{1,16})\/([a-z0-9]{1,16})\/?$/);
      if (o) {
        const [, who, platform, plan, outcome] = o;
        if (!OUTCOME_WHO.includes(who) || !OUTCOME_PLATFORMS.includes(platform) || !OUTCOME_PLANS.includes(plan) || !OUTCOMES.includes(outcome)) return fail(res, 404, 'not_found', 'Unknown path.');
        route = 'outcome';
        return playOutcome(req, res, who, platform, plan, outcome);
      }
      const m = url.pathname.match(/^\/v1\/(\d+)\/(s(?:\.m3u8)?|q(?:\/(?:\d{3,4}|auto))?|cc(?:\/(?:[A-Za-z-]+|\d{1,3}))?|r\/[a-z]{1,16}\/[a-z]{1,16}|\d+(?:\.m3u8)?)\/?$/);
      if (!m) return fail(res, 404, 'not_found', 'Unknown path.');
      const shard = Number(m[1]);
      if (!store.validShard(shard)) return fail(res, 404, 'bad_shard', 'Unknown shard.');
      metrics.shard(shard);
      if (m[2] === 's' || m[2] === 's.m3u8') { route = 'search'; return await search(req, res, shard, url, undefined, m[2] === 's.m3u8'); }
      if (m[2] === 'cc' || m[2].startsWith('cc/')) { route = 'captions'; return await caption(req, res, shard, m[2].slice(3), url); }
      if (m[2] === 'q' || m[2].startsWith('q/')) { route = 'quality'; return quality(res, shard, m[2].slice(2)); }
      if (m[2].startsWith('r/')) {
        const [, who, kind] = m[2].split('/');
        if (!REPORT_WHO.includes(who) || !REPORT_KINDS.includes(kind)) return fail(res, 404, 'not_found', 'Unknown path.');
        route = 'report';
        return report(req, res, shard, who, kind);
      }
      const hlsTicket = m[2].endsWith('.m3u8');
      const n = Number(hlsTicket ? m[2].slice(0, -5) : m[2]);
      if (!store.validTicket(n)) return fail(res, 404, 'unknown_ticket', 'Unknown ticket.');
      route = 'ticket';
      // A video player's loads have their own, higher limit (TICKET_PLAYER_PER_MINUTE_PER_IP): the world shows a 429
      // there as a load error with no fallback, so it is set far above what players send, and their new builds meet the
      // build caps and the daily allowance anyway (over them the play gets youtube.com). The tablet's status, sheets
      // and More pages have TICKETS_PER_MINUTE_PER_IP. Each counts apart.
      const playerPlay = clientKind(req.headers['user-agent']) !== 'string' && store.get(shard, n)?.kind === 'video';
      const ip = clientKey(req);
      const tk = store.get(shard, n);
      if (forced && forcedHit('rate_limited', req, tk?.kind === 'video' ? tk.data.id : null)) {
        logJson({ event: 'forced_limit', mode: 'rate_limited', route: 'ticket', client: clientKind(req.headers['user-agent']) });
        return fail(res, 429, 'rate_limited', 'Too many requests, wait a minute.');
      }
      if (playerPlay ? ticketLimited(ip, playerHits, config.ticketPlayerPerMinutePerIp, 'player') : ticketLimited(ip)) {
        metrics.inc('ticket_limited');
        return fail(res, 429, 'rate_limited', 'Too many requests, wait a minute.');
      }
      return await ticket(req, res, shard, n, hlsTicket);
    } catch (err) {
      log(JSON.stringify({ at: new Date().toISOString(), event: 'error', route, message: String(err?.stack ?? err).slice(0, 500) }));
      if (!res.headersSent) fail(res, 500, 'server_error', 'Something went wrong.');
      else res.end();
    }
  }
  // kept(): everything that remembers a visitor past the request, for the tests that check no raw IP is in it.
  const kept = () => ({ hits, ticketHits, playerHits, lookupWarms, allowance, spend, adaptive, playback });
  return Object.assign(handler, { relay, checkWorkers, metrics, probe, refusals, home, kept });
}

// What SIGTERM/SIGINT do (deploys restart the service): answer the relay workers' held polls first, write the last
// minute's counts and today's home use (so the daily caps count across the restart), then exit after a short wait that
// lets those 204s reach Caddy. Exported so the tests cover it without a child process (SV-053).
export function shutdown(app, server, { exit = (code) => process.exit(code), waitMs = 200 } = {}) {
  app.relay?.drain();
  app.probe?.stop?.();
  server?.close();
  app.metrics.close();
  app.home?.flush?.();
  setTimeout(() => exit(0), waitMs);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const app = createApp();
  let server;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(app, server));
  server = http.createServer(app).listen(defaults.port, defaults.host, () => {
    console.log(`japharsworld-yt listening on ${defaults.host}:${defaults.port} (${defaults.shards} shards × ${defaults.pool} tickets)`);
  });
}
