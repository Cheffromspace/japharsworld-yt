// netguard self-test fixture: loopback only (a real local server, fetch, socket): green, nothing refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
test('C1 loopback fetch and socket pass', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
  assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), 'ok');
  await new Promise((done, fail) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); done(); }); s.on('error', fail); });
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});
