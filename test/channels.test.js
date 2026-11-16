import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChannelSlots } from '../src/channels.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';

const fetch2 = (url) => fetch(url, { redirect: 'manual', headers: { 'user-agent': 'AVProMobileVideo/2026.3.3p2 (Linux;Android 14) ExoPlayer' } });

// A monitor.db made by the monitor's own schema (monitor/slotmon/db.py SCHEMA, the text slotmon runs), so the lookup is
// tested against the columns production has, not a hand-written table (#776, coordinator 2026-11-16).
const SCHEMA = /SCHEMA = """([\s\S]*?)"""/.exec(readFileSync(new URL('../monitor/slotmon/db.py', import.meta.url), 'utf8'))[1];
function monitorDb(t, rows = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'monitor.db');
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const put = db.prepare('INSERT INTO slots (key, idx, kind, current_video, baked_video, baked_hidden, auto_hidden, auto_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  put.run('lofi-sleep-chill', 1, 'live', 'JD-kMIpDfnY', 'JD-kMIpDfnY', 0, 0, null);
  put.run('jack-oblivion', 2, 'live', 'iVTPoB2GelQ', '2f5CjnKt6oI', 0, 0, null); // swapped by the monitor
  put.run('pink-noise-black', 3, 'video', '2wgg7KtzTrU', '2wgg7KtzTrU', 0, 0, null);
  put.run('spare-01', 4, 'live', null, null, 1, 0, null);
  put.run('playlist-test', 5, 'removed', null, null, 0, 0, null);
  for (const r of rows) put.run(...r);
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

test('channel slots with no monitor database and an upstream set (staging, world #376): the baked link; hidden, linkless and unknown slots as before', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jyt-baked-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const baked = join(dir, 'channels.json');
  writeFileSync(baked, JSON.stringify({ slots: [
    { key: 'shown', url: 'https://www.youtube.com/watch?v=JD-kMIpDfnY' },
    { key: 'hidden', url: 'https://www.youtube.com/watch?v=iVTPoB2GelQ', hidden: true },
    { key: 'list-only', url: 'https://www.youtube.com/playlist?list=PLabc' },
  ] }));
  const upstream = 'http://up.invalid'; // lookup() reads the baked file; only resolve() asks the upstream
  const ch = new ChannelSlots({ monitorDb: '/nope/monitor.db', baked, upstream });
  assert.deepEqual(ch.lookup('shown'), { id: 'JD-kMIpDfnY' });
  assert.deepEqual(ch.lookup('hidden'), { error: 'channel_unavailable' });
  assert.deepEqual(ch.lookup('list-only'), { error: 'channel_unavailable' });
  assert.deepEqual(ch.lookup('nope'), { error: 'unknown_channel' });
  assert.deepEqual(new ChannelSlots({ monitorDb: '/nope/monitor.db', baked: join(dir, 'gone.json'), upstream }).lookup('shown'), { error: 'monitor_unreadable' });
  // With a database, the monitor decides.
  const m = monitorDb(t);
  assert.deepEqual(new ChannelSlots({ monitorDb: m.path, baked }).lookup('nope'), { error: 'unknown_channel' });
  assert.deepEqual(new ChannelSlots({ monitorDb: m.path, baked }).lookup('shown'), { error: 'unknown_channel' });
});

// #776 (2026-11-16): /v1/ch refuses every slot sleep-list.json hides (slotmon publish.status_doc: baked_hidden or
// auto_hidden), with the answer a spare gets. Rows shaped as production's on 2026-11-16 (read-only read, mode=ro).
const HIDDEN_ROWS = [
  ['shown-down', 10, 'live', 'AAAAAAAAAAA', 'AAAAAAAAAAA', 0, 1, 'down'], // the monitor's: stream down, waiting for a replacement
  ['shown-flash', 11, 'live', 'BBBBBBBBBBB', 'BBBBBBBBBBB', 0, 1, 'flash fail'], // the monitor's: failed its flash check
  ['owner-hidden', 12, 'live', 'CCCCCCCCCCC', 'CCCCCCCCCCC', 1, 0, null], // retroworld-ps1: overrides.json hidden, row not hidden
  ['retired-flash', 13, 'unmanaged', 'DDDDDDDDDDD', 'DDDDDDDDDDD', 1, 1, 'flash fail'], // gta-vice-city: retired, stream still live
  ['retired-down', 14, 'unmanaged', 'EEEEEEEEEEE', 'EEEEEEEEEEE', 1, 0, null], // jack-stardew: retired
  ['spare-shown', 15, 'live', 'FFFFFFFFFFF', 'FFFFFFFFFFF', 0, 0, null], // lofi-study: a baked spare overrides.json shows
];

