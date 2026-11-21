// T-MWMIQMBO1BQ (option B): the Runs list, the Room and the Board show "waiting (no slot)" and a slot line.
// Each render takes ONE slotSnapshot (counted by the load hook in hooks.js), however many cards and runs there are, and writes nothing for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { until } from "./stubs/until.js";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [] };
const { default: Room } = await import("../drover-room/main.js");
const { default: Runs } = await import("../drover-runs/main.js");
const { default: Board } = await import("../drover-board/main.js");
const C = await import("../_lib/config.js");
const R = await import("../_lib/runs.js");
const { NODE } = await import("./stubs/el.js");

const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
const card = (i, column) => ({ id: `T-${i}`, title: `card ${i}`, column, agent: null, run: `R${i}`, priority: "P2", tags: [], created: 1, updated: 1, project: P.id, archived: false, notes: [] });
const run = (i) => ({ id: `R${i}`, task: `T-${i}`, project: P.id, started: 1, terminals: [{ address: `t${i}`, agent: "wrangler", name: "W", role: "leader", started: 1 }] });
const walk = (n, out = []) => { out.push(n); for (const k of n.kids ?? []) walk(k, out); return out; };
const nodeOf = (root, id) => walk(root[NODE]).find((n) => n.id === id);
const writes = [];
let host, cx;

// n runs: the odd ones sit on Review cards (waiting), the even ones on In progress cards (active). Every terminal is alive.
// The Board starts a remote watch loop that never ends: its cx does not run spawned work (as in lazy-menus.test.js).
function world(n, { focus = "t1", spawn = true } = {}) {
  C.resetCache();
  for (const m of ["drover-runs", "drover-room", "drover-board"]) C.setSettings(m, {});
  const idx = Array.from({ length: n }, (_, i) => i + 1);
  const raw = { "drover.runs": idx.map(run), "drover.tasks": idx.map((i) => card(i, i % 2 ? "review" : "doing")), "drover.projects": [P],
    "drover.config": { "drover-runs": {}, "drover-room": {}, "drover-board": {} } };
  const state = new Proxy(raw, { set(o, k, v) { writes.push(String(k)); o[k] = v; return true; } });
  host = globalThis.__host = { props: {}, notified: [], agents: [], panes: [], spaces: [], terminals: idx.map((i) => ({ address: `t${i}` })), home: "/h", appHome: "/nowhere", state, focused: { terminal: focus, cwd: "/x" }, readTextFile: async () => null };
  cx = { notify() {}, stop_propagation() {}, write_to_clipboard() {}, focus_handle: () => ({ focus() {} }), timer: { every() {}, after() {} }, spawn: (fn) => { if (spawn) Promise.resolve().then(() => fn(cx)).catch(() => {}); } };
  return idx;
}
const draw = (view) => { globalThis.__rec = { ids: [], texts: [] }; try { const root = view.render(cx); return { root, texts: globalThis.__rec.texts.slice(), ids: globalThis.__rec.ids.slice() }; } finally { globalThis.__rec = undefined; } };
// A screen is gated until its own settings load: draw until the real screen appears.
async function ready(view, test) { let out; await until(() => { out = draw(view); return test(out); }, "the screen is ready"); return out; }
const mk = (Screen) => { const v = new Screen(); v.init({}, cx); return v; };
const slotCalls = (view) => { globalThis.__slotCalls = 0; const out = draw(view); return { out, calls: globalThis.__slotCalls }; };

test("Runs: a waiting run reads 'waiting (no slot)'; the project slot line is labelled by name; Stop stays", async () => {
  world(4); // R1, R3 waiting; R2, R4 active; limit 2
  const v = mk(Runs);
  const { root, texts } = await ready(v, (o) => o.ids.includes("list"));
  assert.equal(texts.filter((x) => x === "waiting (no slot)").length, 2);
  assert.ok(texts.includes("Alpha: Slots 2/2 · 2 waiting"), texts.filter((x) => /Slots/.test(x)).join("|"));
  assert.ok(nodeOf(root, "stop-R1"), "a waiting run is still alive: it can be stopped");
  assert.equal(texts.filter((x) => x === "Working" || x === "Stopped: check the result").length, 2, "the active runs keep their terminal-derived label");
});

test("Runs: no run, no slot line", async () => {
  world(0);
  const v = mk(Runs);
  const { texts } = await ready(v, () => true);
  assert.equal(texts.filter((x) => /Slots/.test(x)).length, 0);
});

