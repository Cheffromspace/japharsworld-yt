// Security counters for Grafana (owner, 2026-10-26), run as root every minute by japharsworld-yt-security.timer on the
// Linode. Writes a Prometheus textfile that Alloy's unix exporter picks up (deploy/alloy/linode.alloy). Only counts,
// on/off flags and short hashes leave the host: never an IP address, a key, a log line or anything else read here.
//   SSH_KNOWN_SOURCES  addresses whose logins are expected, comma separated (/etc/japharsworld-yt-security.env, local
//                      only: the repo is public). Unset: logins are counted as "unclassified", so nothing alerts.
//   SECURITY_PROM      the textfile to write (default /var/lib/japharsworld-yt-deploy/security.prom)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const WINDOW_MIN = 10; // the counts are "in the last 10 minutes", recomputed every run

// sshd's journal lines (journalctl -t sshd -t sshd-session -o cat) → counts. "Failed password for invalid user x"
// and "Invalid user x" are two lines for one attempt: counted under their own kinds, not added up into one.
export function sshCounts(lines, known) {
  const out = { accepted: { known: 0, unknown: 0, unclassified: 0 }, failed: 0, invalidUser: 0 };
  for (const l of lines) {
    let m;
    if ((m = /^Accepted \S+ for \S+ from (\S+) port /.exec(l))) {
      out.accepted[known == null ? 'unclassified' : known.has(m[1]) ? 'known' : 'unknown']++;
    } else if (/^Failed \S+ for /.test(l)) out.failed++;
    else if (/^Invalid user /.test(l)) out.invalidUser++;
  }
  return out;
}

export const knownSources = (v) => (v == null || !v.trim() ? null : new Set(v.split(',').map((s) => s.trim()).filter(Boolean)));

// A change marker that says nothing about the content: the first 32 bits of its SHA-256 (0 = missing).
export const shortHash = (text) => (text == null ? 0 : parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16));

// The settings of `sshd -T` that decide who can log in, and whether the hardening holds (keys only, no root password).
const AUTH = /^(passwordauthentication|kbdinteractiveauthentication|challengeresponseauthentication|permitrootlogin|pubkeyauthentication|permitemptypasswords|authenticationmethods|authorizedkeysfile|usepam|allowusers|allowgroups|denyusers|denygroups) /;
export function sshdAuth(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => AUTH.test(l)).sort();
  const get = (k) => lines.find((l) => l.startsWith(`${k} `))?.slice(k.length + 1);
  const hardened = get('passwordauthentication') === 'no' && get('kbdinteractiveauthentication') === 'no'
    && ['prohibit-password', 'without-password', 'no'].includes(get('permitrootlogin'));
  return { text: lines.join('\n'), hardened: lines.length ? hardened : null };
}

export function fail2ban(text) {
  const num = (re) => { const m = re.exec(String(text ?? '')); return m ? Number(m[1]) : null; };
  return { current: num(/Currently banned:\s*(\d+)/), total: num(/Total banned:\s*(\d+)/) };
}

export function render({ ssh, hashes, hardened, bans, ufwActive, now }) {
  const rows = [];
  const add = (name, help, type, series) => {
    rows.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of series) if (v != null) rows.push(`${name}${labels} ${v}`);
  };
  add('eiok_ssh_accepted_10m', `Accepted SSH logins in the last ${WINDOW_MIN} minutes, by whether the source is known.`, 'gauge',
    Object.entries(ssh.accepted).map(([k, v]) => [`{source="${k}"}`, v]));
  add('eiok_ssh_failed_10m', `Failed SSH attempts in the last ${WINDOW_MIN} minutes.`, 'gauge',
    [['{kind="failed"}', ssh.failed], ['{kind="invalid_user"}', ssh.invalidUser]]);
  add('eiok_fail2ban_banned', 'fail2ban sshd jail bans.', 'gauge', [['{state="current"}', bans.current], ['{state="total"}', bans.total]]);
  add('eiok_security_hash', 'First 32 bits of a SHA-256 of an authorized_keys file, sshd -T auth settings or ufw rules (0 = missing).', 'gauge',
    Object.entries(hashes).map(([item, v]) => [`{item="${item}"}`, v]));
  add('eiok_sshd_hardened', 'sshd -T: password and keyboard-interactive login off, root by key only.', 'gauge', [['', hardened == null ? null : Number(hardened)]]);
  add('eiok_ufw_active', 'ufw reports itself active.', 'gauge', [['', ufwActive == null ? null : Number(ufwActive)]]);
  add('eiok_security_updated_seconds', 'When these counters were last written.', 'gauge', [['', Math.round(now / 1000)]]);
  return `${rows.join('\n')}\n`;
}

// A command that fails is named in the journal (its output never: it may hold addresses), and its numbers are left out.
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (err) { console.error(JSON.stringify({ event: 'security_check_failed', cmd, status: err.status ?? null, signal: err.signal ?? null })); return null; }
};
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };

function main() {
  const journal = run('journalctl', ['-t', 'sshd', '-t', 'sshd-session', '--since', `-${WINDOW_MIN}min`, '-o', 'cat', '--no-pager']) ?? '';
  const ssh = sshCounts(journal.split('\n'), knownSources(process.env.SSH_KNOWN_SOURCES));
  const hashes = { keys_root: shortHash(read('/root/.ssh/authorized_keys')) };
  let homes = [];
  try { homes = readdirSync('/home'); } catch { /* none */ }
  for (const u of homes) if (/^[a-z_][a-z0-9_-]{0,31}$/.test(u)) hashes[`keys_${u}`] = shortHash(read(`/home/${u}/.ssh/authorized_keys`));
  const sshd = sshdAuth(run('sshd', ['-T']));
  hashes.sshd_auth = sshd.text ? shortHash(sshd.text) : 0;
  const ufw = run('ufw', ['status', 'verbose']);
  hashes.ufw = shortHash(ufw);
  const out = process.env.SECURITY_PROM ?? '/var/lib/japharsworld-yt-deploy/security.prom';
  writeFileSync(`${out}.tmp`, render({ ssh, hashes, hardened: sshd.hardened, bans: fail2ban(run('fail2ban-client', ['status', 'sshd'])),
    ufwActive: ufw == null ? null : /^Status: active/m.test(ufw), now: Date.now() }));
  renameSync(`${out}.tmp`, out);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
