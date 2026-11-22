// A3a headless board writer (T-MWO2HE4FPJK): the command line, tests written before the code (red).
// Contract: mods/drover-tasks/bin/drover-headless is a POSIX sh launcher that finds node (PATH, DROVER_NODE_DIR, common dirs, version managers)
// and execs bin/drover-headless.mjs. Verbs: version|rev|tasks|projects --json; add|edit|note|move|archive|import|move-out and `project add`
// read ONE JSON object on stdin (the payload, op taken from the verb) and print the submit() result as JSON on stdout; `migrate-in --from <file>`.
// Exit codes: 0 ok, 1 refused ({ok:false, code, error}), 2 usage, 69 E_NODE_NOT_FOUND (stderr). The board dir is $DROVER_BOARD_DIR.
// Everything here runs on this machine in temp dirs: no hc --on, no ssh, no real home.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = path.join(REPO, "mods/drover-tasks/bin/drover-headless");
const NOW = () => Date.now();
const cleanup = [];
afterEach(() => { for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hcli-")); cleanup.push(d); return d; };

let seq = 0;
const payload = (fields = {}) => ({ nonce: `cli-${String(++seq).padStart(8, "0")}`, issuedAt: NOW(), ttlMs: 60000, ...fields });
const run = (dir, args, input, env = {}) => spawnSync(LAUNCHER, args, { input: input === undefined ? "" : JSON.stringify(input), encoding: "utf8", env: { ...process.env, DROVER_BOARD_DIR: dir, ...env } });
const json = (r) => { try { return JSON.parse(r.stdout); } catch { assert.fail(`stdout is not JSON (exit ${r.status}): ${r.stdout} / ${r.stderr}`); } };
const good = (r) => { assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout} ${r.stderr}`); const j = json(r); assert.equal(j.ok, true, r.stdout); return j; };

test("version --json answers the cli name, the schema and the ops", () => {
  const j = json(run(tmp(), ["version", "--json"]));
  assert.equal(j.cli, "drover-headless");
  assert.equal(j.schema, 1);
  assert.deepEqual([...j.ops].sort(), ["add", "archive", "edit", "import", "move", "move-out", "note", "project-add"]);
});

test("every write verb round-trips through stdin and the read verbs see the result", () => {
  const dir = tmp();
  const added = good(run(dir, ["add"], payload({ title: "from the cli", priority: "P1" })));
  const id = added.result.id;
  assert.match(id, /^T-/);
  good(run(dir, ["note"], payload({ id, text: "a note", kind: "log", by: "tester" })));
  good(run(dir, ["edit"], payload({ id, title: "renamed" })));
  good(run(dir, ["move"], payload({ id, column: "ready" })));
  const tasks = json(run(dir, ["tasks", "--json"]));
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].title, "renamed");
  assert.equal(tasks.tasks[0].column, "todo");
  assert.equal(tasks.tasks[0].notes.length, 1);
  const rev = json(run(dir, ["rev", "--json"]));
  assert.equal(rev.tasks, tasks.rev);
  good(run(dir, ["archive"], payload({ id })));
  assert.equal(json(run(dir, ["tasks", "--json"])).tasks[0].archived, true);
  const imp = good(run(dir, ["import"], payload({ movedFrom: "elsewhere-1", task: { title: "imported", desc: "", tags: [], priority: "P2", column: "backlog", notes: [{ at: 1, by: "x", text: "carried" }] } })));
  assert.match(imp.result.id, /^T-/);
  const live = json(run(dir, ["tasks", "--json"])).tasks.find((t) => t.title === "imported");
  assert.equal(live.notes[0].text, "carried");
  const out = good(run(dir, ["move-out"], payload({ id: live.id, ifRev: live.rev ?? 0 })));
  assert.equal(out.result.task.movedOut, true);
});

test("REVIEW 4: `project add` is the spelling; `projects --json` lists; `project-add` is not a verb", () => {
  const dir = tmp();
  const r = good(run(dir, ["project", "add"], payload({ name: "Alpha", repo: "/some/repo", branch: "main" })));
  assert.equal(r.result.name, "Alpha");
  const list = json(run(dir, ["projects", "--json"]));
  assert.deepEqual(list.projects.map((p) => p.name), ["Alpha"]);
  const bad = run(dir, ["project-add"], payload({ name: "Beta", repo: "/some/repo" }));
  assert.equal(bad.status, 2, "the internal op name is not a verb");
  assert.deepEqual(json(run(dir, ["projects", "--json"])).projects.length, 1);
  assert.equal(run(dir, ["project"], payload({})).status, 2, "`project` alone is a usage error");
});

test("a refusal exits 1 with {ok:false, code, error}; a usage error exits 2; the payload is never read from argv", () => {
  const dir = tmp();
  const refused = run(dir, ["note"], payload({ id: "T-NOPE", text: "x" }));
  assert.equal(refused.status, 1);
  const j = json(refused);
  assert.equal(j.ok, false);
  assert.ok(j.code && j.error);
  assert.equal(run(dir, ["frobnicate"]).status, 2);
  const inArgv = run(dir, ["add", JSON.stringify(payload({ title: "in argv" }))], payload({ title: "from stdin" }));
  assert.equal(inArgv.status, 2, "an extra argument that looks like a payload is a usage error");
  assert.equal(json(run(dir, ["tasks", "--json"])).tasks.length, 0, "nothing was written");
  const notJson = spawnSync(LAUNCHER, ["add"], { input: "{nope", encoding: "utf8", env: { ...process.env, DROVER_BOARD_DIR: dir } });
  assert.equal(notJson.status, 1);
  assert.equal(JSON.parse(notJson.stdout).code, "bad-envelope");
  assert.equal(run(dir, ["add"], payload({ title: "x", op: "move" })).status, 1, "a payload op that contradicts the verb is refused");
});

test("the same payload sent twice answers the stored result (retry over a dropped connection)", () => {
  const dir = tmp();
  const p = payload({ title: "once" });
  const a = good(run(dir, ["add"], p));
  const b = good(run(dir, ["add"], p));
  assert.equal(b.replayed, true);
  assert.equal(b.result.id, a.result.id);
  assert.equal(json(run(dir, ["tasks", "--json"])).tasks.length, 1);
});

test("migrate-in --from <file> copies ids and names from an old shared.json (path in argv, no payload)", () => {
  const dir = tmp();
  const from = path.join(tmp(), "shared.json");
  fs.writeFileSync(from, JSON.stringify({ "drover.tasks": [{ id: "T-OLD", title: "old", column: "todo", priority: "P2", tags: [], archived: false, agent: null, notes: [], source: null, created: 1, updated: 1 }], "drover.projects": [], "drover.agents": { agents: [{ id: "a1", name: "A one" }], squads: [] } }));
  const r = good(run(dir, ["migrate-in", "--from", from]));
  assert.equal(r.copied.tasks, 1);
  assert.equal(r.copied.agents, 1);
  assert.equal(json(run(dir, ["tasks", "--json"])).tasks[0].id, "T-OLD");
  assert.equal(run(dir, ["migrate-in"]).status, 2, "--from is required");
});

// ---------------------------------------------------------------------------------------------------------- the launcher finds node
const TOOLS = ["sh", "mktemp", "rm", "head", "sleep", "kill", "pkill", "awk", "sort", "uname", "cat", "dirname", "basename", "env", "printf", "tr", "sed", "grep", "wc", "ls", "mkdir", "readlink", "pwd", "true", "test", "expr"];
const toolbin = () => {
  const d = tmp();
  for (const t of TOOLS) {
    const r = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" });
    const p = r.stdout.trim();
    if (p.startsWith("/") && !/\/node$/.test(p)) try { fs.symlinkSync(p, path.join(d, t)); } catch {}
  }
  return d;
};
const fakeNode = (file, version = "v20.1.0") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in --version) echo ${version} ;; *) echo "FAKE_NODE_RAN $*" ;; esac\n`);
  fs.chmodSync(file, 0o755);
};
const bare = (home, extra = {}) => ({ PATH: toolbin(), HOME: home, DROVER_FIND_SYSTEM_DIRS: "", ...extra }); // no inherited env: no node reachable unless a test puts one there

