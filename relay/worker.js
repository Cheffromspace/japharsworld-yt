// Search, caption and media relay worker (runs at home, on the owner's Optiplex). It never listens on a port: it
// long-polls RELAY_URL/relay/next over HTTPS for jobs, runs them from this residential connection (search through
// InnerTube, src/youtube.js, so videos come out exactly as on the server; captions through yt-dlp, relay/captions.js;
// media through yt-dlp and ffmpeg, relay/media.js) and posts the results to RELAY_URL/relay/done.
// Settings (environment, /etc/japharsworld-yt-relay.env): RELAY_URL, RELAY_TOKEN, WORKER_NAME, RELAY_POLLS (3),
// YTDLP (found in the flash-check venv or PATH when unset), YTDLP_ARGS (--js-runtimes node), FFMPEG (ffmpeg),
// RELAY_MEDIA (on; off = never announce media jobs), RELAY_MEDIA_MAX (2 streams at once), RELAY_CACHE_GB (40; 0 = no
// cache of finished streams, relay/cache.js) in RELAY_CACHE_DIR (else systemd's CACHE_DIRECTORY), YT_BACKOFF_MINUTES (10)
// and YT_BACKOFF_MAX_MINUTES (120): how long a kind of job pauses after YouTube refuses it (see refused() below).
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { youtube as defaultYoutube, resetClient } from '../src/youtube.js';
import { captionsJob, findYtdlp, ytdlpArgs } from './captions.js';
import { mediaJob } from './media.js';
import { MediaCache } from './cache.js';
import { txBytes as defaultTxBytes } from '../src/net.js';
import { refusalClass } from '../src/refusal.js';

const CONT_MINUTES = 30;
const MAX_CONTS = 2000;
const is403 = (err) => /status code 403\b/.test(String(err?.message ?? err));
// Kinds of job that pause on their own; `more` is a search.
export const PAUSE_KINDS = ['search', 'captions', 'media'];
const pauseKind = (kind) => (kind === 'more' ? 'search' : kind);

