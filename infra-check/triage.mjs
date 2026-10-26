#!/usr/bin/env node
// Severe-alert triage (owner, 2026-10-26): the yt-infra-triage timer runs this every 2 minutes on the Optiplex. It asks
// Grafana Cloud's alertmanager which critical alerts are firing (the read-only GRAFANA_TOKEN of the weekly check; the
// home network stays outbound-only, so no webhook comes in), and on a new one runs Claude Code headless with
// triage-prompt.md (read only, the weekly check's rules) and posts its diagnosis to Discord as "SEVERE: …" with the
// report attached. Each alert is triaged at most once per 6 hours and at most 6 runs a day; past the cap, or when Claude
// can't run (an expired login), the alert still goes to Discord, just without a diagnosis.
// The unit holds the weekly check's lock (flock on ~/yt-infra-check/.lock), so the two never run together.
//   node triage.mjs                                   poll once (the timer)
//   node triage.mjs --synthetic security|down [--dry-run]   a made-up alert through the same path, state untouched;
//                                                     --dry-run prints the Discord text instead of posting it
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));   // the relay worker's checkout of main: triage-prompt.md
const BASE = join(homedir(), 'yt-infra-check');          // .env, reports/, logs/, the state file (never in the repo)
const REPEAT_MS = 6 * 3600_000;
const DAILY_MAX = 6;
const CLAUDE_TIMEOUT_MS = 20 * 60_000;
const LOGIN_RE = /not logged in|login|authenticat|token expired|oauth/i;   // as run.sh

// The made-up alerts for --synthetic: the shapes Grafana sends for two of the real rules (tools/grafana.mjs).
const SYNTHETIC = {
  security: { alertname: 'Linode keys, sshd or ufw changed', uid: 'eiok-security-change', item: 'ufw',
    summary: 'SECURITY: ufw changed on the Linode (an authorized_keys file, the sshd auth settings or the ufw rules). Fine if it was planned; otherwise check it now.' },
  down: { alertname: 'Search service down', uid: 'eiok-search-down',
    summary: 'The search service has not answered /healthz on the Linode for 5 minutes.' },
};

export function syntheticAlert(kind, now) {
  const s = SYNTHETIC[kind];
  if (!s) throw new Error(`--synthetic takes ${Object.keys(SYNTHETIC).join(' or ')}`);
  return {
    fingerprint: `synthetic-${kind}`, startsAt: new Date(now).toISOString(), status: { state: 'active' },
    labels: { alertname: s.alertname, __alert_rule_uid__: s.uid, severity: 'critical', project: 'everything-is-ok', ...(s.item && { item: s.item }) },
    annotations: { summary: s.summary },
  };
}

// Firing, not silenced (a planned change gets a silence), critical, and ours.
export function severe(alerts) {
  return alerts.filter((a) => a.status?.state === 'active' && a.labels?.severity === 'critical' && a.labels?.project === 'everything-is-ok');
}

// The security rules' details (addresses, keys, ports) stay off GitHub: their triage files nothing there.
export function isSecurity(a) {
  return /^SECURITY:/.test(a.annotations?.summary ?? '') || /ssh|security|fail2ban|ufw/i.test(`${a.labels?.__alert_rule_uid__ ?? ''} ${a.labels?.alertname ?? ''}`);
}

export function kindOf(a) {
  if (isSecurity(a)) return 'security';
  if (/channels/i.test(a.labels?.alertname ?? '')) return 'channels';
  return /down|silent|unreachable|not active|no worker/i.test(a.labels?.alertname ?? '') ? 'down' : 'other';
}

// One triage run per poll covers every new alert. Past the daily cap they are still announced, without a run.
export function pick(alerts, state, now, { repeatMs = REPEAT_MS, dailyMax = DAILY_MAX } = {}) {
  const fresh = alerts.filter((a) => !(now - (state.seen[a.fingerprint] ?? -Infinity) < repeatMs));
  if (!fresh.length) return { triage: [], capped: [] };
  const runs = state.runs.filter((t) => now - t < 86400_000).length;
  return runs >= dailyMax ? { triage: [], capped: fresh } : { triage: fresh, capped: [] };
}

