#!/usr/bin/env bash
# Tests for scripts/pre-pr-gate.sh. Temp git repos only. Run: scripts/pre-pr-gate.test.sh   (exit 0 = all passed)
# Every secret and every private word is generated at test time (secrets by concatenation, words from /dev/urandom),
# so this file spells no name, whole or split, and no secret-looking literal.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
gate="$here/pre-pr-gate.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS $1"; }
bad() { fail=$((fail+1)); echo "FAIL $1${2:+: $2}"; [ -f "$work/out" ] && sed 's/^/  | /' "$work/out"; }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
unset DROVER_PRIVATE_WORDS
gid=(-c user.name=T -c user.email=t@example.com)

rnd() { # <charset> <length>
  local s; s="$(LC_ALL=C tr -dc "$1" </dev/urandom 2>/dev/null | head -c "$2")"; printf '%s' "$s"
}
tail24="$(rnd 'A-Za-z0-9' 24)"
w1="$(rnd 'a-z' 8)"                       # the private word of most cases
a="${w1:0:4}"; b="${w1:4}"                # its two pieces
pre_sk="sk""-"; pre_ant="sk""-ant-"; pre_ghp="gh""p_"; pre_pat="github""_pat_"; pre_aws="AK""IA"; pre_xox="xo""xb-"

