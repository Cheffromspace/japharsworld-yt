"""sleep-list.json + sleep-thumbs.jpg on GitHub Pages (docs/ on main), committed only when they change."""
import io, json, math, os, re, subprocess, unicodedata, urllib.error

from . import config
from .youtube import http, oembed_thumbnail, video_id

COLS, CELL_W, CELL_H = 10, 192, 108  # EverythingIsOKTabletLayout.Channels.cs: ThumbCols, ThumbW, ThumbH
DEEP = (0x16, 0x16, 0x1e)
WORLD_FIELDS = ("hidden", "title", "channel", "order", "category")
CATEGORIES = ("music", "sounds", "nature", "space", "games", "trains", "cities", "sensory", "docs")


def sheet_size(n):
    """Same as the baker: next power of two of the cell grid. The world ignores a sheet of any other size."""
    p2 = lambda v: 1 << max(0, math.ceil(math.log2(v)))
    return p2(COLS * CELL_W), p2(max(1, math.ceil(n / COLS)) * CELL_H)


# A title that follows the stream (overrides.json "title_from": "stream", Everything-is-OK#793, owner 2026-11-15) is the
# stream's own title made calm for the list: no emoji (the row's Noto font has none: 🔴 and 🔥 draw as empty boxes, checked
# against NotoSansCJKjp-Regular.otf 2026-11-15), no "LIVE" / "24/7" / "Live Now:" markers, no separator left dangling.
LIVE_STAMP = re.compile(r"\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*$")  # yt-dlp appends this to a live title (its fulltitle doesn't)
MARKERS = re.compile(r"\blive\s+now\b\s*:?|(?<![\w/])24\s*/\s*7(?![\w/])|\blive\b", re.IGNORECASE)
EMPTY_BRACKETS = re.compile(r"[(\[【「『（〔]\s*[)\]】」』）〕]")
SEPARATORS = set("·•|｜-–—:")
PUNCT = set(",.!?;")  # left alone after a removed marker: "LIVE! View of ..." , "ISS live, with ..."


def _pictograph(ch):
    """Emoji and pictographs; CJK and fullwidth symbols stay (Japanese titles use them as text)."""
    cp, cat = ord(ch), unicodedata.category(ch)
    if 0x1F000 <= cp <= 0x1FAFF or 0xFE00 <= cp <= 0xFE0F or cat in ("Cf", "Co", "Cs", "Me"):
        return True  # emoji blocks (also any newer than this Python knows), variation selectors, ZWJ and tags, keycaps
    return cat == "So" and cp >= 0x2190 and not (0x2E80 <= cp <= 0x33FF or 0xFF00 <= cp <= 0xFFEF)


def clean_title(raw):
    """The stream's title for a calm row, or '' when nothing worth showing is left (the caller falls back)."""
    t = LIVE_STAMP.sub("", raw or "")
    t = "".join(" " if _pictograph(c) else c for c in t)
    t = MARKERS.sub(" ", t)
    while EMPTY_BRACKETS.search(t):
        t = EMPTY_BRACKETS.sub(" ", t)
    words = []
    for w in t.split():
        if not words and set(w) <= SEPARATORS | PUNCT:
            continue  # nothing before it
        if set(w) <= PUNCT:
            if not set(words[-1]) <= SEPARATORS:
                words[-1] += w  # "ISS , with" -> "ISS, with"
            continue
        if set(w) <= SEPARATORS:
            if words and not set(words[-1]) <= SEPARATORS:
                words.append(w)  # a separator only between two words, and only one
            continue
        words.append(w)
    while words and set(words[-1]) <= SEPARATORS:
        words.pop()
    words = [w[:-1] if w.endswith(":") and (i + 1 == len(words) or set(words[i + 1]) <= SEPARATORS) else w
             for i, w in enumerate(words)]  # "Title: · more" or a closing "Title:" left by a removed marker
    t = " ".join(words)
    return t if any(c.isalnum() for c in t) else ""


