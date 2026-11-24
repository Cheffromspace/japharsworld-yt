// Everything-is-OK#996, pilot B of #1007: the captions exchange around a held play, as generated orderings. The service is
// the REAL app (createApp with a real Store; only `playback` and `captions` are faked: a player's ticket request is held
// until the test lets it go, src/server.js's ticket route `await playback.location(...)`, and a caption lookup comes back
// with no tracks, temporarily_unavailable, until the test lets the sources succeed; some videos also have faults: a caption
// fetch that fails (502), a track fetch that fails with the list there). The world is a small scripted COPY of the caption-asking rule
// in the world repo's Assets/EverythingIsOK/Scripts/EverythingIsOKYouTubeSearch.cs, in two variants (WORLDS):
//   new       #996's world half and #1046 as built (world commit 071b75af, 2026-11-23; line numbers `cs:N` are that commit's)
//   released  v2026.11.22 (the tag, world commit c500c89a, whose C# equals eddf7f5a's; its lines are written `tag cs:N`)
// Everything the copy takes from the world is in one place: the World class and RULES below; every line names the C# lines
// it mirrors. A change to those lines means re-reading the copy (.claude/skills/verify-home/SKILL.md, "Pilot B"): the copy
// can drift; the real world code is the referee. The REPLAYS below are the world's own ClientSim scenarios (Tests/clientsim/
// captions-*-996.json, captions-new-pick-cc-on-1046.json at 071b75af) fed to the copy with the same answers: the copy must
// reach the same states; for the released world, the state the world's run on the old code failed at (world-cap1's before/).
// The ops: the room picking a ticket (a new play: the old player's request is dropped, the new one held); a held play ending
// (its 302, after store.markPlayed, even for a dropped request: the service still counts it, #1029); a straggler (another
// visitor's player still on an older ticket asks it again and is answered at once); the caption sources answering; the
// visitor turning CC on, opening a picker, or leaving; and the world's string slot (a 'tick': one caption ask sent and its
// answer read). Captions() runs on Update's 0.2 s tick (cs:2030), so the copy runs it (World.update) after every op: what to
// ask is decided at once, and the slot only sends it. Timing becomes order: the copy's clock moves only by LoadGap (5.2 s,
// cs:39) per slot, which is all the self re-asks' 30 s gap needs. Then a drain: every hold ends; first the quiet part (the
// sources answer and the world asks until nothing is due, its self re-asks included: the quiet time passes and the sources
// answer before each), then the visitor opens a picker three times, the sources answering before each.
//   B1 (P1): if the visitor stayed and the video has captions, the world ends holding the playing ticket's OWN caption list
//            (and its lines, CC on), checked against this test's table of each video's track and lines.
//   B2 (P2): "No captions" (NoCaptions, cs:3612-3616) only follows an answer for that very ticket that says it has none
//            (reason no_captions, or the true-empty answers the world reads as none: an available empty list, an empty track).
//   B3 (P1 strict): after the playing ticket's play is counted, a visitor who opens no picker and presses no CC still ends
//            (after the quiet part of the drain) with its own captions. Judged only on seeds where the visitor did nothing
//            after the count. One exclusion, "nopicker" (#166's design, kept by #996 for CC off): the end state "can't load
//            right now" when, by this test's OWN records, the asked video's sources had nothing at the last ask. In the new
//            world that last ask must come after the count (b): its play-start re-ask asks once the video plays, so an
//            excusal whose last ask was during the hold (a) is a failure (verifier-props-b3, L-1).
//   B4:      if the visitor stayed and the playing video has NO captions (by this test's table), the world ends holding no
//            list and no lines (any it holds are another video's).
//   B5:      the world's asks for one ticket stay within the bound world-cap1 derived from the new rule (its report, "Bound
//            counts"): with CC off 6, with CC on 66, plus one episode per visitor action (3 with CC off, 21 with CC on).
// All five are plain tests on the new world (the default). The released world is run by FUZZ_WORLD=released (its B1-B3 fail
// by world paths, which #996's world half fixes) and, in the plain run, by its replays and one sweep (B4, B5, and no false
// "No captions" by another ticket's answer or a 404 against this service).
// Switches (the verify-home skill has them in one table): FUZZ_WORLD=new|released picks the copy; FUZZ_DROP=a,b leaves the
// named RULES out (to show a rule matters); FUZZ_STRICT=1 runs B3 with no exclusion (FUZZ_KNOWN, default nopicker, names
// the exclusions kept); FUZZ_OTHER=0 leaves out stragglers; FUZZ_FAULTS=0 leaves out the faults; FUZZ_TICKET_PIN=1 runs
// with TICKET_PIN on; FUZZ_STRAGGLER_SAME=1 sends a straggler as the room's own client (see STRAGGLER_SAME); FUZZ_SEED /
// FUZZ_SEEDS / FUZZ_STEPS as in the other fuzz tests. Only the value 1 turns FUZZ_STRICT, FUZZ_TICKET_PIN and
// FUZZ_STRAGGLER_SAME on (0 or anything else is off); only 0 turns FUZZ_OTHER and FUZZ_FAULTS off. Service variants are
// patches to src/server.js kept outside the repo (the batch's report names them).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';

const SEED = Number(process.env.FUZZ_SEED) || 996;
const SEEDS = Number(process.env.FUZZ_SEEDS) || (process.env.FUZZ_SEED ? 1 : 60);
const STEPS = Number(process.env.FUZZ_STEPS) || 16;
const WORLD = process.env.FUZZ_WORLD || 'new';
const OTHER = process.env.FUZZ_OTHER !== '0';
const FAULTS = process.env.FUZZ_FAULTS !== '0';
// Switches that turn something on read only '1' (verifier round 2, L-a: `FUZZ_TICKET_PIN=0` turned the pin ON before).
const PIN = process.env.FUZZ_TICKET_PIN === '1';
const STRICT = process.env.FUZZ_STRICT === '1';
// The exclusions kept (see B3 above): FUZZ_STRICT=1 excuses none.
export const KNOWN = new Set(STRICT ? [] : (process.env.FUZZ_KNOWN ?? 'nopicker').split(',').filter(Boolean));
const UA = 'NSPlayer/12.00.19041.5794 WMFSDK/12.00.19041.5794'; // a PC player (AVPro): held, then counted (clientKind 'avpro')
// A straggler is ANOTHER visitor's player (#996's service half answers each client about its own player's ticket): its
// requests carry an x-forwarded-for, which the service honours from loopback (src/server.js clientIp), so it is another
// client; the room's player and the world's caption asks stay one client. FUZZ_STRAGGLER_SAME=1 sends it as the same
// client, as before 2026-11-23 (the coordinator's call: kept for comparison).
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

