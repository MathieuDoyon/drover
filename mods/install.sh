#!/usr/bin/env bash
# Copy the shared library into each drover-* mod (before the tests: the copies are tested), run the tests, link the mods into Herdr, check them.
# Never replaces a real folder in the Herdr home: only its own symlinks.
# DROVER_SKIP_TESTS=1 skips the node test stage. The stage runs every test file (the glob below), never a hand list.
# The glob does not recurse: the slow install tests live in _test/install/ and are run by hand (docs/development.md).
# DROVER_SKIP_MODS="drover-jira drover-github" (space list) leaves those mods out and removes their symlink; default empty = all mods.
# Herdr hot-reloads a mod when any of its files is saved, and a symlink that points at a deleted worktree breaks the mod.
# So a run changes only what differs (a file with equal bytes keeps its mtime, a link already right is left alone), and a run
# from a linked git worktree is refused unless --from-worktree is given (the "look first" flow: the mods then point at that worktree).
# SAFE UPDATES (docs/install.md): an owner-changed managed file is never overwritten. A managed copy is replaced only when its bytes equal the incoming
# copy, the stored baseline (what the last install wrote), or (guarded) the committed bytes of its own source; otherwise it is KEPT untouched, the
# incoming copy lands beside it as <file>.new, and the run exits 1. Links are repointed or removed only when they still equal what install recorded.
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
# One installer per checkout: a second run (or a killed one that left the folder) is refused before anything is written.
lock="$PWD/.install.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "REFUSE: another install is running in this checkout (or a killed run left $lock: remove that folder if no install.sh is running). Nothing was written." >&2
  exit 2
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
# The links record lives in the home and is shared by every checkout that installs into it: one installer per home as well (always the checkout lock first,
# then this one, so two installers cannot wait on each other). Released by the same trap.
homelock="$home/.drover-install.lock"
if ! mkdir "$homelock" 2>/dev/null; then
  echo "REFUSE: another install is using this Herdr home (or a killed run left $homelock: remove that folder if no install.sh is running). Nothing was written." >&2
  exit 2
fi
trap 'rmdir "$homelock" 2>/dev/null || true; rmdir "$lock" 2>/dev/null || true' EXIT
copied=0   # set when this run really rewrote a shared copy
kept=0     # a managed file or link was kept (owner-changed or unknown): exit 1 at the end, no stamp
conflict=0 # a sidecar was blocked or a retained old file could not be moved: exit 1 at the end, no stamp
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
bl="$home/.drover-baseline$(pwd -P)" # per managed file: its bytes as last installed (<mod>/<file>) and <file>.head (HEAD blob id of its source then); outside mods/: no reload
lrec="$home/.drover-baseline/links" # name<TAB>target of every link install made
backups="$PWD/.install-backups/$run_id"
# test-only: DROVER_INSTALL_TEST_HOOK=<command> runs at four points of one file's publish (captured, classified, published, retained) so a test can act as the owner.
hook() { [ -z "${DROVER_INSTALL_TEST_HOOK:-}" ] || "$DROVER_INSTALL_TEST_HOOK" "$1" "$2" || true; }

