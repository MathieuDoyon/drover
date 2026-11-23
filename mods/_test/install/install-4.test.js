// Part 4 of 8 of the install.sh tests (split from install.test.js by measured weight; the shared fixture is install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, unlinkSync, renameSync, mkdirSync, lstatSync, readlinkSync, writeFileSync, appendFileSync, utimesSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { git, BIN, made, fixture, install, NOTE, mainJs, run, noHasherPath, CANNOT, runIn, rd, mp, KEPT, owner, installed, spawnTimed, backups, hookScript, upstream } from "./install-fixture.js";

test("a fresh home and an unchanged re-install print no reopen note", () => {
  const { repo, home } = fixture();
  const first = install(repo, home);
  assert.equal(first.status, 0);
  assert.doesNotMatch(first.stdout, NOTE);
  assert.doesNotMatch(install(repo, home).stdout, NOTE);
});

test("a changed _lib file prints the note and touches no main.js", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0);
  const old = new Date(Date.now() - 3600_000);
  for (const m of Object.keys(mainJs(repo))) utimesSync(join(repo, "mods", m, "main.js"), old, old);
  const before = mainJs(repo);
  appendFileSync(join(repo, "mods", "_lib", "store.js"), "\n// changed\n");
  const r = install(repo, home);
  assert.match(r.stdout, NOTE);
  assert.deepEqual(mainJs(repo), before, "a main.js was rewritten");
  assert.doesNotMatch(install(repo, home).stdout, NOTE, "the note repeats after a good run");
});

test("a query.js-only change prints the note", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0);
  appendFileSync(join(repo, "mods", "drover-github", "query.js"), "\n// changed\n");
  assert.match(install(repo, home).stdout, NOTE);
});

test("with no hasher on PATH: a real shared change says it cannot verify; an equal-byte run is silent; never a failed install", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0); // a good baseline, with a hasher
  const path = `${BIN}:${noHasherPath()}`;
  appendFileSync(join(repo, "mods", "_lib", "store.js"), "\n// changed\n");
  const changed = runIn(repo, home, path);
  assert.equal(changed.status, 0, changed.stderr + changed.stdout);
  assert.match(changed.stdout, CANNOT);
  assert.doesNotMatch(changed.stdout, NOTE);
  const same = runIn(repo, home, path);
  assert.equal(same.status, 0, same.stderr + same.stdout);
  assert.doesNotMatch(same.stdout, CANNOT, "a false alarm on an equal-byte run");
});

test("B6-10 links: an owner repoint is kept (mod and layout), a skip run keeps an owner link and removes an install link, --from-worktree repoints a recorded link", () => {
  const { root, repo, home } = installed();
  const wt = join(root, "wt"); git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  symlinkSync(join(wt, "mods", "drover-tasks"), join(home, "mods", "tmp-l")); renameSync(join(home, "mods", "tmp-l"), join(home, "mods", "drover-tasks"));
  const lay = join(home, "layouts", "drover.json"); unlinkSync(lay); symlinkSync(join(wt, "mods", "_layouts", "drover.json"), lay);
  const r = run(repo, home);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(readlinkSync(join(home, "mods", "drover-tasks")), join(wt, "mods", "drover-tasks"));
  assert.equal(readlinkSync(lay), join(wt, "mods", "_layouts", "drover.json"));
  assert.equal(r.stdout.split("\n").filter((l) => /^KEPT link/.test(l)).length, 2, r.stdout);
  const s = installed(); // skip: an install-made link goes, an owner-repointed link stays
  const jira = join(s.home, "mods", "drover-jira"), github = join(s.home, "mods", "drover-github");
  unlinkSync(github); symlinkSync(s.root, github);
  const rs = run(s.repo, s.home, { DROVER_SKIP_MODS: "drover-jira drover-github" });
  assert.equal(existsSync(jira) || lstatSync(jira, { throwIfNoEntry: false }) !== undefined, false, "an install-made link was kept");
  assert.equal(readlinkSync(github), s.root);
  assert.equal(rs.status, 1, rs.stdout + rs.stderr); assert.match(rs.stdout, /KEPT link .*drover-github/);
  const w = installed(); const wt2 = join(w.root, "wt"); git(w.repo, "worktree", "add", "-q", "-b", "feat", wt2);
  const rw = install(wt2, w.home, "--from-worktree");
  assert.equal(rw.status, 0, rw.stdout + rw.stderr);
  assert.equal(readlinkSync(join(w.home, "mods", "drover-tasks")), join(wt2, "mods", "drover-tasks"));
});

test("B6-11 sidecars: an occupied differing .new and a symlink .new are never written", () => {
  const a = installed();
  appendFileSync(mp(a.repo, "drover-tasks", "store.js"), owner);
  writeFileSync(mp(a.repo, "drover-tasks", "store.js.new"), "owner notes\n");
  const ra = run(a.repo, a.home);
  assert.equal(ra.status, 1); assert.match(ra.stdout, /store\.js\.new/);
  assert.equal(rd(mp(a.repo, "drover-tasks", "store.js.new")), "owner notes\n");
  const b = installed(); const target = join(b.root, "elsewhere"); writeFileSync(target, "keep\n");
  appendFileSync(mp(b.repo, "drover-tasks", "store.js"), owner);
  symlinkSync(target, mp(b.repo, "drover-tasks", "store.js.new"));
  const rb = run(b.repo, b.home);
  assert.equal(rb.status, 1); assert.equal(rd(target), "keep\n"); assert.ok(lstatSync(mp(b.repo, "drover-tasks", "store.js.new")).isSymbolicLink());
});

test("B6-13c race: a held open handle that writes after the final classification lands in the retained old file", () => {
  const { root, repo, home } = installed(); upstream(repo);
  const old = rd(mp(repo, "drover-tasks", "store.js"));
  const fifo = join(root, "fifo"); mkdirSync(fifo);
  for (const n of ["ready", "go", "done"]) assert.equal(spawnSync("mkfifo", [join(fifo, n)]).status, 0);
  const hook = hookScript(root, `F="${fifo}"
case "$1" in
  captured) ( exec 9>>"$2"; echo up > "$F/ready"; read -r _ < "$F/go"; echo LATE-WRITE >&9; echo ok > "$F/done" ) & read -r _ < "$F/ready" ;;
  retained) echo go > "$F/go"; read -r _ < "$F/done" ;;
esac`);
  const r = spawnTimed(repo, home, { DROVER_INSTALL_TEST_HOOK: hook });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const kept = rd(join(backups(repo)[0], "drover-tasks", "store.js"));
  assert.equal(kept, old + "LATE-WRITE\n");
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), rd(mp(repo, "_lib", "store.js")));
});
