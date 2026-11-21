// A small PromQL subset for the alert-rule tests (Everything-is-OK#967): enough to evaluate the expressions that
// tools/grafana.mjs writes over made-up series, so a rule's test runs its real expression rather than matching its text.
// Supported: selectors with = != =~ !~ (a missing label reads as ""), [range] with s/m/h/d, number literals, time(),
// sum/max/min/count with by (...) before or after, increase, max_over_time, count_over_time, absent, absent_over_time,
// subqueries (expr)[range:step] at the multiples of step, as Prometheus aligns them,
// + - * / and the comparisons (as filters, no bool), and/unless/or with an optional on (...).
// Not Prometheus: increase() is the plain rise inside the range (counter resets handled, no extrapolation to the edges),
// which is at most Prometheus' value, so a test that fires here fires there; instant selectors look back 5 minutes.
// Series: [{ labels: { __name__, ...}, samples: [[unixSeconds, value], ...] }] in time order.

const LOOKBACK = 300;
const UNIT = { s: 1, m: 60, h: 3600, d: 86400 };

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d+)?(?:e\d+)?)|("(?:[^"\\]|\\.)*")|(\[\d+[smhd](?::\d+[smhd])?\])|(=~|!~|!=|>=|<=|==|[-+*/(){},=<>])|([A-Za-z_:][A-Za-z0-9_:]*))/y;
  const dur = (d) => Number(d.slice(0, -1)) * UNIT[d.slice(-1)];
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    if (/^\s*$/.test(src.slice(at))) break;
    if (!(m = re.exec(src))) throw new Error(`promql-lite: can't read "${src.slice(at, at + 20)}"`);
    if (m[1]) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2]) out.push({ t: 'str', v: JSON.parse(m[2]) });
    else if (m[3]) { const [r, step] = m[3].slice(1, -1).split(':'); out.push({ t: 'range', v: dur(r), step: step ? dur(step) : null }); }
    else if (m[4]) out.push({ t: 'op', v: m[4] });
    else out.push({ t: 'id', v: m[5] });
  }
  return out;
}

const AGG = new Set(['sum', 'max', 'min', 'count']);
const PREC = [['or'], ['and', 'unless'], ['==', '!=', '>', '<', '>=', '<='], ['+', '-'], ['*', '/']];

function parse(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v) => peek() && (peek().t === 'op' || peek().t === 'id') && peek().v === v;
  const eat = (v) => { if (!isOp(v)) throw new Error(`promql-lite: expected ${v} at ${JSON.stringify(peek())} in ${src}`); i++; };
  const labelList = () => { eat('('); const ls = []; while (!isOp(')')) { ls.push(toks[i++].v); if (isOp(',')) i++; } eat(')'); return ls; };
  function binary(level) {
    if (level === PREC.length) return unary();
    let left = binary(level + 1);
    while (peek() && PREC[level].includes(peek().v) && (peek().t === 'op' || peek().t === 'id')) {
      const op = toks[i++].v;
      let on = null;
      if (isOp('on')) { i++; on = labelList(); }
      left = { k: 'bin', op, on, left, right: binary(level + 1) };
    }
    return left;
  }
  function unary() {
    if (isOp('-')) { i++; return { k: 'bin', op: '*', left: { k: 'num', v: -1 }, right: unary() }; }
    return primary();
  }
  function primary() {
    const tk = toks[i++];
    if (!tk) throw new Error(`promql-lite: unexpected end of ${src}`);
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'op' && tk.v === '(') {
      const e = binary(0); eat(')');
      // A subquery: (expr)[range:step], the expression at every multiple of step inside the range, as Prometheus does.
      if (peek()?.t === 'range' && peek().step) { const r = toks[i++]; return { k: 'subq', expr: e, range: r.v, step: r.step }; }
      return e;
    }
    if (tk.t !== 'id') throw new Error(`promql-lite: unexpected ${tk.v} in ${src}`);
    if (AGG.has(tk.v) && (isOp('(') || isOp('by'))) {
      let by = null;
      if (isOp('by')) { i++; by = labelList(); }
      eat('('); const arg = binary(0); eat(')');
      if (isOp('by')) { i++; by = labelList(); }
      return { k: 'agg', fn: tk.v, by, arg };
    }
    if (isOp('(')) {
      i++; const args = [];
      while (!isOp(')')) { args.push(binary(0)); if (isOp(',')) i++; }
      eat(')');
      return { k: 'call', fn: tk.v, args };
    }
    const matchers = [['__name__', '=', tk.v]];
    if (isOp('{')) {
      i++;
      while (!isOp('}')) { const name = toks[i++].v; const op = toks[i++].v; const val = toks[i++].v; matchers.push([name, op, val]); if (isOp(',')) i++; }
      eat('}');
    }
    const range = peek()?.t === 'range' ? toks[i++].v : null;
    return { k: 'sel', matchers, range };
  }
  const e = binary(0);
  if (i !== toks.length) throw new Error(`promql-lite: left over ${JSON.stringify(toks.slice(i))} in ${src}`);
  return e;
}

const matches = (labels, [name, op, val]) => {
  const v = labels[name] ?? '';
  if (op === '=') return v === val;
  if (op === '!=') return v !== val;
  const re = new RegExp(`^(?:${val})$`);
  return op === '=~' ? re.test(v) : !re.test(v);
};
const key = (labels, keep) => JSON.stringify(Object.entries(labels).filter(([k]) => k !== '__name__' && (!keep || keep.includes(k))).sort());
const dropName = (labels) => Object.fromEntries(Object.entries(labels).filter(([k]) => k !== '__name__'));

