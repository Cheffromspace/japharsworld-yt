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
import { cuesFrom } from './cues.js';
import { randomBytes } from 'node:crypto';
import { refusalClass, RESTRICTED } from './refusal.js';

const INFO_MAX_AGE_MS = 60 * 60_000; // signed caption URLs inside the info JSON expire after a few hours
const MAX_LINES = 6000;

// Caption files are read whole and parsed whole, so a file over these sizes is refused unread (Everything-is-OK#968:
// the home worker died out of heap parsing the info JSON of a multi-hour livestream recording YouTube had not finished
// processing; for such a video yt-dlp lists every stream fragment of every format, inferred, not measured).
// INFO_MAX_BYTES: an ordinary 76-minute video with 173 auto-caption languages and 118 formats wrote a 6.82 MB info JSON
// (measured with yt-dlp 2026.08.19 on a development PC, 2026-11-21; 6.5 MB of it is automatic_captions, which does not
// grow with the video's length) and needed a 20-24 MB heap to parse; a synthetic fragment-list file needed about 3.5x
// its size (17.7 MB: 48-64 MB, 33.4 MB: 96-128 MB). 40 MB is about 6x that file and costs about 150 MB of heap a parse.
// 40 MB relies on the home worker's explicit 2 GB heap (deploy/japharsworld-yt-relay.service, NODE_OPTIONS): without it
// Node sizes the heap from the cgroup (about 550 MB at 1G) and this limit should be about 16 MB. The search service's
// own yt-dlp path (Captions below) uses it too, but that path is built only with CAPTION_LOCAL_YTDLP=on or with Tunelio
// off (src/server.js); there a near-limit parse costs about 150 MB against the service's 400M cap, so whoever switches
// that path on lowers the limit first.
// TRACK_MAX_BYTES: a json3 track for 5 h of speech is about 3-6 MB (inferred: ~150 words a minute, ~50 bytes a word,
// not measured), so the 12 h video cap (VIDEO_MAX_HOURS) gives about 13 MB at most; 32 MB is far above that.
export const INFO_MAX_BYTES = 40 * 1024 * 1024;
export const TRACK_MAX_BYTES = 32 * 1024 * 1024;
// The clean error for a refused file, code 'info_too_large' or 'track_too_large'. The relay worker sends the code as its
// job's error with no refusal class (YouTube refused nothing), and the caption chain goes on to its next source, so a
// visitor gets what a failed worker gives today (temporarily_unavailable).
export const TOO_LARGE = ['info_too_large', 'track_too_large'];
export class TooLarge extends Error {
  constructor(code, bytes) {
    super(code);
    this.code = code;
    this.bytes = bytes;
  }
}
// The file as text, or TooLarge when it is over max bytes (stat first: none of it is read).
export async function readCapped(path, max, code) {
  const { size } = await stat(path);
  if (size > max) throw new TooLarge(code, size);
  return readFile(path, 'utf8');
}
export const DEFAULT_ATTEMPTS = [
  ['--force-ipv6'],
  ['--extractor-args', 'youtube:player_client=tv_simply,android_vr,mweb'],
];

// YouTube's refusal of an address it does not trust (datacenter ranges, mostly). Not an age gate, which shares the
// "Sign in to confirm" wording but is about the video (src/refusal.js RESTRICTED, world #305).
export function isBotWall(err) {
  const text = String(err?.stderr ?? '') + String(err?.message ?? '');
  return /Sign in to confirm/i.test(text) && !RESTRICTED.test(text);
}

// The line worth logging: yt-dlp's ERROR line, not the cookie help text that follows it.
export function errorLine(err) {
  const text = String(err?.stderr || err?.message || err);
  const line = text.split('\n').find((l) => l.startsWith('ERROR')) ?? text.trim().split('\n').pop() ?? '';
  return line.slice(0, 200);
}

