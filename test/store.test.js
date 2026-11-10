import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

const mk = (over = {}) => {
  let now = 1_000_000;
  const s = new Store({ path: ':memory:', shards: 2, pool: 10, pinHours: 24, now: () => now, ...over });
  s.tick = (ms) => { now += ms; };
  return s;
};
const vids = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'video', data: { id: `v${i}` } }));

test('allocates round-robin and wraps', () => {
  const s = mk();
  assert.deepEqual(s.allocate(0, vids(4)), [0, 1, 2, 3]);
  assert.deepEqual(s.allocate(0, vids(4)), [4, 5, 6, 7]);
  assert.deepEqual(s.allocate(0, vids(4)), [8, 9, 0, 1]);
  assert.equal(s.get(0, 0).data.id, 'v2');
});

test('shards are independent', () => {
  const s = mk();
  s.allocate(0, vids(3));
  assert.deepEqual(s.allocate(1, vids(2)), [0, 1]);
});

test('played tickets are pinned and skipped until the pin expires', () => {
  const s = mk();
  s.allocate(0, vids(10));
  s.markPlayed(0, 2, 'v2');
  const again = s.allocate(0, vids(5));
  assert.deepEqual(again, [0, 1, 3, 4, 5]);
  assert.equal(s.get(0, 2).data.id, 'v2');
  assert.deepEqual(s.lastPlayed(0), { n: 2, videoId: 'v2', at: 1_000_000 });
  s.tick(25 * 3600_000);
  assert.deepEqual(s.allocate(0, vids(5)), [6, 7, 8, 9, 0]);
  assert.deepEqual(s.allocate(0, vids(2)), [1, 2]); // pin expired
});

test('fully pinned shard throws instead of overwriting', () => {
  const s = mk();
  s.allocate(0, vids(10));
  for (let n = 0; n < 10; n++) s.markPlayed(0, n, `v${n}`);
  assert.throws(() => s.allocate(0, vids(1)), /no free tickets/);
});

test('caption cache respects max age', () => {
  const s = mk();
  s.captionPut('abc', 'en', { ok: 1 });
  assert.deepEqual(s.captionGet('abc', 'en', 1000), { ok: 1 });
  s.tick(2000);
  assert.equal(s.captionGet('abc', 'en', 1000), null);
});

test('pruneCaptions removes exactly the rows captionGet would no longer return, and counts them', () => {
  const s = mk();
  s.captionPut('old', 'en', { ok: 1 });
  s.tick(1000);
  s.captionPut('edge', 'en', { ok: 2 });
  s.tick(1000);
  s.captionPut('new', 'en', { ok: 3 });
  // max age 1000: 'old' is 2000 old (gone), 'edge' exactly 1000 (still returned, so kept), 'new' 0.
  assert.equal(s.captionGet('old', 'en', 1000), null);
  assert.deepEqual(s.captionGet('edge', 'en', 1000), { ok: 2 });
  assert.equal(s.pruneCaptions(1000), 1);
  assert.deepEqual(s.db.prepare('SELECT video_id FROM captions ORDER BY video_id').all().map((r) => r.video_id), ['edge', 'new']);
  assert.deepEqual(s.captionGet('edge', 'en', 1000), { ok: 2 });
  s.captionPut('old', 'en', { ok: 4 });
  assert.deepEqual(s.captionGet('old', 'en', 1000), { ok: 4 });
  assert.equal(s.pruneCaptions(1000), 0);
});
