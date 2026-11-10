#!/usr/bin/env bash
# A decent shell on the servers (owner, 2026-10-28): stock neovim and bash-completion, and a prompt that says which host
# this is, coloured per host from the Tokyo Night palette (no red). Run as root; safe to run again.
#   bash deploy/shell-setup.sh prod|staging|optiplex
# The label comes from the role, not the hostname: both Linodes are named "localhost" (2026-10-28).
# Ubuntu's ~/.bashrc sets PS1 after /etc/profile.d has run, so the prompt is set from PROMPT_COMMAND (each prompt), and
# /etc/bash.bashrc sources the file too, so non-login shells (tmux, `bash`) get it as well.
set -euo pipefail
role=${1:-}
case "$role" in
  prod)     label=eiok-prod;    rgb='255;158;100' ;;  # orange #ff9e64
  staging)  label=eiok-staging; rgb='187;154;247' ;;  # magenta #bb9af7
  optiplex) label=optiplex;     rgb='158;206;106' ;;  # green #9ece6a
  *) echo "usage: $0 prod|staging|optiplex" >&2; exit 2 ;;
esac
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -q neovim bash-completion >/dev/null

cat > /etc/profile.d/eiok-shell.sh <<EOF
# Written by japharsworld-yt deploy/shell-setup.sh ($role); run it again to change. Interactive bash only.
[ -n "\${BASH_VERSION:-}" ] && [[ \$- == *i* ]] || return 0
[ -z "\${EIOK_SHELL:-}" ] || return 0
EIOK_SHELL=1
export EDITOR=nvim VISUAL=nvim
alias vi=nvim
alias ls='ls --color=auto'
__eiok_ps1() { PS1='\[\e[38;2;192;202;245m\]\u@\[\e[1;38;2;${rgb}m\]${label}\[\e[0m\]:\[\e[38;2;122;162;247m\]\w\[\e[0m\]\\$ '; }
if [[ "\$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then PROMPT_COMMAND+=(__eiok_ps1)
else PROMPT_COMMAND="__eiok_ps1\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"; fi
EOF
chmod 644 /etc/profile.d/eiok-shell.sh

line='[ -r /etc/profile.d/eiok-shell.sh ] && . /etc/profile.d/eiok-shell.sh  # japharsworld-yt deploy/shell-setup.sh'
grep -qxF "$line" /etc/bash.bashrc || echo "$line" >> /etc/bash.bashrc
echo "shell set up: $label, $(nvim --version | head -1)"
