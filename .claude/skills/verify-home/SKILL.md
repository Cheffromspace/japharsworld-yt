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

**The numbers in this section** (the budgets, the reach list, the variants' and B4's counts) were measured against the
service BEFORE #996's service half (f216ef5, 2026-11-23): "today's service" there means a4b15cd / 9259b0b. They were not
re-run against the change, so they do not all reproduce from this tree; only the FAILS_TODAY / FIXED_BY_SERVICE seeds
below are. The batch report of #996's service half has the option table's cells for the change; #996's phase 3
re-measures the rest with the world's rule as built.

A second seeded test, for Everything-is-OK#996. The service is the real `createApp` with a real `Store`. `playback` is
faked so a player's ticket request is held until the test lets it go. `captions` answers as a failed lookup does
(`temporarily_unavailable`, no tracks) until the test lets its sources succeed. The real lookup awaits its sources and
answers that only when they found nothing, so the test's counts of that path are not frequencies. Some videos are looked
up already when a sequence starts. Some have faults: a caption fetch that fails (the route's 502) and a track fetch that
fails while the list is there. The failed fetch stands for any fetch that fails: a service restart, a proxy 502 or 503,
the network. A real failed lookup does not give it: the chain's `resolve()` catches every source error and returns
nothing (`src/captionchain.js` 192-213), so the route answers "not ready". Each video has its own track code and line
text, kept in the test's own table. The world side
is a hand-written COPY of the world's caption-ask rule, so unlike pilot A it can drift from the code it stands for.

- **Promises** (checked against the test's own records: its table of each video's track and lines, its log of asks
  and answers, when the playing ticket's play was counted, what the visitor did):
  - B1: if the visitor stayed and the video has captions, the world ends holding the playing ticket's OWN list (and
    lines, CC on), after a drain in which the visitor opens a picker three times.
  - B2: "No captions" only follows an answer for that ticket that says `no_captions`.
  - B3 (P1 strict): after the play is counted, a visitor who opens no picker and presses no CC still ends with the
    playing ticket's own captions, judged after the quiet part of the drain (the sources answer, the world asks
    until nothing is due). It is judged only on seeds where the visitor did nothing after the count (about 60 % of
    seeds; half the seeds draw an idle visitor for this).
  - B4 (added 2026-11-23, verifier round 2, L-d): if the visitor stayed and the playing video has NO captions (by the
    test's table), the world ends holding no list and no lines; any it holds are another video's. It holds today, so
    it is a plain assertion in the default run and in the `FUZZ_PROMISES=1` run, never a todo.
- **The open finding "nopicker"** (#996; its own `test.todo`; strict seed 999). After an ask the sources could not
  answer yet, the world asks again only on a picker open (cs:3653, cs:3378; the #166 design). So a visitor who does
  nothing ends on "Captions can't load right now". It is B3's one exclusion, for that end state only (no list, no "No
  captions", the last ask was for this ticket and nothing was asked after it), and only when the TEST'S OWN records
  say that last ask could not have been answered with the list: the asked video's sources had nothing (it was not in
  the test's `ready` set), or a fault the test drew threw during it. Until 2026-11-23 it was decided from the
  service's own answer, so a service that wrongly answered "not ready" passed every check (verifier round 2, N1).
  - What it still excuses: whatever the service answered at that last ask, while the sources had nothing. That is
    mostly a "not ready" (the #166 design proper); also a 502 from a failed fetch, and, rarely, a 404 or another
    ticket's answer that came while the sources had nothing anyway (a correct service would have said "not ready"
    there and the world would end the same). Each sweep prints the excused seeds by the last answer's kind.
  - A 404 `nothing_playing` or an answer for another ticket is NOT the #166 design: they are #996's own paths. When
    the sources had the list, they are not excused, and neither is a "not ready".
  - It does NOT excuse a false "No captions", another video's captions, or a world that never asked.
  - The excused seeds are split into (a), the last ask during the hold, and (b), after the count.
  - Budget (`NOPICKER_BUDGET`, per world option): the excused seeds may be at most this share of the judged seeds
    whose video has captions (the only seeds it can excuse), applied from `NOPICKER_MIN_JUDGED` (20) such seeds, so a
    one-seed rerun is not read as over budget. Set on 2026-11-23 from the honest cells (today's service, svcHeld,
    svcNotReady2; stragglers off and on; 500 seeds and the default 60):
    - opt2xs: 25 %. Highest honest share 18.1 % at 500 seeds, 6 of 32 (18.8 %) at the default 60, 16.1 % at 2,000
      (svcHeld). It sees opt2xs losing its start ask with svcHeld and no stragglers (66 of 249 at 500 seeds, 10 of 32
      at 60), which no check sees, since every seed that variant moves is excused. It MISSES the same variant with
      stragglers on (21.3 %, 7 of 38 at 60: under 25 %) and under today's service (18.9 %); under svcNotReady2 B3
      catches it (30 of 500). So it is a coarse guard: run it with `FUZZ_OTHER=0`.
    - today, opt1, opt1x, opt2, opt2x: no budget. Highest honest share 31.3 % (svcNotReady2, stragglers off; 10 of 32 at
      60). Every variant tried that moves these options' excused share is caught by B3 itself (VSFirstListNotReady,
      VSTwoListsNotReady, droplist), so a budget there would guard nothing seen.
- **#996's service half is in** (2026-11-23, service-cap1; `src/server.js` `playerAsked`): a caption ask is answered about
  the video ticket the asking client's player asked for last in the shard, held or counted (the svcHeld option, per
  client). Against it, today's copy (= the released world, v2026.11.22) still fails B1, B2 and B3 by WORLD paths only,
  each a recorded seed in `FAILS_TODAY`, run with explicit options so no switch moves them:
  - a list asked with CC on whose lookup found nothing (#996's item 4, NoCaptions at cs:3656; 1069);
  - a track that keeps failing, LoadNative after its waits (cs:3675-3678; 1170);
  - a list ask whose caption fetch fails three times, 502 (cs:2264-2266; 1120, which replaced 1027: the service half
    moved 1027 off that path);
  - B3 strict, "nopicker" (999: now a not-ready answer for the held ticket, before a 404).
  The seeds that failed by a SERVICE path before it (on staging a4b15cd) are asserted to pass (`FIXED_BY_SERVICE`):
  three answers for another ticket (#996; 1010), a 404 `nothing_playing` with CC on in a fresh shard (1042), B1 by
  another ticket's answers after a straggler's play (1016). In 2,000 seeds of today's copy (stragglers on) no check
  fails by another ticket's answer or a 404 any more.
  So B1-B3 are `test.todo`, and a plain test asserts that the recorded seeds still fail: the file goes red when the
  code under it changes. The orderings printed with a failure (and the ones for the world's replay) come from a
  shrink that keeps the failure's PATH, not only the failing check (verifier round 2, L-b: before, seed 1027's three
  502s shrank to a 404).
- **A straggler is another visitor's player** (since 2026-11-23): its requests carry an `x-forwarded-for` from
  loopback, so the service sees another client. `FUZZ_STRAGGLER_SAME=1` sends it as the room's own client, as before;
  today's service and the shard-level svcHeld option read no client, so their cells do not move with it.
- **When #996's world half lands**, its fixer drops the `FAILS_TODAY` test and turns the todos into plain tests (today's
  `FUZZ_PROMISES=1` run, with `nopicker` kept as long as the #166 design stays). They change the copy (or make the
  matching `VARIANTS` entry the default) in the same batch as the C#, and the world's own replay scenario must then pass
  in the test editor.

| Switch | What it does | In the default `npm test` run? |
|---|---|---|
| (none) | the `FAILS_TODAY` seeds and the `FIXED_BY_SERVICE` seeds, then a 60-seed sweep of today's copy that must keep B4 and still fail B1 and B2 somewhere (diagnostic counts for B3); "fail somewhere" is asserted only from 20 seeds, so `FUZZ_SEED=n` alone is green | yes, the only test that runs |
| `FUZZ_PROMISES=1` | runs B1-B4 as plain tests with the known exclusions, plus the `nopicker` budget | no |
| `FUZZ_STRICT=1` | the same with no exclusion: B3 counts every judged seed | no |
| `FUZZ_KNOWN=a,b` | the exclusions to keep (default `nopicker`; empty keeps none) | default `nopicker` |
| `FUZZ_WORLD=today\|opt1\|opt1x\|opt2\|opt2x\|opt2xs` | the copy's variant: #996's options (`VARIANTS` in the file) | `today` |
| `FUZZ_OTHER=0` | no stragglers | stragglers on |
| `FUZZ_FAULTS=0` | no faults (no 502 lookups, no failing track fetches) | faults on |
| `FUZZ_TICKET_PIN=1` | TICKET_PIN on; the fake's `peek` answers a ready build, so a played ticket picked again is answered from its pin | off |
| `FUZZ_STRAGGLER_SAME=1` | a straggler asks as the room's own client (no `x-forwarded-for`), as before 2026-11-23 | another client |
| `FUZZ_SEED`, `FUZZ_SEEDS`, `FUZZ_STEPS` | the seed range and length | 996, 60 seeds, 16 steps |

  Only the value `1` turns `FUZZ_PROMISES`, `FUZZ_STRICT`, `FUZZ_TICKET_PIN` and `FUZZ_STRAGGLER_SAME` on; `0` or anything else is off. Only
  `0` turns `FUZZ_OTHER` and `FUZZ_FAULTS` off. (Until 2026-11-23 any value turned the first three on, so
  `FUZZ_TICKET_PIN=0` ran with the pin: verifier round 2, L-a.)

- **Run:** `node --import ./test/netguard.mjs --test test/captions-hold.props.test.js` (60 seeds, about 3.7 s); `FUZZ_PROMISES=1 FUZZ_SEEDS=2000
  FUZZ_WORLD=opt2x` (say) for one of #996's options; service options are patches outside the repo (the batch's report
  names them), applied in a scratch worktree.
- **The copy and its drift.** It mirrors `Assets/EverythingIsOK/Scripts/EverythingIsOKYouTubeSearch.cs` in the world
  repo as read at world commit `eddf7f5a` (2026-11-22):
  - lines 39 and 1405-1414 (only spacing, so not modelled);
  - 390;
  - 1942, 1956-1957 and 2015 (Captions() runs on Update's 0.2 s tick, so a new ticket's reset is done at the pick; read
    in code);
  - 2079-2088, 2258-2267, 3145-3150, 3329-3335, 3338-3388, 3544-3548, 3571-3575;
  - 3635-3700 (with 3667);
  - 3719-3723 and 3702 (what the world holds).

  Each line of the copy names its `cs:N`. Before trusting a pass, check those lines are unchanged (`git log
  eddf7f5a..HEAD --` that file in the world repo); if they changed, re-read the copy against the new C#, line by line,
  and move the commit named here.
- **Known differences, not modelled** (each makes the copy simpler than the world):
  - An ask and its answer are one step in the copy. In the world an ask can be in flight while the room picks again;
    the new ticket's reset re-asks at once, so the old answer (old `t`) is read as the new ask's and uses one of its
    three tries (cs:2079-2090, 2175, 3638). That only makes today worse, and opt2x makes a mismatch harmless.
  - cs:3640: an answer that is not a JSON object → "No captions" (the service always sends JSON).
  - cs:3362: a change of `urlLanguage` also forgets and asks again.
  - cs:2388, 2431: a restricted or daily-limit answer stops the asks.
  - cs:3108: PickRow clears `ccNone`. cs:3145: the CC button is a toggle; the copy only turns it on.
  - `PreferredRow()` (cs:3128-3142) is row 0 (no saved language).
  - PaintCaptionNotes' timeout (cs:3557-3567) is display only.
- **The options are models, not the C#.** opt2x's not-ready rule covers only an EMPTY not-ready list (#996's item 4); a
  not-ready list that came with its tracks (a track's cue fetch failed) is read as today: the list is kept and a track
  is asked (cs:3654-3667). Until 2026-11-23 opt2x dropped that one too (verifier round 2, L-d-copy). The change sends
  those CC-on fault seeds on to LoadNative's "No captions" (cs:3678) as today's world does, so under opt2x and opt2xs
  B2 now fails by that path on 16 (today's service), 19 (svcHeld) and 22 (svcNotReady2) of 500 seeds, stragglers off
  (before: 4, 3, 1). A fix for #996 must cover cs:3678 itself: until it does, the `FUZZ_PROMISES=1` run of svcHeld or
  svcNotReady2 with opt2x or opt2xs (stragglers off) fails B1 and B2 by that path on 2 or 3 of the default 60 seeds
  (1012, 1017; svcNotReady2 also 1022).
- **Service side covered:** `captionIn` in `src/server.js` (it answers for `store.lastPlayed`, a 404 with nothing played,
  a 502 when the lookup throws), the ticket route's hold, its `markPlayed` after the hold (even for a dropped request,
  #1029), the pinned answer with TICKET_PIN, and the store. A change there means a run of this file and of its
  `FUZZ_PROMISES=1` form.
- **Reached and not reached** (2,000 seeds, today's copy, stragglers on; `reach` in each run's output):
  - Reached (counts in 2,000 seeds):
    - every path to a false "No captions": another ticket's answers (`none_mismatch` 911), a 404 (`none_404` 179), a
      not-ready list (`none_empty` 121, real ones excluded), LoadNative after its waits (`none_native` 26), three 502s
      (`none_error` 17);
    - CC-on list asks during a hold (`list_ask_during_hold` 518); cs:3667 (`list_not_available` 41); a track given up
      after its waits (cs:3677, `track_gave_up` 14);
    - holds released out of pick order (#1029's path, `release_not_latest_pick` 1,079); stragglers 1,366; lookups
      looked up already 1,798;
    - with `FUZZ_TICKET_PIN=1`, a pick answered from its pin (`pick_answered_at_once` 487; 0 with the pin off, by design);
    - B4 judged (the visitor stayed, the playing video has no captions) on 335 of 2,000 seeds, and on 5 of the default
      60. (All counts re-run on 2026-11-23 after the round-2 fixes: unchanged.)
  - Not reached:
    - the copy's `'no tracks'` "No captions" (cs:3385): an empty list ends in "No captions" at cs:3655 first;
    - the `userTrack >= 0` half of cs:3667: only a track picked on the tablet (PickRow) sets it before the list, and
      that is not modelled;
    - `served_other_video` and `served_other_video_as_asked_ticket`: today's service labels every answer with the
      ticket whose video it looked up, so they count only a broken service (VB1-wrong-video: on 180 of 500 seeds);
    - cs:3640 (a non-JSON answer) and `no_track_in_language` (the fake has one track, asked by row 0): not in the copy
      or the fake.
  - Not covered by any promise: a "No captions" that never comes for a video that has none. Example: the verifier's
    `VR2b-nocaps-as-notready` (round 2), a service that answers a captionless video "not ready" instead of
    `no_captions`: no check fails on any of 500 seeds (B4 included). The visitor would see "Captions can't load right now" for good, and with
    opt2x and CC on the world asks the list again every slot. Why no promise sees it: B2 judges only a "No captions"
    that came, B1 and B3 judge only videos with captions, and B4 judges only what the world holds, and a world on
    "can't load right now" holds nothing. A converse of B2 for captionless videos would see it; adding one is the
    coordinator's call (it was left out of the round of 2026-11-23).
    (Another video's list held while the playing video has none, named here until 2026-11-23, is now B4.)
- **Checking the check** (2026-11-23, after verifier round 2's fixes; the batch reports have the patches and outputs):
  every check was seen failing on a broken variant, counted as the seeds it adds over its base (500 seeds, world opt2x
  unless named, stragglers off; the default 60 seeds in brackets):
  - V404none (the copy's opt2x without its 404 rule; today's service): B2 34 (4).
  - VB1-wrong-video (svcHeld answering the asked ticket with the last-played video's captions): B1 118 (14), and B4 30
    (0), all 30 B4 alone.
  - VB1-never-counted (svcNotReady2 that never counts the 302 path): B1 300 (38).
  - VB2-service-says-none (svcNotReady2's not-ready answer says `no_captions`): B1 174 (25), B3 106 (15). B2 cannot see
    it: it trusts the service's reason, by design.
  - VWccWaitsPicker (the copy with CC on asks the list only on a picker open; svcHeld): B3 7 (1), all 7 B3 alone, so B3
    sees what B1 does not. The weakest variant at the default 60.
  - VSFirstListNotReady and VSTwoListsNotReady (svcHeld whose first one or two list asks per ticket answer "not ready",
    whatever the sources hold): B3 55 (6) and 93 (12); with opt2xs 34 (3) and 98 (10); at 2,000 seeds 253 and 381
    (opt2x), 178 and 433 (opt2xs). Before the exclusion read the test's own records they added no failing seed at all.
  - droplist (the copy drops a good list when the play starts; svcHeld): B3 45 (7), B3 alone, opt2x and opt2xs.
  - keeplist (ForgetTracks keeps the old video's list across a pick; svcHeld): B4 26 (3), all 26 B4 alone; at 2,000
    seeds 89 (3). With today's service and copy: B4 16 of 500 without stragglers, 7 of 500 with them (the default
    run's setting), 0 of the default 60 either way: the default run does not see it, only a longer sweep does.
  - nostartask (opt2xs without its start ask; svcHeld): no check fails on any seed (every seed it moves is excused);
    only opt2xs's budget sees it, and only without stragglers: `FUZZ_PROMISES=1 FUZZ_WORLD=opt2xs FUZZ_OTHER=0`
    reports "excused 10 of 32 ... over its budget of 25 %" (66 of 249 at 500 seeds); without the variant 6 of 32 (39
    of 249), no budget line. With stragglers on it passes (7 of 38).
  - VPPinNotCounted (a pinned answer without `markPlayed`; `FUZZ_TICKET_PIN=1`): B1 37 (4) on today's service.

  The default 60 seeds are a smoke run (the weakest variants are caught by 0 to 3 of them); a change to the captions
  route or the ticket route also gets `FUZZ_PROMISES=1 FUZZ_SEEDS=2000` with the fix's copy variant.
- **A known limit of the svcNotReady2 option** (if #996's fix takes it): its "counted once" is keyed by shard and ticket,
  but tickets are reused round-robin (store.js). After the pool wraps, a reused ticket counts as counted already, so
  it is answered at once and its lookup runs before the count, which is what that option was chosen to avoid. Key it
  by ticket and video id, or clear it when the ticket is allocated; a restart empties it. This test (3 tickets, no reuse)
  cannot see that.
