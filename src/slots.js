// Player test slots (owner, 2026-10-22): the VRPlayer TEST world bakes /hls-test/7e570000000000NN.m3u8 and the
// service decides what each slot plays (server.js hlsTest). Tunelio links last ~6 h, so the slots need refilling;
// POST /ops/slots/refill lets the test session do that itself instead of asking the service session.
//   01 adaptive master, 720p first     02 720p HLS media playlist     03 1080p HLS media playlist
//   04 adaptive master, 1080p first    05 #REDIRECT 720p mp4          06 #REDIRECT 1080p mp4
//   07 #REDIRECT Tunelio's own 720p HLS link (relative segment links: the control for the relative-URL bug)
// Quest audio (2026-10-23: on Quest the 01 master plays muted, though 02 and 03 alone have sound; all 720p first):
//   08 master without CODECS           09 master with CODECS and the muxed audio declared (EXT-X-MEDIA, CHANNELS="2")
//   10 one-variant master with CODECS  11 one-variant master without CODECS
// The masters only link slots 02 and 03, so they are written at startup too (writeMasters): no refill needed.
// Each refill is two /create calls (20 credits, counted as `credits`/`test`), capped per UTC day. Tunelio answers
// /create with the same link until it expires (2026-10-22: a refill 43 min before expiry got the old 720p link back),
// so a refill while both links have hours left would spend credits for nothing and is refused unless forced.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const SLOT_VIDEO = '3FJctU--OxI'; // 19 min, 60 fps game footage: 720p and 1080p are easy to tell apart
const QUALITIES = ['720p', '1080p'];
const INF = {
  '720p': '#EXT-X-STREAM-INF:BANDWIDTH=3300000,RESOLUTION=1280x720,CODECS="avc1.4d4020,mp4a.40.2"',
  '1080p': '#EXT-X-STREAM-INF:BANDWIDTH=5400000,RESOLUTION=1920x1080,CODECS="avc1.64002a,mp4a.40.2"',
};

export const slotName = (n) => `7e57${'0'.repeat(10)}${n.toString(16).padStart(2, '0')}`;

