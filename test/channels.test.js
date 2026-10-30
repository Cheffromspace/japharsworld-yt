import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChannelSlots } from '../src/channels.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';

// A monitor.db with the slots table's columns the lookup reads (monitor/slotmon).
function monitorDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'monitor.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE slots (key TEXT PRIMARY KEY, idx INTEGER, kind TEXT, current_video TEXT, baked_video TEXT, auto_hidden INTEGER DEFAULT 0)');
  const put = db.prepare('INSERT INTO slots (key, idx, kind, current_video, baked_video, auto_hidden) VALUES (?, ?, ?, ?, ?, ?)');
  put.run('lofi-sleep-chill', 1, 'live', 'JD-kMIpDfnY', 'JD-kMIpDfnY', 0);
  put.run('jack-oblivion', 2, 'live', 'iVTPoB2GelQ', '2f5CjnKt6oI', 1); // swapped, and hidden while down
  put.run('pink-noise-black', 3, 'video', '2wgg7KtzTrU', '2wgg7KtzTrU', 0);
  put.run('spare-01', 4, 'live', null, null, 0);
  put.run('playlist-test', 5, 'removed', null, null, 0);
  db.close();
  return { path, db: () => new DatabaseSync(path) };
}

test('channel slots: the current video for live and video slots; spares and removed ones unavailable; cached', (t) => {
  const m = monitorDb(t);
  let now = 0;
  const ch = new ChannelSlots({ monitorDb: m.path, now: () => now });
  assert.deepEqual(ch.lookup('lofi-sleep-chill'), { id: 'JD-kMIpDfnY' });
  assert.deepEqual(ch.lookup('jack-oblivion'), { id: 'iVTPoB2GelQ' }, 'the monitor\'s swap, not the baked video');
  assert.deepEqual(ch.lookup('pink-noise-black'), { id: '2wgg7KtzTrU' });
  assert.deepEqual(ch.lookup('spare-01'), { error: 'channel_unavailable' });
  assert.deepEqual(ch.lookup('playlist-test'), { error: 'channel_unavailable' });
  assert.deepEqual(ch.lookup('nope'), { error: 'unknown_channel' });
  assert.deepEqual(ch.lookup('../etc'), { error: 'unknown_channel' });
  // A swap shows up once the cache entry is older than cacheMs.
  const db = m.db(); db.prepare("UPDATE slots SET current_video = 'AAAAAAAAAAA' WHERE key = 'lofi-sleep-chill'").run(); db.close();
  assert.deepEqual(ch.lookup('lofi-sleep-chill'), { id: 'JD-kMIpDfnY' });
  now += 31_000;
  assert.deepEqual(ch.lookup('lofi-sleep-chill'), { id: 'AAAAAAAAAAA' });
  assert.deepEqual(new ChannelSlots({ monitorDb: '/nope/monitor.db' }).lookup('lofi-sleep-chill'), { error: 'monitor_unreadable' });
});

test('channel slots with no monitor database (staging, world #376): the baked link; hidden, linkless and unknown slots as before', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jyt-baked-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const baked = join(dir, 'channels.json');
  writeFileSync(baked, JSON.stringify({ slots: [
    { key: 'shown', url: 'https://www.youtube.com/watch?v=JD-kMIpDfnY' },
    { key: 'hidden', url: 'https://www.youtube.com/watch?v=iVTPoB2GelQ', hidden: true },
    { key: 'list-only', url: 'https://www.youtube.com/playlist?list=PLabc' },
  ] }));
  const ch = new ChannelSlots({ monitorDb: '/nope/monitor.db', baked });
  assert.deepEqual(ch.lookup('shown'), { id: 'JD-kMIpDfnY' });
  assert.deepEqual(ch.lookup('hidden'), { error: 'channel_unavailable' });
  assert.deepEqual(ch.lookup('list-only'), { error: 'channel_unavailable' });
  assert.deepEqual(ch.lookup('nope'), { error: 'unknown_channel' });
  assert.deepEqual(new ChannelSlots({ monitorDb: '/nope/monitor.db', baked: join(dir, 'gone.json') }).lookup('shown'), { error: 'monitor_unreadable' });
  // With a database, the monitor decides.
  const m = monitorDb(t);
  assert.deepEqual(new ChannelSlots({ monitorDb: m.path, baked }).lookup('nope'), { error: 'unknown_channel' });
  assert.deepEqual(new ChannelSlots({ monitorDb: m.path, baked }).lookup('shown'), { error: 'unknown_channel' });
});

test('GET /v1/ch/<key>: 302 to the watch link, no-store; 404 unknown, 503 unavailable', async (t) => {
  const m = monitorDb(t);
  const config = { ...base, shards: 2, pool: 50, monitorDb: m.path, metricsPath: '' };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const server = http.createServer(createApp({ config, store, captions: { async get() { return {}; } }, log: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', headers: { 'user-agent': 'AVProMobileVideo/2026.3.3p2 (Linux;Android 14) ExoPlayer' } });
  const ok = await get('/v1/ch/lofi-sleep-chill');
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), 'https://www.youtube.com/watch?v=JD-kMIpDfnY');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await get('/v1/ch/jack-oblivion/')).headers.get('location'), 'https://www.youtube.com/watch?v=iVTPoB2GelQ');
  const spare = await get('/v1/ch/spare-01');
  assert.equal(spare.status, 503);
  assert.equal((await spare.json()).error, 'channel_unavailable');
  const unknown = await get('/v1/ch/nope');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'unknown_channel');
  assert.equal((await get('/v1/ch/%zz')).status, 404);
});
