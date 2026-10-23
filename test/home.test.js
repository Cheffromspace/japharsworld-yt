import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { Relay } from '../src/relay.js';
import { Home } from '../src/home.js';
import { createWorker } from '../relay/worker.js';
import { mediaJob, ffmpegArgs, formatFor } from '../relay/media.js';
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

test('home: a session is ready at its first playlist with a segment; the playlist served has absolute links and starts at 0', (t) => {
  const relay = fakeRelay();
  const events = [];
  const home = new Home({ relay, dir: tmp(t), base: 'https://yt/home', enabled: true, onEvent: (k) => events.push(k) });
  const s = home.start({ id: 'aaaaaaaaaaa', seconds: 600 }, '720p');
  assert.equal(s.state, 'building');
  assert.deepEqual(relay.jobs[0], { kind: 'media', videoId: 'aaaaaaaaaaa', quality: '720p', token: s.token });
  assert.equal(home.start({ id: 'aaaaaaaaaaa' }, '720p'), s, 'one session per video and quality');
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from('#EXTM3U\n')), 204);
  assert.equal(s.state, 'building', 'no segment yet');
  assert.equal(home.put(s.token, 'seg0.ts', Buffer.from('ts0')), 204);
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from(PL1)), 204);
  assert.equal(s.state, 'ready');
  const pl = home.file(s.token, 'index.m3u8');
  assert.equal(pl.type, 'application/vnd.apple.mpegurl');
  assert.match(pl.body.toString(), /^#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n/);
  assert.match(pl.body.toString(), new RegExp(`\nhttps://yt/home/${s.token}/seg0\\.ts\n`));
  assert.equal(home.file(s.token, 'seg0.ts').body.toString(), 'ts0');
  assert.equal(s.ended, false);
  home.put(s.token, 'seg1.ts', Buffer.from('ts1'));
  home.put(s.token, 'index.m3u8', Buffer.from(PL2));
  assert.equal(s.ended, true);
  assert.deepEqual(events, ['start', 'ready']);
});

test('home: uploads are checked (names, playlist lines, unknown sessions)', (t) => {
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true });
  const s = home.start({ id: 'aaaaaaaaaaa' }, '720p');
  assert.equal(home.put(s.token, '../x.ts', Buffer.from('x')), 400);
  assert.equal(home.put(s.token, 'seg0.mp4', Buffer.from('x')), 400);
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from('#EXTM3U\nhttps://elsewhere/x.ts\n')), 400);
  assert.equal(home.put(s.token, 'index.m3u8', Buffer.from('not a playlist')), 400);
  assert.equal(home.put('0'.repeat(18), 'seg0.ts', Buffer.from('x')), 410);
  assert.equal(home.file(s.token, '../../etc/passwd'), null);
  assert.equal(home.file('f'.repeat(18), 'index.m3u8'), null);
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

test('home: old sessions are swept, and the oldest finished ones while over maxGb', (t) => {
  let now = 0;
  const home = new Home({ relay: fakeRelay(), dir: tmp(t), enabled: true, keepHours: 1, maxGb: 0.000002, now: () => now });
  const a = home.start({ id: 'aaaaaaaaaaa' }, '720p');
  home.put(a.token, 'seg0.ts', Buffer.alloc(1500));
  home.put(a.token, 'index.m3u8', Buffer.from(PL2));
  now += 1000;
  const b = home.start({ id: 'bbbbbbbbbbb' }, '720p');
  home.put(b.token, 'seg0.ts', Buffer.alloc(1500));
  home.sweep();
  assert.equal(home.file(a.token, 'seg0.ts'), null, 'finished and over the size cap');
  assert.ok(home.file(b.token, 'seg0.ts'), 'still uploading: kept');
  now += 2 * 3600_000;
  home.sweep();
  assert.equal(home.file(b.token, 'seg0.ts'), null, 'older than keepHours');
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
const runner = async () => 'https://v.example/video\nhttps://v.example/audio\n';

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
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-i'), ['https://v.example/video', 'https://v.example/audio']);
  assert.equal(args.filter((a) => a === '-request_size').length, 2, 'ranged reads on both inputs');
  assert.ok(args.includes('copy') && args.includes('event'));
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
