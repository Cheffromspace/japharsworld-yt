// Home relay playback (owner, 2026-10-23: "prefer Tunelio within the budget, home slightly for longer videos, daily
// cap"). A relay worker on the owner's home connection (relay/media.js) has yt-dlp resolve the video's stream URLs,
// which only work from the IP that resolved them, so the media itself has to come through here: ffmpeg at home cuts
// it into HLS segments without re-encoding and the worker PUTs each segment and the growing playlist to
// /relay/media/<token>/<file>. Players get /home/<token>/index.m3u8 and start once the first segments are here.
//
// Measured 2026-10-22/23 (claude/play-latency.md): home downloads 8–27 MB/s and uploads ~12.6 MB/s, so the
// download outruns playback ~50×. VizVid and bare AVPro on PC played a growing EVENT playlist from 0:00 for 13 minutes,
// re-reading it every few seconds, with no missing segment. Android players can't open HLS behind a ticket (f331bcc),
// so they never come here.
//
// A session is one video at one quality: building until its first playlist with a segment arrives, then ready
// (playable while the rest uploads), ended once the playlist carries #EXT-X-ENDLIST. Files stay for keepHours (late
// joiners and replays cost nothing), oldest first out above maxGb.
import { mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const SEGMENT = /^seg\d{1,5}\.ts$/;
const MAX_SEGMENT_BYTES = 64 << 20;
const RETRY_MS = 60_000; // a failed session is tried again after this long

export class Home {
  constructor({ relay, dir, base = 'https://yt.japharsworld.com/home', enabled = false, dailyBuilds = 40, dailyMb = 10_000,
    keepHours = 12, maxGb = 6, readyMs = 30_000, now = () => Date.now(), log = () => {}, onEvent = () => {} }) {
    Object.assign(this, { relay, dir, base, enabled, dailyBuilds, dailyMb, keepHours, maxGb, readyMs, now, log, onEvent });
    this.sessions = new Map(); // "videoId@quality" → session
    this.byToken = new Map();  // token → session
    this.day = { date: '', builds: 0, mb: 0 };
    // Sessions live in memory only, so files left from before a restart can't be served: start empty.
    if (dir && enabled) try { rmSync(dir, { recursive: true, force: true }); } catch { /* none */ }
  }

  #today() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (this.day.date !== d) this.day = { date: d, builds: 0, mb: 0 };
    return this.day;
  }

  // The worker that would build a new session, or null: off, no media worker online, or today's cap reached.
  worker() {
    if (!this.enabled || !this.relay?.enabled) return null;
    const d = this.#today();
    if (d.builds >= this.dailyBuilds || d.mb >= this.dailyMb) return null;
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
    const s = { token: randomBytes(9).toString('hex'), id: data.id, quality, seconds: data.seconds ?? 0, worker, state: 'building',
      startedMs: this.now(), readyMs: 0, endedMs: 0, lastPutMs: 0, ended: false, mb: 0, segments: 0, reason: null, waiters: [] };
    this.sessions.set(`${s.id}@${quality}`, s);
    this.byToken.set(s.token, s);
    this.#today().builds++;
    this.onEvent('start');
    mkdirSync(join(this.dir, s.token), { recursive: true });
    this.relay.run({ kind: 'media', videoId: s.id, quality, token: s.token }, { worker, timeoutMs: this.readyMs })
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

  // A worker's upload. → HTTP status: 204 stored, 400 bad name or playlist, 410 no such session any more (the worker
  // stops), 413 too large.
  put(token, file, body) {
    const s = this.byToken.get(token);
    if (!s || s.state === 'failed') return 410;
    if (file === 'index.m3u8') {
      const text = body.toString('utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines[0] !== '#EXTM3U' || lines.some((l) => !l.startsWith('#') && !SEGMENT.test(l))) return 400;
      this.#write(s, file, Buffer.from(text));
      s.segments = lines.filter((l) => !l.startsWith('#')).length;
      if (s.state === 'building' && s.segments > 0) {
        s.state = 'ready';
        s.readyMs = this.now();
        this.onEvent('ready', { ms: s.readyMs - s.startedMs });
        this.log({ event: 'home_ready', id: s.id, quality: s.quality, ms: s.readyMs - s.startedMs, seconds: s.seconds });
        this.#wake(s);
      }
      if (!s.ended && lines.includes('#EXT-X-ENDLIST')) {
        s.ended = true;
        s.endedMs = this.now();
        this.log({ event: 'home_done', id: s.id, quality: s.quality, ms: s.endedMs - s.startedMs, mb: Math.round(s.mb), segments: s.segments });
      }
      return 204;
    }
    if (!SEGMENT.test(file)) return 400;
    if (body.length > MAX_SEGMENT_BYTES) return 413;
    this.#write(s, file, body);
    s.mb += body.length / 1e6;
    this.#today().mb += body.length / 1e6;
    return 204;
  }

  #write(s, file, body) {
    const path = join(this.dir, s.token, file);
    mkdirSync(join(this.dir, s.token), { recursive: true });
    writeFileSync(`${path}.tmp`, body);
    renameSync(`${path}.tmp`, path);
    s.lastPutMs = this.now();
  }

  // A file for a player: { body, type } or null. The playlist gets absolute links (AVPro resolves relative ones against
  // the ticket URL it was handed, fe6612a) and a start at 0, so a playlist that is still growing plays from the beginning.
  file(token, file) {
    const s = this.byToken.get(token);
    if (!s || !(file === 'index.m3u8' || SEGMENT.test(file))) return null;
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
    return { enabled: this.enabled, workers: this.relay?.capable?.('media') ?? [], today: { builds: d.builds, mb: Math.round(d.mb) },
      cap: { builds: this.dailyBuilds, mb: this.dailyMb },
      building: all.filter((s) => s.state === 'building').length, ready: all.filter((s) => s.state === 'ready' && !s.ended).length,
      ended: all.filter((s) => s.ended).length, failed: all.filter((s) => s.state === 'failed').length,
      storedMb: Math.round(all.reduce((n, s) => n + s.mb, 0)) };
  }
}
