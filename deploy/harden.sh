#!/usr/bin/env bash
# Host hardening (owner, 2026-10-26; production rebuilt that night): key-only SSH, fail2ban for sshd, and ufw that lets
# the known addresses reach the home-only ports and everyone the public ones. As root; safe to re-run (adds rules,
# never resets ufw). bootstrap.sh runs it when the security env exists.
#   bash /opt/japharsworld-yt/deploy/harden.sh
# The addresses are local, never in the repo (it is public): SSH_KNOWN_SOURCES in /etc/japharsworld-yt-security.env,
# comma separated, the same list metrics/security.js counts logins against.
#   HARDEN_HOME_TCP    ports for the known addresses only (default "22 1935": SSH, and RTMP publishing from home)
#   HARDEN_PUBLIC_TCP  ports for everyone (default "80 443 8554": HTTPS, and the world's RTSP stream)
set -euo pipefail
main() {
ENVF=/etc/japharsworld-yt-security.env
HOME_TCP=${HARDEN_HOME_TCP:-22 1935}
PUBLIC_TCP=${HARDEN_PUBLIC_TCP:-80 443 8554}
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
[ -f "$ENVF" ] || { echo "Write $ENVF (SSH_KNOWN_SOURCES=<address>[,<address>]) first."; exit 1; }
. "$ENVF"
sources=$(echo "${SSH_KNOWN_SOURCES:-}" | tr ',' ' ')
[ -n "${sources// /}" ] || { echo "SSH_KNOWN_SOURCES is empty in $ENVF."; exit 1; }
chown root:root "$ENVF"; chmod 600 "$ENVF"
# ufw only lets the known addresses reach port 22: refuse to lock out the session running this.
me=${SSH_CLIENT%% *}
if [ -n "$me" ] && ! printf ' %s ' "$sources" | grep -q " $me "; then
  echo "This SSH session is not from an address in SSH_KNOWN_SOURCES; ufw would lock it out. Nothing changed."; exit 1
fi

echo "== SSH: keys only"
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOT'
# deploy/harden.sh: keys only, root by key only (eiok_sshd_hardened watches these).
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOT
sshd -t
systemctl reload ssh
sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '

echo "== fail2ban (sshd jail)"
apt-get install -y -qq fail2ban >/dev/null
systemctl enable -q --now fail2ban
for i in $(seq 1 10); do fail2ban-client status sshd >/dev/null 2>&1 && break; sleep 1; done
fail2ban-client status sshd | grep -E 'Currently banned|Total banned' || echo "sshd jail not up yet"

echo "== ufw: $HOME_TCP from the known addresses, $PUBLIC_TCP public"
apt-get install -y -qq ufw >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for ip in $sources; do for p in $HOME_TCP; do ufw allow from "$ip" to any port "$p" proto tcp >/dev/null; done; done
for p in $PUBLIC_TCP; do ufw allow "$p/tcp" >/dev/null; done
ufw --force enable >/dev/null
ufw status | head -1
echo "$(echo "$sources" | wc -w) known address(es); rules: $(ufw status | grep -c ALLOW)"
}
main "$@"
