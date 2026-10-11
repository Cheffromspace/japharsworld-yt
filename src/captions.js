// Captions through yt-dlp (with the bgutil PO-token provider installed on the server, yt-dlp adds
// the proof-of-origin token YouTube now requires on caption requests).
//
// Track choice for a visitor language L (candidates from LANGS[L]):
//   1. "manual"     - subtitles the uploader provided in L
//   2. "auto"       - YouTube's auto captions, when the video is spoken in L
//   3. "translated" - YouTube's machine translation of the original captions into L (flakiest:
//                     these are the requests YouTube rate-limits first)
// "native" asks for what the video actually says: manual in the original language, else the
// original auto captions, else any manual track.
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LANGS } from './query.js';

const INFO_MAX_AGE_MS = 60 * 60_000; // signed caption URLs inside the info JSON expire after a few hours
const MAX_LINES = 6000;
export const DEFAULT_ATTEMPTS = [
  ['--force-ipv6'],
  ['--extractor-args', 'youtube:player_client=tv_simply,android_vr,mweb'],
];

export function run(cmd, args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr).slice(-2000); reject(err); } else resolve(String(stdout));
    });
  });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const base = (k) => k.replace(/-orig$/, '');

export function originalLanguage(info) {
  const auto = Object.keys(info.automatic_captions ?? {});
  const orig = auto.find((k) => k.endsWith('-orig'));
  if (orig) return base(orig);
  return info.language || null;
}

// → { key, auto, source } or null
export function chooseTrack(info, lang) {
  const manual = Object.keys(info.subtitles ?? {}).filter((k) => k !== 'live_chat');
  const auto = Object.keys(info.automatic_captions ?? {});
  const orig = originalLanguage(info);
  const origAutoKey = auto.find((k) => k.endsWith('-orig')) ?? (orig && auto.includes(orig) ? orig : null);
  const matches = (key, c) => key === c || key.startsWith(c + '-');

  if (lang === 'native') {
    if (orig) {
      const m = manual.find((k) => base(k) === orig || matches(k, orig));
      if (m) return { key: m, auto: false, source: 'manual' };
    }
    if (origAutoKey) return { key: origAutoKey, auto: true, source: 'auto' };
    if (manual.length) return { key: manual[0], auto: false, source: 'manual' };
    return null;
  }

  const candidates = LANGS[lang] ?? [lang];
  for (const c of candidates) {
    const exact = manual.find((k) => k === c) ?? manual.find((k) => matches(k, c));
    if (exact) return { key: exact, auto: false, source: 'manual' };
  }
  if (origAutoKey && candidates.some((c) => matches(base(origAutoKey), c) || base(origAutoKey) === c.split('-')[0])) {
    return { key: origAutoKey, auto: true, source: 'auto' };
  }
  for (const c of candidates) {
    if (auto.includes(c)) return { key: c, auto: true, source: 'translated' };
  }
  return null;
}

// YouTube json3 → [[startSeconds, durationSeconds, text], ...]
export function parseJson3(raw) {
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const lines = [];
  for (const ev of doc.events ?? []) {
    if (!ev.segs || ev.aAppend) continue;
    const textLine = ev.segs.map((s) => s.utf8 ?? '').join('').replace(/\s*\n\s*/g, '\n').trim();
    if (!textLine) continue;
    const start = Math.round((ev.tStartMs ?? 0) / 10) / 100;
    const dur = Math.round((ev.dDurationMs ?? 0) / 10) / 100;
    lines.push([start, dur, textLine]);
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

export class Captions {
  constructor({ store, ytdlp, extraArgs = [], attempts = DEFAULT_ATTEMPTS, dataDir = 'data', cacheDays = 7, runner = run }) {
    // YouTube answers "Sign in to confirm you're not a bot" to some requests from datacenter IPv4.
    // Each attempt adds its own arguments to extraArgs; the one that last worked is tried first.
    this.attempts = attempts.length ? attempts : [[]];
    this.preferred = 0;
    this.store = store;
    this.ytdlp = ytdlp;
    this.extraArgs = extraArgs;
    this.infoDir = join(dataDir, 'info');
    this.subsDir = join(dataDir, 'subs');
    this.maxAgeMs = cacheDays * 86400_000;
    this.run = runner;
    this.inflight = new Map();
  }

  async info(videoId) {
    await mkdir(this.infoDir, { recursive: true });
    const file = join(this.infoDir, `${videoId}.json`);
    try {
      const s = await stat(file);
      if (Date.now() - s.mtimeMs < INFO_MAX_AGE_MS) return { file, info: JSON.parse(await readFile(file, 'utf8')) };
    } catch { /* not cached */ }
    const order = this.attempts.map((_, i) => (i + this.preferred) % this.attempts.length);
    let lastError;
    for (const i of order) {
      try {
        await this.run(this.ytdlp, [...this.extraArgs, ...this.attempts[i], '--skip-download', '--no-playlist', '--no-warnings',
          '--write-info-json', '--no-write-comments', '-o', join(this.infoDir, '%(id)s'),
          '--', `https://www.youtube.com/watch?v=${videoId}`]);
        this.preferred = i;
        lastError = null;
        break;
      } catch (err) { lastError = err; }
    }
    if (lastError) throw lastError;
    // yt-dlp writes <id>.info.json; keep a stable name.
    const written = join(this.infoDir, `${videoId}.info.json`);
    const info = JSON.parse(await readFile(written, 'utf8'));
    await rm(file, { force: true });
    await rename(written, file);
    return { file, info };
  }

  async download(videoId, infoFile, track) {
    await mkdir(this.subsDir, { recursive: true });
    await this.run(this.ytdlp, [...this.extraArgs, ...this.attempts[this.preferred], '--load-info-json', infoFile, '--skip-download', '--no-warnings',
      track.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', `^${escapeRe(track.key)}$`,
      '--sub-format', 'json3', '-o', join(this.subsDir, '%(id)s')]);
    const name = (await readdir(this.subsDir)).find((f) => f.startsWith(`${videoId}.`) && f.endsWith(`.${track.key}.json3`))
      ?? `${videoId}.${track.key}.json3`;
    const path = join(this.subsDir, name);
    const raw = await readFile(path, 'utf8');
    await rm(path, { force: true });
    return parseJson3(raw);
  }

  // lang: a key of LANGS, or 'native'. Returns { id, lang, available, source?, key?, lines? }.
  get(videoId, lang) {
    const k = `${videoId}|${lang}`;
    if (!this.inflight.has(k)) {
      this.inflight.set(k, this.#get(videoId, lang).finally(() => this.inflight.delete(k)));
    }
    return this.inflight.get(k);
  }

  async #get(videoId, lang) {
    const cached = this.store.captionGet(videoId, lang, this.maxAgeMs);
    if (cached) return cached;
    return this.#ytdlp(videoId, lang);
  }

  async #ytdlp(videoId, lang) {
    const { file, info } = await this.info(videoId);
    const track = chooseTrack(info, lang);
    let result;
    if (!track) {
      result = { id: videoId, lang, available: false, original: originalLanguage(info) };
    } else {
      const lines = await this.download(videoId, file, track);
      result = { id: videoId, lang, available: lines.length > 0, source: track.source, key: track.key,
        original: originalLanguage(info), lines };
    }
    this.store.captionPut(videoId, lang, result);
    return result;
  }
}
