// Part 5 of 8 of the install.sh tests (split from install.test.js by measured weight; the shared fixture is install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sh, BIN, made, fixture, install, NOTE, run, rd, mp, KEPT, keptLines, commitAll, owner, installed, backups, hookScript, upstream, find, realTool, shimDir, withShim } from "./install-fixture.js";

test("a failing check still prints the note, and the next run prints it again", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0);
  appendFileSync(join(repo, "mods", "_lib", "store.js"), "\n// changed\n");
  const bad = run(repo, home, { FAKE_CHECK_FAIL: "1" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, NOTE);
  assert.match(install(repo, home).stdout, NOTE, "the stamp advanced after a failed run");
});

test("B6-7 an install made by the old installer (no baseline) after a pull: untouched copies are replaced, exit 0, no .new", () => {
  const { repo, home } = installed();
  rmSync(join(home, ".drover-baseline"), { recursive: true, force: true });
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// committed upstream\n");
  for (const m of readdirSync(mp(repo)).filter((n) => n.startsWith("drover-"))) appendFileSync(mp(repo, m, "store.js"), "\n// committed upstream\n");
  commitAll(repo);
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// dev edit\n"); // uncommitted: the copies now equal HEAD but not the source
  const r = run(repo, home);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(keptLines(r).length, 0);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), rd(mp(repo, "_lib", "store.js")));
  assert.equal(existsSync(mp(repo, "drover-tasks", "store.js.new")), false);
});

test("B6-8 stale baselines after a pull plus one source edit: no mass KEPT, the edit is replaced", () => {
  const { repo, home } = installed();
  for (const f of ["store.js", "io.js", "keys.js"]) {
    appendFileSync(mp(repo, "_lib", f), "\n// pulled\n");
    for (const m of readdirSync(mp(repo)).filter((n) => n.startsWith("drover-"))) appendFileSync(mp(repo, m, f), "\n// pulled\n");
  }
  commitAll(repo);
  appendFileSync(mp(repo, "_lib", "io.js"), "\n// dev edit\n");
  const r = run(repo, home);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(keptLines(r).length, 0, r.stdout);
  assert.equal(rd(mp(repo, "drover-tasks", "io.js")), rd(mp(repo, "_lib", "io.js")));
  assert.deepEqual(readdirSync(mp(repo, "drover-tasks")).filter((n) => n.endsWith(".new")), []);
});

test("B6-13 race: an in-place owner edit after the capture, after the classification, or after the publish is never lost", () => {
  for (const [phase, where] of [["captured", "kept"], ["classified", "owner"], ["published", "new-file"]]) {
    const { root, repo, home } = installed(); upstream(repo);
    const hook = hookScript(root, `[ "$1" = ${phase} ] && printf 'RACE-${phase}\\n' >> "$2"; exit 0`);
    const r = run(repo, home, { DROVER_INSTALL_TEST_HOOK: hook });
    const all = [mp(repo, "drover-tasks", "store.js"), ...find(repo, /store\.js\.owner-/).map((n) => mp(repo, "drover-tasks", n)), ...(backups(repo).map((d) => join(d, "drover-tasks", "store.js")))].filter(existsSync);
    assert.ok(all.some((p) => rd(p).includes(`RACE-${phase}`)), `${phase}: the edit is gone\n${r.stdout}`);
    if (where !== "new-file") assert.equal(r.status, 1, `${phase}: ${r.stdout}`);
    if (where === "kept") assert.match(rd(mp(repo, "drover-tasks", "store.js")), /RACE-captured/);
    if (where === "owner") { assert.match(r.stdout, /KEPT-OWNER drover-tasks\/store\.js/); assert.equal(find(repo, /store\.js\.owner-/).length, 1); }
  }
});

test("B6-14 the stamp is untouched by KEPT runs (tests skipped and enabled) and by a failed test run, and the reopen note repeats", () => {
  const { root, repo, home } = installed();
  const stamp = join(home, ".drover-lib-stamp"), s0 = rd(stamp);
  appendFileSync(mp(repo, "_lib", "keys.js"), "\n// upstream\n");
  appendFileSync(mp(repo, "drover-tasks", "io.js"), owner);
  for (let i = 0; i < 2; i++) { const r = run(repo, home); assert.equal(r.status, 1); assert.match(r.stdout, NOTE); assert.equal(rd(stamp), s0); }
  const fake = (code) => { const d = join(root, `fakenode${code}`); mkdirSync(d); writeFileSync(join(d, "node"), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 }); return d; };
  const on = (code) => sh(mp(repo), "bash", ["install.sh"], { HERDR_APP_HOME: home, PATH: `${fake(code)}:${BIN}:${process.env.PATH}` });
  const ok = on(0); assert.equal(ok.status, 1, ok.stdout + ok.stderr); assert.match(ok.stdout, /KEPT drover-tasks\/io\.js/); assert.equal(rd(stamp), s0);
  const bad = on(1); assert.equal(bad.status, 1); assert.match(bad.stdout, /KEPT drover-tasks\/io\.js/); assert.equal(rd(stamp), s0);
});

test("B6-T5 one installer per home: a held home lock refuses the run (exit 2, nothing written) and a good run releases both locks", () => {
  const { repo, home } = fixture();
  mkdirSync(join(home, ".drover-install.lock"));
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// upstream\n");
  const r = run(repo, home);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /another install is using this Herdr home/);
  assert.deepEqual(readdirSync(join(home, "mods")), []);
  assert.equal(existsSync(mp(repo, ".install.lock")), false, "the checkout lock stayed after a refused run");
  rmSync(join(home, ".drover-install.lock"), { recursive: true });
  assert.equal(run(repo, home).status, 0);
  assert.equal(existsSync(join(home, ".drover-install.lock")), false);
  assert.equal(existsSync(mp(repo, ".install.lock")), false);
});

test("B6-T6 when the owner's in-flight edit cannot be moved to .owner-<stamp> the run says where it stays", () => {
  const { root, repo, home } = installed(); upstream(repo);
  const hook = hookScript(root, `[ "$1" = classified ] && printf 'RACE\\n' >> "$2"; exit 0`);
  const shim = shimDir(root, "mv", `case "\${@: -1}" in *store.js.owner-*) exit 1;; esac; exec ${realTool("mv")} "$@"`);
  const r = withShim(repo, home, shim, { DROVER_INSTALL_TEST_HOOK: hook });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /KEPT-OWNER drover-tasks\/store\.js: your edit made during the update stays at .*\.drover-aside\./);
  const left = find(repo, /^\.drover-aside\..*store\.js$/);
  assert.ok(left.some((n) => rd(mp(repo, "drover-tasks", n)).includes("RACE")));
});
