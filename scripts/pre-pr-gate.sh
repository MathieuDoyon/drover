#!/usr/bin/env bash
# Pre-PR local gate: run it on the final commit, before READY_FOR_PR. Scans the ADDED lines of the branch diff.
#
#   scripts/pre-pr-gate.sh [--base <ref>] [--all]
#
#   --base <ref>  diff <ref>...HEAD (default origin/main)
#   --all         inventory report of the whole tree at HEAD (same scanner, synthetic diff against the empty tree): counts per rule
#                 and per file, no values, no line numbers; exits 1 when the tree has hits. The gate proper is the branch diff.
# Exit: 0 clean | 1 a hit (blocks READY_FOR_PR) | 2 the gate could not look (bad base, no repo, ...; blocks READY_FOR_PR too).
# Output: "file:line  rule" per hit, never the matched text. Rules (scripts/leak-rules.awk): leak (the public-sync rules),
#   secret-fixture (secret-looking literal in a test file: build it by concatenation), name (a private word), name-split (a private
#   word split across literals or up to 3 consecutive added lines; punctuation ignored), generic-name (a test reads the account or host name).
# Private words (scripts/pre-pr-gate-names.mjs -> mods/_test/private-words.js): this user, this host, the linked machines (hc machine ls
#   --json, never --on) and DROVER_PRIVATE_WORDS as extra; read at run time, never written in the repo. Words under 4 characters are ignored.
# Exit 2 also when that lookup is incomplete (hc missing, failing, bad JSON) or the helper cannot be loaded.
# Allowlist: scripts/pre-pr-gate.allow, lines path<TAB>rule<TAB>sha256(trimmed added line); one exact line under one rule, never a path.
# Stated limits: a word built from one unchanged and one added fragment, reversed or encoded words are not caught.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
base="origin/main"; all=0
die() { echo "gate: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || die "--base needs a value"; base="$2"; shift 2 ;;
    --all)  all=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
tmp="$(mktemp -d)" || die "cannot make a temp dir"
trap 'rm -rf -- "$tmp"' EXIT
if [ "$all" = 1 ]; then
  empty="$(git hash-object -t tree /dev/null)" || die "cannot compute the empty tree"
  git -c core.quotePath=false diff -U0 --text --no-color --no-renames "$empty" HEAD >"$tmp/diff" 2>/dev/null || die "cannot read the tree at HEAD"
  scope="whole tree at HEAD"
else
  git rev-parse --verify -q "$base^{commit}" >/dev/null 2>&1 || die "base '$base' is not a commit"
  git -c core.quotePath=false diff -U0 --text --no-color --no-renames "$base...HEAD" >"$tmp/diff" 2>/dev/null || die "cannot diff $base...HEAD"
  scope="$base...HEAD"
fi

# Private words: the shared helper (this user, this host, hc machine ls --json, DROVER_PRIVATE_WORDS as extra).
command -v node >/dev/null 2>&1 || die "node not found: private words cannot be read"
notes="$(node "$here/pre-pr-gate-names.mjs" "$tmp/words")"; nrc=$?
case "$nrc" in
  0|3) ;;
  4|5) printf '%s\n' "$notes" >&2; die "private words cannot be trusted" ;;
  *)   die "private words could not be read (helper exit $nrc)" ;;
esac

# Allowlist: path<TAB>rule<TAB>sha256 of the trimmed added line. Only that exact line under that rule.
allow="${GATE_ALLOW:-$here/pre-pr-gate.allow}"; tab=$'\t'; : >"$tmp/allow"
if [ -f "$allow" ]; then
  while IFS= read -r l || [ -n "$l" ]; do
    case "$l" in ''|'#'*) continue ;; esac
    printf '%s\n' "$l" | grep -Eq "^[^$tab]+$tab[a-z0-9-]+$tab[0-9a-f]{64}\$" || die "malformed allowlist entry in $allow (want path<TAB>rule<TAB>sha256)"
    printf '%s\n' "$l" >>"$tmp/allow"
  done <"$allow"
fi
sha() { if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi | cut -d' ' -f1; }

# The scanner runs to a file so a failing tr/awk/sort is exit 2, never an empty (clean) result.
LC_ALL=C tr '\000' ' ' <"$tmp/diff" | GATE_WORDS="$(cat "$tmp/words")" LC_ALL=C awk -v gate=1 -f "$here/leak-rules.awk" | sort -u >"$tmp/records" || die "the scanner failed: nothing was checked"

hits=""; allowed=0
while IFS= read -r rec; do
  [ -n "$rec" ] || continue
  head="${rec%%$tab*}"; text="${rec#*$tab}"; rule="${head##*  }"; file="${head%  *}"; file="${file%:*}"
  if [ -s "$tmp/allow" ] && [ "${text#$'\001'}" = "$text" ] && grep -Fq -- "$file$tab$rule$tab" "$tmp/allow"; then
    trimmed="$(printf '%s' "$text" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if grep -Fxq -- "$file$tab$rule$tab$(printf '%s' "$trimmed" | sha)" "$tmp/allow"; then allowed=$((allowed+1)); continue; fi
  fi
  hits="$hits$head"$'\n'
done <"$tmp/records"

[ -z "$notes" ] || printf '%s\n' "$notes"
[ "$allowed" = 0 ] || echo "gate: allowed: $allowed (exact lines in $(basename "$allow"))"
if [ -n "$hits" ]; then
  if [ "$all" = 1 ]; then
    echo "gate: REPORT for $scope: inventory only, values and line numbers not shown"
    echo "hits per rule:"; printf '%s' "$hits" | sort -u | awk '{ print $NF }' | sort | uniq -c | awk '{ printf "  %s %d\n", $2, $1 }'
    echo "hits per file and rule:"; printf '%s' "$hits" | sort -u | sed -E 's/:[0-9]+  / /' | sort | uniq -c
    echo "gate: the tree has hits (exit 1); the gate itself is the branch diff"; exit 1
  fi
  echo "gate: HITS in $scope (values not shown)"; printf '%s' "$hits" | sort -u
  echo "gate: FAILED: fix each hit, commit, run again"; exit 1
fi
if [ "$nrc" = 3 ]; then echo "gate: INCOMPLETE ($scope): the checks above were not done; this blocks READY_FOR_PR"; exit 2; fi
echo "gate: clean ($scope)"
