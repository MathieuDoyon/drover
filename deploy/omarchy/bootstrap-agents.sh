#!/usr/bin/env bash
# Put hc and the drover CLI on the PATH of the shells agents run in, on omarchy. User-level, no sudo, no system files.
#
#   bootstrap-agents.sh [--dry-run]
#
# Appends ONE marked block to each rc file below (backup first, only when something is added):
#   # >>> drover-herdr agents PATH >>>  ...  # <<< drover-herdr agents PATH <<<
# The block prepends ~/.local/bin (hc) and ~/.local/share/herdr-app/src/mods/drover-tasks/bin (drover) to PATH
# only if missing, and exports HERDR_APP_HOME=${HERDR_APP_HOME:-$HOME/.config/herdr-app}. POSIX sh syntax, so it
# works in bash, zsh and sh. A second run finds the marker and adds nothing.
# It also links ~/.local/bin/drover -> ~/.local/share/herdr-app/src/mods/drover-tasks/bin/drover (printed as LINK):
# 'hc exec' runs sh -c, non-login, reads no rc file, but ~/.local/bin is already on its PATH. An existing regular file
# or a different symlink there is REFUSEd (nothing changed). It also creates ~/.config/drover-herdr/agents (mode 700, empty). No secret value is ever written.
#
# Which rc is read by which shell (this is why several files are edited):
#   zsh  every invocation       ~/.zshenv   (also non-interactive, non-login: what 'hc exec' most likely runs)
#   zsh  interactive            ~/.zshrc
#   bash interactive non-login  ~/.bashrc
#   bash login                  the FIRST of ~/.bash_profile, ~/.bash_login, ~/.profile that exists
#   sh   login                  ~/.profile
# So: ~/.zshenv + ~/.zshrc when zsh is installed; ~/.bashrc always; ~/.profile only when neither ~/.bash_profile nor
# ~/.bash_login exists (otherwise bash login does not read it). A ~/.bash_profile / ~/.bash_login is never edited.
# LIMIT: a non-interactive non-login bash ('bash -c', which 'hc exec' may use) reads no rc file at all (only
# $BASH_ENV, which this script cannot set), and many ~/.bashrc return early when not interactive. That case is
# REPORTED below, not guessed.
#
# env DROVER_BOOTSTRAP_ZSH=yes|no|auto   force the zsh decision (default auto; for tests)
set -euo pipefail

dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || { echo "HOME is not set to a directory" >&2; exit 2; }

marker_begin='# >>> drover-herdr agents PATH >>>'
marker_end='# <<< drover-herdr agents PATH <<<'
block=$(cat <<'EOB'
# >>> drover-herdr agents PATH >>>
# managed by deploy/omarchy/bootstrap-agents.sh: hc + drover on PATH for agents. Remove this block to undo.
for _drover_d in "$HOME/.local/share/herdr-app/src/mods/drover-tasks/bin" "$HOME/.local/bin"; do
  case ":$PATH:" in *":$_drover_d:"*) ;; *) PATH="$_drover_d:$PATH" ;; esac
done
unset _drover_d
export PATH
export HERDR_APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
# <<< drover-herdr agents PATH <<<
EOB
)

# --- which rc files (and why) ---
files=(); why=()
add_target() { files+=("$1"); why+=("$2"); }
case "${DROVER_BOOTSTRAP_ZSH:-auto}" in
  yes) zsh_on=1 ;; no) zsh_on=0 ;;
  *) if [ -x /bin/zsh ] || command -v zsh >/dev/null 2>&1; then zsh_on=1; else zsh_on=0; fi ;;
esac
if [ "$zsh_on" = 1 ]; then
  add_target "$HOME/.zshenv" "zsh is installed: ~/.zshenv is read by every zsh, also non-interactive and non-login (hc exec)"
  add_target "$HOME/.zshrc" "zsh is installed: ~/.zshrc is read by interactive zsh"
else
  echo "NOTE zsh not found: ~/.zshenv and ~/.zshrc are left alone"
fi
add_target "$HOME/.bashrc" "bash: read by interactive non-login bash (and by login bash when the login file sources it)"
if [ ! -e "$HOME/.bash_profile" ] && [ ! -e "$HOME/.bash_login" ]; then
  add_target "$HOME/.profile" "neither ~/.bash_profile nor ~/.bash_login exists, so bash login and sh login read ~/.profile"
else
  echo "NOTE ~/.bash_profile or ~/.bash_login exists: bash login reads it instead of ~/.profile, so ~/.profile is left alone."
  echo "     This script never edits it; if it does not source ~/.bashrc, bash login shells will not get the PATH."
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
agents="$HOME/.config/drover-herdr/agents"
phys_home="$(cd "$HOME" && pwd -P)"

