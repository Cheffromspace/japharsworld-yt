import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, readdir, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { captionsJob, warningsFrom } from '../relay/captions.js';
// Read off the module so this file still loads on the code before Everything-is-OK#968 (the before-runs).
import * as cap from '../src/captions.js';
import { createWorker } from '../relay/worker.js';

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

// ---- Everything-is-OK#968: caption files too large to read, and a second job for the same video ----
const INFO_MAX = cap.INFO_MAX_BYTES ?? 40 * 1024 * 1024;
const ID = 'aaaaaaaaaaa';
const track3 = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }] });
// An info JSON shaped like a post_live one: formats with fragment lists of ~1 KB URLs, a title that is not Latin-1 (so
// the text is held as UTF-16), and no caption tracks yet. Written in pieces, so this process never holds it whole.
async function bigInfo(path, bytes) {
  await writeFile(path, '{"title":"ライブ","language":"ja","subtitles":{},"automatic_captions":{},"formats":[');
  const url = 'https://rr1---sn-test.googlevideo.com/videoplayback?' + 'x'.repeat(950);
  let size = 0;
  for (let f = 0; size < bytes; f++) {
    const n = Math.max(1, Math.min(1000, Math.ceil((bytes - size) / 1000)));
    const frags = Array.from({ length: n }, (_, i) => JSON.stringify({ url: `${url}&sq=${i}`, duration: 5 })).join(',');
    const part = `${f ? ',' : ''}{"format_id":"${f}","fragments":[${frags}]}`;
    await appendFile(path, part);
    size += part.length;
  }
  await appendFile(path, ']}');
}
// A fake yt-dlp writing `info` (an object, or a file path to copy) for list calls and `track` text for track calls.
function fakeFiles({ info = some, track = track3, gate = null } = {}) {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push(args);
    const o = args[args.indexOf('-o') + 1].replace('%(id)s', ID);
    if (args.includes('--write-info-json')) {
      if (gate) await gate;
      await writeFile(`${o}.info.json`, typeof info === 'string' ? await readFile(info) : JSON.stringify(info));
    } else {
      const key = args[args.indexOf('--sub-langs') + 1].slice(1, -1);
      await writeFile(`${o}.${key}.json3`, track);
    }
    return { stdout: '', warnings: [] };
  };
  const lists = () => calls.filter((a) => a.includes('--write-info-json')).length;
  const tracks = () => calls.filter((a) => a.includes('--load-info-json')).length;
  return { runner, calls, lists, tracks };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('#968: an info JSON over the limit is refused unread: one yt-dlp call, no retry, no --load-info-json, no temp folder left', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'jyt-968-'));
  try {
    const file = join(tmp, 'big.json');
    await bigInfo(file, 200 * 1024);
    const y = fakeFiles({ info: file });
    const work = await mkdtemp(join(tmp, 'w-'));
    const err = await captionsJob({ videoId: ID, want: { lang: 'en' } }, { ytdlp: 'yt-dlp', runner: y.runner, tmp: work, maxInfoBytes: 64 * 1024 }).then(() => null, (e) => e);
    assert.ok(err, 'refused, not parsed');
    assert.equal(err.code, 'info_too_large');
    assert.ok(err.bytes > 200 * 1024);
    assert.equal(y.calls.length, 1, 'the list call only');
    assert.deepEqual(await readdir(work), [], 'its temp folder is removed');
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('#968: a caption track over the limit is refused unread, the same clean error', async () => {
  const work = await mkdtemp(join(tmpdir(), 'jyt-968-'));
  try {
    const long = JSON.stringify({ events: Array.from({ length: 200 }, (_, i) => ({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: 'word ' }] })) });
    const y = fakeFiles({ track: long });
    const err = await captionsJob({ videoId: ID, want: { lang: 'en' } }, { ytdlp: 'yt-dlp', runner: y.runner, tmp: work, maxTrackBytes: 1024 }).then(() => null, (e) => e);
    assert.ok(err, 'refused, not parsed');
    assert.equal(err.code, 'track_too_large');
    assert.equal(y.lists(), 1);
    assert.equal(y.tracks(), 1);
    assert.deepEqual(await readdir(work), []);
    // Under the limit a track is read as before.
    const ok = await captionsJob({ videoId: ID, want: { lang: 'en' } }, { ytdlp: 'yt-dlp', runner: fakeFiles().runner, tmp: work, maxTrackBytes: 1024 });
    assert.equal(ok.cues.length, 1);
  } finally { await rm(work, { recursive: true, force: true }); }
});

