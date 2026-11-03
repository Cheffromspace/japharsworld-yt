import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, rawQuery, queryShape, youtubeIdFrom, normalizeLang } from '../src/query.js';

test('strips everything up to the last arrow', () => {
  assert.equal(parseQuery('Type to search →   rain on a tin roof  '), 'rain on a tin roof');
  assert.equal(parseQuery('検索してください → 雨の音'), '雨の音');
  assert.equal(parseQuery('a → b → c'), 'c');
  assert.equal(parseQuery('no arrow here'), 'no arrow here');
  assert.equal(parseQuery('Type to search →'), '');
  assert.equal(parseQuery('x'.repeat(500)).length, 150);
});

test('recognizes pasted links', () => {
  assert.equal(youtubeIdFrom('https://www.youtube.com/watch?v=2yJgwwDcgV8&t=3'), '2yJgwwDcgV8');
  assert.equal(youtubeIdFrom('https://youtu.be/2yJgwwDcgV8'), '2yJgwwDcgV8');
  assert.equal(youtubeIdFrom('youtube.com/shorts/2yJgwwDcgV8'), '2yJgwwDcgV8');
  assert.equal(youtubeIdFrom('lofi beats'), null);
});

test('normalizes VRChat languages', () => {
  assert.equal(normalizeLang('pt-br'), 'pt-BR');
  assert.equal(normalizeLang('zh-HK'), 'zh-HK');
  assert.equal(normalizeLang('ja-JP'), 'ja');
  assert.equal(normalizeLang('xx'), 'en');
  assert.equal(normalizeLang(null), 'en');
});

test('queryShape describes q without its text (#143)', () => {
  const pad = ' '.repeat(240);
  assert.deepEqual(queryShape(`${pad}Type to search → cats`), { qLen: 261, pad: 240, arrow: '→', before: 14, prompt: true, after: 4, len: 4, chars: 'ascii', control: false });
  // The arrow dropped by a keyboard: the prompt is the query.
  const none = queryShape(`${pad}Type to search cats`);
  assert.equal(none.arrow, 'none');
  assert.equal(none.before, 0);
  assert.equal(none.len, 19);
  assert.equal(queryShape('Введите запрос → кошки').chars, 'non-ascii');
  assert.equal(queryShape('→ cats 猫').chars, 'mixed');
  assert.equal(queryShape('Type to search →').chars, 'empty');
  assert.equal(queryShape('a\u0000b').control, true);
  assert.equal(queryShape('x'.repeat(500)).len, 150);
  assert.equal(queryShape(undefined).qLen, 0);
  // Nothing in the shape is the search text.
  const shape = queryShape(`${pad}Type to search → secret words`);
  assert.ok(!JSON.stringify(shape).includes('secret'));
});

test('rawQuery: q is the raw rest after q=, so a pasted link keeps its & and + (verifier, 2026-11-03)', () => {
  const ID = 'AbCdEfGh1jK';
  const pre = '?l=en&q=%20%20YouTube%20link%20%E2%86%92%20';
  for (const l of [`www.youtube.com/watch?feature=share&v=${ID}`, `m.youtube.com/watch?app=desktop&v=${ID}`,
    `https://www.youtube.com/watch?list=PLx1&v=${ID}&index=2`, `youtu.be/${ID}?x=a+b`]) {
    assert.equal(parseQuery(rawQuery(pre + l)), l, l);
  }
  // Text searches read as before: + and %20 are spaces, %2B a plus, a malformed % stays.
  assert.equal(parseQuery(rawQuery('?l=en&q=Type+to+search+%E2%86%92+rain+sounds')), 'rain sounds');
  assert.equal(parseQuery(rawQuery('?l=en&q=Type%20to%20search%20%E2%86%92%20rain%20sounds')), 'rain sounds');
  assert.equal(parseQuery(rawQuery('?q=c%2B%2B%20tutorial')), 'c++ tutorial');
  assert.equal(parseQuery(rawQuery('?q=100%+real')), '100% real');
  assert.equal(parseQuery(rawQuery('?q=%E6%97%A5%E6%9C%AC')), '日本');
  // A typed & no longer cuts the text (it used to start a new parameter).
  assert.equal(parseQuery(rawQuery('?q=rock%20&%20roll')), 'rock & roll');
  assert.equal(rawQuery('?l=en'), null);
  assert.equal(rawQuery('?xq=1'), null);
  assert.equal(rawQuery(''), null);
});