export function evaluate(src, series, top) {
  const ev = (n, at = top) => {
    switch (n.k) {
      case 'num': return { scalar: n.v };
      case 'sel': {
        const hit = series.filter((s) => n.matchers.every((m) => matches(s.labels, m)));
        if (n.range) return { matrix: hit.map((s) => ({ labels: s.labels, samples: s.samples.filter(([t]) => t > at - n.range && t <= at) })).filter((s) => s.samples.length) };
        return hit.map((s) => { const last = s.samples.filter(([t]) => t > at - LOOKBACK && t <= at).pop(); return last && { labels: s.labels, value: last[1] }; }).filter(Boolean);
      }
      case 'call': {
        if (n.fn === 'time') return { scalar: at };
        const a = ev(n.args[0], at);
        if (n.fn === 'increase') return a.matrix.filter((s) => s.samples.length >= 2).map((s) => {
          let rise = 0;
          for (let j = 1; j < s.samples.length; j++) { const d = s.samples[j][1] - s.samples[j - 1][1]; rise += d >= 0 ? d : s.samples[j][1]; }
          return { labels: dropName(s.labels), value: rise };
        });
        if (n.fn === 'count_over_time') return a.matrix.map((s) => ({ labels: dropName(s.labels), value: s.samples.length }));
        if (n.fn === 'max_over_time') return a.matrix.map((s) => ({ labels: dropName(s.labels), value: Math.max(...s.samples.map((x) => x[1])) }));
        if (n.fn === 'absent') return a.length ? [] : [{ labels: {}, value: 1 }];
        if (n.fn === 'absent_over_time') return a.matrix.length ? [] : [{ labels: {}, value: 1 }];
        throw new Error(`promql-lite: no function ${n.fn}`);
      }
      case 'subq': {
        // The range is left-open, (t - range, t], as in Prometheus 3 (and Mimir on its engine): an evaluation exactly on a
        // mark sees range/step points (12 half-hours in 6 h). Prometheus 2.x includes a point at t - range too, so it
        // sees one more there (13); that changes only how long a firing lasts at mark instants, and no test depends on it.
        const rows = new Map();
        for (let t = Math.floor(at / n.step) * n.step; t > at - n.range; t -= n.step) {
          for (const s of ev(n.expr, t)) { const k = key(s.labels); const r = rows.get(k) ?? { labels: s.labels, samples: [] }; r.samples.unshift([t, s.value]); rows.set(k, r); }
        }
        return { matrix: [...rows.values()] };
      }
      case 'agg': {
        const v = ev(n.arg, at);
        const groups = new Map();
        for (const s of v) {
          const k = key(s.labels, n.by ?? []);
          const g = groups.get(k) ?? { labels: Object.fromEntries(Object.entries(s.labels).filter(([l]) => (n.by ?? []).includes(l))), values: [] };
          g.values.push(s.value); groups.set(k, g);
        }
        const f = { sum: (x) => x.reduce((a, b) => a + b, 0), max: (x) => Math.max(...x), min: (x) => Math.min(...x), count: (x) => x.length }[n.fn];
        return [...groups.values()].map((g) => ({ labels: g.labels, value: f(g.values) }));
      }
      case 'bin': {
        const l = ev(n.left, at), r = ev(n.right, at);
        const arith = { '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b };
        const cmp = { '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };
        if (['and', 'unless', 'or'].includes(n.op)) {
          const rk = new Set(r.map((s) => key(s.labels, n.on)));
          if (n.op === 'and') return l.filter((s) => rk.has(key(s.labels, n.on)));
          if (n.op === 'unless') return l.filter((s) => !rk.has(key(s.labels, n.on)));
          const lk = new Set(l.map((s) => key(s.labels, n.on)));
          return [...l, ...r.filter((s) => !lk.has(key(s.labels, n.on)))];
        }
        const apply = (a, b) => (arith[n.op] ? arith[n.op](a, b) : cmp[n.op](a, b));
        if ('scalar' in l && 'scalar' in r) return { scalar: arith[n.op] ? apply(l.scalar, r.scalar) : Number(apply(l.scalar, r.scalar)) };
        if ('scalar' in r) return l.flatMap((s) => (arith[n.op] ? [{ labels: s.labels, value: apply(s.value, r.scalar) }] : apply(s.value, r.scalar) ? [s] : []));
        if ('scalar' in l) return r.flatMap((s) => (arith[n.op] ? [{ labels: s.labels, value: apply(l.scalar, s.value) }] : apply(l.scalar, s.value) ? [s] : []));
        const rm = new Map(r.map((s) => [key(s.labels, n.on), s]));
        return l.flatMap((s) => {
          const o = rm.get(key(s.labels, n.on));
          if (!o) return [];
          if (arith[n.op]) return [{ labels: n.on ? s.labels : s.labels, value: apply(s.value, o.value) }];
          return apply(s.value, o.value) ? [s] : [];
        });
      }
      default: throw new Error(`promql-lite: ${n.k}`);
    }
  };
  const out = ev(parse(src));
  return 'scalar' in out ? [{ labels: {}, value: out.scalar }] : out;
}

// Grafana's condition on every rule here is "A > 0" (tools/grafana.mjs alertRules): the instances that fire.
export const firing = (src, series, at) => evaluate(src, series, at).filter((s) => s.value > 0);

// A counter sampled every `step` seconds from `from` to `to`, rising by one at each time in `events` (unix seconds).
export function counter(labels, events, { from, to, step = 60, start = 0 }) {
  const samples = [];
  for (let t = from; t <= to; t += step) samples.push([t, start + events.filter((e) => e <= t).length]);
  return { labels, samples };
}
// A gauge with a value function of time.
export function gauge(labels, fn, { from, to, step = 60 }) {
  const samples = [];
  for (let t = from; t <= to; t += step) { const v = fn(t); if (v != null) samples.push([t, v]); }
  return { labels, samples };
}
