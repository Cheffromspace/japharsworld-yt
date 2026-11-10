import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The update scripts are shared by production and staging (#160): unset switches must mean production, exactly as before.
const script = (f) => readFileSync(new URL(`../deploy/${f}`, import.meta.url), 'utf8');

test('update.sh: production defaults (main, monitor and poller on, the linode Alloy config)', () => {
  const s = script('update.sh');
  for (const d of ['BRANCH=${DEPLOY_BRANCH:-main}', 'MONITOR=${DEPLOY_MONITOR:-on}', 'POLLER=${DEPLOY_POLLER:-on}', 'ALLOY=${DEPLOY_ALLOY:-linode}']) assert.ok(s.includes(d), d);
  assert.ok(s.includes('[ ! -f /etc/japharsworld-yt-deploy.env ] || . /etc/japharsworld-yt-deploy.env'), 'the switches come from a file production does not have');
  const code = s.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /origin\/main|fetch -q origin main/, 'no branch hard-coded any more');
  assert.doesNotMatch(s, /\|security\)\.[|)]/, 'the unit-name dots stay escaped');
});

test('update.sh: the shell setup script does not restart the search service; src/ still does', () => {
  const re = new RegExp(/service_changed=\$\(echo "\$changed" \| grep -v -E '(.*)' \|\| true\)/.exec(script('update.sh'))[1]);
  assert.ok(re.test('deploy/shell-setup.sh'), 'deploy/shell-setup.sh is on the no-restart list');
  assert.ok(re.test('README.md'));
  assert.ok(re.test('.github/workflows/test.yml'), 'the CI workflow (Everything-is-OK#712) is on the no-restart list');
  assert.ok(!re.test('src/server.js'), 'src/ restarts');
  assert.ok(!/^(relay\/|src\/|package(-lock)?\.json$|deploy\/japharsworld-yt-relay)/.test('deploy/shell-setup.sh'), 'nor the relay worker (relay-update.sh)');
});

test('relay-update.sh: production defaults, and a staging worker touches only its own units', () => {
  const s = script('relay-update.sh');
  for (const d of ['APP=${RELAY_APP:-/opt/japharsworld-yt-relay}', 'BRANCH=${RELAY_BRANCH:-main}', 'UNIT=${RELAY_UNIT:-japharsworld-yt-relay}', 'SETUP=${RELAY_SETUP:-on}']) assert.ok(s.includes(d), d);
  assert.ok(s.includes('units="$UNIT.service $UNIT-update.service $UNIT-update.timer"'));
  assert.ok(s.includes('systemctl restart "$UNIT.service"'));
  for (const step of ['deploy/bgutil-setup.sh "$VENV"', 'deploy/alloy-setup.sh optiplex', 'deploy/deploy-record.sh']) {
    // The guard is on the step's line or on the "if" line just above it.
    const lines = s.split('\n');
    const i = lines.findIndex((l) => l.includes(step));
    assert.match(`${lines[i - 1]}\n${lines[i]}`, /\[ "\$SETUP" = on \]/, step);
  }
});

test('harden.sh: addresses stay local; SSH from home and HTTPS only (MediaMTX\'s 1935/8554 went with it, #38)', async () => {
  const harden = script('harden.sh');
  assert.match(harden, /ufw would lock it out/);
  assert.match(harden, /HOME_TCP=\$\{HARDEN_HOME_TCP:-22\}/);
  assert.match(harden, /PUBLIC_TCP=\$\{HARDEN_PUBLIC_TCP:-80 443\}/);
  assert.doesNotMatch(harden, /1935|8554/);
  assert.doesNotMatch(harden, /ufw (--force )?reset/, 'never drops rules someone else added');
  assert.match(script('bootstrap.sh'), /DPkg::Lock::Timeout "600"/);
  assert.match(script('bootstrap.sh'), /bash "\$APP\/deploy\/harden\.sh"/);
  for (const f of ['harden.sh']) {
    const ips = (script(f).match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []).filter((ip) => ip !== '127.0.0.1');
    assert.deepEqual(ips, [], f);
  }
});

// World #428: ReadWritePaths needs /run/ufw.lock, and /run is emptied at boot, so the first run after each reboot failed
// with 226/NAMESPACE until something made the file.
test('security unit: /run/ufw.lock is made at boot by a tmpfiles entry the setup path installs', () => {
  assert.match(script('japharsworld-yt-security.service'), /^ReadWritePaths=.*\/run\/ufw\.lock/m);
  const entry = script('japharsworld-yt-security.tmpfiles').split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(entry, ['f /run/ufw.lock 0644 root root -'], 'plain f: never truncates, no boot-only flag');
  const setup = script('metrics-setup.sh');
  assert.match(setup, /install -m 644 "\$APP\/deploy\/japharsworld-yt-security\.tmpfiles" \/etc\/tmpfiles\.d\/japharsworld-yt-security\.conf/);
  assert.match(setup, /systemd-tmpfiles --create \/etc\/tmpfiles\.d\/japharsworld-yt-security\.conf/);
  const u = script('update.sh');
  const file = 'deploy/japharsworld-yt-security.tmpfiles';
  assert.ok(new RegExp(/service_changed=\$\(echo "\$changed" \| grep -v -E '(.*)' \|\| true\)/.exec(u)[1]).test(file), 'does not restart the search service');
  assert.ok(new RegExp(/metrics_setup_changed=\$\(echo "\$changed" \| grep -E '(.*)' \|\| true\)/.exec(u)[1]).test(file), 'a change runs the setup');
  assert.match(/metrics_missing\(\) \{.*/.exec(u)[0], /\/etc\/tmpfiles\.d\/japharsworld-yt-security\.conf/, 'a host without it gets it on the next pass');
});

// Everything-is-OK#682: six settings the service reads were missing from the example (seven with MONITOR_DB), so nobody
// setting up or auditing a server could see them. Every environment variable src/ reads must have its `NAME=` line in
// deploy/japharsworld-yt.env.example, commented out or not; a mention in another setting's note doesn't count. The relay
// worker, the metrics poller and exporter, the monitor and tools/ read their own env files and are not checked here.
test('env example: every setting src/ reads has its NAME= line', () => {
  // Read on purpose and left out of the example: none today. Add a name here only with the reason beside it.
  const UNDOCUMENTED = new Set([]);
  const dir = new URL('../src/', import.meta.url);
  const read = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) read.add(m[1] ?? m[2]);
    if (f === 'config.js') for (const m of src.matchAll(/\bint\('([A-Z][A-Z0-9_]*)'/g)) read.add(m[1]);
  }
  // The scan still understands src/config.js: long-lived settings read in each of its forms, int('X') (PORT, SHARDS,
  // POOL), process.env.X (HOST, DB_PATH, TUNELIO_API_KEY, RELAY_TOKEN). Named, not counted (105 found on 2026-11-10):
  // a count near today's would fail when settings are removed.
  for (const name of ['PORT', 'SHARDS', 'POOL', 'HOST', 'DB_PATH', 'TUNELIO_API_KEY', 'RELAY_TOKEN']) assert.ok(read.has(name), `the scan missed ${name}`);
  const example = script('japharsworld-yt.env.example');
  const listed = new Set([...example.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  assert.deepEqual([...read].filter((n) => !listed.has(n) && !UNDOCUMENTED.has(n)).sort(), [], 'read by src/ but not in the example');
  assert.deepEqual([...UNDOCUMENTED].filter((n) => listed.has(n) || !read.has(n)), [], 'an exclusion that is no longer one');
});
