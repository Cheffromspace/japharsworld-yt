// Grafana Cloud dashboard and alert rules for Everything is OK (claude/monitoring.md), kept in the repo.
//   node tools/grafana.mjs build    writes grafana/dashboard.json, grafana/tonight.json and grafana/alert-rules.json
//   node tools/grafana.mjs push     uploads them to the stack (and the Discord contact points). Until the production
//                                   deploy that carries 76c083d is live (Everything-is-OK#967), it refuses: rules go out
//                                   only with push-rule from the checkouts the #967 push plan names, and a full push
//                                   would fire "Alert inputs missing" and blind the rules that read the new series.
//                                   Then, once the four series named at FULL_PUSH_WAITS_FOR show: push --after-deploy.
//   node tools/grafana.mjs push-rule <uid> [--dry-run]   that one alert rule only (no dashboards, contact points or
//                                   other rules); --dry-run prints the request and sends nothing
// push reads its settings from the environment or the repo's .env (gitignored; the environment wins):
//   GRAFANA_URL               https://<stack>.grafana.net
//   GRAFANA_SA_TOKEN          a service account token (glsa_…, Editor role); not GRAFANA_TOKEN, Alloy's write-only token
//   GRAFANA_DISCORD_WEBHOOK   where the alerts go (the contact point). Change it and push again to move them.
//   GRAFANA_DISCORD_MENTION   optional: a Discord user ID mentioned on firing critical alerts only (kept out of the repo)
//   DISCORD_CRITICAL_WEBHOOK  optional: the critical-alerts channel (world #195, owner 2026-10-26). With it, severity=critical
//                             rules go to their own contact point there; without it, everything goes to the one above.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { HOUR_CREDITS, HOME_FIRST_PERCENT } from '../src/spend.js';
import { REFUSAL_CLASSES, REFUSAL_WHERE } from '../src/refusal.js';

const env = { ...dotenv('.env'), ...process.env };
function dotenv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const DS = { type: 'prometheus', uid: '${ds}' };
const DASH_UID = 'everything-is-ok';
const TONIGHT_UID = 'everything-is-ok-tonight';
const FOLDER = { uid: 'everything-is-ok', title: 'Everything is OK' };
const RECEIVER = 'Everything is OK Discord';
const CRITICAL_RECEIVER = 'Everything is OK Discord critical';

// Staging (#160, deploy/alloy/staging.alloy) sends the same metrics with env="staging"; production's carry no env label,
// so this matcher keeps every one of them. Added to every selector of every query and rule at build time (owner,
// 2026-10-26), so staging never shows on the dashboard or fires a production alert.
const PROD = 'env!="staging"';
export function prodOnly(expr) {
  return expr.replace(/\b((?:eiok|probe|node|namedprocess)_[A-Za-z0-9_]+)(\{)?/g, (m, name, brace) => (brace ? `${name}{${PROD},` : `${name}{${PROD}}`));
}
const scoped = (o) => (Array.isArray(o) ? o.map(scoped)
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'expr' && typeof v === 'string' ? prodOnly(v) : scoped(v)]))
  : o);

let id = 0;
const grid = { x: 0, y: 0 };
function place(w, h) {
  if (grid.x + w > 24) { grid.x = 0; grid.y += grid.rowH ?? h; grid.rowH = 0; }
  const pos = { x: grid.x, y: grid.y, w, h };
  grid.x += w; grid.rowH = Math.max(grid.rowH ?? 0, h);
  return pos;
}
function row(title) {
  if (grid.x) { grid.x = 0; grid.y += grid.rowH; }
  const p = { type: 'row', id: ++id, title, collapsed: false, gridPos: { x: 0, y: grid.y, w: 24, h: 1 }, panels: [] };
  grid.y += 1; grid.rowH = 0;
  return p;
}
const target = (expr, legendFormat = '', extra = {}) => ({ refId: String.fromCharCode(65 + (extra.i ?? 0)), datasource: DS, expr, legendFormat, ...extra.t });
const targets = (list) => list.map(([e, l, t], i) => target(e, l, { i, t }));

// expr: one expression, or a list of [expr, legend] shown side by side with their names.
function stat(title, expr, { unit = 'short', w = 4, h = 4, thresholds, decimals, mappings, description } = {}) {
  const list = Array.isArray(expr) ? expr.map(([e, l]) => [e, l, { instant: true }]) : [[expr, '', { instant: true }]];
  // A stat with no state (its only colour the SURFACE) is a quiet tile: a solid Tokyo Night surface, numbers in the
  // colour Grafana picks for it (near-white; a stat can't colour the text and the fill apart, Grafana 13.4). Owner,
  // 2026-11-17, #866: blue fill, then blue numbers on the plain panel, then "background just a tiny bit brighter" with
  // near-white numbers. Stats with a state colour keep the gradient fill.
  const quiet = (thresholds ?? []).length > 0 && thresholds.every((s) => s.color === SURFACE);
  return {
    type: 'stat', id: ++id, title, description, datasource: DS, gridPos: place(w, h), targets: targets(list),
    options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: quiet ? 'background_solid' : 'background', graphMode: 'none', textMode: Array.isArray(expr) ? 'value_and_name' : 'value' },
    fieldConfig: { defaults: { unit, decimals, mappings: mappings ?? [], thresholds: { mode: 'absolute', steps: thresholds ?? [{ color: 'blue', value: null }] } }, overrides: [] },
  };
}
// names: the values a templated legend takes, by legend ({ '{{key}}': KEYS.home }), so each of its lines gets a colour.
// palette: false leaves the colours to the caller (Tonight's curve has its own scheme).
function series(title, list, { unit = 'short', w = 12, h = 8, stack = false, description, min, decimals, overrides = [], names = {}, palette = true } = {}) {
  const colour = palette ? { color: { mode: 'shades', fixedColor: INK } } : {};
  return {
    type: 'timeseries', id: ++id, title, description, datasource: DS, gridPos: place(w, h), targets: targets(list),
    options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    fieldConfig: { defaults: { unit, min, decimals, ...colour, custom: { lineWidth: 2, fillOpacity: stack ? 30 : 8, stacking: { mode: stack ? 'normal' : 'none' } } },
      overrides: palette ? [...overrides, ...lineColours(list.flatMap(([, legend]) => lineNames(legend, names[legend])))] : overrides },
  };
}
// The latest rows of a "value = when (ms)" series: one row per label set, newest first.
function versions(title, expr, labels, description) {
  return {
    type: 'table', id: ++id, title, description, datasource: DS, gridPos: place(12, 6),
    targets: targets([[expr, '', { instant: true, format: 'table' }]]),
    transformations: [{ id: 'organize', options: { indexByName: Object.fromEntries([...labels, 'Value'].map((l, i) => [l, i])), excludeByName: { Time: true }, renameByName: { Value: 'When' } } }],
    options: { showHeader: true, sortBy: [{ displayName: 'When', desc: true }] },
    fieldConfig: { defaults: {}, overrides: [{ matcher: { id: 'byName', options: 'When' }, properties: [{ id: 'unit', value: 'dateTimeAsLocal' }] }] },
  };
}
// Markers on every time series: each release or deploy at its own time (the series' value), not at the scrape.
// Off by default (owner, 2026-10-30); the dashboard's toggles turn each one on.
const marker = (name, expr, iconColor, titleFormat, tagKeys) => ({
  name, datasource: DS, enable: false, iconColor, expr, step: '5m', useValueForTime: true, titleFormat, textFormat: '', tagKeys,
});

// Tokyo Night status colours.
const OK = '#9ece6a', WARN = '#e0af68', BAD = '#f7768e', INK = '#7aa2f7', SURFACE = '#24283b';

// Graph lines in Tokyo Night (folke/tokyonight.nvim "night" accents; owner, 2026-11-17, #868: a palette colour per line).
// A line's colour follows what it means: failures red, warnings amber, healthy green (the meaning colours), anything
// else the neutrals, each family in this order. Within a panel a line takes the first colour of its family not used
// there yet. A neutral line never wears a meaning colour (it would claim a meaning it hasn't). A line with a meaning
// never shares its colour in a panel of up to 18 lines (the palette's size): when its family runs out it takes a
// neutral before the neutral lines do, and repeats fall only on neutral lines, each sharing with a neutral line's colour
// from the last one back, so the first lines of a panel stay unique (coordinator's ruling, 2026-11-17, #868). Past 18
// lines (only Home relay) that can't hold: there the neutral lines keep the neutrals and a meaning line repeats its
// own family, so a shared colour still means the same kind of line. A signal line (SIGNALS: the freeze proxy) takes
// its family's first colour before the other lines of that family. p50 and p95 lines come in fixed pairs (a panel's
// first group blue and magenta, its second cyan and fg, its third blue1 and blue6). Lines whose names aren't known when
// this builds (no 'names' entry in the series() call) keep series()'s default, shades of INK, picked by series index.
// A line meaning a failure, warning or health whose family has run out wears a neutral: it keeps a colour of its own
// but loses the meaning colour (accepted, coordinator 2026-11-17: failure outcomes, fallbacks, Home relay's overflow).
// Colours follow the order of the names (KEYS) and the panel's line count: a key added mid-list, or a panel passing 18
// lines, recolours the lines after it in that panel (claude/monitoring.md).
// All colours are from the project palette (ProjectGuidelines.md) except magenta2 #ff007c (tokyonight.nvim's; owner,
// 2026-11-18 00:04Z: "probably fine hot pink can stay").
export const LINE = {
  bad: [BAD, '#db4b4b', '#ff007c'],   // red, red1, magenta2
  warn: [WARN, '#ff9e64'],   // yellow, orange
  ok: [OK, '#73daca', '#41a6b5', '#1abc9c'],   // green, green1, green2, teal (green1 and teal, a near pair, apart)
  // The near pairs (cyan and blue5, magenta and purple) sit far apart, so a panel gets both only past 7 neutrals.
  neutral: [INK, '#bb9af7', '#7dcfff', '#c0caf5', '#2ac3de', '#737aa2', '#b4f9f8', '#9d7cd8', '#89ddff'],   // blue, magenta, cyan, fg, blue1, dark5, blue6, purple, blue5
};
const P50 = [LINE.neutral[0], LINE.neutral[2], LINE.neutral[4]], P95 = [LINE.neutral[1], LINE.neutral[3], LINE.neutral[6]];
const SIGNALS = ['reload_after_upgrade'];   // reloads after a 1080p step-up: the freeze proxy (src/adaptive.js)
// First match wins; anything else is neutral.
const MEANING = [
  ['neutral', /fast-fails \(normal/],   // normal while a build runs, as its own name says
  ['warn', /^fallback: /],                // sent on to youtube.com: the play still happened
  ['bad', /^unavailable: (failed|temporarily_unavailable|list_unavailable)$/],
  ['neutral', /^unavailable: /],          // the video has no such captions: not a fault
  ['bad', /fail|error|timeout|refus|could not|^cuts$|^e(invalid|denied|rate|player|unknown)$|^after$|^capped|no_room|too_big/],
  ['warn', /defer|slow|^oldest|paced|pacer|stepdown|skip|reload_after|uneven|spaced|budget|: cap$|too_long|estimated|^videos: none$/],
  ['ok', /^ok$|^ready$|played|served|cache_hit|^pass$|real$|^videos: tracks$|^settled$|race_won|^stayed$/],
];
export const meaningOf = (name) => (MEANING.find(([, re]) => re.test(name)) ?? ['neutral'])[0];
// A legend's line names: itself when it has no {{label}}; else one per value given ({ re } values match by pattern);
// none (shades) when no values are given or the legend has two labels.
function lineNames(legend, values) {
  if (!legend.includes('{{')) return [legend];
  if (!values || legend.split('{{').length > 2) return [];
  return values.map((v) => (typeof v === 'string' ? legend.replace(/\{\{\w+\}\}/, v) : { re: `^${legend.replace(/\{\{\w+\}\}/, v.re)}$` }));
}
export function lineColours(lines) {
  const label = (l) => (typeof l === 'string' ? l : l.re);
  const used = new Set(), colour = new Map(), groups = [];
  for (const l of lines) {   // p50 / p95 first: their pairs are fixed
    const m = label(l).match(/\bp(50|95)\b/);
    if (!m) continue;
    const g = label(l).replace(/\s*\bp(50|95)\b\s*/, ' ').trim();
    if (!groups.includes(g)) groups.push(g);
    const c = (m[1] === '50' ? P50 : P95)[groups.indexOf(g)];
    if (c && !used.has(c)) { colour.set(l, c); used.add(c); }
  }
  const take = (l, list) => { const c = list.find((x) => !used.has(x)); if (c) { colour.set(l, c); used.add(c); } };
  const rest = lines.filter((l) => !colour.has(l));
  const neutral = (l) => meaningOf(label(l)) === 'neutral';
  const meant = rest.filter((l) => !neutral(l)), plain = rest.filter(neutral);
  const signalsFirst = [...meant.filter((l) => SIGNALS.includes(label(l))), ...meant.filter((l) => !SIGNALS.includes(label(l)))];
  for (const l of signalsFirst) take(l, LINE[meaningOf(label(l))]);          // a meaning line: its own family
  const spare = () => meant.forEach((l) => colour.has(l) || take(l, LINE.neutral));   // ran out: a spare neutral
  if (lines.length <= 18) spare();                                            // before the neutral lines take them
  for (const l of plain) take(l, LINE.neutral);
  if (lines.length > 18) spare();
  const wrap = { bad: 0, warn: 0, ok: 0 };
  for (const l of meant) if (!colour.has(l)) { const m = meaningOf(label(l)); colour.set(l, LINE[m][wrap[m]++ % LINE[m].length]); }
  // Neutral lines past the neutrals share a neutral line's colour, from the panel's last neutral line back.
  const shareable = lines.filter((l) => colour.has(l) && neutral(l)).map((l) => colour.get(l)).reverse();
  let n = 0;
  for (const l of plain) if (!colour.has(l)) colour.set(l, shareable[n++ % shareable.length] ?? INK);
  return lines.map((l) => ({ matcher: typeof l === 'string' ? { id: 'byName', options: l } : { id: 'byRegexp', options: l.re },
    properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: colour.get(l) } }] }));
}
// The key values of the counters the graphs split by, copied from the key checks in src/metrics.js (a test compares
// them, so a key added there fails the tests until it is listed here), and the label values of the other series.
export const KEYS = {
  play_route: ['tunelio-progressive', 'tunelio-hls', 'tunelio-adaptive', 'home', 'youtube-live', 'youtube-fallback'],
  play_fallback: ['disabled', 'paused', 'tunelio_failed', 'too_long', 'build_failed', 'build_timeout', 'av1'],
  adaptive: ['plan_lower', 'plan_direct', 'plan_adaptive', 'plan_start', 'master', 'upgrade', 'upgrade_served', 'upgrade_failed', 'paced_off', 'defer', 'android_progressive', 'hls_ticket', 'quest_mp4', 'quest_skip',
    'reload_before_upgrade', 'reload_after_upgrade', 'android_av1', 'android_av1_rung', 'pc_av1', 'quest_av1', 'start_one_step', 'start_mid'],
  ticket_client: ['string', 'ytdlp', 'avpro', 'other'],
  home: ['start', 'ready', 'failed', 'capped', 'defer', 'timeout', 'cache_hit', 'settled', 'settle_timeout', 'other_quality', 'uneven', 'stepdown', 'no_room', 'race_won', 'capped_hour', 'spaced', 'too_big', 'stayed', 'idle'],
  home_why: ['tunelio_off', 'long', 'pacer', 'tunelio_failed', 'av1', 'tunelio_slow', 'slow_build', 'budget', 'cap', 'near_budget', 'tunelio_busy'],
  credits: ['playback', 'captions', 'probe', 'test'],
  build_route: ['home', 'tunelio', 'youtube'],
  search_source: ['worker', 'local', 'api'],
  cc_via: ['worker', 'local', 'tunelio'],
  cc_outcome: ['tracks', 'none'],
  cc_words: ['real', 'estimated'],
  cc_unavailable: ['no_captions', 'no_track_in_language', 'temporarily_unavailable', 'translation_unavailable', 'nothing_playing', 'no_tracks', 'list_unavailable', 'failed', 'none'],
  play_platform: ['pc', 'android'],
  yt_refusal: REFUSAL_WHERE.flatMap((w) => REFUSAL_CLASSES.map((c) => `${w}:${c}`)),
  quality_pick: ['auto', '720p', '1080p'],   // TUNELIO_QUALITIES' default (src/config.js); another quality draws in shades
  outcome: ['einvalid', 'edenied', 'erate', 'eplayer', 'eunknown', 'timeout', 'after', 'left'],   // OUTCOME_FAILS and left
  probe: ['tunelio:progressive', 'tunelio:hls', 'tunelio:pair720', 'tunelio:pair1080'],   // src/probe.js run sources
  verdict: ['pass', 'fail', 'none'],   // the monitor's flash verdicts; none: the exporter's label for a check stored without one
  reason: ['daily', 'other'],
  host: ['linode', 'optiplex'],
  job: [{ re: '.*search-healthz' }, { re: '.*short-healthz' }, { re: '.*pages-sleep-list' }],   // deploy/alloy/linode.alloy
};
const upDown = [{ type: 'value', options: { 0: { text: 'down', color: BAD }, 1: { text: 'up', color: OK } } }];

