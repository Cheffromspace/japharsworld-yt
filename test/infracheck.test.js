import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The weekly infra check's kit (infra-check/): the safety rules that live in its files, not in code.
const kit = (f) => readFileSync(new URL(`../infra-check/${f}`, import.meta.url), 'utf8');

test('infra check: the sudoers files allow no restarts and only the listed read-only commands', () => {
  for (const f of ['sudoers-linode', 'sudoers-optiplex']) {
    const rules = kit(f).split('\n').filter((l) => !l.startsWith('#')).join('\n');
    assert.doesNotMatch(rules, /systemctl|restart|reboot|apt|ALL\s*$/m, f);
  }
  // The Linode's rule is read only (owner, 2026-10-26); the repo copy is the installed file, byte for byte.
  assert.match(kit('sudoers-linode'), /^ytcheck ALL=\(root\) NOPASSWD: YT_READ$/m);
  assert.match(kit('sudoers-optiplex'), /^jonflatt ALL=\(root\) NOPASSWD: YT_SAFE, YT_READ$/m);
  assert.match(kit('sudoers-linode'), /fail2ban-client status sshd/);
  assert.match(kit('sudoers-optiplex'), /\/usr\/bin\/ss -tlnp/);
});

test('infra check: the unit runs the checkout, and the security report stays local but goes to Discord', () => {
  assert.match(kit('yt-infra-check.service'), /^ExecStart=\/bin\/bash \/opt\/japharsworld-yt-relay\/infra-check\/run\.sh$/m);
  const run = kit('run.sh');
  assert.match(run, /cat "\$KIT\/prompt\.md"/, 'the prompt comes from the checkout');
  assert.match(run, /BASE="\$HOME\/yt-infra-check"/, 'the data stays local');
  assert.match(run, /files\[1\]=@\$file2/);
  assert.match(run, /"\$REPORT" "\$SECURITY"/);
  assert.match(kit('prompt.md'), /Security: green\/yellow\/red, details in the local report/);
});

test('infra check: the README has no step that writes a placeholder key (2026-10-25)', () => {
  const readme = kit('README.md');
  assert.doesNotMatch(readme, /echo '<paste/);
  assert.match(readme, /'ssh-ed25519 '\*' yt-infra-check@gameserver'\)/);
});
