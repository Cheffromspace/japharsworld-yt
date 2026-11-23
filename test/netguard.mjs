// `npm test` is offline (Everything-is-OK#1035): loaded into every test process by package.json's test script
// (`node --import ./test/netguard.mjs --test ...`). Any connection to a host other than this machine is refused and
// recorded, and a run that tried one FAILS, naming the host, the code that opened it and where it was charged. Until
// 2026-11-23 seven test files tried tunelio.dev, www.youtube.com and cdn.example on every run (a fake build's real-looking
// URL read by the real codec read; the real YouTube search) and passed whether or not the connection went out: from the
// home network that was a YouTube request per run.
// Refused: a socket or TLS connect, dns.lookup / lookupService, every c-ares query (dns.resolve*, dns.reverse, a
// dns.Resolver's, which always ask a DNS server), a UDP send or connect (dgram), fetch, the built-in WebSocket. Loopback
// (127.0.0.1, ::1, localhost) and local pipes pass: the tests run the real app on port 0.
// Where a refusal is charged (a test process, the main thread):
//   - made by a test (its body, its beforeEach/afterEach, async work it started), or while it runs by work with no
//     async owner or started in a before()/after() hook (a server shared by the file's tests): that test fails;
//   - made at load, in a before()/after() hook, between tests, or by async work a test left running after it ended:
//     no test is charged (an innocent test stays green), and the file FAILS at exit, naming each one and its place.
//   The owner is read from an AsyncLocalStorage the guard sets around each test's and hook's function (the runner calls
//   them through AsyncResource.runInAsyncScope with the TestContext; Node 24.19, 2026-11-23). If a later Node stops
//   doing that, every refusal falls back to "the test that was running" (the guard's charge before 2026-11-23).
// Children and workers: the guard puts itself into NODE_OPTIONS, so every node child that inherits the environment loads
// it (six test files start children: home, grafana, deploy, rejection, relaycaptions, hypercare); a worker thread gets it
// from the preload (one given its own execArgv gets the --import added), and an `eval: true` worker (which gets no
// preload) by a line put before its code. In a child or a worker the guard only refuses and records: each refusal is
// written to the parent test process's log (charged there like its own), and a child exits non-zero. A child started with its own env gets the guard only if NODE_OPTIONS is passed
// (grafana.test.js does). A bash child (deploy's scripts, hypercare's awk) passes NODE_OPTIONS on to any node it starts;
// bash, awk, curl and other programs themselves are NOT guarded.
// The guard's own self-test: test/netguard.test.js over the fixtures in test/netguard-fixtures/.
// NETGUARD_RECORD=<file> appends one JSON line per test process: { file, local, refused: [{ what, where, to }] } (the
// evidence that a run tried nothing; `to` is the test charged, or the place outside a test).
import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import dgram from 'node:dgram';
import workerThreads, { isMainThread, threadId } from 'node:worker_threads';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { appendFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { beforeEach, afterEach } from 'node:test';

const KEY = Symbol.for('eiok.netguard');
// Loaded once per thread: a test file gets it from --import and from NODE_OPTIONS (two URLs, one guard).
if (!globalThis[KEY]) { globalThis[KEY] = true; install(); }

function install() {
  const self = new URL(import.meta.url);
  const base = self.href.split('?')[0];
  // A test process: the runner's child for one test file (NODE_TEST_CONTEXT is set, and argv[1] is that file; the
  // variable is inherited by every child of a test, so it alone is not enough), or a runner that runs tests in itself.
  // Only there may the guard add node:test hooks: in a plain `node -e` child they print a test summary into its stdout.
  const testProcess = isMainThread && (process.execArgv.includes('--test')
    || (!!process.env.NODE_TEST_CONTEXT && /\.test\.[cm]?js$/i.test(process.argv[1] ?? '')));
  // A worker copies the env of its thread when it starts (the test process's own log); a child started with a bare env
  // still has the log in NODE_OPTIONS' URL.
  const parentLog = process.env.NETGUARD_PARENT_LOG || self.searchParams.get('log') || null;
  const local = (h) => h == null || h === '' || h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1';
  const record = { local: 0, refused: [] };
  const owners = new AsyncLocalStorage();
  let current = null; // the TestContext between the guard's beforeEach and afterEach
  // The opener's frames under src/, relay/, test/, tools/ or metrics/ (not node_modules, not this file).
  const where = () => (new Error().stack ?? '').split('\n').slice(1)
    .filter((l) => /[\\/](src|relay|test|tools|metrics)[\\/]/.test(l) && !/node_modules|netguard\.mjs/.test(l))
    .slice(0, 3).map((l) => l.trim().replace(/^at /, '').replace(/\(?(file:\/\/\/)?[A-Za-z]?:?[^(]*?[\\/](src|relay|test|tools|metrics)[\\/]/, '$2/').replace(/\)$/, '')).join(' < ');
  const proc = () => (isMainThread ? `child process ${process.pid} (${process.argv.slice(1).map((x) => x.split(/[\\/]/).pop()).join(' ').slice(0, 80) || 'node -e'})` : `worker thread ${threadId} of process ${process.pid}`);
  const refuse = (what) => {
    const r = { what, where: where() || '?', owner: owners.getStore() ?? null, during: current };
    record.refused.push(r);
    if (!testProcess && parentLog) {
      try { appendFileSync(parentLog, `${JSON.stringify({ what, where: r.where, from: proc() })}\n`); } catch { /* the exit code still fails the child */ }
    }
    return new Error(`netguard: refused ${what} (npm test is offline, test/netguard.mjs)`);
  };
  const later = (cb, err) => { process.nextTick(cb, err); };

  // Sockets, TLS, fetch.
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let o = args[0];
    if (Array.isArray(o)) o = o[0];
    const host = typeof o === 'object' && o ? (o.path ? null : o.host) : (typeof args[1] === 'string' ? args[1] : undefined);
    if (local(host)) { record.local++; return connect.apply(this, args); }
    throw refuse(`connect ${host}`);
  };
  const tlsConnect = tls.connect;
  tls.connect = function (...a) {
    const host = a[0]?.host ?? a[0]?.servername ?? (typeof a[1] === 'string' ? a[1] : undefined);
    if (a[0]?.socket) return tlsConnect.apply(this, a); // TLS over a socket this guard already let through
    if (local(host)) return tlsConnect.apply(this, a);
    throw refuse(`tls ${host}`);
  };
  // fetch is refused at the call, where the stack still names the code that asked (inside undici it would not).
  const hostOf = (u) => { try { return new URL(String(u)).hostname.replace(/^\[|\]$/g, ''); } catch { return null; } };
  const fetchFn = globalThis.fetch;
  if (fetchFn) {
    globalThis.fetch = function (input, init) {
      const u = String(input?.url ?? input);
      const host = hostOf(u); // a relative or bad URL: fetch itself refuses it
      if (host != null && !local(host)) return Promise.reject(refuse(`fetch ${u.replace(/^(\w+:\/\/[^/?#]+).*/, '$1')}`));
      return fetchFn.call(this, input, init);
    };
  }
  // The built-in WebSocket opens its connection inside undici, past the socket patch (verifier-cap-s1's P8).
  if (typeof globalThis.WebSocket === 'function') {
    const WS = globalThis.WebSocket;
    globalThis.WebSocket = class WebSocket extends WS {
      constructor(u, ...rest) {
        const host = hostOf(u);
        if (host != null && !local(host)) throw refuse(`websocket ${String(u).replace(/^(\w+:\/\/[^/?#]+).*/, '$1')}`);
        super(u, ...rest);
      }
    };
  }

  // DNS: getaddrinfo (lookup), getnameinfo (lookupService), and c-ares (resolve*, reverse; any server, any name).
  const lookup = dns.lookup;
  dns.lookup = function (host, ...rest) {
    if (local(host)) return lookup.call(this, host, ...rest);
    const err = refuse(`dns ${host}`);
    const cb = rest.at(-1);
    if (typeof cb === 'function') return later(cb, err);
    throw err;
  };
  const plookup = dns.promises.lookup;
  dns.promises.lookup = function (host, ...rest) { return local(host) ? plookup.call(this, host, ...rest) : Promise.reject(refuse(`dns ${host}`)); };
  const lookupService = dns.lookupService;
  dns.lookupService = function (host, ...rest) {
    if (local(host)) return lookupService.call(this, host, ...rest);
    const err = refuse(`dns lookupService ${host}`);
    const cb = rest.at(-1);
    if (typeof cb === 'function') return later(cb, err);
    throw err;
  };
  const plookupService = dns.promises.lookupService;
  dns.promises.lookupService = function (host, ...rest) { return local(host) ? plookupService.call(this, host, ...rest) : Promise.reject(refuse(`dns lookupService ${host}`)); };
  const cares = /^(resolve\w*|reverse)$/;
  const refuseCb = (k) => function (name, ...rest) {
    const err = refuse(`c-ares ${k} ${name}`);
    const cb = rest.at(-1);
    if (typeof cb === 'function') return later(cb, err);
    throw err;
  };
  const refusePromise = (k) => function (name) { return Promise.reject(refuse(`c-ares ${k} ${name}`)); };
  for (const k of Object.getOwnPropertyNames(dns.Resolver.prototype)) if (cares.test(k)) dns.Resolver.prototype[k] = refuseCb(k);
  for (const k of Object.keys(dns)) if (cares.test(k) && typeof dns[k] === 'function') dns[k] = refuseCb(k);
  for (const k of Object.getOwnPropertyNames(dns.promises.Resolver.prototype)) if (cares.test(k)) dns.promises.Resolver.prototype[k] = refusePromise(k);
  for (const k of Object.keys(dns.promises)) if (cares.test(k) && typeof dns.promises[k] === 'function') dns.promises[k] = refusePromise(k);

  // UDP: send(msg[, offset, length][, port][, address][, cb]) names its address as the one string after msg; a send on
  // a connected socket names none (its connect was checked), and an unconnected one without it goes to localhost.
  const udpSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (...a) {
    const host = a.slice(1).find((x) => typeof x === 'string');
    if (local(host)) return udpSend.apply(this, a);
    throw refuse(`udp ${host}`);
  };
  const udpConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function (port, host, ...rest) {
    if (local(typeof host === 'string' ? host : undefined)) return udpConnect.call(this, port, host, ...rest);
    throw refuse(`udp connect ${host}`);
  };

  // Worker threads: a file or URL worker gets the --import preload; an eval worker does not (verifier-cap-s1's P7), so
  // its code starts by loading this file (require of an ES module, no top-level await here).
  const W = workerThreads.Worker;
  const prelude = `process.getBuiltinModule('node:module').createRequire(${JSON.stringify(base)})(${JSON.stringify(fileURLToPath(base))});\n`;
  workerThreads.Worker = class Worker extends W {
    constructor(what, options) {
      if (options?.eval && typeof what === 'string') what = prelude + what;
      else if (Array.isArray(options?.execArgv)) options = { ...options, execArgv: [...options.execArgv, `--import=${base}`] };
      super(what, options);
    }
  };
  syncBuiltinESMExports();

  if (!testProcess) {
    // A child or a worker: refuse and record only; the parent test process charges what its log receives.
    process.on('exit', (code) => {
      if (process.env.NETGUARD_RECORD) { // the evidence that the child loaded the guard
        try { appendFileSync(process.env.NETGUARD_RECORD, `${JSON.stringify({ file: proc(), child: true, local: record.local, refused: record.refused.map((r) => ({ what: r.what, where: r.where })) })}\n`); } catch { /* evidence only */ }
      }
      if (!record.refused.length) return;
      process.stderr.write(`netguard: ${proc()} tried ${record.refused.length} outbound connection(s): ${record.refused.map((r) => `${r.what} @ ${r.where}`).join('; ')}\n`);
      if (!code) process.exitCode = 1;
    });
    return;
  }

  // This process's log, for its children and workers; NODE_OPTIONS carries the guard (and the log) into node children.
  const log = join(tmpdir(), `netguard-${process.pid}-${Date.now()}.jsonl`);
  process.env.NETGUARD_PARENT_LOG = log;
  const url = `${base}?log=${encodeURIComponent(log)}`;
  process.env.NODE_OPTIONS = `${(process.env.NODE_OPTIONS ?? '').replace(/--import[= ]\S*netguard\.mjs\S*/g, '').trim()} --import=${url}`.trim();
  let logRead = 0;
  const fromLog = () => {
    let text;
    try { if (statSync(log).size <= logRead) return []; text = readFileSync(log); } catch { return []; }
    const fresh = text.subarray(logRead).toString('utf8');
    logRead = text.length;
    return fresh.split('\n').filter(Boolean).map((l) => { try { const o = JSON.parse(l); return { what: `${o.what} (in a ${o.from})`, where: o.where, owner: null, during: current }; } catch { return null; } }).filter(Boolean);
  };

  // Each test's and hook's function runs with its owner in `owners`; async work it starts keeps it.
  const runIn = AsyncResource.prototype.runInAsyncScope;
  AsyncResource.prototype.runInAsyncScope = function (fn, thisArg, ...args) {
    const kind = thisArg?.constructor?.name;
    if (typeof fn !== 'function' || (kind !== 'TestContext' && kind !== 'SuiteContext')) return runIn.call(this, fn, thisArg, ...args);
    const owner = { ctx: thisArg, name: thisArg.fullName ?? thisArg.name, hook: typeof this.hookType === 'string' ? this.hookType : null };
    return runIn.call(this, function (...a) { return owners.run(owner, () => fn.apply(this, a)); }, thisArg, ...args);
  };

  let seen = 0; // refusals already sorted into charged / outside
  let lastEnded = null; // the name of the last test that ended
  const outside = [];
  const all = []; // every refusal, sorted, for NETGUARD_RECORD
  // A before()/after() hook is shared setup (a server started there serves every test): what it starts is charged like
  // work with no owner, to the test running when the refusal is made, and only outside a test is it named as the hook's.
  const shared = (r) => r.owner?.hook === 'before' || r.owner?.hook === 'after';
  const label = (r) => {
    if (shared(r)) return `in ${r.owner.hook === 'after' ? 'an' : 'a'} ${r.owner.hook}() hook${r.owner.name && r.owner.name !== '<root>' ? ` of "${r.owner.name}"` : ''}`;
    if (r.owner) return `from async work started in test "${r.owner.name}", after that test ended${r.during ? `, while test "${r.during.fullName ?? r.during.name}" ran` : ''}`;
    if (r.during) return `while test "${r.during.fullName ?? r.during.name}" ran`;
    return lastEnded == null ? 'at load, before any test' : `outside any test, after "${lastEnded}" (no async owner)`;
  };
  // Sorts the refusals since the last call: those of test `t` are returned; every other one is kept for the exit.
  const sort = (t) => {
    const fresh = [...record.refused.slice(seen), ...fromLog()];
    seen = record.refused.length;
    const mine = [];
    for (const r of fresh) {
      all.push(r);
      const ours = t && (r.owner && !shared(r) ? r.owner.ctx === t : r.during === t);
      if (ours) { r.to = t.fullName ?? t.name; mine.push(r); } else { r.to = label(r); outside.push(r); }
    }
    return mine;
  };
  beforeEach((t) => { sort(null); current = t; });
  afterEach((t) => {
    const mine = sort(t);
    current = null;
    lastEnded = t.fullName ?? t.name;
    if (mine.length) throw new Error(`netguard: this test tried ${mine.length} outbound connection(s): ${mine.map((r) => `${r.what} @ ${r.where}`).join('; ')}`);
  });
  process.on('exit', (code) => {
    sort(null);
    try { rmSync(log, { force: true }); } catch { /* a temp file */ }
    const file = process.argv.slice(1).map((x) => x.split(/[\\/]/).pop()).join(' ');
    if (process.env.NETGUARD_RECORD) {
      const refused = all.map((r) => ({ what: r.what, where: r.where, to: r.to ?? null }));
      try { appendFileSync(process.env.NETGUARD_RECORD, `${JSON.stringify({ file, local: record.local, refused })}\n`); } catch { /* the record is evidence only */ }
    }
    // Refusals no test was charged with: the file fails, each one named with its place.
    if (outside.length) {
      process.stderr.write(`netguard: ${file} tried ${outside.length} outbound connection(s) outside its tests: ${outside.map((r) => `${r.what} @ ${r.where} (${r.to})`).join('; ')}\n`);
      if (!code) process.exitCode = 1;
    }
  });
}
