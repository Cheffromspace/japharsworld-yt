import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = (f) => readFileSync(new URL(`../deploy/${f}`, import.meta.url), 'utf8');

test('staging (#160): its own units, no addresses in the repo, and the guards in setup and flip', () => {
  const unit = script('japharsworld-yt-relay-staging.service');
  assert.match(unit, /^WorkingDirectory=\/opt\/japharsworld-yt-relay-staging$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/japharsworld-yt-relay-staging\.env$/m);
  assert.match(script('japharsworld-yt-relay-staging-update.service'), /RELAY_BRANCH=staging .*RELAY_SETUP=off/);
  // The repo is public: addresses live in local env files (security, flip), never here.
  for (const f of ['staging-setup.sh', 'dns-flip.sh', 'japharsworld-yt-relay-staging.env.example', 'alloy/staging.alloy']) {
    const ips = (script(f).match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []).filter((ip) => ip !== '127.0.0.1');
    assert.deepEqual(ips, [], f);
  }
  const setup = script('staging-setup.sh');
  assert.match(setup, /ufw would lock it out/, 'refuses to run from an address ufw would shut out');
  assert.match(setup, /dns cloudflare \{env\.CF_API_TOKEN\}/);
  const flip = script('dns-flip.sh');
  assert.match(flip, /--resolve "\$1:443:\$2"/, 'checks under the real name and certificate before a flip');
  assert.match(flip, /expects DNS only/);
  assert.match(setup, /git clone -q -b staging /);
  // bootstrap.sh follows the deploy env's branch (it reset staging to main before); production has no such file.
  const boot = script('bootstrap.sh');
  assert.match(boot, /BRANCH=\$\(\. \/etc\/japharsworld-yt-deploy\.env; echo "\$\{DEPLOY_BRANCH:-main\}"\)/);
  assert.match(boot, /checkout -q -B "\$BRANCH" "origin\/\$BRANCH"/);
  assert.doesNotMatch(boot, /reset -q --hard origin\/main/);
  assert.match(script('alloy/staging.alloy'), /external_labels = \{ host = "staging", env = "staging" \}/);
  assert.match(script('update.sh'), /deploy\/\(staging-setup\|dns-flip\|harden\|mediamtx-setup\)\\.sh\$/, 'pushing them restarts nothing in production');
});
