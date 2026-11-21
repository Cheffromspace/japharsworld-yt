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
// seven fetches that worked earlier in the day, and (as the worst case) none after 15:50.
const captionsDay = () => [
  ev('cc_unavailable', 'temporarily_unavailable', ['16:12', '16:12', '16:12', '16:12']),
  ev('cc_unavailable', 'failed', []),
  ev('cc_via', 'worker', ['09:45', '10:05', '10:25', '11:10', '15:20', '15:25', '15:50']),
];

test('eiok-captions-failing (#967): one room\'s burst for one video is quiet all evening, with or without other fetches; the rule before #967 fired on it', () => {
  // The rule before #967 fired here (the 16:14Z alert): 4 answers >= 3.
  const before = 'sum(increase(eiok_events_total{env!="staging",metric="cc_unavailable",key=~"temporarily_unavailable|failed"}[6h])) >= 3';
  assert.equal(firing(before, captionsDay(), at('16:14')).length, 1, 'the old rule fires on the fixture');
  // The verifier's case (M1): stage 1's first form fired 17:55Z-22:10Z here once no fetch had worked for 2 h.
  for (const when of ['16:14', '16:30', '17:00', '18:00', '20:00', '22:00']) assert.deepEqual(fires('eiok-captions-failing', captionsDay(), when), [], when);
  // The same room asking again an hour later about the same stuck video: two half-hours, still quiet.
  const again = [...captionsDay().slice(1), ev('cc_unavailable', 'temporarily_unavailable', ['16:12', '16:12', '16:12', '16:12', '17:20', '17:21'])];
  assert.deepEqual(fires('eiok-captions-failing', again, '18:00'), []);
  // A burst that crosses a half-hour mark fills two half-hours: quiet.
  assert.deepEqual(fires('eiok-captions-failing', [ev('cc_unavailable', 'temporarily_unavailable', ['16:28', '16:29', '16:31', '16:33'])], '17:00'), []);
});

