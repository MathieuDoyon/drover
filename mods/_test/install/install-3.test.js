// Part 3 of 8 of the install.sh tests (split from install.test.js by measured weight; the shared fixture is install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, unlinkSync, readdirSync, lstatSync, readlinkSync, writeFileSync, appendFileSync, utimesSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { sh, git, BIN, fixture, install, mtimes, NOTE, mainJs, run, rd, mp, KEPT, keptLines, ageAll, owner, installed, hookScript, upstream, blDir, withShim, plant, mvFault } from "./install-fixture.js";

test("--from-worktree installs from a linked worktree on purpose", () => {
  const { root, repo, home } = fixture();
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  const r = install(wt, home, "--from-worktree");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readlinkSync(join(home, "mods", "drover-tasks")), join(wt, "mods", "drover-tasks"));
});

test("a tracked update (canonical and copies already equal, as after git pull) still prints the note", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0);
  for (const m of readdirSync(join(repo, "mods")).filter((n) => n.startsWith("drover-") || n === "_lib")) {
    const f = join(repo, "mods", m, "store.js");
    if (existsSync(f)) appendFileSync(f, "\n// pulled\n");
  }
  const old = new Date(Date.now() - 3600_000);
  for (const m of Object.keys(mainJs(repo))) utimesSync(join(repo, "mods", m, "main.js"), old, old);
  const before = mainJs(repo);
  const r = install(repo, home);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, NOTE);
  assert.deepEqual(mainJs(repo), before, "a main.js was rewritten");
});

test("B6-5 idempotent: a second run after a replace writes nothing; after a KEPT run it prints the same, leaves .new alone, exits 1 again", () => {
  const a = installed();
  appendFileSync(mp(a.repo, "_lib", "store.js"), "\n// upstream\n");
  assert.equal(run(a.repo, a.home).status, 0);
  ageAll(a.repo); const before = mtimes(mp(a.repo));
  const again = run(a.repo, a.home);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.deepEqual(mtimes(mp(a.repo)), before);
  assert.deepEqual(readdirSync(mp(a.repo, "drover-tasks")).filter((n) => /\.(new|drover-)/.test(n)), []);
  const b = installed();
  appendFileSync(mp(b.repo, "drover-tasks", "store.js"), owner);
  const one = run(b.repo, b.home);
  assert.equal(one.status, 1);
  ageAll(b.repo); const nw = mp(b.repo, "drover-tasks", "store.js.new");
  utimesSync(nw, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  const m0 = { ...mtimes(mp(b.repo)), n: lstatSync(nw).mtimeMs }, c0 = rd(nw);
  const two = run(b.repo, b.home);
  assert.equal(two.status, 1);
  assert.equal(keptLines(two).join("\n"), keptLines(one).join("\n"));
  assert.deepEqual({ ...mtimes(mp(b.repo)), n: lstatSync(nw).mtimeMs }, m0);
  assert.equal(rd(nw), c0);
});

test("B6-F1 the baseline is the published snapshot, not the canonical file as it is later: B published, canonical changed to C mid-run, then owner C and canonical D is kept", () => {
  const { root, repo, home } = installed();
  const A = rd(mp(repo, "_lib", "store.js"));
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// B\n");
  const hook = hookScript(root, `[ "$1" = captured ] && printf '%s\\n// C\\n' "$(cat ${JSON.stringify(join(root, "A.js"))})" > _lib/store.js; exit 0`);
  writeFileSync(join(root, "A.js"), A.replace(/\n$/, "")); // $(cat) drops the trailing newline; printf adds one back
  const r = run(repo, home, { DROVER_INSTALL_TEST_HOOK: hook });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const B = A + "\n// B\n", C = rd(mp(repo, "_lib", "store.js"));
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), B);
  assert.equal(rd(join(blDir(repo, home), "drover-tasks", "store.js")), B, "the baseline holds bytes that were never published");
  writeFileSync(mp(repo, "drover-tasks", "store.js"), C); // the owner edit happens to equal the later canonical C
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// D\n");
  const r2 = run(repo, home);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /KEPT drover-tasks\/store\.js/);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), C);
});

test("B6-F3 a staging name planted as a symlink is never opened: the external file is unchanged and the file is kept", () => {
  const { root, repo, home } = installed();
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// upstream\n");
  const ext = join(root, "owner-file.txt"); writeFileSync(ext, "owner bytes\n");
  const before = rd(mp(repo, "drover-tasks", "store.js"));
  // same pid as the installer: the wrapper plants the predictable names, then becomes install.sh
  const plant = `for n in store.js; do ln -s ${JSON.stringify(ext)} drover-tasks/.drover-tmp.$$.$n; ln -s ${JSON.stringify(ext)} drover-tasks/.drover-aside.$$.$n; done; exec bash install.sh`;
  const r = spawnSync("sh", ["-c", plant], { cwd: mp(repo), encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, PATH: `${BIN}:${process.env.PATH}` } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(rd(ext), "owner bytes\n");
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), before);
  assert.ok(!lstatSync(mp(repo, "drover-tasks", "store.js")).isSymbolicLink());
  assert.match(r.stdout, /KEPT drover-tasks\/store\.js/);
});

test("B6-F6 an edited or symlinked sidecar is reported even after the main file is settled: exit 1, no stamp, the sidecar untouched", () => {
  for (const mode of ["edited", "symlink"]) {
    const { root, repo, home } = installed();
    const orig = rd(mp(repo, "drover-tasks", "store.js")), stamp = join(home, ".drover-lib-stamp"), s0 = rd(stamp);
    appendFileSync(mp(repo, "drover-tasks", "store.js"), owner);
    assert.equal(run(repo, home).status, 1);
    const nw = mp(repo, "drover-tasks", "store.js.new"), ext = join(root, "ext"); writeFileSync(ext, "ext\n");
    if (mode === "edited") writeFileSync(nw, "OWNER-NOTES\n"); else { unlinkSync(nw); symlinkSync(ext, nw); }
    writeFileSync(mp(repo, "drover-tasks", "store.js"), orig); // the main conflict is gone
    appendFileSync(mp(repo, "_lib", "keys.js"), "\n// upstream\n"); // so a stamp would change
    const r = run(repo, home);
    assert.equal(r.status, 1, `${mode}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /KEPT drover-tasks\/store\.js\.new/);
    assert.equal(rd(stamp), s0, `${mode}: the stamp moved`);
    if (mode === "edited") assert.equal(rd(nw), "OWNER-NOTES\n"); else { assert.ok(lstatSync(nw).isSymbolicLink()); assert.equal(rd(ext), "ext\n"); }
  }
});

test("B6-H3 a link is not repointed or removed when its record cannot be put out of charge first", () => {
  const { root, repo, home } = installed();
  const wt = join(root, "wt"); git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  const link = join(home, "mods", "drover-tasks"), before = readlinkSync(link);
  const shim = mvFault(root, "*/.drover-baseline/links");
  const r = spawnSync("bash", ["install.sh", "--from-worktree"], { cwd: join(wt, "mods"), encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, PATH: `${shim}:${BIN}:${process.env.PATH}` } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(readlinkSync(link), before, "the link moved without a record");
  const s = withShim(repo, home, shim, { DROVER_SKIP_MODS: "drover-jira" });
  assert.equal(s.status, 1, s.stdout + s.stderr);
  assert.ok(lstatSync(join(home, "mods", "drover-jira"), { throwIfNoEntry: false }), "the link was removed without a record");
});
