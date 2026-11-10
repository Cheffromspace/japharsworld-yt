// Everything-is-OK#681: a promise rejected with nobody waiting on it ended the process, and with it every held player.
// The entry point of src/server.js installs catchRejections; createApp doesn't, so these tests drive it directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createApp, catchRejections, rejectionShape } from '../src/server.js';
import { Store } from '../src/store.js';
import { config as base } from '../src/config.js';
import { redact } from '../src/ops.js';
import { checkedKey, METRICS } from '../src/metrics.js';

const QUERY = 'rain sounds for sleeping';
const VIDEO = 'dQw4w9WgXcQ';

test('unhandled rejection: one line with the error\'s class, code and code locations, counted, and no message', () => {
  const proc = new EventEmitter();
  const lines = [];
  const counted = [];
  catchRejections(proc, { log: (o) => lines.push(o), metrics: { inc: (m, k) => counted.push([m, k]) } });
  assert.equal(proc.listenerCount('unhandledRejection'), 1);

  const err = new TypeError(`fetch failed for https://example.invalid/watch?v=${VIDEO}&q=${QUERY}`, { cause: Object.assign(new Error(QUERY), { code: 'ECONNRESET' }) });
  proc.emit('unhandledRejection', err, Promise.resolve());
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.deepEqual([line.event, line.error, line.code], ['unhandled_rejection', 'TypeError', 'ECONNRESET']);
  assert.match(line.where, /^test\/rejection\.test\.js:\d+( < [\w.@-]+(\/[\w.@-]+)?:\d+)*$/, 'where the error was made: dir/file:line, nearest first');
  assert.deepEqual(Object.keys(line).sort(), ['code', 'error', 'event', 'where']);
  assert.deepEqual(counted, [['unhandled_rejection', undefined]]);
  assert.equal(checkedKey('unhandled_rejection', ''), '', 'a metric the service knows');
  assert.equal(METRICS.unhandled_rejection[0], 'daily');
  // /ops/events keeps every field (src/ops.js); its ID mask may blank an 11-character name among Node's own frames.
  const kept = redact({ at: '2026-11-10T00:00:00.000Z', ...line });
  assert.deepEqual({ ...kept, where: null }, { at: '2026-11-10T00:00:00.000Z', ...line, where: null });
  assert.match(kept.where, /^test\/rejection\.test\.js:\d+/);

  // Nothing from the message, whatever was rejected with.
  const odd = [QUERY, { q: QUERY, id: VIDEO }, null, undefined, 42, Object.assign(new Error(QUERY), { name: QUERY, code: QUERY, stack: `${QUERY}\n    at ${QUERY}` })];
  for (const reason of odd) proc.emit('unhandledRejection', reason, Promise.resolve());
  assert.deepEqual(lines.slice(1).map((l) => l.error), ['string', 'object', 'null', 'undefined', 'number', 'Error']);
  const all = JSON.stringify(lines);
  for (const secret of [QUERY, VIDEO, 'example.invalid', 'fetch failed', 'rain']) assert.ok(!all.includes(secret), secret);
  assert.equal(counted.length, 7);
  assert.deepEqual(rejectionShape(new RangeError(QUERY)).error, 'RangeError');
});

test('unhandled rejection: a failing log or counter never throws out of the handler', () => {
  const proc = new EventEmitter();
  const lines = [];
  catchRejections(proc, { log: (o) => lines.push(o), metrics: { inc() { throw new Error('unknown metric'); } } });
  assert.doesNotThrow(() => proc.emit('unhandledRejection', new Error('x')));
  assert.equal(lines.length, 1, 'still logged when counting fails');
  const bare = new EventEmitter();
  catchRejections(bare, { log() { throw new Error('EPIPE'); } });
  assert.doesNotThrow(() => bare.emit('unhandledRejection', new Error('x')));
  assert.doesNotThrow(() => catchRejections(new EventEmitter()).call(null, new Error('x')), 'no log, no metrics');
});

// The real thing, in a child process: Node ends on an unhandled rejection unless something listens for it.
test('unhandled rejection: a real process with the handler keeps running; without it, it ends', () => {
  const code = `
    import { catchRejections } from './src/server.js';
    if (process.env.EIOK_TEST_HANDLER === 'on') catchRejections(process, { log: (o) => console.log(JSON.stringify(o)), metrics: { inc: (m) => console.log('counted ' + m) } });
    Promise.reject(new Error(${JSON.stringify(QUERY)}));
    setTimeout(() => console.log('still running'), 50);`;
  const run = (handler) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, EIOK_TEST_HANDLER: handler }, encoding: 'utf8', timeout: 30_000 });
  const off = run('off');
  assert.notEqual(off.status, 0, 'Node\'s default: the process ends');
  assert.ok(!off.stdout.includes('still running'));
  const on = run('on');
  assert.equal(on.status, 0, on.stderr);
  const out = on.stdout.trim().split('\n').map((l) => l.trim());
  assert.equal(out[0], 'counted unhandled_rejection');
  assert.deepEqual([JSON.parse(out[1]).event, JSON.parse(out[1]).error], ['unhandled_rejection', 'Error']);
  assert.equal(out[2], 'still running');
  assert.ok(!on.stdout.includes(QUERY) && !on.stderr.includes(QUERY), 'the message is not printed');
});

test('unhandled rejection: wired at the entry point to the service\'s own log (the /ops/events ring) and metrics', () => {
  const lines = [];
  const counted = [];
  const metrics = new Proxy({ inc: (m) => counted.push(m) }, { get: (o, k) => (k in o ? o[k] : () => {}) });
  const app = createApp({ config: { ...base, shards: 1, pool: 10, metricsPath: '' }, store: new Store({ path: ':memory:', shards: 1, pool: 10, pinHours: 24 }),
    metrics, captions: { async get() { return {}; } }, log: (l) => lines.push(JSON.parse(l)) });
  const proc = new EventEmitter();
  catchRejections(proc, { log: app.logJson, metrics: app.metrics });
  proc.emit('unhandledRejection', new Error(QUERY));
  const line = lines.find((l) => l.event === 'unhandled_rejection');
  assert.deepEqual([line.error, Number.isFinite(Date.parse(line.at))], ['Error', true]);
  assert.ok(counted.includes('unhandled_rejection'));
  assert.ok(!JSON.stringify(lines).includes(QUERY));
  // createApp itself listens for nothing on the process; only the entry point does.
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const entry = src.slice(src.indexOf('if (import.meta.url === pathToFileURL(process.argv[1]'));
  assert.match(entry, /const app = createApp\(\);\s+catchRejections\(process, \{ log: app\.logJson, metrics: app\.metrics \}\);/);
  assert.equal(src.split('catchRejections(process').length, 2, 'installed once, at the entry point');
});
