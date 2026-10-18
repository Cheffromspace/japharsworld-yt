"""Reading YouTube without yt-dlp: the Data API when a key or OAuth grant is set, else the watch page's HTML.

From the Linode, yt-dlp gets "Sign in to confirm you're not a bot", but plain page loads still carry ytInitialData
(title, channel, live flag, concurrent viewers, "Started streaming on ..."). That is enough for live/ended checks
and for finding a channel's current live stream. Formats (resolution) and frames (flash check) need yt-dlp: probe.py.
"""
import datetime as dt, gzip, json, re, time, urllib.error, urllib.parse, urllib.request
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import config

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
try:
    PACIFIC = ZoneInfo("America/Los_Angeles")  # the API quota day
except ZoneInfoNotFoundError:  # Windows without tzdata (the PC worker never counts quota)
    PACIFIC = dt.timezone(dt.timedelta(hours=-8))


def http(url, data=None, headers=None, method=None, timeout=30):
    h = {"User-Agent": UA, "Accept-Encoding": "gzip", "Accept-Language": "en-US,en;q=0.8"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return r.status, body


def video_id(url):
    m = re.search(r"(?:v=|youtu\.be/|/live/)([\w-]{11})", url or "")
    return m.group(1) if m else None


# ---------- HTML ----------

def _initial(html, name):
    m = re.search(r"var " + name + r"\s*=\s*(\{.+?\});\s*(?:var |</script>)", html, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return None


def _walk(o, key):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key:
                yield v
            yield from _walk(v, key)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v, key)


def _first(o, key):
    return next(_walk(o, key), None)


def _text(t):
    if not isinstance(t, dict):
        return None
    if "simpleText" in t:
        return t["simpleText"]
    return "".join(r.get("text", "") for r in t.get("runs", [])) or None


MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def parse_date_text(s, now=None):
    """'Started streaming on Oct 1, 2026' / 'Started streaming 5 hours ago' -> epoch seconds (UTC; a date gives midnight Pacific)."""
    now = now or time.time()
    if not s:
        return None
    m = re.search(r"(\d+)\s+(second|minute|hour|day|week)s?\s+ago", s)
    if m:
        mult = {"second": 1, "minute": 60, "hour": 3600, "day": 86400, "week": 604800}[m.group(2)]
        return now - int(m.group(1)) * mult
    m = re.search(r"([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})", s)
    if m and m.group(1).lower() in MONTHS:
        d = dt.datetime(int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2)), tzinfo=PACIFIC)
        return d.timestamp()
    return None


def parse_watch(html, now=None):
    """Status of one video from its watch page. status: live | ended | upcoming | video | unavailable."""
    player = _initial(html, "ytInitialPlayerResponse") or {}
    data = _initial(html, "ytInitialData") or {}
    ps = player.get("playabilityStatus") or {}
    cur = _first(_first(data, "currentVideoEndpoint") or {}, "videoId")
    out = {"source": "html", "video_id": cur}
    if ps.get("status") == "ERROR":
        out.update(status="unavailable", error=ps.get("reason") or "video unavailable")
        return out
    if not cur:
        # A bot-wall page carries no video at all: that says nothing about the stream.
        out.update(status="error", error=ps.get("reason") or "no video on the page")
        return out
    prim = _first(data, "videoPrimaryInfoRenderer") or {}
    owner = _first(data, "videoOwnerRenderer") or {}
    vc = _first(prim, "videoViewCountRenderer") or {}
    date_text = _text(prim.get("dateText")) or ""
    out["title"] = _text(prim.get("title"))
    out["channel"] = _text(owner.get("title"))
    out["channel_id"] = _first(owner.get("navigationEndpoint") or {}, "browseId")
    mf = (player.get("microformat") or {}).get("playerMicroformatRenderer") or {}
    lbd = mf.get("liveBroadcastDetails") or {}
    if vc.get("isLive"):
        out["status"] = "live"
        try:
            out["viewers"] = int(vc.get("originalViewCount") or 0)
        except ValueError:
            pass
    elif date_text.startswith(("Streamed live", "Streamed ")) or lbd.get("endTimestamp") or "recording is not available" in (ps.get("reason") or ""):
        out["status"] = "ended"
    elif date_text.startswith(("Scheduled", "Premieres", "Waiting")):
        out["status"] = "upcoming"
    elif ps.get("status") == "UNPLAYABLE":
        out.update(status="unavailable", error=ps.get("reason"))
    else:
        out["status"] = "video"
    start = lbd.get("startTimestamp")
    out["started_at"] = dt.datetime.fromisoformat(start).timestamp() if start else parse_date_text(date_text, now)
    out["started_precision"] = "exact" if start else ("relative" if "ago" in date_text else "day")
    return out


