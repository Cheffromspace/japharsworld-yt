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
node --test test/home.props.test.js                    # 100 seeds x 150 steps, about 3 s; part of npm test and CI
FUZZ_SEEDS=2000 node --test test/home.props.test.js    # the sweep: one process, about 1 min, prints reach counts
FUZZ_SEED=1234 node --test test/home.props.test.js     # one seed; a failure prints its shrunk ops and this command
FUZZ_STRICT=1 node --test test/home.props.test.js      # no exclusions: the open findings below fail again
FUZZ_STEPS=400 FUZZ_SEEDS=500 node --test test/home.props.test.js   # longer sequences
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
  `flush`; reach `crash`): after one, and only for a session it reloaded and no player fetched since, the last fetch
  may count as up to 30 s older (GET_SAVE_MS, `file()` writes it at most that often; reach `crash_lag_allowed`).
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
  `other`, `isUneven`, `markUneven`; `load()` and `state()`; the HTTP routes in `src/server.js` that call `Home`.

Bounds: 150 steps per sequence, 100 seeds in `npm test`, 2,000 in a sweep. Sizes are scaled down so the limits bite in a
few steps: segments 20-150 KB, videos 1-5 s with 2-6 segments of 4 s, `maxGb` 1.5-3 MB, `freeFloorGb` 0-2 MB, a disk
of 4-10 MB, `dailyMb` 0.3, 0.8 or 2-10 MB, two media workers taking 1-3 streams. The fake worker sends only what `relay/media.js` sends: the whole
predicted playlist or a growing one that only grows, never both, then one closing playlist (every segment, or cut back
to those sent in order, `closedAt`), after which its stream uploads nothing more.

**Directed:** the seeds ending in 0 and in 5 also run a second sequence that opens with a set script, then that seed's
random ops (the plain sequence of every seed is unchanged). Ending in 0, 'edge': a finished copy from the worker's
cache, two player fetches 10-55 s apart, a crash or a clean restart, the longest video's start 3.9 min after the last
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
(for example `FUZZ_KNOWN=reload,midnight FUZZ_SEEDS=2000` for recached).

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
none of the 13 variants has slipped past.

## Moving the coverage commit

Move it only after (1) re-reading every function listed under the coverage at the new commit and confirming the
properties and the drift points still describe them, (2) `FUZZ_SEEDS=2000 node --test test/home.props.test.js` passing
(or failing only on the open findings above), and (3) recording the new commit here in the same commit as any test
change. A diff that changes `src/home.js` and leaves this unchanged says why in its message.

**Coverage commit:** `9259b0b` (src/home.js blob `fbdd29791325e3a35608f5655d9352cc81ce5039`), confirmed 2026-11-22.

## Pilot B: captions around a held play (test/captions-hold.props.test.js)

