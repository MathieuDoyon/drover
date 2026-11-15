import { test } from "node:test";
import assert from "node:assert/strict";
import { add, addProject, claim, release, CLAIMING } from "./store.js";
import { reconcile, activeFor, claimTtl } from "./runs.js";

const { projects } = addProject([], { name: "A", repos: "/a" }, 1);
const A = projects[0].id;
const seed = (...cards) => cards.reduce((tasks, c, i) => add(tasks, { project: A, column: "todo", title: "c" + i, ...c }, 1000 + i).tasks, []);
const T0 = 1_000_000, TTL = claimTtl;
const run = (task, ...terms) => ({ id: "R-" + task, task, project: A, started: T0 + 5, terminals: terms.map((address) => ({ address, agent: "wrangler" })) });
const claimed = (now = T0) => { const tasks = seed({}); return claim(tasks, tasks[0].id, A, now, new Set()).tasks; };

test("claim stores claimedAt; release clears it", () => {
  const tasks = seed({});
  const c = claim(tasks, tasks[0].id, A, T0, new Set());
  assert.equal(c.task.claimedAt, T0);
  const r = release(c.tasks, tasks[0].id, c.prev, T0 + 1);
  assert.equal(r.tasks[0].claimedAt, null);
});

test("crash after claim: kept before the TTL, expired to todo after it (note, no relaunch)", () => {
  const tasks = claimed();
  const early = reconcile(tasks, [], new Set(), T0 + TTL - 1, A);
  assert.equal(early.tasks, tasks);
  assert.deepEqual(early.lines, []);
  const late = reconcile(tasks, [], new Set(), T0 + TTL + 1, A);
  const t = late.tasks[0];
  assert.equal(t.column, "todo");
  assert.equal(t.agent, null);
  assert.equal(t.claimedAt, null);
  assert.match(t.notes.at(-1).text, /launch did not finish \(claim expired\)/);
  assert.deepEqual(late.lines, [`expired ${t.id}`]);
});

test("a claim with no claimedAt (old card) expires at once", () => {
  const tasks = claimed().map((t) => ({ ...t, claimedAt: undefined }));
  assert.equal(reconcile(tasks, [], new Set(), T0, A).tasks[0].column, "todo");
});

test("expired claim frees the slot", () => {
  const tasks = claimed();
  assert.equal(activeFor([], tasks, A, new Map(), new Set()), 1);
  const after = reconcile(tasks, [], new Set(), T0 + TTL + 1, A).tasks;
  assert.equal(activeFor([], after, A, new Map(), new Set()), 0);
});

test("crash after run saved: claiming card with a run is adopted (leader = last terminal)", () => {
  const tasks = claimed(), id = tasks[0].id;
  const r = reconcile(tasks, [run(id, "t5", "t6")], new Set(["t5", "t6"]), T0 + 1, A);
  const t = r.tasks[0];
  assert.deepEqual([t.agent, t.run, t.column, t.claimedAt], ["t6", "R-" + id, "doing", null]);
  assert.deepEqual(r.lines, [`adopted ${id} R-${id}`]);
});

test("a retry claim does not adopt an older run of the same task", () => {
  const tasks = claimed(), id = tasks[0].id;
  const old = { ...run(id, "t5"), started: T0 - 10 };
  assert.deepEqual(reconcile(tasks, [old], new Set(), T0 + 1, A).lines, []);
  assert.equal(reconcile(tasks, [old], new Set(), T0 + TTL + 1, A).tasks[0].column, "todo");
});

test("dead run in doing: a line, no change", () => {
  const tasks = seed({ column: "doing" }).map((t) => ({ ...t, agent: "t6", run: "R-x" }));
  const id = tasks[0].id;
  const runs = [{ ...run(id, "t5", "t6"), id: "R-x" }];
  const r = reconcile(tasks, runs, new Set(), T0, A);
  assert.equal(r.tasks, tasks);
  assert.deepEqual(r.lines, [`dead ${id} R-x`]);
  assert.deepEqual(reconcile(tasks, runs, new Set(["t6"]), T0, A).lines, []); // still alive
});

test("archived or moved cards are not restored", () => {
  const tasks = claimed(), id = tasks[0].id, late = T0 + TTL + 1;
  const arch = tasks.map((t) => ({ ...t, archived: true }));
  assert.equal(reconcile(arch, [], new Set(), late, A).tasks, arch);
  assert.deepEqual(reconcile(arch, [run(id, "t5")], new Set(), late, A).lines, []);
  const moved = tasks.map((t) => ({ ...t, column: "backlog" }));
  const r = reconcile(moved, [], new Set(), late, A);
  assert.equal(r.tasks[0].column, "backlog");
  assert.equal(r.tasks[0].agent, null); // the stale claim is cleared, the column stays
  const m2 = reconcile(moved, [run(id, "t5")], new Set(), late, A);
  assert.equal(m2.tasks[0].column, "backlog");
  assert.equal(m2.tasks[0].agent, "t5");
});

test("other projects are untouched", () => {
  const tasks = claimed();
  assert.equal(reconcile(tasks, [], new Set(), T0 + TTL + 1, "P-other").tasks, tasks);
});

test("refill: after 1 run ends, the next report has exactly 1 slot more", () => {
  const tasks = seed({ column: "doing" }, { column: "doing" }).map((t, i) => ({ ...t, agent: "t" + i, run: "R" + i }));
  const runs = tasks.map((t, i) => ({ ...run(t.id, "t" + i), id: "R" + i }));
  const slots = (alive) => 2 - activeFor(runs, tasks, A, new Map(), new Set(alive));
  assert.equal(slots(["t0", "t1"]), 0);
  assert.equal(slots(["t1"]), 1);
});
