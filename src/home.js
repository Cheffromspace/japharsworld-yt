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
// saved too (day.json), so it doesn't reset the cap. Files stay keepHours, oldest finished first out above maxGb
// (8 GB: 1080p sessions are 0.6–1.6 GB and the Linode's / is 25 GB, 2026-10-25), never one building or being played;
// a build counts its expected size against maxGb from its start (#expectedMb), so room is made before it grows.
//
// Segments on demand (Everything-is-OK#367): the worker uploads in order, so a player that seeks far ahead of the upload
// (resuming a long video part way) asks for a segment minutes away. Prod, 2026-10-30 00:37Z: a 4.1 h 1080p play from
// the worker's cache went up in order at ~6.9 MB/s (8404 MB in 1220 s), the player's seg550 would have come ~250 s in,
// each request was held 20 s and the world reloaded every ~30 s, so it froze for good. Now a segment a player waits for
// that isn't next in line becomes the session's want, and every answer to the worker's uploads names it (x-media-want,
// server.js) until it is here; the worker sends it next (relay/media.js).
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { dayOf } from './metrics.js';

const SEGMENT = /^seg\d{1,5}\.ts$/;
const segIndex = (file) => Number(file.slice(3, -3));
// A segment a player waits for more than this past the last one uploaded, or before it (a gap left by a jump), is
// wanted; the next ones in line are coming anyway.
const WANT_AHEAD = 2;
const TOKEN = /^[a-f0-9]{18}$/;
const MAX_SEGMENT_BYTES = 64 << 20;
const DAY_SAVE_MS = 30_000; // today's use goes to day.json at most this often while segments arrive (#saveDaySoon)
const RETRY_MS = 60_000; // a failed session is tried again after this long
// An unfinished session with no upload for this long has no worker stream behind it any more (it died or was stopped);
// a live one uploads every few seconds, and a server restart only pauses it for seconds (the worker retries).
const STALE_MS = 5 * 60_000;
// A session a player fetched from this recently is being played: the sweep leaves it alone. Players fetch a segment
// every few seconds, and a paused one picks up where it was.
const PLAYING_MS = 5 * 60_000;
// A 1080p home session's MB per second of video, the high end measured (0.46–0.57, 2026-10-26: a 4.1 h mix, 8404 MB):
// what a build counts against maxGb before its first segments say better (#expectedMb).
const MB_PER_SECOND = 0.57;

