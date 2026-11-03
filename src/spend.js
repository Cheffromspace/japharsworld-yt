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
// Caption transcripts (6 credits each, src/transcripts.js) share the same budget and have their own per-IP limit,
// SPEND_TRANSCRIPTS_PER_MINUTE_PER_IP, counting every uncached call.
//
// A trusted client IP (TRUSTED_IPS, src/trusted.js) gets trustedFactor times both per-IP limits; the per-shard cap and
// the budget are the same for it as for everyone. Its spend_cap events carry trusted: true.
//
// Windows roll (the last 60 minutes, the last 24 hours) and the spends are kept in stateFile (times and credits only),
// so a restart doesn't hand out a fresh budget. A missing file starts empty; an unreadable one is kept as .bak and the
// hour starts half spent, so a damaged file can't hand out a fresh budget either.
//
// The alert: one spend_budget post at most per 24 h, and its all-clear only once spend has stayed under half of both
// budgets for 30 minutes (without that, steady load at the limit posted hit, ok, hit, ok... as calls aged out).
//
// Known gap: a call refunded because it failed on our side (a timeout) may still have been charged by Tunelio, so the
// count can run a little low. Tunelio's own balance (credits_remaining) is the truth.

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { limitFor } from './trusted.js';

// The request a paid build would be made for: { ip, shard }. server.js runs each ticket and lookup in it; a build made
// outside any request (a restart resuming one) has none and meets the budget only.
export const spendScope = new AsyncLocalStorage();

const HOUR = 3600_000, DAY = 24 * HOUR, MINUTE = 60_000;

// Stores `value` (a list of { at } or timestamps) for `key` in a map of at most `max` keys, as its most recently active
// (every update moves its key to the end, so the first keys are the least recently active). A new key, when the map is
// full, makes room only from keys with nothing in the last minute; if every key is active, it is refused (false), so the
// caller treats that client as over its limit. Never a clear or an eviction of an active key: either would hand a
// client a fresh count, and enough new addresses could do it on purpose.
export function touch(map, key, value, max = 10_000, now = Date.now()) {
  if (!map.has(key)) {
    for (const [k, l] of map) {
      if (map.size < max || l.some((e) => now - (e?.at ?? e) < MINUTE)) break;
      map.delete(k);
    }
    if (map.size >= max) return false;
  }
  map.delete(key);
  map.set(key, value);
  return true;
}

export class SpendGate {
  constructor({ hourCredits = 800, dayCredits = 4000, perIpPerMinute = 4, perShardPerMinute = 6, cost = 10,
    transcriptsPerIpPerMinute = 6, transcriptCost = 6, maxKeys = 10_000, okAfterMs = 30 * MINUTE, alertEveryMs = DAY,
    alert = () => {}, log = () => {}, now = () => Date.now(), stateFile = null, trusted = null, trustedFactor = 10 } = {}) {
    Object.assign(this, { hourCredits, dayCredits, perIpPerMinute, perShardPerMinute, cost, transcriptsPerIpPerMinute, transcriptCost,
      maxKeys, okAfterMs, alertEveryMs, alert, log, now, stateFile, trusted, trustedFactor });
    this.spends = []; // { at, c }, oldest first, the last 24 h
    this.byIp = new Map(); // ip → [{ id, at }]
    this.byShard = new Map(); // shard → [{ id, at }]
    this.transcriptsByIp = new Map(); // ip → [{ at }]
    this.over = null; // 'hour' | 'day' while over budget
    this.alertedAt = -Infinity; // the last spend_budget post
    this.okDue = false; // a post is waiting for its all-clear
    this.lowSince = null; // since when spend has been under half of both budgets
    this.#load();
  }

  #load() {
    if (!this.stateFile) return;
    let text;
    try { text = readFileSync(this.stateFile, 'utf8'); } catch (err) {
      if (err?.code === 'ENOENT') return; // none yet
      return this.#damaged(err);
    }
    try {
      const st = JSON.parse(text);
      if (!Array.isArray(st?.spends)) throw new Error('no spends list');
      const since = this.now() - DAY;
      this.spends = st.spends.filter((s) => Number.isFinite(s?.at) && s.at > since && s.c > 0);
      if (Number.isFinite(st.alertedAt)) this.alertedAt = st.alertedAt;
      this.okDue = Boolean(st.okDue);
    } catch (err) { this.#damaged(err); }
  }