# a repo with one base commit on main and a work branch; prints its path
mk() {
  local d="$work/$1"; rm -rf "$d"; mkdir -p "$d"
  git init -q -b main "$d"; echo one > "$d/README.md"
  git -C "$d" "${gid[@]}" add -A; git -C "$d" "${gid[@]}" commit -qm base
  git -C "$d" checkout -q -b work
  echo "$d"
}
put() { # <repo> <path> <content>   (content is written as given, one trailing newline)
  mkdir -p "$(dirname "$1/$2")"; printf '%s\n' "$3" > "$1/$2"
}
commit() { git -C "$1" "${gid[@]}" add -A; git -C "$1" "${gid[@]}" commit -qm change; }
# hc stubs: discovery must never touch the real machines. stub_ok lists none; others are made per case.
stubdir() { local dir="$work/stub-$1"; mkdir -p "$dir"; printf '#!/bin/sh\n%s\n' "$2" > "$dir/hc"; chmod +x "$dir/hc"; echo "$dir"; }
stub_ok="$(stubdir ok 'echo "$@" >> "$HC_LOG"; printf "{\"machines\":[]}"')"
export HC_LOG="$work/hc.log"
run() { # <repo> [args...]; sets $rc, output in $work/out (stdout+stderr)
  local d="$1"; shift
  (cd "$d" && PATH="$stub_ok:$PATH" bash "$gate" --base main "$@") >"$work/out" 2>&1; rc=$?
}
runp() { # <PATH> <repo> [args...]: same, with an explicit PATH
  local pth="$1" d="$2"; shift 2
  (cd "$d" && PATH="$pth" bash "$gate" --base main "$@") >"$work/out" 2>&1; rc=$?
}
no_value() { # <name> <value>...  none of the values may appear in the output
  local n="$1" v; shift
  for v in "$@"; do
    if grep -qiF -- "$v" "$work/out"; then bad "$n: a value was printed"; return; fi
  done
  ok "$n: no value printed"
}
expect() { # <name> <rc> <rule or ''> [file]
  local n="$1" want="$2" rule="$3" f="${4:-}"
  if [ "$rc" != "$want" ]; then bad "$n" "rc=$rc want=$want"; return; fi
  if [ -n "$rule" ] && ! grep -Eq "^${f:-[^ ]+}:[0-9]+  $rule\$" "$work/out"; then bad "$n" "no '$rule' hit"; return; fi
  ok "$n"
}
absent() { # <name> <rule>: no line of that rule in the output
  if grep -Eq "  $2\$" "$work/out"; then bad "$1" "unexpected $2 hit"; else ok "$1"; fi
}

# --- B5: secret-looking literals in test fixtures
d="$(mk b5-sk)"; put "$d" mods/x.test.js "const k = \"$pre_sk$tail24\";"; commit "$d"
run "$d"; expect "B5 sk- whole: secret-fixture" 1 secret-fixture mods/x.test.js; absent "B5 sk- whole: not a public-sync class" leak; no_value "B5 sk-" "$tail24"

d="$(mk b5-ant)"; put "$d" mods/x.test.js "const k = \"$pre_ant$tail24\";"; commit "$d"
run "$d"; expect "B5 Anthropic prefix whole: leak" 1 leak mods/x.test.js; expect "B5 Anthropic prefix whole: secret-fixture" 1 secret-fixture mods/x.test.js; no_value "B5 Anthropic prefix" "$tail24"

d="$(mk b5-ghp)"; put "$d" scripts/y.test.sh "tok=$pre_ghp$tail24"; commit "$d"
run "$d"; expect "B5 GitHub PAT prefix whole: leak" 1 leak scripts/y.test.sh; expect "B5 GitHub PAT prefix whole: secret-fixture" 1 secret-fixture scripts/y.test.sh; no_value "B5 GitHub PAT prefix" "$tail24"

for p in pat aws xox; do
  eval "pre=\$pre_$p"; t="$tail24"; [ "$p" = aws ] && t="$(rnd 'A-Z0-9' 16)"
  d="$(mk b5-$p)"; put "$d" mods/_test/z.js "x = '$pre$t'"; commit "$d"
  run "$d"; expect "B5 $p whole: secret-fixture" 1 secret-fixture; no_value "B5 $p" "$t"
done

d="$(mk b5-assign)"; put "$d" mods/x.test.js "const apiToken = \"$(rnd 'a-z0-9' 20)\";"; commit "$d"
run "$d"; expect "B5 token assigned a long literal" 1 secret-fixture

d="$(mk b5-concat)"
put "$d" mods/x.test.js "const a = \"sk-\" + \"$tail24\"; const b = \"gh\" + \"p_\" + \"$tail24\"; const c = [\"github_\", \"pat_$tail24\"].join(\"\");"; commit "$d"
run "$d"; expect "B5 same literals built by concatenation pass" 0 ""

d="$(mk b5-nontest)"; put "$d" src/app.js "const k = \"$pre_sk$tail24\";"; commit "$d"
run "$d"; expect "secret-fixture is for test files only (sk- in app code is not a hit)" 0 ""

# --- A3a: private words, from the environment at run time
export DROVER_PRIVATE_WORDS="$w1"
d="$(mk a3a-whole)"; put "$d" mods/x.test.js "const n = \"$w1\";"; commit "$d"
run "$d"; expect "name written whole" 1 name mods/x.test.js; no_value "name whole" "$w1" "$a" "$b"

d="$(mk a3a-two)"; put "$d" mods/x.test.js "const n = \"$a\" + \"$b\";"; commit "$d"
run "$d"; expect "A3a split in 2 literals" 1 name-split mods/x.test.js; no_value "A3a 2 literals" "$w1" "$a" "$b"

d="$(mk a3a-lines)"; put "$d" mods/x.js "const n = \"$a\" +"$'\n'"  \"$b\";"; commit "$d"
run "$d"
grep -Eq '^mods/x.js:[0-9]+  name-split$' "$work/out" && [ "$rc" = 1 ] && ok "A3a split across 2 lines" || bad "A3a split across 2 lines" "rc=$rc"
no_value "A3a 2 lines" "$w1" "$a" "$b"

d="$(mk a3a-regex)"; put "$d" mods/x.js "const re = /(?:$a)(?:$b)/;"; commit "$d"
run "$d"; expect "A3a split in a regex" 1 name-split

d="$(mk a3a-upper)"; up="$(printf '%s' "$a" | tr a-z A-Z)"; put "$d" mods/x.js "const n = '$up' + '$b';"; commit "$d"
run "$d"; expect "A3a split, mixed case" 1 name-split

d="$(mk a3a-three)"; put "$d" mods/x.js "const n = [\"${w1:0:3}\", \"${w1:3:3}\", \"${w1:6}\"].join(\"\");"; commit "$d"
run "$d"; expect "A3a split in 3 pieces" 1 name-split

p1="$(rnd 'a-z' 5)"; p2="$(rnd 'a-z' 4)"
export DROVER_PRIVATE_WORDS="$p1-$p2"
d="$(mk a3a-punct)"; put "$d" mods/x.js "const n = \"$p1\" + \"-\" + \"$p2\";"; commit "$d"
run "$d"; expect "A3a punctuated word, split" 1 name-split; no_value "A3a punctuated" "$p1" "$p2"

w4="$(rnd 'a-z' 4)"; export DROVER_PRIVATE_WORDS="$w4"
d="$(mk a3a-4)"; put "$d" mods/x.js "const n = \"${w4:0:2}\" + \"${w4:2}\";"; commit "$d"
run "$d"; expect "A3a 4-char word split in 2" 1 name-split

w5="$(rnd 'a-z' 5)"; export DROVER_PRIVATE_WORDS="$w5"
d="$(mk a3a-5)"; put "$d" mods/x.js "const n = \"${w5:0:2}\" + \"${w5:2}\";"; commit "$d"
run "$d"; expect "A3a 5-char word split in 2" 1 name-split

export DROVER_PRIVATE_WORDS="$w1"
d="$(mk a3a-far)"; put "$d" mods/x.js "const n = \"$a\";"$'\n'"//"$'\n'"//"$'\n'"//"$'\n'"const m = \"$b\";"; commit "$d"
run "$d"; expect "pieces 4 lines apart are not joined (stated limit)" 0 ""

d="$(mk a3a-unchanged)"; put "$d" mods/x.js "const n = \"$a\";"; git -C "$d" "${gid[@]}" add -A; git -C "$d" "${gid[@]}" commit -qm frag
git -C "$d" branch -f main work; put "$d" mods/x.js "const n = \"$a\";"$'\n'"const m = \"$b\";"; commit "$d"
run "$d"; expect "one fragment unchanged, one added: not caught (stated limit)" 0 ""

export DROVER_PRIVATE_WORDS="a,b,$w1"
d="$(mk a3a-short)"; put "$d" mods/x.js "const n = \"a\" + \"b\";"; commit "$d"
run "$d"; expect "words under 4 characters are ignored" 0 ""

export DROVER_PRIVATE_WORDS="$w1"
d="$(mk clean)"; put "$d" src/app.js "export const add = (x, y) => x + y;"; put "$d" docs/a.md "Some prose."; commit "$d"
run "$d"; expect "clean diff passes" 0 ""; no_value "clean" "$w1"

d="$(mk empty)"; run "$d"; expect "empty diff (head = base) passes" 0 ""

# --- rule 2 and discovery: names come from discoverPrivateWords (this user, this host, hc machine ls --json), env is extra
unset DROVER_PRIVATE_WORDS
m1="$(rnd 'a-z' 9)"
stub_m="$(stubdir mach "echo \"\$@\" >> \"\$HC_LOG\"; printf '{\"machines\":[{\"name\":\"$m1\",\"host\":\"$m1\",\"logout_linger_user\":\"$m1\"}]}'")"
d="$(mk disc-machine)"; put "$d" mods/x.js "// ssh to $m1 first"; commit "$d"; : > "$HC_LOG"
runp "$stub_m:$PATH" "$d"; expect "a linked machine's name written whole is a hit (via hc machine ls --json)" 1 name mods/x.js; no_value "machine name" "$m1"
if [ "$(sort -u "$HC_LOG")" = "machine ls --json" ]; then ok "hc is called only as 'machine ls --json' (never --on)"; else bad "hc call shape" "$(cat "$HC_LOG")"; fi
d="$(mk disc-split)"; put "$d" mods/x.js "const n = \"${m1:0:4}\" + \"${m1:4}\";"; commit "$d"
runp "$stub_m:$PATH" "$d"; expect "a linked machine's name split in 2 literals is a hit" 1 name-split

