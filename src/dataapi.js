// YouTube Data API v3: the last fallback for search, used only with YOUTUBE_API_KEY. A page costs 101 quota units
// (search.list 100 + videos.list 1) of 10,000 a day; the day resets at midnight Pacific time.
// Videos come out in the same shape as mapVideo() in youtube.js.
const BASE = 'https://www.googleapis.com/youtube/v3';
const UNITS = { search: 100, videos: 1 };

const pacificDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(t);

export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso ?? '');
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

export function lengthText(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// YouTube's short counts: 999, 1.2K, 251K, 1.2M, 25M, 1.1B (truncated, not rounded).
export function shortCount(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return '';
  for (const [size, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (n >= size) {
      const v = n / size;
      return (v < 10 ? Math.floor(v * 10) / 10 : Math.floor(v)) + suffix;
    }
  }
  return String(Math.floor(n));
}

export function ageText(published, now = Date.now()) {
  const t = Date.parse(published ?? '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  const [n, unit] = s < 60 ? [s, 'second'] : s < 3600 ? [s / 60, 'minute'] : s < 86400 ? [s / 3600, 'hour']
    : s < 7 * 86400 ? [s / 86400, 'day'] : s < 30 * 86400 ? [s / (7 * 86400), 'week']
      : s < 365 * 86400 ? [s / (30 * 86400), 'month'] : [s / (365 * 86400), 'year'];
  const k = Math.max(1, Math.floor(n));
  return `${k} ${unit}${k === 1 ? '' : 's'} ago`;
}

const unescapeHtml = (s) => String(s ?? '').replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (all, e) => {
  const l = e.toLowerCase();
  if (l[0] === '#') return String.fromCodePoint(l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[l];
});

// One search.list item plus its videos.list entry (may be missing) → mapVideo() shape.
export function mapApiVideo(item, details, now = Date.now()) {
  const id = item?.id?.videoId;
  if (!id) return null;
  const sn = details?.snippet ?? {};
  const live = (sn.liveBroadcastContent ?? item.snippet?.liveBroadcastContent) === 'live';
  const seconds = live ? 0 : parseDuration(details?.contentDetails?.duration);
  const watching = details?.liveStreamingDetails?.concurrentViewers;
  const views = details?.statistics?.viewCount;
  return {
    id,
    title: sn.title ?? unescapeHtml(item.snippet?.title),
    channel: sn.channelTitle ?? unescapeHtml(item.snippet?.channelTitle),
    length: lengthText(seconds),
    seconds,
    views: live ? (watching != null ? `${shortCount(watching)} watching` : '')
      : views != null ? (Number(views) === 1 ? '1 view' : `${shortCount(views)} views`) : '',
    age: live ? '' : ageText(sn.publishedAt ?? item.snippet?.publishedAt, now),
    live,
    cc: details?.contentDetails?.caption === 'true',
    desc: String(sn.description ?? unescapeHtml(item.snippet?.description ?? '')).replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

export class DataApi {
  constructor({ key = '', dailyUnits = 10_000, fetcher = fetch, alert = () => {}, log = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { key, dailyUnits, fetcher, alert, log, now });
    this.day = pacificDay(now());
    this.used = 0;
  }

  get enabled() { return Boolean(this.key); }
  get unitsToday() { if (pacificDay(this.now()) !== this.day) { this.day = pacificDay(this.now()); this.used = 0; } return this.used; }

  #spend(units) {
    this.unitsToday; // roll the day over first
    this.used += units;
    if (this.used > this.dailyUnits * 0.8) {
      this.alert('api_quota', `YouTube Data API quota above 80 %: ${this.used} of ${this.dailyUnits} units used today (Pacific).`, 24 * 60);
    }
  }

  async #get(endpoint, params) {
    this.#spend(UNITS[endpoint]);
    const url = new URL(`${BASE}/${endpoint}`);
    for (const [k, v] of Object.entries({ ...params, key: this.key })) if (v != null && v !== '') url.searchParams.set(k, String(v));
    const res = await this.fetcher(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      let reason = '';
      try { reason = (await res.json())?.error?.errors?.[0]?.reason ?? ''; } catch {}
      throw new Error(`Data API ${endpoint} failed with status code ${res.status}${reason ? ` (${reason})` : ''}`);
    }
    return res.json();
  }

  async search(query, limit, pageToken = null) {
    if (!this.enabled) throw new Error('no YOUTUBE_API_KEY');
    const before = this.unitsToday;
    const found = await this.#get('search', { part: 'snippet', type: 'video', maxResults: Math.min(50, limit), q: query, pageToken });
    const items = (found.items ?? []).filter((i) => i?.id?.videoId);
    const details = new Map();
    if (items.length) {
      const got = await this.#get('videos', { part: 'contentDetails,liveStreamingDetails,statistics,snippet', id: items.map((i) => i.id.videoId).join(','), maxResults: 50 });
      for (const v of got.items ?? []) details.set(v.id, v);
    }
    this.log({ event: 'data_api', units: this.unitsToday - before, unitsToday: this.unitsToday, results: items.length });
    const videos = items.map((i) => mapApiVideo(i, details.get(i.id.videoId), this.now())).filter(Boolean).slice(0, limit);
    const next = found.nextPageToken;
    return { videos, more: next ? () => this.search(query, limit, next) : null, via: 'api' };
  }
}
