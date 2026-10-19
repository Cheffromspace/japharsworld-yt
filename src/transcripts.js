// Captions through Tunelio's /transcript (replaces yt-dlp, which YouTube bot-walls from the Linode).
//
// A video's tracks are what its uploader provided plus YouTube's auto captions in the spoken language.
// YouTube's machine translations are NOT available through Tunelio, and asking for a language the video does not
// have quietly returns English instead, so every answer is checked against the track we asked for.
//
// Two ways to ask, both for the video last played in a shard:
//   by visitor language (a VRChat code) or 'native'  → the best matching track, plus the full track list
//   by track number i (0-based, into that list)     → that exact track (the tablet's caption picker)
// The list is the same for every visitor (only the display names follow the asking language), so a number means
// the same track for everyone. Tracks in scripts the world cannot draw are left out of the list.
import { LANGS } from './query.js';

export const DEFAULT_SCRIPTS = ['Latn', 'Cyrl', 'Hans', 'Hant', 'Jpan', 'Kore', 'Thai', 'Hebr'];
const UI_LOCALE = { 'zh-CN': 'zh-Hans', 'zh-HK': 'zh-Hant', tok: 'en' };

export function scriptOf(code) {
  try { return new Intl.Locale(code).maximize().script ?? null; } catch { return null; }
}
const lower = (s) => String(s ?? '').toLowerCase();
const baseOf = (s) => lower(s).split('-')[0];

// Tunelio's list → our ordered, filtered list: uploader tracks first, then auto captions; duplicates dropped.
export function orderTracks(raw, scripts = DEFAULT_SCRIPTS) {
  const ok = new Set(scripts);
  const seen = new Set();
  const out = [];
  for (const t of [...raw.filter((x) => !x.auto), ...raw.filter((x) => x.auto)]) {
    const k = `${lower(t.code)}|${t.auto ? 'a' : 'm'}`;
    if (seen.has(k) || !t.code) continue;
    seen.add(k);
    const script = scriptOf(t.code);
    if (!script || !ok.has(script)) continue;
    out.push({ code: t.code, auto: Boolean(t.auto) });
  }
  return out;
}

// → index into tracks, or -1. lang: a VRChat code (key of LANGS) or 'native'.
export function pickTrack(tracks, lang) {
  if (!tracks.length) return -1;
  if (lang === 'native') {
    const auto = tracks.findIndex((t) => t.auto);
    if (auto >= 0) {
      const spoken = baseOf(tracks[auto].code);
      const manual = tracks.findIndex((t) => !t.auto && baseOf(t.code) === spoken);
      return manual >= 0 ? manual : auto;
    }
    return 0; // no auto captions: the first uploader track
  }
  const candidates = LANGS[lang] ?? [lang];
  const chinese = lang.startsWith('zh');
  for (const auto of [false, true]) {
    const pool = tracks.map((t, i) => ({ t, i })).filter((x) => x.t.auto === auto);
    for (const c of candidates) { const m = pool.find((x) => lower(x.t.code) === lower(c)); if (m) return m.i; }
    // Bare "zh" would also catch the other script (zh-Hans vs zh-Hant), so Chinese only matches with its script.
    for (const c of candidates) { if (chinese && !c.includes('-')) continue; const m = pool.find((x) => lower(x.t.code).startsWith(lower(c) + '-')); if (m) return m.i; }
    if (!chinese) for (const c of candidates) { const m = pool.find((x) => baseOf(x.t.code) === baseOf(c)); if (m) return m.i; }
  }
  return -1;
}

export function displayName(code, uiLang) {
  const loc = UI_LOCALE[uiLang] ?? uiLang ?? 'en';
  try {
    const n = new Intl.DisplayNames([loc, 'en'], { type: 'language', fallback: 'code' }).of(code);
    return n ? n.charAt(0).toLocaleUpperCase(loc) + n.slice(1) : code;
  } catch { return code; }
}

export class TunelioCaptions {
  constructor({ store, tunelio, cacheDays = 7, scripts = DEFAULT_SCRIPTS, alert = () => {}, log = () => {} }) {
    this.store = store;
    this.tunelio = tunelio;
    this.maxAgeMs = cacheDays * 86400_000;
    this.scripts = scripts;
    this.alert = alert;
    this.log = log;
    this.inflight = new Map();
  }

