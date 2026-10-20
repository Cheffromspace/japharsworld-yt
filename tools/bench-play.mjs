#!/usr/bin/env node
// Playback start-up benchmark (claude/play-latency.md). Measures what a visitor waits on after pressing Play:
//   through the service:  ticket → first answer (warm JSON as the tablet sees it, then the player's redirect), and
//                         the hold the resolver/player would have seen (by sending each client's User-Agent)
//   straight at Tunelio:  /create, then the first byte of the progressive and HLS links (cold = the build), warm
//                         again, at one or more qualities. Needs TUNELIO_API_KEY (run it on the Linode, or export it).
//
//   node tools/bench-play.mjs --search "1 hour relaxing piano" [--search "..."] [--ids ID,ID] [--quality 1080p,720p]
//                             [--formats progressive,hls] [--service https://yt.japharsworld.com] [--shard 7] [--out bench/]
//
// Writes bench/<date>-<time>.json and prints a markdown table. Video IDs stay in the file (it is a local benchmark,
// not the metrics database). Each Tunelio /create costs 10 credits per video and quality: a default run with two
// searches, two qualities, four videos is about 80 credits.
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const args = parse(process.argv.slice(2));
const service = (args.service ?? 'https://yt.japharsworld.com').replace(/\/$/, '');
const shard = Number(args.shard ?? 7);
const qualities = (args.quality ?? '1080p').split(',').map((s) => s.trim()).filter(Boolean);
const formats = (args.formats ?? 'progressive,hls').split(',').map((s) => s.trim()).filter(Boolean);
const key = process.env.TUNELIO_API_KEY ?? '';
const UA = {
  bench: 'japharsworld-yt-bench/1',
  string: 'UnityPlayer/2022.3.22f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
  ytdlp: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  avpro: 'NSPlayer/12.00.26100.1 WMFSDK/12.00.26100.1',
};

function parse(argv) {
  const out = { search: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    if (k === 'search') out.search.push(v); else out[k] = v;
  }
  return out;
}

async function timed(url, { ua = UA.bench, range = null, redirect = 'manual', timeoutMs = 180_000, headers = {} } = {}) {
  const t0 = performance.now();
  const h = { 'user-agent': ua, ...headers };
  if (range) h.range = range;
  try {
    const res = await fetch(url, { headers: h, redirect, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Math.round(performance.now() - t0);
    const type = res.headers.get('content-type') ?? '';
    let body = null;
    if (type.includes('json')) body = await res.json().catch(() => null);
    else { try { await res.body?.cancel(); } catch { /* ignore */ } }
    return { ms, status: res.status, location: res.headers.get('location'), type, body };
  } catch (err) {
    return { ms: Math.round(performance.now() - t0), status: 0, error: String(err?.message ?? err) };
  }
}

async function search(q) {
  const r = await timed(`${service}/v1/${shard}/s?l=en&q=${encodeURIComponent('bench → ' + q)}`, { timeoutMs: 40_000 });
  if (!r.body?.results) throw new Error(`search failed: ${r.status} ${r.error ?? ''}`);
  return r.body.results.filter((v) => !v.live && v.seconds > 0);
}

// Through the service, as the world would: tablet warm, then poll until ready, then the player clients.
async function viaService(video) {
  const url = `${service}/v1/${shard}/${video.t}`;
  const out = { ticket: video.t };
  const warm = await timed(url, { ua: UA.string, timeoutMs: 30_000 });
  out.warm = { ms: warm.ms, state: warm.body?.state, eta: warm.body?.eta, format: warm.body?.format };
  const t0 = performance.now();
  let st = warm.body;
  while (st && st.state === 'building' && performance.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 2000));
    st = (await timed(url, { ua: UA.string, timeoutMs: 30_000 })).body;
  }
  out.buildMs = Math.round(performance.now() - t0 + warm.ms);
  out.finalState = st?.state;
  const y = await timed(url, { ua: UA.ytdlp, timeoutMs: 30_000 });
  out.resolver = { ms: y.ms, status: y.status, redirected: Boolean(y.location) };
  const a = await timed(url, { ua: UA.avpro, timeoutMs: 120_000 });
  out.player = { ms: a.ms, status: a.status, redirected: Boolean(a.location) };
  if (a.location) {
    const fb = await timed(a.location, { range: 'bytes=0-0' });
    out.firstByte = { ms: fb.ms, status: fb.status };
  }
  return out;
}

