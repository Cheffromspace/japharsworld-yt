// Everything-is-OK#996, pilot B of #1007: the captions exchange around a held play, as generated orderings. The service is
// the REAL app (createApp with a real Store; only `playback` and `captions` are faked: a player's ticket request is held
// until the test lets it go, src/server.js's ticket route `await playback.location(...)`, and a caption lookup comes back
// with no tracks, temporarily_unavailable, until the test lets the sources succeed; some videos also have faults: a caption
// fetch that fails (502), a track fetch that fails with the list there). The world is a small scripted COPY of the caption-asking rule
// in the world repo's Assets/EverythingIsOK/Scripts/EverythingIsOKYouTubeSearch.cs, read at world commit eddf7f5a
// (2026-11-22); every line of the copy names the C# lines (cs:N) it mirrors. A change to those lines means re-reading the
// copy (.claude/skills/verify-home/SKILL.md, "Pilot B"): the copy can drift; the real world code is the referee, through
// the replay in the test editor (_TesterCaptionAnswer / _TesterCaptionError).
// The ops: the world's caption tick (Captions() plus the string slot sending one ask and reading its answer); the room
// picking a ticket (a new play: the old player's request is dropped, the new one held); a held play ending (its 302,
// after store.markPlayed, even for a dropped request: the service still counts it, #1029); a straggler (another visitor's
// player still on an older ticket asks it again and is answered at once); the caption sources answering; the visitor
// turning CC on, opening a picker, or leaving. Then a drain: every hold ends; first the quiet part (the sources answer, the world asks until
// nothing is due, the visitor does nothing), then the visitor opens a picker three times, the sources answering before
// each. Timing becomes order: LoadGap (5.2 s, cs:39) and the retry waits (cs:1405-1414) only space the asks, so no
// constant is assumed.
//   B1 (P1): if the visitor stayed and the video has captions, the world ends holding the playing ticket's OWN caption list
//            (and its lines, CC on), checked against this test's table of each video's track and lines.
//   B2 (P2): "No captions" (NoCaptions, cs:3571-3575) only follows an answer for that very ticket that says it has none
//            (reason no_captions).
//   B3 (P1 strict): after the playing ticket's play is counted, a visitor who opens no picker and presses no CC still ends
//            (after the quiet part of the drain) with its own captions. Judged only on seeds where the visitor did nothing
//            after the count. One exclusion, "nopicker" (#996): the end state "can't load right now" when, by this test's OWN
//            records, the asked video's sources had nothing at the last ask (or a fault the test drew threw there), which the
//            world's #166 design leaves for a picker open; within NOPICKER_BUDGET of the judged seeds whose video has captions (opt2xs only).
//   B4:      if the visitor stayed and the playing video has NO captions (by this test's table), the world ends holding no
//            list and no lines (any it holds are another video's). It holds today: a plain assertion in every run.
// B1-B3 fail on today's code (#996): the promises are test.todo, and a plain test asserts that they DO fail today on
// the recorded seeds (FAILS_TODAY), so this file goes red when the code under it changes. #996's SERVICE half is in
// (2026-11-23, service-cap1: src/server.js playerAsked, a caption ask answered about the ticket the asking client's player
// asked for last, held or counted): FAILS_TODAY now holds only seeds that fail by a world path, and the seeds it fixed
// are asserted to pass (FIXED_BY_SERVICE). The fixer of #996's WORLD half must then: drop that assertion, turn the todos
// into plain tests (FUZZ_PROMISES=1 runs them now; B3 may keep its exclusion and todo if the fix leaves the #166 design),
// and change the copy below in the same batch as the C# (and re-read it against the new C#).
// Switches (the verify-home skill has them in one table): FUZZ_PROMISES=1 runs B1-B3 with the known exclusions
// (FUZZ_KNOWN, default nopicker); FUZZ_STRICT=1 runs them with none; FUZZ_WORLD=today|opt1|opt1x|opt2|opt2x|opt2xs picks the
// copy's variant (#996's options; see VARIANTS); FUZZ_OTHER=0 leaves out stragglers; FUZZ_FAULTS=0 leaves out the faults;
// FUZZ_TICKET_PIN=1 runs with TICKET_PIN on; FUZZ_STRAGGLER_SAME=1 sends a straggler as the room's own client (see
// STRAGGLER_SAME); FUZZ_SEED / FUZZ_SEEDS / FUZZ_STEPS as in the other fuzz tests. Only the
// value 1 turns FUZZ_PROMISES, FUZZ_STRICT, FUZZ_TICKET_PIN and FUZZ_STRAGGLER_SAME on (0 or anything else is off); only 0 turns FUZZ_OTHER and
// FUZZ_FAULTS off. Service variants are patches to src/server.js kept outside the repo (the batch's report names them).
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
const FAULTS = process.env.FUZZ_FAULTS !== '0';
// Switches that turn something on read only '1' (verifier round 2, L-a: `FUZZ_TICKET_PIN=0` turned the pin ON before).
const PIN = process.env.FUZZ_TICKET_PIN === '1';
const STRICT = process.env.FUZZ_STRICT === '1';
const PROMISES = process.env.FUZZ_PROMISES === '1';
// The open findings excused where their check names them (see the todos below): FUZZ_STRICT=1 excuses none.
export const KNOWN = new Set(STRICT ? [] : (process.env.FUZZ_KNOWN ?? 'nopicker').split(',').filter(Boolean));
// The nopicker exclusion's budget, per world option: at most this share of the B3-judged seeds whose video has captions
// (the only seeds it can excuse) may be excused by it in one sweep. Set from the honest cells (2026-11-23, at the test of
// this commit; 500 seeds and the default 60; today's service, svcHeld and svcNotReady2; stragglers off and on; "today's
// service" in this file's numbers is the service BEFORE #996's service half, f216ef5, and none were re-run since):
//   opt2xs  highest honest share 18.1 % at 500 seeds, 6 of 32 (18.8 %) at the default 60, 16.1 % at 2,000 (svcHeld):
//           budget 25 %. It sees opt2xs losing its start ask with svcHeld and no stragglers (26.5 % at 500, 10 of 32 at
//           60), which no check sees: every seed it moves is excused. It MISSES that variant with stragglers on (21.3 %,
//           7 of 38) and under today's service (18.9 %); under svcNotReady2 B3 catches it.
//   today, opt1, opt1x, opt2, opt2x  highest honest share 31.3 % (svcNotReady2, stragglers off; 10 of 32 at 60): no
//           budget. With the exclusion read from the test's own records, every variant tried that moves these options'
//           excused share is caught by B3 itself (VSFirstListNotReady, VSTwoListsNotReady, droplist); none needs a budget.
export const NOPICKER_BUDGET = { opt2xs: 0.25 };
// ...applied only from this many such seeds: a run of one or a few seeds (FUZZ_SEED=n) would otherwise read one excused
// seed as over budget.
export const NOPICKER_MIN_JUDGED = 20;
// The plain test's "B1 and B2 still fail somewhere today" needs a sweep: with fewer seeds (FUZZ_SEED=n alone) it is not
// asserted (verifier round 2, L-a: `FUZZ_SEED=1010` went red on it).
const MIN_SEEDS_FAIL_SOMEWHERE = 20;
const UA = 'NSPlayer/12.00.19041.5794 WMFSDK/12.00.19041.5794'; // a PC player (AVPro): held, then counted (clientKind 'avpro')
// A straggler is ANOTHER visitor's player (#996's service half answers each client about its own player's ticket): its
// requests carry an x-forwarded-for, which the service honours from loopback (src/server.js clientIp), so it is another
// client; the room's player and the world's caption asks stay one client. FUZZ_STRAGGLER_SAME=1 sends it as the same
// client, as before 2026-11-23 (the coordinator's call: kept for comparison). Today's service and the shard-level option
// read no client, so their cells do not move with it.
const STRAGGLER_SAME = process.env.FUZZ_STRAGGLER_SAME === '1';
const straggler = STRAGGLER_SAME ? {} : { 'x-forwarded-for': '203.0.113.7' };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// leave was 2 until 2026-11-23: B3 is judged only for a visitor who stays and does nothing after the count, and with 2 (and
// no idle visitors) only 196 of 500 seeds were judged; the coordinator asked for about half or more (rule 3).
const KINDS = [['tick', 40], ['release', 15], ['sources', 8], ['pick', 7], ['straggler', 6], ['ccOn', 6], ['picker', 8], ['leave', 1]];
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
//   opt2x  opt2, and a list answer for this ticket that is not ready (temporarily_unavailable) and EMPTY (no tracks) does
//          the same instead of "No captions" (#996's item 4, the CC-on path; the LoadTracks branch at cs:3653 already does
//          this). A not-ready list that came WITH tracks (a track's cue fetch failed) is read as today (cs:3654-3667: the
//          list is kept, the next tick asks a track); until 2026-11-23 opt2x dropped that one too (verifier round 2, L-d-copy)
//   opt2xs opt2x, and when the play starts the list is asked once more if it is not here yet (the verifier's start-ask
//          variant, T-startask.patch; whether the world should do this is #996's design choice: it is here to be measured)
export const VARIANTS = ['today', 'opt1', 'opt1x', 'opt2', 'opt2x', 'opt2xs'];