export function dashboard() {
  id = 0; grid.x = 0; grid.y = 0; grid.rowH = 0;
  const p = [];
  p.push(row('Now'));
  p.push(stat('Search service', 'min(eiok_search_up)', { w: 3, mappings: upDown, thresholds: [{ color: BAD, value: null }, { color: OK, value: 1 }],
    description: 'Whether the search service answers its own health check on the Linode, now.' }));
  p.push(stat('Public /healthz', 'min(probe_success{job=~".*search-healthz.*"})', { w: 3, mappings: upDown, thresholds: [{ color: BAD, value: null }, { color: OK, value: 1 }],
    description: 'Whether https://yt.japharsworld.com/healthz answers from outside (Caddy, TLS and DNS included), now.' }));
  p.push(stat('Relay workers', 'max(eiok_relay_workers_online)', { w: 3, thresholds: [{ color: BAD, value: null }, { color: OK, value: 1 }], description: 'Home relay workers (the Optiplex) connected now and waiting for searches. At 0, searches fall back to the Linode.' }));
  p.push(stat('In the world now', 'max(eiok_poll{source="world:prod",metric="occupants"})', { w: 3, thresholds: [{ color: SURFACE, value: null }],
    description: 'People in the production world now, as VRChat reports it (polled every minute).' }));
  p.push(stat('Credits left', 'max(eiok_credits_remaining)', { w: 3, thresholds: [{ color: BAD, value: null }, { color: WARN, value: 500 }, { color: OK, value: 1500 }],
    description: 'Tunelio credits left on the plan now. At 0, plays go to youtube.com.' }));
  p.push(stat('Channels hidden', 'sum(eiok_slot_hidden * on(slot) (1 - eiok_slot_spare))', { w: 3, thresholds: [{ color: OK, value: null }, { color: WARN, value: 1 }, { color: BAD, value: 5 }],
    description: 'Channels slots hidden from the world now (stream down or failed its checks); spare slots not counted.' }));
  p.push(stat('Flash fails now', 'count(eiok_slot_flash_pass == 0) or vector(0)', { w: 3, thresholds: [{ color: OK, value: null }, { color: BAD, value: 1 }], description: 'Channels slots whose current stream failed its last flash check, now.' }));
  p.push(stat('Oldest waiting check', 'max(eiok_jobs_oldest_pending_seconds{reason="other"})', { w: 3, unit: 's', thresholds: [{ color: OK, value: null }, { color: WARN, value: 3600 }, { color: BAD, value: 7200 }], description: 'How long the oldest new, candidate or manual Channels check has waited for the Optiplex worker, which runs every 20 min. The daily batch is in Check queue.' }));

  const startupNote = 'Over the selected range, per ticket request, so a slow video the player retries counts several timeouts. A timeout means the player waited 90 s and got youtube.com.';
  const noBuilds = [{ type: 'special', options: { match: 'nan', result: { text: 'no builds' } } }, { type: 'special', options: { match: 'null', result: { text: 'no builds' } } }];
  p.push(stat('Total visits (production)', 'max(eiok_poll{source="world:prod",metric="visits"})', { w: 5, unit: 'locale', decimals: 0, thresholds: [{ color: SURFACE, value: null }],
    description: 'All-time visits to the production world, from VRChat.' }));
  p.push(stat('Favorites (production)', 'max(eiok_poll{source="world:prod",metric="favorites"})', { w: 4, unit: 'locale', decimals: 0, thresholds: [{ color: SURFACE, value: null }],
    description: 'All-time favorites of the production world, from VRChat.' }));
  p.push(stat('Start-up problems, this range', [
    ['sum(increase(eiok_events_total{metric="ticket_timeout"}[$__range])) or vector(0)', 'player timeouts'],
    ['sum(increase(eiok_events_total{metric="build",key="failed"}[$__range])) or vector(0)', 'failed builds'],
  ], { w: 7, decimals: 0, thresholds: [{ color: OK, value: null }, { color: WARN, value: 0.5 }, { color: BAD, value: 3 }], description: startupNote }));
  p.push(stat('Tunelio build time', [
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_build_progressive_seconds_bucket[$__range])))', 'visitors p95'],
    ['max(eiok_poll{source="tunelio:progressive",metric="start_s"})', 'probe progressive'],
    ['max(eiok_poll{source="tunelio:hls",metric="start_s"})', 'probe HLS'],
  ], { w: 8, unit: 's', decimals: 0, mappings: noBuilds, thresholds: [{ color: OK, value: null }, { color: WARN, value: 20 }, { color: BAD, value: 60 }],
    description: 'Visitors’ progressive build time (p95 over the selected range) and the speed probe’s latest start times. Over ~20 s a visitor waits past the resolver hold; over ~90 s the player gives up.' }));

  p.push(row('Visitors and search'));
  p.push(series('In world (production)', [
    ['max(eiok_poll{source="world:prod",metric="occupants"})', 'in world'],
    ['max(eiok_poll{source="world:prod",metric="publicOccupants"})', 'public instances'],
    ['max(eiok_poll{source="world:prod",metric="privateOccupants"})', 'private instances'],
  ], { w: 12, min: 0, description: 'People in the production world, in all and by instance type, polled every minute. VRChat updates its counts on its own schedule.' }));
  p.push(series('Total visits (production)', [
    ['max(eiok_poll{source="world:prod",metric="visits"})', 'visits'],
    ['max(eiok_poll{source="world:prod",metric="favorites"})', 'favorites'],
  ], { w: 12, unit: 'locale', decimals: 0, overrides: [{ matcher: { id: 'byName', options: 'favorites' }, properties: [{ id: 'custom.axisPlacement', value: 'right' }] }],
    description: 'All-time visits and favorites (right axis) of the production world, from VRChat. Older history is on /stats.' }));
  p.push(series('Searches, plays, joins (per hour)', [
    ['sum by (metric) (increase(eiok_events_total{metric=~"search|play|join|more",key=""}[1h]))', '{{metric}}'],
  ], { names: { '{{metric}}': ['search', 'play', 'join', 'more'] }, w: 24, h: 6, description: 'Searches, More pages, plays (once per room) and joins (the world\'s first load of the search address), each point counting the hour before it.' }));
  p.push(series('Search latency', [
    ['histogram_quantile(0.5, sum by (le) (increase(eiok_search_seconds_bucket[3h])))', 'p50'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_search_seconds_bucket[3h]))) and on() sum(increase(eiok_search_seconds_count[3h])) >= 20', 'p95'],
    ['sum(increase(eiok_search_seconds_count[3h]))', 'searches in window'],
  ], { w: 8, unit: 's', min: 0, overrides: [{ matcher: { id: 'byName', options: 'searches in window' }, properties: [{ id: 'unit', value: 'short' }, { id: 'decimals', value: 0 }, { id: 'custom.axisPlacement', value: 'right' }, { id: 'custom.lineStyle', value: { fill: 'dash', dash: [4, 4] } }, { id: 'custom.lineWidth', value: 1 }] }],
    description: 'Search time p50 and p95 over the 3 h before each point. p95 shows only when those 3 h hold 20 or more searches, so one slow search can\'t set it; the count is on the right axis.' }));
  p.push(series('Search failure rate', [
    ['sum(increase(eiok_events_total{metric="search_fail"}[3h])) / clamp_min(sum(increase(eiok_events_total{metric="search",key=""}[3h])) + sum(increase(eiok_events_total{metric="search_fail"}[3h])), 1)', 'failures'],
  ], { w: 8, unit: 'percentunit', min: 0, description: 'Share of searches that failed (rate limited or YouTube not answering) over the 3 h before each point.' }));
  p.push(series('Play routes (per 3 h)', [
    ['sum by (key) (increase(eiok_events_total{metric="play_route"}[3h]))', '{{key}}'],
  ], { names: { '{{key}}': KEYS.play_route }, w: 8, stack: true, description: 'Where each play went (once per room) over the 3 h before each point: Tunelio progressive, HLS or adaptive, the home relay, a live stream, or youtube.com as a fallback.' }));
  p.push(series('Tunelio credits left', [['max(eiok_credits_remaining)', 'left']], { w: 8, min: 0, description: 'Tunelio credits left on the plan; it jumps back up when the plan renews.' }));
  p.push(series('Tunelio build time', [
    ['histogram_quantile(0.5, sum by (le) (increase(eiok_build_progressive_seconds_bucket[6h])))', 'progressive p50'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_build_progressive_seconds_bucket[6h])))', 'progressive p95'],
    ['histogram_quantile(0.5, sum by (le) (increase(eiok_build_hls_seconds_bucket[6h])))', 'HLS p50'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_build_hls_seconds_bucket[6h])))', 'HLS p95'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_ticket_hold_seconds_bucket[6h])))', 'ticket hold p95'],
  ], { w: 8, unit: 's', description: 'Visitors\' Tunelio build times and the ticket hold, p50 and p95 over the 6 h before each point. A player is held up to 90 s, the resolver 12 s.' }));
  p.push(series('Start-up problems (per 3 h)', [
    ['sum(increase(eiok_events_total{metric="ticket_timeout"}[3h]))', 'player timeouts (got youtube.com)'],
    ['sum(increase(eiok_events_total{metric="ticket_fastfail"}[3h]))', 'resolver fast-fails (normal while building)'],
    ['sum(increase(eiok_events_total{metric="build",key="failed"}[3h]))', 'failed builds'],
    ['sum by (key) (increase(eiok_events_total{metric="play_fallback"}[3h]))', 'fallback: {{key}}'],
  ], { names: { 'fallback: {{key}}': KEYS.play_fallback }, w: 8, min: 0, description: 'Player timeouts, resolver fast-fails, failed builds and youtube.com fallbacks by reason, over the 3 h before each point. Timeouts count per ticket request, so a retried video counts several.' }));
  const probeNote = 'The speed probe builds a fresh 12–30 min video at 1080p about hourly, progressive and HLS on alternate runs, so each line moves every 2–3 h.';
  p.push(series('Tunelio probe: time to start', [
    ['max by (source) (eiok_poll{source=~"tunelio:.*",metric="start_s"})', '{{source}}'],
    ['max by (source) (eiok_poll{source=~"tunelio:.*",metric="create_s"})', '{{source}} /create'],
  ], { names: { '{{source}}': KEYS.probe, '{{source}} /create': KEYS.probe }, w: 12, unit: 's', min: 0, description: `${probeNote} Start is what a player waits for (progressive: first byte; HLS: playlist and first segment).` }));
  p.push(series('Tunelio probe: build speed', [
    ['max by (source) (eiok_poll{source=~"tunelio:.*",metric="mb_per_s"})', '{{source}} MB/s'],
    ['max by (source) (eiok_poll{source=~"tunelio:.*",metric="mb"})', '{{source}} file MB'],
  ], { names: { '{{source}} MB/s': KEYS.probe, '{{source}} file MB': KEYS.probe }, w: 12, min: 0, description: `${probeNote} Build speed in MB/s, file size on the right axis.`,
    overrides: [{ matcher: { id: 'byRegexp', options: '.*file MB' }, properties: [{ id: 'custom.axisPlacement', value: 'right' }] }] }));
  const dropNote = 'The speed probe reads each progressive link at playback speed for 10 minutes and resumes after a cut, skipping a read while a visitor\'s build is in flight. Each point covers the 24 h before it; empty while the drop check is off.';
  p.push(series('Tunelio cuts per playback hour (24 h)', [
    ['sum(increase(eiok_tunelio_probe_cuts_total[24h])) / (sum(increase(eiok_tunelio_probe_read_minutes_total[24h])) / 60)', 'cuts per hour'],
  ], { w: 12, min: 0, description: dropNote }));
  p.push(series('Tunelio read and reopens (24 h)', [
    ['sum(increase(eiok_tunelio_probe_read_minutes_total[24h]))', 'read minutes'],
    ['sum(increase(eiok_tunelio_probe_cuts_total[24h]))', 'cuts'],
    ['sum(increase(eiok_tunelio_probe_reopen_fail_total[24h]))', 'failed reopens'],
    ['sum(increase(eiok_tunelio_probe_open_fail_total[24h]))', 'reads that could not open'],
  ], { w: 12, min: 0, description: 'The speed probe\'s paced reads over the 24 h before each point: minutes read, cuts, failed reopens (wrong status or offset, or no first byte in 10 s) and reads that could not open at all. Empty while the drop check is off.' }));

  // Playback plans, the home relay, captions and credits (2026-10-23 audit: all of these were counted but not shown).
  const ev = (metric, w = '6h') => `sum by (key) (increase(eiok_events_total{metric="${metric}"}[${w}]))`;
  p.push(row('What visitors saw'));
  p.push(series('Time to first frame, visitors', [
    ['histogram_quantile(0.5, sum by (le, platform) (increase(eiok_play_first_frame_seconds_bucket{who="visitor"}[6h])))', 'p50 {{platform}}'],
    ['histogram_quantile(0.95, sum by (le, platform) (increase(eiok_play_first_frame_seconds_bucket{who="visitor"}[6h])))', 'p95 {{platform}}'],
  ], { names: { 'p50 {{platform}}': KEYS.play_platform, 'p95 {{platform}}': KEYS.play_platform }, unit: 's', min: 0, description: 'From the load starting to the first frame on each visitor\'s own client (testers left out), p50 and p95 by platform over the 6 h before each point. Coarse buckets: 5, 10, 20, 30, 45, 60, 90 s.' }));
  p.push(series('Plays that never showed a picture, visitors', [
    ['sum by (outcome) (increase(eiok_play_outcome_total{who="visitor",outcome=~"e.*|timeout|after|left"}[6h]))', '{{outcome}}'],
  ], { names: { '{{outcome}}': KEYS.outcome }, stack: true, min: 0, description: 'Visitor plays with no picture over the 6 h before each point. e*: the player gave up, by error class; timeout: nothing by the world\'s cap; after: gave up after a first frame; left: the room moved on first, not a fault.' }));
  p.push(row('Playback plans, home relay, captions'));
  p.push(series('Playback plans (per 6 h)', [[ev('adaptive').replace('}[', ',key=~"plan_.*|paced_off"}['), '{{key}}']], { names: { '{{key}}': KEYS.adaptive.filter((k) => /^(plan_.*|paced_off)$/.test(k)) }, w: 8, stack: true, min: 0,
    description: 'Which plan each video got, per 6 h: plan_direct 1080p at once, plan_adaptive 720p then 1080p, plan_start from a 360p first rung, plan_lower 720p only; paced_off kept at 720p by the credit pacer.' }));
  p.push(series('Adaptive steps and Quest tickets (per 6 h)', [[ev('adaptive').replace('}[', ',key!~"plan_.*|paced_off"}['), '{{key}}']], { names: { '{{key}}': KEYS.adaptive.filter((k) => !/^(plan_.*|paced_off)$/.test(k)) }, w: 8, min: 0,
    description: 'Per 6 h: adaptive playlists served (master), 1080p step-ups started, played and failed, Quest .m3u8 tickets, resolvers told to wait (defer), and playlist reloads before and after 1080p (after is the freeze signal).' }));
  p.push(series('Ticket requests by client (per 6 h)', [[ev('ticket_client'), '{{key}}']], { names: { '{{key}}': KEYS.ticket_client }, w: 8, stack: true, min: 0,
    description: 'Ticket requests per 6 h by who asked: string is the tablet’s status checks, ytdlp VRChat’s resolver, avpro the video player. Per request, not per play.' }));
  p.push(stat('Home relay today', [
    ['max(eiok_home_today{key="mb"}) / 1000', 'GB'],
    ['max(eiok_home_today{key="cap_mb"}) / 1000', 'cap GB'],
    ['max(eiok_home_today{key="builds"})', 'videos'],
    ['max(eiok_home_today{key="cap_builds"})', 'cap videos'],
    ['max(eiok_home_today{key="workers"})', 'workers'],
    ['max(eiok_home_today{key="cache_mb"}) / 1000', 'from cache GB'],
  ], { w: 8, h: 8, decimals: 1, thresholds: [{ color: SURFACE, value: null }], description: 'Today (Chicago day), now: what the Optiplex downloaded for home relay plays against its daily cap, the videos, what it served from its own cache (not counted against the cap), and the media workers connected.' }));
  p.push(series('Home relay (per 6 h)', [[ev('home'), '{{key}}'], [ev('home_why'), 'why: {{key}}']], { names: { '{{key}}': KEYS.home, 'why: {{key}}': KEYS.home_why }, w: 8, min: 0,
    description: 'Home relay sessions per 6 h (started, ready, failed, refused by the cap or for room, cache hits, step-downs), and why a play went home: a long video, Tunelio off, slow or failed, the pacer, or the spend budget or build cap.' }));
  p.push(series('Home relay start time', [
    ['histogram_quantile(0.5, sum by (le) (increase(eiok_home_start_seconds_bucket[6h])))', 'p50'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_home_start_seconds_bucket[6h])))', 'p95'],
  ], { w: 8, unit: 's', min: 0, description: 'From a home relay play to its first playlist with a segment from the Optiplex, p50 and p95 over the 6 h before each point.' }));
  p.push(series('Credits spent per day, by use', [[ev('credits', '1d'), '{{key}}']], { names: { '{{key}}': KEYS.credits }, w: 8, stack: true, min: 0,
    description: 'Tunelio credits spent in the 24 h before each point, by use: playback builds, caption transcripts, the speed probe, and test slot refills.' }));
  p.push(series('New builds: home vs Tunelio, per day', [[ev('build_route', '1d'), '{{key}}']], { names: { '{{key}}': KEYS.build_route }, w: 8, stack: true, min: 0,
    description: 'Videos newly built in the 24 h before each point, by where they went: home (a new home relay session), tunelio (a paid build), youtube (no source could take it: a spend limit with home full). Each video counts once an hour per route, however many builds its play made. Next to the credits spent per day, it shows how the load is shared.' }));
  p.push(series('Search sources (per 6 h)', [[ev('search_source'), '{{key}}'], ['max(eiok_youtube_api_units_today)', 'Data API units today']], { names: { '{{key}}': KEYS.search_source }, w: 8, stack: false, min: 0,
    description: 'Which source answered searches, per 6 h: worker the home relay, local the Linode, api the YouTube Data API (quota), with today\'s Data API units.' }));
  p.push(series('Captions (per 6 h)', [
    ['sum by (metric) (increase(eiok_events_total{metric=~"cc_list|cc_track",key=""}[6h]))', '{{metric}}'],
    [ev('cc_via'), 'via {{key}}'], [ev('cc_outcome'), 'videos: {{key}}'], [ev('cc_words'), 'words {{key}}'], [ev('cc_unavailable'), 'unavailable: {{key}}'],
  ], { names: { '{{metric}}': ['cc_list', 'cc_track'], 'via {{key}}': KEYS.cc_via, 'videos: {{key}}': KEYS.cc_outcome, 'words {{key}}': KEYS.cc_words, 'unavailable: {{key}}': KEYS.cc_unavailable }, w: 8, min: 0, description: 'Per 6 h: caption lists and picked tracks served, which source answered (home relay, Linode yt-dlp, Tunelio), real or estimated word timing, distinct videos whose list had tracks or none, and why none was available.' }));
  p.push(series('YouTube refusals (per hour)', [[ev('yt_refusal', '1h'), '{{key}}']], { names: { '{{key}}': KEYS.yt_refusal }, w: 8, stack: true, min: 0,
    description: 'YouTube refusals per hour by where (home relay, Linode, flash-check worker) and class: bot ("Sign in to confirm"), rate (429 or try again later), forbidden (403), potoken, restricted (age gate), other.' }));
  p.push(series('Rooms active (shards with a request, per hour)', [
    ['count(increase(eiok_shard_active_hours_total[1h]) > 0) or vector(0)', 'rooms'],
  ], { w: 8, min: 0, decimals: 0, description: 'Tablet shards (rooms) that made any request in the hour before each point.' }));
  p.push(series('Plays by platform (per 6 h)', [[ev('play_platform'), '{{key}}']], { names: { '{{key}}': KEYS.play_platform }, w: 8, stack: true, min: 0,
    description: 'Plays per 6 h by player platform, once per room and platform (a room with PC and Quest players counts one of each). PC is low before the Everything-is-OK#586 deploy (see the Deploys markers; built 2026-11-06): plays whose resolver got the link were not counted PC, so don’t compare the PC/Quest ratio across it. Quest is in practice unchanged.' }));
  p.push(series('Room quality picks and tablet warm-ups (per 6 h)', [[ev('quality_pick'), 'pick {{key}}'],
    ['sum(increase(eiok_events_total{metric="warm"}[6h]))', 'warm builds'], ['sum(increase(eiok_events_total{metric="warm_played"}[6h]))', 'warm then played']], { names: { 'pick {{key}}': KEYS.quality_pick }, w: 8, min: 0,
    description: 'Per 6 h: quality picks on room tablets, builds started before Play (tablet status checks and pasted-link lookups), and how many of those a player then asked for.' }));

  p.push(row('Channels and flash checks'));
  p.push({
    type: 'table', id: ++id, title: 'Slots', datasource: DS, gridPos: place(14, 12),
    description: 'Every Channels slot now: up or down, hidden from the world, stream height, flashes per second at its last check, and how long ago that was.',
    targets: targets([
      ['max by (slot, category) (eiok_slot_up)', '', { instant: true, format: 'table' }],
      ['max by (slot, category) (eiok_slot_hidden)', '', { instant: true, format: 'table' }],
      ['max by (slot, category) (eiok_slot_height)', '', { instant: true, format: 'table' }],
      ['max by (slot, category) (eiok_slot_flash_max)', '', { instant: true, format: 'table' }],
      ['time() - max by (slot, category) (eiok_slot_flash_timestamp_seconds)', '', { instant: true, format: 'table' }],
    ]),
    transformations: [
      { id: 'merge', options: {} },
      { id: 'organize', options: { excludeByName: { Time: true }, renameByName: { 'Value #A': 'Up', 'Value #B': 'Hidden', 'Value #C': 'Height', 'Value #D': 'Flashes/s', 'Value #E': 'Checked ago' } } },
    ],
    options: { showHeader: true, sortBy: [{ displayName: 'Hidden', desc: true }] },
    fieldConfig: {
      defaults: {},
      overrides: [
        { matcher: { id: 'byName', options: 'Up' }, properties: [{ id: 'mappings', value: upDown }, { id: 'custom.cellOptions', value: { type: 'color-text' } }] },
        { matcher: { id: 'byName', options: 'Hidden' }, properties: [{ id: 'mappings', value: [{ type: 'value', options: { 0: { text: '' }, 1: { text: 'hidden', color: WARN } } }] }, { id: 'custom.cellOptions', value: { type: 'color-text' } }] },
        { matcher: { id: 'byName', options: 'Flashes/s' }, properties: [{ id: 'thresholds', value: { mode: 'absolute', steps: [{ color: OK, value: null }, { color: WARN, value: 2 }, { color: BAD, value: 4 }] } }, { id: 'custom.cellOptions', value: { type: 'color-text' } }] },
        { matcher: { id: 'byName', options: 'Checked ago' }, properties: [{ id: 'unit', value: 's' }] },
      ],
    },
  });
  p.push(series('Flash checks (per 6 h)', [['sum by (verdict) (increase(eiok_flash_checks_total[6h]))', '{{verdict}}']], { names: { '{{verdict}}': KEYS.verdict }, w: 10, h: 6, stack: true, description: 'Channels flash checks by verdict over the 6 h before each point.' }));
  p.push(series('Check queue', [
    ['max(eiok_jobs_pending)', 'waiting'],
    ['max by (reason) (eiok_jobs_oldest_pending_seconds) / 60', 'oldest {{reason}} (min)'],
  ], { names: { 'oldest {{reason}} (min)': KEYS.reason }, w: 10, h: 6, min: 0, description: 'Channels check jobs waiting for the Optiplex worker, and how many minutes the oldest of each kind has waited.' }));

  p.push(row('Hosts'));
  p.push(series('CPU busy', [['1 - avg by (host) (rate(node_cpu_seconds_total{mode="idle"}[5m]))', '{{host}}']], { names: { '{{host}}': KEYS.host }, w: 8, unit: 'percentunit', min: 0, description: 'Share of CPU time busy on each host (5 min rate).' }));
  p.push(series('Memory available', [['max by (host) (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)', '{{host}}']], { names: { '{{host}}': KEYS.host }, w: 8, unit: 'percentunit', min: 0, description: 'Share of memory available on each host.' }));
  p.push(series('Disk free (/)', [['max by (host) (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})', '{{host}}']], { names: { '{{host}}': KEYS.host }, w: 8, unit: 'percentunit', min: 0, description: 'Share of the root disk free on each host.' }));
  p.push(series('Public endpoints', [['max by (job) (probe_success)', '{{job}}'], ['max by (job) (probe_duration_seconds)', '{{job}} seconds']], { names: { '{{job}}': KEYS.job, '{{job}} seconds': KEYS.job }, w: 12, description: 'Outside health checks of the public addresses: 1 up, 0 down, and how long each check took in seconds.' }));
  p.push(series('Failed units', [['sum by (host, name) (node_systemd_unit_state{state="failed"}) > 0', '{{host}} {{name}}']], { w: 12, description: 'systemd units in the failed state on either host; empty when all is well.' }));
  // From the capacity-alerts branch (d22fa0e), already live on the dashboard since 2026-11-01; the exporter series is on prod.
  p.push(series('Search service memory', [
    ['sum(eiok_service_memory_bytes{kind=~"anon|swap"})', 'anon + swap'],
    ['max(eiok_service_memory_limit_bytes)', 'MemoryMax'],
  ], { w: 24, h: 6, unit: 'bytes', min: 0, description: 'The search service’s memory that can’t be dropped (anon in RAM plus swapped out) against its MemoryMax. Page cache is left out, as the kernel reclaims it at the limit.' }));

  p.push(row('Versions and deploys'));
  // A band per world version over time (the polled version number), so uploads read as a timeline.
  p.push({
    type: 'state-timeline', id: ++id, title: 'World version over time', datasource: DS, gridPos: place(24, 4),
    description: 'The published version of the production and TEST worlds over time, one band per version.',
    targets: targets([
      ['max(eiok_poll{source="world:prod",metric="version"})', 'production'],
      ['max(eiok_poll{source="world:test",metric="version"})', 'TEST'],
    ]),
    options: { showValue: 'always', mergeValues: true, rowHeight: 0.8, legend: { showLegend: false }, tooltip: { mode: 'single' } },
    fieldConfig: { defaults: { unit: 'prefix:v', decimals: 0, color: { mode: 'continuous-BlPu' }, custom: { fillOpacity: 70, lineWidth: 0 } }, overrides: [] },
  });
  p.push(versions('World uploads and releases', 'max by (source, version) (eiok_release_timestamp_seconds) * 1000', ['source', 'version'],
    'World versions (production and TEST, at VRChat’s upload time) and GitHub release tags, newest first.'));
  p.push(versions('Deploys of main', 'max by (host, commit, outcome) (eiok_deploy_timestamp_seconds) * 1000', ['host', 'commit', 'outcome'],
    'Deploys of main per host, newest first: the Linode (search service; no_restart when only files it doesn’t run changed) and the Optiplex (relay worker).'));

  return scoped({
    uid: DASH_UID, title: 'Everything is OK', tags: ['everything-is-ok'], timezone: 'America/Chicago', refresh: '5m',
    time: { from: 'now-2d', to: 'now' }, schemaVersion: 39, editable: true, graphTooltip: 1,
    description: 'Service health, playback, search, Channels and hosts for the Everything is OK world. Time series plot each point over a fixed window before it (named in the title or description); stats marked "this range" follow the selected range. Ranges of several weeks can overcount where the usage counters restarted.',
    templating: { list: [{ name: 'ds', label: 'Data source', type: 'datasource', query: 'prometheus', regex: '.*-prom$', current: {} }] },
    annotations: { list: [
      { builtIn: 1, name: 'Annotations & Alerts', type: 'dashboard', datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)' },
      marker('World uploads', 'max by (source, version) (eiok_release_timestamp_seconds{source=~"world:.*"}) * 1000', '#bb9af7', '{{source}} v{{version}}', 'source'),
      marker('GitHub releases', 'max by (source, version) (eiok_release_timestamp_seconds{source!~"world:.*"}) * 1000', '#7dcfff', '{{source}} {{version}}', 'source'),
      marker('Deploys', 'max by (host, commit, outcome) (eiok_deploy_timestamp_seconds) * 1000', '#e0af68', '{{host}} {{commit}} ({{outcome}})', 'host,outcome'),
    ] },
    panels: p,
  });
}