d="$(mk disc-clean)"; put "$d" src/app.js "export const one = 1;"; commit "$d"
run "$d"; expect "complete discovery, clean diff: exit 0" 0 ""
grep -q "NOT CHECKED" "$work/out" && bad "complete discovery says NOT CHECKED" || ok "complete discovery says nothing is unchecked"

nohc="$work/nohc"; mkdir -p "$nohc"; ln -sf "$(command -v node)" "$nohc/node"
runp "$nohc:/usr/bin:/bin" "$d"; expect "hc missing: exit 2 (incomplete)" 2 ""
grep -q "machines: NOT CHECKED (hc not found)" "$work/out" && ok "hc missing: says what was not checked" || bad "hc missing: says what was not checked"
stub_f="$(stubdir fail 'exit 3')"; runp "$stub_f:$PATH" "$d"; expect "hc exits non-zero: exit 2" 2 ""
stub_j="$(stubdir json 'echo not-json')"; runp "$stub_j:$PATH" "$d"; expect "hc prints bad JSON: exit 2" 2 ""
stub_n="$(stubdir nolist "echo '{}'")"; runp "$stub_n:$PATH" "$d"; expect "hc prints no machines list: exit 2" 2 ""
d2="$(mk disc-hit-incomplete)"; export DROVER_PRIVATE_WORDS="$w1"; put "$d2" mods/x.js "const n = \"$w1\";"; commit "$d2"
runp "$stub_f:$PATH" "$d2"; expect "a hit still wins over incomplete discovery: exit 1" 1 name
grep -q "NOT CHECKED" "$work/out" && ok "a hit with incomplete discovery also lists what was not checked" || bad "hit + incomplete lists NOT CHECKED"
unset DROVER_PRIVATE_WORDS

