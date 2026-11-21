// The alert rules that replaced the hourly hypercare timer's journal counts (Everything-is-OK#967, owner 2026-11-21: "stop
// the hypercare loop and fold anything useful into grafana"), evaluated as Grafana would (condition A > 0) over made-up
// series with test/promql-lite.mjs, so each test runs the rule's real expression. Times are 2026-11-21 (unix seconds).
// The day's two alarms (Grafana's "Caption lookups failing" at about 16:14Z, hypercare #966 at 16:17Z) came from one
// video in one room that YouTube had not finished processing, during the home worker's crash (down about 5 s at 16:12Z,
// world #968). The fixtures keep the day's shape in whole minutes, not its real times (no journal second goes in this
// public repo), and carry counts only: no video, room or visitor.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { alertRules } from '../tools/grafana.mjs';
import { counter, firing, gauge } from './promql-lite.mjs';

const at = (hhmmss) => { const [h, m, s = 0] = hhmmss.split(':').map(Number); return Date.UTC(2026, 10, 21, h, m, s) / 1000; };
const DAY = { from: at('00:00'), to: at('23:59') };
const rules = Object.fromEntries(alertRules('ds').map((r) => [r.uid, r]));
const expr = (uid) => { assert.ok(rules[uid], `rule ${uid} exists`); return rules[uid].data[0].model.expr; };
const ev = (metric, key, times, labels = {}) => counter({ __name__: 'eiok_events_total', host: 'linode', job: 'eiok', metric, key, ...labels }, times.map(at), DAY);
const fires = (uid, series, when) => firing(expr(uid), series, at(when));

// The shape of 2026-11-21's captions counters (from the exporter's lines and the journal's caption events, 09:30Z-16:16Z):
// four "not available right now" answers within a second, one room and one video, about two minutes before the alert;
// seven fetches that worked earlier in the day. With stage 2 the service also counts that one video once (video_fail).
const captionsDay = () => [
  ev('cc_unavailable', 'temporarily_unavailable', ['16:12', '16:12', '16:12', '16:12']),
  ev('cc_unavailable', 'failed', []),
  ev('cc_via', 'worker', ['09:45', '10:05', '10:25', '11:10', '15:20', '15:25', '15:50']),
  ev('video_fail', 'captions', ['16:12']),
];

test('eiok-captions-failing (#967): one video in one room is quiet; the rule before #967 fired on it', () => {
  // The rule before #967 fired here (the 16:14Z alert): 4 answers >= 3.
  const before = 'sum(increase(eiok_events_total{env!="staging",metric="cc_unavailable",key=~"temporarily_unavailable|failed"}[6h])) >= 3';
  assert.equal(firing(before, captionsDay(), at('16:14')).length, 1, 'the old rule fires on the fixture');
  assert.deepEqual(fires('eiok-captions-failing', captionsDay(), '16:14'), []);
  assert.deepEqual(fires('eiok-captions-failing', captionsDay(), '17:00'), []);
  // Two stuck videos in 6 h: still quiet.
  assert.deepEqual(fires('eiok-captions-failing', [ev('video_fail', 'captions', ['12:00', '16:12'])], '16:14'), []);
});

test('eiok-captions-failing (#967): 3 different videos with no captions in 6 h fire, even while other videos\' captions work', () => {
  // The home worker's captions break after 12:00Z: each video visitors ask for afterwards counts once.
  const broken = [ev('video_fail', 'captions', ['12:30', '13:10', '14:05']), ev('cc_via', 'worker', ['13:00', '13:50'])];
  assert.deepEqual(fires('eiok-captions-failing', broken, '13:30'), [], 'two videos so far');
  const f = fires('eiok-captions-failing', broken, '14:10');
  assert.equal(f.length, 1);
  assert.equal(f[0].value, 3);
  assert.deepEqual(fires('eiok-captions-failing', broken, '19:00'), [], 'the first left the 6 h window');
});

