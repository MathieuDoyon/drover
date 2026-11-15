// #20: an in-flight task's click goes to its agent, so the Tasks row and the Room title carry their own Edit entry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const H = globalThis.__host = { props: {}, state: {}, notified: [], agents: [], terminals: [] };
const { default: Tasks } = await import("../drover-tasks/main.js");
const { default: Room } = await import("../drover-room/main.js");
// The screens render a neutral view until their settings are ready: these tests are about the ready screen.
const CFG = await import("../_lib/config.js");
CFG.setSettings("drover-tasks", {}); CFG.setSettings("drover-room", {});
const cx = { notify() {}, timer: { every() {} }, spawn() {} };
const render = (view) => { globalThis.__rec = { ids: [], texts: [] }; view.render(cx); const r = globalThis.__rec; globalThis.__rec = null; return r; };
const task = (id, extra = {}) => ({ id, title: `title ${id}`, column: "doing", priority: "p2", tags: [], archived: false, ...extra });
beforeEach(() => { H.state = {}; H.agents = []; H.terminals = []; H.focused = null; });

test("Tasks: a row whose click focuses a live agent shows an Edit pencil; others do not", () => {
  H.agents = [{ address: "t9", status: "working" }];
  H.state["drover.tasks"] = [task("T-LIVE", { agent: "t9" }), task("T-PLAIN")];
  const v = new Tasks(); v.init({}, cx);
  const r = render(v);
  assert.ok(r.ids.includes("edit-T-LIVE"));
  assert.ok(!r.ids.includes("edit-T-PLAIN"));
});

test("Tasks: the pencil opens the editor, not the agent", () => {
  const opened = [];
  H.openOverlay = (o) => opened.push(o);
  H.agents = [{ address: "t9", status: "working" }];
  const v = new Tasks();
  v.editTask("T-LIVE");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].mod, "drover-todos");
  assert.equal(opened[0].props.edit, "T-LIVE");
});

test("Room: the title has an Edit link when the run has a task", () => {
  H.state["drover.tasks"] = [task("T-1")];
  H.state["drover.runs"] = [{ id: "R", task: "T-1", terminals: [{ address: "t1", name: "n", role: "leader" }] }];
  H.terminals = [{ address: "t1" }]; H.focused = { terminal: "t1" };
  const v = new Room(); v.init({}, cx);
  assert.ok(render(v).ids.includes("edit-task"));
});

// Click handlers: walk the rendered tree for an id and call its on_click.
import { NODE } from "./stubs/el.js";
const find = (n, id) => n.id === id ? n : n.kids.map((k) => find(k, id)).find(Boolean);
const click = (view, id, cx2) => {
  globalThis.__rec = { ids: [], texts: [] };
  const root = view.render(cx);
  globalThis.__rec = null;
  find(root[NODE], id).args.on_click[0]({}, cx2);
};

test("Tasks: pencil click stops propagation, opens the editor and never focuses the agent; row click still focuses it", () => {
  const opened = [], runs = [];
  H.openOverlay = (o) => opened.push(o); H.run = (...a) => runs.push(a);
  H.agents = [{ address: "t9", status: "working" }];
  H.state["drover.tasks"] = [task("T-LIVE", { agent: "t9" })];
  const v = new Tasks(); v.init({}, cx);
  let stopped = 0;
  click(v, "edit-T-LIVE", { stop_propagation: () => stopped++ });
  assert.equal(stopped, 1);
  assert.equal(opened[0].props.edit, "T-LIVE");
  assert.equal(runs.length, 0);
  click(v, "task-T-LIVE", {});
  assert.deepEqual(runs[0], ["agent.focus", { terminal: "t9" }]);
});

test("Room: Edit link click opens the run's task editor", () => {
  const opened = [];
  H.openOverlay = (o) => opened.push(o);
  H.state["drover.tasks"] = [task("T-1")];
  H.state["drover.runs"] = [{ id: "R", task: "T-1", terminals: [{ address: "t1", name: "n", role: "leader" }] }];
  H.terminals = [{ address: "t1" }]; H.focused = { terminal: "t1" };
  const v = new Room(); v.init({}, cx);
  click(v, "edit-task", {});
  assert.equal(opened[0].props.edit, "T-1");
});
