#!/usr/bin/env bash
# Tests for scripts/public-sync.sh. Temp repos and a local bare remote only; the real public repo is never touched.
# Run: scripts/public-sync.test.sh   (exit 0 = all passed)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sync="$here/public-sync.sh"
work="$(mktemp -d)"
trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf -- "$work"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS $1"; }
bad() { fail=$((fail+1)); echo "FAIL $1${2:+: $2}"; [ -f "$work/out" ] && sed 's/^/  | /' "$work/out"; }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
gid=(-c user.name=T -c user.email=t@example.com)
slug="Owner/pub"                      # stands in for the public repo name in repo.txt
NOREPLY_NAME="Mathieu Doyon"; NOREPLY_MAIL="1854511+MathieuDoyon@users.noreply.github.com"

# fixtures: private bare "origin" + private working clone; public bare + export clone
mk() {
  local d="$work/$1"; rm -rf "$d"; mkdir -p "$d"
  git init -q --bare -b main "$d/priv-origin.git"
  git clone -q "$d/priv-origin.git" "$d/private" 2>/dev/null
  mkdir -p "$d/private/mods/_recipe"; echo "$slug" > "$d/private/mods/_recipe/repo.txt"
  echo one > "$d/private/a.txt"
  git -C "$d/private" "${gid[@]}" add -A; git -C "$d/private" "${gid[@]}" commit -qm "private 1"
  git -C "$d/private" push -q origin HEAD:main
  git init -q --bare -b main "$d/pub.git"
  git clone -q "$d/pub.git" "$d/export" 2>/dev/null
  echo one > "$d/export/a.txt"; mkdir -p "$d/export/mods/_recipe"; echo "$slug" > "$d/export/mods/_recipe/repo.txt"
  git -C "$d/export" "${gid[@]}" add -A; git -C "$d/export" "${gid[@]}" commit -qm "public 1"
  git -C "$d/export" push -q origin HEAD:main
  # the export's origin reads as the github URL of repo.txt; git rewrites it to the local bare repo (no network, no script bypass)
  git -C "$d/export" remote set-url origin "https://github.com/$slug.git"
  git -C "$d/export" config "url.$d/pub.git.insteadOf" "https://github.com/$slug.git"
  echo "$d"
}
priv_commit() { # <dir> <file> <content>
  printf '%s\n' "$3" > "$1/private/$2"; git -C "$1/private" "${gid[@]}" add -A
  git -C "$1/private" "${gid[@]}" commit -qm "private change"; git -C "$1/private" push -q origin HEAD:main
}
run() { local d="$1"; shift; bash "$sync" --export "$d/export" --private "$d/private" --message "msg" "$@" >"$work/out" 2>&1; echo $?; }
expect_refuse() { # <name> <rc> <pattern>
  if [ "$2" != 0 ] && grep -q -- "$3" "$work/out"; then ok "$1"; else bad "$1" "rc=$2"; fi
}

# 1 args
bash "$sync" >"$work/out" 2>&1; [ $? -ne 0 ] && ok "no args refused" || bad "no args refused"

# 2 tree equal
d="$(mk eq)"; rc="$(run "$d")"; expect_refuse "tree already equal" "$rc" "nothing to sync"

# 3 dirty export
d="$(mk dirty)"; priv_commit "$d" a.txt two; echo x > "$d/export/junk"; rc="$(run "$d")"; expect_refuse "dirty export" "$rc" "dirty"

# 4 wrong origin
d="$(mk origin)"; priv_commit "$d" a.txt two; echo "Other/thing" > "$d/private/mods/_recipe/repo.txt"
rc="$(run "$d")"; expect_refuse "export origin is not the public repo" "$rc" "expected"

# 5 private main != its origin/main
d="$(mk ahead)";
echo local > "$d/private/b.txt"; git -C "$d/private" "${gid[@]}" add -A; git -C "$d/private" "${gid[@]}" commit -qm local
rc="$(run "$d")"; expect_refuse "private main not equal to origin/main" "$rc" "origin/main"

# 6 leaks (one per class); the value must never be printed
leak() { # <name> <content>
  d="$(mk "leak-$1")"; priv_commit "$d" leak.txt "$2"
  rc="$(run "$d")"; expect_refuse "leak: $1" "$rc" "leak.txt:[12]"
  if grep -qF "SECRETVALUE" "$work/out"; then bad "leak: $1 printed a value"; else ok "leak: $1 value not printed"; fi
}
leak home "path /Us""ers/bob/x SECRETVALUE"
leak homeNumeric "path /Us""ers/123/x SECRETVALUE"
leak headerShaped $'++ b/\n'"gh""p_SECRETVALUE"
leak homeUpper "path /Us""ers/Alice/x SECRETVALUE"
leak tailscale64 "host 100.""64.2.3 SECRETVALUE"
leak employer "see ""nest""oca SECRETVALUE"
leak tailscale "host 100.""87.2.3 SECRETVALUE"
leak ghp "ghp""_SECRETVALUE0123456789"
leak pat "github""_pat_SECRETVALUE"
leak ant "sk-""ant-SECRETVALUE"
leak pem "-----BEGIN RSA PRIVATE"" KEY----- SECRETVALUE"
leak keyval "OPENAI_API""_KEY=SECRETVALUE"
leak tokenval "GH_TO""KEN=SECRETVALUE"
leak secretval "MY_SE""CRET=SECRETVALUE"

