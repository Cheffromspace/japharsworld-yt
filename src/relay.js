// Search relay: workers on residential connections (the owner's Optiplex) long-poll this server over HTTPS for
// search jobs and post the results back. Nothing on the worker's side accepts connections.
//   GET  /relay/next?worker=<name>&version=<v>&caps=<a,b>&paused=<kind:s,…>   held up to pollMs; 204 (nothing) or 200 {"job": {...}}
//   POST /relay/done                             {id, ok, page: {videos, cont} | captions | media, error, refusal, paused}
//   PUT  /relay/media/<token>/<file>             a media job's segments and playlist (src/home.js)
// Jobs: {id, kind: "search", query, limit}, {id, kind: "more", cont} (sent to the worker that holds `cont`),
// {kind: "captions", ...}, {kind: "media", videoId, quality, token} (only to a worker that announced caps=media).
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

export class RelayError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// A worker's back-off (relay/worker.js, YouTube risk fix 3): `search:600,captions:1200` = kinds paused and the
// seconds left. → { kind: untilMs }, or null for anything malformed. At most 2 h (the worker's longest pause).
const PAUSE_KINDS = ['search', 'captions', 'media'];
export function parsePaused(list, now = Date.now()) {
  const out = {};
  for (const item of Array.isArray(list) ? list : String(list ?? '').split(',')) {
    const m = /^([a-z]{1,16}):(\d{1,5})$/.exec(String(item).trim());
    if (m && PAUSE_KINDS.includes(m[1])) out[m[1]] = now + Math.min(7200, Number(m[2])) * 1000;
  }
  return out;
}

const digest = (s) => createHash('sha256').update(String(s)).digest();
export function tokenMatches(header, token) {
  if (!token) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return Boolean(m) && timingSafeEqual(digest(m[1].trim()), digest(token));
}

export class Relay {
  constructor({ token = '', pollMs = 25_000, onlineMs = 30_000, now = () => Date.now(), log = () => {} } = {}) {
    this.token = token;
    this.pollMs = pollMs;
    this.onlineMs = onlineMs;
    this.now = now;
    this.log = log;
    this.workers = new Map(); // name → { seen, version, caps, polling, paused: { kind: untilMs } }
    this.waiting = []; // { worker, give(job) }
    this.queue = []; // { job, worker|null }
    this.inflight = new Map(); // id → { resolve, reject, timer, worker }
    this.lastSeenAny = now(); // counts from start so "no worker for 10 minutes" also fires after a restart
  }

  get enabled() { return Boolean(this.token); }
  authorized(header) { return tokenMatches(header, this.token); }

  isOnline(name) {
    const w = this.workers.get(name);
    return Boolean(w) && (w.polling > 0 || this.now() - w.seen < this.onlineMs);
  }
  isPaused(name, kind) { return (this.workers.get(name)?.paused?.[kind] ?? 0) > this.now(); }
  // Online workers; with a kind (search, captions, media), only those that haven't paused it. Without one, a paused
  // worker still counts, so idleMs() and the no_worker alert don't take a back-off for a missing worker.
  online(kind = null) { return [...this.workers.keys()].filter((n) => this.isOnline(n) && !(kind && this.isPaused(n, kind))); }
  // Online workers that announced this capability (`media`: ffmpeg is there, relay/media.js) and haven't paused it.
  capable(cap) { return this.online(cap).filter((n) => this.workers.get(n).caps?.includes(cap)); }
  idleMs() { return this.online().length ? 0 : this.now() - this.lastSeenAny; }
  // For /ops/state: { worker: { kind: seconds left } } for the pauses running now.
  paused() {
    const t = this.now();
    const out = {};
    for (const n of this.online()) {
      const left = Object.entries(this.workers.get(n).paused ?? {}).filter(([, u]) => u > t).map(([k, u]) => [k, Math.ceil((u - t) / 1000)]);
      if (left.length) out[n] = Object.fromEntries(left);
    }
    return out;
  }

  // For /ops/state: { worker: streams at once } for online workers that announced it (RELAY_MEDIA_MAX).
  mediaMax() { return Object.fromEntries(this.online().filter((n) => this.workers.get(n).mediaMax != null).map((n) => [n, this.workers.get(n).mediaMax])); }

