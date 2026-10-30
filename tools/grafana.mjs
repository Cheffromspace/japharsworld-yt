// Grafana Cloud dashboard and alert rules for Everything is OK (claude/monitoring.md), kept in the repo.
//   node tools/grafana.mjs build    writes grafana/dashboard.json, grafana/tonight.json and grafana/alert-rules.json
//   node tools/grafana.mjs push     uploads them to the stack (and the Discord contact points)
// push reads its settings from the environment or the repo's .env (gitignored; the environment wins):
//   GRAFANA_URL               https://<stack>.grafana.net
//   GRAFANA_SA_TOKEN          a service account token (glsa_…, Editor role); not GRAFANA_TOKEN, Alloy's write-only token
//   GRAFANA_DISCORD_WEBHOOK   where the alerts go (the contact point). Change it and push again to move them.
//   GRAFANA_DISCORD_MENTION   optional: a Discord user ID mentioned on firing critical alerts only (kept out of the repo)
//   DISCORD_CRITICAL_WEBHOOK  optional: the critical-alerts channel (world #195, owner 2026-10-26). With it, severity=critical
//                             rules go to their own contact point there; without it, everything goes to the one above.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

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
  return expr.replace(/\b((?:eiok|probe|node)_[A-Za-z0-9_]+)(\{)?/g, (m, name, brace) => (brace ? `${name}{${PROD},` : `${name}{${PROD}}`));
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
  return {
    type: 'stat', id: ++id, title, description, datasource: DS, gridPos: place(w, h), targets: targets(list),
    options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'background', graphMode: 'none', textMode: Array.isArray(expr) ? 'value_and_name' : 'value' },
    fieldConfig: { defaults: { unit, decimals, mappings: mappings ?? [], thresholds: { mode: 'absolute', steps: thresholds ?? [{ color: 'blue', value: null }] } }, overrides: [] },
  };
}
function series(title, list, { unit = 'short', w = 12, h = 8, stack = false, description, min, decimals, overrides = [] } = {}) {
  return {
    type: 'timeseries', id: ++id, title, description, datasource: DS, gridPos: place(w, h), targets: targets(list),
    options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    fieldConfig: { defaults: { unit, min, decimals, custom: { lineWidth: 2, fillOpacity: stack ? 30 : 8, stacking: { mode: stack ? 'normal' : 'none' } } }, overrides },
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
const marker = (name, expr, iconColor, titleFormat, tagKeys) => ({
  name, datasource: DS, enable: true, iconColor, expr, step: '5m', useValueForTime: true, titleFormat, textFormat: '', tagKeys,
});

// Tokyo Night status colours.
const OK = '#9ece6a', WARN = '#e0af68', BAD = '#f7768e', INK = '#7aa2f7';
const upDown = [{ type: 'value', options: { 0: { text: 'down', color: BAD }, 1: { text: 'up', color: OK } } }];

export function dashboard() {
  id = 0; grid.x = 0; grid.y = 0; grid.rowH = 0;
  const p = [];
  p.push(row('Now'));
  p.push(stat('Search service', 'min(eiok_search_up)', { w: 3, mappings: upDown, thresholds: [{ color: BAD, value: null }, { color: OK, value: 1 }] }));
  p.push(stat('Public /healthz', 'min(probe_success{job=~".*search-healthz.*"})', { w: 3, mappings: upDown, thresholds: [{ color: BAD, value: null }, { color: OK, value: 1 }] }));
  p.push(stat('Relay workers', 'max(eiok_relay_workers_online)', { w: 3, thresholds: [{ color: BAD, value: null }, { color: OK, value: 1 }], description: 'The Optiplex long-polling for searches.' }));
  p.push(stat('In the world now', 'max(eiok_poll{source="world:prod",metric="occupants"})', { w: 3, thresholds: [{ color: INK, value: null }] }));
  p.push(stat('Credits left', 'max(eiok_credits_remaining)', { w: 3, thresholds: [{ color: BAD, value: null }, { color: WARN, value: 500 }, { color: OK, value: 1500 }] }));
  p.push(stat('Channels hidden', 'sum(eiok_slot_hidden * on(slot) (1 - eiok_slot_spare))', { w: 3, thresholds: [{ color: OK, value: null }, { color: WARN, value: 1 }, { color: BAD, value: 5 }] }));
  p.push(stat('Flash fails now', 'count(eiok_slot_flash_pass == 0) or vector(0)', { w: 3, thresholds: [{ color: OK, value: null }, { color: BAD, value: 1 }], description: 'Slots whose current stream failed its last flash check.' }));
  p.push(stat('Oldest waiting check', 'max(eiok_jobs_oldest_pending_seconds{reason="other"})', { w: 3, unit: 's', thresholds: [{ color: OK, value: null }, { color: WARN, value: 3600 }, { color: BAD, value: 7200 }], description: 'New, candidate and manual resolution + flash jobs wait for the Optiplex worker (every 20 min); the daily batch is in Check queue.' }));

  const startupNote = 'Last 3 h, per ticket request: a slow video the player retries counts several timeouts. A timeout means the player waited 90 s and got youtube.com at 360p.';
  const noBuilds = [{ type: 'special', options: { match: 'nan', result: { text: 'no builds' } } }, { type: 'special', options: { match: 'null', result: { text: 'no builds' } } }];
  p.push(stat('Total visits (production)', 'max(eiok_poll{source="world:prod",metric="visits"})', { w: 5, unit: 'locale', decimals: 0, thresholds: [{ color: INK, value: null }] }));
  p.push(stat('Favorites (production)', 'max(eiok_poll{source="world:prod",metric="favorites"})', { w: 4, unit: 'locale', decimals: 0, thresholds: [{ color: INK, value: null }] }));
  p.push(stat('Start-up problems, last 3 h', [
    ['sum(increase(eiok_events_total{metric="ticket_timeout"}[3h])) or vector(0)', 'player timeouts'],
    ['sum(increase(eiok_events_total{metric="build",key="failed"}[3h])) or vector(0)', 'failed builds'],
  ], { w: 7, decimals: 0, thresholds: [{ color: OK, value: null }, { color: WARN, value: 0.5 }, { color: BAD, value: 3 }], description: startupNote }));
  p.push(stat('Tunelio build time', [
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_build_progressive_seconds_bucket[3h])))', 'visitors p95, 3 h'],
    ['max(eiok_poll{source="tunelio:progressive",metric="start_s"})', 'probe progressive'],
    ['max(eiok_poll{source="tunelio:hls",metric="start_s"})', 'probe HLS'],
  ], { w: 8, unit: 's', decimals: 0, mappings: noBuilds, thresholds: [{ color: OK, value: null }, { color: WARN, value: 20 }, { color: BAD, value: 60 }],
    description: 'Visitors’ progressive builds (p95 over 3 h, from the daily buckets) and the speed probe’s latest start times (src/probe.js). Over ~20 s the visitor waits past the resolver hold; over ~100 s the player gives up.' }));

  p.push(row('Visitors and search'));
  p.push(series('In world (production)', [
    ['max(eiok_poll{source="world:prod",metric="occupants"})', 'in world'],
    ['max(eiok_poll{source="world:prod",metric="publicOccupants"})', 'public instances'],
    ['max(eiok_poll{source="world:prod",metric="privateOccupants"})', 'private instances'],
    ['max(eiok_poll{source="group",metric="online"})', 'group online'],
  ], { w: 12, min: 0, description: 'VRChat’s world counts, polled about every minute (japharsworld-yt-occupants.timer). VRChat updates them on its own schedule.' }));
  p.push(series('Total visits (production)', [
    ['max(eiok_poll{source="world:prod",metric="visits"})', 'visits'],
    ['max(eiok_poll{source="world:prod",metric="favorites"})', 'favorites'],
  ], { w: 12, unit: 'locale', decimals: 0, overrides: [{ matcher: { id: 'byName', options: 'favorites' }, properties: [{ id: 'custom.axisPlacement', value: 'right' }] }],
    description: 'All-time counts from VRChat. Grafana has them from 2026-10-21; /stats has the daily history before that.' }));
  p.push(series('Searches, plays, joins (per hour)', [
    ['sum by (metric) (increase(eiok_events_total{metric=~"search|play|join|more",key=""}[1h]))', '{{metric}}'],
  ], { w: 24, h: 6 }));
  p.push(series('Search latency', [
    ['histogram_quantile(0.5, sum by (le) (increase(eiok_search_seconds_bucket[3h])))', 'p50'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_search_seconds_bucket[3h]))) and on() sum(increase(eiok_search_seconds_count[3h])) >= 20', 'p95'],
    ['sum(increase(eiok_search_seconds_count[3h]))', 'searches in window'],
  ], { w: 8, unit: 's', min: 0, overrides: [{ matcher: { id: 'byName', options: 'searches in window' }, properties: [{ id: 'unit', value: 'short' }, { id: 'decimals', value: 0 }, { id: 'custom.axisPlacement', value: 'right' }, { id: 'custom.lineStyle', value: { fill: 'dash', dash: [4, 4] } }, { id: 'custom.lineWidth', value: 1 }] }],
    description: 'From the daily buckets, over 3 h windows. p95 shows only when the window holds 20 or more searches: with fewer, one slow search sets it for 3 h (the plateaus). Searches in window on the right axis.' }));
  p.push(series('Search failure rate', [
    ['sum(increase(eiok_events_total{metric="search_fail"}[3h])) / clamp_min(sum(increase(eiok_events_total{metric="search",key=""}[3h])) + sum(increase(eiok_events_total{metric="search_fail"}[3h])), 1)', 'failures'],
  ], { w: 8, unit: 'percentunit', min: 0 }));
  p.push(series('Play routes (per 3 h)', [
    ['sum by (key) (increase(eiok_events_total{metric="play_route"}[3h]))', '{{key}}'],
  ], { w: 8, stack: true }));
  p.push(series('Tunelio credits left', [['max(eiok_credits_remaining)', 'left']], { w: 8, min: 0 }));
  p.push(series('Tunelio build time', [
    ['histogram_quantile(0.5, sum by (le) (increase(eiok_build_progressive_seconds_bucket[6h])))', 'progressive p50'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_build_progressive_seconds_bucket[6h])))', 'progressive p95'],
    ['histogram_quantile(0.5, sum by (le) (increase(eiok_build_hls_seconds_bucket[6h])))', 'HLS p50'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_build_hls_seconds_bucket[6h])))', 'HLS p95'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_ticket_hold_seconds_bucket[6h])))', 'ticket hold p95'],
  ], { w: 8, unit: 's', description: 'From the daily buckets, over 6 h windows. A player is held up to 90 s, the resolver 12 s (claude/play-latency.md).' }));
  p.push(series('Start-up problems (per 3 h)', [
    ['sum(increase(eiok_events_total{metric="ticket_timeout"}[3h]))', 'player timeouts (got youtube.com)'],
    ['sum(increase(eiok_events_total{metric="ticket_fastfail"}[3h]))', 'resolver fast-fails (normal while building)'],
    ['sum(increase(eiok_events_total{metric="build",key="failed"}[3h]))', 'failed builds'],
    ['sum by (key) (increase(eiok_events_total{metric="play_fallback"}[3h]))', 'fallback: {{key}}'],
  ], { w: 8, min: 0, description: 'Per ticket request, so one slow video retried by the player counts several timeouts; plays count once per room.' }));
  const probeNote = 'Speed probe about hourly (src/probe.js; every ~20 min before 2026-10-23): a fresh 12–30 min video at 1080p, progressive and HLS on alternate runs, so each line moves about every 2–2.5 h. Start = what a player waits for (progressive: first byte; HLS: playlist + first segment).';
  p.push(series('Tunelio probe: time to start', [
    ['max by (source) (eiok_poll{source=~"tunelio:.*",metric="start_s"})', '{{source}}'],
    ['max by (source) (eiok_poll{source=~"tunelio:.*",metric="create_s"})', '{{source}} /create'],
  ], { w: 12, unit: 's', min: 0, description: probeNote }));
  p.push(series('Tunelio probe: build speed', [
    ['max by (source) (eiok_poll{source=~"tunelio:.*",metric="mb_per_s"})', '{{source}} MB/s'],
    ['max by (source) (eiok_poll{source=~"tunelio:.*",metric="mb"})', '{{source}} file MB'],
  ], { w: 12, min: 0, description: `${probeNote} 2026-10-19 measured ~60 MB/s progressive.`,
    overrides: [{ matcher: { id: 'byRegexp', options: '.*file MB' }, properties: [{ id: 'custom.axisPlacement', value: 'right' }] }] }));

  // Playback plans, the home relay, captions and credits (2026-10-23 audit: all of these were counted but not shown).
  const ev = (metric, w = '6h') => `sum by (key) (increase(eiok_events_total{metric="${metric}"}[${w}]))`;
  p.push(row('Playback plans, home relay, captions'));
  p.push(series('Playback plans (per 6 h)', [[ev('adaptive').replace('}[', ',key=~"plan_.*|paced_off"}['), '{{key}}']], { w: 8, stack: true, min: 0,
    description: 'Which plan each video got (src/adaptive.js): plan_direct = 1080p at once, plan_adaptive = 720p then 1080p, plan_start = the 360p first rung, plan_lower = 720p only; paced_off = kept at 720p by the credit pacer.' }));
  p.push(series('Adaptive steps and Quest tickets (per 6 h)', [[ev('adaptive').replace('}[', ',key!~"plan_.*|paced_off"}['), '{{key}}']], { w: 8, min: 0,
    description: 'master = adaptive playlists served, upgrade / upgrade_served / upgrade_failed = 1080p step-ups started, played, failed; hls_ticket = .m3u8 tickets (the world’s Android build); android_progressive = Quest players sent progressive; defer = resolver told to wait. reload_after_upgrade / reload_before_upgrade = the same player loading the master again after / before it got 1080p: the freeze proxy (a freeze shows no error, so Play pressed again is the closest signal; compare the two).' }));
  p.push(series('Ticket requests by client (per 6 h)', [[ev('ticket_client'), '{{key}}']], { w: 8, stack: true, min: 0,
    description: 'string = the tablet’s status checks, ytdlp = VRChat’s resolver, avpro = the player. Per request, not per play.' }));
  p.push(stat('Home relay today', [
    ['max(eiok_home_today{key="mb"}) / 1000', 'GB'],
    ['max(eiok_home_today{key="cap_mb"}) / 1000', 'cap GB'],
    ['max(eiok_home_today{key="builds"})', 'videos'],
    ['max(eiok_home_today{key="workers"})', 'workers'],
    ['max(eiok_home_today{key="cache_mb"}) / 1000', 'from cache GB'],
  ], { w: 8, decimals: 1, thresholds: [{ color: INK, value: null }], description: 'What the Optiplex downloaded for home relay plays today (Chicago day) against HOME_DAILY_MB, what the worker uploaded from its own cache instead (not counted against the cap, relay/cache.js), and the media workers connected now. Set every minute by the search service.' }));
  p.push(series('Home relay (per 6 h)', [[ev('home'), '{{key}}'], [ev('home_why'), 'why: {{key}}']], { w: 8, min: 0,
    description: 'Sessions started / ready / failed / capped (refused by the daily cap) / timeout, and why a play went home (long video, Tunelio off or failed, the pacer).' }));
  p.push(series('Home relay start time', [
    ['histogram_quantile(0.5, sum by (le) (increase(eiok_home_start_seconds_bucket[6h])))', 'p50'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_home_start_seconds_bucket[6h])))', 'p95'],
  ], { w: 8, unit: 's', min: 0, description: 'Play → first playlist with a segment from the Optiplex, 6 h windows.' }));
  p.push(series('Credits spent per day, by use', [[ev('credits', '1d'), '{{key}}']], { w: 8, stack: true, min: 0,
    description: 'playback = /create for visitors, captions = transcripts, probe = the speed probe, test = test slot refills. Rolling 24 h.' }));
  p.push(series('Search sources (per 6 h)', [[ev('search_source'), '{{key}}'], ['max(eiok_youtube_api_units_today)', 'Data API units today']], { w: 8, stack: false, min: 0,
    description: 'worker = the Optiplex relay, local = InnerTube from the Linode, api = the YouTube Data API (quota).' }));
  p.push(series('Captions (per 6 h)', [
    ['sum by (metric) (increase(eiok_events_total{metric=~"cc_list|cc_track",key=""}[6h]))', '{{metric}}'],
    [ev('cc_via'), 'via {{key}}'], [ev('cc_words'), 'words {{key}}'], [ev('cc_unavailable'), 'unavailable: {{key}}'],
  ], { w: 8, min: 0, description: 'Track lists and tracks served, which source answered (worker, local yt-dlp, Tunelio), word timing real or estimated, and why none was available.' }));
  p.push(series('YouTube refusals (per hour)', [[ev('yt_refusal', '1h'), '{{key}}']], { w: 8, stack: true, min: 0,
    description: 'Failed YouTube lookups by where (home = the Optiplex relay, linode, flash = the Optiplex flash-check worker) and class: bot = "Sign in to confirm", rate = 429 / try again later / a caption track that failed after its list, forbidden = 403, potoken = PO token, other. Counted from 2026-10-25 (src/refusal.js).' }));
  p.push(series('Rooms active (shards with a request, per hour)', [
    ['count(increase(eiok_shard_active_hours_total[1h]) > 0) or vector(0)', 'rooms'],
  ], { w: 8, min: 0, decimals: 0, description: 'Distinct shards that saw a request in the past hour (from the hourly shard table).' }));
  p.push(series('Plays by platform (per 6 h)', [[ev('play_platform'), '{{key}}']], { w: 8, stack: true, min: 0,
    description: 'Once per room and platform (a room with PC and Quest players counts one of each), from the player’s User-Agent or a .m3u8 ticket. Counted from 2026-10-23.' }));
  p.push(series('Room quality picks and tablet warm-ups (per 6 h)', [[ev('quality_pick'), 'pick {{key}}'],
    ['sum(increase(eiok_events_total{metric="warm"}[6h]))', 'warm builds'], ['sum(increase(eiok_events_total{metric="warm_played"}[6h]))', 'warm then played']], { w: 8, min: 0 }));

  p.push(row('Channels and flash checks'));
  p.push({
    type: 'table', id: ++id, title: 'Slots', datasource: DS, gridPos: place(14, 12),
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
  p.push(series('Flash checks (per 6 h)', [['sum by (verdict) (increase(eiok_flash_checks_total[6h]))', '{{verdict}}']], { w: 10, h: 6, stack: true }));
  p.push(series('Check queue', [
    ['max(eiok_jobs_pending)', 'waiting'],
    ['max by (reason) (eiok_jobs_oldest_pending_seconds) / 60', 'oldest {{reason}} (min)'],
  ], { w: 10, h: 6, min: 0 }));

  p.push(row('Hosts'));
  p.push(series('CPU busy', [['1 - avg by (host) (rate(node_cpu_seconds_total{mode="idle"}[5m]))', '{{host}}']], { w: 8, unit: 'percentunit', min: 0 }));
  p.push(series('Memory available', [['max by (host) (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)', '{{host}}']], { w: 8, unit: 'percentunit', min: 0 }));
  p.push(series('Disk free (/)', [['max by (host) (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})', '{{host}}']], { w: 8, unit: 'percentunit', min: 0 }));
  p.push(series('Public endpoints', [['max by (job) (probe_success)', '{{job}}'], ['max by (job) (probe_duration_seconds)', '{{job}} seconds']], { w: 12 }));
  p.push(series('Failed units', [['sum by (host, name) (node_systemd_unit_state{state="failed"}) > 0', '{{host}} {{name}}']], { w: 12, description: 'japharsworld-yt units, bgutil-pot and caddy in the failed state.' }));

  p.push(row('Versions and deploys'));
  // A band per world version over time (the polled version number), so uploads read as a timeline.
  p.push({
    type: 'state-timeline', id: ++id, title: 'World version over time', datasource: DS, gridPos: place(24, 4),
    targets: targets([
      ['max(eiok_poll{source="world:prod",metric="version"})', 'production'],
      ['max(eiok_poll{source="world:test",metric="version"})', 'TEST'],
    ]),
    options: { showValue: 'always', mergeValues: true, rowHeight: 0.8, legend: { showLegend: false }, tooltip: { mode: 'single' } },
    fieldConfig: { defaults: { unit: 'prefix:v', decimals: 0, color: { mode: 'continuous-BlPu' }, custom: { fillOpacity: 70, lineWidth: 0 } }, overrides: [] },
  });
  p.push(versions('World uploads and releases', 'max by (source, version) (eiok_release_timestamp_seconds) * 1000', ['source', 'version'],
    'VRChat world versions (world:prod, world:test, at VRChat’s upload time) and GitHub release tags.'));
  p.push(versions('Deploys of main', 'max by (host, commit, outcome) (eiok_deploy_timestamp_seconds) * 1000', ['host', 'commit', 'outcome'],
    'Per host: the Linode (search service; no_restart = only files it does not run changed) and the Optiplex (relay worker). deploy/deploy-record.sh.'));

  return scoped({
    uid: DASH_UID, title: 'Everything is OK', tags: ['everything-is-ok'], timezone: 'America/Chicago', refresh: '5m',
    time: { from: 'now-2d', to: 'now' }, schemaVersion: 39, editable: true, graphTooltip: 1,
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
const OWN_TESTS = 'Includes the owner\'s own testing: the TEST world uses the same service and these counts can\'t tell them apart (most of 10-26\'s Channels plays were testing).';
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
// the whole panel, 2026-10-27), so a fixed grid keeps them one size. Dark when the language had none in the last 2 h,
// lit by count as people arrive (#248).
const LANG_CODES = ['en', 'fr', 'es', 'it', 'ko', 'de', 'ja', 'pl', 'ru', 'pt-BR', 'zh-CN', 'zh-HK', 'he', 'tok', 'uk', 'th'];
function squares(title, metric, { w = 12, h = 6, description } = {}) {
  const p = stat(title, LANG_CODES.map((l) => [`sum(round(increase(eiok_events_total{metric="${metric}",key="${l}"}[2h]))) or vector(0)`, l]), { w, h, decimals: 0, description,
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
    { w: 5, description: 'People in the production world now (VRChat, polled every ~15 min): 0 quiet, 1–3 cozy, 4 or more lively.',
      colors: { vibe: [{ color: NIGHT.quiet, value: null }, { color: NIGHT.amber, value: 1 }, { color: NIGHT.purple, value: 4 }], quiet: lit(NIGHT.quiet), cozy: lit(NIGHT.amber), lively: lit(NIGHT.purple) },
      mappings: [{ type: 'value', options: { 0: { text: 'quiet' } } }, { type: 'range', options: { from: 1, to: 3, result: { text: 'cozy' } } }, { type: 'range', options: { from: 4, to: 1e6, result: { text: 'lively' } } }] }));
  p.push(stat('People here', [[occ('publicOccupants'), 'public'], [occ('privateOccupants'), 'private']], { w: 5, thresholds: tile(NIGHT.blue),
    description: 'Production world occupants by instance type (VRChat\'s counts, polled every ~15 min).' }));
  p.push(stat('Rooms', [[occ('instances'), 'instances'], ['count(increase(eiok_shard_active_hours_total[1h]) > 0) or vector(0)', 'tablets in use, last hour']], { w: 4, thresholds: tile(NIGHT.purple),
    description: `Instances of the production world (VRChat), and the tablet shards that made any request in the last hour (hourly rows). ${OWN_TESTS}` }));
  p.push(stat('Warmth, this range', [[`${occ('visits')} - min(min_over_time(eiok_poll{source="world:prod",metric="visits"}[$__range]))`, 'new visits'],
    [`${occ('favorites')} - min(min_over_time(eiok_poll{source="world:prod",metric="favorites"}[$__range]))`, 'new favorites']], { w: 4, decimals: 0, thresholds: tile(NIGHT.green),
    description: 'Growth of the production world\'s visit and favorite totals over the selected time range (VRChat\'s public numbers; unfavorites net out).' }));

  // VRChat's world heat (its trending flames; the owner believes 7 is the top, unconfirmed): seven flame slots, lit up to
  // the heat (Canvas can't repeat an element by value), Tokyo Night orange, the rest dim. Above 7 the number shows
  // beside them (transparent until then), so a higher ceiling is never hidden.
  const SLOTS = 7, SPAN = 86;
  p.push(canvas('Heat', [...Array.from({ length: SLOTS }, (_, k) => [`${occ('heat')} >= bool ${k + 1}`, `flame${k + 1}`]), [occ('heat'), 'heat']],
    [...Array.from({ length: SLOTS }, (_, k) => icon(`flame${k + 1}`, 'flame', `flame${k + 1}`, [1 + k * (SPAN / SLOTS), 99 - 1 - (k + 1) * (SPAN / SLOTS), 10, 10])),
      label('over', 'heat', 28, [SPAN + 1, 1, 10, 10])],
    { w: 6, description: 'VRChat\'s heat for the production world (the flames on its world page), polled every ~15 min: one lit flame per point, up to 7; above 7 the number shows beside them.',
      colors: { ...Object.fromEntries(Array.from({ length: SLOTS }, (_, k) => [`flame${k + 1}`, [{ color: NIGHT.dim, value: null }, { color: NIGHT.orange, value: 1 }]])),
        heat: [{ color: 'transparent', value: null }, { color: NIGHT.orange, value: SLOTS + 1 }] } }));

  p.push(row('What\'s on'));
  p.push(bars('Plays by length', [[inRange('play_length', 'lt10m'), 'under 10 min'], [inRange('play_length', 'lt1h'), '10 min – 1 h'], [inRange('play_length', 'lt3h'), '1–3 h'],
    [inRange('play_length', 'longer'), '3 h+ (sleep)'], [inRange('play_length', 'live'), 'live']], { description: `Search videos played, once per room, by length, over the time range. ${OWN_TESTS}` }));
  p.push(bars('Channels and searches', [[inRange('channel', 'redirect'), 'Channels'], [inRange('search', ''), 'searches'], [inRange('play', ''), 'plays']],
    { description: `Channels: a slot opened from the Channels tab. Searches with a query, and videos played once per room, over the time range. ${OWN_TESTS}` }));
  p.push(bars('Captions and quality', [[inRange('cc_list', ''), 'captions shown'], [inRange('cc_track', ''), 'tracks picked'], [inRange('quality_pick', '1080p'), '1080p picked'], [inRange('quality_pick', '720p'), '720p picked']],
    { description: `"Show captions" list loads and tracks picked on the tablet, and rooms that picked a playback quality, over the time range. ${OWN_TESTS}` }));

  p.push(row('Who, broadly'));
  // Joins, not presence: a square lights as people of that language arrive and goes dark 2 h after the last one. A quarter
  // of the width each (owner, #248), so the 16 squares sit 4 × 4.
  p.push(squares('Here lately', 'join_lang', { w: 6, h: 10, description: 'All 16 VRChat client languages; a square lights up when that language had joins in the last 2 hours (whatever the time range), from visitors who allow untrusted URLs: the bare search address the world loads once after join. It counts arrivals, not who is still here, so a square stays lit for 2 h after its last join. Dark: none; 1 join grey; 2–3 blue; 4 or more purple.' }));
  p.push(squares('Search languages', 'search_lang', { w: 6, h: 10, description: `The same squares for searches with a query in the last 2 hours, by VRChat client language. ${OWN_TESTS}` }));
  p.push(bars('Quest and PC', [[inRange('play_platform', 'pc'), 'PC plays'], [inRange('play_platform', 'android'), 'Quest plays'], [inRange('join', ''), 'joins']],
    { w: 12, h: 10, description: `Plays by player platform, once per room and platform, and joins that loaded the search address (untrusted URLs allowed), over the time range. ${OWN_TESTS}` }));

  p.push(row('The night\'s shape'));
  const curve = series('Through the night (Chicago time)', [[occ('publicOccupants'), 'public'], [occ('privateOccupants'), 'private']], { w: 18, h: 9, stack: true, min: 0, decimals: 0,
    description: 'Production world occupants, stacked by instance type, in America/Chicago time.' });
  curve.fieldConfig.defaults.color = { mode: 'continuous-BlPu' };
  curve.fieldConfig.defaults.custom.lineInterpolation = 'smooth';
  p.push(curve);
  // The most people at any 15-minute step of the last 24 h whose Chicago hour was 3–5.
  const lateExpr = `max_over_time((max(eiok_poll{source="world:prod",metric="occupants"}) and on() (${CHICAGO_HOUR} >= 3) and on() (${CHICAGO_HOUR} < 6))[24h:15m]) or vector(0)`;
  p.push(canvas('Stayed past 03:00', [[lateExpr, 'late']], [icon('zzz', 'zzz', 'late', [6, 52, 14, 14]), label('count', 'late', 64, [46, 4, 10, 10])],
    { w: 6, h: 9, description: 'The most people in the world between 03:00 and 06:00 Chicago time (summer and winter time alike) in the last 24 h. Do people sleep here?',
      colors: { late: [{ color: NIGHT.dim, value: null }, { color: NIGHT.blue, value: 1 }] }, mappings: [{ type: 'value', options: { 0: { text: 'no one' } } }] }));

  return scoped({
    uid: TONIGHT_UID, title: 'Everything is OK · Tonight', tags: ['everything-is-ok'], timezone: 'America/Chicago', refresh: '1m',
    time: { from: 'now-12h', to: 'now' }, schemaVersion: 39, editable: true, graphTooltip: 1,
    description: 'The vibe right now: counts only (world #248). Ops stay on the Everything is OK dashboard.',
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
    // Owner, 2026-10-26: the flash worker's YouTube refusals (metrics/exporter.js, yt_refusal flash:<class>), which the
    // search service's own refusal alert (src/refusal.js, the relay worker's) never sees. As there: 3 or more bot, rate,
    // PO-token or 403 refusals, here within 30 minutes (the worker runs every 20).
    rule('eiok-flash-refusals', 'Flash checks refused by YouTube', 'sum(increase(eiok_events_total{metric="yt_refusal",key=~"flash:(bot|rate|potoken|forbidden)"}[30m])) - 2', { forM: 0, summary: 'The Optiplex flash-check worker met 3 or more YouTube refusals (bot wall, rate limit, PO token or 403) in 30 minutes: the home IP may be flagged, which hits the relay worker too. Check `journalctl -u japharsworld-yt-slotworker` on the Optiplex.' }),
    rule('eiok-checks-waiting', 'Flash checks waiting', 'max(eiok_jobs_oldest_pending_seconds{reason="other"}) > 7200 or max(eiok_jobs_oldest_pending_seconds{reason="daily"}) > 18000', { summary: 'A new/candidate/manual resolution or flash job has waited over 2 hours, or the daily batch over 5 hours; the Optiplex worker runs every 20 minutes, 6 jobs a run.' }),
    // Owner, 2026-10-23 (the dashboard audit): the home relay's cap and worker, and the credits lasting to renewal.
    rule('eiok-home-cap', 'Home relay near its daily cap', 'max(eiok_home_today{key="mb"}) / max(eiok_home_today{key="cap_mb"}) >= 0.9', { forM: 5, summary: 'The home relay has used 90 % of HOME_DAILY_MB today; at the cap, long videos go to Tunelio (credits) or youtube.com instead.' }),
    rule('eiok-home-worker', 'Home relay has no worker', '1 - max(eiok_home_today{key="workers"})', { forM: 15, summary: 'No media worker (the Optiplex relay) connected for 15 minutes: home relay plays fall back to Tunelio or youtube.com.' }),
    // Renewal on the 1st (TUNELIO_RENEWS_DAY's default): the last 3 days' spend per day times the days left, minus the credits left.
    rule('eiok-credits-pace', 'Credits run out before renewal', '(sum(increase(eiok_events_total{metric="credits"}[3d])) / 3) * (days_in_month() - day_of_month() + 1) - max(eiok_credits_remaining) > 0', { forM: 60, summary: 'At the last 3 days’ spend, the Tunelio credits run out before the plan renews on the 1st (the pacer then keeps plays at 720p; at 0 they go to youtube.com).' }),
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

const cmd = process.argv[2];
if (cmd === 'build') {
  mkdirSync('grafana', { recursive: true });
  writeFileSync('grafana/dashboard.json', `${JSON.stringify(dashboard(), null, 1)}\n`);
  writeFileSync('grafana/tonight.json', `${JSON.stringify(tonight(), null, 1)}\n`);
  writeFileSync('grafana/alert-rules.json', `${JSON.stringify(alertRules('${ds}', { critical: true }), null, 1)}\n`);
  console.log('wrote grafana/dashboard.json, grafana/tonight.json, grafana/alert-rules.json');
} else if (cmd === 'push') {
  push().catch((err) => { console.error(err.message); process.exitCode = 1; });
} else if (cmd) {
  console.error('usage: node tools/grafana.mjs build|push');
  process.exit(2);
}
