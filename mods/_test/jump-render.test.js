// B7: render reads memory only. Cold and warm render do no exec/read/write/start; reads and rows do not grow with the card count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [] };
const { default: Jump } = await import(new URL("../drover-jump/main.js", import.meta.url).href);

const COLS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const card = (i) => ({ id: `T-${i}`, title: `card ${i}`, column: COLS[i % 6], priority: "P2", tags: [], created: i, updated: i, project: "P-1", agent: null });

function setup(n, { overlay = "o9" } = {}) {
  const raw = { "drover.tasks": Array.from({ length: n }, (_, i) => card(i + 1)), "drover.projects": [{ id: "P-1", name: "Alpha" }], "drover.runs": [] };
  const reads = {};
  const state = new Proxy(raw, { get(o, k) { if (typeof k === "string") reads[k] = (reads[k] ?? 0) + 1; return o[k]; }, set(o, k, v) { o[k] = v; return true; } });
  const calls = { exec: 0, read: 0, write: 0, hc: 0, watch: 0, overlay: 0, timers: 0, spawn: 0 };
  globalThis.__host = {
    props: { overlay }, state, notified: [], agents: [], terminals: [], panes: [], spaces: [], home: "/h", appHome: "/nowhere", focused: { terminal: "t1", space: "s1" },
    exec: async () => { calls.exec++; return { code: 0 }; }, readTextFile: async () => { calls.read++; return null; }, writeTextFile: async () => { calls.write++; },
    hc: () => { calls.hc++; }, watchFolder: () => { calls.watch++; }, openOverlay: () => { calls.overlay++; return "ov"; }, closeOverlay() {}, run() {},
  };
  const cx = { notify() {}, stop_propagation() {}, spawn() { calls.spawn++; }, focus_handle: () => ({ focus() {} }), timer: { every() { calls.timers++; }, after() {} } };
  const v = new Jump(); v.init({}, cx);
  return { v, calls, reads, cx };
}
const render = (v, cx) => { globalThis.__rec = { ids: [], texts: [] }; v.render(cx); const r = globalThis.__rec; globalThis.__rec = undefined; return r; };
const zero = (calls) => { for (const k in calls) calls[k] = 0; };

for (const n of [3, 30, 300]) {
  test(`${n} cards: cold and warm render start, read, write and exec nothing; rows <= 50`, () => {
    const { v, calls, reads, cx } = setup(n);
    zero(calls);
    for (const k in reads) delete reads[k];
    const cold = render(v, cx);
    assert.deepEqual(calls, { exec: 0, read: 0, write: 0, hc: 0, watch: 0, overlay: 0, timers: 0, spawn: 0 }, "cold");
    const coldReads = { ...reads };
    for (const k in reads) delete reads[k];
    const warm = render(v, cx);
    assert.deepEqual(calls, { exec: 0, read: 0, write: 0, hc: 0, watch: 0, overlay: 0, timers: 0, spawn: 0 }, "warm");
    assert.deepEqual({ ...reads }, coldReads);
    assert.deepEqual(reads, {}, "render reads no shared key at all");
    const rows = (r) => r.ids.filter((x) => x.startsWith("jump-row-"));
    assert.equal(rows(cold).length, Math.min(n + 1, 50));
    assert.deepEqual(rows(warm), rows(cold));
  });
}

test("render reads and row cost are the same for 3, 30 and 300 cards", () => {
  const sizes = [3, 30, 300].map((n) => { const { v, reads, cx } = setup(n); render(v, cx); for (const k in reads) delete reads[k]; const r = render(v, cx); return { reads: { ...reads }, rows: r.ids.filter((x) => x.startsWith("jump-row-")).length }; });
  assert.deepEqual(sizes[0].reads, sizes[1].reads);
  assert.deepEqual(sizes[1].reads, sizes[2].reads);
  assert.ok(sizes[2].rows <= 50);
});

test("init starts exactly one poller (the 1 s timer) and writes nothing: no keys.json write, no state write, no exec", () => {
  const { calls, v } = setup(5);
  assert.equal(calls.timers, 1);
  assert.equal(calls.write, 0);
  assert.equal(calls.exec, 0);
  assert.equal(calls.read, 0);
  assert.ok(v.cache);
});

test("host check (overlay null): init does nothing and render does not throw", () => {
  const { calls, v, cx } = setup(5, { overlay: null });
  assert.deepEqual(calls, { exec: 0, read: 0, write: 0, hc: 0, watch: 0, overlay: 0, timers: 0, spawn: 0 });
  assert.doesNotThrow(() => render(v, cx));
});

test("an empty result shows a note, not rows", () => {
  const { v, cx } = setup(3);
  v.input.set_value("zzzz"); v.input.handlers.change({}, cx);
  const r = render(v, cx);
  assert.equal(r.ids.filter((x) => x.startsWith("jump-row-")).length, 0);
  assert.ok(r.texts.some((t) => /no match/i.test(t)));
});
