"""One monitor pass: check every slot's stream, react to outages, apply job results, publish."""
import datetime as dt, difflib, json, os, time

from . import config, db, discord, publish
from .youtube import Api, QuotaExceeded, channel_live_ids, video_id, watch_status

LIVE_WORDS = ("24/7", "24 / 7", "24hr", "24 hours", "24h", "radio", "live cam", "live camera", "livecam", "webcam")
REASON_ORDER = {"candidate": 0, "manual": 1, "new": 2, "daily": 3}


def now():
    return time.time()


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def load_slots():
    return load_json(config.CHANNELS, {"slots": []})["slots"]


def load_overrides():
    return load_json(config.OVERRIDES, {})


def label(row):
    return "**%s** (`%s`)" % (row["title"] or row["key"], row["key"])


def yt(vid):
    return "https://youtu.be/%s" % vid if vid else "-"


# ---------- slots ----------

def sync_slots(con, slots, overrides):
    ov = overrides.get("slots", {})
    seen = set()
    for i, s in enumerate(slots):
        key = s["key"]
        seen.add(key)
        url = s.get("url") or ""
        baked = video_id(url) if "list=" not in url else None
        kind = ov.get(key, {}).get("kind") or ("live" if (baked or s.get("playlist")) else "unmanaged")
        row = con.execute("SELECT * FROM slots WHERE key=?", (key,)).fetchone()
        if row is None:
            con.execute("INSERT INTO slots(key, current_video, updated) VALUES(?,?,?)", (key, baked, now()))
            row = con.execute("SELECT * FROM slots WHERE key=?", (key,)).fetchone()
        cur = row["current_video"]
        if row["baked_video"] and baked and baked != row["baked_video"] and cur == row["baked_video"]:
            cur = baked  # channels.json now names a different stream (the owner changed the list)
        con.execute("UPDATE slots SET idx=?, playlist=?, baked_video=?, current_video=?, kind=?, category=?, title=?, channel=?, baked_hidden=? WHERE key=?",
                    (i, s.get("playlist"), baked, cur or baked, kind, s.get("category"), s.get("title"), s.get("channel"),
                     1 if s.get("hidden") else 0, key))
    for r in con.execute("SELECT key FROM slots").fetchall():
        if r["key"] not in seen:
            con.execute("UPDATE slots SET idx=NULL, kind='removed' WHERE key=?", (r["key"],))
    con.commit()


def slot_rows(con):
    return {r["key"]: r for r in con.execute("SELECT * FROM slots WHERE idx IS NOT NULL ORDER BY idx")}


def is_shown(row, overrides):
    o = overrides.get("slots", {}).get(row["key"], {})
    return not bool(o.get("hidden", bool(row["baked_hidden"])))


# ---------- status ----------

def statuses(con, api, ids):
    out = {}
    if api.can_read:
        try:
            out = api.videos(ids)
        except QuotaExceeded as e:
            discord.send(con, "Quota: falling back to page checks", str(e), "warn", dedupe="quota-fallback", every_hours=12)
        except Exception as e:
            discord.send(con, "YouTube API failed; using page checks", str(e)[:500], "warn", dedupe="api-error", every_hours=6)
    for vid in ids:
        if vid not in out:
            out[vid] = watch_status(vid)
            time.sleep(0.4)
    return out


def record_check(con, row, st):
    s = db.stream(con, st["video_id"])
    started = st.get("started_at")
    if s and s["started_at"] and started and st.get("started_precision") != "exact":
        started = None  # keep the exact time we already have
    db.upsert_stream(con, st["video_id"], channel_id=st.get("channel_id"), channel=st.get("channel"), title=st.get("title"),
                     kind=("video" if st.get("status") == "video" else "live") if st.get("status") in ("video", "live") else None,
                     started_at=started, last_seen=now(), last_status=st.get("status"),
                     ended_at=now() if st.get("status") == "ended" and not (s and s["ended_at"]) else None)
    s = db.stream(con, st["video_id"])
    con.execute("INSERT INTO checks(ts,slot_key,video_id,status,height,started_at,viewers,title,channel_id,channel,source,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (now(), row["key"], st["video_id"], st.get("status"), s["height"], s["started_at"], st.get("viewers"),
                 st.get("title"), st.get("channel_id"), st.get("channel"), st.get("source"), st.get("error")))
    if st.get("channel_id") and not row["channel_id"]:
        con.execute("UPDATE slots SET channel_id=? WHERE key=?", (st["channel_id"], row["key"]))


