// netguard self-test fixture: one test per way out the guard covers, each aimed at 192.0.2.1 (TEST-NET-1, RFC 5737,
// reserved; .invalid names). Each test must FAIL, charged with its own refusal; the last one (loopback) must pass.
import test from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const quietly = (fn) => { try { const p = fn(); return p?.catch ? p.catch(() => {}) : p; } catch { return undefined; } };
const settled = (fn) => new Promise((done) => { try { fn(() => done()); } catch { done(); } setTimeout(done, 1500).unref(); });
const workerRun = (w) => new Promise((done) => { w.once('message', done); w.once('error', done); w.once('exit', done); });
const FETCH = "fetch('http://192.0.2.1:9/', { signal: AbortSignal.timeout(800) }).catch(() => {})";

test('API fetch', async () => { await quietly(() => fetch('http://192.0.2.1:9/')); });
test('API net connect', () => { quietly(() => net.connect(9, '192.0.2.1').on('error', () => {})); });
test('API tls connect', () => { quietly(() => tls.connect({ host: '192.0.2.1', port: 9 }).on('error', () => {})); });
test('API dns lookup', async () => { await quietly(() => dns.promises.lookup('example.invalid')); });
test('API dns lookupService', async () => { await settled((done) => dns.lookupService('192.0.2.1', 9, done)); });
test('API dns Resolver resolve4', async () => {
  const r = new dns.Resolver({ timeout: 300, tries: 1 });
  r.setServers(['192.0.2.1']);
  await settled((done) => r.resolve4('example.invalid', done));
});
test('API dns promises Resolver resolveTxt', async () => {
  const r = new dns.promises.Resolver({ timeout: 300, tries: 1 });
  r.setServers(['192.0.2.1']);
  await quietly(() => r.resolveTxt('example.invalid'));
});
test('API dns resolve (the default resolver, its server set to 192.0.2.1)', async () => {
  dns.setServers(['192.0.2.1']);
  await settled((done) => dns.resolve('example.invalid', done));
});
test('API dgram send', async () => {
  const s = dgram.createSocket('udp4');
  await settled((done) => s.send(Buffer.from('x'), 9, '192.0.2.1', done));
  s.close();
});
test('API dgram connect', async () => {
  const s = dgram.createSocket('udp4');
  await settled((done) => s.connect(9, '192.0.2.1', done));
  s.close();
});
test('API WebSocket', () => { quietly(() => { const ws = new WebSocket('ws://192.0.2.1:9/'); ws.onerror = () => {}; setTimeout(() => ws.close(), 100); }); });
test('API worker eval', async () => {
  const w = new Worker(`${FETCH}.then(() => require('node:worker_threads').parentPort.postMessage('done'))`, { eval: true });
  await workerRun(w);
  await w.terminate();
});
test('API worker module', async () => {
  const w = new Worker(new URL(`data:text/javascript,import { parentPort } from 'node:worker_threads'; await ${FETCH}; parentPort.postMessage('done');`));
  await workerRun(w);
  await w.terminate();
});
test('API worker with its own execArgv', async () => {
  const w = new Worker(new URL(`data:text/javascript,import { parentPort } from 'node:worker_threads'; await ${FETCH}; parentPort.postMessage('done');`), { execArgv: [] });
  await workerRun(w);
  await w.terminate();
});
test('API node child', () => {
  const r = spawnSync(process.execPath, ['-e', `${FETCH}`], { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 1) throw new Error(`the child exits 1 on a refusal, got ${r.status}: ${r.stderr}`);
});
test('API node child under bash', { skip: spawnSync('bash', ['-c', 'exit 0']).status !== 0 && 'no bash here' }, () => {
  spawnSync('bash', ['-c', `node -e "${FETCH.replaceAll('"', '\\"')}"`], { encoding: 'utf8', timeout: 20_000 });
});
test('API loopback passes', async () => {
  const s = net.createServer((c) => c.end());
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  await new Promise((done) => net.connect(s.address().port, '127.0.0.1', done).on('error', done).on('connect', function () { this.destroy(); }));
  await new Promise((done) => s.close(done));
});
