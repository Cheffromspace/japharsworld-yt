"""Discord webhook alerts. Without DISCORD_WEBHOOK they only go to the journal."""
import json, time

from . import config, db
from .youtube import http

COLORS = {"info": 0x7aa2f7, "good": 0x9ece6a, "warn": 0xe0af68, "urgent": 0xf7768e}


def send(con, title, body="", level="info", dedupe=None, every_hours=6):
    """dedupe: key that sends at most once per every_hours (service errors, quota)."""
    if dedupe:
        last = db.get_meta(con, "alert:" + dedupe, 0)
        if time.time() - last < every_hours * 3600:
            return
        db.set_meta(con, "alert:" + dedupe, time.time())
        con.commit()
    print("[alert:%s] %s %s" % (level, title, body.replace("\n", " | ")), flush=True)
    if not config.DISCORD_WEBHOOK:
        return
    payload = {"username": "Everything is OK monitor",
               "embeds": [{"title": title[:256], "description": body[:4000], "color": COLORS.get(level, COLORS["info"])}],
               "allowed_mentions": {"parse": ["users"]}}
    if level == "urgent" and config.DISCORD_MENTION:
        payload["content"] = config.DISCORD_MENTION
    try:
        http(config.DISCORD_WEBHOOK, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
    except Exception as e:
        print("discord send failed: %s" % e, flush=True)
