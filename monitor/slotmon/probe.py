"""Resolution probe + WCAG flash check for one video, through yt-dlp and ffmpeg.

One yt-dlp extraction gives both: the height VRChat would get (its resolver asks for
"(mp4/best)[height<=?1080][height>=?64][width>=?64]"; live streams answer format 96 at 1080p) and a <=480p stream
URL for the flash check. Same method as SessionWork/2026-10-17/flashcheck/flashcheck.py (validated: the strobing fan
stream SbjZKmnZYao fails at 9/s): FLASH_SECONDS (60) at 30 fps, 160x90 grey; a flash is a pair of opposing changes in relative
luminance of at least 0.1 with the darker side below 0.8; fail at more than 3 flashes in any 1 s, measured over the
whole frame and each quarter.

Runs on the PC worker (residential IP) and on the server when a cookies file is set.
"""
import json, os, re, shutil, subprocess, sys, time

from . import config

W, H, FPS = 160, 90, 30
QUIET = {"creationflags": 0x08000000} if sys.platform == "win32" else {}  # no console windows from the scheduled PC worker
LUT = [((v / 255.0) ** 2.2) for v in range(256)]


def ffmpeg_path():
    if config.FFMPEG:
        return config.FFMPEG
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        raise RuntimeError("ffmpeg not found: set FFMPEG or install imageio-ffmpeg")


def ytdlp_cmd():
    cmd = [config.YTDLP, *config.YTDLP_ARGS, "--no-warnings", "-J"]
    if config.COOKIES and os.path.exists(config.COOKIES):
        cmd += ["--cookies", config.COOKIES]
    return cmd


def extract(url):
    cmd = ytdlp_cmd()
    cmd += ["--playlist-items", "1"] if "list=" in url and "v=" not in url else ["--no-playlist"]
    r = subprocess.run(cmd + [url], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=150, **QUIET)
    if r.returncode != 0 or not r.stdout.strip():
        err = [l for l in r.stderr.splitlines() if "ERROR" in l] or r.stderr.splitlines()[-1:] or ["yt-dlp failed"]
        raise RuntimeError(err[0][:300])
    info = json.loads(r.stdout)
    if info.get("_type") == "playlist":
        entries = [e for e in info.get("entries") or [] if e]
        if not entries:
            raise RuntimeError("playlist is empty")
        info = entries[0]
    return info


VRCHAT_SELECTOR = "(mp4/best)[height<=?1080][height>=?64][width>=?64]"


def _simple(args):
    cmd = [config.YTDLP, *args]
    if config.COOKIES and os.path.exists(config.COOKIES):
        cmd[1:1] = ["--cookies", config.COOKIES]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=150, **QUIET)
    if r.returncode != 0:
        err = [l for l in r.stderr.splitlines() if "ERROR" in l] or r.stderr.splitlines()[-1:] or ["yt-dlp failed"]
        raise RuntimeError(err[0][:300])
    return r.stdout.strip()


def vrchat_format(formats):
    """Format VRChat's selector would choose: best single-file mp4 within 1080p, else best single file."""
    av = [f for f in formats if f.get("vcodec") not in (None, "none") and f.get("acodec") not in (None, "none")
          and (f.get("height") or 0) >= 64 and (f.get("width") or 64) >= 64]
    for pool in ([f for f in av if f.get("ext") == "mp4" and (f.get("height") or 0) <= 1080], [f for f in av if (f.get("height") or 0) <= 1080], av):
        if pool:
            return pool[-1]  # yt-dlp lists formats worst to best
    return None


def flash_source(formats):
    vids = [f for f in formats if f.get("vcodec") not in (None, "none") and f.get("url")]
    small = [f for f in vids if 0 < (f.get("height") or 0) <= 480]
    pick = small[-1] if small else (vids[0] if vids else None)
    return pick and pick["url"]


