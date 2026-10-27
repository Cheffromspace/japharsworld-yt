#!/usr/bin/env node
// Hourly hypercare (world #208, owner 2026-10-26): the yt-hypercare timer runs this on the Optiplex, replacing the
// coordinator's 30-minute loop. Read only, no Claude: it collects counts for the last hour (the Linode over
// `ssh linode-check`, the Optiplex locally, the public /healthz), compares them with fixed limits and stays quiet when
// all is normal (one log line). A new problem goes to Discord (the weekly check's webhook, pinging DISCORD_MENTION_ID)
// and gets one issue in the private world repo, an `owner-task` card when the owner has to act (a unit down, the
// public address failing, a disk filling). Still abnormal after 6 hours: Discord again and a comment. Recovered: a
// quiet Discord line and a comment. It never restarts or fixes anything.
// It ends itself (world #236, owner 2026-10-26): after 7 days of consecutive clean runs (any finding starts the count
// again) it posts one Discord line and a comment on world #208, then disables its own user timer.
// The journal is counted on the Linode (awk), so no log line, video ID or address ever reaches this machine. MediaMTX
// moved to its own Linode (2026-10-26), which has no check account: a TCP connect to its public RTSP port 8554
// (open in its ufw by design) at HYPERCARE_MEDIAMTX_HOST from the .env, never in the repo; unset = skipped.
//   node hypercare.mjs              one run (the timer)
//   node hypercare.mjs --dry-run    the real checks, but prints what it would post and file; state untouched
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discordPayload } from './triage.mjs';

const BASE = join(homedir(), 'yt-infra-check');   // .env (DISCORD_WEBHOOK_URL, DISCORD_CRITICAL_WEBHOOK, DISCORD_MENTION_ID), the state file
const REPO = 'Cheffromspace/Everything-is-OK';
const HEALTHZ = 'https://yt.japharsworld.com/healthz';
const REPEAT_MS = 6 * 3600_000;
const HYPERCARE_ISSUE = 208;
// 7 days of hourly runs, and 7 days by the clock too (manual or Persistent catch-up runs don't shorten it).
export const END_AFTER = { runs: 7 * 24, ms: (7 * 24 - 1) * 3600_000 };   // 168 runs an hour apart span 167 h
const MARK = '<!-- coordinator -->';   // the board watcher skips marked comments: agents share the owner's GitHub account
const LINODE_UNITS = ['japharsworld-yt', 'caddy'];
// The flash worker is a oneshot its timer starts; its last run's Result says whether it worked.
const OPTIPLEX_UNITS = ['japharsworld-yt-relay', 'bgutil-pot-relay', 'japharsworld-yt-slotworker.timer'];

// Limits per hour, overridable in ~/yt-infra-check/.env as HYPERCARE_<NAME>. Set from the 48 h before 2026-10-26 19:30
// UTC: no 5xx, no backoff, no evictions, 3 home_failed, 1 of 17 captions with zero tracks, 39 % disk, 0 banned.
export const LIMITS = { DISK: 80, S5: 3, ERRORS: 5, YT: 3, BACKOFF: 1, CAP0: 3, EVICT: 20, OVERCAP: 1, BANNED: 20 };
export function limits(env = process.env) {
  return Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => {
    const n = Number(env[`HYPERCARE_${k}`]);
    return [k, Number.isFinite(n) && env[`HYPERCARE_${k}`] !== '' && env[`HYPERCARE_${k}`] != null ? n : v];
  }));
}

// Runs on the Linode as ytcheck (systemd-journal group; sudo only for fail2ban-client status sshd). Prints counts only.
// A refused Tunelio /create logs tunelio_error and then build_failed (reason tunelio_failed) for the same build, so the
// second is not counted (2026-10-27: one video Tunelio said "not found" for, played 3 times, was 6 of 10 errors).
export const LINODE_PROBE = `
for u in ${LINODE_UNITS.join(' ')}; do echo "unit:$u $(systemctl is-active $u)"; done
echo "disk $(df --output=pcent / | tail -1 | tr -dc 0-9)"
echo "banned $(sudo -n fail2ban-client status sshd 2>/dev/null | sed -n 's/.*Currently banned:[[:space:]]*//p')"
journalctl -u japharsworld-yt --since -60min -o cat --no-pager | awk '
/"status":5[0-9][0-9]/ { s5++ }
/"event":"(error|[a-z_]*_error|[a-z_]*_failed)"/ && !(/"event":"build_failed"/ && /"reason":"tunelio_failed"/) { errors++ }
/"event":"youtube_error"/ { yt++ }
/"event":"backoff"/ { backoff++ }
/"event":"captions_via"/ { if (/"tracks":0[,}]/) cap0++; else if (/"tracks":[1-9]/) cap1++ }
/"event":"home_evict"/ { evict++ }
/"event":"home_over_cap"/ { overcap++ }
END { printf "s5 %d\\nerrors %d\\nyt %d\\nbackoff %d\\ncap0 %d\\ncap1 %d\\nevict %d\\novercap %d\\njournal ok\\n", s5, errors, yt, backoff, cap0, cap1, evict, overcap }'
`;

