// Home copies judged whole or short (Everything-is-OK#780, #781; the owner's review of the service release, 2026-11-15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Home, SHORT_S as HOME_SHORT_S } from '../src/home.js';
import { mediaJob } from '../relay/media.js';
import { MediaCache, SHORT_S } from '../relay/cache.js';

const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'cut-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const fakeRelay = () => ({ jobs: [], enabled: true, capable: () => ['home'], run() { return new Promise(() => {}); } });
const runnerDur = (s) => async () => `https://v.example/video?clen=100&dur=${s}\nhttps://v.example/audio?clen=100&dur=${s}\n`;
const name = (i) => `seg${i}.ts`;
// A playlist of these segment lengths (keyframe cuts: EVENT, as ffmpeg writes it), closed with ENDLIST when `end`.
const pl = (lengths, end = false) => `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n${lengths.map((d, i) => `#EXTINF:${d.toFixed(6)},\n${name(i)}\n`).join('')}${end ? '#EXT-X-ENDLIST\n' : ''}`;
const sum = (a) => a.reduce((x, y) => x + y, 0);

// A fake ffmpeg: each step writes its segments and playlist into the output folder, then it exits with `code`.
function fakeFfmpeg(steps, { code = 0 } = {}) {
  const spawnFn = (cmd, args) => {
    const dir = dirname(args.at(-1));
    const p = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {};
    steps.forEach(([text, segs], i) => setTimeout(() => {
      for (const s of segs) writeFileSync(join(dir, s), s);
      writeFileSync(join(dir, 'index.m3u8'), text);
      if (i === steps.length - 1) setTimeout(() => { if (code) p.stderr.emit('data', 'Connection reset\n'); p.emit('close', code); }, 20);
    }, 30 + i * 80));
    return p;
  };
  return { spawnFn };
}

// A whole keyframe-cut build of these segment lengths, `seconds` long by its dur=, with a cache. → its uploads and logs.
async function build(t, lengths, seconds, { code = 0, steps = null, upload = null, job = {} } = {}) {
  const cache = new MediaCache({ dir: tmp(t), maxGb: 1 });
  const all = lengths.map((_, i) => name(i));
  const ff = fakeFfmpeg(steps ?? [[pl(lengths.slice(0, 8)), all.slice(0, 8)], [pl(lengths, true), all.slice(8)]], { code });
  const uploads = [];
  const logs = [];
  const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'x', ...job }, { ytdlp: 'yt-dlp', runner: runnerDur(seconds), spawnFn: ff.spawnFn,
    pollMs: 10, retryMs: 1, cache, log: (o) => logs.push(o),
    upload: upload ?? (async (file, body, type, opts = {}) => { uploads.push({ file, body: body.toString(), ...opts }); return 204; }) });
  await first.done;
  return { uploads, logs, cache, playlists: uploads.filter((u) => u.file === 'index.m3u8') };
}

// The two ways a whole build comes out with fewer segments than predicted (#780).
// 1. `dur=` 0.2 s past the media's end: 12 × 5 s = 60 s made; predictPlaylist lists 12 × 5 s + a 0.2 s tail = 13.
const TAIL = { lengths: Array(12).fill(5), seconds: 60.2 };
// 2. steadyLength's median below the real GOP: the first 8 are five 5.00 s and three 5.04 s (all within a frame of the
// median, 5.00), the rest 5.04 s. Over an hour the prediction (720 × 5 s) runs 6 segments past the real 714.
const DRIFT = (() => {
  const seconds = 3600;
  const lengths = [5, 5, 5, 5, 5, 5.04, 5.04, 5.04];
  while (sum(lengths) + 5.04 < seconds) lengths.push(5.04);
  lengths.push(Math.round((seconds - sum(lengths)) * 1e6) / 1e6);
  return { lengths, seconds };
})();

