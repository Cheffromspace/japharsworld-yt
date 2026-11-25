---
name: verify-home
description: Check a change to the home relay's session bookkeeping (src/home.js, the Home class) against its stated promises with the seeded property test test/home.props.test.js, and a change to the captions exchange around a held play with test/captions-hold.props.test.js. Use whenever a diff touches src/home.js, the home parts of src/server.js that call Home (start, put, file, giveUp, sweep, flush), the captions route or the ticket route's markPlayed in src/server.js, either test file, or the world's caption-ask lines the captions test copies, and before moving this skill's coverage commit.
---

# verify-home

`test/home.props.test.js` drives the REAL `Home` class (`src/home.js`) with seeded random sequences of operations and,
after every step, checks four promises the code's own comments make. It complements `test/home.test.js` (example tests):
a property test checks every sequence it draws, within the bounds below, not only the cases someone thought of. A pass
covers those sequences at those sizes, not the whole service.

## Does my change touch the verified code?

Run `git log --oneline <coverage commit>..HEAD -- src/home.js test/home.props.test.js` with the coverage commit below.
Any commit listed means this check needs a run and, if the change was intended, the re-read in "Moving the coverage
commit". A change elsewhere in the service (server.js routing, the relay worker) is not covered by it.

## Run it

```sh
node --import ./test/netguard.mjs --test test/home.props.test.js                                # 100 seeds x 150 steps, about 5-9 s; part of npm test and CI
FUZZ_SEEDS=2000 node --import ./test/netguard.mjs --test test/home.props.test.js                # the sweep: one process, about 1.5-3.5 min, prints reach counts
FUZZ_SEED=1234 node --import ./test/netguard.mjs --test test/home.props.test.js                 # one seed; a failure prints its shrunk ops and this command
FUZZ_STRICT=1 node --import ./test/netguard.mjs --test test/home.props.test.js                  # no exclusions: the open findings below fail again
FUZZ_STEPS=400 FUZZ_SEEDS=500 node --import ./test/netguard.mjs --test test/home.props.test.js  # longer sequences
```

Seeds start at 1009 (FUZZ_SEED moves the start). A seed runs the same on every platform: the session tokens are seeded
in the test, and `readdirSync` is sorted while a sequence runs, so `#load` reads the folders in one order (both swapped
through `syncBuiltinESMExports`, with no seam in `src/`).

## What it checks (the coverage)

The checks read the test's own records: when it fetched each token, the starts it saw, the bytes it put, and a model of
each session built only from what the test sent and saw (building until a listed segment is here, then ready; ended at
ENDLIST with every listed segment here; failed by `giveUp`, a job failing while it builds, an `x-media-failed` or
SHORT_S cut-back closing playlist, or a 410 on a live session's segment). Two things do come from Home: which sessions
exist (`byToken` and `sessions`, which A1 and A2 check) and a new session's token and worker (`start`'s answer, recorded
once). Cache hits are predicted the same way, never read from `s.cached`: the first cached upload of a session the model
has not failed, once per restart epoch (`put` sets `s.cached`, which a restart forgets). The functions named are `Home`'s
in `src/home.js`.

- **A1 no delete under a player or a live build.** `start`, `sweep` and `#evictFor` (through `start` and `put`) never
  remove a session a player fetched in the last 5 min (PLAYING_MS) or one building or uploading and not stale
  (STALE_MS). A restart (`flush`, then a new `Home` on the same dir: `#load`) keeps exactly the ready, not-stale
  sessions (ready as `#playlist` reads it from disk: a listed segment and a stored one) and the `cut_short` failures
  with files, and drops the rest (allowing for the 30 s by which `#write` may lag `lastPutMs` in meta.json). A restart
  keeps who is watching: the played check runs on the test's own fetch times across it, as strict as anywhere
  (Everything-is-OK#1011, fixed by saving the last fetch in meta.json). A third of the restart ops are **crashes** (no
  `flush`; reach `crash`): for a session a crash reloaded and no player fetched since (also across later clean restarts,
  whose `flush` has nothing newer to write), the last fetch may count as up to 30 s older (GET_SAVE_MS, `file()` writes it
  at most that often; reach `crash_lag_allowed`). With no crash since a session's last fetch, A1 is as strict as anywhere.