// "key value" lines → { key: value }, numbers as numbers.
export function parseProbe(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.trim().match(/^(\S+)\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
  }
  return out;
}

const where = { linode: 'the Linode', media: 'the media-mtx Linode', optiplex: 'the Optiplex' };

// The measurements → findings. owner: the owner has to act (restart, clean up), so it becomes an owner-task card.
export function evaluate(m, lim) {
  const f = [];
  const add = (key, owner, title, detail) => f.push({ key, owner, title, detail });
  for (const host of ['linode', 'media', 'optiplex']) {
    const p = m[host];
    if (!p) continue;   // not configured (media without HYPERCARE_MEDIAMTX_HOST)
    if (p.error) { add(`probe:${host}`, false, `Hypercare can't read ${where[host]}`, p.error); continue; }
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith('unit:') && v !== 'active') add(`${host}:${k}`, true, `${k.slice(5)} is not active on ${where[host]}`, `systemctl is-active says "${v || 'nothing'}".`);
      if (k === 'rtsp' && v !== 'open') add(`${host}:rtsp`, true, `MediaMTX is not answering on ${where[host]}`, `A TCP connect to its RTSP port 8554 gave: ${v}.`);
    }
  }
  const o = m.optiplex;
  if (o && !o.error && o.slotworker_result && o.slotworker_result !== 'success') {
    add('optiplex:slotworker-result', false, 'The flash-check worker\'s last run failed on the Optiplex', `japharsworld-yt-slotworker.service Result=${o.slotworker_result}.`);
  }
  if (m.healthz && !m.healthz.ok) add('healthz', true, 'yt.japharsworld.com/healthz is not answering', m.healthz.detail);
  const l = m.linode;
  if (l && !l.error) {
    if (l.journal !== 'ok') add('linode:journal', false, 'Hypercare can\'t count the search service\'s journal', 'The journal count on the Linode printed nothing.');
    const over = (v, limit) => Number(v) >= limit;
    if (over(l.disk, lim.DISK)) add('linode:disk', true, `The Linode's disk is ${l.disk} % full`, `Limit ${lim.DISK} %.`);
    if (over(l.s5, lim.S5)) add('linode:5xx', false, 'The search service answered 5xx', `${l.s5} in the last hour (limit ${lim.S5}).`);
    if (over(l.errors, lim.ERRORS)) add('linode:errors', false, 'Error events in the search service\'s journal', `${l.errors} error or *_failed events in the last hour (limit ${lim.ERRORS}).`);
    if (over(l.yt, lim.YT)) add('linode:youtube', false, 'YouTube is refusing the search service', `${l.yt} youtube_error events in the last hour (limit ${lim.YT}).`);
    if (over(l.backoff, lim.BACKOFF)) add('linode:backoff', false, 'The search service backed off from YouTube', `${l.backoff} backoff events in the last hour (limit ${lim.BACKOFF}).`);
    if (over(l.cap0, lim.CAP0) && Number(l.cap0) > Number(l.cap1)) add('linode:captions', false, 'Most captions came back with no tracks', `${l.cap0} with no tracks against ${l.cap1} with tracks in the last hour (limit ${lim.CAP0}).`);
    if (over(l.evict, lim.EVICT)) add('linode:evict', false, 'The home cache is evicting a lot', `${l.evict} home_evict in the last hour (limit ${lim.EVICT}).`);
    if (over(l.overcap, lim.OVERCAP)) add('linode:overcap', false, 'The home cache is over its cap', `${l.overcap} home_over_cap in the last hour.`);
    if (over(l.banned, lim.BANNED)) add('linode:banned', false, 'fail2ban is banning many SSH clients', `${l.banned} currently banned for sshd (limit ${lim.BANNED}).`);
  }
  return f;
}