# --- rule 4 generic-name (#89): test code must use the shared filtered words, never read the account or host name itself
ui="user""Info"; hn="host""name"
d="$(mk g-ui)"; put "$d" mods/x.test.js "const u = $ui().username;"; commit "$d"
run "$d"; expect "#89 userinfo() in a test" 1 generic-name mods/x.test.js
d="$(mk g-host)"; put "$d" mods/_test/x.js "const h = $hn().split('.')[0];"; commit "$d"
run "$d"; expect "a host-name read in a test helper" 1 generic-name
for v in USER LOGNAME HOSTNAME; do
  d="$(mk g-env-$v)"; put "$d" mods/x.test.js "const u = process.env.$v;"; commit "$d"
  run "$d"; expect "process.env.$v in a test" 1 generic-name
done
d="$(mk g-import)"; put "$d" mods/x.test.js 'import { runtimePrivateWords } from "./private-words.js";'$'\n'"const u = $ui().username; // imports the helper but still reads the name"; commit "$d"
run "$d"; expect "importing the helper does not excuse a hand-rolled userinfo() (#89)" 1 generic-name mods/x.test.js
d="$(mk g-ok)"; put "$d" mods/x.test.js 'import { runtimePrivateWords } from "./private-words.js";'$'\n''const words = runtimePrivateWords(); const e = process.env.USERPROFILE;'; commit "$d"
run "$d"; expect "a test using only runtimePrivateWords() passes" 0 ""
d="$(mk g-app)"; put "$d" src/app.js "const u = $ui().username;"; commit "$d"
run "$d"; expect "userinfo() in app code is not rule 4" 0 ""
d="$(mk g-home)"; put "$d" mods/_test/private-words.js "const u = $ui().username;"; commit "$d"
run "$d"; expect "mods/_test/private-words.js (the one home) is exempt" 0 ""

# self-check: the shared helper must never return a stoplist name as private (ci off). A helper that does is a gate failure.
broken="$work/broken-words.js"; sed 's/export const GENERIC_NAMES = new Set(\[[^]]*\])/export const GENERIC_NAMES = new Set([])/' "$here/../mods/_test/private-words.js" > "$broken"
cmp -s "$broken" "$here/../mods/_test/private-words.js" && bad "self-check fixture: the copy was not broken"
d="$(mk selfcheck)"; put "$d" src/app.js "export const one = 1;"; commit "$d"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_HELPER="$broken" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
[ "$rc" = 2 ] && grep -q "self-check" "$work/out" && ok "self-check: a helper that leaks stoplist names fails the gate" || bad "self-check" "rc=$rc"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_HELPER="$work/missing.js" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
[ "$rc" = 2 ] && ok "helper cannot be loaded: exit 2" || bad "helper cannot be loaded" "rc=$rc"
run "$d"; expect "self-check passes with the real helper" 0 ""