// "Everything is OK · Tonight" (world #248, owner 2026-10-26: "how cozy the current vibe is and who and what people are
// doing"): a separate, friendly board from aggregates the service already keeps (claude/metrics.md), counts only. Tokyo
// Night accents, no red; big tiles first. Grafana's own theme sets the page ground, so the tiles carry the colours.
const NIGHT = { ground: '#24283b', blue: '#7aa2f7', purple: '#bb9af7', green: '#9ece6a', dim: '#414868', quiet: '#565f89', amber: '#e0af68', orange: '#ff9e64' };
const OWN_TESTS = 'Includes the owner\'s testing in the TEST world, which these counts can\'t tell apart.';
const inRange = (metric, key) => `sum(increase(eiok_events_total{metric="${metric}"${key == null ? '' : `,key="${key}"`}}[$__range])) or vector(0)`;
const occ = (m) => `max(eiok_poll{source="world:prod",metric="${m}"})`;
// Bars of named counts for the time range ([expr, name] pairs), in the accents.
function bars(title, list, { w = 8, h = 7, description } = {}) {
  return {
    type: 'bargauge', id: ++id, title, description, datasource: DS, gridPos: place(w, h),
    targets: targets(list.map(([e, l]) => [e, l, { instant: true }])),
    options: { orientation: 'horizontal', displayMode: 'gradient', showUnfilled: true, valueMode: 'color', namePlacement: 'left', reduceOptions: { calcs: ['lastNotNull'] } },
    fieldConfig: { defaults: { unit: 'short', decimals: 0, min: 0, color: { mode: 'continuous-BlPu' }, thresholds: { mode: 'absolute', steps: [{ color: NIGHT.blue, value: null }] } }, overrides: [] },
  };
}
// One square per VRChat client language (src/query.js LANGS), always all 16: Grafana 13 stretches stat and bar gauge
// tiles to fill the panel (minVizWidth/minVizHeight and the bar gauge's manual sizing only set minimums; one "en" filled
// the whole panel, 2026-10-27), so a fixed grid keeps them one size. Dark when the language had none in the selected
// range, lit by count (#248; a fixed 2 h until the owner asked for the range, 2026-11-03).
const LANG_CODES = ['en', 'fr', 'es', 'it', 'ko', 'de', 'ja', 'pl', 'ru', 'pt-BR', 'zh-CN', 'zh-HK', 'he', 'tok', 'uk', 'th'];
function squares(title, metric, { w = 12, h = 6, description } = {}) {
  const p = stat(title, LANG_CODES.map((l) => [`sum(round(increase(eiok_events_total{metric="${metric}",key="${l}"}[$__range]))) or vector(0)`, l]), { w, h, decimals: 0, description,
    thresholds: [{ color: NIGHT.ground, value: null }, { color: NIGHT.dim, value: 1 }, { color: NIGHT.blue, value: 2 }, { color: NIGHT.purple, value: 4 }] });
  Object.assign(p.options, { textMode: 'name', colorMode: 'background_solid', orientation: 'auto', wideLayout: false, justifyMode: 'center' });
  return p;
}
const tile = (color) => [{ color, value: null }];
// Line-style icons on the service's GitHub Pages (docs/icons, CORS open), drawn by Grafana's Canvas panel and coloured
// through their stroke: Tokyo Night instead of the system's emoji colours (owner, #248).
const ICONS = 'https://cheffromspace.github.io/japharsworld-yt/icons/';
const CLEAR = { color: { fixed: 'transparent' } };
// One Canvas element; placement in percent of the tile (constraint "scale").
const element = (type, name, config, [left, right, top, bottom]) => ({ type, name, config, constraint: { horizontal: 'scale', vertical: 'scale' },
  placement: { left, right, top, bottom }, background: CLEAR, border: { color: { fixed: 'transparent' }, width: 0 } });