test('eiok-builds-failing (#967): builds of 3 different videos failing fire only when nothing built in the hour', () => {
  const failed = ev('video_fail', 'build', ['10:05', '10:20', '10:40']);
  assert.equal(fires('eiok-builds-failing', [failed, ev('build', 'ok', [])], '10:45').length, 1, 'Tunelio building nothing');
  assert.deepEqual(fires('eiok-builds-failing', [failed, ev('build', 'ok', ['10:30'])], '10:45'), [], 'a build worked in the hour (the 2026-11-19/20/21 bursts of 524s each had one)');
  assert.deepEqual(fires('eiok-builds-failing', [ev('video_fail', 'build', ['10:05', '10:20']), ev('build', 'ok', [])], '10:45'), [], 'two videos');
});

test('eiok-builds-failing (#967): the provider refusing a video (tunelio_failed, its 409 "not ready") is not a video_fail, so it never counts', () => {
  // 15:17Z-16:17Z of 2026-11-21: one video refused by Tunelio 4 times (no video_fail: src/server.js counts build_failed
  // only, test/videofail.test.js), and two warm-up builds of other videos timed out (524): two videos, under 3.
  const day = [ev('video_fail', 'build', ['15:24', '15:24']), ev('play_fallback', 'tunelio_failed', ['16:11']), ev('build', 'ok', [])];
  assert.deepEqual(fires('eiok-builds-failing', day, '16:17'), []);
});

test('eiok-home-failing (#967): one video failing at home is quiet; 3 different videos with nothing ready fire', () => {
  assert.deepEqual(fires('eiok-home-failing', [ev('video_fail', 'home', ['16:11']), ev('home', 'ready', ['15:30'])], '16:17'), [], 'today: one video');
  assert.equal(fires('eiok-home-failing', [ev('video_fail', 'home', ['16:01', '16:05', '16:12']), ev('home', 'ready', ['14:00'])], '16:17').length, 1);
  assert.deepEqual(fires('eiok-home-failing', [ev('video_fail', 'home', ['16:01', '16:05', '16:12']), ev('home', 'ready', ['16:08'])], '16:17'), [], 'one got ready');
  // The per-session count of one stuck video retried every minute (RETRY_MS) is not what this reads.
  assert.deepEqual(fires('eiok-home-failing', [ev('home', 'failed', ['16:01', '16:02', '16:03', '16:04']), ev('video_fail', 'home', ['16:01']), ev('home', 'ready', [])], '16:17'), []);
});

test('eiok-server-errors (#967): the first request a route answered 5xx without meaning to fires, critical, naming the route', () => {
  const day = [ev('http_5xx', 'ticket', ['12:00']), ev('http_5xx', 'captions', [])];
  const f = fires('eiok-server-errors', day, '12:01');
  assert.deepEqual(f.map((x) => [x.labels.key, x.value]), [['ticket', 1]]);
  assert.deepEqual(fires('eiok-server-errors', day, '12:20'), [], 'clears after 15 minutes');
  assert.deepEqual(fires('eiok-server-errors', [ev('http_5xx', 'ticket', [])], '12:01'), []);
  assert.equal(rules['eiok-server-errors'].labels.severity, 'critical');
  assert.equal(rules['eiok-server-errors'].for, '0m');
});

test('eiok-channels-unreadable (#967, hypercare\'s CHMON of #863): one play refused for an unreadable monitor status fires', () => {
  assert.equal(fires('eiok-channels-unreadable', [ev('channel', 'unreadable', ['16:00'])], '16:01').length, 1);
  assert.deepEqual(fires('eiok-channels-unreadable', [ev('channel', 'unreadable', []), ev('channel', 'unavailable', ['16:00'])], '16:01'), [], 'a hidden slot is not this');
});

test('eiok-channels-refused (#967, hypercare\'s CH503 of #863): 9 refused Channels plays in an hour are quiet, 10 fire', () => {
  const minutes = (n) => Array.from({ length: n }, (_, i) => `16:${String(10 + i).padStart(2, '0')}`);
  assert.deepEqual(fires('eiok-channels-refused', [ev('channel', 'unavailable', minutes(9))], '16:30'), []);
  assert.equal(fires('eiok-channels-refused', [ev('channel', 'unavailable', minutes(10))], '16:30').length, 1);
  assert.deepEqual(fires('eiok-channels-refused', [ev('channel', 'redirect', minutes(30))], '16:30'), [], 'redirects are plays that worked');
});

