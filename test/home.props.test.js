// Everything-is-OK#1009 (pilot A of #1007): generated sequences against the REAL home relay bookkeeping (src/home.js Home),
// checked after every step against promises its own comments make. Example tests (home.test.js) check the cases someone
// thought of; three production bugs got past them (the disk filling 2026-10-28/30, a failed session deleted under its
// players, verifier M1 2026-11-15, and a start race). Here a seeded generator draws starts, worker uploads, player fetches,
// sweeps, clock jumps, worker failures and restarts, and after each step the test checks, from its OWN records (when it
// fetched each token, the starts it saw, the bytes it put, and a model of each session built only from what the test sent
// and saw: `model` below), not from Home's fields. Two things do come from Home: which sessions exist (byToken and sessions,
// what A1 and A2 check) and a new session's token and worker (start's answer, recorded once):
//   A1 no delete under a player or a live build; a restart keeps exactly what #load promises to keep;
//   A2 the maps agree (sessions, byToken, the folders on disk, the MB counted);
//   A3 the limits hold at every start (day, hour, start gap with its AV1 exception, streams per worker);
//   A4 the disk: the free-space floor after a start, and the size cap after a sweep.
// Sizes are scaled down (segments of 20-150 KB, videos of 1-5 s, caps of a few MB) so the limits bite in a few steps.
// Bounds: FUZZ_STEPS (150) steps per sequence, FUZZ_SEEDS (100) seeds from FUZZ_SEED (1009) in npm test. By hand:
//   FUZZ_SEED=n node --test test/home.props.test.js          one seed (prints the shrunk failing ops, if any)
//   FUZZ_SEEDS=2000 node --test test/home.props.test.js      a sweep, in this one process, with reach counts
// Not covered: the half-floor stop in put (home.js put, the freeFloorGb x 500 check), segment holds and want(), the
// playlist text players get, eta/settle. The skill .claude/skills/verify-home/SKILL.md says how to read a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { Home, MB_PER_SECOND, mbPerSecond } from '../src/home.js';
import { dayOf } from '../src/metrics.js';

const SEED = Number(process.env.FUZZ_SEED) || 1009;
const SEEDS = Number(process.env.FUZZ_SEEDS) || (process.env.FUZZ_SEED ? 1 : 100);
const STEPS = Number(process.env.FUZZ_STEPS) || 150;

// home.js's own constants (not exported), by name: PLAYING_MS, STALE_MS; and the 30 s at which #write saves lastPutMs to
// meta.json, so a reloaded session's lastPutMs may lag the real last upload by up to that (home.js #write, "at least every
// 30 s, so a restart doesn't take a live stream for a dead one").
const PLAYING_MS = 5 * 60_000;
const STALE_MS = 5 * 60_000;
const META_LAG_MS = 30_000;
const HOUR = 3600_000;
const TZ = 'America/Chicago';
const TOKEN = /^[a-f0-9]{18}$/;
const EPS = 1e-9;

// mulberry32, as test/fuzz5xx.test.js: the same seed draws the same sequence.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Session tokens (home.js start: randomBytes(9)) decide the order #load reads the folders in, so random ones made a seed's
// run differ between runs (2026-11-22). randomBytes is swapped for a seeded one while a sequence runs, with no seam in src/:
// syncBuiltinESMExports() carries the swap to home.js's `import { randomBytes } from 'node:crypto'`. With readdirSync
// sorted as well (sortedReaddir below), a seed runs the same on every platform.
const realRandomBytes = crypto.randomBytes;
function seededTokens(seed) {
  const r = rng(seed ^ 0x70c3);
  crypto.randomBytes = (n, cb) => {
    if (n !== 9 || cb) return realRandomBytes(n, cb);
    return Buffer.from(Array.from({ length: 9 }, () => Math.floor(r() * 256)));
  };
  syncBuiltinESMExports();
}
function realTokens() { crypto.randomBytes = realRandomBytes; fs.readdirSync = realReaddir; syncBuiltinESMExports(); }
// The order #load reads the folders in is the file system's (sorted on Windows, hashed on Linux's ext4), so readdirSync is
// sorted while a sequence runs: a seed then runs the same on every platform (verifier, 2026-11-23: with the order changed,
// three strict seeds moved).
const realReaddir = fs.readdirSync;
function sortedReaddir() {
  fs.readdirSync = (path, options) => { const out = realReaddir(path, options); return options?.withFileTypes ? out : [...out].sort(); };
  syncBuiltinESMExports();
}

