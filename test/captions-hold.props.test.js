// Everything-is-OK#996, pilot B of #1007: the captions exchange around a held play, as generated orderings. The service is
// the REAL app (createApp with a real Store; only `playback` and `captions` are faked: a player's ticket request is held
// until the test lets it go, src/server.js's ticket route `await playback.location(...)`, and a caption lookup comes back
// with no tracks, temporarily_unavailable, until the test lets the sources succeed). The world is a small scripted COPY of the caption-asking rule in the
// world repo's Assets/EverythingIsOK/Scripts/EverythingIsOKYouTubeSearch.cs, read at world commit eddf7f5a (2026-11-22);
// every line of the copy names the C# lines (cs:N) it mirrors. A change to those lines means re-reading the copy
// (.claude/skills/verify-home/SKILL.md, "Pilot B"): the copy can drift; the real world code is the referee, through the
// replay in the test editor (_TesterCaptionAnswer / _TesterCaptionError).
// The ops: the world's caption tick (Captions() plus the string slot sending one ask and reading its answer); the room
// picking a ticket (a new play: the old player's request is dropped, the new one held); a held play ending (its 302,
// after store.markPlayed, even for a dropped request: the service still counts it); a straggler (a player still on an
// older ticket asks it again and is answered at once); the caption sources answering; the visitor turning CC on, opening
// a picker, or leaving. Then a drain: every hold ends, the sources answer, the visitor opens a picker, and the world ticks
// until nothing is due. Timing becomes order: LoadGap (5.2 s, cs:39) and the retry waits (cs:1405-1414) only space the
// asks, so no constant is assumed.
//   B1 (P1): if the visitor stayed and the video has captions, the world ends holding the playing ticket's caption list
//            (and its lines, CC on).
//   B2 (P2): "No captions" (NoCaptions, cs:3571-3575) only follows an answer for that very ticket that says it has none
//            (reason no_captions).
// Both fail on today's code (#996): the promises are test.todo, and a plain test asserts that they DO fail today on the
// recorded seeds, so this file goes red when the code under it changes. The fixer of #996 must then: drop that assertion
// (FAILS_TODAY), turn the todos into plain tests (FUZZ_STRICT=1 runs them now), and, for a world-side fix, change the copy
// below in the same batch as the C# (and re-read it against the new C#).
// By hand: FUZZ_WORLD=today|opt1|opt1x|opt2 picks the copy's variant (#996's options; see VARIANTS), FUZZ_OTHER=0 leaves
// out stragglers, FUZZ_SEED / FUZZ_SEEDS / FUZZ_STEPS as in the other fuzz tests. Service variants are patches to
// src/server.js kept outside the repo (the batch's report names them).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';

const SEED = Number(process.env.FUZZ_SEED) || 996;
const SEEDS = Number(process.env.FUZZ_SEEDS) || (process.env.FUZZ_SEED ? 1 : 60);
const STEPS = Number(process.env.FUZZ_STEPS) || 16;
const WORLD = process.env.FUZZ_WORLD || 'today';
const OTHER = process.env.FUZZ_OTHER !== '0';
const UA = 'NSPlayer/12.00.19041.5794 WMFSDK/12.00.19041.5794'; // a PC player (AVPro): held, then counted (clientKind 'avpro')

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const KINDS = [['tick', 40], ['release', 15], ['sources', 8], ['pick', 7], ['straggler', 6], ['ccOn', 6], ['picker', 8], ['leave', 2]];
export function draw(seed, n, other = OTHER) {
  const r = rng(seed);
  const kinds = KINDS.filter(([k]) => other || k !== 'straggler');
  const total = kinds.reduce((s, [, w]) => s + w, 0);
  return Array.from({ length: n }, () => {
    let x = r() * total, k = kinds[0][0];
    for (const [name, w] of kinds) { if (x < w) { k = name; break; } x -= w; }
    return { k, a: r(), b: r() };
  });
}