test("Runs: claim-only project and two projects each get their own line", async () => {
  world(2);
  host.state["drover.projects"] = [P, { id: "P-2", name: "Beta", repos: [], folders: [], branch: "main" }];
  host.state["drover.tasks"] = [...host.state["drover.tasks"], { ...card(9, "doing"), project: "P-2", agent: "claiming", run: null }];
  const v = mk(Runs);
  const { texts } = await ready(v, (o) => o.ids.includes("list"));
  const lines = texts.filter((x) => /Slots/.test(x));
  assert.deepEqual(lines.sort(), ["Alpha: Slots 1/2 · 1 waiting", "Beta: Slots 1/2"]);
});

test("Room: the run you are inside shows one waiting line under the Squad heading when its card is in Review/Blocked", async () => {
  world(2, { focus: "t1" }); // T-1 review
  host.state["drover.runs"] = host.state["drover.runs"].map((r) => ({ ...r, worktree: null, space: "s" }));
  const v = mk(Room);
  const w = await ready(v, (o) => o.ids.includes("p-Run"));
  assert.ok(nodeOf(w.root, "waiting-slot"));
  assert.ok(w.texts.some((x) => /waiting \(no slot\)/.test(x)));
  const v2 = (world(2, { focus: "t2" }), mk(Room)); // T-2 doing
  const a = await ready(v2, (o) => o.ids.includes("p-Run"));
  assert.equal(nodeOf(a.root, "waiting-slot"), undefined);
});

test("Board: slot line 'Slots A/L · W waiting' only in a local project scope; hidden elsewhere and when the project has no run", async () => {
  world(4, { spawn: false });
  const b = mk(Board);
  await ready(b, (o) => o.ids.includes("scope"));
  const all = draw(b);
  assert.equal(nodeOf(all.root, "slot-line"), undefined, "All issues: no line");
  b.scope = `project:${P.id}`;
  const one = draw(b);
  assert.ok(one.texts.includes("Slots 2/2 · 2 waiting"), one.texts.filter((x) => /Slots/.test(x)).join("|"));
  assert.ok(nodeOf(one.root, "slot-line"));
  host.state["drover.runs"] = [];
  assert.equal(nodeOf(draw(b).root, "slot-line"), undefined, "no run: hidden");
});

for (const [name, Screen, prep] of [["Runs", Runs, (v) => v], ["Room", Room, (v) => v], ["Board", Board, (v) => { v.scope = `project:${P.id}`; return v; }]]) {
  test(`${name}: one slotSnapshot per render (Runs: per cache refresh), equal for 3, 30 and 300 cards and runs; the render writes nothing`, async () => {
    const counts = [];
    for (const n of [3, 30, 300]) {
      world(n, { spawn: name !== "Board" });
      const v = prep(mk(Screen));
      await ready(v, (o) => o.ids.length > 3);
      writes.length = 0;
      // Runs derives in its cache refresh (init, a tick, own saves): that is where its ONE snapshot is taken; its render takes none.
      let calls;
      if (name === "Runs") { globalThis.__slotCalls = 0; v.cache.refresh(); calls = globalThis.__slotCalls; assert.equal(slotCalls(v).calls, 0, "Runs: a render takes no snapshot"); }
      else calls = slotCalls(v).calls;
      counts.push(calls);
      assert.deepEqual(writes, [], `${name} ${n}: a render writes no shared state`);
    }
    assert.deepEqual(counts, [1, 1, 1]);
  });
}

test("the slot view never reaches into the filtered columns: the Board numbers come from local tasks and runs, not from the visible cards", async () => {
  world(4, { spawn: false });
  const b = mk(Board);
  b.scope = `project:${P.id}`;
  await ready(b, (o) => o.ids.includes("scope"));
  b.query = "no card matches this";
  assert.ok(draw(b).texts.includes("Slots 2/2 · 2 waiting"));
});

test("helpers: slotLine and runBadge", () => {
  const b = { active: 1, waiting: 2, free: 1 };
  assert.equal(R.slotLine(b, 2), "Slots 1/2 · 2 waiting");
  assert.equal(R.slotLine({ active: 2, waiting: 0, free: 0 }, 2), "Slots 2/2");
  assert.equal(R.slotLine({ active: 3, waiting: 0, free: 0 }, 2), "Slots 3/2", "over limit is shown as it is");
  assert.equal(R.slotLine({ active: 0, waiting: 0, free: 2 }, 2), "", "no run: no line");
  assert.equal(R.slotLine(undefined, 2), "");
  assert.equal(R.slotLine(b, 2, "Alpha"), "Alpha: Slots 1/2 · 2 waiting");
  assert.equal(R.runBadge(true, "Working"), "waiting (no slot)");
  assert.equal(R.runBadge(false, "Working"), "Working");
});
