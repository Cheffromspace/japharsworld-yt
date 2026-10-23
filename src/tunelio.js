// Tunelio (https://tunelio.dev): a hosted YouTube media API. We use two calls:
//   GET /create?url=&quality=   10 credits → a signed tunnel link (a few hours), streamed from Tunelio's servers
//   GET /transcript?url=&lang=&type=&format=json   6 credits → one caption track + the list of all tracks
// The API key stays on this server; visitors only ever see the tunnel link.
// Failed calls (4xx/5xx) cost nothing. Every successful answer carries X-Credits-Remaining.

export class TunelioError extends Error {
  constructor(status, code, message) {
    super(message || code || `tunelio ${status}`);
    this.status = status;
    this.code = code;
  }
}

export class Tunelio {
  // createTimeoutMs: /create answers in under 2 s (2026-10-19..23); when it doesn't, it usually doesn't at all (two 12 s
  // timeouts in a row cost one play 24 s, 2026-10-23), so it gives up sooner than the other calls. timedOutAt: when a
  // call last timed out (server.js sends plays home for a while after).
  constructor({ key, base = 'https://tunelio.dev', fetcher = fetch, timeoutMs = 12_000, createTimeoutMs = timeoutMs, onCredits = () => {}, onCall = () => {}, now = () => Date.now() }) {
    this.key = key;
    this.base = base.replace(/\/$/, '');
    this.fetch = fetcher;
    this.timeoutMs = timeoutMs;
    this.createTimeoutMs = createTimeoutMs;
    this.now = now;
    this.timedOutAt = 0;
    this.onCredits = onCredits;
    this.onCall = onCall; // ({ path, ok, status, ms }) after every call (metrics)
    this.credits = null; // last X-Credits-Remaining seen
  }

  get enabled() { return Boolean(this.key); }

  async call(path, params, timeoutMs = this.timeoutMs) {
    if (!this.key) throw new TunelioError(0, 'no_key', 'Tunelio is not configured');
    const qs = new URLSearchParams(params).toString();
    const started = Date.now();
    const done = (ok, status) => { try { this.onCall({ path, ok, status, ms: Date.now() - started }); } catch { /* metrics only */ } };
    let res;
    try {
      res = await this.fetch(`${this.base}${path}?${qs}`, {
        headers: { authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      done(false, 0);
      if (err?.name === 'TimeoutError') this.timedOutAt = this.now();
      throw new TunelioError(0, err?.name === 'TimeoutError' ? 'timeout' : 'network', String(err?.message ?? err));
    }
    const left = Number.parseInt(res.headers.get('x-credits-remaining') ?? '', 10);
    if (Number.isFinite(left)) { this.credits = left; this.onCredits(left); }
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !body || (body.status && body.status !== 'ok')) {
      done(false, res.status);
      throw new TunelioError(res.status, body?.error ?? body?.status ?? 'bad_response', body?.message);
    }
    done(true, res.status);
    return body;
  }

  // → { url, expires (unix seconds), quality, fileSize }
  async create(videoId, quality) {
    const b = await this.call('/create', { url: `https://www.youtube.com/watch?v=${videoId}`, quality }, this.createTimeoutMs);
    if (!b.url) throw new TunelioError(200, 'bad_response', 'no url in /create answer');
    return { url: b.url, expires: Number(b.expires) || 0, quality: b.quality, fileSize: b.file_size ?? 0 };
  }

  // → { language, type: 'manual'|'auto', tracks: [{ code, name, auto }], lines: [[start, dur, text]] }
  async transcript(videoId, lang, type = 'any') {
    const b = await this.call('/transcript', { url: videoId, lang, type, format: 'json' });
    return {
      language: b.language ?? '',
      type: b.type ?? (b.is_generated ? 'auto' : 'manual'),
      tracks: (b.available_languages ?? []).map((t) => ({ code: t.code, name: t.name ?? t.code, auto: Boolean(t.is_generated ?? t.type === 'auto') })),
      lines: (b.segments ?? [])
        .map((s) => [round(s.start), round(s.duration), String(s.text ?? '').replace(/\s*\n\s*/g, '\n').trim()])
        .filter((l) => l[2].length > 0),
    };
  }
}

const round = (x) => Math.round((Number(x) || 0) * 100) / 100;
