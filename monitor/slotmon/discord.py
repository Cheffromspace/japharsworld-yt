"""Discord webhook alerts. Without DISCORD_WEBHOOK they only go to the journal; a send marked critical goes to
DISCORD_CRITICAL_WEBHOOK when it is set (none is today: the mass outage is a plain alert, #246)."""
import json, re, time

from . import config, db
from .youtube import http

COLORS = {"info": 0x7aa2f7, "good": 0x9ece6a, "warn": 0xe0af68, "urgent": 0xf7768e}


def mention_id():
    """The user ID in DISCORD_MENTION ("<@123>" or "123"), or None."""
    m = re.fullmatch(r"<@!?(\d{5,25})>|(\d{5,25})", config.DISCORD_MENTION)
    return (m.group(1) or m.group(2)) if m else None


def webhook(critical):
    """The critical channel for critical alerts when it is set, else the usual one."""
    return (critical and config.DISCORD_CRITICAL_WEBHOOK) or config.DISCORD_WEBHOOK


def send(con, title, body="", level="info", dedupe=None, every_hours=6, mention=False, critical=None):
    """dedupe: key that sends at most once per every_hours (service errors, quota). mention: ping DISCORD_MENTION's user
    (nothing passes it since #246); nothing else can ping anyone, whatever a stream title says.
    critical: to DISCORD_CRITICAL_WEBHOOK (default: what pings is critical; outage_watch says False)."""
    if dedupe:
        last = db.get_meta(con, "alert:" + dedupe, 0)
        if time.time() - last < every_hours * 3600:
            return
        db.set_meta(con, "alert:" + dedupe, time.time())
        con.commit()
    print("[alert:%s] %s %s" % (level, title, body.replace("\n", " | ")), flush=True)
    url = webhook(mention if critical is None else critical)
    if not url:
        return
    payload = {"username": "Everything is OK monitor",
               "embeds": [{"title": title[:256], "description": body[:4000], "color": COLORS.get(level, COLORS["info"])}],
               "allowed_mentions": {"parse": []}}
    uid = mention_id() if mention else None
    if uid:
        payload["content"] = "<@%s>" % uid
        payload["allowed_mentions"] = {"parse": [], "users": [uid]}
    try:
        http(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
    except Exception as e:
        print("discord send failed: %s" % e, flush=True)


def resolve(con, dedupe, title, body="", critical=False):
    """The all-clear for a dedupe'd warning, sent once and only if that warning went out since the last all-clear
    (owner, 2026-10-23: every "failed" alert gets a "restored" one). A new failure after it is sent at once."""
    if not db.get_meta(con, "alert:" + dedupe, 0):
        return False
    db.set_meta(con, "alert:" + dedupe, 0)
    con.commit()
    send(con, title, body, "good", critical=critical)
    return True
