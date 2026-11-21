// T-MWO2HFSB34T: the Runs screen render reads memory only. Everything it draws is derived by the runs cache (init, a 1 s timer, own saves).
// Render makes no exec / hc / file read / file write / folder watch / timer start / spawn, no host agents()/terminals() read, and calls none of the
// derivations (lineOf, lineageOf, squadRows, slotSnapshot, runStatus: counted by the loader hook in hooks.js). The run line shows on the card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { NODE } from "./stubs/el.js";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { default: Runs } = await import(new URL("../drover-runs/main.js", import.meta.url).href);
const C = await import(new URL("../_lib/config.js", import.meta.url).href);

const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
const NOW = Date.now();
const MIN = 60000;
const card = (i) => ({ id: `T-${i}`, title: `card ${i}`, column: i % 3 ? "doing" : "review", priority: "P2", tags: [], created: i, updated: i, project: P.id, archived: false, agent: null, run: `R-${i}`, notes: [], desc: "" });
const run = (i, o = {}) => ({ id: `R-${i}`, task: `T-${i}`, project: P.id, started: NOW - 30 * MIN, terminals: [{ address: `t${i}`, name: `W${i}`, role: "leader", agent: "claude", started: NOW - 30 * MIN }, { address: `m${i}`, name: `M${i}`, role: "Wrangler", agent: "claude", started: NOW - 30 * MIN }], ...o });
const LINE = (o = {}) => ({ text: "reading the code", progress: 40, at: NOW - 3 * MIN, by: "W1", ...o });

const SIDE = ["exec", "hc", "read", "write", "watch", "every", "spawn", "set", "agents", "terminals"];
const SPIES = ["lineOf", "lineageOf", "squadRows", "slotSnapshot", "runStatus"];
function setup(n, { line = true, settings = {} } = {}) {
  C.resetCache(); C.setSettings("drover-runs", settings);
  const calls = Object.fromEntries([...SIDE, "notified"].map((k) => [k, 0]));
  const reads = {};
  const idx = Array.from({ length: n }, (_, i) => i + 1);
  const raw = { "drover.runs": idx.map((i) => run(i, i === 1 && line ? { line: LINE() } : {})), "drover.tasks": idx.map(card), "drover.projects": [P], "drover.config": { "drover-runs": settings } };
  const state = new Proxy(raw, {
    get(o, k) { if (typeof k === "string") reads[k] = (reads[k] ?? 0) + 1; return o[k]; },
    set(o, k, v) { calls.set++; o[k] = v; return true; },
  });
  const agentsList = [], terminalsList = idx.flatMap((i) => [{ address: `t${i}` }, { address: `m${i}` }]);
  const host = { props: {}, notified: [], home: "/h", appHome: "/nowhere", state, focused: { terminal: "t1", cwd: "/x", space: null }, spaces: [], panes: [],
    exec: async () => { calls.exec++; return { code: 1, stdout: "", stderr: "" }; }, hc: async () => { calls.hc++; return { code: 1, stdout: "", stderr: "" }; },
    readTextFile: async () => { calls.read++; return null; }, writeTextFile: async () => { calls.write++; }, watchFolder: async () => { calls.watch++; }, run: () => {} };
  Object.defineProperty(host, "agents", { get() { calls.agents++; return agentsList; } });
  Object.defineProperty(host, "terminals", { get() { calls.terminals++; return terminalsList; } });
  globalThis.__host = host;
  const timers = [];
  const spawned = [];
  const cx = { notify() { calls.notified++; }, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn(fn) { calls.spawn++; spawned.push(fn); },
    timer: { every(ms, f) { calls.every++; timers.push({ ms, f }); }, after() { calls.every++; } } };
  const v = new Runs(); v.init({}, cx);
  const tick = () => { for (const x of timers) if (x.ms === 1000) x.f(cx); }; // the 1 s tick (the 60 s ageing timer is not part of a second)
  return { v, cx, raw, calls, reads, tick, timers, spawned, terminalsList, agentsList };
}
const render = (v, cx) => { globalThis.__rec = { ids: [], texts: [] }; try { const root = v.render(cx); return { root, ids: [...globalThis.__rec.ids], texts: [...globalThis.__rec.texts] }; } finally { globalThis.__rec = undefined; } };
const spyCalls = () => Object.fromEntries(SPIES.map((k) => [k, globalThis.__calls?.[k] ?? 0]));
const delta = (calls, fn) => {
  const b = { ...calls }, s = spyCalls();
  const out = fn();
  const a = spyCalls();
  return { out, d: Object.fromEntries(SIDE.map((k) => [k, calls[k] - b[k]])), spies: Object.fromEntries(SPIES.map((k) => [k, a[k] - s[k]])) };
};
const none = Object.fromEntries(SIDE.map((k) => [k, 0]));
const noSpies = Object.fromEntries(SPIES.map((k) => [k, 0]));
// init starts the screen from a spawned whenLoaded: run it (the settings are set, so it resolves at once).
const boot = async (w) => { for (const fn of w.spawned.splice(0)) await fn(w.cx); return w; };
const walk = (n, out = []) => { out.push(n); for (const k of n.kids ?? []) walk(k, out); return out; };
const textOf = (n) => (typeof n.args.child?.[0] === "string" ? n.args.child[0] : "");