// The world's loads (cs:~370, the LoadList / LoadTracks / LoadTrack / LoadNative constants).
const LIST = 'LoadList', TRACKS = 'LoadTracks', TRACK = 'LoadTrack', NATIVE = 'LoadNative';
const MAX_WAITS = 6; // cs:390
// #996's options, as changes to the copy (the C# is not changed here):
//   today  the world as it is at eddf7f5a
//   opt1   when the video starts, a "No captions" that came from another ticket's answer is forgotten and asked once more
//   opt1x  opt1, and the same for one that came from a 404 nothing_playing (the second path; not in #996's text)
//   opt2   an answer for another ticket or a 404 never ends in "No captions": asked again while the player loads, then
//          "Captions can't load right now" (ccUnavailable), which a picker open asks again
//   opt2x  opt2, and a list answer for this ticket that is not ready (temporarily_unavailable) does the same instead of
//          "No captions" (#996's item 4, the CC-on path; the LoadTracks branch at cs:3653 already does this)
export const VARIANTS = ['today', 'opt1', 'opt1x', 'opt2', 'opt2x'];

class World {
  constructor(ask, variant) { Object.assign(this, { ask, variant, ticket: -1, loading: false, playing: false, left: false, pickerOpened: false, nones: [] }); this.forget(); }
  // ForgetTracks (cs:3329-3335): a new video: everything about the old one's captions goes, and captions are off again.
  forget() {
    Object.assign(this, { ccTicket: -1, ccListLoaded: false, ccLinesLoaded: false, ccNone: false, trackCount: 0, userTrack: -1, ccLoad: 0, ccWaits: 0,
      want: false, ccOn: false, ccTracksTried: false, ccDefaultTried: false, ccUnavailable: false, ccTries: 0, noneFrom: null });
  }
  // Ask (cs:3544-3548).
  askFor(load, track = -1) { this.ccLoad = load; this.ccLoadTrack = track; this.ccTries = 0; this.ccWaits = 0; this.want = true; if (load === LIST || load === TRACKS) this.ccUnavailable = false; }
  // NoCaptions (cs:3571-3575): "No captions for this video", and ccNone stops every later ask for this ticket (cs:3373).
  // from: what led to it; real: the answer was for this ticket and said no_captions.
  none(from, real = false) { this.ccLoad = 0; this.ccNone = true; this.ccLinesLoaded = true; this.noneFrom = from; this.nones.push({ ticket: this.ccTicket, from, real }); }
  // The room's player loads a ticket (core.Url → CoreTicket, cs:3343): loading until the play starts.
  load(ticket) { this.ticket = ticket; this.loading = true; this.playing = false; }
  // The play starts (core.IsPlaying). opt1/opt1x: forget a "none" that no answer for this ticket gave.
  started() {
    this.loading = false; this.playing = true;
    const forgettable = this.variant === 'opt1' ? ['mismatch'] : this.variant === 'opt1x' ? ['mismatch', '404'] : [];
    if (this.ccTicket === this.ticket && this.ccNone && forgettable.includes(this.noneFrom)) { this.ccNone = false; this.ccLinesLoaded = false; this.ccTracksTried = false; this.noneFrom = null; }
  }
  // SetCaptionsOn(true) (cs:3145-3150), the CC button: on even before the list is here.
  ccButtonOn() { this.ccOn = true; if (this.ccListLoaded && this.userTrack < 0 && this.trackCount > 0 && !this.ccLinesLoaded) { this.ccDefaultTried = true; this.userTrack = 0; } }
  // Captions() (cs:3338-3388), the part that decides what to ask.
  decide() {
    if (this.left || this.ticket < 0) return;
    if (this.ticket !== this.ccTicket) { this.forget(); this.ccTicket = this.ticket; this.ccTries = 0; } // cs:3362-3365
    const opened = this.pickerOpened; this.pickerOpened = false; // cs:3366-3367
    if (this.ccLoad === 0 && (this.playing || this.loading) && !this.ccNone) { // cs:3373
      if (!this.ccListLoaded) {
        if (this.ccOn) this.askFor(LIST); // cs:3377
        else if (!this.ccTracksTried || opened) { this.ccTracksTried = true; this.askFor(TRACKS); } // cs:3378
      } else if (this.ccOn && !this.ccLinesLoaded) {
        if (this.userTrack >= 0) this.askFor(TRACK, this.userTrack); // cs:3382
        else if (this.trackCount > 0 && !this.ccDefaultTried) { this.ccDefaultTried = true; this.userTrack = 0; this.askFor(TRACK, 0); } // cs:3383
        else if (this.trackCount > 0) this.askFor(NATIVE); // cs:3384
        else this.none('no tracks'); // cs:3385
      }
    }
  }
  // The string slot (cs:2079-2088): one caption ask, then its answer (ReadCaptions or CaptionsFailed).
  async tick() {
    this.decide();
    if (this.left || !this.want) return null;
    this.want = false;
    const load = this.ccLoad;
    const path = load === TRACK ? `cc/${this.ccLoadTrack}` : load === TRACKS ? 'cc?l=en' : load === NATIVE ? 'cc/native' : 'cc/en'; // urls.CaptionTrack / CaptionList / Captions
    const { status, body } = await this.ask(path);
    if (status === 200) this.read(body); else this.failed(status);
    return { load, status, t: body?.t, reason: body?.reason, during: this.loading };
  }
  // CaptionsFailed (cs:2258-2267).
  failed(code) {
    if (this.ccLoad === 0) return;
    if (this.variant.startsWith('opt2') && (code === 404 || this.ccTries >= 2)) {
      if (this.loading) { this.want = true; return; } // asked again while the player loads
      this.ccLoad = 0; this.ccUnavailable = true; this.ccTracksTried = true; return; // "can't load right now"; a picker open asks again
    }
    if (code !== 404 && this.ccTries < 2) { this.ccTries++; this.want = true; } // cs:2264
    else if (this.ccLoad === TRACKS) { this.ccLoad = 0; this.ccUnavailable = true; } // cs:2265
    else this.none(code === 404 ? '404' : 'error'); // cs:2266
  }
  // ReadCaptions (cs:3635-3700), the parts that decide whether captions are there.
  read(d) {
    const load = this.ccLoad;
    if (load === 0) return; // cs:3637
    if ((d.t ?? -1) !== this.ccTicket) { // cs:3643: "the service answers for the video last played in this shard"
      if (this.ccTries < 2) { this.ccTries++; this.want = true; } // cs:3645
      else if (this.variant.startsWith('opt2')) { if (this.loading) this.want = true; else { this.ccLoad = 0; this.ccUnavailable = true; this.ccTracksTried = true; } }
      else this.none('mismatch'); // cs:3645
      return;
    }
    this.ccLoad = 0; // cs:3648
    const real = d.reason === 'no_captions';
    if (load === LIST || load === TRACKS) {
      if (load === TRACKS && !d.available && d.reason !== 'no_captions') { this.ccUnavailable = true; return; } // cs:3653
      if (this.variant === 'opt2x' && !d.available && d.reason !== 'no_captions') { if (this.loading) this.want = true; else { this.ccUnavailable = true; this.ccTracksTried = true; } this.ccLoad = this.loading ? load : 0; return; }
      this.trackCount = Array.isArray(d.tracks) ? d.tracks.length : 0; this.ccListLoaded = true; // ReadTracks cs:3719-3723, cs:3654
      if (this.trackCount === 0) { this.none(real ? 'empty' : `empty list (${d.reason})`, real); return; } // cs:3655
      if (load === TRACKS) return; // cs:3656
      if (this.userTrack < 0 && !this.ccDefaultTried) { this.ccDefaultTried = true; if (0 !== (d.track ?? -1)) { this.userTrack = 0; return; } } // cs:3659-3663
    }
    if (!d.available || !Array.isArray(d.lines)) { // cs:3671-3679
      if ((load === TRACK || load === NATIVE) && d.reason === 'temporarily_unavailable' && this.ccWaits < MAX_WAITS) { this.ccWaits++; this.ccLoad = load; this.want = true; return; } // cs:3675-3676
      if (load === TRACK) this.userTrack = -1; // cs:3677
      if (load === NATIVE) this.none(`native (${d.reason})`, real); // cs:3678
      return;
    }
    this.ccLinesLoaded = true;
  }
}