  #setPaused(name, w, list) {
    const next = parsePaused(list, this.now());
    const kinds = (p) => Object.keys(p ?? {}).filter((k) => p[k] > this.now()).sort().join(',');
    if (kinds(next) !== kinds(w.paused)) this.log({ event: 'relay_paused', worker: name, kind: kinds(next) || null });
    w.paused = next;
  }

  #seen(name, version, caps, paused, mediaMax = null) {
    const t = this.now();
    let w = this.workers.get(name);
    if (!w || !this.isOnline(name)) this.log({ event: 'relay_worker_online', worker: name, version });
    if (!w) this.workers.set(name, (w = { seen: t, version, polling: 0 }));
    w.seen = t;
    if (version) w.version = version;
    if (caps) w.caps = caps;
    if (mediaMax != null) w.mediaMax = mediaMax;
    if (paused !== undefined) this.#setPaused(name, w, paused);
    this.lastSeenAny = t;
    return w;
  }

  // Shutting down: held polls answer "nothing" now, so a deploy restart reaches the worker as an empty poll instead of a
  // cut connection (Caddy 502; 341 in the week to 2026-10-25, about 4.6 per restart).
  drain() {
    this.draining = true;
    for (const w of [...this.waiting]) w.give(null);
  }

  // A worker's long poll. Resolves with a job, or null after pollMs (or when `signal` aborts).
  // `paused`: the worker's back-off list from the poll (none = nothing paused).
  next(name, version, signal, caps = null, paused = '', mediaMax = null) {
    const w = this.#seen(name, version, caps, paused, mediaMax);
    if (this.draining) return Promise.resolve(null);
    const i = this.queue.findIndex((q) => q.worker == null || q.worker === name);
    if (i >= 0) return Promise.resolve(this.#hand(this.queue.splice(i, 1)[0].job, name));
    return new Promise((resolve) => {
      w.polling++;
      const waiter = { worker: name, give: (job) => { finish(); resolve(job && this.#hand(job, name)); } };
      const timer = setTimeout(() => { finish(); resolve(null); }, this.pollMs);
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const k = this.waiting.indexOf(waiter);
        if (k >= 0) this.waiting.splice(k, 1);
        w.polling--;
        w.seen = this.now();
        this.lastSeenAny = w.seen;
      };
      const onAbort = () => { finish(); resolve(null); };
      signal?.addEventListener('abort', onAbort);
      this.waiting.push(waiter);
    });
  }

  #hand(job, name) {
    const f = this.inflight.get(job.id);
    if (f) f.worker = name;
    return job;
  }

  // A worker's answer. False when nobody is waiting for it any more (timed out).
  done(result) {
    const f = this.inflight.get(result?.id);
    if (!f) return false;
    this.inflight.delete(result.id);
    clearTimeout(f.timer);
    // A refusal just paused a kind: skip the worker for it now, not from its next poll.
    const w = f.worker && this.workers.get(f.worker);
    if (w && Array.isArray(result.paused)) this.#setPaused(f.worker, w, result.paused);
    if (result.ok && result.page && Array.isArray(result.page.videos)) f.resolve({ ...result.page, worker: f.worker });
    else if (result.ok && result.captions && typeof result.captions === 'object') f.resolve({ ...result.captions, worker: f.worker });
    else if (result.ok && result.media && typeof result.media === 'object') f.resolve({ ...result.media, worker: f.worker });
    else f.reject(new RelayError(result.error === 'expired' ? 'expired' : 'worker_failed', String(result.error ?? 'worker failed')));
    return true;
  }

  // A video's caption track list and one track from a worker (relay/captions.js). want: { lang } | { code, auto } | null.
  captions(videoId, want, opts = {}) {
    const worker = this.online('captions')[0];
    if (!worker) return Promise.reject(new RelayError('offline', 'no caption worker online'));
    return this.run({ kind: 'captions', videoId, want }, { ...opts, worker });
  }

  // Sends a job (to `worker`, or to whoever polls first) and waits up to timeoutMs for its result.
  run(fields, { worker = null, timeoutMs = 8000 } = {}) {
    const job = { id: randomUUID(), ...fields };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(job.id);
        const i = this.queue.findIndex((q) => q.job === job);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new RelayError('timeout', `worker did not answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.inflight.set(job.id, { resolve, reject, timer, worker });
      const w = this.waiting.find((x) => worker == null || x.worker === worker);
      if (w) w.give(job);
      else this.queue.push({ job, worker });
    });
  }

  // A page from a worker; `more` asks the same worker for the next one and is RelayError('expired') once it is gone.
  async search(query, limit, opts = {}) {
    const worker = this.online('search')[0];
    if (!worker) throw new RelayError('offline', 'no search worker online');
    return this.#page(await this.run({ kind: 'search', query, limit }, { ...opts, worker }), opts);
  }

  #page(p, opts) {
    const { worker, cont } = p;
    const more = cont ? () => {
      if (!this.isOnline(worker) || this.isPaused(worker, 'search')) return Promise.reject(new RelayError('expired', `worker ${worker} is gone or paused`));
      return this.run({ kind: 'more', cont }, { ...opts, worker }).then((n) => this.#page(n, opts));
    } : null;
    if (more) Object.assign(more, { via: 'worker', worker, cont });
    return { videos: p.videos, more, via: 'worker', worker };
  }
}