class World {
  constructor(ask, variant) { Object.assign(this, { ask, variant, ticket: -1, loading: false, playing: false, left: false, pickerOpened: false, nones: [] }); this.forget(); }
  // ForgetTracks (cs:3329-3335): a new video: everything about the old one's captions goes, and captions are off again.
  forget() {
    Object.assign(this, { ccTicket: -1, ccListLoaded: false, ccLinesLoaded: false, ccNone: false, trackCount: 0, trackCodes: [], lineTexts: [], userTrack: -1, ccLoad: 0, ccWaits: 0,
      want: false, ccOn: false, ccTracksTried: false, ccDefaultTried: false, ccUnavailable: false, ccTries: 0, noneFrom: null });
  }
  // Ask (cs:3544-3548).
  askFor(load, track = -1) { this.ccLoad = load; this.ccLoadTrack = track; this.ccTries = 0; this.ccWaits = 0; this.want = true; if (load === LIST || load === TRACKS) this.ccUnavailable = false; }
  // NoCaptions (cs:3571-3575): "No captions for this video", and ccNone stops every later ask for this ticket (cs:3373).
  // from: what led to it; real: the answer was for this ticket and said no_captions.
  none(from, real = false) { this.ccLoad = 0; this.ccNone = true; this.ccLinesLoaded = true; this.lineTexts = []; this.noneFrom = from; this.nones.push({ ticket: this.ccTicket, from, real }); }
  // The room's player loads a ticket (core.Url → CoreTicket, cs:3343): loading until the play starts. The world's reset for
  // a new ticket (cs:3362-3365, ForgetTracks) runs in Captions(), which Update (cs:1942) calls on its 0.2 s tick
  // (cs:1956-1957 → cs:2015; read in code, not timed on a client), so well before the next 5.2 s string slot: it is done
  // here, at the pick, not at the next ask (verifier M3: done at the ask, a CC press between the pick and the ask was wiped).
  load(ticket) {
    this.ticket = ticket; this.loading = true; this.playing = false;
    if (ticket !== this.ccTicket) { this.forget(); this.ccTicket = ticket; this.ccTries = 0; } // cs:3362-3365
  }
  // The play starts (core.IsPlaying). opt1/opt1x: forget a "none" that no answer for this ticket gave.
  started() {
    this.loading = false; this.playing = true;
    const forgettable = this.variant === 'opt1' ? ['mismatch'] : this.variant === 'opt1x' ? ['mismatch', '404'] : [];
    if (this.ccTicket === this.ticket && this.ccNone && forgettable.includes(this.noneFrom)) { this.ccNone = false; this.ccLinesLoaded = false; this.ccTracksTried = false; this.noneFrom = null; }
    if (this.variant === 'opt2xs' && this.ccTicket === this.ticket && !this.ccListLoaded && !this.ccNone) this.ccTracksTried = false; // opt2xs: asked once more
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
    return { load, status, t: body?.t, reason: body?.reason, available: body?.available, during: this.loading, asked: this.ccTicket, codes: body?.tracks?.map((x) => x.code), lines: body?.lines?.map((x) => x[2]) };
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
      if (this.variant.startsWith('opt2x') && !d.available && d.reason !== 'no_captions' && !(Array.isArray(d.tracks) && d.tracks.length)) { if (this.loading) this.want = true; else { this.ccUnavailable = true; this.ccTracksTried = true; } this.ccLoad = this.loading ? load : 0; return; }
      // ReadTracks cs:3719-3723 (trackCode per row), cs:3654: what the world now holds, kept so B1 can check whose it is.
      this.trackCodes = Array.isArray(d.tracks) ? d.tracks.map((x) => x.code) : []; this.trackCount = this.trackCodes.length; this.ccListLoaded = true;
      if (this.trackCount === 0) { this.none(real ? 'empty' : `empty list (${d.reason})`, real); return; } // cs:3655
      if (load === TRACKS) return; // cs:3656
      if (this.userTrack < 0 && !this.ccDefaultTried) { this.ccDefaultTried = true; if (0 !== (d.track ?? -1)) { this.userTrack = 0; return; } } // cs:3659-3663
      if (this.userTrack >= 0 || !d.available) { this.listNotAvailable = (this.listNotAvailable ?? 0) + 1; return; } // cs:3667: the next tick asks a track
    }
    if (!d.available || !Array.isArray(d.lines)) { // cs:3671-3679
      if ((load === TRACK || load === NATIVE) && d.reason === 'temporarily_unavailable' && this.ccWaits < MAX_WAITS) { this.ccWaits++; this.ccLoad = load; this.want = true; return; } // cs:3675-3676
      if (load === TRACK) { this.userTrack = -1; this.trackGaveUp = (this.trackGaveUp ?? 0) + 1; } // cs:3677
      if (load === NATIVE) this.none(`native (${d.reason})`, real); // cs:3678
      return;
    }
    this.lineTexts = d.lines.map((x) => x[2]); this.ccLinesLoaded = true; // ccText cs:3702, cs:3707
  }
}

