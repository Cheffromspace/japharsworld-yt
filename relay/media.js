// Media job for the relay worker (home relay playback, src/home.js): stream a video from this residential connection
// to the server as HLS. yt-dlp only resolves the stream URLs (they work from the IP that resolved them, so the media
// can't be handed out directly); ffmpeg reads them at network speed and cuts 4 s MPEG-TS segments without re-encoding;
// every new segment and then the playlist are PUT to RELAY_URL/relay/media/<token>/<file>.
//
// The job's answer goes back as soon as the first playlist with a segment is uploaded (the server can send players
// then); the rest uploads in the background until ffmpeg ends and the playlist carries #EXT-X-ENDLIST. If ffmpeg dies
// part way, the playlist is closed where it got to. A 410 from the server (session dropped) stops the stream.
//
// Measured 2026-10-22/23 from the owner's connection: yt-dlp -g ~3 s, YouTube download 8–27 MB/s, upload ~12.6 MB/s.
//
// Job: { kind: 'media', videoId, quality: '720p', token }   Answer: { ready: true, segments } (plus `done`, a promise
// for the end of the upload, which the worker keeps)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/captions.js';

const SEGMENT = /^seg\d{1,5}\.ts$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// H.264 + AAC so Media Foundation (VRChat on PC) can play it; the height from the quality ("720p" → 720).
export function formatFor(quality) {
  const h = Number.parseInt(quality, 10) || 720;
  return `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/b[height<=${h}][vcodec^=avc1]`;
}

// Range requests of 10 MB, as yt-dlp makes: YouTube throttles one long read of a stream URL to about real time
// (2026-10-23, this connection: 0.1 MB/s for a plain read, 13.6 MB/s with -request_size). The option needs FFmpeg 7.1+
// (the worker checks, relay/worker.js). A small first request makes the probing, and so the first segment, quicker.
export function ffmpegArgs(urls, dir) {
  const inputs = urls.flatMap((u) => ['-request_size', '10000000', '-initial_request_size', '1000000', '-i', u]);
  const maps = urls.length > 1 ? ['-map', '0:v:0', '-map', '1:a:0'] : [];
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputs, ...maps, '-c', 'copy',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file',
    '-hls_segment_type', 'mpegts', '-hls_segment_filename', join(dir, 'seg%d.ts'), join(dir, 'index.m3u8')];
}

// → Promise that resolves { ready: true, segments } once the first playlist is up, or rejects before that.
// upload(file, body, type) → HTTP status. spawnFn/runner are injectable for tests.
export async function mediaJob(job, { ytdlp, ffmpeg = 'ffmpeg', extraArgs = [], upload, runner = run, spawnFn = spawn,
  tmp = tmpdir(), pollMs = 500, maxMs = 4 * 3600_000, log = () => {} }) {
  const videoId = String(job.videoId ?? '');
  const quality = String(job.quality ?? '720p');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('bad videoId');
  if (!/^\d{3,4}p$/.test(quality)) throw new Error('bad quality');
  const started = Date.now();
  const out = await runner(ytdlp, [...extraArgs, '--no-warnings', '--no-cache-dir', '--no-playlist', '-g', '-f', formatFor(quality),
    '--', `https://www.youtube.com/watch?v=${videoId}`], 30_000);
  const urls = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).slice(0, 2);
  if (!urls.length) throw new Error('no stream urls');
  const resolveMs = Date.now() - started;
  const dir = await mkdtemp(join(tmp, 'jyt-media-'));
  const ff = spawnFn(ffmpeg, ffmpegArgs(urls, dir), { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  ff.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  let exit = null;
  const exited = new Promise((r) => ff.on('close', (code) => { exit = code ?? -1; r(); }));
  const killer = setTimeout(() => ff.kill('SIGKILL'), maxMs);

  let ready, failed, background;
  const first = new Promise((res, rej) => { ready = res; failed = rej; });
  const sent = new Set();
  let mb = 0, gone = false, isReady = false, lastPlaylist = '';

  async function pass(final) {
    let text;
    try { text = await readFile(join(dir, 'index.m3u8'), 'utf8'); } catch { return; }
    const segs = text.split(/\r?\n/).filter((l) => SEGMENT.test(l));
    for (const s of segs) {
      if (sent.has(s)) continue;
      const body = await readFile(join(dir, s));
      const status = await upload(s, body, 'video/mp2t');
      if (status === 410) { gone = true; return; }
      if (status !== 204) throw new Error(`upload ${s} answered ${status}`);
      sent.add(s);
      mb += body.length / 1e6;
      rm(join(dir, s), { force: true }).catch(() => {});
    }
    // Closed where it got to when ffmpeg died part way, so players end instead of waiting for more.
    if (final && !text.includes('#EXT-X-ENDLIST')) text = `${text.trimEnd()}\n#EXT-X-ENDLIST\n`;
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
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return first;
}
