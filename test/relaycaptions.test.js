import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { captionsJob, warningsFrom } from '../relay/captions.js';

// A fake yt-dlp: writes the info JSON it is handed for each list call (by call number) and records the args.
function fakeYtdlp(infos, warnings = []) {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push(args);
    const o = args[args.indexOf('-o') + 1];
    if (args.includes('--write-info-json')) await writeFile(`${o.replace('%(id)s', 'aaaaaaaaaaa')}.info.json`, JSON.stringify(infos[calls.filter((a) => a.includes('--write-info-json')).length - 1]));
    return { stdout: '', warnings };
  };
  return { runner, calls };
}
const empty = { language: 'en', subtitles: {}, automatic_captions: {} };
const some = { language: 'en', subtitles: {}, automatic_captions: { 'en-orig': [{ ext: 'json3', url: 'x' }], fr: [{ ext: 'json3', url: 'x' }] } };

test('caption job: an empty first list is asked for once more from web,mweb (2026-10-25)', async () => {
  const y = fakeYtdlp([empty, some]);
  const logs = [];
  const r = await captionsJob({ videoId: 'aaaaaaaaaaa', want: null }, { ytdlp: 'yt-dlp', runner: y.runner, log: (l) => logs.push(l) });
  assert.equal(y.calls.length, 2);
  assert.ok(!y.calls[0].includes('--extractor-args'));
  assert.equal(y.calls[1][y.calls[1].indexOf('--extractor-args') + 1], 'youtube:player_client=web,mweb');
  assert.equal(r.retried, true);
  assert.deepEqual(r.info.auto, ['en-orig', 'fr']);
  assert.equal(logs[0].event, 'captions_list');

  const once = fakeYtdlp([some]);
  const r2 = await captionsJob({ videoId: 'aaaaaaaaaaa', want: null }, { ytdlp: 'yt-dlp', runner: once.runner });
  assert.equal(once.calls.length, 1, 'a list with tracks: no retry');
  assert.equal(r2.retried, undefined);
});

test('caption job: yt-dlp runs with warnings on and its WARNING lines come back', async () => {
  const y = fakeYtdlp([empty, empty], ['WARNING: [youtube] aaaaaaaaaaa: something']);
  const r = await captionsJob({ videoId: 'aaaaaaaaaaa', want: { lang: 'en' } }, { ytdlp: 'yt-dlp', runner: y.runner });
  assert.ok(y.calls.every((a) => !a.includes('--no-warnings')));
  assert.equal(r.reason, 'no_captions');
  assert.deepEqual(r.warnings, ['WARNING: [youtube] aaaaaaaaaaa: something', 'WARNING: [youtube] aaaaaaaaaaa: something']);
  assert.deepEqual(warningsFrom('[debug] x\nWARNING: a\nWARNING: a\nERROR: b\nWARNING: c'), ['WARNING: a', 'WARNING: c']);
});