// One sequence against a fresh real app. → { fails: { B1: message | null, B2: message | null }, trace, reach }.
export async function runOne(seed, ops, variant = WORLD) {
  const r = rng(seed ^ 0xcc);
  const reach = {};
  const bump = (k) => { reach[k] = (reach[k] ?? 0) + 1; };
  // FUZZ_TICKET_PIN=1: with TICKET_PIN on (config.js ticketPin, off by default; production's own setting is in its env), a
  // played ticket asked again is answered from its pin, at once.
  const config = { ...base, shards: 2, pool: 50, metricsPath: '', publicUrl: 'http://pub', homeRelay: false, ticketPin: Boolean(process.env.FUZZ_TICKET_PIN) };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const pending = []; // held plays: { id, release, done }
  const atOnce = new Set(); // video ids answered without a hold (a straggler)
  const playback = { jobs: new Map(), peek: () => null, status: () => ({ state: 'building' }), start() {}, wouldBuild: () => true,
    location(data) {
      const where = { location: `https://tunelio.dev/${data.id}.mp4`, via: 'tunelio', ready: true };
      if (atOnce.delete(data.id)) return Promise.resolve(where);
      return new Promise((resolve) => pending.push({ id: data.id, release: () => resolve(where) }));
    } };
  const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
  // The caption sources (src/captionchain.js). The real get() and tracks() await the lookup and answer
  // { available: false, reason: 'temporarily_unavailable', tracks: [] } only when it found no tracks (captionchain.js:60-66,
  // :96-100, :119): a lookup that failed (a refusal, the relay down). Here every lookup of a video fails that way until the
  // 'sources' op lets them succeed, so the not-ready paths are reached on purpose: their counts are not how often it
  // happens. A video with none answers reason 'no_captions' (:105). Some seeds' videos have none.
  const none = new Set(ids.filter(() => r() < 0.2));
  const fetching = new Set(), ready = new Set();
  const tracks = [{ i: 0, code: 'en', name: 'English', auto: true }];
  const notReady = (id, lang) => ({ id, lang, available: false, reason: 'temporarily_unavailable', tracks: [], track: -1 });
  const nothing = (id, lang) => ({ id, lang, available: false, reason: 'no_captions', tracks: [], track: -1 });
  const ask = (id) => { if (ready.has(id)) return true; fetching.add(id); bump('caption_not_ready'); return false; };
  const captions = {
    async tracks(id, lang) { return !ask(id) ? notReady(id, lang) : none.has(id) ? nothing(id, lang) : { id, lang, available: true, tracks, track: -1 }; },
    async get(id, lang) { return !ask(id) ? notReady(id, lang) : none.has(id) ? nothing(id, lang) : { id, lang, available: true, tracks, track: 0, lines: [[0, 1, 'hi']] }; },
    async track(id, i, lang) { return !ask(id) ? notReady(id, lang) : none.has(id) ? nothing(id, lang) : { id, lang, available: true, lines: [[0, 1, 'hi']] }; },
    warm(id) { if (!ready.has(id)) fetching.add(id); } };
  const app = createApp({ config, store, playback, captions, tunelio: { enabled: true }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const tickets = store.allocate(0, ids.map((id) => ({ kind: 'video', data: { id, title: id, seconds: 600, live: false } })));
  const name = (n) => `ticket ${n}`;
  const get = async (path) => { const res = await fetch(`${url}/v1/0/${path}`); let body = null; try { body = await res.json(); } catch {} return { status: res.status, body }; };
  const plays = []; // the players' ticket requests in flight
  let dropping = null; // the room's current player's request, which a new pick drops
  const play = (n, { droppable = false } = {}) => {
    const ac = new AbortController();
    const p = fetch(`${url}/v1/0/${n}`, { redirect: 'manual', headers: { 'user-agent': UA }, signal: ac.signal }).then((res) => res.status, () => 'dropped');
    plays.push(p);
    if (droppable) dropping = ac;
    return p;
  };
  const world = new World(get, variant);
  const trace = [];
  const picked = [];
  let lastPick = -1;
  // A request has reached the server: held (playback.location called) or answered (a pinned ticket answers at once).
  const reached = async (p, before) => {
    let answered = false;
    p.then(() => { answered = true; });
    for (let i = 0; i < 5000 && !answered && pending.length === before; i++) await new Promise((done) => setImmediate(done));
    if (pending.length > before) pending[pending.length - 1].done = p; else bump('pick_answered_at_once');
  };
  // Holds end in any order: a later pick's build can be ready before an earlier one's (x picks which).
  const release = async (x) => {
    const h = pending.splice(Math.floor(x * pending.length), 1)[0];
    h.release();
    await h.done; // the 302 (or the dropped request's end) comes after store.markPlayed (src/server.js, the ticket route)
    for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done)); // a dropped request: let markPlayed run
    const n = tickets[ids.indexOf(h.id)];
    if (n !== lastPick) bump('release_not_latest_pick');
    if (n === world.ticket && !world.playing) world.started();
    return n;
  };
  const tickLine = (a) => (a ? `the world asks ${a.load} → ${a.status}${a.t != null ? ` t=${a.t}` : ''}${a.reason ? ` (${a.reason})` : ''}` : 'the world ticks (nothing to ask)');
  const count = (a) => { if (!a) return; if (a.during && a.load === LIST) bump('list_ask_during_hold'); if (a.status === 404) bump('answer_404'); if (a.status === 200 && a.t != null && a.t !== world.ccTicket) bump('answer_other_ticket'); };
  let step = 0;
  try {
    // Before the sequence: the shard played ticket 0 earlier (lastPlayed), or nothing yet (a fresh instance: the 404 path).
    if (r() < 0.5) { store.markPlayed(0, tickets[0], ids[0]); picked.push(tickets[0]); trace.push(`before: ${name(tickets[0])} played earlier in this shard`); }
    else trace.push('before: nothing played in this shard yet');
    if (none.size) trace.push(`before: the videos of ${[...none].map((id) => name(tickets[ids.indexOf(id)])).join(', ')} have no captions`);
    const pick = async (n) => {
      dropping?.abort(); // the room's player moves on: its request for the old ticket is dropped (the hold goes on)
      picked.push(n); lastPick = n; world.load(n);
      const before = pending.length;
      await reached(play(n, { droppable: true }), before);
      if (!pending.some((h) => tickets[ids.indexOf(h.id)] === n) && !world.playing) world.started(); // answered at once: it plays
    };
    await pick(tickets[1]);
    trace.push(`${step++}: the room picks ${name(tickets[1])}; its player's request is held`);
    for (const op of ops) {
      let line = op.k;
      if (op.k === 'tick') { const a = await world.tick(); count(a); line = tickLine(a); }
      else if (op.k === 'release') { if (!pending.length) line = 'release: nothing held'; else { const n = await release(op.a); line = `the hold on ${name(n)} ends: play counted${n === world.ticket ? ', the video starts' : ' (its player had moved on)'}`; } }
      else if (op.k === 'sources') { line = fetching.size ? `the caption sources answer for ${[...fetching].map((id) => name(tickets[ids.indexOf(id)])).join(', ')}` : 'sources: nothing asked yet'; for (const id of fetching) ready.add(id); fetching.clear(); }
      else if (op.k === 'pick') { const n = tickets.filter((x) => x !== world.ticket)[Math.floor(op.a * 2)]; await pick(n); line = `the room picks ${name(n)}`; }
      else if (op.k === 'straggler') {
        const old = [...new Set(picked)].filter((x) => x !== world.ticket);
        if (!old.length) line = 'straggler: no older ticket';
        else { const n = old[Math.floor(op.a * old.length)]; atOnce.add(ids[tickets.indexOf(n)]); await play(n); bump('straggler'); line = `a straggler's player asks ${name(n)} again: answered at once, play counted`; }
      }
      else if (op.k === 'ccOn') { world.ccButtonOn(); line = 'the visitor turns CC on'; }
      else if (op.k === 'picker') { world.pickerOpened = true; line = 'the visitor opens a picker'; }
      else if (op.k === 'leave') { world.left = true; line = 'the visitor leaves'; }
      trace.push(`${step++}: ${line}`);
      if (world.left) break;
    }
    // The drain: holds end (a real one does within ticketPlayerHoldMs), the sources answer, the visitor looks, the world asks
    // until nothing is due.
    while (pending.length) { const n = await release(r()); trace.push(`drain: the hold on ${name(n)} ends`); }
    if (!world.left) {
      if (!world.playing) world.started();
      for (let round = 0; round < 3; round++) {
        if (fetching.size) { trace.push('drain: the caption sources answer'); for (const id of fetching) ready.add(id); fetching.clear(); }
        world.pickerOpened = true;
        trace.push('drain: the visitor opens a picker');
        for (let i = 0; i < 12; i++) { const a = await world.tick(); count(a); if (!a) break; trace.push(`drain: ${tickLine(a)}`); }
      }
    }
    for (const x of world.nones) bump(`none_${x.real ? 'real' : x.from.split(' ')[0]}`);
    const fails = { B1: null, B2: null };
    const wrong = world.nones.find((x) => !x.real && x.from !== 'no tracks');
    if (wrong) fails.B2 = `"No captions" for ${name(wrong.ticket)} after ${wrong.from === 'mismatch' ? 'three answers for another ticket' : wrong.from === '404' ? 'a 404 nothing_playing' : `an answer for it that did not say no_captions: ${wrong.from}`}`;
    const hasCaptions = !none.has(ids[tickets.indexOf(world.ticket)]);
    if (!world.left && hasCaptions && !(world.ccTicket === world.ticket && world.ccListLoaded && world.trackCount > 0 && (!world.ccOn || world.ccLinesLoaded))) {
      const why = world.ccNone ? `"No captions", after ${world.noneFrom === 'mismatch' ? 'answers for another ticket' : world.noneFrom}` : world.ccUnavailable ? '"can\'t load right now"' : 'list not loaded';
      fails.B1 = `the visitor stayed, and the world ends without ${name(world.ticket)}'s captions (${why})`;
    }
    return { fails, trace, reach };
  } finally {
    while (pending.length) pending.shift().release();
    await Promise.allSettled(plays);
    server.closeAllConnections(); // fetch keeps its sockets alive; close() would wait for them
    await new Promise((done) => server.close(done));
    store.close();
  }
}

