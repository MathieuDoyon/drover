// T-MWIAJZZVPEL: the drover CLI names columns like the board (ready, in-progress); the stored ids (todo, doing) stay valid input and stay on the wire.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMNS, columnName } from "../_lib/store.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../drover-tasks/bin/drover");
let home;
const task = (id, column, title) => ({ id, column, title, priority: "P2", tags: [] });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ccol-"));
  mkdirSync(join(home, "data/drover-inbox"), { recursive: true });
  writeFileSync(join(home, "shared.json"), JSON.stringify({ "drover.tasks": COLUMNS.map(([id], i) => task(`T-C${i}`, id, `in ${id}`)) }));
});
const cli = (args) => new Promise((resolve) => execFile("bash", [CLI, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home } }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
// What `drover move|add` put on the wire (no mod answers: the CLI queues and exits).
const queued = () => readdirSync(join(home, "data/drover-inbox")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(home, "data/drover-inbox", f), "utf8")));

test("tasks prints the board's column names, one per column", async () => {
  const r = await cli(["tasks"]);
  assert.equal(r.code, 0, r.stderr);
  for (const [id] of COLUMNS) assert.match(r.stdout, new RegExp(`^T-C\\d+  ${columnName(id)} +P2  in ${id}$`, "m"));
  assert.doesNotMatch(r.stdout, /  (todo|doing) /);
});

test("tasks <column> filters by canonical name, alias and stored id alike", async () => {
  for (const f of ["ready", "todo", "READY"]) assert.deepEqual((await cli(["tasks", f])).stdout.trim().split("\n").map((l) => l.split(" ")[0]), ["T-C1"], f);
  for (const f of ["in-progress", "doing", "in progress"]) assert.deepEqual((await cli(["tasks", f])).stdout.trim().split("\n").map((l) => l.split(" ")[0]), ["T-C2"], f);
});

test("task header shows the name", async () => {
  assert.match((await cli(["task", "T-C1"])).stdout, /^T-C1 \[ready\] P2 /);
  assert.match((await cli(["task", "T-C2"])).stdout, /^T-C2 \[in-progress\] P2 /);
});

const CASES = [["ready", "todo"], ["READY", "todo"], ["todo", "todo"], ["in-progress", "doing"], ["In-Progress", "doing"], ["in progress", "doing"], ["doing", "doing"], ["backlog", "backlog"], ["Review", "review"], ["blocked", "blocked"], ["done", "done"]];
const wire = () => queued().map((c) => c.column);

test("move: canonical, legacy and case variants all put the stored id on the wire", async () => {
  for (const [input, id] of CASES) {
    const before = wire().length;
    const r = await cli(["move", "T-C0", input]);
    assert.equal(r.code, 0, `${input}: ${r.stderr}`);
    assert.equal(wire().length, before + 1, input);
    assert.equal(queued().at(-1).column, id, input);
  }
});

test("add --column: same table, stored id on the wire; no --column keeps the backlog default", async () => {
  for (const [input, id] of CASES) {
    const r = await cli(["add", `t ${input}`, "--column", input]);
    assert.equal(r.code, 0, `${input}: ${r.stderr}`);
    assert.equal(queued().find((c) => c.op === "add" && c.title === `t ${input}`).column, id, input);
  }
  await cli(["add", "plain"]);
  assert.equal(queued().find((c) => c.title === "plain").column, "backlog");
});

test("invalid column: exit non-zero, a message listing the names, nothing written", async () => {
  for (const bad of ["nope", "in-progres", "", "readyy"]) {
    for (const args of [["move", "T-C0", bad], ["add", "x", "--column", bad]]) {
      const r = await cli(args);
      assert.notEqual(r.code, 0, args.join(" "));
      assert.match(r.stderr, /unknown column .*\(use backlog, ready, in-progress, review, blocked, done\)/);
    }
  }
  assert.deepEqual(queued(), []);
});

test("tags still filter, and a tag named like nothing matches only its cards", async () => {
  writeFileSync(join(home, "shared.json"), JSON.stringify({ "drover.tasks": [{ ...task("T-A", "doing", "a"), tags: ["epic"] }, task("T-B", "todo", "b")] }));
  assert.deepEqual((await cli(["tasks", "epic"])).stdout.trim().split("\n").map((l) => l.split(" ")[0]), ["T-A"]);
  assert.equal((await cli(["tasks", "#epic"])).stdout.includes("T-B"), false);
  assert.equal((await cli(["tasks", "nothing"])).stdout.trim(), "");
});

test("the CLI's column table equals store.js COLUMNS", async () => {
  const r = await cli(["tasks"]);
  const names = r.stdout.trim().split("\n").map((l) => l.split(/ +/)[1]);
  assert.deepEqual([...names].sort(), COLUMNS.map(([id]) => columnName(id)).sort());
});

test("usage lists the canonical names", async () => {
  const r = await cli([]);
  assert.match(r.stderr, /drover move <T-…> <backlog\|ready\|in-progress\|review\|blocked\|done>/);
  assert.match(r.stderr, /--column backlog\|ready\]/);
});
