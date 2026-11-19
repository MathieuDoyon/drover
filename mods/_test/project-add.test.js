// Inbox op project-add: a headless Drover gets a project through the inbox (T-MWHVWQAOV5B). Real git on temp repos; no timing waits.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const IO = await import("../_lib/io.js");
const PKEY = "drover.projects";

let home, inbox, host, gitCalls, hold;
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const mkRepo = ({ commit = true, branch = "master" } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "padd-repo-"));
  git(dir, "init", "-q", "-b", branch);
  if (commit) git(dir, "commit", "-q", "--allow-empty", "-m", "c");
  return dir;
};
const snapshot = (dir) => JSON.stringify({ head: git(dir, "rev-parse", "--git-dir").stdout, refs: git(dir, "for-each-ref").stdout, st: git(dir, "status", "--porcelain").stdout, sym: git(dir, "symbolic-ref", "HEAD").stdout, tree: readdirSync(dir) });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "padd-home-"));
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  gitCalls = [];
  hold = null; // a promise the git calls wait for, set by a race test
  host = globalThis.__host = { appHome: home, props: {}, notified: [], state: {}, agents: [], terminals: [], watchFolder: () => new Promise(() => {}) };
  host.exec = (cmd, args) => new Promise((resolve) => {
    if (cmd !== "stat") gitCalls.push([cmd, ...args]); // the inbox's mtime lookup (protocol 2) is not a Git call, and a race test's hold must not stall it
    const run = () => execFile(cmd, args, { encoding: "utf8" }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }));
    hold && cmd !== "stat" ? hold.then(run) : run();
  });
});

const projects = () => host.state[PKEY] ?? [];
const startLoop = () => { const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) }; IO.watchInbox(cx); };
const drop = (name, cmd) => writeFileSync(join(inbox, `${name}.json`), JSON.stringify(cmd));
const answer = (name) => until(() => existsSync(join(inbox, `${name}.result`)) && readFileSync(join(inbox, `${name}.result`), "utf8"), `the inbox answered ${name}`);
let n = 0;
const send = async (cmd) => { const name = `r${++n}`; drop(name, { op: "project-add", ...cmd }); startLoop(); return answer(name); };

test("a. valid add: project created, the repo is the default, the id is returned", async () => {
  const repo = mkRepo();
  const reply = await send({ name: "multi", repo, folders: ["/data/a"] });
  assert.equal(projects().length, 1);
  const p = projects()[0];
  assert.equal(reply, `ok: ${p.id} project multi`);
  assert.match(p.id, /^P-/);
  assert.deepEqual(p.repos, [{ path: repo, default: true }]);
  assert.deepEqual(p.folders, ["/data/a"]);
  assert.equal(p.branch, "master", "no --branch: the repo's own branch (symbolic-ref)");
});

test("b. idempotent only on equality of the whole normalized request; any difference is an error that names it and changes nothing", async () => {
  const repo = mkRepo(), other = mkRepo();
  git(repo, "branch", "dev");
  const first = await send({ name: "multi", repo, folders: ["/a", "/b"] });
  const id = projects()[0].id;
  assert.equal(await send({ name: "multi", repo, folders: ["/b", "/a"] }), `ok: ${id} exists`);
  assert.equal(await send({ name: "MULTI", repo, folders: ["/a", "/b"], branch: "master" }), `ok: ${id} exists`, "an explicit branch equal to the stored one is the same request");
  const before = JSON.stringify(projects());
  for (const [diff, over] of [["repo", { repo: other }], ["branch", { branch: "dev" }], ["folders", { folders: ["/a"] }]]) {
    const r = await send({ name: "multi", repo, folders: ["/a", "/b"], ...over });
    assert.match(r, /^error: /, diff);
    assert.ok(r.includes(diff), `names ${diff}: ${r}`);
    assert.equal(JSON.stringify(projects()), before, "nothing changed");
  }
  assert.match(first, /^ok: P-\S+ project multi$/);
});

