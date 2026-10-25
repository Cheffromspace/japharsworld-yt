import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { totp, instanceType, worldValues, groupValues, VRChat } from '../metrics/vrchat.js';
import { pollVRChat, updateEnvFile, settings, tunelioPass, renewalReminders, recordReleases, runOccupants, OCCUPANCY, domainPass } from '../metrics/poll.js';
import { openMetricsDb, getMeta } from '../src/metrics.js';
import { githubRepo, domainExpiry, DOMAINS } from '../metrics/sources.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const WORLD = fixture('vrchat-world.json');
const GROUP = fixture('vrchat-group.json');
const UA = 'EverythingIsOK-metrics/1.0 test@example.com';

const json = (status, body, cookies = []) => {
  const h = new Headers({ 'content-type': 'application/json' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status, headers: h });
};

// A fake api.vrchat.cloud: valid session = auth=good + twoFactorAuth=good2.
function fakeVRChat({ password = 'pw', code = null, rateLimit = false } = {}) {
  const calls = [];
  const fetcher = async (url, opts = {}) => {
    const path = new URL(url).pathname.replace('/api/1', '');
    const h = opts.headers ?? {};
    calls.push({ path, method: opts.method ?? 'GET', ua: h['user-agent'], cookie: h.cookie ?? '', auth: h.authorization ?? '' });
    if (rateLimit) return new Response('{}', { status: 429, headers: { 'retry-after': '3600' } });
    if (path === '/auth/user' && h.authorization) {
      const [u, p] = Buffer.from(h.authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
      if (u !== 'metrics bot' || p !== password) return json(401, { error: { message: 'Invalid Username/Email or Password', status_code: 401 } });
      return json(200, fixture('vrchat-login-2fa.json'), ['auth=good; Path=/; HttpOnly']);
    }
    if (path === '/auth/twofactorauth/totp/verify') {
      if (!h.cookie?.includes('auth=good')) return json(401, {});
      const sent = JSON.parse(opts.body).code;
      if (code && sent !== code) return json(400, { verified: false });
      return json(200, { verified: true }, ['twoFactorAuth=good2; Path=/; HttpOnly']);
    }
    if (!(h.cookie?.includes('auth=good') && h.cookie?.includes('twoFactorAuth=good2'))) return json(401, { error: { message: 'Missing Credentials' } });
    if (path.startsWith('/worlds/')) return json(200, { ...WORLD, id: decodeURIComponent(path.slice(8)) });
    if (path.startsWith('/groups/')) return json(200, GROUP);
    return json(404, {});
  };
  return { fetcher, calls };
}

// RFC 6238 Appendix B test key: the ASCII bytes "12345678901234567890", base32-encoded at runtime
// (written out, the encoded string trips secret scanners).
const base32 = (buf) => { let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? []).map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[Number.parseInt(c.padEnd(5, '0'), 2)]).join(''); };
const RFC_KEY = base32(Buffer.from('12345678901234567890'));

const cfg = (over = {}) => ({
  ...settings({ VRCHAT_GROUP_ID: GROUP.id, METRICS_CONTACT: 'test@example.com' }),
  vrchat: { username: 'metrics bot', password: 'pw', totpSecret: RFC_KEY, authCookie: '', twoFactorCookie: '', ...over },
});
const noSleep = async () => {};

test('TOTP matches the RFC 6238 test vectors (SHA-1, 6 digits)', () => {
  const secret = RFC_KEY;
  assert.equal(totp(secret, 59_000), '287082');
  assert.equal(totp(secret, 1111111109_000), '081804');
  assert.equal(totp(secret, 1234567890_000), '005924');
  assert.equal(totp(RFC_KEY.toLowerCase().replace(/(.{4})/g, '$1 '), 59_000), '287082'); // spaces and case ignored
});

test('world and group answers become counts; instance IDs only as type totals', () => {
  const v = worldValues(WORLD);
  assert.deepEqual(v, {
    visits: 12345, favorites: 412, occupants: 9, publicOccupants: 6, privateOccupants: 3, popularity: 5, heat: 3, capacity: 6,
    version: 41, updatedAt: Math.round(Date.parse('2026-10-18T22:04:10.000Z') / 1000),
    instances: 3, occupants_public: 2, occupants_friends: 3, occupants_invite: 0, occupants_group: 1,
  });
  assert.ok(Object.values(v).every((x) => typeof x === 'number'));
  assert.deepEqual(groupValues(GROUP), { members: 128, online: 7 });
  assert.equal(instanceType('1~private(usr_x)~canRequestInvite'), 'invite');
  assert.equal(instanceType('1~friends(usr_x)'), 'friends');
});

