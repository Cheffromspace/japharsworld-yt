// The home relay's throwaway-account cookies, as the server sees them (Everything-is-OK#575): each worker poll carries
// a state word (relay/cookies.js: none, ok, dead), never the cookies. Discord asks the owner for a new sign-in
// (README, "Home relay cookies") when working cookies stop working, or when YouTube bot-walls the home relay and there
// are no working cookies to retry with: one alert kind, so one message per `hours` whichever comes first, and an
// all-clear once a worker reports working cookies. A worker that sends no word (staging's, which has none) is left out,
// and one that hasn't polled for `staleMs` is forgotten.
const STATES = ['none', 'ok', 'dead'];

export class CookieWatch {
  constructor({ alert = () => false, hours = 12, staleMs = 10 * 60_000, log = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { alert, hours, staleMs, log, now });
    this.states = new Map(); // worker → { state, seen }
  }

  #fresh() {
    const t = this.now();
    for (const [w, v] of this.states) if (t - v.seen > this.staleMs) this.states.delete(w);
    return [...this.states.values()].map((v) => v.state);
  }

  #ask(state) {
    if (!this.hours) return false;
    const text = state === 'dead'
      ? 'The home relay\'s YouTube cookies no longer work: a retry with them was bot-walled too. Sign the throwaway account in again on the PC and install the cookies on the Optiplex (README, "Home relay cookies"); never the main account.'
      : 'YouTube bot-walled the home relay and it has no cookies to retry with. Sign the throwaway account in on the PC and install the cookies on the Optiplex (README, "Home relay cookies"); never the main account.';
    return this.alert('cookies_missing', text, this.hours * 60);
  }

  set(worker, state) {
    if (!STATES.includes(state)) return;
    const before = this.states.get(worker)?.state;
    this.states.set(worker, { state, seen: this.now() });
    if (before === state) return;
    this.log({ event: 'cookies', worker, from: before ?? null, to: state });
    if (before === 'ok' && state === 'dead') this.#ask('dead');
    else if (state === 'ok') this.alert.resolve?.('cookies_missing', 'The home relay has working YouTube cookies.');
  }

  // A refusal at the home relay (src/server.js refused()). Only a bot wall asks for a sign-in: a PO-token wall is not
  // something fresh cookies fix (relay/cookies.js marks them dead on a bot wall only, too).
  refused(cls) {
    if (cls !== 'bot') return false;
    const states = this.#fresh();
    if (states.includes('ok')) return false; // working cookies: the worker's retry handles it
    const missing = states.find((s) => s === 'none' || s === 'dead');
    return missing ? this.#ask(missing) : false;
  }

  state() { this.#fresh(); return Object.fromEntries([...this.states].map(([w, v]) => [w, v.state])); }
}