// The settings of one seed: each limit on at some seeds and off at others.
function settings(seed) {
  const r = rng(seed ^ 0x5eed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'];
  return {
    // dailyMb small on some seeds, so the day's MB binds before its builds do (verifier M4, 2026-11-23: at 2-10 MB it never did).
    dailyBuilds: 3 + Math.floor(r() * 8), dailyMb: pick([0.3, 0.8, 2 + r() * 8]),
    hourBuilds: pick([0, 2, 3, 5]), hourMb: pick([0, 1.5, 3]), hourMbExemptSeconds: pick([0, 4]),
    startGapMs: pick([0, 20_000, 90_000]), av1GapMs: pick([0, 10_000]), av1HourBuilds: pick([0, 2, 4]),
    itemMaxMb: pick([0, 0, 2]), keepHours: pick([1, 3, 12]), maxGb: pick([0.0015, 0.003]), freeFloorGb: pick([0, 0.001, 0.002]),
    capacityMb: 4 + r() * 6, mediaMax: { w1: 1 + Math.floor(r() * 3), w2: 1 + Math.floor(r() * 3) },
    videos: ids.map((id) => ({ id, seconds: 1 + Math.floor(r() * 5), segs: 2 + Math.floor(r() * 5) })),
  };
}

// The ops, drawn as data first and read against the state as they run, so a failing sequence can be shrunk by deleting ops.
const KINDS = [['start', 14], ['playlist', 12], ['segment', 26], ['get', 16], ['sweep', 5], ['clock', 12], ['giveUp', 2],
  ['reject', 3], ['worker', 2], ['refused', 2], ['other', 2], ['restart', 4]];
const WEIGHT = KINDS.reduce((n, [, w]) => n + w, 0);
function draw(seed, n) {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    let x = r() * WEIGHT, k = KINDS[0][0];
    for (const [name, w] of KINDS) { if (x < w) { k = name; break; } x -= w; }
    return { k, a: r(), b: r(), c: r(), d: r() };
  });
}

const ago = (ms) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);
const segSize = (ti, i) => 20_000 + ((ti * 7919 + i * 104_729) % 130_000);
const playlist = (n, end, type = end ? 'VOD' : 'EVENT') =>
  `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:${type}\n${Array.from({ length: n }, (_, i) => `#EXTINF:4.000000,\nseg${i}.ts\n`).join('')}${end ? '#EXT-X-ENDLIST\n' : ''}`;