// One sequence against a fresh real app. → { fails: { B1: message | null, B2: message | null }, trace, reach }.
export async function runOne(seed, ops, variant = WORLD, { faults = FAULTS, pin = PIN, known = KNOWN, quietPhase = true } = {}) {
  const r = rng(seed ^ 0xcc);
  const reach = {};
  const bump = (k) => { reach[k] = (reach[k] ?? 0) + 1; };
  // FUZZ_TICKET_PIN=1: TICKET_PIN on (config.js ticketPin, off by default; production's own setting is in its env). A pin is
  // set after a play's 302 only when playback.peek finds that play's build ready (src/server.js, the ticket route's
  // `config.ticketPin && ...` block, and pinned()), so with the switch the fake's peek answers a ready build for every video
  // whose hold has ended. Its codec is given (h264), so the real Adaptive never reads the file (adaptive.js codec(): no
  // network). A ticket played before and picked again is then answered from its pin at once (reach pick_answered_at_once).
  // Without the switch peek answers null, as before. (Verifier M5: 4480c01 said the switch ran the pin path; it could not,
  // since peek always answered null, so no pin was ever set.)
  const config = { ...base, shards: 2, pool: 50, metricsPath: '', publicUrl: 'http://pub', homeRelay: false, ticketPin: pin };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const pending = []; // held plays: { id, release, done }
  const atOnce = new Set(); // video ids answered without a hold (a straggler)
  const built = new Set(); // video ids whose build is ready (their hold ended)
  const jobOf = (id) => ({ id, state: 'ready', format: 'progressive', codec: 'h264', url: `https://tunelio.dev/${id}.mp4`, expiresMs: Date.now() + 3600_000 });
  const playback = { jobs: new Map(), peek: (data) => (pin && built.has(data.id) ? jobOf(data.id) : null), status: () => ({ state: 'building' }), start() {}, wouldBuild: () => true,
    location(data) {
      const where = { location: `https://tunelio.dev/${data.id}.mp4`, via: 'tunelio', ready: true };
      if (atOnce.delete(data.id)) { built.add(data.id); return Promise.resolve(where); }
      return new Promise((resolve) => pending.push({ id: data.id, release: () => { built.add(data.id); resolve(where); } }));
    } };
  const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
  // The caption sources (src/captionchain.js). The real get() and tracks() await the lookup and answer
  // { available: false, reason: 'temporarily_unavailable', tracks: [] } only when it found no tracks (captionchain.js:60-66,
  // :96-100, :119): a lookup that failed (a refusal, the relay down). Here every lookup of a video fails that way until the
  // 'sources' op lets them succeed, so the not-ready paths are reached on purpose: their counts are not how often it
  // happens. A video with none answers reason 'no_captions' (:105). Some seeds' videos have none.
  const none = new Set(ids.filter(() => r() < 0.2));
  const fetching = new Set(), ready = new Set();
  // Some videos are looked up already when the sequence starts (cached from an earlier play or a tablet's warm-up), from
  // their own stream: without them the first ask during a hold always failed, so a service that answers for the held
  // ticket could not be told from one that answers "not ready" until the count (the verifier's generator gap, rule 7).
  const wr = rng(seed ^ 0x3a2b);
  for (const id of ids) if (wr() < 0.3) { ready.add(id); bump('lookup_cached_at_start'); }
  // Each video has its own track and lines (verifier M2: with the same content for every video, another video's captions
  // under the right ticket number passed B1). One track at index 0, so the copy's asks are as before; only its code and the
  // lines' text tell the videos apart, and B1 compares them with this table, the test's own record, never the answer's id.
  const CODE = { [ids[0]]: 'en', [ids[1]]: 'de', [ids[2]]: 'ja' };
  const tracksOf = (id) => [{ i: 0, code: CODE[id], name: CODE[id], auto: true }];
  const linesOf = (id) => [[0, 1, `a line of ${CODE[id]}`]];
  const notReady = (id, lang) => ({ id, lang, available: false, reason: 'temporarily_unavailable', tracks: [], track: -1 });
  const nothing = (id, lang) => ({ id, lang, available: false, reason: 'no_captions', tracks: [], track: -1 });
  // Faults (verifier M4; FUZZ_FAULTS=0 leaves them out), drawn from their own stream so the draws above stay as they were.
  // Per video: `throws` caption fetches that fail, spent only while the list is not looked up yet. The fake throws, so the
  // route answers 502 captions_failed (server.js:1835-1839). That stands for ANY failed caption fetch, which the world counts
  // the same (cs:2264-2266): a service restart, a proxy 502/503, the network. It is not how a real lookup fails: the chain's
  // resolve() catches every source error and returns null (captionchain.js:192-213), so a failed lookup answers "not ready"
  // (verifier round 2, L-c). And `cueFails` track fetches that fail while the list is there
  // (captionchain.js answer(): no cues → { ...base, available: false, reason: 'temporarily_unavailable' } with the tracks
  // and the track index, :128-132), as when a track's source refuses. Without them two world paths to "No captions" are
  // never reached: LoadNative after its waits (cs:3675-3678) and a list ask that fails three times (cs:2264-2266).
  const fr = rng(seed ^ 0xfa17);
  const throws = {}, cueFails = {};
  for (const id of ids) { throws[id] = faults && fr() < 0.25 ? 1 + Math.floor(fr() * 5) : 0; cueFails[id] = faults && fr() < 0.3 ? 1 + Math.floor(fr() * 20) : 0; }
  let thrown = 0; // the test's own record of the faults it threw (N1 reads it per ask, never the service's 502)
  const ask = (id) => {
    if (ready.has(id)) return true;
    fetching.add(id);
    if (throws[id] > 0) { throws[id]--; thrown++; bump('lookup_error'); throw new Error('caption fetch failed (test fault)'); }
    bump('caption_not_ready'); return false;
  };
  const cues = (id, lang, i) => { if (cueFails[id] > 0) { cueFails[id]--; bump('cue_fault'); return { id, lang, available: false, reason: 'temporarily_unavailable', tracks: tracksOf(id), track: i }; } return null; };
  const captions = {
    async tracks(id, lang) { return !ask(id) ? notReady(id, lang) : none.has(id) ? nothing(id, lang) : { id, lang, available: true, tracks: tracksOf(id), track: -1 }; },
    async get(id, lang) { return !ask(id) ? notReady(id, lang) : none.has(id) ? nothing(id, lang) : cues(id, lang, 0) ?? { id, lang, available: true, tracks: tracksOf(id), track: 0, lines: linesOf(id) }; },
    async track(id, i, lang) { return !ask(id) ? notReady(id, lang) : none.has(id) ? nothing(id, lang) : cues(id, lang, i) ?? { id, lang, available: true, tracks: tracksOf(id), track: i, lines: linesOf(id) }; },
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
  const play = (n, { droppable = false, headers = {} } = {}) => {
    const ac = new AbortController();
    const p = fetch(`${url}/v1/0/${n}`, { redirect: 'manual', headers: { 'user-agent': UA, ...headers }, signal: ac.signal }).then((res) => res.status, () => 'dropped');
    plays.push(p);
    if (droppable) dropping = ac;
    return p;
  };
  const world = new World(get, variant);
  const trace = [];
  const picked = [];
  let lastPick = -1;
  // A request has reached the server: held (playback.location called) or answered (a pinned ticket answers at once).
  // For B3, from the test's own records: when the playing ticket's play was counted (the step), whether the visitor opened a
  // picker or pressed CC after that, and every caption ask with its answer.
  let countedAt = null, helped = false;
  // An idle visitor (half the seeds, from its own stream): once the playing ticket's play is counted they open no picker and
  // press no CC (those ops are skipped), so B3 is judged on more seeds. Before the count they act as drawn.
  const idle = rng(seed ^ 0x1d1e)() < 0.5;
  const asks = [];
  const start = () => { if (countedAt == null) countedAt = step; world.started(); };
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
    if (n === world.ticket && !world.playing) start();
    return n;
  };
  const tickLine = (a) => (a ? `the world asks ${a.load} → ${a.status}${a.t != null ? ` t=${a.t}` : ''}${a.codes?.length ? ` list [${a.codes}]` : ''}${a.lines?.length ? ' + lines' : ''}${a.reason ? ` (${a.reason})` : ''}` : 'the world ticks (nothing to ask)');
  const videoOf = (n) => ids[tickets.indexOf(n)];
  // Content (track codes, line text) that is not the video of the ticket it is labelled with, by the test's own table.
  const foreign = (a) => a.status === 200 && a.t != null && ((a.codes?.length && a.codes.join() !== tracksOf(videoOf(a.t)).map((x) => x.code).join()) || (a.lines?.length && a.lines.join() !== linesOf(videoOf(a.t)).map((x) => x[2]).join()));
  // One world tick and its answer, counted. srcDown is N1's record, from this test's own state at that ask, never from the
  // answer: the asked ticket's video was not in `ready` (its sources had nothing), or a fault this test drew threw during
  // the ask. `ready` changes only at a 'sources' op or the drain's sources step, never inside a tick, so reading it after
  // the answer is reading it at the ask.
  const tick = async () => { const before = thrown; const a = await world.tick(); count(a, thrown > before); return a; };
  const count = (a, threw = false) => {
    if (!a) return;
    if (a.during && a.load === LIST) bump('list_ask_during_hold');
    if (a.status === 404) bump('answer_404');
    if (a.status === 502) bump('answer_502');
    if (a.status === 200 && a.t != null && a.t !== a.asked) bump('answer_other_ticket');
    // usable: an answer for the asked ticket that is not "not ready" (a list, or a real no_captions).
    // The kind of the answer (for the excused split only): not ready, a 404, a 502, another ticket's, or a list/no_captions.
    const kind = a.status === 404 ? '404' : a.status === 502 ? '502' : a.status !== 200 ? 'other' : a.t !== a.asked ? 'other_ticket' : a.available === false && a.reason !== 'no_captions' ? 'not_ready' : 'usable';
    asks.push({ asked: a.asked, load: a.load, status: a.status, kind, usable: kind === 'usable', afterCount: countedAt != null, srcDown: !ready.has(videoOf(a.asked)) || threw });
    if (foreign(a)) bump(a.t === a.asked ? 'served_other_video_as_asked_ticket' : 'served_other_video');
  };
  let step = 0;
  try {
    // Before the sequence: the shard played ticket 0 earlier (lastPlayed), or nothing yet (a fresh instance: the 404 path).
    if (r() < 0.5) { store.markPlayed(0, tickets[0], ids[0]); picked.push(tickets[0]); trace.push(`before: ${name(tickets[0])} played earlier in this shard`); }
    else trace.push('before: nothing played in this shard yet');
    if (ready.size) trace.push(`before: the captions of ${[...ready].map((id) => name(tickets[ids.indexOf(id)])).join(', ')} are looked up already`);
    if (none.size) trace.push(`before: the videos of ${[...none].map((id) => name(tickets[ids.indexOf(id)])).join(', ')} have no captions`);
    for (const id of ids) if (throws[id] || cueFails[id]) trace.push(`before: faults for ${name(tickets[ids.indexOf(id)])}'s video:${throws[id] ? ` its caption fetch fails ${throws[id]} times (502)` : ''}${cueFails[id] ? ` its track fetch fails ${cueFails[id]} times with the list there` : ''}`);
    const pick = async (n) => {
      dropping?.abort(); // the room's player moves on: its request for the old ticket is dropped (the hold goes on)
      picked.push(n); lastPick = n; world.load(n); countedAt = null; helped = false;
      const before = pending.length;
      await reached(play(n, { droppable: true }), before);
      if (!pending.some((h) => tickets[ids.indexOf(h.id)] === n) && !world.playing) start(); // answered at once: it plays
    };
    await pick(tickets[1]);
    trace.push(`${step++}: the room picks ${name(tickets[1])}; its player's request is held`);
    for (const op of ops) {
      let line = op.k;
      if (op.k === 'tick') { const a = await tick(); line = tickLine(a); }
      else if (op.k === 'release') { if (!pending.length) line = 'release: nothing held'; else { const n = await release(op.a); line = `the hold on ${name(n)} ends: play counted${n === world.ticket ? ', the video starts' : ' (its player had moved on)'}`; } }
      else if (op.k === 'sources') { line = fetching.size ? `the caption sources answer for ${[...fetching].map((id) => name(tickets[ids.indexOf(id)])).join(', ')}` : 'sources: nothing asked yet'; for (const id of fetching) ready.add(id); fetching.clear(); }
      else if (op.k === 'pick') { const n = tickets.filter((x) => x !== world.ticket)[Math.floor(op.a * 2)]; await pick(n); line = `the room picks ${name(n)}`; }
      else if (op.k === 'straggler') {
        const old = [...new Set(picked)].filter((x) => x !== world.ticket);
        if (!old.length) line = 'straggler: no older ticket';
        else { const n = old[Math.floor(op.a * old.length)]; atOnce.add(ids[tickets.indexOf(n)]); await play(n, { headers: straggler }); atOnce.delete(ids[tickets.indexOf(n)]); bump('straggler'); line = `a straggler's player asks ${name(n)} again: answered at once, play counted`; }
      }
      else if ((op.k === 'ccOn' || op.k === 'picker') && idle && countedAt != null) line = `${op.k}: skipped (an idle visitor, the video plays)`;
      else if (op.k === 'ccOn') { if (countedAt != null) helped = true; world.ccButtonOn(); line = 'the visitor turns CC on'; }
      else if (op.k === 'picker') { if (countedAt != null) helped = true; world.pickerOpened = true; line = 'the visitor opens a picker'; }
      else if (op.k === 'leave') { world.left = true; line = 'the visitor leaves'; }
      trace.push(`${step++}: ${line}`);
      if (world.left) break;
    }
    // The drain: holds end (a real one does within ticketPlayerHoldMs). First the quiet part: the sources answer and the
    // world asks until nothing is due, the visitor doing nothing (B3 is judged here). Then the visitor looks: a picker
    // opens, three times, with the sources answering before each (B1 and B2 are judged at the end).
    while (pending.length) { const n = await release(r()); trace.push(`drain: the hold on ${name(n)} ends`); }
    const vid = videoOf(world.ticket);
    const hasCaptions = !none.has(vid);
    // Whether the world holds the playing ticket's own captions, from the test's records (the video's track code and line
    // text in this test's table): null if it does, else why not.
    const without = () => {
      const ownList = world.trackCodes.join() === tracksOf(vid).map((x) => x.code).join();
      const ownLines = world.lineTexts.join() === linesOf(vid).map((x) => x[2]).join();
      if (world.ccTicket === world.ticket && world.ccListLoaded && ownList && (!world.ccOn || (world.ccLinesLoaded && ownLines))) return null;
      return world.ccNone ? `"No captions", after ${world.noneFrom === 'mismatch' ? 'answers for another ticket' : world.noneFrom}`
        : world.ccListLoaded && !ownList ? `it holds another video's list (${world.trackCodes.join()})`
        : world.ccOn && world.ccLinesLoaded && !ownLines ? `it holds another video's lines (${world.lineTexts.join()})`
        : world.ccUnavailable ? '"can\'t load right now"' : world.ccListLoaded ? 'lines not loaded' : 'list not loaded';
    };
    const b3 = { judged: false, helped, fail: null, excused: null };
    if (!world.left) {
      if (!world.playing) start();
      if (quietPhase) {
        for (let round = 0; round < 3; round++) {
          if (fetching.size) { trace.push('drain: the caption sources answer'); for (const id of fetching) ready.add(id); fetching.clear(); }
          for (let i = 0; i < 12; i++) { const a = await tick(); if (!a) break; trace.push(`drain: ${tickLine(a)}`); }
        }
        trace.push('drain: the world has nothing more to ask by itself');
        b3.helped = helped;
        b3.judged = !helped;
        const why = hasCaptions ? without() : null;
        if (why) {
          b3.fail = `the play of ${name(world.ticket)} was counted, the visitor did ${helped ? 'something' : 'nothing'} after it, and the world ends without its captions (${why})`;
          // The nopicker exclusion (#996, B3's todo): only the end state the world's #166 design leaves for a picker open,
          // "can't load right now" (no list, no "No captions"), after a last ask for this ticket (nothing asked after it)
          // that by THIS TEST's records could not have been answered with the list: the asked video's sources had nothing
          // (not in `ready`), or a fault the test drew threw during it (srcDown). What the service answered does not decide
          // it (verifier round 2, N1; rules 2 and 4): a "not ready", a 404 or another ticket's answer given while the
          // sources held the list is NOT excused. (The answer must also not be a usable one; that only narrows.) The answer's
          // kind is kept for the split. (a): that ask came before the play was counted (during the hold); (b): after it.
          const last = asks.at(-1);
          const shape = world.ccTicket === world.ticket && !world.ccListLoaded && !world.ccNone && world.ccUnavailable && Boolean(last) && last.asked === world.ticket;
          b3.last = last ? { ...last } : null; b3.shape = shape; // returned for the sweeps' split of B3 failures (records only; they decide nothing)
          if (shape && !last.usable && last.srcDown) {
            b3.excused = last.afterCount ? 'b' : 'a'; b3.excusedKind = last.kind;
          }
        }
      }
      for (let round = 0; round < 3; round++) {
        if (fetching.size) { trace.push('drain: the caption sources answer'); for (const id of fetching) ready.add(id); fetching.clear(); }
        world.pickerOpened = true;
        trace.push('drain: the visitor opens a picker');
        for (let i = 0; i < 12; i++) { const a = await tick(); if (!a) break; trace.push(`drain: ${tickLine(a)}`); }
      }
    }
    for (const x of world.nones) bump(`none_${x.real ? 'real' : x.from.split(' ')[0]}`);
    if (world.listNotAvailable) reach.list_not_available = world.listNotAvailable; // cs:3667
    if (world.trackGaveUp) reach.track_gave_up = world.trackGaveUp; // cs:3677
    const fails = { B1: null, B2: null, B3: null, B4: null };
    const wrong = world.nones.find((x) => !x.real && x.from !== 'no tracks');
    const after = { mismatch: 'three answers for another ticket', '404': 'a 404 nothing_playing', error: 'three failed asks (502 captions_failed)' };
    if (wrong) fails.B2 = `"No captions" for ${name(wrong.ticket)} after ${after[wrong.from] ?? (wrong.from.startsWith('native') ? `a track that kept failing, LoadNative after its waits: ${wrong.from}` : `an answer for it that did not say no_captions: ${wrong.from}`)}`;
    // B1, from the test's records: the list (and, CC on, the lines) the world holds are the playing ticket's video's.
    const why = !world.left && hasCaptions ? without() : null;
    if (why) fails.B1 = `the visitor stayed, and the world ends without ${name(world.ticket)}'s captions (${why})`;
    // B3 (P1 strict): judged only when the visitor did nothing after the count; excused only by the named exclusion.
    if (b3.judged && b3.fail && !(b3.excused && known.has('nopicker'))) fails.B3 = b3.fail;
    // B4, from the test's table (verifier round 2, L-d): the playing video has no captions, so any list or lines the world
    // ends holding are another video's (a ForgetTracks that kept the old list across a pick, say). Judged whenever the
    // visitor stayed and the video has none; no exclusion.
    const b4Judged = !world.left && !hasCaptions;
    if (b4Judged && (world.trackCodes.length || world.lineTexts.length)) fails.B4 = `the visitor stayed, ${name(world.ticket)}'s video has no captions, and the world ends holding another video's ${world.trackCodes.length ? `list (${world.trackCodes.join()})` : `lines (${world.lineTexts.join()})`}`;
    const tally = { b3_judged: b3.judged, b3_judged_captions: b3.judged && hasCaptions, b3_helped: b3.helped && !world.left, b3_fail_strict: b3.judged && Boolean(b3.fail), b3_fail_all_seeds: Boolean(b3.fail),
      b3_excused_a: b3.judged && b3.excused === 'a', b3_excused_b: b3.judged && b3.excused === 'b', b3_excused_kind: b3.judged && b3.excused ? b3.excusedKind : null, b4_judged: b4Judged };
    return { fails, trace, reach, tally, b3 };
  } finally {
    while (pending.length) pending.shift().release();
    await Promise.allSettled(plays);
    server.closeAllConnections(); // fetch keeps its sockets alive; close() would wait for them
    await new Promise((done) => server.close(done));
    store.close();
  }
}

