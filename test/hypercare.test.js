import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CAP_HOURS, END_AFTER, LIMITS, LINODE_PROBE, evaluate, issueBody, issueTitle, limits, logLine, parseProbe, plan, posts, streak, webhookFor } from '../infra-check/hypercare.mjs';

const kit = (f) => readFileSync(new URL(`../infra-check/${f}`, import.meta.url), 'utf8');

const normal = () => ({
  linode: parseProbe('unit:japharsworld-yt active\nunit:caddy active\ndisk 39\nbanned 0\ns5 0\nerrors 1\nyt 0\nbackoff 0\ncap0 1\ncap1 8\ncapv0 1\ncapv1 7\nevict 0\novercap 0\njournal ok\n'),
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
  Object.assign(m.linode, { 'unit:caddy': 'failed', disk: 91, s5: 4, errors: 9, yt: 5, backoff: 1, cap0: 6, cap1: 0, capv0: 6, capv1: 0, evict: 30, overcap: 2, banned: 25 });
  m.optiplex['unit:bgutil-pot-relay'] = 'inactive';
  m.optiplex.slotworker_result = 'exit-code';
  m.healthz = { ok: false, detail: 'HTTP 502.' };
  const f = evaluate(m, LIMITS);
  const keys = f.map((x) => x.key).sort();
  assert.deepEqual(keys, ['healthz', 'linode:5xx', 'linode:backoff', 'linode:banned', 'linode:captions', 'linode:disk', 'linode:errors',
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