- **A2 the maps agree.** Every `sessions` entry sits under its own `id@quality` and is in `byToken`. An entry only in
  `byToken` (set aside by `start`, or a reloaded `cut_short`) is gone at the first `sweep` once nobody fetched it for 5
  min. The token folders on disk are exactly `byToken`'s. Each session's `mb` equals the bytes the test put. Each
  session's `state` (and `ended`, while not failed) agrees with the model (`#playlist`, `#checkEnded`, `put`, `giveUp`,
  `#fail`).
- **A3 the limits, at every start.** Real (not cached) builds per Chicago day <= `dailyBuilds` and the day's downloaded
  MB under `dailyMb` (`capped`, `limit`); real builds in the rolling hour <= `hourBuilds`; the hour's expected MB within
  `hourMb` unless the hour is empty or the video is `hourMbExemptSeconds` or longer (`blocks`); nothing over
  `itemMaxMb`; at least `startGapMs` since the last real build, except an AV1 play while not `hammering`; a worker
  online and its live streams <= its `mediaMax` (`worker`, `#active`). After a crash only, the MB half (never the
  builds half: `start` writes day.json at once) allows the downloaded MB the test put since day.json's last write, as
  `#saveDaySoon` schedules it, summed over that day's crashes (reach `crash_day_mb_allowed`). Stated exceptions it allows: a cache upload
  leaves the day, the hour and the gap (`put`); a restart forgets the hour and the gap (`recent`, `lastStartMs`).
- **A4 the disk.** After a start that makes a session, free MB minus what the unfinished builds will still grow is at
  least `freeFloorGb` (`#room`, `#expectedMb`); after any `sweep`, either the expected total is within `maxGb` or no
  finished, unplayed session is left.
