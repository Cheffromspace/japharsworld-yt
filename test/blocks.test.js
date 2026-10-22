import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cuesFromJson3, cuesFromSrv3, cuesFromVtt, linesFromCues, cuesFromLines, codeOfKey, tracksFromInfo, keyFor } from '../src/cues.js';
import { chunksFromCues, chunkWords, wordsFromCues, layoutFor, breakAfter } from '../src/blocks.js';
import { parseJson3 } from '../src/captions.js';

// Real YouTube tracks fetched on 2026-10-22 (first four minutes): auto tracks with word timing, uploader tracks without.
const fixture = (name) => readFileSync(new URL(`./fixtures/captions/${name}`, import.meta.url), 'utf8');
const summary = JSON.parse(fixture('info-summary.json'));

function checkChunks(chunks, maxChars) {
  assert.ok(chunks.length > 0);
  for (let i = 0; i < chunks.length; i++) {
    const [start, end, text, brk, offsets] = chunks[i];
    assert.ok(end >= start, `chunk ${i} ends before it starts`);
    assert.ok(brk >= 0 && brk <= 3);
    assert.ok(text.length > 0 && !/^\s|\s$/.test(text), `chunk ${i} text is trimmed: ${JSON.stringify(text)}`);
    if (text.includes(' ')) assert.ok(text.length <= maxChars + 3, `chunk ${i} too long (${text.length}): ${text}`);
    const pairs = offsets.split(',').map((p) => p.split(':').map(Number));
    assert.ok(pairs.length >= 1);
    let lastCs = -1, lastCh = -1;
    for (const [cs, ch] of pairs) {
      assert.ok(cs >= lastCs, `offsets go backwards in chunk ${i}`);
      assert.ok(ch > lastCh && ch < text.length && text[ch] !== ' ', `offset ${ch} points at a space or outside in chunk ${i}`);
      lastCs = cs; lastCh = ch;
    }
    if (i + 1 < chunks.length) assert.ok(chunks[i + 1][0] >= start && end <= chunks[i + 1][0] + 0.011, `chunk ${i} overlaps the next`);
  }
}

test('auto track: every word keeps YouTube\'s timing; chunks are readable lines', () => {
  const cues = cuesFromJson3(fixture('UF8uR6Z6KLc.en-orig.json3'));
  const words = wordsFromCues(cues, layoutFor('en'));
  assert.ok(words.filter((w) => w.real).length / words.length > 0.95);
  const { chunks, words: quality } = chunksFromCues(cues, 'en');
  assert.equal(quality, 'real');
  checkChunks(chunks, 42);
  // A line's word count matches its offsets.
  for (const [, , text, , offsets] of chunks) assert.equal(offsets.split(',').length, text.split(' ').length);
  // Nothing is lost or repeated: the words read in order.
  assert.equal(chunks.map((c) => c[2]).join(' '), words.map((w) => w.w).join(' '));
  // Lines are reasonably full on average (not a word a line).
  const avg = chunks.reduce((a, c) => a + c[2].length, 0) / chunks.length;
  assert.ok(avg > 24, `average line ${avg}`);
});

test('a newer auto track carries punctuation as its own segments: breaks land on sentence ends', () => {
  const cues = cuesFromJson3(fixture('GPkrrapmtpQ.en-US-orig.json3'));
  const { chunks, words } = chunksFromCues(cues, 'en');
  assert.equal(words, 'real');
  checkChunks(chunks, 42);
  const sentenceEnds = chunks.filter((c) => /[.!?]$/.test(c[2]));
  assert.ok(sentenceEnds.length > 5);
  for (const c of sentenceEnds) assert.equal(c[3], 3, `sentence end without break 3: ${c[2]}`);
  assert.ok(!chunks.some((c) => /^[,.!?]/.test(c[2])), 'no line starts with punctuation');
});

