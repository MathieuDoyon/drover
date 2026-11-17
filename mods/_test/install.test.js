// install.sh must not make Herdr reload mods for nothing (a saved file reloads the mod) and must not link mods to a worktree by accident.
// Everything runs in a disposable repo copy and a disposable HERDR_APP_HOME; never the real Herdr home.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, readdirSync, statSync, lstatSync, readlinkSync, writeFileSync, appendFileSync, readFileSync, utimesSync, rmSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cwd, cmd, args, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const git = (cwd, ...a) => { const r = sh(cwd, "git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a]); assert.equal(r.status, 0, r.stderr); return r.stdout; };

// install.sh runs `herdr-app check` per mod; CI has no Herdr, so a fake that always passes goes first on PATH.
const BIN = mkdtempSync(join(tmpdir(), "install-test-bin-"));
writeFileSync(join(BIN, "herdr-app"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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
