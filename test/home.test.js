import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { Home } from '../src/home.js';
import { createWorker } from '../relay/worker.js';
import { mediaJob, ffmpegArgs, formatFor, rangeProxy, predictPlaylist, steadyLength, onTime, closedAt } from '../relay/media.js';
import { config as base } from '../src/config.js';

const TOKEN = 'secret-token';
const PL1 = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\nseg0.ts\n';
const PL2 = `${PL1}#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n`;
const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'home-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

// A relay that records media jobs and has one media worker online.
function fakeRelay({ online = true } = {}) {
  const jobs = [];
  return { jobs, enabled: true, capable: () => (online ? ['home'] : []), run(job) { jobs.push(job); return new Promise(() => {}); } };
}

test('home: a session is ready at its first playlist with a segment; the playlist served has absolute links and starts at 0', async (t) => {
  const relay = fakeRelay();
  const events = [];
  const home = new Home({ relay, dir: tmp(t), base: 'https://yt/home', enabled: true, onEvent: (k) => events.push(k) });
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 600 }, '720p');
  assert.equal(s.state, 'building');
  assert.deepEqual(relay.jobs[0], { kind: 'media', videoId: 'aaaaaaaaaaa', quality: '720p', token: s.token, seconds: 600 });
  assert.equal(home.start({ id: 'aaaaaaaaaaa' }, '720p'), s, 'one session per video and quality');
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from('#EXTM3U\n')), 204);
  assert.equal(s.state, 'building', 'no segment yet');
  assert.equal(home.put(s.token, 'seg0.ts', Buffer.from('ts0')), 204);
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from(PL1)), 204);
  assert.equal(s.state, 'ready');
  const pl = await home.file(s.token, 'index.m3u8');
  assert.equal(pl.type, 'application/vnd.apple.mpegurl');
  assert.match(pl.body.toString(), /^#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n/);
  assert.match(pl.body.toString(), /#EXT-X-PLAYLIST-TYPE:EVENT\n/, 'still growing: EVENT');
  assert.match(pl.body.toString(), new RegExp(`\nhttps://yt/home/${s.token}/seg0\\.ts\n`));
  assert.equal((await home.file(s.token, 'seg0.ts')).body.toString(), 'ts0');
  assert.equal(s.ended, false);
  home.put(s.token, 'index.m3u8', Buffer.from(PL2));
  assert.equal(s.ended, false, 'ENDLIST, but seg1 is not here yet');
  home.put(s.token, 'seg1.ts', Buffer.from('ts1'));
  assert.equal(s.ended, true);
  assert.match((await home.file(s.token, 'index.m3u8')).body.toString(), /#EXT-X-PLAYLIST-TYPE:VOD\n/, 'finished: VOD, so Media Foundation seeks (#128)');
  assert.deepEqual(events, ['start', 'ready']);
});

test('home: a predicted playlist cut back after a part-way failure is failed, not done; players on it still get what is there, the next play starts over', async (t) => {
  let now = 1_000_000;
  const logs = [];
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), base: 'https://yt/home', enabled: true, segmentHoldMs: 5000, now: () => now, log: (l) => logs.push(l) });
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 16 }, '720p');
  const pl = (n, end = true) => `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n${Array.from({ length: n }, (_, i) => `#EXTINF:4.000000,\nseg${i}.ts\n`).join('')}${end ? '#EXT-X-ENDLIST\n' : ''}`;
  assert.equal(home.put(s.token, 'seg0.ts', Buffer.from('a')), 204);
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from(pl(4))), 204);
  assert.equal(home.put(s.token, 'seg1.ts', Buffer.from('b')), 204);
  assert.equal(s.state, 'ready');
  const waiting = home.file(s.token, 'seg2.ts'); // a player ahead of the upload
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from(pl(2))), 204);
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'cut_short');
  assert.equal(s.ended, false);
  assert.equal(await waiting, null, 'released at once, not after the hold');
  assert.match((await home.file(s.token, 'index.m3u8')).body.toString(), /seg1\.ts\n#EXT-X-ENDLIST/);
  assert.equal((await home.file(s.token, 'seg1.ts')).body.toString(), 'b');
  assert.ok(logs.some((l) => l.event === 'home_failed' && l.reason === 'cut_short') && !logs.some((l) => l.event === 'home_done'));
  assert.equal(home.peek({ id: 'aaaaaaaaaaa' }, '720p'), s, 'failed for a minute, like any failure');
  now += 61_000;
  assert.equal(home.peek({ id: 'aaaaaaaaaaa' }, '720p'), null, 'then the next play starts over');
  assert.notEqual(home.start({ id: 'aaaaaaaaaaa', seconds: 16 }, '720p'), s);
});

test('home: uploads are checked (names, playlist lines, unknown sessions)', async (t) => {
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true });
  const s = home.start({ id: 'aaaaaaaaaaa' }, '720p');
  assert.equal(home.put(s.token, '../x.ts', Buffer.from('x')), 400);
  assert.equal(home.put(s.token, 'seg0.mp4', Buffer.from('x')), 400);
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from('#EXTM3U\nhttps://elsewhere/x.ts\n')), 400);
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from('not a playlist')), 400);
  assert.equal(home.put('0'.repeat(18), 'seg0.ts', Buffer.from('x')), 410);
  assert.equal(await home.file(s.token, '../../etc/passwd'), null);
  assert.equal(await home.file('f'.repeat(18), 'index.m3u8'), null);
});

test('home: off, no media worker, or the daily cap reached → no new session; a failed one is retried after a minute', (t) => {
  assert.equal(new Home({ relay: fakeRelay(), dir: tmp(t), enabled: false }).start({ id: 'aaaaaaaaaaa' }, '720p'), null);
  assert.equal(new Home({ relay: fakeRelay({ online: false }), dir: tmp(t), enabled: true }).start({ id: 'aaaaaaaaaaa' }, '720p'), null);
  let now = Date.parse('2026-10-23T12:00:00Z');
  const events = [];
  const relay = fakeRelay();
  const home = new Home({ relay, dir: tmp(t), enabled: true, dailyBuilds: 1, now: () => now, onEvent: (k) => events.push(k) });
  assert.ok(home.start({ id: 'aaaaaaaaaaa' }, '720p'));
  assert.equal(home.start({ id: 'bbbbbbbbbbb' }, '720p'), null);
  assert.deepEqual(events, ['start', 'capped']);
  now += 24 * 3600_000; // the next day
  const s = home.start({ id: 'bbbbbbbbbbb' }, '720p');
  assert.ok(s);
  // A worker that fails: the session is failed, then retried after RETRY_MS.
  const relay2 = { enabled: true, capable: () => ['home'], run: () => Promise.reject(Object.assign(new Error('no'), { code: 'worker_failed' })) };
  const h2 = new Home({ relay: relay2, dir: tmp(t), enabled: true, now: () => now });
  const f = h2.start({ id: 'ccccccccccc' }, '720p');
  return new Promise((r) => setImmediate(r)).then(() => {
    assert.equal(f.state, 'failed');
    assert.equal(h2.start({ id: 'ccccccccccc' }, '720p'), f, 'kept while failed');
    now += 61_000;
    assert.notEqual(h2.start({ id: 'ccccccccccc' }, '720p'), f);
  });
});

test('home: old sessions are swept, and the oldest finished ones while over maxGb', async (t) => {
  let now = 0;
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, keepHours: 1, maxGb: 0.000002, now: () => now });
  const a = home.start({ id: 'aaaaaaaaaaa' }, '720p');
  home.put(a.token, 'seg0.ts', Buffer.alloc(1500));
  home.put(a.token, 'seg1.ts', Buffer.alloc(10));
  home.put(a.token, 'index.m3u8', Buffer.from(PL2));
  now += 1000;
  const b = home.start({ id: 'bbbbbbbbbbb' }, '720p');
  home.put(b.token, 'seg0.ts', Buffer.alloc(1500));
  home.sweep();
  assert.equal(await home.file(a.token, 'seg0.ts'), null, 'finished and over the size cap');
  assert.ok(await home.file(b.token, 'seg0.ts'), 'still uploading: kept');
  now += 2 * 3600_000;
  home.sweep();
  assert.equal(await home.file(b.token, 'seg0.ts'), null, 'older than keepHours');
});

test('home: a build counts its expected size against maxGb, so finished sessions make room before it grows', async (t) => {
  // prod 2026-10-28 21:48–21:53Z: a 4.5 h 1080p build grew ~5 GB past the 12 GB cap between two sweeps (/ at 90.6 %).
  let now = 0;
  const logs = [];
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, keepHours: 1, maxGb: 0.0000025, now: () => now, log: (l) => logs.push(l) }); // 2.5 kB
  const a = home.start({ id: 'aaaaaaaaaaa' }, '720p');
  home.put(a.token, 'seg0.ts', Buffer.alloc(1500));
  home.put(a.token, 'seg1.ts', Buffer.alloc(10));
  home.put(a.token, 'index.m3u8', Buffer.from(PL2));
  now += 1000;
  const b = home.start({ id: 'bbbbbbbbbbb' }, '720p'); // no length known: counts only its files
  assert.equal(logs.filter((l) => l.event === 'home_evict').length, 0, 'room enough: kept'); // (a file() read would count as a play)
  // The whole playlist up front (4 segments) and one 500-byte segment: ~2 kB to come, so 3.5 kB in all > 2.5 kB.
  home.put(b.token, 'index.m3u8', Buffer.from(`${PL1}#EXTINF:4.0,\nseg1.ts\n#EXTINF:4.0,\nseg2.ts\n#EXTINF:4.0,\nseg3.ts\n#EXT-X-ENDLIST\n`));
  home.put(b.token, 'seg0.ts', Buffer.alloc(500));
  assert.equal(home.state().storedMb, 0, 'files alone ~2 kB, under the cap');
  home.sweep();
  assert.equal(await home.file(a.token, 'seg0.ts'), null, 'out for the build still to come');
  assert.ok(await home.file(b.token, 'seg0.ts'), 'the build stays');
  assert.deepEqual(logs.filter((l) => l.event === 'home_evict').map((l) => l.why), ['size']);
  // Before its first segment, a build counts its length at ~0.57 MB/s: a finished session goes at its start.
  const c = home.start({ id: 'ccccccccccc' }, '720p');
  home.put(c.token, 'seg0.ts', Buffer.alloc(100));
  home.put(c.token, 'index.m3u8', Buffer.from(`${PL1}#EXT-X-ENDLIST\n`));
  now += 1000;
  home.start({ id: 'ddddddddddd', seconds: 60 }, '1080p');
  assert.equal(await home.file(c.token, 'seg0.ts'), null, "out at the long build's start");
  const over = logs.find((l) => l.event === 'home_over_cap');
  assert.ok(over && over.expectedMb >= 34 && over.storedMb === 0, 'logged as over the cap by what is to come');
});