# HEAD blob ids of every possible source, read once (one git call, not one per file). head_of <path> sets $cur ("" = no git, or not committed).
while IFS=$' \t' read -r _ _ blob path; do printf -v "H_${path//[^A-Za-z0-9]/_}" '%s' "$blob"; done < <(git ls-tree -r HEAD -- _lib drover-github/query.js 2>/dev/null || true)
head_of() { local v="H_${1//[^A-Za-z0-9]/_}"; cur="${!v:-}"; }
# Every temp file of the installer is made inside a directory this run just created (mkdir fails on an existing name, even a symlink), so a planted
# name is never opened or followed. rtmp (in the home, beside the baselines) serves the records; <mod>/.drover-tmp.<pid>.<file>/ serves each managed file.
# Only directories this run created are ever deleted: an existing name is refused (the records then fail closed), never adopted or cleaned.
rtmp="$home/.drover-baseline/.run.$run_id"; tn=0; rtmp_made=0; backups_made=0
trap 'rmdir "$homelock" 2>/dev/null || true; rmdir "$lock" 2>/dev/null || true; [ "$rtmp_made" != 1 ] || rm -rf "$rtmp" 2>/dev/null || true' EXIT
rtmp_init() { [ "$rtmp_made" = 1 ] || { mkdir -p "$home/.drover-baseline" 2>/dev/null && mkdir "$rtmp" 2>/dev/null && rtmp_made=1; }; }
backup_init() { [ "$backups_made" = 1 ] || { mkdir -p "${backups%/*}" 2>/dev/null && mkdir "$backups" 2>/dev/null && backups_made=1; }; }
put_file() { # <src> <dest>: atomic copy into place; refuses a folder as the destination
  local f; rtmp_init || return 1; tn=$((tn+1)); f="$rtmp/f.$tn"
  [ ! -d "$2" ] || return 1
  [ -d "${2%/*}" ] || mkdir -p "${2%/*}" 2>/dev/null || return 1
  cp "$1" "$f" 2>/dev/null && mv -f "$f" "$2" 2>/dev/null
}
put_str() {
  local f; rtmp_init || return 1; tn=$((tn+1)); f="$rtmp/f.$tn"
  [ ! -d "$2" ] || return 1
  [ -d "${2%/*}" ] || mkdir -p "${2%/*}" 2>/dev/null || return 1
  printf '%s\n' "$1" > "$f" 2>/dev/null && mv -f "$f" "$2" 2>/dev/null; }
