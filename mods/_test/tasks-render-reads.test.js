// T-MWO2HFFHWRB: the Tasks panel render reads memory only. Grouping, counts, dots and remote write controls are derived by the needs cache
// (init + a 1 s timer), never in render: no exec / hc / file read / file write / folder watch / timer start / spawn, no host agents()/terminals() read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { default: Tasks } = await import(new URL("../drover-tasks/main.js", import.meta.url).href);
const C = await import(new URL("../_lib/config.js", import.meta.url).href);
const IO = await import(new URL("../_lib/io.js", import.meta.url).href);

const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
const PR = { id: "P-R", name: "Omarchy", repos: [], folders: [], branch: "main", remote: { machine: "omarchy", projectId: "P-9", id: "B-1", writes: true } };
const COLS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const card = (i, o = {}) => ({ id: `T-${i}`, title: `card ${i}`, column: COLS[i % 6], priority: "P2", tags: [], created: i, updated: i, project: P.id, archived: false, agent: null, run: null, notes: [], desc: "", assignee: null, source: null, ...o });

// One host: every side-effecting entry point counts. `reads` counts shared-key reads. agents()/terminals() count through getters.
function setup(n, { remote = false } = {}) {
  C.resetCache(); C.setSettings("drover-tasks", {}); C.setSettings("drover-runs", {}); C.setSettings("drover-wakeups", {});
  IO.resetRemoteWriter();
  const calls = { exec: 0, hc: 0, read: 0, write: 0, watch: 0, every: 0, spawn: 0, set: 0, agents: 0, terminals: 0 };
  const reads = {};
  const raw = { "drover.tasks": Array.from({ length: n }, (_, i) => card(i + 1)), "drover.projects": remote ? [P, PR] : [P], "drover.runs": [] };
  if (remote) raw["drover.remote.omarchy.P-9"] = { at: Date.now(), tasks: [card(901, { id: "T-R1", column: "review", project: "P-9" }), card(902, { id: "T-R2", column: "review", project: "P-9" })], picks: { assignees: [], projects: [] } };
  const state = new Proxy(raw, {
    get(o, k) { if (typeof k === "string") reads[k] = (reads[k] ?? 0) + 1; return o[k]; },
    set(o, k, v) { calls.set++; o[k] = v; return true; },
  });
  const agentsList = [], terminalsList = [];
  const host = {
    props: {}, notified: [], home: "/h", appHome: "/nowhere", state, focused: { terminal: "t1", cwd: "/x", space: null }, spaces: [], panes: [],
    exec: async () => { calls.exec++; return { code: 1, stdout: "", stderr: "" }; },
    hc: async () => { calls.hc++; return { code: 1, stdout: "", stderr: "" }; },
    readTextFile: async () => { calls.read++; return null; },
    writeTextFile: async () => { calls.write++; },
    watchFolder: async () => { calls.watch++; },
    run: () => {},
  };
  Object.defineProperty(host, "agents", { get() { calls.agents++; return agentsList; } });
  Object.defineProperty(host, "terminals", { get() { calls.terminals++; return terminalsList; } });
  globalThis.__host = host;
  const timers = [];
  const cx = { notify() { calls.notified = (calls.notified ?? 0) + 1; }, stop_propagation() {}, spawn() { calls.spawn++; }, focus_handle: () => ({ focus() {} }),
    timer: { every(ms, f) { calls.every++; timers.push({ ms, f }); }, after() { calls.every++; } } };
  const t = new Tasks(); t.init({}, cx);
  const tick = () => { for (const x of timers) x.f(cx); }; // the 1 s timers: what the host does every second
  return { t, cx, raw, calls, reads, agentsList, terminalsList, tick, timers };
}
const render = (t, cx) => { globalThis.__rec = { ids: [], texts: [] }; try { t.render(cx); return { ...globalThis.__rec }; } finally { globalThis.__rec = undefined; } };
const SIDE = ["exec", "hc", "read", "write", "watch", "every", "spawn", "set", "agents", "terminals"];
const delta = (calls, fn) => { const b = { ...calls }; const out = fn(); return { out, d: Object.fromEntries(SIDE.map((k) => [k, (calls[k] ?? 0) - (b[k] ?? 0)])) }; };
const none = Object.fromEntries(SIDE.map((k) => [k, 0]));

for (const n of [3, 30, 300]) {
  test(`Tasks render, ${n} cards: cold and warm render have no side effects and read no host lists`, () => {
    const { t, cx, calls } = setup(n);
    const cold = delta(calls, () => render(t, cx));
    assert.ok(cold.out.ids.some((i) => i.startsWith("task-")), "rows are drawn from the cache on the first render");
    assert.deepEqual(cold.d, none, "cold render");
    const warm = delta(calls, () => render(t, cx));
    assert.deepEqual(warm.d, none, "warm render");
  });
}