for (const [why, c, predicted] of [['dur= runs 0.2 s past the media (a tail segment ffmpeg never makes)', TAIL, 13],
  ['the median GOP is below the real one (6 segments of drift over an hour)', DRIFT, 720]]) {
  test(`#780 worker: a whole build with fewer segments than predicted is done and cached, not failed short: ${why}`, async (t) => {
    const { logs, cache, playlists } = await build(t, c.lengths, c.seconds);
    assert.equal(logs.find((l) => l.event === 'media_mismatch')?.predicted, predicted, 'the prediction was over');
    assert.equal(logs.find((l) => l.event === 'media_mismatch')?.actual, c.lengths.length);
    assert.equal(logs.some((l) => l.event === 'media_failed'), false, 'not failed as short');
    assert.ok(logs.some((l) => l.event === 'media_done'));
    assert.equal((playlists.at(-1).body.match(/^seg\d+\.ts$/gm) ?? []).length, c.lengths.length, 'the real playlist went up');
    assert.match(playlists.at(-1).body, /#EXT-X-ENDLIST\n$/);
    assert.ok(cache.get('aaaaaaaaaaa', '720p', { seconds: c.seconds }), 'the whole copy is cached');
  });

  test(`#780 server: the real playlist of a whole build, fewer segments than predicted, ends the session done: ${why}`, async (t) => {
    const logs = [];
    const home = new Home({ relay: fakeRelay(), dir: tmp(t), base: 'https://yt/home', enabled: true, log: (l) => logs.push(l) });
    const s = home.start({ id: 'aaaaaaaaaaa', seconds: Math.round(c.seconds) }, '720p');
    const pred = Array(predicted).fill(c.lengths[0]);
    pred[predicted - 1] = Math.round((c.seconds - sum(pred.slice(0, -1))) * 1e6) / 1e6;
    assert.equal(home.put(s.token, 'seg0.ts', Buffer.from('a')), 204);
    assert.equal(home.put(s.token, 'index.m3u8', Buffer.from(pl(pred, true))), 204);
    assert.equal(s.segments, predicted);
    for (let i = 1; i < c.lengths.length; i++) home.put(s.token, name(i), Buffer.from('b'));
    assert.equal(home.put(s.token, 'index.m3u8', Buffer.from(pl(c.lengths, true))), 204);
    assert.notEqual(s.state, 'failed');
    assert.equal(s.ended, true, 'done: every listed segment is here');
    assert.ok(logs.some((l) => l.event === 'home_done') && !logs.some((l) => l.event === 'home_failed'));
    assert.equal(home.peek({ id: 'aaaaaaaaaaa' }, '720p'), s, 'reused');
  });
}

test('#780 worker: a build that really ends short (exit 0, 20 of 60 s) is still failed short and not cached', async (t) => {
  const lengths = Array(4).fill(5);
  const { logs, cache } = await build(t, lengths, 60, { steps: [[pl(lengths, true), lengths.map((_, i) => name(i))]] });
  assert.equal(logs.find((l) => l.event === 'media_failed')?.reason, 'short');
  assert.equal(cache.get('aaaaaaaaaaa', '720p', { seconds: 60 }), null);
});

test('#780 server: with no failure signal, a closed playlist SHORT_S (10 s) or more shorter than before is failed; less is done', async (t) => {
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), base: 'https://yt/home', enabled: true });
  const run = (cutTo) => {
    const s = home.start({ id: `aaaaaaaaaa${cutTo}`, seconds: 40 }, '720p');
    home.put(s.token, 'seg0.ts', Buffer.from('a'));
    home.put(s.token, 'index.m3u8', Buffer.from(pl(Array(10).fill(4), true)));
    for (let i = 1; i < cutTo; i++) home.put(s.token, name(i), Buffer.from('b'));
    home.put(s.token, 'index.m3u8', Buffer.from(pl(Array(cutTo).fill(4), true)));
    return s;
  };
  const cut = run(7); // 28 of 40 s
  assert.equal(cut.state, 'failed');
  assert.equal(cut.reason, 'cut_short');
  const near = run(8); // 32 of 40 s: 8 s short, under SHORT_S
  assert.notEqual(near.state, 'failed');
  assert.equal(near.ended, true);
});

// #781: a growing (unpredicted) build that ends part way after players were sent. Uneven keyframe cuts, so no prediction.
const UNEVEN = [3, 5, 4, 6, 2, 5, 7, 4, 3, 5, 4, 6]; // 54 s of a 60 s video
const failedCloses = (uploads) => uploads.filter((u) => u.file === 'index.m3u8' && u.failed);