# read_head <file>: 0 = a valid HEAD blob id in $hrec; 1 = truly absent (first run); 2 = present but unreadable, not a regular file, or not a blob id.
read_head() {
  hrec=""
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then return 1; fi
  if [ -f "$1" ] && [ ! -L "$1" ] && [ -r "$1" ]; then
    { hrec="$(<"$1")"; } 2>/dev/null || return 2
    [[ "$hrec" =~ ^[0-9a-f]{40,64}$ ]] && return 0
  fi
  return 2
}
# invalidate_base <key>: take the old record out of charge (or, on a first run, mark the record as unfinished) BEFORE the file it describes changes: the baseline
# file goes and the HEAD record is overwritten with the marker "invalid" (not a blob id, so the committed-bytes test stays off too). The marker stays until the
# new record is complete. Returns 1 when it cannot be written: the caller must not change the file (nothing is published or created without a record).
invalidate_base() {
  local base="$bl/$1" hs=0
  read_head "$base.head" || hs=$?
  # the marker goes down even when nothing was ever recorded: a failed first record must not read as "first run" next time
  if [ ! -e "$base" ] && [ ! -L "$base" ] && [ "$hs" = 2 ] && [ "$hrec" = invalid ]; then return 0; fi
  put_str invalid "$base.head" || return 1
  rm -f "$base" 2>/dev/null || true
  [ ! -e "$base" ] && [ ! -L "$base" ]
}
# record_base <reference copy> <key> <source path>: remember the bytes that were published or found equal (the reference copy is a private copy of exactly
# those bytes, never a later read of the mutable canonical file) and the HEAD blob of the source. Anything that must change is invalidated first, so a failed
# write leaves "no usable record" (the file is kept next time unless equal to the incoming copy), never the old record in charge. Returns 1 and says so on failure.
record_base() {
  local inc=$1 key=$2 hrel=$3 base="$bl/$2" hs=0
  head_of "$hrel"
  read_head "$base.head" || hs=$?
  if [ -f "$base" ] && [ ! -L "$base" ] && cmp -s "$inc" "$base"; then
    if [ -n "$cur" ]; then [ "$hs" = 0 ] && [ "$hrec" = "$cur" ] && return 0; else [ "$hs" = 1 ] && return 0; fi
  fi
  if invalidate_base "$key" && put_file "$inc" "$base" && { if [ -n "$cur" ]; then put_str "$cur" "$base.head"; else rm -f "$base.head" 2>/dev/null; [ ! -e "$base.head" ] && [ ! -L "$base.head" ]; fi; }; then return 0; fi
  echo "FAILED $key: the baseline record could not be written (check $bl); the next run keeps this file unless it equals the incoming copy"; conflict=1; return 1
}
# unchanged <file> <reference copy> <key> <source path>: true when the file is one the installer may replace: equal to the incoming copy, to the stored
# baseline, or to the committed bytes of its source. The committed-bytes test applies only on a first run (no record at all) or when HEAD moved since the
# record (a pull rewrites tracked copies and stales baselines); while HEAD stands still it is off, so an owner restore of an older committed version is kept.
# A record that is present but unreadable, invalid or half-written disables it (fail closed), and so does any error.
unchanged() {
  local f=$1 inc=$2 base="$bl/$3" hrel=$4 babs=0 bbad=0 hs=0 apply=0
  cmp -s "$f" "$inc" && return 0
  if [ ! -e "$base" ] && [ ! -L "$base" ]; then babs=1
  elif [ -f "$base" ] && [ ! -L "$base" ] && [ -r "$base" ]; then cmp -s "$f" "$base" && return 0
  else bbad=1; fi
  head_of "$hrel"
  read_head "$base.head" || hs=$?
  if [ "$hs" = 1 ] && [ "$babs" = 1 ]; then apply=1
  elif [ "$hs" = 0 ] && [ "$cur" != "$hrec" ]; then apply=1; fi
  [ "$bbad" = 0 ] || apply=0
  if [ "$apply" = 1 ] && [ -n "$cur" ]; then
    git cat-file blob "$cur" 2>/dev/null | cmp -s - "$f" && return 0
  fi
  return 1
}
# stage <dir> <file>: a fresh private directory for one file's temp copies; fails when the name is taken.
# $st is set only when this run created the folder, so only then is it ever removed (unstage).
stage() { local cand="$1/.drover-tmp.$$.$2"; st=""; stn="$cand"; mkdir "$cand" 2>/dev/null && st="$cand"; }
unstage() { [ -z "${st:-}" ] || rm -rf "$st" 2>/dev/null || true; st=""; }
# sidecar <reference copy> <key> <source path>: put the incoming copy beside the kept file. STATELESS: absent = created with an exclusive ln; equal to the incoming
# copy = nothing to do; anything else (different, a symlink, not a regular file) is older than the incoming copy or the owner's, never touched, reported with the
# source that holds the current incoming copy. No record of it exists, so nothing stale can ever permit an overwrite. Returns 1 when the copy is not there.
sidecar() {
  local inc=$1 key=$2 new="$2.new" st="" stn
  if [ -L "$new" ]; then echo "  $new is a symlink (yours): left alone; the incoming copy is mods/$3"; conflict=1; return 1; fi
  if [ -e "$new" ] && [ ! -f "$new" ]; then echo "  $new is not a regular file (yours): left alone; the incoming copy is mods/$3"; conflict=1; return 1; fi
  if [ -e "$new" ]; then
    cmp -s "$inc" "$new" && return 0
    echo "  $new is older than the incoming copy, or yours: left alone; the incoming copy is mods/$3"; conflict=1; return 1
  fi
  stage "${key%/*}" "${key##*/}.new" || { echo "  $new: cannot stage a copy here"; conflict=1; return 1; }
  if cp "$inc" "$st/n" 2>/dev/null && ln "$st/n" "$new" 2>/dev/null; then unstage; return 0; fi
  unstage; echo "  $new could not be written"; conflict=1; return 1
}
# settle_new <incoming> <key>: the file beside it is settled. A .new equal to the incoming copy is MOVED (a rename, nothing destroyed) into this run's
# .install-backups folder; any other .new is reported and left, and the run is not clean.
settle_new() { # <incoming> <key> <source path>
  local inc=$1 key=$2 new="$2.new"
  [ -e "$new" ] || [ -L "$new" ] || return 0
  if [ -f "$new" ] && [ ! -L "$new" ] && cmp -s "$new" "$inc"; then
    if backup_init && mkdir -p "$backups/${key%/*}" 2>/dev/null && mv "$new" "$backups/$key.new" 2>/dev/null; then return 0; fi
    echo "KEPT $new: could not be moved to $backups; left in place"; conflict=1; return 0
  fi
  echo "KEPT $new: older than the incoming copy, or yours; left alone, remove it yourself (the incoming copy is mods/$3)"; conflict=1
  return 0
}
keep_file() { # <reference copy> <key> <reason> <source path>
  kept=1
  if sidecar "$1" "$2" "$4"; then echo "KEPT $2 ($3): new copy at $2.new"; else echo "KEPT $2 ($3): new copy NOT written"; fi
}
why() { if [ -f "$bl/$1" ]; then echo owner-changed; else echo "unknown baseline"; fi; }

