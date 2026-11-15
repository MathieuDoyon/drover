#!/usr/bin/env bash
# Tests for deploy/omarchy: install.sh (offline, fixtures only; the REAL mods/install.sh runs
# against a copy of the mods tree with herdr-app stubbed) and the systemd unit.
# Run: deploy/omarchy/test.sh   (exit 0 = all passed; SKIP lines are NOT passes)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
install_sh="$here/install.sh"
unit="$here/drover-herdr.service"
work="$(mktemp -d)"
# Non-interactive cleanup of the mktemp dir only: the real mods tests leave read-only fixtures,
# which make a plain 'rm -r' prompt on a TTY. Make them owner-writable first, then remove with -f.
cleanup() { [ -n "${work:-}" ] && [ -d "$work" ] && { chmod -R u+w "$work"; rm -rf -- "$work"; }; return 0; }
trap cleanup EXIT
pass=0; fail=0; skip=0
ok()   { pass=$((pass+1)); echo "PASS $1"; }
last_out=""   # the output file of the step under test; printed in full when a check fails
bad()  { fail=$((fail+1)); echo "FAIL $1${2:+: $2}"; [ -n "$last_out" ] && [ -f "$last_out" ] && { echo "  --- full output of the step ($last_out) ---"; sed 's/^/  | /' "$last_out"; echo "  --- end ---"; }; }
skp()  { skip=$((skip+1)); echo "SKIP $1${2:+: $2}"; }
sha()  { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# content checksum of every file/symlink under a dir (detects any write into it)
snap() { (cd "$1" && find . \( -type f -o -type l \) | sort | while IFS= read -r f; do echo "$f $(cksum < "$f" 2>/dev/null)"; done | cksum); }

# --- fixtures: a fake release tarball, manifests, a stub repo copy, a REAL-mods repo copy ---
fx="$work/fx"; mkdir -p "$fx/pkg/herdr-app" "$fx/repo/mods" "$fx/repo/deploy/omarchy" "$fx/bin"
cat > "$fx/pkg/herdr-app/herdr-app" <<'EOS'
#!/bin/sh
case "$1" in
  --version) echo "herdr-app 0.1.15" ;;
  status) exit 1 ;;   # the app is not running during install
  *) exit 0 ;;        # check, do, ...
esac
EOS
chmod +x "$fx/pkg/herdr-app/herdr-app"
tar -czf "$fx/app.tar.gz" -C "$fx/pkg" herdr-app
good="$(sha "$fx/app.tar.gz")"
mk_manifest() { # <file> <version> <sha>
  printf '{"version":"%s","targets":{"linux-x86_64":{"url":"file://%s","sha256":"%s"}}}\n' "$2" "$fx/app.tar.gz" "$3" > "$1"
}
mk_manifest "$fx/good.json" 0.1.15 "$good"
mk_manifest "$fx/badsha.json" 0.1.15 "0000000000000000000000000000000000000000000000000000000000000000"
mk_manifest "$fx/newer.json" 0.1.16 "$good"
# stub mods/install.sh: records its cwd/env and links one "mod" into the home
cat > "$fx/repo/mods/install.sh" <<'EOS'
#!/usr/bin/env bash
echo "home=$HERDR_APP_HOME cwd=$PWD skip=${DROVER_SKIP_MODS:-} tests=${DROVER_SKIP_TESTS:-}" > "$HERDR_APP_HOME/stub-mods-install.log"
mkdir -p "$HERDR_APP_HOME/mods"; ln -sfn "$PWD" "$HERDR_APP_HOME/mods/drover-stub"
EOS
chmod +x "$fx/repo/mods/install.sh"
cp "$unit" "$fx/repo/deploy/omarchy/"
# real mods tree + unit, for the tests that must not hide the real installer's writes
mkdir -p "$fx/real/deploy/omarchy"; cp -R "$repo_root/mods" "$fx/real/mods"; cp "$unit" "$fx/real/deploy/omarchy/"
# stub systemctl: records calls
cat > "$fx/bin/systemctl" <<'EOS'
#!/bin/sh
echo "$*" >> "$STUB_SYSTEMCTL_LOG"
EOS
chmod +x "$fx/bin/systemctl"

