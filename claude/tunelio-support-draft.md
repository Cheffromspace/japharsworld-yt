# Tunelio support case (2026-10-24)

Sent by the owner from their Gmail to support@tunelio.dev at about 2026-10-24 23:20 UTC. The draft message below went
unchanged except the sign-off ("Jonathan, Everything is OK"). The reply goes to the owner's inbox. Sources: the search service's journal on the Linode (events
`tunelio_link`, `tunelio_probe`, `build_failed`, `tunelio_error`, `play`; detailed build logging starts 2026-10-19 and
the hourly probe 2026-10-22) and `metrics.db`. All times UTC, with Chicago time (CDT, UTC-5) where it matters. The
example video IDs are from our own speed probe, which picks public videos from generic searches ("documentary",
"lecture", …). None of them is a visitor's play, and nothing here identifies a visitor.

## Evidence summary

**What we call.** `GET /create?url=&quality=` (360p/720p/1080p, progressive mp4 or HLS), then the player (or our
probe) opens the tunnel link. "Build time" below is from the /create answer to the first byte of the mp4, or to the
HLS playlist and its first segment.

**/create itself is fast.** Probe /create answers: p50 0.9 s, p90 1.8–2.5 s, max 5.6 s (132 runs, 10-22 → 10-24).
There were two /create timeouts at our 12 s limit: 10-23 16:02:13Z and 16:09:44Z (11:02 and 11:09 CDT).

**Build times, fresh builds only.** Links Tunelio already had (under 3 s, or over 120 MB/s) are excluded.

| UTC day | builds | p50 | p90 | max |
|---|---|---|---|---|
| 10-20 | 16 | 21.2 s | 32.9 s | 37.7 s |
| 10-21 | 15 | 12.7 s | 64.8 s | 115.7 s |
| 10-22 | 29 | 8.1 s | 33.9 s | 97.1 s |
| 10-23 | 40 | 6.8 s | 53.8 s | 84.1 s |
| 10-24 | 7 | 8.7 s | 19.6 s | 19.6 s |

Probe time to first byte, the same test every hour:

| UTC day | runs | p50 | p90 | failed |
|---|---|---|---|---|
| 10-22 | 55 | 5.0 s | 26.4 s | 3 (age-restricted, expected) |
| 10-23 | 50 | **29.9 s** | **115.2 s** | 10 (6 timeouts + 4 age-restricted) |
| 10-24 | 27 | 10.4 s | 29.5 s | 1 (age-restricted) |

**Slowness tracks the time window more than size.**
- Probes of the same size class (500–1000 MB):
  - 10-22: 0 of 3 failed, 0 slow.
  - **10-23: 6 of 13 failed and 9 took over 60 s.**
  - 10-24: 0 of 3 failed, 1 slow.
- **The slow window was 10-23 01:37Z to about 17:34Z** (10-22 20:37 CDT to 10-23 12:34 CDT), about 16 hours. Inside it:
  - a 330 MB build took 76 s;
  - 358 MB builds took 66 s and 95 s;
  - several 540–1000 MB builds failed.
- Outside it, 500–700 MB builds finished in 10–60 s.
- Larger files are slower in absolute terms, but per MB the large ones were not slower on good days:
  - over 1 GB: p50 64 MB/s;
  - 300–1000 MB: p50 40 MB/s.

**Failures end at fixed times, which looks like a timeout on your side or your proxy's, not a real failure of the file.**
- **Progressive mp4: HTTP 503 at about 115 s.** For example, probes on 10-23:

  | UTC time | video ID | quality | size |
  |---|---|---|---|
  | 05:57:40Z | G24aRVSYVzM | 720p | 640 MB |
  | 07:42:45Z | I8C2mdX7G2w | 1080p | 1000 MB |
  | 11:02:47Z | vNR9QjmhH00 | 1080p | 607 MB |
  | 12:42:46Z | l6N8dYQfZJ4 | 1080p | 540 MB |

  Visitor builds of 0.7–1.3 GB failed the same way at 115–118 s on 10-20, 10-21 and 10-23.
- **HLS: HTTP 524 at about 125 s.** That's Cloudflare's origin timeout. For example: probes on 10-23 at 02:53:24Z
  (YhUiptupV7A, 1080p, 966 MB) and 12:17:56Z (pM62egsJxmM, 1080p, 948 MB), and a 720p 1.6 GB build on 10-24 at
  19:12:55Z.