def watch_status(vid, tries=2):
    for attempt in range(tries):
        try:
            _, body = http("https://www.youtube.com/watch?v=%s&hl=en&gl=US" % vid, headers={"Cookie": "CONSENT=YES+1; SOCS=CAI"})
            r = parse_watch(body.decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            r = {"source": "html", "status": "unavailable" if e.code == 404 else "error", "error": "HTTP %d" % e.code}
        except Exception as e:  # network
            r = {"source": "html", "status": "error", "error": str(e)[:200]}
        if r.get("video_id") not in (None, vid):
            r.update(status="unavailable", error="page shows another video")
        r["video_id"] = vid
        if r["status"] != "error":
            break
        time.sleep(3)
    return r


def parse_streams_tab(html):
    """Video IDs the channel's Live tab marks LIVE (newest first)."""
    data = _initial(html, "ytInitialData") or {}
    ids = []
    for v in _walk(data, "videoRenderer"):
        if isinstance(v, dict) and v.get("videoId") and '"LIVE"' in json.dumps(v):
            ids.append(v["videoId"])
    for v in _walk(data, "lockupViewModel"):
        if isinstance(v, dict) and v.get("contentId") and '"LIVE"' in json.dumps(v):
            ids.append(v["contentId"])
    return list(dict.fromkeys(ids))


def channel_live_ids(channel_id):
    """The channel's /live video (if live), then its other live streams. No API quota."""
    ids = []
    hdr = {"Cookie": "CONSENT=YES+1; SOCS=CAI"}
    try:
        _, body = http("https://www.youtube.com/channel/%s/live?hl=en&gl=US" % channel_id, headers=hdr)
        r = parse_watch(body.decode("utf-8", "replace"))
        if r.get("status") == "live" and r.get("video_id"):
            ids.append(r["video_id"])
    except Exception:
        pass
    try:
        _, body = http("https://www.youtube.com/channel/%s/streams?hl=en&gl=US" % channel_id, headers=hdr)
        ids += parse_streams_tab(body.decode("utf-8", "replace"))
    except Exception:
        pass
    return list(dict.fromkeys(ids))


def oembed_thumbnail(url):
    _, body = http("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(url, safe=""))
    return json.loads(body)["thumbnail_url"]


# ---------- Data API ----------

class QuotaExceeded(Exception):
    pass


class Api:
    BASE = "https://www.googleapis.com/youtube/v3/"

    def __init__(self, con):
        self.con = con
        self._token = None
        self._token_until = 0

    @property
    def can_read(self):
        return bool(config.YT_API_KEY or self.can_write)

    @property
    def can_write(self):
        return bool(config.YT_CLIENT_ID and config.YT_CLIENT_SECRET and config.YT_REFRESH_TOKEN)

    @staticmethod
    def quota_day(ts=None):
        return dt.datetime.fromtimestamp(ts or time.time(), PACIFIC).strftime("%Y-%m-%d")

    def used_today(self):
        r = self.con.execute("SELECT COALESCE(SUM(units),0) u FROM quota WHERE day=?", (self.quota_day(),)).fetchone()
        return r["u"]

    def _spend(self, units, what, essential):
        limit = config.QUOTA_LIMIT if essential else config.QUOTA_RESERVE
        if self.used_today() + units > limit:
            raise QuotaExceeded("%s needs %d units; %d of %d used today" % (what, units, self.used_today(), limit))
        self.con.execute("INSERT INTO quota(day,ts,units,what) VALUES(?,?,?,?)", (self.quota_day(), time.time(), units, what))
        self.con.commit()

    def token(self):
        if self._token and time.time() < self._token_until:
            return self._token
        body = urllib.parse.urlencode({"client_id": config.YT_CLIENT_ID, "client_secret": config.YT_CLIENT_SECRET,
                                       "refresh_token": config.YT_REFRESH_TOKEN, "grant_type": "refresh_token"}).encode()
        _, out = http("https://oauth2.googleapis.com/token", data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
        j = json.loads(out)
        self._token, self._token_until = j["access_token"], time.time() + int(j.get("expires_in", 3600)) - 120
        return self._token

    def call(self, method, path, params, units, what, body=None, write=False, essential=False):
        self._spend(units, what, essential)
        params = dict(params)
        headers = {}
        if write or not config.YT_API_KEY:
            headers["Authorization"] = "Bearer " + self.token()
        else:
            params["key"] = config.YT_API_KEY
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        try:
            _, out = http(self.BASE + path + "?" + urllib.parse.urlencode(params), data=data, headers=headers, method=method)
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:400]
            raise RuntimeError("YouTube API %s %s: HTTP %d %s" % (method, path, e.code, msg)) from None
        return json.loads(out) if out else {}

    def videos(self, ids):
        out = {}
        ids = list(dict.fromkeys(i for i in ids if i))
        for i in range(0, len(ids), 50):
            chunk = ids[i:i + 50]
            j = self.call("GET", "videos", {"part": "snippet,liveStreamingDetails,status,contentDetails", "id": ",".join(chunk), "maxResults": 50},
                          1, "videos.list")
            for item in j.get("items", []):
                out[item["id"]] = item
        return {vid: self.parse_video(vid, out.get(vid)) for vid in ids}

    @staticmethod
    def parse_video(vid, item):
        if item is None:
            return {"source": "api", "video_id": vid, "status": "unavailable", "error": "not returned (removed or private)"}
        sn, live, st = item.get("snippet", {}), item.get("liveStreamingDetails") or {}, item.get("status", {})
        r = {"source": "api", "video_id": vid, "title": sn.get("title"), "channel": sn.get("channelTitle"), "channel_id": sn.get("channelId")}
        lbc = sn.get("liveBroadcastContent")
        if st.get("privacyStatus") == "private" or st.get("uploadStatus") in ("rejected", "deleted", "failed"):
            r.update(status="unavailable", error="privacy %s, upload %s" % (st.get("privacyStatus"), st.get("uploadStatus")))
        elif lbc == "live":
            r["status"] = "live"
        elif lbc == "upcoming":
            r["status"] = "upcoming"
        elif live:
            r["status"] = "ended"
        else:
            r["status"] = "video"
        if live.get("actualStartTime"):
            r["started_at"] = dt.datetime.fromisoformat(live["actualStartTime"].replace("Z", "+00:00")).timestamp()
            r["started_precision"] = "exact"
        if live.get("concurrentViewers"):
            r["viewers"] = int(live["concurrentViewers"])
        return r

    def playlist_items(self, playlist, essential=False):
        j = self.call("GET", "playlistItems", {"part": "snippet", "playlistId": playlist, "maxResults": 50}, 1, "playlistItems.list",
                      write=True, essential=essential)
        items = j.get("items", [])
        items.sort(key=lambda i: i["snippet"].get("position", 0))
        return [(i["id"], i["snippet"]["resourceId"].get("videoId")) for i in items]

    def insert_first(self, playlist, vid):
        body = {"snippet": {"playlistId": playlist, "position": 0, "resourceId": {"kind": "youtube#video", "videoId": vid}}}
        return self.call("POST", "playlistItems", {"part": "snippet"}, 50, "playlistItems.insert", body=body, write=True, essential=True)

    def delete_item(self, item_id):
        self.call("DELETE", "playlistItems", {"id": item_id}, 50, "playlistItems.delete", write=True, essential=True)
