import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, queryShape, youtubeIdFrom, normalizeLang } from '../src/query.js';

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