test('channel slots (#776): a slot the list hides is refused (the monitor\'s hide, the owner\'s, a retired slot); shown slots play; the reason is logged without the key', (t) => {
  const m = monitorDb(t, HIDDEN_ROWS);
  const lines = [];
  let now = 0;
  const ch = new ChannelSlots({ monitorDb: m.path, now: () => now, log: (o) => lines.push(o) });
  for (const key of ['shown-down', 'shown-flash', 'owner-hidden', 'retired-flash', 'retired-down']) {
    assert.deepEqual(ch.lookup(key), { error: 'channel_unavailable' }, key);
  }
  assert.deepEqual(ch.lookup('spare-shown'), { id: 'FFFFFFFFFFF' }, 'a spare the owner shows plays');
  assert.deepEqual(ch.lookup('lofi-sleep-chill'), { id: 'JD-kMIpDfnY' });
  assert.deepEqual(lines.map((l) => [l.event, l.why]), [
    ['channel_refused', 'hidden_by_monitor'], ['channel_refused', 'hidden_by_monitor'], ['channel_refused', 'hidden_by_owner'],
    ['channel_refused', 'hidden_by_monitor'], ['channel_refused', 'hidden_by_owner']]);
  const logged = JSON.stringify(lines).replace(/hidden_by_(owner|monitor)/g, '');
  for (const leak of ['shown', 'owner', 'retired', 'AAAAAAAAAAA', 'DDDDDDDDDDD']) assert.ok(!logged.includes(leak), `no ${leak} in the log`);
  // A hide reaches the answer within the 30 s cache, and so does the clear.
  assert.deepEqual(ch.lookup('jack-oblivion'), { id: 'iVTPoB2GelQ' });
  let db = m.db(); db.prepare("UPDATE slots SET auto_hidden = 1, auto_reason = 'flash fail' WHERE key = 'jack-oblivion'").run(); db.close();
  now += 29_000;
  assert.deepEqual(ch.lookup('jack-oblivion'), { id: 'iVTPoB2GelQ' }, 'cached up to 30 s');
  now += 2_000;
  assert.deepEqual(ch.lookup('jack-oblivion'), { error: 'channel_unavailable' }, 'refused once the 30 s are over');
  db = m.db(); db.prepare("UPDATE slots SET auto_hidden = 0, auto_reason = NULL WHERE key = 'jack-oblivion'").run(); db.close();
  now += 31_000;
  assert.deepEqual(ch.lookup('jack-oblivion'), { id: 'iVTPoB2GelQ' }, 'cleared: plays again');
});

