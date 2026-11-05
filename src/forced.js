// Forced limits, for tests on STAGING ONLY (Everything-is-OK#545, 2026-11-05): POST /ops/limit (tools/ops.mjs limit)
// makes the service answer as if a visitor were over their own limits, for one video or for the caller's own visitor
// key, for a set time, then it lapses by itself (memory only, so a restart clears it too). The world's #527 daily-limit
// hand-off could otherwise only be reached with an env change and a restart, or ~12 paid builds inside a minute; and
// the home network is trusted (TRUSTED_IPS, x10), so the real limits are far away for a tester.
//   daily_limit: a play of the target answers exactly as over the daily allowance (reason allowance): a Quest's .m3u8
//     ticket or an Android player a fast 403 daily_limit, the tablet a failed daily_limit status (a youtube/allowance
//     one on a plain ticket), a PC player youtube.com. Ahead of pins, home and Tunelio, so it spends nothing.
//   rate_limited: the target's ticket requests (and, for a visitor, their searches and More pages) get 429 rate_limited.
// Trusted IPs get it as well: the forcing is the point. A visitor target is the day's keyed code (src/ipkey.js), so
// it stops matching at the day boundary (METRICS_TZ midnight), before its minutes if they run past it.
//
// Never on production. allowedHere() is true only when PUBLIC_URL's host starts with "staging" ("staging-yt.eiok.cc");
// production's is yt.japharsworld.com, and an unset PUBLIC_URL defaults to it, so a missing setting fails closed.
// Off, the server builds no ForcedLimits at all (nothing to match on a play) and /ops/limit answers 403 not_staging
// (test/routing.test.js, "forced limits").

export const MODES = ['daily_limit', 'rate_limited'];
export const MAX_MINUTES = 240;

export function allowedHere(publicUrl) {
  try { return /^staging[-.]/i.test(new URL(publicUrl).hostname); } catch { return false; }
}

export class ForcedLimits {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.byVideo = new Map(); // video id → { mode, until }
    this.byVisitor = new Map(); // visitor key (the day's keyed IP code, src/ipkey.js; never an address) → { mode, until }
  }

  #sweep() {
    const now = this.now();
    for (const m of [this.byVideo, this.byVisitor]) for (const [k, f] of m) if (f.until <= now) m.delete(k);
  }

  // mode null clears the target. One of id / visitor.
  force({ id = null, visitor = null, mode, minutes = 30 }) {
    const map = id ? this.byVideo : this.byVisitor;
    const key = id ?? visitor;
    if (!key) return null;
    if (!mode) { map.delete(key); this.#sweep(); return null; }
    const entry = { mode, until: this.now() + Math.min(MAX_MINUTES, Math.max(1, minutes)) * 60_000 };
    map.set(key, entry);
    this.#sweep();
    return entry;
  }

  // Whether `mode` is forced for this request's video or visitor.
  has(mode, { id = null, visitor = null } = {}) {
    if (!this.byVideo.size && !this.byVisitor.size) return false;
    const now = this.now();
    const hit = (f) => Boolean(f && f.mode === mode && f.until > now);
    return (id != null && hit(this.byVideo.get(id))) || (visitor != null && hit(this.byVisitor.get(visitor)));
  }

  // For /ops/limit: video targets with their id (the tester chose it), visitor targets never with their key, only
  // whether it's the caller's.
  list(caller = null) {
    this.#sweep();
    const at = (f) => new Date(f.until).toISOString();
    return [...[...this.byVideo].map(([id, f]) => ({ target: 'video', id, mode: f.mode, until: at(f) })),
      ...[...this.byVisitor].map(([k, f]) => ({ target: 'visitor', you: k === caller, mode: f.mode, until: at(f) }))];
  }
}