const icon = (name, file, field, at) => element('icon', name, { path: { mode: 'fixed', fixed: `${ICONS}${file}.svg` }, fill: { fixed: 'transparent' },
  stroke: { width: 2, color: { field, fixed: 'transparent' } } }, at);
const label = (name, field, size, at) => element('metric-value', name, { text: { mode: 'field', field, fixed: '' }, color: { field, fixed: '#c0caf5' }, size, align: 'center', valign: 'middle' }, at);
// A Canvas tile: list of [expr, field name] (instant), its elements, the fields' colours ({ field: steps }), mappings.
function canvas(title, list, elements, { w = 6, h = 4, colors = {}, mappings = [], description, decimals = 0 } = {}) {
  return {
    type: 'canvas', id: ++id, title, description, datasource: DS, gridPos: place(w, h), targets: targets(list.map(([e, l]) => [e, l, { instant: true }])),
    options: { inlineEditing: false, showAdvancedTypes: true, root: { type: 'frame', name: 'root', elements, background: CLEAR, border: { color: { fixed: 'transparent' } }, constraint: { horizontal: 'left', vertical: 'top' } } },
    fieldConfig: { defaults: { decimals, mappings, thresholds: { mode: 'absolute', steps: tile('transparent') } },
      overrides: Object.entries(colors).map(([name, steps]) => ({ matcher: { id: 'byName', options: name }, properties: [{ id: 'thresholds', value: { mode: 'absolute', steps } }, { id: 'color', value: { mode: 'thresholds' } }] })) },
  };
}
const lit = (color) => [{ color: 'transparent', value: null }, { color, value: 1 }];   // a 0/1 field: hidden or this colour
// The hour in Chicago, in PromQL (which only knows UTC). US summer time runs from the second Sunday of March to the first
// Sunday of November (day_of_week: Sunday = 0, so day_of_month - day_of_week is the date of the latest Sunday): UTC-5
// then, UTC-6 otherwise. It switches at 00:00 UTC of the switch day instead of 02:00 local (07:00 or 08:00 UTC), so those
// 7–8 hours read an hour off; 03:00 local is 08:00 UTC or later, past them.
const CHICAGO_DST = '(month() > 3 and month() < 11) or (month() == 3 and (day_of_month() - day_of_week()) >= 8) or (month() == 11 and (day_of_month() - day_of_week()) <= 0)';
export const CHICAGO_HOUR = `((hour() + 18 + ((vector(1) and on() (${CHICAGO_DST})) or vector(0))) % 24)`;

