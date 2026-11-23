// `npm test` is offline (Everything-is-OK#1035): loaded into every test process by package.json's test script
// (`node --import ./test/netguard.mjs --test ...`). Any connection to a host other than this machine (a socket connect,
// a DNS lookup, a TLS connect) is refused and recorded, and the test that was running when it was tried FAILS, naming the
// host and the code that opened it. Until 2026-11-23 seven test files tried tunelio.dev, www.youtube.com and cdn.example
// on every run (a fake build's real-looking URL read by the real codec read; the real YouTube search) and passed whether
// or not the connection went out: from the home network that was a YouTube request per run.
// Loopback (127.0.0.1, ::1, localhost) and local pipes pass: the tests run the real app on port 0.
// Not covered: child processes the tests start (they load no --import); none of them reaches out (read 2026-11-23).
// NETGUARD_RECORD=<file> appends one JSON line per test process: { file, local, refused: [...] } (the evidence that a run
// tried nothing).
import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { beforeEach, afterEach } from 'node:test';

const local = (h) => h == null || h === '' || h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1';
const record = { local: 0, refused: [] };
let seen = 0; // refusals already charged to a test
// The opener's frames under src/, relay/, test/ or tools/ (not node_modules, not this file).
const where = () => (new Error().stack ?? '').split('\n').slice(1)
  .filter((l) => /[\\/](src|relay|test|tools|metrics)[\\/]/.test(l) && !/node_modules|netguard\.mjs/.test(l))
  .slice(0, 3).map((l) => l.trim().replace(/^at /, '').replace(/\(?(file:\/\/\/)?[A-Za-z]?:?[^(]*?[\\/](src|relay|test|tools|metrics)[\\/]/, '$2/').replace(/\)$/, '')).join(' < ');
const refuse = (what) => {
  record.refused.push({ what, where: where() || '?' });
  return new Error(`netguard: refused ${what} (npm test is offline, test/netguard.mjs)`);
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  const host = typeof o === 'object' && o ? (o.path ? null : o.host) : (typeof args[1] === 'string' ? args[1] : undefined);
  if (local(host)) { record.local++; return connect.apply(this, args); }
  throw refuse(`connect ${host}`);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (local(host)) return lookup.call(this, host, ...rest);
  const err = refuse(`dns ${host}`);
  const cb = rest.at(-1);
  if (typeof cb === 'function') return process.nextTick(cb, err);
  throw err;
};
const plookup = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) { return local(host) ? plookup.call(this, host, ...rest) : Promise.reject(refuse(`dns ${host}`)); };
const tlsConnect = tls.connect;
tls.connect = function (...a) {
  const host = a[0]?.host ?? a[0]?.servername ?? (typeof a[1] === 'string' ? a[1] : undefined);
  if (local(host) && !a[0]?.socket) return tlsConnect.apply(this, a);
  if (a[0]?.socket) return tlsConnect.apply(this, a); // TLS over a socket this guard already let through
  throw refuse(`tls ${host}`);
};
syncBuiltinESMExports();
// fetch is refused at the call, where the stack still names the code that asked (inside undici it would not).
const fetchFn = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const u = String(input?.url ?? input);
  let host = null;
  try { host = new URL(u).hostname.replace(/^\[|\]$/g, ''); } catch { /* a relative or bad URL: fetch itself refuses it */ }
  if (host != null && !local(host)) return Promise.reject(refuse(`fetch ${u.replace(/^(\w+:\/\/[^/?#]+).*/, '$1')}`));
  return fetchFn.call(this, input, init);
};

// The test that ran when a refusal was recorded fails (a top-level hook of the --import module applies to every test
// in the file; checked on Node 24.19, 2026-11-23).
beforeEach(() => { seen = record.refused.length; });
afterEach(() => {
  const mine = record.refused.slice(seen);
  seen = record.refused.length;
  if (mine.length) throw new Error(`netguard: this test tried ${mine.length} outbound connection(s): ${mine.map((r) => `${r.what} @ ${r.where}`).join('; ')}`);
});
process.on('exit', (code) => {
  const file = process.argv.slice(1).map((x) => x.split(/[\\/]/).pop()).join(' ');
  if (process.env.NETGUARD_RECORD) {
    try { appendFileSync(process.env.NETGUARD_RECORD, `${JSON.stringify({ file, local: record.local, refused: record.refused })}\n`); } catch { /* the record is evidence only */ }
  }
  // Refusals no test was charged with (at load, or after the last test): the process fails.
  if (record.refused.length > seen) {
    process.stderr.write(`netguard: ${file} tried ${record.refused.length - seen} outbound connection(s) outside a test: ${record.refused.slice(seen).map((r) => `${r.what} @ ${r.where}`).join('; ')}\n`);
    if (!code) process.exitCode = 1;
  }
});
