"""One monitor pass: check every slot's stream, react to outages, apply job results, publish."""
import datetime as dt, difflib, json, os, time

from . import config, db, discord, probe, publish
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
        # baked_hidden is the owner's choice: overrides.json's hidden when set, else the world's bake (owner, 2026-10-29:
        # the spare lofi-study shown), so the exporter's eiok_slot_spare and Grafana's "Channels hidden" count a shown spare.
        if row["baked_video"] and baked and baked != row["baked_video"] and cur == row["baked_video"]:
            cur = baked  # channels.json now names a different stream (the owner changed the list)
        con.execute("UPDATE slots SET idx=?, playlist=?, baked_video=?, current_video=?, kind=?, category=?, title=?, channel=?, baked_hidden=? WHERE key=?",
                    (i, s.get("playlist"), baked, cur or baked, kind, s.get("category"), s.get("title"), s.get("channel"),
                     1 if ov.get(key, {}).get("hidden", s.get("hidden")) else 0, key))
    for r in con.execute("SELECT key FROM slots").fetchall():
        if r["key"] not in seen:
            con.execute("UPDATE slots SET idx=NULL, kind='removed' WHERE key=?", (r["key"],))
    con.commit()


def slot_rows(con):
    return {r["key"]: r for r in con.execute("SELECT * FROM slots WHERE idx IS NOT NULL ORDER BY idx")}


# ---------- the flash-fail hold (Everything-is-OK#776) ----------
# A slot whose stream failed the flash check stays hidden until a person clears it (`slotmon clear-flash <key>`): through
# its stream ending, a same-channel restart, the daily pass, a hand playlist edit and a restart of the monitor. Until
# 2026-11-16 the hide lived only in slots.auto_reason and was lost twice for retroworld-ps1: handle_down wrote 'down' over
# it when its stream ended (11-14), and the swap to the channel's next stream, after one 60 s sample, cleared it (11-15).
# Now the events table is the record: a flash_fail event with no later flash_cleared event holds the slot, and every
# check pass and every publish puts the hide back if anything wrote over it (coordinator's call, 2026-11-16: a hold until
# a person clears it, not a longer sample). A held slot gets no replacement search and no swap, so the playlist
# pull_from_playlist emptied stays empty for any PC still showing the slot; it keeps its daily sample while it plays a
# stream other than the one that failed.
FLASH_FAIL = "flash fail"


def held(row):
    return row["auto_reason"] == FLASH_FAIL


def failed_stream(s):
    """A stream that has failed a flash check: never shown again, even after a later sample passes (a hand recheck sets
    the verdict to pass but leaves rejected). One rule for check_pass, maybe_daily and clear_flash."""
    return bool(s and (s["flash_verdict"] == "fail" or s["rejected"] == FLASH_FAIL))


def _hold_times(con, key):
    """(last flash_fail, last flash_cleared) event times for a slot, None where there is none."""
    r = con.execute("SELECT MAX(CASE WHEN kind='flash_fail' THEN ts END) f, MAX(CASE WHEN kind='flash_cleared' THEN ts END) c "
                    "FROM events WHERE slot_key=? AND kind IN ('flash_fail', 'flash_cleared')", (key,)).fetchone()
    return r["f"], r["c"]


def owed_hold(con, key):
    """True when the slot's last flash fail has not been cleared by a person since."""
    failed_at, cleared_at = _hold_times(con, key)
    return bool(failed_at) and not (cleared_at and cleared_at > failed_at)


