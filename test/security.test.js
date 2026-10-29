import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sshCounts, knownSources, shortHash, sshdAuth, fail2ban, render } from '../metrics/security.js';

// Documentation addresses (RFC 5737) and made-up keys only.
const JOURNAL = [
  'Accepted publickey for root from 192.0.2.10 port 50122 ssh2: ED25519 SHA256:abc',
  'Accepted publickey for ytcheck from 198.51.100.7 port 40100 ssh2: ED25519 SHA256:def',
  'pam_unix(sshd:session): session opened for user root(uid=0) by root(uid=0)',
  'Invalid user admin from 203.0.113.5 port 4444',
  'Failed password for invalid user admin from 203.0.113.5 port 4444 ssh2',
  'Failed publickey for root from 203.0.113.6 port 4445 ssh2: RSA SHA256:xyz',
  'Connection closed by authenticating user root 203.0.113.6 port 4445 [preauth]',
];

test('security counters: logins by known/unknown source, failed and invalid-user attempts', () => {
  assert.deepEqual(sshCounts(JOURNAL, knownSources('192.0.2.10')),
    { accepted: { known: 1, unknown: 1, unclassified: 0 }, failed: 2, invalidUser: 1 });
  assert.deepEqual(sshCounts(JOURNAL, knownSources(undefined)).accepted, { known: 0, unknown: 0, unclassified: 2 }, 'not configured: nothing alerts');
  assert.equal(knownSources(' '), null);
});

test('security counters: sshd hardening and short hashes', () => {
  const t = 'port 22\npasswordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin without-password\npubkeyauthentication yes\n';
  assert.equal(sshdAuth(t).hardened, true);
  assert.equal(sshdAuth(t.replace('passwordauthentication no', 'passwordauthentication yes')).hardened, false);
  assert.equal(sshdAuth(t).text.includes('port'), false, 'only the auth settings are hashed');
  assert.equal(sshdAuth('').hardened, null);
  assert.equal(shortHash(null), 0);
  assert.ok(shortHash('a') > 0 && shortHash('a') < 2 ** 32);
  assert.notEqual(shortHash('a'), shortHash('b'));
  assert.deepEqual(fail2ban('Status for the jail: sshd\n|- Filter\n`- Actions\n   |- Currently banned:\t3\n   |- Total banned:\t17\n'), { current: 3, total: 17 });
  assert.deepEqual(fail2ban(null), { current: null, total: null });
});

test('security counters: the textfile carries no address, key or log text', () => {
  const ssh = sshCounts(JOURNAL, knownSources('192.0.2.10'));
  const text = render({ ssh, hashes: { keys_root: shortHash('ssh-ed25519 AAAA k'), sshd_auth: 5, ufw: 0 }, hardened: true,
    bans: { current: 3, total: 17 }, ufwActive: false, now: 1_800_000_000_000 });
  assert.match(text, /^eiok_ssh_accepted_10m\{source="unknown"\} 1$/m);
  assert.match(text, /^eiok_ssh_failed_10m\{kind="invalid_user"\} 1$/m);
  assert.match(text, /^eiok_security_hash\{item="keys_root"\} \d+$/m);
  assert.match(text, /^eiok_sshd_hardened 1$/m);
  for (const leak of ['192.0.2', '198.51.100', '203.0.113', 'SHA256', 'AAAA', 'admin', 'port ']) assert.ok(!text.includes(leak), leak);
});

test('security counters: Alloy keeps the series, and the units are wired in', () => {
  const alloy = readFileSync(new URL('../deploy/alloy/linode.alloy', import.meta.url), 'utf8');
  assert.match(alloy, /eiok_\(deploy\|ssh\|sshd\|fail2ban\|security\|ufw\)_\.\*/);
  assert.match(alloy, /unit_include = "\(japharsworld-yt\.\*\|bgutil-pot\|caddy\|ssh\|fail2ban\|alloy\)/);
  const setup = readFileSync(new URL('../deploy/metrics-setup.sh', import.meta.url), 'utf8');
  assert.match(setup, /japharsworld-yt-security\.timer/);
});
