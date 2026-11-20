#!/bin/sh
# Find node and python3 on this machine and say where they are. Run it from the laptop as `sh -s -- [<configured node dir>]` with this file on stdin.
# Tiers, in order: PATH, the configured dir (first argument), common install locations, then version managers (nvm, fnm, asdf, volta, mise, pyenv;
# no manager is assumed, mise is one example). Inside the manager tier the newest version wins. Each candidate must answer --version within 5 s
# (a background watchdog: stock macOS has no timeout(1)).
# Output (stdout, one line each): home=<physical home>, os=… arch=…, path=…, node tier=<path|configured|common|manager> path=<abs> version=<v>,
# python3 tier=… path=… version=…, hasher=<sha256sum|shasum>. A missing runtime prints E_NODE_NOT_FOUND / E_PYTHON_NOT_FOUND instead of its line;
# E_TEMP_FAILED (no safe temp file) alone means nothing was probed.
# The exit status is ALWAYS 0: a caller reads the outcome from the lines above, never from the status.
# DROVER_FIND_SYSTEM_DIRS (a colon list) replaces the built-in common install locations.
# `--node-only [<configured node dir>]` (the drover-headless launcher): same tiers for node alone; prints just the absolute path and exits 0, or prints nothing and exits 69.
node_only=0
if [ "${1:-}" = "--node-only" ]; then node_only=1; shift; fi
cfg="${1:-}"
home="$(pwd -P)"
sys_dirs="${DROVER_FIND_SYSTEM_DIRS-$HOME/.local/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin}"

# ver <binary>: prints the first line of `<binary> --version`, nothing if it fails or does not answer within the bound (DROVER_FIND_TIMEOUT_S, default 5).
# The candidate runs in the background with its output in a temp file (never a pipe the candidate can keep open); at the bound it and its children are
# killed and reaped, and whatever it printed is ignored. No timeout(1): stock macOS has none.
bound="${DROVER_FIND_TIMEOUT_S:-5}"
case "$bound" in ''|*[!0-9]*) bound=5 ;; esac
ver() {
  vf="$(mktemp 2>/dev/null)" || return 1 # never a predictable fallback name: it could be a planted link
  "$1" --version >"$vf" 2>/dev/null </dev/null &
  vp=$!
  i=0; max=$((bound * 10)); timed=0
  while kill -0 "$vp" 2>/dev/null; do
    if [ "$i" -ge "$max" ]; then timed=1; break; fi
    sleep 0.1; i=$((i + 1))
  done
  if [ "$timed" = 1 ]; then
    pkill -KILL -P "$vp" 2>/dev/null
    kill -KILL "$vp" 2>/dev/null
    wait "$vp" 2>/dev/null
  else
    wait "$vp" 2>/dev/null
    head -n 1 "$vf"
  fi
  rm -f "$vf"
}
# probe <binary>: sets pv to its version line, or empty
probe() {
  [ -f "$1" ] && [ -x "$1" ] || { pv=""; return 1; }
  pv="$(ver "$1")"
  [ -n "$pv" ]
}
# vkey <version dir name>: a sortable key (three numbers, zero padded)
vkey() { printf '%s\n' "$1" | awk -F. '{ for (i = 1; i <= 3; i++) { s = $i; gsub(/[^0-9]/, "", s); printf "%06d", (s == "" ? 0 : s) } print "" }'; }

# find_in_dirs <name> <colon list>
find_in_dirs() {
  oldifs="$IFS"; IFS=:
  for d in $2; do
    IFS="$oldifs"
    [ -n "$d" ] && probe "$d/$1" && { fp="$d/$1"; return 0; }
    IFS=:
  done
  IFS="$oldifs"
  return 1
}
# managed <name> <root>/<*>/<suffix> …: candidates from version-manager trees, newest version first
managed() {
  name="$1"; shift
  list=""
  while [ "$#" -ge 2 ]; do
    root="$1"; suffix="$2"; shift 2
    for vd in "$root"/*; do
      [ -d "$vd" ] || continue
      p="$vd/$suffix"
      [ -f "$p" ] || continue
      list="$list$(vkey "${vd##*/}") $p
"
    done
  done
  [ -n "$list" ] || return 1
  sorted="$(printf '%s' "$list" | sort -r)"
  oldifs="$IFS"; IFS='
'
  for line in $sorted; do
    IFS="$oldifs"
    p="${line#* }"
    probe "$p" && { fp="$p"; return 0; }
    IFS='
'
  done
  IFS="$oldifs"
  return 1
}

# runtime <label> <name> <managed args…>: prints the line, returns 1 when not found
runtime() {
  label="$1"; name="$2"; shift 2
  fp=""; tier=""
  c="$(command -v "$name" 2>/dev/null || true)"
  case "$c" in /*) if probe "$c"; then fp="$c"; tier=path; fi ;; esac
  if [ -z "$fp" ] && [ -n "$cfg" ] && probe "$cfg/$name"; then fp="$cfg/$name"; tier=configured; fi
  if [ -z "$fp" ] && find_in_dirs "$name" "$sys_dirs"; then tier=common; fi
  if [ -z "$fp" ] && managed "$name" "$@"; then tier=manager; fi
  if [ -z "$fp" ] && [ -n "$fixed" ] && probe "$fixed"; then fp="$fixed"; tier=manager; fi # a manager's own shim (volta)
  [ -n "$fp" ] || return 1
  printf '%s tier=%s path=%s version=%s\n' "$label" "$tier" "$fp" "$pv"
}

fixed=""
node_runtime() {
  runtime node node \
    "$HOME/.nvm/versions/node" bin/node \
    "$HOME/.local/share/fnm/node-versions" installation/bin/node \
    "$HOME/Library/Application Support/fnm/node-versions" installation/bin/node \
    "$HOME/.fnm/node-versions" installation/bin/node \
    "$HOME/.asdf/installs/nodejs" bin/node \
    "$HOME/.volta/tools/image/node" bin/node \
    "$HOME/.local/share/mise/installs/node" bin/node
}
# Secure temp files are needed to bound a candidate. Without them nothing is probed (never a guessable path): the fixed code, exit 0.
if t="$(mktemp 2>/dev/null)"; then rm -f "$t"; else [ "$node_only" = 1 ] && exit 69; echo "E_TEMP_FAILED"; exit 0; fi
if [ "$node_only" = 1 ]; then
  fixed="$HOME/.volta/bin/node"
  node_runtime >/dev/null || exit 69
  printf '%s\n' "$fp"
  exit 0
fi
echo "home=$home"
echo "os=$(uname -s 2>/dev/null) arch=$(uname -m 2>/dev/null)"
echo "path=$PATH"
fixed="$HOME/.volta/bin/node"
node_runtime || echo "E_NODE_NOT_FOUND"
fixed=""
runtime python3 python3 \
  "$HOME/.pyenv/versions" bin/python3 \
  "$HOME/.asdf/installs/python" bin/python3 \
  "$HOME/.local/share/mise/installs/python" bin/python3 || echo "E_PYTHON_NOT_FOUND"
for h in sha256sum shasum; do
  if command -v "$h" >/dev/null 2>&1; then echo "hasher=$h"; break; fi
done
exit 0
