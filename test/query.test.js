import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, youtubeIdFrom, normalizeLang } from '../src/query.js';

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