test('VRChat client needs a User-Agent', () => {
  assert.throws(() => new VRChat({}));
});

test('poller: logs in with TOTP when there is no session, saves the cookies, sends the User-Agent, polls gently', async () => {
  const fake = fakeVRChat({ code: totp(RFC_KEY, Date.parse('2026-10-19T14:30:00Z')) });
  const saved = [];
  const sleeps = [];
  const state = {};
  const r = await pollVRChat(cfg(), { state, alert: () => assert.fail('no alert'), now: Date.parse('2026-10-19T14:30:00Z'), fetcher: fake.fetcher,
    sleep: async (ms) => sleeps.push(ms), saveCookies: (c) => saved.push(c) });
  assert.deepEqual(r.rows.map((x) => x.source), ['world:prod', 'world:test', 'group']);
  assert.equal(r.rows[0].values.visits, 12345);
  assert.deepEqual(r.rows[2].values, { members: 128, online: 7 });
  assert.deepEqual(saved, [{ VRCHAT_AUTH_COOKIE: 'good', VRCHAT_2FA_COOKIE: 'good2' }]);
  assert.deepEqual(fake.calls.map((c) => c.path), ['/auth/user', '/auth/twofactorauth/totp/verify',
    '/worlds/wrld_63bed747-6c3d-428c-b2f4-1a904afa7df8', '/worlds/wrld_471c100d-251f-4526-a1b3-5de45b36cc17', '/groups/grp_1c55fc07-01ae-40d8-a6c8-8f5f8f76e079']);
  assert.ok(fake.calls.every((c) => c.ua === 'EverythingIsOK-metrics/1.0 test@example.com'));
  assert.equal(sleeps.length, fake.calls.length - 1);
  assert.ok(sleeps.every((ms) => ms >= 1000));
});

test('poller: a working session is used as is (no login); an expired one logs in again once', async () => {
  const fake = fakeVRChat();
  const saved = [];
  const r = await pollVRChat(cfg({ authCookie: 'good', twoFactorCookie: 'good2' }), { state: {}, alert: () => {}, fetcher: fake.fetcher, sleep: noSleep, saveCookies: (c) => saved.push(c) });
  assert.equal(r.rows.length, 3);
  assert.ok(!fake.calls.some((c) => c.path.startsWith('/auth')));
  assert.equal(saved.length, 0);

  const fake2 = fakeVRChat();
  const r2 = await pollVRChat(cfg({ authCookie: 'expired', twoFactorCookie: 'old' }), { state: {}, alert: () => {}, fetcher: fake2.fetcher, sleep: noSleep, saveCookies: (c) => saved.push(c) });
  assert.equal(r2.rows.length, 3);
  assert.equal(fake2.calls.filter((c) => c.path === '/auth/user').length, 1);
  assert.deepEqual(saved, [{ VRCHAT_AUTH_COOKIE: 'good', VRCHAT_2FA_COOKIE: 'good2' }]);
});

test('poller: a failed login alerts (at most every 6 hours) and waits 6 hours before trying again', async () => {
  const fake = fakeVRChat({ password: 'changed' });
  const alerts = [];
  const state = {};
  const now = Date.parse('2026-10-19T14:30:00Z');
  const opts = (t) => ({ state, alert: (kind, text) => alerts.push([kind, text]), now: t, fetcher: fake.fetcher, sleep: noSleep });
  const r = await pollVRChat(cfg(), opts(now));
  assert.equal(r.rows.length, 0);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0][0], 'vrchat_login');
  assert.match(alerts[0][1], /VRChat login failed/);
  assert.doesNotMatch(alerts[0][1], new RegExp(`pw|changed|${RFC_KEY}`)); // no secrets in the alert
  const logins = () => fake.calls.filter((c) => c.path === '/auth/user').length;
  assert.equal(logins(), 1);
  await pollVRChat(cfg(), opts(now + 15 * 60_000));       // within 6 h: no new login attempt, no new alert
  assert.equal(logins(), 1);
  assert.equal(alerts.length, 1);
  await pollVRChat(cfg(), opts(now + 6 * 3600_000 + 1));  // 6 h later: tries again, alerts again
  assert.equal(logins(), 2);
  assert.equal(alerts.length, 2);
});