test('#781 worker, path A (the catch): an upload refused after ready closes the playlist marked failed; nothing cached', async (t) => {
  const uploads = [];
  const { logs, cache } = await build(t, UNEVEN, 60, { upload: async (file, body, type, opts = {}) => {
    uploads.push({ file, body: body.toString(), ...opts });
    return file === 'seg9.ts' ? 413 : 204;
  } });
  assert.equal(logs.find((l) => l.event === 'media_steady')?.steady, false, 'growing playlist');
  assert.match(logs.find((l) => l.event === 'media_failed')?.message ?? '', /seg9\.ts .* answered 413/);
  const closes = failedCloses(uploads);
  assert.equal(closes.length, 1, 'one closing playlist, marked failed');
  assert.match(closes[0].body, /seg8\.ts\n#EXT-X-ENDLIST\n$/);
  assert.equal(cache.get('aaaaaaaaaaa', '720p', { seconds: 60 }), null);
});

test('#781 worker, path B: ffmpeg exiting non-zero part way closes the playlist marked failed; nothing cached', async (t) => {
  const lengths = UNEVEN.slice(0, 10); // 44 of 60 s, then a connection reset
  const all = lengths.map((_, i) => name(i));
  const { uploads, logs, cache } = await build(t, lengths, 60, { code: 1, steps: [[pl(lengths.slice(0, 8)), all.slice(0, 8)], [pl(lengths), all.slice(8)]] });
  assert.equal(logs.find((l) => l.event === 'media_done')?.exit, 1);
  const closes = failedCloses(uploads);
  assert.equal(closes.length, 1);
  assert.match(closes[0].body, /seg9\.ts\n#EXT-X-ENDLIST\n$/);
  assert.equal(cache.get('aaaaaaaaaaa', '720p', { seconds: 60 }), null);
});

test('#781 worker, path C: ffmpeg ending cleanly short (its own ENDLIST, 44 of 60 s) closes marked failed, and the copy is not cached (main cached it)', async (t) => {
  const lengths = UNEVEN.slice(0, 10);
  const all = lengths.map((_, i) => name(i));
  const { uploads, logs, cache } = await build(t, lengths, 60, { steps: [[pl(lengths.slice(0, 8)), all.slice(0, 8)], [pl(lengths, true), all.slice(8)]] });
  assert.equal(logs.find((l) => l.event === 'media_failed')?.reason, 'short');
  const closes = failedCloses(uploads);
  assert.equal(closes.length, 1);
  assert.match(closes[0].body, /seg9\.ts\n#EXT-X-ENDLIST\n$/);
  assert.equal(cache.get('aaaaaaaaaaa', '720p', { seconds: 60 }), null, 'the worker does not cache it');
  assert.equal(cache.get('aaaaaaaaaaa', '720p'), null, 'not even without a length to compare with');
});

test('#781 worker: a whole growing build sends no failure mark and is cached', async (t) => {
  const lengths = [...UNEVEN, 6]; // 60 s
  const { uploads, logs, cache } = await build(t, lengths, 60);
  assert.equal(failedCloses(uploads).length, 0);
  assert.ok(logs.some((l) => l.event === 'media_done') && !logs.some((l) => l.event === 'media_failed'));
  assert.ok(cache.get('aaaaaaaaaaa', '720p', { seconds: 60 }));
});

test('#781 server: a growing playlist closed with the failure mark fails the session; players on it get what is here and end at the cut; not reused', async (t) => {
  let now = 1_000_000;
  const logs = [];
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), base: 'https://yt/home', enabled: true, segmentHoldMs: 5000, now: () => now, log: (l) => logs.push(l) });
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 60 }, '720p');
  home.put(s.token, 'seg0.ts', Buffer.from('a'));
  home.put(s.token, 'index.m3u8', Buffer.from(pl([3])));
  home.put(s.token, 'seg1.ts', Buffer.from('b'));
  home.put(s.token, 'index.m3u8', Buffer.from(pl([3, 5])));
  const waiting = home.file(s.token, 'seg2.ts'); // a player ahead of the upload
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from(pl([3, 5], true)), { failed: true }), 204);
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'cut_short');
  assert.equal(await waiting, null, 'released at once, not after the hold');
  assert.match((await home.file(s.token, 'index.m3u8')).body.toString(), /seg1\.ts\n#EXT-X-ENDLIST/, 'the closed playlist is still served');
  assert.equal((await home.file(s.token, 'seg1.ts')).body.toString(), 'b');
  assert.ok(!logs.some((l) => l.event === 'home_done'));
  now += 61_000;
  assert.equal(home.peek({ id: 'aaaaaaaaaaa' }, '720p'), null, 'the next play starts over, not 12 h of the short copy');
});

test('#781 server: the mark after the closed playlist already went up unmarked fails a session that had ended as done', async (t) => {
  let now = 1_000_000;
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), base: 'https://yt/home', enabled: true, now: () => now });
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 60 }, '720p');
  home.put(s.token, 'seg0.ts', Buffer.from('a'));
  home.put(s.token, 'index.m3u8', Buffer.from(pl([3], true)));
  assert.equal(s.ended, true, 'done as far as the server could tell');
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from(pl([3], true)), { failed: true }), 204);
  assert.equal(s.state, 'failed');
  now += 61_000;
  assert.equal(home.peek({ id: 'aaaaaaaaaaa' }, '720p'), null);
});

