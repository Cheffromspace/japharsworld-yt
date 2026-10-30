// Tunelio speed probe (owner, 2026-10-21: track Tunelio's performance over time to inform decisions; first hourly,
// then every 20 minutes: "I'm paying for the service and I need it to be reliable"; hourly again from 2026-10-23, as
// 20 minutes cost ~720 credits a day). On 2026-10-21 progressive builds of ~1 GB took 30–120 s, 2–6× slower than the
// 2026-10-19 measurements (claude/play-latency.md), and visitors' builds alone are too few to show a trend.
//
// Once per interval (at least 20 minutes, plus a random quarter of it up to 10 minutes, never on the clock) and only while no visitor's
// build or held player is in flight: one search through the relay worker (never the Linode's InnerTube or the Data
// API), a 12–30 minute video from it that this process has not probed before, one /create (10 credits), then what a
// player waits for: the first byte of the progressive mp4, or the HLS playlist and its first segment, alternating
// between the two by run. Each run is a poller row (source `tunelio:progressive` or `tunelio:hls`; numbers only, no
// video ID), which the exporter sends to Grafana as `eiok_poll`.
//
// Every `pairEvery`-th run (owner, 2026-10-22: "run some in parallel too, every 3rd run or something") builds the same
// video at 720p and 1080p at once, as an adaptive play does (src/adaptive.js): rows `tunelio:pair720` and
// `tunelio:pair1080` (with `hls` 0/1), 20 credits. They show whether 1080p builds at the 720p rate per MB and whether two
// builds at once slow each other; they don't feed the speed estimate, which predicts a build on its own.
//
// Connection-drop check (Everything-is-OK#361, for the playback stalls of #61): after a progressive run, when
// `dropMinutes` is set, the link that run paid for is read like a player reads it, for that many minutes, and resumed at
// the byte reached after every cut. No extra credits. Measured from a home PC on 2026-10-29: 2 cuts in ~40 reader-minutes,
// reopens fine. It answers two questions for #61: how often does Tunelio's side drop, and does a reopen resume? It is not
// busy (a deploy doesn't wait for it): a restart ends the read, and the counts up to the last minute stay.
// `at` on a cut is when the read reached it. The real cut can be seconds earlier (inferred): a slow reader leaves data in
// the socket's buffer, so `lastByteAt` and `at` place a cut to within about the buffer / the rate, not exactly.

const QUERIES = ['documentary', 'video essay', 'history explained', 'science explained', 'cooking', 'travel vlog',
  'nature documentary', 'interview', 'lecture', 'short film', 'car review', 'game review'];
const WARM_MS = 2000; // a first byte this fast means Tunelio already had the file: not a build, so not a speed sample
const DROP_MB_PER_S = 0.45; // 720p's rate, and the most it reads: 270 MB per 10 minutes. A file with a lower bitrate reads at its own, so a 12-minute video can't run out inside the 10 minutes
const DROP_FIRST_BYTE_MS = 10_000; // a reopen that takes longer than this counts as failed
const DROP_STALL_MS = 30_000; // no data for this long while waiting for it counts as a cut (a hang, not a reset)
const DROP_TRIES = 3; // reopens in a row before the read gives up
const DROP_RETRY_MS = 5000;
const round = (x, places = 1) => Math.round(x * 10 ** places) / 10 ** places;
const errName = (err) => String(err?.cause?.code ?? (typeof err?.code === 'string' ? err.code : err?.name) ?? err).slice(0, 60); // an AbortError's code is the number 20

