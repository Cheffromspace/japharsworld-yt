// Caption job for the relay worker (Everything is OK #77): yt-dlp from this residential connection fetches a
// video's caption track list and one track as YouTube's json3, which carries the start time of every word in
// auto-generated tracks. The server cannot do this itself: YouTube bot-walls caption requests from the Linode, and
// Tunelio's transcripts have segment timing only.
//
// Job: { kind: 'captions', videoId, want }   want: { lang } (a VRChat code or 'native') | { code, auto } | null (list only)
// Answer: { info: { language, manual: [keys], auto: [keys] }, track: { key, code, auto, format } | null, cues, reason? }
// Cues are src/cues.js cues; the server orders the list, caches and chunks (src/captionchain.js, src/blocks.js).
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, escapeRe } from '../src/captions.js';
import { cuesFrom, tracksFromInfo, codeOfKey, keyFor } from '../src/cues.js';
import { orderTracks, pickTrack } from '../src/transcripts.js';

const FORMATS = ['json3', 'srv3', 'vtt'];
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

export async function captionsJob(job, { ytdlp, extraArgs = [], runner = run, scripts, tmp = tmpdir(), timeoutMs = 60_000, log = () => {} } = {}) {
  const videoId = String(job.videoId ?? '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('bad videoId');
  const dir = await mkdtemp(join(tmp, 'jyt-cc-'));
  try {
    const common = [...extraArgs, '--no-cache-dir', '--no-warnings', '--skip-download', '--no-playlist', '-o', join(dir, '%(id)s')];
    await runner(ytdlp, [...common, '--write-info-json', '--no-write-comments', '--', `https://www.youtube.com/watch?v=${videoId}`], timeoutMs);
    const infoFile = join(dir, `${videoId}.info.json`);
    const full = JSON.parse(await readFile(infoFile, 'utf8'));
    const info = { language: full.language ?? null, manual: Object.keys(full.subtitles ?? {}).filter((k) => k !== 'live_chat'), auto: Object.keys(full.automatic_captions ?? {}) };
    const want = job.want ?? null;
    if (!want) return { info, track: null, cues: null };
    let target;
    if (want.lang) {
      const tracks = orderTracks(tracksFromInfo(info), scripts);
      const i = pickTrack(tracks, want.lang);
      if (i < 0) return { info, track: null, cues: null, reason: tracks.length ? 'no_track_in_language' : 'no_captions' };
      target = tracks[i];
    } else target = { code: want.code, auto: Boolean(want.auto) };
    const key = keyFor(full, target);
    if (!key) return { info, track: null, cues: null, reason: 'no_track_in_language' };
    await runner(ytdlp, [...common, '--load-info-json', infoFile, target.auto ? '--write-auto-subs' : '--write-subs',
      '--sub-langs', `^${escapeRe(key)}$`, '--sub-format', FORMATS.join('/')], timeoutMs);
    const files = await readdir(dir);
    let found = null;
    for (const f of FORMATS) { const name = files.find((x) => x.startsWith(`${videoId}.`) && x.endsWith(`.${f}`)); if (name) { found = { name, format: f }; break; } }
    if (!found) return { info, track: { key, code: codeOfKey(key), auto: target.auto, format: null }, cues: null, reason: 'temporarily_unavailable' };
    const cues = cuesFrom(found.format, await readFile(join(dir, found.name), 'utf8'));
    log({ event: 'captions_job', id: videoId, key, format: found.format, cues: cues.length });
    return { info, track: { key, code: codeOfKey(key), auto: target.auto, format: found.format }, cues };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
