// Metrics poller (claude/metrics.md), run by japharsworld-yt-metrics.timer about every 15 minutes.
//   node metrics/poll.js                    one pass: VRChat; once a day Tunelio + GitHub; the reports when due
//   node metrics/poll.js report [--day D] [--weekly] [--send]   print (or send) a report now
//
// Starts as root only to read and update the VRChat session in the root-only secrets file (and its state file),
// then drops to the service user before touching the metrics database.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openMetricsDb, recordPoll, getMeta, setMeta, dayOf } from '../src/metrics.js';
import { makeAlert } from '../src/alert.js';
import { addDays, billingPeriod, daysBetween } from '../src/stats.js';
import { VRChat, worldValues, groupValues } from './vrchat.js';
import { tunelioCredits, githubRepo } from './sources.js';
import { dailyReport, weeklyReport, testWorld, chunks } from './report.js';

const env = process.env;
export const settings = (e = env) => ({
  db: e.METRICS_DB ?? '/var/lib/japharsworld-yt/metrics.db',
  tz: e.METRICS_TZ ?? 'America/Chicago',
  monitorDb: e.MONITOR_DB ?? '/var/lib/japharsworld-yt-monitor/monitor.db',
  webhook: e.ALERT_WEBHOOK ?? '',
  reportHour: Number.parseInt(e.METRICS_REPORT_HOUR ?? '9', 10),
  tunelioKey: e.TUNELIO_API_KEY ?? '',
  tunelioRenewsDay: Number.parseInt(e.TUNELIO_RENEWS_DAY ?? '1', 10) || 1,
  vrchat: {
    username: e.VRCHAT_USERNAME ?? '', password: e.VRCHAT_PASSWORD ?? '', totpSecret: e.VRCHAT_TOTP_SECRET ?? '',
    authCookie: e.VRCHAT_AUTH_COOKIE ?? '', twoFactorCookie: e.VRCHAT_2FA_COOKIE ?? '',
  },
  // name=world id, comma separated. Production is EverythingIsOKPublish.WorldId, TEST is the auto test upload's.
  worlds: (e.VRCHAT_WORLDS ?? 'prod=wrld_63bed747-6c3d-428c-b2f4-1a904afa7df8,test=wrld_471c100d-251f-4526-a1b3-5de45b36cc17')
    .split(',').map((s) => s.trim().split('=')).filter(([k, v]) => k && /^wrld_[0-9a-f-]{36}$/.test(v ?? '')),
  groupId: /^grp_[0-9a-f-]{36}$/.test(e.VRCHAT_GROUP_ID ?? '') ? e.VRCHAT_GROUP_ID : '',
  userAgent: `EverythingIsOK-metrics/1.0 ${e.METRICS_CONTACT || 'https://github.com/Cheffromspace/japharsworld-yt'}`,
  githubToken: e.GITHUB_TOKEN ?? '',
  githubRepos: (e.GITHUB_REPOS ?? 'Cheffromspace/japharsworld-yt,Cheffromspace/Everything-is-OK').split(',').map((s) => s.trim()).filter(Boolean),
  secretsFile: e.METRICS_SECRETS ?? '/etc/japharsworld-yt-metrics.env',
  stateFile: e.METRICS_STATE ?? '/var/lib/japharsworld-yt-metrics/state.json',
  runAs: e.METRICS_RUN_AS ?? 'jyt',
});

const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const HOUR = 3600_000;

function readState(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }
function writeState(path, s) {
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(s, null, 1), { mode: 0o600 }); } catch (err) { log({ event: 'state_write_failed', message: String(err.message) }); }
}

// KEY=value lines updated in place (others kept). Written in place, not renamed: systemd lets the poller write this
// one file, not /etc.
export function updateEnvFile(path, updates) {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = text.split('\n');
  for (const [k, v] of Object.entries(updates)) {
    if (/[\n\r]/.test(v)) throw new Error('newline in env value');
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, `${k}=${v}`);
  }
  writeFileSync(path, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
}