  #damaged(err) {
    try { copyFileSync(this.stateFile, `${this.stateFile}.bak`); } catch { /* unreadable: nothing to keep */ }
    const c = Math.ceil((this.hourCredits || this.dayCredits || 0) / 2);
    this.spends = c > 0 ? [{ at: this.now(), c }] : [];
    this.log({ event: 'spend_state_damaged', assumed: c, message: String(err?.message ?? err).slice(0, 200) });
  }

  #save() {
    if (!this.stateFile) return;
    try {
      writeFileSync(`${this.stateFile}.tmp`, JSON.stringify({ spends: this.spends, alertedAt: Number.isFinite(this.alertedAt) ? this.alertedAt : null, okDue: this.okDue }));
      renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (err) { this.log({ event: 'spend_state_failed', message: String(err?.message ?? err).slice(0, 200) }); }
  }

  spent(ms) {
    const since = this.now() - ms;
    let n = 0;
    for (const s of this.spends) if (s.at > since) n += s.c;
    return n;
  }

  // Which budget a call of `cost` would break: 'hour', 'day' or null. Logs each change; posts as described at the top
  // (check() runs every minute too, so the all-clear doesn't wait for a play).
  check(cost = this.cost) {
    const now = this.now();
    const hour = this.spent(HOUR), day = this.spent(DAY);
    const over = this.dayCredits > 0 && day + cost > this.dayCredits ? 'day' : this.hourCredits > 0 && hour + cost > this.hourCredits ? 'hour' : null;
    if (over && !this.over) {
      this.log({ event: 'spend_budget', state: 'hit', window: over, hour, day, hourCredits: this.hourCredits, dayCredits: this.dayCredits });
      if (now - this.alertedAt >= this.alertEveryMs) {
        this.alertedAt = now;
        this.okDue = true;
        this.#save();
        this.alert('spend_budget', `Tunelio spend budget reached (${over === 'day' ? `${day} of ${this.dayCredits} credits in 24 h` : `${hour} of ${this.hourCredits} credits in an hour`}): no new HD builds or paid captions; plays go to the home relay or youtube.com until it frees up.`, 0);
      }
    } else if (!over && this.over) {
      this.log({ event: 'spend_budget', state: 'reset', window: this.over, hour, day });
    }
    this.over = over;
    const low = !over && (!(this.hourCredits > 0) || hour < this.hourCredits / 2) && (!(this.dayCredits > 0) || day < this.dayCredits / 2);
    this.lowSince = low ? this.lowSince ?? now : null;
    if (this.okDue && low && now - this.lowSince >= this.okAfterMs) {
      this.okDue = false;
      this.#save();
      this.alert.resolve?.('spend_budget', `Tunelio spend has stayed well under budget for ${Math.round(this.okAfterMs / MINUTE)} minutes (${hour} credits in the last hour, ${day} in 24 h): HD builds and paid captions are back.`);
    }
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

  // Whether this request's client IP is in TRUSTED_IPS.
  #trusted(ip) { return Boolean(ip && this.trusted?.has(ip)); }

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
    const perIp = limitFor(this.perIpPerMinute, this.#trusted(ctx.ip), this.trustedFactor);
    if (ip && !known(ip) && ip.length >= perIp && perIp > 0) return 'ip';
    if (shard && !known(shard) && shard.length >= this.perShardPerMinute && this.perShardPerMinute > 0) return 'shard';
    if (!record) return null;
    if (ip && !known(ip) && !touch(this.byIp, ctx.ip, [...ip, { id, at: now }], this.maxKeys, now)) return 'ip';
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
      this.log({ event: 'spend_cap', by: rate, shard: ctx?.shard ?? null, ...(this.#trusted(ctx?.ip) ? { trusted: true } : {}) });
    }
    return rate ? 'cap' : null;
  }

  // Why an uncached caption transcript may not be fetched now: 'budget', 'cap' (this request's IP is over
  // transcriptsPerIpPerMinute) or null (allowed and counted). The caller charges it.
  refuseTranscript() {
    if (this.check(this.transcriptCost)) return 'budget';
    const ip = spendScope.getStore()?.ip;
    const trusted = this.#trusted(ip);
    const perIp = limitFor(this.transcriptsPerIpPerMinute, trusted, this.trustedFactor);
    if (!ip || !(perIp > 0)) return null;
    const now = this.now();
    const list = (this.transcriptsByIp.get(ip) ?? []).filter((e) => now - e.at < MINUTE);
    const capped = () => { this.log({ event: 'spend_cap', by: 'ip', kind: 'transcript', ...(trusted ? { trusted: true } : {}) }); return 'cap'; };
    if (list.length >= perIp) return capped();
    if (!touch(this.transcriptsByIp, ip, [...list, { at: now }], this.maxKeys, now)) return capped();
    return null;
  }
}
