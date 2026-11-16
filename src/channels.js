// Channels slots for Quest (Everything-is-OK#145, owner 2026-10-24): /v1/ch/<key> redirects to the slot's current
// youtube.com/watch link. VRChat on Quest resolves watch links itself (the world's default stream, a Lambda 302 to
// Lofi Girl's watch URL, plays live there), but not the playlist?list= links the Channels tab bakes for PC. The video is
// the link monitor's `slots.current_video` (its playlist's first item), so the monitor's swaps apply without a re-upload.
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;
// A JSON file that may start with a byte-order mark (the monitor reads overrides.json as utf-8-sig).
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (path) => { const t = readFileSync(path, 'utf8'); return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); };

// key → { id } | { error: 'unknown_channel' | 'channel_unavailable' }. Read-only, cached for cacheMs so a room full of
// players opening one slot reads the database once.
export class ChannelSlots {
  // baked: channels.json (the world's list), for a host with no link monitor. Staging has none (DEPLOY_MONITOR=off), so
  // every /v1/ch answered 503 and no Quest Channels play could start from a staging-baked world (world #376, 181 of 181
  // requests on 2026-10-29/30). There a slot plays its baked link, which may be older than the monitor's. Only where an
  // upstream is set (staging) since Everything-is-OK#776 (verifier M2, 2026-11-16): a host with no upstream is production,
  // whose monitor database is the only record of the monitor's own hides (down, flash fail), so a missing or unreadable
  // database there refuses every slot instead (status_missing, below).
  //
  // upstream: another service's base URL (CHANNELS_UPSTREAM; staging sets production, world #519). The baked file goes
  // stale as the monitor swaps streams and unhides slots: on 2026-11-04 it disagreed with the live list for 11 of the 52
  // shown slots (10 swapped streams, 1 unhidden), and a Quest in the TEST world couldn't start those. So a host with no
  // monitor asks the upstream's /v1/ch server-side, without following the redirect, and answers the Quest itself (one
  // hop for the player). The upstream's 302, 404 or 503 is the answer, cached upstreamCacheMs per key; on a timeout,
  // an error or any other answer the baked link is used as before (staging as standby while production is down, #383).
  // Bounded (verifier, 2026-11-04): at most upstreamCacheMax keys, oldest dropped first, and a 404 for a key the baked
  // file doesn't have is not kept, so a scan of random keys can't grow it. After a timeout or a network error the
  // upstream is skipped for upstreamDownMs, so a hanging upstream doesn't add its timeout to every play.
  //
  // overrides: monitor/overrides.json, for the baked file only (Everything-is-OK#776, 2026-11-16): the owner's hides and
  // retirements live there, not in channels.json.
  constructor({ monitorDb, baked = null, overrides = null, cacheMs = 30_000, now = () => Date.now(), upstream = '', upstreamTimeoutMs = 2000,
    upstreamCacheMs = 5 * 60_000, upstreamCacheMax = 256, upstreamDownMs = 20_000, fetch: fetchFn = globalThis.fetch,
    log = () => {} }) {
    Object.assign(this, { monitorDb, baked, overrides, cacheMs, now, upstream: (upstream ?? '').replace(/\/$/, ''), upstreamTimeoutMs,
      upstreamCacheMs, upstreamCacheMax, upstreamDownMs, fetchFn, log });
    this.upstreamDownUntil = 0;
    this.refusedAt = new Map(); // why -> { at, more }: the status_unreadable / status_missing lines, one a minute each
    this.cache = new Map();
    this.upstreamCache = new Map();
    this.inflight = new Map();
  }

  // The route's entry point: the monitor DB when there is one, else the upstream when set, else the baked file.
  async resolve(key) {
    if (!KEY.test(key ?? '')) return { error: 'unknown_channel' };
    if (!this.upstream || (this.monitorDb && existsSync(this.monitorDb))) return this.lookup(key);
    const hit = this.upstreamCache.get(key);
    if (hit && this.now() - hit.at < this.upstreamCacheMs) return hit.v;
    if (this.now() < this.upstreamDownUntil) return this.lookup(key);
    // A room opening one slot at once shares one upstream call.
    if (!this.inflight.has(key)) {
      this.inflight.set(key, this.#askUpstream(key).finally(() => this.inflight.delete(key)));
    }
    return (await this.inflight.get(key)) ?? this.lookup(key);
  }

  // { id } | { error } from the upstream, cached; null when it gave no usable answer (the caller uses the baked file).
  // The log line carries the outcome and status only: no key, no video.
  async #askUpstream(key) {
    const started = this.now();
    let outcome, status = null, v = null;
    try {
      const r = await this.fetchFn(`${this.upstream}/v1/ch/${key}`, {
        redirect: 'manual', signal: AbortSignal.timeout(this.upstreamTimeoutMs), headers: { 'user-agent': 'japharsworld-yt channels-upstream' } });
      status = r.status;
      try { await r.body?.cancel(); } catch { /* nothing to drain */ }
      if (r.status === 302) {
        const id = /^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/.exec(r.headers.get('location') ?? '')?.[1];
        if (id) { v = { id }; outcome = 'redirect'; } else outcome = 'bad_location';
      } else if (r.status === 404) { v = { error: 'unknown_channel' }; outcome = 'unknown'; }
      else if (r.status === 503) { v = { error: 'channel_unavailable' }; outcome = 'unavailable'; }
      else outcome = 'other';
    } catch (e) {
      outcome = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'error';
    }
    if (v && !(v.error === 'unknown_channel' && !this.#bakedHas(key))) {
      this.upstreamCache.delete(key);
      this.upstreamCache.set(key, { at: this.now(), v });
      while (this.upstreamCache.size > this.upstreamCacheMax) this.upstreamCache.delete(this.upstreamCache.keys().next().value);
    }
    if (outcome === 'timeout' || outcome === 'error') this.upstreamDownUntil = this.now() + this.upstreamDownMs;
    this.log({ event: 'channel_upstream', outcome, status, ms: this.now() - started, fallback: !v });
    return v;
  }

  lookup(key) {
    if (!KEY.test(key ?? '')) return { error: 'unknown_channel' };
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.v;
    const v = this.#read(key);
    if (v.error !== 'monitor_unreadable') this.cache.set(key, { at: this.now(), v });
    return v;
  }

  // Whether the baked file lists the key; its key list is kept for cacheMs.
  #bakedHas(key) {
    if (!this.bakedKeys || this.now() - this.bakedKeys.at >= this.cacheMs) {
      let keys = new Set();
      try { keys = new Set(JSON.parse(readFileSync(this.baked, 'utf8')).slots.map((s) => s.key)); } catch { /* none */ }
      this.bakedKeys = { at: this.now(), keys };
    }
    return this.bakedKeys.keys.has(key);
  }

