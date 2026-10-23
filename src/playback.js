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

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const watch = (id) => `https://www.youtube.com/watch?v=${id}`;

// Build time follows the file size, not the length: Tunelio pulls the media at roughly 60 MB/s (2026-10-19:
// 220 MB in 4 s, 915 MB in 16 s, 3.5 GB in 58 s; a 2 GB progressive build failed with 503 after 115 s). /create
// answers with the size before the build starts, so the ETA and the quality/format choice can use it. These priors
// are per format: seconds per MB, plus a fixed part. Learned from every finished build (EWMA).
const RATE_PRIOR = { progressive: 0.017, hls: 0.03 };
const FIXED_PRIOR = { progressive: 2, hls: 3 };
// A build this quick was already at Tunelio (another visitor's, or ours a little earlier) and says nothing about how
// fast Tunelio builds: 2026-10-23, 3FJctU--OxI's builds again at 0.5–2 s (456–751 MB, "46–1600 MB/s") made the median of
// the last five ~260 MB/s, so the next fresh video (rI9x6DvOaao, 613 MB) was predicted 12 s and took 84 s. The quickest
// fresh builds seen took 3.4 s (30 MB at 360p); the fastest real speed seen was ~82 MB/s.
export const cachedBuild = (mb, buildMs) => buildMs < 3000 || mb / (buildMs / 1000) > 120;

export class Playback {
  constructor({ tunelio, quality = '1080p', lowerQuality = '720p', maxMbForQuality = 1500, progressiveMaxMb = 1800,
    progressiveMaxSeconds = 3 * 3600, marginSeconds = 20 * 60,
    pauseMinutes = 10, alert = () => {}, log = () => {}, now = () => Date.now(), probe = null, onBuild = () => {}, stateFile = null }) {
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
    this.jobs = new Map();     // "videoId@quality[@hls]" → job
    this.creates = new Map();  // "videoId@quality" → { promise, made }: the paid /create, shared
    this.speeds = [];          // recent build speeds { at, mbps }, newest last
    this.pausedUntil = 0;      // after out-of-credits / auth errors, skip Tunelio for a while
    // Learned build speed per format: seconds of build per second of video, and the fixed part. EWMA over builds.
    this.rate = { ...RATE_PRIOR };
    this.fixed = { ...FIXED_PRIOR };
    // What was learned survives a restart (every deploy is one): before 2026-10-23 a restart dropped the recent speeds
    // and went back to the priors (~33 MB/s at HLS, when that day's real builds ran at 3–7 MB/s), so the first plays
    // after a deploy were planned as if Tunelio were fast. Speeds and learned rates only: no video IDs.
    this.stateFile = stateFile;
    this.#load();
  }

