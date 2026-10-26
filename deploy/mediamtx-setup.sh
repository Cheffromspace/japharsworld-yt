#!/usr/bin/env bash
# MediaMTX on the Linode (owner's stream; rebuilt 2026-10-26 after production was wiped: nothing about it was in a repo
# before). As root; safe to re-run. Installs the pinned release (checksum checked), user mediamtx, the config from
# deploy/mediamtx.yml with the credentials filled in, and mediamtx.service.
#   bash /opt/japharsworld-yt/deploy/mediamtx-setup.sh
# Credentials are local, never in the repo: /etc/mediamtx/credentials.env (root 0600), written as a template on the
# first run:
#   PUBLISH_USER, PUBLISH_PASS   what home's encoder (OBS) publishes ingest with
#   LIVE_FROM_INGEST             optional: the command that turns ingest into live (default: copy it unchanged)
set -euo pipefail
main() {
VERSION=v1.21.2   # 2026-10-08; v1.21.3 was a day old when this was written
SHA256=121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27   # mediamtx_v1.21.2_linux_amd64.tar.gz
HERE=$(cd "$(dirname "$0")" && pwd)
CRED=/etc/mediamtx/credentials.env
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "This pins the linux_amd64 build."; exit 1; }

install -d -m 755 /etc/mediamtx
if [ ! -f "$CRED" ]; then
  cat > "$CRED" <<'EOT'
# MediaMTX credentials (deploy/mediamtx-setup.sh). Root only; never in the repo.
PUBLISH_USER=
PUBLISH_PASS=
# What turns ingest into live, run by MediaMTX as user mediamtx. Empty = copy unchanged with ffmpeg.
LIVE_FROM_INGEST=
EOT
  chmod 600 "$CRED"
  echo "Fill in $CRED, then run this again."; exit 1
fi
chown root:root "$CRED"; chmod 600 "$CRED"
set -a; . "$CRED"; set +a
[ -n "${PUBLISH_USER:-}" ] && [ "$PUBLISH_USER" != any ] && [ -n "${PUBLISH_PASS:-}" ] || { echo "PUBLISH_USER (not 'any') and PUBLISH_PASS must be set in $CRED."; exit 1; }
export LIVE_FROM_INGEST="${LIVE_FROM_INGEST:-ffmpeg -nostdin -loglevel warning -i rtsp://localhost:8554/ingest -c copy -f rtsp rtsp://localhost:8554/live}"

echo "== MediaMTX $VERSION"
if [ "$(/usr/local/bin/mediamtx --version 2>/dev/null || true)" != "$VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL --proto '=https' -o "$tmp/m.tar.gz" "https://github.com/bluenviron/mediamtx/releases/download/$VERSION/mediamtx_${VERSION}_linux_amd64.tar.gz"
  echo "$SHA256  $tmp/m.tar.gz" | sha256sum -c --quiet - || { echo "Checksum mismatch; nothing installed."; rm -rf "$tmp"; exit 1; }
  tar xzf "$tmp/m.tar.gz" -C "$tmp" mediamtx
  install -m 755 "$tmp/mediamtx" /usr/local/bin/mediamtx
  rm -rf "$tmp"
fi
/usr/local/bin/mediamtx --version
case "$LIVE_FROM_INGEST" in ffmpeg*) command -v ffmpeg >/dev/null || apt-get install -y -qq ffmpeg >/dev/null ;; esac

echo "== User and config"
id mediamtx >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin mediamtx
# The values go in as JSON strings, which YAML reads as double-quoted scalars: any password character is safe.
node -e '
  const fs = require("fs");
  const q = (k) => JSON.stringify(process.env[k] ?? "");
  let t = fs.readFileSync(process.argv[1], "utf8");
  for (const k of ["PUBLISH_USER", "PUBLISH_PASS", "LIVE_FROM_INGEST"]) t = t.split(`__${k}__`).join(q(k));
  if (/__[A-Z_]+__/.test(t)) { console.error("template placeholder left unfilled"); process.exit(1); }
  fs.writeFileSync(process.argv[2], t, { mode: 0o640 });
' "$HERE/mediamtx.yml" /etc/mediamtx/mediamtx.yml.new
chown root:mediamtx /etc/mediamtx/mediamtx.yml.new
mv /etc/mediamtx/mediamtx.yml.new /etc/mediamtx/mediamtx.yml

echo "== Unit"
install -m 644 "$HERE/mediamtx.service" /etc/systemd/system/mediamtx.service
systemctl daemon-reload
systemctl enable -q mediamtx
systemctl restart mediamtx
for i in $(seq 1 10); do systemctl is-active -q mediamtx && ss -ltn '( sport = :8554 )' | grep -q 8554 && break; sleep 1; done
echo "mediamtx: $(systemctl is-active mediamtx); listening: $(ss -ltnH '( sport = :8554 or sport = :1935 )' | awk '{print $4}' | tr '\n' ' ')"
echo "Publish from home: rtmp://<this host>:1935/ingest (user $PUBLISH_USER). Watch: rtsp://stream.japharsworld.com:8554/live"
}
main "$@"
