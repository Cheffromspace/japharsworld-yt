// Trusted client IPs (owner, 2026-11-03): TRUSTED_IPS gets TRUSTED_IP_FACTOR times every per-IP limit; the per-shard
// cap, the global lookup-warm cap and the spend budget stay the same. Addresses are from the documentation ranges only
// (192.0.2.0/24, 198.51.100.0/24, 2001:db8::/32): the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { trustedIps } from '../src/trusted.js';
import { SpendGate, spendScope } from '../src/spend.js';
import { Playback } from '../src/playback.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { config as base } from '../src/config.js';

const UNITY = 'UnityPlayer/6000.0.67f1-DWR (UnityWebRequest/1.0, libcurl/8.10.1-DEV)';
const WMF = 'NSPlayer/12.00.26100.1234 WMFSDK/12.00.26100.1234';
const vid = (i) => `Vid${String(i).padStart(8, '0')}`; // 11 characters
const HOME = '192.0.2.7', OTHER = '198.51.100.7';

test('trusted: IPv4, IPv6 and CIDR entries match; others, bad entries and an empty list do not', () => {
  const t = trustedIps(' 192.0.2.0/24, 2001:db8:1::/48 ,203.0.113.9, nonsense, 10.0.0.0/33, ,2001:db8::5');
  assert.deepEqual([t.size, t.bad], [4, 2]);
  for (const ip of ['192.0.2.0', '192.0.2.255', '::ffff:192.0.2.40', '2001:db8:1::1', '2001:db8:1:ffff::9', '203.0.113.9', '2001:db8::5'])
    assert.equal(t.has(ip), true, ip);
  for (const ip of ['192.0.3.1', '203.0.113.10', '2001:db8:2::1', '2001:db8::6', '', 'x', undefined, '::ffff:198.51.100.7'])
    assert.equal(t.has(ip), false, String(ip));
  for (const empty of ['', undefined, null, ' , '])
    assert.deepEqual([trustedIps(empty).size, trustedIps(empty).has(HOME)], [0, false]);
});

test('trusted: a trusted IP gets factor times the build and transcript limits; others are unchanged; shard cap unchanged', () => {
  const logs = [];
  const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, perIpPerMinute: 2, perShardPerMinute: 0, transcriptsPerIpPerMinute: 1,
    trusted: trustedIps('192.0.2.0/24'), trustedFactor: 3, log: (o) => logs.push(o) });
  const build = (ip, i) => spendScope.run({ ip }, () => spend.refuse(vid(i)));
  const tx = (ip) => spendScope.run({ ip }, () => spend.refuseTranscript());
  for (let i = 0; i < 6; i++) assert.equal(build(HOME, i), null, `trusted build ${i}`);
  assert.equal(build(HOME, 6), 'cap', 'the 7th: 2 × 3');
  assert.equal(build(OTHER, 10), null);
  assert.equal(build(OTHER, 11), null);
  assert.equal(build(OTHER, 12), 'cap', 'untrusted: still 2');
  for (let i = 0; i < 3; i++) assert.equal(tx(HOME), null, `trusted transcript ${i}`);
  assert.equal(tx(HOME), 'cap');
  assert.equal(tx(OTHER), null);
  assert.equal(tx(OTHER), 'cap');
  assert.deepEqual(logs.map((o) => [o.event, o.kind ?? 'build', o.trusted ?? false]),
    [['spend_cap', 'build', true], ['spend_cap', 'build', false], ['spend_cap', 'transcript', true], ['spend_cap', 'transcript', false]]);

  // The per-shard cap is everyone's.
  const shardy = new SpendGate({ hourCredits: 0, dayCredits: 0, perIpPerMinute: 1, perShardPerMinute: 2, trusted: trustedIps(HOME), trustedFactor: 10 });
  const inShard = (i) => spendScope.run({ ip: HOME, shard: 0 }, () => shardy.refuse(vid(i)));
  assert.deepEqual([inShard(1), inShard(2), inShard(3)], [null, null, 'cap']);
});