export class TunelioProbe {
  constructor({ tunelio, search, busy = () => 0, record = () => {}, meta, intervalMinutes = 20, quality = '1080p',
    fetcher = fetch, log = () => {}, now = () => Date.now(), random = Math.random,
    minSeconds = 12 * 60, maxSeconds = 30 * 60, timeoutMs = 150_000, queries = QUERIES, pairEvery = 3, pairQualities = ['720p', '1080p'],
    dropMinutes = 0, dropCount = () => {}, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), dropStallMs = DROP_STALL_MS }) {
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
    this.pairEvery = pairEvery;
    this.pairQualities = pairQualities;
    this.dropMs = dropMinutes > 0 ? dropMinutes * 60_000 : 0;
    this.dropCount = dropCount; // (key, n) → daily counter tunelio_drop
    this.sleep = sleep;
    this.dropStallMs = dropStallMs;
    this.dropAbort = null;
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
    const pair = this.pairEvery > 1 && n % this.pairEvery === this.pairEvery - 1;
    if (!pair) {
      const b = await this.#build(video, this.quality, format, `tunelio:${format}`);
      const drop = format === 'progressive' ? await this.#dropCheck(b, video) : null;
      return { format, ...b, drop };
    }
    const builds = await Promise.all(this.pairQualities.map((q) => this.#build(video, q, format, `tunelio:pair${Number.parseInt(q, 10)}`, { hls: format === 'hls' ? 1 : 0 })));
    // A pair's first quality (720p) when it built: its rate is the one the 2026-10-29 sample used.
    const drop = format === 'progressive' ? await this.#dropCheck(builds.find((b) => b.ok), video) : null;
    return { format, pair: true, ok: builds.every((b) => b.ok), builds, drop };
  }

  // Opens the link at `offset` and waits for the first byte. Right = 206 starting at exactly `offset`, within 10 s.
  async #dropOpen(url, offset, stop) {
    const t0 = this.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DROP_FIRST_BYTE_MS);
    let res;
    try {
      res = await this.fetch(url, { headers: { range: `bytes=${offset}-` }, signal: AbortSignal.any([ctrl.signal, stop]) });
      const range = /^bytes (\d+)-\d*\/(\d+|\*)/.exec(res.headers?.get?.('content-range') ?? '');
      const offsetOk = Number(range?.[1]) === offset;
      if (res.status !== 206 || !offsetOk) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return { ok: false, status: res.status, offsetOk, ttfbMs: this.now() - t0 };
      }
      const reader = res.body.getReader();
      const first = await reader.read();
      if (first.done) return { ok: false, status: res.status, offsetOk, ttfbMs: this.now() - t0, error: 'empty' };
      return { ok: true, status: res.status, offsetOk, ttfbMs: this.now() - t0, reader, first: first.value, ctrl, total: Number(range[2]) || null };
    } catch (err) {
      return { ok: false, status: res?.status, ttfbMs: this.now() - t0, error: errName(err) };
    } finally { clearTimeout(timer); }
  }

  // Reads one connection at `rate` until `budgetMs` is used, the file ends or the connection is cut.
  async #dropRead(conn, offset, rate, budgetMs, stop) {
    const started = this.now();
    let got = 0, chunk = conn.first, lastByte = started, counted = 0;
    const result = (end, error) => {
      this.dropCount('minutes', (lastByte - started - counted) / 60_000);
      conn.ctrl.abort();
      conn.reader.cancel().catch(() => {});
      return { end, error, offset: offset + got, readMs: lastByte - started, connMs: this.now() - started, lastByte };
    };
    for (;;) {
      got += chunk.length;
      lastByte = this.now();
      if (lastByte - started - counted >= 60_000) { this.dropCount('minutes', (lastByte - started - counted) / 60_000); counted = lastByte - started; }
      if (conn.total && offset + got >= conn.total) return result('eof');
      if (stop.aborted) return result('stopped');
      if (lastByte - started >= budgetMs) return result('time');
      const wait = got / (rate * 1000) - (lastByte - started);
      if (wait > 0) await this.sleep(wait);
      if (stop.aborted) return result('stopped');
      let stalled = false;
      const timer = setTimeout(() => { stalled = true; conn.ctrl.abort(); }, this.dropStallMs);
      try {
        const next = await conn.reader.read();
        if (next.done) return result('short'); // closed cleanly before the end of the file
        chunk = next.value;
      } catch (err) {
        if (stop.aborted) return result('stopped');
        return result(stalled ? 'stall' : 'reset', errName(err));
      } finally { clearTimeout(timer); }
    }
  }

  async #dropCheck(build, video) {
    if (!this.dropMs || !build?.url) return null;
    if (this.busy() > 0) { this.log({ event: 'tunelio_drop', skipped: 'busy' }); return null; }
    const abort = this.dropAbort = new AbortController();
    const stop = abort.signal;
    const url = build.url;
    const fileRate = build.mb > 0 && video.seconds > 0 ? build.mb / video.seconds : DROP_MB_PER_S;
    const rate = Math.max(0.05, Math.min(DROP_MB_PER_S, fileRate));
    const run = { cuts: 0, reopenOk: 0, reopenFail: 0, readMs: 0, offset: 0 };
    const done = (ended, extra = {}) => {
      const out = { ended, minutes: round(run.readMs / 60_000), cuts: run.cuts, reopenOk: run.reopenOk, reopenFail: run.reopenFail, readMb: round(run.offset / 1e6) };
      this.log({ event: 'tunelio_drop', ...out, quality: build.quality, mb: build.mb, rate: round(rate, 2), ...extra });
      return out;
    };
    const wall = this.now() + this.dropMs * 2; // a link that keeps cutting at once ends here, not after hours of reopens
    let conn = await this.#dropOpen(url, 0, stop);
    if (!conn.ok) return done(stop.aborted ? 'stopped' : 'open_failed', { status: conn.status, error: conn.error });
    for (;;) {
      const total = conn.total;
      const r = await this.#dropRead(conn, run.offset, rate, this.dropMs - run.readMs, stop);
      run.offset = r.offset;
      run.readMs += r.readMs;
      if (r.end === 'time' || r.end === 'eof' || r.end === 'stopped') return done(r.end);
      run.cuts++;
      this.dropCount('cut', 1);
      // No video here: a cut lines up with a client freeze by clock time (#61), and the probe's video isn't the client's.
      this.log({ event: 'tunelio_drop_cut', kind: r.end, error: r.error, connS: round(r.connMs / 1000), pos: total ? round(r.offset / total, 3) : null,
        readMb: round(r.offset / 1e6), lastByteAt: new Date(r.lastByte).toISOString(), quality: build.quality });
      if (this.now() > wall) return done('wall');
      conn = null;
      for (let attempt = 1; attempt <= DROP_TRIES; attempt++) {
        const next = await this.#dropOpen(url, r.offset, stop);
        if (stop.aborted) { if (next.ok) { next.ctrl.abort(); next.reader.cancel().catch(() => {}); } return done('stopped'); }
        if (next.ok) run.reopenOk++; else run.reopenFail++;
        this.dropCount(next.ok ? 'reopen_ok' : 'reopen_fail', 1);
        this.log({ event: 'tunelio_drop_reopen', ok: next.ok, attempt, status: next.status, offsetOk: next.offsetOk, ttfbMs: next.ttfbMs, error: next.error });
        if (next.ok) { conn = next; break; }
        if (attempt < DROP_TRIES) await this.sleep(DROP_RETRY_MS);
      }
      if (!conn) return done('reopen_fail');
    }
  }

  // One /create and what a player waits for, recorded as one row of `source`.
  async #build(video, quality, format, source, extra = {}) {
    const pair = source.includes(':pair');
    const t0 = this.now();
    let made;
    try { made = await this.tunelio.create(video.id, quality); } catch (err) {
      this.log({ event: 'tunelio_probe', format, pair, quality, id: video.id, ok: false, step: 'create', status: err.status, code: err.code });
      this.record(source, { ok: 0, ...extra });
      return { quality, ok: false };
    }
    const createMs = this.now() - t0;
    const mb = Math.round((made.fileSize ?? 0) / 1e5) / 10;
    const url = made.url + (format === 'hls' ? '&hls=1' : '&progressive=1');
    const t1 = this.now();
    let r;
    try { r = format === 'hls' ? await this.#hlsStart(url, t1) : await this.#firstByte(url); } catch (err) { r = { ok: false, error: String(err?.name ?? err) }; }
    const startMs = this.now() - t1;
    const warm = r.ok && startMs < WARM_MS;
    this.log({ event: 'tunelio_probe', format, pair, id: video.id, seconds: video.seconds, quality: made.quality || quality, mb, createMs, startMs,
      playlistMs: r.playlistMs, ok: r.ok, warm, status: r.status, error: r.error });
    const values = { ok: r.ok ? 1 : 0, warm: warm ? 1 : 0, create_s: createMs / 1000, mb, minutes: Math.round(video.seconds / 6) / 10,
      height: Number.parseInt(made.quality || quality, 10) || 0, ...extra };
    if (r.ok && !warm) {
      values.start_s = startMs / 1000;
      if (mb > 0) values.mb_per_s = Math.round(mb / (startMs / 1000) * 10) / 10;
      if (r.playlistMs != null) values.playlist_s = r.playlistMs / 1000;
    }
    this.record(source, values);
    return { quality: made.quality || quality, ok: r.ok, warm, mb, createMs, startMs, url: r.ok && format === 'progressive' ? url : null };
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

  stop() { clearInterval(this.timer); this.timer = null; this.dropAbort?.abort(); }
}