test("no node reachable (PATH and DROVER_FIND_SYSTEM_DIRS empty of node, empty home): exit 69 with E_NODE_NOT_FOUND on stderr and nothing on stdout", () => {
  const r = spawnSync(LAUNCHER, ["version", "--json"], { encoding: "utf8", env: bare(tmp()) });
  assert.equal(r.status, 69, `${r.stdout} ${r.stderr}`);
  assert.match(r.stderr, /E_NODE_NOT_FOUND/);
  assert.equal(r.stdout, "");
});

test("a node under a version-manager-style tree is found and run with the entry script and the arguments", () => {
  const home = tmp();
  fakeNode(path.join(home, ".nvm/versions/node/v20.1.0/bin/node"));
  const r = spawnSync(LAUNCHER, ["version", "--json"], { encoding: "utf8", env: bare(home) });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /FAKE_NODE_RAN .*drover-headless\.mjs version --json/);
});

test("a configured dir (DROVER_NODE_DIR) is found, and a node on PATH comes first", () => {
  const home = tmp();
  const cfg = tmp();
  fakeNode(path.join(cfg, "node"), "v18.0.0");
  const viaCfg = spawnSync(LAUNCHER, ["rev", "--json"], { encoding: "utf8", env: bare(home, { DROVER_NODE_DIR: cfg }) });
  assert.equal(viaCfg.status, 0, `${viaCfg.stdout} ${viaCfg.stderr}`);
  assert.match(viaCfg.stdout, /FAKE_NODE_RAN/);
  const onPath = tmp();
  fs.writeFileSync(path.join(onPath, "node"), `#!/bin/sh\ncase "$1" in --version) echo v22.0.0 ;; *) echo "PATH_NODE_RAN $*" ;; esac\n`);
  fs.chmodSync(path.join(onPath, "node"), 0o755);
  const e = bare(home, { DROVER_NODE_DIR: cfg });
  e.PATH = `${e.PATH}:${onPath}`;
  const first = spawnSync(LAUNCHER, ["rev", "--json"], { encoding: "utf8", env: e });
  assert.match(first.stdout, /PATH_NODE_RAN/);
});

