"""Settings from the environment (on the server: /etc/japharsworld-yt-monitor.env, loaded by systemd)."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MONITOR = os.path.dirname(HERE)


def _env(name, default=""):
    return os.environ.get(name, default).strip()


def _int(name, default):
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


DATA_DIR = _env("DATA_DIR", os.path.join(MONITOR, "data"))
DB_PATH = _env("DB_PATH", os.path.join(DATA_DIR, "monitor.db"))
CHANNELS = _env("CHANNELS", os.path.join(MONITOR, "channels.json"))
OVERRIDES = _env("OVERRIDES", os.path.join(MONITOR, "overrides.json"))

# YouTube Data API. An API key is enough for reading; playlist swaps need the owner's OAuth grant (scope youtube).
YT_API_KEY = _env("YT_API_KEY")
YT_CLIENT_ID = _env("YT_CLIENT_ID")
YT_CLIENT_SECRET = _env("YT_CLIENT_SECRET")
YT_REFRESH_TOKEN = _env("YT_REFRESH_TOKEN")
QUOTA_LIMIT = _int("QUOTA_LIMIT", 10000)
QUOTA_WARN = _int("QUOTA_WARN", 8000)      # alert once a day past this
QUOTA_RESERVE = _int("QUOTA_RESERVE", 9000)  # past this, only swaps and flash-fail removals spend units

DISCORD_WEBHOOK = _env("DISCORD_WEBHOOK")
# e.g. <@123456789>: pinged only when MASS_DOWN or more shown slots are down or hidden at once (owner, 2026-10-26: single
# outages and flash fails are handled by the monitor and stay unmentioned).
DISCORD_MENTION = _env("DISCORD_MENTION")
MASS_DOWN = _int("MASS_DOWN", 8)

# Publishing to GitHub Pages: a clone of this repo that the monitor commits docs/ to.
PUBLISH = _env("PUBLISH", "1") == "1"
PAGES_REPO = _env("PAGES_REPO", "git@github.com:Cheffromspace/japharsworld-yt.git")
PAGES_BRANCH = _env("PAGES_BRANCH", "main")
PAGES_CLONE = _env("PAGES_CLONE", os.path.join(DATA_DIR, "pages"))
GIT_SSH_KEY = _env("GIT_SSH_KEY")
STATUS_FILE = "docs/sleep-list.json"
THUMBS_FILE = "docs/sleep-thumbs.jpg"
THUMBS_REFRESH_HOURS = _int("THUMBS_REFRESH_HOURS", 24)

# yt-dlp runs (resolution + flash check). On the Linode they need a cookies file (datacenter IPs get the bot wall).
YTDLP = _env("YTDLP", "yt-dlp")
YTDLP_ARGS = _env("YTDLP_ARGS").split()
COOKIES = _env("COOKIES")
FFMPEG = _env("FFMPEG")
LOCAL_JOBS = _int("LOCAL_JOBS", 6)  # jobs the server runs itself per pass when COOKIES exists

# Rules
MIN_HEIGHT = _int("MIN_HEIGHT", 720)
MIN_HOURS = _int("MIN_HOURS", 40)
FLASH_LIMIT = _int("FLASH_LIMIT", 3)  # fail at more than this many flashes in any 1 s
FLASH_SECONDS = _int("FLASH_SECONDS", 60)  # seconds of stream each flash check samples (15 before 2026-10-26)
DAILY_HOUR_UTC = _int("DAILY_HOUR_UTC", 14)  # 09:00 CDT
WORKER_STALE_HOURS = _int("WORKER_STALE_HOURS", 36)
BANNED_WORDS = ["asmr", "yellow brick cinema", "yellowbrickcinema"]