test('home: a finished session being played survives the size cap and keepHours; evictions are logged', async (t) => {
  let now = 0;
  const logs = [];
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, keepHours: 1, maxGb: 0.000001, now: () => now, log: (l) => logs.push(l) });
  const a = home.start({ id: 'aaaaaaaaaaa' }, '720p');
  home.put(a.token, 'seg0.ts', Buffer.alloc(1500));
  home.put(a.token, 'seg1.ts', Buffer.alloc(10));
  home.put(a.token, 'index.m3u8', Buffer.from(PL2));
  now += 2 * 3600_000;
  assert.ok(await home.file(a.token, 'seg1.ts'), 'a player fetches it');
  now += 60_000;
  home.sweep();
  assert.ok(await home.file(a.token, 'seg0.ts'), 'played a minute ago: kept although old and over the cap');
  assert.ok(logs.some((l) => l.event === 'home_over_cap'));
  now += 6 * 60_000;
  home.sweep();
  assert.equal(await home.file(a.token, 'seg0.ts'), null, 'no player for 6 minutes: out');
  assert.deepEqual(logs.filter((l) => l.event === 'home_evict').map((l) => l.why), ['age']);
});

test('home: a segment asked for before it is here is held until it arrives; one past the end is not', async (t) => {
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, segmentHoldMs: 2000 });
  const s = home.start({ id: 'aaaaaaaaaaa' }, '720p');
  home.put(s.token, 'seg0.ts', Buffer.from('ts0'));
  home.put(s.token, 'index.m3u8', Buffer.from(PL2)); // the whole playlist up front
  const t0 = Date.now();
  const later = home.file(s.token, 'seg1.ts');
  setTimeout(() => home.put(s.token, 'seg1.ts', Buffer.from('ts1')), 100);
  assert.equal((await later).body.toString(), 'ts1');
  assert.ok(Date.now() - t0 < 1500, 'answered when it arrived, not at the hold limit');
  assert.equal(s.ended, true);
  assert.equal(await home.file(s.token, 'seg2.ts'), null, 'ended: no hold');
  const short = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, segmentHoldMs: 50 });
  const s2 = short.start({ id: 'bbbbbbbbbbb' }, '720p');
  assert.equal(await short.file(s2.token, 'seg9.ts'), null, 'held, then 404');
});

test('home: sessions and the day\'s use survive a restart (a deploy); an unfinished one keeps taking uploads', async (t) => {
  const dir = tmp(t);
  const now = () => Date.parse('2026-10-23T12:00:00Z');
  const first = new Home({ relay: fakeRelay(), dir, base: 'https://yt/home', enabled: true, now });
  const a = first.start({ id: 'aaaaaaaaaaa', seconds: 8 }, '720p');
  first.put(a.token, 'seg0.ts', Buffer.from('ts0'));
  first.put(a.token, 'index.m3u8', Buffer.from(PL2));
  first.start({ id: 'bbbbbbbbbbb' }, '720p'); // never ready: dropped on load
  const again = new Home({ relay: fakeRelay(), dir, base: 'https://yt/home', enabled: true, now });
  const b = again.peek({ id: 'aaaaaaaaaaa' }, '720p');
  assert.equal(b.token, a.token);
  assert.equal(b.state, 'ready');
  assert.equal(b.ended, false);
  assert.equal(again.peek({ id: 'bbbbbbbbbbb' }, '720p'), null);
  assert.deepEqual(again.state().today, { builds: 2, mb: 0, cacheHits: 0, cacheMb: 0 });
  assert.equal(again.put(a.token, 'seg1.ts', Buffer.from('ts1')), 204);
  assert.equal(b.ended, true);
  assert.match((await again.file(a.token, 'index.m3u8')).body.toString(), new RegExp(`https://yt/home/${a.token}/seg1\\.ts`));
});

test('home: a restart drops given-up and dead sessions, and keeps the uneven list and why (2026-10-25)', (t) => {
  const dir = tmp(t);
  let ms = Date.parse('2026-10-25T22:53:00Z');
  const now = () => ms;
  const first = new Home({ relay: fakeRelay(), dir, base: 'https://yt/home', enabled: true, now });
  const play = (id) => { const s = first.start({ id, seconds: 5400 }, '720p'); first.put(s.token, 'seg0.ts', Buffer.from('ts0')); first.put(s.token, 'index.m3u8', Buffer.from(PL1)); return s; };
  const given = play('aaaaaaaaaaa');
  given.why = 'long';
  first.save(given);
  first.giveUp(given, 'uneven');           // the 2026-10-25 case: 13 segments, then Tunelio
  const dead = play('bbbbbbbbbbb');        // its worker stream stopped part way
  const live = play('ccccccccccc');
  live.why = 'long';
  first.save(live);
  ms += 6 * 60_000;
  assert.equal(first.peek({ id: 'bbbbbbbbbbb' }, '720p'), null, 'a dead stream is not reused');
  first.put(live.token, 'seg1.ts', Buffer.from('ts1'));  // still uploading
  ms += 60_000;
  const logs = [];
  const again = new Home({ relay: fakeRelay(), dir, base: 'https://yt/home', enabled: true, now, log: (o) => logs.push(o) });
  assert.equal(again.peek({ id: 'aaaaaaaaaaa' }, '720p'), null, 'given up: not reloaded');
  assert.equal(again.peek({ id: 'bbbbbbbbbbb' }, '720p'), null, 'dead: not reloaded');
  assert.equal(again.peek({ id: 'ccccccccccc' }, '720p').why, 'long');
  assert.equal(again.isUneven({ id: 'aaaaaaaaaaa' }), true);
  assert.deepEqual(logs.find((l) => l.event === 'home_loaded'), { event: 'home_loaded', sessions: 1, dropped: 2, storedMb: 0, maxGb: 8 });
  assert.throws(() => readFileSync(join(dir, given.token, 'meta.json')), 'its folder is gone');
});

// A fake ffmpeg: writes segments and the playlist into its output folder like the real one, then exits with `code`.
function fakeFfmpeg({ code = 0, steps = [[PL1, ['seg0.ts']], [PL2, ['seg1.ts']]] } = {}) {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    const dir = dirname(args.at(-1));
    const p = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {};
    steps.forEach(([pl, segs], i) => setTimeout(() => {
      for (const s of segs) writeFileSync(join(dir, s), s);
      writeFileSync(join(dir, 'index.m3u8'), pl);
      if (i === steps.length - 1) setTimeout(() => { if (code) p.stderr.emit('data', 'Connection reset\n'); p.emit('close', code); }, 20);
    }, 30 + i * 80));
    return p;
  };
  return { calls, spawnFn };
}
const runner = async () => 'https://v.example/video?clen=100\nhttps://v.example/audio?clen=100\n';

test('mediaJob: answers at the first playlist, uploads the rest, closes with ENDLIST', async () => {
  const ff = fakeFfmpeg();
  const uploads = [];
  const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'x' }, { ytdlp: 'yt-dlp', runner, spawnFn: ff.spawnFn, pollMs: 10,
    upload: async (file, body) => { uploads.push([file, body.toString()]); return 204; } });
  assert.equal(first.ready, true);
  assert.equal(first.segments, 1);
  await first.done;
  assert.deepEqual(uploads.map(([f]) => f), ['seg0.ts', 'index.m3u8', 'seg1.ts', 'index.m3u8']);
  assert.match(uploads.at(-1)[1], /#EXT-X-ENDLIST/);
  const args = ff.calls[0].args;
  assert.ok(args.filter((a, i) => args[i - 1] === '-i').every((u) => u.startsWith('http://127.0.0.1:')), 'read through the range proxy');
  assert.ok(args.includes('copy') && args.includes('event'));
  assert.equal(args[args.indexOf('-bsf:v') + 1], 'h264_mp4toannexb,dump_extra=freq=keyframe', 'SPS/PPS in every segment');
});

test('mediaJob: the first playlist goes up right after seg0, not after every segment ffmpeg has made (2026-10-25)', async () => {
  const pl = (n) => `#EXTM3U
${Array.from({ length: n }, (_, i) => `#EXTINF:4,
seg${i}.ts
`).join('')}`;
  const ff = fakeFfmpeg({ steps: [[pl(3), ['seg0.ts', 'seg1.ts', 'seg2.ts']], [`${pl(4)}#EXT-X-ENDLIST
`, ['seg3.ts']]] });
  const uploads = [];
  const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'x', vod: false }, { ytdlp: 'yt-dlp', runner, spawnFn: ff.spawnFn, pollMs: 10,
    upload: async (file) => { uploads.push(file); return 204; } });
  assert.deepEqual(uploads, ['seg0.ts', 'index.m3u8'], 'ready with seg0 and the playlist');
  await first.done;
  assert.deepEqual(uploads.filter((f) => f !== 'index.m3u8'), ['seg0.ts', 'seg1.ts', 'seg2.ts', 'seg3.ts'], 'the rest follow in order');
});

test('mediaJob: ffmpeg dying part way closes the playlist where it got to; a 410 stops it', async () => {
  const uploads = [];
  const ff = fakeFfmpeg({ code: 1, steps: [[PL1, ['seg0.ts']]] });
  const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'x' }, { ytdlp: 'yt-dlp', runner, spawnFn: ff.spawnFn, pollMs: 10,
    upload: async (file, body) => { uploads.push([file, body.toString()]); return 204; } });
  await first.done;
  assert.match(uploads.at(-1)[1], /seg0\.ts\n#EXT-X-ENDLIST\n$/);
  const gone = fakeFfmpeg();
  await assert.rejects(mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'x' }, { ytdlp: 'yt-dlp', runner, spawnFn: gone.spawnFn, pollMs: 10,
    upload: async () => 410 }), /session gone/);
  await assert.rejects(mediaJob({ videoId: 'bad', quality: '720p' }, { ytdlp: 'yt-dlp', runner, upload: async () => 204 }), /bad videoId/);
});

