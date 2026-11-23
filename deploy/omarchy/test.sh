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
echo "home=$HERDR_APP_HOME cwd=$PWD skip=${DROVER_SKIP_MODS:-}" > "$HERDR_APP_HOME/stub-mods-install.log"
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
   && grep -q "home=$H/.config/herdr-app cwd=$S/src/mods skip=drover-jira drover-github$" "$H/.config/herdr-app/stub-mods-install.log" \
   && ! grep -q 'node tests' "$out" \
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

# 9. mods/install.sh on its own (a copy of the real tree, herdr-app stubbed). The installer runs no node tests.
mkdir -p "$work/t9/home/mods" "$work/t9/home/layouts" "$work/t9/bin"
cp -R "$repo_root/mods" "$work/t9/mods"; cp "$fx/pkg/herdr-app/herdr-app" "$work/t9/bin/"
mods_install() { # <outfile> [env...]: run the copy's install.sh
  local o="$1"; shift; last_out="$o"
  ( cd "$work/t9/mods" && env PATH="$work/t9/bin:$PATH" HERDR_APP_HOME="$work/t9/home" "$@" ./install.sh >"$o" 2>&1 )
}
if mods_install "$work/t9/out" \
   && [ -L "$work/t9/home/mods/drover-jira" ] && [ -L "$work/t9/home/mods/drover-github" ] && [ -L "$work/t9/home/mods/drover-tasks" ]; then ok "mods/install.sh default installs every mod (unchanged)"
else bad "mods/install.sh default installs every mod (unchanged)"; fi
if mods_install "$work/t9/out2" DROVER_SKIP_MODS='drover-jira drover-github' \
   && [ ! -e "$work/t9/home/mods/drover-jira" ] && [ ! -e "$work/t9/home/mods/drover-github" ] && [ -L "$work/t9/home/mods/drover-tasks" ]; then ok "DROVER_SKIP_MODS skips the listed mods"
else bad "DROVER_SKIP_MODS skips the listed mods"; fi
# no test stage: a failing test file in the tree does not stop the installer, and nothing runs it
printf 'import test from "node:test";\ntest("boom", () => { throw new Error("boom"); });\n' > "$work/t9/mods/_lib/store.test.js"
rm -f "$work/t9/home/mods/drover-tasks"
if mods_install "$work/t9/out3" && [ -L "$work/t9/home/mods/drover-tasks" ] && ! grep -q 'node tests' "$work/t9/out3"; then ok "mods/install.sh runs no node tests (a failing test file does not stop it)"
else last_out="$work/t9/out3"; bad "mods/install.sh runs no node tests"; fi

