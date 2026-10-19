// Discord report text: daily (yesterday, sent around 09:00 America/Chicago) and weekly (Mondays, week over week).
import { summary, channels, addDays } from '../src/stats.js';

const n = (x) => (x == null ? '–' : Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '∞');
const signed = (x) => (x == null ? '' : x >= 0 ? `+${n(x)}` : `−${n(-x)}`);
const top = (o, max = 6) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]).slice(0, max).map(([k, v]) => `${k} ${n(v)}`).join(', ') || 'none';
const pct = (x) => `${(x * 100).toFixed(1)} %`;
const change = (now, before) => {
  if (before == null || now == null) return '';
  if (!before) return now ? ' (new)' : '';
  const d = (now - before) / before;
  return ` (${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)} %)`;
};
const weekday = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function worldLine(name, w) {
  if (!w) return null;
  return `${name}: visits ${n(w.visits)} (${signed(w.visitsDelta)}), favorites ${n(w.favorites)} (${signed(w.favoritesDelta)}), `
    + `peak ${n(w.peakOccupants)} in world (public ${n(w.peakPublic)}, private ${n(w.peakPrivate)})`;
}

function creditsLine(s) {
  const c = s.credits;
  const f = c.forecast;
  const spent = c.playback + c.captions;
  let out = `Credits: ${n(spent)} spent (playback ${n(c.playback)}, captions ${n(c.captions)}), ${n(c.remaining)} left`;
  if (f) out += f.lastsPeriod ? `; at ${n(f.perDay)}/day they last to renewal (${shortDay(f.renews)})`
    : `; at ${n(f.perDay)}/day they run out ${shortDay(f.runsOut)}, before renewal (${shortDay(f.renews)})`;
  return out;
}

function channelsLine(ch) {
  if (!ch) return 'Channels: no monitor data';
  if (ch.error) return `Channels: monitor database unreadable (${ch.error})`;
  const down = ch.filter((s) => s.down && !s.spare);
  const fails = ch.reduce((a, s) => a + s.flashFails, 0);
  const restarts = ch.reduce((a, s) => a + s.restarts, 0);
  const low = ch.filter((s) => !s.spare && s.uptime != null && s.uptime < 0.9).map((s) => `${s.slot} ${(s.uptime * 100).toFixed(0)} %`);
  return `Channels: ${down.length ? `${down.length} down (${down.map((s) => `${s.slot}: ${s.reason ?? 'down'}`).join(', ')})` : 'all slots up'}`
    + `; ${restarts} restarts, ${fails} flash fails in 24 h${low.length ? `; uptime under 90 %: ${low.join(', ')}` : ''}`;
}

const LABEL = { 'world:prod': 'production', 'world:test': 'TEST' };
const clock = (ms, tz) => new Date(ms).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// "Releases: production v104 uploaded Oct 19, 3:02 PM; GitHub v2026.10.19 Oct 19, 2:40 PM"
function releasesLine(list, tz) {
  if (!list?.length) return null;
  return `Releases: ${[...list].reverse().map((r) => r.source.startsWith('world:')
    ? `${LABEL[r.source] ?? r.source} v${r.version} uploaded ${clock(r.at, tz)}`
    : `GitHub ${r.version} ${clock(r.at, tz)}`).join('; ')}`;
}