export function createWorker({ url, token, name = 'worker', version = '', polls = 3, youtube = defaultYoutube, reset = resetClient,
  txBytes = defaultTxBytes, captions = null, ytdlp = null, ytdlpExtraArgs = ytdlpArgs(), media = null, caps = [], mediaMax = 2, ffmpeg = 'ffmpeg', cache = null,
  backoffMinutes = 10, backoffMaxMinutes = 120, fetcher = fetch, log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o })), now = () => Date.now(),
  sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); }) }) {
  // Caption jobs: an injected function (tests) or yt-dlp, found once on first use.
  let ytdlpPath = ytdlp;
  const runCaptions = captions ?? (async (job) => {
    ytdlpPath ??= await findYtdlp();
    return captionsJob(job, { ytdlp: ytdlpPath, extraArgs: ytdlpExtraArgs, log });
  });
  const base = String(url).replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${token}` };
  // Media jobs: an injected function (tests) or relay/media.js, at most mediaMax streams at once.
  let streaming = 0;
  const runMedia = media ?? (async (job) => {
    ytdlpPath ??= await findYtdlp();
    const upload = async (file, body, type, { cached = false } = {}) => {
      const res = await fetcher(`${base}/relay/media/${job.token}/${file}`, { method: 'PUT',
        headers: { ...headers, 'content-type': type, ...(cached ? { 'x-media-cached': '1' } : {}) }, body,
        signal: AbortSignal.timeout(60_000) });
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return res.status;
    };
    const attempt = () => mediaJob(job, { ytdlp: ytdlpPath, ffmpeg, extraArgs: ytdlpExtraArgs, upload, cache, log: (o) => log({ ...o, quality: job.quality }) });
    // ffmpeg that can't open the streams: once more from a fresh yt-dlp resolve (2026-10-23, 1 of 8 test videos: its
    // fresh stream URLs answered 403 for a minute or two).
    return attempt().catch((err) => (/ffmpeg exited/.test(err?.message ?? '') ? attempt() : Promise.reject(err)));
  });
  const conts = new Map(); // id → { more, at }

  // Back-off (YouTube risk fix 3, owner 2026-10-25), like the Linode's blockedUntil in src/captions.js: a bot, rate or
  // potoken refusal pauses that kind for backoffMinutes, the next refusal after it (no success between) for twice as
  // long, up to backoffMaxMinutes; a success ends the streak. A bot wall on captions or media pauses both (the same
  // yt-dlp from the same IP). A 403 left after once()'s reset pauses search for 2 minutes only: InnerTube session
  // trouble, not a verdict on the IP. Polls and answers carry `paused`, so the server skips this worker for that kind.
  const pauses = new Map(); // kind → { until, minutes }
  const pausedNow = (kind) => (pauses.get(kind)?.until ?? 0) > now();
  function paused() {
    const t = now();
    return PAUSE_KINDS.filter(pausedNow).map((k) => `${k}:${Math.ceil((pauses.get(k).until - t) / 1000)}`);
  }
  function refused(kind, cls) {
    const t = now();
    if (cls === 'forbidden') {
      if (kind !== 'search') return;
      const p = pauses.get('search');
      pauses.set('search', { until: Math.max(p?.until ?? 0, t + 2 * 60_000), minutes: p?.minutes ?? 0 });
      log({ event: 'backoff', kind, refusal: cls, minutes: 2 });
      return;
    }
    if (!['bot', 'rate', 'potoken'].includes(cls)) return;
    for (const k of cls === 'bot' && kind !== 'search' ? ['captions', 'media'] : [kind]) {
      const p = pauses.get(k);
      if (p?.minutes && p.until > t) continue; // a job that was already running when the pause began
      const minutes = p?.minutes ? Math.min(backoffMaxMinutes, p.minutes * 2) : backoffMinutes;
      pauses.set(k, { until: t + minutes * 60_000, minutes });
      log({ event: 'backoff', kind: k, refusal: cls, minutes });
    }
  }
  function succeeded(kind) {
    if (pauses.delete(kind)) log({ event: 'backoff_cleared', kind });
  }
  const stopping = new AbortController();

  function keep(more) {
    if (!more) return null;
    const t = now();
    for (const [k, v] of conts) if (t - v.at > CONT_MINUTES * 60_000) conts.delete(k); else break;
    const id = randomUUID();
    conts.set(id, { more, at: t });
    while (conts.size > MAX_CONTS) conts.delete(conts.keys().next().value);
    return id;
  }

  async function once(fn) {
    try { return await fn(); } catch (err) {
      if (!is403(err)) throw err;
      reset?.();
      return fn();
    }
  }

  // Job → { id, ok, page: { videos, cont }, error } for search, { id, ok, captions, error } for captions; a failure (or a
// caption track that failed after its list) adds refusal: the src/refusal.js class.
  async function handle(job) {
    const kind = pauseKind(job.kind);
    // Sent before the server learned of the pause: answered at once, and YouTube isn't asked.
    if (PAUSE_KINDS.includes(kind) && pausedNow(kind)) return { id: job.id, ok: false, error: 'paused', paused: paused() };
    const result = await run(job);
    if (result.refusal) refused(kind, result.refusal);
    else if (result.ok) succeeded(kind);
    const p = paused();
    return p.length ? { ...result, paused: p } : result;
  }

  async function run(job) {
    const started = now();
    try {
      let page;
      if (job.kind === 'media') {
        if (!/^[a-f0-9]{18}$/.test(String(job.token ?? ''))) return { id: job.id, ok: false, error: 'bad token' };
        if (streaming >= mediaMax) return { id: job.id, ok: false, error: 'busy' };
        streaming++;
        let first;
        try { first = await runMedia(job); } catch (err) { streaming--; throw err; }
        // The stream goes on uploading after this answer; its slot frees when it ends.
        Promise.resolve(first.done).finally(() => streaming--);
        log({ event: 'job', kind: job.kind, ms: now() - started, segments: first.segments, cached: first.cached || undefined });
        return { id: job.id, ok: true, media: { ready: true, segments: first.segments, cached: !!first.cached } };
      }
      if (job.kind === 'captions') {
        const captions = await runCaptions(job);
        log({ event: 'job', kind: job.kind, ms: now() - started, cues: captions.cues?.length ?? 0, reason: captions.reason });
        // The track failed after its list worked: the usual sign of timedtext being rate-limited.
        return { id: job.id, ok: true, captions, ...(captions.reason === 'temporarily_unavailable' ? { refusal: 'rate' } : {}) };
      }
      if (job.kind === 'search') page = await once(() => youtube.search(String(job.query ?? ''), Math.min(50, Number(job.limit) || 20)));
      else if (job.kind === 'more') {
        const c = conts.get(job.cont);
        if (!c || now() - c.at > CONT_MINUTES * 60_000) { conts.delete(job.cont); return { id: job.id, ok: false, error: 'expired' }; }
        conts.delete(job.cont);
        page = await c.more();
      } else return { id: job.id, ok: false, error: `unknown job kind ${job.kind}` };
      log({ event: 'job', kind: job.kind, ms: now() - started, results: page.videos.length });
      return { id: job.id, ok: true, page: { videos: page.videos, cont: keep(page.more) } };
    } catch (err) {
      const message = String(err?.message ?? err).slice(0, 300);
      const refusal = refusalClass(err); // the server counts the class only (yt_refusal)
      log({ event: 'job_failed', kind: job.kind, ms: now() - started, refusal, message });
      return { id: job.id, ok: false, error: message, refusal };
    }
  }

  async function loop(n) {
    let backoff = 1000;
    const q = new URLSearchParams({ worker: name, version, ...(caps.length ? { caps: caps.join(',') } : {}) });
    while (!stopping.signal.aborted) {
      const p = paused();
      if (p.length) q.set('paused', p.join(',')); else q.delete('paused');
      // This host's bytes sent, for the server's transfer count (src/net.js).
      const tx = txBytes();
      if (Number.isFinite(tx)) q.set('tx', String(tx));
      try {
        const res = await fetcher(`${base}/relay/next?${q}`, { headers, signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(40_000)]) });
        if (res.status === 204) { backoff = 1000; continue; }
        if (res.status === 401) throw new Error('relay refused the token (401)');
        if (!res.ok) throw new Error(`relay answered ${res.status}`);
        const { job } = await res.json();
        backoff = 1000;
        if (!job) continue;
        const result = await handle(job);
        const sent = await fetcher(`${base}/relay/done`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(result), signal: AbortSignal.timeout(15_000) });
        if (!sent.ok) log({ event: 'done_failed', status: sent.status });
      } catch (err) {
        if (stopping.signal.aborted) break;
        log({ event: 'poll_failed', poll: n, retryMs: backoff, message: String(err?.message ?? err).slice(0, 200) });
        await sleep(backoff, stopping.signal);
        backoff = Math.min(30_000, backoff * 2);
      }
    }
  }

  return {
    handle, conts, paused, get streaming() { return streaming; },
    start() { log({ event: 'start', worker: name, version, relay: base, polls, cacheGb: cache?.maxGb ?? 0, cacheDir: cache?.dir }); return Promise.all(Array.from({ length: polls }, (_, i) => loop(i))); },
    stop() { stopping.abort(); },
  };
}

function gitVersion() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { RELAY_URL, RELAY_TOKEN, WORKER_NAME = 'worker', RELAY_POLLS = '3', FFMPEG = 'ffmpeg', RELAY_MEDIA = 'on', RELAY_MEDIA_MAX = '2',
    RELAY_CACHE_GB = '40', RELAY_CACHE_DIR = process.env.CACHE_DIRECTORY,
    YT_BACKOFF_MINUTES = '10', YT_BACKOFF_MAX_MINUTES = '120' } = process.env;
  if (!RELAY_URL || !RELAY_TOKEN) { console.error('Set RELAY_URL and RELAY_TOKEN.'); process.exit(2); }
  // Media jobs only when ffmpeg runs here; the server sends them only to workers that announce caps=media.
  let hasFfmpeg = false;
  try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); hasFfmpeg = true; } catch { /* no ffmpeg */ }
  const caps = RELAY_MEDIA !== 'off' && hasFfmpeg ? ['media'] : [];
  let cache = null;
  if (caps.length && Number(RELAY_CACHE_GB) > 0 && RELAY_CACHE_DIR) {
    const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
    try { cache = new MediaCache({ dir: join(RELAY_CACHE_DIR, 'media'), maxGb: Number(RELAY_CACHE_GB), log }); }
    catch (err) { log({ event: 'media_cache_off', message: String(err?.message ?? err).slice(0, 200) }); }
  }
  const worker = createWorker({ url: RELAY_URL, token: RELAY_TOKEN, name: WORKER_NAME, version: gitVersion(), polls: Number(RELAY_POLLS) || 3,
    caps, ffmpeg: FFMPEG, mediaMax: Number(RELAY_MEDIA_MAX) || 2, cache,
    backoffMinutes: Number(YT_BACKOFF_MINUTES) || 10, backoffMaxMinutes: Number(YT_BACKOFF_MAX_MINUTES) || 120 });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { worker.stop(); setTimeout(() => process.exit(0), 500).unref(); });
  worker.start();
}
