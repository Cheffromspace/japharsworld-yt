// Caption job for the relay worker (Everything is OK #77): yt-dlp from this residential connection fetches a
// video's caption track list and one track as YouTube's json3, which carries the start time of every word in
// auto-generated tracks. The server cannot do this itself: YouTube bot-walls caption requests from the Linode, and
// Tunelio's transcripts have segment timing only.
//
// Job: { kind: 'captions', videoId, want }   want: { lang } (a VRChat code or 'native') | { code, auto } | null (list only)
// Answer: { info: { language, manual: [keys], auto: [keys] }, track: { key, code, auto, format } | null, cues, reason?,
//   warnings?: yt-dlp's WARNING lines, retried?: true when the list was asked for again (EMPTY_RETRY) }
// Cues are src/cues.js cues; the server orders the list, caches and chunks (src/captionchain.js, src/blocks.js).
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeRe, readCapped, INFO_MAX_BYTES, TRACK_MAX_BYTES } from '../src/captions.js';
import { cuesFrom, tracksFromInfo, codeOfKey, keyFor } from '../src/cues.js';
import { orderTracks, pickTrack } from '../src/transcripts.js';

const FORMATS = ['json3', 'srv3', 'vtt'];
// An empty first list is asked for once more at once from these clients (owner, 2026-10-25): the default clients answered
// a 33-minute video with no captions at all twice in 27 s, then with 176 auto tracks 2 minutes later, and no warning
// could say why because the job ran with --no-warnings. The warnings are kept now.
const EMPTY_RETRY = ['--extractor-args', 'youtube:player_client=web,mweb'];

// yt-dlp's stdout and its WARNING lines (at most 5, 300 characters each, repeats once).
export function runWarn(cmd, args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr).slice(-2000); reject(err); return; }
      resolve({ stdout: String(stdout), warnings: warningsFrom(stderr) });
    });
  });
}
export const warningsFrom = (stderr) => [...new Set(String(stderr ?? '').split(/\r?\n/).filter((l) => l.startsWith('WARNING:')).map((l) => l.slice(0, 300)))].slice(0, 5);
// Where yt-dlp lives when YTDLP is not set: the flash-check worker's venv on the Optiplex, else PATH.
const CANDIDATES = ['/opt/japharsworld-yt-slotworker-venv/bin/yt-dlp', 'yt-dlp'];

export async function findYtdlp(env = process.env) {
  if (env.YTDLP) return env.YTDLP;
  for (const c of CANDIDATES) {
    if (!c.startsWith('/')) return c;
    try { await access(c, constants.X_OK); return c; } catch { /* next */ }
  }
  return 'yt-dlp';
}
export const ytdlpArgs = (env = process.env) => (env.YTDLP_ARGS ?? '--js-runtimes node').split(' ').filter(Boolean);

