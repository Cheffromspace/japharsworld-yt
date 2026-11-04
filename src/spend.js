// Spend limits for paid Tunelio builds (Everything-is-OK#478): a hard budget in credits per hour and per day, and
// build rate limits per client IP and per shard. Playback asks before every new paid /create (src/playback.js); over a
// limit there is no new build: over the shared budget the play may go home, over a per-minute cap it gets youtube.com. Cached builds, home builds and
// refused videos never get here.
//
// Real spend, prod 2026-10-26..11-03 (metrics.db credits/playback and the journal's builds): busiest day 1,700
// playback credits (10-31), next 710; busiest hour ~310 (31 builds, 10-31 02h UTC); busiest minute 9 builds, the
// same few videos at more than one quality. The plan is 100k credits a month and all of it may be spent (owner,
// 2026-11-04), ~3.3k a day: the pacer (src/adaptive.js) spreads the month, and these limits only stop a runaway. So
// the defaults are SPEND_HOUR_CREDITS 1500 (~5x the busiest real hour), SPEND_DAY_CREDITS 8000 (2.4x the average day,
// at most 8 % of the month in a bad day) and SPEND_MONTH_CREDITS 100000 per billing period (monthKey, the period's
// first day: TUNELIO_RENEWS_DAY). Past homeFirstPercent (75 %) of the hour or day budget, near() says so and new plays
// go home first while home has room (src/server.js homeWhy, near_budget); Tunelio still builds when home is full.
//
// The rate limits count distinct videos that started a paid build in the last minute, so one play's several /create
// calls (adaptive's two qualities, a downgrade) count once: 6 a minute per IP (a visitor browsing rows stays under),
// 12 per shard (a room of 6 each picking). Home sessions share the count (rateCap). Over one, the play gets
// youtube.com, never home instead (owner, 2026-11-04: no overflow to home for a visitor over their own limits).
//
// Caption transcripts (6 credits each, src/transcripts.js) share the same budget and have their own per-IP limit,
// SPEND_TRANSCRIPTS_PER_MINUTE_PER_IP, counting every uncached call.
//
// A trusted client IP (TRUSTED_IPS, src/trusted.js) gets trustedFactor times both per-IP limits; the per-shard cap and
// the budget are the same for it as for everyone. Its spend_cap events carry trusted: true.
//
// Windows roll (the last 60 minutes, the last 24 hours) and the spends are kept in stateFile (times and credits only),
// with the billing period's total ({ key, c }), so a restart doesn't hand out a fresh budget. A missing file starts empty; an unreadable one is kept as .bak and the
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
// The hour budget's default (SPEND_HOUR_CREDITS), shared with src/config.js and the Grafana spend-rate alert
// (tools/grafana.mjs), which fires at the home-first point of it.
export const HOUR_CREDITS = 1500;
export const HOME_FIRST_PERCENT = 75;

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
  constructor({ hourCredits = HOUR_CREDITS, dayCredits = 8000, monthCredits = 100_000, monthKey = null, homeFirstPercent = HOME_FIRST_PERCENT,
    perIpPerMinute = 6, perShardPerMinute = 12, cost = 10,
    transcriptsPerIpPerMinute = 6, transcriptCost = 6, maxKeys = 10_000, okAfterMs = 30 * MINUTE, alertEveryMs = DAY,
    alert = () => {}, log = () => {}, now = () => Date.now(), stateFile = null, trusted = null, trustedFactor = 10, allowance = null } = {}) {
    Object.assign(this, { hourCredits, dayCredits, monthCredits, homeFirstPercent, perIpPerMinute, perShardPerMinute, cost, transcriptsPerIpPerMinute, transcriptCost,
      maxKeys, okAfterMs, alertEveryMs, alert, log, now, stateFile, trusted, trustedFactor, allowance });
    this.capLogged = new Map(); // "ip:by" → when its spend_cap was last logged (once per minute's stretch)
    // The billing period's key (its first day, 'YYYY-MM-DD', from server.js); without one, the UTC calendar month.
    this.monthKey = monthKey ?? (() => new Date(this.now()).toISOString().slice(0, 7));
    this.month = { key: this.monthKey(), c: 0 }; // credits charged this billing period
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
      if (st.month?.key === this.month.key && Number.isFinite(st.month.c) && st.month.c > 0) this.month.c = st.month.c;
      else if (!st.month) this.month.c = this.spends.reduce((n, sp) => n + sp.c, 0); // a file from before the month window
      if (Number.isFinite(st.alertedAt)) this.alertedAt = st.alertedAt;
      this.okDue = Boolean(st.okDue);
    } catch (err) { this.#damaged(err); }
  }

  #damaged(err) {
    try { copyFileSync(this.stateFile, `${this.stateFile}.bak`); } catch { /* unreadable: nothing to keep */ }
    const c = Math.ceil((this.hourCredits || this.dayCredits || 0) / 2);
    this.spends = c > 0 ? [{ at: this.now(), c }] : [];
    this.month.c = c;
    this.log({ event: 'spend_state_damaged', assumed: c, message: String(err?.message ?? err).slice(0, 200) });
  }

  #save() {
    if (!this.stateFile) return;
    try {
      writeFileSync(`${this.stateFile}.tmp`, JSON.stringify({ spends: this.spends, month: this.month, alertedAt: Number.isFinite(this.alertedAt) ? this.alertedAt : null, okDue: this.okDue }));
      renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (err) { this.log({ event: 'spend_state_failed', message: String(err?.message ?? err).slice(0, 200) }); }
  }

  spent(ms) {
    const since = this.now() - ms;
    let n = 0;
    for (const s of this.spends) if (s.at > since) n += s.c;
    return n;
  }

  // Credits charged this billing period (a new period starts at 0).
  spentMonth() {
    const key = this.monthKey();
    if (this.month.key !== key) this.month = { key, c: 0 };
    return this.month.c;
  }

  // The spend so far, for the routing event and /ops/state: credits in the last hour, 24 h and this billing period.
  totals() { return { hour: this.spent(HOUR), day: this.spent(DAY), month: this.spentMonth() }; }

  // Which window is past homeFirstPercent of its budget ('day', 'hour') or null: new plays go home first then. The
  // month's pace is the pacer's (src/adaptive.js), which reads Tunelio's real balance.
  near() {
    const p = this.homeFirstPercent / 100;
    if (!(p > 0)) return null;
    if (this.dayCredits > 0 && this.spent(DAY) >= this.dayCredits * p) return 'day';
    if (this.hourCredits > 0 && this.spent(HOUR) >= this.hourCredits * p) return 'hour';
    return null;
  }

  // Which budget a call of `cost` would break: 'month', 'day', 'hour' or null. Logs each change; posts as described at
  // the top (check() runs every minute too, so the all-clear doesn't wait for a play).
  check(cost = this.cost) {
    const now = this.now();
    const hour = this.spent(HOUR), day = this.spent(DAY), month = this.spentMonth();
    const over = this.monthCredits > 0 && month + cost > this.monthCredits ? 'month'
      : this.dayCredits > 0 && day + cost > this.dayCredits ? 'day' : this.hourCredits > 0 && hour + cost > this.hourCredits ? 'hour' : null;
    if (over && !this.over) {
      this.log({ event: 'spend_budget', state: 'hit', window: over, hour, day, month, hourCredits: this.hourCredits, dayCredits: this.dayCredits, monthCredits: this.monthCredits });
      if (now - this.alertedAt >= this.alertEveryMs) {
        this.alertedAt = now;
        this.okDue = true;
        this.#save();
        const what = over === 'month' ? `${month} of ${this.monthCredits} credits this billing period` : over === 'day' ? `${day} of ${this.dayCredits} credits in 24 h` : `${hour} of ${this.hourCredits} credits in an hour`;
        this.alert('spend_budget', `Tunelio spend budget reached (${what}): no new HD builds or paid captions; plays go to the home relay or youtube.com until it frees up.`, 0);
      }
    } else if (!over && this.over) {
      this.log({ event: 'spend_budget', state: 'reset', window: this.over, hour, day, month });
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
    // The request's visitor pays from their daily allowance too (src/allowance.js), refunded with it.
    const back = this.allowance?.charge(spendScope.getStore()?.ip, { credits: cost }) ?? (() => {});
    while (this.spends.length && this.spends[0].at <= now - DAY) this.spends.shift();
    const s = { at: now, c: cost };
    this.spends.push(s);
    this.spentMonth(); // a new billing period starts at 0 first
    const month = this.month;
    month.c += cost;
    this.#save();
    return () => {
      const i = this.spends.indexOf(s);
      if (i < 0) return;
      back();
      this.spends.splice(i, 1);
      month.c = Math.max(0, month.c - cost); // a refund after the period rolled over changes only the old one
      this.#save();
    };
  }

  // The per-minute build caps for a new home session of `id` (src/server.js startHome): 'cap' or null. Home builds
  // share the count with Tunelio's, so a visitor over 6 new videos a minute gets youtube.com, not home (owner,
  // 2026-11-04). record: count it (after the session started).
  rateCap(id, { record = false } = {}) {
    const rate = this.#rate(id, record);
    if (rate) this.#capLog(rate, spendScope.getStore(), { kind: 'home' });
    return rate ? 'cap' : null;
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

  // Why a new paid build of `id` may not start now: 'budget' (the shared hour/day/month budget: the play may still go
  // home), 'allowance' (this visitor's daily allowance, src/allowance.js) or 'cap' (this IP's or shard's builds a
  // minute); over either of those the play gets youtube.com, not home. null: allowed, and counted against the rate
  // limits. peek: the same answer without counting it.
  refuse(id, { peek = false } = {}) {
    const over = this.check();
    if (over) return 'budget';
    const ctx = spendScope.getStore();
    if (this.allowance?.over(ctx?.ip, { credits: this.cost })) return 'allowance';
    const rate = this.#rate(id, !peek);
    if (rate && !peek) this.#capLog(rate, ctx);
    return rate ? 'cap' : null;
  }

  // spend_cap, once per IP and limit while it keeps refusing (a stretch: nothing logged in the last minute).
  #capLog(by, ctx, extra = {}) {
    const now = this.now();
    const key = `${ctx?.ip ?? ''}:${by}:${extra.kind === 'transcript' ? 'transcript' : 'build'}`; // home and Tunelio builds share a cap
    if (now - (this.capLogged.get(key) ?? -Infinity) < MINUTE) { this.capLogged.set(key, now); return; }
    this.capLogged.delete(key);
    this.capLogged.set(key, now);
    if (this.capLogged.size > this.maxKeys) this.capLogged.delete(this.capLogged.keys().next().value);
    this.log({ event: 'spend_cap', by, ...extra, shard: ctx?.shard ?? null, ...(this.#trusted(ctx?.ip) ? { trusted: true } : {}) });
  }

  // Why an uncached caption transcript may not be fetched now: 'budget', 'cap' (this request's IP is over
  // transcriptsPerIpPerMinute) or null (allowed and counted). The caller charges it.
  refuseTranscript() {
    if (this.check(this.transcriptCost)) return 'budget';
    const ip = spendScope.getStore()?.ip;
    if (this.allowance?.over(ip, { credits: this.transcriptCost })) return 'allowance';
    const trusted = this.#trusted(ip);
    const perIp = limitFor(this.transcriptsPerIpPerMinute, trusted, this.trustedFactor);
    if (!ip || !(perIp > 0)) return null;
    const now = this.now();
    const list = (this.transcriptsByIp.get(ip) ?? []).filter((e) => now - e.at < MINUTE);
    const capped = () => { this.#capLog('ip', spendScope.getStore(), { kind: 'transcript' }); return 'cap'; };
    if (list.length >= perIp) return capped();
    if (!touch(this.transcriptsByIp, ip, [...list, { at: now }], this.maxKeys, now)) return capped();
    return null;
  }
}