// Shrinks a failing sequence by deleting ops while the same property still fails.
async function shrink(seed, ops, prop, variant) {
  let best = ops;
  for (let i = 0; i < best.length;) {
    const tryOps = [...best.slice(0, i), ...best.slice(i + 1)];
    const r = await runOne(seed, tryOps, variant);
    if (r.fails[prop]) best = tryOps; else i++;
  }
  return best;
}
export async function sweep(variant) {
  const out = { B1: [], B2: [] }, reach = {};
  for (let seed = SEED; seed < SEED + SEEDS; seed++) {
    const r = await runOne(seed, draw(seed, STEPS), variant);
    for (const prop of ['B1', 'B2']) if (r.fails[prop]) out[prop].push(seed);
    for (const [k, n] of Object.entries(r.reach)) reach[k] = (reach[k] ?? 0) + n;
  }
  return { out, reach };
}
// The shortest failing ordering among the first failing seeds, optionally only those whose message matches.
export async function shortest(variant, prop, seeds, match = null) {
  let best = null;
  for (const seed of seeds.slice(0, 30)) {
    const ops = await shrink(seed, draw(seed, STEPS), prop, variant);
    const r = await runOne(seed, ops, variant);
    if (r.fails[prop] && (!match || match.test(r.fails[prop])) && (!best || r.trace.length < best.trace.length)) best = { seed, prop, ops: ops.length, ...r };
  }
  return best;
}
const show = (b) => `seed ${b.seed}: ${b.fails[b.prop]}\n  ${b.trace.join('\n  ')}\n  rerun: FUZZ_STRICT=1 FUZZ_WORLD=${WORLD} FUZZ_SEED=${b.seed} node --test test/captions-hold.props.test.js`;

