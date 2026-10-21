// Grafana Cloud dashboard and alert rules for Everything is OK (claude/monitoring.md), kept in the repo.
//   node tools/grafana.mjs build    writes grafana/dashboard.json and grafana/alert-rules.json
//   node tools/grafana.mjs push     uploads both to the stack (and the Discord contact point)
// push reads its settings from the environment or the repo's .env (gitignored; the environment wins):
//   GRAFANA_URL               https://<stack>.grafana.net
//   GRAFANA_SA_TOKEN          a service account token (glsa_…, Editor role); not GRAFANA_TOKEN, Alloy's write-only token
//   GRAFANA_DISCORD_WEBHOOK   where the alerts go (the contact point). Change it and push again to move them.
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
const FOLDER = { uid: 'everything-is-ok', title: 'Everything is OK' };
const RECEIVER = 'Everything is OK Discord';

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

function stat(title, expr, { unit = 'short', w = 4, thresholds, decimals, mappings, description } = {}) {
  return {
    type: 'stat', id: ++id, title, description, datasource: DS, gridPos: place(w, 4), targets: targets([[expr, '', { instant: true }]]),
    options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'background', graphMode: 'none', textMode: 'value' },
    fieldConfig: { defaults: { unit, decimals, mappings: mappings ?? [], thresholds: { mode: 'absolute', steps: thresholds ?? [{ color: 'blue', value: null }] } }, overrides: [] },
  };
}
function series(title, list, { unit = 'short', w = 12, h = 8, stack = false, description, min } = {}) {
  return {
    type: 'timeseries', id: ++id, title, description, datasource: DS, gridPos: place(w, h), targets: targets(list),
    options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    fieldConfig: { defaults: { unit, min, custom: { lineWidth: 2, fillOpacity: stack ? 30 : 8, stacking: { mode: stack ? 'normal' : 'none' } } }, overrides: [] },
  };
}
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
  p.push(stat('Oldest waiting check', 'max(eiok_jobs_oldest_pending_seconds)', { w: 3, unit: 's', thresholds: [{ color: OK, value: null }, { color: WARN, value: 3600 }, { color: BAD, value: 7200 }], description: 'Resolution + flash jobs wait for the Optiplex worker (every 20 min).' }));

  p.push(row('Visitors and search'));
  p.push(series('Searches, plays, joins (per hour)', [
    ['sum by (metric) (increase(eiok_events_total{metric=~"search|play|join|more",key=""}[1h]))', '{{metric}}'],
  ], { w: 12 }));
  p.push(series('VRChat (production)', [
    ['max(eiok_poll{source="world:prod",metric="occupants"})', 'in world'],
    ['max(eiok_poll{source="group",metric="online"})', 'group online'],
  ], { w: 12, min: 0 }));
  p.push(series('Search latency', [
    ['histogram_quantile(0.5, sum by (le) (increase(eiok_search_seconds_bucket[3h])))', 'p50'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_search_seconds_bucket[3h])))', 'p95'],
  ], { w: 8, unit: 's', description: 'From the daily buckets, over 3 h windows.' }));
  p.push(series('Search failure rate', [
    ['sum(increase(eiok_events_total{metric="search_fail"}[3h])) / clamp_min(sum(increase(eiok_events_total{metric="search",key=""}[3h])) + sum(increase(eiok_events_total{metric="search_fail"}[3h])), 1)', 'failures'],
  ], { w: 8, unit: 'percentunit', min: 0 }));
  p.push(series('Play routes (per 3 h)', [
    ['sum by (key) (increase(eiok_events_total{metric="play_route"}[3h]))', '{{key}}'],
  ], { w: 8, stack: true }));
  p.push(series('Tunelio credits left', [['max(eiok_credits_remaining)', 'left']], { w: 12, min: 0 }));
  p.push(series('Tunelio build time', [
    ['histogram_quantile(0.5, sum by (le) (increase(eiok_build_progressive_seconds_bucket[6h])))', 'progressive p50'],
    ['histogram_quantile(0.95, sum by (le) (increase(eiok_build_progressive_seconds_bucket[6h])))', 'progressive p95'],
  ], { w: 12, unit: 's' }));

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
    ['max(eiok_jobs_oldest_pending_seconds) / 60', 'oldest (min)'],
  ], { w: 10, h: 6, min: 0 }));

  p.push(row('Hosts'));
  p.push(series('CPU busy', [['1 - avg by (host) (rate(node_cpu_seconds_total{mode="idle"}[5m]))', '{{host}}']], { w: 8, unit: 'percentunit', min: 0 }));
  p.push(series('Memory available', [['max by (host) (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)', '{{host}}']], { w: 8, unit: 'percentunit', min: 0 }));
  p.push(series('Disk free (/)', [['max by (host) (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})', '{{host}}']], { w: 8, unit: 'percentunit', min: 0 }));
  p.push(series('Public endpoints', [['max by (job) (probe_success)', '{{job}}'], ['max by (job) (probe_duration_seconds)', '{{job}} seconds']], { w: 12 }));
  p.push(series('Failed units', [['sum by (host, name) (node_systemd_unit_state{state="failed"}) > 0', '{{host}} {{name}}']], { w: 12, description: 'japharsworld-yt units, bgutil-pot and caddy in the failed state.' }));

  return {
    uid: DASH_UID, title: 'Everything is OK', tags: ['everything-is-ok'], timezone: 'America/Chicago', refresh: '5m',
    time: { from: 'now-2d', to: 'now' }, schemaVersion: 39, editable: true, graphTooltip: 1,
    templating: { list: [{ name: 'ds', label: 'Data source', type: 'datasource', query: 'prometheus', regex: '.*-prom$', current: {} }] },
    panels: p,
  };
}

