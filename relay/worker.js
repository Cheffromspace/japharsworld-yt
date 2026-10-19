// Search relay worker (runs at home, on the owner's Optiplex). It never listens on a port: it long-polls
// RELAY_URL/relay/next over HTTPS for search jobs, runs them through InnerTube from this residential connection
// (src/youtube.js, so videos come out exactly as on the server) and posts the results to RELAY_URL/relay/done.
// Settings (environment, /etc/japharsworld-yt-relay.env): RELAY_URL, RELAY_TOKEN, WORKER_NAME, RELAY_POLLS (3).
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { youtube as defaultYoutube, resetClient } from '../src/youtube.js';

const CONT_MINUTES = 30;
const MAX_CONTS = 2000;
const is403 = (err) => /status code 403\b/.test(String(err?.message ?? err));

export function createWorker({ url, token, name = 'worker', version = '', polls = 3, youtube = defaultYoutube, reset = resetClient,
  fetcher = fetch, log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o })), now = () => Date.now(),
  sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); }) }) {
  const base = String(url).replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${token}` };
  const conts = new Map(); // id → { more, at }
  const stopping = new AbortController();

  function keep(more) {
    if (!more) return null;
    const t = now();
    for (const [k, v] of conts) if (t - v.at > CONT_MINUTES * 60_000) conts.delete(k); else break;
    const id = randomUUID();
    conts.set(id, { more, at: t });
    while (conts.size > MAX_CONTS) conts.delete(conts.keys().next().value);
    return id;
  }

  async function once(fn) {
    try { return await fn(); } catch (err) {
      if (!is403(err)) throw err;
      reset?.();
      return fn();
    }
  }

  // Job → { id, ok, page: { videos, cont }, error }
  async function handle(job) {
    const started = now();
    try {
      let page;
      if (job.kind === 'search') page = await once(() => youtube.search(String(job.query ?? ''), Math.min(50, Number(job.limit) || 20)));
      else if (job.kind === 'more') {
        const c = conts.get(job.cont);
        if (!c || now() - c.at > CONT_MINUTES * 60_000) { conts.delete(job.cont); return { id: job.id, ok: false, error: 'expired' }; }
        conts.delete(job.cont);
        page = await c.more();
      } else return { id: job.id, ok: false, error: `unknown job kind ${job.kind}` };
      log({ event: 'job', kind: job.kind, ms: now() - started, results: page.videos.length });
      return { id: job.id, ok: true, page: { videos: page.videos, cont: keep(page.more) } };
    } catch (err) {
      const message = String(err?.message ?? err).slice(0, 300);
      log({ event: 'job_failed', kind: job.kind, ms: now() - started, message });
      return { id: job.id, ok: false, error: message };
    }
  }

  async function loop(n) {
    let backoff = 1000;
    const q = new URLSearchParams({ worker: name, version });
    while (!stopping.signal.aborted) {
      try {
        const res = await fetcher(`${base}/relay/next?${q}`, { headers, signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(40_000)]) });
        if (res.status === 204) { backoff = 1000; continue; }
        if (res.status === 401) throw new Error('relay refused the token (401)');
        if (!res.ok) throw new Error(`relay answered ${res.status}`);
        const { job } = await res.json();
        backoff = 1000;
        if (!job) continue;
        const result = await handle(job);
        const sent = await fetcher(`${base}/relay/done`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(result), signal: AbortSignal.timeout(15_000) });
        if (!sent.ok) log({ event: 'done_failed', status: sent.status });
      } catch (err) {
        if (stopping.signal.aborted) break;
        log({ event: 'poll_failed', poll: n, retryMs: backoff, message: String(err?.message ?? err).slice(0, 200) });
        await sleep(backoff, stopping.signal);
        backoff = Math.min(30_000, backoff * 2);
      }
    }
  }

  return {
    handle, conts,
    start() { log({ event: 'start', worker: name, version, relay: base, polls }); return Promise.all(Array.from({ length: polls }, (_, i) => loop(i))); },
    stop() { stopping.abort(); },
  };
}

function gitVersion() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { RELAY_URL, RELAY_TOKEN, WORKER_NAME = 'worker', RELAY_POLLS = '3' } = process.env;
  if (!RELAY_URL || !RELAY_TOKEN) { console.error('Set RELAY_URL and RELAY_TOKEN.'); process.exit(2); }
  const worker = createWorker({ url: RELAY_URL, token: RELAY_TOKEN, name: WORKER_NAME, version: gitVersion(), polls: Number(RELAY_POLLS) || 3 });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { worker.stop(); setTimeout(() => process.exit(0), 500).unref(); });
  worker.start();
}
