// install.sh must not make Herdr reload mods for nothing (a saved file reloads the mod) and must not link mods to a worktree by accident.
// Everything runs in a disposable repo copy and a disposable HERDR_APP_HOME; never the real Herdr home.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdtempSync, unlinkSync, chmodSync, renameSync, mkdirSync, cpSync, readdirSync, statSync, lstatSync, readlinkSync, writeFileSync, appendFileSync, readFileSync, utimesSync, rmSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cwd, cmd, args, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const git = (cwd, ...a) => { const r = sh(cwd, "git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a]); assert.equal(r.status, 0, r.stderr); return r.stdout; };

// install.sh runs `herdr-app check` per mod; CI has no Herdr, so a fake that always passes goes first on PATH.
const BIN = mkdtempSync(join(tmpdir(), "install-test-bin-"));
writeFileSync(join(BIN, "herdr-app"), "#!/bin/sh\n[ -n \"$FAKE_CHECK_FAIL\" ] && exit 1\nexit 0\n", { mode: 0o755 });
const made = [BIN];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); }); // worktree metadata lives inside the root, so one rm cleans all

// a repo whose mods/ is a copy of this one, plus an empty Herdr home
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-test-")));
  made.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  cpSync(SRC, join(repo, "mods"), { recursive: true, filter: (p) => !p.includes("node_modules") && !/\/\.install(\.lock|-backups)$/.test(p) });
  if (process.env.INSTALL_SH_UNDER_TEST) cpSync(process.env.INSTALL_SH_UNDER_TEST, join(repo, "mods", "install.sh")); // a scratch variant of the installer (mutation / red controls)
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "x");
  const home = join(root, "home");
  mkdirSync(join(home, "mods"), { recursive: true }); mkdirSync(join(home, "layouts"));
  return { root, repo, home };
}
const install = (dir, home, ...args) => sh(join(dir, "mods"), "bash", ["install.sh", ...args], { HERDR_APP_HOME: home, DROVER_SKIP_TESTS: "1", PATH: `${BIN}:${process.env.PATH}` });
const mtimes = (dir) => {
  const out = {};
  for (const m of readdirSync(dir).filter((n) => n.startsWith("drover-")))
    for (const f of readdirSync(join(dir, m))) { const st = lstatSync(join(dir, m, f)); if (st.isFile()) out[`${m}/${f}`] = st.mtimeMs; }
  return out;
};

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

test("--from-worktree installs from a linked worktree on purpose", () => {
  const { root, repo, home } = fixture();
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  const r = install(wt, home, "--from-worktree");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readlinkSync(join(home, "mods", "drover-tasks")), join(wt, "mods", "drover-tasks"));
});

test("an unknown argument is refused", () => {
  const { repo, home } = fixture();
  const r = install(repo, home, "--nope");
  assert.equal(r.status, 2);
  assert.deepEqual(readdirSync(join(home, "mods")), []);
});

// the reopen note: shared _lib code that changed since the last good install (Herdr may keep the old imports)
const NOTE = /NOTE: shared _lib code changed/;
const mainJs = (repo) => Object.fromEntries(readdirSync(join(repo, "mods")).filter((n) => n.startsWith("drover-")).map((m) => [m, statSync(join(repo, "mods", m, "main.js")).mtimeMs]));
const run = (repo, home, env = {}) => sh(join(repo, "mods"), "bash", ["install.sh"], { HERDR_APP_HOME: home, DROVER_SKIP_TESTS: "1", PATH: `${BIN}:${process.env.PATH}`, ...env });

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

test("a query.js-only change prints the note", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0);
  appendFileSync(join(repo, "mods", "drover-github", "query.js"), "\n// changed\n");
  assert.match(install(repo, home).stdout, NOTE);
});

test("a failing check still prints the note, and the next run prints it again", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0);
  appendFileSync(join(repo, "mods", "_lib", "store.js"), "\n// changed\n");
  const bad = run(repo, home, { FAKE_CHECK_FAIL: "1" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, NOTE);
  assert.match(install(repo, home).stdout, NOTE, "the stamp advanced after a failed run");
});