  // Same promise for concurrent askers of the same thing (six visitors loading captions at once).
  once(key, fn) {
    if (!this.inflight.has(key)) this.inflight.set(key, fn().finally(() => this.inflight.delete(key)));
    return this.inflight.get(key);
  }

  // → { id, lang, available, ... } (see answer())
  get(videoId, lang) {
    return this.once(`${videoId}|${lang}`, async () => {
      const tracks = await this.tracks(videoId, lang === 'native' ? null : (LANGS[lang] ?? [lang])[0]);
      if (!tracks) return this.unavailable(videoId, lang, 'temporarily_unavailable');
      const i = pickTrack(tracks, lang);
      return this.answer(videoId, lang, tracks, i);
    });
  }

  track(videoId, i, uiLang = 'en') {
    return this.once(`${videoId}|#${i}|${uiLang}`, async () => {
      const tracks = await this.tracks(videoId, null);
      if (!tracks) return this.unavailable(videoId, uiLang, 'temporarily_unavailable');
      return this.answer(videoId, uiLang, tracks, i < tracks.length ? i : -1);
    });
  }

  unavailable(videoId, lang, reason) { return { id: videoId, lang, available: false, reason, tracks: [], track: -1 }; }

  async answer(videoId, lang, tracks, i) {
    const list = tracks.map((t, n) => ({ i: n, code: t.code, name: displayName(t.code, lang === 'native' ? 'en' : lang), auto: t.auto }));
    const autoTrack = tracks.find((t) => t.auto);
    const base = { id: videoId, lang, original: autoTrack ? baseOf(autoTrack.code) : null, tracks: list, track: i };
    if (i < 0) return { ...base, available: false, reason: tracks.length ? 'no_track_in_language' : 'no_captions' };
    const t = tracks[i];
    const lines = await this.lines(videoId, t);
    if (!lines) return { ...base, available: false, reason: 'temporarily_unavailable' };
    return { ...base, available: lines.length > 0, source: t.auto ? 'auto' : 'manual', key: t.code, lines };
  }

  // The video's track list (cached). The call that learns it also returns one track: ask for `guess` so that, for the
  // common case, the list and the visitor's own captions cost one call. Returns null when Tunelio cannot answer now.
  async tracks(videoId, guess) {
    const cached = this.store.captionGet(videoId, 'tracks', this.maxAgeMs);
    if (cached) return cached;
    return this.once(`${videoId}|tracks`, async () => {
      const got = await this.fetch(videoId, guess ?? 'en', 'any');
      if (got === null) return null;
      if (got === 'none') { this.store.captionPut(videoId, 'tracks', []); return []; }
      const tracks = orderTracks(got.tracks, this.scripts);
      this.store.captionPut(videoId, 'tracks', tracks);
      this.keep(videoId, got);
      return tracks;
    });
  }

  async lines(videoId, t) {
    const key = `t:${lower(t.code)}:${t.auto ? 'auto' : 'manual'}`;
    const cached = this.store.captionGet(videoId, key, this.maxAgeMs);
    if (cached) return cached;
    return this.once(`${videoId}|${key}`, async () => {
      const got = await this.fetch(videoId, t.code, t.auto ? 'auto' : 'manual');
      if (got === null || got === 'none') return null;
      this.keep(videoId, got);
      // Tunelio answered with a different track than we asked for (its silent English fallback).
      if (lower(got.language) !== lower(t.code) || (got.type === 'auto') !== t.auto) {
        this.log({ event: 'transcript_mismatch', id: videoId, asked: t.code, auto: t.auto, got: got.language, type: got.type });
        return null;
      }
      return got.lines;
    });
  }

  // Cache whatever track an answer carried, under its real language and type.
  keep(videoId, got) {
    if (!got.language) return;
    this.store.captionPut(videoId, `t:${lower(got.language)}:${got.type === 'auto' ? 'auto' : 'manual'}`, got.lines);
  }

  // → transcript | 'none' (the video has no captions) | null (Tunelio failed; try again later, not cached)
  async fetch(videoId, lang, type) {
    try {
      return await this.tunelio.transcript(videoId, lang, type);
    } catch (err) {
      this.log({ event: 'transcript_error', id: videoId, lang, type, status: err.status, code: err.code, message: String(err.message).slice(0, 200) });
      if (err.status === 404 || err.status === 400 || err.status === 422) return 'none';
      if (err.status === 402) this.alert('credits_out', 'Tunelio is out of credits: captions and HD playback are off until credits return.');
      return null;
    }
  }
}
