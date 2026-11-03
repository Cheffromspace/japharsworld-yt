// Spend limits for paid Tunelio builds (Everything-is-OK#478): a hard budget in credits per hour and per day, and
// build rate limits per client IP and per shard. Playback asks before every new paid /create (src/playback.js); over a
// limit there is no new build, and the play goes home or to youtube.com instead. Cached builds, home builds and
// refused videos never get here.
//
// Real spend, prod 2026-10-26..11-03 (metrics.db credits/playback and the journal's builds): busiest day 1,700
// playback credits (10-31), next 710; busiest hour ~310 (31 builds, 10-31 02h UTC); busiest minute 9 builds, the
// same few videos at more than one quality. So the defaults (SPEND_HOUR_CREDITS 800, SPEND_DAY_CREDITS 4000) are about
// 2.5x the busiest real hour and 2.4x the busiest real day, under 5 % of the 85,260 credits left on 11-03.
//
// The rate limits count distinct videos that started a paid build in the last minute, so one play's several /create
// calls (adaptive's two qualities, a downgrade) count once. A room holds 6, hence 6 a minute per shard.
//
// Windows roll (the last 60 minutes, the last 24 hours) and the spends are kept in stateFile (times and credits only),
// so a restart doesn't hand out a fresh budget.

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

// The request a paid build would be made for: { ip, shard }. server.js runs each ticket and lookup in it; a build made
// outside any request (a restart resuming one) has none and meets the budget only.
export const spendScope = new AsyncLocalStorage();

const HOUR = 3600_000, DAY = 24 * HOUR, MINUTE = 60_000;

// Sets `key` as the most recently active of a map, keeping at most `max` keys: past it, the least recently active go
// (the first in insertion order, since every update moves its key to the end). Never a wholesale clear, which would
// hand every key a fresh count at once.
export function touch(map, key, value, max = 10_000) {
  map.delete(key);
  map.set(key, value);
  for (const k of map.keys()) { if (map.size <= max) break; map.delete(k); }
}

export class SpendGate {
  constructor({ hourCredits = 800, dayCredits = 4000, perIpPerMinute = 4, perShardPerMinute = 6, cost = 10,
    alert = () => {}, log = () => {}, now = () => Date.now(), stateFile = null } = {}) {
    Object.assign(this, { hourCredits, dayCredits, perIpPerMinute, perShardPerMinute, cost, alert, log, now, stateFile });
    this.spends = []; // { at, c }, oldest first, the last 24 h
    this.byIp = new Map(); // ip → [{ id, at }]
    this.byShard = new Map(); // shard → [{ id, at }]
    this.over = null; // 'hour' | 'day' while over budget (for the one alert and its all-clear)
    this.#load();
  }

  #load() {
    if (!this.stateFile) return;
    try {
      const st = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      const since = this.now() - DAY;
      this.spends = (Array.isArray(st.spends) ? st.spends : []).filter((s) => Number.isFinite(s?.at) && s.at > since && s.c > 0);
    } catch { /* none yet */ }
  }

  #save() {
    if (!this.stateFile) return;
    try {
      writeFileSync(`${this.stateFile}.tmp`, JSON.stringify({ spends: this.spends }));
      renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (err) { this.log({ event: 'spend_state_failed', message: String(err?.message ?? err).slice(0, 200) }); }
  }

  spent(ms) {
    const since = this.now() - ms;
    let n = 0;
    for (const s of this.spends) if (s.at > since) n += s.c;
    return n;
  }

  // Which budget another build would break: 'hour', 'day' or null. Sends the alert when it first breaks and the
  // all-clear when there is room again (check() runs every minute too, so the all-clear doesn't wait for a play).
  check(cost = this.cost) {
    const hour = this.spent(HOUR), day = this.spent(DAY);
    const over = this.dayCredits > 0 && day + cost > this.dayCredits ? 'day' : this.hourCredits > 0 && hour + cost > this.hourCredits ? 'hour' : null;
    if (over && !this.over) {
      this.log({ event: 'spend_budget', state: 'hit', window: over, hour, day, hourCredits: this.hourCredits, dayCredits: this.dayCredits });
      this.alert('spend_budget', `Tunelio spend budget reached (${over === 'day' ? `${day} of ${this.dayCredits} credits in 24 h` : `${hour} of ${this.hourCredits} credits in an hour`}): no new HD builds, plays go to the home relay or youtube.com until it frees up.`, 24 * 60);
    } else if (!over && this.over) {
      this.log({ event: 'spend_budget', state: 'reset', window: this.over, hour, day });
      this.alert.resolve?.('spend_budget', `Tunelio spend is back under budget (${hour} credits in the last hour, ${day} in 24 h): HD builds are back.`);
    }
    this.over = over;
    return over;
  }

  // A paid call is being made: count it now (so calls at once can't all pass), and give back a refund for a failed one.
  charge(cost = this.cost) {
    const now = this.now();
    while (this.spends.length && this.spends[0].at <= now - DAY) this.spends.shift();
    const s = { at: now, c: cost };
    this.spends.push(s);
    this.#save();
    return () => { const i = this.spends.indexOf(s); if (i >= 0) { this.spends.splice(i, 1); this.#save(); } };
  }

  // The rate limit this request's new build of `id` would break: 'ip', 'shard' or null. A video this IP (or shard)
  // already started in the window counts once. With record, an allowed build is counted.
  #rate(id, record) {
    const ctx = spendScope.getStore();
    if (!ctx) return null;
    const now = this.now();
    const fresh = (map, k) => (map.get(k) ?? []).filter((e) => now - e.at < MINUTE);
    const ip = ctx.ip ? fresh(this.byIp, ctx.ip) : null;
    const shard = ctx.shard != null ? fresh(this.byShard, ctx.shard) : null;
    const known = (list) => !list || list.some((e) => e.id === id);
    if (ip && !known(ip) && ip.length >= this.perIpPerMinute && this.perIpPerMinute > 0) return 'ip';
    if (shard && !known(shard) && shard.length >= this.perShardPerMinute && this.perShardPerMinute > 0) return 'shard';
    if (!record) return null;
    if (ip && !known(ip)) touch(this.byIp, ctx.ip, [...ip, { id, at: now }]);
    if (shard && !known(shard)) this.byShard.set(ctx.shard, [...shard, { id, at: now }]);
    return null;
  }

  // Why a new paid build of `id` may not start now: 'budget', 'cap' or null (allowed, and counted against the rate
  // limits). peek: the same answer without counting it.
  refuse(id, { peek = false } = {}) {
    const over = this.check();
    if (over) return 'budget';
    const rate = this.#rate(id, !peek);
    if (rate && !peek) {
      const ctx = spendScope.getStore();
      this.log({ event: 'spend_cap', by: rate, shard: ctx?.shard ?? null });
    }
    return rate ? 'cap' : null;
  }
}
