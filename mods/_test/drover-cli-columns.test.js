// T-MWIAJZZVPEL: the drover CLI names columns like the board (ready, in-progress); the stored ids (todo, doing) stay valid input and stay on the wire.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
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
// DROVER_WRITE_WAIT=0: no mod answers here, so the write commands must not poll for an answer (the default is a 5 s poll per call).
const cli = (args, env = {}) => new Promise((resolve) => execFile("bash", [CLI, ...args], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, DROVER_WRITE_WAIT: "0", ...env } }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
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
// The request one CLI call queued, found by the file names it added: inbox files are <epoch>-<pid>.json, so directory order is neither call order nor time order.
const inboxNames = () => readdirSync(join(home, "data/drover-inbox")).filter((f) => f.endsWith(".json"));
const sentBy = async (args) => {
  const before = new Set(inboxNames());
  const r = await cli(args);
  const added = inboxNames().filter((f) => !before.has(f));
  return { r, added, request: added.length === 1 ? JSON.parse(readFileSync(join(home, "data/drover-inbox", added[0]), "utf8")) : null };
};

test("move: canonical, legacy and case variants all put the stored id on the wire", async () => {
  for (const [input, id] of CASES) {
    const { r, added, request } = await sentBy(["move", "T-C0", input]);
    assert.equal(r.code, 0, `${input}: ${r.stderr}`);
    assert.equal(added.length, 1, input);
    assert.equal(request.column, id, input);
  }
});

test("the move lookup finds this call's request even when a stale file sorts after it", async () => {
  writeFileSync(join(home, "data/drover-inbox/9-99999.json"), JSON.stringify({ op: "move", id: "T-OLD", column: "done" })); // sorts after every <epoch>-<pid>.json
  const { added, request } = await sentBy(["move", "T-C0", "in-progress"]);
  assert.equal(added.length, 1);
  assert.equal(request.id, "T-C0");
  assert.equal(request.column, "doing");
  assert.equal(queued().at(-1).column, "done", "the stale file does come last in directory order: an at(-1) lookup would have picked it");
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

// DROVER_WRITE_WAIT: milliseconds, a whole number in [0, 5000], polled every 250 ms (ceil). Anything else keeps the 5 s default = 20 polls.
// A `sleep` shim first on PATH logs its argument and returns at once, so the poll count is observable without waiting and without a clock.
const sleepCalls = (extraEnv, args) => {
  const shim = mkdtempSync(join(tmpdir(), "csleep-"));
  const log = join(shim, "calls.log");
  writeFileSync(join(shim, "sleep"), `#!/bin/sh\necho "$@" >> '${log}'\n`);
  chmodSync(join(shim, "sleep"), 0o755);
  const env = { PATH: `${shim}:${process.env.PATH}`, ...extraEnv };
  return cli(args, env).then((r) => ({ r, calls: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [] }));
};
const unsetWait = { DROVER_WRITE_WAIT: undefined };

test("DROVER_WRITE_WAIT unset, empty or invalid keeps the 5 s default: 20 polls of 0.25, then queued", async () => {
  const cases = [unsetWait, { DROVER_WRITE_WAIT: "" }, ...["abc", "-1", "1.5", "5001", "99999999999999999999", "x500", "500x", " 500", "1e3"].map((v) => ({ DROVER_WRITE_WAIT: v }))];
  for (const env of cases) {
    const label = JSON.stringify(env.DROVER_WRITE_WAIT ?? "unset");
    for (const args of [["move", "T-C0", "ready"], ["add", "plain"]]) {
      const before = queued().length;
      const { r, calls } = await sleepCalls(env, args);
      assert.equal(r.code, 0, `${label} ${args[0]}: ${r.stderr}`);
      assert.match(r.stdout, /^queued: no Drover Tasks, Board or Wakeups mod is open; it applies when one opens$/m, `${label} ${args[0]}`);
      assert.equal(queued().length, before + 1, `${label} ${args[0]}`);
      assert.deepEqual(calls, Array(20).fill("0.25"), `${label} ${args[0]}`);
    }
  }
});

test("DROVER_WRITE_WAIT 0 polls nothing; N ms polls ceil(N/250) times; 5000 is the 20-poll default", async () => {
  for (const [v, polls] of [["0", 0], ["00", 0], ["1", 1], ["250", 1], ["251", 2], ["500", 2], ["0500", 2], ["5000", 20]]) {
    for (const args of [["move", "T-C0", "ready"], ["add", "plain"]]) {
      const before = queued().length;
      const { r, calls } = await sleepCalls({ DROVER_WRITE_WAIT: v }, args);
      assert.equal(r.code, 0, `${v} ${args[0]}: ${r.stderr}`);
      assert.match(r.stdout, /^queued: /m, `${v} ${args[0]}`);
      assert.equal(queued().length, before + 1, `${v} ${args[0]}`);
      assert.deepEqual(calls, Array(polls).fill("0.25"), `${v} ${args[0]}`);
    }
  }
});

// Only move/add use the DROVER_WRITE_WAIT loop. Every other caller of send() keeps its legacy `seq` loop, whatever `seq 0` does on this platform
// (BSD seq counts down and yields two lines, GNU seq none): the expected count is computed here from the same `seq`, not hardcoded.
test("other send() callers keep the legacy seq loop: DROVER_RESUME_WAIT=0 polls exactly as many times as `seq 0` has lines", async () => {
  const legacy = execFileSync("seq", ["0"], { encoding: "utf8" }).split("\n").filter(Boolean).length;
  const { r, calls } = await sleepCalls({ DROVER_RESUME_WAIT: "0", DROVER_WRITE_WAIT: "5000" }, ["resume", "T-C0"]);
  assert.match(r.stdout, /^queued: /m, r.stderr);
  assert.deepEqual(calls, Array(legacy).fill("0.25"));
});