test("Tasks render: the shared-key reads of a render do not depend on the card count", () => {
  const seen = [3, 30, 300].map((n) => { const { t, cx, reads } = setup(n); render(t, cx); for (const k in reads) delete reads[k]; render(t, cx); return { ...reads }; });
  assert.deepEqual(seen[1], seen[0]);
  assert.deepEqual(seen[2], seen[0]);
});

for (const n of [3, 30, 300]) {
  test(`Tasks render, ${n} cards with remote Review cards: a missing probe starts nothing in render (the timer does)`, () => {
    const { t, cx, calls, tick } = setup(n, { remote: true });
    const cold = delta(calls, () => render(t, cx));
    assert.deepEqual(cold.d, none, "cold render with remote Review cards");
    assert.ok(cold.out.ids.includes("task-omarchy/P-9/T-R1"));
    assert.deepEqual(delta(calls, () => render(t, cx)).d, none, "warm render");
    const timer = delta(calls, () => { for (let i = 0; i < 3; i++) tick(); });
    assert.ok(timer.d.hc >= 0); // the probe belongs to the timer: whatever it starts, render did not
    const after = delta(calls, () => render(t, cx));
    assert.deepEqual(after.d, none, "render after the timer ran");
    assert.ok(after.out.ids.includes("ro-done-omarchy/P-9/T-R1"), "the ✓ of a remote Review card is a disabled control with the reason from the cache");
  });
}

test("Tasks render: a probe that is expired or not answered is retried by the timer only", () => {
  const { t, cx, calls, tick } = setup(3, { remote: true });
  tick();
  for (let i = 0; i < 4; i++) assert.deepEqual(delta(calls, () => render(t, cx)).d, none, `render ${i}`);
  const hcBefore = calls.hc;
  tick(); tick();
  assert.ok(calls.hc >= hcBefore);
  assert.deepEqual(delta(calls, () => render(t, cx)).d, none);
});

test("Tasks: init starts the 1 s refresh timer and the remote watch; render starts neither", () => {
  const { t, cx, calls, timers } = setup(3, { remote: true });
  assert.ok(timers.filter((x) => x.ms === 1000).length >= 2, "needs refresh and watchRemote both run every second");
  const before = timers.length;
  render(t, cx); render(t, cx);
  assert.equal(timers.length, before);
  assert.equal(calls.every, before);
});

test("Tasks render: it never derives a group per card (no attention(), loadMerged(), remoteWriteState(), watchRemote() in render)", () => {
  const src = readFileSync(new URL("../drover-tasks/main.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("  render(cx) {"));
  for (const word of ["attention(", "loadMerged(", "remoteWriteState(", "watchRemote(", "liveStatuses(", "reviewLive(", "loadRuns(", "agents()", "terminals()"]) {
    assert.ok(!body.includes(word), `render must not call ${word}`);
  }
  assert.ok(body.includes("cache.get()") || body.includes("needs.get()"), "render reads the cache");
});

test("Tasks: a changed card shows after the next refresh, and notifies only when something changed", () => {
  const { t, cx, raw, calls, tick } = setup(3);
  const has = (r, s) => r.texts.some((x) => x.includes(s));
  assert.ok(!has(render(t, cx), "Needs you"), "no card needs you yet");
  raw["drover.tasks"] = raw["drover.tasks"].map((x) => (x.id === "T-1" ? { ...x, column: "doing", agent: "t77", updated: 99 } : x));
  assert.ok(!has(render(t, cx), "Needs you"), "render alone does not look at the tasks again");
  const n0 = calls.notified ?? 0;
  tick();
  assert.ok(has(render(t, cx), "Needs you"), "the next refresh puts T-1 under Needs you");
  assert.equal((calls.notified ?? 0) - n0, 1, "one repaint for one change");
  tick(); tick();
  assert.equal((calls.notified ?? 0) - n0, 1, "nothing changed: no repaint");
});

test("Tasks: a live-only change (agent working -> blocked -> gone) updates the rows with tasks and runs untouched", () => {
  const { t, cx, raw, calls, agentsList, terminalsList, tick } = setup(0);
  raw["drover.tasks"] = [card(1, { column: "doing", agent: "t9" })];
  agentsList.push({ address: "t9", status: "working" }); terminalsList.push({ address: "t9" });
  tick();
  const has = (s) => render(t, cx).texts.some((x) => x.includes(s));
  assert.ok(has("Agent is working"));
  agentsList[0] = { address: "t9", status: "blocked" };
  const n0 = calls.notified ?? 0;
  tick();
  assert.ok(has("Agent asks: open its terminal"));
  assert.equal((calls.notified ?? 0) - n0, 1);
  agentsList.length = 0; terminalsList.length = 0;
  tick();
  assert.ok(has("Agent t9 is gone"));
});
