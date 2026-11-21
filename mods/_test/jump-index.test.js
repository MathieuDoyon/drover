// B7 jump palette: the pure index and filter (memory only, no I/O).
import { test } from "node:test";
import assert from "node:assert/strict";
import { jumpIndex, jumpFilter, jumpTarget, JUMP_LIMIT } from "../_lib/jump.js";

const card = (id, title, extra = {}) => ({ id, title, column: "todo", project: null, created: 1, ...extra });
const world = (over = {}) => ({ tasks: [], runs: [], projects: [], live: new Map(), alive: new Set(), ...over });
const keys = (list) => list.map((x) => x.key);

test("index: cards, then runs, then projects; frozen; each item has kind, key, label, sub, lower", () => {
  const idx = jumpIndex(world({
    tasks: [card("T-1", "Fix login", { column: "doing", project: "P-1" })],
    runs: [{ id: "R-1", task: "T-1", title: "", terminals: [{ address: "t1", role: "leader" }] }],
    projects: [{ id: "P-1", name: "Alpha" }],
    alive: new Set(["t1"]),
  }));
  assert.ok(Object.isFrozen(idx));
  assert.deepEqual(idx.map((x) => x.kind), ["card", "run", "project"]);
  for (const x of idx) {
    assert.equal(typeof x.key, "string");
    assert.equal(typeof x.label, "string");
    assert.equal(typeof x.sub, "string");
    assert.equal(x.lower, x.lower.toLowerCase());
  }
  assert.match(idx[0].sub, /doing/);
  assert.match(idx[0].sub, /Alpha/);
  assert.match(idx[1].sub, /running|stopped|working|blocked|ended/);
});

test("a done card is included, labelled by its column", () => {
  const idx = jumpIndex(world({ tasks: [card("T-9", "Old thing", { column: "done" })] }));
  assert.equal(idx.length, 1);
  assert.match(idx[0].sub, /done/);
});

test("a remote card's key does not collide with a local card of the same id", () => {
  const idx = jumpIndex(world({ tasks: [card("T-1", "local"), card("T-1", "remote", { remote: { machine: "m1", projectId: "P-9" } })] }));
  assert.equal(new Set(keys(idx)).size, 2);
});

test("filter: empty query returns the first N in index order, limit applies", () => {
  const tasks = Array.from({ length: 80 }, (_, i) => card(`T-${i}`, `card ${i}`));
  const idx = jumpIndex(world({ tasks }));
  const r = jumpFilter(idx, "");
  assert.equal(JUMP_LIMIT, 50);
  assert.equal(r.length, 50);
  assert.deepEqual(keys(r), keys(idx).slice(0, 50));
  assert.equal(jumpFilter(idx, "", 7).length, 7);
});

test("filter: every token must match; case-insensitive", () => {
  const idx = jumpIndex(world({ tasks: [card("T-1", "Fix login bug"), card("T-2", "Fix signup"), card("T-3", "Other")] }));
  assert.deepEqual(keys(jumpFilter(idx, "FIX bug")), ["card:T-1"]);
  assert.deepEqual(keys(jumpFilter(idx, "zzz")), []);
  assert.deepEqual(keys(jumpFilter(idx, "  fix  ")).sort(), ["card:T-1", "card:T-2"]);
});

test("filter ranking: prefix > word start > contains, stable inside a rank", () => {
  const idx = jumpIndex(world({ tasks: [card("T-1", "xxlogin"), card("T-2", "the login page"), card("T-3", "login first"), card("T-4", "another login")] }));
  assert.deepEqual(keys(jumpFilter(idx, "login")), ["card:T-3", "card:T-2", "card:T-4", "card:T-1"]);
});

test("filter: kind order cards, runs, projects when ranks tie", () => {
  const idx = jumpIndex(world({
    tasks: [card("T-1", "alpha work")],
    runs: [{ id: "R-1", task: "T-1", title: "alpha run", terminals: [] }],
    projects: [{ id: "P-1", name: "alpha" }],
  }));
  assert.deepEqual(jumpFilter(idx, "alpha").map((x) => x.kind), ["card", "run", "project"]);
});

test("matches id, project name and column too (the haystack)", () => {
  const idx = jumpIndex(world({ tasks: [card("T-42", "x", { project: "P-1", column: "review" })], projects: [{ id: "P-1", name: "Gamma" }] }));
  assert.equal(jumpFilter(idx, "t-42").length, 1);
  assert.equal(jumpFilter(idx, "gamma").length, 2); // the card (its project) and the project itself
  assert.equal(jumpFilter(idx, "review").length, 1);
});

test("bad input is tolerated: no tasks, a run without terminals, a card without a title", () => {
  assert.deepEqual([...jumpIndex({})], []);
  assert.equal(jumpIndex(world({ runs: [{ id: "R-1" }], tasks: [{ id: "T-1" }] })).length, 2);
});

test("a remote card's action is its read-only view with the card object; a local card with a pane agent is a focus", () => {
  const remote = card("T-1", "far", { remote: { machine: "m1", projectId: "P-9" } });
  const local = card("T-1", "near", { agent: "t7" });
  const snap = { byCard: new Map([["m1/P-9/T-1", remote], ["T-1", local]]), runs: new Map(), projects: new Set(), agentAddrs: new Set(["t7"]), alive: new Set() };
  assert.deepEqual(jumpTarget({ kind: "card", key: "card:m1/P-9/T-1" }, snap), { type: "edit", id: "T-1", task: remote });
  assert.deepEqual(jumpTarget({ kind: "card", key: "card:T-1" }, snap), { type: "focus", command: "agent.focus", terminal: "t7" });
  assert.equal(jumpTarget({ kind: "card", key: "card:T-404" }, snap), null);
});
