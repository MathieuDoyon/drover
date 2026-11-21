// B7: the cache refreshes OUTSIDE render and reports a change only when the result changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJumpCache } from "../_lib/jump.js";

const mk = () => {
  const w = { tasks: [{ id: "T-1", title: "Fix login", column: "todo", agent: null }], runs: [], projects: [{ id: "P-1", name: "Alpha" }], agents: [], terminals: [] };
  return { w, cache: createJumpCache({ read: () => w }) };
};

test("before the first refresh the value is empty, never a read", () => {
  let reads = 0;
  const cache = createJumpCache({ read: () => { reads++; return {}; } });
  assert.deepEqual([...cache.get().index], []);
  assert.deepEqual([...cache.get().results], []);
  assert.equal(reads, 0);
});

test("an unchanged snapshot: refresh() returns false", () => {
  const { cache } = mk();
  assert.equal(cache.refresh(), true);
  assert.equal(cache.refresh(), false);
  assert.equal(cache.refresh(), false);
});

test("a card title change updates index and results", () => {
  const { w, cache } = mk();
  cache.refresh();
  cache.setQuery("login");
  assert.equal(cache.get().results.length, 1);
  w.tasks = [{ ...w.tasks[0], title: "Fix signup" }];
  assert.equal(cache.refresh(), true);
  assert.equal(cache.get().results.length, 0, "the current query is re-filtered by refresh");
  cache.setQuery("signup");
  assert.equal(cache.get().results[0].label, "Fix signup");
});

test("an agent going live, a new run and a project rename each change the result", () => {
  const { w, cache } = mk();
  cache.refresh();
  w.runs = [{ id: "R-1", task: "T-1", title: "", terminals: [{ address: "t5", role: "leader" }] }];
  assert.equal(cache.refresh(), true);
  w.terminals = [{ address: "t5" }];
  assert.equal(cache.refresh(), true, "terminal alive: run status changes");
  w.agents = [{ address: "t5", status: "working" }];
  assert.equal(cache.refresh(), true, "status working");
  assert.match(cache.get().index.find((x) => x.kind === "run").sub, /working/);
  w.projects = [{ id: "P-1", name: "Beta" }];
  assert.equal(cache.refresh(), true);
  cache.setQuery("beta");
  assert.ok(cache.get().results.some((x) => x.kind === "project"));
});

test("a parked member (no status) is running while its terminal lives, ended once only the terminal is gone", () => {
  const { w, cache } = mk();
  w.runs = [{ id: "R-1", task: "T-1", title: "", terminals: [{ address: "t5", role: "leader" }] }];
  w.terminals = [{ address: "t5" }]; // no status anywhere
  cache.refresh();
  const sub = () => cache.get().index.find((x) => x.kind === "run").sub;
  assert.match(sub(), /stopped|running/);
  assert.doesNotMatch(sub(), /ended/);
  w.terminals = [];
  assert.equal(cache.refresh(), true);
  assert.match(sub(), /ended/);
});

test("get() returns the stored value and never computes; a refresh stores a NEW value", () => {
  const { w, cache } = mk();
  cache.refresh();
  const a = cache.get();
  assert.equal(cache.get(), a);
  w.tasks = [];
  cache.refresh();
  assert.notEqual(cache.get(), a);
  assert.equal(a.index.length, 2, "a reader holding the old value is safe");
});
