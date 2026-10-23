// Discord webhook alerts (the same webhook the Channels monitor uses). Each kind is sent at most once per
// quietMinutes so an outage does not flood the channel. Without a webhook, alerts only go to the log.
// alert.resolve(kind, text) sends the matching all-clear, once, only if that kind alerted since its last all-clear
// (owner, 2026-10-23: every "failed" alert should get a "restored" one); a new failure after it alerts at once.
export function makeAlert({ webhook = '', username = 'Everything is OK search', quietMinutes = 60, fetcher = fetch, log = () => {}, now = () => Date.now() } = {}) {
  const last = new Map();
  const open = new Set();
  const post = (kind, text) => {
    log({ event: 'alert', kind, text });
    if (!webhook) return;
    fetcher(webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, content: text }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => log({ event: 'alert_failed', kind, message: String(err?.message ?? err) }));
  };
  function alert(kind, text, quiet = quietMinutes) {
    const t = now();
    open.add(kind);
    if (t - (last.get(kind) ?? -Infinity) < quiet * 60_000) return false;
    last.set(kind, t);
    post(kind, text);
    return true;
  }
  alert.resolve = (kind, text) => {
    if (!open.delete(kind)) return false;
    last.delete(kind);
    post(`${kind}_ok`, text);
    return true;
  };
  return alert;
}
