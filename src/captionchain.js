// Where a video's captions come from, in order (owner, 2026-10-22: "a bunch of imperfect solutions mashed together to
// create some semblance of High Availability"; Everything is OK #77):
//   1. a relay worker on a residential connection (relay/captions.js): yt-dlp json3, free, real word timing
//   2. yt-dlp on this server (src/captions.js): the same, when YouTube is not bot-walling us (CAPTION_LOCAL_YTDLP=on)
//   3. Tunelio /transcript (src/transcripts.js): 6 credits a track, segment timing only
// Every source answers in one shape and is cached the same way, so the picker's track numbers mean the same thing
// however the list was learned, and the world sees `words: "real" | "estimated"` for what it is about to highlight.
//
// Public API as TunelioCaptions had it (server.js /cc routes): get(videoId, lang), track(videoId, i, uiLang), plus
// tracks(videoId, uiLang) (the list alone, free sources only) and warm(videoId), which the play route calls (only the
// free sources are used for warming).
import { orderTracks, pickTrack, displayName, DEFAULT_SCRIPTS } from './transcripts.js';
import { tracksFromInfo, codeOfKey, keyFor, linesFromCues, cuesFromLines } from './cues.js';
import { chunksFromCues } from './blocks.js';

const lower = (s) => String(s ?? '').toLowerCase();
const short = (err) => String(err?.message ?? err).slice(0, 300);
const cueKey = (t) => `c1:${lower(t.code)}:${t.auto ? 'auto' : 'manual'}`;
const legacyKey = (t) => `t:${lower(t.code)}:${t.auto ? 'auto' : 'manual'}`;
const same = (a, b) => lower(a.code) === lower(b.code) && Boolean(a.auto) === Boolean(b.auto);
// The yt-dlp key may carry a variant id or "-orig": match tracks by language code (then by its base) and kind.
const matches = (a, b) => Boolean(a.auto) === Boolean(b.auto) && (lower(a.code) === lower(b.code) || lower(a.code).split('-')[0] === lower(b.code).split('-')[0]);

// An empty list is suspect: YouTube sometimes answers the home IP with no captions at all and no error (2026-10-25: a
// 100-minute video got 0 tracks in two lookups 2 s apart, then 176 auto tracks 25 minutes later). So the first empty
// answer is only marked (EMPTY_KEY), the next request looks once more, and a second empty answer is kept for emptyMs.
const EMPTY_KEY = 'tracks-empty';

export class CaptionChain {
  constructor({ store, relay = null, local = null, tunelio = null, cacheDays = 7, emptyMinutes = 30, scripts = DEFAULT_SCRIPTS,
    relayWaitMs = 40_000, metrics = null, log = () => {} }) {
    this.store = store;
    this.relay = relay;
    this.local = local;      // a Captions instance (yt-dlp on this server) or null
    this.tunelio = tunelio;  // a TunelioCaptions instance or null
    this.maxAgeMs = cacheDays * 86400_000;
    this.emptyMs = emptyMinutes * 60_000;
    this.looking = new Map(); // video id → its lookup in flight (any want), so the CC list can wait for the play's warm-up
    this.scripts = scripts;
    this.relayWaitMs = relayWaitMs;
    this.metrics = metrics;
    this.log = log;
    this.inflight = new Map();
  }

  once(key, fn) {
    if (!this.inflight.has(key)) this.inflight.set(key, fn().finally(() => this.inflight.delete(key)));
    return this.inflight.get(key);
  }

  get free() { return Boolean((this.relay?.enabled && this.relay.online('captions').length) || (this.local && !this.local.blocked)); }

  // ---- public ----
  get(videoId, lang) {
    return this.once(`${videoId}|${lang}`, async () => {
      let tracks = this.list(videoId);
      if (!tracks) {
        const got = await this.resolve(videoId, { lang });
        tracks = this.list(videoId) ?? got?.tracks ?? null;
        if (!tracks) return this.unavailable(videoId, lang, 'temporarily_unavailable');
      }
      return this.answer(videoId, lang, tracks, pickTrack(tracks, lang));
    });
  }

  track(videoId, i, uiLang = 'en') {
    return this.once(`${videoId}|#${i}|${uiLang}`, async () => {
      let tracks = this.list(videoId);
      if (!tracks) {
        const got = await this.resolve(videoId, null);
        tracks = this.list(videoId) ?? got?.tracks ?? null;
        if (!tracks) return this.unavailable(videoId, uiLang, 'temporarily_unavailable');
      }
      return this.answer(videoId, uiLang, tracks, i >= 0 && i < tracks.length ? i : -1);
    });
  }

