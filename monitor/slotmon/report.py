"""Baseline report from the database: uptime per slot, restarts, resolution changes, flash results (Markdown)."""
import datetime as dt, json, time


def fmt_ts(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%m-%d %H:%M") if ts else "-"


def report(con, days=14):
    since = time.time() - days * 86400
    out = ["# Channels baseline (%d days, to %s UTC)" % (days, dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M")), ""]
    span = con.execute("SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n FROM checks WHERE ts>? AND source NOT LIKE 'seed%'", (since,)).fetchone()
    out.append("Checks: %d from %s to %s." % (span["n"], fmt_ts(span["a"]), fmt_ts(span["b"])))
    out += ["", "| # | Slot | Uptime | Checks | Streams | Restarts | Heights | Flash (max/s, runs, fails) | Median viewers |",
            "|---|---|---|---|---|---|---|---|---|"]
    slots = con.execute("SELECT * FROM slots WHERE idx IS NOT NULL ORDER BY idx").fetchall()
    worst = []
    for s in slots:
        if s["kind"] not in ("live", "video"):
            continue
        ck = con.execute("SELECT status, video_id, started_at, viewers FROM checks WHERE slot_key=? AND ts>? AND source NOT LIKE 'seed%' AND status<>'error' ORDER BY ts",
                         (s["key"], since)).fetchall()
        good = "live" if s["kind"] == "live" else None
        up = sum(1 for c in ck if (c["status"] == good if good else c["status"] in ("video", "live")))
        vids = list(dict.fromkeys(c["video_id"] for c in ck))
        starts = {(c["video_id"], round((c["started_at"] or 0) / 3600)) for c in ck if c["started_at"]}
        restarts = max(0, len(starts) - 1) + con.execute("SELECT COUNT(*) n FROM events WHERE slot_key=? AND kind IN ('replaced','down') AND ts>?", (s["key"], since)).fetchone()["n"]
        hs = con.execute("SELECT height FROM probes WHERE video_id IN (%s) AND height IS NOT NULL AND ts>? ORDER BY ts" % ",".join("?" * len(vids)),
                         (*vids, since)).fetchall() if vids else []
        heights = []
        for h in hs:
            if not heights or heights[-1] != h["height"]:
                heights.append(h["height"])
        fl = con.execute("SELECT MAX(max_fps) m, COUNT(*) n, SUM(verdict='fail') f FROM flash WHERE slot_key=? AND ts>?", (s["key"], since - 86400)).fetchone()
        viewers = sorted(c["viewers"] for c in ck if c["viewers"] is not None)
        pct = 100.0 * up / len(ck) if ck else 0
        worst.append((pct, s["key"]))
        out.append("| %d | %s%s | %.1f%% | %d | %d | %d | %s | %s, %s, %s | %s |" % (
            s["idx"], s["key"], "" if not s["baked_hidden"] else " (spare)", pct, len(ck), len(vids), restarts,
            " → ".join("%sp" % h for h in heights) or "-", fl["m"] if fl["m"] is not None else "-", fl["n"], fl["f"] or 0,
            viewers[len(viewers) // 2] if viewers else "-"))
    ev = con.execute("SELECT * FROM events WHERE ts>? ORDER BY ts", (since,)).fetchall()
    out += ["", "## Events", ""] + ["- %s `%s` %s %s %s" % (fmt_ts(e["ts"]), e["slot_key"], e["kind"], e["video_id"] or "", e["detail"] or "") for e in ev]
    fails = con.execute("SELECT * FROM flash WHERE verdict='fail' ORDER BY ts").fetchall()
    out += ["", "## Flash failures (all time)", ""] + ["- %s %s `%s` %s/s regions %s (%s)" % (fmt_ts(f["ts"]), f["video_id"], f["slot_key"], f["max_fps"], f["regions"], f["source"]) for f in fails]
    worst.sort()
    out += ["", "Lowest uptime: " + ", ".join("%s %.1f%%" % (k, p) for p, k in worst[:8])]
    return "\n".join(out)