for (const n of [3, 30, 300]) {
  test(`Runs render, ${n} runs: cold and warm render have no side effects and call no derivation`, async () => {
    const w = await boot(setup(n));
    const cold = delta(w.calls, () => render(w.v, w.cx));
    assert.ok(cold.out.ids.includes("run-R-1"), "cards are drawn from the cache on the first render");
    assert.deepEqual(cold.d, { ...none, agents: 0 }, "cold render");
    assert.deepEqual(cold.spies, noSpies, "cold render derivations");
    const warm = delta(w.calls, () => render(w.v, w.cx));
    assert.deepEqual(warm.d, none, "warm render");
    assert.deepEqual(warm.spies, noSpies, "warm render derivations");
  });
}

test("Runs render: the shared-key reads of a render do not depend on the run count", async () => {
  const seen = [];
  for (const n of [3, 30, 300]) { const w = await boot(setup(n)); render(w.v, w.cx); for (const k in w.reads) delete w.reads[k]; render(w.v, w.cx); seen.push({ ...w.reads }); }
  assert.deepEqual(seen[1], seen[0]);
  assert.deepEqual(seen[2], seen[0]);
});

test("Runs render with Show ended: reads and side effects still do not depend on the run count", async () => {
  const seen = [];
  for (const n of [3, 30, 300]) {
    const w = await boot(setup(n));
    w.raw["drover.runs"] = w.raw["drover.runs"].map((r) => ({ ...r, ended: NOW - MIN, terminals: r.terminals.map((t) => ({ ...t, ended: NOW - MIN })) }));
    w.v.showEnded = true; w.v.cache.refresh();
    const cold = delta(w.calls, () => render(w.v, w.cx));
    assert.deepEqual(cold.d, none);
    assert.deepEqual(cold.spies, noSpies);
    for (const k in w.reads) delete w.reads[k];
    render(w.v, w.cx);
    seen.push({ ...w.reads });
  }
  assert.deepEqual(seen[1], seen[0]);
  assert.deepEqual(seen[2], seen[0]);
});