test("c. consumer-side validation: nothing is written, git never runs for a bad shape", async () => {
  const repo = mkRepo();
  const bad = [
    { name: "", repo }, { name: "a\nb", repo }, { name: "a\0b", repo }, { name: "multi\n", repo }, { name: "\nmulti", repo }, { name: "multi\r", repo }, { name: "\rmulti", repo }, { name: "x".repeat(201), repo },
    { name: "p", repo: "relative/dir" }, { name: "p", repo: repo + "\n" }, { name: "p", repo, folders: ["rel"] },
    { name: "p", repo, folders: Array.from({ length: 21 }, (_, i) => `/f${i}`) }, { name: "p", repo, folders: ["/" + "x".repeat(4096)] },
    { name: "p", repo, branch: "-x" }, { name: "p", repo, branch: "a b" }, { name: "p", repo, branch: "a..b" }, { name: "p", repo, branch: "x.lock" }, { name: "p", repo, branch: "@{-1}" },
  ];
  for (const cmd of bad) { const r = await send(cmd); assert.match(r, /^error: /, JSON.stringify(cmd).slice(0, 80)); assert.doesNotMatch(r, /Unknown drover command/); }
  assert.deepEqual(projects(), []);
  assert.ok(!gitCalls.some((c) => c.includes("-x") && c.includes("rev-parse")), "a refused branch never reaches rev-parse");
});

test("c. the branch check is Git's own, an argv call (check-ref-format --branch)", async () => {
  const repo = mkRepo();
  assert.match(await send({ name: "p", repo, branch: "feature/ok" }), /^error: /, "valid ref but absent in a committed repo");
  assert.deepEqual(gitCalls.find((c) => c.includes("check-ref-format")), ["git", "check-ref-format", "--branch", "feature/ok"]);
  assert.ok(gitCalls.every((c) => c[0] === "git" && Array.isArray(c)), "argv only, never a shell string");
});

test("d. the repo must be a git repository on this machine: a missing path or a plain folder is an error", async () => {
  const plain = mkdtempSync(join(tmpdir(), "padd-plain-"));
  assert.match(await send({ name: "p", repo: plain }), /^error: .*not a git repository/i);
  assert.match(await send({ name: "p", repo: join(plain, "nope") }), /^error: /);
  assert.deepEqual(projects(), []);
  const gc = gitCalls.find((c) => c.includes("rev-parse") && c.includes("--git-dir"));
  assert.deepEqual(gc, ["git", "-C", plain, "rev-parse", "--git-dir"]);
});

test("e(i). unborn HEAD (no commit, branch master): accepted with the warning; no commit or other change in the repo", async () => {
  const repo = mkRepo({ commit: false });
  const before = snapshot(repo);
  const r = await send({ name: "multi", repo });
  assert.match(r, /^ok: P-\S+ project multi/);
  assert.ok(r.includes("no commit yet; the first start needs one"), r);
  assert.equal(projects()[0].branch, "master", "never rejected for a missing main");
  assert.equal(snapshot(repo), before, "the repo is untouched");
  assert.equal(git(repo, "rev-parse", "--verify", "-q", "HEAD").status, 1, "still no commit");
  const id = projects()[0].id;
  assert.equal(await send({ name: "multi", repo }), `ok: ${id} exists`, "re-run: same request, no warning");
});

test("e(ii). a committed repo with --branch omitted: the current branch; a detached HEAD gives main", async () => {
  const repo = mkRepo({ branch: "trunk" });
  assert.match(await send({ name: "a", repo }), /^ok: /);
  assert.equal(projects()[0].branch, "trunk");
  assert.deepEqual(gitCalls.find((c) => c.includes("symbolic-ref")), ["git", "-C", repo, "symbolic-ref", "--short", "HEAD"]);
  git(repo, "checkout", "-q", "--detach");
  assert.match(await send({ name: "b", repo }), /^ok: /);
  assert.equal(projects()[1].branch, "main");
});