  // The picker's list alone, never spending credits (Everything is OK #76: the CC popover opens straight onto Off and
  // the video's languages, so this is asked for every search video someone opens the picker on). Usually already cached
  // by warm(); otherwise the free sources are asked once. Without a free source it says so rather than paying Tunelio.
  tracks(videoId, uiLang = 'en') {
    return this.once(`${videoId}|tracks|${uiLang}`, async () => {
      let tracks = this.list(videoId);
      // The play's warm-up is usually still looking when the popover opens (2026-10-25: 2 s apart, two lookups): its
      // answer has the list, so wait for it rather than asking YouTube again from the same IP.
      if (!tracks && this.looking.has(videoId)) {
        const got = await this.looking.get(videoId).catch(() => null);
        tracks = this.list(videoId) ?? got?.tracks ?? null;
      }
      if (!tracks && this.free) {
        const got = await this.resolve(videoId, null, { freeOnly: true });
        tracks = this.list(videoId) ?? got?.tracks ?? null;
      }
      if (!tracks) return { id: videoId, lang: uiLang, available: false, reason: this.free ? 'temporarily_unavailable' : 'list_unavailable', tracks: [], track: -1 };
      const lang = uiLang === 'native' ? 'en' : uiLang;
      const list = tracks.map((t, n) => ({ i: n, code: t.code, name: displayName(t.code, lang), auto: t.auto }));
      const autoTrack = tracks.find((t) => t.auto);
      const base = { id: videoId, lang: uiLang, original: autoTrack ? lower(autoTrack.code).split('-')[0] : null, tracks: list, track: -1 };
      return tracks.length ? { ...base, available: true } : { ...base, available: false, reason: 'no_captions' };
    });
  }

  // Captions that cost nothing are fetched as soon as a video plays, so they are there when someone taps CC.
  warm(videoId) {
    if (!this.free) return;
    this.get(videoId, 'native').catch(() => {});
  }

  // ---- answers ----
  unavailable(videoId, lang, reason) { return { id: videoId, lang, available: false, reason, tracks: [], track: -1 }; }

  async answer(videoId, lang, tracks, i) {
    const list = tracks.map((t, n) => ({ i: n, code: t.code, name: displayName(t.code, lang === 'native' ? 'en' : lang), auto: t.auto }));
    const autoTrack = tracks.find((t) => t.auto);
    const base = { id: videoId, lang, original: autoTrack ? lower(autoTrack.code).split('-')[0] : null, tracks: list, track: i };
    if (i < 0) return { ...base, available: false, reason: tracks.length ? 'no_track_in_language' : 'no_captions' };
    const t = tracks[i];
    let c = this.cached(videoId, t);
    if (!c) {
      const got = await this.resolve(videoId, { code: t.code, auto: t.auto });
      c = this.cached(videoId, t) ?? (got?.cues ? got : null);
    }
    if (!c?.cues) return { ...base, available: false, reason: 'temporarily_unavailable' };
    const lines = linesFromCues(c.cues);
    const { chunks, words } = chunksFromCues(c.cues, t.code);
    this.metrics?.inc('cc_words', words);
    return { ...base, available: lines.length > 0, source: t.auto ? 'auto' : 'manual', key: t.code, words, via: c.via, lines, chunks };
  }

  // ---- cache ----
  // A confirmed empty list counts for emptyMs only; after that the video is looked up again.
  list(videoId) {
    const tracks = this.store.captionGet(videoId, 'tracks', this.maxAgeMs);
    if (Array.isArray(tracks) && !tracks.length) return this.store.captionGet(videoId, 'tracks', this.emptyMs);
    return tracks;
  }

  // Cues for a track: ours, or lines Tunelio cached before the chain existed (segment timing, so estimated words).
  cached(videoId, t) {
    const c = this.store.captionGet(videoId, cueKey(t), this.maxAgeMs);
    if (c?.cues) return c;
    const lines = this.store.captionGet(videoId, legacyKey(t), this.maxAgeMs);
    if (Array.isArray(lines)) return { cues: cuesFromLines(lines), via: 'tunelio' };
    return null;
  }

  keep(videoId, got, want) {
    if (got.tracks?.length && !this.list(videoId)) this.store.captionPut(videoId, 'tracks', got.tracks);
    if (got.tracks && !got.tracks.length && !this.list(videoId)) {
      // The first empty answer is only marked; the second within emptyMs is kept (see EMPTY_KEY).
      if (this.store.captionGet(videoId, EMPTY_KEY, this.emptyMs)) this.store.captionPut(videoId, 'tracks', []);
      else this.store.captionPut(videoId, EMPTY_KEY, true);
    }
    if (!got.cues || !got.track) return;
    const value = { cues: got.cues, via: got.via };
    this.store.captionPut(videoId, cueKey(got.track), value);
    // Asked for a list entry whose code is spelled differently by this source: file it under the asked-for name too.
    if (want?.code != null && !same(want, got.track)) this.store.captionPut(videoId, cueKey(want), value);
  }

