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

// ---- Everything-is-OK#968: the server's own yt-dlp path refuses files too large to read ----
import { readdir, mkdir } from 'node:fs/promises';
import { CaptionChain } from '../src/captionchain.js';

// A fake yt-dlp for the server's Captions: `info` for list calls, `track` text for track calls (json3 under the key).
function serverYtdlp(dataDir, { info, track = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }] }) }) {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push(args);
    if (args.includes('--write-info-json')) {
      const id = args.at(-1).split('v=')[1];
      await writeFile(join(dataDir, 'info', `${id}.info.json`), JSON.stringify(info));
    } else {
      const id = args[args.indexOf('--load-info-json') + 1].split(/[\\/]/).pop().replace('.json', '');
      const key = args[args.indexOf('--sub-langs') + 1].slice(1, -1);
      await writeFile(join(dataDir, 'subs', `${id}.${key}.json3`), track);
    }
    return '';
  };
  return { runner, calls };
}
const padded = { language: 'en', subtitles: {}, automatic_captions: {}, formats: [{ fragments: Array.from({ length: 300 }, (_, i) => ({ url: 'u'.repeat(900) + i })) }] };

test('#968: the server path refuses an oversized info JSON, deletes it, and the chain answers "not available right now"', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jyt-968-'));
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 });
  const y = serverYtdlp(dataDir, { info: padded });
  const local = new Captions({ store, ytdlp: 'yt-dlp', dataDir, runner: y.runner, attempts: [[]], maxInfoBytes: 64 * 1024 });
  const err = await local.info('vid968info1').then(() => null, (e) => e);
  assert.ok(err, 'refused, not parsed');
  assert.equal(err.code, 'info_too_large');
  assert.deepEqual(await readdir(join(dataDir, 'info')), [], 'nothing kept in data/info');
  // The legacy route answers the same "not available right now", uncached.
  assert.equal((await local.get('vid968info2', 'en')).reason, 'temporarily_unavailable');
  assert.equal(store.captionGet('vid968info2', 'en', 3600_000), null);

  const logs = [];
  const chain = new CaptionChain({ store, local, log: (l) => logs.push(l) });
  const r = await chain.get('vid968info3', 'en');
  assert.equal(r.available, false);
  assert.equal(r.reason, 'temporarily_unavailable', 'the existing code, not no_captions');
  assert.deepEqual(logs.filter((l) => l.event === 'captions_source_failed').map((l) => [l.via, l.message]), [['local', 'info_too_large']]);
  assert.equal(chain.list('vid968info3'), null, 'no empty list cached');
});

test('#968: the server path refuses an oversized caption track and deletes it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jyt-968-'));
  await mkdir(join(dataDir, 'subs'), { recursive: true });
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 });
  const long = JSON.stringify({ events: Array.from({ length: 200 }, (_, i) => ({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: 'word ' }] })) });
  const y = serverYtdlp(dataDir, { info: { language: 'en', subtitles: { en: [{}] }, automatic_captions: {} }, track: long });
  const local = new Captions({ store, ytdlp: 'yt-dlp', dataDir, runner: y.runner, attempts: [[]], maxTrackBytes: 1024 });
  const { file } = await local.info('vid968trak1');
  const err = await local.cues('vid968trak1', file, { key: 'en', auto: false }).then(() => null, (e) => e);
  assert.ok(err, 'refused, not parsed');
  assert.equal(err.code, 'track_too_large');
  assert.deepEqual(await readdir(join(dataDir, 'subs')), [], 'the track file is deleted');
  assert.equal((await local.get('vid968trak2', 'en')).reason, 'temporarily_unavailable', 'legacy route: not available right now');
  assert.deepEqual(await readdir(join(dataDir, 'subs')), []);
});