// AVPro resolves relative playlist links against the URL it was handed (fe6612a), so every link we write is absolute.
export function absolute(text, base) {
  return text.split('\n').map((l) => (l && !l.startsWith('#') ? new URL(l.trim(), base).href
    : l.replace(/URI="([^"]+)"/, (_, u) => `URI="${new URL(u, base).href}"`))).join('\n');
}

export class TestSlots {
  constructor({ dir, tunelio, base = 'https://yt.japharsworld.com/hls-test', fetcher = fetch, maxPerDay = 6,
    validHours = 2, log = () => {}, now = Date.now, retryMs = 3000 }) {
    Object.assign(this, { dir, tunelio, base, fetcher, maxPerDay, validHours, log, now, retryMs });
    this.running = null;
  }

  #state() { try { return JSON.parse(readFileSync(join(this.dir, 'slots.json'), 'utf8')); } catch { return {}; } }
  #save(s) { mkdirSync(this.dir, { recursive: true }); const f = join(this.dir, 'slots.json'); writeFileSync(`${f}.tmp`, JSON.stringify(s)); renameSync(`${f}.tmp`, f); }
  // The master playlists (01, 04, 08-11). They only link slots 02 and 03, whose names never change.
  writeMasters() {
    const inf = (q, codecs = true, audio = false) => INF[q].replace(codecs ? /$/ : /,CODECS="[^"]*"/, audio ? ',AUDIO="a"' : '');
    const head = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS'];
    const v720 = this.#url(2, true), v1080 = this.#url(3, true);
    mkdirSync(this.dir, { recursive: true });
    this.#put(1, [...head, INF['720p'], v720, INF['1080p'], v1080, ''].join('\n'));
    this.#put(4, [...head, INF['1080p'], v1080, INF['720p'], v720, ''].join('\n'));
    this.#put(8, [...head, inf('720p', false), v720, inf('1080p', false), v1080, ''].join('\n'));
    this.#put(9, [...head, '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="main",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"',
      inf('720p', true, true), v720, inf('1080p', true, true), v1080, ''].join('\n'));
    this.#put(10, [...head, INF['720p'], v720, ''].join('\n'));
    this.#put(11, [...head, inf('720p', false), v720, ''].join('\n'));
  }

  #put(n, text) { writeFileSync(join(this.dir, `${slotName(n)}.m3u8`), text, { mode: 0o644 }); }
  #url(n, resolve) { return `${this.base}/${slotName(n)}.m3u8${resolve ? '?resolve=1' : ''}`; }
  #today() { return new Date(this.now()).toISOString().slice(0, 10); }

  status() {
    const s = this.#state();
    const today = s.day === this.#today() ? s.count ?? 0 : 0;
    return { running: !!this.running, refillsToday: today, maxPerDay: this.maxPerDay, last: s.last ?? null };
  }

  // → { started: true } or { error, message } (the refill runs in the background; status() shows the result).
  refill({ id = SLOT_VIDEO, force = false } = {}) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return { error: 'bad_id', message: 'A YouTube video ID is 11 characters.' };
    if (this.running) return { started: true, already: true };
    const s = this.#state();
    const day = this.#today(), count = s.day === day ? s.count ?? 0 : 0;
    if (count >= this.maxPerDay) return { error: 'daily_cap', message: `${this.maxPerDay} refills a day (20 credits each); try after 00:00 UTC.` };
    const left = s.last?.ok && s.last.id === id ? Math.min(...QUALITIES.map((q) => Date.parse(s.last.expires?.[q] ?? 0))) - this.now() : 0;
    if (!force && left > this.validHours * 3600_000) {
      return { error: 'still_valid', message: `The links are good until ${new Date(this.now() + left).toISOString()}; Tunelio would hand the same ones back. Pass force to rebuild anyway.` };
    }
    this.#save({ ...s, day, count: count + 1 });
    this.running = this.#fill(id).catch((e) => ({ ok: false, error: `${String(e?.message ?? e)}${e?.cause?.code ? ` (${e.cause.code})` : ''}`.slice(0, 200) }))
      .then((last) => {
        last = { at: new Date(this.now()).toISOString(), id, ...last };
        this.#save({ ...this.#state(), last });
        this.log({ event: 'test_slots', ok: last.ok, error: last.error, buildMs: last.buildMs });
        this.running = null;
        return last;
      });
    return { started: true };
  }

  // A network error ("fetch failed": a reset or refused connection to Tunelio's edge) is tried twice more, a few
  // seconds apart (2026-10-23: a refill right after a restart failed so and spent one of the day's refills for nothing).
  async #get(url, opts) {
    for (let i = 0; ; i++) {
      try { return await this.fetcher(url, { ...opts, signal: AbortSignal.timeout(200_000) }); } catch (err) {
        if (i >= 2 || err?.name === 'TimeoutError' || err?.name === 'AbortError') throw err;
        this.log({ event: 'test_slots_retry', try: i + 1, message: String(err?.message ?? err).slice(0, 100), code: err?.cause?.code });
        await new Promise((r) => setTimeout(r, this.retryMs));
      }
    }
  }

  async #fill(id) {
    const started = this.now();
    const made = {};
    for (const q of QUALITIES) made[q] = await this.tunelio.create(id, q);
    // HLS builds for both qualities at once, then the mp4s (warm after the HLS build: one source download per quality).
    const hls = {}, builds = {};
    await Promise.all(QUALITIES.map(async (q) => {
      const link = `${made[q].url}&hls=1`;
      const t = this.now();
      const r = await this.#get(link);
      hls[q] = { link, text: r.status === 200 ? absolute(await r.text(), link) : null };
      builds[`hls_${q}`] = { status: r.status, s: Math.round((this.now() - t) / 100) / 10 };
    }));
    for (const q of QUALITIES) {
      const t = this.now();
      const r = await this.#get(`${made[q].url}&progressive=1`, { headers: { range: 'bytes=0-0' } });
      try { await r.body?.cancel(); } catch { /* already done */ }
      builds[`mp4_${q}`] = { status: r.status, s: Math.round((this.now() - t) / 100) / 10, mb: Math.round(made[q].fileSize / 1e5) / 10 };
    }
    mkdirSync(this.dir, { recursive: true });
    if (hls['720p'].text) this.#put(2, hls['720p'].text);
    if (hls['1080p'].text) this.#put(3, hls['1080p'].text);
    // The masters link their variants through ?resolve=1, so a resolver reading a master (?resolve=1 slots) can too.
    this.writeMasters();
    this.#put(5, `#REDIRECT ${made['720p'].url}&progressive=1\n`);
    this.#put(6, `#REDIRECT ${made['1080p'].url}&progressive=1\n`);
    this.#put(7, `#REDIRECT ${hls['720p'].link}\n`);
    const ok = Object.values(builds).every((b) => b.status === 200 || b.status === 206);
    return { ok, buildMs: this.now() - started, builds,
      expires: Object.fromEntries(QUALITIES.map((q) => [q, new Date(made[q].expires * 1000).toISOString()])) };
  }
}