// ---- The world's rule: everything the copy takes from the C#. ----
// The loads (cs:387; tag cs:~370).
export const LIST = 'LoadList', TRACKS = 'LoadTracks', TRACK = 'LoadTrack', NATIVE = 'LoadNative';
const MAX_WAITS = 6; // cs:390 (the same at the tag): not-ready answers re-asked for a track
const LOAD_GAP = 5.2; // cs:39: the string slot's gap; the copy's clock moves this much per slot (spacing; retry waits, cs:1420, are left out)
const MAX_SELF = 2, SELF_GAP = 30; // cs:414-415: MaxSelfAsks, ccSelfGap
// The rules, each a difference between the two variants, switchable by name (FUZZ_DROP=a,b) so each can be shown to matter.
// `released` holds only carriedCcMode; `new` holds all the others. Lines are 071b75af's unless marked tag.
export const RULES = {
  carriedCcMode: 'tag cs:3340, 3364: Mode() is read BEFORE ForgetTracks, so the first ask of a new pick is the list with captions when CC was on for the previous video (the released world; verifier-cap-s1\'s Low)',
  giveUpOther: 'cs:3687-3690: the 3rd answer for another ticket gives up ("can\'t load right now"); tag cs:3645 said "No captions"',
  giveUpFailed: 'cs:2279-2280: a 404, or a 3rd failed fetch, gives up for every load; tag cs:2265-2266: only the list alone, else "No captions"',
  unreadableIsFailed: 'cs:3682: an unreadable answer (a proxy error page) is a failed fetch; tag cs:3640: "No captions"',
  giveUpEmptyList: 'cs:3701: an empty list that is not a true none (no_captions, or available with no reason) gives up; tag cs:3656: "No captions"',
  giveUpNative: 'cs:3729-3733: the native track after its waits gives up unless no_captions or an empty track; tag cs:3678: "No captions"',
  nativeDropsList: 'cs:3603-3608: a native give-up drops the list back to pending (the note shows only then)',
  gate: 'cs:3402: with CC on the list is asked only while not given up, or when something asks again; tag cs:3377: on every tick',
  pickerOnCcOn: 'cs:3399: a picker open asks again with CC on too (`again`)',
  askAgainOnCcOn: 'cs:3163: CC turned on with no list asks once more (ccAskAgain; cleared by any Ask, cs:3571)',
  startReask: 'cs:3400: the play-start re-ask after a give-up',
  startOnlyPlaying: 'cs:3400 `playing`: the start re-ask waits for the play (not while loading)',
  startOnce: 'cs:3400 `ccStartDone = true`: once per ticket and language (cleared only by ForgetTracks, cs:3350)',
  startDoneOnList: 'cs:3704: a usable list spends the start re-ask',
  selfReask: 'cs:3401: with CC on while playing, self re-asks ccSelfGap after the latest give-up (ccGaveUpAt, cs:3609)',
  selfMax: 'cs:414: at most MaxSelfAsks (2) self re-asks per ticket and language',
  selfGap: 'cs:415: 30 s after the latest give-up (dropped: at once)',
  selfOnlyCcOn: 'cs:3401 `mode == 1`: never with CC off',
  doneOnLines: 'cs:3763: the lines spend the self re-asks and the start re-ask',
};
const RELEASED = ['carriedCcMode'];
const NEW = Object.keys(RULES).filter((k) => k !== 'carriedCcMode');
export const WORLDS = ['new', 'released'];
const DROP = new Set((process.env.FUZZ_DROP ?? '').split(',').filter(Boolean));
for (const k of DROP) if (!RULES[k]) throw new Error(`FUZZ_DROP: no rule ${k} (RULES)`);
export const rulesOf = (variant, drop = DROP) => new Set((variant === 'released' ? RELEASED : variant === 'new' ? NEW : assert.fail(`FUZZ_WORLD: ${variant}`)).filter((k) => !drop.has(k)));

