// Part 8 of 8 of the install.sh tests (split from install.test.js by measured weight; the shared fixture is install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, unlinkSync, mkdirSync, readdirSync, statSync, lstatSync, readlinkSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { made, fixture, run, rd, mp, KEPT, keptLines, owner, installed, backups, upstream, realTool, shimDir, withShim, plant } from "./install-fixture.js";

test("B6-1 an edit made through the home symlink is kept; the incoming copy sits beside it; the run says so and exits 1", () => {
  const { repo, home } = installed();
  appendFileSync(join(home, "mods", "drover-tasks", "store.js"), owner); // the symlink: the edit lands in the repo file
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// upstream\n");
  const r = run(repo, home);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /KEPT drover-tasks\/store\.js \(owner-changed\): new copy at drover-tasks\/store\.js\.new/);
  assert.match(rd(mp(repo, "drover-tasks", "store.js")), /owner edit/);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js.new")), rd(mp(repo, "_lib", "store.js")));
  assert.equal(rd(mp(repo, "drover-config", "store.js")), rd(mp(repo, "_lib", "store.js")), "an untouched copy was not updated");
});

test("B6-3 an unknown baseline (fresh home, differing copy, not the committed bytes) is kept", () => {
  const { repo, home } = fixture();
  appendFileSync(mp(repo, "drover-tasks", "io.js"), owner);
  const r = run(repo, home);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /KEPT drover-tasks\/io\.js \(unknown baseline\): new copy at drover-tasks\/io\.js\.new/);
  assert.match(rd(mp(repo, "drover-tasks", "io.js")), /owner edit/);
  assert.ok(existsSync(mp(repo, "drover-tasks", "io.js.new")));
});

test("B6-12 a leaf that is not a regular file (symlink to equal bytes, other target, dangling, folder) is kept and nothing outside is written", () => {
  const { root, repo, home } = installed();
  const ext = join(root, "ext.js"); writeFileSync(ext, "external\n");
  const canon = rd(mp(repo, "_lib", "store.js"));
  const files = { "store.js": mp(repo, "_lib", "store.js"), "io.js": ext, "keys.js": join(root, "nowhere") };
  for (const [f, t] of Object.entries(files)) { unlinkSync(mp(repo, "drover-tasks", f)); symlinkSync(t, mp(repo, "drover-tasks", f)); }
  unlinkSync(mp(repo, "drover-tasks", "runs.js")); mkdirSync(mp(repo, "drover-tasks", "runs.js"));
  appendFileSync(mp(repo, "_lib", "io.js"), "\n// upstream\n");
  const r = run(repo, home);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(keptLines(r).length, 4, r.stdout);
  for (const f of Object.keys(files)) { assert.ok(lstatSync(mp(repo, "drover-tasks", f)).isSymbolicLink(), f); assert.equal(existsSync(mp(repo, "drover-tasks", `${f}.new`)), false, `${f}.new`); }
  assert.equal(rd(ext), "external\n"); assert.equal(rd(mp(repo, "_lib", "store.js")), canon); assert.ok(statSync(mp(repo, "drover-tasks", "runs.js")).isDirectory());
});

test("B6-F5 a skip run keeps a link nothing recorded, even one that points into this checkout", () => {
  const { repo, home } = installed();
  rmSync(join(home, ".drover-baseline", "links"));
  const r = run(repo, home, { DROVER_SKIP_MODS: "drover-tasks" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(readlinkSync(join(home, "mods", "drover-tasks")), mp(repo, "drover-tasks"));
  assert.match(r.stdout, /KEPT link .*drover-tasks.*unknown baseline/);
  const again = run(repo, home); // a normal run adopts the link that equals the wanted target (non-mutating)
  assert.equal(again.status, 0, again.stdout + again.stderr);
  const skip = run(repo, home, { DROVER_SKIP_MODS: "drover-tasks" });
  assert.equal(skip.status, 0, skip.stdout + skip.stderr);
  assert.equal(lstatSync(join(home, "mods", "drover-tasks"), { throwIfNoEntry: false }), undefined);
});

test("B6-G2 a failed baseline update never leaves the old baseline in charge: after the failure the owner's restore of the old bytes is kept", () => {
  const { root, repo, home } = installed();
  const A = rd(mp(repo, "drover-tasks", "store.js"));
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// B\n");
  const shim = shimDir(root, "mv", `case "\${@: -1}" in */.drover-baseline/*/drover-tasks/store.js) exit 1;; esac; exec ${realTool("mv")} "$@"`);
  const r = withShim(repo, home, shim);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAILED drover-tasks\/store\.js: the baseline record could not be written/);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), A + "\n// B\n");
  writeFileSync(mp(repo, "drover-tasks", "store.js"), A); // owner restores the old (committed) bytes
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// C\n");
  const r2 = run(repo, home);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /KEPT drover-tasks\/store\.js/);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), A);
});

test("B6-G3b a pre-existing staging folder beside a missing file is not deleted, and the file is not created over it", () => {
  const { repo, home } = installed();
  unlinkSync(mp(repo, "drover-tasks", "store.js"));
  const r = plant(repo, home, `for n in store.js; do d=drover-tasks/.drover-tmp.$$.$n; mkdir $d; echo notes > $d/owner-notes; done`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(existsSync(mp(repo, "drover-tasks", ".drover-tmp." + "x")), false);
  const dirs = readdirSync(mp(repo, "drover-tasks")).filter((n) => /^\.drover-tmp\..*store\.js$/.test(n));
  assert.equal(dirs.length, 1); assert.equal(rd(mp(repo, "drover-tasks", dirs[0], "owner-notes")), "notes\n");
  assert.equal(existsSync(mp(repo, "drover-tasks", "store.js")), false);
  assert.match(r.stdout, /FAILED drover-tasks\/store\.js/);
});

test("B6-G3c a pre-existing backup folder for this run is refused: the old file stays beside the new one, the owner's files are untouched", () => {
  const { repo, home } = installed();
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// upstream\n");
  const r = plant(repo, home, `for s in $S; do d=.install-backups/$s-$$; mkdir -p $d/drover-tasks; echo notes > $d/drover-tasks/store.js; done`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /could not be moved/);
  for (const d of backups(repo)) assert.equal(rd(join(d, "drover-tasks", "store.js")), "notes\n");
});
