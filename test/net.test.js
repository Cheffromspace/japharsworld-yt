import test from 'node:test';
import assert from 'node:assert/strict';
import { txBytes, TxDelta } from '../src/net.js';

const DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 125768134 1000 0 0 0 0 0 0 125768134 1000 0 0 0 0 0 0
  eth0: 628447978480 616453117 0 0 0 0 0 0 605922816485 348418634 0 0 0 0 0 0
 wlan0: 10 1 0 0 0 0 0 0 15 1 0 0 0 0 0 0
`;

test('txBytes: bytes sent over every interface but loopback, from /proc/net/dev', () => {
  assert.equal(txBytes(DEV), 605922816485 + 15);
  assert.equal(txBytes('nothing here'), null);
});

test('TxDelta: MB since the last reading; first reading and a reboot set the baseline, a stale one is ignored', () => {
  const d = new TxDelta();
  assert.equal(d.mb('a', 1_000_000_000), 0);
  assert.equal(d.mb('a', 1_250_000_000), 250);
  assert.equal(d.mb('a', 1_200_000_000), 0, 'stale (out of order): ignored');
  assert.equal(d.mb('a', 1_300_000_000), 50, 'counted from the newest reading');
  assert.equal(d.mb('a', 5_000_000), 0, 'reboot: baseline');
  assert.equal(d.mb('a', 7_000_000), 2);
  assert.equal(d.mb('b', 7_000_000), 0, 'sources are separate');
  assert.equal(d.mb('a', NaN), 0);
});
