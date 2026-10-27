import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHICAGO_HOUR, alertRules, contactPoint, dashboard, prodOnly, tonight } from '../tools/grafana.mjs';

// Staging (#160) sends the same metrics with env="staging": every selector of every query and rule leaves them out.
test('every dashboard query and alert rule excludes staging', () => {
  assert.equal(prodOnly('1 - max_over_time(eiok_search_up[5m])'), '1 - max_over_time(eiok_search_up{env!="staging"}[5m])');
  assert.equal(prodOnly('sum(eiok_slot_hidden * on(slot) (1 - eiok_slot_spare))'), 'sum(eiok_slot_hidden{env!="staging"} * on(slot) (1 - eiok_slot_spare{env!="staging"}))');
  assert.equal(prodOnly('max(node_time_seconds{host="optiplex"})'), 'max(node_time_seconds{env!="staging",host="optiplex"})');
  assert.equal(prodOnly('x{source="domain:eiok.cc"}'), 'x{source="domain:eiok.cc"}', 'label values are left alone');
  const exprs = [];
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) (k === 'expr' && typeof v === 'string' ? exprs.push(v) : walk(v)); };
  walk(dashboard()); walk(tonight()); walk(alertRules('ds'));
  assert.ok(exprs.length > 50, `${exprs.length} expressions`);
  for (const e of exprs) {
    for (const m of e.matchAll(/\b(?:eiok|probe|node)_[A-Za-z0-9_]+(\{[^}]*\})?/g)) assert.match(m[1] ?? '', /^\{env!="staging"/, e);
  }
});

// The owner is pinged on firing critical alerts only (2026-10-26); the ID comes from the local .env.
test('contact point: the mention only with an ID, only for firing critical alerts', () => {
  assert.equal(contactPoint('https://hook', undefined).settings.message, undefined, 'no ID: Grafana\'s default text');
  const m = contactPoint('https://hook', '123456789012').settings.message;
  assert.match(m, /range \.Alerts\.Firing/);
  assert.match(m, /eq \.Labels\.severity "critical"/);
  assert.match(m, /\{\{ if \$critical \}\}<@123456789012> \{\{ end \}\}\{\{ template "default\.message" \. \}\}$/);
  assert.throws(() => contactPoint('https://hook', '<@123>'), /user ID/);
  // The search service being down wakes the triage and the mention (owner, 2026-10-26).
  const sev = Object.fromEntries(alertRules('ds').map((r) => [r.uid, r.labels.severity]));
  for (const uid of ['eiok-search-down', 'eiok-public-down', 'eiok-short-down']) assert.equal(sev[uid], 'critical', uid);
  assert.equal(sev['eiok-linode-disk-70'], 'warning');
});

// Critical alerts in their own channel (world #195, owner 2026-10-26); without DISCORD_CRITICAL_WEBHOOK all go to one.
test('alert rules: critical ones go to the critical contact point when it is set, warnings stay', () => {
  const to = (o) => Object.fromEntries(alertRules('ds', o).map((r) => [r.uid, r.notification_settings.receiver]));
  const split = to({ critical: true });
  for (const uid of ['eiok-search-down', 'eiok-public-down', 'eiok-ssh-unknown-login', 'eiok-security-change', 'eiok-sshd-not-hardened', 'eiok-linode-disk-80']) {
    assert.equal(split[uid], 'Everything is OK Discord critical', uid);
  }
  assert.equal(split['eiok-linode-disk-70'], 'Everything is OK Discord');
  // The owner's answer (#246): the mass outage and the 7-day domain alert are plain warnings (no ping, no triage).
  assert.equal(split['eiok-channels-mass-down'], 'Everything is OK Discord');
  const sev = Object.fromEntries(alertRules('ds').map((r) => [r.uid, r.labels.severity]));
  assert.equal(sev['eiok-channels-mass-down'], 'warning');
  assert.equal(sev['eiok-domain-expiry-urgent'], 'warning');
  assert.equal(split['eiok-domain-expiry-urgent'], 'Everything is OK Discord');
  assert.equal(sev['eiok-domain-expiry-critical'], 'critical');
  assert.equal(split['eiok-domain-expiry-critical'], 'Everything is OK Discord critical', 'the last 48 hours: the critical channel');
  assert.deepEqual(new Set(Object.values(to())), new Set(['Everything is OK Discord']), 'unset: one channel, as before');
  assert.equal(contactPoint('https://hook', '123456789012', 'Everything is OK Discord critical').name, 'Everything is OK Discord critical');
});

// Every rule's condition is "A > 0" (tools/grafana.mjs rule()), so an expression must be positive when it fires. A
// trailing "< n" filter keeps the series but leaves its value at or under n (0 for "up < 1": never fired, 2026-10-26).
test('alert rules: every expression is positive when it fires (no trailing < or == filter)', () => {
  const rules = alertRules('ds');
  assert.ok(rules.length > 20);
  for (const r of rules) {
    const expr = r.data[0].model.expr;
    assert.doesNotMatch(expr, /(<=?|==)\s*-?[\d.e]+\s*$/, `${r.uid}: ${expr}`);
    assert.equal(r.data[1].model.conditions[0].evaluator.type, 'gt');
    assert.deepEqual(r.data[1].model.conditions[0].evaluator.params, [0]);
    // With noData = Alerting a filter ("> 600") empties the result when healthy, and the rule fires then
    // (2026-10-26: "security counters stale" fired while they were 60 s old). The value itself must carry it.
    if (r.noDataState === 'Alerting') assert.doesNotMatch(expr, /(>=?|<=?|==|!=)\s*-?[\d.e*\s]+$/, `${r.uid}: ${expr}`);
  }
});

