#!/usr/bin/env bash
# japharsworld-yt bootstrap. Run once on the server, as root:
#   curl -fsSL https://raw.githubusercontent.com/Cheffromspace/japharsworld-yt/main/deploy/bootstrap.sh | bash
# Safe to re-run. Leaves MediaMTX and anything else already running alone.
# Installs: Node 22 (if needed), the service (/opt/japharsworld-yt, runs as user "jyt"),
# yt-dlp + bgutil PO-token provider (captions), HTTPS for $DOMAIN, and a 5-minute auto-update timer
# that deploys whatever is on main (rolls back if the new version fails its health check).
set -euo pipefail

# Wrapped in main() so that "curl | bash" reads the whole script before running any of it.
main() {
DOMAIN="${DOMAIN:-yt.japharsworld.com}"
REPO="${REPO:-https://github.com/Cheffromspace/japharsworld-yt.git}"
APP=/opt/japharsworld-yt
VENV=/opt/japharsworld-yt-venv
BGUTIL=/opt/bgutil-pot
BGUTIL_VERSION=2.0.2
DATA=/var/lib/japharsworld-yt
PORT=8790

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
command -v apt-get >/dev/null || { echo "This script expects Debian/Ubuntu (apt)."; exit 1; }

say "Box"
. /etc/os-release; echo "OS: $PRETTY_NAME"
echo "CPU: $(nproc)  RAM: $(free -m | awk '/Mem:/{print $2" MB total, "$7" MB available"}')  Disk free: $(df -h / | awk 'NR==2{print $4}')"
echo "Listening TCP ports:"; ss -ltnpH | awk '{print "  "$4"  "$6}' | sort -u
if [ "$(free -m | awk '/Mem:/{print $2}')" -lt 1500 ] && ! swapon --show | grep -q .; then
  say "Adding 1 GB swap (small box, no swap yet)"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Packages"
export DEBIAN_FRONTEND=noninteractive
rm -f /etc/apt/sources.list.d/caddy-stable.list  # left by an earlier run; that repo now answers 402
apt-get update -qq
apt-get install -y -qq git curl ca-certificates python3 python3-venv build-essential >/dev/null
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  say "Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node --version)"

say "Service user and folders"
id jyt >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin jyt
mkdir -p "$DATA" && chown jyt:jyt "$DATA"

say "App ($REPO)"
if [ -d "$APP/.git" ]; then git -C "$APP" fetch -q origin && git -C "$APP" reset -q --hard origin/main
else git clone -q "$REPO" "$APP"; fi
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

say "yt-dlp + bgutil PO-token plugin (captions)"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q -U pip
"$VENV/bin/pip" install -q -U "yt-dlp[default]" "bgutil-ytdlp-pot-provider==$BGUTIL_VERSION"
"$VENV/bin/yt-dlp" --version

say "bgutil PO-token server $BGUTIL_VERSION (127.0.0.1:4416)"
if [ "$(cat "$BGUTIL/.version" 2>/dev/null)" != "$BGUTIL_VERSION" ]; then
  rm -rf "$BGUTIL"
  git clone -q --single-branch --branch "$BGUTIL_VERSION" https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$BGUTIL"
  (cd "$BGUTIL/server" && npm ci --no-audit --no-fund --loglevel=error && npx tsc)
  echo "$BGUTIL_VERSION" > "$BGUTIL/.version"
fi

say "Settings (/etc/japharsworld-yt.env)"
if [ ! -f /etc/japharsworld-yt.env ]; then
  cat > /etc/japharsworld-yt.env <<EOF
HOST=127.0.0.1
PORT=$PORT
SHARDS=8
POOL=2000
PIN_HOURS=24
DB_PATH=$DATA/tickets.db
YTDLP=$VENV/bin/yt-dlp
YTDLP_ARGS=--js-runtimes node
EOF
fi
cat /etc/japharsworld-yt.env

say "systemd units"
install -m 644 "$APP/deploy/japharsworld-yt.service" /etc/systemd/system/
install -m 644 "$APP/deploy/bgutil-pot.service" /etc/systemd/system/
install -m 644 "$APP/deploy/japharsworld-yt-update.service" /etc/systemd/system/
install -m 644 "$APP/deploy/japharsworld-yt-update.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bgutil-pot.service
systemctl enable japharsworld-yt.service && systemctl restart japharsworld-yt.service
systemctl enable --now japharsworld-yt-update.timer
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/healthz" && echo || { warn "Service did not answer; see: journalctl -u japharsworld-yt -n 50"; exit 1; }

say "HTTPS for $DOMAIN"
public_ip=$(curl -fsS4 --max-time 5 https://api.ipify.org || true)
dns_ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
echo "This box: ${public_ip:-unknown}   $DOMAIN resolves to: ${dns_ip:-nothing yet}"
[ -n "$dns_ip" ] && [ "$dns_ip" = "$public_ip" ] || warn "DNS for $DOMAIN does not point here yet. HTTPS certificates will fail until it does (Caddy keeps retrying on its own)."

on443=$(ss -ltnpH '( sport = :443 or sport = :80 )' | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' ')
echo "Already on ports 80/443: ${on443:-nothing}"
site_block="$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}"
if [ -z "$on443" ] || [[ "$on443" == *caddy* ]]; then
  if ! command -v caddy >/dev/null; then
    # Caddy's own apt repo (cloudsmith) started answering 402; Ubuntu ships Caddy in universe.
    rm -f /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null || { warn "Could not install Caddy from apt."; exit 1; }
  fi
  caddy version
  mkdir -p /etc/caddy/sites
  echo "$site_block" > /etc/caddy/sites/japharsworld-yt.caddy
  grep -q 'import sites/\*' /etc/caddy/Caddyfile 2>/dev/null || {
    # Fresh Caddy ships a demo :80 site; keep whatever else is there, drop only the stock demo.
    if grep -q 'root \* /usr/share/caddy' /etc/caddy/Caddyfile 2>/dev/null && [ "$(grep -c '{' /etc/caddy/Caddyfile)" -le 2 ]; then
      : > /etc/caddy/Caddyfile
    fi
    echo 'import sites/*' >> /etc/caddy/Caddyfile
  }
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl enable --now caddy && systemctl reload caddy
  echo "Caddy serves https://$DOMAIN"
elif [[ "$on443" == *nginx* ]]; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  cat > /etc/nginx/sites-available/japharsworld-yt <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location / { proxy_pass http://127.0.0.1:$PORT; proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$remote_addr; proxy_read_timeout 120s; }
}
EOF
  ln -sf /etc/nginx/sites-available/japharsworld-yt /etc/nginx/sites-enabled/japharsworld-yt
  nginx -t && systemctl reload nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || warn "certbot failed (DNS not ready?). Re-run this script once DNS points here."
else
  warn "Ports 80/443 are used by: $on443. Not touching them. Point that proxy at http://127.0.0.1:$PORT for $DOMAIN."
fi
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; echo "ufw: opened 80, 443"; fi

say "Done"
echo "Local:  curl http://127.0.0.1:$PORT/healthz"
echo "Public: curl https://$DOMAIN/healthz"
echo "Logs:   journalctl -u japharsworld-yt -f"
echo "Updates: main is deployed every 5 minutes (journalctl -u japharsworld-yt-update)"
}
main "$@"
