// Part 2 of 8 of the install.sh tests (split from install.test.js by measured weight; the shared fixture is install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, chmodSync, mkdirSync, readdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { git, BIN, made, fixture, install, NOTE, run, noHasherPath, runIn, rd, mp, KEPT, keptLines, owner, installed, backups, upstream, find, blDir } from "./install-fixture.js";

test("a changed shared file is copied into every mod that holds it", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0);
  const name = "store.js"; // listed in _lib/copies.txt
  appendFileSync(join(repo, "mods", "_lib", name), "\n// changed\n");
  assert.equal(install(repo, home).status, 0);
  for (const m of ["drover-tasks", "drover-config"]) assert.match(readFileSync(join(repo, "mods", m, name), "utf8"), /\/\/ changed\n$/);
});

test("from a linked worktree the install is refused and changes nothing", () => {
  const { root, repo, home } = fixture();
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  const r = install(wt, home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /linked git worktree/);
  assert.deepEqual(readdirSync(join(home, "mods")), [], "a link was made");
});

test("an unknown argument is refused", () => {
  const { repo, home } = fixture();
  const r = install(repo, home, "--nope");
  assert.equal(r.status, 2);
  assert.deepEqual(readdirSync(join(home, "mods")), []);
});

test("with only cksum on PATH (no sha256sum, no shasum) a tracked update (canonical and copies already equal) still prints the note", () => {
  const { repo, home } = fixture();
  const path = `${BIN}:${noHasherPath(true)}`;
  const skip = { DROVER_SKIP_MODS: "drover-jira drover-github" };
  assert.equal(runIn(repo, home, path, skip).status, 0); // the baseline is hashed with cksum too, so only the content can differ
  for (const m of readdirSync(join(repo, "mods")).filter((n) => n.startsWith("drover-") || n === "_lib")) {
    const f = join(repo, "mods", m, "store.js");
    if (existsSync(f)) appendFileSync(f, "\n// pulled\n");
  }
  const r = runIn(repo, home, path, skip);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, NOTE);
  assert.doesNotMatch(runIn(repo, home, path, skip).stdout, NOTE);
});

test("B6-4 a mixed run keeps only the edited file; the clean and the missing ones are updated; exit 1", () => {
  const { repo, home } = installed();
  appendFileSync(mp(repo, "drover-tasks", "store.js"), owner);
  appendFileSync(mp(repo, "_lib", "io.js"), "\n// upstream io\n");
  unlinkSync(mp(repo, "drover-board", "keys.js"));
  const r = run(repo, home);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.deepEqual(keptLines(r).length, 1, r.stdout);
  for (const m of readdirSync(mp(repo)).filter((n) => n.startsWith("drover-"))) assert.equal(rd(mp(repo, m, "io.js")), rd(mp(repo, "_lib", "io.js")), `${m}/io.js`);
  assert.equal(rd(mp(repo, "drover-board", "keys.js")), rd(mp(repo, "_lib", "keys.js")));
});

test("B6-13d move failure: when the old file cannot be moved into .install-backups it stays beside the new one, is reported, exit 1", () => {
  const { repo, home } = installed(); upstream(repo);
  const old = rd(mp(repo, "drover-tasks", "store.js"));
  writeFileSync(mp(repo, ".install-backups"), "in the way\n");
  const r = run(repo, home);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /could not be moved/);
  const left = find(repo, /^\.drover-aside\..*store\.js$/);
  assert.equal(left.length >= 1, true, "no retained file");
  assert.ok(left.some((n) => rd(mp(repo, "drover-tasks", n)) === old));
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), rd(mp(repo, "_lib", "store.js")));
});

test("B6-F2 an unreadable or directory HEAD record fails closed: the owner's restored committed bytes are kept, a failed record write is reported", () => {
  const pick = () => { const f = installed(); const A = rd(mp(f.repo, "drover-tasks", "store.js")); return { ...f, A }; };
  const a = pick(); // chmod 000 on the record
  appendFileSync(mp(a.repo, "_lib", "store.js"), "\n// B\n");
  assert.equal(run(a.repo, a.home).status, 0);
  const head = join(blDir(a.repo, a.home), "drover-tasks", "store.js.head");
  assert.ok(existsSync(head));
  chmodSync(head, 0o000);
  writeFileSync(mp(a.repo, "drover-tasks", "store.js"), a.A);
  appendFileSync(mp(a.repo, "_lib", "store.js"), "\n// C\n");
  const ra = run(a.repo, a.home);
  chmodSync(head, 0o644);
  assert.equal(ra.status, 1, ra.stdout + ra.stderr);
  assert.match(ra.stdout, /KEPT drover-tasks\/store\.js/);
  assert.equal(rd(mp(a.repo, "drover-tasks", "store.js")), a.A);
  const b = pick(); // a folder where the record belongs
  const hb = join(blDir(b.repo, b.home), "drover-tasks", "store.js.head");
  rmSync(hb); mkdirSync(hb);
  appendFileSync(mp(b.repo, "_lib", "store.js"), "\n// B\n");
  const r1 = run(b.repo, b.home);
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /drover-tasks\/store\.js \(the old baseline record cannot be invalidated/); // the record cannot be put out of charge: the file is not changed
  assert.equal(rd(mp(b.repo, "drover-tasks", "store.js")), b.A);
  writeFileSync(mp(b.repo, "drover-tasks", "store.js"), b.A);
  appendFileSync(mp(b.repo, "_lib", "store.js"), "\n// C\n");
  const r2 = run(b.repo, b.home);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /KEPT drover-tasks\/store\.js/);
  assert.equal(rd(mp(b.repo, "drover-tasks", "store.js")), b.A);
});

test("B6-T3b once the file is settled an equal .new is moved to this run's .install-backups, a different one is reported and stays, a symlink is untouched", () => {
  const a = installed(); const orig = rd(mp(a.repo, "drover-tasks", "store.js"));
  appendFileSync(mp(a.repo, "drover-tasks", "store.js"), owner);
  assert.equal(run(a.repo, a.home).status, 1);
  writeFileSync(mp(a.repo, "drover-tasks", "store.js"), orig); // settled again, .new still equals the incoming copy
  const ra = run(a.repo, a.home);
  assert.equal(ra.status, 0, ra.stdout + ra.stderr);
  assert.equal(existsSync(mp(a.repo, "drover-tasks", "store.js.new")), false);
  const moved = backups(a.repo).map((d) => join(d, "drover-tasks", "store.js.new")).filter(existsSync);
  assert.equal(moved.length, 1); assert.equal(rd(moved[0]), orig);
  const b = installed(); // the source moved on: the old .new is not equal to the incoming copy
  appendFileSync(mp(b.repo, "drover-tasks", "store.js"), owner); assert.equal(run(b.repo, b.home).status, 1);
  writeFileSync(mp(b.repo, "drover-tasks", "store.js"), rd(mp(b.repo, "_lib", "store.js")));
  appendFileSync(mp(b.repo, "_lib", "store.js"), "\n// moved on\n"); appendFileSync(mp(b.repo, "drover-tasks", "store.js"), "\n// moved on\n");
  const rb = run(b.repo, b.home);
  assert.equal(rb.status, 1, rb.stdout + rb.stderr); assert.ok(existsSync(mp(b.repo, "drover-tasks", "store.js.new")));
  assert.match(rb.stdout, /KEPT .*store\.js\.new: older than the incoming copy, or yours/);
});
