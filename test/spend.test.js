// Everything-is-OK#478: spend limits on paid Tunelio builds (src/spend.js). No real credits: Tunelio is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Playback } from '../src/playback.js';
import { SpendGate, spendScope } from '../src/spend.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { config as base } from '../src/config.js';
import { alertRules } from '../tools/grafana.mjs';

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
  assert.deepEqual(sent, ['spend_budget', 'spend_budget_ok'], 'one all-clear');
  assert.equal((await pb.location({ id: vid(7), seconds: 600 })).via, 'tunelio');
  assert.equal(tunelio.created.length, 4);
});

test('#478: the day budget rolls over 24 h, failed calls are given back, and the spend survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spend-'));
  try {
    let now = 1_000_000_000_000;
    const stateFile = join(dir, 'spend-budget.json');
    const a = new SpendGate({ hourCredits: 0, dayCredits: 20, now: () => now, stateFile });
    // Failed /create: costs nothing, so it isn't counted.
    const failing = new Playback({ tunelio: fakeTunelio({ fail: true }), quality: '720p', spend: a, now: () => now });
    await failing.location({ id: vid(1), seconds: 60 });
    assert.equal(a.spent(24 * 3600_000), 0);
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

test('#478: the per-IP map stays bounded by evicting the least recently active IPs, not by a reset', () => {
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, perIpPerMinute: 1, perShardPerMinute: 0 });
  const ip = (i) => `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`;
  const as = (i, id) => spendScope.run({ ip: ip(i) }, () => spend.refuse(id));
  assert.equal(as(0, vid(0)), null);
  for (let i = 1; i < 12_000; i++) {
    assert.equal(as(i, vid(i)), null);
    if (i === 11_000) assert.equal(as(11_000, vid(99)), 'cap', 'a recent IP keeps its count while the map is full');
  }
  assert.equal(spend.byIp.size, 10_000);
  assert.equal(as(11_999, vid(98)), 'cap', 'the newest IPs were not reset');
  assert.equal(as(0, vid(97)), null, 'the least recently active was evicted');
});

test('#478: a Grafana alert on spend rate over 400 credits an hour, production only', () => {
  const r = alertRules('x').find((x) => x.uid === 'eiok-spend-rate');
  assert.ok(r, 'rule present');
  const expr = r.data[0].model.expr;
  assert.match(expr, /metric="credits"/);
  assert.match(expr, /\[1h\]/);
  assert.match(expr, /> 400/);
  assert.match(expr, /env!="staging"/);
});
