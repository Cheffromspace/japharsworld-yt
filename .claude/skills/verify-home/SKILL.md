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
  with files, and drops the rest (allowing for the 30 s by which `#write` may lag `lastPutMs` in meta.json).
- **A2 the maps agree.** Every `sessions` entry sits under its own `id@quality` and is in `byToken`. An entry only in
  `byToken` (set aside by `start`, or a reloaded `cut_short`) is gone at the first `sweep` once nobody fetched it for 5
  min. The token folders on disk are exactly `byToken`'s. Each session's `mb` equals the bytes the test put. Each
  session's `state` (and `ended`, while not failed) agrees with the model (`#playlist`, `#checkEnded`, `put`, `giveUp`,
  `#fail`).
- **A3 the limits, at every start.** Real (not cached) builds per Chicago day <= `dailyBuilds` and the day's downloaded
  MB under `dailyMb` (`capped`, `limit`); real builds in the rolling hour <= `hourBuilds`; the hour's expected MB within
  `hourMb` unless the hour is empty or the video is `hourMbExemptSeconds` or longer (`blocks`); nothing over
  `itemMaxMb`; at least `startGapMs` since the last real build, except an AV1 play while not `hammering`; a worker
  online and its live streams <= its `mediaMax` (`worker`, `#active`). Stated exceptions it allows: a cache upload
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

**Drift points** (hand copies in the test that must follow the code): `expectedOf` is `#expectedMb` written out (it is
private, and `state()` rounds it to whole MB); the session model follows the rules of `#playlist`, `#checkEnded`, `put`
and `start`'s `.catch` (including SHORT_S); the constants PLAYING_MS, STALE_MS and the 30 s meta save are copied by name.
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
- `reload`, Everything-is-OK#1011: `#load` rebuilds sessions with `lastGetMs` 0 (`#session`; only a `cut_short` one is
  stamped), so a sweep after a restart can evict a finished session a player is on. Excused only for A1's played check
  (never the live-build one), and only for a session the latest restart reloaded and no player fetched since. Strict
  seeds: 1105, 1116.
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
test or delete it, run the sweep with `FUZZ_STRICT=1`, and update this list. The fix for `reload` also changes the test's
restart bookkeeping: the restart op stamps only reloaded failed sessions as played (`stamped`, as `#load` does today); a
fix that stamps reloaded ready sessions too needs the same there, or A4 fails on sessions Home rightly keeps as played
(verifier, 2026-11-23: 24 such seeds of 2,000, for example 1112).

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

A second seeded test, for Everything-is-OK#996. The service is the real `createApp` with a real `Store`; `playback` is
faked so a player's ticket request is held until the test lets it go, and `captions` answers as a failed lookup does
(`temporarily_unavailable`, no tracks) until the test lets its sources succeed. The real lookup awaits its sources and
answers that only when they found nothing, so the test's counts of that path are not frequencies. The world side is a
hand-written COPY of the world's caption-ask rule, so unlike pilot A it can drift from the code it stands for.

- **Promises.** B1: if the visitor stayed and the video has captions, the world ends holding the playing ticket's list
  (and lines, CC on). B2: "No captions" only follows an answer for that ticket that says `no_captions`.
- **Today both fail**, by three paths (each a recorded seed in `FAILS_TODAY`): three answers for another ticket (#996),
  a list asked with CC on whose lookup found no tracks yet (#996's item 4), and a 404 `nothing_playing` with CC on in a fresh
  shard. So the promises are `test.todo`, and a plain test asserts that the recorded seeds still fail: the file goes red
  when the code under it changes. `FUZZ_STRICT=1` runs the promises as plain tests.
- **When #996's fix lands**, its fixer: drops the `FAILS_TODAY` test, turns the two todos into plain tests (the strict
  test), and for a world-side fix changes the copy (or makes the matching `VARIANTS` entry the default) in the same batch
  as the C#; the world's own replay scenario must then pass in the test editor.
- **The copy and its drift.** It mirrors `Assets/EverythingIsOK/Scripts/EverythingIsOKYouTubeSearch.cs` in the world repo
  as read at world commit `eddf7f5a` (2026-11-22): lines 39 and 1405-1414 (only spacing, so not modelled), 390, 2079-2088,
  2258-2267, 3145-3150, 3329-3335, 3338-3388, 3544-3548, 3571-3575, 3635-3700, 3719-3723; each line of the copy names
  its `cs:N`. Before trusting a pass, check those lines are unchanged (`git log eddf7f5a..HEAD --` that file in the world
  repo); if they changed, re-read the copy against the new C#, line by line, and move the commit named here.
- **Service side covered:** `captionIn` in `src/server.js` (it answers for `store.lastPlayed`), the ticket route's
  `markPlayed` after the hold, and the store. A change there means a run of this file and of its strict form.
- **Run:** `node --test test/captions-hold.props.test.js` (60 seeds, about 3 s); `FUZZ_STRICT=1 FUZZ_SEEDS=2000` for the
  promises; `FUZZ_WORLD=opt2x` (say) for one of #996's options in the copy; `FUZZ_OTHER=0` without stragglers.
