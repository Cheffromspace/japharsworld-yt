// Client IPs are never kept (owner, 2026-11-04: "can we like hash an IP so we don't need to read it?"). Every limit that
// remembers a visitor past their request (the daily allowance, the per-minute counts, the spend gate's lists, the
// cap-log marks, an adaptive session's payer, the reload mark) keys on code(ip): HMAC-SHA256 with a secret key, cut to 16
// bytes. Not a plain hash: there are few enough IPv4 addresses to hash them all and look one up. The key is 32 random
// bytes made at startup and again at the start of each reporting day (METRICS_TZ, the allowance's day), held in memory
// only (never in a state file, log, event, metric or /ops output), and dropped at the day's end, after which no code
// kept can be matched to an address. A play over midnight gets a new code (and so a new payer); that is fine.
//
// Trusted IPs (TRUSTED_IPS) are checked on the raw address at request time; the code of a trusted address is noted for
// the day, so `trusted.has(code)` answers for the limits that only see codes. Nothing raw is kept for that either.
import { createHmac, randomBytes } from 'node:crypto';
import { dayOf } from './metrics.js';

export class IpKeys {
  constructor({ tz = 'America/Chicago', now = () => Date.now(), trusted = null, random = () => randomBytes(32) } = {}) {
    Object.assign(this, { tz, now, random });
    this.raw = trusted; // TRUSTED_IPS (src/trusted.js), raw addresses from the env
    this.#rotate();
    const self = this;
    // What the limits are given as `trusted`: has() for a code (or, at request time, a raw address).
    this.trusted = { get size() { return self.raw?.size ?? 0; }, get bad() { return self.raw?.bad ?? 0; },
      has(k) { self.#fresh(); return self.trustedCodes.has(k) || Boolean(self.raw?.has?.(k)); } };
  }

  #rotate() {
    this.day = dayOf(this.now(), this.tz);
    this.key = this.random();
    this.trustedCodes = new Set();
  }
  #fresh() { if (dayOf(this.now(), this.tz) !== this.day) this.#rotate(); }
  // The day check on its own (server.js, every minute), so a quiet night doesn't keep yesterday's key until the next
  // request: the key is replaced within a minute of the day's start.
  sweep() { this.#fresh(); }

  // The day's code for an address (and, for the reload mark, the player's name with it); null for none.
  code(ip, extra = null) {
    if (!ip) return null;
    this.#fresh();
    const c = createHmac('sha256', this.key).update(extra == null ? String(ip) : `${ip}\n${extra}`).digest('base64url').slice(0, 22); // 16 bytes
    if (extra == null && this.raw?.has?.(ip)) this.trustedCodes.add(c);
    return c;
  }
}