// One JSON line for the journal: counts and unit states only.
export function logLine(m, findings, at = new Date().toISOString()) {
  const l = m.linode && !m.linode.error ? m.linode : {};
  const units = {};
  for (const host of ['linode', 'optiplex']) {
    for (const [k, v] of Object.entries(m[host] ?? {})) if (k.startsWith('unit:')) units[k.slice(5)] = v;
  }
  return JSON.stringify({ at, event: 'hypercare', ok: findings.length === 0, findings: findings.map((x) => x.key),
    healthz: m.healthz?.ok ?? null, units, mediamtx: m.media?.rtsp ?? 'unchecked',
    disk: l.disk ?? null, s5: l.s5 ?? null, errors: l.errors ?? null, yt: l.yt ?? null, backoff: l.backoff ?? null,
    cap0: l.cap0 ?? null, cap1: l.cap1 ?? null, evict: l.evict ?? null, overcap: l.overcap ?? null, banned: l.banned ?? null });
}

// New findings get an issue and an alert; open ones are re-alerted after REPEAT_MS; gone ones are recovered.
export function plan(findings, state, now, repeatMs = REPEAT_MS) {
  const keys = new Set(findings.map((f) => f.key));
  return {
    fresh: findings.filter((f) => !state.open[f.key]),
    repeat: findings.filter((f) => state.open[f.key] && now - state.open[f.key].alerted >= repeatMs),
    recovered: Object.entries(state.open).filter(([k]) => !keys.has(k)).map(([key, v]) => ({ key, ...v })),
  };
}

// The clean streak: a run with no findings adds one (the first sets cleanSince), any finding resets it.
export function streak(state, findings, now, end = END_AFTER) {
  const clean = findings.length ? 0 : (state.clean ?? 0) + 1;
  const cleanSince = findings.length ? null : (state.cleanSince ?? now);
  return { clean, cleanSince, done: clean >= end.runs && now - cleanSince >= end.ms };
}

const optiplexSteps = (unit) => [
  ['See why it stopped (on the Optiplex)', `journalctl -u ${unit} -n 40 --no-pager`],
  ['Start it again', `sudo systemctl restart ${unit}`],
];
const linodeSteps = (unit) => [
  ['See why it stopped (from your PC)', `ssh linode 'journalctl -u ${unit} -n 40 --no-pager'`],
  ['Start it again', `ssh linode 'systemctl restart ${unit}'`],
];
// The media-mtx Linode's SSH name is the owner's own (no alias for it in the repo).
const mediaSteps = [
  ['On the media-mtx Linode, see why MediaMTX stopped', 'journalctl -u mediamtx -n 40 --no-pager'],
  ['Start it again', 'systemctl restart mediamtx'],
];

