// Part 7 of 8 of the install.sh tests (split from install.test.js by measured weight; the shared fixture is install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, mkdirSync, readdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, install, NOTE, run, rd, mp, KEPT, owner, installed, hookScript, upstream, withShim, mvFault } from "./install-fixture.js";

test("with drover-github/query.js absent (box1 skips it) a changed _lib file still prints the note, and the install succeeds", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0);
  rmSync(join(repo, "mods", "drover-github", "query.js"));
  appendFileSync(join(repo, "mods", "_lib", "store.js"), "\n// changed\n");
  const skip = { DROVER_SKIP_MODS: "drover-jira drover-github" };
  const r = run(repo, home, skip);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, NOTE);
  assert.doesNotMatch(run(repo, home, skip).stdout, NOTE, "the note repeats after a good run");
});

test("B6-HEAD guard A/B/C: while HEAD did not move, an owner restore to the old bytes is kept", () => {
  const { repo, home } = installed();
  const A = rd(mp(repo, "drover-tasks", "store.js"));
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// B uncommitted\n");
  assert.equal(run(repo, home).status, 0); // copies are now B, baseline B, HEAD still A
  writeFileSync(mp(repo, "drover-tasks", "store.js"), A); // owner restores A, which is also the committed blob
  const r = run(repo, home);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /KEPT drover-tasks\/store\.js \(owner-changed\)/);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), A);
});

test("B6-13b race: an owner save-by-rename after the classification is not overwritten (the same-inode check), and no run claims the window is closed", () => {
  const { root, repo, home } = installed(); upstream(repo);
  const hook = hookScript(root, `[ "$1" = classified ] && { printf 'RENAMED\\n' > "$2.sv"; mv "$2.sv" "$2"; }; exit 0`);
  const r = run(repo, home, { DROVER_INSTALL_TEST_HOOK: hook });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), "RENAMED\n");
  assert.doesNotMatch(r.stdout, /\bsafe\b/i);
});

test("B6-lock a held installer lock refuses the run (exit 2) and writes nothing", () => {
  const { repo, home } = fixture();
  mkdirSync(mp(repo, ".install.lock"));
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// upstream\n");
  const r = run(repo, home);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /another install/);
  assert.deepEqual(readdirSync(join(home, "mods")), []);
  assert.notEqual(rd(mp(repo, "drover-tasks", "store.js")), rd(mp(repo, "_lib", "store.js")));
  rmSync(mp(repo, ".install.lock"), { recursive: true });
  assert.equal(run(repo, home).status, 0);
  assert.equal(existsSync(mp(repo, ".install.lock")), false, "the lock stayed after a good run");
});

test("B6-H2 when the invalid marker cannot be written nothing is published or created for that file", () => {
  const { root, repo, home } = fixture();
  const A = rd(mp(repo, "drover-tasks", "store.js"));
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// B\n");
  unlinkSync(mp(repo, "drover-tasks", "io.js")); // a file that would be created
  const r = withShim(repo, home, mvFault(root, "*/.drover-baseline/*/drover-tasks/*.head"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), A, "a file was published without a record");
  assert.equal(existsSync(mp(repo, "drover-tasks", "io.js")), false, "a file was created without a record");
  assert.match(r.stdout, /KEPT drover-tasks\/store\.js \(the old baseline record cannot be invalidated/);
  assert.match(r.stdout, /FAILED drover-tasks\/io\.js: could not create it/);
});