test("e(iii). an explicit --branch that does not exist in a committed repo is an error; an existing one is accepted", async () => {
  const repo = mkRepo();
  git(repo, "branch", "release");
  assert.match(await send({ name: "p", repo, branch: "nope" }), /^error: .*nope/);
  assert.deepEqual(projects(), []);
  assert.match(await send({ name: "p", repo, branch: "release" }), /^ok: /);
  assert.equal(projects()[0].branch, "release");
  assert.deepEqual(gitCalls.find((c) => c.includes("--verify") && c.includes("refs/heads/nope")), ["git", "-C", repo, "rev-parse", "--verify", "refs/heads/nope"]);
});

test("e(iv). an explicit --branch in an unborn repo is accepted only if it is the unborn branch name", async () => {
  const repo = mkRepo({ commit: false });
  assert.match(await send({ name: "p", repo, branch: "main" }), /^error: .*master/);
  assert.deepEqual(projects(), []);
  const r = await send({ name: "p", repo, branch: "master" });
  assert.match(r, /^ok: .*no commit yet; the first start needs one/);
  assert.equal(projects()[0].branch, "master");
});

test("f. race: two distinct inbox files for one new name: exactly one project, the other answers error", async () => {
  const r1 = mkRepo(), r2 = mkRepo();
  let release; hold = new Promise((r) => { release = r; });
  drop("race-a", { op: "project-add", name: "same", repo: r1 });
  drop("race-b", { op: "project-add", name: "same", repo: r2 });
  startLoop(); startLoop(); // two open mods, each draining
  await until(() => gitCalls.length >= 2, "both requests are inside their Git checks");
  assert.deepEqual(projects(), [], "nothing written before the checks finish");
  release();
  const [a, b] = await Promise.all([answer("race-a"), answer("race-b")]);
  assert.equal(projects().length, 1);
  assert.deepEqual([a, b].filter((x) => x.startsWith("ok: ")).length, 1);
  assert.equal([a, b].filter((x) => x.startsWith("error: ")).length, 1);
});

test("f. race: two identical requests: one created, the other is the same project (exists)", async () => {
  const repo = mkRepo();
  let release; hold = new Promise((r) => { release = r; });
  drop("same-a", { op: "project-add", name: "same", repo });
  drop("same-b", { op: "project-add", name: "same", repo });
  startLoop(); startLoop();
  await until(() => gitCalls.length >= 2, "both inside the checks");
  release();
  const out = await Promise.all([answer("same-a"), answer("same-b")]);
  assert.equal(projects().length, 1);
  assert.equal(out.filter((x) => /project same$/.test(x)).length, 1, out.join(" | "));
  assert.equal(out.filter((x) => x === `ok: ${projects()[0].id} exists`).length, 1, out.join(" | "));
});

test("f. a project the Projects dialog creates between the checks and the commit is neither overwritten nor duplicated", async () => {
  const repo = mkRepo(), other = mkRepo();
  const dialog = { id: "P-DIALOG", name: "Multi", repos: [{ path: other, default: true }], folders: [], branch: "main", created: 1 };
  let release; hold = new Promise((r) => { release = r; });
  drop("dlg", { op: "project-add", name: "multi", repo });
  startLoop();
  await until(() => gitCalls.length >= 1, "the request is inside its Git checks");
  host.state[PKEY] = [dialog]; // the dialog saves now
  release();
  const r = await answer("dlg");
  assert.match(r, /^error: .*repo/, r);
  assert.deepEqual(projects(), [dialog], "the dialog's project is intact, no duplicate");
  // and the same race where the dialog made the identical project: the request is idempotent on it
  host.state[PKEY] = [];
  const same = { ...dialog, id: "P-SAME", repos: [{ path: repo, default: true }], branch: "master" };
  hold = new Promise((r) => { release = r; });
  const before = gitCalls.length;
  drop("dlg2", { op: "project-add", name: "multi", repo });
  startLoop();
  await until(() => gitCalls.length > before, "second request inside its checks");
  host.state[PKEY] = [same];
  release();
  assert.equal(await answer("dlg2"), "ok: P-SAME exists");
  assert.deepEqual(projects(), [same]);
});