# 11. bootstrap-agents.sh: PATH + HERDR_APP_HOME for agents (fake HOME; nothing is touched outside it)
boot_sh="$here/bootstrap-agents.sh"
bs_dir=".local/share/herdr-app/src/mods/drover-tasks/bin"
run_boot() { # <name> <zsh yes|no> [args...] -> $H, $out, $rc; the HOME is pre-seeded by the caller via $seed
  local name="$1" z="$2"; shift 2
  H="$work/$name/home"; mkdir -p "$H"; out="$work/$name/out"; last_out="$out"
  [ -n "${seed:-}" ] && "$seed" "$H"
  HOME="$H" DROVER_BOOTSTRAP_ZSH="$z" bash "$boot_sh" "$@" >"$out" 2>&1; rc=$?
}
seed_bash() { printf '# my bashrc\nalias ll="ls -l"' > "$1/.bashrc"; printf 'export FOO=1\n' > "$1/.profile"; printf '# my zshrc\n' > "$1/.zshrc"; }
seed=seed_bash
# 11a. --dry-run: prints the plan and the lines, writes nothing
run_boot b1 yes --dry-run
if [ "$rc" -eq 0 ] && grep -q '>>> drover-herdr agents PATH >>>' "$out" && grep -q "$H/.bashrc" "$out" && grep -q "$H/.zshenv" "$out" \
   && [ "$(cat "$H/.bashrc")" = "$(printf '# my bashrc\nalias ll="ls -l"')" ] && [ ! -e "$H/.zshenv" ] && [ ! -e "$H/.config" ] && ! ls "$H"/*drover-bak* "$H"/.*drover-bak* >/dev/null 2>&1; then ok "bootstrap --dry-run lists rc files + exact lines, writes nothing"
else bad "bootstrap --dry-run lists rc files + exact lines, writes nothing" "rc=$rc"; fi
# 11b. real run: block in zshrc, zshenv, bashrc, profile; backups of the pre-existing ones; agents dir 700 and empty
run_boot b2 yes
baks="$(ls -A "$H" | grep -c 'drover-bak\.')"
agents="$H/.config/drover-herdr/agents"
if [ "$rc" -eq 0 ] && for f in .zshrc .zshenv .bashrc .profile; do grep -q '^# >>> drover-herdr agents PATH >>>$' "$H/$f" && grep -q '^# <<< drover-herdr agents PATH <<<$' "$H/$f" || exit 1; done \
   && [ "$(grep -c '>>> drover-herdr' "$H/.bashrc")" = 1 ] && ls "$H"/.bashrc.drover-bak.* "$H"/.zshrc.drover-bak.* "$H"/.profile.drover-bak.* >/dev/null 2>&1 \
   && [ ! -e "$H/.zshenv.drover-bak."* ] 2>/dev/null && [ "$baks" = 3 ] \
   && [ -d "$agents" ] && [ "$(stat -c %a "$agents" 2>/dev/null || stat -f %Lp "$agents")" = 700 ] && empty_dir "$agents"; then ok "bootstrap: marked block in zshrc/zshenv/bashrc/profile, one backup per edited existing rc, agents dir 700 and empty"
else bad "bootstrap: marked block in zshrc/zshenv/bashrc/profile, one backup per edited existing rc, agents dir 700 and empty" "rc=$rc baks=$baks"; fi
bk="$(ls "$H"/.bashrc.drover-bak.* | head -1)"
[ "$(cat "$bk")" = "$(printf '# my bashrc\nalias ll="ls -l"')" ] && [ "$(head -n 2 "$H/.bashrc")" = "$(printf '# my bashrc\nalias ll="ls -l"')" ] \
  && ok "bootstrap: backup is the exact original; the user's lines stay on top" || bad "bootstrap: backup is the exact original; the user's lines stay on top"
grep -q "^ADD $H/.bashrc" "$out" && grep -q 'export HERDR_APP_HOME=' "$out" && ok "bootstrap prints the exact lines added" || bad "bootstrap prints the exact lines added"
# 11c. second run: nothing added, no new backups, files byte-identical
sum1="$(cd "$H" && cat .bashrc .zshrc .zshenv .profile | cksum)"
HOME="$H" DROVER_BOOTSTRAP_ZSH=yes bash "$boot_sh" >"$work/b2/out2" 2>&1; rc2=$?
sum2="$(cd "$H" && cat .bashrc .zshrc .zshenv .profile | cksum)"
if [ "$rc2" -eq 0 ] && [ "$sum1" = "$sum2" ] && [ "$(ls -A "$H" | grep -c 'drover-bak\.')" = 3 ] && grep -qi 'nothing to add' "$work/b2/out2" && ! grep -q '^ADD ' "$work/b2/out2"; then ok "bootstrap is idempotent: 2nd run adds nothing, no new backup, says so"
else last_out="$work/b2/out2"; bad "bootstrap is idempotent: 2nd run adds nothing, no new backup, says so" "rc=$rc2"; fi
# 11d. only the expected files exist in HOME
extra="$(cd "$H" && find . -mindepth 1 -not -path './.bashrc*' -not -path './.zshrc*' -not -path './.zshenv*' -not -path './.profile*' -not -path './.config' -not -path './.config/drover-herdr' -not -path './.config/drover-herdr/agents' -not -path './.local' -not -path './.local/bin' -not -path './.local/bin/drover' -not -path './.local/share' -not -path './.local/share/*')"
[ -z "$extra" ] && ok "bootstrap touches nothing else in HOME" || bad "bootstrap touches nothing else in HOME" "$extra"
# 11e. the block works in the shells that read it: PATH gets both dirs once, HERDR_APP_HOME default, an existing one is kept
chk='printf "%s|%s\n" "$PATH" "$HERDR_APP_HOME"'
r1="$(env -i HOME="$H" PATH=/usr/bin:/bin bash -c ". $H/.bashrc; . $H/.bashrc; $chk")"
case "$r1" in "$H/$bs_dir:$H/.local/bin:/usr/bin:/bin|$H/.config/herdr-app" | "$H/.local/bin:$H/$bs_dir:/usr/bin:/bin|$H/.config/herdr-app") ok "bootstrap block (bash, sourced twice): both dirs once, HERDR_APP_HOME default" ;; *) bad "bootstrap block (bash)" "got: $r1" ;; esac
r2="$(env -i HOME="$H" PATH=/usr/bin:/bin HERDR_APP_HOME=/x/y sh -c ". $H/.profile; $chk")"
case "$r2" in *"|/x/y") ok "bootstrap block (sh): an existing HERDR_APP_HOME is kept" ;; *) bad "bootstrap block (sh): an existing HERDR_APP_HOME is kept" "got: $r2" ;; esac
if command -v zsh >/dev/null; then
  r3="$(env -i HOME="$H" PATH=/usr/bin:/bin zsh -c "$chk")"   # non-interactive, non-login: only .zshenv is read
  case "$r3" in *"$H/$bs_dir"*"$H/.local/bin"*"|$H/.config/herdr-app"|*"$H/.local/bin"*"$H/$bs_dir"*"|$H/.config/herdr-app") ok "bootstrap block reaches a non-interactive zsh (.zshenv)" ;; *) bad "bootstrap block reaches a non-interactive zsh (.zshenv)" "got: $r3" ;; esac
else skp "non-interactive zsh check" "zsh not installed here"; fi
# 11f. .bash_profile present: bash login reads it, not .profile, so .profile is left alone (and a note says why)
seed_bp() { printf '# bp\n' > "$1/.bash_profile"; printf 'export FOO=1\n' > "$1/.profile"; printf '# rc\n' > "$1/.bashrc"; }
seed=seed_bp; run_boot b3 no
if [ "$rc" -eq 0 ] && [ "$(cat "$H/.profile")" = "export FOO=1" ] && ! grep -q drover-herdr "$H/.bash_profile" && grep -q '>>> drover-herdr' "$H/.bashrc" \
   && [ ! -e "$H/.zshrc" ] && [ ! -e "$H/.zshenv" ] && grep -q '\.bash_profile' "$out"; then ok "bootstrap: .bash_profile present -> .profile untouched; no zsh -> no zsh files; reason printed"
else bad "bootstrap: .bash_profile present -> .profile untouched; no zsh -> no zsh files; reason printed" "rc=$rc"; fi
# 11g. fresh HOME with no rc files at all: created (no backup, nothing to back up), still idempotent
seed=""; run_boot b4 yes
if [ "$rc" -eq 0 ] && grep -q '>>> drover-herdr' "$H/.bashrc" && grep -q '>>> drover-herdr' "$H/.zshenv" && ! ls -A "$H" | grep -q 'drover-bak\.'; then ok "bootstrap: no rc yet -> created, no backup"
else bad "bootstrap: no rc yet -> created, no backup" "rc=$rc"; fi
# 11i. symlink refusal (Inspector High): rc symlink out, .config symlink out, ancestor symlink -> REFUSE, exit!=0, NOTHING changed
refuse_case() { # <name> <desc> <seed fn>
  local name="$1" desc="$2"; seed="$3"
  H="$work/$name/home"; mkdir -p "$H" "$work/$name/outside"; "$seed" "$H" "$work/$name/outside"
  out="$work/$name/out"; last_out="$out"
  HOME="$H" DROVER_BOOTSTRAP_ZSH=yes bash "$boot_sh" >"$out" 2>&1; rc=$?
  [ "$rc" -ne 0 ] && grep -q '^REFUSE ' "$out" && ! grep -q '^\(ADD\|WRITE\) ' "$out" && ok "bootstrap refuses: $desc, exits non-zero, no ADD/WRITE" || bad "bootstrap refuses: $desc" "rc=$rc"
}
sd_rc() { ln -s "$2/bashrc" "$1/.bashrc"; printf '# orig\n' > "$2/bashrc"; }
sd_cfg() { ln -s "$2" "$1/.config"; }
sd_anc() { mkdir -p "$1/.config"; ln -s "$2" "$1/.config/drover-herdr"; }
sd_inhome() { mkdir -p "$1/real"; printf '# orig\n' > "$1/real/rc"; ln -s "$1/real/rc" "$1/.zshrc"; }
refuse_case c1 "rc symlinked outside HOME" sd_rc
[ "$(cat "$work/c1/outside/bashrc")" = "# orig" ] && ok "outside rc target unchanged" || bad "outside rc target unchanged"
refuse_case c2 ".config symlinked outside HOME" sd_cfg
empty_dir "$work/c2/outside" && ok "nothing created outside HOME via .config" || bad "nothing created outside HOME via .config"
refuse_case c3 "~/.config/drover-herdr (ancestor of agents) symlinked" sd_anc
empty_dir "$work/c3/outside" && ok "nothing created outside HOME via ancestor" || bad "nothing created outside HOME via ancestor"
refuse_case c4 "rc symlink even inside HOME" sd_inhome
[ "$(cat "$work/c4/home/real/rc")" = "# orig" ] && ! ls -A "$work/c4/home" | grep -q 'drover-bak' && [ ! -e "$work/c4/home/.bashrc" ] && [ ! -e "$work/c4/home/.config" ] \
  && ok "refusal changed nothing: no other rc written, no backup, no agents dir" || bad "refusal changed nothing (all-or-nothing preflight)"
# --dry-run refuses too
HOME="$work/c1/home" DROVER_BOOTSTRAP_ZSH=yes bash "$boot_sh" --dry-run >"$work/c1/o2" 2>&1; [ $? -ne 0 ] && grep -q '^REFUSE ' "$work/c1/o2" && ok "--dry-run also refuses" || bad "--dry-run also refuses"

# 11j. partial/damaged block (Inspector Medium): opening marker without the exact full block -> non-zero, file named, unmodified
seed=""; H="$work/p1/home"; mkdir -p "$H"; printf '# >>> drover-herdr agents PATH >>>\n' > "$H/.bashrc"; cp "$H/.bashrc" "$work/p1/orig"
out="$work/p1/out"; last_out="$out"; HOME="$H" DROVER_BOOTSTRAP_ZSH=no bash "$boot_sh" >"$out" 2>&1; rc=$?
if [ "$rc" -ne 0 ] && grep -q "$H/.bashrc" "$out" && grep -qi 'partial' "$out" && cmp -s "$H/.bashrc" "$work/p1/orig" && ! ls -A "$H" | grep -q 'drover-bak' && [ ! -e "$H/.config" ]; then ok "bootstrap: opening marker alone -> non-zero, file named, nothing modified"
else bad "bootstrap: opening marker alone -> non-zero, file named, nothing modified" "rc=$rc"; fi
# a block with an altered body, and a full block plus a stray second opening marker, are also refused
H="$work/p2/home"; mkdir -p "$H"; printf '# >>> drover-herdr agents PATH >>>\nexport PATH=/evil\n# <<< drover-herdr agents PATH <<<\n' > "$H/.bashrc"
out="$work/p2/out"; last_out="$out"; HOME="$H" DROVER_BOOTSTRAP_ZSH=no bash "$boot_sh" >"$out" 2>&1; rc=$?
[ "$rc" -ne 0 ] && grep -qi 'partial' "$out" && ok "bootstrap: markers around a different body -> refused" || bad "bootstrap: markers around a different body -> refused" "rc=$rc"
H="$work/p3/home"; mkdir -p "$H"; run_p() { HOME="$H" DROVER_BOOTSTRAP_ZSH=no bash "$boot_sh" >"$work/p3/$1" 2>&1; }
run_p o1; printf '# >>> drover-herdr agents PATH >>>\n' >> "$H/.bashrc"; cp "$H/.bashrc" "$work/p3/orig"; last_out="$work/p3/o2"; run_p o2; rc=$?
[ "$rc" -ne 0 ] && cmp -s "$H/.bashrc" "$work/p3/orig" && ok "bootstrap: a good block plus a stray opening marker -> refused, unmodified" || bad "bootstrap: a good block plus a stray opening marker -> refused, unmodified" "rc=$rc"
grep -q 'interactive-return guard' "$work/b2/out" && ok "bootstrap prints the .bashrc interactive-guard hint" || bad "bootstrap prints the .bashrc interactive-guard hint"

# 11k. drover symlink (~/.local/bin/drover -> the CLI): 'hc exec' runs sh -c, reads no rc, but ~/.local/bin is already on its PATH
link_t() { echo "$1/.local/share/herdr-app/src/mods/drover-tasks/bin/drover"; }
seed=""; run_boot l1 no
if [ "$rc" -eq 0 ] && [ -L "$H/.local/bin/drover" ] && [ "$(readlink "$H/.local/bin/drover")" = "$(link_t "$H")" ] && grep -q "^LINK $H/.local/bin/drover -> $(link_t "$H")" "$out"; then ok "bootstrap: creates ~/.local/bin/drover symlink, prints LINK"
else bad "bootstrap: creates ~/.local/bin/drover symlink, prints LINK" "rc=$rc"; fi
HOME="$H" DROVER_BOOTSTRAP_ZSH=no bash "$boot_sh" >"$work/l1/out2" 2>&1; rc2=$?
if [ "$rc2" -eq 0 ] && ! grep -q '^LINK ' "$work/l1/out2" && grep -qi 'drover link.*nothing to add\|already the right' "$work/l1/out2" && [ "$(readlink "$H/.local/bin/drover")" = "$(link_t "$H")" ]; then ok "bootstrap: right symlink already there -> nothing to add, no LINK"
else last_out="$work/l1/out2"; bad "bootstrap: right symlink already there -> nothing to add, no LINK" "rc=$rc2"; fi
seed_reg() { mkdir -p "$1/.local/bin"; printf 'mine\n' > "$1/.local/bin/drover"; }
seed_oth() { mkdir -p "$1/.local/bin"; ln -s /usr/bin/true "$1/.local/bin/drover"; }
for kind in reg oth; do
  seed="seed_$kind"; run_boot l2$kind no
  if [ "$rc" -ne 0 ] && grep -q "^REFUSE $H/.local/bin/drover" "$out" && ! grep -q '^\(ADD\|WRITE\|LINK\) ' "$out" && [ ! -e "$H/.bashrc" ] && [ ! -e "$H/.config" ] \
     && { if [ "$kind" = reg ]; then [ "$(cat "$H/.local/bin/drover")" = mine ]; else [ "$(readlink "$H/.local/bin/drover")" = /usr/bin/true ]; fi; }; then ok "bootstrap: $kind file/symlink at ~/.local/bin/drover -> REFUSE, nothing changed"
  else bad "bootstrap: $kind file/symlink at ~/.local/bin/drover -> REFUSE, nothing changed" "rc=$rc"; fi
done
seed=seed_reg; H="$work/l3/home"; mkdir -p "$H"; seed_reg "$H"; HOME="$H" DROVER_BOOTSTRAP_ZSH=no bash "$boot_sh" --dry-run >"$work/l3/o" 2>&1
[ $? -ne 0 ] && grep -q '^REFUSE ' "$work/l3/o" && ok "bootstrap --dry-run refuses a blocking drover file too" || bad "bootstrap --dry-run refuses a blocking drover file too"
seed=""; run_boot l4 no --dry-run
[ "$rc" -eq 0 ] && grep -q "$H/.local/bin/drover" "$out" && [ ! -e "$H/.local" ] && ok "bootstrap --dry-run lists the link, creates nothing" || bad "bootstrap --dry-run lists the link, creates nothing" "rc=$rc"
seed=""; H="$work/l5/home"; mkdir -p "$H" "$work/l5/outside"; ln -s "$work/l5/outside" "$H/.local"; out="$work/l5/out"; last_out="$out"
HOME="$H" DROVER_BOOTSTRAP_ZSH=no bash "$boot_sh" >"$out" 2>&1; rc=$?
[ "$rc" -ne 0 ] && grep -q '^REFUSE ' "$out" && empty_dir "$work/l5/outside" && ok "bootstrap: ~/.local symlinked out -> REFUSE, nothing created" || bad "bootstrap: ~/.local symlinked out -> REFUSE, nothing created" "rc=$rc"

# 11h. read-only/unknown option and the secret rule
bash "$boot_sh" --nope >"$work/b4/o" 2>&1; [ $? -eq 2 ] && ok "bootstrap rejects unknown options" || bad "bootstrap rejects unknown options"
if grep -v '^[[:space:]]*#' "$boot_sh" | grep -Eq '(^|[^a-z])sudo |/etc/'; then bad "bootstrap: no sudo, no /etc"; else ok "bootstrap: no sudo, no /etc"; fi

# 10. static checks
bash -n "$install_sh" && bash -n "$boot_sh" && bash -n "$here/test.sh" && bash -n "$repo_root/mods/install.sh" && ok "bash -n" || bad "bash -n"
if command -v shellcheck >/dev/null; then shellcheck -x "$install_sh" "$boot_sh" "$here/test.sh" && ok shellcheck || bad shellcheck
else skp shellcheck "not installed here"; fi

echo "passed=$pass failed=$fail skipped=$skip"
[ "$fail" -eq 0 ]