// The list step (yt-dlp --write-info-json, then the parse) in its own temp folder: { dir, infoFile, full, info, warnings,
// retried }. The folder is removed here when the step fails, else by the last job using it (captionsJob).
async function listStep(videoId, { ytdlp, extraArgs, runner, tmp, timeoutMs, maxInfoBytes }) {
  const dir = await mkdtemp(join(tmp, 'jyt-cc-'));
  try {
    const warnings = [];
    const infoFile = join(dir, `${videoId}.info.json`);
    const readInfo = async (more) => {
      const r = await runner(ytdlp, [...extraArgs, '--no-cache-dir', '--skip-download', '--no-playlist', '-o', join(dir, '%(id)s'), ...more,
        '--write-info-json', '--no-write-comments', '--', `https://www.youtube.com/watch?v=${videoId}`], timeoutMs);
      if (r?.warnings) warnings.push(...r.warnings);
      // Over maxInfoBytes: TooLarge before any of it is read, so neither the retry below nor the track's
      // --load-info-json (yt-dlp loading the same file) runs (Everything-is-OK#968).
      const full = JSON.parse(await readCapped(infoFile, maxInfoBytes, 'info_too_large'));
      return { full, info: { language: full.language ?? null, manual: Object.keys(full.subtitles ?? {}).filter((k) => k !== 'live_chat'), auto: Object.keys(full.automatic_captions ?? {}) } };
    };
    let { full, info } = await readInfo([]);
    let retried = false;
    if (!info.manual.length && !info.auto.length) {
      retried = true;
      await rm(infoFile, { force: true });
      ({ full, info } = await readInfo(EMPTY_RETRY));
    }
    return { dir, infoFile, full, info, warnings, retried };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

// lists (the worker's, shared by its poll loops): video id → the list step in flight. A second caption job for the same
// video joins it instead of running yt-dlp and the parse again (Everything-is-OK#968: the server sent a second job for
// the crash video 40 s after the first, which the worker was still running). The key is the video alone: the
// list does not depend on `want`; each job then fetches its own track into its own folder.
export async function captionsJob(job, { ytdlp, extraArgs = [], runner = runWarn, scripts, tmp = tmpdir(), timeoutMs = 60_000, log = () => {},
  lists = null, maxInfoBytes = INFO_MAX_BYTES, maxTrackBytes = TRACK_MAX_BYTES } = {}) {
  const videoId = String(job.videoId ?? '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('bad videoId');
  let entry = lists?.get(videoId);
  if (!entry) {
    entry = { users: 0, step: listStep(videoId, { ytdlp, extraArgs, runner, tmp, timeoutMs, maxInfoBytes }) };
    if (lists) {
      lists.set(videoId, entry);
      // Settled: later jobs run their own list step (the signed URLs in it age).
      const drop = () => { if (lists.get(videoId) === entry) lists.delete(videoId); };
      entry.step.then(drop, drop);
    }
  }
  entry.users++;
  let list = null;
  let out = null;
  try {
    list = await entry.step;
    const { infoFile, full, info, retried } = list;
    const warnings = [...list.warnings];
    // A runner answers yt-dlp's stdout, or { stdout, warnings } (runWarn).
    const call = async (args) => { const r = await runner(ytdlp, args, timeoutMs); if (r?.warnings) warnings.push(...r.warnings); return r; };
    const extra = () => ({ ...(warnings.length ? { warnings } : {}), ...(retried ? { retried } : {}) });
    const done = (answer) => {
      const out = { ...answer, ...extra() };
      if (retried || warnings.length) log({ event: 'captions_list', id: videoId, retried, manual: info.manual.length, auto: info.auto.length, warnings });
      return out;
    };
    const want = job.want ?? null;
    if (!want) return done({ info, track: null, cues: null });
    let target;
    if (want.lang) {
      const tracks = orderTracks(tracksFromInfo(info), scripts);
      const i = pickTrack(tracks, want.lang);
      if (i < 0) return done({ info, track: null, cues: null, reason: tracks.length ? 'no_track_in_language' : 'no_captions' });
      target = tracks[i];
    } else target = { code: want.code, auto: Boolean(want.auto) };
    const key = keyFor(full, target);
    if (!key) return done({ info, track: null, cues: null, reason: 'no_track_in_language' });
    // This job's own folder for the track, so jobs sharing the list never see each other's files.
    out = await mkdtemp(join(tmp, 'jyt-cc-'));
    await call([...extraArgs, '--no-cache-dir', '--skip-download', '--no-playlist', '-o', join(out, '%(id)s'), '--load-info-json', infoFile,
      target.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', `^${escapeRe(key)}$`, '--sub-format', FORMATS.join('/')]);
    const files = await readdir(out);
    let found = null;
    for (const f of FORMATS) { const name = files.find((x) => x.startsWith(`${videoId}.`) && x.endsWith(`.${f}`)); if (name) { found = { name, format: f }; break; } }
    if (!found) return done({ info, track: { key, code: codeOfKey(key), auto: target.auto, format: null }, cues: null, reason: 'temporarily_unavailable' });
    const cues = cuesFrom(found.format, await readCapped(join(out, found.name), maxTrackBytes, 'track_too_large'));
    log({ event: 'captions_job', id: videoId, key, format: found.format, cues: cues.length, ...extra() });
    return done({ info, track: { key, code: codeOfKey(key), auto: target.auto, format: found.format }, cues });
  } finally {
    if (out) await rm(out, { recursive: true, force: true });
    if (--entry.users === 0 && list) await rm(list.dir, { recursive: true, force: true });
  }
}
