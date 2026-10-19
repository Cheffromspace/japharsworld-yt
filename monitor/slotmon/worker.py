"""Flash-check worker: runs the resolution + flash jobs the Linode can't (YouTube bot-walls its datacenter IPs).

Every 20 minutes (systemd timer on the Optiplex, runner "optiplex"; or Task Scheduler on the owner's PC, runner "pc";
see monitor/README.md): ask the server for jobs over SSH, run each with yt-dlp (on the PC, VRChat's own, so the height
matches what VRChat gets) and ffmpeg, then send the results back. Quiet when there is nothing to do.
"""
import json, os, subprocess, sys, time

from . import config, probe

HOST = os.environ.get("SLOTMON_HOST", "root@172.239.34.136")
KEY = os.environ.get("SLOTMON_KEY", os.path.expanduser("~/.ssh/mediamtx_vps"))
VRCHAT_YTDLP = os.path.expandvars(r"%USERPROFILE%\AppData\LocalLow\VRChat\VRChat\Tools\yt-dlp.exe")
RUNNER = os.environ.get("SLOTMON_RUNNER", "pc")
LOG = os.environ.get("SLOTMON_LOG", os.path.join(config.MONITOR, "data", "worker.log"))  # "-": stdout (journald)


def log(msg):
    if LOG == "-":
        print(msg, flush=True)
        return
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))


def remote(args, stdin=None):
    cmd = ["ssh", "-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new", HOST, "/usr/local/bin/slotmon " + args]
    if os.environ.get("SLOTMON_KNOWN_HOSTS"):  # ssh ignores $HOME; the Optiplex service user's home is read-only
        cmd[1:1] = ["-o", "UserKnownHostsFile=" + os.environ["SLOTMON_KNOWN_HOSTS"]]
    r = subprocess.run(cmd, input=stdin, capture_output=True, text=True, encoding="utf-8", timeout=600, **probe.QUIET)
    if r.returncode != 0:
        raise RuntimeError("ssh slotmon %s: %s" % (args, (r.stderr or r.stdout).strip()[-400:]))
    return r.stdout


def main():
    if config.YTDLP == "yt-dlp" and os.path.exists(VRCHAT_YTDLP):
        config.YTDLP = VRCHAT_YTDLP
    try:
        jobs = json.loads(remote("claim --runner %s --max %d" % (RUNNER, int(os.environ.get("SLOTMON_MAX", "12")))))
    except Exception as e:
        log("claim failed: %s" % e)
        return 1
    if not jobs:
        return 0
    results = []
    for j in jobs:
        r = probe.run_job(j, RUNNER)
        fl = r.get("flash") or {}
        log("%s %s %s height=%s flash=%s/%s %s" % (j["reason"], j["video_id"], j.get("slot_key"), r.get("height"), fl.get("verdict"), fl.get("max_fps"), r.get("error") or ""))
        results.append(r)
        if fl.get("verdict") == "fail":
            break  # report a flash fail at once
    try:
        log(remote("submit --source %s" % RUNNER, json.dumps(results)).strip())
    except Exception as e:
        log("submit failed: %s" % e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