// A failure's path: its message with ticket numbers and track codes taken out (the shrink may move a failure to another
// ticket; the path is what failed and after what).
export const pathOf = (msg) => (msg ? msg.replace(/ticket \d+/g, 'ticket #').replace(/\((?:[a-z]{2},?)+\)/g, '(…)') : null);
// Shrinks a failing sequence by deleting ops while the same property still fails BY THE SAME PATH (with the same options).
// Verifier round 2, L-b: "the same check fails" let seed 1027's three 502s shrink to a 404 in 2 ops; the ordering printed
// with a failure (and handed to the world's replay) must show the failure that was found.
async function shrink(seed, ops, prop, variant, opts) {
  const want = pathOf((await runOne(seed, ops, variant, opts)).fails[prop]);
  let best = ops;
  for (let i = 0; i < best.length;) {
    const tryOps = [...best.slice(0, i), ...best.slice(i + 1)];
    const r = await runOne(seed, tryOps, variant, opts);
    if (want && pathOf(r.fails[prop]) === want) best = tryOps; else i++;
  }
  return best;
}
const PROPS = ['B1', 'B2', 'B3', 'B4'];
export async function sweep(variant, opts = {}) {
  const known = opts.known ?? KNOWN;
  const out = { B1: [], B2: [], B3: [], B4: [] }, reach = {}, b3 = { judged: 0, judgedCaptions: 0, a: 0, b: 0, kinds: {} };
  let b4Judged = 0;
  for (let seed = SEED; seed < SEED + SEEDS; seed++) {
    const r = await runOne(seed, draw(seed, STEPS), variant, opts);
    for (const prop of PROPS) if (r.fails[prop]) out[prop].push(seed);
    for (const [k, n] of Object.entries(r.reach)) reach[k] = (reach[k] ?? 0) + n;
    if (r.tally.b3_judged) b3.judged++;
    if (r.tally.b3_judged_captions) b3.judgedCaptions++;
    if (r.tally.b4_judged) b4Judged++;
    if (known.has('nopicker') && r.tally.b3_excused_a) b3.a++;
    if (known.has('nopicker') && r.tally.b3_excused_b) b3.b++;
    if (known.has('nopicker') && r.tally.b3_excused_kind) b3.kinds[r.tally.b3_excused_kind] = (b3.kinds[r.tally.b3_excused_kind] ?? 0) + 1;
  }
  return { out, reach, b3: { ...b3, excused: b3.a + b3.b }, b4: { judged: b4Judged } };
}
// The shortest failing ordering among the first failing seeds, optionally only those whose message matches.
export async function shortest(variant, prop, seeds, match = null, opts) {
  let best = null;
  for (const seed of seeds.slice(0, 30)) {
    const ops = await shrink(seed, draw(seed, STEPS), prop, variant, opts);
    const r = await runOne(seed, ops, variant, opts);
    if (r.fails[prop] && (!match || match.test(r.fails[prop])) && (!best || r.trace.length < best.trace.length)) best = { seed, prop, ops: ops.length, ...r };
  }
  return best;
}
const SWITCHES = ['FUZZ_STRICT', 'FUZZ_PROMISES', 'FUZZ_KNOWN', 'FUZZ_WORLD', 'FUZZ_OTHER', 'FUZZ_FAULTS', 'FUZZ_TICKET_PIN', 'FUZZ_STRAGGLER_SAME', 'FUZZ_STEPS'];
const rerun = (seed) => `${SWITCHES.filter((k) => process.env[k] != null).map((k) => `${k}=${process.env[k]}`).join(' ')} FUZZ_SEED=${seed} node --import ./test/netguard.mjs --test test/captions-hold.props.test.js`.trim();
const show = (b) => `seed ${b.seed}: ${b.fails[b.prop]}\n  ${b.trace.join('\n  ')}\n  rerun: ${rerun(b.seed)}`;