// systemd's restart counter per service, as Alloy's systemd collector exports it with enable_restarts (deploy/alloy).
const restarts = (host, name, times, labels = {}) => counter({ __name__: 'node_systemd_service_restart_total', host, name, ...labels }, times.map(at), DAY);

test('eiok-unit-restarted (#967): the home worker\'s crash of 2026-11-21 fires, naming the unit and the host (world #968)', () => {
  // "Scheduled restart job, restart counter is at 1" at 16:12Z (the Optiplex's journal, read by service-deploy2).
  const day = [restarts('optiplex', 'japharsworld-yt-relay.service', ['16:12']), restarts('linode', 'japharsworld-yt.service', [])];
  const f = fires('eiok-unit-restarted', day, '16:13');
  assert.deepEqual(f.map((x) => x.labels), [{ host: 'optiplex', name: 'japharsworld-yt-relay.service' }]);
  assert.equal(f[0].value, 1);
  assert.deepEqual(fires('eiok-unit-restarted', day, '16:11'), [], 'not before it');
  assert.deepEqual(fires('eiok-unit-restarted', day, '16:30'), [], 'and it clears after 15 minutes');
  assert.equal(rules['eiok-unit-restarted'].labels.severity, 'critical');
  assert.equal(rules['eiok-unit-restarted'].for, '0m');
  assert.match(rules['eiok-unit-restarted'].annotations.summary, /\{\{ \$labels\.name \}\} on \{\{ \$labels\.host \}\} stopped on its own and systemd started it again, in the 15 minutes before this alert/);
});

test('eiok-unit-restarted (#967): the search service crashing fires too; other units, staging and an unchanged count do not', () => {
  assert.deepEqual(fires('eiok-unit-restarted', [restarts('linode', 'japharsworld-yt.service', ['03:00'])], '03:05').map((x) => x.labels), [{ host: 'linode', name: 'japharsworld-yt.service' }]);
  assert.deepEqual(fires('eiok-unit-restarted', [restarts('optiplex', 'japharsworld-yt-relay-staging.service', ['03:00'])], '03:05'), [], 'the staging worker');
  assert.deepEqual(fires('eiok-unit-restarted', [restarts('linode', 'japharsworld-yt-exporter.service', ['03:00'])], '03:05'), [], 'the exporter');
  assert.deepEqual(fires('eiok-unit-restarted', [restarts('staging', 'japharsworld-yt.service', ['03:00'], { env: 'staging' })], '03:05'), [], 'the staging VPS');
  // A counter that was already above 0 when Alloy first read it (the worker's 1 after today's crash) is not a restart.
  assert.deepEqual(fires('eiok-unit-restarted', [counter({ __name__: 'node_systemd_service_restart_total', host: 'optiplex', name: 'japharsworld-yt-relay.service' }, [], { ...DAY, start: 1 })], '18:00'), []);
});

const memory = (group, type, bytes) => gauge({ __name__: 'namedprocess_namegroup_memory_bytes', host: 'optiplex', groupname: group, memtype: type, instance: 'optiplex' }, () => bytes, DAY);
const GiB = 1024 ** 3;