export function tonight() {
  id = 0; grid.x = 0; grid.y = 0; grid.rowH = 0;
  const p = [];
  p.push(row('Right now'));
  // Against the world's 6-per-room design (owner's thresholds, #248): 0 quiet, 1–3 cozy, 4 and up lively.
  // The icon for the word: Canvas can't pick an icon by value mapping (tried, 2026-10-27), so the three sit on one spot
  // and only the matching one is lit.
  const people = occ('occupants');
  p.push(canvas('The vibe', [[people, 'vibe'], [`${people} == bool 0`, 'quiet'], [`(${people} >= bool 1) * (${people} <= bool 3)`, 'cozy'], [`${people} >= bool 4`, 'lively']],
    [icon('moon', 'moon', 'quiet', [4, 60, 10, 10]), icon('cup', 'cup', 'cozy', [4, 60, 10, 10]), icon('sparkle', 'sparkle', 'lively', [4, 60, 10, 10]), label('word', 'vibe', 44, [40, 2, 10, 10])],
    { w: 5, description: 'People in the production world right now (polled every minute): 0 quiet, 1–3 cozy, 4 or more lively.',
      colors: { vibe: [{ color: NIGHT.quiet, value: null }, { color: NIGHT.amber, value: 1 }, { color: NIGHT.purple, value: 4 }], quiet: lit(NIGHT.quiet), cozy: lit(NIGHT.amber), lively: lit(NIGHT.purple) },
      mappings: [{ type: 'value', options: { 0: { text: 'quiet' } } }, { type: 'range', options: { from: 1, to: 3, result: { text: 'cozy' } } }, { type: 'range', options: { from: 4, to: 1e6, result: { text: 'lively' } } }] }));
  p.push(stat('People here', [[occ('publicOccupants'), 'public'], [occ('privateOccupants'), 'private']], { w: 5, thresholds: tile(NIGHT.blue),
    description: 'People in the production world right now, in public and private instances (polled every minute).' }));
  p.push(stat('Rooms', [[occ('instances'), 'public instances'], ['count(increase(eiok_shard_active_hours_total[$__range]) > 0) or vector(0)', 'tablets in use']], { w: 4, thresholds: tile(NIGHT.purple),
    description: `Public instances of the production world right now (VRChat lists only those), and the tablets (rooms) that made any request in the selected range. ${OWN_TESTS}` }));
  p.push(stat('Warmth, this range', [[`${occ('visits')} - min(min_over_time(eiok_poll{source="world:prod",metric="visits"}[$__range]))`, 'new visits'],
    [`${occ('favorites')} - min(min_over_time(eiok_poll{source="world:prod",metric="favorites"}[$__range]))`, 'new favorites']], { w: 4, decimals: 0, thresholds: tile(NIGHT.green),
    description: 'New visits and favorites of the production world over the selected range (unfavorites net out).' }));

  // VRChat's world heat (its trending flames; the owner believes 7 is the top, unconfirmed): seven flame slots, lit up to
  // the heat (Canvas can't repeat an element by value), Tokyo Night orange, the rest dim. Above 7 the number shows
  // beside them (transparent until then), so a higher ceiling is never hidden.
  const SLOTS = 7, SPAN = 86;
  p.push(canvas('Heat', [...Array.from({ length: SLOTS }, (_, k) => [`${occ('heat')} >= bool ${k + 1}`, `flame${k + 1}`]), [occ('heat'), 'heat']],
    [...Array.from({ length: SLOTS }, (_, k) => icon(`flame${k + 1}`, 'flame', `flame${k + 1}`, [1 + k * (SPAN / SLOTS), 99 - 1 - (k + 1) * (SPAN / SLOTS), 10, 10])),
      label('over', 'heat', 28, [SPAN + 1, 1, 10, 10])],
    { w: 6, description: 'VRChat\'s heat for the production world right now (the flames on its world page, polled every 15 min): one lit flame per point up to 7, and the number beside them above that.',
      colors: { ...Object.fromEntries(Array.from({ length: SLOTS }, (_, k) => [`flame${k + 1}`, [{ color: NIGHT.dim, value: null }, { color: NIGHT.orange, value: 1 }]])),
        heat: [{ color: 'transparent', value: null }, { color: NIGHT.orange, value: SLOTS + 1 }] } }));

  p.push(row('What\'s on'));
  p.push(bars('Plays by length', [[inRange('play_length', 'lt10m'), 'under 10 min'], [inRange('play_length', 'lt1h'), '10 min – 1 h'], [inRange('play_length', 'lt3h'), '1–3 h'],
    [inRange('play_length', 'longer'), '3 h+ (sleep)'], [inRange('play_length', 'live'), 'live']], { description: `Videos played over the selected range, once per room, by length. ${OWN_TESTS}` }));
  p.push(bars('Channels and searches', [[inRange('channel', 'redirect'), 'Channels'], [inRange('search', ''), 'searches'], [inRange('play', ''), 'plays']],
    { description: `Over the selected range: Channels slots opened, searches with a query, and videos played (once per room). ${OWN_TESTS}` }));
  p.push(bars('Captions and quality', [[inRange('cc_list', ''), 'captions shown'], [inRange('cc_track', ''), 'tracks picked'], [inRange('quality_pick', '1080p'), '1080p picked'], [inRange('quality_pick', '720p'), '720p picked']],
    { description: `Over the selected range: captions turned on, caption tracks picked on a tablet, and 1080p or 720p picked on a tablet. ${OWN_TESTS}` }));

  p.push(row('Who, broadly'));
  // Joins, not presence: a square lights as people of that language arrive within the range. A quarter
  // of the width each (owner, #248), so the 16 squares sit 4 × 4.
  p.push(squares('Here lately', 'join_lang', { w: 6, h: 10, description: 'Joins over the selected range by VRChat client language, from visitors who allow untrusted URLs. It counts arrivals, not who is still here. Dark: none; 1 grey; 2–3 blue; 4 or more purple.' }));
  p.push(squares('Search languages', 'search_lang', { w: 6, h: 10, description: `Searches with a query over the selected range, by VRChat client language; colours as in Here lately. ${OWN_TESTS}` }));
  p.push(bars('Quest and PC', [[inRange('play_platform', 'pc'), 'PC plays'], [inRange('play_platform', 'android'), 'Quest plays'], [inRange('join', ''), 'joins']],
    { w: 12, h: 10, description: `Over the selected range: plays by player platform (once per room and platform) and joins from visitors who allow untrusted URLs. PC plays are low before the Everything-is-OK#586 deploy (built 2026-11-06; plays whose resolver got the link were not counted PC), so a range that spans it mixes the two. ${OWN_TESTS}` }));

  p.push(row('The night\'s shape'));
  const curve = series('Through the night (Chicago time)', [[occ('publicOccupants'), 'public'], [occ('privateOccupants'), 'private']], { w: 18, h: 9, stack: true, min: 0, decimals: 0, palette: false,
    description: 'People in the production world over the selected range, stacked by public and private instances, in Chicago time.' });
  curve.fieldConfig.defaults.color = { mode: 'continuous-BlPu' };
  curve.fieldConfig.defaults.custom.lineInterpolation = 'smooth';
  p.push(curve);
  // The most people at any 15-minute step of the range whose Chicago hour was 3–5 (the last 24 h until 2026-11-03).
  const lateExpr = `max_over_time((max(eiok_poll{source="world:prod",metric="occupants"}) and on() (${CHICAGO_HOUR} >= 3) and on() (${CHICAGO_HOUR} < 6))[$__range:15m]) or vector(0)`;
  p.push(canvas('Stayed past 03:00', [[lateExpr, 'late']], [icon('zzz', 'zzz', 'late', [6, 52, 14, 14]), label('count', 'late', 64, [46, 4, 10, 10])],
    { w: 6, h: 9, description: 'The most people in the world between 03:00 and 06:00 Chicago time within the selected range; "no one" also when the range holds no such hours. Do people sleep here?',
      colors: { late: [{ color: NIGHT.dim, value: null }, { color: NIGHT.blue, value: 1 }] }, mappings: [{ type: 'value', options: { 0: { text: 'no one' } } }] }));

  return scoped({
    uid: TONIGHT_UID, title: 'Everything is OK · Tonight', tags: ['everything-is-ok'], timezone: 'America/Chicago', refresh: '1m',
    time: { from: 'now-12h', to: 'now' }, schemaVersion: 39, editable: true, graphTooltip: 1,
    description: 'How lively the world is and what people do there, counts only. Right now tiles show the present; the rest follow the selected range (several weeks can overcount where the usage counters restarted). Ops stay on the Everything is OK dashboard.',
    templating: { list: [{ name: 'ds', label: 'Data source', type: 'datasource', query: 'prometheus', regex: '.*-prom$', current: {} }] },
    panels: p,
  });
}

// The Discord contact point. With a mention (owner, 2026-10-26) a notification with a firing severity=critical alert
// starts with <@id>, so it pings; warnings and resolved notices don't. Grafana's default text follows unchanged.
export function contactPoint(url, mention, name = RECEIVER) {
  const settings = { url, use_discord_username: false };
  if (mention) {
    if (!/^\d{5,25}$/.test(mention)) throw new Error('GRAFANA_DISCORD_MENTION must be a Discord user ID (digits)');
    settings.message = `{{ $critical := false }}{{ range .Alerts.Firing }}{{ if eq .Labels.severity "critical" }}{{ $critical = true }}{{ end }}{{ end }}`
      + `{{ if $critical }}<@${mention}> {{ end }}{{ template "default.message" . }}`;
  }
  return { name, type: 'discord', settings, disableResolveMessage: false };
}

