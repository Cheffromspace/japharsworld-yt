// Everything-is-OK#478: spend limits on paid Tunelio builds (src/spend.js). No real credits: Tunelio is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Playback } from '../src/playback.js';
import { SpendGate, spendScope } from '../src/spend.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { config as base } from '../src/config.js';
import { alertRules } from '../tools/grafana.mjs';
import { TunelioCaptions } from '../src/transcripts.js';
import { CaptionChain } from '../src/captionchain.js';

const UNITY = 'UnityPlayer/6000.0.67f1-DWR (UnityWebRequest/1.0, libcurl/8.10.1-DEV)';
const WMF = 'NSPlayer/12.00.26100.1234 WMFSDK/12.00.26100.1234';
const vid = (i) => `Vid${String(i).padStart(8, '0')}`; // 11 characters

function fakeAlert() {
  const sent = [];
  const alert = (kind, text) => { sent.push(kind); return true; };
  alert.resolve = (kind) => { sent.push(`${kind}_ok`); return true; };
  return { alert, sent };
}
function fakeTunelio({ fail = false } = {}) {
  const created = [];
  return { created, enabled: true, async create(id, q) {
    created.push([id, q]);
    if (fail) throw Object.assign(new Error('nope'), { status: 500 });
    return { url: `https://tunelio.dev/tunnel?id=${id}&q=${q}`, expires: Math.floor(Date.now() / 1000) + 3600, quality: q, fileSize: 1e8 };
  } };
}

test('#478: the hour budget stops new paid builds, alerts once, and sends one all-clear when it frees up', async () => {
  let now = 1_000_000_000_000;
  const { alert, sent } = fakeAlert();
  const spend = new SpendGate({ hourCredits: 30, dayCredits: 1000, now: () => now, alert });
  const tunelio = fakeTunelio();
  const pb = new Playback({ tunelio, quality: '720p', spend, now: () => now });
  for (let i = 0; i < 3; i++) {
    const w = await pb.location({ id: vid(i), seconds: 600 });
    assert.equal(w.via, 'tunelio', `build ${i} is within budget`);
  }
  // Over budget: no /create, the youtube.com fallback, for players, tablet warms and adaptive size reads alike.
  for (let i = 3; i < 6; i++) {
    const w = await pb.location({ id: vid(i), seconds: 600 });
    assert.deepEqual([w.via, w.reason], ['youtube', 'budget']);
  }
  assert.deepEqual(pb.status({ id: vid(9), seconds: 600 }), { state: 'youtube', reason: 'budget' });
  await assert.rejects(pb.size({ id: vid(8) }, '1080p'), (e) => e.spend && e.code === 'budget');
  assert.equal(tunelio.created.length, 3, 'nothing paid over budget');
  // A build already there still plays.
  assert.equal((await pb.location({ id: vid(0), seconds: 600 })).via, 'tunelio');
  assert.deepEqual(sent, ['spend_budget'], 'one alert, not one per request');
  now += 61 * 60_000;
  spend.check();
  assert.deepEqual(sent, ['spend_budget'], 'the all-clear waits until spend has stayed low');
  now += 30 * 60_000;
  spend.check();
  assert.deepEqual(sent, ['spend_budget', 'spend_budget_ok'], 'one all-clear');
  assert.equal((await pb.location({ id: vid(7), seconds: 600 })).via, 'tunelio');
  assert.equal(tunelio.created.length, 4);
});

test('#478: a failed /create is charged while it runs and given back after', async () => {
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 1000 });
  let during = null;
  const tunelio = { enabled: true, async create() { during = spend.spent(24 * 3600_000); throw Object.assign(new Error('nope'), { status: 500 }); } };
  const pb = new Playback({ tunelio, quality: '720p', spend });
  await pb.location({ id: vid(1), seconds: 60 });
  assert.equal(during, 10, 'counted when the call was made, so calls at once see it');
  assert.equal(spend.spent(24 * 3600_000), 0, 'and given back when it failed');
});