// Alerts for what the services can't report about themselves (they already alert Discord on their own problems).
export function alertRules(dsUid) {
  const rule = (uid, title, expr, { forM = 5, summary, noData = 'OK' }) => ({
    uid, title, folderUID: FOLDER.uid, ruleGroup: 'everything-is-ok', condition: 'C', for: `${forM}m`, noDataState: noData, execErrState: 'Error',
    annotations: { summary }, labels: { project: 'everything-is-ok' }, notification_settings: { receiver: RECEIVER },
    data: [
      { refId: 'A', relativeTimeRange: { from: 900, to: 0 }, datasourceUid: dsUid, model: { refId: 'A', expr, instant: true } },
      { refId: 'C', datasourceUid: '__expr__', model: { refId: 'C', type: 'threshold', expression: 'A', conditions: [{ evaluator: { type: 'gt', params: [0] } }] } },
    ],
  });
  return [
    rule('eiok-linode-silent', 'Linode sends nothing', 'absent_over_time(eiok_search_up{host="linode"}[10m])', { summary: 'No metrics from the Linode for 10 minutes: the server, Alloy or the exporter is down.' }),
    rule('eiok-optiplex-silent', 'Optiplex sends nothing', 'absent_over_time(node_time_seconds{host="optiplex"}[15m])', { summary: 'No metrics from the Optiplex for 15 minutes: searches fall back and flash checks wait.' }),
    rule('eiok-search-down', 'Search service down', 'max_over_time(eiok_search_up[5m]) < 1', { summary: 'The search service has not answered /healthz on the Linode for 5 minutes.' }),
    rule('eiok-public-down', 'yt.japharsworld.com unreachable', 'max_over_time(probe_success{job=~".*search-healthz.*"}[10m]) < 1', { forM: 5, summary: 'https://yt.japharsworld.com/healthz failed from outside for 10 minutes (Caddy, TLS or DNS).' }),
    rule('eiok-checks-waiting', 'Flash checks waiting', 'max(eiok_jobs_oldest_pending_seconds) > 7200', { summary: 'A resolution/flash job has waited over 2 hours; the Optiplex worker runs every 20 minutes.' }),
    rule('eiok-disk-low', 'Disk almost full', 'max by (host) (1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) > 0.9', { forM: 15, summary: 'Under 10 % free on / of {{ $labels.host }}.' }),
  ];
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

  if (env.GRAFANA_DISCORD_WEBHOOK) {
    const points = await api('/api/v1/provisioning/contact-points');
    const cp = { name: RECEIVER, type: 'discord', settings: { url: env.GRAFANA_DISCORD_WEBHOOK, use_discord_username: false }, disableResolveMessage: false };
    const existing = points.find((c) => c.name === RECEIVER);
    if (existing) await api(`/api/v1/provisioning/contact-points/${existing.uid}`, { method: 'PUT', body: { ...cp, uid: existing.uid } });
    else await api('/api/v1/provisioning/contact-points', { method: 'POST', body: cp });
    console.log(`contact point: ${RECEIVER}`);
  } else if (!(await api('/api/v1/provisioning/contact-points')).some((c) => c.name === RECEIVER)) {
    throw new Error('set GRAFANA_DISCORD_WEBHOOK the first time (the alert rules send to it)');
  }
  for (const r of alertRules(prom.uid)) {
    try { await api(`/api/v1/provisioning/alert-rules/${r.uid}`, { method: 'PUT', body: r }); } catch (err) {
      if (err.status !== 404) throw err;
      await api('/api/v1/provisioning/alert-rules', { method: 'POST', body: r });
    }
    console.log(`alert: ${r.title}`);
  }
}

const cmd = process.argv[2];
if (cmd === 'build') {
  mkdirSync('grafana', { recursive: true });
  writeFileSync('grafana/dashboard.json', `${JSON.stringify(dashboard(), null, 1)}\n`);
  writeFileSync('grafana/alert-rules.json', `${JSON.stringify(alertRules('${ds}'), null, 1)}\n`);
  console.log('wrote grafana/dashboard.json, grafana/alert-rules.json');
} else if (cmd === 'push') {
  push().catch((err) => { console.error(err.message); process.exitCode = 1; });
} else if (cmd) {
  console.error('usage: node tools/grafana.mjs build|push');
  process.exit(2);
}