function body(s, tz) {
  const lines = [];
  for (const [k, label] of [['prod', 'VRChat'], ['test', 'TEST world']]) {
    const l = worldLine(label, s.vrchat[k]);
    if (l) lines.push(l);
  }
  if (!s.vrchat.prod) lines.push('VRChat: no data (poller not logged in yet)');
  if (s.group) lines.push(`Group: ${n(s.group.members)} members, up to ${n(s.group.online)} online`);
  lines.push(`Search: ${n(s.searches)} searches, ${n(s.more)} "more results", ${n(s.plays)} plays; ${n(s.joins)} joins (untrusted URLs on)`);
  lines.push(`Sources: ${top(s.sources)}; failures ${pct(s.failureRate)}${Object.keys(s.failures).length ? ` (${top(s.failures)})` : ''}; p50 ${n(s.searchMs.p50)} ms, p95 ${n(s.searchMs.p95)} ms`);
  lines.push(`Plays: ${top(s.playRoutes)}${Object.keys(s.fallbacks).length ? `; fallbacks: ${top(s.fallbacks)}` : ''}`);
  lines.push(`Captions: ${n(s.captions.lists)} shown, ${n(s.captions.tracks)} tracks picked${Object.keys(s.captions.unavailable).length ? `, not available: ${top(s.captions.unavailable)}` : ''}`);
  lines.push(creditsLine(s));
  lines.push(`Languages: ${s.languages.join(', ') || 'none'}`);
  const rel = releasesLine(s.releases, tz);
  if (rel) lines.push(rel);
  return lines;
}

export function dailyReport(db, { day, tz = 'America/Chicago', monitorDb, now = Date.now(), renewDay = 1 }) {
  const s = summary(db, { from: day, to: day, now, tz, renewDay });
  return [`**Everything is OK: ${weekday(day)}**`, ...body(s, tz), channelsLine(channels(monitorDb, now - 86400_000))].join('\n');
}

// Week ending `endDay` (inclusive) against the 7 days before it.
export function weeklyReport(db, { endDay, tz = 'America/Chicago', now = Date.now(), renewDay = 1 }) {
  const from = addDays(endDay, -6);
  const s = summary(db, { from, to: endDay, now, tz, renewDay });
  const p = summary(db, { from: addDays(from, -7), to: addDays(from, -1), now, tz, renewDay });
  const w = s.vrchat.prod, pw = p.vrchat.prod;
  const lines = [`**Everything is OK: week ${shortDay(from)}–${shortDay(endDay)}** (vs the week before)`];
  if (w) {
    lines.push(`VRChat: +${n(w.visitsDelta)} visits${change(w.visitsDelta, pw?.visitsDelta)}, ${signed(w.favoritesDelta)} favorites${change(w.favoritesDelta, pw?.favoritesDelta)}, `
      + `peak ${n(w.peakOccupants)} in world${pw ? ` (was ${n(pw.peakOccupants)})` : ''}`);
  } else lines.push('VRChat: no data (poller not logged in yet)');
  if (s.group) lines.push(`Group: ${n(s.group.members)} members${p.group ? ` (${signed(s.group.members - p.group.members)})` : ''}`);
  lines.push(`Search: ${n(s.searches)} searches${change(s.searches, p.searches)}, ${n(s.plays)} plays${change(s.plays, p.plays)}, ${n(s.joins)} joins${change(s.joins, p.joins)}`);
  lines.push(`Failures ${pct(s.failureRate)} (was ${pct(p.failureRate)}); sources: ${top(s.sources)}`);
  lines.push(`Captions: ${n(s.captions.lists)} shown${change(s.captions.lists, p.captions.lists)}`);
  const spent = s.credits.playback + s.credits.captions, before = p.credits.playback + p.credits.captions;
  lines.push(`Credits: ${n(spent)} spent${change(spent, before)}, ${n(s.credits.remaining)} left`);
  lines.push(`Languages: ${s.languages.join(', ') || 'none'}`);
  const rel = releasesLine(s.releases, tz);
  if (rel) lines.push(rel);
  const gh = Object.entries(s.github).map(([r, g]) => `${r} ★${n(g.stars)}, ${n(g.downloads)} downloads`);
  if (gh.length) lines.push(`GitHub: ${gh.join('; ')}`);
  return lines.join('\n');
}

// Discord takes at most 2000 characters a message: split at line breaks.
export function chunks(text, max = 1900) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const l = line.length > max ? line.slice(0, max - 1) + '…' : line;
    if (cur && cur.length + 1 + l.length > max) { out.push(cur); cur = l; } else cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) out.push(cur);
  return out;
}
