// install.sh must not make Herdr reload mods for nothing (a saved file reloads the mod) and must not link mods to a worktree by accident.
// Everything runs in a disposable repo copy and a disposable HERDR_APP_HOME; never the real Herdr home.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdtempSync, mkdirSync, cpSync, readdirSync, statSync, lstatSync, readlinkSync, writeFileSync, appendFileSync, readFileSync, utimesSync, rmSync, existsSync, realpathSync } from "node:fs";
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
  cpSync(SRC, join(repo, "mods"), { recursive: true, filter: (p) => !p.includes("node_modules") });
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

// omarchy (Arch) runs this script too: no shasum there, and the GitHub mod may be skipped. Never a false alarm, never a failed install.
// A private bin dir with symlinks to only the tools install.sh needs, found on the real PATH. Hiding the hashers by editing PATH cannot work:
// on Linux they sit in /usr/bin with every other tool. The dir is checked by listing it, not by running anything.
const NEEDED = ["bash", "sh", "env", "cat", "cp", "mv", "rm", "ln", "install", "cmp", "readlink", "dirname", "basename", "git", "mkdir", "grep", "head", "tail", "sed", "awk", "tr", "sort", "ls", "date", "touch", "chmod", "uname", "cut", "wc", "expr", "test", "["];
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

test("with drover-github/query.js absent (omarchy skips it) a changed _lib file still prints the note, and the install succeeds", () => {
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
