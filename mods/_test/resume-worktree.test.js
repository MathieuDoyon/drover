// T-MWLGPS2QJQL S1: ensureWorktree recreates a gone worktree from the run's branch, in isolated real git fixtures.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

register("./hooks.js", import.meta.url);
const { ensureWorktree } = await import("../_lib/io.js");

let tmp, repo, wt;
const git = (args, cwd = repo) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
const exists = (p) => fs.stat(p).then(() => true, () => false);
const registered = () => git(["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
const runOf = (o = {}) => ({ id: "R-OLD", task: "T-1", worktree: { repo, branch: "feat/T-1/card", path: wt }, terminals: [{ address: "t1", role: "leader", cwd: wt }], ...o });

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rw-")));
  repo = path.join(tmp, "repo"); wt = path.join(tmp, "wt", "feat-T-1-card");
  await fs.mkdir(repo, { recursive: true });
  git(["init", "-q", "-b", "main"]); git(["commit", "-q", "--allow-empty", "-m", "init"]);
  git(["worktree", "add", "-q", "-b", "feat/T-1/card", wt]);
  globalThis.__host = { appHome: "/app", home: tmp, props: {}, notified: [], terminals: [], state: {},
    exec: (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { cwd: opts.cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
      (e, stdout, stderr) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }))) };
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

test("the worktree is still there and registered for the branch: reused, nothing created", async () => {
  const w = await ensureWorktree(runOf());
  assert.deepEqual({ path: w.path, branch: w.branch, created: w.created }, { path: wt, branch: "feat/T-1/card", created: false });
});

test("worktree folder gone but still registered: only that path is removed from the metadata, then recreated from the branch", async () => {
  const other = path.join(tmp, "wt", "other");
  git(["worktree", "add", "-q", "-b", "feat/other", other]);
  await fs.rm(other, { recursive: true }); // an UNRELATED missing worktree: it must not be pruned
  await fs.rm(wt, { recursive: true });
  const w = await ensureWorktree(runOf());
  assert.equal(w.created, true);
  assert.equal(await exists(path.join(wt, ".git")), true);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], wt).trim(), "feat/T-1/card");
  assert.ok(registered().includes(other), "the unrelated registration was left alone (no prune)");
});

test("worktree gone and no longer registered (pruned): recreated from the existing branch, no -b", async () => {
  await fs.rm(wt, { recursive: true }); git(["worktree", "prune"]);
  const w = await ensureWorktree(runOf());
  assert.equal(w.created, true);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], wt).trim(), "feat/T-1/card");
  assert.equal(git(["branch", "--list"]).includes("feat/T-1/card"), true);
});

test("the branch is gone too: refused with the reason, nothing created", async () => {
  await fs.rm(wt, { recursive: true }); git(["worktree", "prune"]); git(["branch", "-D", "feat/T-1/card"]);
  await assert.rejects(ensureWorktree(runOf()), /branch feat\/T-1\/card/);
  assert.equal(await exists(wt), false);
});

test("the path exists but is not a worktree of that branch: refused, the folder is untouched", async () => {
  await fs.rm(wt, { recursive: true }); git(["worktree", "prune"]);
  await fs.mkdir(wt, { recursive: true }); await fs.writeFile(path.join(wt, "keep.txt"), "mine");
  await assert.rejects(ensureWorktree(runOf()), /exists|not a worktree/i);
  assert.equal(await fs.readFile(path.join(wt, "keep.txt"), "utf8"), "mine");
});

test("the branch is checked out at another live path: refused, the message names that path", async () => {
  await fs.rm(wt, { recursive: true }); git(["worktree", "prune"]);
  const elsewhere = path.join(tmp, "elsewhere");
  git(["worktree", "add", "-q", elsewhere, "feat/T-1/card"]);
  await assert.rejects(ensureWorktree(runOf()), (e) => e.message.includes(elsewhere));
  assert.equal(await exists(wt), false);
});

test("the path is a worktree of ANOTHER branch: refused", async () => {
  await fs.rm(wt, { recursive: true }); git(["worktree", "prune"]);
  git(["worktree", "add", "-q", "-b", "feat/else", wt]);
  await assert.rejects(ensureWorktree(runOf()), /feat\/else|another branch|not a worktree/i);
});

test("a run without a worktree uses the recorded folder; a folder that is gone is refused", async () => {
  const w = await ensureWorktree(runOf({ worktree: null, terminals: [{ address: "t1", role: "leader", cwd: repo }] }));
  assert.deepEqual({ path: w.path, created: w.created, branch: w.branch }, { path: repo, created: false, branch: null });
  await assert.rejects(ensureWorktree(runOf({ worktree: null, terminals: [{ address: "t1", role: "leader", cwd: path.join(tmp, "nope") }] })), /folder|gone|nope/i);
  await assert.rejects(ensureWorktree(runOf({ worktree: null, terminals: [{ address: "t1", role: "leader" }] })), /folder|cwd|recorded/i);
});

test("the main repo is gone: refused, no guess", async () => {
  await fs.rm(wt, { recursive: true });
  await assert.rejects(ensureWorktree(runOf({ worktree: { repo: path.join(tmp, "norepo"), branch: "feat/T-1/card", path: wt } })), /repo/i);
});

test("an UNRELATED directory recreated at the registered path is refused, not reused (no .git, keep.txt untouched)", async () => {
  await fs.rm(wt, { recursive: true }); // registered, folder gone
  await fs.mkdir(wt, { recursive: true }); await fs.writeFile(path.join(wt, "keep.txt"), "mine");
  await assert.rejects(ensureWorktree(runOf()), /not|worktree|unrelated|root/i);
  assert.equal(await fs.readFile(path.join(wt, "keep.txt"), "utf8"), "mine");
});
test("a registered path whose folder is now a checkout of ANOTHER repository is refused", async () => {
  await fs.rm(wt, { recursive: true });
  await fs.mkdir(wt, { recursive: true });
  const other = path.join(tmp, "otherrepo");
  await fs.mkdir(other); git(["init", "-q", "-b", "main"], other); git(["commit", "-q", "--allow-empty", "-m", "x"], other);
  git(["checkout", "-q", "-b", "feat/T-1/card"], other);
  await fs.rm(wt, { recursive: true }); await fs.rename(other, wt); // same branch name, different common repo
  await assert.rejects(ensureWorktree(runOf()), /repo|worktree|not/i);
});
test("a folder at the path that carries the .git of ANOTHER repository is refused (same path, different common git dir)", async () => {
  await fs.rm(wt, { recursive: true });
  const outer = path.join(tmp, "outer"); await fs.mkdir(outer); git(["init", "-q", "-b", "main"], outer);
  await fs.mkdir(wt, { recursive: true });
  await fs.cp(path.join(outer, ".git"), path.join(wt, ".git"), { recursive: true });
  await assert.rejects(ensureWorktree(runOf()), /repo|worktree|not|branch/i);
});
