// Tunelio speed probe (owner, 2026-10-21: track Tunelio's performance over time to inform decisions; first hourly,
// then every 20 minutes: "I'm paying for the service and I need it to be reliable"). On 2026-10-21 progressive builds of ~1 GB took 30–120 s, 2–6× slower than the
// 2026-10-19 measurements (claude/play-latency.md), and visitors' builds alone are too few to show a trend.
//
// Once per interval (at least 20 minutes, plus a random quarter of it up to 10 minutes, never on the clock) and only while no visitor's
// build or held player is in flight: one search through the relay worker (never the Linode's InnerTube or the Data
// API), a 12–30 minute video from it that this process has not probed before, one /create (10 credits), then what a
// player waits for: the first byte of the progressive mp4, or the HLS playlist and its first segment, alternating
// between the two by run. Each run is a poller row (source `tunelio:progressive` or `tunelio:hls`; numbers only, no
// video ID), which the exporter sends to Grafana as `eiok_poll`.

const QUERIES = ['documentary', 'video essay', 'history explained', 'science explained', 'cooking', 'travel vlog',
  'nature documentary', 'interview', 'lecture', 'short film', 'car review', 'game review'];
const WARM_MS = 2000; // a first byte this fast means Tunelio already had the file: not a build, so not a speed sample

export class TunelioProbe {
  constructor({ tunelio, search, busy = () => 0, record = () => {}, meta, intervalMinutes = 20, quality = '1080p',
    fetcher = fetch, log = () => {}, now = () => Date.now(), random = Math.random,
    minSeconds = 12 * 60, maxSeconds = 30 * 60, timeoutMs = 150_000, queries = QUERIES }) {
    this.tunelio = tunelio;
    this.search = search;       // (query, limit) → page { videos } or null (no worker)
    this.busy = busy;           // > 0 while a visitor's build or held player is in flight
    this.record = record;       // (source, values) → poller row
    const kept = new Map();
    this.meta = meta ?? { get: (k) => kept.get(k) ?? null, set: (k, v) => kept.set(k, String(v)) };
    this.intervalMs = intervalMinutes > 0 ? Math.max(20, intervalMinutes) * 60_000 : 0;
    this.quality = quality;
    this.fetch = fetcher;
    this.log = log;
    this.now = now;
    this.random = random;
    this.minSeconds = minSeconds;
    this.maxSeconds = maxSeconds;
    this.timeoutMs = timeoutMs;
    this.queries = queries;
    this.seen = new Set();      // video IDs probed by this process (memory only: IDs never reach the database)
    this.running = false;
    this.timer = null;
  }

  // Due time, kept in the metrics database so a restart (every deploy) neither probes early nor resets the clock.
  #next() { return Number(this.meta.get('tunelio_probe_next')) || 0; }
  #schedule(ms) { this.meta.set('tunelio_probe_next', Math.round(this.now() + ms)); }
  #jitter() { return this.random() * Math.min(10 * 60_000, this.intervalMs / 4); }