// Straight at Tunelio: the cost of each format and quality from cold.
async function viaTunelio(id, quality) {
  const c = await timed(`https://tunelio.dev/create?${new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, quality })}`,
    { headers: { authorization: `Bearer ${key}` }, timeoutMs: 30_000 });
  const out = { quality, createMs: c.ms, createStatus: c.status };
  if (!c.body?.url) { out.error = c.body?.status ?? c.error ?? `http ${c.status}`; return out; }
  out.quality = c.body.quality ?? quality;
  out.fileMb = Math.round((c.body.file_size ?? 0) / 1e5) / 10;
  for (const f of formats) {
    const link = `${c.body.url}&${f}=1`;
    const cold = await timed(link, { range: 'bytes=0-0' });
    const warm = await timed(link, { range: 'bytes=0-0', timeoutMs: 60_000 });
    out[f] = { coldMs: cold.ms, coldStatus: cold.status, warmMs: warm.ms, warmStatus: warm.status };
  }
  return out;
}

const fmtS = (ms) => ms == null ? '–' : (ms / 1000).toFixed(1) + ' s';

async function main() {
  const videos = [];
  for (const q of args.search) {
    const r = await search(q);
    // one short, one medium, one long per search when available
    for (const [lo, hi] of [[300, 1800], [1800, 5400], [5400, 36000]]) {
      const v = r.find((x) => x.seconds >= lo && x.seconds < hi && !videos.some((y) => y.id === x.id));
      if (v) videos.push(v);
    }
  }
  for (const id of (args.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean)) videos.push({ id, title: id, seconds: 0, t: null });
  if (!videos.length) { console.error('nothing to measure: pass --search or --ids'); process.exit(2); }
  const started = new Date();
  const results = [];
  for (const v of videos) {
    const row = { id: v.id, title: v.title, seconds: v.seconds };
    console.error(`• ${v.title} (${v.seconds} s)`);
    if (v.t != null) { row.service = await viaService(v); console.error(`   service: build ${fmtS(row.service.buildMs)}, resolver ${row.service.resolver.status} in ${fmtS(row.service.resolver.ms)}, player ${row.service.player.status} in ${fmtS(row.service.player.ms)}`); }
    if (key) {
      row.tunelio = [];
      for (const q of qualities) { const r = await viaTunelio(v.id, q); row.tunelio.push(r); console.error(`   tunelio ${q}: ${formats.map((f) => `${f} cold ${fmtS(r[f]?.coldMs)} / warm ${fmtS(r[f]?.warmMs)}`).join(', ')}${r.error ? ' ' + r.error : ''}`); }
    }
    results.push(row);
  }
  const out = { at: started.toISOString(), service, shard, qualities, formats, results };
  mkdirSync(args.out ?? 'bench', { recursive: true });
  const file = `${args.out ?? 'bench'}/${started.toISOString().replace(/[:T]/g, '-').slice(0, 16)}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  const head = ['Video', 'Length', ...(results.some((r) => r.service) ? ['Service build', 'Resolver', 'Player', 'First byte'] : []),
    ...(key ? qualities.flatMap((q) => formats.map((f) => `${q} ${f} cold/warm`)) : [])];
  console.log(`| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |`);
  for (const r of results) {
    const cells = [r.title.slice(0, 40).replace(/\|/g, '/'), `${Math.round(r.seconds / 60)} min`];
    if (r.service) cells.push(fmtS(r.service.buildMs), `${r.service.resolver.status} ${fmtS(r.service.resolver.ms)}`, `${r.service.player.status} ${fmtS(r.service.player.ms)}`, fmtS(r.service.firstByte?.ms));
    if (key) for (const q of qualities) { const t = r.tunelio.find((x) => x.quality === q || x.quality?.startsWith(q.replace('p', ''))) ?? r.tunelio[qualities.indexOf(q)]; for (const f of formats) cells.push(t?.[f] ? `${fmtS(t[f].coldMs)} / ${fmtS(t[f].warmMs)}` : (t?.error ?? '–')); }
    console.log(`| ${cells.join(' | ')} |`);
  }
  console.log(`\nSaved ${file}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
