// netguard self-test fixture: a server started in a before() hook (shared setup) whose handler fetches 192.0.2.1 when
// U1 calls it: the refusal is charged to U1, the test running then, as with app code started at load; U2 stays green.
import test, { before, after } from 'node:test';
import http from 'node:http';

let server;
before(async () => {
  server = http.createServer((req, res) => { fetch('http://192.0.2.1:9/').catch(() => {}).finally(() => res.end('ok')); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
});
after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
test('U1 calls the shared server', async () => { await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text(); });
test('U2 does nothing', () => {});
