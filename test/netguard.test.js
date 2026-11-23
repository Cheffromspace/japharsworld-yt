// The network guard's own test (Everything-is-OK#1035): each fixture in test/netguard-fixtures/ runs in a child
// `node --import ./test/netguard.mjs --test <fixture>` with a clean environment, and must be red (or green) for the right
// reason: a refusal at load, in a before() hook, inside a test, in an after() hook, and from async work that outlives its
// test, and one test per way out the guard covers. Every fixture aims at 192.0.2.1 (TEST-NET-1, RFC 5737, reserved) or a
// .invalid name, so even a guard that let one through reaches no real host. Before 2026-11-23 the guard charged only
// refusals made during a test: one at load or in a before() hook was absorbed and the file stayed green (verifier-cap-s1's
// Medium); this file fails on that guard (4e96df2's) in the load, before(), after() and outlives cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = new URL('./netguard.mjs', import.meta.url).href;
const fixture = (name) => fileURLToPath(new URL(`./netguard-fixtures/${name}.test.mjs`, import.meta.url));

// Runs one fixture file; returns the exit status, the output, each test's ok/not ok and the fixture's guard record.
function run(name) {
  const dir = mkdtempSync(join(tmpdir(), 'netguard-self-'));
  const rec = join(dir, 'record.jsonl');
  const env = { ...process.env, NETGUARD_RECORD: rec };
  // A clean child: not a test-file child of this run (a nested runner that inherits NODE_TEST_CONTEXT reports in the
  // parent's protocol), and not reporting to this process's guard log (its refusals are the fixture's, not this test's).
  delete env.NODE_TEST_CONTEXT;
  delete env.NETGUARD_PARENT_LOG;
  env.NODE_OPTIONS = (env.NODE_OPTIONS ?? '').replace(/--import[= ]\S*netguard\.mjs\S*/g, '').trim();
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['--import', GUARD, '--test', '--test-reporter=tap', fixture(name)], { env, encoding: 'utf8', timeout: 90_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const tests = new Map([...out.matchAll(/^(not )?ok \d+ - (.+?)(?: # .*)?$/gm)].filter((m) => !/netguard-fixtures/.test(m[2])).map((m) => [m[2], !m[1]]));
  const lines = existsSync(rec) ? readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  rmSync(dir, { recursive: true, force: true });
  const own = lines.find((l) => l.file === `${name}.test.mjs`) ?? null;
  return { status: r.status, out, tests, record: own };
}
const passed = (r, name) => assert.equal(r.tests.get(name), true, `"${name}" passes\n${r.out}`);
const failed = (r, name) => assert.equal(r.tests.get(name), false, `"${name}" fails\n${r.out}`);
// A file whose tests all passed but which the guard failed at exit, naming each refusal and its place.
const redOutside = (r, place) => {
  assert.notEqual(r.status, 0, `the file is red\n${r.out}`);
  assert.match(r.out, /netguard: \S+ tried 1 outbound connection\(s\) outside its tests: fetch http:\/\/192\.0\.2\.1:9 @ /, r.out);
  assert.ok(r.out.includes(`(${place})`), `the place is named: ${place}\n${r.out}`);
  assert.deepEqual(r.record?.refused.map((x) => [x.what, x.to]), [['fetch http://192.0.2.1:9', place]], 'the record');
};

test('netguard: a refusal at load fails the file at exit, named "at load"; the test after it stays green', () => {
  const r = run('load');
  assert.ok(r.tests.size > 0, `the fixture ran\n${r.out}`);
  passed(r, 'Q1 passes after a refusal at load');
  redOutside(r, 'at load, before any test');
});

test('netguard: a refusal in a before() hook fails the file at exit, named; the tests after it stay green', () => {
  const r = run('before');
  passed(r, 'R1 passes after a before() hook\'s refusal');
  passed(r, 'R2 passes too');
  redOutside(r, 'in a before() hook');
});

test('netguard: a refusal in a test fails that test only, naming the host and the line', () => {
  const r = run('intest');
  failed(r, 'T1 fetches 192.0.2.1');
  passed(r, 'T2 does nothing');
  assert.notEqual(r.status, 0);
  assert.match(r.out, /netguard: this test tried 1 outbound connection\(s\): fetch http:\/\/192\.0\.2\.1:9 @ .*netguard-fixtures\/intest\.test\.mjs:3/, r.out);
});

test('netguard: a refusal in an after() hook fails the file at exit, named', () => {
  const r = run('after');
  passed(r, 'S1 passes');
  redOutside(r, 'in an after() hook');
});

test('netguard: a refusal from async work that outlives its test names that test; the innocent test then running stays green', () => {
  const r = run('outlives');
  passed(r, 'P10 starts work that outlives it');
  passed(r, 'P11 is innocent and stays green');
  redOutside(r, 'from async work started in test "P10 starts work that outlives it", after that test ended');
});

test('netguard: control: loopback only is green, nothing refused', () => {
  const r = run('control');
  assert.equal(r.status, 0, r.out);
  passed(r, 'C1 loopback fetch and socket pass');
  assert.deepEqual(r.record?.refused, [], 'nothing refused');
  assert.ok(r.record.local > 0, 'loopback connections counted');
});

test('netguard: every way out it covers is refused and charged to the test that tried (sockets, TLS, DNS, c-ares, UDP, WebSocket, workers, node children)', () => {
  const r = run('apis');
  const want = {
    'API fetch': 'fetch http://192.0.2.1:9',
    'API net connect': 'connect 192.0.2.1',
    'API tls connect': 'tls 192.0.2.1',
    'API dns lookup': 'dns example.invalid',
    'API dns lookupService': 'dns lookupService 192.0.2.1',
    'API dns Resolver resolve4': 'c-ares resolve4 example.invalid',
    'API dns promises Resolver resolveTxt': 'c-ares resolveTxt example.invalid',
    'API dns resolve (the default resolver, its server set to 192.0.2.1)': 'c-ares resolve example.invalid',
    'API dgram send': 'udp 192.0.2.1',
    'API dgram connect': 'udp connect 192.0.2.1',
    'API WebSocket': 'websocket ws://192.0.2.1:9',
    'API worker eval': /^fetch http:\/\/192\.0\.2\.1:9 \(in a worker thread \d+ of process \d+\)$/,
    'API worker module': /^fetch http:\/\/192\.0\.2\.1:9 \(in a worker thread \d+ of process \d+\)$/,
    'API worker with its own execArgv': /^fetch http:\/\/192\.0\.2\.1:9 \(in a worker thread \d+ of process \d+\)$/,
    'API node child': /^fetch http:\/\/192\.0\.2\.1:9 \(in a child process \d+ \(node -e\)\)$/,
  };
  const bash = r.tests.has('API node child under bash') && !/^ok \d+ - API node child under bash # SKIP/m.test(r.out);
  if (bash) want['API node child under bash'] = /^fetch http:\/\/192\.0\.2\.1:9 \(in a child process \d+ \(node -e\)\)$/;
  for (const name of Object.keys(want)) failed(r, name);
  passed(r, 'API loopback passes');
  const got = r.record?.refused ?? [];
  for (const [name, what] of Object.entries(want)) {
    const mine = got.filter((x) => x.to === name);
    assert.equal(mine.length, 1, `"${name}": exactly one refusal charged to it: ${JSON.stringify(mine)}`);
    if (typeof what === 'string') assert.equal(mine[0].what, what, name);
    else assert.match(mine[0].what, what, name);
  }
  assert.equal(got.length, Object.keys(want).length, `nothing charged elsewhere: ${JSON.stringify(got)}`);
});
