import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertRules } from '../tools/grafana.mjs';

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