def queue_job(con, vid, slot_key, reason):
    if con.execute("SELECT 1 FROM jobs WHERE video_id=? AND done IS NULL", (vid,)).fetchone():
        return False
    con.execute("INSERT INTO jobs(created,video_id,slot_key,reason) VALUES(?,?,?,?)", (now(), vid, slot_key, reason))
    return True


def check_pass(con, api, overrides):
    rows = [r for r in slot_rows(con).values() if r["kind"] in ("live", "video") and r["current_video"]]
    sts = statuses(con, api, [r["current_video"] for r in rows])
    for row in rows:
        st = sts[row["current_video"]]
        record_check(con, row, st)
        status = st.get("status")
        if status == "error":
            continue
        ok = status == "live" if row["kind"] == "live" else status in ("video", "live")
        shown = is_shown(row, overrides)
        if ok:
            con.execute("UPDATE slots SET misses=0 WHERE key=?", (row["key"],))
            if row["down_since"]:
                con.execute("UPDATE slots SET down_since=NULL WHERE key=?", (row["key"],))
                db.event(con, row["key"], "recovered", row["current_video"])
                if row["auto_reason"] == "down":
                    con.execute("UPDATE slots SET auto_hidden=0, auto_reason=NULL WHERE key=?", (row["key"],))
                if shown:
                    discord.send(con, "Back up: %s" % (row["title"] or row["key"]), "%s is live again: %s" % (label(row), yt(row["current_video"])), "good")
            s = db.stream(con, row["current_video"])
            if row["kind"] == "live" and s["flash_at"] is None:
                queue_job(con, row["current_video"], row["key"], "new")
        else:
            misses = (row["misses"] or 0) + 1
            con.execute("UPDATE slots SET misses=? WHERE key=?", (misses, row["key"]))
            if status in ("ended", "unavailable") or misses >= 2:
                handle_down(con, api, con.execute("SELECT * FROM slots WHERE key=?", (row["key"],)).fetchone(), st, shown)
    con.commit()


# ---------- outages and replacements ----------

def handle_down(con, api, row, st, shown):
    if not row["down_since"]:
        con.execute("UPDATE slots SET down_since=?, auto_hidden=1, auto_reason='down' WHERE key=?", (now(), row["key"]))
        db.event(con, row["key"], "down", row["current_video"], "%s %s" % (st.get("status"), st.get("error") or ""))
        if shown:
            discord.send(con, "Stream down: %s" % (row["title"] or row["key"]),
                         "%s: %s is **%s**%s. Hidden in sleep-list.json; looking for a replacement on the same channel."
                         % (label(row), yt(row["current_video"]), st.get("status"), (" (%s)" % st["error"]) if st.get("error") else ""), "warn")
        row = con.execute("SELECT * FROM slots WHERE key=?", (row["key"],)).fetchone()
    if row["kind"] == "live":
        find_replacement(con, api, row, shown)


def similar(a, b):
    return difflib.SequenceMatcher(None, (a or "").lower(), (b or "").lower()).ratio()


def judge_candidate(con, old, st):
    """None if acceptable (pending resolution + flash check), else the reason it is not."""
    text = ("%s %s" % (st.get("title") or "", st.get("channel") or "")).lower()
    if any(w in text for w in config.BANNED_WORDS):
        return "banned word in title/channel"
    if st.get("status") != "live":
        return "not live (%s)" % st.get("status")
    restart = old is not None and st.get("channel_id") == old["channel_id"] and similar(old["title"], st.get("title")) >= 0.6
    if restart:
        return None  # the same 24/7 stream restarted under a new ID
    age_h = (now() - st["started_at"]) / 3600 if st.get("started_at") else 0
    if not any(w in text for w in LIVE_WORDS):
        return "not marked 24/7"
    if age_h < config.MIN_HOURS:
        return "too new (%.0f h of %d h)" % (age_h, config.MIN_HOURS)
    return None


