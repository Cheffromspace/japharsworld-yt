import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { ChannelSlots } from '../src/channels.js';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { Playback } from '../src/playback.js';
import { Store } from '../src/store.js';
import { CAP_HOURS, END_AFTER, LIMITS, LINODE_PROBE, evaluate, issueBody, issueTitle, limits, logLine, parseProbe, plan, posts, streak, webhookFor } from '../infra-check/hypercare.mjs';

const kit = (f) => readFileSync(new URL(`../infra-check/${f}`, import.meta.url), 'utf8');

const normal = () => ({
  linode: parseProbe('unit:japharsworld-yt active\nunit:caddy active\ndisk 39\nbanned 0\ns5 0\nch503 0\nchmon 0\ntimeouts 0\nbuilt 4\nerrors 1\nyt 0\nbackoff 0\ncap0 1\ncap1 8\ncapv0 1\ncapv1 7\nevict 0\novercap 0\njournal ok\n'),
  optiplex: { 'unit:japharsworld-yt-relay': 'active', 'unit:bgutil-pot-relay': 'active', 'unit:japharsworld-yt-slotworker.timer': 'active', slotworker_result: 'success' },
  healthz: { ok: true, detail: 'HTTP 200.' },
});

test('hypercare: a normal hour has no findings and logs one line of counts', () => {
  const m = normal();
  assert.equal(m.linode.disk, 39);
  assert.deepEqual(evaluate(m, LIMITS), []);
  const line = JSON.parse(logLine(m, []));
  assert.equal(line.event, 'hypercare');
  assert.equal(line.ok, true);
  assert.equal('mediamtx' in line, false, 'MediaMTX is not checked any more (#38)');
});

test('hypercare: each abnormal reading is one finding, and only owner actions become owner tasks', () => {
  const m = normal();
  Object.assign(m.linode, { 'unit:caddy': 'failed', disk: 91, s5: 4, ch503: 10, chmon: 1, timeouts: 3, built: 0, errors: 9, yt: 5, backoff: 1, cap0: 6, cap1: 0, capv0: 6, capv1: 0, evict: 30, overcap: 2, banned: 25 });
  m.optiplex['unit:bgutil-pot-relay'] = 'inactive';
  m.optiplex.slotworker_result = 'exit-code';
  m.healthz = { ok: false, detail: 'HTTP 502.' };
  const f = evaluate(m, LIMITS);
  const keys = f.map((x) => x.key).sort();
  assert.deepEqual(keys, ['healthz', 'linode:5xx', 'linode:backoff', 'linode:banned', 'linode:build-timeouts', 'linode:captions', 'linode:channel-refused', 'linode:channel-status', 'linode:disk', 'linode:errors',
    'linode:evict', 'linode:overcap', 'linode:unit:caddy', 'linode:youtube', 'optiplex:slotworker-result', 'optiplex:unit:bgutil-pot-relay']);
  assert.deepEqual(f.filter((x) => x.owner).map((x) => x.key).sort(), ['healthz', 'linode:disk', 'linode:unit:caddy', 'optiplex:unit:bgutil-pot-relay']);
  // An unreachable host is one finding, not a unit storm.
  assert.deepEqual(evaluate({ linode: { error: 'ssh linode-check failed: timeout' } }, LIMITS).map((x) => x.key), ['probe:linode']);
  assert.equal(limits({ HYPERCARE_DISK: '70' }).DISK, 70);
  // The disk limit is Grafana's critical level: 2026-10-27 22:17's one reading at 80 % is not a finding, 88 % is.
  assert.equal(LIMITS.DISK, 88);
  assert.ok(!evaluate({ linode: { ...normal().linode, disk: 80 } }, LIMITS).length);
  assert.deepEqual(evaluate({ linode: { ...normal().linode, disk: 88 } }, LIMITS).map((x) => x.key), ['linode:disk']);
  assert.equal(limits({ HYPERCARE_DISK: '' }).DISK, LIMITS.DISK);
});

