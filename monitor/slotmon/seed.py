"""Seed the database with the checks made by hand on 2026-10-17 (before the monitor existed).

pack (on the PC): reads the world repo's SessionWork/2026-10-17/{flashcheck,sleep-streams} and writes one JSON file.
load (on the server): puts that file's flash results, observations and heights into the database (source 'seed').
"""
import datetime as dt, glob, json, os, re

from . import db

CDT = dt.timezone(dt.timedelta(hours=-5))
STATUS = {"is_live": "live", "was_live": "ended", "not_live": "video", "post_live": "ended", "is_upcoming": "upcoming"}
LINE = re.compile(r"^(?:AGE\||META\|)?([\w-]{11})\|(\d{9,11}|NA|None)\|(is_live|was_live|not_live|post_live|is_upcoming)\|(\d+|NA|None)\|([^|]*)\|(.*)$")
STAMP = re.compile(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$")


def _ts(s, fallback):
    m = STAMP.search(s)
    return dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M").replace(tzinfo=CDT).timestamp() if m else fallback


def _vid(url):
    m = re.search(r"v=([\w-]{11})", url or "")
    return m.group(1) if m else None


def pack(world, out):
    sw = os.path.join(world, "SessionWork", "2026-10-17")
    key_url = {}
    for p in [os.path.join(sw, "remote-slots", "channels.json"), os.path.join(world, "Assets", "EverythingIsOK", "Channels", "channels.json")]:
        if os.path.exists(p):
            for s in json.load(open(p, encoding="utf-8-sig"))["slots"]:
                if _vid(s.get("url")):
                    key_url[s["key"]] = s["url"]
    key_url["bedroom-fan-black"] = key_url.get("bedroom-fan-black") or key_url.get("box-fan-black")
    flash = []
    fc = os.path.join(sw, "flashcheck")
    for name, keyed_by_video in [("results.json", False), ("new7-result.json", True), ("noise3-result.json", True), ("known-strobe-result.json", False)]:
        p = os.path.join(fc, name)
        if not os.path.exists(p):
            continue
        ts = os.path.getmtime(p)
        src_urls = {}
        if name == "known-strobe-result.json":
            src_urls = {s["key"]: s["url"] for s in json.load(open(os.path.join(fc, "known-strobe.json"), encoding="utf-8"))["slots"]}
        for k, r in json.load(open(p, encoding="utf-8")).items():
            vid = k if keyed_by_video else _vid(src_urls.get(k) or key_url.get(k))
            if not vid:
                print("seed: no video for", name, k)
                continue
            flash.append({"video_id": vid, "slot_key": None if keyed_by_video else k, "ts": ts, "verdict": r.get("verdict"),
                          "max_fps": r.get("maxFlashesPerSecond"), "regions": r.get("regions"), "frames": r.get("frames"),
                          "mean_luminance": r.get("meanLuminance"), "title": r.get("title"), "channel": r.get("channel"), "file": name})
    obs, heights = [], []
    ss = os.path.join(sw, "sleep-streams")
    for p in sorted(glob.glob(os.path.join(ss, "**", "*.txt"), recursive=True)):
        mt = os.path.getmtime(p)
        last_target = None
        for line in open(p, encoding="utf-8", errors="replace"):
            line = line.rstrip("\n")
            if line.startswith("### "):
                last_target = _vid(line) or (re.match(r"### ([\w-]{11})\s*$", line.strip()) or [None, None])[1]
                continue
            m = re.match(r"^(\d+) - (\d+)x(\d+)", line)
            if m and last_target:
                heights.append({"video_id": last_target, "format_id": m.group(1), "height": int(m.group(3)), "ts": mt, "file": os.path.relpath(p, sw)})
                continue
            m = LINE.match(line.strip())
            if m:
                vid, rel, st, viewers, channel, rest = m.groups()
                obs.append({"video_id": vid, "started_at": int(rel) if rel.isdigit() else None, "status": STATUS[st],
                            "viewers": int(viewers) if viewers.isdigit() else None, "channel": channel,
                            "title": STAMP.sub("", rest.split("|")[-1]).strip(), "ts": _ts(line, mt), "file": os.path.relpath(p, sw)})
    doc = {"made": dt.datetime.now(dt.timezone.utc).isoformat(), "flash": flash, "observations": obs, "heights": heights}
    json.dump(doc, open(out, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print("seed: %d flash results, %d observations, %d heights -> %s" % (len(flash), len(obs), len(heights), out))


def load(con, path):
    if db.get_meta(con, "seeded:" + os.path.basename(path)):
        print("already seeded from", path)
        return
    doc = json.load(open(path, encoding="utf-8"))
    for f in doc["flash"]:
        con.execute("INSERT INTO flash(ts,video_id,slot_key,verdict,max_fps,regions,frames,mean_luminance,runner,source) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (f["ts"], f["video_id"], f["slot_key"], f["verdict"], f["max_fps"], json.dumps(f["regions"]), f["frames"], f["mean_luminance"],
                     "pc", "seed:" + f["file"]))
        if f["verdict"] in ("pass", "fail"):
            db.upsert_stream(con, f["video_id"], flash_verdict=f["verdict"], flash_max=f["max_fps"], flash_at=f["ts"], first_seen=f["ts"],
                             rejected="flash fail" if f["verdict"] == "fail" else None)
    for o in doc["observations"]:
        db.upsert_stream(con, o["video_id"], channel=o["channel"], title=o["title"], started_at=o["started_at"], first_seen=o["ts"],
                         kind="live" if o["status"] in ("live", "ended") else None)
        con.execute("INSERT INTO checks(ts,slot_key,video_id,status,started_at,viewers,title,channel,source) VALUES(?,?,?,?,?,?,?,?,?)",
                    (o["ts"], None, o["video_id"], o["status"], o["started_at"], o["viewers"], o["title"], o["channel"], "seed:" + o["file"]))
    for h in doc["heights"]:
        con.execute("INSERT INTO probes(ts,video_id,height,format_id,runner,source) VALUES(?,?,?,?,?,?)",
                    (h["ts"], h["video_id"], h["height"], h["format_id"], "pc", "seed:" + h["file"]))
        s = db.stream(con, h["video_id"])
        if s is None or not s["height_at"] or s["height_at"] <= h["ts"]:
            db.upsert_stream(con, h["video_id"], height=h["height"], height_at=h["ts"], format_id=h["format_id"], first_seen=h["ts"])
    # checks with no slot: attach to the slot whose stream it was
    con.execute("UPDATE checks SET slot_key=(SELECT key FROM slots WHERE slots.baked_video=checks.video_id) WHERE slot_key IS NULL")
    con.execute("UPDATE flash SET slot_key=(SELECT key FROM slots WHERE slots.baked_video=flash.video_id) WHERE slot_key IS NULL")
    db.set_meta(con, "seeded:" + os.path.basename(path), True)
    con.commit()
    print("seeded: %d flash, %d observations, %d heights" % (len(doc["flash"]), len(doc["observations"]), len(doc["heights"])))
