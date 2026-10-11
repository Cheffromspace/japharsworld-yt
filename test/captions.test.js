import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTrack, parseJson3, originalLanguage } from '../src/captions.js';

const info = {
  language: 'en',
  subtitles: { 'en-US': [{}], ja: [{}], live_chat: [{}] },
  automatic_captions: { 'en-orig': [{}], en: [{}], fr: [{}], he: [{}], iw: [{}], 'zh-Hans': [{}] },
};

test('prefers manual subtitles in the visitor language', () => {
  assert.deepEqual(chooseTrack(info, 'ja'), { key: 'ja', auto: false, source: 'manual' });
  assert.deepEqual(chooseTrack(info, 'en'), { key: 'en-US', auto: false, source: 'manual' });
});

test('falls back to YouTube translation', () => {
  assert.deepEqual(chooseTrack(info, 'fr'), { key: 'fr', auto: true, source: 'translated' });
  assert.deepEqual(chooseTrack(info, 'he'), { key: 'iw', auto: true, source: 'translated' });
  assert.deepEqual(chooseTrack(info, 'zh-CN'), { key: 'zh-Hans', auto: true, source: 'translated' });
  assert.equal(chooseTrack(info, 'th'), null);
});

test('auto captions when the video is spoken in that language', () => {
  const i = { subtitles: {}, automatic_captions: { 'ja-orig': [{}], ja: [{}], en: [{}] } };
  assert.equal(originalLanguage(i), 'ja');
  assert.deepEqual(chooseTrack(i, 'ja'), { key: 'ja-orig', auto: true, source: 'auto' });
  assert.deepEqual(chooseTrack(i, 'native'), { key: 'ja-orig', auto: true, source: 'auto' });
  assert.deepEqual(chooseTrack(i, 'en'), { key: 'en', auto: true, source: 'translated' });
});

test('native prefers manual in the original language', () => {
  assert.deepEqual(chooseTrack(info, 'native'), { key: 'en-US', auto: false, source: 'manual' });
  assert.equal(chooseTrack({ subtitles: {}, automatic_captions: {} }, 'native'), null);
});

test('parses json3', () => {
  const lines = parseJson3({ events: [
    { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Hello ' }, { utf8: 'there' }] },
    { tStartMs: 1500, dDurationMs: 10, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 2000, dDurationMs: 1234, segs: [{ utf8: '  \n ' }] },
    { tStartMs: 3456, dDurationMs: 2000, segs: [{ utf8: 'line one\nline two' }] },
    { tStartMs: 9000 },
  ] });
  assert.deepEqual(lines, [[0, 1.5, 'Hello there'], [3.46, 2, 'line one\nline two']]);
});

import { Captions } from '../src/captions.js';
import { Store } from '../src/store.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('falls back to the next yt-dlp attempt and remembers the winner', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jyt-'));
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 });
  const seen = [];
  const runner = async (cmd, args) => {
    const attempt = args.includes('--force-ipv6') ? 'v6' : 'alt';
    if (args.includes('--write-info-json')) {
      seen.push(attempt);
      if (attempt === 'v6') throw new Error("Sign in to confirm you're not a bot");
      const id = args.at(-1).split('v=')[1];
      await writeFile(join(dataDir, 'info', `${id}.info.json`), JSON.stringify({ language: 'en', subtitles: { en: [{}] }, automatic_captions: {} }));
    } else {
      const id = args[args.indexOf('--load-info-json') + 1].split(/[\\/]/).pop().replace('.json', '');
      seen.push('subs:' + attempt);
      await writeFile(join(dataDir, 'subs', `${id}.en.json3`), JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }] }));
    }
    return '';
  };
  const c = new Captions({ store, ytdlp: 'yt-dlp', dataDir, runner });
  const r = await c.get('vid11chars1', 'en');
  assert.equal(r.available, true);
  assert.deepEqual(r.lines, [[0, 1, 'hi']]);
  await c.get('vid11chars2', 'en');
  assert.deepEqual(seen, ['v6', 'alt', 'subs:alt', 'alt', 'subs:alt']);
});

test('a refused machine translation is "not available", not an error', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jyt-'));
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 });
  let subsCalls = 0;
  const runner = async (cmd, args) => {
    if (args.includes('--write-info-json')) {
      const id = args.at(-1).split('v=')[1];
      await writeFile(join(dataDir, 'info', `${id}.info.json`), JSON.stringify({ subtitles: { en: [{}] }, automatic_captions: { 'en-orig': [{}], fr: [{}] } }));
      return '';
    }
    subsCalls++;
    throw new Error('HTTP Error 429: Too Many Requests');
  };
  const c = new Captions({ store, ytdlp: 'yt-dlp', dataDir, runner });
  const r = await c.get('vidtranslat', 'fr');
  assert.equal(r.available, false);
  assert.equal(r.reason, 'translation_unavailable');
  await c.get('vidtranslat', 'fr');
  assert.equal(subsCalls, 1);
});

import { randomAddress, errorLine } from '../src/captions.js';

test('random source address stays inside the /64', () => {
  const a = randomAddress('2600:3c06:e001:35e::/64', Buffer.from([0, 1, 0xab, 0xcd, 0, 0, 0xff, 0xff]));
  assert.equal(a, '2600:3c06:e001:35e:1:abcd:0:ffff');
  assert.throws(() => randomAddress('2600:3c06::/48'));
});

test('logs the ERROR line, not the help text after it', () => {
  const err = new Error('Command failed');
  err.stderr = 'WARNING: something\nERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser\n';
  assert.match(errorLine(err), /^ERROR: \[youtube\] x: Sign in/);
});

test('a bot-wall refusal pauses lookups and answers unavailable', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jyt-'));
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 });
  let calls = 0, clock = 1_000_000;
  const runner = async () => {
    calls++;
    const e = new Error('Command failed');
    e.stderr = 'ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies';
    throw e;
  };
  const c = new Captions({ store, ytdlp: 'yt-dlp', dataDir, runner, now: () => clock });
  const first = await c.get('vid00000001', 'en');
  assert.equal(first.available, false);
  assert.equal(first.reason, 'temporarily_unavailable');
  assert.equal(calls, 2); // both attempts, once
  await c.get('vid00000002', 'en');
  assert.equal(calls, 2); // paused: YouTube is not asked again
  clock += 11 * 60_000;
  await c.get('vid00000002', 'en');
  assert.equal(calls, 4);
});

test('with a source range, info and subtitles go out from the same address', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jyt-'));
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 });
  const seen = [];
  const runner = async (cmd, args) => {
    assert.ok(!args.includes('--force-ipv6'));
    seen.push(args[args.indexOf('--source-address') + 1]);
    if (args.includes('--write-info-json')) {
      const id = args.at(-1).split('v=')[1];
      await writeFile(join(dataDir, 'info', `${id}.info.json`), JSON.stringify({ language: 'en', subtitles: { en: [{}] }, automatic_captions: {} }));
    } else {
      const id = args[args.indexOf('--load-info-json') + 1].split(/[\\/]/).pop().replace('.json', '');
      await writeFile(join(dataDir, 'subs', `${id}.en.json3`), JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }] }));
    }
    return '';
  };
  const c = new Captions({ store, ytdlp: 'yt-dlp', dataDir, runner, sourcePrefix: '2600:3c06:e001:35e::/64' });
  const r = await c.get('vid00000003', 'en');
  assert.equal(r.available, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.match(seen[0], /^2600:3c06:e001:35e:/);
});
