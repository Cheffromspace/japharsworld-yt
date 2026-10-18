"""sleep-list.json + sleep-thumbs.jpg on GitHub Pages (docs/ on main), committed only when they change."""
import io, json, math, os, subprocess, urllib.error

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


def status_doc(slots, rows, overrides):
    """slots: channels.json slots; rows: db slot rows by key; overrides: monitor/overrides.json.
    Writes only what differs from what the world baked, so an unreadable file and an empty file mean the same."""
    out = {"notice": overrides.get("notice", ""), "slots": {}}
    ov = overrides.get("slots", {})
    for s in slots:
        key, o, r = s["key"], ov.get(s["key"], {}), rows.get(s["key"])
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
