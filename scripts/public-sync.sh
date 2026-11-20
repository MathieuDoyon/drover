#!/usr/bin/env bash
# Sync the private repo's main to the public repo as ONE commit with the exact tree of private main.
# Dry run by default: prints the commit it would make. --push really pushes. See docs/development.md ("Syncing the public repo").
#
#   scripts/public-sync.sh --export <export clone> --private <private clone> --message <msg> [--push]
#
# Env: PUBLIC_SYNC_NAME / PUBLIC_SYNC_EMAIL  author+committer of the public commit
#        (default: Mathieu Doyon <1854511+MathieuDoyon@users.noreply.github.com>; a fork sets its own).
# Refuses: dirty export, export origin != mods/_recipe/repo.txt, private main != its origin/main,
#          tree already equal, leak hits. Prints only file:line of a hit, never the matched text.
set -uo pipefail

name="${PUBLIC_SYNC_NAME:-Mathieu Doyon}"
email="${PUBLIC_SYNC_EMAIL:-1854511+MathieuDoyon@users.noreply.github.com}"
export_dir=""; private_dir=""; msg=""; push=0
die() { echo "REFUSED: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --export|--private|--message) [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in --export) export_dir="$2" ;; --private) private_dir="$2" ;; *) msg="$2" ;; esac; shift 2 ;;
    --push)    push=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$export_dir" ] && [ -n "$private_dir" ] && [ -n "$msg" ] || die "usage: public-sync.sh --export <dir> --private <dir> --message <msg> [--push]"
[ -d "$export_dir/.git" ] || die "$export_dir is not a git clone"
[ -d "$private_dir/.git" ] || die "$private_dir is not a git clone"
ex() { git -C "$export_dir" "$@"; }
pv() { git -C "$private_dir" "$@"; }

# 1. export clone clean
[ -z "$(ex status --porcelain)" ] || die "export clone is dirty: $export_dir"

# 2. export origin is the public repo named in mods/_recipe/repo.txt
want="$(tr -d '[:space:]' < "$private_dir/mods/_recipe/repo.txt" 2>/dev/null)"
[ -n "$want" ] || die "cannot read mods/_recipe/repo.txt in $private_dir"
# The raw configured URLs (get-url would show the url.*.insteadOf rewrite): fetch URL and, if set, push URL must both be github.com/<want>.
check_url() { # <label> <url>
  local u="$2" slug
  case "$u" in
    https://github.com/*|git@github.com:*|ssh://git@github.com/*) ;;
    *) die "export $1 URL is not on github.com" ;;
  esac
  slug="$(printf '%s' "$u" | sed -E 's#\.git$##; s#^.*github\.com[:/]##')"
  [ "$slug" = "$want" ] || die "export $1 URL names '$slug', expected '$want' (from mods/_recipe/repo.txt)"
}
urls="$(ex config --get-all remote.origin.url)" || die "export clone has no origin"
while IFS= read -r u; do check_url fetch "$u"; done <<< "$urls"   # git pushes to EVERY url when no pushurl is set
while IFS= read -r pu; do check_url push "$pu"; done < <(ex config --get-all remote.origin.pushurl)

# 3. private main equals the private repo's origin/main
pv fetch -q origin main 2>/dev/null || die "cannot fetch origin main in the private repo"
pmain="$(pv rev-parse --verify -q refs/heads/main)" || die "private repo has no local main"
[ "$pmain" = "$(pv rev-parse FETCH_HEAD)" ] || die "private main is not equal to origin/main (push or pull it first)"

# 4. tree comparison
ex fetch -q origin main || die "cannot fetch origin main in the export clone"
parent="$(ex rev-parse --verify origin/main)"
ex fetch -q "$private_dir" main || die "cannot fetch private main into the export clone"
tree="$(ex rev-parse 'FETCH_HEAD^{tree}')"
[ "$tree" != "$(ex rev-parse "$parent^{tree}")" ] || { echo "nothing to sync: public main already has the tree of private main"; exit 1; }

# 5. leak check on the added lines only; output is file:line, never the text
# --text scans binary additions too; NULs become spaces so awk sees the whole line
here="$(cd "$(dirname "$0")" && pwd)"   # the leak rules are scripts/leak-rules.awk, shared with scripts/pre-pr-gate.sh
leaks="$(ex diff -U0 --text --no-color --no-renames "$parent" "$tree" | tr '\000' ' ' | LC_ALL=C awk -f "$here/leak-rules.awk")"

echo "public sync plan"
echo "  parent:  $parent"
echo "  tree:    $tree"
echo "  author:  $name <$email>"
echo "  message: $msg"
ex diff --stat "$parent" "$tree" | sed 's/^/  /'
if [ -n "$leaks" ]; then
  echo "leak check: HITS (values not shown)"; printf '%s\n' "$leaks" | sed 's/^/  /'
  die "leak check found the hits above"
fi
echo "leak check: clean"

if [ "$push" != 1 ]; then echo "dry run: nothing committed, nothing pushed (use --push)"; exit 0; fi

# 6. commit and push (plain push: a non-fast-forward is rejected, never forced)
c="$(GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" \
     ex commit-tree "$tree" -p "$parent" -m "$msg")" || die "commit-tree failed"
[ "$(ex rev-parse "$c^{tree}")" = "$tree" ] || die "tree mismatch after commit-tree"
ex push -q origin "$c:refs/heads/main" || die "push rejected; public main moved or the remote refused. Nothing was changed on the remote"
if [ "$(ex rev-parse --abbrev-ref HEAD)" = main ]; then ex merge -q --ff-only "$c" || true; fi
echo "pushed $c"