def find_replacement(con, api, row, shown):
    if now() < (row["next_discovery"] or 0):
        return
    con.execute("UPDATE slots SET next_discovery=? WHERE key=?", (now() + 1800, row["key"]))
    old = db.stream(con, row["current_video"])
    cid = row["channel_id"] or (old and old["channel_id"])
    if not cid:
        return
    used = {r["current_video"] for r in con.execute("SELECT current_video FROM slots WHERE idx IS NOT NULL AND key<>?", (row["key"],))}
    ids = [v for v in channel_live_ids(cid) if v != row["current_video"] and v not in used]
    ids = [v for v in ids if not (db.stream(con, v) and db.stream(con, v)["rejected"])]
    if not ids:
        note_no_replacement(con, row, shown, "the channel has no other live stream")
        return
    sts = statuses(con, api, ids[:8])
    reasons = []
    for vid in ids[:8]:
        st = sts[vid]
        db.upsert_stream(con, vid, channel_id=st.get("channel_id"), channel=st.get("channel"), title=st.get("title"),
                         kind="live", started_at=st.get("started_at"), last_seen=now(), last_status=st.get("status"))
        why = judge_candidate(con, old, st)
        if why:
            reasons.append("%s: %s" % (vid, why))
            if why.startswith(("banned", "not marked")):
                db.upsert_stream(con, vid, rejected=why)
            continue
        s = db.stream(con, vid)
        fresh = s["flash_at"] and now() - s["flash_at"] < 86400
        if fresh and s["flash_verdict"] == "pass" and (s["height"] or 0) >= config.MIN_HEIGHT:
            swap(con, api, row, vid, shown)
        elif queue_job(con, vid, row["key"], "candidate"):
            db.event(con, row["key"], "candidate", vid, st.get("title") or "")
            con.execute("UPDATE slots SET auto_reason='down' WHERE key=?", (row["key"],))
            if shown:
                discord.send(con, "Replacement found, waiting for its flash check: %s" % (row["title"] or row["key"]),
                             "%s: candidate %s (%s). It goes in only after it passes the flash check and is %dp or better."
                             % (label(row), yt(vid), st.get("title"), config.MIN_HEIGHT), "info")
        return
    note_no_replacement(con, row, shown, "; ".join(reasons))


def note_no_replacement(con, row, shown, why):
    if shown:
        discord.send(con, "No replacement yet: %s" % (row["title"] or row["key"]),
                     "%s stays hidden. %s. Retrying every 30 min." % (label(row), why[:1500]), "warn",
                     dedupe="norepl:" + row["key"], every_hours=12)


def swap(con, api, row, vid, shown):
    title = row["title"] or row["key"]
    if not row["playlist"]:
        discord.send(con, "Replacement ready but slot has no playlist: %s" % title,
                     "%s: %s passed every check, but the world bakes the old stream link itself. Put it in channels.json "
                     "and upload, or create the slot playlists (Tools/youtube-slots)." % (label(row), yt(vid)), "warn",
                     dedupe="noplaylist:%s:%s" % (row["key"], vid), every_hours=24)
        return False
    if not api.can_write:
        discord.send(con, "Replacement ready but no YouTube OAuth grant: %s" % title,
                     "%s: %s passed every check. Set YT_CLIENT_ID/SECRET/REFRESH_TOKEN on the server." % (label(row), yt(vid)),
                     "warn", dedupe="nooauth:" + row["key"], every_hours=24)
        return False
    try:
        api.insert_first(row["playlist"], vid)
        for item_id, v in api.playlist_items(row["playlist"], essential=True):
            if v != vid:
                api.delete_item(item_id)
        first = api.playlist_items(row["playlist"], essential=True)
    except Exception as e:
        discord.send(con, "Swap failed: %s" % title, "%s -> %s: %s" % (label(row), yt(vid), str(e)[:800]), "urgent")
        return False
    if not first or first[0][1] != vid:
        discord.send(con, "Swap did not stick: %s" % title, "%s: playlist starts with %s" % (label(row), first[0][1] if first else "nothing"), "urgent")
        return False
    old = row["current_video"]
    con.execute("UPDATE slots SET current_video=?, down_since=NULL, misses=0, auto_hidden=0, auto_reason=NULL WHERE key=?", (vid, row["key"]))
    db.event(con, row["key"], "replaced", vid, "from %s" % old)
    db.set_meta(con, "thumbs_dirty", True)
    con.commit()
    if shown:
        s = db.stream(con, vid)
        discord.send(con, "Replaced: %s" % title, "%s now plays %s (%s, %sp, flash %s/s). Was %s."
                     % (label(row), yt(vid), s["title"], s["height"], s["flash_max"], yt(old)), "good")
    return True


def pull_from_playlist(con, api, row):
    """Flash fail on a playlist slot: empty the playlist so nothing plays even where the old list is still showing."""
    if not (row["playlist"] and api.can_write):
        return False
    try:
        for item_id, _ in api.playlist_items(row["playlist"], essential=True):
            api.delete_item(item_id)
        return True
    except Exception as e:
        discord.send(con, "Could not empty playlist after flash fail", "%s: %s" % (label(row), str(e)[:800]), "urgent")
        return False


