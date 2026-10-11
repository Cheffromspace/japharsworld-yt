// Ticket pools. The world bakes https://<host>/v1/<shard>/<n> for n in [0, pool) and every shard.
// A ticket is a reusable claim check: each search binds the next free tickets to its videos,
// thumbnail sheet and next page. Tickets are handed out round-robin, so the oldest unplayed ones
// are reused first. A video ticket that has been played is pinned (skipped) for pinHours so that
// late joiners who load the synced ticket still get the same video.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor({ path, shards, pool, pinHours, now = () => Date.now() }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
    this.shards = shards;
    this.pool = pool;
    this.pinMs = pinHours * 3600_000;
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        shard INTEGER NOT NULL, n INTEGER NOT NULL,
        kind TEXT NOT NULL, data TEXT NOT NULL,
        created INTEGER NOT NULL, pinned_until INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (shard, n));
      CREATE TABLE IF NOT EXISTS cursors (shard INTEGER PRIMARY KEY, next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS played (
        shard INTEGER PRIMARY KEY, n INTEGER NOT NULL, video_id TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS captions (
        video_id TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, fetched INTEGER NOT NULL,
        PRIMARY KEY (video_id, key));
    `);
    this.q = {
      cursor: this.db.prepare('SELECT next FROM cursors WHERE shard = ?'),
      setCursor: this.db.prepare('INSERT INTO cursors (shard, next) VALUES (?, ?) ON CONFLICT(shard) DO UPDATE SET next = excluded.next'),
      pinned: this.db.prepare('SELECT pinned_until FROM tickets WHERE shard = ? AND n = ?'),
      put: this.db.prepare(`INSERT INTO tickets (shard, n, kind, data, created, pinned_until) VALUES (?, ?, ?, ?, ?, 0)
        ON CONFLICT(shard, n) DO UPDATE SET kind = excluded.kind, data = excluded.data, created = excluded.created, pinned_until = 0`),
      get: this.db.prepare('SELECT kind, data, created, pinned_until FROM tickets WHERE shard = ? AND n = ?'),
      pin: this.db.prepare('UPDATE tickets SET pinned_until = ? WHERE shard = ? AND n = ?'),
      setPlayed: this.db.prepare(`INSERT INTO played (shard, n, video_id, at) VALUES (?, ?, ?, ?)
        ON CONFLICT(shard) DO UPDATE SET n = excluded.n, video_id = excluded.video_id, at = excluded.at`),
      getPlayed: this.db.prepare('SELECT n, video_id, at FROM played WHERE shard = ?'),
      capGet: this.db.prepare('SELECT json, fetched FROM captions WHERE video_id = ? AND key = ?'),
      capPut: this.db.prepare(`INSERT INTO captions (video_id, key, json, fetched) VALUES (?, ?, ?, ?)
        ON CONFLICT(video_id, key) DO UPDATE SET json = excluded.json, fetched = excluded.fetched`),
      capPrune: this.db.prepare('DELETE FROM captions WHERE fetched < ?'),
    };
  }

  validShard(shard) { return Number.isInteger(shard) && shard >= 0 && shard < this.shards; }
  validTicket(n) { return Number.isInteger(n) && n >= 0 && n < this.pool; }

  // items: [{ kind, data }] → ticket numbers, in order.
  allocate(shard, items) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = this.#allocate(shard, items);
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  #allocate(shard, items) {
    const now = this.now();
    let next = this.q.cursor.get(shard)?.next ?? 0;
    const out = [];
    let scanned = 0;
    for (const item of items) {
      for (;;) {
        if (scanned++ > this.pool) throw new Error(`shard ${shard} has no free tickets`);
        const n = next;
        next = (next + 1) % this.pool;
        const row = this.q.pinned.get(shard, n);
        if (row && row.pinned_until > now) continue;
        this.q.put.run(shard, n, item.kind, JSON.stringify(item.data), now);
        out.push(n);
        break;
      }
    }
    this.q.setCursor.run(shard, next);
    return out;
  }

  get(shard, n) {
    const row = this.q.get.get(shard, n);
    if (!row) return null;
    return { kind: row.kind, data: JSON.parse(row.data), created: row.created, pinnedUntil: row.pinned_until };
  }

  // Called whenever a video ticket is loaded (every client that plays it resolves it).
  markPlayed(shard, n, videoId) {
    const now = this.now();
    this.q.pin.run(now + this.pinMs, shard, n);
    this.q.setPlayed.run(shard, n, videoId, now);
  }

  lastPlayed(shard) {
    const row = this.q.getPlayed.get(shard);
    return row ? { n: row.n, videoId: row.video_id, at: row.at } : null;
  }

  captionGet(videoId, key, maxAgeMs) {
    const row = this.q.capGet.get(videoId, key);
    if (!row || this.now() - row.fetched > maxAgeMs) return null;
    return JSON.parse(row.json);
  }
  captionPut(videoId, key, value) { this.q.capPut.run(videoId, key, JSON.stringify(value), this.now()); }
  pruneCaptions(maxAgeMs) { this.q.capPrune.run(this.now() - maxAgeMs); }

  close() { this.db.close(); }
}