test("a home with links but no stamp (installed before the stamp existed) prints the note once", () => {
  const { repo, home } = fixture();
  assert.equal(install(repo, home).status, 0);
  rmSync(join(home, ".drover-lib-stamp"));
  assert.match(install(repo, home).stdout, NOTE);
  assert.doesNotMatch(install(repo, home).stdout, NOTE);
});

// box1 (Arch) runs this script too: no shasum there, and the GitHub mod may be skipped. Never a false alarm, never a failed install.
// A private bin dir with symlinks to only the tools install.sh needs, found on the real PATH. Hiding the hashers by editing PATH cannot work:
// on Linux they sit in /usr/bin with every other tool. The dir is checked by listing it, not by running anything.
const NEEDED = ["bash", "sh", "env", "cat", "cp", "mv", "rm", "ln", "install", "cmp", "readlink", "dirname", "basename", "git", "mkdir", "grep", "head", "tail", "sed", "awk", "tr", "sort", "ls", "date", "touch", "chmod", "rmdir", "uname", "cut", "wc", "expr", "test", "["];
function noHasherPath(keepCksum = false) {
  const dir = mkdtempSync(join(tmpdir(), "install-test-nohash-"));
  made.push(dir);
  for (const n of [...NEEDED, ...(keepCksum ? ["cksum"] : [])]) {
    const r = sh(".", "sh", ["-c", `command -v ${n === "[" ? "'['" : n}`]);
    const found = r.stdout.trim();
    if (r.status === 0 && found.startsWith("/")) symlinkSync(found, join(dir, n));
  }
  const names = readdirSync(dir);
  assert.deepEqual(names.filter((n) => ["sha256sum", "shasum"].includes(n) || (n === "cksum" && !keepCksum)), [], "a hasher is in the private bin");
  for (const must of ["bash", "sh", "git", "cat", "cp"]) assert.ok(names.includes(must), `${must} is not available for the install`);
  return dir;
}

const CANNOT = /fingerprint could not be checked/;
const runIn = (repo, home, path, env = {}) => sh(join(repo, "mods"), join(path.split(":")[1], "bash"), ["install.sh"], { HERDR_APP_HOME: home, DROVER_SKIP_TESTS: "1", PATH: path, ...env });

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

test("with no hasher on a fresh home nothing is printed and nothing is stamped", () => {
  const { repo, home } = fixture();
  const r = runIn(repo, home, `${BIN}:${noHasherPath()}`);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, CANNOT);
  assert.doesNotMatch(r.stdout, NOTE);
  assert.equal(existsSync(join(home, ".drover-lib-stamp")), false);
});

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