# 5b destination checks: foreign host, an extra push URL
d="$(mk host)"; priv_commit "$d" a.txt two; git -C "$d/export" remote set-url origin "https://example.com/$slug.git"
rc="$(run "$d")"; expect_refuse "origin on another host" "$rc" "github.com"
d="$(mk pushurl)"; priv_commit "$d" a.txt two; git -C "$d/export" config remote.origin.pushurl "$d/pub.git"
rc="$(run "$d")"; expect_refuse "push URL not on github.com" "$rc" "push URL"
d="$(mk pushurl2)"; priv_commit "$d" a.txt two; git -C "$d/export" config remote.origin.pushurl "https://github.com/Other/thing.git"
rc="$(run "$d")"; expect_refuse "push URL names another repo" "$rc" "push URL"

# 5b2 a second origin URL (git pushes to every one) is validated too
d="$(mk multi)"; priv_commit "$d" a.txt two; git init -q --bare -b main "$d/wrong.git"
git -C "$d/export" config --add remote.origin.url "https://github.com/Other/wrong.git"
git -C "$d/export" config "url.$d/wrong.git.insteadOf" "https://github.com/Other/wrong.git"
rc="$(run "$d" --push)"; expect_refuse "second origin URL names another repo" "$rc" "expected"
[ -z "$(git -C "$d/wrong.git" for-each-ref)" ] && ok "wrong remote untouched" || bad "wrong remote untouched"

# 5c options without a value terminate with a refusal
for o in --export --private --message; do
  bash "$sync" "$o" >"$work/out" 2>&1 </dev/null; rc=$?
  { [ "$rc" = 1 ] && grep -q "needs a value" "$work/out"; } && ok "$o without value refused" || bad "$o without value refused" "rc=$rc"
done

# 5d binary additions are scanned (NUL then a token prefix)
d="$(mk bin)"; printf 'x\0gh%s_SECRETVALUE\n' p > "$d/private/blob.bin"
git -C "$d/private" "${gid[@]}" add -A; git -C "$d/private" "${gid[@]}" commit -qm bin; git -C "$d/private" push -q origin HEAD:main
rc="$(run "$d")"; expect_refuse "leak in a binary file" "$rc" "blob.bin"

# 5e self-sync: this change's own script, test, docs and conv pointer pass the scan
d="$(mk self)"; root="$(cd "$here/.." && pwd)"
mkdir -p "$d/private/scripts" "$d/private/docs" "$d/private/conv" "$d/private/.github/workflows"
cp "$root/scripts/"* "$d/private/scripts/"; cp "$root/docs/development.md" "$d/private/docs/"; cp "$root/conv/05-git.md" "$d/private/conv/"; cp "$root/.github/workflows/"*.yml "$d/private/.github/workflows/"
git -C "$d/private" "${gid[@]}" add -A; git -C "$d/private" "${gid[@]}" commit -qm self; git -C "$d/private" push -q origin HEAD:main
rc="$(run "$d")"; [ "$rc" = 0 ] && grep -q "leak check: clean" "$work/out" && ok "self-sync content is clean" || bad "self-sync content is clean" "rc=$rc"

# 7 dry run: no commit, no ref change, prints the plan
d="$(mk dry)"; priv_commit "$d" a.txt two
before="$(git -C "$d/export" rev-parse HEAD)"; bare_before="$(git -C "$d/pub.git" rev-parse main)"
rc="$(run "$d")"; cnt="$(git -C "$d/export" rev-list --all --count)"
if [ "$rc" = 0 ] && grep -q "parent" "$work/out" && grep -q "tree" "$work/out" && grep -q "leak check: clean" "$work/out" \
   && [ "$(git -C "$d/export" rev-parse HEAD)" = "$before" ] && [ "$(git -C "$d/pub.git" rev-parse main)" = "$bare_before" ] && [ "$cnt" = 1 ]; then ok "dry run makes no commit"; else bad "dry run makes no commit" "rc=$rc"; fi

# 8 --push to the local bare remote: exactly 1 commit, noreply identity, tree equal
rc="$(run "$d" --push)"
tip="$(git -C "$d/pub.git" rev-parse main)"
n="$(git -C "$d/pub.git" rev-list "$bare_before..main" --count)"
if [ "$rc" = 0 ] && [ "$n" = 1 ] \
   && [ "$(git -C "$d/pub.git" log -1 --format='%an <%ae>|%cn <%ce>' main)" = "$NOREPLY_NAME <$NOREPLY_MAIL>|$NOREPLY_NAME <$NOREPLY_MAIL>" ] \
   && [ "$(git -C "$d/pub.git" rev-parse main^{tree})" = "$(git -C "$d/private" rev-parse HEAD^{tree})" ] \
   && [ "$(git -C "$d/pub.git" log -1 --format=%s main)" = "msg" ]; then ok "--push: 1 commit, noreply identity, tree equal"; else bad "--push" "rc=$rc n=$n"; fi
rc="$(run "$d" --push)"; expect_refuse "second push: nothing to sync" "$rc" "nothing to sync"

bash -n "$sync" && ok "bash -n" || bad "bash -n"
echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]