// The issue text, following the world repo's .github/ISSUE_TEMPLATE/owner-task.md for owner tasks. No addresses.
export function issueBody(f) {
  const found = `Found by the Optiplex hypercare timer (yt-hypercare, japharsworld-yt \`infra-check/hypercare.mjs\`, world #208): ${f.detail}`;
  if (!f.owner) return `${found}\n\nAn agent can look into this; nothing has been changed. The timer comments here while it lasts and when it recovers.`;
  let steps, time = 5, at = 'your PC (`ssh linode`, root)';
  const unit = f.key.split(':unit:')[1];
  if (f.key.startsWith('optiplex:unit:')) { steps = optiplexSteps(unit); at = 'the Optiplex, as jonflatt (sudo)'; }
  else if (f.key === 'media:rtsp') { steps = mediaSteps; at = 'the media-mtx Linode, as root'; }
  else if (f.key.startsWith('linode:unit:')) steps = linodeSteps(unit);
  else if (f.key === 'linode:disk') {
    time = 15;
    steps = [['See what is using the disk', `ssh linode 'df -h / && du -xsh /var/lib/* /var/log /opt/* 2>/dev/null | sort -h | tail -8'`],
      ['Tell the coordinator what is big (comment here); it proposes what to delete', null]];
  } else {
    steps = [['Check the public address', 'curl -sS -m 10 -o /dev/null -w "%{http_code}\\n" https://yt.japharsworld.com/healthz'],
      ['Check Caddy and the service', `ssh linode 'systemctl status caddy japharsworld-yt --no-pager | head -30'`],
      ['If either is not running, start it again', `ssh linode 'systemctl restart japharsworld-yt caddy'`]];
  }
  const list = steps.map(([t, cmd], i) => `- [ ] ${i + 1}. ${t}${cmd ? `\n  \`\`\`\n  ${cmd}\n  \`\`\`` : ''}`).join('\n');
  return `**Why:** ${f.title}; visitors may be affected until it is back. ${found}
**Time:** about ${time} min · **Where:** ${at} · **Do first:** nothing

### Steps
${list}

### Done when
The next hourly hypercare run is quiet (it comments "recovered" here).

### When finished
Close this issue. The coordinator sees it within 2 minutes.
Stuck or something looks wrong? Comment what you saw and leave the issue open.`;
}

export const issueTitle = (f) => (f.owner ? `Fix: ${f.title}` : `Hypercare: ${f.title}`);
const chicago = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(ms));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 << 20, ...opts });
  return { ok: r.status === 0, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim().slice(0, 300) };
}

function remote(host, script) {
  const r = run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, script]);
  return r.ok || r.out.trim() ? parseProbe(r.out) : { error: `ssh ${host} failed: ${r.err.split('\n')[0] || 'no output'}` };
}

async function healthz() {
  try {
    const r = await fetch(HEALTHZ, { signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.status === 200 && j.ok === true, detail: `HTTP ${r.status}${j.ok === true ? '' : ', ok is not true'}.` };
  } catch (e) { return { ok: false, detail: `No answer: ${e.cause?.code ?? e.name}.` }; }
}

function optiplex() {
  const out = {};
  for (const u of OPTIPLEX_UNITS) out[`unit:${u}`] = run('systemctl', ['is-active', u]).out.trim();
  out.slotworker_result = run('systemctl', ['show', '-p', 'Result', '--value', 'japharsworld-yt-slotworker.service']).out.trim();
  return out;
}

// "open", or why not (the error code only, never the address).
export function tcpProbe(host, port, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done('timeout'));
    s.once('connect', () => done('open'));
    s.once('error', (e) => done(e.code ?? 'error'));
  });
}

async function measure(env) {
  const m = { linode: remote('linode-check', LINODE_PROBE), optiplex: optiplex(), healthz: await healthz() };
  if (env.HYPERCARE_MEDIAMTX_HOST) m.media = { rtsp: await tcpProbe(env.HYPERCARE_MEDIAMTX_HOST, 8554) };
  return m;
}

// gh: find the open issue with this exact title, or file it. Returns its number, or null if GitHub failed.
function fileIssue(f, dry) {
  const title = issueTitle(f);
  const found = run('gh', ['issue', 'list', '-R', REPO, '--state', 'open', '--search', `"${title}" in:title`, '--json', 'number,title']);
  const hit = found.ok ? JSON.parse(found.out || '[]').find((i) => i.title === title) : null;
  if (hit) { comment(hit.number, `Still seen ${chicago(Date.now())} Central: ${f.detail}`, dry); return hit.number; }
  const args = ['issue', 'create', '-R', REPO, '--title', title, '--body-file', '-', ...(f.owner ? ['--label', 'owner-task'] : [])];
  if (dry) { console.log(`--- would file (${f.owner ? 'owner-task' : 'issue'}): ${title} ---\n${issueBody(f)}\n---`); return 0; }
  const r = run('gh', args, { input: issueBody(f) });
  const n = r.out.match(/\/issues\/(\d+)/)?.[1];
  if (!n) console.error(`hypercare: gh issue create failed: ${r.err}`);
  return n ? Number(n) : null;
}

function comment(n, text, dry) {
  if (!n) return;
  if (dry) { console.log(`--- would comment on #${n}: ${text}`); return; }
  const r = run('gh', ['issue', 'comment', String(n), '-R', REPO, '--body-file', '-'], { input: `${text}\n\n${MARK}` });
  if (!r.ok) console.error(`hypercare: gh issue comment failed: ${r.err}`);
}

// critical: the critical channel when DISCORD_CRITICAL_WEBHOOK is set, else the usual one.
export const webhookFor = (critical, env = process.env) => (critical && env.DISCORD_CRITICAL_WEBHOOK) || env.DISCORD_WEBHOOK_URL;

