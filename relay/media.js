// Media job for the relay worker (home relay playback, src/home.js): stream a video from this residential connection
// to the server as HLS. yt-dlp only resolves the stream URLs (they work from the IP that resolved them, so the media
// can't be handed out directly); ffmpeg reads them through rangeProxy at network speed and cuts 4 s MPEG-TS segments
// without re-encoding; every new segment and then the playlist are PUT to RELAY_URL/relay/media/<token>/<file>.
//
// The playlist: VizVid shows a growing playlist as a live stream with no seek bar for the whole play, and a finished one
// with it (2026-10-23). So when the video's segments can be predicted, players get the whole playlist, ENDLIST
// included, from the start (job.vod, the default): when the first STEADY segments are all the same length (an encode with
// evenly spaced keyframes: a 6 h lofi mix was 4388 × 5.071733 s + 3.09 s), the rest are assumed to be too, up to the
// stream's duration (`dur=` in its URL). If the final segments differ, the real playlist is uploaded at the end. Most
// videos have keyframes at scene cuts (segments of 0.1–8.6 s, four 20-minute videos measured 2026-10-23); they get the
// growing playlist.
//
// RELAY_SPLIT_BY_TIME=on (splitByTime, the worker's env; default off, a staging trial for world #250, 2026-10-27): ffmpeg
// cuts every 4 s whether or not a keyframe is there (`-hls_flags split_by_time`, still `-c copy`), so every video is
// steady and gets the whole playlist. The cut lands within a frame or two of each multiple of 4 s: a 29.97 fps clip
// without B-frames made 4.004 s segments with a 3.971 s one every ~8, 75 of them exactly 300 s (ffmpeg 8, 2026-10-27);
// a 4 h YouTube documentary (B-frames) made 3.937–4.071 s, but every cut within 0.1 s of k × 4 s (staging, the same
// day; another cut one 0.153 s late), so the check is on the cut points (onTime), not the lengths. The rest are predicted at 4.000000 s each, not at
// the median (4.004 s would be 2 segments short over 3 h): each listed length is off by up to 2 frames, but the cuts
// don't drift, so the playlist's running time stays within a frame or two of the media. The cost: a segment may start
// mid-GOP, so a player that starts or seeks there shows the picture from the next keyframe (a 60 fps clip with 5 s GOPs:
// 176 and 112 of 240 frames decoded from seg1 and seg2 on their own); sequential play is unaffected.
//
// The job's answer goes back as soon as the first playlist is uploaded (the server can send players then); the rest
// uploads in the background. If ffmpeg dies part way, the playlist is closed where it got to. A 410 from the server
// (session dropped) stops the stream; other failed uploads are retried (a deploy restarts the server in seconds).
//
// Measured 2026-10-22/23 from the owner's connection: yt-dlp -g ~3 s, YouTube download 8–27 MB/s, upload ~12.6 MB/s.
//
// Job: { kind: 'media', videoId, quality: '720p', token }   Answer: { ready: true, segments, cached } (plus `done`, a
// promise for the end of the upload, which the worker keeps)
//
// With a cache (relay/cache.js), a finished stream is kept on the worker's disk and a later job for the same video and
// quality is uploaded from there (`cached`: no yt-dlp, no YouTube download; each upload says so with x-media-cached: 1,
// so the server doesn't count it against HOME_DAILY_MB).
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/captions.js';
import { SHORT_S, playlistSeconds } from './cache.js';

const SEGMENT = /^seg\d{1,5}\.ts$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Until the response can take more, or is gone (both listeners removed again: one per write would pile up).
const drained = (res) => new Promise((resolve) => {
  const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
  res.on('drain', done);
  res.on('close', done);
});

// H.264 + AAC so Media Foundation (VRChat on PC) can play it; the height from the quality ("720p" → 720).
export function formatFor(quality) {
  const h = Number.parseInt(quality, 10) || 720;
  return `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/b[height<=${h}][vcodec^=avc1]`;
}