export function record(state, alerts, now, { ran }) {
  const seen = Object.fromEntries(Object.entries(state.seen).filter(([, t]) => now - t < 86400_000));
  for (const a of alerts) seen[a.fingerprint] = now;
  const runs = state.runs.filter((t) => now - t < 86400_000);
  if (ran) runs.push(now);
  return { seen, runs };
}

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'alert';

const chicago = (ms, opts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', ...opts }).format(new Date(ms));
const day = (ms) => chicago(ms, { year: 'numeric', month: '2-digit', day: '2-digit' });
const clock = (ms) => chicago(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function headline(alerts, test) {
  const names = alerts.map((a) => `${a.labels.alertname}${a.labels.item ? ` (${a.labels.item})` : ''}`).join('; ');
  const since = Math.min(...alerts.map((a) => Date.parse(a.startsAt) || Date.now()));
  return `SEVERE:${test ? ' [synthetic test]' : ''} ${names}, firing since ${clock(since)} Central`;
}

// Discord's limit is 2,000 characters.
export function discordText({ alerts, note, report, test = false }) {
  const tail = report ? `\nReport attached (Optiplex: ~/yt-infra-check/reports/${basename(report)})` : '';
  return `${headline(alerts, test)}\n${note.trim()}`.slice(0, 1990 - tail.length) + tail;
}

export function fallbackText({ alerts, reason, test = false }) {
  const summaries = alerts.map((a) => a.annotations?.summary).filter(Boolean).join('\n');
  return `${headline(alerts, test)}\n${summaries}\nTriage couldn't run: ${reason}`.slice(0, 1990);
}

function loadState(file) {
  try { const s = JSON.parse(readFileSync(file, 'utf8')); return { seen: s.seen ?? {}, runs: s.runs ?? [] }; }
  catch { return { seen: {}, runs: [] }; }
}

function saveState(file, state) {
  writeFileSync(`${file}.tmp`, JSON.stringify(state));
  renameSync(`${file}.tmp`, file);
}

async function firing() {
  const base = process.env.GRAFANA_URL?.replace(/\/$/, '');
  if (!base || !process.env.GRAFANA_TOKEN) throw new Error('GRAFANA_URL and GRAFANA_TOKEN are not set in ~/yt-infra-check/.env');
  const r = await fetch(`${base}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false`, {
    headers: { authorization: `Bearer ${process.env.GRAFANA_TOKEN}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`Grafana alerts: HTTP ${r.status}`);
  return r.json();
}

// Every post is severe, so it pings the owner when DISCORD_MENTION_ID is set in ~/yt-infra-check/.env (owner,
// 2026-10-26); only that user may be pinged, whatever the text says.
export function discordPayload(content, mention) {
  if (!/^\d{5,25}$/.test(mention ?? '')) return { content, allowed_mentions: { parse: [] } };
  return { content: `<@${mention}> ${content}`.slice(0, 2000), allowed_mentions: { parse: [], users: [mention] } };
}

async function discord(text, file, dryRun) {
  const p = discordPayload(text, process.env.DISCORD_MENTION_ID);
  if (dryRun) { console.log(`--- Discord text (dry run, not posted${file ? `; attachment ${basename(file)}` : ''}) ---\n${p.content}\n---`); return; }
  const payload = JSON.stringify(p);
  let body, headers = {};
  if (file && existsSync(file)) {
    body = new FormData();
    body.append('payload_json', payload);
    body.append('files[0]', new Blob([readFileSync(file)], { type: 'text/markdown' }), basename(file));
  } else {
    body = payload; headers = { 'content-type': 'application/json' };
  }
  const r = await fetch(process.env.DISCORD_WEBHOOK_URL, { method: 'POST', body, headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Discord: HTTP ${r.status}`);
}

function triage(alerts, now, test) {
  const stamp = `${day(now)}-${clock(now).replace(':', '')}`;
  const name = `${stamp}-triage-${test ? 'test-' : ''}${slug(alerts[0].labels.__alert_rule_uid__ ?? alerts[0].labels.alertname)}`;
  const report = join(BASE, 'reports', `${name}.md`);
  const note = join(BASE, 'reports', `${name}.discord.txt`);
  const context = alerts.map((a) => ({ kind: kindOf(a), labels: a.labels, summary: a.annotations?.summary, startsAt: a.startsAt }));
  const prompt = `${readFileSync(join(KIT, 'triage-prompt.md'), 'utf8')}

${test ? 'SYNTHETIC TEST: these alerts are made up to test this path. Check the real state as you would, but open and comment on no GitHub issues; say in the note what you would have filed.\n\n' : ''}Now: ${day(now)} ${clock(now)} (America/Chicago). Report: ${report}. Discord note: ${note}.
Alerts (JSON):
${JSON.stringify(context, null, 2)}`;
  // Claude posts nothing to Discord itself; the webhook stays with this script.
  const { DISCORD_WEBHOOK_URL, ...env } = process.env;
  const r = spawnSync('claude', ['-p', prompt, '--allowedTools', 'Bash,Read,Write', '--permission-prompts', 'none', '--output-format', 'json'],
    { cwd: BASE, env, encoding: 'utf8', timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 64 << 20 });
  writeFileSync(join(BASE, 'logs', `${name}.json`), r.stdout ?? '');
  writeFileSync(join(BASE, 'logs', `${name}.stderr`), `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`);
  if (r.status === 0 && existsSync(note)) return { note: readFileSync(note, 'utf8'), report: existsSync(report) ? report : null };
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const reason = r.error?.code === 'ENOENT' ? 'claude is not installed or not on PATH.'
    : r.error?.code === 'ETIMEDOUT' ? `it took over ${CLAUDE_TIMEOUT_MS / 60_000} minutes.`
    : LOGIN_RE.test(out) ? 'the Claude Code login expired. On the Optiplex run `claude setup-token`, then update CLAUDE_CODE_OAUTH_TOKEN in ~/yt-infra-check/.env.'
    : `claude exited ${r.status ?? r.signal}${existsSync(note) ? '' : ' without a note'}. Logs: ~/yt-infra-check/logs/${name}.*`;
  return { reason, report: existsSync(report) ? report : null };
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const synthetic = argv.includes('--synthetic') ? argv[argv.indexOf('--synthetic') + 1] : null;
  process.loadEnvFile(join(BASE, '.env'));
  mkdirSync(join(BASE, 'reports'), { recursive: true });
  mkdirSync(join(BASE, 'logs'), { recursive: true });
  const now = Date.now();
  const stateFile = join(BASE, 'triage-state.json');
  const state = synthetic ? { seen: {}, runs: [] } : loadState(stateFile);
  const alerts = synthetic ? [syntheticAlert(synthetic, now)] : severe(await firing());
  const { triage: todo, capped } = pick(alerts, state, now);
  let next = state;
  if (capped.length) {
    await discord(fallbackText({ alerts: capped, reason: `${DAILY_MAX} triage runs in the last 24 hours already (the daily cap).`, test: !!synthetic }), null, dryRun);
    next = record(next, capped, now, { ran: false });
  }
  if (todo.length) {
    console.log(`triaging ${todo.length} alert(s): ${todo.map((a) => a.labels.alertname).join('; ')}`);
    const t = triage(todo, now, !!synthetic);
    await discord(t.note ? discordText({ alerts: todo, note: t.note, report: t.report, test: !!synthetic })
      : fallbackText({ alerts: todo, reason: t.reason, test: !!synthetic }), t.report, dryRun);
    next = record(next, todo, now, { ran: true });
  }
  if (!synthetic && next !== state) saveState(stateFile, next);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`triage failed: ${e.message}`); process.exit(1); });
}