// VRChat part: → [{ source, values }]. Never throws; failures alert (login) or back off (429).
export async function pollVRChat(cfg, { state, alert, now = Date.now(), fetcher = fetch, sleep, saveCookies = () => {} }) {
  const v = cfg.vrchat;
  if (!(v.authCookie || (v.username && v.password && v.totpSecret))) return { rows: [], skipped: 'not_configured' };
  if ((state.backoffUntil ?? 0) > now) return { rows: [], skipped: 'backoff' };
  // After a failed login, try again at most every 6 hours (each failed login counts against the account).
  const allowLogin = !(state.loginFailedAt && now - state.loginFailedAt < 6 * HOUR);
  const vr = new VRChat({ ...v, userAgent: cfg.userAgent, fetcher, now: () => now, ...(sleep ? { sleep } : {}) });
  const rows = [];
  try {
    for (const [name, id] of cfg.worlds) rows.push({ source: `world:${name}`, values: worldValues(await vr.world(id, { allowLogin })) });
    if (cfg.groupId) rows.push({ source: 'group', values: groupValues(await vr.group(cfg.groupId, { allowLogin })) });
    if (state.loginFailedAt) delete state.loginFailedAt;
    state.backoffMinutes = 0;
  } catch (err) {
    log({ event: 'vrchat_error', status: err.status, code: err.code, message: String(err.message).slice(0, 200) });
    if (err.status === 429) {
      const minutes = Math.min(360, Math.max(30, (state.backoffMinutes ?? 15) * 2, Math.ceil((err.retryAfter ?? 0) / 60)));
      state.backoffMinutes = minutes;
      state.backoffUntil = now + minutes * 60_000;
    } else if (err.code === 'login_failed' || err.code === 'no_credentials' || (err.status === 401 && !allowLogin)) {
      if (err.code !== 'unauthorized') state.loginFailedAt = now;
      if (!state.loginAlertAt || now - state.loginAlertAt > 6 * HOUR) {
        state.loginAlertAt = now;
        alert('vrchat_login', `Metrics: VRChat login failed (${String(err.message).slice(0, 160)}). VRChat numbers are paused; next try in 6 hours. Check /etc/japharsworld-yt-metrics.env.`, 0);
      }
    }
  }
  if (vr.changed) {
    try { saveCookies({ VRCHAT_AUTH_COOKIE: vr.cookies.auth, VRCHAT_2FA_COOKIE: vr.cookies.twoFactorAuth ?? '' }); log({ event: 'vrchat_login', ok: true }); } catch (err) { log({ event: 'vrchat_cookie_save_failed', message: String(err.message) }); }
  }
  return { rows };
}

function dropPrivileges(user) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0 || !user) return;
  process.initgroups(user, user);
  process.setgid(user);
  process.setuid(user);
}

// A webhook post we can wait for (makeAlert itself does not wait).
function waitingAlert(webhook) {
  let pending = Promise.resolve();
  const alert = makeAlert({ webhook, username: 'Everything is OK stats', log, fetcher: (u, o) => (pending = fetch(u, o).then((r) => { if (!r.ok) throw new Error(`discord ${r.status}`); return r; })) });
  return { alert, wait: () => pending };
}

async function send(cfg, kind, text) {
  if (!cfg.webhook) { console.log(text); return true; }
  const { alert, wait } = waitingAlert(cfg.webhook);
  for (const [i, part] of chunks(text).entries()) {
    alert(`${kind}_${i}`, part, 0);
    await wait();
  }
  return true;
}

const lastCredits = (db) => db.prepare("SELECT value FROM polls WHERE source = 'tunelio' AND metric = 'credits' ORDER BY ts DESC LIMIT 1").get()?.value ?? null;

