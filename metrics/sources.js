// Daily sources for the poller: Tunelio's balance (free call) and GitHub repo numbers.
// GitHub keeps traffic for 14 days only, so each day's views/clones are stored as they arrive.

export async function tunelioCredits({ key, base = 'https://tunelio.dev', fetcher = fetch }) {
  if (!key) return null;
  const res = await fetcher(`${base}/credits`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`tunelio /credits ${res.status}`);
  const b = await res.json();
  return { credits: Number(b.credits), plan: String(b.plan ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) };
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

// → { repo, values: { stars, forks, watchers, release_downloads }, traffic: [{ day, metric, value }] }
export async function githubRepo({ repo, token = '', userAgent, fetcher = fetch }) {
  if (!REPO.test(repo)) throw new Error(`bad repo name ${repo}`);
  const get = async (path) => {
    const res = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': userAgent,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status === 403) return null; // private without a token, or no traffic permission
    if (!res.ok) throw new Error(`github ${path || '/'} ${res.status}`);
    return res.json();
  };
  const info = await get('');
  if (!info) return null;
  const releases = (await get('/releases?per_page=100')) ?? [];
  const values = {
    stars: info.stargazers_count, forks: info.forks_count, watchers: info.subscribers_count,
    release_downloads: releases.reduce((s, r) => s + (r.assets ?? []).reduce((a, x) => a + (x.download_count ?? 0), 0), 0),
  };
  const traffic = [];
  if (token) {
    const views = await get('/traffic/views');
    for (const v of views?.views ?? []) traffic.push({ day: v.timestamp.slice(0, 10), metric: 'gh_views', value: v.count }, { day: v.timestamp.slice(0, 10), metric: 'gh_view_uniques', value: v.uniques });
    const clones = await get('/traffic/clones');
    for (const c of clones?.clones ?? []) traffic.push({ day: c.timestamp.slice(0, 10), metric: 'gh_clones', value: c.count }, { day: c.timestamp.slice(0, 10), metric: 'gh_clone_uniques', value: c.uniques });
  }
  return { repo: repo.split('/')[1], values, traffic };
}