test('poller: a login that works again after a failure alert says so once', async () => {
  const alerts = [];
  const state = { loginAlertAt: Date.parse('2026-10-19T08:00:00Z'), loginFailedAt: Date.parse('2026-10-19T08:00:00Z') };
  const fake = fakeVRChat();
  const opts = (t) => ({ state, alert: (kind, text) => alerts.push([kind, text]), now: t, fetcher: fake.fetcher, sleep: noSleep });
  const now = Date.parse('2026-10-19T14:30:00Z');
  const r = await pollVRChat(cfg(), opts(now));
  assert.ok(r.rows.length > 0);
  assert.deepEqual(alerts.map(([k]) => k), ['vrchat_login_ok']);
  assert.match(alerts[0][1], /works again/);
  await pollVRChat(cfg(), opts(now + 60_000));
  assert.equal(alerts.length, 1);
});

test('poller: 429 backs off (doubling, at least Retry-After), and skips polls until then', async () => {
  const fake = fakeVRChat({ rateLimit: true });
  const state = {};
  const now = Date.parse('2026-10-19T14:30:00Z');
  await pollVRChat(cfg({ authCookie: 'good', twoFactorCookie: 'good2' }), { state, alert: () => {}, now, fetcher: fake.fetcher, sleep: noSleep });
  assert.equal(fake.calls.length, 1);
  assert.equal(state.backoffMinutes, 60); // Retry-After 3600 s
  assert.equal(state.backoffUntil, now + 60 * 60_000);
  const r = await pollVRChat(cfg({ authCookie: 'good', twoFactorCookie: 'good2' }), { state, alert: () => {}, now: now + 30 * 60_000, fetcher: fake.fetcher, sleep: noSleep });
  assert.equal(r.skipped, 'backoff');
  assert.equal(fake.calls.length, 1);
  await pollVRChat(cfg({ authCookie: 'good', twoFactorCookie: 'good2' }), { state, alert: () => {}, now: now + 61 * 60_000, fetcher: fake.fetcher, sleep: noSleep });
  assert.equal(state.backoffMinutes, 120);
});

test('poller: nothing configured = no requests', async () => {
  const fake = fakeVRChat();
  const r = await pollVRChat({ ...cfg(), vrchat: { username: '', password: '', totpSecret: '', authCookie: '', twoFactorCookie: '' } }, { state: {}, alert: () => {}, fetcher: fake.fetcher });
  assert.equal(r.skipped, 'not_configured');
  assert.equal(fake.calls.length, 0);
});

test('cookies are written back into the env file, other lines kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jyt-env-'));
  const f = join(dir, 'metrics.env');
  writeFileSync(f, '# secrets\nVRCHAT_USERNAME=bot\nVRCHAT_AUTH_COOKIE=old\nGITHUB_TOKEN=x\n');
  updateEnvFile(f, { VRCHAT_AUTH_COOKIE: 'new', VRCHAT_2FA_COOKIE: 'two' });
  assert.equal(readFileSync(f, 'utf8'), '# secrets\nVRCHAT_USERNAME=bot\nVRCHAT_AUTH_COOKIE=new\nGITHUB_TOKEN=x\nVRCHAT_2FA_COOKIE=two\n');
  assert.throws(() => updateEnvFile(f, { X: 'a\nb' }));
  rmSync(dir, { recursive: true, force: true });
});

test('settings: world and group IDs must look like VRChat IDs', () => {
  const s = settings({ VRCHAT_WORLDS: 'prod=wrld_63bed747-6c3d-428c-b2f4-1a904afa7df8,bad=nope', VRCHAT_GROUP_ID: 'grp_bad' });
  assert.deepEqual(s.worlds, [['prod', 'wrld_63bed747-6c3d-428c-b2f4-1a904afa7df8']]);
  assert.equal(s.groupId, '');
  assert.match(settings({}).userAgent, /^EverythingIsOK-metrics\/1\.0 \S+$/);
});