export class World {
  // ask(path) → { status, body }: the string slot's request. reach(k): a path counter.
  // selfLimit: the self re-asks the copy allows (MaxSelfAsks); only a check of the check sets it lower (a broken copy).
  constructor(ask, variant, { drop = DROP, reach = () => {}, selfLimit = MAX_SELF } = {}) {
    Object.assign(this, { ask, variant, rules: rulesOf(variant, drop), reach, selfLimit, ticket: -1, loading: false, playing: false, left: false, pickerOpened: false, nones: [], gaveUps: 0,
      now: 0, selfGap: SELF_GAP, stint: null, boundBreak: null });
    this.forget();
  }
  has(rule) { return this.rules.has(rule); }
  // ForgetTracks (cs:3344-3352; tag cs:3329-3335): a new video: everything about the old one's captions goes, and captions are off again.
  forget() {
    Object.assign(this, { ccTicket: -1, ccListLoaded: false, ccLinesLoaded: false, ccNone: false, trackCount: 0, trackCodes: [], lineTexts: [], userTrack: -1, ccLoad: 0, ccWaits: 0,
      want: false, ccOn: false, ccTracksTried: false, ccDefaultTried: false, ccUnavailable: false, ccTries: 0, noneFrom: null,
      ccStartDone: false, ccAskAgain: false, ccSelfAsks: 0, ccGaveUpAt: -100 }); // cs:3350 (#996)
  }
  // The player (VizVid's core; the world's ClientSim scenarios stand in with testerTicket / testerPlayer, cs:3360-3362).
  setPlayer(ticket, state) { this.ticket = ticket; this.loading = state === 'loading'; this.playing = state === 'playing'; this.update(); }
  // SetCaptionsOn (cs:3160-3166; tag cs:3146-3151), the CC button.
  ccButton(on) {
    this.ccOn = on; // SetCaptionMode, cs:3228
    if (on && !this.ccListLoaded && this.has('askAgainOnCcOn')) this.ccAskAgain = true; // cs:3163
    if (on && this.ccListLoaded && this.userTrack < 0 && this.trackCount > 0 && !this.ccLinesLoaded) { this.ccDefaultTried = true; this.userTrack = 0; } // cs:3164 (PreferredRow: row 0)
    if (on && this.stint) { this.stint.actions++; this.stint.ccOn = true; }
    this.update();
  }
  // A picker opens (PickerOpen's edge, cs:3387-3388): seen by the next Captions() only.
  openPicker() { this.pickerOpened = true; if (this.stint) this.stint.actions++; this.update(); }
  // Ask (cs:3569-3574; tag cs:3544-3548).
  askFor(load, track = -1) { this.ccLoad = load; this.ccLoadTrack = track; this.ccTries = 0; this.ccWaits = 0; this.want = true; this.ccAskAgain = false; if (load === LIST || load === TRACKS) this.ccUnavailable = false; }
  // NoCaptions (cs:3612-3616): "No captions for this video", and ccNone stops every later ask for this ticket (cs:3393).
  // from: what led to it; real: the answer was for this ticket and said it has none.
  none(from, real = false) { this.ccLoad = 0; this.ccNone = true; this.ccLinesLoaded = true; this.lineTexts = []; this.noneFrom = from; this.nones.push({ ticket: this.ccTicket, from, real }); }
  // CaptionAskGaveUp (cs:3599-3610): "Captions can't load right now", asked again only as Captions() allows.
  giveUp(load, why) {
    this.ccLoad = 0; this.want = false; this.reach(`gaveup_${why}`);
    if (load === TRACK) { this.userTrack = -1; this.trackGaveUp = (this.trackGaveUp ?? 0) + 1; return; } // cs:3602: the next ask is the default track, or native
    if (load === NATIVE && this.has('nativeDropsList')) { this.ccListLoaded = false; this.ccLinesLoaded = false; this.trackCount = 0; this.trackCodes = []; this.lineTexts = []; this.userTrack = -1; this.ccDefaultTried = false; } // cs:3603-3608
    this.ccUnavailable = true; this.ccTracksTried = true; this.ccGaveUpAt = this.now; this.gaveUps++; // cs:3609
  }
  // Captions() (cs:3354-3416; tag cs:3338-3391), the part that decides what to ask; it runs every 0.2 s (cs:2030).
  update() {
    if (this.left || this.ticket < 0) return; // cs:3370-3380: no search video, nothing asked
    let mode = this.ccOn ? 1 : 0; // cs:3356 (tag cs:3340)
    if (this.ticket !== this.ccTicket) { // cs:3381-3386 (tag cs:3362-3366)
      this.forget(); this.ccTicket = this.ticket; this.ccTries = 0;
      this.stint = { ticket: this.ticket, asks: 0, actions: 0, ccOn: false };
      if (!this.has('carriedCcMode')) mode = 0; // cs:3384 (#1046): read again after ForgetTracks (captions off); the released world keeps the old mode
      else if (mode === 1) this.reach('carried_cc_first_list');
    }
    const opened = this.pickerOpened; this.pickerOpened = false; // cs:3387-3388
    if (this.ccLoad === 0 && (this.playing || this.loading) && !this.ccNone) { // cs:3393 (tag cs:3373)
      if (!this.ccListLoaded) {
        let again = (opened && (mode === 0 || this.has('pickerOnCcOn'))) || this.ccAskAgain; // cs:3399
        if (!again && this.has('startReask') && this.ccUnavailable && (this.playing || !this.has('startOnlyPlaying')) && !this.ccStartDone) { // cs:3400
          if (this.has('startOnce')) this.ccStartDone = true;
          again = true; this.reach('start_reask');
        }
        if (!again && this.has('selfReask') && this.ccUnavailable && this.playing && (mode === 1 || !this.has('selfOnlyCcOn'))
          && (this.ccSelfAsks < this.selfLimit || !this.has('selfMax')) && (this.now - this.ccGaveUpAt >= this.selfGap || !this.has('selfGap'))) { // cs:3401
          this.ccSelfAsks++; again = true; this.reach('self_reask');
        }
        if (again && this.ccAskAgain) this.reach('ask_again_cc_on');
        if (mode === 1) { if (!this.ccUnavailable || again || !this.has('gate')) this.askFor(LIST); } // cs:3402 (tag cs:3377: always)
        else if (!this.ccTracksTried || again) { this.ccTracksTried = true; this.askFor(TRACKS); } // cs:3403 (tag cs:3378)
      } else if (mode === 1 && !this.ccLinesLoaded) { // cs:3405-3411 (tag cs:3380-3386)
        if (this.userTrack >= 0) this.askFor(TRACK, this.userTrack);
        else if (this.trackCount > 0 && !this.ccDefaultTried) { this.ccDefaultTried = true; this.userTrack = 0; this.askFor(TRACK, 0); } // PreferredRow: row 0 (no saved language)
        else if (this.trackCount > 0) this.askFor(NATIVE);
        else this.none('no tracks');
      }
    }
  }
  // When the next self re-ask can come (cs:3401), or null when none can: for the drain's quiet time.
  selfDueAt() {
    return this.has('selfReask') && !this.left && this.ccLoad === 0 && !this.want && !this.ccListLoaded && !this.ccNone && this.ccUnavailable && this.playing
      && (this.ccOn || !this.has('selfOnlyCcOn')) && (this.ccSelfAsks < this.selfLimit || !this.has('selfMax')) ? this.ccGaveUpAt + (this.has('selfGap') ? this.selfGap : 0) : null;
  }
  // The string slot (cs:2094-2105; tag cs:2079-2088): one LoadGap later, the ask Captions() decided is sent and its answer
  // read (ReadCaptions or CaptionsFailed), then Captions() runs again. null when nothing was asked.
  async slot() {
    this.now += LOAD_GAP; this.update();
    if (this.left || !this.want) return null;
    this.want = false;
    const load = this.ccLoad;
    if (this.stint) {
      this.stint.asks++;
      const bound = this.stint.ccOn ? 66 + 21 * this.stint.actions : 6 + 3 * this.stint.actions;
      if (this.stint.asks > bound && !this.boundBreak) this.boundBreak = { ...this.stint, bound };
    }
    const path = load === TRACK ? `cc/${this.ccLoadTrack}` : load === TRACKS ? 'cc?l=en' : load === NATIVE ? 'cc/native' : 'cc/en'; // urls.CaptionTrack / CaptionList / Captions
    const { status, body } = await this.ask(path);
    this.answer(status, body);
    this.update();
    return { load, status, t: body?.t, reason: body?.reason, available: body?.available, during: this.loading, asked: this.ccTicket, codes: body?.tracks?.map((x) => x.code), lines: body?.lines?.map((x) => x[2]) };
  }
  answer(status, body) { if (status === 200) this.read(body); else this.failed(status); }
  // CaptionsFailed (cs:2275-2281; tag cs:2260-2267). A failed fetch's code; an unreadable answer is one too (cs:3682).
  failed(code) {
    if (this.ccLoad === 0) return;
    if (code !== 404 && this.ccTries < 2) { this.ccTries++; this.want = true; return; } // cs:2279
    if (this.has('giveUpFailed') || this.ccLoad === TRACKS) this.giveUp(this.ccLoad, code === 404 ? '404' : 'failed'); // cs:2280 (tag cs:2265: the list alone)
    else this.none(code === 404 ? '404' : 'error'); // tag cs:2266
  }
  // ReadCaptions (cs:3676-3766; tag cs:3635-3700), the parts that decide whether captions are there.
  read(d) {
    const load = this.ccLoad;
    if (load === 0) return; // cs:3679: a late answer is dropped
    if (!d || typeof d !== 'object') { if (this.has('unreadableIsFailed')) this.failed(0); else this.none('unreadable'); return; } // cs:3682 (tag cs:3640); only the replays reach it: the route always sends JSON
    if ((d.t ?? -1) !== this.ccTicket) { // cs:3687 (tag cs:3643): the answer is about another ticket
      if (this.ccTries < 2) { this.ccTries++; this.want = true; } // cs:3689
      else if (this.has('giveUpOther')) this.giveUp(load, 'other');
      else this.none('mismatch'); // tag cs:3645
      return;
    }
    this.ccLoad = 0; // cs:3692
    const reason = d.reason ?? '', available = d.available !== false; // Str(d, "reason"); Available(): no field reads true (cs:3767-3771)
    if (load === LIST || load === TRACKS) {
      if (load === TRACKS && !available && reason !== 'no_captions') { this.giveUp(load, 'list_alone'); return; } // cs:3697 (tag cs:3653: the same state)
      // ReadTracks (trackCode per row): what the world now holds, kept so B1 can check whose it is.
      this.trackCodes = Array.isArray(d.tracks) ? d.tracks.map((x) => x.code) : []; this.trackCount = this.trackCodes.length;
      const empty = reason === 'no_captions' || (available && reason === ''); // a true none (cs:3701)
      if (this.trackCount === 0 && !empty && this.has('giveUpEmptyList')) { this.giveUp(load, 'empty_list'); return; } // cs:3701
      this.ccListLoaded = true; // cs:3702
      if (this.trackCount === 0) { this.none(empty ? 'empty' : `empty list (${reason})`, empty); return; } // cs:3703 (tag cs:3656)
      if (this.has('startDoneOnList')) this.ccStartDone = true; // cs:3704
      if (load === TRACKS) return; // cs:3705
      if (this.userTrack < 0 && !this.ccDefaultTried) { this.ccDefaultTried = true; if (0 !== (d.track ?? -1)) { this.userTrack = 0; return; } } // cs:3708-3713
      if (this.userTrack >= 0 || !available) { this.listNotAvailable = (this.listNotAvailable ?? 0) + 1; return; } // cs:3715: the next tick asks a track
    }
    const hasLines = Array.isArray(d.lines) || Array.isArray(d.chunks); // cs:3718-3719
    if (!available || !hasLines) { // cs:3720
      if ((load === TRACK || load === NATIVE) && reason === 'temporarily_unavailable' && this.ccWaits < MAX_WAITS) { this.ccWaits++; this.ccLoad = load; this.want = true; return; } // cs:3724-3725
      if (load === TRACK) { this.userTrack = -1; this.trackGaveUp = (this.trackGaveUp ?? 0) + 1; } // cs:3726
      if (load === NATIVE) { // cs:3729-3733 (tag cs:3678)
        const real = reason === 'no_captions' || (reason === '' && hasLines); // an empty track
        if (real || !this.has('giveUpNative')) this.none(`native (${reason})`, real); else this.giveUp(load, 'native');
      }
      return;
    }
    this.lineTexts = d.lines.map((x) => x[2]); this.ccLinesLoaded = true; this.ccNone = false; // ccText cs:3757, cs:3762
    if (this.has('doneOnLines')) { this.ccSelfAsks = MAX_SELF; this.ccStartDone = true; } // cs:3763
  }
}
// ---- end of the world's rule ----

