// Where a search runs, in order: a relay worker (residential IP), this server's own InnerTube session (retried once
// with a fresh session after a 403), then the YouTube Data API (only with a key). Throws when all of them fail.
// Every page carries `via` ("worker" | "local" | "api"); its `more` continues on the same path.
import { refusalClass } from './refusal.js';

const is403 = (err) => /status code 403\b/.test(String(err?.message ?? err));
const short = (err) => String(err?.message ?? err).slice(0, 300);

export function makeSearch({ relay, youtube, api, alert = () => {}, log = () => {}, workerTimeoutMs = 8000, refused = () => {} }) {
  const state = { lastVia: null };

  async function local(query, limit) {
    try {
      return await youtube.search(query, limit);
    } catch (err) {
      if (!is403(err)) throw err;
      log({ event: 'search_retry', via: 'local', message: short(err) });
      youtube.resetClient?.();
      return youtube.search(query, limit);
    }
  }

  async function search(query, limit) {
    const started = Date.now();
    const attempts = [];
    if (relay?.enabled && relay.online('search').length) attempts.push(['worker', () => relay.search(query, limit, { timeoutMs: workerTimeoutMs })]);
    attempts.push(['local', () => local(query, limit)]);
    if (api?.enabled) attempts.push(['api', () => api.search(query, limit)]);
    let last;
    for (const [via, run] of attempts) {
      const t = Date.now();
      try {
        const page = await run();
        if (via === 'api') alert('api_fallback', 'YouTube search fell back to the Data API (worker and Linode both failed).');
        state.lastVia = via;
        log({ event: 'search', via, worker: page.worker, ms: Date.now() - started, results: page.videos.length });
        return { ...page, via };
      } catch (err) {
        last = err;
        // The worker's own refusals arrive with its answer (src/server.js /relay/done); here only this server's.
        if (via === 'local') refused('linode', refusalClass(err));
        log({ event: 'youtube_error', via, ms: Date.now() - t, message: short(err) });
      }
    }
    log({ event: 'search', via: null, ms: Date.now() - started, failed: true });
    throw last;
  }

  return { search, state };
}