test("g. the store's own fallback: an op it does not know, with no task id, answers Unknown drover command (what a consumer without project-add replies)", async () => {
  const { applyCommand } = await import("../_lib/store.js");
  assert.deepEqual(applyCommand([], { op: "project-add", name: "n", repo: "/r", folders: [] }), { error: "Unknown drover command" });
});

test("g. the drover CLI usage and `drover projects` mention `project add`; it sends the op with repeatable --folder", () => {
  const bin = new URL("../drover-tasks/bin/drover", import.meta.url).pathname;
  const run = (args, env = {}) => spawnSync(bin, args, { env: { ...process.env, HERDR_APP_HOME: home, ...env }, encoding: "utf8" });
  assert.match(run([]).stderr, /drover project add "<name>" --repo <abs path>/);
  writeFileSync(join(home, "shared.json"), JSON.stringify({ "drover.projects": [] }));
  assert.match(run(["projects"]).stderr + run(["projects"]).stdout, /drover project add/, "the empty list hints at the verb");
  // The CLI waits for a .result: a helper answers it, and we read the request file.
  const child = spawnSync("bash", ["-c", `
    ( for i in $(seq 100); do f=$(ls "$HERDR_APP_HOME"/data/drover-inbox/*.json 2>/dev/null | head -1); if [ -n "$f" ]; then cp "$f" "$HERDR_APP_HOME/req.json"; echo "ok: P-X project t" > "\${f%.json}.result"; break; fi; sleep 0.1; done ) &
    ${bin} project add "my proj" --repo /abs/repo --branch dev --folder /f1 --folder /f2; wait`, ], { env: { ...process.env, HERDR_APP_HOME: home }, encoding: "utf8" });
  assert.equal(child.stdout.trim(), "ok: P-X project t");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "req.json"), "utf8")), { op: "project-add", name: "my proj", repo: "/abs/repo", branch: "dev", folders: ["/f1", "/f2"] });
  assert.equal(run(["project", "add", "x"]).status, 2, "--repo is required");
  assert.equal(run(["project", "add", "x", "--repo", "rel"]).status, 2, "a relative repo is refused by the CLI too");
});

test("g. the op is not in any laptop remote whitelist (nothing sends it remotely)", () => {
  const out = spawnSync("grep", ["-rln", "project-add", new URL("..", import.meta.url).pathname, "--include=*.js", "--exclude=*.test.js"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  assert.deepEqual(out.map((f) => f.split("/mods/")[1]).filter((f) => !/^(_lib\/(io|store)\.js|drover-[a-z]+\/(io|store)\.js)$/.test(f)), []);
});

test("h. org on the inbox is refused (never silently dropped); nothing is written; an org-bound project's org-less replay stays idempotent", async () => {
  const repo = mkRepo();
  for (const org of ["acme", "Bad Slug", ""]) {
    const r = await send({ name: "multi", repo, org });
    assert.match(r, /^error: .*org/i, JSON.stringify(org));
  }
  assert.deepEqual(projects(), []);
  const first = await send({ name: "multi", repo });
  const id = projects()[0].id;
  assert.match(first, /^ok: P-\S+ project multi$/);
  host.state[PKEY] = projects().map((p) => ({ ...p, org: "acme" }));
  assert.equal(await send({ name: "multi", repo }), `ok: ${id} exists`);
  assert.match(await send({ name: "multi", repo, org: "acme" }), /^error: .*org/i);
  assert.equal(projects()[0].org, "acme");
});