// Every pass: Tunelio's balance and plan (free). Its wallet funds (what auto-renew pays from) are not in the API, so
// this watches what it can: a lapsed plan reports "trial", a renewal shows up as a jump in credits.
export async function tunelioPass(db, cfg, { now = Date.now(), fetcher = fetch, alert = () => {} } = {}) {
  let tc;
  try { tc = await tunelioCredits({ key: cfg.tunelioKey, fetcher }); } catch (err) { log({ event: 'tunelio_credits_error', message: String(err.message) }); return null; }
  if (!tc || !Number.isFinite(tc.credits)) return null;
  const prevPlan = getMeta(db, 'tunelio_plan');
  const prev = lastCredits(db);
  recordPoll(db, { ts: now, source: 'tunelio', values: { credits: tc.credits }, tz: cfg.tz });
  if (tc.plan) setMeta(db, 'tunelio_plan', tc.plan);
  if (prevPlan && tc.plan && tc.plan !== prevPlan) {
    alert('tunelio_plan', tc.plan === 'trial'
      ? `Tunelio plan lapsed: it now reports "trial" (was "${prevPlan}"). Auto-renew probably found too little in the wallet. Top up and renew at tunelio.dev; search videos fall back to YouTube 360p when credits run out.`
      : `Tunelio plan changed: "${prevPlan}" → "${tc.plan}".`);
  }
  if (prev != null && tc.credits > prev + 1000) {
    setMeta(db, 'tunelio_refreshed', dayOf(now, cfg.tz));
    alert('tunelio_refresh', `Tunelio credits refreshed: ${tc.credits.toLocaleString('en-US')} (plan ${tc.plan || '?'}).`);
  }
  return tc;
}

// Reminders around the renewal day (TUNELIO_RENEWS_DAY): 3 days and 1 day before, and a warning when no refresh was
// seen by the day after. Returns the texts to send; each is given once (remembered in meta).
export function renewalReminders(db, cfg, { today }) {
  const out = [];
  const { start, renews } = billingPeriod(today, cfg.tunelioRenewsDay);
  const left = daysBetween(today, renews);
  const credits = lastCredits(db);
  const have = credits == null ? '' : ` ${credits.toLocaleString('en-US')} credits left.`;
  const once = (key, text) => { if (getMeta(db, 'renew_note') === key) return; setMeta(db, 'renew_note', key); out.push(text); };
  if (left === 3 || left === 1) {
    once(`${renews}:${left}`, `Tunelio renews ${left === 1 ? 'tomorrow' : 'in 3 days'} (${renews}) from your wallet funds. The API can't read the wallet, so check it at tunelio.dev and top up if needed.${have}`);
  }
  if (today === addDays(start, 1) && (getMeta(db, 'tunelio_refreshed') ?? '') < start) {
    once(`${start}:missed`, `Tunelio was due to renew on ${start}, but no credit refresh has been seen.${have} Check the plan and wallet at tunelio.dev.`);
  }
  return out;
}

// World versions (at = VRChat's updated_at, the upload time) and GitHub release tags, recorded the first time they are seen.
export function recordReleases(db, list, now = Date.now()) {
  const put = db.prepare('INSERT OR IGNORE INTO releases (source, version, at, detected) VALUES (?, ?, ?, ?)');
  let added = 0;
  for (const r of list) if (Number.isFinite(r.at) && r.at > 0 && r.version != null) added += Number(put.run(r.source, String(r.version), r.at, now).changes);
  return added;
}

export async function dailySources(db, cfg, { now = Date.now(), fetcher = fetch } = {}) {
  const gauge = db.prepare(`INSERT INTO gauges (day, metric, key, value, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day, metric, key) DO UPDATE SET value = excluded.value, at = excluded.at`);
  for (const repo of cfg.githubRepos) {
    try {
      const g = await githubRepo({ repo, token: cfg.githubToken, userAgent: cfg.userAgent, fetcher });
      if (!g) { log({ event: 'github_skipped', repo }); continue; }
      recordPoll(db, { ts: now, source: `github:${g.repo}`, values: g.values, tz: cfg.tz });
      for (const r of g.traffic) gauge.run(r.day, r.metric, g.repo, r.value, now);
      recordReleases(db, g.tags.map((t) => ({ source: `github:${g.repo}`, version: t.tag, at: t.at })), now);
    } catch (err) { log({ event: 'github_error', repo, message: String(err.message) }); }
  }
}