// Alerts for what the services can't report about themselves (they already alert Discord on their own problems).
// critical: severity=critical rules go to the critical channel's contact point (push: when DISCORD_CRITICAL_WEBHOOK is
// set; build: always, so the reviewed copy shows the routing).
export function alertRules(dsUid, { critical = false } = {}) {
  const rule = (uid, title, expr, { forM = 5, summary, noData = 'OK', severity = 'warning' }) => ({
    uid, title, folderUID: FOLDER.uid, ruleGroup: 'everything-is-ok', condition: 'C', for: `${forM}m`, noDataState: noData, execErrState: 'Error',
    annotations: { summary }, labels: { project: 'everything-is-ok', severity },
    notification_settings: { receiver: critical && severity === 'critical' ? CRITICAL_RECEIVER : RECEIVER },
    data: [
      { refId: 'A', relativeTimeRange: { from: 900, to: 0 }, datasourceUid: dsUid, model: { refId: 'A', expr, instant: true } },
      { refId: 'C', datasourceUid: '__expr__', model: { refId: 'C', type: 'threshold', expression: 'A', conditions: [{ evaluator: { type: 'gt', params: [0] } }] } },
    ],
  });
  // The condition is "A > 0", so every expression is positive when it fires (2026-10-26: "x < 1" returned 0 when down
  // and "days < 14" went negative once expired, so those never fired). test/grafana.test.js checks the shape.
  return scoped([
    rule('eiok-linode-silent', 'Linode sends nothing', 'absent_over_time(eiok_search_up{host="linode"}[10m])', { summary: 'No metrics from the Linode for 10 minutes: the server, Alloy or the exporter is down.' }),
    rule('eiok-optiplex-silent', 'Optiplex sends nothing', 'absent_over_time(node_time_seconds{host="optiplex"}[15m])', { summary: 'No metrics from the Optiplex for 15 minutes: searches fall back and flash checks wait.' }),
    rule('eiok-search-down', 'Search service down', '1 - max_over_time(eiok_search_up[5m])', { severity: 'critical', summary: 'The search service has not answered /healthz on the Linode for 5 minutes.' }),
    rule('eiok-public-down', 'yt.japharsworld.com unreachable', '1 - max_over_time(probe_success{job=~".*search-healthz.*"}[10m])', { forM: 5, severity: 'critical', summary: 'https://yt.japharsworld.com/healthz failed from outside for 10 minutes (Caddy, TLS or DNS).' }),
    // The short domain (owner, 2026-10-25): the public world bakes https://eiok.cc/s/… for Quest search.
    rule('eiok-short-down', 'eiok.cc unreachable', '1 - max_over_time(probe_success{job=~".*short-healthz.*"}[10m])', { forM: 5, severity: 'critical', summary: 'https://eiok.cc/healthz failed from outside for 10 minutes (Caddy, TLS or DNS): Quest search in the world is down.' }),
    // Caddy renews 30 days ahead, so under 14 days left means renewal is failing.
    rule('eiok-cert-expiry', 'TLS certificate expiring', '14 - min by (job) (probe_ssl_earliest_cert_expiry{job=~".*(search|short)-healthz.*"} - time()) / 86400', { forM: 60, summary: 'A public certificate has under 14 days left ({{ $labels.job }}); Caddy should have renewed it at 30. Check `journalctl -u caddy` on the Linode.' }),
    // Domain registrations from RDAP (metrics/poll.js domainPass): renewal is the owner's (auto-renew, years ahead).
    rule('eiok-domain-expiry', 'Domain expires within 30 days', '30 - min by (source) (eiok_poll{source=~"domain:.*",metric="expires"} - time()) / 86400', { forM: 60, summary: '{{ $labels.source }} expires within 30 days. The world bakes it: renew it at the registrar (Cloudflare for eiok.cc).' }),
    rule('eiok-domain-expiry-urgent', 'Domain expires within 7 days', '7 - min by (source) (eiok_poll{source=~"domain:.*",metric="expires"} - time()) / 86400', { forM: 60, summary: 'URGENT: {{ $labels.source }} expires within 7 days. When it lapses, the public world breaks until it is renewed.' }),
    // The last 48 hours are critical: the critical channel and the mention (owner, #246).
    rule('eiok-domain-expiry-critical', 'Domain expires within 48 hours', '2 - min by (source) (eiok_poll{source=~"domain:.*",metric="expires"} - time()) / 86400', { forM: 60, severity: 'critical', summary: 'CRITICAL: {{ $labels.source }} expires within 48 hours. Renew it at the registrar now (Cloudflare for eiok.cc): when it lapses, the public world breaks.' }),
    rule('eiok-domain-check-stale', 'Domain expiry check failing', '(time() - max by (source) (eiok_poll_timestamp_seconds{source=~"domain:.*"})) > 3 * 86400 or absent(eiok_poll_timestamp_seconds{source="domain:eiok.cc"}) or absent(eiok_poll_timestamp_seconds{source="domain:japharsworld.com"})', { forM: 60, summary: 'No good RDAP answer for a domain in 3 days (or never): the expiry alerts are blind. See `journalctl -u japharsworld-yt-metrics | grep domain_` on the Linode.' }),
    // Owner, 2026-10-25: at 6 jobs a run the 14:00 UTC daily batch (~60 jobs) takes ~3.5 h, so it gets 5 h; other jobs 2 h.
    // Owner, 2026-10-25 (YouTube risk fix 2): a home worker that is online but fails, which "no search worker" misses,
    // and captions answered mostly by Tunelio.
    rule('eiok-worker-not-serving', 'Searches not served by the home relay', '(1 - (sum(increase(eiok_events_total{metric="search_source",key="worker"}[30m])) or vector(0)) / sum(increase(eiok_events_total{metric="search_source"}[30m]))) > 0.5 and on() sum(increase(eiok_events_total{metric="search_source"}[30m])) >= 3 and on() max(eiok_relay_workers_online) > 0', { forM: 5, summary: 'The home relay worker is online, but over half of the last 30 minutes’ searches (3 or more) were served by the Linode or the Data API: YouTube may be refusing the home IP (see YouTube refusals).' }),
    // Not cc_words estimated > real: manual tracks never carry word timing, so that held on normal days (10-24: 104
    // estimated, 71 real, every track from the home worker). Tunelio answering instead of the free sources is the sign.
    rule('eiok-captions-paid', 'Captions falling back to Tunelio', 'sum(increase(eiok_events_total{metric="cc_via",key="tunelio"}[6h])) - (sum(increase(eiok_events_total{metric="cc_via",key=~"worker|local"}[6h])) or vector(0)) > 0 and on() sum(increase(eiok_events_total{metric="cc_via",key="tunelio"}[6h])) >= 3', { forM: 30, summary: 'Over the last 6 hours Tunelio (credits, segment timing) answered more caption fetches than the free sources (home relay, yt-dlp): YouTube may be refusing caption requests (see YouTube refusals).' }),
    // A silent total failure: every lookup answers, with no tracks (world #428). Hypercare has the same check and ends
    // itself after 7 clean days, so this one stays. Its numbers and reasons: infra-check/hypercare.mjs CAP0. Replayed over
    // prod's lookups of 2026-10-26 to 10-31 it never fires (at most 4 videos). At 0.5, as increase() extrapolates.
    rule('eiok-captions-empty', 'No video has caption tracks', 'sum(increase(eiok_events_total{metric="cc_outcome",key="none"}[6h])) >= 5 unless on() sum(increase(eiok_events_total{metric="cc_outcome",key="tracks"}[6h])) >= 0.5', { forM: 0, summary: 'Over the last 6 hours, 5 or more videos looked up had no caption tracks and none had any: caption lookups may be failing silently. See `node tools/ops.mjs events --event captions_via,captions_source_failed` and the Captions panel.' }),
    // Every source throwing, which eiok-captions-empty can't see: resolve returns null, so nothing reaches cc_outcome, and
    // the answer is temporarily_unavailable. failed is a throw that reached the route. Not list_unavailable: no free source
    // online (15 on 10-28), which the worker alerts cover. Neither key had ever counted by 2026-10-31.
    // Everything-is-OK#967 (2026-11-21): it fired at 16:14Z on 4 requests from one room for one video, a livestream archive
    // YouTube had not finished, during the home worker's crash (#968): it counted requests. Now different videos: the
    // service counts a video once per 6 h when a visitor's caption request got none (video_fail captions,
    // src/videofail.js; the IDs stay in its memory). 3 different videos in 6 h: before 2026-11-21 neither key had ever
    // counted, and that day's 4 answers were one video. Until this counter was live (stage 1 of #967) it counted failing
    // half-hours; one room asking about one stuck video for hours can no longer fire it.
    rule('eiok-captions-failing', 'Caption lookups failing', 'sum(increase(eiok_events_total{metric="video_fail",key="captions"}[6h])) >= 3', { forM: 0, summary: 'Captions are failing: {{ printf "%.0f" $values.A.Value }} different videos got no captions when visitors asked, in the last 6 hours (each video counted once, however often it was asked for). One video YouTube can\'t serve does not fire this. Look: `node tools/ops.mjs events --event captions_source_failed,captions_via`, the Captions panel, and whether the home worker restarted (eiok-unit-restarted).' }),
    // Owner, 2026-10-26: the flash worker's YouTube refusals (metrics/exporter.js, yt_refusal flash:<class>), which the
    // search service's own refusal alert (src/refusal.js, the relay worker's) never sees. As there: 3 or more bot, rate,
    // PO-token or 403 refusals, here within 30 minutes (the worker runs every 20).
    rule('eiok-flash-refusals', 'Flash checks refused by YouTube', 'sum(increase(eiok_events_total{metric="yt_refusal",key=~"flash:(bot|rate|potoken|forbidden)"}[30m])) - 2', { forM: 0, summary: 'The Optiplex flash-check worker met 3 or more YouTube refusals (bot wall, rate limit, PO token or 403) in 30 minutes: the home IP may be flagged, which hits the relay worker too. Check `journalctl -u japharsworld-yt-slotworker` on the Optiplex.' }),
    rule('eiok-checks-waiting', 'Flash checks waiting', 'max(eiok_jobs_oldest_pending_seconds{reason="other"}) > 7200 or max(eiok_jobs_oldest_pending_seconds{reason="daily"}) > 18000', { summary: 'A new/candidate/manual resolution or flash job has waited over 2 hours, or the daily batch over 5 hours; the Optiplex worker runs every 20 minutes, 6 jobs a run.' }),
    // Owner, 2026-10-23 (the dashboard audit): the home relay's cap and worker, and the credits lasting to renewal.
    // Ratios of the caps the service reports, so an env change moves the alert with it. MB warned at 90 % until
    // 2026-10-31: 68 % was used by 14:00 Chicago with the evening to come, so 90 % left too little time to act.
    rule('eiok-home-cap', 'Home relay MB near its daily cap', 'max(eiok_home_today{key="mb"}) / max(eiok_home_today{key="cap_mb"}) >= 0.75', { forM: 5, summary: 'The home relay has used 75 % of HOME_DAILY_MB today. At the cap (reset at midnight Chicago), long videos go to Tunelio (credits; long HLS builds can fail on Quest) or youtube.com. `node tools/ops.mjs state` shows both caps.' }),
    rule('eiok-home-builds', 'Home relay builds near their daily cap', 'max(eiok_home_today{key="builds"}) / max(eiok_home_today{key="cap_builds"}) >= 0.9', { forM: 5, summary: 'The home relay has used 90 % of HOME_DAILY_BUILDS today. At the cap (reset at midnight Chicago), long videos go to Tunelio (credits; long HLS builds can fail on Quest) or youtube.com. `node tools/ops.mjs state` shows both caps.' }),
    rule('eiok-home-worker', 'Home relay has no worker', '1 - max(eiok_home_today{key="workers"})', { forM: 15, summary: 'No media worker (the Optiplex relay) connected for 15 minutes: home relay plays fall back to Tunelio or youtube.com.' }),
    // Everything-is-OK#967 (2026-11-21, the owner: stop the hourly hypercare timer and fold what is useful into Grafana).
    // These were hypercare's journal counts. The service counts different videos for them (video_fail, once per video
    // and hour: src/videofail.js; the IDs stay in its memory), and each fires only when the thing also stopped working in
    // the hour (nothing built, nothing ready), so one video that can't be fetched, or a few among many that work, don't.
    // Builds: different videos whose Tunelio build /create accepted then failed or timed out (build_failed: 524, 503, no
    // answer; warm-ups included). The provider refusing a video (tunelio_failed, its 409 "not ready") is not counted:
    // the service alerts on its own when Tunelio fails (5xx, 401, 402, src/playback.js). Hypercare's version counted 524s.
    rule('eiok-builds-failing', 'Video builds failing at Tunelio', 'sum(increase(eiok_events_total{metric="video_fail",key="build"}[1h])) >= 3 unless on() sum(increase(eiok_events_total{metric="build",key="ok"}[1h])) >= 0.5', { forM: 0, summary: 'Tunelio builds are failing: {{ printf "%.0f" $values.A.Value }} different videos\' builds failed or timed out in the last hour, and no Tunelio build succeeded in that hour. One video Tunelio refuses does not fire this. Look: `node tools/ops.mjs events --event build_failed,tunelio_error,tunelio_link` and the failed builds on the dashboard.' }),
    // Home: different videos whose home session failed (src/home.js #fail, not a growing playlist given up on purpose).
    rule('eiok-home-failing', 'Home relay plays failing', 'sum(increase(eiok_events_total{metric="video_fail",key="home"}[1h])) >= 3 unless on() sum(increase(eiok_events_total{metric="home",key="ready"}[1h])) >= 0.5', { forM: 0, summary: 'The home relay is failing: {{ printf "%.0f" $values.A.Value }} different videos failed at home in the last hour and none got ready. One video that fails at home does not fire this. Look: `node tools/ops.mjs events --event home_failed,home_ready`, then `journalctl -u japharsworld-yt-relay -n 80` on the Optiplex.' }),
    // Channels: a hidden slot answers 503 by design (#776); hypercare's limit, 10 in an hour (#863: one visitor on a stale
    // list retries about six times, our own checks add three). Its two firings ever (#520, #554) were our own sweeps.
    rule('eiok-channels-refused', 'Many Channels plays refused', 'sum(increase(eiok_events_total{metric="channel",key="unavailable"}[1h])) >= 10', { forM: 0, summary: '{{ printf "%.0f" $values.A.Value }} Channels plays were refused in the last hour: slots the list hides (stale lists, our own checks). Look: `node tools/ops.mjs events --event channel_refused`.' }),
    // A monitor status the service can't read refuses every Quest Channels play (src/channels.js monitor_unreadable,
    // logged at most once a minute); hypercare's CHMON fired on the first (#863). Counted as channel unreadable (#967).
    rule('eiok-channels-unreadable', 'Channels status unreadable', 'sum(increase(eiok_events_total{metric="channel",key="unreadable"}[1h])) >= 0.5', { forM: 0, summary: 'The search service can\'t read the Channels monitor\'s status: {{ printf "%.0f" $values.A.Value }} Quest Channels plays were refused for it in the last hour, and every one will be until it is fixed. Look: `node tools/ops.mjs events --event channel_refused` (why status_unreadable or status_missing), then the monitor database on the Linode.' }),
    // A request answered 5xx that the service didn't mean to give: a route that threw (src/server.js BY_DESIGN_5XX
    // lists the 5xx answers given on purpose, which have alerts of their own or aren't faults). Hypercare counted these
    // from the journal (3 an hour); none was seen in the reads of 2026-11-19 to 11-21. At the first one (#967, item 5).
    rule('eiok-server-errors', 'Requests answered 5xx', 'sum by (key) (increase(eiok_events_total{metric="http_5xx"}[15m])) >= 0.5', { forM: 0, severity: 'critical', summary: '{{ printf "%.0f" $values.A.Value }} {{ $labels.key }} requests were answered 5xx in the last 15 minutes: a fault in the search service (a route that threw), not a refusal it gives on purpose. Look: `node tools/ops.mjs events --event error` for the route and the error.' }),
    // A crash (Everything-is-OK#967, #968): systemd restarts the search service in 3 s and the home worker in 5 s, between
    // two 60 s scrapes, so nothing else sees it (on 2026-11-21 the worker died out of memory at 16:12Z and was
    // back about 5 s later, and no alert named it). The counter is systemd's own NRestarts (Alloy's systemd enable_restarts,
    // deploy/alloy/*.alloy), which counts the restarts its Restart= makes.
    rule('eiok-unit-restarted', 'Service crashed and restarted', 'sum by (host, name) (increase(node_systemd_service_restart_total{name=~"japharsworld-yt.service|japharsworld-yt-relay.service"}[15m]))', { forM: 0, severity: 'critical', summary: '{{ $labels.name }} on {{ $labels.host }} stopped on its own and systemd started it again, in the 15 minutes before this alert ({{ printf "%.0f" $values.A.Value }} time(s)). Plays and caption jobs it was holding were dropped. Look: `journalctl -u {{ $labels.name }} -n 80` on that host for why it stopped (out of memory, a crash).' }),
    // The worker's memory (Everything-is-OK#967, #968): Alloy sends the production worker's resident and swapped bytes
    // (namedprocess_namegroup_memory_bytes, group relay, deploy/alloy/optiplex.alloy), but no rule reads them yet: the
    // run that crashed peaked at its 1G cap, so a threshold set now could fire the moment it is pushed. The rule comes as
    // a follow-up once a day of the series has been read (the coordinator tracks it on #968).
    // Spend rate (Everything-is-OK#478): fires at the service's home-first point of the hour budget (the defaults of
    // SPEND_HOUR_CREDITS and SPEND_HOME_FIRST_PERCENT, src/spend.js: 75 % of 1500 = 1125), where new plays start going
    // home first. Below it is normal use of the 100k a month plan (owner, 2026-11-04); the busiest real hour was ~310
    // (prod 2026-10-31). An env override of either on the server doesn't move this rule: rebuild with the same numbers.
    ...(() => {
      const at = Math.round(HOUR_CREDITS * HOME_FIRST_PERCENT / 100);
      return [rule('eiok-spend-rate', `Tunelio spend over ${at} credits an hour`, `sum(increase(eiok_events_total{metric="credits"}[1h])) > ${at}`, { forM: 0, summary: `Over ${at} Tunelio credits were spent in the last hour (${HOME_FIRST_PERCENT} % of the ${HOUR_CREDITS} hour budget): new plays now go home first while home has room, and at ${HOUR_CREDITS} the service stops new paid builds and alerts Discord. Check builds and routes (\`node tools/ops.mjs events --event build_route,spend_cap,spend_budget\`).` })];
    })(),
    // The last 3 days' spend per day times the days left, minus the credits left. Days from the poller, which reads
    // TUNELIO_RENEWS_DAY (metrics/poll.js renewalPass): until 2026-10-31 this counted days to the 1st while prod renews on
    // the 17th, so on the 31st it needed a whole balance of spend in a day. Counts prod's spend only, and the balance fell
    // about 27 % faster than that (10-25 to 10-31, cause unverified), so it can fire late.
    rule('eiok-credits-pace', 'Credits run out before renewal', '(sum(increase(eiok_events_total{metric="credits"}[3d])) / 3) * max(eiok_poll{source="tunelio_plan",metric="days_to_renewal"}) - max(eiok_credits_remaining) > 0', { forM: 60, summary: 'At the last 3 days’ spend, the Tunelio credits run out before the plan renews (TUNELIO_RENEWS_DAY). The pacer moves plays home while home has room; at 0 they go to youtube.com at 360p.' }),
    // Inputs the rules above and below need. Without them those rules see no data and stay quiet, which looks like health.
    rule('eiok-alert-inputs-missing', 'Alert inputs missing', 'absent(eiok_home_today{key="cap_builds"}) or absent(eiok_service_memory_limit_bytes) or absent(eiok_poll{source="tunelio_plan",metric="days_to_renewal"}) or absent(eiok_events_total{metric="cc_outcome",key="none"}) or absent(node_systemd_service_restart_total{host="linode",name="japharsworld-yt.service"}) or absent(node_systemd_service_restart_total{host="optiplex",name="japharsworld-yt-relay.service"}) or absent(eiok_events_total{metric="video_fail",key="captions"}) or absent(eiok_events_total{metric="http_5xx",key="ticket"})', { forM: 30, summary: 'A value that the build cap, service memory, credit pace, captions, crash-restart or server-errors alert needs has been missing for 30 minutes, so that alert is blind. Expected while the search service is down, and for a restart counter while its host is off. Otherwise check japharsworld-yt-exporter (STATS_TOKEN, cgroup) and the metrics poller on the Linode, or, for the restart counters, Alloy on the Linode or the Optiplex (`systemctl status alloy`, `journalctl -u alloy`).' }),
    // tunelio_plan is written mid-pass with no outside call needed (metrics/poll.js renewalPass). The timer is 15 min; the
    // widest gap in 523 passes to 2026-10-31 was 18 min. A pass stuck or failing before it leaves the old value exported, so
    // this sees it, but not a failure after it. A value missing altogether is eiok-alert-inputs-missing's.
    rule('eiok-poller-stale', 'Metrics poller stale', 'time() - max(eiok_poll_timestamp_seconds{source="tunelio_plan"}) - 3600', { forM: 5, summary: 'No metrics poller pass has reached its Tunelio plan step for over an hour (it runs every 15 minutes): the poller is stopped, stuck or failing early, so world numbers, Tunelio credits and what follows in the pass are stale. A failure later in the pass does not fire this. See `journalctl -u japharsworld-yt-metrics` on the Linode.' }),
    // Sustained capacity, not spikes (7 days to 2026-10-31: p50 2 %, p95 11 %, p99 32 %, single spikes to 99 %).
    rule('eiok-linode-cpu', 'Linode CPU over 80 %', '1 - avg(rate(node_cpu_seconds_total{host="linode",mode="idle"}[5m])) > 0.8', { forM: 15, summary: 'The Linode’s CPU has been over 80 % busy for 15 minutes; plays and searches slow down first. No event-loop metric exists. Check `top` there and the Hosts row.' }),
    // Anon + swap against the live MemoryMax (metrics/exporter.js). 61 % on 2026-10-31; since the last start swap peaked at
    // 231 MiB, so about 83 % at most if anon (~102 MiB) stood as now then. There is no history to set this from: a judgement.
    // Not an OOM line: swap is unlimited in the unit, so this is an early warning of growth.
    rule('eiok-service-memory', 'Search service memory near its limit', 'sum(eiok_service_memory_bytes{kind=~"anon|swap"}) / max(eiok_service_memory_limit_bytes) > 0.9', { forM: 15, summary: 'The search service’s anon + swap has been over 90 % of MemoryMax for 15 minutes (page cache not counted). An OOM restart drops pins and held plays. See the Search service memory panel; `systemctl set-property japharsworld-yt MemoryMax=…` needs no restart.' }),
    // Every source in the chain failed (src/search.js) and the visitor saw an error. Two, so that one blip stays quiet; a
    // count, as a ratio means little at about 85 searches a day. None had ever happened by 2026-10-31.
    rule('eiok-search-502', 'Searches failing (502)', 'sum(increase(eiok_events_total{metric="search_fail",key="502"}[15m])) >= 2', { forM: 0, summary: 'Two or more searches in 15 minutes got 502 youtube_failed: the home relay, the Linode and the Data API all failed. See `node tools/ops.mjs state` and the YouTube refusals panel.' }),
    // Transfer (owner, 2026-10-24): metrics.db counts from src/net.js; months are Chicago calendar months.
    // The home connection has no ISP data cap (owner, 2026-10-27), so these are only alerts on unusual volume: 100 GB a day
    // (2026-10-27 alone was ~19 GB of home builds) and 2,000 GB a month.
    rule('eiok-home-egress-day', 'Home sent over 100 GB today', 'max(eiok_transfer_bytes{host="home",period="today"}) > 100e9', { forM: 5, summary: 'The Optiplex has sent over 100 GB today (home relay uploads and everything else on the box). No ISP cap (owner, 10-27): this is unusual volume, not a limit.' }),
    rule('eiok-home-egress-month', 'Home sent over 2,000 GB this month', 'max(eiok_transfer_bytes{host="home",period="month"}) > 2000e9', { forM: 5, summary: 'The Optiplex has sent over 2,000 GB this month. No ISP cap (owner, 10-27): this is unusual volume, not a limit.' }),
    rule('eiok-linode-egress-month', 'Linode sent over 700 GB this month', 'max(eiok_transfer_bytes{host="linode",period="month"}) > 700e9', { forM: 5, summary: 'The Linode has sent over 700 GB this month, of its 1 TB transfer (overage about $5 per TB).' }),
    // The Linode's / is 25 GB (47 % used 2026-10-25, the home session files capped at HOME_MAX_GB=8): earlier warnings there.
    // With the home cache full at HOME_MAX_GB=12, / sits at ~76 % (2026-10-27), so the old 70 % warning fired for good;
    // 80 % warns and 88 % is critical (owner, option 1).
    rule('eiok-linode-disk-80', 'Linode disk 80 % full', 'max(1 - node_filesystem_avail_bytes{host="linode",mountpoint="/"} / node_filesystem_size_bytes{host="linode",mountpoint="/"}) > 0.8', { forM: 15, summary: 'The Linode’s / is over 80 % full (a full home cache at HOME_MAX_GB=12 is ~76 %, so something else grew). Check `du -sh /var/lib/japharsworld-yt/*` (home sessions, SQLite) and the journal.' }),
    rule('eiok-linode-disk-88', 'Linode disk 88 % full', 'max(1 - node_filesystem_avail_bytes{host="linode",mountpoint="/"} / node_filesystem_size_bytes{host="linode",mountpoint="/"}) > 0.88', { forM: 15, severity: 'critical', summary: 'The Linode’s / is over 88 % full (a full home cache at HOME_MAX_GB=12 is ~76 %): free space before SQLite writes and home uploads fail. Check `du -sh /var/lib/japharsworld-yt/*` and lower HOME_MAX_GB if the home files grew.' }),
    // Since 2026-10-30 the home store has its own 100 GB volume (eiok-home, claude/play-latency.md), which the / rules
    // above don't see. HOME_MAX_GB=80 of ~98 GB is ~82 %, sessions in play can pass it, and HOME_FREE_FLOOR_GB (3)
    // stops builds before the last 3 %, so 92 % means the floor is being leaned on.
    rule('eiok-linode-home-92', 'Linode home volume 92 % full', 'max(1 - node_filesystem_avail_bytes{host="linode",mountpoint="/var/lib/japharsworld-yt/home"} / node_filesystem_size_bytes{host="linode",mountpoint="/var/lib/japharsworld-yt/home"}) > 0.92', { forM: 15, summary: 'The Linode’s home volume (/var/lib/japharsworld-yt/home, 100 GB) is over 92 % full: long plays are being refused at home (home_no_room) or stopped. Check `df -h /var/lib/japharsworld-yt/home` and the home sessions (`node tools/ops.mjs state`); lower HOME_MAX_GB or grow the volume.' }),
    // Linode security (owner, 2026-10-26): metrics/security.js counts every minute, over the last 10 minutes. Each
    // expression is positive when it fires (the condition is > 0).
    rule('eiok-ssh-unknown-login', 'SSH login from an unknown address', 'max(eiok_ssh_accepted_10m{host="linode",source="unknown"})', { forM: 0, severity: 'critical', summary: 'SECURITY: an SSH login on the Linode from an address not in SSH_KNOWN_SOURCES. Check `journalctl -t sshd -t sshd-session` there now.' }),
    rule('eiok-security-change', 'Linode keys, sshd or ufw changed', 'max by (item) (changes(eiok_security_hash{host="linode"}[15m]))', { forM: 0, severity: 'critical', summary: 'SECURITY: {{ $labels.item }} changed on the Linode (an authorized_keys file, the sshd auth settings or the ufw rules). Fine if it was planned; otherwise check it now.' }),
    rule('eiok-sshd-not-hardened', 'Linode sshd hardening off', '1 - min(eiok_sshd_hardened{host="linode"})', { forM: 0, severity: 'critical', summary: 'SECURITY: sshd -T on the Linode allows password or keyboard-interactive login, or root by password.' }),
    rule('eiok-ssh-failed-spike', 'SSH failed attempts spike', 'sum(eiok_ssh_failed_10m{host="linode"}) > 20', { forM: 0, summary: 'Over 20 failed SSH attempts on the Linode in 10 minutes, though port 22 takes only the owner’s address. Check the Linode firewall and fail2ban.' }),
    rule('eiok-linode-unit-down', 'Linode ssh/fail2ban/alloy not active', '1 - max by (name) (node_systemd_unit_state{host="linode",name=~"(ssh|fail2ban|alloy).service",state="active"})', { forM: 5, summary: '{{ $labels.name }} is not active on the Linode.' }),
    rule('eiok-security-stale', 'Linode security counters stale', 'time() - max(eiok_security_updated_seconds{host="linode"}) - 600', { forM: 5, noData: 'Alerting', summary: 'metrics/security.js has not written its counters for 10 minutes (japharsworld-yt-security.timer on the Linode), so the security alerts are blind.' }),
    // The Tester tab's problem reports (world #353, 2026-10-29), one alert per kind, so the coordinator's watcher hears of
    // them while its session is open. Resync and autoresync (every visitor's) only count: as alerts they would be noise.
    // It posts to the warning channel (owner, 2026-10-29: fine there for now). Its own channel later: a third contact
    // point from its own webhook env var, pushed like DISCORD_CRITICAL_WEBHOOK's, and this rule's receiver set to it.
    rule('eiok-tester-report', 'Tester video report', 'sum by (kind) (increase(eiok_video_report_total{kind=~"frozen|stutter|sync|sound|load|quality"}[15m]))', { forM: 0, summary: 'A tester reported "{{ $labels.kind }}" from the world in the last 15 minutes. The play behind it: `node tools/ops.mjs events --event video_report`.' }),
    rule('eiok-tunelio-reopen-fail', 'Tunelio open or reopen failed', 'sum(increase(eiok_tunelio_probe_reopen_fail_total[6h])) + sum(increase(eiok_tunelio_probe_open_fail_total[6h]))', { forM: 0, summary: 'In the last 6 hours the speed probe could not resume a cut Tunelio link at the byte reached, or could not open one at all (three tries): a reset would then be a visible freeze for players, and a failed open can mean Tunelio stopped honouring Range. The cause can be the Linode\'s own network, because any fetch error counts, not only an answer from Tunelio. The details: `node tools/ops.mjs events --event tunelio_drop_open,tunelio_drop_cut,tunelio_drop_reopen,tunelio_drop`.' }),
    // World #274: over 30 % of 5 or more visitor plays in 3 h failed. "left" counts as a play, not as a failure.
    rule('eiok-play-failures', 'Many plays failing for visitors', '(sum(increase(eiok_play_outcome_total{who="visitor",outcome=~"e.*|timeout|after"}[3h])) / sum(increase(eiok_play_outcome_total{who="visitor"}[3h])) - 0.3) and sum(increase(eiok_play_outcome_total{who="visitor"}[3h])) >= 5', { forM: 0, summary: 'Over 30 % of visitors\' plays failed in the last 3 hours. By class and plan: the "What visitors saw" row, or eiok_play_outcome_total.' }),
    // The daily S3 backup (metrics/backup.js, Everything-is-OK#585) runs at 01:30 Chicago: over 30 h since a day landed
    // means a night was missed. No data (backups not set up) is OK.
    rule('eiok-backup-missing', 'Daily backup missing', 'time() - max(eiok_backup_last_success_timestamp_seconds) - 30 * 3600', { forM: 60, summary: 'No day has reached the S3 backup for over 30 hours (it runs at 01:30 Chicago and catches up to 3 missed days). See `journalctl -u japharsworld-yt-backup` on the Linode.' }),
    rule('eiok-disk-low', 'Disk almost full', 'max by (host) (1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) > 0.9', { forM: 15, summary: 'Under 10 % free on / of {{ $labels.host }}.' }),
  ]);
}

