// Readable caption chunks (Everything is OK #77): the world shows captions as pop-on blocks that appear whole, hold
// still and are replaced whole. This module turns a track's cues (src/cues.js) into the lines those blocks are built
// from, one entry per text line, with the time of every word so the world can highlight the word being spoken.
//
//   chunk = [startSeconds, endSeconds, text, breakAfter, offsets]
//     breakAfter  0 wrapped mid-sentence, 1 a pause follows, 2 a clause ends (, ; :), 3 a sentence ends (. ! ?)
//     offsets     "cs:ch,cs:ch,…" one pair per word: start in centiseconds after the chunk start, and the index
//                 of the word's first character in text. The world merges chunks into blocks of 1-3 lines and
//                 splits this only for the block on screen.
//
// Guidance followed (BBC, Netflix, DCMP; the issue has the sources): about 42 characters per line (16 for Chinese
// and Japanese, 20 for Korean), break at sentence > clause > pause > length, never leave a one-word orphan line
// when a better break is near, and a long silence always ends a line.
import { scriptOf } from './transcripts.js';

export const PAUSE_MS = 600;        // a gap this long counts as a clause-like break
export const LONG_PAUSE_MS = 1500;  // a gap this long always ends a chunk
const SENTENCE_END = /[.!?。！？…]["'»”’)\]]*$/;
const CLAUSE_END = /[,;:、，；：—–]["'»”’)\]]*$/;

export function layoutFor(code) {
  const script = scriptOf(code) ?? 'Latn';
  if (script === 'Jpan' || script === 'Hans' || script === 'Hant') return { maxChars: 16, units: 'chars', join: '' };
  if (script === 'Kore') return { maxChars: 20, units: 'words', join: ' ' };
  if (script === 'Thai') return { maxChars: 42, units: 'chars', join: '' };
  return { maxChars: 42, units: 'words', join: ' ' };
}

// cues → words [{ t, e, w, sp, real }]: t/e in ms, sp = a space precedes the word, real = the source timed it.
// A seg the source did not time, or one holding several words, spreads its span over its words by character count.
export function wordsFromCues(cues, { units = 'words' } = {}) {
  const words = [];
  for (let c = 0; c < cues.length; c++) {
    const [start, dur, segs] = cues[c];
    const cueEnd = start + Math.max(dur, 300);
    // Resolve seg starts: known offsets stay, unknown ones are interpolated between their neighbours by weight.
    const starts = segs.map(([o]) => (o == null ? null : start + o));
    starts[0] = start;
    for (let i = 1; i < segs.length; i++) {
      if (starts[i] != null) continue;
      let j = i; while (j < segs.length && starts[j] == null) j++;
      const from = starts[i - 1], to = j < segs.length ? starts[j] : cueEnd;
      const weights = segs.slice(i - 1, j).map(([, t]) => Math.max(1, t.trim().length + 1));
      const total = weights.reduce((a, b) => a + b, 0);
      let acc = weights[0];
      for (let k = i; k < j; k++) { starts[k] = from + (to - from) * (acc / total); acc += weights[k - i + 1]; }
    }
    for (let i = 0; i < segs.length; i++) {
      const [offset, text] = segs[i];
      const segStart = starts[i], segEnd = i + 1 < segs.length ? starts[i + 1] : cueEnd;
      const real = offset != null;
      const pieces = split(text, units);
      if (!pieces.length) continue;
      if (pieces.length === 1) { words.push({ t: segStart, e: segEnd, w: pieces[0].w, sp: pieces[0].sp || /^\s/.test(text), real }); continue; }
      const weights = pieces.map((p) => Math.max(1, p.w.length + (units === 'words' ? 1 : 0)));
      const total = weights.reduce((a, b) => a + b, 0);
      let acc = 0;
      for (let k = 0; k < pieces.length; k++) {
        const t = segStart + (segEnd - segStart) * (acc / total);
        acc += weights[k];
        const e = segStart + (segEnd - segStart) * (acc / total);
        words.push({ t, e, w: pieces[k].w, sp: k === 0 ? (pieces[k].sp || /^\s/.test(text)) : pieces[k].sp, real: false });
      }
    }
  }
  // Words never overlap: each ends where the next begins when the source said otherwise.
  for (let i = 0; i + 1 < words.length; i++) if (words[i].e > words[i + 1].t) words[i].e = Math.max(words[i].t, words[i + 1].t);
  return words;
}

// Text → pieces [{ w, sp }]. Words mode splits on whitespace (a newline counts as a space); chars mode makes every
// character its own unit so scripts without spaces can still break anywhere, with punctuation kept on the character
// before it.
function split(text, units) {
  const out = [];
  if (units === 'words') {
    const re = /(\s*)(\S+)/g;
    let m;
    while ((m = re.exec(text))) out.push({ w: m[2], sp: m[1].length > 0 });
    return out;
  }
  let space = false;
  for (const ch of Array.from(text.replace(/\s+/g, ' '))) {
    if (ch === ' ') { space = out.length > 0; continue; }
    if (/[。！？…、，；：」』）】,.!?;:'"）]/.test(ch) && out.length) { out[out.length - 1].w += ch; continue; }
    out.push({ w: ch, sp: space });
    space = false;
  }
  return out;
}

// How strongly the text wants a break after word i (0..3), from its punctuation and the silence that follows it.
export function breakAfter(words, i) {
  const w = words[i];
  let s = 0;
  if (SENTENCE_END.test(w.w)) s = 3;
  else if (CLAUSE_END.test(w.w)) s = 2;
  if (i + 1 < words.length) {
    const gap = words[i + 1].t - w.e;
    if (gap >= LONG_PAUSE_MS) s = Math.max(s, 3);
    else if (gap >= PAUSE_MS) s = Math.max(s, 1);
  } else s = 3;
  return s;
}

const cs = (ms) => Math.round(ms / 10);
const sec = (ms) => Math.round(ms / 10) / 100;

// words → chunks. Greedy lines of up to maxChars that stop early at a sentence end, a long silence, or a clause end
// once the line is reasonably full; a line that would otherwise end mid-sentence looks back for the best break in
// its second half.
export function chunkWords(words, { maxChars = 42, join = ' ', minFill = 0.45 } = {}) {
  const chunks = [];
  let i = 0;
  const strength = words.map((_, k) => breakAfter(words, k));
  while (i < words.length) {
    let j = i, len = 0;
    while (j < words.length) {
      const add = (j > i && words[j].sp && join === ' ' ? 1 : 0) + words[j].w.length;
      if (j > i && len + add > maxChars) break;
      len += add; j++;
      const s = strength[j - 1];
      if (s >= 3) break;
      if (s === 2 && len >= maxChars * 0.6) break;
      if (s === 1 && len >= maxChars * 0.75) break;
    }
    // Ended by length mid-sentence: prefer the strongest break in the second half of the line.
    if (j < words.length && strength[j - 1] === 0 && j - i > 1) {
      let best = -1, bestS = 0;
      const floor = i + Math.max(1, Math.ceil((j - i) * minFill));
      for (let k = j - 2; k >= floor; k--) if (strength[k] > bestS) { bestS = strength[k]; best = k; if (bestS >= 2) break; }
      if (best >= 0) j = best + 1;
    }
    chunks.push(make(words, i, j, strength[j - 1], join));
    i = j;
  }
  // Orphans: a one-word line ending a sentence after a wrapped line reads badly; the line before gives up its last
  // word when the two words then still fit on one line and the shortened line keeps a reasonable length.
  for (let c = 1; c < chunks.length; c++) {
    const prev = chunks[c - 1], cur = chunks[c];
    if (cur.count === 1 && prev.brk === 0 && prev.count > 2 && cur.brk >= 2) {
      const moved = words.slice(prev.from, prev.to - 1), rest = words.slice(prev.to - 1, cur.to);
      const restLen = textOf(rest, join).length, movedLen = textOf(moved, join).length;
      if (restLen <= maxChars && movedLen >= maxChars * 0.3) {
        chunks[c - 1] = make(words, prev.from, prev.to - 1, 0, join);
        chunks[c] = make(words, prev.to - 1, cur.to, cur.brk, join);
      }
    }
  }
  return chunks.map((c) => c.out);
}

function textOf(ws, join) {
  let text = '';
  for (let k = 0; k < ws.length; k++) text += (k > 0 && (join === ' ' ? ws[k].sp : false) ? ' ' : '') + ws[k].w;
  return text;
}
function make(words, from, to, brk, join) {
  const ws = words.slice(from, to);
  let text = '';
  const offsets = [];
  for (let k = 0; k < ws.length; k++) {
    if (k > 0 && join === ' ' && ws[k].sp) text += ' ';
    offsets.push(`${cs(ws[k].t - ws[0].t)}:${text.length}`);
    text += ws[k].w;
  }
  const end = Math.max(ws[ws.length - 1].e, ws[0].t + 300);
  return { from, to, count: ws.length, brk, out: [sec(ws[0].t), sec(end), text, brk, offsets.join(',')] };
}

// cues of one track → { chunks, words: 'real' | 'estimated' }
export function chunksFromCues(cues, code) {
  const layout = layoutFor(code);
  const words = wordsFromCues(cues, layout);
  const chunks = chunkWords(words, layout);
  // Each chunk ends no later than the next one begins.
  for (let i = 0; i + 1 < chunks.length; i++) if (chunks[i][1] > chunks[i + 1][0]) chunks[i][1] = Math.max(chunks[i][0], chunks[i + 1][0]);
  const real = words.filter((w) => w.real).length;
  return { chunks, words: words.length && real >= words.length / 2 ? 'real' : 'estimated' };
}
