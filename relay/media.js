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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/captions.js';

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
// in turn. → { urls (local, same order), close() }
export async function rangeProxy(urls, { fetcher = fetch, chunk = 10_000_000, retryMs = 1000, retryForMs = 30_000 } = {}) {
  const totals = new Map();
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
      for (let pos = start; pos <= end;) {
        // A piece that fails is asked for again every retryMs for up to retryForMs: fresh stream URLs often answer 403 for
        // a while before they work (Optiplex, 2026-10-23, six videos: 0.1–2.6 s after yt-dlp printed them, one 22 s).
        let up;
        for (const t0 = Date.now(); ;) {
          up = await fetcher(`${urls[i]}&range=${pos}-${Math.min(pos + chunk - 1, end)}`, { signal: ac.signal });
          if (up.status === 200 || up.status === 206) break;
          try { await up.body?.cancel(); } catch { /* ignore */ }
          if (Date.now() - t0 >= retryForMs || ac.signal.aborted) throw new Error(`upstream answered ${up.status}`);
          await sleep(retryMs);
        }
        for await (const c of up.body) {
          pos += c.length;
          if (!res.write(c)) await drained(res);
          if (ac.signal.aborted) return;
        }
      }
      res.end();
    } catch { res.destroy(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { urls: urls.map((_, i) => `http://127.0.0.1:${port}/${i}`), close: () => { server.close(); server.closeAllConnections(); } };
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

const extinfs = (text) => [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
const STEADY = 8;

export function ffmpegArgs(urls, dir) {
  const inputs = urls.flatMap((u) => ['-i', u]);
  const maps = urls.length > 1 ? ['-map', '0:v:0', '-map', '1:a:0'] : [];
  // h264_mp4toannexb,dump_extra: the H.264 parameter sets (SPS/PPS) before every keyframe. Copied from YouTube's mp4
  // they were only in seg0 (its keyframes aren't IDR, the only frames mp4toannexb repeats them for), so every later
  // segment failed to decode on its own ("non-existing PPS 0", 2026-10-23; a 12 s open-GOP test file on the Optiplex:
  // seg1 0 frames → 118 with the filter): a player that starts or seeks past seg0 had nothing to decode with.
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputs, ...maps, '-c', 'copy', '-bsf:v', 'h264_mp4toannexb,dump_extra=freq=keyframe',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file',
    '-hls_segment_type', 'mpegts', '-hls_segment_filename', join(dir, 'seg%d.ts'), join(dir, 'index.m3u8')];
}

// → Promise that resolves { ready: true, segments } once the first playlist is up, or rejects before that.
// upload(file, body, type) → HTTP status. spawnFn/runner are injectable for tests.
export async function mediaJob(job, { ytdlp, ffmpeg = 'ffmpeg', extraArgs = [], upload: put, runner = run, spawnFn = spawn,
  fetcher = fetch, tmp = tmpdir(), pollMs = 500, maxMs = 4 * 3600_000, retryMs = 1000, cache = null, log = () => {} }) {
  const videoId = String(job.videoId ?? '');
  const quality = String(job.quality ?? '720p');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('bad videoId');
  if (!/^\d{3,4}p$/.test(quality)) throw new Error('bad quality');
  const started = Date.now();
  const hit = cache?.get(videoId, quality);
  if (hit) return fromCache(hit, { upload: put, retryMs, started, log });
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
  const proxy = await rangeProxy(urls, { fetcher });
  const ff = spawnFn(ffmpeg, ffmpegArgs(proxy.urls, dir), { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  ff.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  let exit = null;
  const exited = new Promise((r) => ff.on('close', (code) => { exit = code ?? -1; r(); }));
  const killer = setTimeout(() => ff.kill('SIGKILL'), maxMs);

  let ready, failed, background;
  const first = new Promise((res, rej) => { ready = res; failed = rej; });
  const sent = new Set();
  let mb = 0, gone = false, isReady = false, lastPlaylist = '', predicted = null;

  async function pass(final) {
    let text;
    try { text = await readFile(join(dir, 'index.m3u8'), 'utf8'); } catch { return; }
    const segs = text.split(/\r?\n/).filter((l) => SEGMENT.test(l));
    for (const s of segs) {
      if (sent.has(s)) continue;
      // Before the first playlist, seg0 only: a player needs nothing more to start, and the server holds a listed
      // segment that isn't here yet. Uploading all ffmpeg had made first held ready back by up to ~8 s (10–98
      // segments before the first playlist, Optiplex, 2026-10-24/25).
      if (!isReady && sent.size >= 1) break;
      const body = await readFile(join(dir, s));
      const status = await upload(s, body, 'video/mp2t');
      if (status === 410) { gone = true; return; }
      if (status !== 204) throw new Error(`upload ${s} answered ${status}`);
      sent.add(s);
      mb += body.length / 1e6;
      if (!cache) rm(join(dir, s), { force: true }).catch(() => {}); // with a cache, kept for it
    }
    // Closed where it got to when ffmpeg died part way, so players end instead of waiting for more.
    if (final && !text.includes('#EXT-X-ENDLIST')) text = `${text.trimEnd()}\n#EXT-X-ENDLIST\n`;
    // Whole or growing is decided once STEADY segments are made (ffmpeg makes dozens a second), before any playlist goes
    // up, so a player never gets the growing playlist first and the whole one after.
    if (predicted === null && !final && duration > 0 && segs.length < STEADY) return;
    if (predicted === null) {
      const known = extinfs(text);
      const steady = duration > 0 && known.length >= STEADY && new Set(known.slice(0, STEADY).map((d) => d.toFixed(3))).size === 1;
      predicted = steady ? predictPlaylist([], known[0], duration) : false;
    }
    if (predicted) {
      const actual = extinfs(text);
      const differs = final && (segs.length !== predicted.count || !text.includes('#EXT-X-ENDLIST') || exit);
      if (differs) log({ event: 'media_mismatch', predicted: predicted.count, actual: segs.length, exit });
      else text = predicted.text;
      if (final && !differs && actual.length) log({ event: 'media_predicted', segments: segs.length });
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
      while (exit === null && !gone) {
        await Promise.race([sleep(pollMs), exited]);
        await pass(false);
      }
      if (!gone) await pass(true);
      if (gone) ff.kill('SIGKILL');
      log({ event: 'media_done', ms: Date.now() - started, mb: Math.round(mb), segments: sent.size, exit, gone,
        error: exit ? stderr.trim().split('\n').pop()?.slice(0, 200) : undefined });
      if (!isReady) failed(new Error(gone ? 'session gone' : `ffmpeg exited ${exit}: ${stderr.trim().split('\n').pop() ?? ''}`.slice(0, 300)));
    } catch (err) {
      ff.kill('SIGKILL');
      log({ event: 'media_failed', ms: Date.now() - started, mb: Math.round(mb), message: String(err?.message ?? err).slice(0, 200) });
      if (!isReady) failed(err);
    } finally {
      clearTimeout(killer);
      await exited;
      proxy.close();
      // A stream that finished whole goes into the cache (put checks every listed segment is here); anything else is dropped.
      let kept = false;
      if (cache && exit === 0 && !gone) {
        try { kept = cache.put(videoId, quality, dir, lastPlaylist); } catch (err) { log({ event: 'media_cache_failed', message: String(err?.message ?? err).slice(0, 200) }); }
      }
      if (!kept) await rm(dir, { recursive: true, force: true });
    }
  })();
  return first;
}

// A cached stream, uploaded from disk: the first segment and the whole playlist (the server can send players then), the
// rest in order in the background. A segment a player asks for early is held by the server until it arrives.
async function fromCache(hit, { upload: put, retryMs, started, log }) {
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
    let n = 1;
    try {
      for (; n < hit.segments.length; n++) await send(hit.segments[n]);
      log({ event: 'media_done', ms: Date.now() - started, cached: true, mb: Math.round(hit.mb ?? 0), segments: n });
    } catch (err) {
      const gone = err.status === 410;
      log({ event: gone ? 'media_done' : 'media_failed', ms: Date.now() - started, cached: true, segments: n, gone,
        message: gone ? undefined : String(err?.message ?? err).slice(0, 200) });
    }
  })();
  return { ready: true, segments: hit.segments.length, cached: true, done };
}
