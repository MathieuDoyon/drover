// T-MWGM0XUUWJT (#34): Report to Drover defaults to the Drover of the sidebar's space.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./hooks.js", import.meta.url);
let host;
beforeEach(() => {
  host = globalThis.__host = { appHome: "/app", home: "/h", props: {}, notified: [], terminals: [],
    focused: { space: "s1", terminal: "tTodos" },
    spaces: [{ id: "s1", name: "herdr", tabs: [{ id: "tab1" }] }, { id: "s2", name: "gallery-all", tabs: [{ id: "tab2" }] }],
    panes: [{ terminal: "t1", tab: "tab1" }, { terminal: "t2", tab: "tab2" }],
    state: { "drover.agents": { agents: [], squads: [] }, "drover.runs": [
      { id: "R1", started: 1, terminals: [{ address: "t1", agent: "drover", name: "Drover" }] },
      { id: "R2", started: 9, terminals: [{ address: "t2", agent: "drover", name: "Drover" }] }] },
    readTextFile: async () => JSON.stringify({ settings: { default_report: true } }) };
});
const { droverList, startOptions } = await import("../_lib/io.js");

test("droverList: both Drovers on screen with their space, newest first", () => {
  assert.deepEqual(droverList().map((c) => [c.address, c.spaceName]), [["t2", "gallery-all"], ["t1", "herdr"]]);
});

test("startOptions: reports to the Drover in the focused space, not the newest one elsewhere", async () => {
  assert.equal((await startOptions()).reportTo, "t1");
  host.focused = { space: "s2" };
  assert.equal((await startOptions()).reportTo, "t2");
});

// The picker: default = Drover of the space the sidebar is in; 2+ Drovers show the list; a choice is for this launch only.
const { default: Agents } = await import("../drover-agents/main.js");
test("picker: defaults to the same-space Drover, lists both, a pick applies to this picker only", async () => {
  host.props = { overlay: "o", pick: "T-1" };
  host.state["drover.tasks"] = [{ id: "T-1", title: "t", desc: "", column: "todo", priority: "P2", tags: [], notes: [], created: 1 }];
  host.state["drover.agents"] = { agents: [{ id: "claude", name: "Claude", command: "claude", instructions: "", version: 1 }], squads: [] };
  const cx = { notify() {}, spawn: (fn) => Promise.resolve().then(() => fn(cx)), timer: { every() {} } };
  const v = new Agents(); v.init({}, cx);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const p = v.dialog;
  assert.equal(p.droverAt(), "t1", "same space as the sidebar");
  globalThis.__rec = { ids: [], texts: [] };
  p.render(cx);
  assert.ok(globalThis.__rec.ids.includes("trig-drover"), "2 Drovers: the picker list");
  assert.ok(globalThis.__rec.ids.includes("drover-t2") && globalThis.__rec.ids.includes("drover-t1"));
  assert.ok(globalThis.__rec.texts.includes("Drover · gallery-all · t2"));
  globalThis.__rec = null;
  p.picked.drover = "t2";
  assert.equal(p.droverAt(), "t2");
});