# --- allowlist: path<TAB>rule<TAB>sha256 of the trimmed line; only that exact line under that rule
sha() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
tab=$'\t'
export DROVER_PRIVATE_WORDS="$w1"
line1="  const owner = \"$w1\";  "; line2="const other = \"$(rnd 'A-Za-z0-9' 20)\"; // $pre_sk$tail24"
d="$(mk allow)"; put "$d" mods/x.test.js "$line1"; commit "$d"
allow="$work/allowlist.tsv"; printf '# a reason\n%s\t%s\t%s\n' mods/x.test.js name "$(sha "const owner = \"$w1\";")" > "$allow"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_ALLOW="$allow" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
expect "allowlist: the exact line under that rule is allowed" 0 ""
grep -q "allowed: 1" "$work/out" && ok "allowlist: says how many hits it allowed" || bad "allowlist: says how many it allowed"
printf '%s\n' "$line1" "$line2" > "$d/mods/x.test.js"; commit "$d"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_ALLOW="$allow" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
expect "allowlist: another secret in the same file still fails" 1 secret-fixture mods/x.test.js
printf '%s\n' "$line1" "const again = \"$w1\";" > "$d/mods/x.test.js"; commit "$d"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_ALLOW="$allow" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
expect "allowlist: another name in the same file still fails" 1 name mods/x.test.js; no_value "allowlist" "$w1" "$tail24"
printf '%s\t%s\t%s\n' mods/x.test.js secret-fixture "$(sha "const owner = \"$w1\";")" > "$allow"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_ALLOW="$allow" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
expect "allowlist: the same line under another rule is not allowed" 1 name
printf '%s\t%s\t%s\n' mods/other.js name "$(sha "const owner = \"$w1\";")" > "$allow"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_ALLOW="$allow" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
expect "allowlist: the same line in another path is not allowed" 1 name
printf 'mods/x.test.js\tname\n' > "$allow"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_ALLOW="$allow" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
expect "allowlist: a malformed entry (no hash) is exit 2" 2 ""
unset DROVER_PRIVATE_WORDS

# --- exit code 2: the gate could not look
d="$(mk badbase)"; (cd "$d" && bash "$gate" --base no-such-ref >"$work/out" 2>&1); rc=$?; expect "bad base -> exit 2" 2 ""
(cd "$d" && bash "$gate" --nope >"$work/out" 2>&1); rc=$?; expect "unknown argument -> exit 2" 2 ""
(cd "$d" && bash "$gate" --base >"$work/out" 2>&1); rc=$?; expect "--base without a value -> exit 2" 2 ""
mkdir "$work/notgit"; (cd "$work/notgit" && bash "$gate" >"$work/out" 2>&1); rc=$?; expect "not a git repo -> exit 2" 2 ""

# --- review round 1
# (1) a scanner that fails must not read as clean: exit 2
stub_awk="$(stubdir awk9 'exit 9')"; mv "$work/stub-awk9/hc" "$work/stub-awk9/awk"
d="$(mk scanfail)"; put "$d" mods/x.test.js "const k = \"$pre_sk$tail24\";"; commit "$d"
runp "$stub_awk:$stub_ok:$PATH" "$d"; expect "a failing scanner (awk exits 9) is exit 2, never clean" 2 ""
d="$(mk scanfail-clean)"; put "$d" src/app.js "export const one = 1;"; commit "$d"
runp "$stub_awk:$stub_ok:$PATH" "$d"; expect "a failing scanner on a clean diff is exit 2 too" 2 ""
grep -q "clean" "$work/out" && bad "failing scanner printed clean" || ok "failing scanner never prints clean"

# (2) UTF-8 file names are not git-quoted away: file-specific rules still apply
d="$(mk utf8name)"; put "$d" "mods/caf$(printf '\303\251').test.js" "const k = \"$pre_sk$tail24\";"; commit "$d"
run "$d"; expect "a secret in a UTF-8-named test file is a hit" 1 secret-fixture; no_value "utf8 name" "$tail24"