# publish <incoming> <key> <source path>: replace a file that is unchanged, without ever destroying owner bytes the file system lets us keep.
# 0 snapshot the canonical file ONCE into a private dir (snap, plus ref = a second copy of the same bytes: everything below uses ref, never the canonical file);
# 1 capture the old inode under a second name (hard link: any in-place write, before or after the rename, lands in it);
# 2 classify the captured inode; 3 check the file is still that inode; 4 rename the snapshot over it (atomic); 5 classify the captured inode again and MOVE it
# into .install-backups, after the new file is in place.
publish() {
  local inc=$1 key=$2 hrel=$3 dir="${2%/*}" f="${2##*/}" aside st="" stn ref old
  aside="$dir/.drover-aside.$$.$f"
  if ! stage "$dir" "$f"; then echo "KEPT $key (cannot stage a copy here: $stn exists): nothing changed"; kept=1; return 0; fi
  ref="$st/ref"; old="$st/old"
  if ! cp "$inc" "$st/snap" 2>/dev/null || ! cp "$st/snap" "$ref" 2>/dev/null; then unstage; echo "KEPT $key (cannot write a snapshot): nothing changed"; kept=1; return 0; fi
  if ! ln "$key" "$aside" 2>/dev/null; then keep_file "$ref" "$key" "cannot hold the old file" "$hrel"; unstage; return 0; fi
  hook captured "$key"
  # old = a private copy of the captured inode's bytes: it is what gets classified now and what the inode must still hold after the rename
  if ! cp "$aside" "$old" 2>/dev/null || ! unchanged "$old" "$ref" "$key" "$hrel"; then rm -f "$aside"; keep_file "$ref" "$key" "$(why "$key")" "$hrel"; unstage; return 0; fi
  hook classified "$key"
  if [ ! "$key" -ef "$aside" ]; then rm -f "$aside"; keep_file "$ref" "$key" "owner-changed: replaced while updating" "$hrel"; unstage; return 0; fi
  if ! invalidate_base "$key"; then rm -f "$aside"; unstage; echo "KEPT $key (the old baseline record cannot be invalidated, check $bl): nothing changed"; kept=1; conflict=1; return 0; fi
  if ! mv -f "$st/snap" "$key" 2>/dev/null; then rm -f "$aside"; unstage; echo "FAILED $key: could not replace it, nothing changed"; conflict=1; return 0; fi
  copied=1
  hook published "$key"
  if cmp -s "$aside" "$old"; then
    if backup_init && mkdir -p "$backups/${key%/*}" 2>/dev/null && mv "$aside" "$backups/$key" 2>/dev/null; then hook retained "$key"
    else echo "WARN $key: the old file could not be moved to $backups; it stays at $aside"; conflict=1; fi
  else
    if mv "$aside" "$key.owner-$run_id" 2>/dev/null; then echo "KEPT-OWNER $key: your edit made during the update is kept at $key.owner-$run_id; the new file is in place"
    else echo "KEPT-OWNER $key: your edit made during the update stays at $aside (it could not be moved to $key.owner-$run_id); the new file is in place"; fi
    kept=1
  fi
  record_base "$ref" "$key" "$hrel" || true; settle_new "$ref" "$key" "$hrel"; unstage
}
# sync_managed <incoming> <key> <source path>: the rule for one generated copy (key = <mod>/<file>).
sync_managed() {
  local inc=$1 key=$2 hrel=$3 dir="${2%/*}" f="${2##*/}" st="" stn hs=0
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then echo "KEPT $key (not a regular file): its folder is not a real folder; nothing written"; kept=1; return 0; fi
  if [ ! -e "$key" ] && [ ! -L "$key" ]; then
    if stage "$dir" "$f" && cp "$inc" "$st/snap" 2>/dev/null && cp "$st/snap" "$st/ref" 2>/dev/null && invalidate_base "$key" && ln "$st/snap" "$key" 2>/dev/null; then # ln: exclusive, never over a name that appeared meanwhile
      copied=1; record_base "$st/ref" "$key" "$hrel" || true; settle_new "$st/ref" "$key" "$hrel"
    else echo "FAILED $key: could not create it"; conflict=1; fi
    unstage; return 0
  fi
  if [ -L "$key" ] || [ ! -f "$key" ]; then echo "KEPT $key (not a regular file): left untouched, no new copy"; kept=1; return 0; fi
  if cmp -s "$inc" "$key"; then
    # fast path: the file equals the record it already has (record = file bytes, HEAD record current): nothing to write
    head_of "$hrel"; read_head "$bl/$key.head" || hs=$?
    if [ -f "$bl/$key" ] && [ ! -L "$bl/$key" ] && cmp -s "$key" "$bl/$key" && { { [ -n "$cur" ] && [ "$hs" = 0 ] && [ "$hrec" = "$cur" ]; } || { [ -z "$cur" ] && [ "$hs" = 1 ]; }; }; then settle_new "$inc" "$key" "$hrel"; return 0; fi
    # slow path: record a private copy of the canonical bytes that were just compared equal, never a later read of the canonical file
    if stage "$dir" "$f" && cp "$inc" "$st/ref" 2>/dev/null && cmp -s "$st/ref" "$key"; then record_base "$st/ref" "$key" "$hrel" || true; settle_new "$st/ref" "$key" "$hrel"; unstage; return 0; fi
    unstage # the file or the source changed meanwhile: decide again below
  fi
  if unchanged "$key" "$inc" "$key" "$hrel"; then publish "$inc" "$key" "$hrel"; return 0; fi
  keep_file "$inc" "$key" "$(why "$key")" "$hrel"
}
# Refresh the generated copies first: after an edit in _lib the tests (byte-equal copies) must see the new files.
# The list of shared files is _lib/copies.txt (the self-contained test reads it too).
[ ! -f drover-github/query.js ] || sync_managed drover-github/query.js drover-config/query.js drover-github/query.js # the dialog checks the default query with the GitHub parser
for mod in drover-*/; do
  mod="${mod%/}"
  while IFS= read -r f; do [ -n "$f" ] && sync_managed "_lib/$f" "$mod/$f" "_lib/$f"; done < _lib/copies.txt
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
# Links. A link install made is recorded (name<TAB>target). It is repointed or removed only while it still equals the record: a link the owner
# changed, or one nothing recorded, is kept and reported. No guessing from the shape of the path.
link_rec() { [ -f "$lrec" ] && awk -F'\t' -v n="$1" '$1==n{t=$2} END{if(t!="")print t}' "$lrec" || true; }
link_set() { # <name> [target]: record it, or forget the name when no target. Returns 1 (and says so) when the record cannot be written.
  local f; tn=$((tn+1))
  if rtmp_init && f="$rtmp/l.$tn" && { { [ ! -f "$lrec" ] || awk -F'\t' -v n="$1" '$1!=n' "$lrec"; [ -z "${2:-}" ] || printf '%s\t%s\n' "$1" "$2"; } > "$f"; } 2>/dev/null && [ ! -d "$lrec" ] && mv -f "$f" "$lrec" 2>/dev/null; then return 0; fi
  echo "FAILED link $1: the record could not be written (check $home/.drover-baseline)"; conflict=1; return 1
}
# A recorded link is changed or removed only after its record was put out of charge (forgotten); if that fails the link stays as it is.
link_forget_failed() { echo "KEPT link $1 (its record cannot be put out of charge first): not changed"; kept=1; }
ensure_link() { # <name> <path> <wanted target>; returns 1 when a link was kept
  local name=$1 path=$2 want=$3 cur rec
  if [ -L "$path" ]; then
    cur="$(readlink "$path")"
    if [ "$cur" = "$want" ]; then [ "$(link_rec "$name")" = "$want" ] || link_set "$name" "$want" || true; return 0; fi
    rec="$(link_rec "$name")"
    if [ -n "$rec" ] && [ "$cur" = "$rec" ]; then
      link_set "$name" || { link_forget_failed "$path"; return 1; }
      ln -sfn "$want" "$path"; link_set "$name" "$want" || true; return 0
    fi
    echo "KEPT link $path -> $cur ($([ -n "$rec" ] && echo owner-changed || echo 'unknown baseline')): install would point it at $want; remove the link and run install.sh again to take it"
    kept=1; return 1
  fi
  ln -sfn "$want" "$path"; link_set "$name" "$want" || true; return 0
}
for mod in drover-*/; do
  mod="${mod%/}"
  target="$home/mods/$mod"
  case " ${DROVER_SKIP_MODS:-} " in *" $mod "*)
    if [ -L "$target" ]; then
      cur="$(readlink "$target")"; rec="$(link_rec "mods/$mod")"
      if [ "$cur" = "$rec" ]; then if link_set "mods/$mod"; then rm "$target"; else link_forget_failed "$target"; fi; else echo "KEPT link $target -> $cur ($([ -n "$rec" ] && echo owner-changed || echo 'unknown baseline')): not removed"; kept=1; fi
    fi
    echo "skip $mod: DROVER_SKIP_MODS"; continue ;;
  esac
  if [ -e "$target" ] && [ ! -L "$target" ]; then echo "skip $mod: $target is not a symlink" >&2; continue; fi
  ensure_link "mods/$mod" "$target" "$PWD/$mod" || true
  herdr-app check "$target" >/dev/null && echo "ok   $mod" || { echo "FAIL $mod" >&2; herdr-app check "$target"; exit 1; }
done
# The drover layout (main + capsule tabs + Tasks column). Switch: herdr-app do layout.switch '{"name":"drover"}'
target="$home/layouts/drover.json"
if [ -e "$target" ] && [ ! -L "$target" ]; then echo "skip layout: $target is not a symlink" >&2
else ensure_link "layouts/drover.json" "$target" "$PWD/_layouts/drover.json" && echo "ok   layout drover" || true; fi
if [ "$kept" = 1 ] || [ "$conflict" = 1 ]; then
  echo "INCOMPLETE: some files or links were kept or blocked (see the KEPT/WARN lines above); the lib stamp was not written. Exit 1." >&2
  exit 1
fi
[ -z "$lib_hash" ] || { printf '%s\n' "$lib_hash" > "$stamp.new" && mv -f "$stamp.new" "$stamp"; } # last: only a run that passed every gate counts as installed
