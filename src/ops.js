// Operator routes, read only except the slot refill and test plans (owner, 2026-10-21: query the Linode without SSH, which Claude's sessions can't use):
//   GET /ops/state                                      what the service is doing now (builds, holds, relay, probe, version)
//   GET /ops/events?event=a,b&minutes=1440&limit=500    recent log events from memory, newest last
//   GET /ops/plan, POST /ops/plan?id=&mode=&minutes=     test plans: force a video's play plan for a while (src/adaptive.js force;
//                                                       mode restricted: src/playback.js forceRestricted)
//   GET /ops/slots, POST /ops/slots/refill?id=&force=1  the player test slots (src/slots.js); refills are
//                                                       capped per day, so the test session can refill them itself
// Behind STATS_TOKEN like /stats (404 without one). Fixed answers only: no parameters reach a shell, a file path or
// SQL. Events are the service's own `logJson` lines kept in memory (lost on restart) and reduced to an allowlist of
// fields: video IDs, ticket numbers, shards and User-Agents never leave, and IDs inside messages are masked.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenOk } from './stats.js';

// Fields an event may carry out. Anything else (id, n, shard, ua, future fields) is dropped.
const FIELDS = new Set(['at', 'event', 'via', 'reason', 'client', 'held', 'quality', 'hls', 'mb', 'buildMs', 'seconds',
  'status', 'code', 'message', 'format', 'createMs', 'startMs', 'playlistMs', 'ok', 'warm', 'step', 'error', 'skipped',
  'route', 'ms', 'results', 'failed', 'worker', 'from', 'to', 'kind', 'lang', 'text', 'units', 'pair',
  'cached', 'rungs', 'mode', 'why', 'predicted', 'lowerMb', 'lowerPredicted', 'allowance', 'spent', 'file', 'ended', 'eta',
  'qLen', 'attempt', 'pad', 'arrow', 'before', 'prompt', 'after', 'len', 'chars', 'control', 'device', 'ses', 'seg', 'found', 'range', 'pinned',
  'who', 'rung', 'top', 'ago', 'counted', 'freeMb', 'growthMb', 'floorGb', 'jumps']); // play_plan: the plan and why (2026-10-23); search_shape: no search text (#143, 2026-10-24); pinned: a play answered from its ticket's pin (#293, 2026-10-28); video_report: who, rung, top, ago, counted (world #353, 2026-10-29); home_no_room: freeMb, growthMb, floorGb (2026-10-30); media_done jumps (#367)

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
    // Event names are the code's own snake_case constants, never data; some are ID-shaped (android_av1, 2026-10-23).
    if (k === 'event' && typeof v === 'string' && /^[a-z][a-z0-9_]{0,40}$/.test(v)) { out[k] = v; continue; }
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
// A worktree's .git is a file naming its own git dir, whose branches live in the main one (commondir); the owner's
// go-live runs the tests in one (2026-10-29).
export function gitHead(dir = new URL('../.git', import.meta.url)) {
  try {
    let git = fileURLToPath(dir).replace(/[\\/]$/, '');
    let common = git;
    if (statSync(git).isFile()) {
      git = resolve(dirname(git), readFileSync(git, 'utf8').match(/^gitdir: (.+)$/m)[1].trim());
      try { common = resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim()); } catch { /* not a worktree */ }
    }
    const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 40);
    const ref = head.slice(5);
    try { return readFileSync(join(common, ref), 'utf8').trim(); } catch { /* packed */ }
    const line = readFileSync(join(common, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 40) : null;
  } catch { return null; }
}

export function opsRoute(req, res, url, { token, ring, state, slots, adaptive, playback }) {
  const send = (status, body) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  if (!token) return send(404, { v: 1, error: 'not_found', message: 'Unknown path.' });
  if (!tokenOk(req, url, token)) return send(401, { v: 1, error: 'unauthorized', message: 'Bad stats token.' });
  const p = url.pathname.replace(/\/$/, '');
  if (req.method !== 'GET' && req.method !== 'HEAD' && p !== '/ops/slots/refill' && p !== '/ops/plan') return send(405, { v: 1, error: 'method', message: 'GET only.' });
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
  if (p === '/ops/plan' && adaptive) {
    if (req.method === 'POST') {
      const id = url.searchParams.get('id') ?? '';
      const mode = url.searchParams.get('mode') ?? '';
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return send(400, { v: 1, error: 'bad_id', message: 'id: an 11-character video id.' });
      const modes = ['lower', 'direct', 'adaptive', 'start', ...(playback?.forceRestricted ? ['restricted'] : []), 'clear'];
      if (!modes.includes(mode)) return send(400, { v: 1, error: 'bad_mode', message: `mode: ${modes.join(', ')}.` });
      const minutes = Math.min(240, Math.max(1, Number.parseInt(url.searchParams.get('minutes') ?? '', 10) || 60));
      // restricted (#305) is the playback's verdict, not a plan: it and a plan can't both hold, so one clears the other.
      playback?.forceRestricted?.(id, mode === 'restricted' ? minutes : 0);
      adaptive.force(id, mode === 'clear' || mode === 'restricted' ? null : mode, minutes);
    }
    return send(200, { v: 1, at: new Date().toISOString(), forced: [...adaptive.forcedPlans(), ...(playback?.forcedRestrictions?.() ?? [])] });
  }
  return send(404, { v: 1, error: 'not_found', message: 'Unknown path.' });
}