test('trusted: the hour budget still refuses a trusted IP', () => {
  const spend = new SpendGate({ hourCredits: 30, dayCredits: 0, perIpPerMinute: 4, perShardPerMinute: 0, transcriptsPerIpPerMinute: 6,
    trusted: trustedIps(HOME), trustedFactor: 10 });
  spendScope.run({ ip: HOME }, () => {
    for (let i = 0; i < 3; i++) { assert.equal(spend.refuse(vid(i)), null); spend.charge(); }
    assert.equal(spend.refuse(vid(3)), 'budget');
    assert.equal(spend.refuseTranscript(), 'budget');
  });
});

test('trusted: an empty list changes nothing in the spend gate', () => {
  for (const trusted of [trustedIps(''), null]) {
    const spend = new SpendGate({ hourCredits: 0, dayCredits: 0, perIpPerMinute: 2, perShardPerMinute: 0, trusted, trustedFactor: 10 });
    const r = [0, 1, 2].map((i) => spendScope.run({ ip: HOME }, () => spend.refuse(vid(i))));
    assert.deepEqual(r, [null, null, 'cap']);
  }
});

async function app(t, config = {}) {
  const store = new Store({ path: ':memory:', shards: 1, pool: 200, pinHours: 24 });
  const youtube = { async search(q) {
    return { videos: [{ id: /^[\w-]{11}$/.test(q) ? q : 'ZZZZZZZZZZZ', title: 't', channel: 'c', length: '10:00', seconds: 600, views: '', age: '', live: false, cc: false }], more: null };
  }, thumbnailUrl: (id) => id };
  const created = [];
  const tunelio = { enabled: true, async create(id, q) { created.push([id, q]); return { url: `https://tunelio.dev/tunnel?id=${id}&q=${q}`, expires: Math.floor(Date.now() / 1000) + 3600, quality: q, fileSize: 1e8 }; } };
  const playback = new Playback({ tunelio, quality: '720p', probe: async () => ({ ok: true, refused: false }) });
  const logs = [];
  const a = createApp({ config: { ...base, shards: 1, pool: 200, tunelioQuality: '720p', ticketPlayerHoldMs: 5000, videoMaxSeconds: 43200,
    lookupWarm: true, lookupWarmsPerMinute: 100, trustedIpFactor: 3, ...config },
    store, youtube, playback, tunelio, captions: { async get() { return { available: false }; } }, log: (s) => logs.push(JSON.parse(s)) });
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const get = (p, ip, ua = UNITY) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': ip } });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  return { get, created, settle, events: (e) => logs.filter((o) => o.event === e) };
}

const searches = async (a, ip, n) => { const s = []; for (let i = 0; i < n; i++) s.push((await a.get(`/v1/0/s?q=q${ip}${i}`, ip)).status); return s; };

test('trusted: the search limit is factor times as high for a trusted IP, unchanged for others', async (t) => {
  const a = await app(t, { searchesPerMinutePerIp: 2, trustedIps: `${HOME}, 2001:db8::/32` });
  assert.deepEqual(await searches(a, HOME, 7), [200, 200, 200, 200, 200, 200, 429]);
  assert.deepEqual(await searches(a, '2001:db8::77', 7), [200, 200, 200, 200, 200, 200, 429]);
  assert.deepEqual(await searches(a, OTHER, 3), [200, 200, 429]);
  assert.deepEqual(a.events('trusted_ips').map((o) => [o.count, o.bad, o.factor]), [[2, 0, 3]], 'counts only, never the list');
  assert.ok(!JSON.stringify(a.events('trusted_ips')).includes(HOME));
});

test('trusted: an empty or unset list leaves the search limit as it was', async (t) => {
  for (const config of [{ trustedIps: '' }, { trustedIps: undefined }]) {
    const a = await app(t, { searchesPerMinutePerIp: 2, ...config });
    assert.deepEqual(await searches(a, HOME, 3), [200, 200, 429]);
    assert.deepEqual(a.events('trusted_ips'), []);
  }
});

