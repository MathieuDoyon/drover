#!/usr/bin/env bash
# User-level install of herdr-app + the Drover mods on omarchy (Linux x86_64). No sudo.
#
#   install.sh [--dry-run] [--with-service] [--version X.Y.Z] [<repo-copy>]
#
# <repo-copy>     the drover-herdr checkout whose mods/ is copied to ~/.local/share/herdr-app/src
#                 (default: the checkout this script lives in). It is only read, never written.
# --dry-run       print the paths it would write, touch nothing (no network either)
# --with-service  also install + enable the systemd user unit (needs the owner's OK first)
# --version       release to install (default 0.1.15); the manifest must carry exactly this version
# env HC_SESSION  optional isolated core, written to ~/.config/herdr-app/service.env (mode 600)
# env DROVER_RELEASES_URL, DROVER_TARGET  overrides, for tests only
#
# Every persistent write is printed as "WRITE <path>": under ~/.local/share/herdr-app, ~/.config/herdr-app,
# ~/.local/bin/herdr-app (+ the unit file with --with-service). Scratch: one mktemp -d, removed on exit.
set -euo pipefail

want_version=0.1.15
dry=0; with_service=0; repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --with-service) with_service=1 ;;
    --version) want_version="${2:?--version needs a value}"; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) repo="$1" ;;
  esac
  shift
done
[ -n "$repo" ] || repo="$(cd "$(dirname "$0")/../.." && pwd)"
repo="$(cd "$repo" && pwd)" || { echo "repo copy not found: $repo" >&2; exit 2; }

manifest_url="${DROVER_RELEASES_URL:-https://releases.herdr.dev/app/latest.json}"
target="${DROVER_TARGET:-linux-x86_64}"
share="$HOME/.local/share/herdr-app"
bin="$HOME/.local/bin/herdr-app"
app_home="$HOME/.config/herdr-app"
unit_dir="$HOME/.config/systemd/user"
unit="$unit_dir/drover-herdr.service"
envfile="$app_home/service.env"

if [ "$dry" = 1 ]; then
  echo "dry-run: nothing is touched, no network."
  echo "source:  $manifest_url (target $target, version $want_version, sha256 checked before extracting)"
  echo "WRITE $share/releases/$want_version   (extracted release)"
  echo "WRITE $share/current   (symlink to the release)"
  echo "WRITE $bin   (symlink to $share/current/herdr-app)"
  echo "WRITE $share/src   (copy of $repo/mods; the mods installer runs from it)"
  echo "WRITE $app_home   (HERDR_APP_HOME; mods + layout symlinks into $share/src/mods)"
  [ -n "${HC_SESSION:-}" ] && echo "WRITE $envfile            (HC_SESSION, mode 600)"
  [ "$with_service" = 1 ] && echo "WRITE $unit"
  echo "temp:    a mktemp -d under \${TMPDIR:-/tmp}, removed on exit"
  exit 0
fi

if [ "$(uname -s)" != Linux ] && [ -z "${DROVER_TARGET:-}" ]; then echo "this installer is for Linux" >&2; exit 2; fi
for t in curl tar node; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
wrote() { echo "WRITE $1"; }

tmp="$(mktemp -d)"
cleanup() { [ -n "${tmp:-}" ] && rm -r -- "$tmp"; }
trap cleanup EXIT

# 1. manifest -> version, url, sha256 (nothing outside $tmp is touched until the sha matches)
curl -fsSL "$manifest_url" -o "$tmp/latest.json"
read -r version url sum < <(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), t = (m.targets || {})[process.argv[2]];
  if (!t) { console.error("no target " + process.argv[2] + " in the manifest"); process.exit(1); }
  console.log(m.version, t.url, t.sha256);' "$tmp/latest.json" "$target")
if [ "$version" != "$want_version" ]; then
  echo "version: manifest has $version, expected $want_version (pass --version to accept another)" >&2; exit 1
fi