// One sequence. → { fail: null | { prop, step, message }, trace, reach }.
// known: the open findings to tell apart from new failures (see KNOWN below); each one is named where it is excused.
export async function runOne(seed, ops, { known = KNOWN } = {}) {
  const cfg = settings(seed);
  seededTokens(seed);
  sortedReaddir();
  const dir = mkdtempSync(join(tmpdir(), 'home-props-'));
  let now = Date.parse('2026-11-20T22:00:00Z'); // 16:00 in Chicago, so clock jumps cross the caps' midnight
  const online = { w1: true, w2: false };
  let refused = false, otherMb = 0, epoch = 0;
  const jobs = []; // { token, epoch, reject, settled }
  const relay = { enabled: true, capable: () => Object.keys(online).filter((w) => online[w]), mediaMax: () => cfg.mediaMax,
    run(job, { worker }) { return new Promise((resolve, reject) => { jobs.push({ token: job.token, worker, epoch, reject, settled: false }); }); } };
  // The test's own records.
  const issued = [];                // tokens, in order: t0, t1, ...
  const info = new Map();           // token → { name, v, q, cached, ti, started }
  const bytes = new Map();          // token → bytes of the segments it put (204), each segment once
  const segs = new Map();           // token → Set of segment indexes stored
  const lastPut = new Map();        // token → time of its last 204 upload
  const lagged = new Set();         // tokens reloaded by a restart and not uploaded to since (meta.json's lastPutMs may lag)
  const fetched = new Map();        // token → the last time a player fetched it while it was there
  const stamped = new Map();        // token → the restart that counted it as played (home.js #load, cut_short)
  const closed = new Set();         // streams whose worker sent the closing playlist
  const mode = new Map();           // token → 'whole' or 'growing': the kind of playlist its worker sends
  const grown = new Map();          // token → segments its growing playlist lists
  const reloaded = new Set();       // tokens the latest restart reloaded
  const fetchedSince = new Set();   // tokens a player fetched since the latest restart
  const starts = [];                // { t, token, av1, worker, expected, seconds, epoch }
  const cachedAt = new Map();       // token → when its first cached upload was taken (a cache hit)
  const hits = [];                  // { token, t, again }: every cache hit the test expects Home to take
  const hitEpoch = new Map();       // token → the restart epoch of its last cache hit: s.cached lives in memory only
  const dayEvents = [];             // { day, kind: 'start' | 'legit' | 'midnight' | 'recached' }, in order: what Home's day count sees
  // The test's model of each session, from what it sent and saw only, by the rules home.js states (the top: building until
  // a listed segment is here, then ready; ended once the playlist has ENDLIST and every segment it lists is here; failed by
  // giveUp, a job failing while it builds, a closing playlist marked x-media-failed or cut back by SHORT_S or more, or a 410
  // on a segment of a live session, the disk's half floor): token → { state, ended, reason, listed, endlist }.
  const model = new Map();
  const mbByDay = new Map();        // day → MB of segments downloaded (not cached) that day
  const reach = {};
  const bump = (k) => { reach[k] = (reach[k] ?? 0) + 1; };
  const trace = [];
  let events = [];
  const freeMb = () => cfg.capacityMb - otherMb - issued.reduce((n, tok) => n + (existsSync(join(dir, tok)) ? (bytes.get(tok) ?? 0) / 1e6 : 0), 0);
  const opts = () => ({ relay, dir, enabled: true, dailyBuilds: cfg.dailyBuilds, dailyMb: cfg.dailyMb, hourBuilds: cfg.hourBuilds, hourMb: cfg.hourMb,
    hourMbExemptSeconds: cfg.hourMbExemptSeconds, startGapMs: cfg.startGapMs, av1GapMs: cfg.av1GapMs, av1HourBuilds: cfg.av1HourBuilds,
    refusedRecently: () => refused, itemMaxMb: cfg.itemMaxMb, keepHours: cfg.keepHours, maxGb: cfg.maxGb, freeFloorGb: cfg.freeFloorGb, freeMb,
    segmentHoldMs: 1, tz: TZ, now: () => now,
    log: (l) => { if (l.event === 'home_evict') bump(`evict_${l.why}`); else if (l.event === 'home_failed') bump(`failed_${l.reason}`); else if (['home_set_aside', 'home_av1_gap', 'home_over_cap', 'home_no_room'].includes(l.event)) bump(l.event); else if (l.event === 'home_loaded' && l.dropped) bump('load_dropped'); },
    onEvent: (k) => { events.push(k); if (['capped', 'capped_hour', 'spaced', 'cache_hit', 'no_room'].includes(k)) bump(k); } });
  let home = new Home(opts());
  const pending = [];
  const name = (tok) => info.get(tok)?.name ?? tok.slice(0, 4);
  const real = () => starts.filter((x) => !cachedAt.has(x.token));
  const played = (tok, withStamp) => Math.max(fetched.get(tok) ?? -Infinity, withStamp ? stamped.get(tok) ?? -Infinity : -Infinity);
  const sinceUpload = (tok) => now - (lastPut.get(tok) ?? info.get(tok).started);
  const finished = (tok) => { const m = model.get(tok); return m.ended || m.state === 'failed'; };
  const liveBuild = (tok) => !finished(tok) && sinceUpload(tok) <= STALE_MS - (lagged.has(tok) ? META_LAG_MS : 0);
  // home.js #expectedMb, written out from the model (it is private; state() rounds it to whole MB, too coarse at these
  // sizes). A drift point: the skill lists it. An unfinished session counts its expected final size. A session reloaded and
  // not uploaded to since may look stale to Home up to META_LAG_MS early: it counts as stale then (Home's smaller sum).
  const expectedOf = (tok) => {
    const m = model.get(tok), mb = (bytes.get(tok) ?? 0) / 1e6, stored = segs.get(tok).size;
    if (finished(tok) || sinceUpload(tok) > STALE_MS - (lagged.has(tok) ? META_LAG_MS : 0)) return mb;
    const est = stored && m.listed > stored ? mb * m.listed / stored : info.get(tok).v.seconds * MB_PER_SECOND;
    return Math.max(mb, est);
  };
  // The model's rules, applied as the test sends.
  const ended = (tok) => { const m = model.get(tok); if (!m.ended && m.endlist && [...Array(m.listed).keys()].every((i) => segs.get(tok).has(i))) m.ended = true; }; // #checkEnded
  const failModel = (tok, reason) => { const m = model.get(tok); if (m.state !== 'failed') Object.assign(m, { state: 'failed', reason }); };
  // A cache upload reaching a session Home has and the model says is not failed (home.js put takes the hit before any other
  // check but the 410): the test expects a cache hit on the first one in each restart epoch (put sets s.cached, which a
  // restart forgets), by kind: a repeat in a later epoch than the token's last hit (recached, #1013), the first one on a
  // later day than its build started (midnight, #1018), or the first one on its build's day. Not read from Home's s.cached
  // (verifier N1, 2026-11-23): a Home that took a hit on every cached upload must fail here, not be excused as recached.
  const hit = (tok) => {
    if (hitEpoch.get(tok) === epoch) return;
    const again = cachedAt.has(tok), day = dayOf(now, TZ), later = day !== dayOf(info.get(tok).started, TZ);
    hitEpoch.set(tok, epoch);
    hits.push({ token: tok, t: now, again });
    if (!again) { cachedAt.set(tok, now); if (later) bump('hit_next_day'); }
    dayEvents.push({ day, kind: again ? 'recached' : later ? 'midnight' : 'legit' });
  };
  const fail = (prop, message) => { throw Object.assign(new Error(message), { prop }); };

  // A1 and A2, after every step but a restart.
  const snapshot = () => new Map([...home.byToken.keys()].map((tok) => { const m = model.get(tok); return [tok, { live: liveBuild(tok), state: m.state, ended: m.ended, reason: m.reason, stored: segs.get(tok).size, listed: m.listed }]; }));
  function checkAfter(before, op) {
    for (const [tok, was] of before) {
      if (home.byToken.has(tok)) continue;
      if (was.live) fail('A1', `${name(tok)} (${was.state}, building or uploading, not stale) was removed by ${op}`);
      const f = now - played(tok, false);
      // KNOWN reload (Everything-is-OK#1011; strict seeds 1105, 1116): #load rebuilds a session with lastGetMs 0 (home.js
      // #session; only a cut_short one is stamped), so a sweep before the player's next fetch takes it for unplayed. Excused
      // only for the played check (not the live one above), and only for a session the latest restart reloaded and no
      // player fetched since.
      if (f < PLAYING_MS && known.has('reload') && reloaded.has(tok) && !fetchedSince.has(tok)) { bump('known_reload'); continue; }
      if (f < PLAYING_MS) fail('A1', `${name(tok)} (${was.state}${was.ended ? ', ended' : ''}) was removed by ${op} while a player fetched it ${ago(f)} ago`);
    }
    for (const [key, s] of home.sessions) {
      if (key !== `${s.id}@${s.quality}`) fail('A2', `sessions holds ${name(s.token)} under ${key}`);
      if (home.byToken.get(s.token) !== s) fail('A2', `${name(s.token)} is in sessions but not in byToken`);
    }
    const folders = readdirSync(dir).filter((f) => TOKEN.test(f)).sort();
    const tokens = [...home.byToken.keys()].sort();
    if (folders.join() !== tokens.join()) fail('A2', `folders on disk [${folders.map(name)}] are not byToken's [${tokens.map(name)}]`);
    for (const [tok, s] of home.byToken) {
      if (Math.abs(s.mb - (bytes.get(tok) ?? 0) / 1e6) > EPS) fail('A2', `${name(tok)} counts ${s.mb} MB, the test put ${(bytes.get(tok) ?? 0) / 1e6}`);
      // Home's state agrees with what the worker sent (the model). Ended is compared only while not failed: a failed session
      // is "failed, not done" (home.js #playlist), whether or not #load later finds its closing playlist complete.
      const m = model.get(tok);
      if (s.state !== m.state || (m.state !== 'failed' && s.ended !== m.ended)) fail('A2', `${name(tok)} is ${s.state}${s.ended ? ', ended' : ''} in Home, ${m.state}${m.ended ? ', ended' : ''} by what its worker sent`);
    }
  }

  // A3 and A4 at a start that made a new session.
  function checkStart(rec, v) {
    const today = dayOf(now, TZ);
    const realToday = real().filter((x) => dayOf(x.t, TZ) === today).length;
    if (realToday + 1 > cfg.dailyBuilds) {
      // Over the day's real builds. Excused only if Home's day count, as the KNOWN findings alone would make it, was under
      // dailyBuilds: the day's starts less its cache hits, each finding's kind of hit counted only if that finding is known,
      // floored at 0 as home.js put does. So neither exclusion can pay for the other's case (verifier M3, 2026-11-23).
      // KNOWN midnight (Everything-is-OK#1018): a cache hit is taken off the day it is marked (home.js put, d.builds - 1 on
      // #today()), so a build started on an earlier day and marked cached today gives today one more real build.
      // KNOWN recached (Everything-is-OK#1013): s.cached is not saved in meta.json (#saveMeta) or set by #load, so after a
      // restart a cache upload already counted as a cache hit takes the day's builds down again.
      let count = 0;
      const used = new Set();
      for (const e of dayEvents) {
        if (e.day !== today) continue;
        if (e.kind === 'start') count++;
        else if (e.kind === 'legit' || known.has(e.kind)) { if (e.kind !== 'legit') used.add(e.kind); count = Math.max(0, count - 1); }
      }
      if (count < cfg.dailyBuilds && used.size) for (const k of used) bump(`known_${k}`);
      else fail('A3', `start ${name(rec.token)} is real build ${realToday + 1} of ${today}, over dailyBuilds ${cfg.dailyBuilds}`);
    }
    if ((mbByDay.get(today) ?? 0) >= cfg.dailyMb - EPS) fail('A3', `start ${name(rec.token)} with ${(mbByDay.get(today)).toFixed(3)} MB downloaded today, dailyMb ${cfg.dailyMb.toFixed(3)}`);
    const epochReal = real().filter((x) => x.epoch === epoch); // a restart forgets the hour and the gap (home.js: recent, lastStartMs)
    const hour = epochReal.filter((x) => now - x.t < HOUR);
    if (cfg.hourBuilds > 0 && hour.length + 1 > cfg.hourBuilds) fail('A3', `start ${name(rec.token)} is build ${hour.length + 1} in the hour, hourBuilds ${cfg.hourBuilds}`);
    const exempt = cfg.hourMbExemptSeconds > 0 && v.seconds >= cfg.hourMbExemptSeconds;
    const hourMb = hour.reduce((n, x) => n + x.expected, 0);
    if (cfg.hourMb > 0 && !exempt && hour.length > 0 && hourMb + rec.expected > cfg.hourMb + EPS) fail('A3', `start ${name(rec.token)} takes the hour to ${(hourMb + rec.expected).toFixed(3)} MB, hourMb ${cfg.hourMb}`);
    if (cfg.itemMaxMb > 0 && rec.expected > cfg.itemMaxMb + EPS) fail('A3', `start ${name(rec.token)} expects ${rec.expected.toFixed(3)} MB, itemMaxMb ${cfg.itemMaxMb}`);
    if (cfg.startGapMs > 0 && epochReal.length) {
      const gap = now - Math.max(...epochReal.map((x) => x.t));
      if (gap < cfg.startGapMs) {
        const hammering = !(cfg.av1GapMs > 0) || gap < cfg.av1GapMs || (cfg.av1HourBuilds > 0 && hour.length >= cfg.av1HourBuilds) || refused;
        if (!(rec.av1 && !hammering)) fail('A3', `start ${name(rec.token)}${rec.av1 ? ' (AV1, hammering)' : ''} ${ago(gap)} after the last real build, startGapMs ${ago(cfg.startGapMs)}`);
        bump('av1_inside_gap');
      }
    }
    if (!online[rec.worker]) fail('A3', `start ${name(rec.token)} went to ${rec.worker}, which is offline`);
    const streams = [...home.byToken.keys()].filter((tok) => info.get(tok).worker === rec.worker && liveBuild(tok)).length;
    if (streams > cfg.mediaMax[rec.worker]) fail('A3', `${rec.worker} runs ${streams} streams after start ${name(rec.token)}, mediaMax ${cfg.mediaMax[rec.worker]}`);
    if (cfg.freeFloorGb > 0) {
      const growth = [...home.byToken.keys()].reduce((n, tok) => n + Math.max(0, expectedOf(tok) - (bytes.get(tok) ?? 0) / 1e6), 0);
      if (freeMb() - growth < cfg.freeFloorGb * 1000 - EPS) fail('A4', `after start ${name(rec.token)}: ${freeMb().toFixed(3)} MB free, ${growth.toFixed(3)} MB still to grow, floor ${cfg.freeFloorGb * 1000} MB`);
    }
  }
  function checkSweep() {
    for (const [tok, s] of home.byToken) {
      if (home.sessions.get(`${s.id}@${s.quality}`) === s) continue;
      bump('orphan_kept');
      if (now - played(tok, true) >= PLAYING_MS) fail('A2', `${name(tok)}, set aside (not in sessions), outlived a sweep with no player for ${ago(now - played(tok, true))}`);
    }
    const total = [...home.byToken.keys()].reduce((n, tok) => n + expectedOf(tok), 0);
    if (total > cfg.maxGb * 1000 + EPS) {
      bump('over_cap_after_sweep');
      for (const tok of home.byToken.keys()) if (finished(tok) && now - played(tok, true) >= PLAYING_MS) fail('A4', `after a sweep the sessions expect ${total.toFixed(3)} MB > maxGb, and ${name(tok)} (finished, unplayed) is still there`);
    }
  }
  // A1, the restart: #load keeps the ready, not-stale sessions and the cut_short failures with files, and nothing else.
  function checkRestart(before) {
    for (const [tok, was] of before) {
      const kept = home.byToken.has(tok);
      const since = sinceUpload(tok);
      // Ready as #load reads it from disk: a playlist that lists a segment, and a segment here (home.js #playlist). An ended
      // session whose closing playlist was cut back to no segment at all (a video under SHORT_S, taken as done) has nothing
      // to play, so #load dropping it as never ready cuts no play off.
      const mustKeep = (was.state === 'ready' && was.listed > 0 && (was.ended || since <= STALE_MS - META_LAG_MS)) || (was.state === 'failed' && was.reason === 'cut_short' && was.stored > 0);
      const mustDrop = was.state === 'building' || (was.state === 'failed' && !(was.reason === 'cut_short' && was.stored > 0)) || (was.state === 'ready' && !was.ended && since > STALE_MS);
      if (mustKeep && !kept) fail('A1', `restart dropped ${name(tok)} (${was.state}${was.ended ? ', ended' : ''}${was.reason ? `, ${was.reason}` : ''})`);
      if (mustDrop && kept) fail('A1', `restart kept ${name(tok)} (${was.state}${was.reason ? `, ${was.reason}` : ''}${was.state === 'ready' ? `, no upload for ${ago(since)}` : ''})`);
    }
  }

  let step = 0;
  try {
    for (const op of ops) {
      const before = snapshot();
      events = [];
      const pickTok = (x) => (issued.length ? issued[Math.floor(x * issued.length)] : null);
      let line = op.k, after = true;
      switch (op.k) {
        case 'start': {
          const v = cfg.videos[Math.floor(op.a * cfg.videos.length)];
          const q = op.b < 0.5 ? '720p' : '1080p';
          const av1 = op.c < 0.3;
          const s = home.start({ id: v.id, seconds: v.seconds }, q, { av1 });
          line = `start(${v.id.slice(0, 1)}@${q}${av1 ? ', av1' : ''})`;
          if (events.includes('start')) {
            const tok = s.token;
            issued.push(tok);
            info.set(tok, { name: `t${issued.length - 1}`, v, q, cached: op.d < 0.25, ti: issued.length - 1, started: now, worker: s.worker });
            segs.set(tok, new Set());
            model.set(tok, { state: 'building', ended: false, reason: null, listed: 0, endlist: false });
            const rec = { t: now, token: tok, av1, worker: s.worker, expected: v.seconds * mbPerSecond(q), seconds: v.seconds, epoch };
            line += ` → new ${name(tok)} on ${s.worker}${info.get(tok).cached ? ' (its worker uploads from cache)' : ''}`;
            trace.push(`${step}: ${line}`);
            checkAfter(before, line);
            checkStart(rec, v);
            starts.push(rec);
            dayEvents.push({ day: dayOf(rec.t, TZ), kind: 'start' }); // after the check: Home checks the cap before it counts the build
            after = false;
          } else line += s ? ` → ${name(s.token)} again` : ` → none (${events.join(',') || home.refusal || 'no worker'})`;
          break;
        }
        case 'playlist': case 'segment': {
          // Only a stream that is still open uploads: after its closing playlist a worker stops (relay/media.js).
          const open = issued.filter((x) => !closed.has(x));
          const tok = open.length ? open[Math.floor(op.a * open.length)] : null;
          if (!tok) { line = `${op.k}: no open stream`; break; }
          const { v, cached, ti } = info.get(tok);
          const n = v.segs;
          let status, what;
          if (op.k === 'playlist') {
            let text, failed = false;
            const have = segs.get(tok);
            // A worker sends either the whole predicted playlist (steady segments) or a growing one that only grows (uneven
            // ones), never both, then the closing one (relay/media.js mediaJob; home.js, the top).
            const kind = mode.get(tok) ?? (op.b < 0.35 ? 'whole' : 'growing');
            if (op.b < 0.7 && kind === 'whole') { mode.set(tok, kind); text = playlist(n, true); what = `whole (predicted), ${n} segments`; }
            else if (op.b < 0.7) { const k = Math.max(grown.get(tok) ?? 1, 1 + Math.floor(op.c * n)); grown.set(tok, k); mode.set(tok, kind); text = playlist(k, false); what = `growing, ${k} segments`; }
            else {
              // The closing playlist: every segment, or cut back to the ones sent in order from seg0 (relay/media.js closedAt),
              // marked failed when the copy isn't whole (x-media-failed, #781); the stream ends there.
              let k = 0;
              while (k < n && have.has(k)) k++;
              failed = k < n ? op.d < 0.5 : op.d < 0.1;
              text = playlist(k, true); what = k < n ? `closing, cut back to ${k} of ${n}` : `closing, all ${n}`;
              closed.add(tok);
            }
            const s0 = home.byToken.get(tok);
            if (cached && s0 && model.get(tok).state !== 'failed') hit(tok);
            status = home.put(tok, 'index.m3u8', Buffer.from(text), { cached, failed });
            line = `put(${name(tok)}, index.m3u8 ${what}${failed ? ', x-media-failed' : ''}${cached ? ', cached' : ''}) → ${status}`;
            if (status === 204) {
              const m = model.get(tok), k = (text.match(/^seg\d+\.ts$/gm) ?? []).length, end = text.includes('#EXT-X-ENDLIST'), before = m.listed;
              Object.assign(m, { listed: k, endlist: end });
              if (m.state === 'building' && k > 0 && have.size > 0) m.state = 'ready';
              // A closing playlist marked failed, or with fewer segments and SHORT_S (10 s) or more shorter (4 s each here): failed.
              if (end && (failed || (k < before && 4 * k < 4 * before - 10)) && m.state !== 'failed') failModel(tok, 'cut_short'); else ended(tok);
            }
          } else {
            const have = segs.get(tok);
            const i = op.b < 0.6 ? Math.min(n - 1, (have.size ? Math.max(...have) : -1) + 1) : Math.floor(op.c * n);
            const size = segSize(ti, i);
            const s = home.byToken.get(tok);
            // home.js put takes the cache hit before the segment checks, so a 410 for the disk still counts it.
            if (cached && s && model.get(tok).state !== 'failed') hit(tok);
            status = home.put(tok, `seg${i}.ts`, Buffer.alloc(size), { cached });
            line = `put(${name(tok)}, seg${i}.ts${cached ? ', cached' : ''}) → ${status}`;
            if (status === 410 && s && model.get(tok).state !== 'failed') failModel(tok, 'no_room'); // put: the disk's half floor
            if (status === 204) {
              if (!have.has(i)) {
                have.add(i);
                bytes.set(tok, (bytes.get(tok) ?? 0) + size);
                // home.js put: a segment counts against the day's MB unless its session is cached by now; a stream's uploads are
                // all cached or none (relay/media.js), and its first cached one sets s.cached before the segment counts.
                if (!cached) { const d = dayOf(now, TZ); mbByDay.set(d, (mbByDay.get(d) ?? 0) + size / 1e6); }
              }
              const m = model.get(tok);
              if (m.state === 'building' && m.listed > 0) m.state = 'ready';
              ended(tok);
            }
          }
          if (status === 204) { lastPut.set(tok, now); lagged.delete(tok); }
          break;
        }
        case 'get': {
          const tok = pickTok(op.a);
          if (!tok) { line = 'get: no session yet'; break; }
          const file = op.b < 0.3 ? 'index.m3u8' : `seg${Math.floor(op.c * info.get(tok).v.segs)}.ts`;
          if (home.byToken.has(tok)) { fetched.set(tok, now); fetchedSince.add(tok); }
          pending.push(home.file(tok, file).catch(() => null));
          line = `get(${name(tok)}, ${file})${home.byToken.has(tok) ? '' : ' → gone'}`;
          break;
        }
        case 'sweep': home.sweep(); trace.push(`${step}: sweep()`); checkAfter(before, 'sweep()'); checkSweep(); after = false; break;
        case 'clock': {
          const dt = op.a < 0.6 ? 1000 + Math.floor(op.b * 89_000) : op.a < 0.9 ? 120_000 + Math.floor(op.b * 480_000) : HOUR + Math.floor(op.b * 12 * HOUR);
          now += dt; line = `clock +${ago(dt)}`; break;
        }
        case 'giveUp': {
          const live = [...home.byToken.keys()].filter((tok) => model.get(tok).state !== 'failed');
          if (!live.length) { line = 'giveUp: none'; break; }
          const tok = live[Math.floor(op.a * live.length)];
          home.giveUp(home.byToken.get(tok)); failModel(tok, 'uneven'); line = `giveUp(${name(tok)})`; break;
        }
        case 'reject': {
          const open = jobs.filter((j) => j.epoch === epoch && !j.settled);
          if (!open.length) { line = 'reject: no job'; break; }
          const j = open[Math.floor(op.a * open.length)];
          j.settled = true;
          j.reject(Object.assign(new Error('worker failed'), { code: 'worker_failed' }));
          await new Promise((r) => setImmediate(r));
          if (home.byToken.has(j.token) && model.get(j.token).state === 'building') failModel(j.token, 'worker_failed'); // start's .catch
          line = `the worker fails ${name(j.token)}'s job`; break;
        }
        case 'worker': { const w = op.a < 0.5 ? 'w1' : 'w2'; online[w] = !online[w]; line = `${w} ${online[w] ? 'online' : 'offline'}`; break; }
        case 'refused': refused = !refused; line = `refusedRecently ${refused}`; break;
        case 'other': otherMb = op.a * cfg.capacityMb * 0.5; line = `other disk use ${otherMb.toFixed(2)} MB`; break;
        case 'restart': {
          home.flush(); // server.js on SIGTERM
          epoch++; // the old process's relay jobs are never settled: it is gone
          home = new Home(opts());
          reloaded.clear(); fetchedSince.clear();
          for (const [tok, s] of home.byToken) {
            reloaded.add(tok);
            lagged.add(tok);
            if (s.state === 'failed') stamped.set(tok, now); // home.js #load: a cut_short one counts as played from the restart
          }
          bump('restart');
          trace.push(`${step}: restart (flush, then a new Home on the same dir)`);
          checkRestart(before);
          checkAfter(new Map(), 'restart');
          after = false;
          break;
        }
      }
      if (after) { trace.push(`${step}: ${line}`); checkAfter(before, line); }
      step++;
    }
    return { fail: null, trace, reach };
  } catch (err) {
    if (!err.prop) throw err;
    return { fail: { prop: err.prop, step, message: err.message }, trace, reach };
  } finally {
    await Promise.all(pending);
    realTokens();
    rmSync(dir, { recursive: true, force: true });
  }
}

