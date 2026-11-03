// Trusted client IPs (owner, 2026-11-03): the owner's home network, where this service's own tests, the desk Quest and
// the test clients share one public IP and used to hit the per-IP caps (4 builds, 3 lookup warms, 6 transcripts a
// minute, the search limit). For a trusted IP every per-IP limit is multiplied by TRUSTED_IP_FACTOR; the per-shard cap,
// the global lookup-warm cap and the hour and day spend budget stay the same for everyone, so a trusted IP can never
// spend past the budget.
//
// The list is TRUSTED_IPS, comma-separated IPv4, IPv6 and CIDR entries, from the env only: the repo is public, so an
// address never goes in code, tests or docs (tests use the documentation ranges 192.0.2.0/24 and 2001:db8::/32).

import { BlockList, isIP } from 'node:net';

// "::ffff:a.b.c.d" (an IPv4 client on a dual-stack socket) is matched as a.b.c.d.
const plain = (ip) => {
  const s = String(ip ?? '').trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
};

// → { has(ip), size, bad }: size the entries kept, bad the ones that didn't parse (ignored, so a typo can't stop the
// service; the caller logs the count).
export function trustedIps(list = '') {
  const block = new BlockList();
  let size = 0, bad = 0;
  for (const raw of String(list ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [addr, bits, extra] = entry.split('/');
    const a = plain(addr), type = isIP(a) === 4 ? 'ipv4' : isIP(a) === 6 ? 'ipv6' : null;
    const max = type === 'ipv4' ? 32 : 128;
    const prefix = bits === undefined ? max : /^\d+$/.test(bits) ? Number(bits) : NaN;
    if (!type || extra !== undefined || !(prefix >= 0 && prefix <= max)) { bad++; continue; }
    if (prefix === max) block.addAddress(a, type); else block.addSubnet(a, prefix, type);
    size++;
  }
  const has = (ip) => {
    if (!size) return false;
    const a = plain(ip), v = isIP(a);
    return v ? block.check(a, v === 4 ? 'ipv4' : 'ipv6') : false;
  };
  return { has, size, bad };
}

// The per-IP limit for this IP: `limit` times `factor` when trusted. 0 (no limit) stays 0.
export const limitFor = (limit, trusted, factor) => (trusted ? limit * Math.max(1, factor || 1) : limit);