// A local HTTP server that ffmpeg reads the stream URLs through. YouTube throttles one long read of a stream URL to about
// real time; ~10 MB pieces asked for with the URL's `&range=a-b` parameter, as yt-dlp does, are not (2026-10-23:
// ffmpeg's plain read 0.1 MB/s; on the Optiplex `&range=` 19.8 MB/s, while a 10 MB Range header got 403 and only small
// ones 206). ffmpeg can't make such requests itself (-request_size, a header, and only in development builds; the
// Optiplex has 8.0.1), so every request ffmpeg makes here, seeks included, is answered by fetching `chunk`-byte pieces
// in turn. → { urls (local, same order), close(), failure (why upstream was given up on, or null) }
//
// Upstream trouble is never passed on to ffmpeg as the end of the input: ffmpeg takes a connection that closes early as
// the end of the stream and exits 0 (staging, 2026-10-27 23:16: a 55 min video stopped after 21 of 825 segments, no
// error anywhere; until then only error answers were asked for again, while a request that threw or a body that broke
// off part way closed ffmpeg's connection).
export async function rangeProxy(urls, { fetcher = fetch, chunk = 10_000_000, retryMs = 1000, retryForMs = 30_000, log = () => {} } = {}) {
  const totals = new Map();
  let failure = null;
  async function total(i) {
    if (totals.has(i)) return totals.get(i);
    let n = Number(new URL(urls[i]).searchParams.get('clen')) || 0;
    if (!n) {
      const r = await fetcher(urls[i], { headers: { range: 'bytes=0-0' } });
      try { await r.body?.cancel(); } catch { /* ignore */ }
      n = Number(/\/(\d+)$/.exec(r.headers.get('content-range') ?? '')?.[1]) || 0;
    }
    totals.set(i, n);
    return n;
  }
  const server = createServer(async (req, res) => {
    const i = Number(req.url.slice(1));
    if (!Number.isInteger(i) || !urls[i]) { res.writeHead(404); return res.end(); }
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    try {
      const size = await total(i);
      if (!size) throw new Error('unknown size');
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
      res.writeHead(m ? 206 : 200, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
        ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
      if (req.method === 'HEAD') return res.end();
      // A piece that fails (an error answer, a request that throws, a body that breaks off or ends early) is asked for
      // again from the byte it got to, every retryMs for up to retryForMs without progress: fresh stream URLs often answer
      // 403 for a while before they work (Optiplex, 2026-10-23, six videos: 0.1–2.6 s after yt-dlp printed them, one 22 s).
      let t0 = Date.now();
      for (let pos = start; pos <= end;) {
        const from = pos;
        let why = null;
        try {
          const up = await fetcher(`${urls[i]}&range=${pos}-${Math.min(pos + chunk - 1, end)}`, { signal: ac.signal });
          if (up.status === 200 || up.status === 206) {
            for await (const c of up.body) {
              pos += c.length;
              if (!res.write(c)) await drained(res);
              if (ac.signal.aborted) return;
            }
            if (pos === from) why = 'empty answer';
          } else {
            why = `upstream answered ${up.status}`;
            try { await up.body?.cancel(); } catch { /* ignore */ }
          }
        } catch (err) {
          if (ac.signal.aborted) return; // ffmpeg closed this request (a seek, or it is done)
          why = String(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err).slice(0, 80);
        }
        if (pos > from) t0 = Date.now();
        if (!why) continue;
        if (Date.now() - t0 >= retryForMs) throw new Error(why);
        log({ event: 'media_source_retry', stream: i, mb: Math.round(pos / 1e5) / 10, why });
        await sleep(retryMs);
      }
      res.end();
    } catch (err) {
      if (!ac.signal.aborted) {
        failure = String(err?.message ?? err).slice(0, 120);
        log({ event: 'media_source_failed', stream: i, why: failure });
      }
      res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { urls: urls.map((_, i) => `http://127.0.0.1:${port}/${i}`), close: () => { server.close(); server.closeAllConnections(); },
    get failure() { return failure; } };
}

// The whole playlist from the durations of the segments made so far (`known`), the usual segment length (`gop`) and
// the video's duration: the rest at `gop` each, the remainder last.
export function predictPlaylist(known, gop, duration) {
  const durations = [...known];
  let left = duration - known.reduce((a, b) => a + b, 0);
  while (left > 0.05) { const d = left > gop * 1.01 ? gop : left; durations.push(d); left -= d; }
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`, '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD'];
  durations.forEach((d, i) => lines.push(`#EXTINF:${d.toFixed(6)},`, `seg${i}.ts`));
  lines.push('#EXT-X-ENDLIST');
  return { text: `${lines.join('\n')}\n`, count: durations.length };
}

// The playlist cut back to the segments the server has, closed (ENDLIST): for a job that fails part way after players
// were sent, so they end there instead of waiting on segments that will never come (a predicted playlist lists them all).
export function closedAt(text, sent) {
  const out = [];
  const lines = text.split(/\r?\n/).filter((l) => l && l !== '#EXT-X-ENDLIST');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF:')) { if (!SEGMENT.test(lines[i])) out.push(lines[i]); continue; }
    if (!sent.has(lines[i + 1])) break;
    out.push(lines[i], lines[++i]);
  }
  return `${out.join('\n')}\n#EXT-X-ENDLIST\n`;
}

const extinfs = (text) => [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
const STEADY = 8;
const HLS_TIME = 4;
// Runs (mediaJob): at most MAX_RUNS ffmpeg at once per job, MAX_TOTAL_RUNS in all; a want within LEAD segments, or
// LEAD_S seconds at its run's rate, of what a run has made is left to that run.
const MAX_RUNS = 2;
const MAX_TOTAL_RUNS = 20;
const LEAD = 8;
const LEAD_S = 5;
// One frame: segments of the same number of frames at 29.97 fps print as 4.004 or 3.971 s (2026-10-27).
const FRAME = 0.05;

// Keyframe cuts (splitByTime off): the usual segment length if the first STEADY segments are all within a frame of
// their median, else null.
export function steadyLength(known) {
  if (known.length < STEADY) return null;
  const first = known.slice(0, STEADY);
  const median = [...first].sort((a, b) => a - b)[STEADY / 2];
  return first.every((d) => Math.abs(d - median) <= FRAME) ? median : null;
}

// Time cuts (splitByTime on): whether each of the first STEADY cut points (the running sum) is within CUT of a multiple
// of HLS_TIME. Measured on staging, 2026-10-27, 29.97 fps YouTube documentaries: cuts land up to 0.153 s late (4–5
// frames, the next segment gives it back), never early; scene-cut lists are seconds off by the second segment.
const CUT = 0.5;
export function onTime(known) {
  if (known.length < STEADY) return false;
  let at = 0;
  return known.slice(0, STEADY).every((d, i) => Math.abs((at += d) - (i + 1) * HLS_TIME) <= CUT);
}

// start > 0 (a run at a seek point, mediaJob): every input from `seconds`, the source's timestamps kept (-copyts) and the
// segments numbered from start, so they fit the whole playlist the server has (without -copyts they restart at ~1.4 s).
export function ffmpegArgs(urls, dir, { splitByTime = false, start = 0, seconds = 0 } = {}) {
  const ss = start > 0 ? ['-ss', seconds.toFixed(3)] : [];
  const inputs = urls.flatMap((u) => [...ss, '-i', u]);
  const maps = urls.length > 1 ? ['-map', '0:v:0', '-map', '1:a:0'] : [];
  // h264_mp4toannexb,dump_extra: the H.264 parameter sets (SPS/PPS) before every keyframe. Copied from YouTube's mp4
  // they were only in seg0 (its keyframes aren't IDR, the only frames mp4toannexb repeats them for), so every later
  // segment failed to decode on its own ("non-existing PPS 0", 2026-10-23; a 12 s open-GOP test file on the Optiplex:
  // seg1 0 frames → 118 with the filter): a player that starts or seeks past seg0 had nothing to decode with. With
  // splitByTime a segment can start between keyframes; it still gets the parameter sets at its first keyframe, which is
  // where a decoder starts anyway. freq=all (before every frame) only if a player is seen needing them at the cut.
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(start > 0 ? ['-copyts'] : []), ...inputs, ...maps, '-c', 'copy', '-bsf:v', 'h264_mp4toannexb,dump_extra=freq=keyframe',
    '-f', 'hls', '-hls_time', String(HLS_TIME), '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_flags', splitByTime ? 'temp_file+split_by_time' : 'temp_file',
    '-hls_segment_type', 'mpegts', ...(start > 0 ? ['-start_number', String(start)] : []), '-hls_segment_filename', join(dir, 'seg%d.ts'), join(dir, 'index.m3u8')];
}

// → Promise that resolves { ready: true, segments } once the first playlist is up, or rejects before that.
// upload(file, body, type) → HTTP status. wanted() → the segment number a player is waiting for (the server's
// x-media-want, Everything-is-OK#367), or null. spawnFn/runner are injectable for tests.
export async function mediaJob(job, { ytdlp, ffmpeg = 'ffmpeg', extraArgs = [], upload: put, wanted = () => null, runner = run, spawnFn = spawn,
  fetcher = fetch, tmp = tmpdir(), pollMs = 500, maxMs = 4 * 3600_000, retryMs = 1000, cache = null, splitByTime = false, log = () => {} }) {
  const videoId = String(job.videoId ?? '');
  const quality = String(job.quality ?? '720p');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('bad videoId');
  if (!/^\d{3,4}p$/.test(quality)) throw new Error('bad quality');
  const started = Date.now();
  const hit = cache?.get(videoId, quality, { seconds: Number(job.seconds) || 0 });
  if (hit) return fromCache(hit, { upload: put, wanted, retryMs, started, log });
  const out = await runner(ytdlp, [...extraArgs, '--no-warnings', '--no-cache-dir', '--no-playlist', '-g', '-f', formatFor(quality),
    '--', `https://www.youtube.com/watch?v=${videoId}`], 30_000);
  const urls = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).slice(0, 2);
  if (!urls.length) throw new Error('no stream urls');
  const resolveMs = Date.now() - started;
  // The video's duration: the longer of the streams' `dur=`, else the ticket's length. 0 = unknown (growing playlist).
  const duration = job.vod === false ? 0
    : Math.max(...urls.map((u) => Number(new URL(u).searchParams.get('dur')) || 0)) || Number(job.seconds) || 0;
  // Uploads that fail other than with an answer the server meant (204/400/410/413) are tried again, 5 times over ~15 s.
  async function upload(file, body, type) {
    for (let attempt = 0; ; attempt++) {
      let status;
      try { status = await put(file, body, type); } catch { status = 0; }
      if (status && status < 500) return status;
      if (attempt >= 4) return status;
      await sleep(retryMs * (attempt + 1));
    }
  }
  const dir = cache ? cache.staging() : await mkdtemp(join(tmp, 'jyt-media-'));
  const proxy = await rangeProxy(urls, { fetcher, log });
  // Runs (Everything-is-OK#367 phase 2): ffmpeg processes, each making the segments [start, until) in its own folder
  // (dir/r<k>); a segment moves to dir once it is uploaded (kept there for the cache). Run 0 builds from the start. When
  // a player waits for a segment of a whole (predicted) playlist that no run will reach soon, the run heading there
  // stops at it and a new one starts at it (-copyts -ss, measured 2026-10-29: its segments line up with the in-order
  // build within 2 frames, no drift; but see below); at most MAX_RUNS at once. When no run is left, the segments still missing are made
  // by fill runs, the ones after the last want first. Each segment is still downloaded and uploaded about once.
  // Open (2026-10-30, real 1080p streams): -ss lands on the keyframe before the seek point and cuts every 4 s from there, so
  // when keyframes aren't on the segment grid a run's segments start up to one GOP early (3.4 s measured). Timestamps stay
  // true, but video overlaps the run before it at the joint and the build can end one segment past the playlist.
  const runs = [];
  let segLen = 0; // the predicted segment length, once the playlist is predicted
  function startRun(start, until) {
    const r = { k: runs.length, start, until, dir: join(dir, `r${runs.length}`), exit: null, killed: false, stderr: '', listed: [],
      top: start - 1, startedMs: Date.now() };
    mkdirSync(r.dir, { recursive: true });
    r.proc = spawnFn(ffmpeg, ffmpegArgs(proxy.urls, r.dir, { splitByTime, start, seconds: start * segLen }), { stdio: ['ignore', 'ignore', 'pipe'] });
    r.proc.stderr?.on('data', (d) => { r.stderr = (r.stderr + d).slice(-2000); });
    r.closed = new Promise((res) => r.proc.on('close', (code) => { r.exit = code ?? -1; res(); }));
    runs.push(r);
    return r;
  }
  const main = startRun(0, Infinity);
  const alive = () => runs.filter((r) => r.exit === null);
  const stop = (r) => { if (r.exit === null && !r.killed) { r.killed = true; r.proc.kill('SIGKILL'); } };
  const killer = setTimeout(() => alive().forEach((r) => r.proc.kill('SIGKILL')), maxMs); // a failure, not a stop
  // The first run that failed on its own (not stopped here): the job's ffmpeg exit, as with one run.
  const failedRun = () => runs.find((r) => r.exit !== null && r.exit !== 0 && !r.killed);
  const exitCode = () => failedRun()?.exit ?? (alive().length ? null : 0);

  let ready, failed, background;
  const first = new Promise((res, rej) => { ready = res; failed = rej; });
  const sent = new Set();
  const made = new Map(); // segment → the run that made it
  let mb = 0, gone = false, isReady = false, lastPlaylist = '', realText = '', predicted = null, short = false, jumps = 0, lastWant = null;
  const name = (i) => `seg${i}.ts`;
  const index = (s) => Number(s.slice(3, -3));
  const jumped = () => runs.length > 1;
  // What the server is sent when the job fails part way: cut back to the segments it has.
  const listing = () => (jumped() ? predicted.text : realText);

  async function readRun(r) {
    let text;
    try { text = await readFile(join(r.dir, 'index.m3u8'), 'utf8'); } catch { return null; }
    r.listed = text.split(/\r?\n/).filter((l) => SEGMENT.test(l));
    for (const s of r.listed) {
      const i = index(s);
      if (i >= r.until) { stop(r); continue; } // past its range: another run has it
      if (i < r.start || made.has(s)) continue;
      made.set(s, r);
      r.top = Math.max(r.top, i);
    }
    return text;
  }

  // The next segment after i that is made or that an alive run starts at, else the playlist's end.
  function boundary(i) {
    let b = predicted ? predicted.count : Infinity;
    for (const r of alive()) if (r.start > i) b = Math.min(b, r.start);
    for (let j = i + 1; j < b; j++) if (made.has(name(j))) return j;
    return b;
  }
  const covered = (i) => alive().some((r) => r.start <= i && i < r.until);

  // A player waits for segment w (wanted()): unless an alive run will make it within a few seconds, the run heading
  // there stops at w and a new one starts at w. A run that would be one too many is stopped where it got to (filled later).
  function jumpFor(w) {
    if (!predicted || !isReady || w == null || w === lastWant || !(w >= 0 && w < predicted.count) || made.has(name(w))) return;
    lastWant = w;
    const cover = alive().find((r) => r.start <= w && w < r.until);
    if (cover) {
      const perS = (cover.top - cover.start + 1) / Math.max(1, (Date.now() - cover.startedMs) / 1000);
      if (w <= cover.top + Math.max(LEAD, perS * LEAD_S)) return; // coming anyway
    }
    const until = cover ? cover.until : boundary(w);
    if (cover) cover.until = w;
    const others = alive().filter((r) => r !== cover).sort((a, b) => a.start - b.start);
    // Counting the ones not yet told to stop: a stopped run stays alive until its close event.
    while (alive().filter((r) => !r.killed).length >= MAX_RUNS && others.length) { const v = others.shift(); v.until = v.top + 1; stop(v); }
    jumps++;
    log({ event: 'media_jump', cached: false, from: cover ? cover.top + 1 : null, to: w, seconds: Math.round(w * segLen) });
    startRun(w, until);
  }

  // No run alive: one for the first missing segment (after the last want first). → whether one started.
  function fill() {
    if (!predicted || gone || failedRun() || runs.length >= MAX_TOTAL_RUNS) return false;
    const missing = (from) => { for (let i = from; i < predicted.count; i++) if (!made.has(name(i)) && !covered(i)) return i; return -1; };
    let m = lastWant != null ? missing(lastWant) : -1;
    if (m < 0) m = missing(0);
    if (m < 0) return false;
    const prev = runs.at(-1);
    if (prev.start === m && prev.top < m) return false; // the last run made nothing where it started: it would again
    log({ event: 'media_run', from: m, until: boundary(m) });
    startRun(m, boundary(m));
    return true;
  }

  async function send(s) {
    const r = made.get(s);
    const body = await readFile(join(r.dir, s));
    const status = await upload(s, body, 'video/mp2t');
    if (status === 410) { gone = true; return false; }
    if (status !== 204) throw new Error(`upload ${s} (${(body.length / 1e6).toFixed(1)} MB) answered ${status}`);
    sent.add(s);
    mb += body.length / 1e6;
    // With a cache, kept for it in dir (where cache.put looks); without, gone.
    if (cache) await rename(join(r.dir, s), join(dir, s)); else rm(join(r.dir, s), { force: true }).catch(() => {});
    return true;
  }

  async function pass(final) {
    let text = await readRun(main);
    if (text == null) return;
    realText = text;
    for (const r of runs) if (r !== main) await readRun(r);
    const segs = main.listed;
    if (isReady) jumpFor(wanted());
    // What is made and not yet sent: the wanted one first, then the newest run's (where the player is), then older ones.
    const order = () => [...made.keys()].filter((s) => !sent.has(s))
      .sort((a, b) => (made.get(b).k - made.get(a).k) || (index(a) - index(b)));
    for (let queue = order(); queue.length;) {
      const w = wanted();
      const s = w != null && queue.includes(name(w)) ? name(w) : queue[0];
      // Before the first playlist, seg0 only: a player needs nothing more to start, and the server holds a listed
      // segment that isn't here yet. Uploading all ffmpeg had made first held ready back by up to ~8 s (10–98
      // segments before the first playlist, Optiplex, 2026-10-24/25).
      if (!isReady && sent.size >= 1) break;
      if (!(await send(s))) return;
      queue = queue.filter((q) => q !== s);
      // A new want for a segment nobody has made: back to the loop, which starts a run for it.
      if (!final && isReady && w !== wanted() && wanted() != null && !made.has(name(wanted()))) break;
    }
    // Closed where it got to when ffmpeg died part way, so players end instead of waiting for more.
    if (final && !text.includes('#EXT-X-ENDLIST')) text = `${text.trimEnd()}\n#EXT-X-ENDLIST\n`;
    // Whole or growing is decided once STEADY segments are made (ffmpeg makes dozens a second), before any playlist goes
    // up, so a player never gets the growing playlist first and the whole one after.
    if (predicted === null && !final && duration > 0 && segs.length < STEADY) return;
    if (predicted === null) {
      const known = extinfs(text);
      const gop = !(duration > 0) ? null : splitByTime ? (onTime(known) ? HLS_TIME : null) : steadyLength(known);
      predicted = gop ? predictPlaylist([], gop, duration) : false;
      segLen = gop ?? 0;
      // The decision with its inputs, so a growing playlist can be explained from the journal (staging, 2026-10-27).
      let at = 0;
      log({ event: 'media_steady', steady: !!gop, gop: gop ?? undefined, duration: Math.round(duration), splitByTime,
        reason: gop ? 'ok' : !(duration > 0) ? 'no duration' : known.length < STEADY ? 'too few' : splitByTime ? 'cut off the 4 s marks' : 'lengths differ',
        lengths: known.slice(0, STEADY), offsets: known.slice(0, STEADY).map((d, i) => Math.round(((at += d) - (i + 1) * HLS_TIME) * 1000) / 1000) });
    }
    if (predicted) {
      const actual = extinfs(text);
      const count = jumped() ? made.size : segs.length;
      const differs = final && (count !== predicted.count || (!jumped() && !text.includes('#EXT-X-ENDLIST')) || exitCode());
      if (differs) log({ event: 'media_mismatch', predicted: predicted.count, actual: count, exit: exitCode() });
      text = differs && jumped() ? closedAt(predicted.text, sent) : differs ? text : predicted.text;
      if (final && !differs && actual.length) log({ event: 'media_predicted', segments: count });
    }
    if (text === lastPlaylist) return;
    lastPlaylist = text;
    const status = await upload('index.m3u8', Buffer.from(text), 'application/vnd.apple.mpegurl');
    if (status === 410) { gone = true; return; }
    if (status !== 204) throw new Error(`upload playlist answered ${status}`);
    if (!isReady && segs.length) {
      isReady = true;
      ready({ ready: true, segments: segs.length, done: background });
      log({ event: 'media_ready', ms: Date.now() - started, resolveMs, segments: segs.length });
    }
  }

  background = (async () => {
    try {
      while (!gone) {
        if (!alive().length && !fill()) break;
        await Promise.race([sleep(pollMs), ...alive().map((r) => r.closed)]);
        await pass(false);
      }
      if (!gone) await pass(true);
      if (gone) runs.forEach(stop);
      const exit = exitCode();
      const stderr = (failedRun() ?? main).stderr;
      // ffmpeg ending cleanly short of the video is a failure, not done (world #266): fewer segments than predicted, or
      // (growing playlist) SHORT_S less running time than the video. The playlist went up closed where it got to; the
      // server marks a predicted session cut_short, and the copy is not cached, so the next play makes it again.
      const count = jumped() ? made.size : extinfs(realText).length;
      const runS = playlistSeconds(realText);
      short = !gone && exit === 0 && duration > 0 && (predicted ? count < predicted.count : runS < duration - SHORT_S);
      if (short) {
        log({ event: 'media_failed', reason: 'short', ms: Date.now() - started, mb: Math.round(mb), segments: sent.size,
          expected: predicted ? predicted.count : undefined, seconds: Math.round(runS), duration: Math.round(duration), source: proxy.failure ?? undefined });
        if (!isReady) failed(new Error(`ffmpeg ended at ${Math.round(runS)} of ${Math.round(duration)} s`));
        return;
      }
      log({ event: 'media_done', ms: Date.now() - started, mb: Math.round(mb), segments: sent.size, exit, gone, jumps: jumps || undefined,
        runs: jumped() ? runs.length : undefined, error: exit ? stderr.trim().split('\n').pop()?.slice(0, 200) : undefined });
      if (!isReady) failed(new Error(gone ? 'session gone' : `ffmpeg exited ${exit}: ${stderr.trim().split('\n').pop() ?? ''}`.slice(0, 300)));
    } catch (err) {
      runs.forEach(stop);
      log({ event: 'media_failed', ms: Date.now() - started, mb: Math.round(mb), message: String(err?.message ?? err).slice(0, 200) });
      if (!isReady) failed(err);
      else if (!gone && realText) {
        const status = await upload('index.m3u8', Buffer.from(closedAt(listing(), sent)), 'application/vnd.apple.mpegurl').catch(() => 0);
        log({ event: 'media_closed', segments: sent.size, status });
      }
    } finally {
      clearTimeout(killer);
      await Promise.all(runs.map((r) => r.closed));
      proxy.close();
      // The runs' own folders (ffmpeg's playlists, segments past their range) go first, then a stream that finished
      // whole goes into the cache (put checks every listed segment is here); anything else is dropped.
      await Promise.all(runs.map((r) => rm(r.dir, { recursive: true, force: true })));
      let kept = false;
      if (cache && exitCode() === 0 && !gone && !short) {
        try { kept = cache.put(videoId, quality, dir, lastPlaylist, { seconds: duration }); } catch (err) { log({ event: 'media_cache_failed', message: String(err?.message ?? err).slice(0, 200) }); }
      }
      if (!kept) await rm(dir, { recursive: true, force: true });
    }
  })();
  return first;
}

// A cached stream, uploaded from disk: the first segment and the whole playlist (the server can send players then), the
// rest in order in the background. A segment a player asks for early is held by the server until it arrives. A player
// that seeked ahead (wanted(), Everything-is-OK#367) gets its segment next: the upload jumps there, carries on in order
// from it and comes back for the ones it skipped at the end, so every segment still goes up once. Prod, 2026-10-30: a
// 4.1 h 1080p copy went up in order at ~6.9 MB/s, so a seek an hour in waited ~4 min for its segment and froze.
async function fromCache(hit, { upload: put, wanted = () => null, retryMs, started, log }) {
  const upload = async (file, body, type) => {
    for (let attempt = 0; ; attempt++) {
      let status;
      try { status = await put(file, body, type, { cached: true }); } catch { status = 0; }
      if ((status && status < 500) || attempt >= 4) return status;
      await sleep(retryMs * (attempt + 1));
    }
  };
  const send = async (file) => {
    const status = await upload(file, await readFile(join(hit.dir, file)), 'video/mp2t');
    if (status !== 204) throw Object.assign(new Error(`upload ${file} answered ${status}`), { status });
  };
  await send(hit.segments[0]);
  const status = await upload('index.m3u8', Buffer.from(hit.playlist), 'application/vnd.apple.mpegurl');
  if (status !== 204) throw new Error(`upload playlist answered ${status}`);
  log({ event: 'media_ready', ms: Date.now() - started, cached: true, segments: hit.segments.length });
  const done = (async () => {
    const sent = new Set([0]);
    const index = new Map(hit.segments.map((f, i) => [f, i]));
    const next = (i) => (i + 1 < hit.segments.length ? i + 1 : 0); // past the end: back to the first skipped one
    let n = 1, jumps = 0;
    try {
      while (sent.size < hit.segments.length) {
        const w = wanted();
        const at = w == null ? undefined : index.get(`seg${w}.ts`);
        if (at !== undefined && !sent.has(at) && at !== n) {
          log({ event: 'media_jump', cached: true, from: n, to: at });
          n = at;
          jumps++;
        }
        while (sent.has(n)) n = next(n);
        await send(hit.segments[n]);
        sent.add(n);
        n = next(n);
      }
      log({ event: 'media_done', ms: Date.now() - started, cached: true, mb: Math.round(hit.mb ?? 0), segments: sent.size, jumps });
    } catch (err) {
      const gone = err.status === 410;
      log({ event: gone ? 'media_done' : 'media_failed', ms: Date.now() - started, cached: true, segments: sent.size, gone, jumps,
        message: gone ? undefined : String(err?.message ?? err).slice(0, 200) });
    }
  })();
  return { ready: true, segments: hit.segments.length, cached: true, done };
}