test('#780: the server and the worker judge short by the same SHORT_S', () => {
  assert.equal(HOME_SHORT_S, SHORT_S);
});

// Verifier round 1, M1 (2026-11-15): a failed session still being played is set aside by the next start of its video,
// not deleted under its players; sweep() drops it once nobody plays it. From the verifier's probe-drop-after-fail.mjs.
const growing400 = (n) => `#EXTM3U\n${Array.from({ length: n }, (_, i) => `#EXTINF:4,\nseg${i}.ts\n`).join('')}#EXT-X-ENDLIST\n`;
function failedSession(t, now) {
  const logs = [];
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), base: 'https://yt/home', enabled: true, now: () => now.t, log: (l) => logs.push(l) });
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 3600 }, '720p');
  for (let i = 0; i < 100; i++) home.put(s.token, name(i), Buffer.from('x'));
  home.put(s.token, 'index.m3u8', Buffer.from(growing400(100)), { failed: true }); // 400 s of 3600 s, marked failed
  assert.equal(s.state, 'failed');
  return { home, s, logs };
}

test('M1: a failed session a player is on is set aside, not deleted, by the next play of its video after RETRY_MS; the player plays on to the cut', async (t) => {
  const now = { t: 1_000_000 };
  const { home, s, logs } = failedSession(t, now);
  now.t += 10_000;
  assert.equal((await home.file(s.token, 'seg5.ts')).body.toString(), 'x', 'a player on it');
  now.t += 61_000;
  const s2 = home.start({ id: 'aaaaaaaaaaa', seconds: 3600 }, '720p'); // a late joiner, a Resync or a pin re-plan
  assert.ok(s2 && s2 !== s, 'the new play gets its own session');
  assert.equal(home.peek({ id: 'aaaaaaaaaaa' }, '720p'), s2);
  assert.equal((await home.file(s.token, 'seg6.ts'))?.body.toString(), 'x', 'the first player\'s next segment is still there');
  assert.ok(logs.some((l) => l.event === 'home_set_aside' && l.state === 'failed'));
  assert.equal((await home.file(s.token, 'seg99.ts'))?.body.toString(), 'x', 'up to the cut');
  assert.match((await home.file(s.token, 'index.m3u8')).body.toString(), /seg99\.ts\n#EXT-X-ENDLIST/);
  home.sweep();
  assert.ok(await home.file(s.token, 'seg7.ts'), 'a sweep while it is played keeps it');
  now.t += 5 * 60_000 + 1; // nobody has fetched from it for PLAYING_MS
  home.sweep();
  assert.equal(await home.file(s.token, 'seg8.ts'), null, 'then the sweep drops it');
  assert.ok(logs.some((l) => l.event === 'home_evict' && l.why === 'replaced'));
  assert.equal(home.peek({ id: 'aaaaaaaaaaa' }, '720p'), s2, 'the new session stays');
});

test('M1: a failed session nobody is playing is dropped by the next play after RETRY_MS, as before', async (t) => {
  const now = { t: 1_000_000 };
  const { home, s, logs } = failedSession(t, now);
  now.t += 61_000;
  const s2 = home.start({ id: 'aaaaaaaaaaa', seconds: 3600 }, '720p');
  assert.ok(s2 && s2 !== s);
  assert.equal(await home.file(s.token, 'seg0.ts'), null, 'gone at once');
  assert.ok(!logs.some((l) => l.event === 'home_set_aside'));
});

// Verifier round 1, M2: a whole copy whose only failure is the closing playlist upload is not failed. From the verifier's
// probe-patha-whole.mjs: a growing 60 s build sends all 13 segments, then its closing playlist answers 503 five times.
for (const [why, closeAnswers] of [['the server takes it on the next try', [503, 503, 503, 503, 503, 204]], ['the server never takes it', Array(12).fill(503)]]) {
  test(`M2: a whole copy whose closing playlist upload fails is closed unmarked and cached, not failed (${why})`, async (t) => {
    const lengths = [...UNEVEN, 6]; // 60 s, 13 segments
    const answers = [...closeAnswers];
    const uploads = [];
    const { logs, cache } = await build(t, lengths, 60, { upload: async (file, body, type, opts = {}) => {
      const b = body.toString();
      const status = file === 'index.m3u8' && b.includes('#EXT-X-ENDLIST') ? (answers.shift() ?? 204) : 204;
      uploads.push({ file, body: b, status, ...opts });
      return status;
    } });
    assert.equal(new Set(uploads.filter((u) => u.file !== 'index.m3u8').map((u) => u.file)).size, 13, 'every segment sent');
    assert.match(logs.find((l) => l.event === 'media_failed')?.message ?? '', /upload playlist answered 503/);
    assert.equal(failedCloses(uploads).length, 0, 'no failure mark');
    assert.equal(logs.find((l) => l.event === 'media_closed')?.whole, true);
    assert.ok(cache.get('aaaaaaaaaaa', '720p', { seconds: 60 }), 'the whole copy is cached');
  });
}

test('M2: a copy the catch finds short (a segment refused) is still marked failed and not cached', async (t) => {
  const uploads = [];
  const { cache } = await build(t, [...UNEVEN, 6], 60, { upload: async (file, body, type, opts = {}) => {
    uploads.push({ file, body: body.toString(), ...opts });
    return file === 'seg11.ts' ? 413 : 204;
  } });
  assert.equal(failedCloses(uploads).length, 1);
  assert.equal(cache.get('aaaaaaaaaaa', '720p', { seconds: 60 }), null);
});

// Verifier round 1, L6: a growing copy short of the video goes up closed only once, marked; ffmpeg's own ENDLIST, read
// before its exit was seen, is not sent unmarked first. The server counts and logs it once, as failed.
test('L6: path C sends no unmarked closed playlist before the marked one', async (t) => {
  for (let i = 0; i < 3; i++) { // the pass that reads ffmpeg's ENDLIST before its exit is seen is a race: three tries
    const lengths = UNEVEN.slice(0, 10);
    const all = lengths.map((_, j) => name(j));
    const { uploads } = await build(t, lengths, 60, { steps: [[pl(lengths.slice(0, 8)), all.slice(0, 8)], [pl(lengths, true), all.slice(8)]] });
    const closes = uploads.filter((u) => u.file === 'index.m3u8' && u.body.includes('#EXT-X-ENDLIST'));
    assert.deepEqual(closes.map((u) => Boolean(u.failed)), [true], `try ${i + 1}: one close, marked`);
  }
});

test('L6: a session ended as done and then marked failed counts once, as failed', (t) => {
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), base: 'https://yt/home', enabled: true });
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 60 }, '720p');
  home.put(s.token, 'seg0.ts', Buffer.from('a'));
  home.put(s.token, 'index.m3u8', Buffer.from(pl([3], true)));
  home.put(s.token, 'index.m3u8', Buffer.from(pl([3], true)), { failed: true });
  const st = home.state();
  assert.deepEqual([st.ended, st.failed], [0, 1]);
});