# ---------- jobs ----------

def claim_jobs(con, runner, limit):
    rows = con.execute("SELECT j.*, s.kind FROM jobs j LEFT JOIN streams s ON s.video_id=j.video_id WHERE j.done IS NULL AND (j.claimed IS NULL OR j.claimed < ?)",
                       (now() - 7200,)).fetchall()
    rows = sorted(rows, key=lambda r: (REASON_ORDER.get(r["reason"], 9), r["created"]))[:limit]
    for r in rows:
        con.execute("UPDATE jobs SET claimed=?, runner=? WHERE id=?", (now(), runner, r["id"]))
    db.set_meta(con, "worker:" + runner, now())
    con.commit()
    return [{"id": r["id"], "video_id": r["video_id"], "slot_key": r["slot_key"], "reason": r["reason"],
             "flash": r["kind"] != "video"} for r in rows]


def submit_results(con, api, results, overrides, source="worker"):
    rows = slot_rows(con)
    for res in results:
        job = con.execute("SELECT * FROM jobs WHERE id=?", (res["id"],)).fetchone()
        if job is None or job["done"]:
            continue
        vid, runner = res["video_id"], res.get("runner", "?")
        db.set_meta(con, "worker:" + runner, now())
        if res.get("error"):
            tries = len(json.loads(job["result"] or "[]")) + 1
            log = json.dumps(json.loads(job["result"] or "[]") + [res["error"]])
            con.execute("INSERT INTO probes(ts,video_id,runner,source,error) VALUES(?,?,?,?,?)", (res["ts"], vid, runner, source, res["error"]))
            if tries >= 3:
                con.execute("UPDATE jobs SET done=?, result=? WHERE id=?", (now(), log, job["id"]))
                discord.send(con, "Check failed 3 times", "%s for %s: %s" % (yt(vid), job["slot_key"], res["error"]), "warn",
                             dedupe="jobfail:" + vid, every_hours=24)
            else:
                con.execute("UPDATE jobs SET claimed=NULL, result=? WHERE id=?", (log, job["id"]))
            continue
        prev = db.stream(con, vid)
        con.execute("INSERT INTO probes(ts,video_id,live_status,height,format_id,runner,source) VALUES(?,?,?,?,?,?,?)",
                    (res["ts"], vid, res.get("live_status"), res.get("height"), res.get("format_id"), runner, source))
        db.upsert_stream(con, vid, height=res.get("height"), height_at=res["ts"], format_id=res.get("format_id"),
                         channel_id=res.get("channel_id"), channel=res.get("channel"), title=res.get("title"))
        if prev and prev["height"] and res.get("height") and prev["height"] != res["height"]:
            db.event(con, job["slot_key"], "resolution", vid, "%sp -> %sp" % (prev["height"], res["height"]))
        fl = res.get("flash")
        if fl:
            con.execute("INSERT INTO flash(ts,video_id,slot_key,verdict,max_fps,regions,frames,mean_luminance,runner,source) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (res["ts"], vid, job["slot_key"], fl.get("verdict"), fl.get("max_fps"), json.dumps(fl.get("regions")),
                         fl.get("frames"), fl.get("mean_luminance"), runner, source))
            if fl.get("verdict") in ("pass", "fail"):
                db.upsert_stream(con, vid, flash_verdict=fl["verdict"], flash_max=fl.get("max_fps"), flash_at=res["ts"])
            elif tries_left(job):
                con.execute("UPDATE jobs SET claimed=NULL, result=? WHERE id=?", (json.dumps(json.loads(job["result"] or "[]") + [fl.get("verdict")]), job["id"]))
                continue
        con.execute("UPDATE jobs SET done=?, result=? WHERE id=?", (now(), json.dumps(res), job["id"]))
        con.commit()
        react(con, api, job, res, rows, overrides)
    con.commit()


def tries_left(job):
    return len(json.loads(job["result"] or "[]")) < 2


