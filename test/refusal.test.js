import test from 'node:test';
import assert from 'node:assert/strict';
import { refusalClass, RefusalWatch } from '../src/refusal.js';
import { createWorker } from '../relay/worker.js';
import { isBotWall } from '../src/captions.js';

test('refusal classes from yt-dlp and InnerTube error texts', () => {
  // The bot wall as the Linode's yt-dlp printed it (monitor/test_slotmon.py has the page version).
  assert.equal(refusalClass({ stderr: 'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.' }), 'bot');
  assert.equal(refusalClass(new Error('playability status: LOGIN_REQUIRED')), 'bot');
  assert.equal(refusalClass(new Error('ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests')), 'rate');
  assert.equal(refusalClass(new Error("ERROR: [youtube] x: This content isn't available, try again later.")), 'rate');
  assert.equal(refusalClass(new Error('Request failed with status code 403')), 'forbidden');
  assert.equal(refusalClass({ stderr: 'ERROR: unable to download video data: HTTP Error 403: Forbidden' }), 'forbidden');
  assert.equal(refusalClass({ stderr: 'WARNING: [youtube] x: The tv client requires a GVS PO Token\nERROR: HTTP Error 403: Forbidden' }), 'potoken');
  assert.equal(refusalClass(new Error('ffmpeg exited with 1')), 'other');
  assert.equal(refusalClass('timeout'), 'other');
  // The age gate shares "Sign in to confirm" with the bot wall but is the video's verdict (world #305, prod 2026-10-28).
  assert.equal(refusalClass({ stderr: 'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication.' }), 'restricted');
  assert.equal(refusalClass(new Error('This video is age-restricted and cannot be downloaded.')), 'restricted');
  assert.equal(isBotWall({ stderr: 'ERROR: [youtube] x: Sign in to confirm your age.' }), false, "the Linode's captions don't pause on an age gate");
  assert.equal(isBotWall({ stderr: 'ERROR: [youtube] x: Sign in to confirm you’re not a bot.' }), true);
  assert.equal(refusalClass({ stderr: 'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.' }), 'bot');
});

test('refusal watch: 3 in 15 minutes fire, forbidden and other never do, the window slides, quiet after an hour', () => {
  let t = 0;
  const w = new RefusalWatch({ now: () => t });
  assert.equal(w.add('bot'), false);
  assert.equal(w.add('forbidden'), false);
  assert.equal(w.add('other'), false);
  assert.equal(w.add('restricted'), false);
  assert.equal(w.times.length, 1, 'an age gate is not counted toward the alert');
  t += 10 * 60_000;
  assert.equal(w.add('rate'), false);
  t += 6 * 60_000; // the first one left the window
  assert.equal(w.add('potoken'), false);
  assert.equal(w.add('bot'), true);
  assert.equal(w.summary(), 'rate 1, potoken 1, bot 1');
  t += 59 * 60_000;
  assert.equal(w.quiet(), false);
  t += 2 * 60_000;
  assert.equal(w.quiet(), true);
  assert.equal(w.quiet(), false); // once
});

test('worker: a failed job carries its refusal class, a caption track that failed after its list carries rate', async () => {
  const w = createWorker({ url: 'http://x', token: 't', log: () => {},
    youtube: { search: async () => { throw new Error('Sign in to confirm you’re not a bot'); } },
    captions: async () => ({ info: { language: 'en', manual: [], auto: ['en'] }, track: { key: 'en', auto: true, format: null }, cues: null, reason: 'temporarily_unavailable' }) });
  const s = await w.handle({ id: '1', kind: 'search', query: 'q' });
  assert.equal(s.ok, false);
  assert.equal(s.refusal, 'bot');
  const c = await w.handle({ id: '2', kind: 'captions', videoId: 'dQw4w9WgXcQ', want: { lang: 'en' } });
  assert.equal(c.ok, true);
  assert.equal(c.refusal, 'rate');
  const ok = await createWorker({ url: 'http://x', token: 't', log: () => {}, captions: async () => ({ info: {}, track: null, cues: null }) })
    .handle({ id: '3', kind: 'captions', videoId: 'dQw4w9WgXcQ', want: null });
  assert.equal(ok.refusal, undefined);
});
