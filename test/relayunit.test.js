import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The home relay workers' memory settings (Everything-is-OK#968; the owner's go for up to 4 GB, 2026-11-21 about 18:03Z).
const unit = (name) => readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8');
const lines = (text, key) => text.split('\n').filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));

test('#968: the production worker may use 4 GB with an explicit 2 GB heap; its command line is unchanged', () => {
  const u = unit('japharsworld-yt-relay.service');
  assert.deepEqual(lines(u, 'MemoryMax'), ['4G']);
  assert.deepEqual(lines(u, 'Environment'), ['NODE_OPTIONS=--max-old-space-size=2048']);
  // The Alloy memory matcher and test/alerts.test.js read this command line (#967): the heap is not set here.
  assert.deepEqual(lines(u, 'ExecStart'), ['/usr/bin/node /opt/japharsworld-yt-relay/relay/worker.js']);
  assert.match(u, /child node processes[\s\S]{0,80}inherit/i, 'the comment says yt-dlp\'s node children inherit the ceiling');
  assert.doesNotMatch(u, /2026-10-25 at 300M it held/, 'the stale comment about the old 300M cap is gone');
});

test('#968: the staging worker keeps its 300M cap and its command line, so it still fails first', () => {
  const u = unit('japharsworld-yt-relay-staging.service');
  assert.deepEqual(lines(u, 'MemoryMax'), ['300M']);
  assert.deepEqual(lines(u, 'Environment'), []);
  assert.deepEqual(lines(u, 'ExecStart'), ['/usr/bin/node /opt/japharsworld-yt-relay-staging/relay/worker.js']);
  assert.doesNotMatch(u, /The Optiplex has ~30 GB free/, 'the comment no longer reads as production\'s');
  assert.match(u, /#968/);
});