def react(con, api, job, res, rows, overrides):
    vid, fl = res["video_id"], res.get("flash") or {}
    playing = [r for r in rows.values() if r["current_video"] == vid]
    if fl.get("verdict") == "fail":
        db.upsert_stream(con, vid, rejected="flash fail")
        for r in playing:
            con.execute("UPDATE slots SET auto_hidden=1, auto_reason='flash fail' WHERE key=?", (r["key"],))
            db.event(con, r["key"], "flash_fail", vid, "%s/s %s" % (fl.get("max_fps"), fl.get("regions")))
            emptied = pull_from_playlist(con, api, r)
            discord.send(con, "FLASH FAIL: %s" % (r["title"] or r["key"]),
                         "%s: %s flashes **%s times/s** (limit %d; regions whole/TL/TR/BL/BR %s). Hidden at once%s."
                         % (label(r), yt(vid), fl.get("max_fps"), config.FLASH_LIMIT, fl.get("regions"),
                            " and removed from the slot playlist, so nothing plays" if emptied else
                            "; the world still has the link baked, so anyone with a stale list could play it"), "urgent")
        if not playing:
            discord.send(con, "Flash fail on a candidate", "%s (%s) failed at %s/s; it will not be used." % (yt(vid), job["slot_key"], fl.get("max_fps")), "warn")
        db.set_meta(con, "publish_now", True)
        con.commit()
        return
    live = res.get("live_status") in ("is_live", None)  # None: VRChat's yt-dlp does not say; the server checked before queuing
    for r in playing:
        if r["kind"] == "live" and live and (res.get("height") or 0) < config.MIN_HEIGHT:
            discord.send(con, "Low resolution: %s" % (r["title"] or r["key"]), "%s plays at %sp (rule: %dp or better)."
                         % (label(r), res.get("height"), config.MIN_HEIGHT), "warn", dedupe="lowres:" + vid, every_hours=24)
    if job["reason"] == "candidate":
        row = con.execute("SELECT * FROM slots WHERE key=?", (job["slot_key"],)).fetchone()
        if row is None or not row["down_since"]:
            return
        shown = is_shown(row, overrides)
        if not live or (res.get("height") or 0) < config.MIN_HEIGHT:
            why = "not live" if not live else "%sp" % res.get("height")
            db.upsert_stream(con, vid, rejected=why)
            con.execute("UPDATE slots SET next_discovery=0 WHERE key=?", (row["key"],))
            note_no_replacement(con, row, shown, "candidate %s rejected: %s" % (vid, why))
        else:
            swap(con, api, row, vid, shown)


def run_local_jobs(con, api, overrides):
    if not (config.COOKIES and os.path.exists(config.COOKIES)):
        return 0
    from . import probe
    jobs = claim_jobs(con, "linode", config.LOCAL_JOBS)
    results = [probe.run_job(j, "linode") for j in jobs]
    submit_results(con, api, results, overrides, source="linode")
    if results and all(r.get("error") and "not a bot" in r["error"] for r in results):
        discord.send(con, "Linode cookies no longer work", "yt-dlp gets the bot wall even with %s. Refresh the cookies file." % config.COOKIES,
                     "warn", dedupe="cookies", every_hours=24)
    return len(results)


# ---------- daily ----------

def maybe_daily(con, api, overrides):
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    if dt.datetime.now(dt.timezone.utc).hour < config.DAILY_HOUR_UTC or db.get_meta(con, "last_daily") == today:
        return
    db.set_meta(con, "last_daily", today)
    rows = slot_rows(con)
    queued = 0
    for r in rows.values():
        if r["kind"] == "live" and r["current_video"] and not r["auto_hidden"]:
            queued += queue_job(con, r["current_video"], r["key"], "daily")
    if api.can_write:
        for r in rows.values():
            if not r["playlist"] or r["auto_reason"] == "flash fail":
                continue
            try:
                items = api.playlist_items(r["playlist"])
            except QuotaExceeded:
                break
            except Exception as e:
                discord.send(con, "Playlist check failed", "%s: %s" % (label(r), str(e)[:500]), "warn", dedupe="plcheck", every_hours=24)
                continue
            first = items[0][1] if items else None
            if first and first != r["current_video"]:
                con.execute("UPDATE slots SET current_video=? WHERE key=?", (first, r["key"]))
                db.event(con, r["key"], "playlist_changed", first, "was %s" % r["current_video"])
                discord.send(con, "Playlist changed outside the monitor", "%s now starts with %s (was %s). Following it." % (label(r), yt(first), yt(r["current_video"])), "info")
            elif not first and r["current_video"]:
                discord.send(con, "Slot playlist is empty", "%s: the world plays nothing for this slot." % label(r), "warn", dedupe="plempty:" + r["key"], every_hours=24)
    db.set_meta(con, "thumbs_dirty", True)
    con.commit()
    summary(con, api, overrides, queued)