test('#478: under steady load at the limit the budget alert posts once, and its all-clear only after 30 low minutes', () => {
  let now = 1_000_000_000_000;
  const { alert, sent } = fakeAlert();
  const spend = new SpendGate({ hourCredits: 100, dayCredits: 0, now: () => now, alert });
  // Three hours of a caller spending whenever the budget lets it, checked every minute: the old code posted hit, ok,
  // hit, ok, hit as single calls aged out of the hour.
  for (let m = 0; m < 180; m++, now += 60_000) if (!spend.check()) spend.charge();
  assert.deepEqual(sent, ['spend_budget']);
  // Quiet: under half the hour budget for 30 minutes, then the one all-clear.
  for (let m = 0; m < 100; m++, now += 60_000) spend.check();
  assert.deepEqual(sent, ['spend_budget', 'spend_budget_ok']);
  // Hit again within 24 h of the post: logged, not posted.
  for (let m = 0; m < 20; m++, now += 60_000) if (!spend.check()) spend.charge();
  assert.deepEqual(sent, ['spend_budget', 'spend_budget_ok']);
});

test('#478: a damaged spend file starts half spent and is kept as .bak; a missing one starts empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spend-'));
  try {
    const stateFile = join(dir, 'spend-budget.json');
    assert.equal(new SpendGate({ hourCredits: 800, stateFile }).spent(3600_000), 0, 'missing: empty');
    writeFileSync(stateFile, '{"spends": [{"at": 1');
    const logs = [];
    const g = new SpendGate({ hourCredits: 800, stateFile, log: (o) => logs.push(o) });
    assert.equal(g.spent(3600_000), 400);
    assert.ok(existsSync(`${stateFile}.bak`));
    assert.equal(logs[0].event, 'spend_state_damaged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#478: the day budget rolls over 24 h and the spend survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spend-'));
  try {
    let now = 1_000_000_000_000;
    const stateFile = join(dir, 'spend-budget.json');
    const a = new SpendGate({ hourCredits: 0, dayCredits: 20, now: () => now, stateFile });
    a.charge(); now += 5 * 3600_000; a.charge();
    assert.equal(a.check(), 'day');
    const b = new SpendGate({ hourCredits: 0, dayCredits: 20, now: () => now, stateFile });
    assert.equal(b.check(), 'day', 'a restart keeps the last 24 h');
    now += 19 * 3600_000 + 1;
    assert.equal(b.check(), null, 'the first spend left the window');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function app(t, spendOpts = {}) {
  const store = new Store({ path: ':memory:', shards: 2, pool: 200, pinHours: 24 });
  const youtube = { async search(q) {
    return { videos: [{ id: q, title: 't', channel: 'c', length: '10:00', seconds: 600, views: '', age: '', live: false, cc: false }], more: null };
  }, thumbnailUrl: (id) => id };
  const tunelio = fakeTunelio();
  const logs = [];
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, perIpPerMinute: 2, perShardPerMinute: 3, log: () => {}, ...spendOpts });
  const playback = new Playback({ tunelio, quality: '720p', probe: async () => ({ ok: true, refused: false }), spend });
  const a = createApp({ config: { ...base, shards: 2, pool: 200, tunelioQuality: '720p', ticketPlayerHoldMs: 5000, searchesPerMinutePerIp: 500, videoMaxSeconds: 43200, lookupWarm: false, adaptiveHls: false },
    store, youtube, playback, tunelio, captions: { async get() { return { available: false }; } }, log: (s) => logs.push(JSON.parse(s)) });
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const get = (p, ua, ip) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': ip } });
  const ticketFor = async (shard, id) => (await (await get(`/v1/${shard}/s?l=en&q=${id}`, UNITY, '10.0.0.1')).json()).results[0].t;
  return { get, ticketFor, tunelio, spend };
}