  // ---- the chain ----
  // want: { lang } | { code, auto } | null. Returns { tracks, track, cues, via, reason } from the first source that
  // answers, or null when none can right now. Whatever a source returns is cached before it is returned.
  resolve(videoId, want, { freeOnly = false } = {}) {
    const k = `${videoId}|${JSON.stringify(want)}${freeOnly ? '|free' : ''}`;
    const first = !this.inflight.has(`resolve|${k}`);
    const p = this.once(`resolve|${k}`, async () => {
      for (const [via, fetch] of this.sources(videoId, want, freeOnly)) {
        const t0 = Date.now();
        try {
          const got = await fetch();
          if (!got) continue;
          got.via = via;
          this.keep(videoId, got, want);
          this.metrics?.inc('cc_via', via);
          this.log({ event: 'captions_via', id: videoId, via, ms: Date.now() - t0, tracks: got.tracks?.length ?? null, cues: got.cues?.length ?? null, reason: got.reason });
          return got;
        } catch (err) {
          this.log({ event: 'captions_source_failed', id: videoId, via, ms: Date.now() - t0, message: short(err) });
        }
      }
      return null;
    });
    if (first) {
      this.looking.set(videoId, p);
      p.catch(() => {}).finally(() => { if (this.looking.get(videoId) === p) this.looking.delete(videoId); });
    }
    return p;
  }

  sources(videoId, want, freeOnly = false) {
    const list = [];
    if (this.relay?.enabled && this.relay.online('captions').length) list.push(['worker', () => this.fromRelay(videoId, want)]);
    if (this.local && !this.local.blocked) list.push(['local', () => this.fromLocal(videoId, want)]);
    if (this.tunelio && !freeOnly) list.push(['tunelio', () => this.fromTunelio(videoId, want)]);
    return list;
  }

  order(info) { return orderTracks(tracksFromInfo(info), this.scripts).map((t) => ({ code: t.code, auto: t.auto })); }

  async fromRelay(videoId, want) {
    const r = await this.relay.captions(videoId, want, { timeoutMs: this.relayWaitMs });
    if (!r?.info) throw new Error('worker answered without info');
    const track = r.track ? { code: r.track.code ?? codeOfKey(r.track.key), auto: Boolean(r.track.auto) } : null;
    return { tracks: this.order(r.info), track, cues: Array.isArray(r.cues) ? r.cues : null, reason: r.reason };
  }

  async fromLocal(videoId, want) {
    const { file, info } = await this.local.info(videoId);
    const tracks = this.order(info);
    if (!want) return { tracks, track: null, cues: null };
    let target;
    if (want.lang) {
      const i = pickTrack(tracks, want.lang);
      if (i < 0) return { tracks, track: null, cues: null, reason: tracks.length ? 'no_track_in_language' : 'no_captions' };
      target = tracks[i];
    } else target = tracks.find((t) => same(t, want)) ?? tracks.find((t) => matches(t, want)) ?? { code: want.code, auto: Boolean(want.auto) };
    const key = keyFor(info, target);
    if (!key) return { tracks, track: null, cues: null, reason: 'no_track_in_language' };
    const cues = await this.local.cues(videoId, file, { key, auto: target.auto });
    return { tracks, track: { code: codeOfKey(key), auto: target.auto }, cues };
  }

  async fromTunelio(videoId, want) {
    let a;
    if (!want || want.lang) a = await this.tunelio.get(videoId, want?.lang ?? 'native');
    else {
      const tracks = this.list(videoId) ?? (await this.tunelio.tracks(videoId, null));
      if (!tracks) return null;
      const i = tracks.findIndex((t) => same(t, want));
      if (i < 0) return { tracks, track: null, cues: null, reason: 'no_track_in_language' };
      a = await this.tunelio.track(videoId, i);
    }
    if (!a) return null;
    if (a.reason === 'temporarily_unavailable' && !a.tracks?.length) return null;
    const tracks = (a.tracks ?? []).map((t) => ({ code: t.code, auto: Boolean(t.auto) }));
    const track = a.track >= 0 && tracks[a.track] ? tracks[a.track] : null;
    return { tracks, track, cues: Array.isArray(a.lines) ? cuesFromLines(a.lines) : null, reason: a.available ? undefined : a.reason };
  }
}