// The open findings: each is excused only where its own check names it, and is listed in the skill with its seed.
export const KNOWN = new Set(process.env.FUZZ_STRICT ? [] : (process.env.FUZZ_KNOWN ?? 'reload,recached,midnight').split(',').filter(Boolean));

// Deletes ops while the same property still fails: the shortest sequence this finds, for the report.
export async function shrink(seed, ops, prop) {
  let best = ops;
  for (let chunk = Math.max(1, best.length >> 1); chunk >= 1; chunk >>= 1) {
    for (let i = 0; i < best.length;) {
      const tryOps = [...best.slice(0, i), ...best.slice(i + chunk)];
      const r = await runOne(seed, tryOps);
      if (r.fail?.prop === prop) best = tryOps.slice(0, r.fail.step + 1); else i += chunk;
    }
  }
  return best;
}

// The open findings, until their fixes land. Each fix drops its name from KNOWN and its todo here (the skill says how).
// FUZZ_STRICT=1 runs with no exclusion; FUZZ_KNOWN=reload,recached (say) keeps only the named ones.
test.todo('home props finding "reload forgets players" (Everything-is-OK#1011; strict seeds 1105, 1116): a restart gives every reloaded session lastGetMs 0 (home.js #load, #session), so the next sweep can evict a finished one a player is on');
test.todo('home props finding "recached" (Everything-is-OK#1013; strict seed 1026): s.cached is not saved in meta.json, so after a restart a cache upload takes its cache hit again (home.js put), and the day lets one more real build through than dailyBuilds');
test.todo('home props finding "midnight" (Everything-is-OK#1018; strict seed 2925): a cache hit is taken off the day it is marked, not the day its build started (home.js put), so a build started before midnight and marked cached after it gives the new day one more real build');

