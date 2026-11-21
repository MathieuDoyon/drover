// Part 1 of 8 of the install.sh tests (split from install.test.js by measured weight; the shared fixture is install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, lstatSync, readlinkSync, writeFileSync, appendFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, BIN, fixture, install, mtimes, run, noHasherPath, runIn, rd, mp, KEPT, keptLines, commitAll, owner, installed, withShim, mvFault, anyNewrec, aliasScenario } from "./install-fixture.js";

test("a second run rewrites no mod file and no link", () => {
  const { repo, home } = fixture();
  const first = install(repo, home);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  // age every file and link, so a rewrite shows as a changed mtime
  const old = new Date(Date.now() - 3600_000);
  for (const f of Object.keys(mtimes(join(repo, "mods")))) utimesSync(join(repo, "mods", f), old, old);
  const before = mtimes(join(repo, "mods"));
  const link = join(home, "mods", "drover-tasks");
  const linkBefore = lstatSync(link).ino;
  const second = install(repo, home);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.deepEqual(mtimes(join(repo, "mods")), before, "a file with equal bytes was rewritten");
  assert.equal(lstatSync(link).ino, linkBefore, "a link that was already right was recreated");
  assert.equal(readlinkSync(link), join(repo, "mods", "drover-tasks"));
});

test("B6-9 a local commit of an owner edit, a restored old version, and a missing git are all kept", () => {
  const a = installed();
  appendFileSync(mp(a.repo, "drover-tasks", "store.js"), owner); commitAll(a.repo, "owner edit");
  const ra = run(a.repo, a.home);
  assert.equal(ra.status, 1, ra.stdout); assert.equal(keptLines(ra).length, 1);
  const b = installed(); // historical revert: HEAD moves to B (copies too), then the owner puts A back
  const A = rd(mp(b.repo, "drover-tasks", "store.js"));
  for (const d of ["_lib", ...readdirSync(mp(b.repo)).filter((n) => n.startsWith("drover-"))]) appendFileSync(mp(b.repo, d, "store.js"), "\n// B\n");
  commitAll(b.repo);
  assert.equal(run(b.repo, b.home).status, 0);
  writeFileSync(mp(b.repo, "drover-tasks", "store.js"), A);
  const rb = run(b.repo, b.home);
  assert.equal(rb.status, 1, rb.stdout); assert.match(rb.stdout, /KEPT drover-tasks\/store\.js/);
  assert.equal(rd(mp(b.repo, "drover-tasks", "store.js")), A);
  const c = fixture(); // no git at all: an unknown baseline cannot be proved untouched
  rmSync(join(c.repo, ".git"), { recursive: true, force: true });
  appendFileSync(mp(c.repo, "drover-tasks", "store.js"), owner);
  const rc = run(c.repo, c.home);
  assert.equal(rc.status, 1, rc.stdout + rc.stderr); assert.equal(keptLines(rc).length, 1);
});

test("B6-15 with no hasher on PATH a kept file is still kept and reported (no crash, exit 1)", () => {
  const { repo, home } = fixture();
  const path = `${BIN}:${noHasherPath()}`;
  appendFileSync(mp(repo, "drover-tasks", "io.js"), owner);
  const r = runIn(repo, home, path);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /KEPT drover-tasks\/io\.js \(unknown baseline\)/);
});

test("B6-H1 a first-ever publish whose baseline write fails leaves the invalid marker: the owner's restored committed copy is kept on retry", () => {
  const { root, repo, home } = fixture(); // no baseline, no record: a first run
  const A = rd(mp(repo, "drover-tasks", "store.js"));
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// B\n");
  const r = withShim(repo, home, mvFault(root, "*/.drover-baseline/*/drover-tasks/store.js"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAILED drover-tasks\/store\.js: the baseline record could not be written/);
  writeFileSync(mp(repo, "drover-tasks", "store.js"), A); // the owner restores the committed copy
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// C\n");
  const r2 = run(repo, home);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /KEPT drover-tasks\/store\.js/);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), A);
});

test("B6-T3 a .new keeps its bytes and mtime while the source moves A, B, C; it is reported (naming the source) and the run exits 1; no record file exists", () => {
  const { repo, home } = installed();
  appendFileSync(mp(repo, "drover-tasks", "store.js"), owner);
  const r1 = run(repo, home);
  assert.equal(r1.status, 1);
  const nw = mp(repo, "drover-tasks", "store.js.new"), first = rd(nw);
  const old = new Date(Date.now() - 3600_000); utimesSync(nw, old, old); const m0 = lstatSync(nw).mtimeMs;
  for (const tag of ["B", "C"]) {
    appendFileSync(mp(repo, "_lib", "store.js"), `\n// ${tag}\n`);
    const r = run(repo, home);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /store\.js\.new is older than the incoming copy, or yours: left alone; the incoming copy is mods\/_lib\/store\.js/);
    assert.match(r.stdout, /KEPT drover-tasks\/store\.js \(owner-changed\): new copy NOT written/);
    assert.equal(rd(nw), first, `${tag}: the .new was rewritten`);
    assert.equal(lstatSync(nw).mtimeMs, m0, `${tag}: the .new was touched`);
  }
  assert.deepEqual(anyNewrec(home), [], "a sidecar record exists");
  const eq = installed(); // an equal .new needs no write: same bytes, same mtime
  appendFileSync(mp(eq.repo, "drover-tasks", "store.js"), owner);
  run(eq.repo, eq.home);
  const e = mp(eq.repo, "drover-tasks", "store.js.new"); utimesSync(e, old, old); const e0 = lstatSync(e).mtimeMs;
  const re = run(eq.repo, eq.home);
  assert.equal(re.status, 1); assert.equal(lstatSync(e).mtimeMs, e0);
});

test("B6-T4 a symlinked path to the same checkout is the same baseline: the A/B/C guard is not bypassed", () => {
  const { r, A, repo } = aliasScenario();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /KEPT drover-tasks\/store\.js/);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), A);
});

test("B6-T4 control: keyed by the logical path the same run bypasses the guard (so T4 really exercises the alias)", () => {
  const { r, A, repo } = aliasScenario((src) => { assert.ok(src.includes("$(pwd -P)"), "the physical key is gone from install.sh"); return src.replace("$(pwd -P)", "$PWD"); });
  assert.doesNotMatch(r.stdout, /KEPT drover-tasks\/store\.js/, r.stdout);
  assert.notEqual(rd(mp(repo, "drover-tasks", "store.js")), A, "the guard held although the key was logical: the alias was not in effect");
});