// ---- T-MWO2HH3HOAU (B6): safe updates. Owner-changed managed files are never overwritten; the incoming copy lands beside them as <file>.new.
const rd = (p) => readFileSync(p, "utf8");
const mp = (repo, ...a) => join(repo, "mods", ...a);
const KEPT = /^KEPT /gm;
const keptLines = (r) => r.stdout.split("\n").filter((l) => /^KEPT/.test(l));
const ageAll = (repo) => { const old = new Date(Date.now() - 3600_000); for (const f of Object.keys(mtimes(mp(repo)))) utimesSync(mp(repo, f), old, old); };
const commitAll = (repo, msg = "y") => { git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", msg); };
const owner = "\n// owner edit\n";
const installed = () => { const f = fixture(); assert.equal(run(f.repo, f.home).status, 0); return f; };
const spawnTimed = (repo, home, env) => spawnSync("bash", ["install.sh"], { cwd: mp(repo), encoding: "utf8", timeout: 30000, env: { ...process.env, HERDR_APP_HOME: home, DROVER_SKIP_TESTS: "1", PATH: `${BIN}:${process.env.PATH}`, ...env } }); // timeout: a hang guard only
const backups = (repo) => { const d = mp(repo, ".install-backups"); return existsSync(d) ? readdirSync(d).map((s) => join(d, s)) : []; };

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

test("B6-2 an edit of a generated copy (query.js in drover-config) is kept even when upstream did not change", () => {
  const { repo, home } = installed();
  appendFileSync(mp(repo, "drover-config", "query.js"), owner);
  const r = run(repo, home);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /KEPT drover-config\/query\.js \(owner-changed\)/);
  assert.match(rd(mp(repo, "drover-config", "query.js")), /owner edit/);
  assert.equal(rd(mp(repo, "drover-config", "query.js.new")), rd(mp(repo, "drover-github", "query.js")));
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

// race hooks (DROVER_INSTALL_TEST_HOOK is test-only): the hook runs at four points of one file's publish and edits the file as an owner would.
const hookScript = (root, body) => { const p = join(root, "hook.sh"); writeFileSync(p, `#!/bin/bash\n[ "$2" = drover-tasks/store.js ] || exit 0\n${body}\n`, { mode: 0o755 }); return p; };
const upstream = (repo) => appendFileSync(mp(repo, "_lib", "store.js"), "\n// upstream\n");
const find = (repo, re) => readdirSync(mp(repo, "drover-tasks")).filter((n) => re.test(n));

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

test("B6-13b race: an owner save-by-rename after the classification is not overwritten (the same-inode check), and no run claims the window is closed", () => {
  const { root, repo, home } = installed(); upstream(repo);
  const hook = hookScript(root, `[ "$1" = classified ] && { printf 'RENAMED\\n' > "$2.sv"; mv "$2.sv" "$2"; }; exit 0`);
  const r = run(repo, home, { DROVER_INSTALL_TEST_HOOK: hook });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), "RENAMED\n");
  assert.doesNotMatch(r.stdout, /\bsafe\b/i);
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

test("B6-15 with no hasher on PATH a kept file is still kept and reported (no crash, exit 1)", () => {
  const { repo, home } = fixture();
  const path = `${BIN}:${noHasherPath()}`;
  appendFileSync(mp(repo, "drover-tasks", "io.js"), owner);
  const r = runIn(repo, home, path);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /KEPT drover-tasks\/io\.js \(unknown baseline\)/);
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

// ---- review round 1 fixes (findings 1, 2, 3, 5, 6)
const blDir = (repo, home) => join(home, ".drover-baseline", mp(repo));

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

test("B6-F3 a staging name planted as a symlink is never opened: the external file is unchanged and the file is kept", () => {
  const { root, repo, home } = installed();
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// upstream\n");
  const ext = join(root, "owner-file.txt"); writeFileSync(ext, "owner bytes\n");
  const before = rd(mp(repo, "drover-tasks", "store.js"));
  // same pid as the installer: the wrapper plants the predictable names, then becomes install.sh
  const plant = `for n in store.js; do ln -s ${JSON.stringify(ext)} drover-tasks/.drover-tmp.$$.$n; ln -s ${JSON.stringify(ext)} drover-tasks/.drover-aside.$$.$n; done; exec bash install.sh`;
  const r = spawnSync("sh", ["-c", plant], { cwd: mp(repo), encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, DROVER_SKIP_TESTS: "1", PATH: `${BIN}:${process.env.PATH}` } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(rd(ext), "owner bytes\n");
  assert.equal(rd(mp(repo, "drover-tasks", "store.js")), before);
  assert.ok(!lstatSync(mp(repo, "drover-tasks", "store.js")).isSymbolicLink());
  assert.match(r.stdout, /KEPT drover-tasks\/store\.js/);
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

// ---- review round 2 fixes (equal path reference, failed record update, staging ownership)
const realTool = (n) => { const r = spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }); return r.stdout.trim(); };
const shimDir = (root, name, body) => { const d = join(root, `shim-${name}`); mkdirSync(d); writeFileSync(join(d, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }); return d; };
const withShim = (repo, home, dir, env = {}) => spawnSync("bash", ["install.sh"], { cwd: mp(repo), encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, DROVER_SKIP_TESTS: "1", PATH: `${dir}:${BIN}:${process.env.PATH}`, ...env } });
const forget = (repo, home, f) => { for (const n of [f, `${f}.head`]) rmSync(join(blDir(repo, home), "drover-tasks", n), { force: true }); };

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

// the installer's pid is predictable and its clock is pinned by a date shim shared with the wrapper: the planted names are exact, not a guess
const FIXED = "20260101T000000Z";
let dateShim;
const plant = (repo, home, script) => {
  dateShim ??= (() => { const d = mkdtempSync(join(tmpdir(), "install-test-date-")); made.push(d); writeFileSync(join(d, "date"), `#!/bin/bash\nif [ "$*" = "-u +%Y%m%dT%H%M%SZ" ]; then echo ${FIXED}; else exec ${realTool("date")} "$@"; fi\n`, { mode: 0o755 }); return d; })();
  return spawnSync("sh", ["-c", `S="${FIXED}"; ${script}; exec bash install.sh`], { cwd: mp(repo), encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, DROVER_SKIP_TESTS: "1", PATH: `${dateShim}:${BIN}:${process.env.PATH}` } });
};

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

// ---- review round 3: a record or marker that cannot be written means no change for that file
const mvFault = (root, glob) => shimDir(root, "mv", `case "\${@: -1}" in ${glob}) exit 1;; esac; exec ${realTool("mv")} "$@"`);

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

test("B6-H3 a link is not repointed or removed when its record cannot be put out of charge first", () => {
  const { root, repo, home } = installed();
  const wt = join(root, "wt"); git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  const link = join(home, "mods", "drover-tasks"), before = readlinkSync(link);
  const shim = mvFault(root, "*/.drover-baseline/links");
  const r = spawnSync("bash", ["install.sh", "--from-worktree"], { cwd: join(wt, "mods"), encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, DROVER_SKIP_TESTS: "1", PATH: `${shim}:${BIN}:${process.env.PATH}` } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(readlinkSync(link), before, "the link moved without a record");
  const s = withShim(repo, home, shim, { DROVER_SKIP_MODS: "drover-jira" });
  assert.equal(s.status, 1, s.stdout + s.stderr);
  assert.ok(lstatSync(join(home, "mods", "drover-jira"), { throwIfNoEntry: false }), "the link was removed without a record");
});

// ---- Judge ruling 2: the .new is stateless, the baseline key is physical, one installer per home
const anyNewrec = (home) => { const out = []; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.newrec$/.test(e.name)) out.push(p); } }; walk(home); return out; };

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

// T4: a logical alias for the checkout. `cd` in a shell keeps the alias in $PWD and the exec'd installer inherits it (spawning with cwd=alias would let bash recompute
// the physical path and prove nothing). The control swaps the physical key for the logical one in a scratch copy of the installer and must see the guard bypassed.
function aliasScenario(patch) {
  const { root, repo, home } = installed();
  const A = rd(mp(repo, "drover-tasks", "store.js"));
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// B\n");
  assert.equal(run(repo, home).status, 0);
  const alias = join(root, "alias"); symlinkSync(repo, alias);
  if (patch) writeFileSync(mp(repo, "install.sh"), patch(rd(mp(repo, "install.sh"))));
  writeFileSync(mp(repo, "drover-tasks", "store.js"), A); // the owner restores the committed copy
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// C\n");
  const r = spawnSync("sh", ["-c", `cd ${JSON.stringify(join(alias, "mods"))} && [ "$PWD" = ${JSON.stringify(join(alias, "mods"))} ] && exec bash install.sh`], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, DROVER_SKIP_TESTS: "1", PATH: `${BIN}:${process.env.PATH}` } });
  return { r, A, repo };
}
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