test('hypercare: new findings are filed once, repeated after 6 hours, and recovered ones reported', () => {
  const f = [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }];
  const now = 10 * 3600_000;
  const state = { open: { b: { since: 0, alerted: now - 7 * 3600_000, issue: 5 }, c: { since: 0, alerted: now - 60_000, issue: 6, title: 'C' } } };
  const p = plan(f, state, now);
  assert.deepEqual(p.fresh.map((x) => x.key), ['a']);
  assert.deepEqual(p.repeat.map((x) => x.key), ['b']);
  assert.deepEqual(p.recovered.map((x) => x.key), ['c']);
  assert.deepEqual(plan(f, { open: { a: { alerted: now - 60_000 }, b: { alerted: now - 60_000 } } }, now), { fresh: [], repeat: [], recovered: [] });
});

test('hypercare: 7 days of clean runs in a row end it, and any finding starts the count again (world #236)', () => {
  const H = 3600_000;
  let s = { open: {} };
  const step = (now, findings = []) => { s = { ...s, ...streak(s, findings, now) }; return s; };
  assert.deepEqual(step(0), { open: {}, clean: 1, cleanSince: 0, done: false }, 'a state file from before #236 starts at 1');
  for (let h = 1; h < 100; h++) step(h * H);
  assert.equal(step(100 * H, [{ key: 'linode:overcap' }]).clean, 0, 'a finding resets');
  assert.equal(s.cleanSince, null);
  for (let h = 101; h < 101 + END_AFTER.runs - 1; h++) assert.equal(step(h * H).done, false, `hour ${h}`);
  assert.equal(step((101 + END_AFTER.runs - 1) * H).done, true, '168 clean runs over 7 days');
  // Many runs in a short time (manual or catch-up) don't end it early.
  assert.equal(streak({ clean: 500, cleanSince: 0 }, [], 3 * 24 * H).done, false);
  const src = kit('hypercare.mjs');
  assert.match(src, /run\('systemctl', \['--user', 'disable', '--now', 'yt-hypercare\.timer'\]\)/, 'it disables its own user timer, nothing else');
  assert.match(src, /comment\(HYPERCARE_ISSUE, text, dry\)/);
  assert.match(src, /s\.done \? \{ clean: 0, cleanSince: null \}/, 're-enabled, it counts 7 days again');
  assert.match(src, /const HYPERCARE_ISSUE = 208;/);
  assert.match(src, /try \{ await discord\(`🟢 \*\*YT hypercare:\*\* \$\{text\}`, \{ mention: false, dry \}\); \} catch/, 'one quiet Discord line; a failed post still ends it');
});

