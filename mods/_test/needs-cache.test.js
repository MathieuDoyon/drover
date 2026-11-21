// T-MWO2HFFHWRB: the needs cache is refreshed outside render; get() never computes; live-only changes update rows and signature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNeedsCache } from "../_lib/needs.js";

const T = (o) => ({ id: "T-1", title: "x", column: "doing", agent: "t9", archived: false, created: 1, priority: "P2", tags: [], ...o });
function world(init) {
  const w = { tasks: [T()], runs: [], agents: [], terminals: [], reads: 0, ...init };
  w.read = () => { w.reads++; return { tasks: w.tasks, runs: w.runs, agents: w.agents, terminals: w.terminals }; };
  return w;
}
const agent = (status, address = "t9") => ({ address, status });

test("get() never computes: it does not read and returns the stored value", () => {
  const w = world();
  const c = createNeedsCache({ read: w.read, now: () => 5 });
  assert.equal(w.reads, 0);
  const empty = c.get();
  assert.deepEqual(empty.counts, { needs: 0, review: 0, working: 0, todo: 0, blocked: 0 });
  assert.equal(w.reads, 0);
  c.refresh();
  assert.equal(w.reads, 1, "refresh reads each input once");
  c.get(); c.get(); c.get();
  assert.equal(w.reads, 1);
});

test("refresh returns true on the first real change, false when nothing changed", () => {
  const w = world({ agents: [agent("working")], terminals: [{ address: "t9" }] });
  const c = createNeedsCache({ read: w.read, now: () => 1 });
  assert.equal(c.refresh(), true);
  const sig = c.signature();
  assert.equal(c.refresh(), false);
  assert.equal(c.signature(), sig);
});

test("live-only working -> blocked -> working -> gone, tasks and runs unchanged", () => {
  const w = world({ agents: [agent("working")], terminals: [{ address: "t9" }] });
  const c = createNeedsCache({ read: w.read, now: () => 1 });
  c.refresh();
  assert.equal(c.get().rows.get("T-1").group, "working");
  assert.equal(c.get().counts.needs, 0);

  w.agents = [agent("blocked")];
  assert.equal(c.refresh(), true);
  assert.deepEqual([c.get().rows.get("T-1").group, c.get().rows.get("T-1").reason], ["needs", "Agent asks: open its terminal"]);
  assert.equal(c.get().counts.needs, 1);
  assert.deepEqual(c.get().byGroup.needs, ["T-1"]);

  w.agents = [agent("working")];
  assert.equal(c.refresh(), true);
  assert.equal(c.get().rows.get("T-1").group, "working");
  assert.equal(c.get().counts.needs, 0);

  w.agents = []; w.terminals = [];
  assert.equal(c.refresh(), true);
  assert.deepEqual([c.get().rows.get("T-1").group, c.get().rows.get("T-1").reason], ["needs", "Agent t9 is gone"]);
  assert.equal(c.get().counts.needs, 1);
});

test("a terminal that reports a status (parked, no pane agent) counts as live", () => {
  const w = world({ terminals: [{ address: "t9", status: "blocked" }] });
  const c = createNeedsCache({ read: w.read, now: () => 1 });
  c.refresh();
  assert.equal(c.get().rows.get("T-1").group, "needs");
});

test("a run-only change flips the review-live dot with tasks and live fixed", () => {
  const w = world({ tasks: [T({ column: "review", agent: null })], terminals: [{ address: "t5" }] });
  const c = createNeedsCache({ read: w.read, now: () => 1 });
  c.refresh();
  assert.equal(c.get().rows.get("T-1").dot, "review");
  const sig = c.signature();
  w.runs = [{ id: "R-1", task: "T-1", terminals: [{ address: "t5" }] }];
  assert.equal(c.refresh(), true);
  assert.equal(c.get().rows.get("T-1").dot, "review-live");
  assert.notEqual(c.signature(), sig);
  w.runs = [];
  assert.equal(c.refresh(), true);
  assert.equal(c.get().rows.get("T-1").dot, "review");
});

test("a task change (column moved) is picked up by the next refresh", () => {
  const w = world({ tasks: [T({ column: "todo", agent: null })] });
  const c = createNeedsCache({ read: w.read, now: () => 1 });
  c.refresh();
  assert.equal(c.get().counts.todo, 1);
  w.tasks = [T({ column: "doing", agent: "t9" })]; // its agent is gone
  assert.equal(c.refresh(), true);
  assert.deepEqual(c.get().counts, { needs: 1, review: 0, working: 0, todo: 0, blocked: 0 });
  w.tasks = [T({ column: "blocked", agent: null })]; // parked: not Needs you
  assert.equal(c.refresh(), true);
  assert.deepEqual(c.get().counts, { needs: 0, review: 0, working: 0, todo: 0, blocked: 1 });
});

test("the stored value is replaced, not mutated, so a reader holding the old one is safe", () => {
  const w = world({ agents: [agent("working")], terminals: [{ address: "t9" }] });
  const c = createNeedsCache({ read: w.read, now: () => 1 });
  c.refresh();
  const before = c.get();
  w.agents = [agent("blocked")];
  c.refresh();
  assert.equal(before.counts.needs, 0);
  assert.equal(c.get().counts.needs, 1);
});

test("the cache keys every card by board: byId holds both cards that share an id", async () => {
  const { cardKey } = await import("../_lib/needs.js");
  const local = T({ id: "T-X", title: "local", column: "todo", agent: null });
  const rem = T({ id: "T-X", title: "remote", column: "blocked", agent: null, remote: { machine: "box1", projectId: "P-9" } });
  const w = world({ tasks: [local, rem] });
  const c = createNeedsCache({ read: w.read, now: () => 1 });
  c.refresh();
  assert.equal(c.get().byId.size, 2);
  assert.equal(c.get().byId.get("T-X").title, "local");
  assert.equal(c.get().byId.get(cardKey(rem)).title, "remote");
  assert.deepEqual(c.get().counts, { needs: 0, review: 0, working: 0, todo: 1, blocked: 1 });
});