// A random address inside a routed /64 such as 2600:3c06:e001:35e::/64.
export function randomAddress(prefix, bytes = randomBytes(8)) {
  const [addr, len = '64'] = prefix.trim().split('/');
  if (len !== '64') throw new Error('SOURCE_IPV6_PREFIX must be a /64');
  const [head, tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  if (groups.length !== 8) throw new Error('SOURCE_IPV6_PREFIX is not an IPv6 prefix');
  const host = [0, 2, 4, 6].map((i) => bytes.readUInt16BE(i).toString(16));
  return [...groups.slice(0, 4), ...host].join(':');
}

export function run(cmd, args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr).slice(-2000); reject(err); } else resolve(String(stdout));
    });
  });
}

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  constructor({ store, ytdlp, extraArgs = [], attempts = DEFAULT_ATTEMPTS, dataDir = 'data', cacheDays = 7, runner = run,
    sourcePrefix = '', blockedMinutes = 10, now = () => Date.now(), onRefusal = () => {}, maxInfoBytes = INFO_MAX_BYTES, maxTrackBytes = TRACK_MAX_BYTES }) {
    // YouTube answers "Sign in to confirm you're not a bot" to some requests from datacenter IPv4.
    // Each attempt adds its own arguments to extraArgs; the one that last worked is tried first.
    this.attempts = attempts.length ? attempts : [[]];
    this.preferred = 0;
    this.store = store;
    this.ytdlp = ytdlp;
    this.extraArgs = extraArgs;
    this.infoDir = join(dataDir, 'info');
    this.maxInfoBytes = maxInfoBytes; // #968 (tests set smaller ones)
    this.maxTrackBytes = maxTrackBytes;
    this.subsDir = join(dataDir, 'subs');
    this.maxAgeMs = cacheDays * 86400_000;
    // Every failed yt-dlp run is counted by class (yt_refusal linode:<class>, src/refusal.js).
    this.run = (...a) => runner(...a).catch((err) => { onRefusal(refusalClass(err)); throw err; });
    this.inflight = new Map();
    this.recentMisses = new Map();
    // With a routed IPv6 range, every lookup goes out from a random address in it. The signed caption URLs
    // YouTube hands back are tied to the asking address, so each video remembers which one fetched its info.
    this.sourcePrefix = sourcePrefix;
    this.addresses = new Map();
    // After a bot-wall refusal on every attempt, stop asking YouTube for a while: more refused requests
    // only make the block last longer, and each visitor would wait for the same answer.
    this.blockedMs = blockedMinutes * 60_000;
    this.blockedUntil = 0;
    this.now = now;
  }

  attemptArgs(i, address) {
    if (!address) return this.attempts[i];
    return ['--source-address', address, ...this.attempts[i].filter((a) => a !== '--force-ipv6')];
  }

  blockedAnswer(videoId, lang) {
    return { id: videoId, lang, available: false, reason: 'temporarily_unavailable' };
  }

  async info(videoId) {
    await mkdir(this.infoDir, { recursive: true });
    const file = join(this.infoDir, `${videoId}.json`);
    if (!this.sourcePrefix || this.addresses.has(videoId)) {
      try {
        const s = await stat(file);
        if (Date.now() - s.mtimeMs < INFO_MAX_AGE_MS) return { file, info: JSON.parse(await readCapped(file, this.maxInfoBytes, 'info_too_large')) };
      } catch (err) {
        // Not cached, or an oversized copy: that one is deleted and refused.
        if (err instanceof TooLarge) { await rm(file, { force: true }); throw err; }
      }
    }
    const order = this.attempts.map((_, i) => (i + this.preferred) % this.attempts.length);
    let lastError;
    for (const i of order) {
      const address = this.sourcePrefix ? randomAddress(this.sourcePrefix) : null;
      try {
        await this.run(this.ytdlp, [...this.extraArgs, ...this.attemptArgs(i, address), '--skip-download', '--no-playlist', '--no-warnings',
          '--write-info-json', '--no-write-comments', '-o', join(this.infoDir, '%(id)s'),
          '--', `https://www.youtube.com/watch?v=${videoId}`]);
        this.preferred = i;
        if (address) {
          if (this.addresses.size > 5000) this.addresses.clear();
          this.addresses.set(videoId, address);
        }
        lastError = null;
        break;
      } catch (err) { lastError = err; }
    }
    if (lastError) {
      if (isBotWall(lastError)) { this.blockedUntil = this.now() + this.blockedMs; lastError.blocked = true; }
      throw lastError;
    }
    // yt-dlp writes <id>.info.json; keep a stable name.
    const written = join(this.infoDir, `${videoId}.info.json`);
    let info;
    // An oversized file is deleted, never kept for the next lookup in data/info.
    try { info = JSON.parse(await readCapped(written, this.maxInfoBytes, 'info_too_large')); } catch (err) {
      if (err instanceof TooLarge) await rm(written, { force: true });
      throw err;
    }
    await rm(file, { force: true });
    await rename(written, file);
    return { file, info };
  }

  async download(videoId, infoFile, track) {
    await mkdir(this.subsDir, { recursive: true });
    await this.run(this.ytdlp, [...this.extraArgs, ...this.attemptArgs(this.preferred, this.addresses.get(videoId) ?? null), '--load-info-json', infoFile, '--skip-download', '--no-warnings',
      track.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', `^${escapeRe(track.key)}$`,
      '--sub-format', 'json3', '-o', join(this.subsDir, '%(id)s')]);
    const name = (await readdir(this.subsDir)).find((f) => f.startsWith(`${videoId}.`) && f.endsWith(`.${track.key}.json3`))
      ?? `${videoId}.${track.key}.json3`;
    const path = join(this.subsDir, name);
    try { return parseJson3(await readCapped(path, this.maxTrackBytes, 'track_too_large')); } finally { await rm(path, { force: true }); }
  }

  // True while a bot-wall refusal has paused lookups (the caption chain then skips this source at once).
  get blocked() { return this.now() < this.blockedUntil; }

  // One track as cues (src/cues.js) for the caption chain: json3 first (word timing), srv3, then vtt.
  async cues(videoId, infoFile, track) {
    await mkdir(this.subsDir, { recursive: true });
    const formats = ['json3', 'srv3', 'vtt'];
    await this.run(this.ytdlp, [...this.extraArgs, ...this.attemptArgs(this.preferred, this.addresses.get(videoId) ?? null), '--load-info-json', infoFile, '--skip-download', '--no-warnings',
      track.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', `^${escapeRe(track.key)}$`,
      '--sub-format', formats.join('/'), '-o', join(this.subsDir, '%(id)s')]);
    const files = await readdir(this.subsDir);
    for (const f of formats) {
      const name = files.find((x) => x.startsWith(`${videoId}.`) && x.endsWith(`.${track.key}.${f}`));
      if (!name) continue;
      const path = join(this.subsDir, name);
      try { return cuesFrom(f, await readCapped(path, this.maxTrackBytes, 'track_too_large')); } finally { await rm(path, { force: true }); }
    }
    throw new Error(`yt-dlp wrote no ${formats.join('/')} file for ${videoId} ${track.key}`);
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
    const miss = this.recentMisses.get(`${videoId}|${lang}`);
    if (miss && Date.now() - miss.at < 3600_000) return miss.answer;
    if (this.recentMisses.size > 5000) this.recentMisses.clear();
    if (this.now() < this.blockedUntil) return this.blockedAnswer(videoId, lang);
    return this.#ytdlp(videoId, lang);
  }

  async #ytdlp(videoId, lang) {
    let file, info;
    try {
      ({ file, info } = await this.info(videoId));
    } catch (err) {
      // Not cached: try again after the pause. An oversized file (#968): the same "not available right now".
      if (err.blocked || err instanceof TooLarge) return this.blockedAnswer(videoId, lang);
      throw err;
    }
    const track = chooseTrack(info, lang);
    let result;
    if (!track) {
      result = { id: videoId, lang, available: false, original: originalLanguage(info) };
    } else {
      let lines;
      try {
        lines = await this.download(videoId, file, track);
      } catch (err) {
        // YouTube throttles machine-translated tracks first. Say "not available" instead of failing,
        // and remember it for an hour so each visitor doesn't wait for the same refusal.
        if (err instanceof TooLarge) return this.blockedAnswer(videoId, lang);
        if (isBotWall(err)) { this.blockedUntil = this.now() + this.blockedMs; return this.blockedAnswer(videoId, lang); }
        if (track.source !== 'translated') throw err;
        const answer = { id: videoId, lang, available: false, reason: 'translation_unavailable', original: originalLanguage(info) };
        this.recentMisses.set(`${videoId}|${lang}`, { at: Date.now(), answer });
        return answer;
      }
      result = { id: videoId, lang, available: lines.length > 0, source: track.source, key: track.key,
        original: originalLanguage(info), lines };
    }
    this.store.captionPut(videoId, lang, result);
    return result;
  }
}