test('channel slots (#776): a status that can\'t be read refuses (fail closed), is never cached, and is logged apart from a hide, once a minute', (t) => {
  // A slots table without the hide columns: the select throws, so the slot is refused, not played.
  const dir = mkdtempSync(join(tmpdir(), 'ch-old-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'monitor.db');
  let db = new DatabaseSync(path);
  db.exec('CREATE TABLE slots (key TEXT PRIMARY KEY, idx INTEGER, kind TEXT, current_video TEXT)');
  db.prepare("INSERT INTO slots VALUES ('lofi-sleep-chill', 1, 'live', 'JD-kMIpDfnY')").run();
  db.close();
  const lines = [];
  let now = 0;
  const ch = new ChannelSlots({ monitorDb: path, now: () => now, log: (o) => lines.push(o) });
  assert.deepEqual(ch.lookup('lofi-sleep-chill'), { error: 'monitor_unreadable' });
  assert.deepEqual(ch.lookup('lofi-sleep-chill'), { error: 'monitor_unreadable' });
  now += 10_000;
  assert.deepEqual(ch.lookup('lofi-sleep-chill'), { error: 'monitor_unreadable' });
  assert.equal(lines.length, 1, 'one line a minute');
  assert.equal(lines[0].event, 'channel_refused');
  assert.equal(lines[0].why, 'status_unreadable');
  assert.equal(lines[0].source, 'monitor');
  assert.match(lines[0].error, /baked_hidden|auto_hidden/);
  assert.ok(!JSON.stringify(lines).includes('lofi') && !JSON.stringify(lines).includes('JD-kMIpDfnY'), 'no key or video');
  now += 60_000;
  ch.lookup('lofi-sleep-chill');
  assert.equal(lines.length, 2);
  assert.equal(lines[1].more, 2, 'the two refusals the minute stood for');
  // Not cached: once the status reads again, the next play has it.
  db = new DatabaseSync(path);
  db.exec('ALTER TABLE slots ADD COLUMN baked_hidden INTEGER; ALTER TABLE slots ADD COLUMN auto_hidden INTEGER DEFAULT 0');
  db.close();
  now += 1_000;
  assert.deepEqual(ch.lookup('lofi-sleep-chill'), { id: 'JD-kMIpDfnY' });
});

test('channel slots with no monitor database and an upstream set (#776): overrides.json\'s hidden wins over the baked flag; a file of the wrong shape refuses every slot, a wrong entry its own slot', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jyt-ov-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const baked = join(dir, 'channels.json');
  const overrides = join(dir, 'overrides.json');
  writeFileSync(baked, JSON.stringify({ slots: [
    { key: 'shown', url: 'https://www.youtube.com/watch?v=JD-kMIpDfnY' },
    { key: 'retired', url: 'https://www.youtube.com/watch?v=AMwnj-pSbLo' }, // gta-vice-city: shown in the bake
    { key: 'owner-hidden', url: 'https://www.youtube.com/watch?v=lHa4PnLnFEI' }, // retroworld-ps1
    { key: 'spare-shown', url: 'https://www.youtube.com/watch?v=rFZHOHl-L8A', hidden: true }, // lofi-study
    { key: 'spare', url: 'https://www.youtube.com/watch?v=CwPCy1GLS38', hidden: true },
  ] }));
  const upstream = 'http://up.invalid';
  const lines = [];
  const slots = (ov) => {
    if (ov === undefined) rmSync(overrides, { force: true });
    else writeFileSync(overrides, ov);
    const c = new ChannelSlots({ monitorDb: '/nope/monitor.db', baked, overrides, upstream, log: (o) => lines.push(o) });
    return Object.fromEntries(['shown', 'retired', 'owner-hidden', 'spare-shown', 'spare'].map((k) => [k, c.lookup(k).id ?? c.lookup(k).error]));
  };
  const good = { slots: {
    retired: { hidden: true, kind: 'unmanaged', retired: '2026-11-15: flash fail' },
    'owner-hidden': { hidden: true },
    'spare-shown': { hidden: false },
    shown: { title: 'Renamed' },
  } };
  // With a byte-order mark, as slotmon accepts it (utf-8-sig).
  assert.deepEqual(slots(String.fromCharCode(0xfeff) + JSON.stringify(good)), {
    shown: 'JD-kMIpDfnY', retired: 'channel_unavailable', 'owner-hidden': 'channel_unavailable', 'spare-shown': 'rFZHOHl-L8A', spare: 'channel_unavailable' });
  assert.equal(lines.length, 0);
  // No "slots" at all: no owner edits (as slotmon reads it), so the baked flags.
  assert.deepEqual(slots(JSON.stringify({ notice: '' })), {
    shown: 'JD-kMIpDfnY', retired: 'AMwnj-pSbLo', 'owner-hidden': 'lHa4PnLnFEI', 'spare-shown': 'channel_unavailable', spare: 'channel_unavailable' });
  // A file that vouches for no slot: every slot refused.
  const none = { shown: 'monitor_unreadable', retired: 'monitor_unreadable', 'owner-hidden': 'monitor_unreadable', 'spare-shown': 'monitor_unreadable', spare: 'monitor_unreadable' };
  for (const bad of ['{ not json', '{"slots": {"shown": {"hidden": NaN}}}', '{"notice": Infinity}', 'null', '[]', '"x"', JSON.stringify({ slots: [] }), JSON.stringify({ slots: null }), JSON.stringify({ slots: 'x' })]) {
    assert.deepEqual(slots(bad), none, bad);
  }
  assert.deepEqual(slots(undefined), none, 'a missing overrides file');
  // An entry that is not an object refuses its own slot only; the rest follow the file.
  for (const entry of [null, 'x', [], 1]) {
    const doc = structuredClone(good);
    doc.slots.shown = entry;
    doc.slots.spare = entry;
    assert.deepEqual(slots(JSON.stringify(doc)), {
      shown: 'monitor_unreadable', retired: 'channel_unavailable', 'owner-hidden': 'channel_unavailable', 'spare-shown': 'rFZHOHl-L8A', spare: 'monitor_unreadable' }, JSON.stringify(entry));
  }
  assert.ok(lines.length > 0 && lines.every((l) => l.event === 'channel_refused' && l.why === 'status_unreadable' && l.source === 'baked'));
  assert.ok(!JSON.stringify(lines).match(/shown|retired|spare|JD-kMIpDfnY/), 'no key or video in the log');
});

test('GET /v1/ch/<key> (#776): a hidden or retired slot answers 503 channel_unavailable, as a spare does', async (t) => {
  const m = monitorDb(t, HIDDEN_ROWS);
  const config = { ...base, shards: 2, pool: 50, monitorDb: m.path, metricsPath: '' };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const server = http.createServer(createApp({ config, store, captions: { async get() { return {}; } }, log: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', headers: { 'user-agent': 'AVProMobileVideo/2026.3.3p2 (Linux;Android 14) ExoPlayer' } });
  for (const key of ['shown-flash', 'owner-hidden', 'retired-flash', 'retired-down', 'shown-down']) {
    const r = await get(`/v1/ch/${key}`);
    assert.equal(r.status, 503, key);
    assert.equal(r.headers.get('location'), null, key);
    assert.equal((await r.json()).error, 'channel_unavailable', key);
  }
  assert.equal((await get('/v1/ch/spare-shown')).headers.get('location'), 'https://www.youtube.com/watch?v=FFFFFFFFFFF');
});

test('channel slots (#776, verifier M2): no upstream set and the monitor database missing or unreadable: every slot refused, logged as status_missing once a minute, never cached; with an upstream set (staging) the baked link as before', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ch-m2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const baked = join(dir, 'channels.json');
  writeFileSync(baked, JSON.stringify({ slots: [
    { key: 'lofi-sleep-chill', url: 'https://www.youtube.com/watch?v=JD-kMIpDfnY' },
    { key: 'flash-hidden', url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB' }, // shown in the bake, hidden by the monitor
  ] }));
  const path = join(dir, 'gone', 'monitor.db'); // the file, and its folder, missing
  const lines = [];
  let now = 0;
  const prod = new ChannelSlots({ monitorDb: path, baked, now: () => now, log: (o) => lines.push(o) });
  for (const key of ['lofi-sleep-chill', 'flash-hidden', 'flash-hidden']) assert.deepEqual(await prod.resolve(key), { error: 'monitor_unreadable' }, key);
  now += 10_000;
  assert.deepEqual(prod.lookup('lofi-sleep-chill'), { error: 'monitor_unreadable' });
  assert.deepEqual(lines, [{ event: 'channel_refused', why: 'status_missing', source: 'monitor', error: 'the monitor database is missing or not readable', more: 0 }]);
  now += 60_000;
  prod.lookup('flash-hidden');
  assert.deepEqual(lines.map((l) => [l.why, l.more]), [['status_missing', 0], ['status_missing', 3]]);
  // Never cached: once the monitor's database is there, the next play reads it.
  mkdirSync(join(dir, 'gone'));
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO slots (key, idx, kind, current_video, baked_hidden, auto_hidden, auto_reason) VALUES ('flash-hidden', 1, 'live', 'BBBBBBBBBBB', 0, 1, 'flash fail'), ('lofi-sleep-chill', 2, 'live', 'JD-kMIpDfnY', 0, 0, NULL)").run();
  db.close();
  now += 1_000;
  assert.deepEqual(prod.lookup('flash-hidden'), { error: 'channel_unavailable' });
  assert.deepEqual(prod.lookup('lofi-sleep-chill'), { id: 'JD-kMIpDfnY' });
  // Staging: an upstream set and no database: its answers come from the upstream; a failed upstream falls back to the baked link.
  const fetch = async () => { throw new Error('upstream down'); };
  const staging = new ChannelSlots({ monitorDb: join(dir, 'none.db'), baked, upstream: 'http://up.invalid', fetch });
  assert.deepEqual(await staging.resolve('lofi-sleep-chill'), { id: 'JD-kMIpDfnY' });
  // Through the route (production's config: no CHANNELS_UPSTREAM): a 503, not a redirect.
  const config = { ...base, shards: 2, pool: 50, monitorDb: join(dir, 'missing.db'), channelsUpstream: '', metricsPath: '' };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const server = http.createServer(createApp({ config, store, captions: { async get() { return {}; } }, log: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const r = await fetch2(`http://127.0.0.1:${server.address().port}/v1/ch/lofi-sleep-chill`);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('location'), null);
  assert.equal((await r.json()).error, 'channel_unavailable');
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

// A stand-in for production's /v1/ch (world #519): answers per key, counts calls; 'slow' never answers.
async function upstream(t) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    const key = req.url.replace('/v1/ch/', '');
    calls.push(key);
    if (key === 'slow') return; // held until the client gives up
    if (key === 'live') { res.writeHead(302, { location: 'https://www.youtube.com/watch?v=iVTPoB2GelQ' }); return res.end(); }
    if (key === 'odd') { res.writeHead(302, { location: 'https://example.com/elsewhere' }); return res.end(); }
    if (key === 'boom') { res.writeHead(500); return res.end(); }
    if (key === 'down') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"channel_unavailable"}'); }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"unknown_channel"}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { url: `http://127.0.0.1:${srv.address().port}/`, calls };
}

function bakedFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jyt-up-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const baked = join(dir, 'channels.json');
  writeFileSync(baked, JSON.stringify({ slots: [
    { key: 'live', url: 'https://www.youtube.com/watch?v=2f5CjnKt6oI' }, // the stale baked stream
    { key: 'down', url: 'https://www.youtube.com/watch?v=2f5CjnKt6oI' },
    { key: 'gone', url: 'https://www.youtube.com/watch?v=2f5CjnKt6oI' },
    { key: 'slow', url: 'https://www.youtube.com/watch?v=JD-kMIpDfnY' },
    { key: 'odd', url: 'https://www.youtube.com/watch?v=JD-kMIpDfnY' },
    { key: 'boom', url: 'https://www.youtube.com/watch?v=JD-kMIpDfnY' },
    { key: 'unhidden', url: 'https://www.youtube.com/watch?v=JD-kMIpDfnY', hidden: true },
  ] }));
  return baked;
}

test('channel upstream (world #519): its 302, 404 and 503 are the answer and cached 5 min; timeout, error or an odd answer fall back to the baked link', async (t) => {
  const up = await upstream(t);
  const baked = bakedFile(t);
  const lines = [];
  let now = 0;
  const ch = new ChannelSlots({ monitorDb: '/nope/monitor.db', baked, upstream: up.url, upstreamTimeoutMs: 150, upstreamDownMs: 0, now: () => now, log: (o) => lines.push(o) });
  assert.deepEqual(await ch.resolve('live'), { id: 'iVTPoB2GelQ' }, 'the upstream video, not the stale baked one');
  assert.deepEqual(await ch.resolve('down'), { error: 'channel_unavailable' }, '503 passed through though the baked link has a video');
  assert.deepEqual(await ch.resolve('gone'), { error: 'unknown_channel' }, '404 passed through');
  assert.deepEqual(await ch.resolve('unhidden'), { error: 'unknown_channel' }, 'the upstream decides, not the baked hidden flag');
  assert.deepEqual(await ch.resolve('slow'), { id: 'JD-kMIpDfnY' }, 'timeout: the baked link');
  assert.deepEqual(await ch.resolve('odd'), { id: 'JD-kMIpDfnY' }, 'a 302 elsewhere is not trusted: the baked link');
  assert.deepEqual(await ch.resolve('boom'), { id: 'JD-kMIpDfnY' }, 'a 500: the baked link');
  assert.deepEqual(await ch.resolve('../etc'), { error: 'unknown_channel' });
  assert.deepEqual(up.calls, ['live', 'down', 'gone', 'unhidden', 'slow', 'odd', 'boom'], 'a bad key never reaches the upstream');
  assert.deepEqual(lines.map((l) => [l.event, l.outcome, l.status, l.fallback]), [
    ['channel_upstream', 'redirect', 302, false], ['channel_upstream', 'unavailable', 503, false],
    ['channel_upstream', 'unknown', 404, false], ['channel_upstream', 'unknown', 404, false],
    ['channel_upstream', 'timeout', null, true], ['channel_upstream', 'bad_location', 302, true], ['channel_upstream', 'other', 500, true]]);
  const logged = JSON.stringify(lines);
  for (const leak of ['iVTPoB2GelQ', 'JD-kMIpDfnY', 'live', 'down', 'example.com']) assert.ok(!logged.includes(leak), `no ${leak} in the log`);
  // Cached for 5 minutes; failures are not cached, so the next play asks again.
  now += 4 * 60_000;
  await ch.resolve('live'); await ch.resolve('down'); await ch.resolve('slow');
  assert.deepEqual(up.calls.slice(7), ['slow']);
  now += 61_000;
  await ch.resolve('live');
  assert.deepEqual(up.calls.slice(8), ['live']);
  // Plays of one slot at once share one call.
  now += 6 * 60_000;
  const all = await Promise.all([ch.resolve('down'), ch.resolve('down'), ch.resolve('down')]);
  assert.deepEqual(all, Array(3).fill({ error: 'channel_unavailable' }));
  assert.deepEqual(up.calls.slice(9), ['down']);
});

test('channel upstream unset, or a monitor database present: no upstream call; with neither, refused (#776 M2)', async (t) => {
  const baked = bakedFile(t);
  let calls = 0;
  const fetch = async () => { calls++; throw new Error('must not be called'); };
  const plain = new ChannelSlots({ monitorDb: '/nope/monitor.db', baked, fetch });
  assert.deepEqual(await plain.resolve('live'), { error: 'monitor_unreadable' }, 'not the baked link');
  assert.deepEqual(await plain.resolve('unhidden'), { error: 'monitor_unreadable' });
  const m = monitorDb(t);
  const withDb = new ChannelSlots({ monitorDb: m.path, baked, upstream: 'http://127.0.0.1:9/', fetch });
  assert.deepEqual(await withDb.resolve('jack-oblivion'), { id: 'iVTPoB2GelQ' });
  assert.equal(calls, 0);
});

test('GET /v1/ch/<key> with CHANNELS_UPSTREAM and no monitor: one hop to the upstream video; 503 and 404 passed through', async (t) => {
  const up = await upstream(t);
  const lines = [];
  const config = { ...base, shards: 2, pool: 50, monitorDb: '/nope/monitor.db', channelsUpstream: up.url, metricsPath: '' };
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const server = http.createServer(createApp({ config, store, captions: { async get() { return {}; } }, log: (l) => lines.push(l) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', headers: { 'user-agent': 'AVProMobileVideo/2026.3.3p2 (Linux;Android 14) ExoPlayer' } });
  const ok = await get('/v1/ch/live');
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), 'https://www.youtube.com/watch?v=iVTPoB2GelQ', 'YouTube directly, not the upstream');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await get('/v1/ch/down')).status, 503);
  assert.equal((await get('/v1/ch/gone')).status, 404);
  assert.ok(lines.some((l) => l.includes('"event":"channel_upstream"')));
});

test('channel upstream cache is bounded (verifier, world #519): oldest dropped past the cap; a 404 for a key not in the baked file is not kept', async (t) => {
  const baked = bakedFile(t);
  const calls = [];
  const fetch = async (url) => {
    const key = url.split('/v1/ch/')[1];
    calls.push(key);
    return key.startsWith('scan-') || key === 'gone' ? new Response(null, { status: 404 }) : new Response(null, { status: 503 });
  };
  const ch = new ChannelSlots({ monitorDb: '/nope/monitor.db', baked, upstream: 'http://up.invalid', upstreamCacheMax: 3, fetch });
  for (let i = 0; i < 50; i++) assert.deepEqual(await ch.resolve(`scan-${i}`), { error: 'unknown_channel' });
  assert.equal(ch.upstreamCache.size, 0, 'random keys are not cached');
  await ch.resolve('scan-1');
  assert.equal(calls.filter((k) => k === 'scan-1').length, 2, 'and are asked again');
  assert.deepEqual(await ch.resolve('gone'), { error: 'unknown_channel' });
  assert.ok(ch.upstreamCache.has('gone'), 'a 404 for a baked key is kept');
  for (const k of ['live', 'down', 'slow', 'odd']) await ch.resolve(k);
  assert.equal(ch.upstreamCache.size, 3);
  assert.deepEqual([...ch.upstreamCache.keys()], ['down', 'slow', 'odd'], 'oldest first out');
  const before = calls.length;
  await ch.resolve('odd');
  assert.equal(calls.length, before, 'a kept key is answered from the cache');
});

test('channel upstream skipped for 20 s after a timeout or an error (verifier, world #519): the baked link without the wait', async (t) => {
  const baked = bakedFile(t);
  let now = 0, calls = 0, mode = 'hang';
  const fetch = async (url, { signal }) => {
    calls++;
    if (mode === 'hang') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    if (mode === 'refused') throw new TypeError('fetch failed');
    return new Response(null, { status: 302, headers: { location: 'https://www.youtube.com/watch?v=iVTPoB2GelQ' } });
  };
  const lines = [];
  const ch = new ChannelSlots({ monitorDb: '/nope/monitor.db', baked, upstream: 'http://up.invalid', upstreamTimeoutMs: 100, now: () => now, fetch, log: (o) => lines.push(o) });
  assert.deepEqual(await ch.resolve('live'), { id: '2f5CjnKt6oI' }, 'timeout: the baked link');
  assert.equal(calls, 1);
  const t0 = Date.now();
  now += 19_000;
  assert.deepEqual(await ch.resolve('slow'), { id: 'JD-kMIpDfnY' });
  assert.deepEqual(await ch.resolve('live'), { id: '2f5CjnKt6oI' });
  assert.equal(calls, 1, 'no upstream call within 20 s');
  assert.ok(Date.now() - t0 < 50, 'and no wait');
  now += 1_001;
  mode = 'refused';
  assert.deepEqual(await ch.resolve('live'), { id: '2f5CjnKt6oI' }, 'a network error: the baked link');
  assert.equal(calls, 2);
  now += 10_000;
  await ch.resolve('live');
  assert.equal(calls, 2, 'skipped again after the error');
  now += 10_001;
  mode = 'ok';
  assert.deepEqual(await ch.resolve('live'), { id: 'iVTPoB2GelQ' }, 'back once the 20 s are over');
  assert.equal(calls, 3);
  assert.deepEqual(lines.map((l) => l.outcome), ['timeout', 'error', 'redirect'], 'one log line per upstream call, none for skips');
});