test('#478: new paid builds on the ticket route are capped per IP and per shard; over the cap a play still plays, from youtube.com', async (t) => {
  const a = await app(t);
  const play = async (shard, id, ip) => { const r = await a.get(`/v1/${shard}/${await a.ticketFor(shard, id)}`, WMF, ip); return [r.status, r.headers.get('location')]; };
  assert.match((await play(0, vid(1), '1.1.1.1'))[1], /tunelio/);
  assert.match((await play(0, vid(2), '1.1.1.1'))[1], /tunelio/);
  // A third new video from that IP: no new build, the youtube.com link (not an error).
  assert.deepEqual(await play(0, vid(3), '1.1.1.1'), [302, `https://www.youtube.com/watch?v=${vid(3)}`]);
  // The same IP replaying a built video: cached, so not capped.
  assert.match((await play(0, vid(1), '1.1.1.1'))[1], /tunelio/);
  // The tablet's warm from that IP is capped too, and says so in its status.
  const st = await (await a.get(`/v1/0/${await a.ticketFor(0, vid(4))}`, UNITY, '1.1.1.1')).json();
  assert.deepEqual([st.state, st.reason], ['youtube', 'cap']);
  // Another IP in the same shard: one more build fills the shard's 3.
  assert.match((await play(0, vid(5), '2.2.2.2'))[1], /tunelio/);
  assert.deepEqual(await play(0, vid(6), '3.3.3.3'), [302, `https://www.youtube.com/watch?v=${vid(6)}`]);
  // Another shard has its own count.
  assert.match((await play(1, vid(7), '3.3.3.3'))[1], /tunelio/);
  assert.deepEqual(a.tunelio.created.map(([id]) => id), [vid(1), vid(2), vid(5), vid(7)]);
});

test('#478: the per-IP map stays bounded without dropping an active IP\'s count', () => {
  let now = 1_000_000_000_000;
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, perIpPerMinute: 1, perShardPerMinute: 0, maxKeys: 100, now: () => now });
  const ip = (i) => `10.0.${i >> 8}.${i & 255}`;
  const as = (i, id) => spendScope.run({ ip: ip(i) }, () => spend.refuse(id));
  for (let i = 0; i < 100; i++) assert.equal(as(i, vid(i)), null);
  assert.equal(as(100, vid(100)), 'cap', 'full of active IPs: a new one gets no paid build');
  assert.equal(as(0, vid(200)), 'cap', 'the oldest IP kept its count');
  assert.equal(spend.byIp.size, 100);
  now += 61_000;
  assert.equal(as(101, vid(101)), null, 'once IPs go quiet, new ones get room');
  assert.ok(spend.byIp.size <= 100);
});

test('#478: a Grafana alert on spend rate at the home-first point of the hour budget (1125 credits), production only', () => {
  const r = alertRules('x').find((x) => x.uid === 'eiok-spend-rate');
  assert.ok(r, 'rule present');
  const expr = r.data[0].model.expr;
  assert.match(expr, /metric="credits"/);
  assert.match(expr, /\[1h\]/);
  assert.match(expr, /> 1125(?!\d)/);
  assert.match(r.title, /1125/);
  assert.doesNotMatch(JSON.stringify(r), /~310\)|over 400/, 'no old threshold text');
  assert.match(expr, /env!="staging"/);
});

// Captions (Everything-is-OK#478 follow-up): Tunelio /transcript goes through the same budget, with its own per-IP limit.
function fakeTranscripts() {
  const calls = [];
  const tracks = [{ code: 'en', name: 'English', auto: false }, { code: 'ja', name: 'Japanese', auto: true }];
  return { calls, enabled: true, async transcript(id, lang, type) {
    calls.push([id, lang, type]);
    const code = lang === 'ja' ? 'ja' : 'en';
    return { language: code, type: code === 'ja' ? 'auto' : 'manual', tracks, lines: [[0, 1, `${code} line`]] };
  } };
}

test('#478: Tunelio transcripts meet the spend budget and a per-IP limit; over either, captions are just unavailable', async () => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 });
  const tunelio = fakeTranscripts();
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, transcriptsPerIpPerMinute: 2 });
  const tc = new TunelioCaptions({ store, tunelio, spend });
  await spendScope.run({ ip: '1.1.1.1' }, async () => {
    assert.equal((await tc.get(vid(1), 'en')).available, true);
    assert.equal((await tc.get(vid(2), 'en')).available, true);
    const c = await tc.get(vid(3), 'en');
    assert.deepEqual([c.available, c.reason], [false, 'temporarily_unavailable']);
  });
  assert.equal(tunelio.calls.length, 2, 'the third IP call made no paid request');
  assert.equal(spend.spent(3600_000), 12, '6 credits each');
  // Another IP has its own count; the budget covers them all.
  const tight = new SpendGate({ hourCredits: 10, dayCredits: 0 });
  const t2 = fakeTranscripts();
  const tc2 = new TunelioCaptions({ store: new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 }), tunelio: t2, spend: tight });
  assert.equal((await tc2.get(vid(1), 'en')).available, true);
  assert.equal((await tc2.get(vid(2), 'en')).available, false, 'a second 6 would pass 10');
  assert.equal(t2.calls.length, 1);
});