A second seeded test, for Everything-is-OK#996. The service is the real `createApp` with a real `Store`. `playback` is
faked so a player's ticket request is held until the test lets it go. `captions` answers as a failed lookup does
(`temporarily_unavailable`, no tracks) until the test lets its sources succeed. The real lookup awaits its sources and
answers that only when they found nothing, so the test's counts of that path are not frequencies. Some videos are looked
up already when a sequence starts. Some have faults: a lookup that throws (the route's 502) and a track fetch that fails
while the list is there. Each video has its own track code and line text, kept in the test's own table. The world side
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
- **The open finding "nopicker"** (#996; its own `test.todo`; strict seed 999). After a list answer that is not usable
  (not ready, a 404 or 502, or for another ticket), the world asks again only on a picker open (cs:3653, cs:3378;
  the #166 design). So a visitor who does nothing ends on "Captions can't load right now". It is B3's one exclusion,
  for that end state only: no list, no "No captions", the test's log showing the last ask for this ticket unusable and
  nothing asked after it. The excused seeds are split into (a), answered during the hold, and (b), after the count.
  Budget: `NOPICKER_BUDGET` (half of the judged seeds per sweep), applied from `NOPICKER_MIN_JUDGED` (20) judged seeds, so a
  one-seed rerun is not read as over budget. The highest honest cell on 2026-11-23 was 37.6 % over 500 seeds (svcNotReady2
  with opt2x and stragglers), and 16 of 42 judged at the default 60 seeds.
  It does NOT excuse a false "No captions", another video's captions, or a world that never asked.
- **Today all three fail**, each path a recorded seed in `FAILS_TODAY`, run with explicit options so no switch moves
  them:
  - three answers for another ticket (#996; 1010);
  - a list asked with CC on whose lookup found nothing yet (#996's item 4; 1069);
  - a 404 `nothing_playing` with CC on in a fresh shard (1042);
  - a track that keeps failing, LoadNative after its waits (cs:3675-3678; 1170);
  - a list ask that errors three times (cs:2264-2266; 1027);
  - B1 by #996's path (1016);
  - B3 strict, "nopicker" (999).
  So the promises are `test.todo`, and a plain test asserts that the recorded seeds still fail: the file goes red
  when the code under it changes.
- **When #996's fix lands**, its fixer drops the `FAILS_TODAY` test and turns the todos into plain tests (today's
  `FUZZ_PROMISES=1` run, with `nopicker` kept as long as the #166 design stays). For a world-side fix they change the
  copy (or make the matching `VARIANTS` entry the default) in the same batch as the C#, and the world's own replay
  scenario must then pass in the test editor.

| Switch | What it does | In the default `npm test` run? |
|---|---|---|
| (none) | the `FAILS_TODAY` seeds, then a 60-seed sweep of today's copy that must still fail B1 and B2 somewhere (diagnostic counts for B3) | yes, the only test that runs |
| `FUZZ_PROMISES=1` | runs B1, B2, B3 as plain tests with the known exclusions, plus the `nopicker` budget | no |
| `FUZZ_STRICT=1` | the same with no exclusion: B3 counts every judged seed | no |
| `FUZZ_KNOWN=a,b` | the exclusions to keep (default `nopicker`; empty keeps none) | default `nopicker` |
| `FUZZ_WORLD=today\|opt1\|opt1x\|opt2\|opt2x\|opt2xs` | the copy's variant: #996's options (`VARIANTS` in the file) | `today` |
| `FUZZ_OTHER=0` | no stragglers | stragglers on |
| `FUZZ_FAULTS=0` | no faults (no 502 lookups, no failing track fetches) | faults on |
| `FUZZ_TICKET_PIN=1` | TICKET_PIN on; the fake's `peek` answers a ready build, so a played ticket picked again is answered from its pin | off |
| `FUZZ_SEED`, `FUZZ_SEEDS`, `FUZZ_STEPS` | the seed range and length | 996, 60 seeds, 16 steps |

- **Run:** `node --test test/captions-hold.props.test.js` (60 seeds, about 3.6 s); `FUZZ_PROMISES=1 FUZZ_SEEDS=2000
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
    - with `FUZZ_TICKET_PIN=1`, a pick answered from its pin (`pick_answered_at_once` 487; 0 with the pin off, by design).
  - Not reached:
    - the copy's `'no tracks'` "No captions" (cs:3385): an empty list ends in "No captions" at cs:3655 first;
    - the `userTrack >= 0` half of cs:3667: only a track picked on the tablet (PickRow) sets it before the list, and
      that is not modelled;
    - `served_other_video` and `served_other_video_as_asked_ticket`: today's service labels every answer with the
      ticket whose video it looked up, so they count only a broken service (VB1-wrong-video: on 180 of 500 seeds);
    - cs:3640 (a non-JSON answer) and `no_track_in_language` (the fake has one track, asked by row 0): not in the copy
      or the fake.
  - Not covered by any promise: another video's list held while the playing video has no captions. B1 and B3 apply
    only when it has captions, and B2 only to a "No captions". Under VB1-wrong-video this was 33 of the 78 seeds that
    served another video's content and failed nothing (the other 45: the visitor left, the list was for a ticket no
    longer playing, or it was replaced before the end). Widening B1 to it would change the promise: the coordinator's
    call.
- **Checking the check** (2026-11-23, the batch report has the patches and outputs): every check was seen failing on a
  broken variant, counted over 500 seeds as the seeds it adds over its base (the default 60 seeds in brackets):
  - V404none (the copy's opt2x without its 404 rule; today's service): B2 34 (4).
  - VB1-wrong-video (svcHeld answering the asked ticket with the last-played video's captions): B1 121 (14).
  - VB1-never-counted (svcNotReady2 that never counts the 302 path): B1 321 (41), and the `nopicker` budget (249 of 319
    judged seeds excused).
  - VB2-service-says-none (svcNotReady2's not-ready answer says `no_captions`): B1 192 (28), B3 147 (21). B2 cannot see
    it: it trusts the service's reason, by design.
  - VWccWaitsPicker (the copy with CC on asks the list only on a picker open; svcHeld): B3 13 (2), on 6 of them B3 alone,
    so B3 sees what B1 does not.
  - VSTwoListsNotReady (svcHeld whose first two list asks per ticket answer "not ready"): the `nopicker` budget: 172 of
    319 judged seeds excused (22 of 40 in the default 60). Its one-ask form excuses 132 of 319 (41 %) and stays under:
    the budget catches a large shift, not a small one.
  - VPPinNotCounted (a pinned answer without `markPlayed`; `FUZZ_TICKET_PIN=1`): B1 37 (4) on today's service. Under
    svcNotReady2 it changes nothing: that option never reads `lastPlayed` for an asked ticket counted before.

  The default 60 seeds are a smoke run (the weakest variants are caught by 2 to 4 of them); a change to the captions
  route or the ticket route also gets `FUZZ_PROMISES=1 FUZZ_SEEDS=2000` with the fix's copy variant.
- **A known limit of the svcNotReady2 option** (if #996's fix takes it): its "counted once" is keyed by shard and ticket,
  but tickets are reused round-robin (store.js). After the pool wraps, a reused ticket counts as counted already, so
  it is answered at once and its lookup runs before the count, which is what that option was chosen to avoid. Key it
  by ticket and video id, or clear it when the ticket is allocated; a restart empties it. This test (3 tickets, no reuse)
  cannot see that.
