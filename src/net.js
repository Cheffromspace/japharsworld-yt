// Bytes a host has sent, for the transfer alerts (owner, 2026-10-24: home 50 GB a day and 500 GB a month, the Linode
// 700 GB a month of its 1 TB). Grafana Cloud keeps 14 days, so the month comes from metrics.db (metric `transfer`):
// the search service counts the Linode's own bytes and the home worker reports its counter on each poll (relay/worker.js).
import { readFileSync } from 'node:fs';

// Transmitted bytes summed over every interface but loopback, from /proc/net/dev; null where there is none (Windows).
export function txBytes(text = null) {
  let s = text;
  if (s == null) { try { s = readFileSync('/proc/net/dev', 'utf8'); } catch { return null; } }
  let total = 0, seen = false;
  for (const line of s.split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length < 9 || !Number.isFinite(f[8])) continue;
    total += f[8];
    seen = true;
  }
  return seen ? total : null;
}

// Successive counter readings → MB sent since the last one. The first reading, and one far below the last (a reboot
// reset the counter), only set the baseline: at most one interval is lost. A slightly lower one is a stale reading
// (the worker's parallel polls can arrive out of order) and is ignored.
export class TxDelta {
  constructor() { this.last = new Map(); }
  mb(source, bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return 0;
    const prev = this.last.get(source);
    if (prev != null && bytes < prev && bytes > prev / 2) return 0;
    this.last.set(source, bytes);
    if (prev == null || bytes < prev) return 0;
    return (bytes - prev) / 1e6;
  }
}