- **HLS: failed at exactly 62.87 s three times, on 1080p and 720p builds of 344–710 MB,** on 10-23 between 19:14:42Z
  and 19:22:25Z (14:14–14:22 CDT). We didn't log the status then; we do now.
- **Count of build failures in the journal (10-20 → 10-24):**
  - 14 timeouts of these kinds;
  - 2 /create timeouts;
  - 1 instant failure: a 6 GB, 10-hour HLS.

  Age-restricted 404s are expected, not counted.

**Our usage.**
- Builds at once:
  - visitors' plays: one at a time, or two to three for one video (an adaptive play builds 720p and 1080p together);
  - our probe: one build an hour, or a 720p + 1080p pair every third run, and only while no visitor build is running.
- No automatic retries of a failed build. After a failure the play falls back to youtube.com, or to our own relay.
- Volume: about 1–40 builds a day.
- Credits: about 96,000 left (2026-10-24), and the plan renews on the 1st.
- We don't use /transcript any more (captions come from elsewhere), so there's no transcript latency to report.

## Draft message

> Subject: Slow and failing builds in long windows (503 at ~115 s, 524 at ~125 s), 2026-10-20 to 10-24
>
> Hello,
>
> We run the video backend for "Everything is OK", a VRChat world where visitors search YouTube and play videos on a
> shared screen. We call `/create` on demand (360p/720p/1080p, progressive mp4 and HLS) and hand the tunnel link to the
> in-world player. A visitor waits for the build, so build time is what they experience.
>
> What we see:
>
> - `/create` itself is fast: median 0.9 s, worst 5.6 s, over 132 hourly test runs from 2026-10-22 to 10-24. It timed
>   out only twice, at our 12 s limit: 2026-10-23 16:02:13 and 16:09:44 UTC.
> - The time to the first byte of the link varies a lot by time window. Our hourly test, the same kind of video each
>   time, took a median of 5.0 s on 10-22 and 10.4 s on 10-24. On 10-23 it took a median of 29.9 s, the 90th percentile
>   was 115 s, and 6 of 13 builds of 500–1000 MB failed. The slow window ran from about 01:30 to 17:30 UTC on 10-23.
>   The same sizes built in 10–60 s outside it.
> - Failures end at fixed times, which looks like a timeout rather than a failed file:
>   - Progressive mp4: HTTP 503 after about 115 s. Examples on 2026-10-23:
>     - 05:57:40 UTC: video G24aRVSYVzM, 720p, about 640 MB
>     - 07:42:45 UTC: I8C2mdX7G2w, 1080p, about 1000 MB
>     - 11:02:47 UTC: vNR9QjmhH00, 1080p, about 607 MB
>   - HLS: HTTP 524 after about 125 s. Examples:
>     - 2026-10-23 02:53:24 UTC: YhUiptupV7A, 1080p, about 966 MB
>     - 2026-10-23 12:17:56 UTC: pM62egsJxmM, 1080p, about 948 MB
>   - HLS: three builds of 344–710 MB failed after exactly 62.9 s, between 19:14 and 19:22 UTC on 2026-10-23.
>
> We expected builds of this size to take 10–60 s, as they do most of the time. Where a build will take longer, we'd
> rather get a status we can poll than a 503 or 524 after two minutes.
>
> Our load is small: one to three builds at once, and one test build an hour. We don't retry failed builds
> automatically, and we have about 96,000 credits on our plan.
>
> Questions:
>
> 1. Are there known capacity windows or maintenance periods? Was anything happening on 2026-10-23 between about
>    01:30 and 17:30 UTC?
> 2. Is there a status page or incident feed we can watch?
> 3. What are the 503 at about 115 s and the 524 at about 125 s: a proxy timeout while the file is still building? Does
>    the build carry on after that, so that opening the link again later would work? And what is the 62.9 s cutoff?
> 4. Is there a way to know when a build is ready without holding a request open? For example a status endpoint, or
>    a HEAD request that answers at once.
> 5. Is there a priority, higher-concurrency or faster tier for on-demand use like ours?
> 6. What retry behaviour do you recommend after a 503 or 524: retry the same link, or call /create again (and is a
>    repeat /create charged)?
>
> Thank you,
> [owner's name], Everything is OK
