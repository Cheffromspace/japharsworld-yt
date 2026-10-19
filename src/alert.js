// Discord webhook alerts (the same webhook the Channels monitor uses). Each kind is sent at most once per
// quietMinutes so an outage does not flood the channel. Without a webhook, alerts only go to the log.
export function makeAlert({ webhook = '', quietMinutes = 60, fetcher = fetch, log = () => {}, now = () => Date.now() } = {}) {
  const last = new Map();
  return function alert(kind, text, quiet = quietMinutes) {
    const t = now();
    if (t - (last.get(kind) ?? -Infinity) < quiet * 60_000) return false;
    last.set(kind, t);
    log({ event: 'alert', kind, text });
    if (!webhook) return true;
    fetcher(webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Everything is OK search', content: text }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => log({ event: 'alert_failed', kind, message: String(err?.message ?? err) }));
    return true;
  };
}
