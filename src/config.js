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
  // Captions come from a chain of sources (src/captionchain.js): a relay worker's yt-dlp, then yt-dlp on this
  // server when CAPTION_LOCAL_YTDLP=on (YouTube usually bot-walls the Linode, and a refused attempt is slow), then
  // Tunelio. RELAY_CAPTION_WAIT_MS is how long a worker gets for one video (two yt-dlp runs).
  captionLocalYtdlp: (process.env.CAPTION_LOCAL_YTDLP ?? 'off') === 'on',
  relayCaptionWaitMs: int('RELAY_CAPTION_WAIT_MS', 40_000),
  // A routed IPv6 /64 of our own (e.g. 2600:3c06:e001:35e::/64). When set, each yt-dlp lookup goes out from a
  // random address in it. The box must accept that: see README, "Sending from your own IPv6 range".
  sourcePrefix: process.env.SOURCE_IPV6_PREFIX ?? '',
  // After YouTube refuses every attempt ("Sign in to confirm you're not a bot"), captions answer
  // "not available" for this long without asking again.
  blockedMinutes: int('BLOCKED_MINUTES', 10),
  // Tunelio (hosted YouTube media API) for HD playback of ordinary videos and for captions. Without a key, played
  // tickets go to youtube.com (360p in VRChat) and captions use yt-dlp.
  tunelioKey: process.env.TUNELIO_API_KEY ?? '',
  // Default playback quality (owner, 2026-10-22: 720p for now; builds are about half as long and the difference is
  // hard to see on the wall screen). A room can pick another of TUNELIO_QUALITIES on its tablet (/v1/<shard>/q/<p>),
  // kept for QUALITY_HOURS.
  tunelioQuality: process.env.TUNELIO_QUALITY ?? '720p',
  tunelioQualities: (process.env.TUNELIO_QUALITIES ?? '720p,1080p').split(',').map((s) => s.trim()).filter((s) => /^\d{3,4}p$/.test(s)),
  qualityHours: int('QUALITY_HOURS', 12),
  // Adaptive HLS (src/adaptive.js): start at the default quality, step up to the best of TUNELIO_QUALITIES when its
  // build is ready, paced so the credits last to renewal with ADAPTIVE_RESERVE to spare. ADAPTIVE_HLS=on turns it on,
  // for the shards in ADAPTIVE_SHARDS only (comma separated; empty = all) while it is being tried.
  adaptiveHls: (process.env.ADAPTIVE_HLS ?? 'off') === 'on',
  adaptiveShards: (process.env.ADAPTIVE_SHARDS ?? '').split(',').map((s) => Number.parseInt(s, 10)).filter(Number.isInteger),
  adaptiveReserve: int('ADAPTIVE_RESERVE', 5000),
  adaptiveHoldMs: int('ADAPTIVE_HOLD_SECONDS', 8) * 1000,
  // The mid-video 720p → 1080p step up. Off: a 1080p build predicted too slow means 720p for that video (switching froze
  // the picture in VRChat on PC in 2 of 4 tries, 2026-10-22).
  adaptiveSwitch: (process.env.ADAPTIVE_SWITCH ?? 'off') === 'on',
  // Play 1080p at once (no adaptive playlist) when its build is predicted to take at most this long (~15–18 s to the
  // picture with VRChat's own ~5–8 s).
  adaptiveDirectSeconds: int('ADAPTIVE_DIRECT_SECONDS', 10),
  // A quick first rung for adaptive plays (e.g. 360p; empty = off): used when the 720p HLS build is predicted to take
  // more than ADAPTIVE_START_SECONDS, so the picture starts on the small build and steps up (10 more credits per play).
  adaptiveStart: /^\d{3,4}p$/.test(process.env.ADAPTIVE_START ?? '') ? process.env.ADAPTIVE_START : null,
  adaptiveStartSeconds: int('ADAPTIVE_START_SECONDS', 10),
  // This service's public address, for links it hands out (the adaptive master playlist).
  publicUrl: (process.env.PUBLIC_URL ?? 'https://yt.japharsworld.com').replace(/\/$/, ''),
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
  // Minutes between Tunelio speed probes (src/probe.js; 10 credits each, at least 20, plus a random quarter). 0 = off.
  // Hourly (owner, 2026-10-23): every 20 minutes cost ~720 credits a day, more than playback's 80–450.
  tunelioProbeMinutes: int('TUNELIO_PROBE_MINUTES', 60),
  // The probe's own quality (2026-10-22: it followed TUNELIO_QUALITY, so it measured 720p while Auto decides whether
  // 1080p is fast enough).
  tunelioProbeQuality: process.env.TUNELIO_PROBE_QUALITY ?? '1080p',
  // Player test slot refills a day through POST /ops/slots/refill (src/slots.js; 20 credits each, 0 = off).
  slotRefillsPerDay: int('SLOT_REFILLS_PER_DAY', 6),
  // Comma-separated ISO 15924 scripts the world can draw captions in.
  captionScripts: (process.env.CAPTION_SCRIPTS ?? 'Latn,Cyrl,Hans,Hant,Jpan,Kore,Thai,Hebr').split(',').map((s) => s.trim()).filter(Boolean),
  // Discord webhook for alerts (Tunelio out of credits, failing, running low).
  alertWebhook: process.env.ALERT_WEBHOOK ?? '',
  // Search relay: workers (the owner's Optiplex) long-poll /relay/next with this bearer token. Empty = relay off.
  relayToken: process.env.RELAY_TOKEN ?? '',
  relayWaitMs: int('RELAY_WAIT_MS', 8000),
  // Minutes without any worker before the "no search worker" alert.
  relayIdleAlertMinutes: int('RELAY_IDLE_ALERT_MINUTES', 10),
  // Home relay playback (src/home.js, relay/media.js): a relay worker with ffmpeg streams the video from the home
  // connection as HLS. Tunelio stays first while today's credits are within the pacer's allowance; home serves when they
  // aren't, when Tunelio is off or failing, and for videos of HOME_LONG_MINUTES and longer (Tunelio's build time grows
  // with the file and fails at ~115 s; home starts in seconds whatever the length). PC players only: Android can't open
  // HLS behind a ticket. HOME_DAILY_BUILDS / HOME_DAILY_MB cap what the home IP downloads a day (YouTube may flag it).
  homeRelay: (process.env.HOME_RELAY ?? 'off') === 'on',
  // The home relay for .m3u8 tickets too (the world's Android build: Quest opens HLS behind those), by the same rules
  // as a PC player, and for an AV1 Tunelio build, which the Quest 2 can't decode (home is always H.264). Off until
  // verified on the Quest (2026-10-23).
  homeAndroid: (process.env.HOME_ANDROID ?? 'off') === 'on',
  homeLongMinutes: int('HOME_LONG_MINUTES', 30),
  homeDailyBuilds: int('HOME_DAILY_BUILDS', 40),
  homeDailyMb: int('HOME_DAILY_MB', 50_000), // owner, 2026-10-23: 10 GB went in a few long videos (a 6 h mix is ~2.5 GB)
  homeKeepHours: int('HOME_KEEP_HOURS', 12),
  homeMaxGb: int('HOME_MAX_GB', 6),
  // How long a new session may take to its first playlist: yt-dlp ~3 s, then its stream URLs answer 403 for 0.1–2.6 s,
  // once 22 s, before they work (2026-10-23), then the first segments.
  homeReadyMs: int('HOME_READY_SECONDS', 40) * 1000,
  // How long a player's request for a segment that hasn't arrived yet is held (the whole playlist is published up front).
  homeSegmentHoldMs: int('HOME_SEGMENT_HOLD_SECONDS', 20) * 1000,
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