- **Not covered:** the half-floor stop in `put` (free space under `freeFloorGb` x 500 while building); segment holds,
  `want()` and `#far`; the playlist text `file()` serves (absolute links, START, EVENT to VOD); `eta`, `settle`, `wait`;
  `other`, `isUneven`, `markUneven`; `load()` and `state()`; the HTTP routes in `src/server.js` that call `Home`; the
  `#load` stamp of a meta.json without `lastGetMs` (one written before Everything-is-OK#1011): every meta.json the test
  writes has the field, so no seed reaches it, and the example tests in `test/home.test.js` cover it.

Bounds: 150 steps per sequence, 100 seeds in `npm test`, 2,000 in a sweep. Sizes are scaled down so the limits bite in a
few steps: segments 20-150 KB, videos 1-5 s with 2-6 segments of 4 s, `maxGb` 1.5-3 MB, `freeFloorGb` 0-2 MB, a disk
of 4-10 MB, `dailyMb` 0.3, 0.8 or 2-10 MB, two media workers taking 1-3 streams. The fake worker sends only what `relay/media.js` sends: the whole
predicted playlist or a growing one that only grows, never both, then one closing playlist (every segment, or cut back
to those sent in order, `closedAt`), after which its stream uploads nothing more.

**Directed:** the seeds ending in 0 and in 5 also run a second sequence that opens with a set script, then that seed's
random ops (the plain sequence of every seed is unchanged). Ending in 0, 'edge': a finished copy from the worker's
cache, two player fetches 10-55 s apart, a crash, a clean restart, or a crash then a clean restart, the longest video's start 3.9 min after the last
fetch (over maxGb), then a sweep every 10 s to 5.1 min. Ending in 5, 'day': a download whose segments come 15-50 s
apart, a crash, another start. Random ops almost never
reach these edges (2026-11-23: the A1 crash allowance fired 0 times in 2,000 plain seeds, and a `Home` writing day.json
every 60 s was caught by 1 seed in 2,000); without them the two crash allowances would be unchecked. A failure there is
named "seed N (directed)"; `FUZZ_SEED=N` reruns both sequences of that seed.

**Drift points** (hand copies in the test that must follow the code): `expectedOf` is `#expectedMb` written out (it is
private, and `state()` rounds it to whole MB); the session model follows the rules of `#playlist`, `#checkEnded`, `put`
and `start`'s `.catch` (including SHORT_S); the constants PLAYING_MS, STALE_MS, GET_SAVE_MS, DAY_SAVE_MS and the 30 s
meta save are copied by name; when `#saveDaySoon` and its callers write day.json (a start that makes a session, a
playlist upload, `flush`, the first new segment DAY_SAVE_MS after the last write) is written out as `daySave` in the
test.
A change to any of them in `src/home.js` means changing the test in the same commit.

## Reading a failure

A failure prints the property, the message in the code's words (`t0`, `t1` are sessions in the order they were made),
the seed's settings, the sequence shrunk to the fewest ops that still fail that property, and the command to rerun it.
Read the shrunk ops as a story: each line is one call on `Home` (`start`, `put`, `get` = `file`, `sweep`, `giveUp`), a
worker event, the clock, or a restart.

**A real bug or a wrong property?** Re-read the comment or decision the property cites (in `src/home.js`, at the
function named). If the code does what its comment says and the property says something else, the property is wrong:
change it only together with the comment or decision that shows the intent, and say so in the commit. If the code
breaks what its comment promises, it is a finding: report it with the seed and the shrunk ops, never weaken the
property or add an exclusion to make it pass. If the failing ops are something the real worker or server never does
(read `relay/media.js` and `src/server.js`), the generator is wrong: hold it to what they do, and say so.

**Open findings** (each excused by one narrow, named exclusion in `KNOWN`, with a `test.todo` naming it; `FUZZ_STRICT=1`
shows them failing):
- `recached`, Everything-is-OK#1013: `s.cached` is not saved in meta.json, so after a restart a cache upload takes its
  cache hit again (`put`) and the day lets one more real build through. Only a repeat hit after a restart counts as
  this finding; a second hit with no restart between fails (verifier V17, 2026-11-23). Strict seed: 1026.
- `midnight`, Everything-is-OK#1018: a cache hit is taken off the day it is marked (`put`), not the day its build
  started, so a build started before midnight and marked cached after it gives the new day one more real build.
  Strict seed: 2925.

The two day-count findings are excused by one rule: a start over the day's real builds passes only if Home's day count,
as the known findings alone would make it (the day's starts less its cache hits, each finding's kind of hit counted only
when that finding is in `KNOWN`, floored at 0 as `put` does), was under `dailyBuilds`. So neither can pay for the other.
A finding's count is measured one way: the seeds of 2,000 that fail with the other findings in `KNOWN` and this one not
(for example `FUZZ_KNOWN=midnight FUZZ_SEEDS=2000` for recached).

When a fix for one lands: remove its name from `KNOWN` (and its branch in the check), turn its `test.todo` into a plain
test or delete it, run the sweep with `FUZZ_STRICT=1`, and update this list.

**Fixed:** `reload`, Everything-is-OK#1011 (a restart forgot who was watching). meta.json now carries `lastGetMs`
(always, 0 when nobody fetched), written by `file()` at most every 30 s and by `flush()`; `#load` restores it, and
stamps "played from the restart" only a ready session whose meta.json has no such field (written before the fix), and
writes the stamp at once, so it is the one restart of the deploy that brings it, crash or not. The restart op's bookkeeping (`stamped`, reloaded `cut_short` failures only) did
not change, because nothing new is stamped. Seeds that failed before it: strict 1105; 1116 with
`FUZZ_KNOWN=recached,midnight` (it also fails on `recached` strict).

**Known limits** (what the code states it does; allowed by name, not findings):
- After a crash (no `flush`), the day's downloaded MB can be under-counted by what was downloaded since day.json was
  last written, at most 30 s of uploads, per crash (`#saveDaySoon`, "flush() saves the rest on shutdown").
- After a crash, a session's last fetch can read back up to 30 s old (GET_SAVE_MS), so its protection can end up to
  30 s early.

## Checking the check

Each property has been seen failing on a deliberately broken `src/home.js` (verifier rule "a new test fails on the old
code"); after a change to the test, break one property on purpose and confirm the run fails, for example
`start` setting aside a played session (`if (old && this.#playing(old))` → `if (old && false)`) must fail A1.
Put `src/home.js` back with `git diff --quiet src/home.js` confirming it.

The default 100 seeds are a smoke run: the weakest broken variants (A1's, set-aside and restart, caught by 4-5 of 100
seeds on 2026-11-23) slip past about 1 run in 50. So any change to `src/home.js` also gets the 2,000-seed sweep, which
none of the 13 variants of 2026-11-22 slipped past. Everything-is-OK#1011's 11 (V1-V10 and V17, rerun by its verifier
on 2026-11-23): the sweep catches V1-V10; V17 (the `#load` stamp's write left out) only the example tests catch, since no
seed reaches that stamp (under "Not covered"). The default 100 seeds catch none of V1, V6 (`flush` skipping the fetches)
and V17, so each has an example test that `npm test` runs.

## Moving the coverage commit

Move it only after (1) re-reading every function listed under the coverage at the new commit and confirming the
properties and the drift points still describe them, (2) `FUZZ_SEEDS=2000 node --import ./test/netguard.mjs --test test/home.props.test.js` passing
(or failing only on the open findings above), and (3) recording the new commit here in the same commit as any test
change. A diff that changes `src/home.js` and leaves this unchanged says why in its message.

**Coverage commit:** `9259b0b` (src/home.js blob `fbdd29791325e3a35608f5655d9352cc81ce5039`), confirmed 2026-11-22.
It stays there while the commits of Everything-is-OK#1011, #1013 and #1018, which change src/home.js, are unpushed: the
owner may ship #1011 alone, which rebuilds them under new hashes, so a hash named now might name no commit on the branch
that ships. It moves in one commit once that branch is on staging, after the three steps above (its verifier's L-1,
2026-11-23).


## Pilot B: captions around a held play (test/captions-hold.props.test.js)

A second seeded test, for Everything-is-OK#996. The service is the real `createApp` with a real `Store`. `playback` is
faked so a player's ticket request is held until the test lets it go. `captions` answers as a failed lookup does
(`temporarily_unavailable`, no tracks) until the test lets its sources succeed. The real lookup awaits its sources and
answers that only when they found nothing, so the test's counts of that path are not frequencies. Some videos are looked
up already when a sequence starts. Some have faults: a caption fetch that fails (the route's 502) and a track fetch that
fails while the list is there. The failed fetch stands for any fetch that fails: a service restart, a proxy 502 or 503,
the network. A real failed lookup does not give it: the chain's `resolve()` catches every source error and returns
nothing (`src/captionchain.js` 192-213), so the route answers "not ready". Each video has its own track code and line
text, kept in the test's own table.

**The world side is a hand-written COPY** of the world's caption-ask rule, so unlike pilot A it can drift from the code
it stands for. Since 2026-11-23 (#996 phase 3, service-cap3) it has two variants (`FUZZ_WORLD`):
- `new` (the default): #996's world half and #1046 as built, world commit `071b75af`;
- `released`: v2026.11.22, the tag (`c500c89a`, whose C# equals `eddf7f5a`'s), with verifier-cap-s1's Low fixed: the
  released C# reads the CC mode BEFORE it forgets the previous video, so a new pick made with CC on asks the list with
  captions first (`carriedCcMode`).

Everything the copy takes from the world is in one block (`World`, `RULES`); each line names its `cs:N` (071b75af's) or
`tag cs:N`. The new world's pieces are named rules; `FUZZ_DROP=a,b` leaves them out, to show each one matters.
`Captions()` runs on Update's 0.2 s tick (cs:2030), so the copy runs it after every op: what to ask is decided at once,
and a `tick` op is the string slot that sends it (until 2026-11-23 the copy decided only at the slot, so a CC press
between a pick and the next slot made the first ask a list with captions; the C# had asked the list alone 0.2 s after the
pick). The copy's clock moves only by LoadGap (5.2 s) per slot; the self re-asks' 30 s gap needs nothing more.

- **The replays.** The world's own ClientSim scenarios (`Tests/clientsim/` at 071b75af: captions-replay-1010, -1027,
  -1042 (+1188), -1069 (+1152), -1170, -999, captions-not-json, captions-start-before-lookup, captions-ask-bound (-996),
  captions-new-pick-cc-on-1046) are fed to the copy with the same answers, step for step (`REPLAYS`). The new world must
  reach every state the scenario reads; the released world must be in the state where the world's run on the OLD code
  failed (world-cap1's `before/pc`, `before/pc-1046`), and stops there. A read with `untilMs` lets `Captions()` run
  first; one without reads at once. 20 plain tests. Dropping any one rule of `RULES` reds at least one of them.
- **Promises** (checked against the test's own records: its table of each video's track and lines, its log of asks
  and answers, when the playing ticket's play was counted, what the visitor did), plain tests on the new world:
  - B1: if the visitor stayed and the video has captions, the world ends holding the playing ticket's OWN list (and
    lines, CC on), after a drain in which the visitor opens a picker three times.
  - B2: "No captions" only follows an answer for that ticket that says it has none (`no_captions`, or the true-empty
    answers the world reads as none: an available empty list, an empty track; the fake sends neither).
  - B3 (P1 strict): after the play is counted, a visitor who opens no picker and presses no CC still ends with the
    playing ticket's own captions, judged after the quiet part of the drain (the sources answer, the world asks until
    nothing is due, its self re-asks included: the quiet time passes and the sources answer before each).
  - B4: if the visitor stayed and the playing video has NO captions, the world ends holding no list and no lines.
  - B5 (new 2026-11-23): the world's asks for one ticket stay within the bound world-cap1 derived (and its verifier
    confirmed): CC off 6, CC on 66, plus one episode per visitor action (3 CC off, 21 CC on). It is what makes the
    limiting rules matter in the sweep (`startOnce` dropped: B5 on 12 of 500).
  - The released world in the plain run: 60 seeds that must keep B4 and B5 and meet no "No captions" by another ticket's
    answer or a 404 (#996's service half took those away).
- **B3's one exclusion, "nopicker"** (#166's design, which #996 keeps for CC off, and the bound of #996's self re-asks
  with CC on; the coordinator's calls of 2026-11-23, the second on seed 1978). Only the end state "Captions can't load
  right now" (no list, no "No captions"), and only when ALL hold, by the TEST'S OWN records:
  1. the last ask, for this ticket, failed by a fault the test drew: the asked video's list not looked up yet (not in
     `ready`), a 502 the test threw for it, or its track fetch failing (`fault`). What the service answered does not
     decide it (verifier round 2, N1): a "not ready", a 404 or another ticket's answer while the sources worked is NOT
     excused;
  2. the world's allowance after the count is SPENT: its own list episodes after the count, counted from the asks the
     test saw (not the copy's counters), number at least the start re-ask (unless a list came first, which spends it)
     plus, with CC on, the two self re-asks. A world that stops asking with allowance left stays red;
  3. the last ask came after the count, with no visitor action after it. A last ask during the hold (a) is not excused
     in the new world, which re-asks when the play starts (verifier-props-b3, L-1: exact, no budget).
  Until 2026-11-23 the "fault" was "the list's sources had nothing, or a fault the test drew threw during the ask": the
  second half only ever counted ANOTHER video's fetch (a fault throws only for a video not looked up), so it excused
  #996's own wrong-video path (verifier-props-b3, L-3); it is now the asked video's own faults, list or track.
  - **Known limit (the owner's information):** with CC on, when a video's captions keep failing for about two and a
    half minutes, the room stops asking by itself and reads "Captions can't load right now" until the visitor opens the
    captions menu or presses CC. Seed 1978 (stragglers off) shows it: a track fetch failing 16 times in a row outlasts
    the start re-ask and both self re-asks. The exclusion excuses it (2 of 2,000 seeds off, 5 on, by a track fault).
  - **What it still excuses** (verifier-props-b3, L-2): a service that starts a lookup late is excused on videos not
    looked up yet, since the test's `ready` set advances only on lookups the service under test starts.
  - It does NOT excuse a false "No captions", another video's captions, or a world that never asked.
  - **Checked:** a copy one self re-ask short (`selfLimit` 1) is red on 13 of 2,000 seeds (off) and 19 (on); the plain
    run's directed case (`directed-track-fault-ends-before-the-allowance`: the fault ends before the second self
    re-ask, the lines come with no visitor action) parts from that copy.
- **A straggler is another visitor's player**: its requests carry an `x-forwarded-for` from loopback, so the service
  sees another client. `FUZZ_STRAGGLER_SAME=1` sends it as the room's own client, as before 2026-11-23.

| Switch | What it does | In the default `npm test` run? |
|---|---|---|
| (none) | the 20 replays, the directed case, B1-B5 on 60 seeds of the new world, the released world's 60-seed check | yes |
| `FUZZ_WORLD=new\|released` | the copy's variant for B1-B5 (released: B1-B3 fail by world paths, by design) | `new` |
| `FUZZ_DROP=a,b` | leaves the named `RULES` out (replays and sweep), to show a rule matters | none |
| `FUZZ_STRICT=1` | B3 with no exclusion | no |
| `FUZZ_KNOWN=a,b` | the exclusions to keep (default `nopicker`; empty keeps none) | default `nopicker` |
| `FUZZ_OTHER=0` | no stragglers | stragglers on |
| `FUZZ_FAULTS=0` | no faults (no 502 lookups, no failing track fetches) | faults on |
| `FUZZ_TICKET_PIN=1` | TICKET_PIN on; the fake's `peek` answers a ready build, so a played ticket picked again is answered from its pin | off |
| `FUZZ_STRAGGLER_SAME=1` | a straggler asks as the room's own client, as before 2026-11-23: B1 and B3 red by design (it moves that client's record to the old ticket: 10 and 7 of the default 60); the released check is skipped | another client |
| `FUZZ_SEED`, `FUZZ_SEEDS`, `FUZZ_STEPS` | the seed range and length | 996, 60 seeds, 16 steps |

  Only the value `1` turns `FUZZ_STRICT`, `FUZZ_TICKET_PIN` and `FUZZ_STRAGGLER_SAME` on; only `0` turns `FUZZ_OTHER`
  and `FUZZ_FAULTS` off. `FUZZ_PROMISES` and `FAILS_TODAY` are gone (2026-11-23): the promises are plain tests.

- **Run:** `node --import ./test/netguard.mjs --test test/captions-hold.props.test.js` (about 5 s). Smoke of each switch
  on 2026-11-23: `FUZZ_WORLD=released` red on B1-B3 only; `FUZZ_STRICT=1` and `FUZZ_KNOWN=` red on B3 only;
  `FUZZ_TICKET_PIN=1`, `FUZZ_FAULTS=0`, `FUZZ_OTHER=0` green; `FUZZ_DROP=startReask` red on 8 replays, the directed case
  and B3. The default 60 seeds
  are a smoke run. A change to the captions route, the ticket route or the copy also gets the longer gate, which is
  also B4's and B5's: `FUZZ_SEEDS=2000 node --import ./test/netguard.mjs --test test/captions-hold.props.test.js`, with
  and without `FUZZ_OTHER=0` (verifier-props-b3, L-4). Measured 2026-11-23 on this tree: every check 0 at 2,000 seeds
  both ways; B3 judged 1,307 / 1,344, excused 141 / 126.
- **The copy and its drift.** Before trusting a pass, check the world's lines are unchanged: `git log 071b75af..HEAD --
  Assets/EverythingIsOK/Scripts/EverythingIsOKYouTubeSearch.cs` in the world repo (and `c500c89a` for the released
  variant, which only a new release replaces). If they changed, re-read the copy against the new C#, line by line,
  check the replays against the world's scenarios, and move the commits named here.
- **Known differences, not modelled** (each makes the copy simpler than the world):
  - An ask and its answer are one step: the room cannot pick again while an answer is in flight. In the world the old
    answer (old `t`) is then read as the new ask's and uses one of its three tries.
  - A row pick on the tablet (PickRow, cs:3107-3124: the picked track, then the default track, then native: 27 asks)
    and CC turned off; a change of `urlLanguage`; `PreferredRow()` is row 0 (no saved language).
  - cs:2388, 2431: a restricted or daily-limit answer stops the asks.
  - The retry waits (cs:1420) and PaintCaptionNotes' timeout are spacing and display only.
  - The service never sends an unreadable answer, an available empty list or an empty track: those paths are covered
    by the replays only (not-json) or not at all (the true-empty nones; read in code).
- **Reached** (2,000 seeds, new world, stragglers off; `reach` in each run's output): give-ups by kind (`gaveup_list_alone`
  2,629, `gaveup_empty_list` 588, `gaveup_failed` 160, `gaveup_native` 85; `gaveup_other` 0: with #996's service half
  another ticket's answer three times in a row is not drawn), `start_reask` 1,253, `self_reask` 151, `ask_again_cc_on`
  682, `track_gave_up` 59, `none_real` 522. The released world's carried CC first ask: `carried_cc_first_list`.
  Not reached by the sweep: `gaveup_other`, the unreadable answer, the true-empty nones; each rule still reds a replay
  when dropped.
- **Service side covered:** `captionIn` in `src/server.js` (the asking client's own player's ticket, held or counted;
  `lastPlayed` without a record; a 404 with nothing played; a 502 when the lookup throws), the ticket route's hold, its
  `markPlayed` after the hold (even for a dropped request, #1029), the pinned answer with TICKET_PIN, and the store.
- **Checking the check** (2026-11-23, service-cap3; 500 seeds, stragglers on, new world, rule dropped): `giveUpEmptyList`
  B1 44 / B2 87 / B3 22; `giveUpNative` 12 / 12 / 8; `startReask` B3 59 (the exclusion is keyed to the
  variant, so a copy without the start re-ask is held to it); `startOnlyPlaying` B3 19; `selfReask` B3 10; `startOnce`
  B5 12; `selfGap` B3 strict 31 → 33; `selfOnlyCcOn` B3 strict 31 → 0 (CC off then re-asks by itself too);
  the other rules (`giveUpOther`, `giveUpFailed`, `unreadableIsFailed`, `nativeDropsList`, `gate`, `pickerOnCcOn`,
  `askAgainOnCcOn`, `startDoneOnList`, `selfMax`, `doneOnLines`) move no sweep cell and are seen by the replays only.
  The service variants of round 3 (VB1-wrong-video and the others) were measured against the old copy and are not
  re-run here; their patches and counts are in the batch reports of 2026-11-22.
