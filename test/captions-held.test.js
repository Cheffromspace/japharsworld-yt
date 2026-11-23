// Everything-is-OK#996, the service half: a caption ask is answered about the video ticket the asking client's player
// asked for last in the shard, held or counted (src/server.js, playerAsked), and about the shard's last counted play
// when that client has none. The real app over a real Store; `playback` holds a player's ticket request until the test
// lets it go (the ticket route's `await playback.location(...)`), `captions` records which video it was asked about.
// The issue's "Wanted with the fix": a service test that asks for captions while a ticket is held. Each test here fails
// on the code before the fix (staging a4b15cd), which answered about store.lastPlayed(shard) only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';

const PLAYER = 'NSPlayer/12.00.19041.5794 WMFSDK/12.00.19041.5794'; // a PC player (AVPro): held, then counted
const TABLET = 'UnityPlayer/2022.3.22f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)'; // the world's status asks ('string')
const IDS = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
const OTHER = { 'x-forwarded-for': '203.0.113.7' }; // another visitor (clientIp honours it from loopback)

async function setup(t, { store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 }), tickets: given = null } = {}) {
  const config = { ...base, shards: 2, pool: store.pool, metricsPath: '', publicUrl: 'http://pub', homeRelay: false, ticketPin: false };
  const pending = []; // { id, release }
  const atOnce = new Set();
  const playback = { jobs: new Map(), peek: () => null, status: () => ({ state: 'building' }), start() {}, wouldBuild: () => true,
    location(data) {
      const where = { location: `http://127.0.0.1:9/${data.id}.mp4`, via: 'tunelio', ready: true };
      if (atOnce.has(data.id)) return Promise.resolve(where);
      return new Promise((resolve) => pending.push({ id: data.id, release: () => resolve(where) }));
    } };
  const asked = []; // [kind, video id] the captions fake was asked about
  const tracksOf = (id) => [{ i: 0, code: id.slice(0, 2), name: id.slice(0, 2), auto: true }];
  const captions = {
    async tracks(id, lang) { asked.push(['tracks', id]); return { id, lang, available: true, tracks: tracksOf(id), track: -1 }; },
    async get(id, lang) { asked.push(['list', id]); return { id, lang, available: true, tracks: tracksOf(id), track: 0, lines: [[0, 1, `a line of ${id}`]] }; },
    async track(id, i, lang) { asked.push(['track', id]); return { id, lang, available: true, tracks: tracksOf(id), track: i, lines: [[0, 1, `a line of ${id}`]] }; },
    warm() {} };
  const logs = [];
  const app = createApp({ config, store, playback, captions, tunelio: { enabled: true }, log: (l) => { try { logs.push(JSON.parse(l)); } catch { /* request lines */ } } });
  const server = http.createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const tickets = given ?? store.allocate(0, IDS.map((id) => ({ kind: 'video', data: { id, title: id, seconds: 600, live: false } })));
  const plays = [];
  const turn = () => new Promise((done) => setImmediate(done));
  // A player's request for ticket n: resolves once it has reached the hold (or been answered at once).
  const play = async (n, { headers = {}, ua = PLAYER } = {}) => {
    const ac = new AbortController();
    const before = pending.length;
    let status = null;
    const p = fetch(`${url}/v1/0/${n}`, { redirect: 'manual', headers: { 'user-agent': ua, ...headers }, signal: ac.signal }).then((r) => { status = r.status; return r.status; }, () => 'dropped');
    plays.push(p);
    for (let i = 0; i < 5000 && status == null && pending.length === before; i++) await turn();
    return { drop: () => ac.abort(), done: p, held: pending.length > before };
  };
  const idOf = (n) => IDS[tickets.indexOf(n)];
  // Lets the hold on ticket n go, and waits until its play is counted (store.markPlayed runs before the 302, also for a
  // request its player dropped: #1029).
  const release = async (n) => {
    const i = pending.findIndex((h) => h.id === idOf(n));
    assert.ok(i >= 0, `ticket ${n} is held`);
    pending.splice(i, 1)[0].release();
    for (let k = 0; k < 5000 && !(store.lastPlayed(0)?.n === n && store.lastPlayed(0)?.videoId === idOf(n)); k++) await turn();
    assert.equal(store.lastPlayed(0)?.n, n, `ticket ${n}'s play counted`);
  };
  const cc = async (path, headers = {}) => {
    const r = await fetch(`${url}/v1/0/${path}`, { headers: { 'user-agent': TABLET, ...headers } });
    return { status: r.status, body: await r.json() };
  };
  t.after(async () => {
    while (pending.length) pending.shift().release();
    await Promise.allSettled(plays);
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { store, tickets, play, release, cc, asked, logs, atOnce, idOf, pending, url, app };
}

test('#996: a caption ask during a held play is answered about the held ticket, not the last counted one; a restart answers the last counted', async (t) => {
  const store = new Store({ path: ':memory:', shards: 2, pool: 50, pinHours: 24 });
  const a = await setup(t, { store });
  const [t0, t1] = a.tickets;
  store.markPlayed(0, t0, IDS[0]); // the room played ticket 0 earlier
  assert.equal((await a.play(t1)).held, true, 'ticket 1 is held');
  for (const [path, kind] of [['cc?l=en', 'tracks'], ['cc/en', 'list'], ['cc/0', 'track'], ['cc/native', 'list']]) {
    const r = await a.cc(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.body.t, t1, `${path}: answered for the held ticket (was ticket ${t0}, the last counted)`);
    assert.equal(r.body.tracks[0].code, IDS[1].slice(0, 2), `${path}: the held video's own list`);
    assert.deepEqual(a.asked.at(-1), [kind, IDS[1]], `${path}: looked up for the held video`);
  }
  assert.equal(store.lastPlayed(0).n, t0, 'nothing counted yet: lastPlayed unchanged');
  const lines = a.logs.filter((l) => l.event === 'captions_held');
  assert.deepEqual(lines.map((l) => [l.n, l.id, l.kind, l.reason]), [[t1, IDS[1], 'tracks', null], [t1, IDS[1], 'list', null], [t1, IDS[1], 'track', null], [t1, IDS[1], 'native', null]]);
  assert.ok(lines.every((l) => Number.isInteger(l.held) && l.held >= 0), 'held: ms since the player asked');
  // The hold ends: counted, the same answer, and no captions_held line any more (it is the last counted play now).
  await a.release(t1);
  assert.equal((await a.cc('cc?l=en')).body.t, t1);
  assert.equal(a.logs.filter((l) => l.event === 'captions_held').length, 4, 'no captions_held once the asked ticket is the counted one');
  // The room picks ticket 2: held, and this client's asks follow it.
  await a.play(a.tickets[2]);
  assert.equal((await a.cc('cc?l=en')).body.t, a.tickets[2]);
  // A restart (a new app over the same database) forgets the per-client records: the last counted play, as before.
  const b = await setup(t, { store, tickets: a.tickets });
  assert.equal((await b.cc('cc?l=en')).body.t, t1, 'a fresh app answers about lastPlayed');
});

test('#996: a fresh shard during the first held play answers about it, not 404 nothing_playing', async (t) => {
  const a = await setup(t);
  const [, t1] = a.tickets;
  assert.equal(a.store.lastPlayed(0), null, 'nothing played in this shard yet');
  await a.play(t1);
  const r = await a.cc('cc/en');
  assert.equal(r.status, 200, 'not 404 nothing_playing');
  assert.equal(r.body.t, t1);
  // Another visitor with no player request of their own still gets today's answer (nothing counted: 404).
  assert.equal((await a.cc('cc/en', OTHER)).status, 404, 'a client without a record: the shard\'s last counted play, here none');
});

test('#996: another visitor\'s player on an older ticket (a straggler, the captions test\'s seed 1016) does not move this client\'s answer, held or at once', async (t) => {
  const a = await setup(t);
  const [t0, t1, t2] = a.tickets;
  a.store.markPlayed(0, t0, IDS[0]);
  await a.play(t1); // this visitor's room picks ticket 1: held
  a.atOnce.add(IDS[0]);
  await (await a.play(t0, { headers: OTHER })).done; // a straggler's player asks ticket 0: answered at once and counted
  assert.equal(a.store.lastPlayed(0).n, t0, 'the straggler\'s play counted');
  assert.equal((await a.cc('cc?l=en')).body.t, t1, 'still about the held ticket');
  assert.equal((await a.cc('cc?l=en', OTHER)).body.t, t0, 'the straggler\'s own client: its own player\'s ticket');
  await a.release(t1);
  assert.equal((await a.cc('cc?l=en')).body.t, t1, 'after the hold: the counted ticket');
  // A straggler whose own request is held (an older ticket not ready) moves nothing for this client either.
  await a.play(t2, { headers: OTHER });
  assert.equal((await a.cc('cc?l=en')).body.t, t1);
});

test('#996: a held play its player dropped, counted late (#1029\'s shape), does not take the answer back; a pick answered at once does take it', async (t) => {
  const a = await setup(t);
  const [t0, t1, t2] = a.tickets;
  a.store.markPlayed(0, t0, IDS[0]);
  const first = await a.play(t1); // pick 1: held
  first.drop(); // the room picks again: the player drops ticket 1's request (its hold goes on, #1029)
  await a.play(t2); // pick 2: held
  assert.equal((await a.cc('cc/en')).body.t, t2);
  await a.release(t2); // 2 is counted
  await a.release(t1); // the dropped 1 is counted after it (#1029): lastPlayed goes back to 1
  assert.equal(a.store.lastPlayed(0).n, t1, '#1029 is not fixed here: the late count still moves lastPlayed');
  assert.equal((await a.cc('cc/en')).body.t, t2, 'the answer stays on the ticket this client\'s player asked for last');
  // A pick answered at once (its build ready) while an older hold is still in flight: the answer follows the pick.
  await a.play(t1); // held again
  a.atOnce.add(IDS[0]);
  await (await a.play(t0)).done; // this client's room picks ticket 0, answered at once
  assert.equal((await a.cc('cc/en')).body.t, t0);
  await a.release(t1); // the older hold ends later
  assert.equal((await a.cc('cc/en')).body.t, t0, 'not the older hold counted after it');
});

test('#996: the tablet\'s status asks set nothing; a ticket bound to another video by a later search falls back to the last counted play', async (t) => {
  const store = new Store({ path: ':memory:', shards: 2, pool: 4, pinHours: 24 });
  const a = await setup(t, { store });
  const [t0, t1, t2] = a.tickets; // 0, 1, 2 of a pool of 4
  store.markPlayed(0, t0, IDS[0]); // pinned: a later search skips it
  await a.play(t1);
  assert.equal((await a.cc('cc?l=en')).body.t, t1, 'about the held ticket');
  // The tablet asks ticket 2's status (a row selected): not a player, so the answer stays on ticket 1.
  const status = await fetch(`${a.url}/v1/0/${t2}`, { headers: { 'user-agent': TABLET } });
  assert.equal(status.status, 200, 'the tablet gets its JSON status');
  assert.equal((await a.cc('cc?l=en')).body.t, t1, 'still about ticket 1');
  // A later search binds tickets 3, 1, 2 again (0 is pinned): ticket 1 now names another video, so the record is not used.
  const again = store.allocate(0, ['ddddddddddd', 'eeeeeeeeeee', 'fffffffffff'].map((id) => ({ kind: 'video', data: { id, title: id, seconds: 600, live: false } })));
  assert.deepEqual(again, [3, 1, 2], 'ticket 1 bound again');
  const r = await a.cc('cc?l=en');
  assert.equal(r.body.t, t0, 'the record names a video ticket 1 no longer has: the last counted play');
  assert.deepEqual(a.asked.at(-1), ['tracks', IDS[0]]);
});

test('#996: the record keeps the daily client code, never the address (as the other per-visitor marks; routing.test.js scans kept() too)', async (t) => {
  const a = await setup(t);
  await a.play(a.tickets[1], { headers: OTHER });
  const kept = a.app.kept().playerAsked;
  assert.equal(kept.size, 1, 'one record, for that visitor');
  const text = JSON.stringify([...kept]);
  assert.equal(text.includes(OTHER['x-forwarded-for']), false, 'no raw address in it');
  assert.equal(text.includes('127.0.0.1'), false);
  assert.match([...kept.keys()][0], /^0:[A-Za-z0-9_-]{22}$/, '"shard:code", the daily 16-byte code');
});