  #load() {
    if (!this.stateFile) return;
    let st;
    try { st = JSON.parse(readFileSync(this.stateFile, 'utf8')); } catch { return; }
    const since = this.now() - 2 * 3600_000;
    this.speeds = (Array.isArray(st.speeds) ? st.speeds : [])
      .filter((x) => Number.isFinite(x?.at) && x.at >= since && x.mbps > 0 && x.mbps <= 120).slice(-50);
    for (const f of Object.keys(RATE_PRIOR)) {
      if (st.rate?.[f] > 0) this.rate[f] = st.rate[f];
      if (st.fixed?.[f] > 0) this.fixed[f] = st.fixed[f];
    }
  }

  #save() {
    if (!this.stateFile) return;
    try {
      writeFileSync(`${this.stateFile}.tmp`, JSON.stringify({ speeds: this.speeds, rate: this.rate, fixed: this.fixed }));
      renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (err) { this.log({ event: 'speed_state_failed', message: String(err?.message ?? err).slice(0, 200) }); }
  }

  // More measured speeds from elsewhere (server.js: the probe's stored builds), merged in time order.
  seedSpeeds(rows) {
    const have = new Set(this.speeds.map((x) => x.at));
    for (const r of rows) if (r.mbps > 0 && r.mbps <= 120 && !have.has(r.at)) this.speeds.push({ at: r.at, mbps: r.mbps });
    this.speeds.sort((a, b) => a.at - b.at);
    if (this.speeds.length > 50) this.speeds.splice(0, this.speeds.length - 50);
  }

  // Static answers that need no build: live streams, Tunelio off or paused.
  #direct(data) {
    const id = data.id;
    if (data.live) return { location: watch(id), via: 'youtube', reason: 'live' };
    if (!this.tunelio?.enabled) return { location: watch(id), via: 'youtube', reason: 'disabled' };
    if (this.now() < this.pausedUntil) return { location: watch(id), via: 'youtube', reason: 'paused' };
    return null;
  }

  // Jobs are kept per video, quality and kind: `hls` jobs are the adaptive playlist's variants (src/adaptive.js), always
  // HLS and never re-made at another quality; `maxMb` gives up on a file larger than that (a 1080p upgrade that would
  // not finish before Tunelio's ~2-minute limit).
  #key(data, quality, hls) { return `${data.id}@${quality}${hls ? '@hls' : ''}`; }

  // The job for a video at a quality, if there is one (no build is started).
  peek(data, quality = this.quality, { hls = false } = {}) { return this.jobs.get(this.#key(data, quality, hls)) ?? null; }

  // The job for a video at a quality, started if there is none (or the old one expired or failed long enough ago to
  // retry). ticket data: { id, live?, seconds? }
  start(data, quality = this.quality, { hls = false, maxMb = 0 } = {}) {
    const id = data.id;
    const key = this.#key(data, quality, hls);
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
    const format = hls || seconds > this.progressiveMaxSeconds ? 'hls' : 'progressive';
    job = { id, seconds, format, fixed: hls, maxMb, mb: 0, requested: quality, quality, state: 'building', startedMs: now, endedMs: 0, url: null, expiresMs: 0, reason: null, waiters: [] };
    job.promise = this.#build(job).finally(() => { for (const w of job.waiters) w(); job.waiters = []; });
    this.jobs.set(key, job);
    return job;
  }

  // One paid /create per video and quality while its link lasts, shared by the progressive and HLS builds of it (the
  // same link serves both: &progressive=1 or &hls=1) and by planning (src/adaptive.js reads the size first).
  // The size of a quality whose /create has already answered, in MB, else null (no call).
  knownMb(id, quality) {
    const fileSize = this.creates.get(`${id}@${quality}`)?.made?.fileSize;
    return fileSize > 0 ? Math.round(fileSize / 1e5) / 10 : null;
  }

  made(id, quality) {
    const key = `${id}@${quality}`;
    const hit = this.creates.get(key);
    if (hit && (!hit.made || hit.made.expires * 1000 - this.marginMs > this.now())) return hit.promise;
    const entry = { made: null };
    entry.promise = this.tunelio.create(id, quality).then((m) => { entry.made = m; return m; }, (err) => { this.creates.delete(key); throw err; });
    this.creates.set(key, entry);
    if (this.creates.size > 4000) for (const [k, e] of this.creates) if (e.made && e.made.expires * 1000 < this.now()) this.creates.delete(k);
    return entry.promise;
  }

  // The file size Tunelio reports for a video at a quality, in MB (costs the /create, which the build then reuses).
  async size(data, quality) {
    const m = await this.made(data.id, quality);
    return Math.round((m.fileSize ?? 0) / 1e5) / 10;
  }

  // Seconds a build of this many MB is expected to take. Tunelio's speed swings with the hour (2026-10-22: 35–82 MB/s at
  // 00:45 UTC, 4–6 MB/s for every build from 01:28 to 01:42), so the median speed of the last few builds within two hours
  // (visitors' and the probe's) beats the long-run average; with fewer than two, the learned average.
  predict(format, mb) {
    const recent = this.#recent();
    if (recent.length >= 2) return this.fixed[format] + Math.max(0, mb) / recent[Math.floor(recent.length / 2)];
    return this.fixed[format] + this.rate[format] * Math.max(0, mb);
  }

  // Whether predict() rests on measured builds (two or more in the last two hours) rather than the learned average,
  // which after a restart is the prior, ~33 MB/s at HLS (2026-10-23: real builds that day were 3–7 MB/s).
  measured() { return this.#recent().length >= 2; }

  #recent() {
    const since = this.now() - 2 * 3600_000;
    return this.speeds.filter((x) => x.at >= since).slice(-5).map((x) => x.mbps).sort((a, b) => a - b);
  }

  // A measured build speed (MB/s): small files are mostly fixed overhead, so only 20 MB and up count.
  speed(mb, buildMs, at = this.now()) {
    if (!(mb >= 20) || !(buildMs > 0)) return;
    this.speeds.push({ at, mbps: mb / (buildMs / 1000) });
    if (this.speeds.length > 50) this.speeds.shift();
  }

  // Learn from a finished build (visitors' and the speed probe's): split the time into a fixed part and a per-MB
  // part, nudging both toward this build.
  learn(format, mb, buildMs) {
    if (!(mb > 0) || !(buildMs > 500) || !this.rate[format] || cachedBuild(mb, buildMs)) return;
    this.speed(mb, buildMs);
    const fixed = this.fixed[format], rate = this.rate[format];
    const k = Math.min(3, Math.max(0.3, buildMs / 1000 / Math.max(1, fixed + rate * mb))); // > 1: slower than predicted
    this.rate[format] = Math.max(0.0005, rate * (0.7 + 0.3 * k));
    this.fixed[format] = Math.max(1, fixed * (0.7 + 0.3 * k));
    this.#save();
  }

  async #create(job, quality) {
    const made = await this.made(job.id, quality);
    job.quality = made.quality || quality;
    job.mb = Math.round((made.fileSize ?? 0) / 1e5) / 10;
    return made;
  }

  async #build(job) {
    const id = job.id;
    let made;
    try {
      made = await this.#create(job, job.requested);
      if (job.fixed && job.maxMb && job.mb > job.maxMb) return this.#finish(job, { ok: false, reason: 'too_big' });
      if (!job.fixed && job.mb > this.maxMbForQuality && this.lowerQuality && this.lowerQuality !== job.requested) {
        this.log({ event: 'build_downgrade', id, mb: job.mb, from: job.quality, to: this.lowerQuality });
        made = await this.#create(job, this.lowerQuality);
      }
      if (!job.fixed && job.format === 'progressive' && job.mb > this.progressiveMaxMb) job.format = 'hls';
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
    // /create answered: the all-clear for whichever of these alerted (sent only if it did).
    this.alert.resolve?.('tunelio_down', 'Tunelio works again: videos play in HD.');
    this.alert.resolve?.('credits_out', 'Tunelio has credits again: HD playback and captions are back.');
    this.alert.resolve?.('auth', 'Tunelio accepts the API key again: videos play in HD.');
    const expiresMs = made.expires * 1000 || this.now() + 3600_000;
    const link = (format) => made.url + (format === 'hls' ? '&hls=1' : '&progressive=1');
    if (this.probe) {
      // The first request makes Tunelio build the file; a refused progressive build (413) falls back to HLS.
      // status: Tunelio's answer when it fails (0 = no answer: timeout or network, `error` says which), logged with the
      // failure. 2026-10-23: 1080p HLS builds failed after 115–128 s, and one after 63 s, without a record of why.
      const tryProbe = async (url) => {
        try { return await this.probe(url); } catch (err) { return { ok: false, refused: false, status: 0, error: err?.name ?? 'error' }; }
      };
      let r = await tryProbe(link(job.format));
      if (!r.ok && r.refused && job.format === 'progressive') {
        job.format = 'hls';
        r = await tryProbe(link('hls'));
      }
      if (!r.ok) return this.#finish(job, { ok: false, reason: 'build_failed', url: link(job.format), expiresMs, status: r.status, error: r.error });
    }
    return this.#finish(job, { ok: true, url: link(job.format), expiresMs });
  }

  #finish(job, { ok, reason = null, url = null, expiresMs = 0, status, error }) {
    job.endedMs = this.now();
    job.state = ok ? 'ready' : 'failed';
    job.url = url;
    job.expiresMs = expiresMs;
    job.reason = reason;
    const buildMs = job.endedMs - job.startedMs;
    if (ok) this.learn(job.format, job.mb, buildMs);
    this.log({ event: ok ? 'tunelio_link' : 'build_failed', id: job.id, quality: job.quality, hls: job.format === 'hls', mb: job.mb, buildMs, seconds: job.seconds, reason,
      ...(ok && cachedBuild(job.mb, buildMs) ? { cached: true } : {}), ...(status !== undefined ? { status } : {}), ...(error ? { error } : {}) });
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
  status(data, { warm = true, quality = this.quality, hls = false } = {}) {
    const direct = this.#direct(data);
    if (direct) return { state: direct.reason === 'live' ? 'live' : 'youtube', reason: direct.reason };
    const job = warm ? this.start(data, quality, { hls }) : this.peek(data, quality, { hls });
    if (!job) return { state: 'idle' };
    if (job.state === 'ready') return { state: 'ready', format: job.format, quality: job.quality, mb: job.mb, elapsed: Math.round((job.endedMs - job.startedMs) / 1000) };
    if (job.state === 'failed') return { state: 'failed', format: job.format, reason: job.reason };
    const elapsed = (this.now() - job.startedMs) / 1000;
    const eta = this.etaSeconds(job);
    return { state: 'building', format: job.format, quality: job.quality, mb: job.mb, elapsed: Math.round(elapsed), eta,
      progress: Math.round(Math.min(0.95, elapsed / Math.max(1, elapsed + eta)) * 100) / 100 };
  }

  // Resolves when the job has finished building or after holdMs, whichever is first.
  wait(job, holdMs = Infinity) {
    if (job.state !== 'building') return Promise.resolve(job);
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { if (timer) clearTimeout(timer); resolve(job); };
      job.waiters.push(done);
      if (Number.isFinite(holdMs)) timer = setTimeout(done, Math.max(0, holdMs));
    });
  }

  // Where to send a player. Waits for the build at most `holdMs` (default: for ever, as before).
  //   { location, via: 'tunelio'|'youtube', reason?, ready }  — ready=false means the hold ran out while building.
  async location(data, { holdMs = Infinity, quality = this.quality, hls = false } = {}) {
    const direct = this.#direct(data);
    if (direct) return { ...direct, ready: true };
    const job = this.start(data, quality, { hls });
    await this.wait(job, holdMs);
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
// An Android video player: Quest's AVPro (ExoPlayer) or VizVid's fallback, Android's MediaPlayer ("stagefright"). Both
// pick the format from the URL they were handed, before following redirects (Quest 2, 2026-10-22): a ticket has no
// extension, so it opens as a progressive file and an HLS playlist behind it fails with "Loading failed".
export function isAndroidPlayer(ua = '') {
  const s = String(ua);
  return /Android/i.test(s) && !/Mozilla\//i.test(s) && !/UnityPlayer|UnityWebRequest/i.test(s);
}

export function clientKind(ua = '') {
  const s = String(ua);
  if (/UnityPlayer|UnityWebRequest/i.test(s)) return 'string';
  if (/Mozilla\/.*(Chrome|Firefox|Safari)/i.test(s)) return 'ytdlp';
  if (!s) return 'avpro';
  return /NSPlayer|Windows-Media-Player|MediaFoundation|AVPro|WMFSDK|Microsoft-/i.test(s) ? 'avpro' : 'other';
}