test('rangeProxy: serves every request (seeks too) from &range= pieces upstream', async () => {
  const data = Buffer.from(Array.from({ length: 25 }, (_, i) => String.fromCharCode(97 + i)).join(''));
  const asked = [];
  // Like googlevideo: a small Range header answers 206 with the total; &range=a-b answers 200 with those bytes.
  const fetcher = async (url, { headers } = {}) => {
    const param = /[?&]range=(\d+)-(\d+)$/.exec(url);
    const [a, b] = (param ?? /bytes=(\d+)-(\d+)/.exec(headers.range)).slice(1).map(Number);
    asked.push(param ? `&range=${a}-${b}` : headers.range);
    const body = data.subarray(a, b + 1);
    return new Response(body, param ? { status: 200 } : { status: 206, headers: { 'content-range': `bytes ${a}-${a + body.length - 1}/${data.length}` } });
  };
  const proxy = await rangeProxy(['https://v.example/x?id=1'], { fetcher, chunk: 10 });
  try {
    assert.equal(await (await fetch(proxy.urls[0])).text(), data.toString());
    assert.deepEqual(asked, ['bytes=0-0', '&range=0-9', '&range=10-19', '&range=20-24'], 'size first (no clen), then pieces');
    const seek = await fetch(proxy.urls[0], { headers: { range: 'bytes=12-' } });
    assert.equal(seek.status, 206);
    assert.equal(seek.headers.get('content-range'), 'bytes 12-24/25');
    assert.equal(await seek.text(), 'mnopqrstuvwxy');
    assert.equal((await fetch(proxy.urls[0], { headers: { range: 'bytes=30-' } })).status, 416);
    assert.equal((await fetch(proxy.urls[0].replace(/\/0$/, '/5'))).status, 404);
  } finally { proxy.close(); }
});

test('rangeProxy: a request that throws or a body that breaks off is asked for again from the byte it got to (world #266)', async () => {
  const data = Buffer.from('abcdefghijklmnopqrstuvwxy');
  const asked = [];
  let broke = false;
  const fetcher = async (url) => {
    const [a, b] = /[?&]range=(\d+)-(\d+)$/.exec(url).slice(1).map(Number);
    asked.push(`${a}-${b}`);
    if (a === 10 && asked.filter((x) => x.startsWith('10-')).length === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    if (a === 20 && !broke) {
      broke = true; // two bytes, then the connection drops
      let n = 0;
      return new Response(new ReadableStream({ pull(c) { if (n++ === 0) c.enqueue(data.subarray(20, 22)); else c.error(new TypeError('terminated')); } }), { status: 200 });
    }
    return new Response(data.subarray(a, b + 1), { status: 200 });
  };
  const logs = [];
  const proxy = await rangeProxy(['https://v.example/x?clen=25'], { fetcher, chunk: 10, retryMs: 1, log: (o) => logs.push(o) });
  try {
    assert.equal(await (await fetch(proxy.urls[0])).text(), data.toString(), 'ffmpeg gets every byte');
    assert.deepEqual(asked, ['0-9', '10-19', '10-19', '20-24', '22-24'], 'resumed at byte 22, not from the piece start');
    assert.deepEqual(logs.map((l) => [l.event, l.why]), [['media_source_retry', 'ECONNRESET'], ['media_source_retry', 'terminated']]);
    assert.equal(proxy.failure, null);
  } finally { proxy.close(); }
});

test('rangeProxy: upstream that keeps failing is given up after retryForMs, logged, and named in failure', async () => {
  const fetcher = async (url) => {
    if (/range=0-/.test(url)) return new Response('abcde', { status: 200 });
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
  };
  const logs = [];
  const proxy = await rangeProxy(['https://v.example/x?clen=10'], { fetcher, chunk: 5, retryMs: 5, retryForMs: 30, log: (o) => logs.push(o) });
  try {
    await assert.rejects((await fetch(proxy.urls[0])).text(), 'the connection closes short, as before');
    assert.equal(proxy.failure, 'UND_ERR_SOCKET');
    assert.ok(logs.some((l) => l.event === 'media_source_failed' && l.why === 'UND_ERR_SOCKET'));
  } finally { proxy.close(); }
});

test('mediaJob: ffmpeg ending cleanly short of the video is a failure, not done, and the copy is not cached (world #266)', async (t) => {
  const { MediaCache } = await import('../relay/cache.js');
  const pl = (n) => `#EXTM3U\n${Array.from({ length: n }, (_, i) => `#EXTINF:4.000000,\nseg${i}.ts\n`).join('')}`;
  const segs = (from, to) => Array.from({ length: to - from }, (_, i) => `seg${from + i}.ts`);
  const run = async (steps, extra = {}) => {
    const cache = new MediaCache({ dir: tmp(t), maxGb: 1 });
    const logs = [];
    const uploads = [];
    const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '1080p', token: 'x', seconds: 3300 }, { ytdlp: 'yt-dlp', runner, spawnFn: fakeFfmpeg({ steps }).spawnFn,
      pollMs: 10, cache, log: (o) => logs.push(o), upload: async (file, body) => { uploads.push([file, body.toString()]); return 204; }, ...extra });
    await first.done;
    await new Promise((r) => setTimeout(r, 30)); // the finally block
    return { cache, logs, playlists: uploads.filter(([f]) => f === 'index.m3u8').map(([, b]) => b) };
  };
  // The staging case: time cuts, 825 predicted, ffmpeg exit 0 after 21.
  const cut = await run([[pl(8), segs(0, 8)], [`${pl(21)}#EXT-X-ENDLIST\n`, segs(8, 21)]], { splitByTime: true });
  const failed = cut.logs.find((l) => l.event === 'media_failed');
  assert.deepEqual([failed?.reason, failed?.segments, failed?.expected, failed?.seconds], ['short', 21, 825, 84]);
  assert.ok(!cut.logs.some((l) => l.event === 'media_done' || l.event === 'media_cached'), 'not done, not cached');
  assert.match(cut.playlists.at(-1), /seg20\.ts\n#EXT-X-ENDLIST\n$/, 'players get the playlist closed where it got to');
  assert.equal(cut.cache.get('aaaaaaaaaaa', '1080p'), null);
  // A growing (keyframe-cut) copy that ends 3216 s early is short too.
  const grew = await run([[`${pl(21)}#EXT-X-ENDLIST\n`, segs(0, 21)]]);
  assert.equal(grew.logs.find((l) => l.event === 'media_failed')?.reason, 'short');
  assert.equal(grew.cache.get('aaaaaaaaaaa', '1080p'), null);
});

