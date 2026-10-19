// Routes (all under the baked shard prefix):
//   GET /v1/<shard>/s?l=<lang>&q=<prompt> → <query>   search; JSON with ticket numbers
//   GET /v1/<shard>/<n>                                ticket: 302 to the video (Tunelio HD link, or YouTube), JPEG (thumbnail sheet),
//                                                      JSON (next page)
//   GET /v1/<shard>/cc/<lang>                          captions for the video last played in this shard (lang: VRChat code or
//                                                      "native"), with the list of the video's caption tracks (names in <lang>)
//   GET /v1/<shard>/cc/<i>[?l=<lang>]                  track i of that list (the tablet's caption picker; Tunelio captions only)
//   GET /healthz
//   GET /, /privacy, /logo.png                         home page and privacy policy (public/)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config as defaults } from './config.js';
import { Store } from './store.js';
import { parseQuery, youtubeIdFrom, normalizeLang, LANGS } from './query.js';
import { youtube as defaultYoutube } from './youtube.js';
import { cachedSheet } from './sheet.js';
import { Captions, errorLine } from './captions.js';
import { Tunelio } from './tunelio.js';
import { Playback, progressiveChecker } from './playback.js';
import { TunelioCaptions } from './transcripts.js';
import { makeAlert } from './alert.js';

const API = 1;
const PAGES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/privacy': ['privacy.html', 'text/html; charset=utf-8'],
  '/logo.png': ['logo.png', 'image/png'],
};
const pageCache = new Map();
function page(path) {
  if (!pageCache.has(path)) pageCache.set(path, readFileSync(new URL('../public/' + PAGES[path][0], import.meta.url)));
  return pageCache.get(path);
}