async function report(seed, ops, fail) {
  const small = await shrink(seed, ops.slice(0, fail.step + 1), fail.prop);
  const r = await runOne(seed, small);
  return `${fail.prop} on seed ${seed}: ${r.fail?.message ?? fail.message}\nsettings: ${JSON.stringify(settings(seed))}\n` +
    `shrunk to ${small.length} ops:\n  ${r.trace.join('\n  ')}\nrerun: ${process.env.FUZZ_STRICT ? 'FUZZ_STRICT=1 ' : process.env.FUZZ_KNOWN != null ? `FUZZ_KNOWN=${process.env.FUZZ_KNOWN} ` : ''}FUZZ_SEED=${seed} node --test test/home.props.test.js`;
}

test(`home props (#1009): ${SEEDS} seeds from ${SEED}, ${STEPS} steps each, keep A1-A4`, async (t) => {
  const reach = {};
  const failures = [];
  const started = Date.now();
  for (let seed = SEED; seed < SEED + SEEDS; seed++) {
    const ops = draw(seed, STEPS);
    const r = await runOne(seed, ops);
    for (const [k, n] of Object.entries(r.reach)) reach[k] = (reach[k] ?? 0) + n;
    if (r.fail) {
      failures.push({ seed, ...r.fail });
      if (failures.length === 1 || SEEDS <= 50) t.diagnostic(await report(seed, ops, r.fail));
    }
  }
  t.diagnostic(`${SEEDS} seeds in ${Date.now() - started} ms; reach: ${JSON.stringify(Object.fromEntries(Object.entries(reach).sort()))}`);
  if (failures.length) {
    const by = {};
    for (const f of failures) by[f.prop] = [...(by[f.prop] ?? []), f.seed];
    t.diagnostic(`failing seeds by property: ${JSON.stringify(by)}`);
  }
  assert.deepEqual(failures.map((f) => `${f.prop} seed ${f.seed}: ${f.message}`), []);
});
