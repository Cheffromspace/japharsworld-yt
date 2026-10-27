#!/usr/bin/env node
// View of the live search service (src/ops.js), for when SSH isn't available:
//   node tools/ops.mjs state
//   node tools/ops.mjs events [--event tunelio_link,build_failed] [--minutes 1440] [--limit 500]
//   node tools/ops.mjs slots                              what the player test slots hold and when their links expire
//   node tools/ops.mjs refill [--id <video>] [--force]    refill them (20 credits) and wait for the builds (~0.5–3 min)
//   node tools/ops.mjs plan [--id <video> --mode start|adaptive|direct|lower|clear] [--minutes 60]
//                                                         force a video's play plan for a while (max 240 min); no --id lists
// Needs STATS_TOKEN (from /etc/japharsworld-yt.env on the Linode) in .env or the environment; OPS_URL defaults to
// https://yt.japharsworld.com. Events print one JSON object per line.
// --staging (anywhere on the line, #160): the staging server instead, https://staging-yt.eiok.cc (OPS_STAGING_URL) with
// its own token, STATS_TOKEN_STAGING (staging's STATS_TOKEN; it can't read production).
// Errors set process.exitCode rather than calling exit(): exiting while fetch's sockets close trips a libuv
// assertion on Windows (2026-10-22).
import { readFileSync, existsSync } from 'node:fs';

const file = new URL('../.env', import.meta.url);
const env = { ...(existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')])) : {}), ...process.env };
const args = process.argv.slice(2);
const staging = args.includes('--staging');
const base = (staging ? env.OPS_STAGING_URL ?? 'https://staging-yt.eiok.cc' : env.OPS_URL ?? 'https://yt.japharsworld.com').replace(/\/$/, '');
const token = staging ? env.STATS_TOKEN_STAGING : env.STATS_TOKEN;

const [cmd = 'state', ...rest] = args.filter((a) => a !== '--staging');
const opt = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const call = async (path, method = 'GET') => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  return { status: r.status, ok: r.ok, body: await r.json().catch(() => null) };
};
const fail = (message) => { console.error(message); process.exitCode = 1; };

async function refill() {
  const qs = new URLSearchParams();
  if (opt('id')) qs.set('id', opt('id'));
  if (rest.includes('--force')) qs.set('force', '1');
  const r = await call(`/ops/slots/refill?${qs}`, 'POST');
  if (!r.ok) return fail(`${r.status} ${JSON.stringify(r.body)}`);
  console.error(r.body.already ? 'a refill is already running; waiting for it' : 'refill started; waiting for the builds');
  const until = Date.now() + 10 * 60_000;
  let s;
  do {
    await new Promise((res) => setTimeout(res, 5000));
    s = (await call('/ops/slots')).body;
  } while (s?.running && Date.now() < until);
  console.log(JSON.stringify(s, null, 1));
  if (!s?.last?.ok || s.running) process.exitCode = 1;
}

async function show() {
  let path;
  if (cmd === 'state') path = '/ops/state';
  else if (cmd === 'slots') path = '/ops/slots';
  else if (cmd === 'plan') {
    if (!opt('id')) path = '/ops/plan';
    else {
      const qs = new URLSearchParams({ id: opt('id'), mode: opt('mode') ?? 'start' });
      if (opt('minutes')) qs.set('minutes', opt('minutes'));
      const r = await call(`/ops/plan?${qs}`, 'POST');
      return r.ok ? console.log(JSON.stringify(r.body, null, 1)) : fail(`${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  else if (cmd === 'events') {
    const qs = new URLSearchParams();
    for (const k of ['event', 'minutes', 'limit']) if (opt(k)) qs.set(k, opt(k));
    path = `/ops/events?${qs}`;
  } else return fail('usage: node tools/ops.mjs state | events [--event a,b] [--minutes N] [--limit N] | slots | refill [--id X] [--force] | plan [--id X --mode M] [--minutes N]');
  const r = await call(path);
  if (!r.ok) return fail(`${r.status} ${JSON.stringify(r.body)}`);
  if (cmd === 'events') {
    console.log(`# ${r.body.count} events in the last ${r.body.minutes} min (${r.body.kept} kept since ${r.body.oldest ?? '–'})`);
    for (const e of r.body.events) console.log(JSON.stringify(e));
  } else console.log(JSON.stringify(r.body, null, 1));
}

if (!token) fail(`set ${staging ? 'STATS_TOKEN_STAGING' : 'STATS_TOKEN'} (in .env or the environment)`);
else await (cmd === 'refill' ? refill() : show());
