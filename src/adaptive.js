// Playback plans and adaptive HLS (owner, 2026-10-22: "720 is acceptable, 1080 looks noticeably better, <20 s could be
// well worth 720"; go straight to 1080p when Tunelio is fast; pace the upgrades so the credits last to renewal).
//
// Each video gets a plan, decided once (and again when its links expire):
//   lower    — the default quality only (720p), progressive: the room picked 720p, or the pacer says the extra credits
//              aren't there today. 10 credits.
//   direct   — 1080p progressive at once: /create reports the 1080p size before anything is built, and at the speed of
//              recent builds (visitors' and the speed probe's) it should be ready within `directSeconds`. Short videos
//              mostly land here. 10 credits.
//   adaptive — 720p first, stepping up to 1080p when that is built: a played ticket leads to our master playlist,
//              /hls/<token>.m3u8, listing our 720p and 1080p playlists (Tunelio's, with absolute segment links). 20
//              credits (the 1080p /create made for the size is reused).
//   start    — adaptive with a quick first rung (`start`, 360p): when the 720p HLS build itself is predicted to take more
//              than `startSeconds`, the player starts on a 360p HLS build (a much smaller file, so a few seconds) and
//              steps up as the builds finish. When the 1080p build is predicted ready within `startStepSeconds` of the
//              first master load, the master lists only 360p and 1080p: one switch (owner, 2026-10-23, #104: 360p →
//              720p at +7 s → 1080p at +17 s stuttered at the start, 360p → 1080p at +11 s didn't). Slower, it lists
//              360p, 720p, 1080p: two steps, so a big video still reaches 1080p (owner, same day, after fjords2's 1080p
//              took over 80 s). The players read the master and each variant playlist once, so that choice is made
//              when the master is first served and can't change later. In a two-rung session the 720p HLS build is
//              still made, unlisted: it stands in for a 1080p that fails or is AV1 on a Quest. 30 credits; the 720p
//              /create made for the prediction is reused. `startMid` (ADAPTIVE_START_MID=on) always lists the 720p. 360p through Tunelio rather than VRChat's free youtube.com path,
//              because only a Tunelio link can be a variant in our playlist (googlevideo links are single mp4s, bound to the IP that resolved them).
//
// Adaptive HLS was tested in VRChat on PC on 2026-10-22 (AVPro, Media Foundation): playback starts on the first variant;
// the player asks for the other one ~2 s in and switches without a stutter; a variant answering 404 is retried (about
// 50 tries in 3 s, then every ~6 s) and picked up within seconds once it exists. So the 1080p playlist is held here up to
// `holdMs` while it builds (fewer retries), then 404; if its build fails it serves the 720p playlist, ending the
// retries. The hold is 1 s, not 8: held 8 s, AVPro's picture stalled every 8 s while it played the lower rung
// (owner's A/B, 2026-10-23, #104: "many stutters" on 360p with 8 s, none with 1 s, 0 still frame pairs in 112). Tunelio only answers an HLS playlist once the whole file is built, so the start waits for the 720p build.
// The 1080p HLS build starts when a player first loads the master, not while the 720p one is still building.
//
// Every link we hand out is absolute: a player that reached a playlist through the ticket's redirect resolves relative
// links against the ticket URL (2026-10-22: "<token>/720p.m3u8" and Tunelio's "tunnel?id=…" both became /v1/3/… 404s
// and AVPro failed with "Loading failed"). The same goes for a plain HLS build (videos over 3 hours): the ticket
// redirects to our copy of its playlist, `single()`, not to Tunelio's.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

// Allows the extra credits of an adaptive play while today's spend stays under an even share of what is left until the
// plan renews, minus a reserve. remaining: () => credits left (null = unknown: allow); spentToday: () => spent today.
export class Pacer {
  constructor({ remaining, spentToday, daysLeft, reserve = 5000, cost = 10 }) {
    Object.assign(this, { remaining, spentToday, daysLeft, reserve, cost });
  }

  check() {
    const left = this.remaining();
    if (left == null) return { ok: true, allowance: null, spent: null };
    const allowance = Math.max(0, (left - this.reserve) / Math.max(1, this.daysLeft()));
    const spent = this.spentToday();
    return { ok: spent + this.cost <= allowance, allowance: Math.round(allowance), spent };
  }
}