async function api(path, { method = 'GET', body } = {}) {
  const base = env.GRAFANA_URL?.replace(/\/$/, '');
  const token = env.GRAFANA_SA_TOKEN;
  if (!base || !token) throw new Error('set GRAFANA_URL and GRAFANA_SA_TOKEN (in .env or the environment)');
  const r = await fetch(`${base}${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-disable-provenance': 'true' },
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`), { status: r.status });
  return text ? JSON.parse(text) : null;
}

// The stack's Prometheus data source: GRAFANA_PROM_DS_UID, else the list (needs datasources:read), else Grafana
// Cloud's usual uid.
async function promSource() {
  const byUid = (uid) => api(`/api/datasources/uid/${encodeURIComponent(uid)}`);
  if (env.GRAFANA_PROM_DS_UID) return byUid(env.GRAFANA_PROM_DS_UID);
  try {
    const sources = await api('/api/datasources');
    const prom = sources.find((d) => d.type === 'prometheus' && /-prom$/.test(d.name)) ?? sources.find((d) => d.type === 'prometheus');
    if (prom) return prom;
  } catch (err) { if (err.status !== 403) throw err; }
  try { return await byUid('grafanacloud-prom'); } catch {
    throw new Error('no Prometheus data source found; set GRAFANA_PROM_DS_UID (Connections > Data sources > the -prom one, uid in its URL)');
  }
}

