// All settings come from the environment (see deploy/japharsworld-yt.env.example).
const int = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
};

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: int('PORT', 8790),
  // Baked into the world: changing these needs a world re-upload with regenerated URLs.
  shards: int('SHARDS', 8),
  pool: int('POOL', 2000),
  // A video ticket that has been played stays bound to its video this long (late joiners).
  pinHours: int('PIN_HOURS', 24),
  resultsPerPage: int('RESULTS_PER_PAGE', 20),
  searchesPerMinutePerIp: int('SEARCHES_PER_MINUTE', 20),
  dbPath: process.env.DB_PATH ?? 'data/tickets.db',
  ytdlp: process.env.YTDLP ?? 'yt-dlp',
  ytdlpExtraArgs: (process.env.YTDLP_ARGS ?? '').split(' ').filter(Boolean),
  captionCacheDays: int('CAPTION_CACHE_DAYS', 7),
  // A routed IPv6 /64 of our own (e.g. 2600:3c06:e001:35e::/64). When set, each yt-dlp lookup goes out from a
  // random address in it. The box must accept that: see README, "Sending from your own IPv6 range".
  sourcePrefix: process.env.SOURCE_IPV6_PREFIX ?? '',
  // After YouTube refuses every attempt ("Sign in to confirm you're not a bot"), captions answer
  // "not available" for this long without asking again.
  blockedMinutes: int('BLOCKED_MINUTES', 10),
  // Tunelio (hosted YouTube media API) for HD playback of ordinary videos and for captions. Without a key, played
  // tickets go to youtube.com (360p in VRChat) and captions use yt-dlp.
  tunelioKey: process.env.TUNELIO_API_KEY ?? '',
  tunelioQuality: process.env.TUNELIO_QUALITY ?? '1080p',
  // Build time follows file size (~17 ms per MB, 2026-10-19). A 1080p file above TUNELIO_MAX_MB is made again at
  // TUNELIO_LOWER_QUALITY (10 more credits, about half the wait); a file above TUNELIO_PROGRESSIVE_MAX_MB, or a video
  // longer than TUNELIO_PROGRESSIVE_MAX_MINUTES, is served as HLS instead of a progressive mp4 (which Tunelio builds
  // whole first and refuses or times out on when very large).
  tunelioLowerQuality: process.env.TUNELIO_LOWER_QUALITY ?? '720p',
  tunelioMaxMb: int('TUNELIO_MAX_MB', 1500),
  progressiveMaxMb: int('TUNELIO_PROGRESSIVE_MAX_MB', 1800),
  progressiveMaxSeconds: int('TUNELIO_PROGRESSIVE_MAX_MINUTES', 180) * 60,
  lowCredits: int('TUNELIO_LOW_CREDITS', 5000),
  // How long a played ticket may keep VRChat's resolver (yt-dlp, 20 s socket timeout) waiting for a Tunelio build
  // before answering it with a quick "not a video" page so VRChat hands the URL to AVPro, which is then held until the
  // build is ready (up to TICKET_PLAYER_HOLD_SECONDS, then youtube.com). See playback.js.
  ticketResolverHoldMs: int('TICKET_RESOLVER_HOLD_SECONDS', 12) * 1000,
  ticketPlayerHoldMs: int('TICKET_PLAYER_HOLD_SECONDS', 90) * 1000,
  // Day of the month the Tunelio plan renews and its credits refresh (the credits forecast counts from it).
  tunelioRenewsDay: int('TUNELIO_RENEWS_DAY', 1),
  // Minutes between Tunelio speed probes (src/probe.js; 10 credits each, at least 60, plus a random 0–10). 0 = off.
  tunelioProbeMinutes: int('TUNELIO_PROBE_MINUTES', 60),
  // Comma-separated ISO 15924 scripts the world can draw captions in.
  captionScripts: (process.env.CAPTION_SCRIPTS ?? 'Latn,Cyrl,Hans,Hant,Jpan,Kore,Thai,Hebr').split(',').map((s) => s.trim()).filter(Boolean),
  // Discord webhook for alerts (Tunelio out of credits, failing, running low).
  alertWebhook: process.env.ALERT_WEBHOOK ?? '',
  // Search relay: workers (the owner's Optiplex) long-poll /relay/next with this bearer token. Empty = relay off.
  relayToken: process.env.RELAY_TOKEN ?? '',
  relayWaitMs: int('RELAY_WAIT_MS', 8000),
  // Minutes without any worker before the "no search worker" alert.
  relayIdleAlertMinutes: int('RELAY_IDLE_ALERT_MINUTES', 10),
  // YouTube Data API v3: last fallback for search. Empty = never used.
  youtubeApiKey: process.env.YOUTUBE_API_KEY ?? '',
  youtubeApiDailyUnits: int('YOUTUBE_API_DAILY_UNITS', 10000),
  // Usage metrics (claude/metrics.md): counts per day in this SQLite file, shared with the poller. Empty = off.
  metricsPath: process.env.METRICS_DB ?? 'data/metrics.db',
  metricsTz: process.env.METRICS_TZ ?? 'America/Chicago',
  // Bearer token for GET /stats, /stats.json and /stats/export.csv. Empty = those routes answer 404.
  statsToken: process.env.STATS_TOKEN ?? '',
  // The Channels monitor's database (read only, for /stats).
  monitorDb: process.env.MONITOR_DB ?? '/var/lib/japharsworld-yt-monitor/monitor.db',
  // Thumbnail sheet: one cell per result, row-major.
  sheet: { cols: 4, rows: 5, cellW: 256, cellH: 144, background: '#24283b' },
};
