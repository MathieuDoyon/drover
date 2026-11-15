#!/usr/bin/env bash
# Rollback drain check for omarchy's drover inbox (T-MWHVWR8TIJB). Run it while the v2 consumer is still up, after the laptop writes are frozen.
# FAILS CLOSED: exit 0 only if the inbox directory exists, was listed without error, holds no `.*.tmp` staging file (a delivery in flight)
# and no `*.json` request contains `ifRev` or `ttlMs` (a protected request only a v2 consumer can expire or reject). Anything else, including
# an unreadable or missing directory, an unreadable file or a grep status other than 0/1, exits non-zero. Prints one line. Read-only.
# Usage: drain-check.sh [inbox-dir]   (default $HOME/.config/herdr-app/data/drover-inbox)
set -u
dir="${1:-${HOME:-}/.config/herdr-app/data/drover-inbox}"
fail() { echo "FAIL drain-check: $1"; exit 1; }

[ -d "$dir" ] || fail "inbox $dir is missing or not a directory"
listing="$(find "$dir" -mindepth 1 -maxdepth 1 -print 2>/dev/null)" || fail "inbox $dir could not be listed"
tmp=0; json=0; protected=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  base="${f##*/}"
  case "$base" in
    .*.tmp) tmp=$((tmp+1)) ;;
    *.json)
      json=$((json+1))
      grep -q -e ifRev -e ttlMs -- "$f" 2>/dev/null; rc=$?
      case "$rc" in
        0) protected="$protected $base" ;;
        1) ;;
        *) fail "could not read $base (grep status $rc)" ;;
      esac ;;
  esac
done <<EOT
$listing
EOT
[ "$tmp" -eq 0 ] || fail "$tmp staging file(s) (.tmp): a delivery is in flight"
[ -z "$protected" ] || fail "protected request(s) still queued (ifRev/ttlMs):${protected}"
echo "OK drain-check: $json request file(s), none protected, no delivery in flight"
