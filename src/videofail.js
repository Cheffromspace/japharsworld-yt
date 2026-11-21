// Different videos the service had trouble fetching or captioning (Everything-is-OK#967): each video is counted once
// per kind per window, so Grafana's increase() over that window reads as different videos, which a counter can't say
// otherwise (no per-video label: privacy and cardinality). One video that YouTube or Tunelio can't serve then counts
// once however many rooms and retries ask for it.
//   captions  a visitor's caption request got none (temporarily_unavailable, or a throw that answered 502), 6 h
//   build     a Tunelio build that /create accepted failed or timed out (build_failed: 524, 503, no answer), 1 h
//   home      a home relay session failed (src/home.js #fail; not a growing playlist given up on purpose), 1 h
// The privacy page promises (public/privacy.html, the owner's wording of 2026-11-21): "to count each video once, its ID
// is kept in memory for up to 6 hours and is never stored or sent". So the IDs live in this Map only; each one is
// dropped by its own timer when its kind's window ends (and the Map is capped), and nothing here logs, stores or
// exports one: the metric carries the kind alone. A restart forgets them, so a video can count twice across one.
export const VIDEO_FAIL_MS = { captions: 6 * 3600_000, build: 3600_000, home: 3600_000 };
const MAX = 5000;

export class VideoFails {
  // later(fn, ms): runs fn after ms without keeping the process alive (tests pass a fake).
  constructor({ metrics, now = () => Date.now(), later = (fn, ms) => setTimeout(fn, ms).unref() }) {
    this.metrics = metrics;
    this.now = now;
    this.later = later;
    this.seen = new Map(); // `${kind}\n${video id}` → when counted (memory only)
  }

  count(kind, id) {
    const window = VIDEO_FAIL_MS[kind];
    if (!window || !id) return false;
    const k = `${kind}\n${id}`;
    const at = this.seen.get(k);
    if (at != null && this.now() - at < window) return false;
    if (this.seen.size >= MAX) this.seen.delete(this.seen.keys().next().value);
    const now = this.now();
    this.seen.set(k, now);
    this.later(() => { if (this.seen.get(k) === now) this.seen.delete(k); }, window);
    this.metrics?.inc('video_fail', kind);
    return true;
  }
}