// ---------------------------------------------------------------------------------------------------------- review 1, finding 1
test("REVIEW-1 F1: a reply larger than the pipe buffer arrives whole (the entry finishes the stdout write before it exits)", () => {
  const dir = tmp();
  const desc = "x".repeat(300000);
  good(run(dir, ["add"], payload({ title: "big", desc })));
  const r = run(dir, ["tasks", "--json"]);
  assert.equal(r.status, 0);
  const j = json(r);
  assert.equal(j.tasks[0].desc.length, 300000);
});

// T-MWO3AW7QXPA: the headless writer infers the parent's project too.
test("add with a parent and no project takes the parent's project; an explicit other project is refused", () => {
  const dir = tmp();
  const a = good(run(dir, ["project", "add"], payload({ name: "Alpha", repo: "/some/repo", branch: "main" }))).result.id;
  good(run(dir, ["project", "add"], payload({ name: "Beta", repo: "/other/repo", branch: "main" })));
  const parent = good(run(dir, ["add"], payload({ title: "parent", project: "Alpha" }))).result.id;
  const kid = good(run(dir, ["add"], payload({ title: "kid", parent }))).result.id;
  const tasks = json(run(dir, ["tasks", "--json"])).tasks;
  assert.equal(tasks.find((t) => t.id === kid).project, a);
  assert.equal(tasks.find((t) => t.id === kid).parent, parent);
  const bad = run(dir, ["add"], payload({ title: "kid2", parent, project: "Beta" }));
  assert.equal(bad.status, 1);
  assert.match(json(bad).error, /Parent .* is in project Alpha/);
});