test('trusted: lookup warms per IP are factor times as high; the global cap is not; a capped trusted warm logs trusted', async (t) => {
  const look = async (a, i, ip) => { await a.get(`/v1/0/s?q=${encodeURIComponent(`Paste a link → https://youtu.be/${vid(i)}`)}`, ip); await a.settle(); };
  const a = await app(t, { searchesPerMinutePerIp: 50, lookupWarmsPerMinutePerIp: 1, trustedIps: '192.0.2.0/24' });
  for (let i = 0; i < 4; i++) await look(a, i, HOME);
  await look(a, 10, OTHER);
  await look(a, 11, OTHER);
  assert.deepEqual(a.created.map(([id]) => id), [vid(0), vid(1), vid(2), vid(10)], 'trusted 1 × 3, untrusted 1');
  assert.deepEqual(a.events('warm_skip').map((o) => [o.skipped, o.trusted ?? false]), [['cap', true], ['cap', false]]);

  const g = await app(t, { searchesPerMinutePerIp: 50, lookupWarmsPerMinutePerIp: 1, lookupWarmsPerMinute: 2, trustedIps: HOME });
  for (let i = 0; i < 3; i++) await look(g, 20 + i, HOME);
  assert.equal(g.created.length, 2, 'the global cap holds for a trusted IP');
});

test('trusted: the server passes TRUSTED_IPS to the spend gate it makes', async (t) => {
  const store = new Store({ path: ':memory:', shards: 1, pool: 200, pinHours: 24 });
  const youtube = { async search(q) { return { videos: [{ id: q, title: 't', channel: 'c', length: '10:00', seconds: 600, views: '', age: '', live: false, cc: false }], more: null }; }, thumbnailUrl: (id) => id };
  // The server-made Playback probes each link (linkProbe): a local media server answers it, so nothing leaves the machine.
  const media = http.createServer((req, res) => { res.writeHead(206); res.end('x'); });
  await new Promise((r) => media.listen(0, '127.0.0.1', r));
  t.after(() => media.close());
  const created = [];
  const tunelio = { enabled: true, credits: null, async create(id, q) { created.push(id); return { url: `http://127.0.0.1:${media.address().port}/tunnel?id=${id}&q=${q}`, expires: Math.floor(Date.now() / 1000) + 3600, quality: q, fileSize: 1e8 }; } };
  const a = createApp({ config: { ...base, shards: 1, pool: 200, tunelioQuality: '720p', ticketPlayerHoldMs: 5000, videoMaxSeconds: 43200, searchesPerMinutePerIp: 500,
    lookupWarm: false, adaptiveHls: false, homeEnabled: false, metricsPath: null, spendHourCredits: 0, spendDayCredits: 0, spendBuildsPerMinutePerIp: 1, spendBuildsPerMinutePerShard: 0,
    trustedIps: HOME, trustedIpFactor: 2 }, store, youtube, tunelio, captions: { async get() { return { available: false }; } }, log: () => {} });
  const server = http.createServer(a);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const get = (p, ip, ua) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': ip } });
  const play = async (i, ip) => {
    const n = (await (await get(`/v1/0/s?l=en&q=${vid(i)}`, ip, UNITY)).json()).results[0].t;
    return (await get(`/v1/0/${n}`, ip, WMF)).headers.get('location');
  };
  assert.match(await play(1, HOME), /\/tunnel/);
  assert.match(await play(2, HOME), /\/tunnel/);
  assert.match(await play(3, HOME), /youtube\.com/, 'trusted: 1 × 2');
  assert.match(await play(4, OTHER), /\/tunnel/);
  assert.match(await play(5, OTHER), /youtube\.com/, 'untrusted: 1');
  assert.deepEqual(created, [vid(1), vid(2), vid(4)]);
});