const RES = { '360p': '640x360', '720p': '1280x720', '1080p': '1920x1080' };
// No CODECS on the variants: on Quest (AVPro's ExoPlayer) a master whose CODECS lists mp4a, without an audio group,
// plays muted, though the same variant playlists alone have sound. Measured 2026-10-23 with test slots 01/08-11
// (src/slots.js): with CODECS muted (-64 dB, the room alone), without it -26 dB; PC (Media Foundation) has sound either way.
const PLAN_MS = 30 * 60_000;

export class Adaptive {
  constructor({ playback, pacer, fetcher = fetch, log = () => {}, onEvent = () => {}, lower = '720p', upper = '1080p',
    holdMs = 1000, maxUpperMb = 1500, directSeconds = 10, now = () => Date.now(), base = 'https://yt.japharsworld.com/hls', switching = true,
    start = null, startSeconds = 10, startMid = false, startStepSeconds = 30, androidNoAv1 = false, stateFile = null }) {
    Object.assign(this, { playback, pacer, fetch: fetcher, log, onEvent, lower, upper, holdMs, maxUpperMb, directSeconds, now, base, switching, start, startSeconds, startMid, androidNoAv1 });
    this.startStepSeconds = startStepSeconds;
    this.byJob = new WeakMap(); // build job → its session
    this.plans = new Map();    // video id → { mode, upgrade, until, promise }
    this.sessions = new Map(); // token → { token, data, lowerJob, served, fellBack }
    this.byVideo = new Map();  // video id → token
    this.forced = new Map();   // video id → { mode, until }: test plans (force)
    // Sessions and test plans survive a restart (with Playback's liveFile for the builds behind them): a player keeps
    // asking for its session's rungs by token for the whole video, and an unknown token is a 404 for good.
    this.stateFile = stateFile;
    this.#load();
  }