test('uploader track: words are spread by character weight, lines match the old cue output', () => {
  const raw = fixture('dQw4w9WgXcQ.en.json3');
  const cues = cuesFromJson3(raw);
  assert.deepEqual(linesFromCues(cues), parseJson3(raw), 'the lines field stays what the world has always read');
  const { chunks, words } = chunksFromCues(cues, 'en');
  assert.equal(words, 'estimated');
  checkChunks(chunks, 42);
  // Word times inside a cue rise monotonically and stay within it.
  const ws = wordsFromCues(cues, layoutFor('en'));
  for (let i = 1; i < ws.length; i++) assert.ok(ws[i].t >= ws[i - 1].t);
});

test('Japanese auto track: one segment per sentence, chunked by character into 16-wide lines', () => {
  const cues = cuesFromJson3(fixture('W_Jnd53UB4U.ja-orig.json3'));
  assert.deepEqual(layoutFor('ja'), { maxChars: 16, units: 'chars', join: '' });
  const { chunks, words } = chunksFromCues(cues, 'ja');
  assert.equal(words, 'estimated');
  assert.ok(chunks.length > 50);
  for (const [, , text, , offsets] of chunks) {
    assert.ok(Array.from(text).length <= 18, `too wide: ${text}`);
    assert.ok(!/^[。、！？」]/.test(text), `starts with punctuation: ${text}`);
    assert.ok(offsets.split(',').length >= 1);
  }
  assert.equal(chunks.map((c) => c[2]).join(''), cues.map((c) => c[2].map((s) => s[1]).join('')).join('').replace(/\s+/g, ''));
});

const w = (list) => list.map(([t, e, text]) => ({ t, e, w: text, sp: true, real: true }));

test('breaks: sentence > clause > pause > length, and a long silence always ends a line', () => {
  const words = w([[0, 300, 'Hello'], [300, 700, 'there.'], [700, 900, 'How'], [900, 1100, 'are'], [1100, 1400, 'you,'], [1400, 1600, 'my'], [1600, 2000, 'friend?'],
    [2100, 2400, 'Fine'], [4500, 4800, 'and'], [4800, 5100, 'you']]);
  assert.equal(breakAfter(words, 1), 3);
  assert.equal(breakAfter(words, 4), 2);
  assert.equal(breakAfter(words, 7), 3, 'a 2.1 s silence counts as a sentence break');
  const chunks = chunkWords(words, { maxChars: 42, join: ' ' });
  assert.deepEqual(chunks.map((c) => [c[2], c[3]]), [['Hello there.', 3], ['How are you, my friend?', 3], ['Fine', 3], ['and you', 3]]);
  assert.equal(chunks[0][4], '0:0,30:6');
});

test('a line that would wrap mid-sentence breaks at the clause in its second half instead', () => {
  const words = w('one two three four five, six seven eight nine ten eleven twelve thirteen'.split(' ').map((x, i) => [i * 300, i * 300 + 300, x]));
  const chunks = chunkWords(words, { maxChars: 42, join: ' ' });
  assert.equal(chunks[0][2], 'one two three four five,');
  assert.equal(chunks[0][3], 2);
});

test('orphans: a one-word last line takes a word from the line before', () => {
  const words = w('the quick brown fox jumps over the lazy dog today.'.split(' ').map((x, i) => [i * 300, i * 300 + 300, x]));
  const chunks = chunkWords(words, { maxChars: 42, join: ' ' });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1][2], 'dog today.');
});