# --- PREFLIGHT: decide everything and refuse before the first write. Symlinks are never followed: an rc file, its
# backup path, or any of ~/.config, ~/.config/drover-herdr, ~/.config/drover-herdr/agents that is a symlink (or that
# resolves outside the physical HOME) stops the run with nothing changed; edit those by hand.
problems=0
refuse() { echo "REFUSE $1 -> $2"; problems=1; }
check_path() { # <path under $HOME>: every component below HOME must be a real dir/file inside the physical HOME
  local p="$1" rel cur part real
  rel="${p#"$HOME"/}"; cur="$HOME"
  local IFS=/; local -a parts; read -r -a parts <<< "$rel"; IFS=$' \t\n'
  for part in "${parts[@]}"; do
    cur="$cur/$part"
    if [ -L "$cur" ]; then refuse "$cur" "$(readlink "$cur")"; return; fi
    [ -e "$cur" ] || return 0           # the rest does not exist yet: it will be created inside a checked real dir
    if [ -d "$cur" ]; then real="$(cd "$cur" && pwd -P)"; else real="$(cd "$(dirname "$cur")" && pwd -P)/$(basename "$cur")"; fi
    case "$real/" in "$phys_home"/*) ;; *) refuse "$cur" "$real"; return ;; esac
  done
}
state=()
for i in "${!files[@]}"; do
  f="${files[$i]}"
  check_path "$f"; check_path "$f.drover-bak.$stamp"
  if [ -e "$f" ] && [ ! -L "$f" ] && [ ! -f "$f" ]; then refuse "$f" "not a regular file"; fi
  st=add
  if [ -f "$f" ] && [ ! -L "$f" ] && grep -qxF "$marker_begin" "$f"; then
    found="$(awk -v b="$marker_begin" -v e="$marker_end" '$0==b{p=1} p{print} p&&$0==e{exit}' "$f")"
    nb="$(grep -cxF "$marker_begin" "$f" || true)"; ne="$(grep -cxF "$marker_end" "$f" || true)"
    if [ "$found" = "$block" ] && [ "$nb" = 1 ] && [ "$ne" = 1 ]; then st=have
    else echo "PARTIAL $f: has the opening marker but not exactly the expected block (begin x$nb, end x$ne). Not modified; fix or remove it by hand, then rerun."; problems=1; st=bad; fi
  fi
  state+=("$st")
done
check_path "$HOME/.config/drover-herdr/agents"
# the drover symlink: its parent chain must be real dirs inside HOME; the link itself must be absent or already right
link="$HOME/.local/bin/drover"; link_target="$HOME/.local/share/herdr-app/src/mods/drover-tasks/bin/drover"
check_path "$HOME/.local/bin"
link_state=add
if [ -L "$link" ]; then
  if [ "$(readlink "$link")" = "$link_target" ]; then link_state=have; else refuse "$link" "$(readlink "$link")"; fi
elif [ -e "$link" ]; then refuse "$link" "an existing file (not a symlink)"
fi
if [ "$problems" = 1 ]; then echo "ABORT: nothing was changed." >&2; exit 1; fi

# --- WRITE ---
changed=0
for i in "${!files[@]}"; do
  f="${files[$i]}"
  echo "RC $f: ${why[$i]}"
  if [ "${state[$i]}" = have ]; then
    echo "  already has the full block: nothing to add"
    continue
  fi
  changed=1
  if [ "$dry" = 1 ]; then echo "  dry-run: would back up (if it exists) and append:"; else
    if [ -f "$f" ]; then
      bak="$f.drover-bak.$stamp"
      cp -p -- "$f" "$bak"; echo "WRITE $bak   (backup)"
      # a file without a trailing newline: finish its last line first, so the block starts on its own line
      [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && printf '\n' >> "$f"
    fi
    printf '\n%s\n' "$block" >> "$f"
    echo "ADD $f"
  fi
  printf '%s\n' "$block" | sed 's/^/    | /'
done
[ "$changed" = 1 ] || echo "nothing to add: every rc file already has the block"

# --- the drover symlink ---
if [ "$link_state" = have ]; then echo "drover link: $link already points to $link_target: nothing to add"
elif [ "$dry" = 1 ]; then echo "dry-run: would link $link -> $link_target"
else
  mkdir -p -- "$HOME/.local/bin"; ln -s -- "$link_target" "$link"
  echo "LINK $link -> $link_target"
fi

# --- the agents folder: mode 700, no secret value written ---
if [ "$dry" = 1 ]; then echo "dry-run: would create $agents (mode 700, empty); nothing was touched"
else
  mkdir -p -- "$agents"; chmod 700 "$agents"
  echo "WRITE $agents   (mode 700, empty; no secret value)"
fi
echo "HINT: many ~/.bashrc start with an interactive-return guard (case $- in *i*) ;; *) return;; esac), which skips everything below it, our block included, for non-interactive shells. If the block is appended after such a guard it will not help non-interactive use."
echo "REPORT: a non-interactive non-login bash ('bash -c') reads no rc file. If 'hc exec' runs bash that way on omarchy, hc/drover stay off its PATH; check with: hc exec --on omarchy 'command -v hc drover'"
