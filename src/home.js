// Home relay playback (owner, 2026-10-23: "prefer Tunelio within the budget, home slightly for longer videos, daily
// cap"). A relay worker on the owner's home connection (relay/media.js) has yt-dlp resolve the video's stream URLs,
// which only work from the IP that resolved them, so the media itself has to come through here: ffmpeg at home cuts
// it into HLS segments without re-encoding and the worker PUTs each segment and the playlist to
// /relay/media/<token>/<file>. Players get /home/<token>/index.m3u8 and start once the first segments are here.
//
// Measured 2026-10-22/23 (claude/play-latency.md): home downloads 8–27 MB/s and uploads ~8–12 MB/s, so the upload
// outruns playback ~40×. Android players can't open HLS behind a plain ticket (f331bcc), so they come here only through a
// .m3u8 ticket (the world's Android build) and only with HOME_ANDROID=on (server.js).
//
// The playlist: a growing EVENT playlist played from 0:00 in VizVid, but as a live stream (no seek bar, 2026-10-23),
// for the whole play even after #EXT-X-ENDLIST arrived; a finished one has the seek bar. So the worker uploads the
// whole playlist, ENDLIST included, as soon as it knows the segment length (YouTube's keyframes are evenly spaced: a
// 6 h mix was 4388 × 5.071733 s + a 3.09 s tail), and a segment a player asks for before it is here is held until it
// arrives (segmentHoldMs). If ffmpeg's segments turn out different, the worker uploads the real playlist at the end.
//
// A session is one video at one quality: building until its first playlist with a segment arrives, then ready
// (playable while the rest uploads), ended once the playlist has ENDLIST and every segment it lists is here. Sessions
// are saved next to their files (meta.json) and reloaded on start, so a deploy doesn't cut plays off; the daily use is
// saved too (day.json), so it doesn't reset the cap. Files stay keepHours, oldest finished first out above maxGb.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const SEGMENT = /^seg\d{1,5}\.ts$/;
const TOKEN = /^[a-f0-9]{18}$/;
const MAX_SEGMENT_BYTES = 64 << 20;
const RETRY_MS = 60_000; // a failed session is tried again after this long

export class Home {
  constructor({ relay, dir, base = 'https://yt.japharsworld.com/home', enabled = false, dailyBuilds = 40, dailyMb = 10_000,
    keepHours = 12, maxGb = 6, readyMs = 30_000, segmentHoldMs = 20_000, now = () => Date.now(), log = () => {}, onEvent = () => {} }) {
    Object.assign(this, { relay, dir, base, enabled, dailyBuilds, dailyMb, keepHours, maxGb, readyMs, segmentHoldMs, now, log, onEvent });
    this.sessions = new Map(); // "videoId@quality" → session
    this.byToken = new Map();  // token → session
    this.day = { date: '', builds: 0, mb: 0 };
    if (dir && enabled) { this.loading = true; this.#load(); this.loading = false; }
  }

  // Sessions and today's use from before a restart. Folders without a readable meta.json are removed.
  #load() {
    mkdirSync(this.dir, { recursive: true });
    try { this.day = { date: '', builds: 0, mb: 0, ...JSON.parse(readFileSync(join(this.dir, 'day.json'), 'utf8')) }; } catch { /* none */ }
    for (const token of readdirSync(this.dir)) {
      if (!TOKEN.test(token)) continue;
      const folder = join(this.dir, token);
      try {
        const m = JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8'));
        const s = this.#session({ ...m, token });
        for (const f of readdirSync(folder)) if (SEGMENT.test(f)) { s.stored.add(f); s.mb += statSync(join(folder, f)).size / 1e6; }
        try { this.#playlist(s, readFileSync(join(folder, 'index.m3u8'), 'utf8')); } catch { /* none yet */ }
        if (s.state !== 'ready') throw new Error('never ready');
        this.sessions.set(`${s.id}@${s.quality}`, s);
        this.byToken.set(s.token, s);
      } catch { rmSync(folder, { recursive: true, force: true }); }
    }
    if (this.byToken.size) this.log({ event: 'home_loaded', sessions: this.byToken.size });
  }

  #session(f) {
    return { token: f.token, id: f.id, quality: f.quality, seconds: f.seconds ?? 0, worker: f.worker ?? null, state: 'building',
      startedMs: f.startedMs ?? this.now(), readyMs: 0, endedMs: 0, lastPutMs: f.lastPutMs ?? 0, ended: false, mb: 0, segments: 0,
      listed: [], stored: new Set(), reason: null, waiters: [], segmentWaiters: new Map() };
  }

