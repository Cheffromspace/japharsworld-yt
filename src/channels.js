// Channels slots for Quest (Everything-is-OK#145, owner 2026-10-24): /v1/ch/<key> redirects to the slot's current
// youtube.com/watch link. VRChat on Quest resolves watch links itself (the world's default stream, a Lambda 302 to
// Lofi Girl's watch URL, plays live there), but not the playlist?list= links the Channels tab bakes for PC. The video is
// the link monitor's `slots.current_video` (its playlist's first item), so the monitor's swaps apply without a re-upload.
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;

// key → { id } | { error: 'unknown_channel' | 'channel_unavailable' }. Read-only, cached for cacheMs so a room full of
// players opening one slot reads the database once.
export class ChannelSlots {
  // baked: channels.json (the world's list), for a host with no link monitor. Staging has none (DEPLOY_MONITOR=off), so
  // every /v1/ch answered 503 and no Quest Channels play could start from a staging-baked world (world #376, 181 of 181
  // requests on 2026-10-29/30). There a slot plays its baked link, which may be older than the monitor's.
  constructor({ monitorDb, baked = null, cacheMs = 30_000, now = () => Date.now() }) {
    Object.assign(this, { monitorDb, baked, cacheMs, now });
    this.cache = new Map();
  }

  lookup(key) {
    if (!KEY.test(key ?? '')) return { error: 'unknown_channel' };
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.v;
    const v = this.#read(key);
    if (v.error !== 'monitor_unreadable') this.cache.set(key, { at: this.now(), v });
    return v;
  }

  #readBaked(key) {
    if (!this.baked) return { error: 'monitor_unreadable' };
    try {
      const slot = JSON.parse(readFileSync(this.baked, 'utf8')).slots.find((s) => s.key === key);
      if (!slot) return { error: 'unknown_channel' };
      const id = slot.hidden ? null : /[?&]v=([A-Za-z0-9_-]{11})(?:&|$)/.exec(slot.url ?? '')?.[1];
      return id ? { id } : { error: 'channel_unavailable' };
    } catch {
      return { error: 'monitor_unreadable' };
    }
  }

  #read(key) {
    if (!this.monitorDb || !existsSync(this.monitorDb)) return this.#readBaked(key);
    let db;
    try {
      db = new DatabaseSync(this.monitorDb, { readOnly: true });
      const row = db.prepare('SELECT kind, current_video FROM slots WHERE key = ?').get(key);
      if (!row) return { error: 'unknown_channel' };
      // A spare (no video yet) or a slot taken off the list.
      if (row.kind === 'removed' || !VIDEO.test(row.current_video ?? '')) return { error: 'channel_unavailable' };
      return { id: row.current_video };
    } catch {
      return { error: 'monitor_unreadable' };
    } finally {
      try { db?.close(); } catch { /* closed */ }
    }
  }
}