export async function run(cfg = settings(), { now = Date.now() } = {}) {
  // 1. As root: the VRChat session.
  const state = readState(cfg.stateFile);
  const { alert } = waitingAlert(cfg.webhook);
  const vr = await pollVRChat(cfg, { state, alert, now, saveCookies: (u) => updateEnvFile(cfg.secretsFile, u) });
  writeState(cfg.stateFile, state);
  // 2. As the service user: the database.
  dropPrivileges(cfg.runAs);
  const db = openMetricsDb(cfg.db);
  try {
    for (const r of vr.rows) recordPoll(db, { ts: now, source: r.source, values: r.values, tz: cfg.tz });
    const fresh = recordReleases(db, vr.rows.filter((r) => r.source.startsWith('world:') && r.values.version != null)
      .map((r) => ({ source: r.source, version: r.values.version, at: (r.values.updatedAt ?? 0) * 1000 })), now);
    const notes = [];
    const tc = await tunelioPass(db, cfg, { now, alert: (kind, text) => notes.push([kind, text]) });
    for (const [kind, text] of notes) await send(cfg, kind, text).catch((err) => log({ event: 'alert_failed', kind, message: String(err.message) }));
    log({ event: 'metrics_poll', vrchat: vr.skipped ?? vr.rows.length, releases: fresh, credits: tc?.credits ?? null });
    const today = dayOf(now, cfg.tz);
    if (getMeta(db, 'daily_sources') !== today) {
      await dailySources(db, cfg, { now });
      setMeta(db, 'daily_sources', today);
    }
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
    if (hour >= cfg.reportHour) {
      for (const text of renewalReminders(db, cfg, { today })) {
        await send(cfg, 'tunelio_renewal', text).catch((err) => log({ event: 'report_failed', kind: 'renewal', message: String(err.message) }));
      }
    }
    if (hour >= cfg.reportHour && getMeta(db, 'report_daily') !== today) {
      setMeta(db, 'report_daily', today); // before sending: never twice, even if the webhook is slow
      const yesterday = addDays(today, -1);
      await send(cfg, 'daily_summary', dailyReport(db, { day: yesterday, tz: cfg.tz, monitorDb: cfg.monitorDb, now, renewDay: cfg.tunelioRenewsDay }))
        .catch((err) => log({ event: 'report_failed', kind: 'daily', message: String(err.message) }));
      log({ event: 'test_world_daily', ...testWorld(db, { day: yesterday, tz: cfg.tz, now, renewDay: cfg.tunelioRenewsDay }) });
      const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz, weekday: 'short' }).format(now);
      if (weekdayName === 'Mon' && getMeta(db, 'report_weekly') !== today) {
        setMeta(db, 'report_weekly', today);
        await send(cfg, 'weekly_summary', weeklyReport(db, { endDay: yesterday, tz: cfg.tz, now, renewDay: cfg.tunelioRenewsDay }))
          .catch((err) => log({ event: 'report_failed', kind: 'weekly', message: String(err.message) }));
      }
    }
  } finally { db.close(); }
}

async function cli(args) {
  const cfg = settings();
  if (args[0] === 'report') {
    dropPrivileges(cfg.runAs);
    const db = openMetricsDb(cfg.db);
    try {
      const i = args.indexOf('--day');
      const day = i >= 0 ? args[i + 1] : addDays(dayOf(Date.now(), cfg.tz), -1);
      const text = args.includes('--weekly') ? weeklyReport(db, { endDay: day, tz: cfg.tz, renewDay: cfg.tunelioRenewsDay })
        : dailyReport(db, { day, tz: cfg.tz, monitorDb: cfg.monitorDb, renewDay: cfg.tunelioRenewsDay });
      if (args.includes('--send')) await send(cfg, args.includes('--weekly') ? 'weekly_summary' : 'daily_summary', text);
      else console.log(text);
    } finally { db.close(); }
    return;
  }
  await run(cfg);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  cli(process.argv.slice(2)).catch((err) => { log({ event: 'metrics_poll_failed', message: String(err?.stack ?? err).slice(0, 500) }); process.exit(1); });
}