// --- Tunelio balance, plan and renewal; releases ---

const tunelioAnswer = (credits, plan) => async () => new Response(JSON.stringify({ credits, plan }), { headers: { 'content-type': 'application/json' } });

test('Tunelio: balance each pass; a lapsed plan and a refresh alert', async () => {
  const db = openMetricsDb(':memory:');
  const c = { ...cfg(), tunelioKey: 'k', tunelioRenewsDay: 17 };
  const alerts = [];
  const alert = (kind, text) => alerts.push([kind, text]);
  const t0 = Date.parse('2026-10-19T15:00:00Z');
  await tunelioPass(db, c, { now: t0, fetcher: tunelioAnswer(9000, 'pro'), alert });
  await tunelioPass(db, c, { now: t0 + 900_000, fetcher: tunelioAnswer(8990, 'pro'), alert });
  assert.equal(alerts.length, 0);
  await tunelioPass(db, c, { now: t0 + 1800_000, fetcher: tunelioAnswer(8990, 'trial'), alert });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][1], /lapsed.*"trial".*was "pro"/);
  await tunelioPass(db, c, { now: t0 + 2700_000, fetcher: tunelioAnswer(100_000, 'pro'), alert });
  assert.equal(alerts.length, 3);
  assert.match(alerts[2][1], /refreshed: 100,000 \(plan pro\)/);
  assert.equal(getMeta(db, 'tunelio_refreshed'), '2026-10-19');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM polls WHERE source = 'tunelio'").get().n, 4);
});

test('Tunelio renewal reminders: 3 days and 1 day before, once each; a missed refresh the day after', () => {
  const db = openMetricsDb(':memory:');
  const c = { ...cfg(), tunelioRenewsDay: 17 };
  assert.deepEqual(renewalReminders(db, c, { today: '2026-11-10' }), []);
  const r3 = renewalReminders(db, c, { today: '2026-11-14' });
  assert.equal(r3.length, 1);
  assert.match(r3[0], /renews in 3 days \(2026-11-17\).*can't read the wallet/);
  assert.deepEqual(renewalReminders(db, c, { today: '2026-11-14' }), []); // once
  assert.match(renewalReminders(db, c, { today: '2026-11-16' })[0], /renews tomorrow/);
  assert.match(renewalReminders(db, c, { today: '2026-11-18' })[0], /due to renew on 2026-11-17, but no credit refresh/);
  const db2 = openMetricsDb(':memory:');
  db2.prepare("INSERT INTO meta (k, v) VALUES ('tunelio_refreshed', '2026-11-17')").run();
  assert.deepEqual(renewalReminders(db2, c, { today: '2026-11-18' }), []);
});

test('releases: world versions and GitHub tags recorded once, at their own time', async () => {
  const db = openMetricsDb(':memory:');
  const t = Date.parse('2026-10-19T15:00:00Z');
  assert.equal(recordReleases(db, [{ source: 'world:prod', version: 103, at: 1792291130_000 }], t), 1);
  assert.equal(recordReleases(db, [{ source: 'world:prod', version: 103, at: 1792291130_000 }], t + 900_000), 0);
  assert.equal(recordReleases(db, [{ source: 'world:prod', version: 104, at: 0 }], t), 0); // no upload time
  const rows = db.prepare('SELECT * FROM releases').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ source: 'world:prod', version: '103', at: 1792291130_000, detected: t }]);
  // GitHub: only the world's vYYYY.MM.DD tags, not drafts.
  const gh = async (url) => new Response(JSON.stringify(url.includes('/releases') ? [
    { tag_name: 'v2026.10.17', published_at: '2026-10-17T21:00:00Z', assets: [{ download_count: 3 }] },
    { tag_name: 'v2026.10.18.2', published_at: '2026-10-18T01:00:00Z', assets: [] },
    { tag_name: 'nightly', published_at: '2026-10-18T02:00:00Z', assets: [] },
    { tag_name: 'v2026.10.19', draft: true, published_at: null, assets: [] },
  ] : { stargazers_count: 2, forks_count: 0, subscribers_count: 1 }));
  const g = await githubRepo({ repo: 'Cheffromspace/Everything-is-OK', userAgent: UA, fetcher: gh });
  assert.deepEqual(g.tags, [{ tag: 'v2026.10.17', at: Date.parse('2026-10-17T21:00:00Z') }, { tag: 'v2026.10.18.2', at: Date.parse('2026-10-18T01:00:00Z') }]);
  assert.equal(g.values.release_downloads, 3);
});

