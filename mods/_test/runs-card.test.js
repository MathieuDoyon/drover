// C4: Runs cards render the lineage tree. The stubs record ids and text; layout and clicks are checked natively.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const H = globalThis.__host = { props: {}, state: {}, notified: [], agents: [], terminals: [] };
const { default: Runs } = await import("../drover-runs/main.js");
// The screens render a neutral view until their settings are ready: these tests are about the ready screen.
const CFG = await import("../_lib/config.js");
CFG.setSettings("drover-runs", {});
const cx = { notify() {}, spawn() {}, timer: { every() {} } };
const MIN = 60000, T0 = Date.now() - 90 * MIN;
const term = (address, role, extra = {}) => ({ address, name: `n-${address}`, role, agent: "claude", model: null, started: T0, ...extra });
// The screen draws from its cache, refreshed by a 1 s tick: these tests change the world and draw at once, so each draw is preceded by a tick.
const render = (view) => { view.cache.refresh(); globalThis.__rec = { ids: [], texts: [] }; view.render(cx); const r = globalThis.__rec; globalThis.__rec = null; return r; };
let v;
beforeEach(() => {
  H.state = {}; H.agents = []; H.terminals = [];
  v = new Runs(); v.init({}, cx);
});

test("live run: coordinator row, leader, member rows from lineageOf; duration shown, no model chip", () => {
  H.state["drover.runs"] = [{ id: "R", started: T0, reportTo: "t0", task: "T-1", terminals: [term("t1", "Wrangler", { model: "m-w" }), term("t2", "leader", { model: "m-l" })] },
    { id: "D", started: T0, terminals: [term("t0", "leader", { name: "Drover" })] }];
  H.terminals = [{ address: "t0" }, { address: "t1" }, { address: "t2" }];
  const r = render(v);
  assert.ok(r.ids.includes("m-R-t0") && r.ids.includes("m-R-t1") && r.ids.includes("m-R-t2"));
  assert.ok(r.ids.indexOf("m-R-t0") < r.ids.indexOf("m-R-t2") && r.ids.indexOf("m-R-t2") < r.ids.indexOf("m-R-t1"), "coordinator, leader, then members");
  assert.ok(r.texts.includes("1h 30m") && !r.texts.some((x) => String(x).startsWith("req:")));
  assert.ok(r.ids.includes("stop-R"));
});

test("old run without model/started renders dashes, no errors", () => {
  H.state["drover.runs"] = [{ id: "O", terminals: [{ address: "t5", name: "old", role: "leader" }] }];
  H.terminals = [{ address: "t5" }];
  const r = render(v);
  assert.ok(r.texts.includes("—") && !r.texts.some((x) => String(x).startsWith("req:")));
});

test("ended run under Show ended: frozen duration, Forget, no Stop", () => {
  H.state["drover.runs"] = [{ id: "E", started: T0, ended: T0 + 30 * MIN, terminals: [term("t1", "leader", { ended: T0 + 30 * MIN })] }];
  let r = render(v);
  assert.ok(!r.ids.includes("run-E"));
  v.showEnded = true;
  r = render(v);
  assert.ok(r.ids.includes("run-E") && r.ids.includes("forget-E") && !r.ids.includes("stop-E"));
  assert.ok(r.texts.includes("30m"), "duration stays 30m however late it is rendered");
});
