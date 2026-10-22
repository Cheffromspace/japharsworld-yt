// Caption cues as every source hands them to the chunker (src/blocks.js), whatever the format was.
//
//   cue = [startMs, durationMs, segs]      segs = [[offsetMs | null, text], ...]
//
// A seg is a timed piece of the cue's text: YouTube's json3 and srv3 auto captions carry one per word with its
// offset from the cue start (the first seg has none: it starts with the cue). Uploader tracks, Tunelio segments
// and vtt have one seg per cue with offset 0; the chunker then spreads the words over the cue by character weight.
// null marks an offset the source did not give (a later seg without timing), which the chunker estimates too.
const MAX_CUES = 12000;

const clean = (s) => String(s ?? '').replace(/\r/g, '').replace(/[ \t]*\n[ \t]*/g, '\n');
const toInt = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0);

// YouTube json3 (events[].segs[].utf8 / tOffsetMs). Events flagged aAppend only carry the "\n" that YouTube's
// roll-up display appends to the previous window: not text of their own.
export function cuesFromJson3(raw) {
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const cues = [];
  for (const ev of doc?.events ?? []) {
    if (!ev?.segs || ev.aAppend) continue;
    const segs = [];
    for (let i = 0; i < ev.segs.length; i++) {
      const s = ev.segs[i];
      const text = clean(s?.utf8);
      if (!text.trim()) continue;
      segs.push([i === 0 ? 0 : (Number.isFinite(s.tOffsetMs) ? toInt(s.tOffsetMs) : null), text]);
    }
    if (!segs.length) continue;
    cues.push([toInt(ev.tStartMs), toInt(ev.dDurationMs), segs]);
    if (cues.length >= MAX_CUES) break;
  }
  return cues;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// YouTube srv3 (XML: <p t d><s t>word</s>…</p>): the same words and offsets as json3.
export function cuesFromSrv3(xml) {
  const cues = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  const attr = (attrs, name) => { const m = new RegExp(`\\b${name}="(-?\\d+)"`).exec(attrs); return m ? Number(m[1]) : null; };
  let p;
  while ((p = pRe.exec(String(xml)))) {
    const [, attrs, inner] = p;
    if (/\ba="1"/.test(attrs)) continue; // append marker, like json3's aAppend
    const start = attr(attrs, 't') ?? 0, dur = attr(attrs, 'd') ?? 0;
    const segs = [];
    if (/<s\b/.test(inner)) {
      const sRe = /<s\b([^>]*)>([\s\S]*?)<\/s>/g;
      let s, first = true;
      while ((s = sRe.exec(inner))) {
        const text = clean(decodeEntities(s[2].replace(/<[^>]+>/g, '')));
        if (!text.trim()) continue;
        segs.push([first ? 0 : attr(s[1], 't'), text]);
        first = false;
      }
    } else {
      const text = clean(decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')));
      if (text.trim()) segs.push([0, text]);
    }
    if (!segs.length) continue;
    cues.push([start, dur, segs]);
    if (cues.length >= MAX_CUES) break;
  }
  return cues;
}

// WebVTT: timing lines "hh:mm:ss.mmm --> hh:mm:ss.mmm", text until a blank line, tags stripped. No word timing.
const vttTime = (s) => {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/.exec(s.trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
};
export function cuesFromVtt(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = vttTime(a), end = vttTime((b ?? '').trim().split(/\s+/)[0] ?? '');
    if (start == null || end == null) continue;
    const body = clean(decodeEntities(lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '')));
    if (!body.trim()) continue;
    cues.push([start, Math.max(0, end - start), [[0, body]]]);
    if (cues.length >= MAX_CUES) break;
  }
  return cues;
}

export function cuesFrom(format, raw) {
  if (format === 'json3') return cuesFromJson3(raw);
  if (format === 'srv3') return cuesFromSrv3(raw);
  if (format === 'vtt') return cuesFromVtt(raw);
  throw new Error(`unknown caption format ${format}`);
}

// [[startSeconds, durationSeconds, text], ...] as the world has always read them (segment timing only).
export function linesFromCues(cues) {
  return cues.map(([s, d, segs]) => [Math.round(s / 10) / 100, Math.round(d / 10) / 100, segs.map((x) => x[1]).join('').trim()])
    .filter((l) => l[2].length > 0);
}
export function cuesFromLines(lines) {
  return (lines ?? []).map(([s, d, text]) => [Math.round(Number(s) * 1000), Math.round(Number(d) * 1000), [[0, String(text ?? '')]]]);
}

// yt-dlp's keys for uploader tracks sometimes carry a variant id ("en-eEY6OEpapPo": a second English track with its
// own name). The language code is what the picker and the cache go by; the key is what yt-dlp downloads.
export function codeOfKey(key) {
  const k = String(key ?? '').replace(/-orig$/, '');
  const m = /^([a-zA-Z]{2,3})-([A-Za-z0-9_-]{6,})$/.exec(k);
  if (m && !/^(Hans|Hant|Latn|Cyrl)$/.test(m[2])) return m[1];
  return k;
}

// The yt-dlp key to download for a wanted { code, auto } among an info JSON's keys: the original auto track for the
// code (or its base language), else the exact code, a variant key of it, or any key in the same base language.
export function keyFor(info, want) {
  const keys = want.auto ? Object.keys(info.automatic_captions ?? {}) : Object.keys(info.subtitles ?? {}).filter((k) => k !== 'live_chat');
  const lower = (s) => String(s ?? '').toLowerCase();
  const code = lower(want.code), base = code.split('-')[0];
  if (want.auto) {
    const orig = keys.find((k) => k.endsWith('-orig') && lower(codeOfKey(k)) === code) ?? keys.find((k) => k.endsWith('-orig') && lower(codeOfKey(k)).split('-')[0] === base);
    if (orig) return orig;
  }
  return keys.find((k) => lower(k) === code) ?? keys.find((k) => lower(codeOfKey(k)) === code)
    ?? keys.find((k) => lower(codeOfKey(k)).split('-')[0] === base) ?? null;
}

// A yt-dlp info JSON (or just its subtitle keys) → the raw track list the chain orders: uploader tracks, then the
// original-language auto track. Machine translations are left out (japharsworld-yt #12).
export function tracksFromInfo(info) {
  const manual = (info.manual ?? Object.keys(info.subtitles ?? {})).filter((k) => k !== 'live_chat');
  const auto = info.auto ?? Object.keys(info.automatic_captions ?? {});
  const list = manual.map((k) => ({ code: codeOfKey(k), key: k, auto: false }));
  const orig = auto.find((k) => k.endsWith('-orig'));
  if (orig) list.push({ code: codeOfKey(orig), key: orig, auto: true });
  else if (info.language && auto.includes(info.language)) list.push({ code: info.language, key: info.language, auto: true });
  return list;
}