test('media cache: a copy short of the video is never kept or served (world #266)', async (t) => {
  const { MediaCache } = await import('../relay/cache.js');
  const logs = [];
  const cache = new MediaCache({ dir: tmp(t), maxGb: 1, log: (o) => logs.push(o) });
  const put = (n, opts) => {
    const s = cache.staging();
    for (let i = 0; i < n; i++) writeFileSync(join(s, `seg${i}.ts`), 'x');
    return cache.put('aaaaaaaaaaa', '1080p', s, `#EXTM3U\n${Array.from({ length: n }, (_, i) => `#EXTINF:4.0,\nseg${i}.ts\n`).join('')}#EXT-X-ENDLIST\n`, opts);
  };
  assert.equal(put(21, { seconds: 3300 }), false, '84 of 3300 s: not kept');
  assert.equal(put(21), true, 'no length given: kept, as before (this is how the staging copy got in)');
  assert.ok(cache.get('aaaaaaaaaaa', '1080p'), 'served when the job gives no length');
  assert.equal(cache.get('aaaaaaaaaaa', '1080p', { seconds: 3300 }), null, 'the job says 3300 s: dropped');
  assert.ok(logs.some((l) => l.event === 'media_cache_short' && l.seconds === 84 && l.duration === 3300));
  assert.equal(cache.get('aaaaaaaaaaa', '1080p'), null, 'and gone from disk');
  assert.equal(put(823, { seconds: 3298 }), true, 'within SHORT_S of the length: kept');
  assert.ok(cache.get('aaaaaaaaaaa', '1080p', { seconds: 3298 }));
});

test('predictPlaylist: the rest of the video at the usual length, the remainder last (the 6 h mix of 2026-10-23)', () => {
  const p = predictPlaylist([5.071733], 5.071733, 22257.851848);
  assert.equal(p.count, 4389);
  assert.match(p.text, /#EXT-X-PLAYLIST-TYPE:VOD\n/);
  assert.match(p.text, /#EXTINF:3\.08\d+,\nseg4388\.ts\n#EXT-X-ENDLIST\n$/);
  assert.match(p.text, /#EXT-X-TARGETDURATION:6\n/);
  const short = predictPlaylist([2.5], 5, 12.5);
  assert.deepEqual([...short.text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1])), [2.5, 5, 5]);
});

test('mediaJob: steady segments → the whole playlist goes up first (the real one only if they differ); uneven ones → growing', async () => {
  const pl = (ds) => `#EXTM3U\n${ds.map((d, i) => `#EXTINF:${d},\nseg${i}.ts\n`).join('')}`;
  const segs = (from, to) => Array.from({ length: to - from }, (_, i) => `seg${from + i}.ts`);
  const even = Array(9).fill(4);
  const steps = [[pl(even.slice(0, 8)), segs(0, 8)], [`${pl(even)}#EXT-X-ENDLIST\n`, segs(8, 9)]];
  const run = async (seconds, stepsUsed) => {
    const uploads = [];
    const ff = fakeFfmpeg({ steps: stepsUsed });
    const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'x', seconds }, { ytdlp: 'yt-dlp', runner, spawnFn: ff.spawnFn, pollMs: 10,
      upload: async (file, body) => { uploads.push([file, body.toString()]); return 204; } });
    await first.done;
    return uploads.filter(([f]) => f === 'index.m3u8').map(([, b]) => b);
  };
  const right = await run(36, steps);
  assert.equal(right.length, 1, 'predicted once, and it held');
  assert.match(right[0], /VOD[\s\S]*seg8\.ts\n#EXT-X-ENDLIST\n$/);
  const wrong = await run(40, steps); // predicts 10 segments, ffmpeg makes 9
  assert.equal(wrong.length, 2);
  assert.match(wrong[0], /seg9\.ts/);
  assert.doesNotMatch(wrong[1], /seg9\.ts/);
  const uneven = [7, 6.72, 3, 6.96, 7, 1.04, 7, 6.4, 3];
  const growing = await run(47, [[pl(uneven.slice(0, 8)), segs(0, 8)], [`${pl(uneven)}#EXT-X-ENDLIST\n`, segs(8, 9)]]);
  assert.ok(growing.every((p) => !/VOD/.test(p)), 'uneven: the growing playlist');
  assert.match(growing.at(-1), /seg8\.ts\n#EXT-X-ENDLIST\n$/);
});

test('steadyLength: equal within a frame (29.97 fps cuts print as 4.004 / 3.971 s), from the median; scene cuts are not', () => {
  const ntsc = [4.004, 4.004, 3.970633, 4.004, 4.004, 4.004, 4.004, 4.004, 3.970633];
  assert.equal(steadyLength(ntsc), 4.004);
  assert.equal(steadyLength([3.970633, ...ntsc.slice(1)]), 4.004, 'not the first one');
  assert.equal(steadyLength(Array(8).fill(5.071733)), 5.071733);
  assert.equal(steadyLength(ntsc.slice(0, 7)), null, 'too few yet');
  assert.equal(steadyLength([4, 4, 4, 4, 4.1, 4, 4, 4]), null, 'more than a frame off');
  assert.equal(steadyLength([7, 6.72, 3, 6.96, 7, 1.04, 7, 6.4]), null);
});

test('onTime: time cuts within 0.5 s of each 4 s mark (B-frame documentaries of 2026-10-27, up to 0.153 s late); scene cuts are not', () => {
  const doc = [4.004, 4.070733, 4.004, 3.970633, 3.970633, 4.037367, 4.037367, 3.937267];
  assert.equal(steadyLength(doc), null, 'a frame of tolerance on the lengths missed it');
  assert.equal(onTime(doc), true);
  const late = [4.070733, 3.937267, 4.004, 4.004, 4.137467, 3.8712, 4.037367, 4.004]; // a cut 0.153 s late
  assert.equal(onTime(late), true);
  assert.equal(onTime([4.004, 4.004, 3.970633, 4.004, 4.004, 4.004, 4.004, 4.004]), true);
  assert.equal(onTime(doc.slice(0, 7)), false, 'too few yet');
  assert.equal(onTime([4, 4, 4.6, 4, 4, 4, 4, 4]), false, 'a cut 0.6 s off');
  assert.equal(onTime([5, 6.28, 4.32, 1.32, 3.08, 5, 6.2, 4.08]), false, 'scene cuts (the Quest test video, keyframe-cut)');
  assert.equal(onTime([7, 6.72, 3, 6.96, 7, 1.04, 7, 6.4]), false);
});

test('mediaJob splitByTime: ffmpeg cuts on time, and the whole playlist is predicted at 4 s, not the 4.004 s median', async () => {
  const pl = (ds) => `#EXTM3U\n${ds.map((d, i) => `#EXTINF:${d},\nseg${i}.ts\n`).join('')}`;
  const segs = (from, to) => Array.from({ length: to - from }, (_, i) => `seg${from + i}.ts`);
  // 1000 segments of a 29.97 fps video, 4000 s: 4.004 s with a 3.971 s one every 8 (ffmpeg 8, 2026-10-27).
  const ds = Array.from({ length: 1000 }, (_, i) => (i % 8 === 7 ? 3.970633 : 4.004));
  ds[999] = 4000 - ds.slice(0, 999).reduce((a, b) => a + b, 0);
  const steps = [[pl(ds.slice(0, 8)), segs(0, 8)], [`${pl(ds)}#EXT-X-ENDLIST\n`, segs(8, 1000)]];
  const run = async (splitByTime) => {
    const uploads = [];
    const ff = fakeFfmpeg({ steps });
    const logs = [];
    const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'x', seconds: 4000 }, { ytdlp: 'yt-dlp', runner, spawnFn: ff.spawnFn,
      pollMs: 10, splitByTime, log: (o) => logs.push(o.event), upload: async (file, body) => { uploads.push([file, body.toString()]); return 204; } });
    await first.done;
    return { args: ff.calls[0].args, playlists: uploads.filter(([f]) => f === 'index.m3u8').map(([, b]) => b), logs };
  };
  const on = await run(true);
  assert.equal(on.args[on.args.indexOf('-hls_flags') + 1], 'temp_file+split_by_time');
  assert.equal(on.playlists.length, 1, 'predicted once, and it held');
  assert.match(on.playlists[0], /^#EXTM3U[\s\S]*VOD\n#EXTINF:4\.000000,\nseg0\.ts[\s\S]*seg999\.ts\n#EXT-X-ENDLIST\n$/);
  assert.ok(on.logs.includes('media_predicted') && !on.logs.includes('media_mismatch'));
  assert.ok(on.logs.includes('media_steady'));
  const off = await run(false); // the same cuts without the flag: predicted from the median at 999 segments, so the real 1000 go up at the end
  assert.equal(off.args[off.args.indexOf('-hls_flags') + 1], 'temp_file');
  assert.match(off.playlists[0], /VOD\n#EXTINF:4\.004000,/);
  assert.equal(off.playlists.length, 2);
  assert.ok(off.logs.includes('media_mismatch'));
  assert.match(off.playlists[1], /seg999\.ts\n#EXT-X-ENDLIST\n$/);
});

test('closedAt: the playlist cut back to the uploaded segments, with ENDLIST', () => {
  const text = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.000000,\nseg0.ts\n#EXTINF:4.000000,\nseg1.ts\n#EXTINF:4.000000,\nseg2.ts\n#EXT-X-ENDLIST\n';
  assert.equal(closedAt(text, new Set(['seg0.ts', 'seg1.ts'])),
    '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.000000,\nseg0.ts\n#EXTINF:4.000000,\nseg1.ts\n#EXT-X-ENDLIST\n');
  assert.equal(closedAt(text, new Set(['seg0.ts', 'seg2.ts'])).match(/seg\d/g).join(), 'seg0', 'stops at the first missing one');
});

test('mediaJob: a segment the server refuses after players were sent → the playlist closes at the last uploaded one (the 1080p lofi, 2026-10-27)', async () => {
  const pl = (n) => `#EXTM3U\n${Array.from({ length: n }, (_, i) => `#EXTINF:4,\nseg${i}.ts\n`).join('')}`;
  const segs = (from, to) => Array.from({ length: to - from }, (_, i) => `seg${from + i}.ts`);
  const ff = fakeFfmpeg({ steps: [[pl(8), segs(0, 8)], [pl(12), segs(8, 12)], [`${pl(14)}#EXT-X-ENDLIST\n`, segs(12, 14)]] });
  const uploads = [];
  const logs = [];
  const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'x', seconds: 56 }, { ytdlp: 'yt-dlp', runner, spawnFn: ff.spawnFn,
    pollMs: 10, splitByTime: true, log: (o) => logs.push(o),
    upload: async (file, body) => { uploads.push([file, body.toString()]); return file === 'seg10.ts' ? 413 : 204; } });
  await first.done;
  const playlists = uploads.filter(([f]) => f === 'index.m3u8').map(([, b]) => b);
  assert.match(playlists[0], /VOD[\s\S]*seg13\.ts\n#EXT-X-ENDLIST\n$/, 'predicted first');
  assert.match(playlists.at(-1), /seg9\.ts\n#EXT-X-ENDLIST\n$/);
  assert.doesNotMatch(playlists.at(-1), /seg10\.ts/);
  assert.match(logs.find((o) => o.event === 'media_failed').message, /seg10\.ts \([\d.]+ MB\) answered 413/);
  assert.deepEqual(logs.find((o) => o.event === 'media_closed'), { event: 'media_closed', segments: 10, status: 204 });
});

test('mediaJob: an upload that fails (server restarting) is tried again', async () => {
  let fails = 2;
  const uploads = [];
  const ff = fakeFfmpeg();
  const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'x' }, { ytdlp: 'yt-dlp', runner, spawnFn: ff.spawnFn, pollMs: 10, retryMs: 5,
    upload: async (file) => { if (fails-- > 0) throw new Error('ECONNREFUSED'); uploads.push(file); return 204; } });
  await first.done;
  assert.deepEqual(uploads, ['seg0.ts', 'index.m3u8', 'seg1.ts', 'index.m3u8']);
});

test('media formats: H.264 + m4a at the quality\'s height; one input when YouTube serves a single file', () => {
  assert.match(formatFor('1080p'), /^bv\*\[height<=1080\]\[vcodec\^=avc1\]\+ba\[ext=m4a\]/);
  const one = ffmpegArgs(['https://v'], '/tmp/x');
  assert.equal(one.filter((a) => a === '-i').length, 1);
  assert.ok(!one.includes('-map'));
  assert.equal(one[one.indexOf('-hls_flags') + 1], 'temp_file', 'keyframe cuts by default');
  assert.ok(one.includes('h264_mp4toannexb,dump_extra=freq=keyframe'));
  const split = ffmpegArgs(['https://v'], '/tmp/x', { splitByTime: true });
  assert.equal(split[split.indexOf('-hls_flags') + 1], 'temp_file+split_by_time');
  assert.deepEqual(split.slice(split.indexOf('-c'), split.indexOf('-c') + 4), ['-c', 'copy', '-bsf:v', 'h264_mp4toannexb,dump_extra=freq=keyframe']);
});

test('ticket → home: a PC player gets the home playlist when Tunelio is off; the resolver is sent on, Android goes to YouTube', async (t) => {
  const dir = tmp(t);
  const config = { ...base, shards: 2, pool: 50, relayToken: TOKEN, homeRelay: true, homeReadyMs: 5000, dbPath: join(dir, 'tickets.db'), publicUrl: 'http://pub', metricsPath: '' };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const relay = new Relay({ token: TOKEN, pollMs: 200 });
  const app = createApp({ config, store, relay, tunelio: { enabled: false }, captions: { async get() { return {}; } }, log: () => {} });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  // A worker whose media job uploads one segment and a playlist, as relay/media.js would.
  const jobs = [];
  const worker = createWorker({ url, token: TOKEN, name: 'home', polls: 1, caps: ['media'], log: () => {},
    media: async (job) => {
      jobs.push(job);
      const put = (file, body) => fetch(`${url}/relay/media/${job.token}/${file}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body });
      assert.equal((await put('seg0.ts', 'ts0')).status, 204);
      assert.equal((await put('index.m3u8', PL1)).status, 204);
      return { ready: true, segments: 1, done: Promise.resolve() };
    } });
  worker.start();
  t.after(() => worker.stop());
  while (!relay.capable('media').length) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(relay.mediaMax(), { home: 4 }, 'the worker announces how many streams it takes (RELAY_MEDIA_MAX)');

  const [n] = store.allocate(0, [{ kind: 'video', data: { id: 'aaaaaaaaaaa', title: 'T', seconds: 600, live: false } }]);
  const play = (ua) => fetch(`${url}/v1/0/${n}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  const resolver = await play('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/149.0 Safari/537.36');
  assert.equal(resolver.status, 200);
  assert.match(resolver.headers.get('content-type'), /text\/html/);
  const player = await play('NSPlayer/12.00.26100 WMFSDK/12.00');
  assert.equal(player.status, 302);
  const loc = player.headers.get('location');
  assert.match(loc, /^http:\/\/pub\/home\/[a-f0-9]{18}\/index\.m3u8$/);
  assert.equal(jobs.length, 1, 'one stream for the resolver and the player');
  const path = loc.replace('http://pub', '');
  const pl = await fetch(url + path, { headers: { 'user-agent': 'NSPlayer/12.00' } });
  assert.match(await pl.text(), /EXT-X-START:TIME-OFFSET=0[\s\S]*http:\/\/pub\/home\/[a-f0-9]{18}\/seg0\.ts/);
  assert.equal(await (await fetch(url + path.replace('index.m3u8', 'seg0.ts'))).text(), 'ts0');
  assert.match((await fetch(url + path, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/149.0 Safari/537.36' } })).headers.get('content-type'), /text\/html/);
  const tablet = await (await fetch(`${url}/v1/0/${n}`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0)' } })).json();
  assert.equal(tablet.plan, 'home');
  assert.equal(tablet.state, 'ready');
  const android = await play('AVProMobileVideo/2026.3.3p2 (Linux;Android 14) ExoPlayer');
  assert.equal(android.status, 302);
  assert.match(android.headers.get('location'), /youtube\.com\/watch\?v=aaaaaaaaaaa/);
  // Uploads need the relay token.
  assert.equal((await fetch(`${url}/relay/media/${path.split('/')[2]}/seg1.ts`, { method: 'PUT', body: 'x' })).status, 401);
});

// The home app of the test above, with a home worker connected; over: config and createApp overrides.
async function homeApp(t, { config: c = {}, media = null, playlist = PL1, ...over } = {}) {
  const dir = tmp(t);
  const config = { ...base, shards: 2, pool: 50, relayToken: TOKEN, homeRelay: true, homeReadyMs: 5000, dbPath: join(dir, 'tickets.db'), publicUrl: 'http://pub', metricsPath: '', ...c };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const relay = new Relay({ token: TOKEN, pollMs: 200 });
  const app = createApp({ config, store, relay, tunelio: { enabled: false }, captions: { async get() { return {}; } }, log: () => {}, ...over });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const jobs = [];
  const worker = createWorker({ url, token: TOKEN, name: 'home', polls: 1, caps: ['media'], log: () => {}, txBytes: () => null,
    media: async (job) => {
      jobs.push(job);
      if (media) await media(job);
      const put = (file, body) => fetch(`${url}/relay/media/${job.token}/${file}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body });
      await put('seg0.ts', 'ts0');
      await put('index.m3u8', playlist);
      return { ready: true, segments: 1, done: Promise.resolve() };
    } });
  worker.start();
  t.after(() => worker.stop());
  while (!relay.capable('media').length) await new Promise((r) => setTimeout(r, 20));
  const [n] = store.allocate(0, [{ kind: 'video', data: { id: 'aaaaaaaaaaa', title: 'T', seconds: 600, live: false } }]);
  const play = (ua, ext = '.m3u8') => fetch(`${url}/v1/0/${n}${ext}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  return { play, jobs, store, url, n, app };
}
const QUEST = 'AVProMobileVideo/2026.3.3p2 (Linux;Android 14) ExoPlayer';

test('ticket → home: home builds 1080p when the room has not picked, and the room\'s own pick otherwise (owner, 2026-10-25)', async (t) => {
  const app = await homeApp(t);
  const PC = 'NSPlayer/12.00.26100 WMFSDK/12.00';
  assert.equal((await app.play(PC, '')).status, 302);
  const tablet = await (await fetch(`${app.url}/v1/0/${app.n}`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0)' } })).json();
  assert.equal(tablet.quality, '1080p');
  assert.equal(tablet.room, '720p', 'the room itself still reads as its default');
  app.store.setQuality(0, '720p');
  await app.play(PC, '');
  assert.deepEqual(app.jobs.map((j) => j.quality), ['1080p', '720p']);
});

test('ticket → home: a video whose 1080p files would be over HOME_ITEM_MAX_GB is built at 720p (world #240)', async (t) => {
  const PC = 'NSPlayer/12.00.26100 WMFSDK/12.00';
  const tablet = async (app) => (await fetch(`${app.url}/v1/0/${app.n}`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0)' } })).json();
  // The test video is 600 s: ~342 MB at 1080p, over 0.3 GB.
  const app = await homeApp(t, { config: { homeItemMaxGb: 0.3 } });
  assert.equal((await app.play(PC, '')).status, 302);
  assert.equal((await tablet(app)).quality, '720p');
  app.store.setQuality(0, '1080p');
  assert.equal((await tablet(app)).quality, '720p', "the room's 1080p pick is the ceiling, not a promise");
  app.store.setQuality(0, '720p');
  await app.play(PC, '');
  assert.deepEqual(app.jobs.map((j) => j.quality), ['720p'], 'one 720p session for all three');
  // Off (0), or within the limit: 1080p as before.
  assert.equal(base.homeItemMaxGb, base.homeMaxGb, 'by default only an item bigger than the whole cache (#242)');
  for (const homeItemMaxGb of [0, 0.4]) {
    const other = await homeApp(t, { config: { homeItemMaxGb } });
    await other.play(PC, '');
    assert.deepEqual(other.jobs.map((j) => j.quality), ['1080p'], `homeItemMaxGb ${homeItemMaxGb}`);
  }
});

test('ticket → home on Quest: a .m3u8 ticket goes home only with HOME_ANDROID=on; a plain ticket never', async (t) => {
  const off = await homeApp(t);
  assert.doesNotMatch((await off.play(QUEST)).headers.get('location'), /\/home\//, 'HOME_ANDROID off: as before');
  assert.equal(off.jobs.length, 0);
  const on = await homeApp(t, { config: { homeAndroid: true } });
  assert.doesNotMatch((await on.play(QUEST, '')).headers.get('location'), /\/home\//, 'a plain ticket on Android: never home (f331bcc)');
  assert.match((await on.play(QUEST)).headers.get('location'), /^http:\/\/pub\/home\/[a-f0-9]{18}\/index\.m3u8$/);
  assert.equal(on.jobs.length, 1);
});

test('ticket → home on Quest: an AV1 Tunelio build on a .m3u8 ticket goes home (H.264); H.264 builds stay on Tunelio', async (t) => {
  const { Adaptive } = await import('../src/adaptive.js');
  const make = (box) => {
    const job = { id: 'aaaaaaaaaaa', quality: '720p', state: 'ready', url: 'https://tunelio.dev/t?id=x&hls=1' };
    const playback = { jobs: new Map(), peek: () => job, status: () => ({ state: 'ready' }), start() {},
      async location() { return { location: job.url, via: 'tunelio', ready: true }; } };
    const fetcher = async (u) => (u.includes('init')
      ? { status: 206, arrayBuffer: async () => new TextEncoder().encode(`....ftyp....moov....stsd....${box}....`).buffer }
      : { status: 200, text: async () => '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg1.m4s\n' });
    return { playback, adaptive: new Adaptive({ playback, fetcher, base: 'http://pub/hls' }), tunelio: { enabled: true } };
  };
  const av1 = await homeApp(t, { config: { homeAndroid: true }, ...make('av01') });
  assert.match((await av1.play(QUEST)).headers.get('location'), /\/home\/[a-f0-9]{18}\/index\.m3u8$/);
  const h264 = await homeApp(t, { config: { homeAndroid: true }, ...make('avc1') });
  assert.match((await h264.play(QUEST)).headers.get('location'), /^http:\/\/pub\/hls\/[a-f0-9]{18}\/720p\.m3u8$/);
  assert.equal(h264.jobs.length, 0);
  const flagOff = await homeApp(t, make('av01'));
  assert.match((await flagOff.play(QUEST)).headers.get('location'), /\/hls\//, 'AV1 counted but not sent home while HOME_ANDROID is off');
});

test('media cache: a finished stream is kept and the next job for it uploads from disk, marked cached, without yt-dlp', async (t) => {
  const { MediaCache } = await import('../relay/cache.js');
  const dir = tmp(t);
  const cache = new MediaCache({ dir, maxGb: 1 });
  const ff = fakeFfmpeg();
  const first = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'x' }, { ytdlp: 'yt-dlp', runner, spawnFn: ff.spawnFn, pollMs: 10, cache,
    upload: async () => 204 });
  assert.equal(first.cached, undefined);
  await first.done;
  await new Promise((r) => setTimeout(r, 20)); // the finally block's put
  assert.ok(cache.get('aaaaaaaaaaa', '720p'), 'kept');

  const uploads = [];
  let resolved = 0;
  const again = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'y' }, { ytdlp: 'yt-dlp', runner: async () => { resolved++; return ''; }, cache,
    spawnFn: () => { throw new Error('no ffmpeg for a cached stream'); },
    upload: async (file, body, type, opts) => { uploads.push([file, opts?.cached]); return 204; } });
  assert.equal(again.cached, true);
  await again.done;
  assert.equal(resolved, 0, 'no yt-dlp');
  assert.deepEqual(uploads, [['seg0.ts', true], ['index.m3u8', true], ['seg1.ts', true]]);

  // A stream that did not finish (ffmpeg died) is not kept.
  const bad = await mediaJob({ videoId: 'bbbbbbbbbbb', quality: '720p', token: 'z' }, { ytdlp: 'yt-dlp', runner, spawnFn: fakeFfmpeg({ code: 1, steps: [[PL1, ['seg0.ts']]] }).spawnFn,
    pollMs: 10, cache, upload: async () => 204 });
  await bad.done;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cache.get('bbbbbbbbbbb', '720p'), null);
});

test('media cache: least recently used out above maxGb', async (t) => {
  const { MediaCache } = await import('../relay/cache.js');
  const dir = tmp(t);
  let now = 1000;
  const cache = new MediaCache({ dir, maxGb: 0.000002, now: () => now }); // 2 kB
  const put = (id) => {
    const s = cache.staging();
    writeFileSync(join(s, 'seg0.ts'), Buffer.alloc(900));
    now += 1000;
    return cache.put(id, '720p', s, '#EXTM3U\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n');
  };
  assert.equal(put('aaaaaaaaaaa'), true);
  assert.equal(put('bbbbbbbbbbb'), true);
  now += 1000;
  assert.ok(cache.get('aaaaaaaaaaa', '720p'), 'a used again: b is now the oldest');
  put('ccccccccccc');
  assert.ok(cache.get('aaaaaaaaaaa', '720p'));
  assert.equal(cache.get('bbbbbbbbbbb', '720p'), null, 'evicted');
  assert.ok(cache.get('ccccccccccc', '720p'));
  const s = cache.staging();
  assert.equal(cache.put('ddddddddddd', '720p', s, '#EXTM3U\n#EXTINF:4,\nseg0.ts\n'), false, 'no ENDLIST, no segment: not kept');
  // An entry made in an older stream format is dropped (made again from YouTube).
  const meta = join(dir, 'aaaaaaaaaaa@720p', 'meta.json');
  writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, 'utf8')), format: 1 }));
  assert.equal(cache.get('aaaaaaaaaaa', '720p'), null);
});

test('home: uploads from the worker cache count as a cache hit, not against the daily cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-cache-'));
  try {
    const events = [];
    const home = new Home({ relay: fakeRelay(), dir, base: 'https://yt/home', enabled: true, dailyMb: 1, onEvent: (k) => events.push(k) });
    const s = home.start({ id: 'aaaaaaaaaaa', seconds: 8 }, '720p');
    assert.equal(home.put(s.token, 'seg0.ts', Buffer.alloc(2e6), { cached: true }), 204);
    assert.equal(home.put(s.token, 'index.m3u8', Buffer.from(PL2), { cached: true }), 204);
    assert.deepEqual(home.state().today, { builds: 0, mb: 0, cacheHits: 1, cacheMb: 2 });
    assert.equal(home.capped(), false, '2 MB from the cache, cap 1 MB: not capped');
    assert.ok(events.includes('cache_hit'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('home settle: a player waits for a growing playlist that is about to end, not for one that is far off (#111)', async (t) => {
  const dir = tmp(t);
  let now = 1_000_000;
  const home = new Home({ relay: fakeRelay(), dir, base: 'https://yt/home', enabled: true, now: () => now });
  const grow = (n) => `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n${Array.from({ length: n }, (_, i) => `#EXTINF:4.0,\nseg${i}.ts\n`).join('')}`;
  // 40 s of a 60 s video uploaded in 4 s: the remaining 20 s are due in ~2 s.
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 60 }, '720p');
  for (let i = 0; i < 10; i++) home.put(s.token, `seg${i}.ts`, Buffer.from('ts'));
  now += 4000;
  home.put(s.token, 'index.m3u8', Buffer.from(grow(10)));
  assert.equal(s.state, 'ready');
  assert.ok(home.eta(s) > 1000 && home.eta(s) < 3000, `eta ${home.eta(s)}`);
  const settled = home.settle(s, 10_000);
  for (let i = 10; i < 15; i++) home.put(s.token, `seg${i}.ts`, Buffer.from('ts'));
  home.put(s.token, 'index.m3u8', Buffer.from(`${grow(15)}#EXT-X-ENDLIST\n`));
  assert.equal(await settled, true, 'the player gets the finished playlist');

  // A 2 h video at the same rate: due in ~12 min, so no wait.
  const far = home.start({ id: 'bbbbbbbbbbb', seconds: 7200 }, '720p');
  for (let i = 0; i < 10; i++) home.put(far.token, `seg${i}.ts`, Buffer.from('ts'));
  now += 4000;
  home.put(far.token, 'index.m3u8', Buffer.from(grow(10)));
  const t0 = Date.now();
  assert.equal(await home.settle(far, 10_000), false);
  assert.ok(Date.now() - t0 < 100, 'returned at once');
  assert.equal(await home.settle(far, 0), false, 'off');
});

test('ticket → home: right after a Tunelio timeout a PC play goes home (tunelio_slow) without another /create', async (t) => {
  let creates = 0;
  const tunelio = { enabled: true, timedOutAt: Date.now(), credits: 1, async create() { creates++; throw new Error('should not be asked'); } };
  const app = await homeApp(t, { tunelio });
  const r = await app.play('NSPlayer/12.00.26100 WMFSDK/12.00', '');
  assert.match(r.headers.get('location'), /\/home\/[a-f0-9]{18}\/index\.m3u8$/);
  assert.equal(creates, 0);
});

test('ticket → home: the room switching quality mid-play keeps the home session when the new one can\'t be built (#127)', async (t) => {
  const app = await homeApp(t, { media: async (job) => { if (job.quality === '1080p') throw new Error('busy'); } });
  const PC = 'NSPlayer/12.00.26100 WMFSDK/12.00';
  app.store.setQuality(0, '720p');
  const first = (await app.play(PC, '')).headers.get('location');
  assert.match(first, /\/home\/[a-f0-9]{18}\/index\.m3u8$/);
  app.store.setQuality(0, '1080p');
  const again = await app.play(PC, '');
  assert.equal(again.headers.get('location'), first, 'the 720p home stream, not a Tunelio hold or youtube.com');
  const tablet = await (await fetch(`${app.url}/v1/0/${app.n}`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0)' } })).json();
  assert.equal(tablet.plan, 'home');
  assert.equal(tablet.quality, '720p');
  assert.equal(tablet.room, '1080p');
  assert.deepEqual(app.jobs.map((j) => j.quality), ['720p', '1080p']);
});

test('home route: each request logs its segment, the token cut to 4 characters (#128)', async (t) => {
  const lines = [];
  const app = await homeApp(t, { log: (l) => lines.push(l) });
  const loc = (await app.play('NSPlayer/12.00.26100 WMFSDK/12.00', '')).headers.get('location');
  const path = loc.replace('http://pub', '');
  await fetch(app.url + path.replace('index.m3u8', 'seg0.ts'), { headers: { range: 'bytes=0-' } });
  const gets = lines.map((l) => JSON.parse(l)).filter((e) => e.event === 'home_get');
  assert.deepEqual(gets.map((e) => [e.file, e.seg, e.found, e.range]), [['seg0.ts', '0', true, true]]);
  const token = path.split('/')[2];
  assert.equal(gets[0].ses, token.slice(0, 4));
  assert.ok(!lines.some((l) => l.includes(token)), 'the full token is never logged');
});

test('ticket → home: a long play whose home playlist grows (uneven keyframes) goes to Tunelio; even ones and over-budget plays stay home (#127 a)', async (t) => {
  const { Adaptive } = await import('../src/adaptive.js');
  const make = (pacerOk = true) => {
    const job = { id: 'aaaaaaaaaaa', quality: '1080p', state: 'ready', url: 'https://tunelio.dev/t?id=x' };
    const playback = { jobs: new Map(), peek: () => job, status: () => ({ state: 'ready' }), start() {},
      async location() { return { location: job.url, via: 'tunelio', ready: true }; } };
    const adaptive = new Adaptive({ playback, base: 'http://pub/hls' });
    adaptive.pacer = { check: () => ({ ok: pacerOk }) };
    return { playback, adaptive, tunelio: { enabled: true }, config: { homeLongMinutes: 5 } };
  };
  const PC = 'NSPlayer/12.00.26100 WMFSDK/12.00';
  const uneven = await homeApp(t, make());
  assert.doesNotMatch((await uneven.play(PC, '')).headers.get('location'), /\/home\//);
  assert.doesNotMatch((await uneven.play(PC, '')).headers.get('location'), /\/home\//);
  assert.equal(uneven.jobs.length, 1, 'remembered: the second play goes straight to Tunelio');
  const tablet = await (await fetch(`${uneven.url}/v1/0/${uneven.n}`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0)' } })).json();
  assert.notEqual(tablet.plan, 'home');
  const WHOLE = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n';
  const even = await homeApp(t, { ...make(), playlist: WHOLE });
  assert.match((await even.play(PC, '')).headers.get('location'), /\/home\/[a-f0-9]{18}\/index\.m3u8$/);
  const broke = await homeApp(t, make(false));
  assert.match((await broke.play(PC, '')).headers.get('location'), /\/home\/[a-f0-9]{18}\/index\.m3u8$/, 'over budget: home even when it grows');
});

test('ticket → home: with HOME_ANDROID_GROWING a .m3u8 ticket (Quest) keeps the growing home playlist, started at exactly 0; a PC still leaves (world #250)', async (t) => {
  const { Adaptive } = await import('../src/adaptive.js');
  const job = { id: 'aaaaaaaaaaa', quality: '1080p', state: 'ready', url: 'https://tunelio.dev/t?id=x' };
  const playback = { jobs: new Map(), peek: () => job, status: () => ({ state: 'ready' }), start() {},
    async location() { return { location: job.url, via: 'tunelio', ready: true }; } };
  const adaptive = new Adaptive({ playback, base: 'http://pub/hls' });
  adaptive.pacer = { check: () => ({ ok: true }) };
  const QUEST = 'AVProMobileVideo/2026.3.3 (Linux;Android 14) ExoPlayer';
  const app = await homeApp(t, { playback, adaptive, tunelio: { enabled: true }, config: { homeLongMinutes: 5, homeAndroid: true, homeAndroidGrowing: true } });
  const tablet = await (await fetch(`${app.url}/v1/0/${app.n}.m3u8`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0)' } })).json();
  assert.equal(tablet.plan, 'home', 'the Quest tablet keeps the home session');
  const loc = (await app.play(QUEST)).headers.get('location');
  assert.match(loc, /\/home\/[a-f0-9]{18}\/index\.m3u8$/);
  const pl = await (await fetch(app.url + loc.replace('http://pub', ''))).text();
  assert.match(pl, /^#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n/, 'growing: start at 0 exactly, not the live edge');
  assert.doesNotMatch((await app.play('NSPlayer/12.00.26100 WMFSDK/12.00', '')).headers.get('location'), /\/home\//, 'PC: Tunelio as before');
  // Off (the default): the Quest leaves too, and the playlist keeps the plain start.
  const off = await homeApp(t, { playback, adaptive, tunelio: { enabled: true }, config: { homeLongMinutes: 5, homeAndroid: true } });
  assert.doesNotMatch((await off.play(QUEST)).headers.get('location') ?? '', /\/home\//);
});

test('ticket → home: with HOME_ANDROID_GROWING a PC leaving for Tunelio keeps the session a Quest is on growing (world #250, prod 2026-10-27)', async (t) => {
  const { Adaptive } = await import('../src/adaptive.js');
  const job = { id: 'aaaaaaaaaaa', quality: '1080p', state: 'ready', url: 'https://tunelio.dev/t?id=x' };
  const playback = { jobs: new Map(), peek: () => job, status: () => ({ state: 'ready' }), start() {},
    async location() { return { location: job.url, via: 'tunelio', ready: true }; } };
  const adaptive = new Adaptive({ playback, base: 'http://pub/hls' });
  adaptive.pacer = { check: () => ({ ok: true }) };
  const lines = [];
  const app = await homeApp(t, { playback, adaptive, tunelio: { enabled: true }, log: (l) => lines.push(typeof l === 'string' ? JSON.parse(l) : l),
    config: { homeLongMinutes: 5, homeAndroid: true, homeAndroidGrowing: true } });
  const PC = 'NSPlayer/12.00.26100 WMFSDK/12.00';
  const loc = (await app.play(QUEST)).headers.get('location');
  assert.match(loc, /\/home\/[a-f0-9]{18}\/index\.m3u8$/);
  assert.equal((await app.play(PC, '')).headers.get('location'), job.url, 'the PC gets Tunelio');
  assert.ok(lines.some((e) => e.event === 'home_uneven' && e.kept), 'the video is remembered as uneven');
  assert.ok(!lines.some((e) => e.event === 'home_failed'), 'the session is not given up');
  // The worker's next segment is still taken (it got 410 before), and the Quest's playlist and segments still answer.
  const put = await fetch(`${app.url}/relay/media/${app.jobs[0].token}/seg1.ts`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body: 'ts1' });
  assert.ok(put.ok, `segment upload answered ${put.status}`);
  const path = loc.replace('http://pub', '');
  assert.equal((await fetch(app.url + path)).status, 200);
  assert.equal((await fetch(app.url + path.replace('index.m3u8', 'seg1.ts'))).status, 200);
  const tablet = await (await fetch(`${app.url}/v1/0/${app.n}.m3u8`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0)' } })).json();
  assert.equal(tablet.state, 'ready');
  assert.equal(tablet.plan, 'home', 'a Quest joining later still gets the session');
  // Later PC plays keep going to Tunelio, and nothing is built twice.
  assert.equal((await app.play(PC, '')).headers.get('location'), job.url);
  assert.equal(app.jobs.length, 1);
  assert.equal(lines.filter((e) => e.event === 'home_uneven').length, 1, 'marked once');
});

// #293 (prod 2026-10-28 04:48–04:49Z): with HOME_ANDROID_GROWING a Quest starts a home session that grows, the PC in
// the same room is sent to Tunelio (leaveHome marks the video uneven), and once the playlist ends leaveHome returns
// false and homeWhy's 'reuse' sends that same PC ticket home again: a new URL, which its players load from 0.
// TICKET_PIN keeps a ticket's answer while it is played. pinApp: that room, a Tunelio link and the ticket's helpers.
const ENDED = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n';
async function pinApp(t, config = {}, { playlist } = {}) {
  const { Adaptive } = await import('../src/adaptive.js');
  const job = { id: 'aaaaaaaaaaa', quality: '1080p', state: 'ready', url: 'https://tunelio.dev/t?id=x' };
  const playback = { jobs: new Map(), peek: () => job, status: () => ({ state: 'ready' }), start() {},
    async location() { return { location: job.url, via: 'tunelio', ready: true }; } };
  const adaptive = new Adaptive({ playback, base: 'http://pub/hls' });
  adaptive.pacer = { check: () => ({ ok: true }) };
  const lines = [];
  const app = await homeApp(t, { playback, adaptive, tunelio: { enabled: true }, log: (l) => lines.push(typeof l === 'string' ? JSON.parse(l) : l),
    ...(playlist ? { playlist } : {}),
    config: { homeLongMinutes: 5, homeAndroid: true, homeAndroidGrowing: true, homeSettleMs: 0, ticketPin: true, ticketPinMarginMs: 60_000, ...config } });
  const pc = async () => { const loc = (await app.play('NSPlayer/12.00.26100 WMFSDK/12.00', '')).headers.get('location'); return /\/home\//.test(loc) ? 'home' : loc === job.url ? 'tunelio' : loc; };
  const plan = async () => (await (await fetch(`${app.url}/v1/0/${app.n}`, { headers: { 'user-agent': 'UnityPlayer/2022.3 (UnityWebRequest/1.0)' } })).json()).plan;
  const finish = async () => {
    const put = (file, body) => fetch(`${app.url}/relay/media/${app.jobs[0].token}/${file}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body });
    await put('seg1.ts', 'ts1');
    await put('index.m3u8', ENDED);
  };
  return { ...app, job, playback, lines, pc, plan, finish };
}

test('TICKET_PIN (#293): a PC ticket sent to Tunelio while home grew keeps Tunelio after the playlist ends, and so does its tablet; off, it flips home as before', async (t) => {
  const app = await pinApp(t);
  assert.match((await app.play(QUEST)).headers.get('location'), /\/home\//, 'the Quest starts the growing session');
  assert.equal(await app.pc(), 'tunelio');
  const growingPlan = await app.plan();
  assert.notEqual(growingPlan, 'home');
  assert.ok(app.lines.some((e) => e.event === 'home_uneven' && e.kept));
  await app.finish();
  assert.equal(await app.pc(), 'tunelio', 'the same answer once the home playlist ends');
  assert.equal(await app.plan(), growingPlan, "the tablet's plan stays put");
  assert.match((await app.play(QUEST)).headers.get('location'), /\/home\//, 'the Quest keeps its own (home) answer');
  assert.ok(app.lines.some((e) => e.event === 'play' && e.pinned && e.via === 'tunelio'));
  assert.equal(app.jobs.length, 1);
  // Off (prod today): the flip this fixes.
  const off = await pinApp(t, { ticketPin: false });
  await off.play(QUEST);
  assert.equal(await off.pc(), 'tunelio');
  await off.finish();
  assert.equal(await off.pc(), 'home');
  assert.equal(await off.plan(), 'home');
});

test('TICKET_PIN (#293): a play after the window (the video\'s length plus the margin since the last play) gets the finished home copy', async (t) => {
  const app = await pinApp(t);
  await app.play(QUEST);
  assert.equal(await app.pc(), 'tunelio');
  await app.finish();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(500_000); // within 600 s + 60 s of the last play
  assert.equal(await app.pc(), 'tunelio', 'still being played: kept, and the window starts again');
  t.mock.timers.tick(600_000 + 59_000);
  assert.equal(await app.pc(), 'tunelio', 'within the renewed window');
  t.mock.timers.tick(660_001);
  assert.equal(await app.pc(), 'home', 'after the window: the best source now, the finished home playlist');
  assert.ok(app.lines.some((e) => e.event === 'ticket_unpin' && e.reason === 'window'));
  assert.equal(await app.pc(), 'home', 'and that is kept in turn');
});

test('TICKET_PIN (#293): a dead pinned source is chosen again: a Tunelio link re-made, a home session given up', async (t) => {
  // Tunelio: the link expired and was re-made (another URL): the pin goes, and this play decides again (home, ended).
  const app = await pinApp(t);
  await app.play(QUEST);
  assert.equal(await app.pc(), 'tunelio');
  await app.finish();
  app.job.url = 'https://tunelio.dev/t?id=y';
  assert.equal(await app.pc(), 'home');
  assert.ok(app.lines.some((e) => e.event === 'ticket_unpin' && e.reason === 'dead' && e.via === 'tunelio'));
  // Home: an even-keyframe video (whole playlist at once) keeps the PC home; the session is then given up.
  const even = await pinApp(t, {}, { playlist: ENDED.replace('EVENT', 'VOD') });
  assert.equal(await even.pc(), 'home');
  even.app.home.giveUp(even.app.home.peek({ id: 'aaaaaaaaaaa' }, '1080p'), 'uneven');
  assert.equal(await even.pc(), 'tunelio', 'its session failed: decided again, Tunelio');
  assert.ok(even.lines.some((e) => e.event === 'ticket_unpin' && e.reason === 'dead' && e.via === 'home'));
});

test('TICKET_PIN (#293): a youtube.com fallback is not kept: the next play gets the ready build, which is then kept', async (t) => {
  const job = { id: 'aaaaaaaaaaa', quality: '720p', state: 'building', url: null };
  let calls = 0;
  const playback = { jobs: new Map(), peek: () => job, status: () => ({ state: job.state }), start() {},
    async location() {
      calls++;
      if (job.state !== 'ready') return { ready: false };
      return { location: job.url, via: 'tunelio', ready: true };
    } };
  const lines = [];
  const app = await homeApp(t, { playback, tunelio: { enabled: true }, log: (l) => lines.push(typeof l === 'string' ? JSON.parse(l) : l),
    config: { ticketPin: true, ticketPinMarginMs: 60_000 } });
  const PC = 'NSPlayer/12.00.26100 WMFSDK/12.00';
  assert.match((await app.play(PC, '')).headers.get('location'), /youtube\.com\/watch/, 'the build timed out: youtube.com');
  Object.assign(job, { state: 'ready', url: 'https://tunelio.dev/t?id=x' });
  assert.equal((await app.play(PC, '')).headers.get('location'), job.url, 'upgraded to the ready build');
  assert.equal((await app.play(PC, '')).headers.get('location'), 'https://tunelio.dev/t?id=x');
  assert.equal(calls, 2, 'the third play was answered from the pin');
  assert.ok(lines.some((e) => e.event === 'play' && e.pinned));
});

test('home: today\'s MB are saved while segments arrive (at most every 30 s) and on flush, so a restart mid-build keeps them', (t) => {
  const dir = tmp(t);
  let now = Date.parse('2026-10-27T20:00:00Z');
  const home = new Home({ relay: fakeRelay(), dir, base: 'https://yt/home', enabled: true, now: () => now });
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 3600 }, '1080p');
  home.put(s.token, 'seg0.ts', Buffer.alloc(1_000_000));
  home.put(s.token, 'index.m3u8', Buffer.from(PL1)); // a predicted playlist goes up once, here
  const reload = () => new Home({ relay: fakeRelay(), dir, base: 'https://yt/home', enabled: true, now: () => now }).state().today;
  now += 10_000;
  home.put(s.token, 'seg1.ts', Buffer.alloc(2_000_000));
  assert.equal(reload().mb, 1, 'within 30 s of the last save: not written yet');
  now += 30_000;
  home.put(s.token, 'seg2.ts', Buffer.alloc(3_000_000));
  assert.deepEqual([reload().mb, reload().builds], [6, 1], 'saved as it grew, before any further playlist');
  now += 1_000;
  home.put(s.token, 'seg3.ts', Buffer.alloc(4_000_000));
  home.flush(); // SIGTERM
  assert.equal(reload().mb, 10, 'the rest on shutdown');
});

test('home: the daily caps count the reporting time zone\'s day (Chicago), not the UTC date', (t) => {
  const dir = tmp(t);
  let now = Date.parse('2026-10-27T23:30:00Z'); // 18:30 CDT
  const home = new Home({ relay: fakeRelay(), dir, base: 'https://yt/home', enabled: true, now: () => now });
  home.start({ id: 'aaaaaaaaaaa', seconds: 600 }, '720p');
  now = Date.parse('2026-10-28T00:25:00Z'); // 19:25 CDT, the same Chicago day (the UTC date rolled over)
  assert.equal(home.state().today.builds, 1, 'still today');
  now = Date.parse('2026-10-28T05:00:01Z'); // 00:00:01 CDT on the 28th
  assert.equal(home.state().today.builds, 0, 'a new day at Chicago midnight');
  const utc = new Home({ relay: fakeRelay(), dir: tmp(t), base: 'https://yt/home', enabled: true, tz: 'UTC', now: () => now });
  assert.equal(utc.state().today.builds, 0, 'tz is configurable (METRICS_TZ)');
});

test('home: PRECISE=YES only while the playlist grows, and only with startPrecise', async (t) => {
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), base: 'https://yt/home', enabled: true, startPrecise: true });
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 600 }, '720p');
  home.put(s.token, 'seg0.ts', Buffer.from('ts0'));
  home.put(s.token, 'index.m3u8', Buffer.from(PL1));
  assert.match((await home.file(s.token, 'index.m3u8')).body.toString(), /^#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n/);
  home.put(s.token, 'index.m3u8', Buffer.from(PL2));
  home.put(s.token, 'seg1.ts', Buffer.from('ts1'));
  assert.equal(s.ended, true);
  assert.match((await home.file(s.token, 'index.m3u8')).body.toString(), /^#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n/, 'finished: VOD, plain start');
});

test('relay polls: the worker\'s bytes-sent counter is counted as home transfer (src/net.js)', async (t) => {
  const counts = [];
  const metrics = { inc: (m, k, n = 1) => { if (m === 'transfer') counts.push([k, n]); }, gauge() {}, latency() {}, shard() {}, flush() { return 0; }, start() { return this; }, close() {} };
  const app = await homeApp(t, { metrics });
  const poll = (tx) => fetch(`${app.url}/relay/next?worker=w2&tx=${tx}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(300) }).catch(() => {});
  await poll(1_000_000_000);
  await poll(1_300_000_000);
  await poll('bogus');
  const home = counts.filter(([k]) => k === 'home').map(([, n]) => n);
  assert.deepEqual(home, [0, 300]);
});

// Segments on demand (Everything-is-OK#367): prod 2026-10-30, a seek an hour into a 4.1 h cached copy waited on an
// in-order upload (~6.9 MB/s) and froze.
test('home want: a segment a player waits for past the next in line is wanted until it arrives; the next ones are not', async (t) => {
  const logs = [];
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, segmentHoldMs: 200, log: (o) => logs.push(o) });
  const s = home.start({ id: 'aaaaaaaaaaa' }, '720p');
  home.put(s.token, 'seg0.ts', Buffer.from('ts0'));
  home.put(s.token, 'index.m3u8', Buffer.from(PL2));
  assert.equal(home.want(s.token), null);
  await home.file(s.token, 'seg2.ts'); // next in line but one: coming anyway
  assert.equal(home.want(s.token), null);
  const far = home.file(s.token, 'seg550.ts');
  assert.equal(home.want(s.token), 550);
  assert.deepEqual(logs.filter((l) => l.event === 'home_want'), [{ event: 'home_want', ses: s.token.slice(0, 4), quality: '720p', seg: 550, top: 0 }]);
  home.file(s.token, 'seg550.ts'); // a second request for it logs nothing new
  assert.equal(logs.filter((l) => l.event === 'home_want').length, 1);
  home.put(s.token, 'seg550.ts', Buffer.from('ts550'));
  assert.equal((await far).body.toString(), 'ts550');
  assert.equal(home.want(s.token), null, 'here: no longer wanted');
  // A gap behind the last upload (the worker jumped past it) is wanted too.
  const gap = home.file(s.token, 'seg300.ts');
  assert.equal(home.want(s.token), 300);
  await gap;
  assert.equal(home.want('f'.repeat(18)), null, 'unknown session');
});

test('media cache upload: jumps to the wanted segment, carries on from it, then sends the skipped ones; each once', async (t) => {
  const { MediaCache } = await import('../relay/cache.js');
  const cache = new MediaCache({ dir: tmp(t), maxGb: 1 });
  const staging = cache.staging();
  const lines = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let i = 0; i < 10; i++) { writeFileSync(join(staging, `seg${i}.ts`), `ts${i}`); lines.push('#EXTINF:4.0,', `seg${i}.ts`); }
  assert.ok(cache.put('aaaaaaaaaaa', '720p', staging, `${lines.join('\n')}\n#EXT-X-ENDLIST\n`));
  const order = [];
  let want = null;
  const logs = [];
  const job = await mediaJob({ videoId: 'aaaaaaaaaaa', quality: '720p', token: 'y' }, { ytdlp: 'yt-dlp', cache, wanted: () => want, log: (o) => logs.push(o),
    upload: async (file) => {
      if (file !== 'index.m3u8') order.push(Number(file.slice(3, -3)));
      if (file === 'seg2.ts') want = 7;   // a player seeked to seg7 while seg2 went up
      if (file === 'seg7.ts') want = null; // the server stops naming it once it is there
      return 204;
    } });
  await job.done;
  assert.deepEqual(order, [0, 1, 2, 7, 8, 9, 3, 4, 5, 6]);
  assert.deepEqual(logs.find((l) => l.event === 'media_jump'), { event: 'media_jump', cached: true, from: 3, to: 7 });
  assert.equal(logs.find((l) => l.event === 'media_done').jumps, 1);
});

test('home want end to end: a far seek on a cached copy is answered in about one upload, not after the ones before it', async (t) => {
  const { MediaCache } = await import('../relay/cache.js');
  const dir = tmp(t);
  const cache = new MediaCache({ dir: join(dir, 'cache'), maxGb: 1 });
  const SEGS = 300;
  for (const q of ['720p', '1080p']) {
    const staging = cache.staging();
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:VOD'];
    for (let i = 0; i < SEGS; i++) { writeFileSync(join(staging, `seg${i}.ts`), `ts${i}`); lines.push('#EXTINF:4.000000,', `seg${i}.ts`); }
    cache.put('aaaaaaaaaaa', q, staging, `${lines.join('\n')}\n#EXT-X-ENDLIST\n`);
  }
  const config = { ...base, shards: 2, pool: 50, relayToken: TOKEN, homeRelay: true, homeReadyMs: 5000, dbPath: join(dir, 'tickets.db'), publicUrl: 'http://pub', metricsPath: '' };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const relay = new Relay({ token: TOKEN, pollMs: 200 });
  const lines = [];
  const app = createApp({ config, store, relay, tunelio: { enabled: false }, captions: { async get() { return {}; } }, log: (l) => lines.push(l) });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  // Each segment upload takes 20 ms, so the in-order upload would reach seg250 after ~5 s.
  const slow = async (u, o) => { if (o?.method === 'PUT' && /seg\d+\.ts$/.test(u)) await new Promise((r) => setTimeout(r, 20)); return fetch(u, o); };
  const wlogs = [];
  const worker = createWorker({ url, token: TOKEN, name: 'home', polls: 1, caps: ['media'], ytdlp: 'yt-dlp', cache, fetcher: slow, txBytes: () => null, log: (o) => wlogs.push(o) });
  worker.start();
  t.after(() => worker.stop());
  while (!relay.capable('media').length) await new Promise((r) => setTimeout(r, 20));
  const [n] = store.allocate(0, [{ kind: 'video', data: { id: 'aaaaaaaaaaa', title: 'T', seconds: SEGS * 4, live: false } }]);
  const loc = (await fetch(`${url}/v1/0/${n}`, { redirect: 'manual', headers: { 'user-agent': 'NSPlayer/12.00.26100 WMFSDK/12.00' } })).headers.get('location');
  const path = loc.replace('http://pub', '');
  const t0 = Date.now();
  const seg = await fetch(url + path.replace('index.m3u8', 'seg250.ts'));
  const ms = Date.now() - t0;
  assert.equal(await seg.text(), 'ts250');
  assert.ok(ms < 2000, `seg250 in ${ms} ms`);
  assert.ok(wlogs.some((l) => l.event === 'media_jump' && l.to === 250));
  assert.ok(lines.some((l) => l.includes('"event":"home_want"') && l.includes('"seg":250')));
  // The rest still all arrives: the session ends with every segment.
  const t1 = Date.now();
  while (!lines.some((l) => l.includes('"event":"home_done"')) && Date.now() - t1 < 15_000) await new Promise((r) => setTimeout(r, 50));
  assert.ok(lines.some((l) => l.includes('"event":"home_done"') && l.includes(`"segments":${SEGS}`)));
});

// The disk floor (HOME_FREE_FLOOR_GB): prod 2026-10-30 00:58Z, an 8.4 GB played session and a 10.7 GB build over a
// 12 GB cap filled the Linode's disk.
test('home disk floor: a build that would leave less than the floor free does not start; finished sessions go first', (t) => {
  const logs = [], events = [];
  let ms = 1_000_000;
  const DISK = 20_000; // MB; free = DISK − what the sessions hold
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, maxGb: 100, freeFloorGb: 3, now: () => ms, log: (o) => logs.push(o), onEvent: (k) => events.push(k),
    freeMb: () => DISK - [...home.byToken.values()].reduce((n, s) => n + s.mb, 0) });
  // A finished 8 GB session nobody plays, then a 2 h build (2 h × 0.57 MB/s ≈ 4.1 GB to grow).
  const old = home.start({ id: 'aaaaaaaaaaa', seconds: 600 }, '1080p');
  home.put(old.token, 'seg0.ts', Buffer.alloc(10));
  home.put(old.token, 'index.m3u8', Buffer.from(`#EXTM3U\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n`));
  old.mb = 8000;
  ms += 600_000;
  assert.ok(home.start({ id: 'bbbbbbbbbbb', seconds: 7200 }, '1080p'), '12 GB free − 4.1 GB growth ≥ 3 GB: starts');
  // A 5.2 h build (≈ 10.7 GB) on top: the finished 8 GB session is evicted for it, and then it fits.
  assert.ok(home.start({ id: 'ccccccccccc', seconds: 18736 }, '1080p'));
  assert.ok(logs.some((l) => l.event === 'home_evict' && l.why === 'disk'));
  assert.equal(home.peek({ id: 'aaaaaaaaaaa' }, '1080p'), null);
  // Another long one: nothing left to evict, 20 − 4.1 − 10.7 − 10.7 < 3 → not started, counted and logged.
  assert.equal(home.start({ id: 'ddddddddddd', seconds: 18736 }, '1080p'), null);
  assert.equal(events.at(-1), 'no_room');
  const no = logs.find((l) => l.event === 'home_no_room');
  assert.equal(no.floorGb, 3);
  assert.ok(no.freeMb > 0 && no.growthMb > 20_000);
  assert.equal(home.peek({ id: 'ddddddddddd' }, '1080p'), null, 'no session left behind');
  // Off (0): never refused.
  const off = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, freeFloorGb: 0, freeMb: () => 0 });
  assert.ok(off.start({ id: 'eeeeeeeeeee', seconds: 18736 }, '1080p'));
});

test('home disk floor: a build is stopped (410, failed no_room) when free space drops under half the floor', (t) => {
  let free = 10_000, ms = 1_000_000;
  const events = [];
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, freeFloorGb: 3, freeMb: () => free, now: () => ms, onEvent: (k) => events.push(k) });
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 600 }, '1080p');
  assert.equal(home.put(s.token, 'seg0.ts', Buffer.from('ts0')), 204);
  free = 1200; // under 1.5 GB, but checked at most every 5 s
  assert.equal(home.put(s.token, 'seg1.ts', Buffer.from('ts1')), 204);
  ms += 5_000;
  assert.equal(home.put(s.token, 'seg2.ts', Buffer.from('ts2')), 410);
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'no_room');
  assert.ok(events.includes('no_room'));
  assert.equal(home.put(s.token, 'seg3.ts', Buffer.from('ts3')), 410, 'the worker stops');
});