def status_doc(slots, rows, overrides, stream_titles=None):
    """slots: channels.json slots; rows: db slot rows by key; overrides: monitor/overrides.json; stream_titles: slot key ->
    the stored title of the stream it plays, for the slots whose override says "title_from": "stream" (core.stream_titles).
    Writes only what differs from what the world baked, so an unreadable file and an empty file mean the same."""
    out = {"notice": overrides.get("notice", ""), "slots": {}}
    ov = overrides.get("slots", {})
    for s in slots:
        key, o, r = s["key"], ov.get(s["key"], {}), rows.get(s["key"])
        if o.get("title_from") == "stream":
            t = clean_title((stream_titles or {}).get(key))
            if t:  # else the override's own title, else the baked one: never an empty row
                o = dict(o, title=t)
        e = {}
        hidden = bool(o.get("hidden", s.get("hidden", False)))
        if r is not None and r["auto_hidden"]:
            hidden = True
        if hidden != bool(s.get("hidden", False)):
            e["hidden"] = hidden
        for f in ("title", "channel", "order"):
            if f in o and o[f] != s.get(f):
                e[f] = o[f]
        if o.get("category") in CATEGORIES and o["category"] != s.get("category"):
            e["category"] = o["category"]
        if e:
            out["slots"][key] = e
    return out


def _thumb(vid, url):
    tries = []
    if vid:
        tries += ["https://i.ytimg.com/vi/%s/mqdefault_live.jpg" % vid, "https://i.ytimg.com/vi/%s/mqdefault.jpg" % vid]
    for u in tries:
        try:
            return http(u, timeout=20)[1]
        except urllib.error.HTTPError:
            continue
    if url and "list=" in url:
        try:
            return http(oembed_thumbnail(url), timeout=20)[1]
        except Exception:
            return None
    return None


def build_sheet(slots, current):
    """current: slot key -> video id now playing. Cell i = slot i, from the top left."""
    from PIL import Image
    w, h = sheet_size(len(slots))
    sheet = Image.new("RGB", (w, h), DEEP)
    missing = []
    for i, s in enumerate(slots):
        vid = current.get(s["key"]) or video_id(s.get("url"))
        url = s.get("url") or ""
        if not vid and s.get("playlist"):
            url = "https://www.youtube.com/playlist?list=" + s["playlist"]
        data = _thumb(vid if "list=" not in url else None, url)
        if not data:
            missing.append(s["key"])
            continue
        img = Image.open(io.BytesIO(data)).convert("RGB").resize((CELL_W, CELL_H), Image.BILINEAR)
        sheet.paste(img, ((i % COLS) * CELL_W, (i // COLS) * CELL_H))
    buf = io.BytesIO()
    sheet.save(buf, "JPEG", quality=85, optimize=True)
    return buf.getvalue(), missing


def _git(*args, check=True):
    env = dict(os.environ)
    if config.GIT_SSH_KEY:
        kh = os.path.join(config.DATA_DIR, "known_hosts")
        env["GIT_SSH_COMMAND"] = "ssh -i %s -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=%s" % (config.GIT_SSH_KEY, kh)
    cmd = ["git", "-c", "user.name=Everything is OK monitor", "-c", "user.email=slotmon@yt.japharsworld.com", *args]
    r = subprocess.run(cmd, cwd=config.PAGES_CLONE if os.path.isdir(config.PAGES_CLONE) else None, env=env,
                       capture_output=True, text=True, timeout=120)
    if check and r.returncode != 0:
        raise RuntimeError("git %s: %s" % (args[0], (r.stderr or r.stdout).strip()[-300:]))
    return r


def current_file(rel):
    p = os.path.join(config.PAGES_CLONE, rel)
    return open(p, "rb").read() if os.path.exists(p) else None


def publish(files, message):
    """files: repo path -> bytes. Returns True if a commit was pushed."""
    if not os.path.isdir(os.path.join(config.PAGES_CLONE, ".git")):
        os.makedirs(os.path.dirname(config.PAGES_CLONE), exist_ok=True)
        _git("clone", "-q", "--depth", "20", "--branch", config.PAGES_BRANCH, config.PAGES_REPO, config.PAGES_CLONE)
    for attempt in range(2):
        _git("fetch", "-q", "--depth", "20", "origin", config.PAGES_BRANCH)
        _git("reset", "-q", "--hard", "origin/" + config.PAGES_BRANCH)
        for rel, data in files.items():
            p = os.path.join(config.PAGES_CLONE, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(data)
        _git("add", "--", *files.keys())
        if _git("diff", "--cached", "--quiet", check=False).returncode == 0:
            return False
        _git("commit", "-q", "-m", message)
        if _git("push", "-q", "origin", "HEAD:" + config.PAGES_BRANCH, check=False).returncode == 0:
            return True
    raise RuntimeError("git push was rejected twice")


def dumps(doc):
    return (json.dumps(doc, indent=1, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
