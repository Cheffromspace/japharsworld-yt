// Where a played ticket sends VRChat, and how long it waits to say so.
//   live streams          → youtube.com (VRChat already gets 1080p for live)
//   ordinary videos       → a Tunelio tunnel link: progressive mp4 (full seeking) first; the HLS playlist over the
//                           same media when Tunelio refuses the mp4 as too large (413) or the video is longer than
//                           progressiveMaxSeconds
//   anything going wrong  → youtube.com (VRChat's own resolver: 360p, but it plays)
//
// Tunelio builds the file on the first request for a link (10–35 s for a 15-minute to 10-hour video, measured
// 2026-10-19). Everything that asks for the link waits on that one build, so the ticket route needs to know, without
// waiting, whether a video is still building, how far along it probably is, and whether a player may be handed the
// link yet. A build is one `job` per video and quality (the room's pick, 720p by default since 2026-10-22): created by
// the first warm or play request, shared by everyone in the room and by late joiners, kept until shortly before the link
// expires.
//
// Why the waiting matters: VRChat resolves every URL with its own yt-dlp first, which gives up after 20 s of silence
// (measured) and only then hands the raw URL to AVPro, which waits on the same build again. So a ticket answer that
// takes longer than ~18 s costs the visitor the whole wait twice. `location()` therefore holds for at most `holdMs`.

const watch = (id) => `https://www.youtube.com/watch?v=${id}`;

// Build time follows the file size, not the length: Tunelio pulls the media at roughly 60 MB/s (2026-10-19:
// 220 MB in 4 s, 915 MB in 16 s, 3.5 GB in 58 s; a 2 GB progressive build failed with 503 after 115 s). /create
// answers with the size before the build starts, so the ETA and the quality/format choice can use it. These priors
// are per format: seconds per MB, plus a fixed part. Learned from every finished build (EWMA).
const RATE_PRIOR = { progressive: 0.017, hls: 0.03 };
const FIXED_PRIOR = { progressive: 2, hls: 3 };

export class Playback {
  constructor({ tunelio, quality = '1080p', lowerQuality = '720p', maxMbForQuality = 1500, progressiveMaxMb = 1800,
    progressiveMaxSeconds = 3 * 3600, marginSeconds = 20 * 60,
    pauseMinutes = 10, alert = () => {}, log = () => {}, now = () => Date.now(), probe = null, onBuild = () => {} }) {
    this.tunelio = tunelio;
    this.quality = quality;
    // A file above maxMbForQuality MB at `quality` is made again at lowerQuality (10 more credits, roughly half the
    // build); above progressiveMaxMb MB (or progressiveMaxSeconds long) it is served as HLS, which Tunelio can build
    // for files the progressive build refuses or times out on.
    this.lowerQuality = lowerQuality;
    this.maxMbForQuality = maxMbForQuality;
    this.progressiveMaxMb = progressiveMaxMb;
    this.progressiveMaxSeconds = progressiveMaxSeconds;
    this.marginMs = marginSeconds * 1000;
    this.pauseMs = pauseMinutes * 60_000;
    this.alert = alert;
    this.log = log;
    this.now = now;
    // (url) → Promise<{ ok, refused }>: asks Tunelio for the first byte, which makes it build the file. `refused`
    // is Tunelio's 413 for a progressive file it won't assemble. Default: none (the link is trusted unbuilt).
    this.probe = probe;
    // ({ id, format, seconds, buildMs, ok }) after every finished build (metrics).
    this.onBuild = onBuild;
    this.jobs = new Map();     // videoId → job
    this.pausedUntil = 0;      // after out-of-credits / auth errors, skip Tunelio for a while
    // Learned build speed per format: seconds of build per second of video, and the fixed part. EWMA over builds.
    this.rate = { ...RATE_PRIOR };
    this.fixed = { ...FIXED_PRIOR };
  }

