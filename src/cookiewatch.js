// The home relay's throwaway-account cookies, as the server sees them (Everything-is-OK#575): each worker poll carries
// a state word (relay/cookies.js: none, ok, dead), never the cookies. Discord asks the owner for a new sign-in
// (README, "Home relay cookies") when YouTube bot-walls the home relay and there are no working cookies to retry with,
// and says when working cookies stopped working; both at most once per `hours` (owner, 2026-11-06: reminders on their
// own, as well as the owner's own sign-ins). A worker that sends no word (staging's, which has none) is left out.
const STATES = ['none', 'ok', 'dead'];

export class CookieWatch {
  constructor({ alert = () => false, hours = 12, log = () => {} } = {}) {
    Object.assign(this, { alert, hours, log });
    this.states = new Map(); // worker → none|ok|dead
  }

  set(worker, state) {
    if (!STATES.includes(state)) return;
    const before = this.states.get(worker);
    this.states.set(worker, state);
    if (before === state) return;
    this.log({ event: 'cookies', worker, from: before ?? null, to: state });
    if (!this.hours) return;
    if (before === 'ok' && state === 'dead') {
      this.alert('cookies_dead', 'The home relay\'s YouTube cookies no longer work: a retry with them was bot-walled too. Sign the throwaway account in again (README, "Home relay cookies").', this.hours * 60);
    } else if (state === 'ok') {
      this.alert.resolve?.('cookies_dead', 'The home relay has working YouTube cookies again.');
      this.alert.resolve?.('cookies_missing', 'The home relay has YouTube cookies now.');
    }
  }

  // A bot or PO-token refusal at the home relay (src/server.js refused()).
  refused(cls) {
    if (!this.hours || (cls !== 'bot' && cls !== 'potoken')) return false;
    const missing = [...this.states.values()].find((s) => s === 'none' || s === 'dead');
    if (!missing) return false;
    return this.alert('cookies_missing', `YouTube bot-walled the home relay and it has ${missing === 'dead' ? 'only cookies that no longer work' : 'no cookies'} to retry with. Sign the throwaway account in (README, "Home relay cookies"); never the main account.`, this.hours * 60);
  }

  state() { return Object.fromEntries(this.states); }
}
