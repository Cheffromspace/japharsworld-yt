// YouTube refusals by class (claude/metrics.md, yt_refusal): the relay worker (relay/worker.js) sends only the class with
// a failed job, never the message, and the server counts it with this host's own (search from the Linode, its yt-dlp
// captions). Patterns from yt-dlp's and youtubei.js's error texts and the yt-dlp wiki (2026-10-25).
export const REFUSAL_CLASSES = ['bot', 'rate', 'forbidden', 'potoken', 'other'];
export const REFUSAL_WHERE = ['home', 'linode', 'staging'];
const PATTERNS = [
  ['bot', /Sign in to confirm|LOGIN_REQUIRED/i],
  ['potoken', /PO Token|po_token/i],
  ['rate', /\b429\b|Too Many Requests|try again later|This content isn.t available/i],
  ['forbidden', /status code 403\b|HTTP Error 403/i],
];

export function refusalClass(err) {
  const text = String(err?.stderr ?? '') + '\n' + String(err?.message ?? err ?? '');
  return PATTERNS.find(([, re]) => re.test(text))?.[0] ?? 'other';
}

// The home relay's Discord alert (owner, 2026-10-25): 3 or more bot/rate/potoken refusals within 15 minutes alert;
// the all-clear comes after an hour without one. add() → true when the alert should fire now; quiet() → true once
// an alert is open and the last refusal is over clearMs old.
export class RefusalWatch {
  constructor({ count = 3, windowMs = 15 * 60_000, clearMs = 60 * 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { count, windowMs, clearMs, now, times: [], open: false });
  }

  add(cls) {
    if (!['bot', 'rate', 'potoken'].includes(cls)) return false;
    const t = this.now();
    this.times = this.times.filter((x) => t - x.t < this.windowMs);
    this.times.push({ t, cls });
    this.last = t;
    if (this.times.length < this.count) return false;
    this.open = true;
    return true;
  }

  // "bot 2, rate 1" for the refusals in the window.
  summary() {
    const n = {};
    for (const { cls } of this.times) n[cls] = (n[cls] ?? 0) + 1;
    return Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ');
  }

  quiet() {
    if (!this.open || this.now() - this.last < this.clearMs) return false;
    this.open = false;
    this.times = [];
    return true;
  }
}