test('eiok-home-worker-memory (#967): the production worker over 70 % of its 1 GiB fires (warning, after 30 minutes); the staging worker does not', () => {
  assert.equal(fires('eiok-home-worker-memory', [memory('relay', 'resident', 0.6 * GiB), memory('relay', 'swapped', 0.15 * GiB)], '12:00').length, 1, 'resident + swapped');
  assert.deepEqual(fires('eiok-home-worker-memory', [memory('relay', 'resident', 0.5 * GiB), memory('relay', 'swapped', 0.1 * GiB)], '12:00'), []);
  assert.deepEqual(fires('eiok-home-worker-memory', [memory('relay-staging', 'resident', 0.95 * GiB), memory('relay', 'resident', 0.3 * GiB)], '12:00'), []);
  assert.equal(rules['eiok-home-worker-memory'].for, '30m');
  assert.equal(rules['eiok-home-worker-memory'].labels.severity, 'warning');
  assert.match(rules['eiok-home-worker-memory'].annotations.summary, /^The home worker's memory is at its limit: /);
});

test('alert inputs missing (#967): the crash-restart, worker-memory, video_fail and http_5xx series are inputs, so a config or exporter that stopped sending them shows', () => {
  const present = [
    gauge({ __name__: 'eiok_home_today', key: 'cap_builds' }, () => 60, DAY), gauge({ __name__: 'eiok_service_memory_limit_bytes' }, () => 1, DAY),
    gauge({ __name__: 'eiok_poll', source: 'tunelio_plan', metric: 'days_to_renewal' }, () => 9, DAY), ev('cc_outcome', 'none', []),
    restarts('linode', 'japharsworld-yt.service', []), restarts('optiplex', 'japharsworld-yt-relay.service', []), memory('relay', 'resident', 0.3 * GiB),
    ev('video_fail', 'captions', []), ev('http_5xx', 'ticket', []),
  ];
  assert.deepEqual(fires('eiok-alert-inputs-missing', present, '12:00'), []);
  for (const i of [4, 5, 6, 7, 8]) assert.equal(fires('eiok-alert-inputs-missing', present.filter((_, j) => j !== i), '12:00').length, 1, `input ${i} missing`);
});

// Item 5 of #967: the hard alarms stay as they were and still fire at once.
test('hard alarms (#967): search service down, public address down, no home worker still fire', () => {
  const up = (v) => gauge({ __name__: 'eiok_search_up', host: 'linode' }, (t) => (t >= at('12:00') ? v : 1), DAY);
  assert.equal(fires('eiok-search-down', [up(0)], '12:06').length, 1);
  assert.deepEqual(fires('eiok-search-down', [up(1)], '12:06'), []);
  assert.equal(rules['eiok-search-down'].labels.severity, 'critical');
  const probe = gauge({ __name__: 'probe_success', job: 'integrations/blackbox/search-healthz', host: 'linode' }, (t) => (t >= at('12:00') ? 0 : 1), DAY);
  assert.equal(fires('eiok-public-down', [probe], '12:11').length, 1);
  assert.equal(rules['eiok-public-down'].labels.severity, 'critical');
  const workers = gauge({ __name__: 'eiok_home_today', key: 'workers', host: 'linode' }, (t) => (t >= at('12:00') ? 0 : 1), DAY);
  assert.equal(fires('eiok-home-worker', [workers], '12:05').length, 1);
  assert.equal(rules['eiok-home-worker'].for, '15m');
});

test('every rule of #967 explains itself: what it counted, what does not fire it, where to look', () => {
  for (const uid of ['eiok-captions-failing', 'eiok-builds-failing', 'eiok-home-failing']) {
    const s = rules[uid].annotations.summary;
    assert.match(s, /\{\{ humanize \$values\.A\.Value \}\} different videos/, `${uid}: the number counted, in videos`);
    assert.match(s, /One video .* does not fire this/, `${uid}: what does not fire it`);
    assert.match(s, /Look: `node tools\/ops\.mjs events --event /, `${uid}: where to look`);
  }
  for (const uid of ['eiok-server-errors', 'eiok-channels-unreadable', 'eiok-channels-refused']) {
    assert.match(rules[uid].annotations.summary, /\{\{ humanize \$values\.A\.Value \}\}.*Look: `node tools\/ops\.mjs events --event /, uid);
  }
  assert.equal(rules['eiok-captions-failing'].annotations.summary, 'Captions are failing: {{ humanize $values.A.Value }} different videos got no captions when visitors asked, in the last 6 hours (each video counted once, however often it was asked for). One video YouTube can\'t serve does not fire this. Look: `node tools/ops.mjs events --event captions_source_failed,captions_via`, the Captions panel, and whether the home worker restarted (eiok-unit-restarted).');
  assert.equal(rules['eiok-server-errors'].annotations.summary, '{{ humanize $values.A.Value }} {{ $labels.key }} requests were answered 5xx in the last 15 minutes: a fault in the search service (a route that threw), not a refusal it gives on purpose. Look: `node tools/ops.mjs events --event error` for the route and the error.');
});

// promql-lite's own semantics, where Prometheus' are easy to get wrong: an empty aggregation is empty (not 0), so
// "x unless on() <empty>" keeps x; comparisons filter; increase() survives a counter reset.
test('promql-lite: empty aggregations, unless/and on(), comparison filters and counter resets behave as in Prometheus', async () => {
  const { evaluate } = await import('./promql-lite.mjs');
  const s = [counter({ __name__: 'c', k: 'a' }, [at('10:00'), at('10:10')], DAY), { labels: { __name__: 'r' }, samples: [[at('10:00'), 5], [at('10:01'), 7], [at('10:02'), 1]] }];
  assert.deepEqual(evaluate('sum(increase(missing[1h]))', s, at('10:30')), []);
  assert.deepEqual(evaluate('sum(increase(c[1h])) unless on() sum(increase(missing[1h])) >= 1', s, at('10:30')).map((x) => x.value), [2]);
  assert.deepEqual(evaluate('sum(increase(c[1h])) unless on() sum(increase(c[1h])) >= 1', s, at('10:30')), []);
  assert.deepEqual(evaluate('sum(increase(c[1h])) and on() sum(increase(c[1h])) >= 1', s, at('10:30')).map((x) => x.value), [2]);
  assert.deepEqual(evaluate('sum(increase(c[1h])) >= 3', s, at('10:30')), []);
  assert.deepEqual(evaluate('increase(r[5m])', s, at('10:03')).map((x) => x.value), [3], '5 -> 7, then a reset to 1');
  assert.deepEqual(evaluate('1 - max(c)', s, at('10:30')).map((x) => x.value), [-1]);
  assert.deepEqual(evaluate('absent(missing)', s, at('10:30')).map((x) => x.value), [1]);
  assert.deepEqual(evaluate('absent(c)', s, at('10:30')), []);
});

// The Alloy configs that send what eiok-unit-restarted and eiok-home-worker-memory read (deploy/alloy/*.alloy).
const script = (f) => readFileSync(new URL(`../deploy/${f}`, import.meta.url), "utf8");

test('Alloy configs (#967): restart counters on every host, the worker memory on the Optiplex only, production worker by its script', () => {
  for (const host of ['linode', 'staging', 'optiplex']) {
    const a = script(`alloy/${host}.alloy`);
    assert.match(a, /systemd \{\n\s+unit_include = [^\n]+\n(\s+\/\/[^\n]*\n)?\s+enable_restarts = true\n\s+\}/, host);
    assert.match(a, /\|systemd_service_restart_total\|/, `${host}: kept by the relabel rule`);
  }
  const o = script('alloy/optiplex.alloy');
  // The file says worker\\.js: Alloy's string escape, so the regex Alloy gets is worker\.js.
  assert.ok(o.includes('    name    = "relay"\n    cmdline = ["^/opt/japharsworld-yt-relay/relay/worker\\\\.js$"]'), 'production worker group');
  assert.ok(o.includes('    name    = "relay-staging"\n    cmdline = ["^/opt/japharsworld-yt-relay-staging/relay/worker\\\\.js$"]'), 'staging worker group');
  assert.match(o, /gather_smaps\s+= false/);
  assert.match(o, /regex\s+= "namedprocess_namegroup_memory_bytes;\(resident\|swapped\)"/);
  // The ExecStart lines those matchers read.
  assert.match(script('japharsworld-yt-relay.service'), /^ExecStart=\/usr\/bin\/node \/opt\/japharsworld-yt-relay\/relay\/worker\.js$/m);
  assert.match(script('japharsworld-yt-relay-staging.service'), /^ExecStart=\/usr\/bin\/node \/opt\/japharsworld-yt-relay-staging\/relay\/worker\.js$/m);
  for (const host of ['linode', 'staging']) assert.doesNotMatch(script(`alloy/${host}.alloy`), /exporter\.process/, host);
});