export function createApp({ config = defaults, store, youtube = defaultYoutube, captions, playback, tunelio, alert, sheetOpts, log = console.log } = {}) {
  store ??= new Store({ path: config.dbPath, shards: config.shards, pool: config.pool, pinHours: config.pinHours });
  const logJson = (o) => log(JSON.stringify({ at: new Date().toISOString(), ...o }));
  alert ??= makeAlert({ webhook: config.alertWebhook, log: logJson });
  tunelio ??= new Tunelio({ key: config.tunelioKey, onCredits: (left) => {
    if (left < config.lowCredits) alert('credits_low', `Tunelio credits are running low: ${left} left this month.`, 24 * 60);
  } });
  playback ??= new Playback({ tunelio, quality: config.tunelioQuality, progressiveMaxSeconds: config.progressiveMaxSeconds,
    checkProgressive: tunelio.enabled ? progressiveChecker() : null, alert, log: logJson });
  if (!captions && tunelio.enabled) captions = new TunelioCaptions({ store, tunelio, cacheDays: config.captionCacheDays, scripts: config.captionScripts, alert, log: logJson });
  const warmCaptions = !tunelio.enabled; // yt-dlp captions are free to warm; Tunelio's cost credits, so only on demand
  captions ??= new Captions({ store, ytdlp: config.ytdlp, extraArgs: config.ytdlpExtraArgs, cacheDays: config.captionCacheDays,
    sourcePrefix: config.sourcePrefix, blockedMinutes: config.blockedMinutes });
  const continuations = new Map(); // `${shard}:${n}` → () => Promise<page>
  const MAX_CONTINUATIONS = 2000;
  const hits = new Map(); // ip → timestamps of recent searches

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
    if (rateLimited(clientIp(req))) return fail(res, 429, 'rate_limited', 'Too many searches, wait a minute.');
    const lang = normalizeLang(url.searchParams.get('l'));
    const query = parseQuery(url.searchParams.get('q') ?? '');
    if (!query) return fail(res, 400, 'empty_query', 'Type something after the arrow.');
    let page;
    const pasted = youtubeIdFrom(query);
    try {
      page = await youtube.search(pasted ?? query, config.resultsPerPage);
    } catch (err) {
      log(JSON.stringify({ at: new Date().toISOString(), event: 'youtube_error', message: String(err?.message ?? err).slice(0, 300) }));
      return fail(res, 502, 'youtube_failed', 'YouTube search is not answering right now.');
    }
    if (pasted) {
      const exact = page.videos.find((v) => v.id === pasted);
      const rest = page.videos.filter((v) => v.id !== pasted);
      page = { videos: [exact ?? { id: pasted, title: pasted, channel: '', length: '', seconds: 0, views: '', age: '', live: false, cc: false }, ...rest], more: page.more };
    }
    return json(res, 200, publish(shard, page, { query, lang, page: 1, pasted: Boolean(pasted) }));
  }

  async function ticket(req, res, shard, n) {
    const t = store.get(shard, n);
    if (!t) return fail(res, 404, 'unknown_ticket', 'Nothing here yet. Search again.');
    if (t.kind === 'video') {
      store.markPlayed(shard, n, t.data.id);
      // Warm the original-language captions so the overlay is ready when people look for it.
      if (warmCaptions) captions.get(t.data.id, 'native').catch(() => {});
      const where = await playback.location(t.data);
      logJson({ event: 'play', shard, n, id: t.data.id, via: where.via, reason: where.reason });
      res.writeHead(302, { location: where.location, 'cache-control': 'no-store' });
      return res.end();
    }
    if (t.kind === 'sheet') {
      const buf = await cachedSheet(`${shard}:${n}:${t.created}`, t.data.ids.map(youtube.thumbnailUrl), config.sheet, sheetOpts);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store' });
      return res.end(buf);
    }
    if (t.kind === 'page') {
      const more = continuations.get(`${shard}:${n}`);
      if (!more) return fail(res, 410, 'expired', 'These results expired. Search again.');
      continuations.delete(`${shard}:${n}`);
      let page;
      try { page = await more(); } catch {
        return fail(res, 502, 'youtube_failed', 'YouTube search is not answering right now.');
      }
      return json(res, 200, publish(shard, page, { page: (t.data.page ?? 1) + 1 }));
    }
    return fail(res, 404, 'unknown_ticket', 'Nothing here yet. Search again.');
  }

  async function caption(req, res, shard, raw, url) {
    const byTrack = /^\d+$/.test(raw);
    if (byTrack && typeof captions.track !== 'function') return fail(res, 404, 'no_tracks', 'Caption tracks are not available.');
    const lang = byTrack ? normalizeLang(url.searchParams.get('l')) : raw === 'native' ? 'native' : (LANGS[raw] ? raw : normalizeLang(raw));
    const last = store.lastPlayed(shard);
    if (!last) return fail(res, 404, 'nothing_playing', 'Nothing from search has played here yet.');
    try {
      const c = byTrack ? await captions.track(last.videoId, Number(raw), lang) : await captions.get(last.videoId, lang);
      return json(res, 200, { v: API, shard, t: last.n, ...c });
    } catch (err) {
      log(JSON.stringify({ at: new Date().toISOString(), event: 'captions_error', id: last.videoId, lang, message: errorLine(err) }));
      return fail(res, 502, 'captions_failed', 'Captions are not available right now.');
    }
  }

  return async function handler(req, res) {
    const started = Date.now();
    let route = 'other';
    res.on('finish', () => log(JSON.stringify({ at: new Date().toISOString(), route, status: res.statusCode, ms: Date.now() - started })));
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method', 'GET only.');
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/healthz') { route = 'health'; return json(res, 200, { ok: true, v: API, tunelio: tunelio.enabled, credits: tunelio.credits }); }
      const pagePath = url.pathname === '/privacy.html' ? '/privacy' : url.pathname;
      if (PAGES[pagePath]) {
        route = 'page';
        const buf = page(pagePath);
        res.writeHead(200, { 'content-type': PAGES[pagePath][1], 'content-length': buf.length, 'cache-control': 'public, max-age=3600' });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      }
      const m = url.pathname.match(/^\/v1\/(\d+)\/(s|cc\/(?:[A-Za-z-]+|\d{1,3})|\d+)\/?$/);
      if (!m) return fail(res, 404, 'not_found', 'Unknown path.');
      const shard = Number(m[1]);
      if (!store.validShard(shard)) return fail(res, 404, 'bad_shard', 'Unknown shard.');
      if (m[2] === 's') { route = 'search'; return await search(req, res, shard, url); }
      if (m[2].startsWith('cc/')) { route = 'captions'; return await caption(req, res, shard, m[2].slice(3), url); }
      const n = Number(m[2]);
      if (!store.validTicket(n)) return fail(res, 404, 'unknown_ticket', 'Unknown ticket.');
      route = 'ticket';
      return await ticket(req, res, shard, n);
    } catch (err) {
      log(JSON.stringify({ at: new Date().toISOString(), event: 'error', route, message: String(err?.stack ?? err).slice(0, 500) }));
      if (!res.headersSent) fail(res, 500, 'server_error', 'Something went wrong.');
      else res.end();
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const app = createApp();
  http.createServer(app).listen(defaults.port, defaults.host, () => {
    console.log(`japharsworld-yt listening on ${defaults.host}:${defaults.port} (${defaults.shards} shards × ${defaults.pool} tickets)`);
  });
}