// Today's world copy (eddf7f5a, = the released world v2026.11.22) against this service, with #996's service half
// (2026-11-23, service-cap1: a caption ask answered about the ticket the asking client's player asked for last): seeds that
// still fail each promise by a WORLD path (draw(seed, 16) with stragglers, faults on, TICKET_PIN off, given explicitly so no
// switch changes them; the nopicker exclusion on unless an entry says known: []). When #996's world half lands, the copy
// changes with the C# and this test goes red: see the top of this file for what the fixer does. "shrunk": the
// path-keeping shrink (verifier round 2, L-b), as printed with a failure.
const FAILS_TODAY = [
  { seed: 1069, prop: 'B2', path: /empty list \(temporarily_unavailable\)/ }, // #996's item 4: CC on, the held video's lookup failed: a not-ready empty list, NoCaptions at cs:3656 (shrunk: 3 ops)
  { seed: 1170, prop: 'B2', path: /LoadNative after its waits/ }, // a track that keeps failing with the list there (cs:3675-3678; shrunk: 2 ops)
  { seed: 1120, prop: 'B2', path: /three failed asks/ }, // a list ask whose caption fetch fails three times, 502 (cs:2264-2266); replaces 1027, which the service half moved off this path
  { seed: 999, prop: 'B3', path: /can't load right now/, known: [] }, // finding nopicker: a not-ready answer for the held ticket during the hold, nothing asked after the count (cs:3653, cs:3378; #166). Before the service half it was a 404 nothing_playing (shrunk: 1 op)
];
// Seeds that failed by a SERVICE path on the service before #996's service half (staging a4b15cd, the same settings) and
// must pass now (each is shown failing against a4b15cd's src/ in the batch's report, service-cap1 runs/failstoday-*.txt):
// the room's player held, the route answered about the last counted play (another ticket) or with a 404. 1016 needs the
// straggler to be another client (the default; FUZZ_STRAGGLER_SAME=1 moves this client's own record and fails it).
const FIXED_BY_SERVICE = [
  { seed: 1010, prop: 'B2' }, // was: "No captions" after three answers for another ticket (#996's own path)
  { seed: 1042, prop: 'B2' }, // was: "No captions" after a 404 nothing_playing (CC on in a fresh shard during the hold)
  { seed: 1016, prop: 'B1' }, // was: B1 by another ticket's answers after a straggler's play was counted
];

test.todo('captions hold B1 (#996): the world ends holding the playing ticket\'s own captions when the video has them (fails today; FUZZ_PROMISES=1)');
test.todo('captions hold B2 (#996): "No captions" only after an answer for that ticket that says no_captions (fails today; FUZZ_PROMISES=1)');
test.todo('captions hold B3 (#996, P1 strict): after the play is counted, a visitor who opens no picker and presses no CC still ends with the playing ticket\'s own captions (fails today and under every option tried; FUZZ_PROMISES=1)');
test.todo('captions hold finding "nopicker" (#996; strict seed 999): after an ask the sources could not answer yet, the world asks again only on a picker open (cs:3653, cs:3378; #166), so a visitor who does nothing ends on "can\'t load right now"; B3 excuses exactly that end state, and only when the test\'s own records say the sources had nothing at the last ask, within NOPICKER_BUDGET (opt2xs) of the judged seeds with captions');

// The nopicker budget's check for a world option: null when it has none, within it, or under NOPICKER_MIN_JUDGED; else
// the problem.
const overBudget = (b3, variant) => {
  const share = NOPICKER_BUDGET[variant];
  return share != null && b3.judgedCaptions >= NOPICKER_MIN_JUDGED && b3.excused > share * b3.judgedCaptions
    ? `the nopicker exclusion excused ${b3.excused} of ${b3.judgedCaptions} judged seeds with captions, over its budget of ${share * 100} % for ${variant}: the world leaves "can't load right now" for a picker open far more often than the honest cells did` : null;
};
const budgetText = (b3, variant) => (NOPICKER_BUDGET[variant] == null ? `no budget for ${variant}`
  : b3.judgedCaptions >= NOPICKER_MIN_JUDGED ? `budget ${Math.floor(NOPICKER_BUDGET[variant] * b3.judgedCaptions)} (${NOPICKER_BUDGET[variant] * 100} % for ${variant})`
    : `budget not applied under ${NOPICKER_MIN_JUDGED} judged seeds with captions`);
const b3Line = (b3, variant) => `B3 judged on ${b3.judged} of ${SEEDS} seeds (${b3.judgedCaptions} with captions); nopicker excused ${b3.excused} (a, during the hold: ${b3.a}; b, after the count: ${b3.b}; by the last answer: ${JSON.stringify(b3.kinds)}); ${budgetText(b3, variant)}`;

if (STRICT || PROMISES) {
  test(`captions hold (#996), world copy ${WORLD}${OTHER ? '' : ', no stragglers'}${FAULTS ? '' : ', no faults'}${PIN ? ', TICKET_PIN on' : ''}: ${SEEDS} seeds keep B1, B2, B3 and B4 (${KNOWN.size ? `excused: ${[...KNOWN].join(', ')}` : 'no exclusion'})`, async (t) => {
    const { out, reach, b3, b4 } = await sweep(WORLD);
    t.diagnostic(`reach: ${JSON.stringify(Object.fromEntries(Object.entries(reach).sort()))}`);
    t.diagnostic(b3Line(b3, WORLD));
    t.diagnostic(`B4 judged on ${b4.judged} of ${SEEDS} seeds (the visitor stayed, the video has no captions)`);
    const problems = [];
    const budget = KNOWN.has('nopicker') ? overBudget(b3, WORLD) : null;
    if (budget) problems.push(budget);
    for (const prop of PROPS) if (out[prop].length) {
      problems.push(`${prop} fails on ${out[prop].length} seeds: ${out[prop].slice(0, 12).join(', ')}`);
      t.diagnostic(`${prop} fails on ${out[prop].length} seeds; shortest:\n${show(await shortest(WORLD, prop, out[prop]))}`);
    }
    assert.ok(!problems.length, problems.join('\n'));
  });
} else {
  test('captions hold (#996): today\'s world copy against this service still FAILS B1-B3 on the recorded world-path seeds, passes the seeds the service half fixed, and keeps B4', async (t) => {
    for (const { seed, prop, path, known = ['nopicker'] } of FAILS_TODAY) {
      const r = await runOne(seed, draw(seed, 16, true), 'today', { faults: true, pin: false, known: new Set(known) });
      assert.ok(r.fails[prop] && path.test(r.fails[prop]), `seed ${seed} no longer fails ${prop} by ${path}: ${r.fails[prop] ?? 'passes'}. If #996's world half (or a change to the captions route or the ticket route) landed, see the top of this file and the verify-home skill, "Pilot B"`);
    }
    for (const { seed, prop } of FIXED_BY_SERVICE) {
      const r = await runOne(seed, draw(seed, 16, true), 'today', { faults: true, pin: false, known: new Set(['nopicker']) });
      assert.equal(r.fails[prop], null, `seed ${seed} fails ${prop} again, which #996's service half fixed (src/server.js playerAsked): ${r.fails[prop]}`);
    }
    const { out, reach, b3, b4 } = await sweep('today');
    t.diagnostic(`today, ${SEEDS} seeds: B1 fails on ${out.B1.length}, B2 on ${out.B2.length}, B3 on ${out.B3.length}, B4 on ${out.B4.length} (B4 judged ${b4.judged}); ${b3Line(b3, 'today')}; reach: ${JSON.stringify(Object.fromEntries(Object.entries(reach).sort()))}`);
    // B4 holds today: asserted in every run.
    if (out.B4.length) assert.fail(`B4 fails on ${out.B4.length} seeds: ${out.B4.slice(0, 12).join(', ')}\n${show(await shortest('today', 'B4', out.B4))}`);
    if (SEEDS >= MIN_SEEDS_FAIL_SOMEWHERE) assert.ok(out.B1.length > 0 && out.B2.length > 0, 'B1 and B2 still fail somewhere today');
    else t.diagnostic(`"B1 and B2 still fail somewhere today" is not asserted under ${MIN_SEEDS_FAIL_SOMEWHERE} seeds`);
  });
}