  #saveMeta(s) {
    const meta = { id: s.id, quality: s.quality, seconds: s.seconds, worker: s.worker, startedMs: s.startedMs, lastPutMs: s.lastPutMs };
    try { writeFileSync(join(this.dir, s.token, 'meta.json'), JSON.stringify(meta)); } catch { /* folder gone */ }
  }
  #saveDay() { try { writeFileSync(join(this.dir, 'day.json'), JSON.stringify(this.day)); } catch { /* no dir */ } }

  #today() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (this.day.date !== d) this.day = { date: d, builds: 0, mb: 0, cacheHits: 0, cacheMb: 0 };
    return this.day;
  }

  // The worker that would build a new session, or null: off, no media worker online, or today's cap reached.
  worker() {
    if (!this.enabled || !this.relay?.enabled) return null;
    if (this.capped()) return null;
    return this.relay.capable?.('media')[0] ?? null;
  }
  capped() { const d = this.#today(); return d.builds >= this.dailyBuilds || d.mb >= this.dailyMb; }

  peek(data, quality) {
    const s = this.sessions.get(`${data.id}@${quality}`);
    if (!s) return null;
    if (s.state === 'failed' && this.now() - s.endedMs > RETRY_MS) return null;
    if (s.state !== 'failed' && this.now() - (s.lastPutMs || s.startedMs) > this.keepHours * 3600_000) return null;
    return s;
  }

  // The session for a video, started if there is none (and a worker is free and under the cap); null otherwise.
  start(data, quality) {
    const hit = this.peek(data, quality);
    if (hit) return hit;
    const worker = this.worker();
    if (!worker) { if (this.enabled && this.capped()) this.onEvent('capped'); return null; }
    this.#drop(this.sessions.get(`${data.id}@${quality}`));
    this.sweep();
    const s = this.#session({ token: randomBytes(9).toString('hex'), id: data.id, quality, seconds: data.seconds ?? 0, worker });
    this.sessions.set(`${s.id}@${quality}`, s);
    this.byToken.set(s.token, s);
    this.#today().builds++;
    this.#saveDay();
    this.onEvent('start');
    mkdirSync(join(this.dir, s.token), { recursive: true });
    this.#saveMeta(s);
    this.relay.run({ kind: 'media', videoId: s.id, quality, token: s.token, seconds: s.seconds }, { worker, timeoutMs: this.readyMs })
      .catch((err) => { if (s.state === 'building') this.#fail(s, err?.code ?? 'worker_failed', String(err?.message ?? err)); });
    return s;
  }

  #fail(s, reason, message = '') {
    s.state = 'failed';
    s.reason = reason;
    s.endedMs = this.now();
    this.onEvent('failed');
    this.log({ event: 'home_failed', id: s.id, quality: s.quality, reason, ms: s.endedMs - s.startedMs, message: message.slice(0, 200) });
    this.#wake(s);
  }

  #wake(s) { for (const w of s.waiters) w(); s.waiters = []; }

  // Resolves when the session is ready or failed, or after holdMs.
  wait(s, holdMs = Infinity) {
    if (s.state !== 'building') return Promise.resolve(s);
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { if (timer) clearTimeout(timer); resolve(s); };
      s.waiters.push(done);
      if (Number.isFinite(holdMs)) timer = setTimeout(done, Math.max(0, holdMs));
    });
  }

  url(s) { return `${this.base}/${s.token}/index.m3u8`; }

  // A playlist from the worker (or from disk): which segments it lists, ready at the first one, ended when complete.
  #playlist(s, text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    s.listed = lines.filter((l) => !l.startsWith('#'));
    s.segments = s.listed.length;
    s.endlist = lines.includes('#EXT-X-ENDLIST');
    if (s.state === 'building' && s.segments > 0 && s.stored.size > 0) {
      s.state = 'ready';
      s.readyMs = this.now();
    }
    this.#checkEnded(s);
  }

  #checkEnded(s) {
    if (s.ended || !s.endlist || !s.listed.every((f) => s.stored.has(f))) return;
    s.ended = true;
    s.endedMs = this.now();
    if (!this.loading) this.log({ event: 'home_done', id: s.id, quality: s.quality, ms: s.endedMs - s.startedMs, mb: Math.round(s.mb), segments: s.segments });
    // Segments a player is still waiting for that the final playlist doesn't list will not come.
    for (const [file, ws] of s.segmentWaiters) if (!s.stored.has(file)) { for (const w of ws) w(); s.segmentWaiters.delete(file); }
  }

  // A worker's upload. → HTTP status: 204 stored, 400 bad name or playlist, 410 no such session any more (the worker
  // stops), 413 too large. cached: uploaded from the worker's own cache (relay/cache.js), not downloaded from YouTube,
  // so it counts as a cache hit and its MB as cacheMb, not against dailyBuilds / dailyMb.
  put(token, file, body, { cached = false } = {}) {
    const s = this.byToken.get(token);
    if (!s || s.state === 'failed') return 410;
    if (cached && !s.cached) {
      s.cached = true;
      const d = this.#today();
      d.builds = Math.max(0, d.builds - 1);
      d.cacheHits = (d.cacheHits ?? 0) + 1;
      this.onEvent('cache_hit');
    }
    if (file === 'index.m3u8') {
      const text = body.toString('utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines[0] !== '#EXTM3U' || lines.some((l) => !l.startsWith('#') && !SEGMENT.test(l))) return 400;
      this.#write(s, file, Buffer.from(text));
      const was = s.state;
      this.#playlist(s, text);
      if (was === 'building' && s.state === 'ready') this.#ready(s);
      return 204;
    }
    if (!SEGMENT.test(file)) return 400;
    if (body.length > MAX_SEGMENT_BYTES) return 413;
    this.#write(s, file, body);
    if (!s.stored.has(file)) {
      s.stored.add(file);
      s.mb += body.length / 1e6;
      const d = this.#today();
      if (s.cached) d.cacheMb = (d.cacheMb ?? 0) + body.length / 1e6; else d.mb += body.length / 1e6;
    }
    const ws = s.segmentWaiters.get(file);
    if (ws) { s.segmentWaiters.delete(file); for (const w of ws) w(); }
    if (s.state === 'building' && s.segments > 0) { s.state = 'ready'; s.readyMs = this.now(); this.#ready(s); }
    this.#checkEnded(s);
    return 204;
  }

  #ready(s) {
    this.onEvent('ready', { ms: s.readyMs - s.startedMs });
    this.log({ event: 'home_ready', id: s.id, quality: s.quality, ms: s.readyMs - s.startedMs, seconds: s.seconds });
    this.#wake(s);
  }

  #write(s, file, body) {
    const path = join(this.dir, s.token, file);
    mkdirSync(join(this.dir, s.token), { recursive: true });
    writeFileSync(`${path}.tmp`, body);
    renameSync(`${path}.tmp`, path);
    s.lastPutMs = this.now();
    if (file === 'index.m3u8') { this.#saveMeta(s); this.#saveDay(); }
  }

  // A file for a player: { body, type } or null. A segment that isn't here yet is waited for up to segmentHoldMs while
  // the session is still uploading. The playlist gets absolute links (AVPro resolves relative ones against the ticket
  // URL it was handed, fe6612a) and a start at 0.
  async file(token, file) {
    const s = this.byToken.get(token);
    if (!s || !(file === 'index.m3u8' || SEGMENT.test(file))) return null;
    if (file !== 'index.m3u8' && !s.stored.has(file) && !s.ended && s.state !== 'failed') {
      await new Promise((resolve) => {
        const ws = s.segmentWaiters.get(file) ?? [];
        const timer = setTimeout(done, this.segmentHoldMs);
        function done() { clearTimeout(timer); resolve(); }
        ws.push(done);
        s.segmentWaiters.set(file, ws);
      });
    }
    let body;
    try { body = readFileSync(join(this.dir, s.token, file)); } catch { return null; }
    if (file !== 'index.m3u8') return { body, type: 'video/mp2t' };
    const text = body.toString('utf8').split(/\r?\n/)
      .map((l) => (l && !l.startsWith('#') ? `${this.base}/${s.token}/${l}` : l))
      .join('\n').replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0');
    return { body: Buffer.from(text), type: 'application/vnd.apple.mpegurl' };
  }

  #drop(s) {
    if (!s) return;
    this.byToken.delete(s.token);
    if (this.sessions.get(`${s.id}@${s.quality}`) === s) this.sessions.delete(`${s.id}@${s.quality}`);
    try { rmSync(join(this.dir, s.token), { recursive: true, force: true }); } catch { /* gone */ }
  }

  // Old sessions out, then the oldest finished ones while the files take more than maxGb.
  sweep() {
    const now = this.now();
    for (const s of [...this.byToken.values()]) {
      const last = s.lastPutMs || s.endedMs || s.startedMs;
      if (now - last > this.keepHours * 3600_000) this.#drop(s);
    }
    const done = [...this.byToken.values()].filter((s) => s.ended || s.state === 'failed').sort((a, b) => (a.lastPutMs || a.startedMs) - (b.lastPutMs || b.startedMs));
    let total = [...this.byToken.values()].reduce((n, s) => n + s.mb, 0);
    while (total > this.maxGb * 1000 && done.length) { const s = done.shift(); total -= s.mb; this.#drop(s); }
  }

  state() {
    const all = [...this.byToken.values()];
    const d = this.#today();
    return { enabled: this.enabled, workers: this.relay?.capable?.('media') ?? [],
      today: { builds: d.builds, mb: Math.round(d.mb), cacheHits: d.cacheHits ?? 0, cacheMb: Math.round(d.cacheMb ?? 0) },
      cap: { builds: this.dailyBuilds, mb: this.dailyMb },
      building: all.filter((s) => s.state === 'building').length, ready: all.filter((s) => s.state === 'ready' && !s.ended).length,
      ended: all.filter((s) => s.ended).length, failed: all.filter((s) => s.state === 'failed').length,
      storedMb: Math.round(all.reduce((n, s) => n + s.mb, 0)) };
  }
}
