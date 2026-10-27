# YT Search weekly infra check (Optiplex)

Runs Claude Code headless every Thursday at 6:52 AM Central, checks the Optiplex + Linode + Grafana, posts the full report as a comment on issue #33 and files findings as `infra-check` issues, and posts a summary to Discord with the report and a local security report attached. It is read only apart from a journal vacuum or logrotate above 85 % disk use. Its rules are in `claude/monitoring.md`, "Weekly infra check (Optiplex agent)", which it reads from `/opt/japharsworld-yt-relay` (the relay worker's checkout of `main`).

**Code and data are apart.** `run.sh` and `prompt.md` run straight from that checkout
(`/opt/japharsworld-yt-relay/infra-check/`), so a push to `main` deploys them within 5 minutes (the relay-update
timer). Everything local stays in `~/yt-infra-check`: `.env` (secrets), `reports/`, `logs/` and
`security-baseline.md`. The repo is public, so security details (IP addresses, key fingerprints, ports, the
baseline) only ever go in `reports/<date>.security.md` and the Discord attachment, never in the repo or on GitHub.

## Install (on the Optiplex, as your normal user)

```bash
# 1. Claude Code
curl -fsSL https://claude.ai/install.sh | bash
sudo apt install -y jq curl

# 2. The data folder (the code stays in the checkout; nothing is copied)
mkdir -p ~/yt-infra-check/reports ~/yt-infra-check/logs && cd ~/yt-infra-check
KIT=/opt/japharsworld-yt-relay/infra-check
# security-baseline.md: the expected keys, accounts, ports and ufw rules, written by hand (chmod 600; never committed)

# GitHub CLI, signed in with access to Cheffromspace/japharsworld-yt (issues and comments only)
sudo apt install -y gh && gh auth login

# 3. Long-lived login token (prints a link: open it on any device, approve, paste the code back)
claude setup-token

# 4. Secrets
cat > .env <<'EOF'
CLAUDE_CODE_OAUTH_TOKEN=<token from step 3>
DISCORD_WEBHOOK_URL=<the Channels monitor's webhook>
DISCORD_CRITICAL_WEBHOOK=<optional: the critical-alerts channel's webhook; SEVERE triage and hypercare "Fix:" posts go there>
GRAFANA_URL=https://<your-stack>.grafana.net
GRAFANA_TOKEN=<Grafana Cloud service account token, Viewer role>
DISCORD_MENTION_ID=<optional: the owner's Discord user ID; every SEVERE triage post pings it>
EOF
chmod 600 .env

# 5. Optiplex: root actions it may take, plus permission to read system logs
sudo visudo -cf $KIT/sudoers-optiplex && sudo install -m 440 $KIT/sudoers-optiplex /etc/sudoers.d/yt-infra-check
sudo usermod -aG systemd-journal,adm jonflatt     # log out/in (or reboot) for this to apply

# 6. A dedicated SSH key for the check
ssh-keygen -t ed25519 -f ~/.ssh/yt_check -N "" -C "yt-infra-check@gameserver"
cat >> ~/.ssh/config <<'EOF'

Host linode-check
  HostName <linode IP or hostname>
  User ytcheck
  IdentityFile ~/.ssh/yt_check
  IdentitiesOnly yes
EOF
cat ~/.ssh/yt_check.pub    # step 7 asks for this line
```

### On the Linode (as root)

```bash
# 7. A non-root account for the check, instead of SSHing in as root
adduser --disabled-password --gecos "" ytcheck
usermod -aG systemd-journal,adm ytcheck
install -d -m 700 -o ytcheck -g ytcheck /home/ytcheck/.ssh
# Paste the line step 6 printed when asked. Anything else, a placeholder included, writes nothing (2026-10-25: a
# literal '<paste ...>' replaced the real key, and the check never reached the Linode).
read -r -p 'yt_check.pub line: ' KEY
case "$KEY" in
  'ssh-ed25519 '*' yt-infra-check@gameserver')
    printf '%s\n' "$KEY" > /home/ytcheck/.ssh/authorized_keys
    chown ytcheck:ytcheck /home/ytcheck/.ssh/authorized_keys && chmod 600 /home/ytcheck/.ssh/authorized_keys ;;
  *) echo 'not the yt_check key: nothing written' >&2 ;;
esac

# sudoers-linode from the repo (infra-check/), then:
visudo -cf sudoers-linode && install -m 440 sudoers-linode /etc/sudoers.d/yt-infra-check
```