def hold_flash_fails(con):
    """Put the flash-fail hide back on every listed slot whose last flash_fail event no person has cleared."""
    for r in con.execute("SELECT key, title, auto_hidden, auto_reason FROM slots WHERE idx IS NOT NULL").fetchall():
        if (r["auto_hidden"] and held(r)) or not owed_hold(con, r["key"]):
            continue
        failed_at, _ = _hold_times(con, r["key"])
        con.execute("UPDATE slots SET auto_hidden=1, auto_reason=? WHERE key=?", (FLASH_FAIL, r["key"]))
        when = dt.datetime.fromtimestamp(failed_at, dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        was = (r["auto_reason"] or "hidden") if r["auto_hidden"] else "not hidden by the monitor"
        db.event(con, r["key"], "flash_hold", None, "was %s; flash fail %s not cleared" % (was, when))
        discord.note(con, "Flash-fail hide put back: %s" % (r["title"] or r["key"]),
                     "%s failed the flash check on %s and no person has cleared it, so it is hidden again (it was %s). "
                     "Clear it with `slotmon clear-flash %s`." % (label(r), when, was, r["key"]), "warn")
    con.commit()


def clear_flash(con, key):
    """A person clears a slot's flash-fail hold. The stream that failed is never shown again: a slot still on it, or on a
    stream that is down, becomes an ordinary down slot whose replacement must pass its own flash check. Returns a line."""
    row = con.execute("SELECT * FROM slots WHERE key=?", (key,)).fetchone()
    if row is None:
        return "no slot %s" % key
    if not held(row) and not owed_hold(con, key):
        return "%s has no flash-fail hold (hidden by the monitor: %s)" % (key, row["auto_reason"] if row["auto_hidden"] else "no")
    s = db.stream(con, row["current_video"]) if row["current_video"] else None
    on_failed = failed_stream(s)
    if not (on_failed or row["down_since"] or not row["current_video"]) and not (s and s["flash_verdict"] == "pass"):
        # A live stream with no passing check (a channels.json change moves a held slot to a new stream, sync_slots):
        # never shown unchecked. Nothing is cleared.
        return ("%s: not cleared. It plays %s, which has no passing flash check yet: `slotmon queue %s --slot %s`, wait for "
                "the result (slotmon report), then clear again." % (key, yt(row["current_video"]), row["current_video"], key))
    db.event(con, key, "flash_cleared", row["current_video"], "by hand")
    if on_failed or row["down_since"] or not row["current_video"]:
        con.execute("UPDATE slots SET auto_hidden=1, auto_reason='down', down_since=COALESCE(down_since, ?), next_discovery=0 WHERE key=?", (now(), key))
        line = ("%s: cleared. It stays hidden as down (%s): the next pass looks for a replacement on the same channel, "
                "which goes in only after it passes its own flash check." % (key, "it still plays the stream that failed" if on_failed else "its stream is down"))
    else:
        con.execute("UPDATE slots SET auto_hidden=0, auto_reason=NULL WHERE key=?", (key,))
        line = "%s: cleared. It plays %s (flash pass at %s/s, last checked %s) and is shown from this publish, unless overrides.json hides it." % (
            key, yt(row["current_video"]), s["flash_max"],
            dt.datetime.fromtimestamp(s["flash_at"], dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if s["flash_at"] else "?")
    db.set_meta(con, "publish_now", True)
    con.commit()
    return line


def is_shown(row, overrides):
    o = overrides.get("slots", {}).get(row["key"], {})
    return not bool(o.get("hidden", bool(row["baked_hidden"])))


# ---------- status ----------

def statuses(con, api, ids):
    out = {}
    if api.can_read:
        try:
            out = api.videos(ids)
            discord.resolve(con, "quota-fallback", "Quota back: status checks use the YouTube API again")
            discord.resolve(con, "api-error", "YouTube API works again: status checks use it again")
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
    hold_flash_fails(con)
    rows = [r for r in slot_rows(con).values() if r["kind"] in ("live", "video") and r["current_video"]]
    sts = statuses(con, api, [r["current_video"] for r in rows])
    for row in rows:
        st = sts[row["current_video"]]
        record_check(con, row, st)
        status = st.get("status")
        if status == "error":
            continue
        ok = status == "live" if row["kind"] == "live" else status in ("video", "live")
        # #776: once a person clears a hold on a slot still on the stream that failed (clear_flash makes it down), that
        # stream being live must not bring the slot back.
        failed = failed_stream(db.stream(con, row["current_video"])) and not held(row)
        if failed:
            ok = False
        shown = is_shown(row, overrides)
        if ok:
            con.execute("UPDATE slots SET misses=0 WHERE key=?", (row["key"],))
            if row["down_since"]:
                con.execute("UPDATE slots SET down_since=NULL WHERE key=?", (row["key"],))
                db.event(con, row["key"], "recovered", row["current_video"])
                if row["auto_reason"] == "down":
                    con.execute("UPDATE slots SET auto_hidden=0, auto_reason=NULL WHERE key=?", (row["key"],))
                if shown and not held(row):
                    discord.note(con, "Back up: %s" % (row["title"] or row["key"]), "%s is live again: %s" % (label(row), yt(row["current_video"])), "good")
            s = db.stream(con, row["current_video"])
            if row["kind"] == "live" and s["flash_at"] is None:
                queue_job(con, row["current_video"], row["key"], "new")
        else:
            misses = (row["misses"] or 0) + 1
            con.execute("UPDATE slots SET misses=? WHERE key=?", (misses, row["key"]))
            if status in ("ended", "unavailable") or misses >= 2 or failed:
                handle_down(con, api, con.execute("SELECT * FROM slots WHERE key=?", (row["key"],)).fetchone(), st, shown)
    con.commit()


# ---------- outages and replacements ----------

def handle_down(con, api, row, st, shown):
    if not row["down_since"]:
        # #776: a flash-fail hold outlives the stream (until 2026-11-16 this wrote 'down' over it).
        con.execute("UPDATE slots SET down_since=?, auto_hidden=1, auto_reason=? WHERE key=?", (now(), FLASH_FAIL if held(row) else "down", row["key"]))
        db.event(con, row["key"], "down", row["current_video"], "%s %s" % (st.get("status"), st.get("error") or ""))
        if shown and held(row):
            discord.note(con, "Stream down: %s" % (row["title"] or row["key"]),
                         "%s: %s is **%s**. It stays hidden for its flash fail until a person clears it (`slotmon clear-flash %s`); "
                         "no replacement is looked for until then." % (label(row), yt(row["current_video"]), st.get("status"), row["key"]), "warn")
        elif shown:
            discord.note(con, "Stream down: %s" % (row["title"] or row["key"]),
                         "%s: %s is **%s**%s. Hidden in sleep-list.json; looking for a replacement on the same channel."
                         % (label(row), yt(row["current_video"]), st.get("status"), (" (%s)" % st["error"]) if st.get("error") else ""), "warn")
        row = con.execute("SELECT * FROM slots WHERE key=?", (row["key"],)).fetchone()
    if row["kind"] == "live" and not held(row):
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
    if held(row) or now() < (row["next_discovery"] or 0):
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
            con.execute("UPDATE slots SET auto_reason='down' WHERE key=? AND auto_reason IS NOT ?", (row["key"], FLASH_FAIL))
            if shown:
                discord.note(con, "Replacement found, waiting for its flash check: %s" % (row["title"] or row["key"]),
                             "%s: candidate %s (%s). It goes in only after it passes the flash check and is %dp or better."
                             % (label(row), yt(vid), st.get("title"), config.MIN_HEIGHT), "info")
        return
    note_no_replacement(con, row, shown, "; ".join(reasons))


def note_no_replacement(con, row, shown, why):
    if shown:
        discord.note(con, "No replacement yet: %s" % (row["title"] or row["key"]),
                     "%s stays hidden. %s. Retrying every 30 min." % (label(row), why[:1500]), "warn")


def swap(con, api, row, vid, shown):
    title = row["title"] or row["key"]
    # #776: the row as it is now, not as the caller read it: a hold set since stops the swap (a swap used to clear it).
    if held(con.execute("SELECT auto_reason FROM slots WHERE key=?", (row["key"],)).fetchone()):
        db.event(con, row["key"], "swap_held", vid, "flash-fail hold: no swap until a person clears it")
        con.commit()
        return False
    if not row["playlist"]:
        swap_failed(con, row, vid, "no slot playlist (the world bakes the old link)",
                    "Replacement ready but slot has no playlist: %s" % title,
                    "%s: %s passed every check, but the world bakes the old stream link itself. Put it in channels.json "
                    "and upload, or create the slot playlists (Tools/youtube-slots)." % (label(row), yt(vid)))
        return False
    if not api.can_write:
        swap_failed(con, row, vid, "no YouTube OAuth grant", "Replacement ready but no YouTube OAuth grant: %s" % title,
                    "%s: %s passed every check. Set YT_CLIENT_ID/SECRET/REFRESH_TOKEN on the server." % (label(row), yt(vid)))
        return False
    try:
        api.insert_first(row["playlist"], vid)
        for item_id, v in api.playlist_items(row["playlist"], essential=True):
            if v != vid:
                api.delete_item(item_id)
        first = api.playlist_items(row["playlist"], essential=True)
    except Exception as e:
        swap_failed(con, row, vid, "playlist write failed: %s" % str(e)[:200], "Swap failed: %s" % title,
                    "%s -> %s: %s" % (label(row), yt(vid), str(e)[:800]))
        return False
    if not first or first[0][1] != vid:
        swap_failed(con, row, vid, "the playlist did not keep it", "Swap did not stick: %s" % title,
                    "%s: playlist starts with %s" % (label(row), first[0][1] if first else "nothing"))
        return False
    old = row["current_video"]
    if not con.execute("UPDATE slots SET current_video=?, down_since=NULL, misses=0, auto_hidden=0, auto_reason=NULL WHERE key=? AND auto_reason IS NOT ?",
                       (vid, row["key"], FLASH_FAIL)).rowcount:
        # #776: held while the playlist was written (a worker's submit runs beside the pass): the hold stays, and the
        # playlist is emptied again so a PC with a stale list plays nothing.
        db.event(con, row["key"], "swap_held", vid, "held during the swap; playlist emptied again")
        con.commit()
        pull_from_playlist(con, api, row)
        return False
    db.event(con, row["key"], "replaced", vid, "from %s" % old)
    db.set_meta(con, "thumbs_dirty", True)
    con.commit()
    if shown:
        s = db.stream(con, vid)
        discord.note(con, "Replaced: %s" % title, "%s now plays %s (%s, %sp, flash %s/s). Was %s."
                     % (label(row), yt(vid), s["title"], s["height"], s["flash_max"], yt(old)), "good")
    return True


def swap_failed(con, row, vid, why, title, body):
    """A replacement that could not go in: an event for the daily summary's failures, and the journal."""
    db.event(con, row["key"], "swap_failed", vid, why)
    con.commit()
    discord.note(con, title, body, "warn")


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

CLAIM_SECONDS = 3600  # a claim never reported is handed out again after this; a worker run times out at 50 min


def claim_jobs(con, runner, limit):
    rows = con.execute("SELECT j.*, s.kind FROM jobs j LEFT JOIN streams s ON s.video_id=j.video_id WHERE j.done IS NULL AND (j.claimed IS NULL OR j.claimed < ?)",
                       (now() - CLAIM_SECONDS,)).fetchall()
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
        # A YouTube refusal the worker classified (probe.refusal_class; a worker without it: from the error text). Only
        # the class is kept; metrics/exporter.js counts these as yt_refusal flash:<class>.
        refusal = res.get("refusal") or (res.get("flash") or {}).get("refusal") or (res.get("error") and res["error"] != "timeout" and probe.refusal_class(res["error"]))
        if refusal in probe.REFUSAL_CLASSES:
            db.event(con, job["slot_key"], "yt_refusal", vid, refusal)
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
            discord.note(con, "Flash fail on a candidate", "%s (%s) failed at %s/s; it will not be used." % (yt(vid), job["slot_key"], fl.get("max_fps")), "warn")
        db.set_meta(con, "publish_now", True)
        con.commit()
        return
    live = res.get("live_status") in ("is_live", None)  # None: VRChat's yt-dlp does not say; the server checked before queuing
    for r in playing:
        if r["kind"] == "live" and live and (res.get("height") or 0) < config.MIN_HEIGHT:
            discord.note(con, "Low resolution: %s" % (r["title"] or r["key"]), "%s plays at %sp (rule: %dp or better)."
                         % (label(r), res.get("height"), config.MIN_HEIGHT), "warn")
    if job["reason"] == "candidate":
        row = con.execute("SELECT * FROM slots WHERE key=?", (job["slot_key"],)).fetchone()
        # A candidate queued before its slot was retired (verifier Low 1, 2026-11-15) or held (#776) does not go in.
        if row is None or not row["down_since"] or row["kind"] != "live" or held(row):
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
        # #776: a held slot playing a stream other than the one that failed (retroworld-ps1 from 2026-11-15) is still
        # sampled daily, so whoever clears the hold has the record of more than one sample.
        s = db.stream(con, r["current_video"]) if r["current_video"] else None
        sample_held = held(r) and not r["down_since"] and not failed_stream(s)
        if r["kind"] == "live" and r["current_video"] and (not r["auto_hidden"] or sample_held):
            queued += queue_job(con, r["current_video"], r["key"], "daily")
    if api.can_write:
        for r in rows.values():
            # A retired slot (kind unmanaged, owner 2026-10-29) is out of every check, its playlist too.
            if not r["playlist"] or r["auto_reason"] == "flash fail" or r["kind"] not in ("live", "video"):
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
                discord.note(con, "Playlist changed outside the monitor", "%s now starts with %s (was %s). Following it." % (label(r), yt(first), yt(r["current_video"])), "info")
            elif not first and r["current_video"]:
                discord.send(con, "Slot playlist is empty", "%s: the world plays nothing for this slot." % label(r), "warn", dedupe="plempty:" + r["key"], every_hours=24)
    db.set_meta(con, "thumbs_dirty", True)
    con.commit()
    summary(con, api, overrides, queued)


def outage_watch(con, overrides):
    """Many channels out at once (owner, 2026-10-26): MASS_DOWN or more shown slots down or hidden, at most once in 24 h
    (dedupe), and no all-clear (owner, 2026-10-29: a daily summary and this warning are the only channel messages; the
    Grafana copy, eiok-channels-mass-down, is retired). One outage the monitor handles itself and the summary counts.
    A plain alert on the usual channel, no mention (owner, #246)."""
    shown = [r for r in slot_rows(con).values() if r["kind"] in ("live", "video") and is_shown(r, overrides)]
    out = [r for r in shown if r["auto_hidden"] or r["down_since"]]
    if len(out) >= config.MASS_DOWN:
        discord.send(con, "%d channels down or hidden at once" % len(out),
                     "%d of %d shown slots: %s" % (len(out), len(shown), ", ".join("%s (%s)" % (r["key"], r["auto_reason"] or "down") for r in out))[:3900],
                     "urgent", dedupe="mass-down", every_hours=24)


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
    # Channel replacements (owner, 2026-10-29): the day's count and channels, and what failed, instead of a message each.
    repl = con.execute("SELECT e.slot_key k, s.title t FROM events e LEFT JOIN slots s ON s.key=e.slot_key WHERE e.ts>? AND e.kind='replaced' ORDER BY e.ts", (day,)).fetchall()
    lines.append("Replacements (24 h): %d%s" % (len(repl), (": " + ", ".join(r["t"] or r["k"] for r in repl)) if repl else ""))
    failed = con.execute("SELECT e.slot_key k, s.title t, e.detail d FROM events e LEFT JOIN slots s ON s.key=e.slot_key WHERE e.id IN "
                         "(SELECT MAX(id) FROM events WHERE ts>? AND kind='swap_failed' GROUP BY slot_key) ORDER BY e.ts", (day,)).fetchall()
    waiting = [r for r in hidden if r["auto_reason"] == "down" and r["key"] not in {f["k"] for f in failed}]
    fails = ["%s (%s)" % (f["t"] or f["k"], f["d"]) for f in failed] + ["%s (no replacement yet)" % (r["title"] or r["key"]) for r in waiting]
    lines.append("Replacement failures: " + ("; ".join(fails) if fails else "none"))
    lines.append("Last 24 h events: " + (", ".join("%s %d" % (r["kind"], r["n"]) for r in ev) or "none"))
    lines.append("Flash checks (24 h): " + (", ".join("%s %d (max %s/s)" % (r["verdict"], r["n"], r["m"]) for r in fl) or "none"))
    lines.append("Queued %d daily checks; %d jobs pending%s." % (queued, pending["n"], (" (oldest %.0f h)" % ((now() - pending["c"]) / 3600)) if pending["c"] else ""))
    lines.append("Workers last seen: " + (", ".join("%s %.1f h ago" % (k, (now() - v) / 3600) for k, v in workers.items()) or "never"))
    lines.append("API quota today: %d of %d." % (api.used_today(), config.QUOTA_LIMIT))
    discord.send(con, "Daily summary", "\n".join(lines), "info")
    if pending["c"] and now() - pending["c"] > config.WORKER_STALE_HOURS * 3600:
        discord.send(con, "Flash checks are stalled", "Jobs have waited %.0f h. Is the Optiplex worker running (or the Linode cookies set)?"
                     % ((now() - pending["c"]) / 3600), "warn", dedupe="stalled", every_hours=24)


# ---------- publish ----------

def stream_titles(con, rows, overrides):
    """Slot key -> the stored title of the stream it plays now, for slots with "title_from": "stream" (#793). current_video
    moves only when a swap has stuck (or the daily playlist read follows a hand edit), so a candidate still waiting for its
    flash check never lends its title. The title is rewritten by every status check (Data API or watch page) and by every
    worker result (yt-dlp), so the row also follows a title the channel edits; publish.clean_title makes both forms equal."""
    ov = overrides.get("slots", {})
    out = {}
    for key, r in rows.items():
        if ov.get(key, {}).get("title_from") == "stream" and r["current_video"]:
            s = db.stream(con, r["current_video"])
            if s is not None and s["title"]:
                out[key] = s["title"]
    return out


def published_doc(con, slots, overrides, rows=None):
    rows = slot_rows(con) if rows is None else rows
    return publish.status_doc(slots, rows, overrides, stream_titles(con, rows, overrides))


def publish_pass(con, slots, overrides, force_thumbs=False):
    hold_flash_fails(con)
    rows = slot_rows(con)
    files = {config.STATUS_FILE: publish.dumps(published_doc(con, slots, overrides, rows))}
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
    outage_watch(con, overrides)
    maybe_daily(con, api, overrides)
    publish_pass(con, slots, overrides)
    quota_watch(con, api)
