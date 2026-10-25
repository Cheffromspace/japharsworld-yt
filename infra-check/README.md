# YT Search weekly infra check (Optiplex)

Runs Claude Code headless every Thursday at 6:52 AM Central, checks the Optiplex + Linode + Grafana, posts the full report as a comment on issue #33 and files findings as `infra-check` issues, and posts a summary to Discord with the report attached. It is read only apart from a journal vacuum or logrotate above 85 % disk use. Its rules are in `claude/monitoring.md`, "Weekly infra check (Optiplex agent)", which it reads from `/opt/japharsworld-yt-relay` (the relay worker's checkout of `main`).

## Install (on the Optiplex, as your normal user)

```bash
# 1. Claude Code
curl -fsSL https://claude.ai/install.sh | bash
sudo apt install -y jq curl

# 2. Files
mkdir -p ~/yt-infra-check && cd ~/yt-infra-check
cp /opt/japharsworld-yt-relay/infra-check/* .      # this folder of the repo (README, run.sh, prompt.md, units, sudoers)
chmod +x run.sh

# GitHub CLI, signed in with access to Cheffromspace/japharsworld-yt (issues and comments only)
sudo apt install -y gh && gh auth login

# 3. Long-lived login token (prints a link: open it on any device, approve, paste the code back)
claude setup-token

# 4. Secrets
cat > .env <<'EOF'
CLAUDE_CODE_OAUTH_TOKEN=<token from step 3>
DISCORD_WEBHOOK_URL=<the Channels monitor's webhook>
GRAFANA_URL=https://<your-stack>.grafana.net
GRAFANA_TOKEN=<Grafana Cloud service account token, Viewer role>
EOF
chmod 600 .env

# 5. Optiplex: root actions it may take, plus permission to read system logs
sudo visudo -cf sudoers-optiplex && sudo install -m 440 sudoers-optiplex /etc/sudoers.d/yt-infra-check
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
cat ~/.ssh/yt_check.pub    # copy this for step 7
```

### On the Linode (as root)

```bash
# 7. A non-root account for the check, instead of SSHing in as root
adduser --disabled-password --gecos "" ytcheck
usermod -aG systemd-journal,adm ytcheck
install -d -m 700 -o ytcheck -g ytcheck /home/ytcheck/.ssh
echo '<paste yt_check.pub here>' > /home/ytcheck/.ssh/authorized_keys
chown ytcheck:ytcheck /home/ytcheck/.ssh/authorized_keys && chmod 600 /home/ytcheck/.ssh/authorized_keys

# copy sudoers-linode over, then:
visudo -cf sudoers-linode && install -m 440 sudoers-linode /etc/sudoers.d/yt-infra-check
```

### Back on the Optiplex

```bash
ssh -o BatchMode=yes linode-check 'systemctl is-active japharsworld-yt && sudo -n -l' && echo ok
cd ~/yt-infra-check

# 8. Timer (linger lets user timers run without you logged in)
sudo loginctl enable-linger "$USER"
mkdir -p ~/.config/systemd/user
cp yt-infra-check.service yt-infra-check.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now yt-infra-check.timer
systemctl --user list-timers yt-infra-check.timer

# 9. Test run now
systemctl --user start yt-infra-check && journalctl --user -u yt-infra-check -e
```

## Notes
- `Persistent=true`: if the Optiplex is off at 6:52, the run happens at next boot.
- If the login token stops working, the wrapper posts a 🔑 alert to Discord telling you to rerun `claude setup-token`.
- The sudoers files are the real guardrail: they allow only the journal vacuum and logrotate (no restarts since 2026-10-25; reinstall them with step 5 / step 7 after a change). On the Optiplex this holds only while `jonflatt`'s normal sudo still asks for a password (the check always uses `sudo -n`, so anything outside the allowlist fails instead of prompting). On the Linode, `ytcheck` has no sudo beyond the allowlist.
- Updating: after a change to this folder lands on `main`, copy `run.sh` and `prompt.md` again (`cp /opt/japharsworld-yt-relay/infra-check/{run.sh,prompt.md} ~/yt-infra-check/`). The rules in `claude/monitoring.md` need no copy.
- Reports: `~/yt-infra-check/reports/`, raw run output: `~/yt-infra-check/logs/` (kept 26 weeks).