# 2. download + verify sha256 BEFORE extracting
curl -fsSL "$url" -o "$tmp/app.tar.gz"
got="$(sha "$tmp/app.tar.gz")"
if [ "$got" != "$sum" ]; then echo "sha256 mismatch for $url: expected $sum, got $got" >&2; exit 1; fi
echo "sha256 ok  $got  $url"
if tar -tzf "$tmp/app.tar.gz" | grep -qE '^/|(^|/)\.\.(/|$)'; then echo "archive has absolute or .. paths: refusing" >&2; exit 1; fi

# 3. extract in $tmp, find the binary, stage it as releases/<ver> and point 'current' at it
mkdir "$tmp/x"; tar -xzf "$tmp/app.tar.gz" -C "$tmp/x"
if [ -f "$tmp/x/herdr-app/herdr-app" ]; then rel_src="$tmp/x/herdr-app"
elif [ -f "$tmp/x/herdr-app" ]; then rel_src="$tmp/x"
else echo "no herdr-app binary in the archive" >&2; exit 1; fi
chmod +x "$rel_src/herdr-app"
mkdir -p "$share/releases" "$HOME/.local/bin"
rel="$share/releases/$version"
[ ! -e "$rel.new" ] || rm -r -- "$rel.new"
mv "$rel_src" "$rel.new"
[ ! -e "$rel" ] || rm -r -- "$rel"
mv "$rel.new" "$rel"; wrote "$rel"
ln -sfn "$rel" "$share/current"; wrote "$share/current"
for old in "$share"/releases/*; do [ "$old" = "$rel" ] || rm -r -- "$old"; done   # keep only the current release
ln -sfn "$share/current/herdr-app" "$bin"; wrote "$bin"
echo "version: $("$bin" --version)"

# 4. repo copy -> $share/src (the mods installer runs from it, so its library copies land there, not in the checkout)
[ ! -e "$share/src.new" ] || rm -r -- "$share/src.new"
mkdir "$share/src.new"; cp -R "$repo/mods" "$share/src.new/mods"
[ ! -e "$share/src" ] || rm -r -- "$share/src"
mv "$share/src.new" "$share/src"; wrote "$share/src"

# 5. app home, optional service env, mods + layout (Jira/GitHub are never installed here)
mkdir -p "$app_home/mods" "$app_home/layouts"; wrote "$app_home"
if [ -n "${HC_SESSION:-}" ]; then
  ( umask 077; printf 'HC_SESSION=%s\n' "$HC_SESSION" > "$envfile" ); chmod 600 "$envfile"; wrote "$envfile"
fi
( cd "$share/src/mods" && PATH="$HOME/.local/bin:$PATH" HERDR_APP_HOME="$app_home" DROVER_SKIP_MODS="drover-jira drover-github" ./install.sh )
echo "mods: drover-* symlinks in $app_home/mods -> $share/src/mods, layout $app_home/layouts/drover.json"
echo "drover CLI: $share/src/mods/drover-tasks/bin/drover (not on PATH; the runbook uses the full path)"

# 6. layout: only possible while the app runs; the service switches it on every start
if PATH="$HOME/.local/bin:$PATH" HERDR_APP_HOME="$app_home" herdr-app status >/dev/null 2>&1; then
  PATH="$HOME/.local/bin:$PATH" HERDR_APP_HOME="$app_home" herdr-app do layout.switch '{"name":"drover"}'
else
  echo "app not running: the service switches to the drover layout on start (by hand: herdr-app do layout.switch '{\"name\":\"drover\"}')"
fi

# 7. systemd user unit: only with --with-service
if [ "$with_service" = 1 ]; then
  mkdir -p "$unit_dir"; cp "$repo/deploy/omarchy/drover-herdr.service" "$unit"; wrote "$unit"
  systemctl --user daemon-reload
  systemctl --user enable --now drover-herdr.service
  echo "service enabled. For start at boot with nobody logged in: loginctl enable-linger \"\$USER\" (see docs/guides/omarchy-permanent.md)"
else
  echo "no service installed. Next, after the owner's OK: $repo/deploy/omarchy/install.sh --with-service $repo"
fi