test('M1: after a restart a failed session with files is kept set aside for its players, never offered to a new play, then swept', async (t) => {
  const now = { t: 1_000_000 };
  const dir = tmp(t);
  const relay = fakeRelay();
  const first = new Home({ relay, dir, base: 'https://yt/home', enabled: true, now: () => now.t });
  const s = first.start({ id: 'aaaaaaaaaaa', seconds: 3600 }, '720p');
  for (let i = 0; i < 100; i++) first.put(s.token, name(i), Buffer.from('x'));
  first.put(s.token, 'index.m3u8', Buffer.from(growing400(100)), { failed: true });
  now.t += 10_000;
  const restarted = new Home({ relay, dir, base: 'https://yt/home', enabled: true, now: () => now.t }); // a deploy
  assert.equal(restarted.peek({ id: 'aaaaaaaaaaa' }, '720p'), null, 'not offered to a new play');
  assert.equal((await restarted.file(s.token, 'seg6.ts'))?.body.toString(), 'x', 'its player plays on');
  const s2 = restarted.start({ id: 'aaaaaaaaaaa', seconds: 3600 }, '720p');
  assert.ok(s2 && s2.token !== s.token);
  assert.ok(await restarted.file(s.token, 'seg7.ts'), 'still there after a new play started');
  now.t += 5 * 60_000 + 1;
  restarted.sweep();
  assert.equal(await restarted.file(s.token, 'seg8.ts'), null, 'swept once nobody plays it');
  // A session failed another way (given up) is still removed at load, as before.
  const empty = restarted.start({ id: 'bbbbbbbbbbb', seconds: 60 }, '720p');
  restarted.put(empty.token, 'index.m3u8', Buffer.from('#EXTM3U\n'));
  restarted.giveUp(empty, 'uneven');
  const again = new Home({ relay, dir, base: 'https://yt/home', enabled: true, now: () => now.t });
  assert.equal(await again.file(empty.token, 'index.m3u8'), null);
});
