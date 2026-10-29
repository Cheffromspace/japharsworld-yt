"""SQLite log: slots, streams, checks, probes (resolution), flash results, events, jobs, quota."""
import json, os, sqlite3, time

SCHEMA = """
CREATE TABLE IF NOT EXISTS slots (
  key TEXT PRIMARY KEY,
  idx INTEGER,                  -- position in channels.json = thumbnail cell
  playlist TEXT,                -- owner's unlisted playlist (NULL = the world bakes the stream URL itself)
  baked_video TEXT,             -- video the slot's url names
  current_video TEXT,           -- what the slot plays now (the playlist's first item)
  kind TEXT,                    -- live | video | unmanaged
  category TEXT, title TEXT, channel TEXT, channel_id TEXT,
  baked_hidden INTEGER,         -- hidden unless the monitor shows it: overrides.json hidden if set, else channels.json
  auto_hidden INTEGER DEFAULT 0,  -- hidden by the monitor (down, flash fail, waiting for a check)
  auto_reason TEXT,
  down_since REAL, misses INTEGER DEFAULT 0,
  next_discovery REAL DEFAULT 0,
  updated REAL
);
CREATE TABLE IF NOT EXISTS streams (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT, channel TEXT, title TEXT,
  kind TEXT,                    -- live | video
  started_at REAL, ended_at REAL,
  first_seen REAL, last_seen REAL, last_status TEXT,
  height INTEGER, height_at REAL, format_id TEXT,
  flash_verdict TEXT, flash_max INTEGER, flash_at REAL,
  rejected TEXT                 -- why it can't be a replacement
);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY, ts REAL, slot_key TEXT, video_id TEXT,
  status TEXT,                  -- live | ended | upcoming | video | unavailable | error
  height INTEGER,               -- latest probe of this video (probes are daily; see probes.ts)
  started_at REAL, viewers INTEGER, title TEXT, channel_id TEXT, channel TEXT,
  source TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS checks_slot ON checks(slot_key, ts);
CREATE TABLE IF NOT EXISTS probes (
  id INTEGER PRIMARY KEY, ts REAL, video_id TEXT, live_status TEXT, height INTEGER, format_id TEXT,
  runner TEXT, source TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS flash (
  id INTEGER PRIMARY KEY, ts REAL, video_id TEXT, slot_key TEXT, verdict TEXT, max_fps INTEGER,
  regions TEXT, frames INTEGER, mean_luminance REAL, runner TEXT, source TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, ts REAL, slot_key TEXT, kind TEXT, video_id TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, created REAL, video_id TEXT, slot_key TEXT,
  reason TEXT,                  -- new | daily | candidate | manual
  claimed REAL, runner TEXT, done REAL, result TEXT
);
CREATE TABLE IF NOT EXISTS quota (day TEXT, ts REAL, units INTEGER, what TEXT);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""


def connect(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    con = sqlite3.connect(path, timeout=60)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    return con


def get_meta(con, k, default=None):
    r = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return json.loads(r["v"]) if r else default


def set_meta(con, k, v):
    con.execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v)))


def event(con, slot_key, kind, video_id=None, detail=""):
    con.execute("INSERT INTO events(ts,slot_key,kind,video_id,detail) VALUES(?,?,?,?,?)",
                (time.time(), slot_key, kind, video_id, detail))


def upsert_stream(con, vid, **f):
    now = time.time()
    if con.execute("SELECT 1 FROM streams WHERE video_id=?", (vid,)).fetchone() is None:
        con.execute("INSERT INTO streams(video_id, first_seen) VALUES(?,?)", (vid, f.pop("first_seen", now)))
    f = {k: v for k, v in f.items() if v is not None}
    if f:
        con.execute("UPDATE streams SET " + ",".join(k + "=?" for k in f) + " WHERE video_id=?", (*f.values(), vid))


def stream(con, vid):
    return con.execute("SELECT * FROM streams WHERE video_id=?", (vid,)).fetchone()
