// A per-visitor daily allowance for new builds, on Tunelio and at home together (owner, 2026-11-04: "I don't want a
// single person able to exhaust the limits", and no overflow to home for someone over their own limit). Keyed on the
// client IP, per reporting day (METRICS_TZ). Over it a play gets the youtube.com fallback (owner, same day: "We can
// send them to YouTube 360p as a final fallback"): no Tunelio credits, no home work. Cached builds and home sessions
// already there cost nothing and stay open to everyone.
//
// Sized from prod, 2026-10-26..11-04 (the journal's plays and warms per shard and day; a shard holds one room or more,
// so this is an upper bound for one visitor): the busiest shard-day had 34 distinct videos on Tunelio (10-31, ~18
// credits a video that day: 1700 for 95, so ~610 credits) and 12 home sessions (10-31); the most home MB in one
// shard-day was ~28 GB (10-30, long 1080p mixes). Six people behind one NAT watching ~10 new videos each in an evening
// at ~20 credits: ~1200. So the defaults: 1500 credits, 25 home builds and 35,000 MB a day per IP, under the home
// relay's own daily caps (HOME_DAILY_BUILDS 40, HOME_DAILY_MB 50,000) and the spend day budget (8000). A trusted IP
// (TRUSTED_IPS) gets trustedFactor times each; the global caps still bind it.
//
// Home MB is counted when a session starts, at its expected size (its length at 1080p's rate, src/home.js), since the
// real size arrives later. Tunelio credits are counted as each paid call is made and given back if it fails, as in
// src/spend.js; caption transcripts count too.
//
// Memory only: counts per IP are never written to disk or logged (no IP in any event). A restart starts the day's
// counts again, a known gap: deploys restart the service, a visitor can't.
import { limitFor } from './trusted.js';
import { dayOf } from './metrics.js';

const MINUTE = 60_000;

export class Allowance {
  constructor({ creditsPerIp = 1500, homeBuildsPerIp = 25, homeMbPerIp = 35_000, trusted = null, trustedFactor = 10,
    maxKeys = 10_000, tz = 'America/Chicago', now = () => Date.now(), log = () => {}, onReached = () => {} } = {}) {
    Object.assign(this, { creditsPerIp, homeBuildsPerIp, homeMbPerIp, trusted, trustedFactor, maxKeys, tz, now, log, onReached });
    this.day = dayOf(this.now(), this.tz);
    this.byIp = new Map(); // ip → { credits, homeBuilds, homeMb, at, reached: Set }, least recently active first
  }

  #today() {
    const d = dayOf(this.now(), this.tz);
    if (d !== this.day) { this.day = d; this.byIp.clear(); }
  }

  #trusted(ip) { return Boolean(ip && this.trusted?.has(ip)); }
  #limit(n, ip) { return limitFor(n, this.#trusted(ip), this.trustedFactor); }

  // This IP's counts, made (and moved to the end, most recently active) when `create`. When the map is full, a new IP
  // makes room only from IPs with nothing in the last minute; if every one is active, null (refused as over).
  #entry(ip, create) {
    let e = this.byIp.get(ip);
    if (!e && !create) return null;
    const now = this.now();
    if (!e) {
      for (const [k, v] of this.byIp) {
        if (this.byIp.size < this.maxKeys || now - v.at < MINUTE) break;
        this.byIp.delete(k);
      }
      if (this.byIp.size >= this.maxKeys) return null;
      e = { credits: 0, homeBuilds: 0, homeMb: 0, at: now, reached: new Set() };
    }
    this.byIp.delete(ip);
    e.at = now;
    this.byIp.set(ip, e);
    return e;
  }

  // Which of this IP's allowances a new build would pass, or has already used up: 'credits', 'home_builds' or 'home_mb'
  // (any one used up stops every new build, home and Tunelio: one allowance), or null. `credits`: a Tunelio call's
  // cost; `home`, `homeMb`: a home session and its expected MB. No IP (a build outside any request): null. The first time each is
  // reached in a day it is logged as allowance_reached (route youtube: where the play goes) and counted.
  over(ip, { credits = 0, home = false, homeMb = 0 } = {}) {
    if (!ip) return null;
    this.#today();
    const e = this.#entry(ip, true);
    if (!e) return 'full'; // maxKeys IPs all active in the last minute: refused, not counted (nothing to keep it in)
    let kind = null;
    const cl = this.#limit(this.creditsPerIp, ip), bl = this.#limit(this.homeBuildsPerIp, ip), ml = this.#limit(this.homeMbPerIp, ip);
    if (cl > 0 && (e.credits >= cl || e.credits + credits > cl)) kind = 'credits';
    else if (bl > 0 && (e.homeBuilds >= bl || (home && e.homeBuilds + 1 > bl))) kind = 'home_builds';
    else if (ml > 0 && (e.homeMb >= ml || (home && e.homeBuilds > 0 && e.homeMb + homeMb > ml))) kind = 'home_mb'; // a first home build always fits
    if (kind) this.#reached(ip, e, kind);
    return kind;
  }

  #reached(ip, e, kind) {
    if (e.reached.has(kind)) return;
    e.reached.add(kind);
    this.onReached(kind);
    this.log({ event: 'allowance_reached', kind, route: 'youtube', ...(this.#trusted(ip) ? { trusted: true } : {}) });
  }

  // Count a new build for this IP; returns a refund (a failed Tunelio call gives its credits back).
  charge(ip, { credits = 0, homeBuilds = 0, homeMb = 0 } = {}) {
    if (!ip) return () => {};
    this.#today();
    const e = this.#entry(ip, true);
    if (!e) return () => {};
    e.credits += credits; e.homeBuilds += homeBuilds; e.homeMb += homeMb;
    const day = this.day;
    return () => { if (this.day === day) { e.credits = Math.max(0, e.credits - credits); e.homeBuilds = Math.max(0, e.homeBuilds - homeBuilds); e.homeMb = Math.max(0, e.homeMb - homeMb); } };
  }

  // The day's counts go at the day's end even with no request to notice it (server.js, every minute).
  sweep() { this.#today(); }

  // For /ops/state: how many IPs have counts today and how many reached each allowance. Numbers only.
  state() {
    this.#today();
    const reached = { credits: 0, home_builds: 0, home_mb: 0 };
    for (const e of this.byIp.values()) for (const k of e.reached) reached[k]++;
    return { ips: this.byIp.size, reached, perIp: { credits: this.creditsPerIp, homeBuilds: this.homeBuildsPerIp, homeMb: this.homeMbPerIp } };
  }
}
