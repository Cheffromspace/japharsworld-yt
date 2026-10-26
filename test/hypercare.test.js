import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { END_AFTER, LIMITS, LINODE_PROBE, evaluate, issueBody, issueTitle, limits, logLine, parseProbe, plan, streak } from '../infra-check/hypercare.mjs';

const kit = (f) => readFileSync(new URL(`../infra-check/${f}`, import.meta.url), 'utf8');

const normal = () => ({
  linode: parseProbe('unit:japharsworld-yt active\nunit:caddy active\ndisk 39\nbanned 0\ns5 0\nerrors 1\nyt 0\nbackoff 0\ncap0 1\ncap1 8\nevict 0\novercap 0\njournal ok\n'),
  optiplex: { 'unit:japharsworld-yt-relay': 'active', 'unit:bgutil-pot-relay': 'active', 'unit:japharsworld-yt-slotworker.timer': 'active', slotworker_result: 'success' },
  media: { rtsp: 'open' },
  healthz: { ok: true, detail: 'HTTP 200.' },
});

test('hypercare: a normal hour has no findings and logs one line of counts', () => {
  const m = normal();
  assert.equal(m.linode.disk, 39);
  assert.deepEqual(evaluate(m, LIMITS), []);
  const line = JSON.parse(logLine(m, []));
  assert.equal(line.event, 'hypercare');
  assert.equal(line.ok, true);
  assert.equal(line.mediamtx, 'open');
  delete m.media;
  assert.equal(JSON.parse(logLine(m, [])).mediamtx, 'unchecked', 'no HYPERCARE_MEDIAMTX_HOST: skipped, and the log says so');
  assert.deepEqual(evaluate(m, LIMITS), []);
});

test('hypercare: each abnormal reading is one finding, and only owner actions become owner tasks', () => {
  const m = normal();
  Object.assign(m.linode, { 'unit:caddy': 'failed', disk: 91, s5: 4, errors: 9, yt: 5, backoff: 1, cap0: 6, cap1: 2, evict: 30, overcap: 2, banned: 25 });
  m.optiplex['unit:bgutil-pot-relay'] = 'inactive';
  m.optiplex.slotworker_result = 'exit-code';
  m.media.rtsp = 'ECONNREFUSED';
  m.healthz = { ok: false, detail: 'HTTP 502.' };
  const f = evaluate(m, LIMITS);
  const keys = f.map((x) => x.key).sort();
  assert.deepEqual(keys, ['healthz', 'linode:5xx', 'linode:backoff', 'linode:banned', 'linode:captions', 'linode:disk', 'linode:errors',
    'linode:evict', 'linode:overcap', 'linode:unit:caddy', 'linode:youtube', 'media:rtsp', 'optiplex:slotworker-result', 'optiplex:unit:bgutil-pot-relay']);
  assert.deepEqual(f.filter((x) => x.owner).map((x) => x.key).sort(), ['healthz', 'linode:disk', 'linode:unit:caddy', 'media:rtsp', 'optiplex:unit:bgutil-pot-relay']);
  // Captions only count when zero-track ones outnumber the rest.
  assert.ok(!evaluate({ linode: { ...normal().linode, cap0: 5, cap1: 9 } }, LIMITS).length);
  // An unreachable host is one finding, not a unit storm.
  assert.deepEqual(evaluate({ linode: { error: 'ssh linode-check failed: timeout' } }, LIMITS).map((x) => x.key), ['probe:linode']);
  assert.equal(limits({ HYPERCARE_DISK: '70' }).DISK, 70);
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

test('hypercare: owner-task cards follow the world repo template and carry no addresses', () => {
  const m = normal();
  Object.assign(m.linode, { 'unit:caddy': 'failed', disk: 91 });
  m.optiplex['unit:japharsworld-yt-relay'] = 'failed';
  m.media.rtsp = 'timeout';
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
