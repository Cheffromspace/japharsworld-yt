import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// The guard from bootstrap.sh, run for real in bash against a stand-in caddy (#399). A wrong guard here would leave
// request details in the log while the setup reports success.
// The stand-in's adapt writes each filter line it finds (anywhere in the file) into the named logger's encoder, in
// the real form (fields, format, wrap, ">" escaped: 2.11.7 on staging and 2.6.2 on prod adapt it so, 2026-11-13) or
// with wrap first (no version seen doing that; the guard must not depend on key order). `before` adds a named global
// logger that sorts before "default".
function runGuard(caddyfile, { validate = 0, adaptOk = true, logger = 'default', wrapFirst = false, errorOk = true, before = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'caddy-guard-'));
  try {
    mkdirSync(join(dir, 'bin'));
    const enc = wrapFirst ? `{"wrap":{"format":"json"},"fields":{'"$f"'},"format":"filter"}` : `{"fields":{'"$f"'},"format":"filter","wrap":{"format":"json"}}`;
    writeFileSync(join(dir, 'bin', 'caddy'), String.raw`#!/usr/bin/env bash
if [ "$1" = validate ]; then exit ${validate}; fi
gt=$(printf '\134u003e')
f=''
if ${errorOk ? '' : 'false && '}grep -q '^[[:space:]]*error regexp' "$3"; then f='"error":{"filter":"regexp","regexp":"-'$gt'[^ ]+","value":"-'$gt'client"}'; fi
if grep -q '^[[:space:]]*request delete' "$3"; then [ -z "$f" ] || f="$f,"; f="$f"'"request":{"filter":"delete"}'; fi
` + (adaptOk ? `echo '{"logging":{"logs":{${before ? '"access":{"encoder":{"format":"json"},"include":["http.log.access"]},' : ''}"${logger}":{"encoder":${enc}}}},"apps":{}}'\n` : `echo '{}'\n`), { mode: 0o755 });
    writeFileSync(join(dir, 'Caddyfile'), caddyfile);
    const part = script('bootstrap.sh').match(/# >>> caddy-log-filter[\s\S]*# <<< caddy-log-filter/)[0];
    writeFileSync(join(dir, 'run.sh'), `set -euo pipefail\nPATH="$PWD/bin:$PATH"\n${part}\ncaddy_log_filter Caddyfile\necho "added=$caddy_filter_added"\n`);
    const r = spawnSync('bash', ['run.sh'], { cwd: dir, encoding: 'utf8' });
    return { status: r.status, out: r.stdout, err: r.stderr, file: readFileSync(join(dir, 'Caddyfile'), 'utf8'), leftover: existsSync(join(dir, 'Caddyfile.new')) };
  } finally {
    // Windows can hold the folder for a moment after bash exits (EPERM, 2026-10-31); a leftover temp folder fails nothing.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

test('bootstrap.sh Caddy guard: the filter goes first, once', () => {
  const r = runGuard('import sites/*\n');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /added=1/);
  assert.ok(r.file.startsWith('{\n\tlog {'));
  assert.ok(r.file.endsWith('\n\nimport sites/*\n'));
  const again = runGuard(r.file);
  assert.equal(again.status, 0, again.err);
  assert.match(again.out, /added=0/);
  assert.equal(again.file, r.file);
});

test('bootstrap.sh Caddy guard: a comment naming the filter does not pass for it', () => {
  const r = runGuard('# request delete\n# error regexp "->[^ ]+" "->client"\n# { old note\nimport sites/*\n');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /added=1/);
  assert.ok(r.file.startsWith('{\n\tlog {'));
});

test('bootstrap.sh Caddy guard: a commented-out filter line inside the global block does not count', () => {
  // Read with its comments, the error line would complete the filter, and the guard would go on to adapt.
  const text = '{\n\tlog {\n\t\tformat filter {\n\t\t\twrap json\n\t\t\tfields {\n\t\t\t\trequest delete\n\t\t\t\t# error regexp "->[^ ]+" "->client"\n\t\t\t}\n\t\t}\n\t}\n}\n';
  const r = runGuard(text);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /Nothing changed/);
  assert.equal(r.file, text);
});

test('bootstrap.sh Caddy guard: the filter in a site log block only does not count, so the global one is added', () => {
  const text = 'example.com {\n\tlog {\n\t\tformat filter {\n\t\t\twrap json\n\t\t\tfields {\n\t\t\t\trequest delete\n\t\t\t\terror regexp "->[^ ]+" "->client"\n\t\t\t}\n\t\t}\n\t}\n}\n';
  const r = runGuard(text);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /added=1/);
  assert.ok(r.file.startsWith('{\n\tlog {'));
  assert.ok(r.file.endsWith(`\n\n${text}`));
});

test('bootstrap.sh Caddy guard: the adapted config must carry both filters on the default logger', () => {
  assert.equal(runGuard('import sites/*\n', { wrapFirst: true }).status, 0, 'another key order passes');
  assert.equal(runGuard('import sites/*\n', { before: true }).status, 0, 'a named logger sorting before default passes');
  const other = runGuard('import sites/*\n', { logger: 'log0' });
  assert.notEqual(other.status, 0);
  assert.match(other.err, /does not apply the log filter to the default logger/);
  const noError = runGuard('import sites/*\n', { errorOk: false });
  assert.notEqual(noError.status, 0);
  assert.match(noError.err, /does not apply the log filter to the default logger/);
});

for (const [name, text] of [
  ['a global block','{\n\temail a@b.c\n}\nimport sites/*\n'],
  ['a lone { line', 'import sites/*\nexample.com\n{\n}\n'],
  ['half a filter', '{\n\tlog {\n\t\tformat filter {\n\t\t\tfields {\n\t\t\t\trequest delete\n\t\t\t}\n\t\t}\n\t}\n}\n'],
]) {
  test(`bootstrap.sh Caddy guard: ${name} fails loud and changes nothing`, () => {
    const r = runGuard(text);
    assert.notEqual(r.status, 0);
    assert.match(r.err, /Nothing changed/);
    assert.equal(r.file, text);
  });
}

test('bootstrap.sh Caddy guard: a candidate that fails validation leaves the Caddyfile alone', () => {
  const r = runGuard('import sites/*\n', { validate: 1 });
  assert.notEqual(r.status, 0);
  assert.equal(r.file, 'import sites/*\n');
  assert.equal(r.leftover, false);
});

test('bootstrap.sh Caddy guard: a config that adapts without the filter fails', () => {
  const r = runGuard('import sites/*\n', { adaptOk: false });
  assert.notEqual(r.status, 0);
  assert.match(r.err, /does not apply the log filter/);
});

test('bootstrap.sh: a new filter restarts Caddy, and an existing site file for the domain is kept', () => {
  const s = script('bootstrap.sh');
  assert.ok(s.includes('if [ "$caddy_filter_added" = 1 ]; then systemctl restart caddy; else systemctl reload caddy; fi'));
  assert.ok(s.includes('grep -qF "$DOMAIN" /etc/caddy/sites/japharsworld-yt.caddy 2>/dev/null || echo "$site_block" >'));
});