def frames(src):
    # Owner, 2026-10-26: 60 s instead of 15, to catch a strobe that starts later. Measured on the Optiplex that day: a
    # 480p live stream (1.28 Mbps) took 7.4 s for 15 s (the buffered segments come at once) and 53 s for 60 s (the rest
    # in real time), ~9.6 MB; 1800 frames are 26 MB here.
    secs = config.FLASH_SECONDS
    cmd = [ffmpeg_path(), "-loglevel", "error", "-t", str(secs), "-i", src, "-vf", "fps=%d,scale=%d:%d,format=gray" % (FPS, W, H),
           "-f", "rawvideo", "-"]
    p = subprocess.run(cmd, capture_output=True, timeout=secs + 120, **QUIET)
    data, n = p.stdout, W * H
    return [data[i:i + n] for i in range(0, len(data) - n + 1, n)]


def region_means(fr):
    sums = [0.0] * 5
    cnt = [0] * 5
    hw, hh = W // 2, H // 2
    for y in range(0, H, 2):
        row = y * W
        q = 0 if y < hh else 2
        for x in range(0, W, 2):
            L = LUT[fr[row + x]]
            k = 1 + q + (0 if x < hw else 1)
            sums[0] += L; cnt[0] += 1; sums[k] += L; cnt[k] += 1
    return [s / c for s, c in zip(sums, cnt)]


def flashes_per_second(series):
    events = []
    ref = series[0]
    direction = 0
    for i, v in enumerate(series[1:], 1):
        d = v - ref
        if abs(d) >= 0.1 and min(v, ref) < 0.8:
            nd = 1 if d > 0 else -1
            if direction != 0 and nd != direction:
                events.append(i)
            direction = nd
            ref = v
        elif (direction >= 0 and v > ref) or (direction <= 0 and v < ref):
            ref = v
    best = 0
    for i, t in enumerate(events):
        best = max(best, sum(1 for u in events[i:] if u - t < FPS))
    return (best + 1) // 2


def flash_check(src):
    fs = frames(src)
    rec = {"frames": len(fs)}
    if len(fs) < FPS * 5:
        rec["verdict"] = "too-few-frames"
        return rec
    means = [region_means(f) for f in fs]
    regions = [flashes_per_second([m[r] for m in means]) for r in range(5)]
    rec.update(max_fps=max(regions), regions=regions, mean_luminance=round(sum(m[0] for m in means) / len(means), 4),
               verdict="fail" if max(regions) > config.FLASH_LIMIT else "pass")
    return rec


def run_job(job, runner):
    """job: {id, video_id, kind}. kind 'video' skips the flash check (static black-screen uploads)."""
    vid = job["video_id"]
    out = {"id": job["id"], "video_id": vid, "runner": runner, "ts": time.time()}
    try:
        url = "https://www.youtube.com/watch?v=" + vid
        try:
            info = extract(url)
        except RuntimeError as e:
            if "no such option" not in str(e):
                raise
            info = None  # VRChat's cut-down yt-dlp: only -f, -g, --get-format
        if info is None:
            fmt = _simple(["-f", VRCHAT_SELECTOR, "--get-format", url])
            m = re.match(r"(\S+) - (\d+)x(\d+)", fmt)
            out.update(height=int(m.group(3)) if m else None, format_id=m and m.group(1))
            if job.get("flash", True):
                src = _simple(["-g", "-f", "best[height<=?480]/best", url]).splitlines()
                out["flash"] = flash_check(src[0]) if src and src[0].startswith("http") else {"verdict": "unreachable"}
            return out
        fmts = info.get("formats") or []
        f = vrchat_format(fmts)
        if f is None and fmts:
            # Full yt-dlp lists a live stream's HLS formats without audio codecs, so ask it with VRChat's own selector.
            m = re.match(r"(\S+) - (\d+)x(\d+)", _simple(["-f", VRCHAT_SELECTOR, "--get-format", url]))
            f = m and {"format_id": m.group(1), "height": int(m.group(3))}
        out.update(live_status=info.get("live_status"), height=f and f.get("height"), format_id=f and f.get("format_id"),
                   title=info.get("title"), channel=info.get("channel"), channel_id=info.get("channel_id"),
                   started_at=info.get("release_timestamp"), viewers=info.get("concurrent_view_count"))
        if job.get("flash", True):
            src = flash_source(fmts)
            out["flash"] = flash_check(src) if src else {"verdict": "unreachable"}
    except subprocess.TimeoutExpired:
        out["error"] = "timeout"
    except Exception as e:
        out["error"] = str(e)[:300]
    return out