### Back on the Optiplex

```bash
ssh -o BatchMode=yes linode-check 'systemctl is-active japharsworld-yt && sudo -n -l' && echo ok

# 8. Timer (linger lets user timers run without you logged in)
sudo loginctl enable-linger "$USER"
mkdir -p ~/.config/systemd/user
cp $KIT/yt-infra-check.service $KIT/yt-infra-check.timer ~/.config/systemd/user/   # again only if the units change
systemctl --user daemon-reload
systemctl --user enable --now yt-infra-check.timer
systemctl --user list-timers yt-infra-check.timer

# 9. Test run now
systemctl --user start yt-infra-check && journalctl --user -u yt-infra-check -e

# 10. Severe-alert triage (needs steps 1-8; no sudo): polls Grafana every 2 minutes, triages new critical alerts
node $KIT/triage.mjs --synthetic down --dry-run     # a made-up alert end to end; prints the Discord text, posts nothing
cp $KIT/yt-infra-triage.service $KIT/yt-infra-triage.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now yt-infra-triage.timer
journalctl --user -u yt-infra-triage -e                 # quiet while nothing critical fires

# 11. Hourly hypercare (world #208; needs steps 1-8, no Claude, no sudo): MediaMTX's host goes in .env, not the repo
echo 'HYPERCARE_MEDIAMTX_HOST=<the media-mtx Linode address>' >> ~/yt-infra-check/.env
node $KIT/hypercare.mjs --dry-run                       # the real checks; prints what it would post and file
cp $KIT/yt-hypercare.service $KIT/yt-hypercare.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now yt-hypercare.timer
systemctl --user list-timers yt-hypercare.timer
```

## Notes
- `Persistent=true`: if the Optiplex is off at 6:52, the run happens at next boot.
- If the login token stops working, the wrapper posts a 🔑 alert to Discord telling you to rerun `claude setup-token`.
- The sudoers files are the real guardrail: they allow only the journal vacuum, logrotate and the read-only security
  commands (`sshd -T`, `ufw status verbose`, and `fail2ban-client status sshd` on the Linode, `ss -tlnp` on the
  Optiplex) (no restarts since 2026-10-25; reinstall them with step 5 / step 7 after a change). On the Optiplex this holds only while `jonflatt`'s normal sudo still asks for a password (the check always uses `sudo -n`, so anything outside the allowlist fails instead of prompting). On the Linode, `ytcheck` has no sudo beyond the allowlist.
- Updating: nothing to copy. `run.sh`, `prompt.md` and the rules in `claude/monitoring.md` are read from the checkout at
  each run. Only a change to the units (copy them again, `daemon-reload`) or the sudoers files (reinstall them) needs a step.
- Reports: `~/yt-infra-check/reports/`, raw run output: `~/yt-infra-check/logs/` (kept 26 weeks).
- Hourly hypercare (`hypercare.mjs`, rules in `claude/monitoring.md`, "Hourly hypercare"): read-only counts every hour
  at :17; quiet when normal, otherwise Discord plus a world-repo issue (an `owner-task` card when you have to act).
  After 7 clean days in a row it says so on Discord and world #208 and disables its own timer (world #236).
- Severe-alert triage (`triage.mjs`, `triage-prompt.md`, rules in `claude/monitoring.md`, "Severe alert triage"):
  on a new firing `severity=critical` alert it runs a read-only Claude triage and posts "SEVERE: …" to Discord with the
  report attached (`reports/<date>-<hhmm>-triage-<rule>.md`); a GitHub issue only for non-security alerts. Once per
  alert per 6 hours, 6 runs a day at most; it shares the weekly check's lock. Its state is
  `~/yt-infra-check/triage-state.json` (delete it to forget which alerts were triaged).
