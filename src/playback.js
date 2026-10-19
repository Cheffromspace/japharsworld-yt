// Where a played ticket sends VRChat.
//   live streams          → youtube.com (VRChat already gets 1080p for live)
//   ordinary videos       → a Tunelio tunnel link: progressive mp4 (full seeking) for videos up to
//                           progressiveMaxSeconds, the HLS playlist over the same media for longer ones
//                           (a progressive file is built on Tunelio's side first and can be refused as too large)
//   anything going wrong  → youtube.com (VRChat's own resolver: 360p, but it plays)
// One tunnel link per video and format is cached until shortly before it expires, so the six people in a room,
// late joiners and replays share one paid /create call. Concurrent requests for the same video share one call.

const watch = (id) => `https://www.youtube.com/watch?v=${id}`;

export class Playback {
  constructor({ tunelio, quality = '1080p', progressiveMaxSeconds = 3 * 3600, marginSeconds = 20 * 60,
    pauseMinutes = 10, alert = () => {}, log = () => {}, now = () => Date.now(), checkProgressive = null }) {
    this.tunelio = tunelio;
    this.quality = quality;
    this.progressiveMaxSeconds = progressiveMaxSeconds;
    this.marginMs = marginSeconds * 1000;
    this.pauseMs = pauseMinutes * 60_000;
    this.alert = alert;
    this.log = log;
    this.now = now;
    // (url) → Promise<boolean>: false when the progressive build is refused (413). Default: none (trust it).
    this.checkProgressive = checkProgressive;
    this.links = new Map();    // videoId → { url, expiresMs, hls }
    this.inflight = new Map(); // videoId → Promise<link|null>
    this.pausedUntil = 0;      // after out-of-credits / auth errors, skip Tunelio for a while
  }

  // ticket data: { id, live?, seconds? } → { location, via: 'tunelio'|'youtube', reason? }
  async location(data) {
    const id = data.id;
    if (data.live) return { location: watch(id), via: 'youtube', reason: 'live' };
    if (!this.tunelio?.enabled) return { location: watch(id), via: 'youtube', reason: 'disabled' };
    if (this.now() < this.pausedUntil) return { location: watch(id), via: 'youtube', reason: 'paused' };
    const cached = this.links.get(id);
    if (cached && cached.expiresMs - this.marginMs > this.now()) return { location: cached.url, via: 'tunelio' };
    if (!this.inflight.has(id)) {
      this.inflight.set(id, this.#resolve(data).finally(() => this.inflight.delete(id)));
    }
    const link = await this.inflight.get(id);
    return link ? { location: link.url, via: 'tunelio' } : { location: watch(id), via: 'youtube', reason: 'tunelio_failed' };
  }

  async #resolve(data) {
    const id = data.id;
    let made;
    try {
      made = await this.tunelio.create(id, this.quality);
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
      return null;
    }
    const long = (data.seconds ?? 0) > this.progressiveMaxSeconds;
    let hls = long;
    if (!hls && this.checkProgressive) {
      try { hls = !(await this.checkProgressive(made.url + '&progressive=1')); } catch { hls = false; }
    }
    const url = made.url + (hls ? '&hls=1' : '&progressive=1');
    const link = { url, expiresMs: made.expires * 1000 || this.now() + 3600_000, hls };
    if (this.links.size > 2000) this.links.clear();
    this.links.set(id, link);
    this.log({ event: 'tunelio_link', id, quality: made.quality, hls, mb: Math.round((made.fileSize ?? 0) / 1e5) / 10 });
    return link;
  }
}

// Asks for the first byte of a progressive link. Tunelio builds the file on that first request (so this also
// warms it before the visitors' players ask), and answers 413 when the video is too large to build.
export function progressiveChecker({ fetcher = fetch, timeoutMs = 20_000 } = {}) {
  return async (url) => {
    const res = await fetcher(url, { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(timeoutMs) });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return res.status !== 413;
  };
}
