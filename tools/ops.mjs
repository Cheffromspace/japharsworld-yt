#!/usr/bin/env node
// Read-only view of the live search service (src/ops.js), for when SSH isn't available:
//   node tools/ops.mjs state
//   node tools/ops.mjs events [--event tunelio_link,build_failed] [--minutes 1440] [--limit 500]
// Needs STATS_TOKEN (from /etc/japharsworld-yt.env on the Linode) in .env or the environment; OPS_URL defaults to
// https://yt.japharsworld.com. Events print one JSON object per line.
import { readFileSync, existsSync } from 'node:fs';

const file = new URL('../.env', import.meta.url);
const env = { ...(existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')])) : {}), ...process.env };
const base = (env.OPS_URL ?? 'https://yt.japharsworld.com').replace(/\/$/, '');
if (!env.STATS_TOKEN) { console.error('set STATS_TOKEN (in .env or the environment)'); process.exit(1); }

const [cmd = 'state', ...rest] = process.argv.slice(2);
const opt = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
let path;
if (cmd === 'state') path = '/ops/state';
else if (cmd === 'events') {
  const qs = new URLSearchParams();
  for (const k of ['event', 'minutes', 'limit']) if (opt(k)) qs.set(k, opt(k));
  path = `/ops/events?${qs}`;
} else { console.error('usage: node tools/ops.mjs state | events [--event a,b] [--minutes N] [--limit N]'); process.exit(1); }

const r = await fetch(base + path, { headers: { authorization: `Bearer ${env.STATS_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
const body = await r.json().catch(() => null);
if (!r.ok) { console.error(`${r.status} ${JSON.stringify(body)}`); process.exit(1); }
if (cmd === 'events') {
  console.log(`# ${body.count} events in the last ${body.minutes} min (${body.kept} kept since ${body.oldest ?? '–'})`);
  for (const e of body.events) console.log(JSON.stringify(e));
} else console.log(JSON.stringify(body, null, 1));