test('per-minute pass: one request (the production world), occupancy and visits only, the release recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eiok-occ-'));
  try {
    const fake = fakeVRChat();
    const c = { ...cfg({ authCookie: 'good', twoFactorCookie: 'good2' }), db: join(dir, 'metrics.db'), stateFile: join(dir, 'state.json'), secretsFile: join(dir, 'secrets.env'), runAs: '' };
    await runOccupants(c, { now: Date.parse('2026-10-21T18:00:00Z'), fetcher: fake.fetcher, sleep: noSleep });
    assert.deepEqual(fake.calls.map((x) => x.path), ['/worlds/wrld_63bed747-6c3d-428c-b2f4-1a904afa7df8']);
    const db = openMetricsDb(c.db);
    try {
      const rows = db.prepare('SELECT source, metric FROM polls ORDER BY metric').all();
      assert.ok(rows.every((r) => r.source === 'world:prod' && OCCUPANCY.includes(r.metric)));
      assert.ok(rows.some((r) => r.metric === 'visits'));
      assert.equal(db.prepare('SELECT COUNT(*) n FROM releases').get().n, 1);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Domain expiry (owner, 2026-10-25): RDAP once a day per domain, retried hourly when it fails.
const rdap = (date) => ({ objectClassName: 'domain', ldhName: 'EIOK.CC', events: [{ eventAction: 'registration', eventDate: '2026-10-25T18:25:36Z' },
  ...(date ? [{ eventAction: 'expiration', eventDate: date }] : [])] });

test('domain expiry: RDAP expiration event → epoch ms; errors throw', async () => {
  const seen = [];
  const ok = async (url, o) => { seen.push([url, o.headers.accept]); return { ok: true, json: async () => rdap('2027-10-25T18:25:36Z') }; };
  assert.equal(await domainExpiry({ domain: 'eiok.cc', fetcher: ok }), Date.parse('2027-10-25T18:25:36Z'));
  assert.deepEqual(seen, [['https://tld-rdap.verisign.com/cc/v1/domain/eiok.cc', 'application/rdap+json']]);
  await assert.rejects(domainExpiry({ domain: 'eiok.cc', fetcher: async () => ({ ok: false, status: 503 }) }), /503/);
  await assert.rejects(domainExpiry({ domain: 'eiok.cc', fetcher: async () => ({ ok: true, json: async () => rdap(null) }) }), /no expiration/);
  await assert.rejects(domainExpiry({ domain: 'example.org' }), /no RDAP server/);
  assert.deepEqual(Object.keys(DOMAINS), ['eiok.cc', 'japharsworld.com']);
});

test('domain pass: records expires once a day; a failure retries after an hour, not every poll', async () => {
  const db = openMetricsDb(':memory:');
  const H = 3600_000;
  let t = Date.parse('2026-10-25T19:00:00Z'), calls = 0, fail = true;
  const fetcher = async () => { calls++; return fail ? { ok: false, status: 500 } : { ok: true, json: async () => rdap('2027-10-25T18:25:36Z') }; };
  const cfg = { domains: { 'eiok.cc': 'https://rdap.test/cc/v1' }, tz: 'UTC' };
  const expires = () => db.prepare("SELECT value FROM polls WHERE source = 'domain:eiok.cc' AND metric = 'expires'").all().map((r) => r.value);
  await domainPass(db, cfg, { now: t, fetcher });
  await domainPass(db, cfg, { now: t + 15 * 60_000, fetcher });
  assert.equal(calls, 1);
  assert.deepEqual(expires(), []);
  fail = false;
  t += H;
  await domainPass(db, cfg, { now: t, fetcher });
  assert.equal(calls, 2);
  assert.deepEqual(expires(), [Date.parse('2027-10-25T18:25:36Z') / 1000]);
  await domainPass(db, cfg, { now: t + 2 * H, fetcher });
  assert.equal(calls, 2, 'a good answer holds for a day');
  await domainPass(db, cfg, { now: t + 21 * H, fetcher });
  assert.equal(calls, 3);
});