test("Runs render: the source calls none of the derivations and no ensureStarted", () => {
  const src = readFileSync(new URL("../drover-runs/main.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("  render(cx) {"));
  for (const word of ["liveStatuses(", "runStatus(", "slotSnapshot(", "slotLine(", "lineageOf(", "squadRows(", "loadRuns()", "load()", "loadProjects()", "agents()", "terminals()", "ensureStarted(", "observeEnded(", "resumeState(", "canResume(", "lineOf(", "age("]) {
    assert.ok(!body.includes(word), `render must not call ${word}`);
  }
  assert.ok(body.includes("this.cache.get()"), "render reads the cache");
});

// ---- the run card ----
test("Run card: a fresh line shows 'text · 40% · 3m' in the muted colour, no dimming", async () => {
  const w = await boot(setup(3));
  const { root, texts } = render(w.v, w.cx);
  assert.ok(texts.includes("reading the code · 40% · 3m"), texts.join("|"));
  const n = walk(root[NODE]).find((x) => textOf(x) === "reading the code · 40% · 3m");
  assert.ok(!n.calls.includes("opacity"));
  assert.equal(texts.filter((x) => x.includes("reading the code")).length, 1, "R-1 only");
});

test("Run card: a line of 10 min or more is dimmed (opacity 0.5)", async () => {
  const w = await boot(setup(3));
  w.raw["drover.runs"] = w.raw["drover.runs"].map((r) => (r.id === "R-1" ? { ...r, line: LINE({ at: NOW - 12 * MIN }) } : r));
  w.tick();
  const { root } = render(w.v, w.cx);
  const n = walk(root[NODE]).find((x) => textOf(x) === "reading the code · 40% · 12m");
  assert.ok(n, "the 12m line");
  assert.deepEqual(n.args.opacity, [0.5]);
});

test("Run card: no line, no row; an ended run (by record or by the live state alone) shows none", async () => {
  const w = await boot(setup(3, { line: false }));
  assert.ok(!render(w.v, w.cx).texts.some((x) => x.includes("reading")));
  const w2 = await boot(setup(3));
  w2.terminalsList.length = 0; w2.tick(); // live-only end of every run: no record changed
  w2.v.showEnded = true; w2.v.cache.refresh();
  assert.ok(render(w2.v, w2.cx).ids.includes("run-R-1"));
  assert.ok(!render(w2.v, w2.cx).texts.some((x) => x.includes("reading")), "live-ended run: no line");
  const w3 = await boot(setup(3));
  w3.raw["drover.runs"] = w3.raw["drover.runs"].map((r) => (r.id === "R-1" ? { ...r, ended: NOW } : r)); w3.tick();
  assert.ok(!render(w3.v, w3.cx).texts.some((x) => x.includes("reading")), "stamped-ended run: no line");
});

test("Runs: a new line shows after the next refresh, not before; render alone does not look at the runs; one repaint", async () => {
  const w = await boot(setup(3, { line: false }));
  w.raw["drover.runs"] = w.raw["drover.runs"].map((r) => (r.id === "R-1" ? { ...r, line: LINE() } : r));
  assert.ok(!render(w.v, w.cx).texts.some((x) => x.includes("reading")), "render does not read the runs");
  const n0 = w.calls.notified;
  w.tick();
  assert.ok(render(w.v, w.cx).texts.some((x) => x.includes("reading the code")));
  assert.equal(w.calls.notified - n0, 1, "one repaint for one change");
  w.tick(); w.tick();
  assert.equal(w.calls.notified - n0, 1, "nothing changed: no repaint");
});

test("Runs: a run end (the line dropped, stamped) clears the card line after the next refresh", async () => {
  const w = await boot(setup(3));
  assert.ok(render(w.v, w.cx).texts.some((x) => x.includes("reading the code")));
  w.raw["drover.runs"] = w.raw["drover.runs"].map((r) => { const { line: _l, ...rest } = r; return r.id === "R-1" ? { ...rest, ended: NOW } : r; });
  w.tick();
  assert.ok(!render(w.v, w.cx).texts.some((x) => x.includes("reading")));
});

// ---- the start-up moved out of render ----
test("Runs: render never starts the screen; init does (once loaded), and the 1 s timer is the only repeat", async () => {
  const w = setup(3);
  let started = 0;
  const orig = w.v.ensureStarted.bind(w.v);
  w.v.ensureStarted = (cx) => { started++; return orig(cx); };
  render(w.v, w.cx); render(w.v, w.cx);
  assert.equal(started, 0, "render does not call ensureStarted");
  assert.equal(w.timers.length, 1, "init has started the 1 s tick (and nothing else yet)");
  assert.equal(w.timers[0].ms, 1000);
  await boot(w);
  assert.equal(started, 1, "the loaded settings start it");
  assert.ok(w.timers.some((x) => x.ms === 60000), "the 60 s ageing timer is started by ensureStarted");
  const before = w.timers.length;
  render(w.v, w.cx);
  assert.equal(w.timers.length, before, "render starts no timer");
  assert.equal(w.calls.every, before);
});

test("Runs: switched off, the tick does no observe/refresh work; switched back on, the tick observes again (no reopen)", async () => {
  const w = await boot(setup(2));
  // a run whose terminals are gone is stamped ended by observeEnded (the live list must be non-empty to be trusted: t2 stays alive)
  const gone = { ...run(9), id: "R-9", task: "T-9" };
  w.raw["drover.runs"] = [...w.raw["drover.runs"], gone];
  C.setSettings("drover-runs", { enabled: false });
  const writes = w.calls.set;
  w.tick(); w.tick();
  assert.equal(w.calls.set, writes, "off: no observeEnded write");
  C.setSettings("drover-runs", {});
  w.tick();
  const r9 = w.raw["drover.runs"].find((r) => r.id === "R-9");
  assert.ok(r9.ended != null, "back on: the tick observed the gone run");
});

// The visible list is chosen at refresh (this.showEnded is read there): render selects one of two cached arrays and only formats it.
for (const n of [3, 30, 300]) {
  test(`Runs render, ${n} runs: the visible list is selected from the cache, never derived (no filter over a cached list; the other list is untouched)`, async () => {
    const w = await boot(setup(n));
    for (const showEnded of [false, true]) {
      w.v.showEnded = showEnded; w.v.cache.refresh();
      const c = w.v.cache.get();
      const touched = { all: [], active: [] };
      for (const name of ["all", "active"]) for (const m of ["filter", "find", "some", "every", "reduce", "slice", "map", "forEach"]) {
        const orig = Array.prototype[m], list = c[name];
        Object.defineProperty(list, m, { configurable: true, value: (...a) => { touched[name].push(m); return orig.apply(list, a); } });
      }
      const out = render(w.v, w.cx);
      assert.ok(out.ids.includes("run-R-1"));
      const other = showEnded ? "active" : "all";
      assert.deepEqual(touched[other], [], `showEnded=${showEnded}: the unselected list is not walked`);
      assert.ok(!touched.all.includes("filter") && !touched.active.includes("filter"), "no filter in render");
    }
  });
}