  #load() {
    if (!this.stateFile) return;
    let st;
    try { st = JSON.parse(readFileSync(this.stateFile, 'utf8')); } catch { return; }
    const now = this.now();
    for (const [id, f] of Object.entries(st.forced ?? {})) if (f?.until > now) this.forced.set(id, f);
    for (const x of Array.isArray(st.sessions) ? st.sessions : []) {
      const data = { id: x?.id, seconds: x?.seconds };
      const job = x?.id && this.playback.peek?.(data, x.quality, { hls: x.hls });
      if (!job || !/^[a-f0-9]{18}$/.test(x.token) || !Array.isArray(x.rungs) || !Array.isArray(x.ladder)) continue;
      const s = { token: x.token, data, lowerJob: job, rungs: x.rungs, ladder: x.ladder, single: !!x.single, started: !!x.started,
        served: new Set(x.served ?? []), viewers: new Map(), best: x.ladder.includes(x.best) ? x.best : undefined };
      this.byJob.set(job, s);
      this.sessions.set(s.token, s);
    }
  }

  #save() {
    if (!this.stateFile) return;
    const sessions = [];
    for (const s of this.sessions.values()) {
      if (s.lowerJob.state === 'failed') continue;
      sessions.push({ token: s.token, id: s.data.id, seconds: s.data.seconds, quality: s.lowerJob.requested, hls: s.lowerJob.fixed,
        rungs: s.rungs, ladder: s.ladder, single: s.single, started: s.started, served: [...s.served], best: s.best ?? null });
    }
    try {
      writeFileSync(`${this.stateFile}.tmp`, JSON.stringify({ sessions: sessions.slice(-500), forced: Object.fromEntries(this.forced) }));
      renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (err) { this.log({ event: 'adaptive_state_failed', message: String(err?.message ?? err).slice(0, 200) }); }
  }

  // A test plan for one video until `minutes` from now (POST /ops/plan, tools/ops.mjs plan): its plays get `mode`
  // whatever the prediction, a room pick or the pacer say, so the test kit can play a given plan (e.g. `start`,
  // 360p → 1080p) without hunting for a video Tunelio is slow on (2026-10-23, #104). Tunelio failures still fall back
  // as usual. mode null clears it.
  force(id, mode, minutes = 60) {
    this.plans.delete(id);
    if (!mode) { this.forced.delete(id); this.#save(); return null; }
    const entry = { mode, until: this.now() + minutes * 60_000 };
    this.forced.set(id, entry);
    for (const [k, f] of this.forced) if (f.until < this.now()) this.forced.delete(k);
    this.#save();
    return entry;
  }

  forcedPlans() {
    return [...this.forced].filter(([, f]) => f.until > this.now()).map(([id, f]) => ({ id, mode: f.mode, until: new Date(f.until).toISOString() }));
  }

  // 'lower' | 'direct' | 'adaptive' | 'start' for a video. upgrade: 'always' (the room picked 1080p) | 'never' (picked 720p) |
  // 'paced' (no pick). Concurrent callers share one decision.
  plan(data, upgrade = 'paced') {
    const hit = this.plans.get(data.id);
    if (hit && hit.upgrade === upgrade && hit.until > this.now()) return hit.promise;
    const entry = { upgrade, until: this.now() + PLAN_MS };
    entry.promise = this.#decide(data, upgrade).then((mode) => { entry.mode = mode; return mode; });
    this.plans.set(data.id, entry);
    if (this.plans.size > 4000) for (const [k, p] of this.plans) if (p.until < this.now()) this.plans.delete(k);
    return entry.promise;
  }

  async #decide(data, upgrade) {
    const forced = this.forced.get(data.id);
    if (forced?.until > this.now()) return this.#forcedPlan(data, forced.mode);
    if (upgrade === 'never') return this.#chose(data, 'lower', { why: 'room_720p' });
    if (upgrade === 'paced') {
      const p = this.pacer?.check() ?? { ok: true };
      if (!p.ok) { this.onEvent('paced_off'); return this.#chose(data, 'lower', { why: 'pacer', allowance: p.allowance, spent: p.spent }); }
    }
    let mb;
    try { mb = await this.playback.size(data, this.upper); } catch (err) {
      return this.#chose(data, 'lower', { why: 'create_failed', status: err?.status });
    }
    if (mb > this.maxUpperMb) return this.#chose(data, 'lower', { why: 'too_big', mb });
    const predicted = Math.round(this.playback.predict('progressive', mb) * 10) / 10;
    if (predicted <= this.directSeconds) return this.#chose(data, 'direct', { mb, predicted });
    // Switching off: no 720p → 1080p step up mid-video. In VRChat on PC it froze the picture (clock running, no error)
    // in 2 of 4 tries on 2026-10-22, with segments and timestamps aligned; so a slow 1080p means 720p for this video.
    // A room that picked 1080p gets it anyway, slower to start.
    if (!this.switching) return this.#chose(data, upgrade === 'always' ? 'direct' : 'lower', { why: 'slow', mb, predicted });
    if (this.start) {
      // The 720p /create is the one the 720p build makes anyway, so asking for its size costs nothing extra.
      try {
        const lowerMb = await this.playback.size(data, this.lower);
        const lowerPredicted = Math.round(this.playback.predict('hls', lowerMb) * 10) / 10;
        if (lowerPredicted > this.startSeconds) return this.#chose(data, 'start', { mb, predicted, lowerMb, lowerPredicted });
      } catch { /* 720p /create failed: plain adaptive, whose 720p build asks again */ }
    }
    return this.#chose(data, 'adaptive', { mb, predicted });
  }

  async #forcedPlan(data, mode) {
    if (mode === 'lower') return this.#chose(data, 'lower', { why: 'forced' });
    let mb;
    try { mb = await this.playback.size(data, this.upper); } catch (err) {
      return this.#chose(data, 'lower', { why: 'create_failed', status: err?.status });
    }
    if (mode === 'start' && this.start) {
      try {
        const lowerMb = await this.playback.size(data, this.lower);
        return this.#chose(data, 'start', { why: 'forced', mb, lowerMb });
      } catch { /* as in #decide: plain adaptive */ }
    }
    return this.#chose(data, mode === 'direct' ? 'direct' : 'adaptive', { why: 'forced', mb });
  }

  #chose(data, mode, detail) {
    this.onEvent(`plan_${mode}`);
    this.log({ event: 'play_plan', id: data.id, mode, seconds: data.seconds, ...detail });
    return mode;
  }

  // The session for a ready HLS build, shared by everyone who plays it while that build's links last (a rebuild, hours
  // later, starts a new session). Adaptive sessions are on the 720p HLS build (or the 360p one for a `start` plan); single
  // ones on a plain HLS build. rungs: the variants the master lists; ladder: every build the session makes, lowest first
  // (a `start` session's 720p is built but not listed, see the top).
  session(data, job = this.playback.peek(data, this.lower, { hls: true }), { single = false } = {}) {
    let s = this.byJob.get(job);
    if (!s) {
      const startRung = this.start && job.requested === this.start;
      const ladder = startRung ? [this.start, this.lower, this.upper] : [this.lower, this.upper];
      const rungs = startRung && !this.startMid ? [this.start, this.upper] : ladder;
      s = { token: randomBytes(9).toString('hex'), data, lowerJob: job, rungs, ladder, single, started: false, served: new Set(), viewers: new Map() };
      this.byJob.set(job, s);
      this.sessions.set(s.token, s);
      if (this.sessions.size > 2000) this.sessions.delete(this.sessions.keys().next().value);
      this.#save();
    }
    return s;
  }

  // The URL to send a player to: the master playlist (adaptive), or our copy of a plain HLS build's playlist.
  url(s) { return s.single ? `${this.base}/${s.token}/${s.lowerJob.quality}.m3u8` : `${this.base}/${s.token}.m3u8`; }
  single(data, job) { return this.url(this.session(data, job, { single: true })); }

  // The build behind a rung: the session's own for the first, the shared HLS builds above it.
  #job(s, quality) { return quality === s.rungs[0] ? s.lowerJob : this.playback.peek(s.data, quality, { hls: true }); }

  bandwidth(job, factor = 1) {
    const bps = job?.mb > 0 && job.seconds > 0 ? (job.mb * 8e6) / job.seconds : 0;
    return Math.round((bps || 3_000_000) * factor * 1.1);
  }

  // The master playlist, or null for an unknown token. The first load starts the HLS builds above the first rung
  // (1080p only up to maxUpperMb). Players start on the first variant listed, which is the one already built.
  // viewer: an opaque per-player key (server.js: a hash of address and User-Agent, in memory only). A player loads the
  // master once per play, so the same player loading it again is someone pressing Play again (or the player retrying
  // after an error). Counted as reload_after_upgrade when that player had been served a higher rung, else
  // reload_before_upgrade: the freeze after a switch (2026-10-22) shows no error, so a reload is the closest signal
  // the server has. A proxy, not a freeze count: compare the two.
  master(token, viewer) {
    const s = this.sessions.get(token);
    if (!s || s.single) return null;
    if (viewer) {
      const v = s.viewers.get(viewer);
      if (v) this.onEvent(v.upgraded ? 'reload_after_upgrade' : 'reload_before_upgrade');
      else { s.viewers.set(viewer, { upgraded: false }); if (s.viewers.size > 200) s.viewers.delete(s.viewers.keys().next().value); }
    }
    if (!s.started) {
      s.started = true;
      if (s.rungs.length < s.ladder.length) {
        // One switch only when the 1080p build (starting now) should be ready soon. An unknown size, or no measured
        // builds to predict from, counts as slow: reaching 1080p matters more than the one switch.
        const mb = this.playback.knownMb(s.data.id, this.upper);
        const predicted = mb == null || !this.playback.measured() ? null : Math.round(this.playback.predict('hls', mb) * 10) / 10;
        if (predicted == null || predicted > this.startStepSeconds) s.rungs = s.ladder;
        this.onEvent(s.rungs.length === s.ladder.length ? 'start_mid' : 'start_one_step');
        this.log({ event: 'adaptive_start_rungs', id: s.data.id, rungs: s.rungs.length, mb, predicted });
      }
      for (const q of s.ladder.slice(1)) this.playback.start(s.data, q, { hls: true, maxMb: q === this.upper ? this.maxUpperMb : 0 });
      this.#save();
      this.onEvent('upgrade');
    }
    this.onEvent('master');
    const lines = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS'];
    s.rungs.forEach((q, i) => {
      // Before a rung's /create answers its size is unknown: guess from the first rung's.
      const job = this.#job(s, q);
      const bw = i === 0 || job?.mb > 0 ? this.bandwidth(job) : this.bandwidth(s.lowerJob, 1.8 ** s.ladder.indexOf(q));
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${RES[q]}`, `${this.base}/${token}/${q}.m3u8`);
    });
    return `${lines.join('\n')}\n`;
  }

  // What a session's players have been given so far, for the tablet's ticket status (owner, 2026-10-23, #104: AVPro
  // reports the top variant's size from the start, so the world can't tell the real rung itself).
  //   rung: the highest build actually served to the session's players ('360p' | '720p' | '1080p'), null before any;
  //         a fallback counts as what it is (a failed 1080p answered with the 720p is '720p')
  //   top:  'served' (the top rung's own build went out) | 'failed' (its build failed, or is AV1 for a Quest: it won't
  //         come) | 'pending'
  // Null for a job without an adaptive session (progressive and plain HLS plays).
  progress(job) {
    const s = job && this.byJob.get(job);
    if (!s || s.single) return null;
    const top = s.rungs.at(-1);
    return {
      rung: s.best ?? null,
      top: s.served.has(top) ? 'served' : s.served.has(`failed:${top}`) || s.served.has(`av1:${top}`) ? 'failed' : 'pending',
    };
  }

  // Records the build a session's player was just given (progress).
  #gave(s, job, text) {
    if (!text || !job) return text;
    const q = job.requested;
    if (s.best == null || s.ladder.indexOf(q) > s.ladder.indexOf(s.best)) s.best = q;
    return text;
  }

  // A variant playlist: Tunelio's, with its segment links made absolute. Null = not (yet) available (404).
  // android: the player is Quest's (src/playback.js isAndroidPlayer). With androidNoAv1 (HOME_ANDROID=on), a higher rung
  // whose build is AV1, which the Quest 2 can't decode, is answered like a failed one: with the best rung below that
  // isn't, so the play tops out lower instead of failing at the step up. (The master can't leave it out: when it is
  // served, the higher builds have only just started.) A first rung that is AV1 goes home instead (server.js).
  async variant(token, quality, viewer, { android = false } = {}) {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.single) return quality === s.lowerJob.quality ? this.#playlist(s.lowerJob) : null;
    const i = s.rungs.indexOf(quality);
    if (i < 0) return null;
    if (i === 0) return this.#gave(s, s.lowerJob, await this.#playlist(s.lowerJob));
    let up = this.#job(s, quality);
    if (!up) return null;
    // Every build below this rung, listed or not (a `start` session's 720p).
    const under = s.ladder.slice(0, s.ladder.indexOf(quality)).map((q) => this.#job(s, q));
    if (up.state === 'building') up = await this.playback.wait(up, this.holdMs);
    if (up.state === 'building') return null;
    if (up.state === 'failed') {
      // The best ready build below it, which ends the player's retries of this one.
      if (!s.served.has(`failed:${quality}`)) { s.served.add(`failed:${quality}`); this.onEvent('upgrade_failed'); this.log({ event: 'adaptive_upgrade_failed', id: s.data.id, quality, reason: up.reason }); }
      const got = under.filter((j) => j?.state === 'ready').at(-1) ?? s.lowerJob;
      return this.#gave(s, got, await this.#playlist(got));
    }
    if (android && this.androidNoAv1 && await this.codec(up) === 'av1') {
      if (!s.served.has(`av1:${quality}`)) { s.served.add(`av1:${quality}`); this.onEvent('android_av1_rung'); this.log({ event: 'android_av1', id: s.data.id, quality, rung: i }); }
      const below = [];
      for (const j of under) if (j?.state === 'ready' && await this.codec(j) !== 'av1') below.push(j);
      const got = below.at(-1) ?? s.lowerJob;
      return this.#gave(s, got, await this.#playlist(got));
    }
    const text = this.#gave(s, up, await this.#playlist(up));
    const v = viewer && s.viewers.get(viewer);
    if (text && v) v.upgraded = true;
    if (text && !s.served.has(quality)) { s.served.add(quality); this.onEvent('upgrade_served'); this.log({ event: 'adaptive_upgrade_served', id: s.data.id, quality, mb: up.mb, buildMs: up.endedMs - up.startedMs }); }
    return text;
  }

  // The video codec of a ready HLS build: 'av1' | 'h264' | 'hevc' | 'vp9', or null when unknown. Read from the sample
  // entry in its init segment (the EXT-X-MAP file, a few KB), once per build. The Quest 2 can't decode AV1, and
  // Tunelio's builds sometimes are (Everything-is-OK #101), so an Android play of one goes home instead (server.js).
  // Only the playlist's head is read for the EXT-X-MAP line (2026-10-23, Quest: a fresh 1080p HLS playlist took over
  // 15 s to arrive whole, and the play waited for it), and concurrent asks for the same build share one read.
  codec(job) {
    if (!job || job.state !== 'ready') return Promise.resolve(null);
    if (job.codec !== undefined) return Promise.resolve(job.codec);
    job.codecRead ??= this.#readCodec(job).finally(() => { job.codecRead = null; });
    return job.codecRead;
  }

  // The init segment's URL from the first lines of a build's playlist (absolute), or null.
  async #mapUrl(job) {
    const find = (text) => text.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/)?.[1];
    if (job.playlist) return find(job.playlist) ?? null; // already absolute
    try {
      const res = await this.fetch(job.url, { signal: AbortSignal.timeout(15_000) });
      if (res.status !== 200) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
      let head = '';
      const reader = res.body?.getReader?.();
      if (!reader) head = await res.text();
      else {
        const dec = new TextDecoder();
        // Up to the first segment line, the MAP line with its end, or 64 KB.
        while (head.length < 65536 && !/#EXT-X-MAP:[^\n]*\n/.test(head) && !/\n[^#\s][^\n]*\n/.test(head)) {
          const { value, done } = await reader.read();
          if (done) break;
          head += dec.decode(value, { stream: true });
        }
        try { await reader.cancel(); } catch { /* ignore */ }
      }
      const u = find(head);
      return u ? new URL(u, job.url).href : null;
    } catch (err) {
      this.log({ event: 'adaptive_codec_error', id: job.id, quality: job.quality, message: String(err?.message ?? err).slice(0, 200) });
      return null;
    }
  }

  async #readCodec(job) {
    const map = await this.#mapUrl(job);
    if (!map) return null; // TS segments or no playlist: not known (not cached, so a later play asks again)
    try {
      const res = await this.fetch(map, { headers: { range: 'bytes=0-65535' }, signal: AbortSignal.timeout(10_000) });
      if (res.status !== 200 && res.status !== 206) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
      const head = Buffer.from(await res.arrayBuffer()).subarray(0, 65536).toString('latin1');
      const box = head.match(/av01|avc[13]|hev1|hvc1|vp09/)?.[0];
      job.codec = box ? { av01: 'av1', avc1: 'h264', avc3: 'h264', hev1: 'hevc', hvc1: 'hevc', vp09: 'vp9' }[box] : null;
      return job.codec;
    } catch (err) {
      this.log({ event: 'adaptive_codec_error', id: job.id, quality: job.quality, message: String(err?.message ?? err).slice(0, 200) });
      return null;
    }
  }

  async #playlist(job) {
    if (!job || job.state !== 'ready' || !job.url) return null;
    if (job.playlist) return job.playlist;
    try {
      const res = await this.fetch(job.url, { signal: AbortSignal.timeout(15_000) });
      if (res.status !== 200) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
      const abs = (u) => new URL(u, job.url).href;
      job.playlist = (await res.text()).split(/\r?\n/)
        .map((l) => (l && !l.startsWith('#') ? abs(l.trim()) : l.replace(/URI="([^"]+)"/, (_, u) => `URI="${abs(u)}"`))).join('\n');
      return job.playlist;
    } catch (err) {
      this.log({ event: 'adaptive_playlist_error', id: job.id, quality: job.quality, message: String(err?.message ?? err).slice(0, 200) });
      return null;
    }
  }
}
