// Operator routes, read only except the slot refill (owner, 2026-10-21: query the Linode without SSH, which Claude's sessions can't use):
//   GET /ops/state                                      what the service is doing now (builds, holds, relay, probe, version)
//   GET /ops/events?event=a,b&minutes=1440&limit=500    recent log events from memory, newest last
//   GET /ops/slots, POST /ops/slots/refill?id=&force=1  the player test slots (src/slots.js): the one write here,
//                                                       capped per day, so the test session can refill them itself
// Behind STATS_TOKEN like /stats (404 without one). Fixed answers only: no parameters reach a shell, a file path or
// SQL. Events are the service's own `logJson` lines kept in memory (lost on restart) and reduced to an allowlist of
// fields: video IDs, ticket numbers, shards and User-Agents never leave, and IDs inside messages are masked.
import { readFileSync } from 'node:fs';
import { tokenOk } from './stats.js';

// Fields an event may carry out. Anything else (id, n, shard, ua, future fields) is dropped.
const FIELDS = new Set(['at', 'event', 'via', 'reason', 'client', 'held', 'quality', 'hls', 'mb', 'buildMs', 'seconds',
  'status', 'code', 'message', 'format', 'createMs', 'startMs', 'playlistMs', 'ok', 'warm', 'step', 'error', 'skipped',
  'route', 'ms', 'results', 'failed', 'worker', 'from', 'to', 'kind', 'lang', 'text', 'units', 'pair']);

// An 11-character YouTube-ID-shaped token with a digit, "-", "_" or an inner capital (so ordinary words such as
// "unavailable" or "Information" stay), and URL query strings (v=, sig=, tokens).
const ID_LIKE = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{11}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*[0-9_-]|.[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{11}/g;
export function mask(text) {
  return String(text).replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, '$1?…').replace(ID_LIKE, '…');
}

export function redact(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (!FIELDS.has(k)) continue;
    out[k] = typeof v === 'string' ? mask(v).slice(0, 300) : (v === null || typeof v !== 'object' ? v : undefined);
  }
  return out;
}

// The last `size` log events (JSON lines with an `event`), redacted when stored.
export class EventRing {
  constructor(size = 5000) { this.size = size; this.items = []; this.dropped = 0; }
  push(line) {
    let o;
    try { o = typeof line === 'string' ? JSON.parse(line) : line; } catch { return; }
    if (!o || typeof o !== 'object' || !o.event) return;
    this.items.push(redact(o));
    if (this.items.length > this.size) { this.items.splice(0, this.items.length - this.size); this.dropped++; }
  }
  query({ events = [], sinceMs = 0, limit = 500 } = {}) {
    const want = new Set(events);
    const hits = this.items.filter((e) => (!want.size || want.has(e.event)) && Date.parse(e.at ?? 0) >= sinceMs);
    return hits.slice(-limit);
  }
}

// The deployed commit, read from the checkout each time (deploys that don't restart the service still move it).
export function gitHead(dir = new URL('../.git/', import.meta.url)) {
  try {
    const head = readFileSync(new URL('HEAD', dir), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 40);
    const ref = head.slice(5);
    try { return readFileSync(new URL(ref, dir), 'utf8').trim(); } catch { /* packed */ }
    const line = readFileSync(new URL('packed-refs', dir), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 40) : null;
  } catch { return null; }
}

export function opsRoute(req, res, url, { token, ring, state, slots }) {
  const send = (status, body) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  if (!token) return send(404, { v: 1, error: 'not_found', message: 'Unknown path.' });
  if (!tokenOk(req, url, token)) return send(401, { v: 1, error: 'unauthorized', message: 'Bad stats token.' });
  const p = url.pathname.replace(/\/$/, '');
  if (req.method !== 'GET' && req.method !== 'HEAD' && p !== '/ops/slots/refill') return send(405, { v: 1, error: 'method', message: 'GET only.' });
  if (p === '/ops/state') return send(200, { v: 1, at: new Date().toISOString(), ...state() });
  if (p === '/ops/events') {
    const num = (k, d, lo, hi) => Math.min(hi, Math.max(lo, Number.parseInt(url.searchParams.get(k) ?? '', 10) || d));
    const minutes = num('minutes', 1440, 1, 7 * 1440);
    const limit = num('limit', 500, 1, 5000);
    const events = (url.searchParams.get('event') ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-z_]{1,40}$/.test(s));
    const items = ring.query({ events, sinceMs: Date.now() - minutes * 60_000, limit });
    return send(200, { v: 1, minutes, kept: ring.items.length, oldest: ring.items[0]?.at ?? null, count: items.length, events: items });
  }
  if (p === '/ops/slots' && slots) return send(200, { v: 1, at: new Date().toISOString(), ...slots.status() });
  if (p === '/ops/slots/refill' && slots) {
    if (req.method !== 'POST') return send(405, { v: 1, error: 'method', message: 'POST to refill.' });
    const r = slots.refill({ id: url.searchParams.get('id') || undefined, force: url.searchParams.get('force') === '1' });
    return send(r.error ? (r.error === 'bad_id' ? 400 : 409) : 202, { v: 1, ...r });
  }
  return send(404, { v: 1, error: 'not_found', message: 'Unknown path.' });
}
