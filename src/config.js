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
  // Thumbnail sheet: one cell per result, row-major.
  sheet: { cols: 4, rows: 5, cellW: 256, cellH: 144, background: '#24283b' },
};
