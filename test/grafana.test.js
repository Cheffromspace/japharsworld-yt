import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertRules, contactPoint, dashboard, prodOnly } from '../tools/grafana.mjs';

// Staging (#160) sends the same metrics with env="staging": every selector of every query and rule leaves them out.
test('every dashboard query and alert rule excludes staging', () => {
  assert.equal(prodOnly('1 - max_over_time(eiok_search_up[5m])'), '1 - max_over_time(eiok_search_up{env!="staging"}[5m])');
  assert.equal(prodOnly('sum(eiok_slot_hidden * on(slot) (1 - eiok_slot_spare))'), 'sum(eiok_slot_hidden{env!="staging"} * on(slot) (1 - eiok_slot_spare{env!="staging"}))');
  assert.equal(prodOnly('max(node_time_seconds{host="optiplex"})'), 'max(node_time_seconds{env!="staging",host="optiplex"})');
  assert.equal(prodOnly('x{source="domain:eiok.cc"}'), 'x{source="domain:eiok.cc"}', 'label values are left alone');
  const exprs = [];
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) (k === 'expr' && typeof v === 'string' ? exprs.push(v) : walk(v)); };
  walk(dashboard()); walk(alertRules('ds'));
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