test('#478: a caption track number beyond the video\'s tracks costs only the list, never a track', async (t) => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 100, pinHours: 24 });
  const tunelio = fakeTranscripts();
  const captions = new CaptionChain({ store, tunelio: new TunelioCaptions({ store, tunelio }) });
  const a = createApp({ config: { ...base, shards: 1, pool: 100 }, store, captions, tunelio: { enabled: true, credits: null },
    youtube: { async search(q) { return { videos: [{ id: q, title: 't', channel: 'c', length: '1:00', seconds: 60, views: '', age: '', live: false, cc: true }], more: null }; }, thumbnailUrl: (id) => id },
    log: () => {} });
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const n = (await (await fetch(`http://127.0.0.1:${server.address().port}/v1/0/s?l=en&q=${vid(1)}`, { headers: { 'user-agent': UNITY } })).json()).results[0].t;
  store.markPlayed(0, n, vid(1));
  const c = await (await fetch(`http://127.0.0.1:${server.address().port}/v1/0/cc/999`, { headers: { 'user-agent': UNITY } })).json();
  assert.equal(c.available, false);
  assert.equal(c.tracks.length, 2);
  assert.equal(tunelio.calls.length, 1, 'one call for the list; the old path also paid for the video\'s own track');
});

test('#452/#478: the caption warm at play uses free sources only, even when the free source fails', async () => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 1 });
  const tunelio = fakeTranscripts();
  const local = { blocked: false, async info() { throw new Error('yt-dlp failed'); } };
  const captions = new CaptionChain({ store, local, tunelio: new TunelioCaptions({ store, tunelio }) });
  captions.warm(vid(1));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tunelio.calls.length, 0);
});

test('#478: many IPs can\'t reset another IP\'s lookup warm count', async (t) => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 100, pinHours: 24 });
  const youtube = { async search(q) { return { videos: [{ id: q, title: 't', channel: 'c', length: '1:00', seconds: 60, views: '', age: '', live: false, cc: false }], more: null }; }, thumbnailUrl: (id) => id };
  const tunelio = fakeTunelio();
  const playback = new Playback({ tunelio, quality: '720p', probe: async () => ({ ok: true, refused: false }) });
  // RATE_KEYS_MAX 2: the old map cleared itself past its bound, and every IP's count with it.
  const a = createApp({ config: { ...base, shards: 1, pool: 100, tunelioQuality: '720p', searchesPerMinutePerIp: 50, videoMaxSeconds: 43200,
    lookupWarm: true, lookupWarmsPerMinutePerIp: 2, lookupWarmsPerMinute: 100, rateKeysMax: 2 },
    store, youtube, playback, tunelio, captions: { async get() { return { available: false }; } }, log: () => {} });
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const look = async (i, from) => {
    const q = encodeURIComponent(`Paste a link → https://youtu.be/${vid(i)}`);
    await fetch(`http://127.0.0.1:${server.address().port}/v1/0/s?l=en&q=${q}`, { headers: { 'user-agent': UNITY, 'x-forwarded-for': from } });
    await new Promise((r) => setTimeout(r, 20));
  };
  await look(0, '9.9.9.9'); await look(1, '9.9.9.9'); // at its 2
  await look(2, '8.8.8.1'); // fills the map
  await look(3, '8.8.8.2'); // a new IP with the map full of active ones: no warm
  await look(4, '9.9.9.9'); // still at its 2
  assert.deepEqual(tunelio.created.map(([id]) => id), [vid(0), vid(1), vid(2)]);
});