  // Static answers that need no build: live streams, Tunelio off or paused.
  #direct(data) {
    const id = data.id;
    if (data.live) return { location: watch(id), via: 'youtube', reason: 'live' };
    if (!this.tunelio?.enabled) return { location: watch(id), via: 'youtube', reason: 'disabled' };
    if (this.now() < this.pausedUntil) return { location: watch(id), via: 'youtube', reason: 'paused' };
    return null;
  }

  // The job for a video at a quality, if there is one (no build is started).
  peek(data, quality = this.quality) { return this.jobs.get(`${data.id}@${quality}`) ?? null; }

  // The job for a video at a quality, started if there is none (or the old one expired or failed long enough ago to
  // retry). ticket data: { id, live?, seconds? }
  start(data, quality = this.quality) {
    const id = data.id;
    const key = `${id}@${quality}`;
    const now = this.now();
    let job = this.jobs.get(key);
    if (job) {
      const stale = job.state === 'ready' ? job.expiresMs - this.marginMs <= now
        : job.state === 'failed' ? now - job.endedMs > 30_000 : false;
      if (!stale) return job;
      this.jobs.delete(key);
    }
    if (this.jobs.size > 2000) for (const [k, j] of this.jobs) if (j.state !== 'building') this.jobs.delete(k);
    const seconds = Math.max(0, data.seconds ?? 0);
    const format = seconds > this.progressiveMaxSeconds ? 'hls' : 'progressive';
    job = { id, seconds, format, mb: 0, requested: quality, quality, state: 'building', startedMs: now, endedMs: 0, url: null, expiresMs: 0, reason: null, waiters: [] };
    job.promise = this.#build(job).finally(() => { for (const w of job.waiters) w(); job.waiters = []; });
    this.jobs.set(key, job);
    return job;
  }

  async #create(job, quality) {
    const made = await this.tunelio.create(job.id, quality);
    job.quality = made.quality || quality;
    job.mb = Math.round((made.fileSize ?? 0) / 1e5) / 10;
    return made;
  }

  async #build(job) {
    const id = job.id;
    let made;
    try {
      made = await this.#create(job, job.requested);
      if (job.mb > this.maxMbForQuality && this.lowerQuality && this.lowerQuality !== job.requested) {
        this.log({ event: 'build_downgrade', id, mb: job.mb, from: job.quality, to: this.lowerQuality });
        made = await this.#create(job, this.lowerQuality);
      }
      if (job.format === 'progressive' && job.mb > this.progressiveMaxMb) job.format = 'hls';
    } catch (err) {
      this.log({ event: 'tunelio_error', id, status: err.status, code: err.code, message: String(err.message).slice(0, 200) });
      if (err.status === 402 || err.status === 401) {
        this.pausedUntil = this.now() + this.pauseMs;
        this.alert(err.status === 402 ? 'credits_out' : 'auth',
          err.status === 402
            ? 'Tunelio is out of credits: search videos now play through YouTube at 360p.'
            : 'Tunelio refused the API key: search videos now play through YouTube at 360p.');
      } else if (err.status === 503 || err.status >= 500 || err.status === 0) {
        this.alert('tunelio_down', `Tunelio is failing (${err.status || err.code}); videos fall back to YouTube at 360p.`);
      }
      return this.#finish(job, { ok: false, reason: 'tunelio_failed' });
    }
    const expiresMs = made.expires * 1000 || this.now() + 3600_000;
    const link = (format) => made.url + (format === 'hls' ? '&hls=1' : '&progressive=1');
    if (this.probe) {
      // The first request makes Tunelio build the file; a refused progressive build (413) falls back to HLS.
      let r;
      try { r = await this.probe(link(job.format)); } catch { r = { ok: false, refused: false }; }
      if (!r.ok && r.refused && job.format === 'progressive') {
        job.format = 'hls';
        try { r = await this.probe(link('hls')); } catch { r = { ok: false, refused: false }; }
      }
      if (!r.ok) return this.#finish(job, { ok: false, reason: 'build_failed', url: link(job.format), expiresMs });
    }
    return this.#finish(job, { ok: true, url: link(job.format), expiresMs });
  }

  #finish(job, { ok, reason = null, url = null, expiresMs = 0 }) {
    job.endedMs = this.now();
    job.state = ok ? 'ready' : 'failed';
    job.url = url;
    job.expiresMs = expiresMs;
    job.reason = reason;
    const buildMs = job.endedMs - job.startedMs;
    if (ok && job.mb > 0 && buildMs > 500) {
      // Learn: split the time into a fixed part and a per-MB part, nudging both toward this build.
      const f = job.format;
      const fixed = this.fixed[f], rate = this.rate[f];
      const predicted = fixed + rate * job.mb;
      const k = Math.min(3, Math.max(0.3, buildMs / 1000 / Math.max(1, predicted))); // > 1: slower than predicted
      this.rate[f] = Math.max(0.0005, rate * (0.7 + 0.3 * k));
      this.fixed[f] = Math.max(1, fixed * (0.7 + 0.3 * k));
    }
    this.log({ event: ok ? 'tunelio_link' : 'build_failed', id: job.id, quality: job.quality, hls: job.format === 'hls', mb: job.mb, buildMs, seconds: job.seconds, reason });
    try { this.onBuild({ id: job.id, format: job.format, quality: job.quality, seconds: job.seconds, mb: job.mb, buildMs, ok }); } catch { /* metrics only */ }
    return job;
  }

  etaSeconds(job) {
    // Before /create answers the size is unknown: guess 150 MB for every 10 minutes (a typical 1080p music video).
    const mb = job.mb > 0 ? job.mb : Math.max(60, job.seconds / 600 * 150);
    const total = this.fixed[job.format] + this.rate[job.format] * mb;
    return Math.max(2, Math.round(total - (this.now() - job.startedMs) / 1000));
  }

  // What the tablet shows while a video is prepared. Never waits. `warm` starts the build when there is none.
  //   { state: 'live'|'youtube'|'building'|'ready'|'failed', format?, elapsed?, eta?, progress? }
  status(data, { warm = true, quality = this.quality } = {}) {
    const direct = this.#direct(data);
    if (direct) return { state: direct.reason === 'live' ? 'live' : 'youtube', reason: direct.reason };
    const job = warm ? this.start(data, quality) : this.peek(data, quality);
    if (!job) return { state: 'idle' };
    if (job.state === 'ready') return { state: 'ready', format: job.format, quality: job.quality, mb: job.mb, elapsed: Math.round((job.endedMs - job.startedMs) / 1000) };
    if (job.state === 'failed') return { state: 'failed', format: job.format, reason: job.reason };
    const elapsed = (this.now() - job.startedMs) / 1000;
    const eta = this.etaSeconds(job);
    return { state: 'building', format: job.format, quality: job.quality, mb: job.mb, elapsed: Math.round(elapsed), eta,
      progress: Math.round(Math.min(0.95, elapsed / Math.max(1, elapsed + eta)) * 100) / 100 };
  }

  // Where to send a player. Waits for the build at most `holdMs` (default: for ever, as before).
  //   { location, via: 'tunelio'|'youtube', reason?, ready }  — ready=false means the hold ran out while building.
  async location(data, { holdMs = Infinity, quality = this.quality } = {}) {
    const direct = this.#direct(data);
    if (direct) return { ...direct, ready: true };
    const job = this.start(data, quality);
    if (job.state === 'building') {
      await new Promise((resolve) => {
        let timer = null;
        const done = () => { if (timer) clearTimeout(timer); resolve(); };
        job.waiters.push(done);
        if (Number.isFinite(holdMs)) timer = setTimeout(done, Math.max(0, holdMs));
      });
    }
    if (job.state === 'building') return { location: job.url, via: 'tunelio', reason: 'building', ready: false };
    if (job.state === 'ready') return { location: job.url, via: 'tunelio', quality: job.quality, ready: true };
    return { location: watch(data.id), via: 'youtube', reason: job.reason ?? 'tunelio_failed', ready: true };
  }
}

// Asks for the first byte of a link. Tunelio builds the file on that first request (so this is the build),
// and answers 413 when a progressive file is too large to assemble. Timeout: builds can take over a minute for
// very long videos.
export function linkProbe({ fetcher = fetch, timeoutMs = 150_000 } = {}) {
  return async (url) => {
    const res = await fetcher(url, { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(timeoutMs) });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { ok: res.status === 200 || res.status === 206, refused: res.status === 413, status: res.status };
  };
}

// Which kind of client is asking for a ticket, by User-Agent:
//   string — VRChat's string/image downloader (UnityWebRequest): the tablet warming or watching a build
//   ytdlp  — VRChat's resolver (a Chrome-like UA)
//   avpro  — the AVPro / Media Foundation player itself (anything else that isn't a browser-like UA)
export function clientKind(ua = '') {
  const s = String(ua);
  if (/UnityPlayer|UnityWebRequest/i.test(s)) return 'string';
  if (/Mozilla\/.*(Chrome|Firefox|Safari)/i.test(s)) return 'ytdlp';
  if (!s) return 'avpro';
  return /NSPlayer|Windows-Media-Player|MediaFoundation|AVPro|WMFSDK|Microsoft-/i.test(s) ? 'avpro' : 'other';
}
