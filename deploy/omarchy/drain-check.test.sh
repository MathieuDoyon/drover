#!/usr/bin/env bash
# Tests for deploy/omarchy/drain-check.sh: every case runs on a disposable temp inbox. No network, no omarchy.
# Run: deploy/omarchy/drain-check.test.sh   (exit 0 = all passed)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
check="$here/drain-check.sh"
work="$(mktemp -d)"
cleanup() { [ -n "${work:-}" ] && [ -d "$work" ] && { chmod -R u+rwx "$work"; rm -rf -- "$work"; }; return 0; }
trap cleanup EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS $1"; }
bad() { fail=$((fail+1)); echo "FAIL $1${2:+: $2}"; }
fresh() { d="$work/$1"; rm -rf "$d"; mkdir -p "$d"; }
# expect <name> <0|1> <inbox>: exit 0 = pass, non-zero = fail; always one reason line on stdout
expect() {
  local out rc
  out="$(bash "$check" "$3" 2>&1)"; rc=$?
  if { [ "$2" -eq 0 ] && [ "$rc" -eq 0 ]; } || { [ "$2" -ne 0 ] && [ "$rc" -ne 0 ]; }; then
    [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" -eq 1 ] && ok "$1" || bad "$1" "not a one-line reason: $out"
  else bad "$1" "rc=$rc out=$out"; fi
}

fresh empty;           expect "empty inbox passes" 0 "$d"
fresh cli;             echo '{"op":"move","id":"T-1","column":"doing"}' > "$d/1700000000-4242.json"; echo 'ok: x' > "$d/1700000000-4242.result"
                       expect "only unprotected CLI files pass" 0 "$d"
fresh tmp;             : > "$d/.1700000000-Lx-000000000001.tmp"
                       expect "a .tmp staging file (in-flight delivery) fails" 1 "$d"
fresh ifrev;           echo '{"op":"move","id":"T-1","column":"doing","ifRev":3}' > "$d/1700000000-Lx-000000000002.json"
                       expect "a json with ifRev fails" 1 "$d"
fresh ttl;             echo '{"op":"add","title":"x","ttlMs":120000}' > "$d/1700000000-Lx-000000000003.json"
                       expect "a json with ttlMs fails" 1 "$d"
expect "a missing inbox fails" 1 "$work/does-not-exist"
fresh unreadable;      echo '{"op":"move","ifRev":1}' > "$d/a.json"; chmod 000 "$d"
if [ "$(id -u)" -eq 0 ]; then echo "SKIP unreadable dir (running as root)"; else expect "an unreadable inbox fails" 1 "$d"; fi
chmod 755 "$d"
fresh file;            : > "$work/notadir"; expect "a path that is a file fails" 1 "$work/notadir"
fresh unreadable_json; echo '{"op":"move"}' > "$d/a.json"; chmod 000 "$d/a.json"
if [ "$(id -u)" -eq 0 ]; then echo "SKIP unreadable json (root)"; else expect "an unreadable json fails (grep status 2)" 1 "$d"; fi
chmod 644 "$d/a.json"
fresh dotjson;         echo '{"ifRev":1}' > "$d/.hidden.json"; expect "a dot-named json with ifRev also fails" 1 "$d"
fresh result_only;    echo 'error: stale: ifRev ttlMs' > "$d/1-Lx-000000000004.result"; expect "a .result that mentions ifRev is not a request" 0 "$d"
bash -n "$check" && ok "bash -n" || bad "bash -n"

echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