test('hypercare: "Fix:" findings go to the critical channel, the rest to the usual one (world #195)', () => {
  const open = { a: { issue: 7, since: 0 }, b: { issue: 8, since: 0 }, c: { issue: 9, since: 0 } };
  const p = posts({ fresh: [{ key: 'a', owner: true, title: 'caddy is not active', detail: 'd' }, { key: 'b', owner: false, title: 'Errors', detail: 'd' }],
    repeat: [], recovered: [{ key: 'c', owner: true, title: 'Disk', issue: 9 }, { key: 'x', owner: false, title: 'Backoff', issue: 3 }] }, open);
  assert.deepEqual(p.map((x) => [x.critical, x.mention, x.text.slice(0, 22)]), [
    [true, true, '🔴 **YT hypercare:** 1'], [true, false, '🟢 **YT hypercare reco'], [false, true, '🔴 **YT hypercare:** 1'], [false, false, '🟢 **YT hypercare reco']]);
  assert.match(p[0].text, /caddy is not active.*#7\) \[owner task\]/);
  assert.doesNotMatch(p[2].text, /caddy/);
  assert.deepEqual(posts({ fresh: [], repeat: [], recovered: [] }, {}), [], 'quiet when normal');
  const env = { DISCORD_WEBHOOK_URL: 'usual', DISCORD_CRITICAL_WEBHOOK: 'critical' };
  assert.equal(webhookFor(true, env), 'critical');
  assert.equal(webhookFor(false, env), 'usual');
  assert.equal(webhookFor(true, { DISCORD_WEBHOOK_URL: 'usual' }), 'usual', 'unset: the usual channel');
});

test('hypercare: owner-task cards follow the world repo template and carry no addresses', () => {
  const m = normal();
  Object.assign(m.linode, { 'unit:caddy': 'failed', disk: 91 });
  m.optiplex['unit:japharsworld-yt-relay'] = 'failed';
  m.healthz = { ok: false, detail: 'No answer: ETIMEDOUT.' };
  m.linode.s5 = 9;
  for (const f of evaluate(m, LIMITS)) {
    const body = issueBody(f);
    assert.doesNotMatch(body, /\b\d{1,3}(\.\d{1,3}){3}\b/, f.key);
    assert.match(body, /world #208/, f.key);
    if (!f.owner) { assert.match(issueTitle(f), /^Hypercare: /); continue; }
    assert.match(issueTitle(f), /^Fix: /, 'the title starts with a verb');
    assert.match(body, /^\*\*Why:\*\* .*\n\*\*Time:\*\* about \d+ min · \*\*Where:\*\* .+ · \*\*Do first:\*\* /, f.key);
    assert.match(body, /### Steps\n- \[ \] 1\. /, f.key);
    assert.match(body, /### Done when\n/, f.key);
    assert.match(body, /### When finished\nClose this issue\./, f.key);
    for (const step of body.split('- [ ] ').slice(1)) assert.ok((step.match(/```/g) ?? []).length <= 2, `${f.key}: one copyable block a step`);
  }
});

test('hypercare: the five false captions alerts of world #257 stay quiet', () => {
  // [lookups in the hour with none, with tracks; distinct videos over 6 h with none, with tracks], replayed from the journal.
  const fired = [[7, 0, 4, 0], [4, 2, 3, 2], [4, 2, 8, 23], [9, 1, 14, 23], [3, 0, 11, 28]];
  for (const [cap0, cap1, capv0, capv1] of fired) {
    assert.deepEqual(evaluate({ linode: { ...normal().linode, cap0, cap1, capv0, capv1 } }, LIMITS), [], `${cap0}/${cap1}`);
  }
});

test('hypercare: many distinct videos with no tracks and none with tracks still fire', () => {
  assert.equal(LIMITS.CAP0, 5);
  const captions = (capv0, capv1, lim = LIMITS) => evaluate({ linode: { ...normal().linode, cap0: capv0, cap1: capv1, capv0, capv1 } }, lim).map((x) => x.key);
  assert.deepEqual(captions(5, 0), ['linode:captions']);
  assert.deepEqual(captions(40, 0), ['linode:captions']);
  assert.deepEqual(captions(4, 0), [], 'below the limit');
  assert.deepEqual(captions(40, 1), [], 'one video with tracks shows the chain works');
  assert.deepEqual(captions(3, 0, limits({ HYPERCARE_CAP0: '3' })), ['linode:captions'], 'the limit can be overridden');
  const [f] = evaluate({ linode: { ...normal().linode, capv0: 6, capv1: 0 } }, LIMITS);
  assert.match(f.detail, /6 distinct videos with no tracks and none with tracks in the last 6 hours/);
  assert.equal(JSON.parse(logLine({ linode: { capv0: 6, capv1: 0 } }, [f])).capv0, 6);
});

test('hypercare: the probe counts distinct videos over 6 hours, and no ID leaves the Linode', (t) => {
  assert.equal(CAP_HOURS, 6);
  const [hourly, prog] = [...LINODE_PROBE.matchAll(/--since (-\d+min) -o cat --no-pager \| awk '([^']*)'/g)].map((m) => m[2]);
  assert.deepEqual([...LINODE_PROBE.matchAll(/--since (-\d+min)/g)].map((m) => m[1]), ['-60min', '-360min'], 'the other counts stay hourly');
  assert.doesNotMatch(hourly, /capv/);
  const via = (id, tracks) => JSON.stringify({ at: 'x', event: 'captions_via', id, via: 'worker', tracks, cues: null });
  const count = (lines) => {
    const r = spawnSync('awk', [prog], { input: `${lines.join('\n')}\n`, encoding: 'utf8' });
    return r.error ? null : r.stdout;
  };
  const replays = count([via('aaa', 0), via('aaa', 0), via('aaa', 0), via('bbb', 0), via('ccc', 12), via('ddd', 1), via('ddd', 0)]);
  if (replays == null) return t.skip('no awk here');
  const p = parseProbe(replays);
  assert.deepEqual([p.capv0, p.capv1], [2, 2], 'replays count once; a video with tracks once is a video with tracks');
  const hour = spawnSync('awk', [hourly], { input: `${via('aaa', 0)}\n${via('aaa', 0)}\n${via('ccc', 12)}\n`, encoding: 'utf8' }).stdout;
  assert.deepEqual([parseProbe(hour).cap0, parseProbe(hour).cap1], [2, 1], 'the journal line still has the hour\'s lookups');
  assert.doesNotMatch(hour, /aaa|ccc/);
  assert.doesNotMatch(replays, /aaa|bbb|ccc|ddd/);
  const five = parseProbe(count(['a', 'b', 'c', 'd', 'e'].map((id) => via(id, 0))));
  assert.deepEqual([five.capv0, five.capv1], [5, 0]);
  assert.deepEqual(evaluate({ linode: { ...normal().linode, ...five } }, LIMITS).map((x) => x.key), ['linode:captions']);
  // The old rule's false alarm: one video replayed 7 times is one video.
  const one = parseProbe(count(Array(7).fill(via('a', 0))));
  assert.equal(one.capv0, 1);
  assert.deepEqual(evaluate({ linode: { ...normal().linode, ...one } }, LIMITS), []);
  assert.deepEqual([parseProbe(count(['{"event":"play"}'])).capv0, parseProbe(count(['{"event":"play"}'])).capv1], [0, 0], 'a quiet hour prints zeros');
});

test('hypercare: a refused Tunelio build counts as one error, not two (tunelio_error, then its build_failed)', (t) => {
  const prog = LINODE_PROBE.match(/awk '([^']*)'/)[1];
  const lines = [
    '{"event":"tunelio_error","id":"x","status":404}',
    '{"event":"build_failed","id":"x","reason":"tunelio_failed"}',
    '{"event":"build_failed","id":"y","reason":"build_failed","status":503}',
    '{"event":"home_failed","id":"z","reason":"uneven"}',
    '{"event":"play","id":"z"}',
  ].join('\n') + '\n';
  const r = spawnSync('awk', [prog], { input: lines, encoding: 'utf8' });
  if (r.error) return t.skip('no awk here');
  assert.match(r.stdout, /^errors 3$/m);
});

test('hypercare: the probe reads counts only, read only, and the units run the checkout hourly', () => {
  assert.doesNotMatch(LINODE_PROBE, /restart|systemctl (start|stop)|rm |(^|[^2])>\s*\//, 'writes nothing (2>/dev/null aside)');
  assert.match(LINODE_PROBE, /sudo -n fail2ban-client status sshd/, 'the one sudo command its rule allows');
  assert.match(LINODE_PROBE, /awk/, 'the journal is counted on the Linode, so no log line leaves it');
  const src = kit('hypercare.mjs');
  assert.match(src, /const MARK = '<!-- coordinator -->'/);
  assert.ok(src.includes('input: `${text}\\n\\n${MARK}`'), 'every comment ends with the marker');
  assert.doesNotMatch(src, /\b\d{1,3}(\.\d{1,3}){3}\b/, 'no addresses in the repo');
  assert.match(kit('yt-hypercare.service'), /^ExecStart=\/usr\/bin\/node \/opt\/japharsworld-yt-relay\/infra-check\/hypercare\.mjs$/m);
  assert.match(kit('yt-hypercare.timer'), /^OnCalendar=\*-\*-\* \*:17:00$/m);
});

// Everything-is-OK#863 (folding in #521): the journal lines come from the real server (its request lines and the
// channel refusal lines, src/channels.js), so the event name and the request line's shape are pinned across both files.
const hourlyProbe = () => LINODE_PROBE.match(/awk '([^']*)'/)[1];
const countJournal = (lines) => {
  const r = spawnSync('awk', [hourlyProbe()], { input: `${lines.join('\n')}\n`, encoding: 'utf8' });
  return r.error ? null : parseProbe(r.stdout);
};
const reqLine = (route, status) => JSON.stringify({ at: '2026-01-01T00:00:00.000Z', route, status, ms: 3 });
const findingsFor = (counts) => evaluate({ linode: { ...normal().linode, ...counts } }, LIMITS).map((x) => x.key);

// The search service with a monitor database whose slots table is `rows`, or none at `monitorDb` when rows is null.
async function channelServer(t, rows) {
  const dir = mkdtempSync(join(tmpdir(), 'hc-ch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const monitorDb = join(dir, 'monitor.db');
  if (rows) {
    const db = new DatabaseSync(monitorDb);
    db.exec(rows.schema);
    for (const r of rows.slots) db.prepare(`INSERT INTO slots VALUES (${r.map(() => '?').join(', ')})`).run(...r);
    db.close();
  }
  const lines = [];
  const channels = new ChannelSlots({ monitorDb, log: (o) => lines.push(JSON.stringify({ at: new Date().toISOString(), ...o })) });
  // Only the channel route runs; the rest are fakes, as in server.test.js, so nothing is written outside `dir`.
  const store = new Store({ path: ':memory:', shards: config.shards, pool: config.pool, pinHours: 24 });
  const youtube = { async search() { throw new Error('not used'); }, thumbnailUrl: (id) => id };
  const captions = { async get() { throw new Error('not used'); }, async tracks() { throw new Error('not used'); }, warm() {} };
  const app = createApp({ config: { ...config, monitorDb, dbPath: join(dir, 'tickets.db'), channelsUpstream: '', metricsPath: '' },
    store, youtube, captions, channels, log: (l) => lines.push(l) });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const requests = () => lines.filter((l) => l.includes('"route"')).length;
  const get = async (key) => {
    const before = requests();
    const res = await fetch(`${base}/v1/ch/${key}`, { redirect: 'manual' });
    await res.arrayBuffer();
    // The request line is written on 'finish', which can come just after the client has the answer.
    for (let i = 0; i < 200 && requests() === before; i++) await new Promise((r) => setTimeout(r, 5));
    return res.status;
  };
  return { get, lines };
}

const SLOTS = 'CREATE TABLE slots (key TEXT PRIMARY KEY, kind TEXT, current_video TEXT, baked_hidden INTEGER, auto_hidden INTEGER)';

test('hypercare (#863): three refused hidden Channels slots (503 by design) are not a 5xx finding; they are counted apart', async (t) => {
  if (!countJournal(['x'])) return t.skip('no awk here');
  const s = await channelServer(t, { schema: SLOTS, slots: [
    ['gta-vice-city', 'live', 'AAAAAAAAAAA', 0, 1], ['retroworld-ps1', 'live', 'BBBBBBBBBBB', 0, 1], ['jack-stardew', 'live', 'CCCCCCCCCCC', 1, 0],
    ['lofi-sleep-chill', 'live', 'DDDDDDDDDDD', 0, 0]] });
  // #862's hour: the deploy's three hidden-slot checks, and a shown slot playing.
  for (const key of ['gta-vice-city', 'retroworld-ps1', 'jack-stardew']) assert.equal(await s.get(key), 503, key);
  assert.equal(await s.get('lofi-sleep-chill'), 302);
  assert.equal(s.lines.filter((l) => /"route":"channel","status":503/.test(l)).length, 3, 'the real request lines');
  const c = countJournal(s.lines);
  assert.deepEqual([c.s5, c.ch503, c.chmon, c.errors], [0, 3, 0, 0]);
  assert.deepEqual(findingsFor(c), [], 'no "The search service answered 5xx" card (#862)');
  assert.doesNotMatch(JSON.stringify(c), /gta|retro|stardew|lofi|AAAA|DDDD/, 'counts only');
});

test('hypercare (#863): other 5xx still count, a Channels 5xx that is not 503 too', (t) => {
  const three502 = countJournal([reqLine('ticket', 502), reqLine('ticket', 502), reqLine('ticket', 502)]);
  if (!three502) return t.skip('no awk here');
  assert.deepEqual([three502.s5, three502.ch503], [3, 0]);
  assert.deepEqual(findingsFor(three502), ['linode:5xx']);
  // A throw on the channel route answers 500: that is a fault, not a refusal.
  const thrown = countJournal([reqLine('channel', 500), reqLine('channel', 500), reqLine('channel', 503), reqLine('search', 502)]);
  assert.deepEqual([thrown.s5, thrown.ch503], [3, 1]);
  assert.deepEqual(findingsFor(thrown), ['linode:5xx']);
});

test('hypercare (#863, #521): a monitor status the service can\'t read still raises a finding, from one visitor\'s single play', async (t) => {
  if (!countJournal(['x'])) return t.skip('no awk here');
  // A database without the hide columns: every slot refused, logged as status_unreadable (one line a minute).
  const old = await channelServer(t, { schema: 'CREATE TABLE slots (key TEXT PRIMARY KEY, kind TEXT, current_video TEXT)', slots: [['lofi-sleep-chill', 'live', 'DDDDDDDDDDD']] });
  assert.equal(await old.get('lofi-sleep-chill'), 503);
  let c = countJournal(old.lines);
  assert.ok(old.lines.some((l) => /"event":"channel_refused".*"why":"status_unreadable"/.test(l)));
  assert.deepEqual([c.s5, c.ch503, c.chmon], [0, 1, 1]);
  assert.deepEqual(findingsFor(c), ['linode:channel-status'], 'one refused play is enough: every Quest Channels play fails meanwhile');
  // One visitor retrying six loads in that minute: still one finding, the right one (six 503s, one status line).
  for (let i = 0; i < 5; i++) assert.equal(await old.get('lofi-sleep-chill'), 503);
  c = countJournal(old.lines);
  assert.deepEqual([c.s5, c.ch503, c.chmon], [0, 6, 1]);
  assert.deepEqual(findingsFor(c), ['linode:channel-status']);
  // Production with no database file at all: status_missing, the same finding.
  const gone = await channelServer(t, null);
  assert.equal(await gone.get('lofi-sleep-chill'), 503);
  assert.ok(gone.lines.some((l) => /"event":"channel_refused".*"why":"status_missing"/.test(l)));
  assert.deepEqual(findingsFor(countJournal(gone.lines)), ['linode:channel-status']);
  // A hide is not a monitor fault.
  assert.equal(countJournal(['{"event":"channel_refused","why":"hidden_by_monitor"}', '{"event":"channel_refused","why":"hidden_by_owner"}']).chmon, 0);
  const [f] = evaluate({ linode: { ...normal().linode, chmon: 1 } }, LIMITS);
  assert.equal(f.owner, false);
  assert.match(f.detail, /status_unreadable or status_missing/);
});

test('hypercare (#863): a burst of refused Channels slots over the limit raises its own finding', (t) => {
  const burst = (n) => countJournal(Array.from({ length: n }, () => reqLine('channel', 503)));
  const nine = burst(9);
  if (!nine) return t.skip('no awk here');
  assert.deepEqual(findingsFor(nine), [], 'one visitor\'s six retries and our three checks');
  const ten = burst(10);
  assert.deepEqual([ten.s5, ten.ch503], [0, 10]);
  assert.deepEqual(findingsFor(ten), ['linode:channel-refused']);
  assert.deepEqual([LIMITS.CH503, LIMITS.CHMON], [10, 1]);
  assert.deepEqual(evaluate({ linode: { ...normal().linode, ch503: 4 } }, limits({ HYPERCARE_CH503: '4' })).map((x) => x.key), ['linode:channel-refused'], 'overridable');
  const line = JSON.parse(logLine({ linode: { ...normal().linode, ...ten } }, []));
  assert.deepEqual([line.s5, line.ch503, line.chmon], [0, 10, 0]);
});

// Everything-is-OK#904: the 5xx count took every journal line with "status":5xx, event lines too, so a provider build
// timeout (`build_failed` with status 524, Tunelio's answer after about 125 s) read as "The search service answered
// 5xx" (#903; #931) and was counted again as an error event (#932). The sample lines are made up, in the shapes of
// src/playback.js #finish and src/server.js's request line; no value comes from a real journal.
const AT = '2026-01-02T03:04:05.000Z';
const timedOut = (id) => JSON.stringify({ at: AT, event: 'build_failed', id, quality: '720p', hls: true, mb: 500, buildMs: 126000, seconds: 1500, reason: 'build_failed', status: 524 });
const linkLine = (id, cached = false) => JSON.stringify({ at: AT, event: 'tunelio_link', id, quality: '720p', hls: false, mb: 400, buildMs: cached ? 800 : 15000, seconds: 1200, reason: null, ...(cached ? { cached: true } : {}) });
const sixTimeouts = () => ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(timedOut);

test('hypercare (#904): three provider build timeouts are neither a 5xx nor error events; three ticket 502s still are a 5xx', (t) => {
  const c = countJournal([timedOut('a1'), timedOut('a2'), timedOut('a3'), linkLine('b1')]);
  if (!c) return t.skip('no awk here');
  assert.deepEqual([c.s5, c.errors, c.timeouts, c.built], [0, 0, 3, 1]);
  assert.deepEqual(findingsFor(c), [], '#903\'s hour: no "The search service answered 5xx" card');
  const three502 = countJournal([reqLine('ticket', 502), reqLine('ticket', 502), reqLine('ticket', 502)]);
  assert.deepEqual([three502.s5, three502.timeouts], [3, 0]);
  assert.deepEqual(findingsFor(three502), ['linode:5xx'], 'a real 5xx answer still fires');
});

test('hypercare (#904): a 5xx is a request line; an event line with a route and a 5xx status is not, a request line with 524 is', (t) => {
  // Event lines can carry a route (youtube_error, forced_limit, error: src/server.js), so "has a route" is not enough.
  const ev = JSON.stringify({ at: AT, event: 'youtube_error', route: 'search', status: 503, message: 'x' });
  const c = countJournal([ev, ev, ev]);
  if (!c) return t.skip('no awk here');
  assert.equal(c.s5, 0);
  assert.equal(c.yt, 3, 'still a YouTube refusal');
  // No route answers 524 today (inferred from src/), but a request line that did is a 5xx answer like any other.
  const r = countJournal([reqLine('hls', 524), reqLine('ticket', 524), reqLine('ticket', 500)]);
  assert.deepEqual([r.s5, r.timeouts], [3, 0]);
  assert.deepEqual(findingsFor(r), ['linode:5xx']);
});

test('hypercare (#904): events carrying an upstream status are not 5xx answers; the *_error ones are still error events', (t) => {
  const lines = [
    { event: 'tunelio_error', id: 'a1', status: 503, code: 'x', message: 'x' },
    { event: 'transcript_error', id: 'a2', lang: 'en', type: 'x', status: 502, code: 'x', message: 'x' },
    { event: 'adaptive_codec_error', id: 'a3', quality: '720p', status: 500, ms: 5 },
    { event: 'build_retry', id: 'a4', quality: '720p', mb: 900, attempt: 1, status: 503, ms: 115000 },
    { event: 'channel_upstream', outcome: 'unavailable', status: 503, ms: 40, fallback: false },
    { event: 'tunelio_probe', format: 'hls', pair: 'x', quality: '720p', id: 'a5', ok: false, step: 'create', status: 500, code: 'x' },
    { event: 'tunelio_drop_open', ok: false, attempt: 1, status: 502, offsetOk: false, ttfbMs: 0, error: 'x' },
  ].map((o) => JSON.stringify({ at: AT, ...o }));
  const c = countJournal(lines);
  if (!c) return t.skip('no awk here');
  assert.deepEqual([c.s5, c.errors, c.timeouts], [0, 3, 0]);
  assert.deepEqual(findingsFor(c), []);
});

test('hypercare (#904): one burst of build timeouts raises one card at most, and only when no new Tunelio build succeeded in the hour', (t) => {
  const ok = (n) => Array.from({ length: n }, () => reqLine('ticket', 200));
  // #931's hour: six timeouts, a fresh build that worked, normal requests: no card (it filed two).
  const burst = countJournal([...ok(5), ...sixTimeouts(), linkLine('b1'), ...ok(5)]);
  if (!burst) return t.skip('no awk here');
  assert.deepEqual([burst.s5, burst.errors, burst.timeouts, burst.built], [0, 0, 6, 1]);
  assert.deepEqual(findingsFor(burst), []);
  // No build succeeded: one card, never the 5xx or error card as well.
  const dead = countJournal([...ok(5), ...sixTimeouts()]);
  assert.deepEqual(findingsFor(dead), ['linode:build-timeouts']);
  const [f] = evaluate({ linode: { ...normal().linode, ...dead } }, LIMITS);
  assert.equal(f.owner, false);
  assert.equal(issueTitle(f), 'Hypercare: Video builds are timing out at Tunelio');
  assert.equal(f.detail, '6 video builds timed out at Tunelio (build_failed, status 524) in the last hour and no new Tunelio build succeeded (limit 3 with none built). A 524 is Tunelio\'s answer after about 125 s, not this service\'s.');
  assert.deepEqual(findingsFor(countJournal([timedOut('a1'), timedOut('a2')])), [], 'two are under the limit');
  assert.equal(LIMITS.BUILD524, 3);
  assert.deepEqual(evaluate({ linode: { ...normal().linode, timeouts: 2, built: 0 } }, limits({ HYPERCARE_BUILD524: '2' })).map((x) => x.key), ['linode:build-timeouts'], 'overridable');
  const line = JSON.parse(logLine({ linode: { ...normal().linode, ...dead } }, [f]));
  assert.deepEqual([line.s5, line.errors, line.timeouts, line.built], [0, 0, 6, 0]);
});

test('hypercare (#904): only a 524 leaves the error count; a failed build with status 503 or 0 (no answer) is still an error event', (t) => {
  const failed = (id, status, error) => JSON.stringify({ at: AT, event: 'build_failed', id, quality: '720p', hls: false, mb: 500, buildMs: 115000, seconds: 1500, reason: 'build_failed', status, ...(error ? { error } : {}) });
  const c = countJournal([failed('c1', 503), failed('c2', 0, 'TimeoutError'), timedOut('c3')]);
  if (!c) return t.skip('no awk here');
  assert.deepEqual([c.errors, c.timeouts, c.s5], [2, 1, 0]);
  const five = countJournal([failed('c1', 503), failed('c2', 503), failed('c3', 0, 'TimeoutError'), failed('c4', 0, 'TimeoutError'), failed('c5', 503)]);
  assert.deepEqual(findingsFor(five), ['linode:errors'], 'five real build failures still file the errors card');
});

test('hypercare (#904): a cached link is not a new build, so timeouts with only cached links in the hour still fire', (t) => {
  const c = countJournal([...sixTimeouts(), linkLine('b1', true), linkLine('b2', true)]);
  if (!c) return t.skip('no awk here');
  assert.deepEqual([c.timeouts, c.built], [6, 0]);
  assert.deepEqual(findingsFor(c), ['linode:build-timeouts']);
});

test('hypercare (#904): the real Playback\'s own lines: a timed-out build counts as a timeout, a fresh link as built, a cached one not', async (t) => {
  if (!countJournal(['x'])) return t.skip('no awk here');
  // Playback logs through the injected log; src/server.js wraps each object as logJson does ({ at, ...o }).
  const lines = [];
  let now = 1_000_000;
  let answer = { ok: false, refused: false, status: 524 };
  let buildMs = 126_000;
  const tunelio = { enabled: true, async create(id, quality) { return { url: `https://tunelio.invalid/tunnel?id=${id}`, expires: 9e9, quality, fileSize: 500e6 }; } };
  const probe = async () => { now += buildMs; return answer; };
  const playback = new Playback({ tunelio, quality: '720p', probe, now: () => now, log: (o) => lines.push(JSON.stringify({ at: AT, ...o })) });
  await playback.start({ id: 'v1', seconds: 1500 }, '720p', { hls: true }).promise;
  answer = { ok: true, refused: false, status: 200 };
  buildMs = 20_000;
  await playback.start({ id: 'v2', seconds: 1500 }, '720p', { hls: true }).promise;
  buildMs = 500;
  await playback.start({ id: 'v3', seconds: 1500 }, '720p', { hls: true }).promise;
  assert.ok(lines.some((l) => /"event":"build_failed".*"status":524/.test(l)), 'the real line carries status 524');
  assert.ok(lines.some((l) => /"event":"tunelio_link".*"cached":true/.test(l)), 'and the real cached flag');
  const c = countJournal(lines);
  assert.deepEqual([c.s5, c.errors, c.timeouts, c.built], [0, 0, 1, 1]);
});