# (3) a cross-line name-split hit cannot be allowlisted by its last line; a single-line one can
export DROVER_PRIVATE_WORDS="$w1"
c="$(rnd 'a-z' 4)"; w2="$c$b"
d="$(mk allow-cross)"; put "$d" mods/x.js "const n = \"$a\" +"$'\n'"  \"$b\";"; commit "$d"
allow="$work/allowlist2.tsv"; printf 'mods/x.js\tname-split\t%s\n' "$(sha "\"$b\";")" > "$allow"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_ALLOW="$allow" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
expect "allowlist: a cross-line name-split hit is never allowed by its last line" 1 name-split mods/x.js
export DROVER_PRIVATE_WORDS="$w1,$w2"
put "$d" mods/x.js "const n = \"$c\" +"$'\n'"  \"$b\";"; commit "$d"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_ALLOW="$allow" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
expect "allowlist: changing the preceding fragment (last line unchanged) still fails" 1 name-split mods/x.js
export DROVER_PRIVATE_WORDS="$w1"
d="$(mk allow-single)"; put "$d" mods/x.js "const n = \"zz${w1}zz\";"; commit "$d"
printf 'mods/x.js\tname-split\t%s\n' "$(sha "const n = \"zz${w1}zz\";")" > "$allow"
(cd "$d" && PATH="$stub_ok:$PATH" GATE_ALLOW="$allow" bash "$gate" --base main) >"$work/out" 2>&1; rc=$?
expect "allowlist: a single-line name-split hit can be allowed by its exact line" 0 ""
unset DROVER_PRIVATE_WORDS

# (4) a helper-supported raw word with few letters once punctuation is dropped is still checked whole
l1="$(rnd 'a-z' 1)"; l2="$(rnd 'a-z' 2)"
export DROVER_PRIVATE_WORDS="$l1-$l2"
d="$(mk raw4)"; put "$d" mods/x.js "const n = \"$l1-$l2\";"; commit "$d"
run "$d"; expect "a punctuated raw 4-char word (3 letters) written whole is a hit" 1 name; no_value "raw4" "$l1-$l2"
export DROVER_PRIVATE_WORDS="$l1-$l1-$l1"
d="$(mk raw5)"; put "$d" mods/x.js "const n = \"$l1-$l1-$l1\";"; commit "$d"
run "$d"; expect "a punctuated raw 5-char word (3 letters) written whole is a hit" 1 name
unset DROVER_PRIVATE_WORDS

# --- --all is an inventory report of the whole tree at HEAD (same scanner, synthetic diff against the empty tree): counts per rule and
#     per file, never a value or a line number. It exits 1 when the tree has hits; the gate proper is the branch diff.
export DROVER_PRIVATE_WORDS="$w1"
d="$(mk all-hit)"; git -C "$d" checkout -q main; put "$d" mods/old.test.js "const k = \"$pre_sk$tail24\";"; put "$d" mods/n.js "const q = \"$a\" + \"$b\";"
put "$d" mods/m.js "const q = \"$w1\"; const r = \"$w1\";"; commit "$d"
git -C "$d" checkout -q -b work2
run "$d" --all; expect "--all with hits in the tree exits 1" 1 ""
grep -Eq '^ +secret-fixture +1$' "$work/out" && grep -Eq '^ +name-split +1$' "$work/out" && grep -Eq '^ +name +1$' "$work/out" && ok "--all prints a count per rule" || bad "--all prints a count per rule"
grep -Eq '^ +1 +mods/old.test.js +secret-fixture$' "$work/out" && grep -Eq '^ +1 +mods/n.js +name-split$' "$work/out" && ok "--all prints a count per file and rule" || bad "--all prints a count per file and rule"
grep -Eq ':[0-9]+  ' "$work/out" && bad "--all prints no per-line hits" || ok "--all prints no per-line hits"
no_value "--all report" "$tail24" "$w1" "$a" "$b"
run "$d"; expect "diff mode passes on a branch with no new hits, though the tree has some" 0 ""
d="$(mk all-clean)"; run "$d" --all; expect "--all on a clean tree exits 0" 0 ""

# --- shared leak rules: public-sync.sh runs the same awk file, not a copy
grep -q 'leak-rules.awk' "$here/public-sync.sh" && ok "public-sync.sh uses scripts/leak-rules.awk" || bad "public-sync.sh uses scripts/leak-rules.awk"
if grep -q -- "-f .*leak-rules.awk" "$here/public-sync.sh" && ! grep -q 'github.*_pat_' "$here/public-sync.sh"; then ok "public-sync.sh holds no copy of the rules"; else bad "public-sync.sh holds no copy of the rules"; fi

bash -n "$gate" && ok "bash -n" || bad "bash -n"
echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]