async function push() {
  const prom = await promSource();
  try { await api('/api/folders', { method: 'POST', body: FOLDER }); } catch (err) { if (err.status !== 409 && err.status !== 412) throw err; }
  await api('/api/dashboards/db', { method: 'POST', body: { dashboard: dashboard(), folderUid: FOLDER.uid, overwrite: true, message: 'tools/grafana.mjs push' } });
  console.log(`dashboard: ${env.GRAFANA_URL.replace(/\/$/, '')}/d/${DASH_UID}`);
  await api('/api/dashboards/db', { method: 'POST', body: { dashboard: tonight(), folderUid: FOLDER.uid, overwrite: true, message: 'tools/grafana.mjs push' } });
  console.log(`dashboard: ${env.GRAFANA_URL.replace(/\/$/, '')}/d/${TONIGHT_UID}`);

  if (env.GRAFANA_DISCORD_WEBHOOK) {
    const points = await api('/api/v1/provisioning/contact-points');
    const cp = contactPoint(env.GRAFANA_DISCORD_WEBHOOK, env.GRAFANA_DISCORD_MENTION);
    const existing = points.find((c) => c.name === RECEIVER);
    if (existing) await api(`/api/v1/provisioning/contact-points/${existing.uid}`, { method: 'PUT', body: { ...cp, uid: existing.uid } });
    else await api('/api/v1/provisioning/contact-points', { method: 'POST', body: cp });
    console.log(`contact point: ${RECEIVER}`);
  } else if (!(await api('/api/v1/provisioning/contact-points')).some((c) => c.name === RECEIVER)) {
    throw new Error('set GRAFANA_DISCORD_WEBHOOK the first time (the alert rules send to it)');
  }
  const critical = Boolean(env.DISCORD_CRITICAL_WEBHOOK);
  if (critical) {
    const points = await api('/api/v1/provisioning/contact-points');
    const cp = contactPoint(env.DISCORD_CRITICAL_WEBHOOK, env.GRAFANA_DISCORD_MENTION, CRITICAL_RECEIVER);
    const existing = points.find((c) => c.name === CRITICAL_RECEIVER);
    if (existing) await api(`/api/v1/provisioning/contact-points/${existing.uid}`, { method: 'PUT', body: { ...cp, uid: existing.uid } });
    else await api('/api/v1/provisioning/contact-points', { method: 'POST', body: cp });
    console.log(`contact point: ${CRITICAL_RECEIVER}`);
  }
  for (const r of alertRules(prom.uid, { critical })) {
    try { await api(`/api/v1/provisioning/alert-rules/${r.uid}`, { method: 'PUT', body: r }); } catch (err) {
      if (err.status !== 404) throw err;
      await api('/api/v1/provisioning/alert-rules', { method: 'POST', body: r });
    }
    console.log(`alert: ${r.title}`);
  }
  // Push only creates and updates by uid, so a rule renamed away would stay in Grafana and keep firing.
  for (const uid of RETIRED_RULES) {
    try { await api(`/api/v1/provisioning/alert-rules/${uid}`, { method: 'DELETE' }); console.log(`alert removed: ${uid}`); } catch (err) { if (err.status !== 404) throw err; }
  }
}
// Rule uids no longer defined (2026-10-27: the 70 % Linode disk warning became 80 %, the 80 % critical 88 %;
// 2026-10-29: the mass Channels outage warning is the monitor's alone, outage_watch, once a day at most).
export const RETIRED_RULES = ['eiok-linode-disk-70', 'eiok-channels-mass-down'];

// One alert rule, alone: a PUT by uid (a POST if Grafana doesn't have it yet), then a read-back with its state. For a
// rule change that must not touch the dashboards or the other rules (2026-11-03: eiok-spend-rate, pushed with a release).
// `call` is the API (injectable for tests); dryRun returns the request without calling it at all.
export async function pushRule(uid, { dryRun = false, call = api, dsUid = null, critical = Boolean(env.DISCORD_CRITICAL_WEBHOOK) } = {}) {
  if (!uid) throw new Error('usage: node tools/grafana.mjs push-rule <uid> [--dry-run]');
  const ds = dsUid ?? (dryRun ? '${ds}' : (await promSourceVia(call)).uid);
  const rule = alertRules(ds, { critical }).find((r) => r.uid === uid);
  if (!rule) throw new Error(`no alert rule ${uid} in tools/grafana.mjs`);
  const request = { method: 'PUT', path: `/api/v1/provisioning/alert-rules/${uid}`, body: rule };
  if (dryRun) return { dryRun: true, request };
  try { await call(request.path, { method: 'PUT', body: rule }); } catch (err) {
    if (err.status !== 404) throw err;
    await call('/api/v1/provisioning/alert-rules', { method: 'POST', body: rule });
  }
  const back = await call(`/api/v1/provisioning/alert-rules/${uid}`);
  const groups = (await call('/api/prometheus/grafana/api/v1/rules'))?.data?.groups ?? [];
  const live = groups.flatMap((g) => g.rules ?? []).find((r) => r.uid === uid || r.name === rule.title);
  return { uid: back?.uid, title: back?.title, expr: back?.data?.[0]?.model?.expr, receiver: back?.notification_settings?.receiver,
    state: live?.state ?? null, health: live?.health ?? null, lastEvaluation: live?.lastEvaluation ?? null };
}

// Everything-is-OK#967 (the verifier's R2-M1): the rules here read series production sends only after the deploy that
// carries 76c083d (video_fail, http_5xx, channel unreadable) and after both hosts run the new Alloy configs (the restart
// counters). A full `push` before then fires "Alert inputs missing" within 30 minutes and blinds the rules that read the
// new series. So `push` refuses until it is told the deploy is live (--after-deploy); push-rule is not affected.
// Before `push --after-deploy`, these four must show in Grafana (inputs-missing's new terms):
//   node_systemd_service_restart_total{host="linode",name="japharsworld-yt.service"}
//   node_systemd_service_restart_total{host="optiplex",name="japharsworld-yt-relay.service"}
//   eiok_events_total{metric="video_fail",key="captions"}
//   eiok_events_total{metric="http_5xx",key="ticket"}
// Then remove the guard in a commit of its own: FULL_PUSH_WAITS_FOR = null here, and the guard test in
// test/grafana.test.js and the push-step sentence in claude/monitoring.md with it. Until then every full push needs
// the flag.
export const FULL_PUSH_WAITS_FOR = { commit: '76c083d', issue: 'Everything-is-OK#967' };
export function fullPushRefusal(args, waits = FULL_PUSH_WAITS_FOR) {
  if (!waits || args.includes('--after-deploy')) return null;
  return `push refused: these rules need the production deploy that carries ${waits.commit} (${waits.issue}) and the new Alloy configs on the Linode and the Optiplex; pushed earlier, "Alert inputs missing" fires and the rules that read the new series go blind. Push single rules with push-rule meanwhile (claude/monitoring.md, Setup). Once the deploy is live and its series show in Grafana: node tools/grafana.mjs push --after-deploy (and set FULL_PUSH_WAITS_FOR to null).`;
}

// promSource() through another API function (pushRule's injectable `call`).
async function promSourceVia(call) {
  if (call === api) return promSource();
  return call(`/api/datasources/uid/${encodeURIComponent(env.GRAFANA_PROM_DS_UID ?? 'grafanacloud-prom')}`);
}

const cmd = process.argv[2];
if (cmd === 'build') {
  mkdirSync('grafana', { recursive: true });
  writeFileSync('grafana/dashboard.json', `${JSON.stringify(dashboard(), null, 1)}\n`);
  writeFileSync('grafana/tonight.json', `${JSON.stringify(tonight(), null, 1)}\n`);
  writeFileSync('grafana/alert-rules.json', `${JSON.stringify(alertRules('${ds}', { critical: true }), null, 1)}\n`);
  console.log('wrote grafana/dashboard.json, grafana/tonight.json, grafana/alert-rules.json');
} else if (cmd === 'push') {
  const refused = fullPushRefusal(process.argv.slice(3));
  if (refused) { console.error(refused); process.exit(2); }
  push().catch((err) => { console.error(err.message); process.exitCode = 1; });
} else if (cmd === 'push-rule') {
  const args = process.argv.slice(3);
  pushRule(args.find((a) => !a.startsWith('--')), { dryRun: args.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify(r, null, 1)))
    .catch((err) => { console.error(err.message); process.exitCode = 1; });
} else if (cmd) {
  console.error('usage: node tools/grafana.mjs build|push [--after-deploy]|push-rule <uid> [--dry-run]');
  process.exit(2);
}
