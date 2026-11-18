#!/usr/bin/env bash
# Copy the shared library into each drover-* mod (before the tests: the copies are tested), run the tests, link the mods into Herdr, check them.
# Never replaces a real folder in the Herdr home: only its own symlinks.
# DROVER_SKIP_TESTS=1 skips the node test stage. The stage runs every test file (the glob below), never a hand list.
# DROVER_SKIP_MODS="drover-jira drover-github" (space list) leaves those mods out and removes their symlink; default empty = all mods.
# Herdr hot-reloads a mod when any of its files is saved, and a symlink that points at a deleted worktree breaks the mod.
# So a run changes only what differs (a file with equal bytes keeps its mtime, a link already right is left alone), and a run
# from a linked git worktree is refused unless --from-worktree is given (the "look first" flow: the mods then point at that worktree).
set -euo pipefail
cd "$(dirname "$0")"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
from_worktree=0
for a in "$@"; do
  case "$a" in
    --from-worktree) from_worktree=1 ;;
    *) echo "unknown argument: $a (usage: install.sh [--from-worktree])" >&2; exit 2 ;;
  esac
done
if [ "$from_worktree" != 1 ] && [ "$(git rev-parse --absolute-git-dir 2>/dev/null || true)" != "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)" ]; then
  echo "REFUSE: this is a linked git worktree; linking the mods here would break them when it is deleted. Run it from the main checkout, or pass --from-worktree to look at this worktree on purpose." >&2
  exit 2
fi
# cp only when the bytes differ: an identical rewrite still changes the mtime, and Herdr reloads the mod.
copied=0 # set when this run really rewrote a shared copy
sync_file() { cmp -s "$1" "$2" || { cp "$1" "$2"; copied=1; }; }
# Refresh the generated copies first: after an edit in _lib the tests (byte-equal copies) must see the new files.
# The list of shared files is _lib/copies.txt (the self-contained test reads it too).
{ [ ! -f drover-github/query.js ] || cmp -s drover-github/query.js drover-config/query.js || { install -m 644 drover-github/query.js drover-config/query.js; copied=1; }; } # the dialog checks the default query with the GitHub parser
for mod in drover-*/; do
  mod="${mod%/}"
  while IFS= read -r f; do [ -n "$f" ] && sync_file "_lib/$f" "$mod/$f"; done < _lib/copies.txt
done
# Does a running Herdr hold older shared code than the disk now? Herdr is not known to re-import a changed _lib file on its in-place reload
# (the card's incident: PROTOCOL 5 on disk, protocol 4 answered until the window was reopened). So: a hash of the shared set, kept in a hidden
# stamp at the home root (outside mods/, so no mod file changes and nothing reloads). A new hash, or no stamp beside existing links, prints a
# note BEFORE the test and check gates (a failed run may already have changed the linked files). The stamp is written only at the end of a good run.
stamp="$home/.drover-lib-stamp"
# No hasher (sha256sum on Linux, shasum on macOS, else cksum) or a missing _lib file: lib_hash stays empty: no stamp, never a failed install. query.js is optional (the GitHub mod may be absent).
if command -v sha256sum >/dev/null 2>&1; then hasher="sha256sum"; elif command -v shasum >/dev/null 2>&1; then hasher="shasum -a 256"; elif command -v cksum >/dev/null 2>&1; then hasher="cksum"; else hasher=""; fi # cksum (POSIX, always there) only detects change, which is all the stamp needs
lib_hash=""
if [ -n "$hasher" ]; then
  lib_hash="$( { while IFS= read -r f; do [ -n "$f" ] && cat "_lib/$f"; done < _lib/copies.txt; [ ! -f drover-github/query.js ] || cat drover-github/query.js; } 2>/dev/null | $hasher 2>/dev/null )" || lib_hash=""
  { while IFS= read -r f; do [ -z "$f" ] || [ -f "_lib/$f" ] || exit 1; done < _lib/copies.txt; :; } || lib_hash=""
fi
have_links=0; for l in "$home"/mods/drover-*; do [ -L "$l" ] && have_links=1; done
if [ -z "$lib_hash" ]; then
  # Cannot fingerprint. Say so only when this run really rewrote a shared copy of an existing install: never a false alarm on an equal-byte run.
  if [ "$copied" = 1 ] && [ "$have_links" = 1 ]; then
    echo "NOTE: shared _lib files were updated, but their fingerprint could not be checked (no sha256sum/shasum, or a shared file is missing). A running Herdr may keep the old imported code: probe it (drover config max-parallel), and if it is stale, quit and reopen the Herdr window."
  fi
elif { { [ -f "$stamp" ] && [ "$(cat "$stamp")" != "$lib_hash" ]; } || { [ ! -f "$stamp" ] && [ "$have_links" = 1 ]; }; }; then
  echo "NOTE: shared _lib code changed since the last install. A running Herdr may keep the old imported code: probe it (drover config max-parallel shows the limit, or the inbox protocol answer); if it is stale, quit and reopen the Herdr window (terminals survive: they live in herdr-core)."
fi
if [ "${DROVER_SKIP_TESTS:-}" != 1 ]; then
  # A failing test is shown (the last lines of the output), never hidden.
  if ! tests_out="$(node --test _lib/*.test.js _test/*.test.js 2>&1)"; then
    echo "node tests FAILED (set DROVER_SKIP_TESTS=1 to skip this stage). Failing tests, then the last lines:" >&2
    printf '%s\n' "$tests_out" | grep -A20 '^ *not ok' | head -80 >&2 || true
    printf '%s\n' "$tests_out" | tail -8 >&2
    exit 1
  fi
fi
for mod in drover-*/; do
  mod="${mod%/}"
  case " ${DROVER_SKIP_MODS:-} " in *" $mod "*)
    [ -L "$home/mods/$mod" ] && rm "$home/mods/$mod"
    echo "skip $mod: DROVER_SKIP_MODS"; continue ;;
  esac
  target="$home/mods/$mod"
  if [ -e "$target" ] && [ ! -L "$target" ]; then echo "skip $mod: $target is not a symlink" >&2; continue; fi
  [ "$(readlink "$target" 2>/dev/null || true)" = "$PWD/$mod" ] || ln -sfn "$PWD/$mod" "$target"
  herdr-app check "$target" >/dev/null && echo "ok   $mod" || { echo "FAIL $mod" >&2; herdr-app check "$target"; exit 1; }
done
# The drover layout (main + capsule tabs + Tasks column). Switch: herdr-app do layout.switch '{"name":"drover"}'
target="$home/layouts/drover.json"
if [ -e "$target" ] && [ ! -L "$target" ]; then echo "skip layout: $target is not a symlink" >&2
else { [ "$(readlink "$target" 2>/dev/null || true)" = "$PWD/_layouts/drover.json" ] || ln -sfn "$PWD/_layouts/drover.json" "$target"; } && echo "ok   layout drover"; fi
[ -z "$lib_hash" ] || { printf '%s\n' "$lib_hash" > "$stamp.new" && mv -f "$stamp.new" "$stamp"; } # last: only a run that passed every gate counts as installed
