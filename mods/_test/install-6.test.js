// Part 6 of 8 of the install.sh tests (split from install.test.js by measured weight; the shared fixture is install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readlinkSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BIN, fixture, install, NOTE, run, noHasherPath, CANNOT, runIn, rd, mp, KEPT, owner, installed, backups, upstream, blDir, realTool, shimDir, withShim, forget, plant } from "./install-fixture.js";

test("a home with links but no stamp (installed before the stamp existed) prints the note once", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0);
  rmSync(join(home, ".drover-lib-stamp"));
  assert.match(install(repo, home).stdout, NOTE);
  assert.doesNotMatch(install(repo, home).stdout, NOTE);
});

test("with no hasher on a fresh home nothing is printed and nothing is stamped", () => {
  const { repo, home } = fixture();
  const r = runIn(repo, home, `${BIN}:${noHasherPath()}`);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, CANNOT);
  assert.doesNotMatch(r.stdout, NOTE);
  assert.equal(existsSync(join(home, ".drover-lib-stamp")), false);
});

// T-MWO2HFFHWRB Rev 3: the existing drover-*/ loop links the Needs-you mods, and the layout link points at the checkout it ran from (disposable home).
test("install links drover-needs and drover-switch like every mod, and the layout that holds them", () => {
  const { repo, home } = fixture();
  const r = install(repo, home);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const m of ["drover-needs", "drover-switch"]) {
    assert.equal(readlinkSync(join(home, "mods", m)), join(repo, "mods", m), m);
    assert.match(r.stdout, new RegExp(`ok   ${m}\\n`));
    assert.ok(existsSync(join(home, "mods", m, "main.js")) && existsSync(join(home, "mods", m, "needsnav.js")) && existsSync(join(home, "mods", m, "needs.js")), `${m} carries its shared copies`);
  }
  assert.equal(readlinkSync(join(home, "layouts", "drover.json")), join(repo, "mods", "_layouts", "drover.json"));
  const layout = JSON.parse(readFileSync(join(home, "layouts", "drover.json"), "utf8"));
  assert.match(JSON.stringify(layout), /"mod":"drover-needs"/);
  assert.match(JSON.stringify(layout), /"mod":"drover-switch"/);
});

test("B6-2 an edit of a generated copy (query.js in drover-config) is kept even when upstream did not change", () => {
  const { repo, home } = installed();
  appendFileSync(mp(repo, "drover-config", "query.js"), owner);
  const r = run(repo, home);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /KEPT drover-config\/query\.js \(owner-changed\)/);
  assert.match(rd(mp(repo, "drover-config", "query.js")), /owner edit/);
  assert.equal(rd(mp(repo, "drover-config", "query.js.new")), rd(mp(repo, "drover-github", "query.js")));
});

test("B6-6 the replaced file's old bytes are retained under mods/.install-backups/<stamp>/<mod>/<file>", () => {
  const { repo, home } = installed();
  const old = rd(mp(repo, "drover-tasks", "store.js"));
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// upstream\n");
  assert.equal(run(repo, home).status, 0);
  const dirs = backups(repo);
  assert.equal(dirs.length, 1);
  assert.equal(rd(join(dirs[0], "drover-tasks", "store.js")), old);
  assert.notEqual(rd(mp(repo, "drover-tasks", "store.js")), old);
});

test("B6-G1 the equal path records the bytes it found equal, not a later read of the canonical file (A equal, canonical -> C, owner C, canonical D: kept)", () => {
  const { root, repo, home } = installed();
  const A = rd(mp(repo, "drover-tasks", "store.js"));
  forget(repo, home, "store.js"); // so the equal path has a record to write
  const flag = join(root, "flag");
  const shim = shimDir(root, "cmp", `${realTool("cmp")} "$@"; rc=$?; if [ $rc = 0 ] && [ "$2" = _lib/store.js ] && [ "$3" = drover-tasks/store.js ] && [ ! -e ${JSON.stringify(flag)} ]; then : > ${JSON.stringify(flag)}; printf '\\n// C\\n' >> _lib/store.js; fi; exit $rc`);
  const r = withShim(repo, home, shim);
  assert.ok(existsSync(flag), "the shim never fired");
  // whatever the run decided after the source moved under it, the record must describe the bytes the file holds: never a canonical read it did not install
  const held = rd(mp(repo, "drover-tasks", "store.js"));
  assert.equal(rd(join(blDir(repo, home), "drover-tasks", "store.js")), held, `the baseline holds bytes that are not in the file\n${r.stdout}`);
  assert.ok([A, rd(mp(repo, "_lib", "store.js"))].includes(held), "the file holds neither the compared nor the new bytes");
  const owner2 = held + "\n// owner\n";
  writeFileSync(mp(repo, "drover-tasks", "store.js"), owner2);
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// D\n");
  const r2 = run(repo, home);
  assert.equal(r2.status, 1, r.stdout + r2.stdout + r2.stderr);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), owner2);
});

test("B6-G3a a pre-existing record workspace (owner notes, a symlink inside) is refused: nothing is followed, nothing of the owner's is deleted", () => {
  const { root, repo, home } = installed();
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// upstream\n");
  const ext = join(root, "unrelated.txt"); writeFileSync(ext, "unrelated\n");
  const bl0 = join(home, ".drover-baseline");
  const r = plant(repo, home, `for s in $S; do d=${JSON.stringify(bl0)}/.run.$s-$$; mkdir $d; echo notes > $d/owner-notes; ln -s ${JSON.stringify(ext)} $d/f.1; done`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(rd(ext), "unrelated\n");
  const planted = readdirSync(bl0).filter((n) => n.startsWith(".run."));
  assert.ok(planted.length > 0 && planted.every((n) => existsSync(join(bl0, n, "owner-notes"))), "an owner folder was deleted");
});