// The crash itself, small: a worker with a 64 MB heap and an info JSON just past the default limit. Before #968 the child
// dies with "JavaScript heap out of memory" (measured 2026-11-21: a 33.4 MB file of this shape needs 96-128 MB of heap);
// with the limit it never reads the file. The flag is the point: without it the child passes on a dev PC and proves
// nothing. A child that cannot start fails this test through spawnSync's error (no skip).
test('#968: a 64 MB heap survives an info JSON past the limit (the 2026-11-21 crash, small)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'jyt-968-'));
  try {
    const big = join(tmp, 'big.json');
    await bigInfo(big, INFO_MAX + 2 * 1024 * 1024);
    const mod = new URL('../relay/captions.js', import.meta.url).href;
    const code = [
      `import { captionsJob } from ${JSON.stringify(mod)};`,
      `import { copyFile } from 'node:fs/promises';`,
      `const runner = async (cmd, args) => {`,
      `  const o = args[args.indexOf('-o') + 1].replace('%(id)s', ${JSON.stringify(ID)});`,
      `  if (args.includes('--write-info-json')) await copyFile(${JSON.stringify(big)}, o + '.info.json');`,
      `  return { stdout: '', warnings: [] };`,
      `};`,
      `try {`,
      `  const r = await captionsJob({ videoId: ${JSON.stringify(ID)}, want: { lang: 'en' } }, { ytdlp: 'yt-dlp', runner, tmp: ${JSON.stringify(tmp)} });`,
      `  console.log('ANSWER ' + (r.reason ?? 'cues'));`,
      `} catch (e) { console.log('CLEAN ' + e.code); }`,
    ].join('\n');
    const r = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000 });
    assert.ifError(r.error);
    const why = String(r.stderr).split('\n').filter((l) => /heap|FATAL|Error/.test(l)).slice(0, 3).join(' | ');
    assert.match(r.stdout, /^CLEAN info_too_large$/m, `child exit ${r.status} ${r.signal ?? ''}: ${why}`);
    assert.equal(r.status, 0);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('#968: the worker answers a too-large file with its code, no refusal class, no pause, one log line with whole MB and no id', async () => {
  const logs = [];
  let n = 0;
  const captions = async () => {
    if (n++ === 0) throw Object.assign(new Error('info_too_large'), { code: 'info_too_large', bytes: 400.4 * 1048576 });
    return { info: { language: 'en', manual: [], auto: ['en'] }, track: null, cues: null };
  };
  const w = createWorker({ url: 'http://x', token: 't', captions, log: (l) => logs.push(l) });
  const r = await w.handle({ id: 'j1', kind: 'captions', videoId: ID, want: null });
  assert.deepEqual(r, { id: 'j1', ok: false, error: 'info_too_large' }, 'no refusal, so the server counts no yt_refusal');
  assert.deepEqual(w.paused(), [], 'not paused (not the rate refusal)');
  assert.deepEqual(logs, [{ event: 'job_failed', kind: 'captions', ms: logs[0]?.ms, message: 'info_too_large', mb: 400 }]);
  assert.ok(!JSON.stringify(logs).includes(ID), 'no video id in the line');
  const next = await w.handle({ id: 'j2', kind: 'captions', videoId: ID, want: null });
  assert.equal(next.ok, true, 'the next caption job runs');
});

test('#968: a second caption job for the same video joins the first one\'s list (one yt-dlp list call, one parse); each gets its own answer', async () => {
  const work = await mkdtemp(join(tmpdir(), 'jyt-968-'));
  try {
    let release;
    const y = fakeFiles({ gate: new Promise((r) => { release = r; }) });
    const lists = new Map();
    const opts = { ytdlp: 'yt-dlp', runner: y.runner, tmp: work, lists };
    const a = captionsJob({ videoId: ID, want: null }, opts);
    const b = captionsJob({ videoId: ID, want: { lang: 'en' } }, opts);
    await tick();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(y.lists(), 1, 'one list call for both jobs');
    assert.equal(y.tracks(), 1, 'the track job fetched its own track');
    assert.equal(ra.track, null, 'the list-only job got the list');
    assert.deepEqual(ra.info.auto, ['en-orig', 'fr']);
    assert.equal(rb.track.key, 'en-orig', 'the track job got its track');
    assert.equal(rb.cues.length, 1);
    assert.equal(lists.size, 0, 'nothing left in flight');
    assert.deepEqual(await readdir(work), [], 'every temp folder removed');
    // Once the first list has settled, a new job runs its own list step.
    await captionsJob({ videoId: ID, want: null }, opts);
    assert.equal(y.lists(), 2);

    // A refused file reaches every job that joined it, from one list call.
    const big = await mkdtemp(join(tmpdir(), 'jyt-968-big-'));
    try {
      const file = join(big, 'big.json');
      await bigInfo(file, 200 * 1024);
      let go;
      const z = fakeFiles({ info: file, gate: new Promise((r) => { go = r; }) });
      const zopts = { ytdlp: 'yt-dlp', runner: z.runner, tmp: work, lists, maxInfoBytes: 64 * 1024 };
      const jobs = [captionsJob({ videoId: ID, want: null }, zopts), captionsJob({ videoId: ID, want: { lang: 'en' } }, zopts)].map((p) => p.then(() => 'answered', (e) => e.code));
      await tick();
      go();
      assert.deepEqual(await Promise.all(jobs), ['info_too_large', 'info_too_large']);
      assert.equal(z.calls.length, 1);
      assert.deepEqual(await readdir(work), []);
    } finally { await rm(big, { recursive: true, force: true }); }
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('#968: the worker shares one list map across its poll loops (two jobs at once, one list call)', async () => {
  const work = await mkdtemp(join(tmpdir(), 'jyt-968-'));
  try {
    let release;
    const y = fakeFiles({ gate: new Promise((r) => { release = r; }) });
    // A yt-dlp path that cannot exist: before #968 captionOpts is ignored and the job fails to start, never asking YouTube.
    const w = createWorker({ url: 'http://x', token: 't', ytdlp: 'no-such-ytdlp-968', captionOpts: { runner: y.runner, tmp: work }, log: () => {} });
    const a = w.handle({ id: 'j1', kind: 'captions', videoId: ID, want: { lang: 'native' } });
    const b = w.handle({ id: 'j2', kind: 'captions', videoId: ID, want: null });
    await tick();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, true, ra.error);
    assert.equal(rb.ok, true, rb.error);
    assert.equal(ra.id, 'j1');
    assert.equal(rb.id, 'j2');
    assert.equal(y.lists(), 1);
    assert.equal(ra.captions.cues.length, 1);
    assert.deepEqual(await readdir(work), []);
  } finally { await rm(work, { recursive: true, force: true }); }
});