export class Home {
  constructor({ relay, dir, base = 'https://yt.japharsworld.com/home', enabled = false, dailyBuilds = 40, dailyMb = 10_000,
    keepHours = 12, maxGb = 8, readyMs = 30_000, segmentHoldMs = 20_000, startPrecise = false, tz = 'America/Chicago', now = () => Date.now(), log = () => {}, onEvent = () => {} }) {
    Object.assign(this, { relay, dir, base, enabled, dailyBuilds, dailyMb, keepHours, maxGb, readyMs, segmentHoldMs, startPrecise, tz, now, log, onEvent });
    this.daySavedMs = 0;
    this.sessions = new Map(); // "videoId@quality" → session
    this.byToken = new Map();  // token → session
    this.day = { date: '', builds: 0, mb: 0 };
    this.uneven = new Map(); // video id → until (ms): its home playlist grew, so long plays of it go to Tunelio (giveUp)
    if (dir && enabled) { this.loading = true; this.#load(); this.loading = false; }
  }

  // Sessions, today's use and the uneven videos from before a restart. Folders without a readable meta.json are removed,
  // and so are sessions that failed or were given up, and unfinished ones whose worker stream is gone (STALE_MS):
  // 2026-10-25, a session given up as uneven after 13 of a 90-minute video's segments came back after a deploy as
  // ready, and a Quest replay was sent to its ~65 s growing playlist, which never grew (6 of the 8 sessions on disk).
  #load() {
    mkdirSync(this.dir, { recursive: true });
    try { this.day = { date: '', builds: 0, mb: 0, ...JSON.parse(readFileSync(join(this.dir, 'day.json'), 'utf8')) }; } catch { /* none */ }
    try {
      for (const [id, until] of Object.entries(JSON.parse(readFileSync(join(this.dir, 'uneven.json'), 'utf8')))) {
        if (until > this.now()) this.uneven.set(id, until);
      }
    } catch { /* none */ }
    let dropped = 0;
    for (const token of readdirSync(this.dir)) {
      if (!TOKEN.test(token)) continue;
      const folder = join(this.dir, token);
      try {
        const m = JSON.parse(readFileSync(join(folder, 'meta.json'), 'utf8'));
        if (m.state === 'failed') throw new Error('failed');
        const s = this.#session({ ...m, token });
        for (const f of readdirSync(folder)) if (SEGMENT.test(f)) { s.stored.add(f); s.mb += statSync(join(folder, f)).size / 1e6; s.last = Math.max(s.last, segIndex(f)); }
        try { this.#playlist(s, readFileSync(join(folder, 'index.m3u8'), 'utf8')); } catch { /* none yet */ }
        if (s.state !== 'ready') throw new Error('never ready');
        if (this.#stale(s)) throw new Error('stream gone');
        this.sessions.set(`${s.id}@${s.quality}`, s);
        this.byToken.set(s.token, s);
      } catch { rmSync(folder, { recursive: true, force: true }); dropped++; }
    }
    if (this.byToken.size || dropped) this.log({ event: 'home_loaded', sessions: this.byToken.size, dropped, storedMb: Math.round(this.#storedMb()), maxGb: this.maxGb });
  }

  #session(f) {
    return { token: f.token, id: f.id, quality: f.quality, seconds: f.seconds ?? 0, worker: f.worker ?? null, state: 'building',
      startedMs: f.startedMs ?? this.now(), readyMs: 0, endedMs: 0, lastPutMs: f.lastPutMs ?? 0, ended: false, mb: 0, segments: 0,
      listed: [], listedSeconds: 0, stored: new Set(), reason: null, waiters: [], endWaiters: [], segmentWaiters: new Map(),
      firstSegmentMs: 0, firstServed: null, lastGetMs: 0, why: f.why ?? null, want: null, last: -1 };
  }

  // Not finished, and no upload for STALE_MS: nothing will arrive any more.
  #stale(s) { return !s.ended && this.now() - (s.lastPutMs || s.startedMs) > STALE_MS; }

  // The session's why (server.js startHome) is saved with it, so leaveHome still knows a reloaded long play.
  save(s) { this.#saveMeta(s); }
  #saveMeta(s) {
    const meta = { id: s.id, quality: s.quality, seconds: s.seconds, worker: s.worker, startedMs: s.startedMs, lastPutMs: s.lastPutMs,
      why: s.why ?? null, ...(s.state === 'failed' ? { state: 'failed', reason: s.reason, endedMs: s.endedMs } : {}) };
    try { writeFileSync(join(this.dir, s.token, 'meta.json'), JSON.stringify(meta)); s.metaSavedMs = this.now(); } catch { /* folder gone */ }
  }
  #saveUneven() { try { writeFileSync(join(this.dir, 'uneven.json'), JSON.stringify(Object.fromEntries(this.uneven))); } catch { /* no dir */ } }
  #saveDay() { this.daySavedMs = this.now(); try { writeFileSync(join(this.dir, 'day.json'), JSON.stringify(this.day)); } catch { /* no dir */ } }
  // Today's use as it grows: at most every DAY_SAVE_MS while segments arrive. A predicted playlist goes up once at the
  // start, so its MB were saved only when the next session started, and a deploy mid-build lost them (up to ~7 GB for
  // a 4 h 1080p build, 2026-10-27). flush() saves the rest on shutdown (server.js, SIGTERM).
  #saveDaySoon() { if (this.now() - this.daySavedMs >= DAY_SAVE_MS) this.#saveDay(); }
  flush() { if (this.dir && this.enabled) this.#saveDay(); }

  // The day the caps count: the reporting time zone's (METRICS_TZ), the day the metrics, the dashboard and the daily
  // report use. It was the UTC date, which rolled over at 19:00 Chicago (2026-10-27: the dashboard's "today" read 0
  // at 19:2x and looked like a restart had reset the count).
  #today() {
    const d = dayOf(this.now(), this.tz);
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
    if (s.state === 'ready' && this.#stale(s)) return null; // its stream died part way: start again rather than reuse it
    return s;
  }

  // A session given up for Tunelio because its playlist grows (keyframes at scene cuts): Media Foundation plays a growing
  // playlist as live, reloading it every few seconds, for the minutes until it ends (#127, 2026-10-24: FRONTLINE PBS,
  // 1 h 53 min, 137 s; 20 of 22 home streams since 2026-10-23 grew). The video is remembered for keepHours, so its next
  // plays don't try home first. The worker stops at its next upload (410).
  giveUp(s, reason = 'uneven') {
    this.uneven.set(s.id, this.now() + this.keepHours * 3600_000);
    this.#saveUneven();
    s.state = 'failed';
    s.reason = reason;
    s.endedMs = this.now();
    this.#saveMeta(s);
    this.onEvent(reason);
    this.log({ event: 'home_failed', id: s.id, quality: s.quality, reason, ms: s.endedMs - s.startedMs });
    this.#wake(s);
  }
  // The same memory without ending the session: with HOME_ANDROID_GROWING a Quest may be on the growing playlist when a
  // PC player of the video leaves for Tunelio (src/server.js leaveHome), so the session keeps going for it (world #250,
  // 2026-10-27: three plays given up that way within 21 minutes on prod; the worker's next upload got 410 and the
  // Quest froze at the last segment it had, 45 s of seg1 404s the last time).
  markUneven(s) {
    if (this.isUneven(s)) return;
    this.uneven.set(s.id, this.now() + this.keepHours * 3600_000);
    this.#saveUneven();
    this.onEvent('uneven');
    this.log({ event: 'home_uneven', id: s.id, quality: s.quality, kept: true, ms: this.now() - s.startedMs });
  }
  isUneven(data) {
    const until = this.uneven.get(data.id);
    if (until && until < this.now()) { this.uneven.delete(data.id); this.#saveUneven(); }
    return Boolean(until && until >= this.now());
  }

  // A usable session for the same video at another quality, ready ones first: what a play keeps when the room's new
  // quality can't be built at home (Everything-is-OK#127, 2026-10-24: the room went to 1080p during a 3.5 h home play,
  // the worker answered "busy", and the player was held 91 s for a 4 GB Tunelio build, then sent to youtube.com).
  other(data, quality) {
    let best = null;
    for (const s of this.sessions.values()) {
      if (s.id !== data.id || s.quality === quality) continue;
      const p = this.peek(data, s.quality);
      if (!p || p.state === 'failed') continue;
      if (!best || (p.state === 'ready' && best.state !== 'ready')) best = p;
    }
    return best;
  }

  // The session for a video, started if there is none (and a worker is free and under the cap); null otherwise.
  start(data, quality) {
    const hit = this.peek(data, quality);
    if (hit) return hit;
    const worker = this.worker();
    if (!worker) { if (this.enabled && this.capped()) this.onEvent('capped'); return null; }
    this.#drop(this.sessions.get(`${data.id}@${quality}`));
    const s = this.#session({ token: randomBytes(9).toString('hex'), id: data.id, quality, seconds: data.seconds ?? 0, worker });
    this.sessions.set(`${s.id}@${quality}`, s);
    this.byToken.set(s.token, s);
    this.sweep(); // with the new build's expected size counted, so room is made before it grows
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
    this.#saveMeta(s);
    this.onEvent('failed');
    this.log({ event: 'home_failed', id: s.id, quality: s.quality, reason, ms: s.endedMs - s.startedMs, message: message.slice(0, 200) });
    this.#wake(s);
  }

  #wake(s) { for (const w of s.waiters) w(); s.waiters = []; if (s.state === 'failed') { for (const w of s.endWaiters) w(); s.endWaiters = []; } }

  // When the rest of a ready session's growing playlist is due (ms, at its upload rate so far), or null when not known.
  eta(s) {
    if (s.state !== 'ready' || s.endlist || !s.seconds || !s.firstSegmentMs || !s.listedSeconds) return s.endlist ? 0 : null;
    const elapsed = this.now() - s.firstSegmentMs;
    if (s.segments < 8 || elapsed < 1000) return null; // too little to tell a rate from
    const rate = s.listedSeconds / elapsed; // video seconds uploaded per ms
    return Math.max(0, (s.seconds - s.listedSeconds) / rate);
  }

  // A player is about to get a session that is ready but whose playlist is still growing. A growing (EVENT) playlist
  // is opened as live by Media Foundation, at its end and with the clock from 0 (2026-10-23, Everything-is-OK#111:
  // "Sleep Is Your Superpower" opened with 101 of 251 segments listed, picture ~7 min ahead of the captions, ENDLIST
  // 6 s later). So when the rest is due within maxMs, wait for it: the player then gets the finished playlist, plays
  // from 0 and has the seek bar. → true when the session ended by then.
  async settle(s, maxMs) {
    if (s.ended || s.endlist || s.state !== 'ready' || !(maxMs > 0)) return s.ended;
    const eta = this.eta(s);
    if (eta == null || eta > maxMs) return false;
    const started = this.now();
    await new Promise((resolve) => {
      const timer = setTimeout(done, Math.min(maxMs, eta * 1.5 + 2000));
      function done() { clearTimeout(timer); resolve(); }
      s.endWaiters.push(done);
    });
    this.onEvent(s.ended ? 'settled' : 'settle_timeout');
    this.log({ event: 'home_settle', id: s.id, quality: s.quality, ms: this.now() - started, ended: s.ended, eta: Math.round(eta) });
    return s.ended;
  }

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

  // The segment players wait for that the worker should send next (see the top), or null.
  want(token) {
    const s = this.byToken.get(token);
    return s && s.want != null && !s.stored.has(`seg${s.want}.ts`) ? s.want : null;
  }

  url(s) { return `${this.base}/${s.token}/index.m3u8`; }

  // A playlist from the worker (or from disk): which segments it lists, ready at the first one, ended when complete.
  #playlist(s, text) {
    const before = s.listed.length;
    const lines = text.split(/\r?\n/).filter(Boolean);
    s.listed = lines.filter((l) => !l.startsWith('#'));
    s.listedSeconds = lines.reduce((a, l) => a + (Number(/^#EXTINF:([\d.]+)/.exec(l)?.[1]) || 0), 0);
    s.segments = s.listed.length;
    s.endlist = lines.includes('#EXT-X-ENDLIST');
    if (s.state === 'building' && s.segments > 0 && s.stored.size > 0) {
      s.state = 'ready';
      s.readyMs = this.now();
    }
    // Fewer segments than before, closed: the worker cut a predicted (whole) playlist back to what it uploaded after
    // failing part way (relay/media.js closedAt). Players already on it end there; the session is failed, not done, so
    // the next play starts over instead of getting the short copy (coordinator, 2026-10-27).
    if (s.endlist && s.segments < before && !this.loading && s.state !== 'failed') {
      this.#fail(s, 'cut_short', `${s.segments} of ${before} segments`);
      for (const [file, ws] of s.segmentWaiters) if (!s.stored.has(file)) { for (const w of ws) w(); s.segmentWaiters.delete(file); }
      return;
    }
    this.#checkEnded(s);
  }

  #checkEnded(s) {
    if (s.ended || !s.endlist || !s.listed.every((f) => s.stored.has(f))) return;
    s.ended = true;
    s.endedMs = this.now();
    for (const w of s.endWaiters) w();
    s.endWaiters = [];
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
      s.firstSegmentMs ||= this.now();
      s.mb += body.length / 1e6;
      const d = this.#today();
      if (s.cached) d.cacheMb = (d.cacheMb ?? 0) + body.length / 1e6; else d.mb += body.length / 1e6;
      this.#saveDaySoon();
    }
    s.last = segIndex(file);
    if (s.want === s.last) s.want = null;
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
    // A predicted playlist goes up once and the segments follow for minutes: lastPutMs reaches meta.json at least every
    // 30 s, so a restart doesn't take a live stream for a dead one (STALE_MS).
    else if (s.lastPutMs - (s.metaSavedMs ?? 0) > 30_000) this.#saveMeta(s);
  }

  // A file for a player: { body, type } or null. A segment that isn't here yet is waited for up to segmentHoldMs while
  // the session is still uploading. The playlist gets absolute links (AVPro resolves relative ones against the ticket
  // URL it was handed, fe6612a) and a start at 0; exactly 0 (PRECISE=YES) on a growing playlist with startPrecise
  // (HOME_ANDROID_GROWING, world #250): ExoPlayer otherwise starts one without ENDLIST at its live edge.
  async file(token, file) {
    const s = this.byToken.get(token);
    if (!s || !(file === 'index.m3u8' || SEGMENT.test(file))) return null;
    s.lastGetMs = this.now();
    if (file !== 'index.m3u8' && !s.stored.has(file) && !s.ended && s.state !== 'failed') {
      const n = segIndex(file);
      if ((n > s.last + WANT_AHEAD || n < s.last) && s.want !== n) {
        s.want = n;
        this.log({ event: 'home_want', ses: s.token.slice(0, 4), quality: s.quality, seg: n, top: s.last });
      }
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
    if (file !== 'index.m3u8') {
      // Which segment a session's first player started on (seg0 = from the start; Everything-is-OK#111).
      if (!s.firstServed) { s.firstServed = file; this.log({ event: 'home_first_segment', id: s.id, quality: s.quality, file, ended: s.ended }); }
      return { body, type: 'video/mp2t' };
    }
    // A finished growing playlist is served as VOD: ffmpeg keeps PLAYLIST-TYPE:EVENT after ENDLIST, and Media Foundation
    // never seeks in it (2026-10-24, #128: a late joiner on a finished EVENT playlist snapped back to 0:00 at every sync
    // seek, while ffmpeg seeks it fine: PTS and EXTINFs match). The predicted whole playlists are VOD already.
    let text = body.toString('utf8').split(/\r?\n/)
      .map((l) => (l && !l.startsWith('#') ? `${this.base}/${s.token}/${l}` : l))
      .join('\n').replace('#EXTM3U', `#EXTM3U\n#EXT-X-START:TIME-OFFSET=0${this.startPrecise && !s.ended ? ',PRECISE=YES' : ''}`);
    if (s.ended) text = text.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
    return { body: Buffer.from(text), type: 'application/vnd.apple.mpegurl' };
  }

  #drop(s) {
    if (!s) return;
    this.byToken.delete(s.token);
    if (this.sessions.get(`${s.id}@${s.quality}`) === s) this.sessions.delete(`${s.id}@${s.quality}`);
    try { rmSync(join(this.dir, s.token), { recursive: true, force: true }); } catch { /* gone */ }
  }

  #storedMb() { return [...this.byToken.values()].reduce((n, s) => n + s.mb, 0); }

  // What a session will take on disk: an unfinished one counts its expected final size, not what is here yet. Counting
  // only the files let a long build grow past the cap between sweeps (prod 2026-10-28 21:48–21:53Z: a 4.5 h 1080p build
  // grew ~5 GB after the sweep at its start, and the Linode's / reached 90.6 % with the cache at its 12 GB cap). From
  // its own segments once the whole playlist is listed (the worker uploads it up front), else its length at MB_PER_SECOND.
  #expectedMb(s) {
    if (s.ended || s.state === 'failed' || this.#stale(s)) return s.mb;
    const est = s.stored.size && s.listed.length > s.stored.size ? s.mb * s.listed.length / s.stored.size : s.seconds * MB_PER_SECOND;
    return Math.max(s.mb, est);
  }

  // Old sessions out, then the oldest finished ones while the sessions take (or will take) more than maxGb; one
  // building or being played stays.
  sweep() {
    const now = this.now();
    const playing = (s) => s.lastGetMs > 0 && now - s.lastGetMs < PLAYING_MS;
    const evict = (s, why) => { this.log({ event: 'home_evict', id: s.id, quality: s.quality, why, mb: Math.round(s.mb) }); this.#drop(s); };
    for (const s of [...this.byToken.values()]) {
      const last = s.lastPutMs || s.endedMs || s.startedMs;
      if (now - last > this.keepHours * 3600_000 && !playing(s)) evict(s, 'age');
    }
    const done = [...this.byToken.values()].filter((s) => (s.ended || s.state === 'failed') && !playing(s))
      .sort((a, b) => (a.lastPutMs || a.startedMs) - (b.lastPutMs || b.startedMs));
    let total = [...this.byToken.values()].reduce((n, s) => n + this.#expectedMb(s), 0);
    while (total > this.maxGb * 1000 && done.length) { const s = done.shift(); total -= s.mb; evict(s, 'size'); }
    // Builds and plays alone can take more; the disk alerts (tools/grafana.mjs) catch it if that ever fills /.
    if (total > this.maxGb * 1000) this.log({ event: 'home_over_cap', storedMb: Math.round(this.#storedMb()), expectedMb: Math.round(total), maxGb: this.maxGb });
  }

  state() {
    const all = [...this.byToken.values()];
    const d = this.#today();
    return { enabled: this.enabled, workers: this.relay?.capable?.('media') ?? [],
      today: { builds: d.builds, mb: Math.round(d.mb), cacheHits: d.cacheHits ?? 0, cacheMb: Math.round(d.cacheMb ?? 0) },
      cap: { builds: this.dailyBuilds, mb: this.dailyMb, storedGb: this.maxGb },
      building: all.filter((s) => s.state === 'building').length, ready: all.filter((s) => s.state === 'ready' && !s.ended).length,
      ended: all.filter((s) => s.ended).length, failed: all.filter((s) => s.state === 'failed').length,
      storedMb: Math.round(this.#storedMb()),
      expectedMb: Math.round([...this.byToken.values()].reduce((n, s) => n + this.#expectedMb(s), 0)) };
  }
}