test('overlapping cues (Tunelio segments) still give word times that run forward', () => {
  // Seen live on 2026-10-22 (shard 7, a Dutch uploader track): the next cue began before the previous one ended.
  const cues = cuesFromLines([[4.24, 2.19, 'We moeten ze stuk voor stuk verzamelen .'], [5.3, 2.56, 'Beginnend bij één tegelijk .']]);
  const words = wordsFromCues(cues, layoutFor('nl'));
  for (let i = 1; i < words.length; i++) assert.ok(words[i].t >= words[i - 1].t, `word ${i} goes back in time`);
  for (const w of words) assert.ok(w.e >= w.t);
  const { chunks } = chunksFromCues(cues, 'nl');
  for (const c of chunks) {
    const cs = c[4].split(',').map((p) => Number(p.split(':')[0]));
    for (let i = 1; i < cs.length; i++) assert.ok(cs[i] >= cs[i - 1], `offsets go back in ${c[2]}`);
  }
});

test('srv3 and vtt parse to the same cue shape', () => {
  const srv3 = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>
<p t="1000" d="2000" w="1"><s ac="0">We&#39;re</s><s t="300" ac="0"> no</s><s t="600" ac="0"> strangers</s></p>
<p t="3000" d="1000" w="1" a="1">\n</p>
<p t="3100" d="1500">Plain &amp; simple</p></body></timedtext>`;
  assert.deepEqual(cuesFromSrv3(srv3), [[1000, 2000, [[0, "We're"], [300, ' no'], [600, ' strangers']]], [3100, 1500, [[0, 'Plain & simple']]]]);
  const vtt = `WEBVTT\nKind: captions\n\n00:00:01.000 --> 00:00:03.500 align:start\n<c.colorE5E5E5>Hello</c> there\n\n2\n01:02:03.004 --> 01:02:04.000\n- Hi\n- Hello\n`;
  assert.deepEqual(cuesFromVtt(vtt), [[1000, 2500, [[0, 'Hello there']]], [3723004, 996, [[0, '- Hi\n- Hello']]]]);
  assert.deepEqual(cuesFromLines([[1.23, 2, 'hi']]), [[1230, 2000, [[0, 'hi']]]]);
});

test('track keys: variant ids and -orig fold to the language code; the key to download is found by code', () => {
  assert.equal(codeOfKey('en-eEY6OEpapPo'), 'en');
  assert.equal(codeOfKey('en-orig'), 'en');
  assert.equal(codeOfKey('en-US-orig'), 'en-US');
  assert.equal(codeOfKey('zh-Hans'), 'zh-Hans');
  assert.equal(codeOfKey('es-419'), 'es-419');
  assert.equal(codeOfKey('pt-BR'), 'pt-BR');
  const stanford = summary.UF8uR6Z6KLc;
  const tracks = tracksFromInfo({ language: stanford.language, manual: stanford.subtitles, auto: stanford.automatic_captions });
  assert.equal(tracks.filter((t) => !t.auto).length, 8);
  assert.deepEqual(tracks.at(-1), { code: 'en', key: 'en-orig', auto: true });
  const info = { subtitles: Object.fromEntries(stanford.subtitles.map((k) => [k, []])), automatic_captions: Object.fromEntries(stanford.automatic_captions.map((k) => [k, []])) };
  assert.equal(keyFor(info, { code: 'en', auto: false }), 'en-eEY6OEpapPo');
  assert.equal(keyFor(info, { code: 'en', auto: true }), 'en-orig');
  // Two Spanish uploader tracks: the variant-id key folds to the bare code "es" and is the one that code names;
  // es-ES keeps its region and is reached through its own list entry.
  assert.equal(keyFor(info, { code: 'es', auto: false }), 'es-y1SAwy5xd4g');
  assert.equal(keyFor(info, { code: 'es-ES', auto: false }), 'es-ES');
  assert.equal(keyFor(info, { code: 'th', auto: false }), null);
  // A video whose auto track is the spoken language without -orig, and one with none at all.
  assert.deepEqual(tracksFromInfo({ language: 'ja', manual: ['en'], auto: ['ja', 'en'] }), [{ code: 'en', key: 'en', auto: false }, { code: 'ja', key: 'ja', auto: true }]);
  assert.deepEqual(tracksFromInfo({ language: null, manual: [], auto: [] }), []);
});
