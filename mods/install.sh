#!/usr/bin/env bash
# Copy the shared library into each drover-* mod (before the tests: the copies are tested), run the tests, link the mods into Herdr, check them.
# Never replaces a real folder in the Herdr home: only its own symlinks.
# DROVER_SKIP_TESTS=1 skips the node test stage. The stage runs every test file (the glob below), never a hand list.
# DROVER_SKIP_MODS="drover-jira drover-github" (space list) leaves those mods out and removes their symlink; default empty = all mods.
set -euo pipefail
cd "$(dirname "$0")"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
# Refresh the generated copies first: after an edit in _lib the tests (byte-equal copies) must see the new files.
# The list of shared files is _lib/copies.txt (the self-contained test reads it too).
install -m 644 drover-github/query.js drover-config/query.js # the dialog checks the default query with the GitHub parser
for mod in drover-*/; do
  mod="${mod%/}"
  while IFS= read -r f; do [ -n "$f" ] && cp "_lib/$f" "$mod/"; done < _lib/copies.txt
done
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
  ln -sfn "$PWD/$mod" "$target"
  herdr-app check "$target" >/dev/null && echo "ok   $mod" || { echo "FAIL $mod" >&2; herdr-app check "$target"; exit 1; }
done
# The drover layout (main + capsule tabs + Tasks column). Switch: herdr-app do layout.switch '{"name":"drover"}'
target="$home/layouts/drover.json"
if [ -e "$target" ] && [ ! -L "$target" ]; then echo "skip layout: $target is not a symlink" >&2
else ln -sfn "$PWD/_layouts/drover.json" "$target" && echo "ok   layout drover"; fi
