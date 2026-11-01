#!/usr/bin/env bash
# japharsworld-yt bootstrap. Run once on the server, as root:
#   curl -fsSL https://raw.githubusercontent.com/Cheffromspace/japharsworld-yt/main/deploy/bootstrap.sh | bash
# Re-runnable, but NOT for a live box in use: it resets the checkout to the deploy branch, runs npm ci and restarts the
# service without waiting for plays to end (update.sh never runs it). A Caddy change on production goes by hand. A
# Caddyfile it can't safely change stops it with an error. Leaves anything else already running alone.
# Installs: Node 22 (if needed), the service (/opt/japharsworld-yt, runs as user "jyt"),
# yt-dlp + bgutil PO-token provider (captions), HTTPS for $DOMAIN, and a 5-minute auto-update timer
# that deploys whatever is on main (rolls back if the new version fails its health check).
set -euo pipefail

# >>> caddy-log-filter (test/deploy.test.js runs this part with a stand-in caddy)
# No request details in Caddy's logs (Everything-is-OK#399): an error line carried the client's address and the URL with
# its search text. request goes whole; a cut client's address is also inside "aborting with incomplete response"'s error
# field ("write tcp <server>-><client>: ..."), so that part is replaced and the message stays. A global block must come
# first in the Caddyfile. The block adapts on production's Caddy 2.6.2 (2026-10-31), and the same two changes applied
# to production's journal left no foreign address in those lines; a real cut line under the filter is still to be seen.
caddy_fail() { printf '\033[1;31mXX  %s\033[0m\n' "$*" >&2; exit 1; }
# Validation provisions the cloudflare module on staging, which rejects an empty token (seen 2026-10-26, world #210).
caddy_check() { ( if [ -f /etc/caddy/cloudflare.env ]; then set -a; . /etc/caddy/cloudflare.env; set +a; fi
  caddy validate --config "$1" --adapter caddyfile >/dev/null ); }
caddy_log_filter() {
  local file=$1 code adapted
  caddy_filter_added=0
  # Comments don't count: one mentioning "request delete" must not pass for the filter.
  code=$(sed -e 's/^[[:space:]]*#.*//' -e 's/[[:space:]]#.*//' "$file")
  if ! { grep -qE '^[[:space:]]*request[[:space:]]+delete[[:space:]]*$' <<<"$code" && grep -qF 'error regexp "->[^ ]+" "->client"' <<<"$code"; }; then
    # Two global blocks aren't allowed and merging one here is guesswork, so this stops before anything changes.
    if grep -qE '^[[:space:]]*[{]' <<<"$code"; then
      caddy_fail "$file has a line starting with { (a global block?) and not the log filter. Nothing changed: add the filter by hand (deploy/bootstrap.sh has it), then run this again."
    fi
    { cat <<'CADDY'
{
	log {
		format filter {
			wrap json
			fields {
				request delete
				error regexp "->[^ ]+" "->client"
			}
		}
	}
}

CADDY
      cat "$file"; } > "$file.new"
    caddy_check "$file.new" || { rm -f "$file.new"; caddy_fail "The Caddyfile with the log filter does not validate. Nothing changed."; }
    mv "$file.new" "$file"
    caddy_filter_added=1
  fi
  adapted=$(caddy adapt --config "$file" --adapter caddyfile 2>/dev/null) || caddy_fail "$file does not adapt."
  grep -qF '"request":{"filter":"delete"}' <<<"$adapted" || caddy_fail "$file does not apply the log filter."
}
# <<< caddy-log-filter

# Wrapped in main() so that "curl | bash" reads the whole script before running any of it.
main() {
DOMAIN="${DOMAIN:-yt.japharsworld.com}"
REPO="${REPO:-https://github.com/Cheffromspace/japharsworld-yt.git}"
APP=/opt/japharsworld-yt
VENV=/opt/japharsworld-yt-venv
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
# A fresh box runs unattended-upgrades at first boot: wait for its dpkg lock instead of failing (2026-10-26, the
# production rebuild lost the lock on its first run). Every apt call here and in the setup scripts waits up to 10 min.
echo 'DPkg::Lock::Timeout "600";' > /etc/apt/apt.conf.d/90japharsworld-yt-lock
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

say "Hardening (deploy/harden.sh)"
# Needs the known addresses (/etc/japharsworld-yt-security.env, local only: the repo is public).
if [ -f /etc/japharsworld-yt-security.env ]; then bash "$APP/deploy/harden.sh"
else warn "No /etc/japharsworld-yt-security.env: SSH, fail2ban and ufw are not hardened. Write SSH_KNOWN_SOURCES there, then run deploy/harden.sh."; fi

say "yt-dlp + bgutil PO-token plugin (captions)"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q -U pip
"$VENV/bin/pip" install -q -U "yt-dlp[default]"
"$VENV/bin/yt-dlp" --version

# The plugin and the token server, shared with the Optiplex (its unit is installed below).
bash "$APP/deploy/bgutil-setup.sh" "$VENV"

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
# lb_try_*: a deploy restarts the service (~1.3 s down, 2026-10-24); new requests wait for it instead of getting 502.
site_block="$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT {
		lb_try_duration 5s
		lb_try_interval 250ms
	}
}"
if [ -z "$on443" ] || [[ "$on443" == *caddy* ]]; then
  if ! command -v caddy >/dev/null; then
    # Caddy's own apt repo (cloudsmith) started answering 402; Ubuntu ships Caddy in universe.
    rm -f /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confnew caddy >/dev/null || { warn "Could not install Caddy from apt."; exit 1; }
  fi
  caddy version
  mkdir -p /etc/caddy/sites
  # A site file that already serves this name stays: production's also lists eiok.cc, and writing DOMAIN alone would
  # drop it (a verifier's find, 2026-10-31).
  grep -qF "$DOMAIN" /etc/caddy/sites/japharsworld-yt.caddy 2>/dev/null || echo "$site_block" > /etc/caddy/sites/japharsworld-yt.caddy
  grep -q 'import sites/\*' /etc/caddy/Caddyfile 2>/dev/null || {
    # Fresh Caddy ships a demo :80 site; keep whatever else is there, drop only the stock demo.
    if grep -q 'root \* /usr/share/caddy' /etc/caddy/Caddyfile 2>/dev/null && [ "$(grep -c '{' /etc/caddy/Caddyfile)" -le 2 ]; then
      : > /etc/caddy/Caddyfile
    fi
    echo 'import sites/*' >> /etc/caddy/Caddyfile
  }
  caddy_log_filter /etc/caddy/Caddyfile
  caddy_check /etc/caddy/Caddyfile
  systemctl enable --now caddy
  # A reload leaves streams open across it on the old logger, whose lines keep the request details: only a restart
  # ends them (a verifier's find, 2026-10-31). Without a new filter a reload stays enough, and drops nothing.
  if [ "$caddy_filter_added" = 1 ]; then systemctl restart caddy; else systemctl reload caddy; fi
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