  // The baked link, hidden as sleep-list.json would hide it without the monitor's own hides: overrides.json's hidden when
  // set, else channels.json's (slotmon publish.status_doc). The monitor's hides (down, flash fail) can't be known here.
  // overrides.json must have the shape slotmon reads (#776, verifier L1): a file that can't be read or parsed, that is not
  // an object, or whose "slots" is there but not an object (null, a list) vouches for no slot, so every slot is refused;
  // an entry for this key that is not an object (null, a string, a list) refuses this key only. A file without "slots"
  // has no owner edits, as for slotmon.
  #readBaked(key) {
    if (!this.baked) return { error: 'monitor_unreadable' };
    try {
      const slot = JSON.parse(readFileSync(this.baked, 'utf8')).slots.find((s) => s.key === key);
      if (!slot) return { error: 'unknown_channel' };
      let owner;
      if (this.overrides) {
        const doc = readJson(this.overrides);
        if (!isObject(doc) || ('slots' in doc && !isObject(doc.slots))) throw new Error('overrides.json: not an object with an object "slots"');
        if (isObject(doc.slots) && Object.hasOwn(doc.slots, key)) {
          owner = doc.slots[key];
          if (!isObject(owner)) throw new Error('overrides.json: a slot entry is not an object');
        }
      }
      const hidden = owner && 'hidden' in owner ? Boolean(owner.hidden) : Boolean(slot.hidden);
      const id = hidden ? null : /[?&]v=([A-Za-z0-9_-]{11})(?:&|$)/.exec(slot.url ?? '')?.[1];
      return id ? { id } : { error: 'channel_unavailable' };
    } catch (e) {
      return this.#unreadable('baked', e);
    }
  }

  // #776: a refusal says why in the journal, so "every slot refused because the status can't be read" is told apart from
  // "this slot is hidden". No key or video in either line. The unreadable and missing lines are kept to one a minute each
  // (those answers are not cached, so each play reads again), with the count each stood for.
  #unreadable(source, e, why = 'status_unreadable') {
    const r = this.refusedAt.get(why) ?? { at: -Infinity, more: 0 };
    if (this.now() - r.at >= 60_000) {
      this.log({ event: 'channel_refused', why, source, error: String(e?.message ?? e).slice(0, 200), more: r.more });
      this.refusedAt.set(why, { at: this.now(), more: 0 });
    } else r.more++;
    return { error: 'monitor_unreadable' };
  }

  #read(key) {
    if (!this.monitorDb || !existsSync(this.monitorDb)) {
      // No database file, or a path the service can't see (verifier M2): the baked file only where an upstream is set
      // (staging, whose answers come from the upstream while it answers); with none set, refused (fail closed).
      if (this.upstream) return this.#readBaked(key);
      return this.#unreadable('monitor', 'the monitor database is missing or not readable', 'status_missing');
    }
    let db;
    try {
      db = new DatabaseSync(this.monitorDb, { readOnly: true });
      // Everything-is-OK#776 (2026-11-16): a slot the list hides is refused too, by the rule sleep-list.json is published
      // with (slotmon publish.status_doc): baked_hidden (overrides.json's hidden when set, else channels.json's; a retired
      // slot is hidden there) or auto_hidden (the monitor's: down, flash fail). Until then only kind 'removed' was refused.
      // Both columns are in the monitor's first schema (81689b2); a database without them throws, which is
      // monitor_unreadable, a 503: refused, never shown.
      const row = db.prepare('SELECT kind, current_video, baked_hidden, auto_hidden FROM slots WHERE key = ?').get(key);
      if (!row) return { error: 'unknown_channel' };
      // A spare (no video yet), a slot taken off the list, or one the list hides.
      if (row.kind !== 'removed' && (row.baked_hidden || row.auto_hidden)) {
        this.log({ event: 'channel_refused', why: row.auto_hidden ? 'hidden_by_monitor' : 'hidden_by_owner' });
        return { error: 'channel_unavailable' };
      }
      if (row.kind === 'removed' || !VIDEO.test(row.current_video ?? '')) return { error: 'channel_unavailable' };
      return { id: row.current_video };
    } catch (e) {
      return this.#unreadable('monitor', e);
    } finally {
      try { db?.close(); } catch { /* closed */ }
    }
  }
}