# run_install <name> <manifest> [args...] -> sets $H (fake HOME), $T (TMPDIR), $out, $rc
run_install() {
  local name="$1" manifest="$2"; shift 2
  H="$work/$name/home"; T="$work/$name/tmp"; mkdir -p "$H" "$T"
  out="$work/$name/out"; last_out="$out"
  HOME="$H" TMPDIR="$T" PATH="$fx/bin:$PATH" STUB_SYSTEMCTL_LOG="$work/$name/systemctl.log" \
    DROVER_RELEASES_URL="file://$manifest" DROVER_TARGET=linux-x86_64 \
    bash "$install_sh" "$@" >"$out" 2>&1
  rc=$?
}
empty_dir() { [ -z "$(find "$1" -mindepth 1 2>/dev/null)" ]; }
# every file/symlink under $1 (HOME) is a printed 'WRITE <path>' or below one
all_writes_printed() { # <home> <out>
  local f p seen stray=0
  while IFS= read -r f; do
    p="$f"; seen=0
    while [ "$p" != "$1" ] && [ "$p" != "/" ]; do grep -q "^WRITE $p\( \|\$\)" "$2" && { seen=1; break; }; p="$(dirname "$p")"; done
    [ "$seen" = 1 ] || { stray=1; echo "  not printed: $f"; }
  done < <(find "$1" -mindepth 1 \( -type f -o -type l \) 2>/dev/null)
  [ "$stray" = 0 ]
}
# the persistent roots: nothing may exist in HOME outside them
only_approved_roots() { # <home>
  local extra
  extra="$(cd "$1" && find . -mindepth 1 -not -path './.local' -not -path './.local/share' -not -path './.local/bin' \
    -not -path './.local/bin/herdr-app' -not -path './.local/share/herdr-app' -not -path './.local/share/herdr-app/*' \
    -not -path './.config' -not -path './.config/herdr-app' -not -path './.config/herdr-app/*' \
    -not -path './.config/systemd' -not -path './.config/systemd/user' -not -path './.config/systemd/user/drover-herdr.service')"
  [ -z "$extra" ] || { echo "  outside the approved roots: $extra"; return 1; }
}
unit_has() { # <section> <exact line>
  awk -v s="[$1]" -v l="$2" '/^\[/{cur=$0} cur==s && $0==l {f=1} END{exit !f}' "$unit"
}

# 1. sha256 mismatch aborts and writes nothing (not even a temp file)
run_install t1 "$fx/badsha.json" "$fx/repo"
if [ "$rc" -ne 0 ] && grep -qi 'sha256' "$out" && empty_dir "$H" && empty_dir "$T"; then ok "sha mismatch aborts, nothing written"
else bad "sha mismatch aborts, nothing written" "rc=$rc"; fi

# 2. version other than the pinned one aborts, nothing written
run_install t2 "$fx/newer.json" "$fx/repo"
if [ "$rc" -ne 0 ] && grep -qi 'version' "$out" && empty_dir "$H" && empty_dir "$T"; then ok "unexpected version aborts, nothing written"
else bad "unexpected version aborts, nothing written" "rc=$rc"; fi

# 3. --dry-run prints the paths and touches nothing
run_install t3 "$fx/good.json" --dry-run "$fx/repo"
if [ "$rc" -eq 0 ] && grep -q "WRITE $H/.local/share/herdr-app/releases/0.1.15" "$out" && grep -q "WRITE $H/.local/share/herdr-app/src" "$out" \
   && grep -q "WRITE $H/.local/bin/herdr-app" "$out" && grep -q "WRITE $H/.config/herdr-app" "$out" && empty_dir "$H" && empty_dir "$T"; then ok "dry-run lists paths, writes nothing"
else bad "dry-run lists paths, writes nothing" "rc=$rc"; fi

# 4. stub-mods install: release staged under share/releases/<ver> + current, repo copied to share/src,
#    mods installer runs FROM src, no unit, repo checkout untouched, nothing outside the roots
before="$(snap "$fx/repo")"
run_install t4 "$fx/good.json" "$fx/repo"
S="$H/.local/share/herdr-app"
if [ "$rc" -eq 0 ] && [ -x "$S/releases/0.1.15/herdr-app" ] && [ "$(readlink "$S/current")" = "$S/releases/0.1.15" ] \
   && [ -L "$H/.local/bin/herdr-app" ] && [ "$("$H/.local/bin/herdr-app" --version)" = "herdr-app 0.1.15" ] \
   && grep -q "home=$H/.config/herdr-app cwd=$S/src/mods .* tests=1" "$H/.config/herdr-app/stub-mods-install.log" \
   && grep -q '^node tests skipped on the remote (dev-time gate; each mod is still checked with herdr-app check)$' "$out" \
   && [ ! -e "$H/.config/systemd" ] && [ ! -e "$H/.config/herdr-app/service.env" ] && empty_dir "$T" \
   && [ ! -e "$S.new" ] && [ ! -e "$S.old" ]; then ok "install: releases/<ver> + current, src copy, mods installer runs from src, tmp clean"
