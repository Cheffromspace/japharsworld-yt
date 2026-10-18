"""slotmon: link monitor for the Channels tab of the VRChat world Everything is OK.

  python -m slotmon run                    one monitor pass (the systemd timer runs this)
  python -m slotmon status                 table of slots as the monitor sees them
  python -m slotmon claim --runner pc      hand out resolution/flash jobs as JSON (PC worker, over SSH)
  python -m slotmon submit                 take job results as JSON on stdin
  python -m slotmon preflight [--json]     channels.json on stdin -> is every shown slot up? (before a world upload)
  python -m slotmon report [--days 14]     baseline report (Markdown)
  python -m slotmon publish [--thumbs]     publish sleep-list.json (and the thumbnail sheet) now
  python -m slotmon queue VIDEO [--slot K] queue a flash check by hand
  python -m slotmon seed FILE              load a seed file made by seed-pack
  python -m slotmon seed-pack WORLD OUT    (PC) pack the 2026-10-17 hand checks from the world repo
  python -m slotmon alert-test             send a test message to Discord
"""
import argparse, json, os, sys, time, traceback

from . import config, core, db, discord
from .youtube import Api, video_id, watch_status


def lock():
    try:
        import fcntl
    except ImportError:
        return True
    os.makedirs(config.DATA_DIR, exist_ok=True)
    f = open(os.path.join(config.DATA_DIR, "run.lock"), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    lock.f = f
    return True


def cmd_run(con, a):
    if not lock():
        print("another pass is running")
        return 0
    t = time.time()
    try:
        core.run(con)
    except Exception as e:
        traceback.print_exc()
        discord.send(con, "Monitor error", "```%s```" % traceback.format_exc()[-1500:], "warn", dedupe="err:" + str(e)[:80], every_hours=6)
        return 1
    print("pass done in %.0f s" % (time.time() - t))
    return 0


def cmd_status(con, a):
    ov = core.load_overrides()
    for r in core.slot_rows(con).values():
        c = con.execute("SELECT * FROM checks WHERE slot_key=? ORDER BY ts DESC LIMIT 1", (r["key"],)).fetchone()
        s = db.stream(con, r["current_video"]) if r["current_video"] else None
        print("%2d %-24s %-9s %-11s %-6s %5s flash=%-4s %s%s" % (
            r["idx"], r["key"], r["kind"], r["current_video"] or "-", "shown" if core.is_shown(r, ov) else "hidden",
            (str(s["height"]) + "p") if s and s["height"] else "?", (s["flash_max"] if s and s["flash_max"] is not None else "?"),
            c["status"] if c else "-", ("  AUTO-HIDDEN: " + r["auto_reason"]) if r["auto_hidden"] else ""))


def cmd_claim(con, a):
    print(json.dumps(core.claim_jobs(con, a.runner, a.max)))


def cmd_submit(con, a):
    results = json.load(sys.stdin)
    ov = core.load_overrides()
    core.submit_results(con, Api(con), results, ov, source=a.source)
    if db.get_meta(con, "publish_now", False):
        core.publish_pass(con, core.load_slots(), ov)  # flash fail: hide at once
    print("took %d results" % len(results))


def cmd_preflight(con, a):
    world = json.load(sys.stdin)["slots"]
    ov = core.load_overrides()
    rows = core.slot_rows(con)
    api = Api(con)
    mine = {s["key"]: s for s in core.load_slots()}
    out, problems = [], []
    if [s.get("playlist") or s.get("url") for s in world] != [mine.get(s["key"], {}).get("playlist") or mine.get(s["key"], {}).get("url") for s in world] \
            or len(world) != len(mine):
        problems.append({"key": "-", "problem": "the monitor's channels.json differs from the world's: copy it to japharsworld-yt/monitor/channels.json and push"})
    for s in world:
        shown = not bool(ov.get("slots", {}).get(s["key"], {}).get("hidden", s.get("hidden", False)))
        r = rows.get(s["key"])
        if r is not None and s.get("playlist") and s["playlist"] == r["playlist"]:
            vid = r["current_video"]
        else:
            vid = video_id(s.get("url")) if "list=" not in (s.get("url") or "") else None
        kind = (ov.get("slots", {}).get(s["key"], {}).get("kind")) or (r["kind"] if r is not None else "live")
        item = {"key": s["key"], "shown": shown, "video": vid, "kind": kind}
        if vid:
            c = con.execute("SELECT * FROM checks WHERE video_id=? AND ts>? AND status<>'error' ORDER BY ts DESC LIMIT 1", (vid, time.time() - 2400)).fetchone()
            st = dict(c) if c else (api.videos([vid])[vid] if api.can_read else watch_status(vid))
            st_s = db.stream(con, vid)
            item.update(status=st.get("status"), title=st.get("title"), height=st_s["height"] if st_s else None,
                        flash=st_s["flash_verdict"] if st_s else None, flash_max=st_s["flash_max"] if st_s else None,
                        flash_age_h=round((time.time() - st_s["flash_at"]) / 3600, 1) if st_s and st_s["flash_at"] else None)
        out.append(item)
        if not shown:
            continue
        p = []
        if not vid:
            if kind != "unmanaged":
                p.append("no stream to check")
        else:
            ok = item["status"] == "live" if kind == "live" else item["status"] in ("video", "live")
            if not ok:
                p.append("not up: %s" % item["status"])
            if item["flash"] == "fail":
                p.append("FLASH FAIL (%s/s)" % item["flash_max"])
            elif item["flash"] is None and kind == "live":
                p.append("never flash-checked")
            elif item["flash_age_h"] and item["flash_age_h"] > 72 and kind == "live":
                p.append("flash check is %.0f h old" % item["flash_age_h"])
            if kind == "live" and item["height"] and item["height"] < config.MIN_HEIGHT:
                p.append("%sp" % item["height"])
            if r is not None and r["auto_hidden"]:
                p.append("hidden by the monitor: %s" % r["auto_reason"])
        for x in p:
            problems.append({"key": s["key"], "problem": x})
    if a.json:
        print(json.dumps({"slots": out, "problems": problems}, ensure_ascii=False))
    else:
        for x in problems:
            print("%-24s %s" % (x["key"], x["problem"]))
        print("%d problems in %d slots" % (len(problems), len(world)))
    return 1 if problems else 0


def cmd_report(con, a):
    from .report import report
    print(report(con, a.days))


def cmd_publish(con, a):
    slots, ov = core.load_slots(), core.load_overrides()
    core.sync_slots(con, slots, ov)
    print("committed" if core.publish_pass(con, slots, ov, force_thumbs=a.thumbs) else "nothing changed (or publishing is off: see data/out)")


def cmd_queue(con, a):
    print("queued" if core.queue_job(con, a.video, a.slot, "manual") else "already queued")
    con.commit()


def cmd_seed(con, a):
    from . import seed
    core.sync_slots(con, core.load_slots(), core.load_overrides())
    seed.load(con, a.file)


def cmd_alert_test(con, a):
    discord.send(con, "Test from slotmon", "If you can read this, alerts work.", "good")


def main():
    ap = argparse.ArgumentParser(prog="slotmon")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run"); sub.add_parser("status"); sub.add_parser("alert-test")
    p = sub.add_parser("claim"); p.add_argument("--runner", default="pc"); p.add_argument("--max", type=int, default=20)
    p = sub.add_parser("submit"); p.add_argument("--source", default="worker")
    p = sub.add_parser("preflight"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("report"); p.add_argument("--days", type=int, default=14)
    p = sub.add_parser("publish"); p.add_argument("--thumbs", action="store_true")
    p = sub.add_parser("queue"); p.add_argument("video"); p.add_argument("--slot")
    p = sub.add_parser("seed"); p.add_argument("file")
    p = sub.add_parser("seed-pack"); p.add_argument("world"); p.add_argument("out")
    a = ap.parse_args()
    if a.cmd == "seed-pack":
        from . import seed
        return seed.pack(a.world, a.out)
    con = db.connect(config.DB_PATH)
    return globals()["cmd_" + a.cmd.replace("-", "_")](con, a) or 0


if __name__ == "__main__":
    sys.exit(main())
