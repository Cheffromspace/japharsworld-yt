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
  // Longer videos get Tunelio's HLS playlist instead of a progressive mp4 (which is built whole on their side first).
  progressiveMaxSeconds: int('TUNELIO_PROGRESSIVE_MAX_MINUTES', 180) * 60,
  lowCredits: int('TUNELIO_LOW_CREDITS', 5000),
  // Comma-separated ISO 15924 scripts the world can draw captions in.
  captionScripts: (process.env.CAPTION_SCRIPTS ?? 'Latn,Cyrl,Hans,Hant,Jpan,Kore,Thai,Hebr').split(',').map((s) => s.trim()).filter(Boolean),
  // Discord webhook for alerts (Tunelio out of credits, failing, running low).
  alertWebhook: process.env.ALERT_WEBHOOK ?? '',
  // Thumbnail sheet: one cell per result, row-major.
  sheet: { cols: 4, rows: 5, cellW: 256, cellH: 144, background: '#24283b' },
};
