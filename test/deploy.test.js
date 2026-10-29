import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