  // Called every few minutes: probes when due and quiet.
  async tick() {
    if (!this.intervalMs || this.running) return null;
    if (!this.#next()) { this.#schedule(10 * 60_000 + this.#jitter()); return null; } // first start: not at once
    if (this.now() < this.#next() || this.busy() > 0) return null;
    this.running = true;
    try { return await this.runOnce(); } finally { this.running = false; }
  }

  async runOnce() {
    const video = await this.#pick();
    if (!video) {
      this.log({ event: 'tunelio_probe', skipped: 'no_video' });
      this.#schedule(15 * 60_000);
      return null;
    }
    const n = Number(this.meta.get('tunelio_probe_runs')) || 0;
    const format = n % 2 ? 'hls' : 'progressive';
    // Spend only after the next run is booked, so a crash mid-probe can't raise the rate.
    this.meta.set('tunelio_probe_runs', n + 1);
    this.#schedule(this.intervalMs + this.#jitter());
    this.seen.add(video.id);
    if (this.seen.size > 5000) this.seen.clear();
    const source = `tunelio:${format}`;
    const t0 = this.now();
    let made;
    try { made = await this.tunelio.create(video.id, this.quality); } catch (err) {
      this.log({ event: 'tunelio_probe', format, id: video.id, ok: false, step: 'create', status: err.status, code: err.code });
      this.record(source, { ok: 0 });
      return { format, ok: false };
    }
    const createMs = this.now() - t0;
    const mb = Math.round((made.fileSize ?? 0) / 1e5) / 10;
    const url = made.url + (format === 'hls' ? '&hls=1' : '&progressive=1');
    const t1 = this.now();
    let r;
    try { r = format === 'hls' ? await this.#hlsStart(url, t1) : await this.#firstByte(url); } catch (err) { r = { ok: false, error: String(err?.name ?? err) }; }
    const startMs = this.now() - t1;
    const warm = r.ok && startMs < WARM_MS;
    this.log({ event: 'tunelio_probe', format, id: video.id, seconds: video.seconds, quality: made.quality || this.quality, mb, createMs, startMs,
      playlistMs: r.playlistMs, ok: r.ok, warm, status: r.status, error: r.error });
    const values = { ok: r.ok ? 1 : 0, warm: warm ? 1 : 0, create_s: createMs / 1000, mb, minutes: Math.round(video.seconds / 6) / 10 };
    if (r.ok && !warm) {
      values.start_s = startMs / 1000;
      if (mb > 0) values.mb_per_s = Math.round(mb / (startMs / 1000) * 10) / 10;
      if (r.playlistMs != null) values.playlist_s = r.playlistMs / 1000;
    }
    this.record(source, values);
    return { format, ok: r.ok, warm, mb, createMs, startMs };
  }

  async #pick() {
    const start = Math.floor(this.random() * this.queries.length);
    for (let i = 0; i < 2; i++) {
      const query = this.queries[(start + i) % this.queries.length];
      let page;
      try { page = await this.search(query, 20); } catch (err) {
        this.log({ event: 'tunelio_probe', skipped: 'search_failed', message: String(err?.message ?? err).slice(0, 200) });
        return null;
      }
      if (!page) return null; // no relay worker: don't search from the Linode for this
      const fits = (page.videos ?? []).filter((v) => !v.live && v.seconds >= this.minSeconds && v.seconds <= this.maxSeconds && !this.seen.has(v.id));
      if (fits.length) return fits[Math.floor(this.random() * fits.length)];
    }
    return null;
  }

  #signal(started) { return AbortSignal.timeout(Math.max(1000, this.timeoutMs - (this.now() - started))); }

  // The first byte of a progressive link: Tunelio builds the whole file before it answers.
  async #firstByte(url, started = this.now()) {
    const res = await this.fetch(url, { headers: { range: 'bytes=0-0' }, signal: this.#signal(started) });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { ok: res.status === 200 || res.status === 206, status: res.status };
  }

  async #text(url, started) {
    const res = await this.fetch(url, { signal: this.#signal(started) });
    if (res.status !== 200) { try { await res.body?.cancel(); } catch { /* ignore */ } return { status: res.status, text: null }; }
    return { status: res.status, text: await res.text() };
  }

  // HLS: the playlist (a master playlist's first variant), then the first byte of its first segment, which is when a
  // player could start.
  async #hlsStart(url, started) {
    let base = url;
    let p = await this.#text(base, started);
    if (p.text && /#EXT-X-STREAM-INF/.test(p.text)) {
      const variant = p.text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (variant) { base = new URL(variant, base).href; p = await this.#text(base, started); }
    }
    const playlistMs = this.now() - started;
    if (!p.text) return { ok: false, status: p.status, playlistMs };
    const segment = p.text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (!segment) return { ok: false, status: p.status, playlistMs, error: 'no_segment' };
    const r = await this.#firstByte(new URL(segment, base).href, started);
    return { ...r, playlistMs };
  }

  start(everyMs = 5 * 60_000) {
    if (!this.intervalMs) return this;
    this.timer ??= setInterval(() => { this.tick().catch((err) => this.log({ event: 'tunelio_probe', error: String(err?.message ?? err).slice(0, 200) })); }, everyMs);
    this.timer.unref?.();
    return this;
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}
