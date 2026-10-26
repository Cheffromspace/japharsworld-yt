// The worker's own cache of finished home relay streams (owner, 2026-10-23: "be aggressive, the Optiplex has lots of
// disk"). The server keeps a stream HOME_KEEP_HOURS; after that a replay would download the video from YouTube again,
// which counts against HOME_DAILY_MB and the home IP's standing with YouTube. So the worker keeps each finished stream's
// segments and final playlist here, one folder per video and quality, and a later job for it is uploaded from disk
// (relay/media.js), without yt-dlp or YouTube. Least recently used out above maxGb.
//
// <dir>/<videoId>@<quality>/  seg0.ts … and index.m3u8 (the playlist the server got last, ENDLIST included), meta.json
// <dir>/.tmp-*                a stream being made (moved in by put when it finished; left over ones are removed at start)
// It lives in systemd's CacheDirectory (/var/cache/japharsworld-yt-relay). Set with RELAY_CACHE_GB (default 40, sized
// for the Optiplex's 98 GB root before the cache had its own volume; 0 = off). That directory is now the 492 GB
// jyt-media volume (README), so the env file sets 440 (owner card, #242, 2026-10-26: the default had been left on,
// 41 GB used with 451 GB free).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KEY = /^[A-Za-z0-9_-]{11}@\d{3,4}p$/;
const SEGMENT = /^seg\d{1,5}\.ts$/;
// The stream format (relay/media.js ffmpegArgs). Entries of another are made again: 2 = SPS/PPS in every segment (2026-10-23).
export const FORMAT = 2;

export class MediaCache {
  constructor({ dir, maxGb = 40, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { dir, maxGb, now, log });
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) if (f.startsWith('.tmp-')) rmSync(join(dir, f), { recursive: true, force: true });
  }

  // A folder for a stream being made, on the cache's own disk (so put is a rename, and a long video doesn't fill /tmp).
  staging() { return mkdtempSync(join(this.dir, '.tmp-')); }

  #meta(key) { try { return JSON.parse(readFileSync(join(this.dir, key, 'meta.json'), 'utf8')); } catch { return null; } }

  // → { dir, playlist, segments: [file…], mb } for a complete cached stream, or null. A hit counts as a use (LRU).
  get(videoId, quality) {
    const key = `${videoId}@${quality}`;
    if (!KEY.test(key)) return null;
    const meta = this.#meta(key);
    if (!meta) return null;
    if (meta.format !== FORMAT) { rmSync(join(this.dir, key), { recursive: true, force: true }); return null; }
    const dir = join(this.dir, key);
    let playlist;
    try { playlist = readFileSync(join(dir, 'index.m3u8'), 'utf8'); } catch { return null; }
    const segments = playlist.split(/\r?\n/).filter((l) => SEGMENT.test(l));
    if (!segments.length || !segments.every((s) => existsSync(join(dir, s)))) { rmSync(dir, { recursive: true, force: true }); return null; }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, usedMs: this.now() }));
    return { dir, playlist, segments, mb: meta.mb };
  }

  // A finished stream: its staging folder becomes the cached copy (replacing an older one), if every segment the playlist
  // lists is in it. → true when kept; the staging folder is gone either way.
  put(videoId, quality, staging, playlist) {
    const key = `${videoId}@${quality}`;
    const segments = playlist.split(/\r?\n/).filter((l) => SEGMENT.test(l));
    const complete = KEY.test(key) && playlist.includes('#EXT-X-ENDLIST') && segments.length > 0 && segments.every((s) => existsSync(join(staging, s)));
    if (!complete || !(this.maxGb > 0)) { rmSync(staging, { recursive: true, force: true }); return false; }
    let bytes = 0;
    for (const f of readdirSync(staging)) {
      if (SEGMENT.test(f) && segments.includes(f)) bytes += statSync(join(staging, f)).size;
      else rmSync(join(staging, f), { force: true }); // ffmpeg's own playlist and segments the final playlist doesn't list
    }
    writeFileSync(join(staging, 'index.m3u8'), playlist);
    writeFileSync(join(staging, 'meta.json'), JSON.stringify({ format: FORMAT, bytes, mb: Math.round(bytes / 1e5) / 10, savedMs: this.now(), usedMs: this.now() }));
    rmSync(join(this.dir, key), { recursive: true, force: true });
    renameSync(staging, join(this.dir, key));
    this.log({ event: 'media_cached', quality, mb: Math.round(bytes / 1e6), segments: segments.length });
    this.evict();
    return true;
  }

  // Least recently used out until the cache is under maxGb. → { entries, mb } left.
  evict() {
    const entries = readdirSync(this.dir).filter((k) => KEY.test(k)).map((k) => ({ k, m: this.#meta(k) }))
      .filter((e) => { if (e.m) return true; rmSync(join(this.dir, e.k), { recursive: true, force: true }); return false; })
      .sort((a, b) => (a.m.usedMs ?? 0) - (b.m.usedMs ?? 0));
    const size = (m) => (m.bytes ?? (m.mb ?? 0) * 1e6) / 1e6;
    let mb = entries.reduce((a, e) => a + size(e.m), 0);
    while (entries.length && mb > this.maxGb * 1000) {
      const e = entries.shift();
      rmSync(join(this.dir, e.k), { recursive: true, force: true });
      mb -= size(e.m);
      this.log({ event: 'media_evicted', mb: Math.round(size(e.m)) });
    }
    return { entries: entries.length, mb: Math.round(mb) };
  }
}
