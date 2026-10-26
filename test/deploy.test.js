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
