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

test('infra check: both prompts file owner tasks in the private world repo, security ones without details (world #216)', () => {
  for (const f of ['prompt.md', 'triage-prompt.md']) {
    const p = kit(f);
    assert.match(p, /gh issue create -R Cheffromspace\/Everything-is-OK --label owner-task --project "Your tasks"/, f);
    assert.match(p, /search the open `owner-task` issues there first/, f);
    assert.match(p, /\.github\/ISSUE_TEMPLATE\/owner-task\.md/, f);
    assert.match(p, /"Security finding on <host>, see the local report of <date>"/, f);
    // The owner shares the GitHub account; the board watcher skips only marked comments (coordinator, 2026-10-26).
    assert.match(p, /every comment you post on an `owner-task` issue ends with the line `<!-- coordinator -->`/, f);
  }
  const rules = readFileSync(new URL('../claude/monitoring.md', import.meta.url), 'utf8');
  assert.match(rules, /\*\*Owner task\*\* \(owner, 2026-10-26, world #216\)/);
  assert.match(rules, /Every comment it posts on an `owner-task` issue ends with the line `<!-- coordinator -->`/);
});

test('infra check: the README has no step that writes a placeholder key (2026-10-25)', () => {
  const readme = kit('README.md');
  assert.doesNotMatch(readme, /echo '<paste/);
  assert.match(readme, /'ssh-ed25519 '\*' yt-infra-check@gameserver'\)/);
});

// #246 (2026-10-26): `. file` ran DISCORD_MENTION=<@id> as a redirection, a syntax error that dropped every later line
// (the new DISCORD_CRITICAL_WEBHOOK among them). Env files are read as KEY=VALUE lines, as systemd does, never sourced.
test('env files: no shell script sources one; each reads KEY=VALUE lines with load_env', () => {
  const files = ['deploy/slotmon', 'infra-check/run.sh', 'deploy/harden.sh', 'deploy/mediamtx-setup.sh'];
  const loader = readFileSync(new URL('../deploy/slotmon', import.meta.url), 'utf8').match(/^load_env\(\) \{[\s\S]*?^\}$/m)[0];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /(^|;|&&)\s*(\.|source)\s+["$\/~]/m, f);
    assert.ok(src.includes(loader), `${f}: the same loader`);
    assert.match(src, /^load_env /m, f);
  }
  assert.match(loader, /export "\$key=\$val"/, 'values are exported as text, never evaluated');
});
