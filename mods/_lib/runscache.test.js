// Runs screen cache (T-MWO2HFSB34T): everything the screen derives is computed in refresh(); get() only returns memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunsCache } from "./runscache.js";

const NOW = 50_000_000;
const MIN = 60000;
let clock;
const term = (address, o = {}) => ({ address, name: `n-${address}`, role: "leader", agent: "claude", started: NOW - 90 * MIN, ...o });
const run = (id, o = {}) => ({ id, task: `T-${id}`, project: "P-1", started: NOW - 90 * MIN, terminals: [term(`t${id}`)], ...o });
function world(init = {}) {
  const w = { runs: [run("1", { line: { text: "reading", progress: 20, at: NOW - 2 * MIN, by: "n" } })], tasks: [{ id: "T-1", title: "One", column: "doing", project: "P-1" }], projects: [{ id: "P-1", name: "Alpha" }],
    agents: [{ address: "t1", status: "working" }], terminals: [{ address: "t1" }], reads: 0, ...init };
  w.read = () => { w.reads++; return { runs: w.runs, tasks: w.tasks, projects: w.projects, agents: w.agents, terminals: w.terminals, resumeOf: w.resumeOf }; };
  clock = NOW;
  w.cache = createRunsCache({ read: w.read, now: () => clock });
  return w;
}
const first = (w) => w.cache.get().all[0];

test("get() never computes: it does not read and returns the stored empty value before the first refresh", () => {
  const w = world();
  assert.deepEqual([w.cache.get().all, w.cache.get().slotLines, w.cache.get().endedCount], [[], [], 0]);
  assert.equal(w.reads, 0);
  w.cache.refresh();
  assert.equal(w.reads, 1);
  w.cache.get(); w.cache.get();
  assert.equal(w.reads, 1);
});

test("an entry holds the status, title, slot state, member rows, the started text and the line view and label", () => {
  const w = world();
  w.cache.refresh();
  const e = first(w);
  assert.equal(e.status, "working");
  assert.equal(e.waiting, false);
  assert.equal(e.title, "T-1 One");
  assert.equal(e.startedText, "1h");
  assert.equal(e.task.column, "doing");
  assert.deepEqual(e.rows.map((m) => m.address), ["t1"]);
  assert.deepEqual(e.line, { text: "reading", progress: 20, ageMin: 2, stale: false });
  assert.equal(e.lineText, "reading · 20% · 2m");
  assert.deepEqual(w.cache.get().slotLines, ["Alpha: Slots 1/" + w.cache.get().limit]);
});

test("a run on a Review card is waiting; the slot line counts it", () => {
  const w = world({ tasks: [{ id: "T-1", title: "One", column: "review", project: "P-1" }] });
  w.cache.refresh();
  assert.equal(first(w).waiting, true);
  assert.match(w.cache.get().slotLines[0], /1 waiting/);
});

test("the line follows the Active test: no line on a stamped-ended run, none when the live state ended it, none without a line", () => {
  const w = world();
  w.cache.refresh();
  assert.ok(first(w).line);
  w.agents = []; w.terminals = [];
  assert.equal(w.cache.refresh(), true);
  assert.equal(first(w).status, "ended");
  assert.equal(first(w).line, null);
  assert.equal(first(w).lineText, "");
  const w2 = world({ runs: [run("1", { ended: NOW - 5, line: { text: "x", at: NOW } })] });
  w2.cache.refresh();
  assert.equal(first(w2).line, null);
  const w3 = world({ runs: [run("1")] });
  w3.cache.refresh();
  assert.equal(first(w3).line, null);
});

test("ended count and ended entries; resume info only when read() offers resumeOf, and only for ended runs", () => {
  const ended = run("2", { ended: NOW - MIN, terminals: [term("t2", { ended: NOW - MIN })] });
  const w = world({ runs: [run("1"), ended], resumeOf: (id) => ({ state: "none", can: id === "2" }) });
  w.cache.refresh();
  assert.equal(w.cache.get().endedCount, 1);
  const byId = Object.fromEntries(w.cache.get().all.map((e) => [e.r.id, e]));
  assert.equal(byId["1"].resume, null);
  assert.deepEqual(byId["2"].resume, { state: "none", can: true });
  const w2 = world({ runs: [ended] });
  w2.cache.refresh();
  assert.equal(w2.cache.get().all[0].resume, null);
});

test("refresh reports a change only when the displayed result changed", () => {
  const w = world();
  assert.equal(w.cache.refresh(), true);
  assert.equal(w.cache.refresh(), false);
  w.runs = [run("1", { line: { text: "second", at: NOW - 2 * MIN } })];
  assert.equal(w.cache.refresh(), true, "a replaced line");
  assert.equal(first(w).lineText, "second · 2m");
  w.agents = [{ address: "t1", status: "blocked" }];
  assert.equal(w.cache.refresh(), true, "live-only status change");
});

test("time: the minute and the stale boundary change the result; a second does not", () => {
  const w = world({ runs: [run("1", { line: { text: "a", at: NOW } })] });
  w.cache.refresh();
  clock = NOW + 20000; // durations round to the minute: 90m20s still reads 90m
  assert.equal(w.cache.refresh(), false);
  clock = NOW + 61000;
  assert.equal(w.cache.refresh(), true);
  assert.equal(first(w).line.ageMin, 1);
  clock = NOW + 10 * MIN;
  assert.equal(w.cache.refresh(), true);
  assert.equal(first(w).line.stale, true);
});

test("each refresh stores a new value: a reader holding the old one is safe", () => {
  const w = world();
  w.cache.refresh();
  const old = w.cache.get();
  w.runs = [];
  w.cache.refresh();
  assert.equal(old.all.length, 1);
  assert.equal(w.cache.get().all.length, 0);
});

test("signature: a run title or line text that looks like a delimiter cannot hide a change", () => {
  const w = world({ runs: [run("1", { line: { text: "a\",\"b", at: NOW } }), run("2", { line: { text: "c", at: NOW } })], tasks: [] });
  w.cache.refresh();
  w.runs = [run("1", { line: { text: "a", at: NOW } }), run("2", { line: { text: "b\",\"c", at: NOW } })];
  assert.equal(w.cache.refresh(), true);
});

test("the display lists are cached: active (not ended) and all, the same arrays on every get()", () => {
  const ended = run("2", { ended: NOW - MIN, terminals: [term("t2", { ended: NOW - MIN })] });
  const w = world({ runs: [run("1"), ended] });
  w.cache.refresh();
  const v = w.cache.get();
  assert.deepEqual(v.active.map((e) => e.r.id), ["1"]);
  assert.deepEqual(v.all.map((e) => e.r.id), ["1", "2"]);
  assert.equal(w.cache.get().active, v.active);
});
