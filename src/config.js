// All settings come from the environment (see deploy/japharsworld-yt.env.example).
// VIDEO_MAX_HOURS as seconds: only an explicit 0 turns the cap off; empty or garbage keeps the default, so a typo in the
// env file can't silently let every length through.
export const videoMaxSeconds = (raw, fallbackHours = 12) => Math.round((/^\s*\d+(\.\d+)?\s*$/.test(raw ?? '') ? Number.parseFloat(raw) : fallbackHours) * 3600);

import { HOUR_CREDITS, HOME_FIRST_PERCENT } from './spend.js';

const int = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
};

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: int('PORT', 8790),
  // Baked into the world: changing these needs a world re-upload with regenerated URLs.
  shards: int('SHARDS', 8),
  pool: int('POOL', 2000),
  // A video ticket that has been played stays bound to its video this long (late joiners).
  pinHours: int('PIN_HOURS', 24),
  resultsPerPage: int('RESULTS_PER_PAGE', 20),
  // Every /s request, text searches and a pasted link's player loads alike. One age-restricted play is about 20 from one
  // client (about 10 an attempt, tried twice); at 20 a minute two clients on one IP got 429 on the next good video
  // (TEST, 2026-11-01, world #450). This never bounded Tunelio credits, because tickets aren't counted; a pasted link's /s
  // also plays through ticket(), so it can spend credits and start home yt-dlp jobs too.
  // More pages count against it too (429 rate_limited).
  searchesPerMinutePerIp: int('SEARCHES_PER_MINUTE', 60),
  // Ticket requests a minute per client IP (status, player, sheet, More; 429 rate_limited over it). VRChat lets a
  // client load one string and one image per 5 s (24 a minute) plus a few loads per play, so 120 is ~5x a real one.
  ticketsPerMinutePerIp: int('TICKETS_PER_MINUTE_PER_IP', 120),
  // A video player's ticket loads a minute per client IP, counted apart (429 rate_limited over it, which the world shows
  // as a load error): 6 players behind one NAT, each resolver + player + a Quest's retry every 6 s, is ~150, so 600.
  ticketPlayerPerMinutePerIp: int('TICKET_PLAYER_PER_MINUTE_PER_IP', 600),
  // Play outcomes (/v1/o, world #274) a minute per client IP; over it the answer is the same and nothing is counted or
  // logged. Each client sends one per play, so even several players behind one NAT stay far under 30. 0 = no per-IP limit.
  outcomePerMinutePerIp: int('OUTCOME_PER_MINUTE_PER_IP', 30),
  // Each visitor's (client IP's) daily allowance for new builds, Tunelio and home together (src/allowance.js, where the
  // defaults are worked out from prod): Tunelio credits, home sessions, home MB (expected size). Any one used up: no new
  // build anywhere, the play gets youtube.com. 0 = no limit. Trusted IPs x TRUSTED_IP_FACTOR.
  allowanceCreditsPerIp: int('ALLOWANCE_CREDITS_PER_IP', 1500),
  allowanceHomeBuildsPerIp: int('ALLOWANCE_HOME_BUILDS_PER_IP', 25),
  allowanceHomeMbPerIp: int('ALLOWANCE_HOME_MB_PER_IP', 60_000),
  dbPath: process.env.DB_PATH ?? 'data/tickets.db',
  ytdlp: process.env.YTDLP ?? 'yt-dlp',
  ytdlpExtraArgs: (process.env.YTDLP_ARGS ?? '').split(' ').filter(Boolean),
  captionCacheDays: int('CAPTION_CACHE_DAYS', 7),
  captionEmptyMinutes: int('CAPTION_EMPTY_MINUTES', 30), // a video's empty caption list is kept this long (src/captionchain.js)
  // Captions come from a chain of sources (src/captionchain.js): a relay worker's yt-dlp, then yt-dlp on this
  // server when CAPTION_LOCAL_YTDLP=on (YouTube usually bot-walls the Linode, and a refused attempt is slow), then
  // Tunelio. RELAY_CAPTION_WAIT_MS is how long a worker gets for one video (two yt-dlp runs).
  captionLocalYtdlp: (process.env.CAPTION_LOCAL_YTDLP ?? 'off') === 'on',
  relayCaptionWaitMs: int('RELAY_CAPTION_WAIT_MS', 40_000),
  // on: a track without real word timing (uploader tracks, Tunelio) sends no word offsets, so the world shows no
  // spoken-word highlight instead of one spread by character count (world #260; turn on with the world update).
  captionRealWordsOnly: (process.env.CAPTION_REAL_WORDS_ONLY ?? 'off') === 'on',
  // A routed IPv6 /64 of our own (e.g. 2600:3c06:e001:35e::/64). When set, each yt-dlp lookup goes out from a
  // random address in it. The box must accept that: see README, "Sending from your own IPv6 range".
  sourcePrefix: process.env.SOURCE_IPV6_PREFIX ?? '',
  // After YouTube refuses every attempt ("Sign in to confirm you're not a bot"), captions answer
  // "not available" for this long without asking again.
  blockedMinutes: int('BLOCKED_MINUTES', 10),
  // Tunelio (hosted YouTube media API) for HD playback of ordinary videos and for captions. Without a key, played
  // tickets go to youtube.com (360p in VRChat) and captions use yt-dlp.
  tunelioKey: process.env.TUNELIO_API_KEY ?? '',
  // Default playback quality (owner, 2026-10-22: 720p for now; builds are about half as long and the difference is
  // hard to see on the wall screen). A room can pick another of TUNELIO_QUALITIES on its tablet (/v1/<shard>/q/<p>),
  // kept for QUALITY_HOURS.
  tunelioQuality: process.env.TUNELIO_QUALITY ?? '720p',
  tunelioQualities: (process.env.TUNELIO_QUALITIES ?? '720p,1080p').split(',').map((s) => s.trim()).filter((s) => /^\d{3,4}p$/.test(s)),
  qualityHours: int('QUALITY_HOURS', 12),
  // Adaptive HLS (src/adaptive.js): start at the default quality, step up to the best of TUNELIO_QUALITIES when its
  // build is ready, paced so the credits last to renewal with ADAPTIVE_RESERVE to spare. ADAPTIVE_HLS=on turns it on,
  // for the shards in ADAPTIVE_SHARDS only (comma separated; empty = all) while it is being tried.
  adaptiveHls: (process.env.ADAPTIVE_HLS ?? 'off') === 'on',
  adaptiveShards: (process.env.ADAPTIVE_SHARDS ?? '').split(',').map((s) => Number.parseInt(s, 10)).filter(Number.isInteger),
  adaptiveReserve: int('ADAPTIVE_RESERVE', 5000),
  // How long a not-yet-built upper rung's playlist request is held before its 404. 1 s: held 8 s, AVPro stalled the
  // lower rung's picture every 8 s (owner's A/B, 2026-10-23, #104).
  adaptiveHoldMs: int('ADAPTIVE_HOLD_SECONDS', 1) * 1000,
  // The mid-video 720p → 1080p step up. Off: a 1080p build predicted too slow means 720p for that video (switching froze
  // the picture in VRChat on PC in 2 of 4 tries, 2026-10-22).
  adaptiveSwitch: (process.env.ADAPTIVE_SWITCH ?? 'off') === 'on',
  // Play 1080p at once (no adaptive playlist) when its build is predicted to take at most this long (~15–18 s to the
  // picture with VRChat's own ~5–8 s).
  adaptiveDirectSeconds: int('ADAPTIVE_DIRECT_SECONDS', 10),
  // A quick first rung for adaptive plays (e.g. 360p; empty = off): used when the 720p HLS build is predicted to take
  // more than ADAPTIVE_START_SECONDS, so the picture starts on the small build and steps up (10 more credits per play).
  adaptiveStart: /^\d{3,4}p$/.test(process.env.ADAPTIVE_START ?? '') ? process.env.ADAPTIVE_START : null,
  adaptiveStartSeconds: int('ADAPTIVE_START_SECONDS', 10),
  // A start play lists 720p between the start rung and 1080p always (on: 360p → 720p → 1080p) or only when the 1080p
  // build is predicted to take over ADAPTIVE_START_STEP_SECONDS (off, the default since 2026-10-23, #104: else one
  // switch, 360p → 1080p).
  adaptiveStartMid: (process.env.ADAPTIVE_START_MID ?? 'off') === 'on',
  adaptiveStartStepSeconds: int('ADAPTIVE_START_STEP_SECONDS', 30),
  // This service's public address, for links it hands out (the adaptive master playlist).
  publicUrl: (process.env.PUBLIC_URL ?? 'https://yt.japharsworld.com').replace(/\/$/, ''),
  // Build time follows file size (~17 ms per MB, 2026-10-19). A 1080p file above TUNELIO_MAX_MB is made again at
  // TUNELIO_LOWER_QUALITY (10 more credits, about half the wait); a file above TUNELIO_PROGRESSIVE_MAX_MB, or a video
  // longer than TUNELIO_PROGRESSIVE_MAX_MINUTES, is served as HLS instead of a progressive mp4. Until 2026-10-27 that
  // was 1800 MB / 180 min, because Tunelio built a progressive file whole first. Since its fix of 2026-10-25 07:38 UTC
  // a progressive file streams once its layout is known (Tunelio: 1.6–4.5 GB start in 17–25 s), while an HLS playlist
  // still answers only after the whole build and a build cut off at ~125 s (524) is thrown away: both long-video
  // build failures of 10-26/27 were HLS (1 h, and 3.3 h / 3.8 GB at 720p), so long and large files stay progressive.
  tunelioLowerQuality: process.env.TUNELIO_LOWER_QUALITY ?? '720p',
  // Longest video played, in hours; over it every platform gets too_long with no /create or home build, live streams
  // exempt, unknown length as usual. 0 = off, nothing else is. Owner, 2026-11-01: 14 h unless Tunelio can't reach that, then the longest
  // that works. Staging bracket, 2026-10-31, 8 h to 24 h: 43200 s built; everything longer got /create 413 except two
  // videos of 14.00 h, which /create accepted and whose files never gave a first byte (413, or 503/524 for 8 min).
  videoMaxSeconds: videoMaxSeconds(process.env.VIDEO_MAX_HOURS),
  tunelioMaxMb: int('TUNELIO_MAX_MB', 1500),
  progressiveMaxMb: int('TUNELIO_PROGRESSIVE_MAX_MB', 6000),
  progressiveMaxSeconds: int('TUNELIO_PROGRESSIVE_MAX_MINUTES', 720) * 60,
  lowCredits: int('TUNELIO_LOW_CREDITS', 5000),
  // How long a played ticket may keep VRChat's resolver (yt-dlp, 20 s socket timeout) waiting for a Tunelio build
  // before answering it with a quick "not a video" page so VRChat hands the URL to AVPro, which is then held until the
  // build is ready (up to TICKET_PLAYER_HOLD_SECONDS, then youtube.com). See playback.js.
  ticketResolverHoldMs: int('TICKET_RESOLVER_HOLD_SECONDS', 12) * 1000,
  ticketPlayerHoldMs: int('TICKET_PLAYER_HOLD_SECONDS', 90) * 1000,
  // Day of the month the Tunelio plan renews and its credits refresh (the credits forecast counts from it).
  tunelioRenewsDay: int('TUNELIO_RENEWS_DAY', 1),
  // Minutes between Tunelio speed probes (src/probe.js; 10 credits each, at least 20, plus a random quarter). 0 = off.
  // Hourly (owner, 2026-10-23): every 20 minutes cost ~720 credits a day, more than playback's 80–450.
  tunelioProbeMinutes: int('TUNELIO_PROBE_MINUTES', 60),
  // Minutes of paced read-and-resume after each progressive probe run (Everything-is-OK#361; no credits, up to 270 MB
  // inbound per 10 minutes). 0 = off, and off until the owner's go on prod.
  tunelioDropMinutes: int('TUNELIO_DROP_MINUTES', 0),
  // Tunelio's /create timeout, and how long after a Tunelio timeout plays go home (when they can) instead of to Tunelio.
  tunelioCreateTimeoutMs: int('TUNELIO_CREATE_TIMEOUT_SECONDS', 6) * 1000,
  tunelioSuspectMs: int('TUNELIO_SUSPECT_SECONDS', 120) * 1000,
  // Tunelio builds running at once past which new plays go home first while home has a free stream (src/server.js
  // homeWhy, tunelio_busy; 0 = never). The busiest real minute had 9 builds (prod 2026-10-31); not measured against
  // Tunelio's own limits: a point to spread the load at, not a cap.
  tunelioBusyBuilds: int('TUNELIO_BUSY_BUILDS', 8),
  // The probe's own quality (2026-10-22: it followed TUNELIO_QUALITY, so it measured 720p while Auto decides whether
  // 1080p is fast enough).
  tunelioProbeQuality: process.env.TUNELIO_PROBE_QUALITY ?? '1080p',
  // Player test slot refills a day through POST /ops/slots/refill (src/slots.js; 20 credits each, 0 = off).
  slotRefillsPerDay: int('SLOT_REFILLS_PER_DAY', 6),
  // Comma-separated ISO 15924 scripts the world can draw captions in.
  captionScripts: (process.env.CAPTION_SCRIPTS ?? 'Latn,Cyrl,Hans,Hant,Jpan,Kore,Thai,Hebr').split(',').map((s) => s.trim()).filter(Boolean),
  // Discord webhook for alerts (Tunelio out of credits, failing, running low).
  alertWebhook: process.env.ALERT_WEBHOOK ?? '',
  // Search relay: workers (the owner's Optiplex) long-poll /relay/next with this bearer token. Empty = relay off.
  relayToken: process.env.RELAY_TOKEN ?? '',
  relayWaitMs: int('RELAY_WAIT_MS', 8000),
  // Minutes without any worker before the "no search worker" alert.
  relayIdleAlertMinutes: int('RELAY_IDLE_ALERT_MINUTES', 10),
  // The home relay's throwaway-account cookies (Everything-is-OK#575, src/cookiewatch.js): Discord asks for a new sign-in
  // at most once per this many hours. 0 = never.
  cookieNudgeHours: int('COOKIE_NUDGE_HOURS', 12),
  // Home relay playback (src/home.js, relay/media.js): a relay worker with ffmpeg streams the video from the home
  // connection as HLS. Tunelio stays first while today's credits are within the pacer's allowance; home serves when they
  // aren't, when Tunelio is off or failing, and for videos of HOME_LONG_MINUTES and longer (Tunelio's build time grows
  // with the file and fails at ~115 s; home starts in seconds whatever the length). PC players only: Android can't open
  // HLS behind a ticket. HOME_DAILY_BUILDS / HOME_DAILY_MB cap what the home IP downloads a day (YouTube may flag it).
  homeRelay: (process.env.HOME_RELAY ?? 'off') === 'on',
  // Hold a player up to this long for a home session's playlist to finish when it is due that soon (src/home.js settle).
  homeSettleMs: int('HOME_SETTLE_SECONDS', 10) * 1000,
  // A PC player on a ready but still growing home session of a video this long (hours) stays on it instead of waiting
  // for Tunelio (src/server.js leaveHome, Everything-is-OK#577). 0 = off.
  homeStayHours: (() => { const v = Number.parseFloat(process.env.HOME_STAY_HOURS ?? ''); return Number.isFinite(v) ? v : 3; })(),
  // The home relay for .m3u8 tickets too (the world's Android build: Quest opens HLS behind those), by the same rules
  // as a PC player, and for an AV1 Tunelio build, which the Quest 2 can't decode (home is always H.264). Off until
  // verified on the Quest (2026-10-23).
  homeAndroid: (process.env.HOME_ANDROID ?? 'off') === 'on',
  // A PC player on a plain ticket: the codec of its progressive Tunelio build is read first, and an AV1 one goes home
  // (else the 720p rung, else youtube.com) instead of to the player (src/server.js, Everything-is-OK#741, staging
  // 2026-11-13: a PC alone got the AV1 1080p mp4 and never showed a frame). off: as before, no read.
  pcAv1: (process.env.PC_AV1 ?? 'on') !== 'off',
  // Everything-is-OK#749: the same read for a Quest on a plain ticket; AV1 gets the first of QUEST_AV1_QUALITIES (each read)
  // that isn't AV1, else "can't be played here". QUEST_AV1_QUALITIES empty: straight to that answer.
  questAv1: (process.env.QUEST_AV1 ?? 'on') !== 'off',
  questAv1Qualities: (process.env.QUEST_AV1_QUALITIES ?? '480p,360p').split(',').map((q) => q.trim()).filter((q) => /^\d{3,4}p$/.test(q)),
  // A .m3u8 ticket (Quest): Unity's Android player gets the mp4, and a long or HLS-failed play sends AVPro on at once so
  // VizVid reaches that player (src/server.js questMp4, Everything-is-OK#584). off: as before. Long: this many minutes,
  // or a file at the ticket's quality of this many MB once its size is known (0 = by length only).
  questMp4: (process.env.QUEST_MP4 ?? 'on') !== 'off',
  questMp4MinMinutes: int('QUEST_MP4_MIN_MINUTES', 60),
  questMp4MinMb: int('QUEST_MP4_MIN_MB', 1000),
  // A .m3u8 ticket (Quest) keeps its home session while the playlist still grows, instead of the give-up to Tunelio
  // for uneven keyframes, which exists for PC Media Foundation (#127); such a playlist then also starts at 0 exactly
  // (EXT-X-START PRECISE=YES), since ExoPlayer starts a playlist without ENDLIST at the live edge. Off: being tested on
  // staging (world #250, 2026-10-27): the Quest's Tunelio HLS fallback for those videos failed at ~125 s on prod.
  homeAndroidGrowing: (process.env.HOME_ANDROID_GROWING ?? 'off') === 'on',
  // A .m3u8 ticket's Tunelio build still running after this many seconds also starts the home stream, and the player
  // gets whichever is ready first (Everything-is-OK#398). 0 = off: this puts more Quest plays on a growing playlist, so
  // it stays off until the fix for #393 is out.
  homeRaceMs: int('HOME_RACE_SECONDS', 0) * 1000,
  homeLongMinutes: int('HOME_LONG_MINUTES', 30),
  // One source per ticket once playing (#293): a ticket's answer is kept per ticket and client kind while it is played
  // (until the video's length plus TICKET_PIN_MARGIN_MINUTES after its last play) instead of decided again on every
  // request, which sent one PC ticket home → Tunelio → home within a minute and its players reloaded from 0 (prod
  // 2026-10-28). Off: staging first.
  ticketPin: (process.env.TICKET_PIN ?? 'off') === 'on',
  // A pasted link's lookup warms the video (Everything-is-OK#449); off only with LOOKUP_WARM=off.
  lookupWarm: (process.env.LOOKUP_WARM ?? 'on') !== 'off',
  // Uncached lookup warms a minute (10 Tunelio credits each), per IP and in all; cached and home builds don't count.
  lookupWarmsPerMinutePerIp: int('LOOKUP_WARMS_PER_MINUTE_PER_IP', 3),
  lookupWarmsPerMinute: int('LOOKUP_WARMS_PER_MINUTE', 10),
  // Spend limits on paid Tunelio builds (src/spend.js, where the defaults are worked out from real spend and the 100k a
  // month plan): credits per rolling hour, 24 h and billing period (TUNELIO_RENEWS_DAY; 0 = no limit), and new paid
  // builds a minute per client IP and per shard (distinct videos, home sessions included). Over the budget the play may
  // still go home; over a per-minute cap it gets youtube.com, no build anywhere.
  // Past SPEND_HOME_FIRST_PERCENT of the hour or day budget new plays go home first (Tunelio when home is full). The
  // budget alerts Discord once when reached and once when clear.
  spendHourCredits: int('SPEND_HOUR_CREDITS', HOUR_CREDITS),
  spendDayCredits: int('SPEND_DAY_CREDITS', 8000),
  spendMonthCredits: int('SPEND_MONTH_CREDITS', 100_000),
  spendHomeFirstPercent: int('SPEND_HOME_FIRST_PERCENT', HOME_FIRST_PERCENT),
  spendBuildsPerMinutePerIp: int('SPEND_BUILDS_PER_MINUTE_PER_IP', 6),
  spendBuildsPerMinutePerShard: int('SPEND_BUILDS_PER_MINUTE_PER_SHARD', 12),
  // Uncached caption transcripts (6 credits each) a minute per client IP, under the same budget. Over it, or over the
  // budget, captions are unavailable for now; playback is unaffected.
  spendTranscriptsPerMinutePerIp: int('SPEND_TRANSCRIPTS_PER_MINUTE_PER_IP', 6),
  // Most client IPs kept by each per-IP limit (the lookup warm's and the spend limits'); past it the least recently
  // active go first.
  rateKeysMax: int('RATE_KEYS_MAX', 10_000),
  // Trusted client IPs (src/trusted.js): comma-separated IPv4, IPv6 and CIDR, env only (the repo is public). Every per-IP
  // limit (searches and More pages, ticket requests, lookup warms, builds, transcripts) is TRUSTED_IP_FACTOR times as high for them; the per-shard cap,
  // the global lookup-warm cap and the spend budget are not.
  trustedIps: process.env.TRUSTED_IPS ?? '',
  trustedIpFactor: int('TRUSTED_IP_FACTOR', 10),
  ticketPinMarginMs: int('TICKET_PIN_MARGIN_MINUTES', 15) * 60_000,
  // The quality home builds when the room hasn't picked one (owner, 2026-10-25: 1080p; home streams, so 1080p starts
  // about as fast as 720p: first segments 6.2 s vs 2.9 s on the Optiplex, 2026-10-23). A room's own pick wins.
  homeQuality: process.env.HOME_QUALITY ?? '1080p',
  homeDailyBuilds: int('HOME_DAILY_BUILDS', 40),
  // owner, 2026-10-23: 10 GB went in a few long videos, so 50,000; owner, 2026-11-04: 120,000, so two rooms' pickers can each
  // play their ALLOWANCE_HOME_MB_PER_IP (60,000) of long mixes. The Linode's transfer (each home MB goes to every viewer)
  // is bounded apart (a guard to come); today it sends at most ~15 GB a day.
  homeDailyMb: int('HOME_DAILY_MB', 120_000),
  // Bursts (Everything-is-OK#576, owner 2026-11-06: "prevent bursts to the home relay"; the defaults are the owner's
  // pick): new home builds in a rolling hour, the MB they're expected to download in it, and the least time between two
  // starts. Over any of them a play goes to Tunelio. 0 = off.
  homeHourBuilds: int('HOME_HOUR_BUILDS', 8),
  homeHourMb: int('HOME_HOUR_MB', 15_000),
  // Videos this long (hours) and longer skip HOME_HOUR_MB: Tunelio fails on them (#577), so home is their only good
  // source (src/home.js blocks). 0 = none skip it.
  homeHourMbExemptHours: (() => { const v = Number.parseFloat(process.env.HOME_HOUR_MB_EXEMPT_HOURS ?? ''); return Number.isFinite(v) ? v : 4; })(),
  homeStartGapMs: int('HOME_START_GAP_SECONDS', 45) * 1000,
  homeKeepHours: int('HOME_KEEP_HOURS', 12),
  homeMaxGb: int('HOME_MAX_GB', 8),
  // Free disk the home store never builds into (src/home.js #room): a build doesn't start when the disk's free space,
  // less what the unfinished builds and it will still grow, would fall under this, and a build is stopped when free
  // space drops under half of it. Prod 2026-10-30 00:58Z: two long 1080p plays (8.4 GB played, a 10.7 GB build) over a
  // 12 GB cap filled the Linode's 24.6 GB disk; Alloy's WAL broke and the build failed. 0 = off.
  homeFreeFloorGb: Number.parseFloat(process.env.HOME_FREE_FLOOR_GB ?? '3') || 0,
  // A home build expected over this size at 1080p (length × ~0.57 MB/s) is built at 720p instead (world #240). It was
  // HOME_MAX_GB by default (#242; prod 80, so a 20.6 GB 1080p build went home on 2026-11-06 before the first bot
  // refusals); 6 GB since #576 (owner, 2026-11-06), about 2.9 h. HOME_ITEM_TOO_BIG: what happens to a video over it
  // even at 720p (about 4.4 h): '720p' (default) builds it at home anyway, since Tunelio fails on such videos (#577);
  // 'tunelio' sends it there (the owner's first pick, 2026-11-06, pending their answer). 0 = off.
  homeItemTooBig: (process.env.HOME_ITEM_TOO_BIG ?? '').trim().toLowerCase() === 'tunelio' ? 'tunelio' : '720p',
  homeItemMaxGb: (() => { const v = Number.parseFloat(process.env.HOME_ITEM_MAX_GB ?? ''); return Number.isFinite(v) ? v : 6; })(),
  // How long a new session may take to its first playlist: yt-dlp ~3 s, then its stream URLs answer 403 for 0.1–2.6 s,
  // once 22 s, before they work (2026-10-23), then the first segments.
  homeReadyMs: int('HOME_READY_SECONDS', 40) * 1000,
  // How long a player's request for a segment that hasn't arrived yet is held (the whole playlist is published up front).
  homeSegmentHoldMs: int('HOME_SEGMENT_HOLD_SECONDS', 20) * 1000,
  // YouTube Data API v3: last fallback for search. Empty = never used.
  youtubeApiKey: process.env.YOUTUBE_API_KEY ?? '',
  youtubeApiDailyUnits: int('YOUTUBE_API_DAILY_UNITS', 10000),
  // Usage metrics (claude/metrics.md): counts per day in this SQLite file, shared with the poller. Empty = off.
  metricsPath: process.env.METRICS_DB ?? 'data/metrics.db',
  metricsTz: process.env.METRICS_TZ ?? 'America/Chicago',
  // Bearer token for GET /stats, /stats.json and /stats/export.csv. Empty = those routes answer 404.
  statsToken: process.env.STATS_TOKEN ?? '',
  // GET /feedback answers 301 here (world #224: eiok.cc/feedback, the same form as japharsworld.com/feedback). Empty = 404.
  feedbackUrl: process.env.FEEDBACK_URL ?? 'https://docs.google.com/forms/d/1UXMXbqXXXtClqTAnQAVKA1niKKsIdOLMGjCPCH-yZFA/viewform',
  // The Channels monitor's database (read only, for /stats).
  monitorDb: process.env.MONITOR_DB ?? '/var/lib/japharsworld-yt-monitor/monitor.db',
  // A host with no monitor DB (staging) asks this service's /v1/ch for Channels slots, server-side (world #519). Empty = the
  // baked monitor/channels.json only. Never set on production, which has the monitor.
  channelsUpstream: process.env.CHANNELS_UPSTREAM ?? '',
  // Thumbnail sheet: one cell per result, row-major.
  sheet: { cols: 4, rows: 5, cellW: 256, cellH: 144, background: '#24283b' },
};