else bad "install: releases/<ver> + current, src copy, mods installer runs from src, tmp clean" "rc=$rc"; fi
all_writes_printed "$H" "$out" && ok "every path written is printed as 'WRITE <path>'" || bad "every path written is printed as 'WRITE <path>'"
only_approved_roots "$H" && ok "nothing written outside the approved roots" || bad "nothing written outside the approved roots"
[ "$before" = "$(snap "$fx/repo")" ] && ok "the repo checkout is not modified" || bad "the repo checkout is not modified"

# 4b. second install over the first (update): same layout, no leftovers, still works
HOME="$H" TMPDIR="$T" DROVER_RELEASES_URL="file://$fx/good.json" DROVER_TARGET=linux-x86_64 bash "$install_sh" "$fx/repo" >"$work/t4/out2" 2>&1; rc2=$?
if [ "$rc2" -eq 0 ] && [ "$(readlink "$S/current")" = "$S/releases/0.1.15" ] && [ "$(find "$S/releases" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ] \
   && [ ! -e "$S/src.new" ] && [ ! -e "$S/src.old" ] && empty_dir "$T"; then ok "re-install (update) leaves one release, no .new/.old"
else last_out="$work/t4/out2"; bad "re-install (update) leaves one release, no .new/.old" "rc=$rc2"; fi

# 5. HC_SESSION -> service.env (mode 600, only that line)
mkdir -p "$work/t5/home" "$work/t5/tmp"; last_out="$work/t5/out"
HOME="$work/t5/home" TMPDIR="$work/t5/tmp" HC_SESSION=drover-omarchy DROVER_RELEASES_URL="file://$fx/good.json" DROVER_TARGET=linux-x86_64 \
  bash "$install_sh" "$fx/repo" >"$work/t5/out" 2>&1
envf="$work/t5/home/.config/herdr-app/service.env"
if [ -f "$envf" ] && [ "$(cat "$envf")" = "HC_SESSION=drover-omarchy" ] && [ "$(stat -c %a "$envf" 2>/dev/null || stat -f %Lp "$envf")" = 600 ] \
   && grep -q "^WRITE $envf" "$work/t5/out"; then ok "HC_SESSION written to service.env (600), printed"
else bad "HC_SESSION written to service.env (600), printed"; fi

# 6. --with-service copies the unit and enables it (stub systemctl)
run_install t6 "$fx/good.json" --with-service "$fx/repo"
if [ "$rc" -eq 0 ] && [ -f "$H/.config/systemd/user/drover-herdr.service" ] && grep -q "^WRITE $H/.config/systemd/user/drover-herdr.service" "$out" \
   && grep -q -- '--user daemon-reload' "$work/t6/systemctl.log" && grep -q -- '--user enable --now drover-herdr.service' "$work/t6/systemctl.log" \
   && only_approved_roots "$H"; then ok "--with-service installs and enables the unit"
else bad "--with-service installs and enables the unit" "rc=$rc"; fi

# 7. unit content, checked per section (StartLimitIntervalSec is only valid in [Unit])
u_ok=1
for want in 'Restart=always' 'RestartSec=5' 'UnsetEnvironment=WAYLAND_DISPLAY DISPLAY XDG_SESSION_TYPE' \
  'Environment=HERDR_APP_HOME=%h/.config/herdr-app' 'EnvironmentFile=-%h/.config/herdr-app/service.env' 'ExecStart=%h/.local/bin/herdr-app'; do
  unit_has Service "$want" || { u_ok=0; echo "  [Service] lacks: $want"; }
done
unit_has Unit 'StartLimitIntervalSec=0' || { u_ok=0; echo "  [Unit] lacks: StartLimitIntervalSec=0"; }
unit_has Service 'StartLimitIntervalSec=0' && { u_ok=0; echo "  StartLimitIntervalSec=0 must not be in [Service]"; }
unit_has Install 'WantedBy=default.target' || { u_ok=0; echo "  [Install] lacks WantedBy=default.target"; }
grep -E '^Environment=PATH=.*%h/\.local/bin' "$unit" >/dev/null || { u_ok=0; echo "  PATH lacks %h/.local/bin"; }
[ "$u_ok" = 1 ] && ok "unit: restart, start limit in [Unit], PATH, HERDR_APP_HOME, unset display vars" || bad "unit content"
if command -v systemd-analyze >/dev/null; then
  v="$(systemd-analyze --user verify "$unit" 2>&1 | grep -viE 'not executable|No such file|Failed to (open|load).*herdr-app')"
  [ -z "$v" ] && ok "systemd-analyze verify" || bad "systemd-analyze verify" "$v"
else skp "systemd-analyze verify" "systemd-analyze not installed here; run on omarchy"; fi

# 8. REAL mods/install.sh through the deploy installer: Jira/GitHub never installed, writes stay in the roots
before="$(snap "$fx/real")"
run_install t8 "$fx/good.json" "$fx/real"
M="$H/.config/herdr-app/mods"; S="$H/.local/share/herdr-app"
if [ "$rc" -eq 0 ] && [ -L "$M/drover-tasks" ] && [ -L "$M/drover-wakeups" ] && [ ! -e "$M/drover-jira" ] && [ ! -e "$M/drover-github" ] \
   && [ -f "$S/src/mods/drover-config/query.js" ] && [ -f "$S/src/mods/drover-tasks/store.js" ] && [ -L "$H/.config/herdr-app/layouts/drover.json" ]; then ok "real mods installer: Jira/GitHub absent, query.js copied, layout linked"
else bad "real mods installer: Jira/GitHub absent, query.js copied, layout linked" "rc=$rc"; fi
[ "$before" = "$(snap "$fx/real")" ] && ok "real mods installer: the repo checkout is not modified" || bad "real mods installer: the repo checkout is not modified"
all_writes_printed "$H" "$out" && only_approved_roots "$H" && ok "real mods installer: every write printed, inside the approved roots" || bad "real mods installer: every write printed, inside the approved roots"

# 9. mods/install.sh on its own (a copy of the real tree, herdr-app stubbed). DROVER_SKIP_TESTS=1 keeps the fixtures
#    independent of the wall-clock node tests; the default must still run (and be stopped by) that stage.
mkdir -p "$work/t9/home/mods" "$work/t9/home/layouts" "$work/t9/bin"
cp -R "$repo_root/mods" "$work/t9/mods"; cp "$fx/pkg/herdr-app/herdr-app" "$work/t9/bin/"
mods_install() { # <outfile> [env...]: run the copy's install.sh
  local o="$1"; shift; last_out="$o"
  ( cd "$work/t9/mods" && env PATH="$work/t9/bin:$PATH" HERDR_APP_HOME="$work/t9/home" "$@" ./install.sh >"$o" 2>&1 )
}
if mods_install "$work/t9/out" DROVER_SKIP_TESTS=1 \
   && [ -L "$work/t9/home/mods/drover-jira" ] && [ -L "$work/t9/home/mods/drover-github" ] && [ -L "$work/t9/home/mods/drover-tasks" ]; then ok "mods/install.sh default installs every mod (unchanged)"
else bad "mods/install.sh default installs every mod (unchanged)"; fi
if mods_install "$work/t9/out2" DROVER_SKIP_TESTS=1 DROVER_SKIP_MODS='drover-jira drover-github' \
   && [ ! -e "$work/t9/home/mods/drover-jira" ] && [ ! -e "$work/t9/home/mods/drover-github" ] && [ -L "$work/t9/home/mods/drover-tasks" ]; then ok "DROVER_SKIP_MODS skips the listed mods"
else bad "DROVER_SKIP_MODS skips the listed mods"; fi
# the test stage: a failing test stops the installer by default, and DROVER_SKIP_TESTS=1 bypasses exactly that stage
printf 'import test from "node:test";\ntest("boom", () => { throw new Error("boom"); });\n' > "$work/t9/mods/_lib/store.test.js"
rm -f "$work/t9/home/mods/drover-tasks"
if ! mods_install "$work/t9/out3" && [ ! -e "$work/t9/home/mods/drover-tasks" ] \
   && grep -q 'node tests FAILED' "$work/t9/out3" && grep -q 'boom' "$work/t9/out3"; then ok "mods/install.sh default runs the node test stage; a failing test stops it and is shown"
else last_out="$work/t9/out3"; bad "mods/install.sh default still runs the node test stage"; fi
if mods_install "$work/t9/out4" DROVER_SKIP_TESTS=1 && [ -L "$work/t9/home/mods/drover-tasks" ]; then ok "DROVER_SKIP_TESTS=1 skips the node test stage"
else bad "DROVER_SKIP_TESTS=1 skips the node test stage"; fi

# 10. static checks
bash -n "$install_sh" && bash -n "$here/test.sh" && bash -n "$repo_root/mods/install.sh" && ok "bash -n" || bad "bash -n"
if command -v shellcheck >/dev/null; then shellcheck -x "$install_sh" "$here/test.sh" && ok shellcheck || bad shellcheck
else skp shellcheck "not installed here"; fi

echo "passed=$pass failed=$fail skipped=$skip"
[ "$fail" -eq 0 ]
