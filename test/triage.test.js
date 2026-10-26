import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discordText, fallbackText, isSecurity, kindOf, pick, record, severe, slug, syntheticAlert } from '../infra-check/triage.mjs';

// The severe-alert triage on the Optiplex (infra-check/triage.mjs, owner 2026-10-26).
const kit = (f) => readFileSync(new URL(`../infra-check/${f}`, import.meta.url), 'utf8');
const H = 3600_000;
const alert = (fp, alertname, extra = {}) => ({
  fingerprint: fp, startsAt: '2026-10-26T14:00:00Z', status: { state: 'active' },
  labels: { alertname, severity: 'critical', project: 'everything-is-ok', ...extra.labels }, annotations: { summary: extra.summary ?? 'x' },
});

test('triage: only firing, unsilenced, critical alerts of this project', () => {
  const list = [
    alert('a', 'Linode disk 80 % full'),
    { ...alert('b', 'Search service down'), labels: { alertname: 'Search service down', severity: 'warning', project: 'everything-is-ok' } },
    { ...alert('c', 'x'), status: { state: 'suppressed' } },
    { ...alert('d', 'x'), labels: { alertname: 'x', severity: 'critical', project: 'other' } },
  ];
  assert.deepEqual(severe(list).map((a) => a.fingerprint), ['a']);
});

test('triage: once per alert per 6 hours, at most 6 runs a day, and past the cap still announced', () => {
  const now = Date.parse('2026-10-26T15:00:00Z');
  const a = alert('a', 'x'), b = alert('b', 'y');
  assert.deepEqual(pick([a, b], { seen: {}, runs: [] }, now).triage, [a, b], 'one run covers every new alert');
  assert.deepEqual(pick([a, b], { seen: { a: now - 5 * H }, runs: [] }, now).triage, [b]);
  assert.deepEqual(pick([a], { seen: { a: now - 7 * H }, runs: [] }, now).triage, [a], 'still firing after 6 h: triaged again');
  assert.deepEqual(pick([a], { seen: { a: now - H }, runs: [] }, now), { triage: [], capped: [] });
  const full = { seen: {}, runs: Array.from({ length: 6 }, (_, i) => now - i * H) };
  assert.deepEqual(pick([a], full, now), { triage: [], capped: [a] });
  assert.deepEqual(pick([a], { seen: {}, runs: full.runs.map((t) => t - 20 * H) }, now).triage, [a], 'runs older than 24 h free the cap');
  const s = record({ seen: { old: now - 25 * H }, runs: [now - 25 * H] }, [a], now, { ran: true });
  assert.deepEqual(s, { seen: { a: now }, runs: [now] }, 'old entries are dropped');
  assert.deepEqual(record({ seen: {}, runs: [] }, [a], now, { ran: false }).runs, [], 'a capped announcement is not a run');
});

test('triage: the security rules are told apart (they go nowhere on GitHub)', () => {
  for (const [name, uid] of [['SSH login from an unknown address', 'eiok-ssh-unknown-login'], ['Linode keys, sshd or ufw changed', 'eiok-security-change'], ['Linode sshd hardening off', 'eiok-sshd-not-hardened']]) {
    assert.equal(kindOf(alert('x', name, { labels: { __alert_rule_uid__: uid } })), 'security', name);
  }
  assert.ok(isSecurity(alert('x', 'Something new', { summary: 'SECURITY: something' })));
  assert.equal(kindOf(alert('x', 'Search service down')), 'down');
  assert.equal(kindOf(alert('x', 'Linode disk 80 % full')), 'other');
  assert.equal(kindOf(alert('x', 'Domain expires within 7 days')), 'other');
  assert.equal(kindOf(syntheticAlert('security', 0)), 'security');
  assert.equal(kindOf(syntheticAlert('down', 0)), 'down');
  assert.equal(severe([syntheticAlert('down', 0)]).length, 1, 'the synthetic alerts pass the same filter');
});

test('triage: the Discord text starts with SEVERE:, fits Discord, and says when triage could not run', () => {
  const a = [alert('a', 'Linode keys, sshd or ufw changed', { labels: { item: 'ufw' } })];
  const t = discordText({ alerts: a, note: 'Planned change.\nNext: nothing.', report: '/home/u/yt-infra-check/reports/r.md' });
  assert.match(t, /^SEVERE: Linode keys, sshd or ufw changed \(ufw\), firing since 09:00 Central\nPlanned change\./);
  assert.match(t, /reports\/r\.md\)$/);
  assert.ok(discordText({ alerts: a, note: 'x'.repeat(5000), report: '/r.md' }).length <= 1990);
  assert.match(discordText({ alerts: a, note: 'x', test: true }), /^SEVERE: \[synthetic test\] /);
  const f = fallbackText({ alerts: a, reason: 'the Claude Code login expired.' });
  assert.match(f, /^SEVERE: /);
  assert.match(f, /Triage couldn't run: the Claude Code login expired\.$/);
  assert.equal(slug('Linode disk 80 % full'), 'linode-disk-80-full');
});

test('triage: the units run the checkout under the weekly lock, and the prompt is read only', () => {
  assert.match(kit('yt-infra-triage.service'), /^ExecStart=\/usr\/bin\/flock -n -E 0 %h\/yt-infra-check\/\.lock \/usr\/bin\/node \/opt\/japharsworld-yt-relay\/infra-check\/triage\.mjs$/m);
  assert.match(kit('run.sh'), /exec 9>"\$BASE\/\.lock"/, 'the same lock file as the weekly check');
  assert.match(kit('yt-infra-triage.timer'), /^OnUnitInactiveSec=2min$/m);
  const p = kit('triage-prompt.md');
  assert.match(p, /No restarts/);
  assert.match(p, /ssh linode-check/);
  assert.match(p, /A security alert goes nowhere on GitHub/);
  assert.doesNotMatch(p, /ssh linode[^-]/, 'never the root login');
  assert.match(readFileSync(new URL('../claude/monitoring.md', import.meta.url), 'utf8'), /^## Severe alert triage/m);
});
