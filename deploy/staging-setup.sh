#!/usr/bin/env bash
# Staging VPS (#160, owner 2026-10-26): one-time setup on the staging box, as root. Safe to re-run.
#   curl -fsSLO https://raw.githubusercontent.com/Cheffromspace/japharsworld-yt/staging/deploy/staging-setup.sh && bash staging-setup.sh
# The staging branch throughout: production deploys only main, so nothing here reaches it.
# Before it: /etc/japharsworld-yt-security.env with SSH_KNOWN_SOURCES (the addresses allowed on port 22; this run must
# come from one of them), and the production settings copied to /etc/japharsworld-yt.env (shared keys and caps).
# For the maintenance flip (deploy/dns-flip.sh) also /etc/caddy/cloudflare.env (CF_API_TOKEN=..., DNS edit on
# japharsworld.com and eiok.cc, root 0600): without it the production names are left out of Caddy.
# What it does: the service through bootstrap.sh (staging-yt.eiok.cc), deploys from the staging branch without the
# Channels monitor or the metrics poller (/etc/japharsworld-yt-deploy.env), Caddy with Cloudflare DNS-01 so it holds
# certificates for yt.japharsworld.com and eiok.cc before any flip, key-only SSH, fail2ban, ufw (22 from the known
# addresses, 80/443 public), the exporter, the security counters and Alloy (env="staging").
set -euo pipefail
main() {
DOMAIN=staging-yt.eiok.cc
PROD_NAMES="yt.japharsworld.com, eiok.cc"
# deploy/harden.sh (run by bootstrap.sh too): no stream here, so SSH from the known addresses and 80/443 only.
export HARDEN_HOME_TCP="22" HARDEN_PUBLIC_TCP="80 443"
APP=/opt/japharsworld-yt
PORT=8790
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }

say "Known SSH sources"
[ -f /etc/japharsworld-yt-security.env ] || { echo "Write /etc/japharsworld-yt-security.env (SSH_KNOWN_SOURCES=...) first."; exit 1; }
. /etc/japharsworld-yt-security.env
[ -n "${SSH_KNOWN_SOURCES:-}" ] || { echo "SSH_KNOWN_SOURCES is empty."; exit 1; }
chmod 600 /etc/japharsworld-yt-security.env
me=${SSH_CLIENT%% *}
# ufw below only lets these in on port 22: refuse to lock out the session running this.
if [ -n "$me" ] && ! printf ',%s,' "$SSH_KNOWN_SOURCES" | tr -d ' ' | grep -q ",$me,"; then
  echo "This SSH session is not from an address in SSH_KNOWN_SOURCES; ufw would lock it out. Nothing changed."; exit 1
fi
echo "$(echo "$SSH_KNOWN_SOURCES" | tr ',' '\n' | grep -c .) known address(es)"

say "Deploy switches (/etc/japharsworld-yt-deploy.env)"
[ -f /etc/japharsworld-yt-deploy.env ] || cat > /etc/japharsworld-yt-deploy.env <<'EOT'
# Staging (#160): read by deploy/update.sh. dns-flip.sh sets DEPLOY_BRANCH=main for a maintenance flip.
DEPLOY_BRANCH=staging
DEPLOY_MONITOR=off
DEPLOY_POLLER=off
DEPLOY_ALLOY=staging
EOT
chmod 644 /etc/japharsworld-yt-deploy.env
cat /etc/japharsworld-yt-deploy.env

say "Service (bootstrap.sh)"
if [ ! -x "$APP/deploy/bootstrap.sh" ] && [ ! -f "$APP/deploy/bootstrap.sh" ]; then
  apt-get update -qq && apt-get install -y -qq git >/dev/null
  git clone -q -b staging https://github.com/Cheffromspace/japharsworld-yt.git "$APP"
fi
DOMAIN=$DOMAIN bash "$APP/deploy/bootstrap.sh"
# The settings are production's (owner: shared pool); only the public URL is this box's.
grep -q "^PUBLIC_URL=https://$DOMAIN$" /etc/japharsworld-yt.env || {
  sed -i '/^PUBLIC_URL=/d' /etc/japharsworld-yt.env; echo "PUBLIC_URL=https://$DOMAIN" >> /etc/japharsworld-yt.env; systemctl restart japharsworld-yt; }
chmod 600 /etc/japharsworld-yt.env

say "Caddy with Cloudflare DNS-01 (certificates for the production names, for a flip)"
apt-get install -y -qq jq >/dev/null
# Ubuntu's Caddy (2.6.2 on 24.04) has no `add-package`: Caddy's own download service builds it with the module. The
# apt binary is diverted and the package held, so an upgrade doesn't put the module-less one back.
if ! caddy list-modules 2>/dev/null | grep -q '^dns.providers.cloudflare$'; then
  curl -fsSL -o /tmp/caddy-cf "https://caddyserver.com/api/download?os=linux&arch=$(dpkg --print-architecture)&p=github.com%2Fcaddy-dns%2Fcloudflare"
  chmod 755 /tmp/caddy-cf
  /tmp/caddy-cf list-modules | grep -q '^dns.providers.cloudflare$' || { echo "The downloaded Caddy has no cloudflare module."; exit 1; }
  dpkg-divert --list /usr/bin/caddy | grep -q . || dpkg-divert --local --rename --add /usr/bin/caddy >/dev/null
  install -m 755 /tmp/caddy-cf /usr/bin/caddy && rm -f /tmp/caddy-cf
  apt-mark hold caddy >/dev/null
  caddy version
fi
site="# Staging (#160): written by deploy/staging-setup.sh.
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT {
		lb_try_duration 5s
		lb_try_interval 250ms
	}
}"
if [ -f /etc/caddy/cloudflare.env ]; then
  chmod 600 /etc/caddy/cloudflare.env
  mkdir -p /etc/systemd/system/caddy.service.d
  printf '[Service]\nEnvironmentFile=/etc/caddy/cloudflare.env\n' > /etc/systemd/system/caddy.service.d/cloudflare.conf
  systemctl daemon-reload
  # DNS-01: the certificates come while these names still point at production (no HTTP challenge reaches this box).
  site="$site

$PROD_NAMES {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	encode gzip
	reverse_proxy 127.0.0.1:$PORT {
		lb_try_duration 5s
		lb_try_interval 250ms
	}
}"
else
  warn "No /etc/caddy/cloudflare.env: only $DOMAIN is served; re-run this once the token file is there."
fi
printf '%s\n' "$site" > /etc/caddy/sites/japharsworld-yt.caddy
# Validate with the token Caddy's unit gets from its EnvironmentFile: the cloudflare module provisions during validate
# and rejects an empty {env.CF_API_TOKEN} (seen 2026-10-26, world #210).
( if [ -f /etc/caddy/cloudflare.env ]; then set -a; . /etc/caddy/cloudflare.env; set +a; fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null )
systemctl restart caddy

say "Hardening (deploy/harden.sh): SSH from the known addresses only, 80/443 public"
bash "$APP/deploy/harden.sh"   # bootstrap ran it already when the security env was there; safe to repeat

say "Metrics: exporter, security counters (no poller), Alloy env=staging"
DEPLOY_POLLER=off bash "$APP/deploy/metrics-setup.sh"
bash "$APP/deploy/alloy-setup.sh" staging

say "Done"
echo "https://$DOMAIN/healthz: $(curl -fsS -m 10 "https://$DOMAIN/healthz" >/dev/null && echo ok || echo 'not yet (certificate or DNS)')"
echo "Deploys follow origin/staging (journalctl -u japharsworld-yt-update). Flip: bash $APP/deploy/dns-flip.sh status"
}
main "$@"
