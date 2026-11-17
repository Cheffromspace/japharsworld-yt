// RELAY_CACHE_KEEP_FORMAT_2 (Everything-is-OK#784; owner on #787, 2026-11-15: "keep cache, A"): production's worker serves
// its format 2 entries instead of dropping them; off (staging, and the default) is exactly the old behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cacheModule from '../relay/cache.js';

const { MediaCache, FORMAT } = cacheModule;
// The setting's parse; where it doesn't exist yet (be142c4), what it should give, so the cache's behaviour is what fails.
const keepFor = (value) => (cacheModule.keepFormatsFor ? cacheModule.keepFormatsFor(value) : value === 'on' ? [2] : []);
const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'cachefmt-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

// An entry of `format`, `seconds` long (4 s segments), as put() leaves it.
function entry(cache, id, { format = FORMAT, seconds = 8 } = {}) {
  const s = cache.staging();
  const n = Math.ceil(seconds / 4);
  for (let i = 0; i < n; i++) writeFileSync(join(s, `seg${i}.ts`), Buffer.alloc(10));
  const playlist = `#EXTM3U\n${Array.from({ length: n }, (_, i) => `#EXTINF:4,\nseg${i}.ts\n`).join('')}#EXT-X-ENDLIST\n`;
  assert.equal(cache.put(id, '720p', s, playlist), true);
  const meta = join(cache.dir, `${id}@720p`, 'meta.json');
  if (format !== FORMAT) writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, 'utf8')), format }));
  return { folder: join(cache.dir, `${id}@720p`), meta };
}

test('#784: with RELAY_CACHE_KEEP_FORMAT_2=on a format 2 entry is served and kept, still format 2; new entries are format 3', (t) => {
  assert.equal(FORMAT, 3, 'FORMAT stays 3');
  let now = 1000;
  const cache = new MediaCache({ dir: tmp(t), maxGb: 1, now: () => now, keepFormats: keepFor('on') });
  const old = entry(cache, 'aaaaaaaaaaa', { format: 2 });
  now = 5000;
  const hit = cache.get('aaaaaaaaaaa', '720p', { seconds: 8 });
  assert.ok(hit, 'served');
  assert.deepEqual(hit.segments, ['seg0.ts', 'seg1.ts']);
  assert.ok(existsSync(old.folder), 'not deleted');
  const meta = JSON.parse(readFileSync(old.meta, 'utf8'));
  assert.equal(meta.format, 2, 'left as format 2 on disk');
  assert.equal(meta.usedMs, 5000, 'a use, for the LRU');
  assert.ok(cache.get('aaaaaaaaaaa', '720p'), 'and again');
  const fresh = entry(cache, 'bbbbbbbbbbb');
  assert.equal(JSON.parse(readFileSync(fresh.meta, 'utf8')).format, 3, 'a new entry is format 3');
});

for (const [why, keepFormats] of [['off', keepFor('off')], ['unset', keepFor(undefined)], ['no option at all', undefined]]) {
  test(`#784: with the setting ${why} a format 2 entry is dropped on lookup, as before; format 3 is served`, (t) => {
    const cache = new MediaCache({ dir: tmp(t), maxGb: 1, ...(keepFormats ? { keepFormats } : {}) });
    const old = entry(cache, 'aaaaaaaaaaa', { format: 2 });
    entry(cache, 'bbbbbbbbbbb');
    assert.equal(cache.get('aaaaaaaaaaa', '720p'), null);
    assert.equal(existsSync(old.folder), false, 'deleted');
    assert.ok(cache.get('bbbbbbbbbbb', '720p'));
  });
}

test('#784: with the setting on, any format other than 2 and 3 is still dropped', (t) => {
  const cache = new MediaCache({ dir: tmp(t), maxGb: 1, keepFormats: keepFor('on') });
  for (const [id, format] of [['ccccccccccc', 1], ['ddddddddddd', 4], ['eeeeeeeeeee', undefined]]) {
    const e = entry(cache, id, { format: 'x' });
    writeFileSync(e.meta, JSON.stringify({ ...JSON.parse(readFileSync(e.meta, 'utf8')), format }));
    assert.equal(cache.get(id, '720p'), null, `format ${format}`);
    assert.equal(existsSync(e.folder), false);
  }
  entry(cache, 'fffffffffff');
  assert.ok(cache.get('fffffffffff', '720p'), 'format 3 unaffected');
});

test('#784: a kept format 2 entry still has to be whole: one SHORT_S short of the job\'s length goes (main cached cut copies, #266)', (t) => {
  const cache = new MediaCache({ dir: tmp(t), maxGb: 1, keepFormats: keepFor('on') });
  const old = entry(cache, 'aaaaaaaaaaa', { format: 2, seconds: 8 });
  assert.equal(cache.get('aaaaaaaaaaa', '720p', { seconds: 60 }), null);
  assert.equal(existsSync(old.folder), false);
});

test('#784: the setting reads only the exact "on"', () => {
  assert.deepEqual(keepFor('on'), [2]);
  for (const v of ['off', 'ON', '1', 'true', '', undefined]) assert.deepEqual(keepFor(v), [], String(v));
});
