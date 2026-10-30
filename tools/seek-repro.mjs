// Seek-ahead repro for home relay plays (Everything-is-OK#367): a player resuming a long video part way asks for a
// segment far past what the home upload has sent. This plays a long search result as a PC player would (NSPlayer UA,
// so the home playlist), then times seg0 and the segment at --at (fraction of the playlist, default 0.6), the way
// AVPro asks after a seek. Prints counts and timings only: no video IDs, titles or tickets.
//
//   node tools/seek-repro.mjs [--staging] [--shard 7] [--q "history documentary full"] [--min 45] [--max 90]
//                             [--quality 720p|1080p] [--at 0.6] [--ticket <n>] [--wait-done]
//
// --ticket reuses a ticket from an earlier run (printed as "ticket" for that, kept local), --wait-done then waits for
// the last segment, i.e. the whole copy, so the next run can start from the worker's cache.
import { existsSync, readFileSync } from 'node:fs';

const file = new URL('../.env', import.meta.url);
const env = { ...(existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')])) : {}), ...process.env };
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const staging = args.includes('--staging');
const base = (staging ? env.OPS_STAGING_URL ?? 'https://staging-yt.eiok.cc' : env.OPS_URL ?? 'https://yt.japharsworld.com').replace(/\/$/, '');
const shard = Number(opt('shard', 7));
const PLAYER = 'NSPlayer/12.00.26100 WMFSDK/12.00';
const WORLD = 'UnityPlayer/2022.3 (UnityWebRequest/1.0)';
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const get = (path, ua, o = {}) => fetch(path.startsWith('http') ? path : base + path, { redirect: 'manual', headers: { 'user-agent': ua, ...o.headers }, signal: AbortSignal.timeout(o.ms ?? 120_000) });

async function timed(url) {
  const s = Date.now();
  const r = await get(url, PLAYER, { headers: { range: 'bytes=0-' } }).catch((err) => ({ status: 0, err }));
  const bytes = r.status ? (await r.arrayBuffer()).byteLength : 0;
  return { status: r.status, ms: Date.now() - s, mb: Math.round(bytes / 1e4) / 100 };
}

async function main() {
  if (opt('quality')) await get(`/v1/${shard}/q/${parseInt(opt('quality'), 10)}`, WORLD); // /q/720 or /q/1080; else the room's pick
  let ticket = opt('ticket');
  if (!ticket) {
    const min = Number(opt('min', 45)) * 60, max = Number(opt('max', 90)) * 60;
    const page = await (await get(`/v1/${shard}/s?q=${encodeURIComponent(opt('q', 'history documentary full'))}`, WORLD)).json();
    const pick = page.results.find((r) => !r.live && r.seconds >= min && r.seconds <= max);
    if (!pick) throw new Error(`no result between ${min / 60} and ${max / 60} min`);
    ticket = pick.t;
    console.log(JSON.stringify({ step: 'picked', ticket, minutes: Math.round(pick.seconds / 60) }));
  }
  const play = await get(`/v1/${shard}/${ticket}`, PLAYER);
  const loc = play.headers.get('location') ?? '';
  const status = await (await get(`/v1/${shard}/${ticket}`, WORLD)).json().catch(() => ({}));
  console.log(JSON.stringify({ step: 'play', at: at(), status: play.status, home: loc.includes('/home/'), plan: status.plan, state: status.state, quality: status.quality }));
  if (!loc.includes('/home/')) throw new Error('not a home play');
  const pl = await (await get(loc, PLAYER)).text();
  const segs = pl.split('\n').filter((l) => /seg\d+\.ts$/.test(l));
  const vod = pl.includes('#EXT-X-ENDLIST');
  const n = Math.floor(segs.length * Number(opt('at', 0.6)));
  console.log(JSON.stringify({ step: 'playlist', at: at(), segments: segs.length, vod, target: n }));
  console.log(JSON.stringify({ step: 'seg0', at: at(), ...(await timed(segs[0])) }));
  // As AVPro after a seek: the far segment, asked again (each held up to the server's 20 s) until it comes or 4 tries.
  for (let i = 1; i <= 4; i++) {
    const r = await timed(segs[n]);
    console.log(JSON.stringify({ step: 'seek', try: i, at: at(), seg: n, ...r }));
    if (r.status === 200 || r.status === 206) {
      const next = await timed(segs[n + 1]);
      console.log(JSON.stringify({ step: 'seek+1', at: at(), seg: n + 1, ...next }));
      break;
    }
  }
  if (args.includes('--wait-done')) {
    for (;;) {
      const r = await timed(segs.at(-1));
      if (r.status === 200 || r.status === 206) { console.log(JSON.stringify({ step: 'done', at: at() })); break; }
      if (Date.now() - t0 > 20 * 60_000) throw new Error('not done after 20 min');
    }
  }
}
main().catch((err) => { console.error(String(err?.message ?? err)); process.exitCode = 1; });
