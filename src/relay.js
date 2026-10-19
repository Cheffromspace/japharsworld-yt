// Search relay: workers on residential connections (the owner's Optiplex) long-poll this server over HTTPS for
// search jobs and post the results back. Nothing on the worker's side accepts connections.
//   GET  /relay/next?worker=<name>&version=<v>   held up to pollMs; 204 (nothing) or 200 {"job": {...}}
//   POST /relay/done                             {id, ok, page: {videos, cont}, error}
// Jobs: {id, kind: "search", query, limit} or {id, kind: "more", cont} (sent to the worker that holds `cont`).
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

export class RelayError extends Error {
  constructor(code, message) { super(message); this.code = code; }
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
    this.workers = new Map(); // name → { seen, version, polling }
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
  online() { return [...this.workers.keys()].filter((n) => this.isOnline(n)); }
  idleMs() { return this.online().length ? 0 : this.now() - this.lastSeenAny; }

  #seen(name, version) {
    const t = this.now();
    let w = this.workers.get(name);
    if (!w || !this.isOnline(name)) this.log({ event: 'relay_worker_online', worker: name, version });
    if (!w) this.workers.set(name, (w = { seen: t, version, polling: 0 }));
    w.seen = t;
    if (version) w.version = version;
    this.lastSeenAny = t;
    return w;
  }

  // A worker's long poll. Resolves with a job, or null after pollMs (or when `signal` aborts).
  next(name, version, signal) {
    const w = this.#seen(name, version);
    const i = this.queue.findIndex((q) => q.worker == null || q.worker === name);
    if (i >= 0) return Promise.resolve(this.#hand(this.queue.splice(i, 1)[0].job, name));
    return new Promise((resolve) => {
      w.polling++;
      const waiter = { worker: name, give: (job) => { finish(); resolve(this.#hand(job, name)); } };
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
    if (result.ok && result.page && Array.isArray(result.page.videos)) f.resolve({ ...result.page, worker: f.worker });
    else f.reject(new RelayError(result.error === 'expired' ? 'expired' : 'worker_failed', String(result.error ?? 'worker failed')));
    return true;
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
    const worker = this.online()[0];
    if (!worker) throw new RelayError('offline', 'no search worker online');
    return this.#page(await this.run({ kind: 'search', query, limit }, { ...opts, worker }), opts);
  }

  #page(p, opts) {
    const { worker, cont } = p;
    const more = cont ? () => {
      if (!this.isOnline(worker)) return Promise.reject(new RelayError('expired', `worker ${worker} is gone`));
      return this.run({ kind: 'more', cont }, { ...opts, worker }).then((n) => this.#page(n, opts));
    } : null;
    if (more) Object.assign(more, { via: 'worker', worker, cont });
    return { videos: p.videos, more, via: 'worker', worker };
  }
}