// Today's world copy and today's service: seeds that fail each promise, by path (2026-11-23, world eddf7f5a, service
// 9259b0b; with the default STEPS). When #996's fix lands, this test goes red: see the top of this file for what the
// fixer does.
const FAILS_TODAY = [
  { seed: 1010, prop: 'B2', path: /three answers for another ticket/ }, // #996's own path
  { seed: 997, prop: 'B2', path: /temporarily_unavailable/ }, // #996's item 4: CC on, a list whose lookup found no tracks yet
  { seed: 1042, prop: 'B2', path: /404 nothing_playing/ }, // CC on in a fresh shard during the hold
  { seed: 1000, prop: 'B1', path: /another ticket/ },
];

test.todo('captions hold B1 (#996): the world ends holding the playing ticket\'s captions when the video has them (fails today; FUZZ_STRICT=1)');
test.todo('captions hold B2 (#996): "No captions" only after an answer for that ticket that says no_captions (fails today; FUZZ_STRICT=1)');

if (process.env.FUZZ_STRICT) {
  test(`captions hold (#996), world copy ${WORLD}${OTHER ? '' : ', no stragglers'}: ${SEEDS} seeds keep B1 and B2`, async (t) => {
    const { out, reach } = await sweep(WORLD);
    t.diagnostic(`reach: ${JSON.stringify(Object.fromEntries(Object.entries(reach).sort()))}`);
    for (const prop of ['B1', 'B2']) if (out[prop].length) t.diagnostic(`${prop} fails on ${out[prop].length} seeds; shortest:\n${show(await shortest(WORLD, prop, out[prop]))}`);
    assert.deepEqual(out, { B1: [], B2: [] });
  });
} else {
  test('captions hold (#996): today\'s world copy against today\'s service still FAILS both promises on the recorded seeds', async (t) => {
    for (const { seed, prop, path } of FAILS_TODAY) {
      const r = await runOne(seed, draw(seed, 16), 'today');
      assert.ok(r.fails[prop] && path.test(r.fails[prop]), `seed ${seed} no longer fails ${prop} by ${path}: ${r.fails[prop] ?? 'passes'}`);
    }
    const { out, reach } = await sweep('today');
    t.diagnostic(`today, ${SEEDS} seeds: B1 fails on ${out.B1.length}, B2 on ${out.B2.length}; reach: ${JSON.stringify(Object.fromEntries(Object.entries(reach).sort()))}`);
    assert.ok(out.B1.length > 0 && out.B2.length > 0, 'both promises still fail somewhere today');
  });
}
