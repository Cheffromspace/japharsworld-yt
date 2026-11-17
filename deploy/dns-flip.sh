#!/usr/bin/env bash
# Manual maintenance flip (#160, owner 2026-10-26): points yt.japharsworld.com and eiok.cc (DNS only, Cloudflare) at
# the staging VPS while production is down for planned work, and back. Never automatic. Run on the staging box as root:
#   bash /opt/japharsworld-yt/deploy/dns-flip.sh status            where each name points; both sides' healthz
#   bash /opt/japharsworld-yt/deploy/dns-flip.sh to-staging        staging onto main and the production URL, checks it
#                                                                  under both names (--resolve, real certificates), flips
#   bash /opt/japharsworld-yt/deploy/dns-flip.sh to-prod           checks production under both names, flips back
#   bash /opt/japharsworld-yt/deploy/dns-flip.sh restore-staging   staging back onto its branch and URL; only once the
#                                                                  records' TTL has passed since to-prod
# Settings: /etc/japharsworld-yt-flip.env (root 0600, local: PROD_IP=..., STAGING_IP=..., optional CF_ZONE_<zone>=<id>
# where the token can't list zones) and /etc/caddy/cloudflare.env (CF_API_TOKEN, DNS edit on both zones).
# Caveat: staging has its own tickets. Search results and pinned plays from before the flip don't exist there, so the
# world answers them as unknown tickets until people search again.
set -euo pipefail
main() {
NAMES="yt.japharsworld.com eiok.cc"
APP=/opt/japharsworld-yt
ENV=/etc/japharsworld-yt.env
DEPLOY_ENV=/etc/japharsworld-yt-deploy.env
STAGING_URL=https://staging-yt.eiok.cc
PROD_URL=https://yt.japharsworld.com
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
. /etc/japharsworld-yt-flip.env
. /etc/caddy/cloudflare.env
: "${PROD_IP:?PROD_IP missing in /etc/japharsworld-yt-flip.env}" "${STAGING_IP:?STAGING_IP missing}" "${CF_API_TOKEN:?no CF_API_TOKEN}"
cf() { curl -fsS -m 20 -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' "$@"; }
zone_of() { echo "$1" | awk -F. '{print $(NF-1)"."$NF}'; }
zone_id() {
  local z; z=$(zone_of "$1"); local var="CF_ZONE_${z//./_}"
  [ -n "${!var:-}" ] && { echo "${!var}"; return; }
  cf "https://api.cloudflare.com/client/v4/zones?name=$z" | jq -r '.result[0].id'
}
record() { cf "https://api.cloudflare.com/client/v4/zones/$(zone_id "$1")/dns_records?type=A&name=$1" | jq -r '.result[0] | "\(.id) \(.content) \(.ttl) \(.proxied)"'; }
side() { case "$1" in "$PROD_IP") echo production ;; "$STAGING_IP") echo staging ;; *) echo "other ($1)" ;; esac; }
# healthz under a production name on a given address, with that name's real certificate.
check() { curl -fsS -m 10 --resolve "$1:443:$2" "https://$1/healthz" >/dev/null; }
set_line() { sed -i "/^$2=/d" "$1"; echo "$2=$3" >> "$1"; }

point() {  # point <ip>: every name's A record to it
  for n in $NAMES; do
    read -r id content ttl proxied <<<"$(record "$n")"
    [ "$proxied" = false ] || { echo "$n is proxied through Cloudflare; this script expects DNS only. Nothing changed."; exit 1; }
    if [ "$content" = "$1" ]; then echo "$n already on $(side "$1")"; continue; fi
    cf -X PATCH "https://api.cloudflare.com/client/v4/zones/$(zone_id "$n")/dns_records/$id" --data "{\"content\":\"$1\"}" | jq -e '.success' >/dev/null
    echo "$n: $(side "$content") -> $(side "$1") (TTL ${ttl}s: resolvers follow within that)"
  done
}

case "${1:-status}" in
  status)
    for n in $NAMES; do read -r _ content ttl _ <<<"$(record "$n")"; echo "$n -> $(side "$content"), TTL ${ttl}s"; done
    for n in $NAMES; do
      printf '%-20s production %s  staging %s\n' "$n" "$(check "$n" "$PROD_IP" && echo ok || echo FAIL)" "$(check "$n" "$STAGING_IP" && echo ok || echo FAIL)"
    done
    echo "staging: $(grep '^DEPLOY_BRANCH=' "$DEPLOY_ENV"), $(grep '^PUBLIC_URL=' "$ENV"), on $(git -C "$APP" rev-parse --short HEAD)" ;;
  to-staging)
    set_line "$DEPLOY_ENV" DEPLOY_BRANCH main
    set_line "$ENV" PUBLIC_URL "$PROD_URL"
    systemctl start japharsworld-yt-update.service     # onto origin/main now, not in up to 5 minutes
    systemctl restart japharsworld-yt.service           # PUBLIC_URL is read at start
    git -C "$APP" fetch -q origin main
    [ "$(git -C "$APP" rev-parse HEAD)" = "$(git -C "$APP" rev-parse origin/main)" ] || { echo "staging is not on origin/main; not flipping."; exit 1; }
    for i in $(seq 1 20); do check yt.japharsworld.com "$STAGING_IP" && break; sleep 1; done
    for n in $NAMES; do check "$n" "$STAGING_IP" || { echo "staging fails healthz as $n (certificate or service); not flipping."; exit 1; }; done
    point "$STAGING_IP"
    echo "Flipped to staging. Back with: dns-flip.sh to-prod, then after the TTL: dns-flip.sh restore-staging" ;;
  to-prod)
    for n in $NAMES; do check "$n" "$PROD_IP" || { echo "production fails healthz as $n; not flipping back."; exit 1; }; done
    point "$PROD_IP"
    echo "Flipped back. Staging keeps serving production names until the TTL passes; then: dns-flip.sh restore-staging" ;;
  restore-staging)
    for n in $NAMES; do read -r _ content _ _ <<<"$(record "$n")"; [ "$content" = "$PROD_IP" ] || { echo "$n still points at $(side "$content"); run to-prod first."; exit 1; }; done
    set_line "$DEPLOY_ENV" DEPLOY_BRANCH staging
    set_line "$ENV" PUBLIC_URL "$STAGING_URL"
    systemctl start japharsworld-yt-update.service
    systemctl restart japharsworld-yt.service
    echo "staging is back on its branch and $STAGING_URL" ;;
  *) echo "usage: dns-flip.sh status|to-staging|to-prod|restore-staging"; exit 2 ;;
esac
}
main "$@"