// One sequence against a fresh real app. → { fails: { B1..B5: message | null }, trace, reach, tally, b3 }.
export async function runOne(seed, ops, variant = WORLD, { faults = FAULTS, pin = PIN, known = KNOWN, quietPhase = true, drop = DROP, selfLimit = MAX_SELF } = {}) {
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
  // the same (cs:2279-2280): a service restart, a proxy 502/503, the network. It is not how a real lookup fails: the chain's
  // resolve() catches every source error and returns null (captionchain.js:192-213), so a failed lookup answers "not ready"
  // (verifier round 2, L-c). And `cueFails` track fetches that fail while the list is there
  // (captionchain.js answer(): no cues → { ...base, available: false, reason: 'temporarily_unavailable' } with the tracks
  // and the track index, :128-132), as when a track's source refuses. Without them two world paths are never reached:
  // LoadNative after its waits (cs:3724-3733) and a list ask that fails three times (cs:2279-2280).
  const fr = rng(seed ^ 0xfa17);
  const throws = {}, cueFails = {};
  for (const id of ids) { throws[id] = faults && fr() < 0.25 ? 1 + Math.floor(fr() * 5) : 0; cueFails[id] = faults && fr() < 0.3 ? 1 + Math.floor(fr() * 20) : 0; }
  let thrown = 0; // the faults this test threw (records only: srcDown below is the asked video's state, see L-3 there)
  let faulted = new Set(); // the videos a fault this test drew failed during the current slot (a 502 lookup, a track fetch)
  const ask = (id) => {
    if (ready.has(id)) return true;
    fetching.add(id);
    if (throws[id] > 0) { throws[id]--; thrown++; faulted.add(id); bump('lookup_error'); throw new Error('caption fetch failed (test fault)'); }
    bump('caption_not_ready'); return false;
  };
  const cues = (id, lang, i) => { if (cueFails[id] > 0) { cueFails[id]--; faulted.add(id); bump('cue_fault'); return { id, lang, available: false, reason: 'temporarily_unavailable', tracks: tracksOf(id), track: i }; } return null; };
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
  const world = new World(get, variant, { drop, reach: bump, selfLimit });
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
  // The play starts (core.IsPlaying; cs:3361): Captions() runs at once.
  const start = () => { if (countedAt == null) countedAt = step; world.loading = false; world.playing = true; world.update(); };
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
  // One string slot and its answer, counted. srcDown is N1's record, from this test's own state at that ask, never from the
  // answer: the asked ticket's video was not in `ready` (its sources had nothing). `ready` changes only at a 'sources' op or
  // the drain's sources step, never inside a slot, so reading it after the answer is reading it at the ask. (Until
  // 2026-11-23 it also read "or a fault the test drew threw during the ask"; a fault throws only for a video not in `ready`,
  // so for the asked video that half added nothing, and for another video it excused #996's own wrong-video path:
  // verifier-props-b3, L-3. `threw` stays in the records for the sweeps.)
  const tick = async () => { const before = thrown; faulted = new Set(); const a = await world.slot(); count(a, thrown > before); return a; };
  // The allowance's records (the coordinator's call on seed 1978, 2026-11-23), from what this test sent and saw, never from
  // the copy's own counters: an EPISODE is a list ask (LoadList or LoadTracks) that starts afresh: not the world's retry of
  // the same load after a failed fetch or another ticket's answer (cs:3689, cs:2279: at most two in a row). An episode after
  // the count is the world's own unless it is the stint's first ask or the first after a CC press (ccAskAgain, cs:3163).
  // listBefore: a list with tracks came before the first such episode (the start re-ask is then spent by it, cs:3704).
  let ep = { ticket: null, runFails: 0, prev: null, own: 0, listBefore: false, first: true };
  let pressT = null, ccPressedSincePick = false; // a CC press with no list shown (it asks once more) and for which ticket; CC on for the playing ticket
  const pressed = () => { ccPressedSincePick = true; if (!world.ccListLoaded) pressT = world.ticket; };
  const count = (a, threw = false) => {
    if (!a) return;
    if (a.during && a.load === LIST) bump('list_ask_during_hold');
    if (a.status === 404) bump('answer_404');
    if (a.status === 502) bump('answer_502');
    if (a.status === 200 && a.t != null && a.t !== a.asked) bump('answer_other_ticket');
    // usable: an answer for the asked ticket that is not "not ready" (a list, or a real no_captions).
    // The kind of the answer (for the excused split only): not ready, a 404, a 502, another ticket's, or a list/no_captions.
    const kind = a.status === 404 ? '404' : a.status === 502 ? '502' : a.status !== 200 ? 'other' : a.t !== a.asked ? 'other_ticket' : a.available === false && a.reason !== 'no_captions' ? 'not_ready' : 'usable';
    const srcReady = ready.has(videoOf(a.asked));
    if (ep.ticket !== a.asked) ep = { ticket: a.asked, runFails: 0, prev: null, own: 0, listBefore: false, first: true };
    const retryable = (k) => k === '502' || k === 'other' || k === 'other_ticket';
    const listAsk = a.load === LIST || a.load === TRACKS;
    const retry = ep.prev && ep.prev.load === a.load && retryable(ep.prev.kind) && ep.runFails < 3;
    let episode = null;
    if (listAsk && !retry) {
      episode = ep.first ? 'first' : pressT === a.asked ? 'pressed' : countedAt != null ? 'own' : 'before';
      if (episode === 'own') ep.own++;
      if (episode === 'pressed') pressT = null;
      ep.first = false; ep.runFails = 0;
    }
    ep.runFails = retryable(kind) ? ep.runFails + 1 : 0;
    if (listAsk && a.status === 200 && a.t === a.asked && a.codes?.length && ep.own === 0) ep.listBefore = true;
    ep.prev = { load: a.load, kind };
    // faulted: by this test's own records, a fault it drew failed the asked video at this ask (its list lookup not done,
    // a 502 it threw, or a track fetch it failed), so no service could have answered it with captions.
    const fault = !srcReady || faulted.has(videoOf(a.asked));
    asks.push({ asked: a.asked, load: a.load, status: a.status, kind, usable: kind === 'usable', afterCount: countedAt != null, srcDown: !srcReady, srcReady, threw, fault, episode });
    if (foreign(a)) bump(a.t === a.asked ? 'served_other_video_as_asked_ticket' : 'served_other_video');
  };
  const sourcesAnswer = (why) => { if (fetching.size) { trace.push(`drain: the caption sources answer${why ?? ''}`); for (const id of fetching) ready.add(id); fetching.clear(); } };
  // The world asks until nothing is due (at most `cap` slots), then, while a self re-ask can still come (cs:3401), the quiet
  // time passes (the clock moves to it) and the sources answer before it is sent. Lines are traced.
  const settle = async (cap = 60) => {
    for (let n = 0; n < cap;) {
      sourcesAnswer();
      let a;
      while (n < cap && (a = await tick())) { n++; trace.push(`drain: ${tickLine(a)}`); }
      if (n >= cap || world.want) break;
      const due = world.selfDueAt();
      if (due == null) break;
      trace.push('drain: the quiet time passes (a self re-ask is due)');
      world.now = Math.max(world.now, due); world.update();
    }
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
      picked.push(n); lastPick = n; countedAt = null; helped = false; ccPressedSincePick = false; pressT = null; // ForgetTracks clears ccAskAgain (cs:3350)
      world.setPlayer(n, 'loading'); // core.Url → CoreTicket (cs:3359), loading (Core.PlayUrl): Captions() resets for the new ticket and decides its first ask
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
      else if (op.k === 'ccOn') { if (countedAt != null) helped = true; pressed(); world.ccButton(true); line = 'the visitor turns CC on'; }
      else if (op.k === 'picker') { if (countedAt != null) helped = true; world.openPicker(); line = 'the visitor opens a picker'; }
      else if (op.k === 'leave') { world.left = true; line = 'the visitor leaves'; }
      trace.push(`${step++}: ${line}`);
      if (world.left) break;
    }
    // The drain: holds end (a real one does within ticketPlayerHoldMs). First the quiet part: the sources answer and the
    // world asks until nothing is due, its self re-asks included, the visitor doing nothing (B3 is judged here). Then the
    // visitor looks: a picker opens, three times, with the sources answering before each (B1 and B2 are judged at the end).
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
        await settle();
        trace.push('drain: the world has nothing more to ask by itself');
        b3.helped = helped;
        b3.judged = !helped;
        const why = hasCaptions ? without() : null;
        if (why) {
          b3.fail = `the play of ${name(world.ticket)} was counted, the visitor did ${helped ? 'something' : 'nothing'} after it, and the world ends without its captions (${why})`;
          // The nopicker exclusion (#166's design, which #996 keeps for CC off, and the bound of #996's self re-asks with CC
          // on: the coordinator's calls of 2026-11-23, the second on seed 1978): only the end state "can't load right now"
          // (no list, no "No captions"), and only when ALL hold, by THIS TEST's records:
          //   (i) the last ask, for this ticket (nothing asked after it), failed by a fault this test drew (`fault`: the
          //       asked video's list not looked up yet, a 502 this test threw for it, or its track fetch failing), so no
          //       service could have answered it with captions. What the service answered does not decide it (verifier
          //       round 2, N1; rules 2 and 4): a "not ready", a 404 or another ticket's answer while the sources worked is NOT
          //       excused. (The answer must also not be a usable one; that only narrows.)
          //   (ii) in the new world, its allowance after the count is SPENT: its own list episodes after the count (`ep.own`,
          //       counted from the asks this test saw) number at least the start re-ask (unless a list came before them,
          //       which spends it, cs:3704) plus, with CC on, the two self re-asks (cs:3401). A world that stops asking with
          //       allowance left stays red. Keyed to the variant, not its rule set: a copy with a rule dropped is held to it.
          //   (iii) its last ask came after the count (b), the visitor doing nothing after it (B3 is judged only then); a
          //       last ask during the hold (a) is not excused in the new world, which re-asks when the play starts (L-1).
          // The answer's kind is kept for the split; (a) is excused only in the released world, which has no allowance.
          const last = asks.at(-1);
          const shape = world.ccTicket === world.ticket && !world.ccListLoaded && !world.ccNone && world.ccUnavailable && Boolean(last) && last.asked === world.ticket;
          const owed = world.variant === 'new' ? (ep.ticket === world.ticket && ep.listBefore ? 0 : 1) + (ccPressedSincePick ? MAX_SELF : 0) : 0;
          const own = ep.ticket === world.ticket ? ep.own : 0;
          b3.last = last ? { ...last } : null; b3.shape = shape; b3.owed = owed; b3.own = own; // returned for the sweeps' split of B3 failures (records only)
          const spent = own >= owed, inTime = last?.afterCount || world.variant !== 'new';
          if (shape && !last.usable && last.fault && inTime && spent) {
            b3.excused = last.afterCount ? 'b' : 'a'; b3.excusedKind = last.kind; b3.excusedBy = last.srcDown ? 'list' : 'track';
          } else if (shape && !last.usable && last.fault) b3.notExcused = !inTime ? 'its last ask was during the hold and nothing asked after the count (the play-start re-ask should have)' : `the world stopped asking with its allowance left (${own} episodes of its own after the count, ${owed} owed)`;
        }
      }
      for (let round = 0; round < 3; round++) {
        sourcesAnswer();
        trace.push('drain: the visitor opens a picker');
        world.openPicker();
        await settle();
      }
    }
    for (const x of world.nones) bump(`none_${x.real ? 'real' : x.from.split(' ')[0]}`);
    if (world.listNotAvailable) reach.list_not_available = world.listNotAvailable; // cs:3715
    if (world.trackGaveUp) reach.track_gave_up = world.trackGaveUp; // cs:3726
    const fails = { B1: null, B2: null, B3: null, B4: null, B5: null };
    const wrong = world.nones.find((x) => !x.real && x.from !== 'no tracks');
    const after = { mismatch: 'three answers for another ticket', '404': 'a 404 nothing_playing', error: 'three failed asks (502 captions_failed)' };
    if (wrong) fails.B2 = `"No captions" for ${name(wrong.ticket)} after ${after[wrong.from] ?? (wrong.from.startsWith('native') ? `a track that kept failing, LoadNative after its waits: ${wrong.from}` : `an answer for it that did not say no_captions: ${wrong.from}`)}`;
    // B1, from the test's records: the list (and, CC on, the lines) the world holds are the playing ticket's video's.
    const why = !world.left && hasCaptions ? without() : null;
    if (why) fails.B1 = `the visitor stayed, and the world ends without ${name(world.ticket)}'s captions (${why})`;
    // B3 (P1 strict): judged only when the visitor did nothing after the count; excused only by the named exclusion.
    if (b3.judged && b3.fail && !(b3.excused && known.has('nopicker'))) fails.B3 = b3.notExcused ? `${b3.fail}; ${b3.notExcused}` : b3.fail;
    // B4, from the test's table (verifier round 2, L-d): the playing video has no captions, so any list or lines the world
    // ends holding are another video's (a ForgetTracks that kept the old list across a pick, say). Judged whenever the
    // visitor stayed and the video has none; no exclusion.
    const b4Judged = !world.left && !hasCaptions;
    if (b4Judged && (world.trackCodes.length || world.lineTexts.length)) fails.B4 = `the visitor stayed, ${name(world.ticket)}'s video has no captions, and the world ends holding another video's ${world.trackCodes.length ? `list (${world.trackCodes.join()})` : `lines (${world.lineTexts.join()})`}`;
    // B5: the asks for one ticket stay within the world's bound (World.slot records the first stint over it).
    if (world.boundBreak) fails.B5 = `the world asked ${name(world.boundBreak.ticket)} ${world.boundBreak.asks} times, over its bound of ${world.boundBreak.bound} (CC ${world.boundBreak.ccOn ? 'on' : 'off'}, ${world.boundBreak.actions} visitor actions)`;
    const tally = { b3_judged: b3.judged, b3_judged_captions: b3.judged && hasCaptions, b3_helped: b3.helped && !world.left, b3_fail_strict: b3.judged && Boolean(b3.fail), b3_fail_all_seeds: Boolean(b3.fail),
      b3_excused_a: b3.judged && b3.excused === 'a', b3_excused_b: b3.judged && b3.excused === 'b', b3_excused_kind: b3.judged && b3.excused ? b3.excusedKind : null, b3_excused_by: b3.judged && b3.excused ? b3.excusedBy : null, b4_judged: b4Judged };
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
export const pathOf = (msg) => (msg ? msg.replace(/ticket \d+/g, 'ticket #').replace(/\((?:[a-z]{2},?)+\)/g, '(…)').replace(/asked ticket # \d+ times, over its bound of \d+/, 'asked ticket # over its bound') : null);
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
export const PROPS = ['B1', 'B2', 'B3', 'B4', 'B5'];
export async function sweep(variant, opts = {}) {
  const known = opts.known ?? KNOWN;
  const out = { B1: [], B2: [], B3: [], B4: [], B5: [] }, reach = {}, b3 = { judged: 0, judgedCaptions: 0, a: 0, b: 0, kinds: {} };
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
const SWITCHES = ['FUZZ_STRICT', 'FUZZ_KNOWN', 'FUZZ_WORLD', 'FUZZ_DROP', 'FUZZ_OTHER', 'FUZZ_FAULTS', 'FUZZ_TICKET_PIN', 'FUZZ_STRAGGLER_SAME', 'FUZZ_STEPS'];
const rerun = (seed) => `${SWITCHES.filter((k) => process.env[k] != null).map((k) => `${k}=${process.env[k]}`).join(' ')} FUZZ_SEED=${seed} node --import ./test/netguard.mjs --test test/captions-hold.props.test.js`.trim();
const show = (b) => `seed ${b.seed}: ${b.fails[b.prop]}\n  ${b.trace.join('\n  ')}\n  rerun: ${rerun(b.seed)}`;
const b3Line = (b3) => `B3 judged on ${b3.judged} of ${SEEDS} seeds (${b3.judgedCaptions} with captions); nopicker excused ${b3.excused} (a, during the hold: ${b3.a}; b, after the count: ${b3.b}; by the last answer: ${JSON.stringify(b3.kinds)})`;

// ---- The world's own ClientSim scenarios, replayed on the copy (no service: the answers are the scenario's). ----
// Tests/clientsim/<name>.json at world commit 071b75af, step for step. Each step: ['ticket', n, state] (testerTicket,
// testerPlayer: 'loading' | 'playing' | 'neither'), ['cc', on] (captions on/off), ['picker'] (captions open), ['answer',
// json] / ['error', code] (the asked load's answer, after the scenario's wantCaptions=False stands for the send), ['wait', s]
// (time passes), ['gap', s] (ccSelfGap), ['send'] (wantCaptions=False before a late answer). Expectations: 'expect' for both variants, 'new' for the new world only (the
// released one stopped before), 'released' where the released world's run on the old code (world-cap1's before/pc and
// before/pc-1046) failed: the copy of the released world must be in that state there, and its replay stops. A scenario's
// read with untilMs waits for Captions() to run (the copy runs it first); one without reads at once, before the next tick
// (the steps ending in Now). State keys: load (LIST/TRACKS/TRACK/NATIVE or 0), want, tries, unavailable, none, list
// ('pending' | 'loaded' | 'none', as the bridge's CaptionListState, cs:3239), tracks, lines (ccLinesLoaded), startDone,
// selfAsks, ccOn.
const T = (t, tracks, extra = {}) => ({ t, available: true, tracks: tracks.map((code, i) => ({ i, code, name: code, auto: true })), track: -1, ...extra });
const NOT_READY = (t, tracks = []) => ({ t, available: false, tracks: tracks.map((code, i) => ({ i, code, name: code, auto: true })), track: tracks.length ? 0 : -1, reason: 'temporarily_unavailable' });
const LINES = (t, code) => T(t, [code], { track: 0, lines: [[0, 2, 'hello there'], [2, 2, 'and again']] });
const asked = (load, k = 'expect') => [k, { load, want: true }];
const thrice = (load, answer, k = 'expect') => [asked(load, k), answer, asked(load, k), answer, asked(load, k), answer];
export const REPLAYS = {
  'captions-replay-1010-996': [ // seed 1010: three answers for the previous ticket during the hold, then the play starts
    ['ticket', 1, 'loading'], asked(TRACKS), ['answer', NOT_READY(0)], ['expectNow', { tries: 1 }], asked(TRACKS), ['answer', NOT_READY(0)], ['expectNow', { tries: 2 }], asked(TRACKS), ['answer', NOT_READY(0)],
    ['released', { list: 'none', tracks: 0, unavailable: false }], // before/pc step 27: "list=none tracks=0 unavailable=no note=none-found"
    ['new', { list: 'pending', tracks: 0, unavailable: true, none: false, want: false, load: 0 }],
    ['ticket', 1, 'playing'], asked(TRACKS, 'new'), ['answer', T(1, ['en', 'de'])], ['new', { list: 'loaded', tracks: 2, unavailable: false, startDone: true, want: false, load: 0 }]],
  'captions-replay-1027-996': [ // seed 1027: a list ask with CC on fails three times (502), the video playing
    ['ticket', 1, 'neither'], ['cc', true], ['ticket', 1, 'playing'], asked(LIST), ['error', 502], ['expectNow', { tries: 1 }], asked(LIST), ['error', 502], ['expectNow', { tries: 2 }], asked(LIST), ['error', 502],
    ['releasedNow', { unavailable: false, none: true }], // before/pc step 29: ccUnavailable "false"
    ['newNow', { unavailable: true, none: false }], asked(LIST, 'new'), ['answer', LINES(1, 'en')], ['new', { lines: true }]],
  'captions-replay-1042-996': [ // seeds 1042 and 1188: a 404 with CC on in a room where nothing has played
    ['ticket', 1, 'neither'], ['cc', true], ['ticket', 1, 'loading'], asked(LIST), ['error', 404],
    ['released', { list: 'none', tracks: 0, unavailable: false, ccOn: true }], // before/pc step 17: "cc=on ... list=none tracks=0 unavailable=no"
    ['new', { list: 'pending', tracks: 0, unavailable: true, none: false, want: false, load: 0 }],
    ['ticket', 1, 'playing'], asked(LIST, 'new'), ['answer', LINES(1, 'en')], ['new', { list: 'loaded', tracks: 1, unavailable: false, lines: true }],
    ['cc', false], ['ticket', 2, 'loading'], asked(TRACKS, 'new'), ['error', 404], ['new', { list: 'pending', tracks: 0, unavailable: true }],
    ['cc', true], asked(LIST, 'new'), ['error', 404], ['new', { list: 'pending', tracks: 0, unavailable: true }], ['newNow', { none: false }]],
  'captions-replay-1069-996': [ // seeds 1069 and 1152 (#996's item 4): CC on, a not-ready empty list; then a true none
    ['ticket', 1, 'neither'], ['cc', true], ['ticket', 1, 'playing'], asked(LIST), ['answer', NOT_READY(1)],
    ['releasedNow', { unavailable: false, none: true }], // before/pc step 17: ccUnavailable "false"
    ['newNow', { unavailable: true, none: false }], asked(LIST, 'new'), ['answer', { t: 1, available: false, tracks: [], track: -1, reason: 'no_captions' }],
    ['new', { list: 'none', tracks: 0, none: true }], ['newNow', { want: false, load: 0 }],
    ['cc', false], ['ticket', 2, 'playing'], asked(TRACKS, 'new'), ['answer', NOT_READY(2)], ['newNow', { unavailable: true, none: false }],
    asked(TRACKS, 'new'), ['answer', NOT_READY(2)], ['new', { list: 'pending', tracks: 0, unavailable: true }],
    ['cc', true], asked(LIST, 'new'), ['answer', NOT_READY(2)], ['new', { list: 'pending', tracks: 0, unavailable: true }], ['newNow', { none: false }]],
  'captions-replay-1170-996': [ // seed 1170: CC on, the list came with its track while the track's fetch kept failing
    ['ticket', 2, 'neither'], ['cc', true], ['ticket', 2, 'playing'], asked(LIST), ['answer', NOT_READY(2, ['ja'])], ['expect', { list: 'loaded', tracks: 1 }],
    ...Array.from({ length: 7 }, () => [asked(NATIVE), ['answer', NOT_READY(2, ['ja'])]]).flat(),
    ['releasedNow', { unavailable: false, none: true }], // before/pc step 53: ccUnavailable "false" after the 7th native answer
    ['newNow', { unavailable: true, none: false }], ['new', { list: 'pending', tracks: 0 }], // no start re-ask: a usable list came
    ['gap', 3], ['wait', 3], asked(LIST, 'new'), ['newNow', { selfAsks: 1 }], ['answer', LINES(2, 'ja')], ['new', { lines: true }]],
  'captions-replay-999-996': [ // seed 999: a 404 during the hold with CC off; the visitor does nothing
    ['ticket', 1, 'loading'], asked(TRACKS), ['error', 404], ['expect', { list: 'pending', tracks: 0, unavailable: true }],
    ['ticket', 1, 'playing'], ['released', { load: 0, want: false }], // before/pc step 18: ccLoad "0" (nothing asked)
    asked(TRACKS, 'new'), ['answer', T(1, ['de'])], ['new', { list: 'loaded', tracks: 1, unavailable: false }]],
  'captions-not-json-996': [ // a non-JSON answer (a proxy's error page), the video playing, CC off
    ['ticket', 1, 'playing'], asked(TRACKS), ['answer', '<html>Bad gateway</html>'],
    ['releasedNow', { none: true }], // before/pc step 15: ccNone "true"
    ['newNow', { none: false }], asked(TRACKS, 'new'), ['answer', '<html>Bad gateway</html>'], asked(TRACKS, 'new'), ['answer', '<html>Bad gateway</html>'],
    ['newNow', { unavailable: true, none: false }], asked(TRACKS, 'new'), ['answer', T(1, ['en'])], ['new', { list: 'loaded', tracks: 1 }]],
  'captions-start-before-lookup-996': [ // the play-start re-ask's answer comes late (the lookup), or not ready when the lookup failed
    ['ticket', 1, 'neither'], ['cc', true], ['ticket', 1, 'loading'], ...thrice(LIST, ['answer', NOT_READY(0)]),
    ['released', { list: 'none', tracks: 0, unavailable: false }], // before/pc step 27: "list=none tracks=0 unavailable=no"
    ['new', { list: 'pending', tracks: 0, unavailable: true }],
    ['ticket', 1, 'playing'], ['gap', 3], asked(LIST, 'new'), ['send'], ['wait', 7], ['newNow', { want: false, load: LIST }], ['answer', LINES(1, 'en')], ['new', { lines: true }],
    ['cc', false], ['ticket', 2, 'neither'], ['cc', true], ['ticket', 2, 'loading'], ...thrice(LIST, ['answer', NOT_READY(1)], 'new'),
    ['ticket', 2, 'playing'], asked(LIST, 'new'), ['answer', NOT_READY(2)], ['newNow', { unavailable: true, none: false }],
    ['wait', 3], asked(LIST, 'new'), ['answer', LINES(2, 'en')], ['new', { lines: true }]],
  'captions-new-pick-cc-on-1046': [ // #1046: a new pick made with CC on asks the list alone
    ['ticket', 1, 'neither'], ['cc', true], ['ticket', 1, 'playing'], asked(LIST), ['answer', LINES(1, 'en')], ['expect', { lines: true }],
    ['ticket', 2, 'playing'], ['released', { load: LIST, want: true }], // before/pc-1046 step 21: ccLoad "1"
    asked(TRACKS, 'new'), ['new', { ccOn: false }], ['answer', T(2, ['de'])], ['new', { ccOn: false, list: 'loaded', tracks: 1 }],
    ['ticket', 3, 'playing'], asked(TRACKS, 'new'), ['answer', T(3, ['ja'])], ['new', { ccOn: false, list: 'loaded', tracks: 1 }]],
  'captions-ask-bound-996': [ // the bound: CC on, the sources down; two self re-asks 30 s apart; a picker episode; a new ticket starts over; CC off never
    ['ticket', 1, 'neither'], ['cc', true], ['ticket', 1, 'playing'], ...thrice(LIST, ['error', 502]),
    ['releasedNow', { unavailable: false, none: true }], // before/pc step 27: ccUnavailable "false"
    ['newNow', { unavailable: true, none: false }], ...thrice(LIST, ['error', 502], 'new'), ['new', { list: 'pending', unavailable: true, startDone: true }],
    ['wait', 25], ['new', { want: false, load: 0 }], ['wait', 5], asked(LIST, 'new'), ['new', { selfAsks: 1 }], ['error', 502], asked(LIST, 'new'), ['error', 502], asked(LIST, 'new'), ['error', 502],
    ['new', { list: 'pending', unavailable: true }], ['gap', 3], ['wait', 3], asked(LIST, 'new'), ['new', { selfAsks: 2 }], ...thrice(LIST, ['error', 502], 'new').slice(1),
    ['new', { list: 'pending', unavailable: true }], ['wait', 8], ['new', { want: false, load: 0 }],
    ['picker'], asked(LIST, 'new'), ['answer', LINES(1, 'en')], ['new', { lines: true }],
    ['cc', false], ['ticket', 2, 'neither'], ['new', { selfAsks: 0, startDone: false }], ['cc', true], ['ticket', 2, 'playing'], ['gap', 3],
    ...thrice(LIST, ['error', 502], 'new'), ['newNow', { unavailable: true, none: false }],
    ...thrice(LIST, ['error', 502], 'new'), ['new', { list: 'pending', unavailable: true }],
    ['wait', 3], asked(LIST, 'new'), ['answer', LINES(2, 'en')], ['new', { lines: true, selfAsks: 2 }], ['wait', 8], ['new', { want: false, load: 0 }],
    ['cc', false], ['ticket', 3, 'playing'], asked(TRACKS, 'new'), ['error', 404], ['newNow', { unavailable: true, none: false }],
    asked(TRACKS, 'new'), ['error', 404], ['new', { list: 'pending', unavailable: true }], ['wait', 8], ['new', { want: false, load: 0 }]],
};
// Not a world scenario: the test's own directed case for the exclusion's allowance (the coordinator's call on seed 1978,
// 2026-11-23, item 2): CC on, the list's lookup not ready, then a track fetch that keeps failing through the start re-ask and
// the first self re-ask and ENDS before the second: the lines arrive with no visitor action. A copy that stops one self
// re-ask early (selfLimit 1) never asks the second time; the test below shows that.
const DIRECTED = {
  'directed-track-fault-ends-before-the-allowance': [
    ['ticket', 1, 'neither'], ['cc', true], ['ticket', 1, 'playing'], asked(LIST), ['answer', NOT_READY(1)], ['newNow', { unavailable: true }],
    asked(LIST, 'new'), ['answer', NOT_READY(1, ['en'])], ['new', { list: 'loaded', startDone: true }],
    ...Array.from({ length: 7 }, () => [asked(NATIVE, 'new'), ['answer', NOT_READY(1, ['en'])]]).flat(), ['new', { list: 'pending', unavailable: true, selfAsks: 0 }],
    ['wait', 30], asked(LIST, 'new'), ['new', { selfAsks: 1 }], ['answer', NOT_READY(1, ['en'])],
    ...Array.from({ length: 7 }, () => [asked(NATIVE, 'new'), ['answer', NOT_READY(1, ['en'])]]).flat(), ['new', { list: 'pending', unavailable: true }],
    ['wait', 30], asked(LIST, 'new'), ['new', { selfAsks: 2 }], ['answer', LINES(1, 'en')], ['new', { lines: true, list: 'loaded' }]],
};
Object.assign(REPLAYS, DIRECTED);
const stateOf = (w) => ({ load: w.ccLoad, want: w.want, tries: w.ccTries, unavailable: w.ccUnavailable, none: w.ccNone, list: w.ccNone ? 'none' : w.ccListLoaded ? 'loaded' : 'pending',
  tracks: w.trackCount, lines: w.ccLinesLoaded, startDone: w.ccStartDone, selfAsks: w.ccSelfAsks, ccOn: w.ccOn });
// Replays one scenario on the copy → null if every expectation held, else the first that did not.
export function replay(name, variant, drop = DROP, { selfLimit } = {}) {
  const w = new World(null, variant, { drop, selfLimit });
  const steps = REPLAYS[name];
  let sent = false;
  for (let i = 0; i < steps.length; i++) {
    const [k, a, b] = steps[i];
    if (k === 'ticket') w.setPlayer(a, b);
    else if (k === 'cc') w.ccButton(a);
    else if (k === 'picker') w.openPicker();
    else if (k === 'gap') w.selfGap = a;
    else if (k === 'wait') { w.now += a; w.update(); }
    else if (k === 'send' || ((k === 'answer' || k === 'error') && !sent)) { // the scenario's wantCaptions=False: what Captions() asked is sent
      w.update();
      if (!w.want) return `step ${i} (${k}): nothing was asked (${JSON.stringify(stateOf(w))})`;
      w.want = false; sent = true;
    }
    if (k === 'answer' || k === 'error') { sent = false; w.answer(k === 'error' ? a : 200, k === 'error' ? null : a); }
    else if (!['ticket', 'cc', 'picker', 'gap', 'wait', 'send'].includes(k)) {
      const now = k.endsWith('Now'), who = now ? k.slice(0, -3) : k;
      if (who !== 'expect' && who !== variant) continue;
      if (!now) w.update(); // a read that waits (untilMs): Captions() runs first
      const s = stateOf(w);
      const off = Object.entries(a).filter(([key, v]) => s[key] !== v);
      if (off.length) return `step ${i} (${k}): ${off.map(([key, v]) => `${key} ${JSON.stringify(s[key])}, the world's ${JSON.stringify(v)}`).join('; ')}`;
      if (who === 'released') return null; // the world's run on the old code failed here: the released replay ends
    }
  }
  return variant === 'released' && steps.some(([k]) => k.startsWith('released')) ? 'the released replay never reached its released step' : null;
}

for (const name of Object.keys(REPLAYS).filter((k) => !DIRECTED[k])) {
  test(`captions hold (#996): the copy replays the world's own ClientSim scenario ${name} (new world, 071b75af)`, () => {
    const off = replay(name, 'new');
    assert.equal(off, null, `the copy of the new world parts from the world's scenario ${name} at ${off}: re-read the copy against the C# (the verify-home skill, "Pilot B")`);
  });
  test(`captions hold (#996): the copy of the released world (v2026.11.22) stops where the world's old code failed in ${name}`, () => {
    const off = replay(name, 'released');
    assert.equal(off, null, `the copy of the released world parts from the world's run of the old code in ${name} at ${off}`);
  });
}

test("captions hold (#996): a track that fails through the start re-ask and the first self re-ask, then works, brings the lines with no visitor action; a copy one self re-ask short does not (the allowance of B3's exclusion, seed 1978)", () => {
  assert.equal(replay('directed-track-fault-ends-before-the-allowance', 'new'), null);
  assert.match(replay('directed-track-fault-ends-before-the-allowance', 'new', DROP, { selfLimit: 1 }) ?? 'passed', /load 0, the world's "LoadList"/);
});

// The new world's sweep, run once and read by the five tests below.
let swept = null;
const sweepNew = () => (swept ??= sweep(WORLD));
const checkProp = async (t, prop) => {
  const { out, reach, b3, b4 } = await sweepNew();
  if (prop === 'B1') {
    t.diagnostic(`reach: ${JSON.stringify(Object.fromEntries(Object.entries(reach).sort()))}`);
    t.diagnostic(b3Line(b3));
    t.diagnostic(`B4 judged on ${b4.judged} of ${SEEDS} seeds (the visitor stayed, the video has no captions)`);
  }
  if (out[prop].length) {
    const b = await shortest(WORLD, prop, out[prop]);
    assert.fail(`${prop} fails on ${out[prop].length} of ${SEEDS} seeds: ${out[prop].slice(0, 12).join(', ')}\nshortest: ${show(b)}`);
  }
};
const what = `world copy ${WORLD}${DROP.size ? ` without ${[...DROP].join(', ')}` : ''}${OTHER ? '' : ', no stragglers'}${FAULTS ? '' : ', no faults'}${PIN ? ', TICKET_PIN on' : ''}, ${SEEDS} seeds`;
test(`captions hold B1 (#996, ${what}): the world ends holding the playing ticket's own captions when the video has them`, (t) => checkProp(t, 'B1'));
test(`captions hold B2 (#996, ${what}): "No captions" only after an answer for that ticket that says it has none`, (t) => checkProp(t, 'B2'));
test(`captions hold B3 (#996, P1 strict, ${what}; ${KNOWN.size ? `excused: ${[...KNOWN].join(', ')}` : 'no exclusion'}): after the play is counted, a visitor who opens no picker and presses no CC still ends with the playing ticket's own captions`, (t) => checkProp(t, 'B3'));
test(`captions hold B4 (#996, ${what}): a video with no captions ends with no list and no lines`, (t) => checkProp(t, 'B4'));
test(`captions hold B5 (#996, ${what}): the world's asks for one ticket stay within its bound`, (t) => checkProp(t, 'B5'));
// The released world against this service, in the plain run only: it keeps B4 and B5, and its remaining false "No
// captions" come by world paths only (#996's service half took away those by another ticket's answer and by a 404).
if (WORLD === 'new' && !DROP.size) {
  test('captions hold (#996): the released world (v2026.11.22) against this service keeps B4 and B5, and no "No captions" comes from another ticket\'s answers or a 404', async (t) => {
    const s = { B2: [], B4: [], B5: [] }, paths = {};
    for (let seed = SEED; seed < SEED + SEEDS; seed++) {
      const r = await runOne(seed, draw(seed, STEPS), 'released');
      for (const k of Object.keys(s)) if (r.fails[k]) s[k].push(seed);
      if (r.fails.B2) { const p = pathOf(r.fails.B2).replace(/^"No captions" for ticket # after /, ''); paths[p] = (paths[p] ?? 0) + 1; }
    }
    t.diagnostic(`released, ${SEEDS} seeds: B2 by path ${JSON.stringify(paths)}`);
    assert.deepEqual({ B4: s.B4, B5: s.B5 }, { B4: [], B5: [] });
    const service = Object.keys(paths).filter((p) => /another ticket|404/.test(p));
    assert.deepEqual(service, [], `the released world met a "No captions" by a service path: ${service.join('; ')}`);
  });
}