def summary(con, api, overrides, queued):
    rows = slot_rows(con)
    shown = [r for r in rows.values() if r["kind"] in ("live", "video") and is_shown(r, overrides)]
    hidden = [r for r in shown if r["auto_hidden"]]
    day = now() - 86400
    ev = con.execute("SELECT kind, COUNT(*) n FROM events WHERE ts>? GROUP BY kind", (day,)).fetchall()
    fl = con.execute("SELECT verdict, COUNT(*) n, MAX(max_fps) m FROM flash WHERE ts>? AND source<>'seed' GROUP BY verdict", (day,)).fetchall()
    pending = con.execute("SELECT COUNT(*) n, MIN(created) c FROM jobs WHERE done IS NULL").fetchone()
    workers = {k[7:]: v for k, v in ((r["k"], json.loads(r["v"])) for r in con.execute("SELECT * FROM meta WHERE k LIKE 'worker:%'"))}
    lines = ["**%d of %d** shown slots up." % (len(shown) - len(hidden), len(shown))]
    if hidden:
        lines.append("Hidden by the monitor: " + ", ".join("%s (%s)" % (r["key"], r["auto_reason"]) for r in hidden))
    lines.append("Last 24 h events: " + (", ".join("%s %d" % (r["kind"], r["n"]) for r in ev) or "none"))
    lines.append("Flash checks (24 h): " + (", ".join("%s %d (max %s/s)" % (r["verdict"], r["n"], r["m"]) for r in fl) or "none"))
    lines.append("Queued %d daily checks; %d jobs pending%s." % (queued, pending["n"], (" (oldest %.0f h)" % ((now() - pending["c"]) / 3600)) if pending["c"] else ""))
    lines.append("Workers last seen: " + (", ".join("%s %.1f h ago" % (k, (now() - v) / 3600) for k, v in workers.items()) or "never"))
    lines.append("API quota today: %d of %d." % (api.used_today(), config.QUOTA_LIMIT))
    discord.send(con, "Daily summary", "\n".join(lines), "info")
    if pending["c"] and now() - pending["c"] > config.WORKER_STALE_HOURS * 3600:
        discord.send(con, "Flash checks are stalled", "Jobs have waited %.0f h. Is the PC worker running (or the Linode cookies set)?"
                     % ((now() - pending["c"]) / 3600), "warn", dedupe="stalled", every_hours=24)


# ---------- publish ----------

def publish_pass(con, slots, overrides, force_thumbs=False):
    rows = slot_rows(con)
    files = {config.STATUS_FILE: publish.dumps(publish.status_doc(slots, rows, overrides))}
    thumbs_at = db.get_meta(con, "thumbs_at", 0)
    if force_thumbs or db.get_meta(con, "thumbs_dirty", False) or now() - thumbs_at > config.THUMBS_REFRESH_HOURS * 3600:
        sheet, missing = publish.build_sheet(slots, {k: r["current_video"] for k, r in rows.items()})
        files[config.THUMBS_FILE] = sheet
        db.set_meta(con, "thumbs_at", now())
        db.set_meta(con, "thumbs_dirty", False)
        if missing:
            print("thumbnails missing: %s" % ", ".join(missing), flush=True)
    db.set_meta(con, "publish_now", False)
    con.commit()
    if not (config.PUBLISH and config.GIT_SSH_KEY):
        out = os.path.join(config.DATA_DIR, "out")
        for rel, data in files.items():
            os.makedirs(os.path.join(out, "docs"), exist_ok=True)
            open(os.path.join(out, rel), "wb").write(data)
        return False
    changed = publish.publish(files, "Channels status: %s" % dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
    if changed:
        print("published %s" % ", ".join(files), flush=True)
    return changed


def quota_watch(con, api):
    used = api.used_today()
    if used >= config.QUOTA_WARN:
        discord.send(con, "YouTube API quota near its limit", "%d of %d units used today (Pacific day). Above %d only swaps and flash-fail removals run."
                     % (used, config.QUOTA_LIMIT, config.QUOTA_RESERVE), "warn", dedupe="quota:" + api.quota_day(), every_hours=24)


def run(con):
    slots, overrides = load_slots(), load_overrides()
    api = Api(con)
    sync_slots(con, slots, overrides)
    check_pass(con, api, overrides)
    run_local_jobs(con, api, overrides)
    maybe_daily(con, api, overrides)
    publish_pass(con, slots, overrides)
    quota_watch(con, api)
