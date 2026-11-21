// Run line (T-MWO2HFSB34T): the needs cache derives `lines` (cardKey -> view) outside render. Pure cache tests, as needs-cache.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNeedsCache, cardKey } from "../_lib/needs.js";

const T = (o) => ({ id: "T-1", title: "x", column: "doing", agent: "t9", archived: false, created: 1, priority: "P2", tags: [], ...o });
const NOW = 10_000_000;
let clock;
const run = (o = {}) => ({ id: "R-1", task: "T-1", started: 1000, terminals: [{ address: "t9", started: 1000 }], line: { text: "reading", progress: 20, at: NOW - 2 * 60000, by: "w" }, ...o });
function world(init) {
  const w = { tasks: [T()], runs: [run()], agents: [{ address: "t9", status: "working" }], terminals: [{ address: "t9" }], ...init };
  w.read = () => ({ tasks: w.tasks, runs: w.runs, agents: w.agents, terminals: w.terminals });
  clock = NOW;
  w.cache = createNeedsCache({ read: w.read, now: () => clock });
  w.cache.refresh();
  return w;
}
const view = (w, key = "T-1") => w.cache.get().lines.get(key) ?? null;

test("a working card with an active run line gets the view: text, progress, whole minutes, not stale", () => {
  const w = world();
  assert.deepEqual(view(w), { text: "reading", progress: 20, ageMin: 2, stale: false });
});

test("no line, no run, an empty cache: no entry", () => {
  assert.equal(createNeedsCache({ read: () => ({}) }).get().lines.size, 0);
  assert.equal(view(world({ runs: [run({ line: undefined })] })), null);
  assert.equal(view(world({ runs: [] })), null);
});

test("a stamped-ended run shows no line", () => {
  assert.equal(view(world({ runs: [run({ ended: NOW - 1 })] })), null);
});

test("a live-only end (terminal gone, record unchanged) clears the line at the next refresh", () => {
  const w = world();
  assert.ok(view(w));
  w.agents = []; w.terminals = [];
  assert.equal(w.cache.refresh(), true);
  assert.equal(view(w), null, "the run record did not change; the live state ended it");
});

test("a legacy run without a numeric started shows its line while its terminal is alive, and not after", () => {
  const legacy = run({ started: undefined, terminals: [{ address: "t9" }] });
  const w = world({ runs: [legacy] });
  assert.ok(view(w));
  w.agents = []; w.terminals = [];
  w.cache.refresh();
  assert.equal(view(w), null);
});

test("unknown host (nothing alive and no agents): follows runStatus, ended, so no line", () => {
  assert.equal(view(world({ agents: [], terminals: [] })), null);
});

test("the latest started active run of the task wins; an ended newer run is skipped", () => {
  const old = run({ id: "R-old", started: 1000, line: { text: "old run", at: NOW - 60000 } });
  const newer = run({ id: "R-new", started: 5000, line: { text: "new run", at: NOW - 60000 } });
  assert.equal(view(world({ runs: [old, newer] })).text, "new run");
  assert.equal(view(world({ runs: [old, { ...newer, ended: NOW - 5 }] })).text, "old run");
  assert.equal(view(world({ runs: [newer, old] })).text, "new run", "list order does not decide");
});

test("a remote card never gets a line, even when a local run shares its bare id; the local card with that id keeps it", () => {
  const remote = (machine, projectId) => T({ id: "T-1", remote: { machine, projectId }, project: projectId });
  const w = world({ tasks: [T(), remote("m1", "P-9"), remote("m2", "P-9")] });
  const lines = w.cache.get().lines;
  assert.ok(lines.get("T-1"));
  assert.equal(lines.get(cardKey(remote("m1", "P-9"))), undefined);
  assert.equal(lines.get(cardKey(remote("m2", "P-9"))), undefined);
  assert.equal(lines.size, 1);
});

test("a line replaced in the runs changes the cache result and reports a change", () => {
  const w = world();
  w.runs = [run({ line: { text: "second", at: NOW - 1000 } })];
  assert.equal(w.cache.refresh(), true);
  assert.deepEqual(view(w), { text: "second", progress: null, ageMin: 0, stale: false });
});

test("the run ending (record stamped, line dropped) clears the entry and reports a change", () => {
  const w = world();
  const { line: _l, ...rest } = run();
  w.runs = [{ ...rest, ended: NOW }];
  assert.equal(w.cache.refresh(), true);
  assert.equal(view(w), null);
});

test("time: nothing changes inside a minute; the minute and the stale boundary are part of the result", () => {
  const w = world({ runs: [run({ line: { text: "a", at: NOW } })] });
  clock = NOW + 30000;
  assert.equal(w.cache.refresh(), false, "the 1 s timer inside the same minute: no repaint");
  clock = NOW + 61000;
  assert.equal(w.cache.refresh(), true, "the minute turned");
  assert.equal(view(w).ageMin, 1);
  clock = NOW + 9 * 60000 + 59000;
  w.cache.refresh();
  assert.equal(view(w).stale, false);
  clock = NOW + 10 * 60000;
  assert.equal(w.cache.refresh(), true);
  assert.equal(view(w).stale, true);
});

test("signature: a line text that looks like the old delimiters cannot collide with two other lines (refresh must report the change)", () => {
  const t2 = T({ id: "T-2" });
  const r2 = (text) => run({ id: "R-2", task: "T-2", terminals: [{ address: "t8", started: 1000 }], line: text === null ? undefined : { text, at: NOW } });
  const w = world({ tasks: [T(), t2], runs: [run({ line: { text: "a||0|false,T-2|b", at: NOW } }), r2(null)], agents: [{ address: "t9", status: "working" }, { address: "t8", status: "working" }], terminals: [{ address: "t9" }, { address: "t8" }] });
  assert.equal(view(w, "T-1").text, "a||0|false,T-2|b");
  w.runs = [run({ line: { text: "a", at: NOW } }), r2("b")];
  assert.equal(w.cache.refresh(), true, "two different displayed lines");
  assert.equal(view(w, "T-1").text, "a");
  assert.equal(view(w, "T-2").text, "b");
});