// World #248: the "Tonight" board, its own dashboard, soft colours, counts only.
test('tonight: its own dashboard, refresh 1 min, the last 12 h in Chicago time, no alarm red', () => {
  const d = tonight();
  assert.equal(d.uid, 'everything-is-ok-tonight');
  assert.notEqual(d.uid, dashboard().uid);
  assert.deepEqual([d.refresh, d.time.from, d.timezone], ['1m', 'now-12h', 'America/Chicago']);
  const text = JSON.stringify(d);
  assert.doesNotMatch(text, /#f7768e|"red"/i, 'no red');
  const ids = d.panels.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const vibe = d.panels.find((p) => p.title === 'The vibe');
  assert.deepEqual(vibe.fieldConfig.defaults.mappings.map((m) => m.type), ['value', 'range', 'range'], 'quiet 0, cozy 1-3, lively 4+');
  // Only the existing aggregates: events_total keys, the VRChat poll, the hourly shard rows.
  for (const m of text.matchAll(/(eiok_[a-z_]+)/g)) assert.ok(['eiok_events_total', 'eiok_poll', 'eiok_shard_active_hours_total'].includes(m[1]), m[1]);
});

// PromQL knows only UTC: "Stayed past 03:00" computes Chicago's hour with the US summer-time rule (#248). The same rule
// in JS, against Intl's America/Chicago, at every hour that can fall in the window (UTC 08–12) for two years.
test('tonight: Chicago hour follows summer and winter time (the 03:00–06:00 window)', () => {
  const late = tonight().panels.find((p) => p.title === 'Stayed past 03:00');
  assert.ok(late.targets[0].expr.includes('>= 3') && late.targets[0].expr.includes('< 6'));
  assert.match(CHICAGO_HOUR, /month\(\) == 3 and \(day_of_month\(\) - day_of_week\(\)\) >= 8/);
  assert.match(CHICAGO_HOUR, /month\(\) == 11 and \(day_of_month\(\) - day_of_week\(\)\) <= 0/);
  const promql = (d) => {
    const m = d.getUTCMonth() + 1, sunday = d.getUTCDate() - d.getUTCDay();
    const dst = (m > 3 && m < 11) || (m === 3 && sunday >= 8) || (m === 11 && sunday <= 0);
    return (d.getUTCHours() + 18 + (dst ? 1 : 0)) % 24;
  };
  const real = (d) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(d));
  for (let t = Date.UTC(2026, 0, 1, 8); t < Date.UTC(2028, 0, 1); t += 3600_000) {
    const d = new Date(t);
    if (d.getUTCHours() < 8 || d.getUTCHours() > 12) continue;
    assert.equal(promql(d), real(d), d.toISOString());
  }
});

// #248 round 2: heat as flames with its line; one square per join language of the last 2 h.
test('tonight: heat shows as that many flames, and join languages as squares coloured by count', () => {
  const d = tonight();
  const heat = d.panels.find((p) => p.title === 'Heat');
  assert.match(heat.targets[0].expr, /metric="heat"/);
  assert.equal(heat.targets[0].range, true);
  assert.equal(heat.options.graphMode, 'area');
  assert.equal(heat.fieldConfig.defaults.mappings[0].options[4].text, '🔥🔥🔥🔥');
  // A fixed grid of all 16 languages (Grafana stretches a lone tile), dark when none, lit by count.
  for (const [title, metric] of [['Here lately', 'join_lang'], ['Search languages', 'search_lang']]) {
    const sq = d.panels.find((p) => p.title === title);
    assert.equal(sq.targets.length, 16, title);
    assert.deepEqual(sq.targets.map((x) => x.legendFormat).slice(0, 3), ['en', 'fr', 'es']);
    for (const x of sq.targets) assert.ok(x.expr.includes(`metric="${metric}",key="${x.legendFormat}"}[2h]`) && x.expr.endsWith('or vector(0)'), x.expr);
    assert.equal(sq.options.textMode, 'name');
    assert.equal(sq.options.colorMode, 'background_solid');
    assert.deepEqual(sq.fieldConfig.defaults.thresholds.steps.map((x) => [x.color, x.value]), [['#24283b', null], ['#414868', 1], ['#7aa2f7', 2], ['#bb9af7', 4]]);
  }
  assert.match(d.panels.find((p) => p.title === 'Here lately').description, /arrivals, not who is still here/);
  assert.equal(heat.options.text.valueSize, 64, 'the flames are the biggest thing in the tile');
  assert.ok(d.panels.some((p) => p.title === 'Search languages'));
});