test('eiok-captions-failing (#967): failures in 3 different half-hours of 6 h fire, whatever other videos do; at most half an hour late', () => {
  // The home worker's captions break after 12:00Z; visitors keep asking.
  const broken = [ev('cc_unavailable', 'temporarily_unavailable', ['12:10', '12:40', '12:45', '13:20']), ev('cc_unavailable', 'failed', []), ev('cc_via', 'worker', ['12:50', '13:10'])];
  assert.deepEqual(fires('eiok-captions-failing', broken, '13:25'), [], 'two half-hours so far (13:20 is seen at the 13:30 mark)');
  const f = fires('eiok-captions-failing', broken, '13:30');
  assert.equal(f.length, 1);
  assert.equal(f[0].value, 3, 'three half-hours');
  assert.equal(fires('eiok-captions-failing', broken, '18:00').length, 1, 'still inside 6 h');
  assert.deepEqual(fires('eiok-captions-failing', broken, '19:00'), [], 'the first half-hour left the 6 h');
  // A route that threw (cc_unavailable failed, 502) counts the same.
  assert.equal(fires('eiok-captions-failing', [ev('cc_unavailable', 'failed', ['15:00', '15:40', '16:10'])], '16:30').length, 1);
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

test('worker memory (#967, the coordinator\'s call on the verifier\'s M3): Alloy collects it, but no rule reads it until a day of readings is in', () => {
  assert.equal(rules['eiok-home-worker-memory'], undefined);
  assert.doesNotMatch(JSON.stringify(alertRules('ds')), /namedprocess_namegroup_memory_bytes/, 'no rule and no inputs-missing entry');
});

test('alert inputs missing (#967): the crash-restart, video_fail and http_5xx series are inputs, so a config or exporter that stopped sending them shows', () => {
  const present = [
    gauge({ __name__: 'eiok_home_today', key: 'cap_builds' }, () => 60, DAY), gauge({ __name__: 'eiok_service_memory_limit_bytes' }, () => 1, DAY),
    gauge({ __name__: 'eiok_poll', source: 'tunelio_plan', metric: 'days_to_renewal' }, () => 9, DAY), ev('cc_outcome', 'none', []),
    restarts('linode', 'japharsworld-yt.service', []), restarts('optiplex', 'japharsworld-yt-relay.service', []),
    ev('video_fail', 'captions', []), ev('http_5xx', 'ticket', []),
  ];
  assert.deepEqual(fires('eiok-alert-inputs-missing', present, '12:00'), []);
  for (const i of [4, 5, 6, 7]) assert.equal(fires('eiok-alert-inputs-missing', present.filter((_, j) => j !== i), '12:00').length, 1, `input ${i} missing`);
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
    assert.match(s, /\{\{ printf "%\.0f" \$values\.A\.Value \}\} different (videos|half-hours)/, `${uid}: the number counted, whole`);
    assert.match(s, /One (video|room) .* does not fire this/, `${uid}: what does not fire it`);
    assert.match(s, /Look: `node tools\/ops\.mjs events --event /, `${uid}: where to look`);
  }
  for (const uid of ['eiok-server-errors', 'eiok-channels-unreadable', 'eiok-channels-refused']) {
    assert.match(rules[uid].annotations.summary, /\{\{ printf "%\.0f" \$values\.A\.Value \}\}.*Look: `node tools\/ops\.mjs events --event /, uid);
  }
  // The verifier's L1: increase() extrapolates, so a count is shown whole (the texts themselves are pinned below).
  assert.doesNotMatch(JSON.stringify(alertRules('ds')), /humanize \$values/);
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

test('Alloy configs (#967): restart counters on every host; the Optiplex collects each relay worker\'s memory, matched on its real command line', () => {
  for (const host of ['linode', 'staging', 'optiplex']) {
    const a = script(`alloy/${host}.alloy`);
    assert.match(a, /systemd \{\n\s+unit_include = [^\n]+\n(\s+\/\/[^\n]*\n)?\s+enable_restarts = true\n\s+\}/, host);
    assert.match(a, /\|systemd_service_restart_total\|/, `${host}: kept by the relabel rule`);
  }
  const o = script('alloy/optiplex.alloy');
  // The verifier's H1: process-exporter v0.8.7 (what Alloy hands its matchers to) runs each cmdline regex on the whole
  // command line joined with spaces, argv[0] included. Each group's pattern, as Alloy reads the string (its \\ is one
  // backslash), must take its own unit's ExecStart joined that way, and not the other unit's; and argv[1] alone too.
  const pattern = (name) => {
    const m = o.match(new RegExp(`name\\s+= "${name}"\\n\\s+cmdline = \\["([^"]+)"\\]`));
    assert.ok(m, name);
    return new RegExp(m[1].replace(/\\\\/g, '\\'));
  };
  const execStart = (unit) => script(unit).match(/^ExecStart=(.+)$/m)[1].trim().split(/\s+/);
  const prod = execStart('japharsworld-yt-relay.service'), staging = execStart('japharsworld-yt-relay-staging.service');
  assert.deepEqual(prod, ['/usr/bin/node', '/opt/japharsworld-yt-relay/relay/worker.js']);
  for (const [group, own, other] of [['relay', prod, staging], ['relay-staging', staging, prod]]) {
    const re = pattern(group);
    assert.ok(re.test(own.join(' ')), `${group}: its own command line, joined`);
    assert.ok(re.test(own[1]), `${group}: and argv[1] alone`);
    assert.ok(!re.test(other.join(' ')) && !re.test(other[1]), `${group}: not the other worker`);
  }
  assert.match(o, /gather_smaps\s+= false/);
  assert.match(o, /track_children = false/, 'the worker alone, not its yt-dlp and ffmpeg children');
  assert.match(o, /regex\s+= "namedprocess_namegroup_memory_bytes;\(resident\|swapped\)"/);
  for (const host of ['linode', 'staging']) assert.doesNotMatch(script(`alloy/${host}.alloy`), /exporter\.process/, host);
});

// The owner reads these on a phone (#967 brief, item 4): every summary of the rules that replaced hypercare, word for word.
const SUMMARIES = {
  "eiok-captions-failing": "Captions are failing: caption requests got none in {{ printf \"%.0f\" $values.A.Value }} different half-hours of the last 6 hours. One room asking many times about one video YouTube can't serve fills one half-hour and does not fire this. Look: `node tools/ops.mjs events --event captions_source_failed,captions_via`, the Captions panel, and whether the home worker restarted (eiok-unit-restarted).",
  "eiok-builds-failing": "Tunelio builds are failing: {{ printf \"%.0f\" $values.A.Value }} different videos' builds failed or timed out in the last hour, and no Tunelio build succeeded in that hour. One video Tunelio refuses does not fire this. Look: `node tools/ops.mjs events --event build_failed,tunelio_error,tunelio_link` and the failed builds on the dashboard.",
  "eiok-home-failing": "The home relay is failing: {{ printf \"%.0f\" $values.A.Value }} different videos failed at home in the last hour and none got ready. One video that fails at home does not fire this. Look: `node tools/ops.mjs events --event home_failed,home_ready`, then `journalctl -u japharsworld-yt-relay -n 80` on the Optiplex.",
  "eiok-channels-refused": "{{ printf \"%.0f\" $values.A.Value }} Channels plays were refused in the last hour: slots the list hides (stale lists, our own checks). Look: `node tools/ops.mjs events --event channel_refused`.",
  "eiok-channels-unreadable": "The search service can't read the Channels monitor's status: {{ printf \"%.0f\" $values.A.Value }} Quest Channels plays were refused for it in the last hour, and every one will be until it is fixed. Look: `node tools/ops.mjs events --event channel_refused` (why status_unreadable or status_missing), then the monitor database on the Linode.",
  "eiok-server-errors": "{{ printf \"%.0f\" $values.A.Value }} {{ $labels.key }} requests were answered 5xx in the last 15 minutes: a fault in the search service (a route that threw), not a refusal it gives on purpose. Look: `node tools/ops.mjs events --event error` for the route and the error.",
  "eiok-unit-restarted": "{{ $labels.name }} on {{ $labels.host }} stopped on its own and systemd started it again, in the 15 minutes before this alert ({{ printf \"%.0f\" $values.A.Value }} time(s)). Plays and caption jobs it was holding were dropped. Look: `journalctl -u {{ $labels.name }} -n 80` on that host for why it stopped (out of memory, a crash).",
  "eiok-alert-inputs-missing": "A value that the build cap, service memory, credit pace, captions, crash-restart or server-errors alert needs has been missing for 30 minutes, so that alert is blind. Expected while the search service is down, and for a restart counter while its host is off. Otherwise check japharsworld-yt-exporter (STATS_TOKEN, cgroup) and the metrics poller on the Linode, or, for the restart counters, Alloy on the Linode or the Optiplex (`systemctl status alloy`, `journalctl -u alloy`).",
};
test('#967 alert texts, word for word (a change here is a change the owner reads)', () => {
  for (const [uid, text] of Object.entries(SUMMARIES)) assert.equal(rules[uid].annotations.summary, text, uid);
});

// The verifier's M2: until the removal commit, both places that describe hypercare say it is retired.
test('hypercare (#967): the docs say it is retired, and the install step is marked not to be run', () => {
  const mon = readFileSync(new URL('../claude/monitoring.md', import.meta.url), 'utf8');
  assert.match(mon, /## Hourly hypercare \(Optiplex timer\)\n\n\*\*Retired 2026-11-21 \(the timer was disabled at 17:04:04Z, Everything-is-OK#967\); kept until the removal commit\.\*\*/);
  const kit = readFileSync(new URL('../infra-check/README.md', import.meta.url), 'utf8');
  assert.match(kit, /# 11\. Hourly hypercare: RETIRED 2026-11-21 .*\n#\s+the removal commit\. Do not run these lines\.\n# 11\. Hourly hypercare/);
  assert.match(kit, /- Retired 2026-11-21 \(the timer was disabled at 17:04:04Z, Everything-is-OK#967\); kept until the removal commit:\n  hourly hypercare/);
});
