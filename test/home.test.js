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
import { mediaJob, ffmpegArgs, formatFor, rangeProxy, predictPlaylist } from '../relay/media.js';
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
  return { play, jobs, store, url, n };
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