async function discord(text, { mention, critical = false, dry }) {
  const p = discordPayload(text.slice(0, 1900), mention ? process.env.DISCORD_MENTION_ID : null);
  const where = critical && process.env.DISCORD_CRITICAL_WEBHOOK ? 'critical channel' : 'usual channel';
  if (dry) { console.log(`--- Discord (dry run, ${where}${mention ? ', pings the owner' : ''}) ---\n${p.content}\n---`); return; }
  const r = await fetch(webhookFor(critical), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Discord: HTTP ${r.status}`);
}

const ref = (n) => (n ? ` (Everything-is-OK#${n})` : '');

// The Discord posts for one run. Owner findings (the "Fix:" cards) are critical: they go to the critical channel
// (DISCORD_CRITICAL_WEBHOOK, world #195, owner 2026-10-26), the rest to the usual one; problems ping, recoveries don't.
export function posts({ fresh, repeat, recovered }, open) {
  const out = [];
  for (const critical of [true, false]) {
    const f = fresh.filter((x) => !!x.owner === critical);
    const r = repeat.filter((x) => !!x.owner === critical);
    if (f.length || r.length) {
      const lines = [...f.map((x) => `• ${x.title}: ${x.detail}${ref(open[x.key].issue)}${x.owner ? ' [owner task]' : ''}`),
        ...r.map((x) => `• still, since ${chicago(open[x.key].since)}: ${x.title}${ref(open[x.key].issue)}`)];
      out.push({ critical, mention: true, text: `🔴 **YT hypercare:** ${f.length ? `${f.length} new` : ''}${f.length && r.length ? ', ' : ''}${r.length ? `${r.length} still open` : ''}\n${lines.join('\n')}` });
    }
    const back = recovered.filter((x) => !!x.owner === critical);
    if (back.length) out.push({ critical, mention: false, text: `🟢 **YT hypercare recovered:** ${back.map((x) => `${x.title}${ref(x.issue)}`).join('; ')}` });
  }
  return out;
}

async function main(argv) {
  const dry = argv.includes('--dry-run');
  process.loadEnvFile(join(BASE, '.env'));
  mkdirSync(BASE, { recursive: true });
  const stateFile = join(BASE, 'hypercare-state.json');
  let state;
  try { const s = JSON.parse(readFileSync(stateFile, 'utf8')); state = { open: s.open ?? {}, clean: s.clean ?? 0, cleanSince: s.cleanSince ?? null }; }
  catch { state = { open: {}, clean: 0, cleanSince: null }; }
  const now = Date.now();
  const m = await measure(process.env);
  const findings = evaluate(m, limits());
  console.log(logLine(m, findings));
  const { fresh, repeat, recovered } = plan(findings, state, now);
  const open = { ...state.open };
  for (const f of fresh) open[f.key] = { since: now, alerted: now, title: f.title, owner: f.owner, issue: fileIssue(f, dry) };
  for (const f of repeat) { open[f.key].alerted = now; comment(open[f.key].issue, `Still abnormal ${chicago(now)} Central: ${f.detail}`, dry); }
  for (const r of recovered) { comment(r.issue, `Recovered as of ${chicago(now)} Central (hypercare). Close this if nothing else is left.`, dry); delete open[r.key]; }
  for (const p of posts({ fresh, repeat, recovered }, open)) await discord(p.text, { ...p, dry });
  const s = streak(state, findings, now);
  if (!dry) { writeFileSync(`${stateFile}.tmp`, JSON.stringify({ open, ...(s.done ? { clean: 0, cleanSince: null } : { clean: s.clean, cleanSince: s.cleanSince }) })); renameSync(`${stateFile}.tmp`, stateFile); }
  if (s.done) await end(s, dry);
}

// 7 clean days: say so once, then turn the timer off; the run in progress finishes, the timer starts no other. The
// saved count is back at 0, so re-enabling it gives another 7 days. A failed post doesn't keep the timer on.
async function end(s, dry) {
  const text = `Hypercare ended: ${s.clean} clean hourly runs in a row since ${chicago(s.cleanSince)} Central, so the yt-hypercare timer turned itself off (world #236). Turn it back on with \`systemctl --user enable --now yt-hypercare.timer\` on the Optiplex.`;
  try { await discord(`🟢 **YT hypercare:** ${text}`, { mention: false, dry }); } catch (e) { console.error(`hypercare: ${e.message}`); }
  comment(HYPERCARE_ISSUE, text, dry);
  if (dry) { console.log('--- would run: systemctl --user disable --now yt-hypercare.timer'); return; }
  const r = run('systemctl', ['--user', 'disable', '--now', 'yt-hypercare.timer']);
  if (!r.ok) throw new Error(`systemctl --user disable failed: ${r.err}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`hypercare failed: ${e.message}`); process.exit(1); });
}
