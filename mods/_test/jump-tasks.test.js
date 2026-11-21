// B7: a project jump lands in an EXISTING Tasks instance: its text query is reset too, so the project's cards show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [] };
const CFG = await import("../_lib/config.js");
const { default: Jump } = await import("../drover-jump/main.js");
const { default: Tasks } = await import("../drover-tasks/main.js");
CFG.setSettings("drover-tasks", {});

const task = (id, title, project) => ({ id, title, column: "todo", project, created: 1, updated: 1, priority: "P2", tags: [], agent: null, run: null, notes: [], desc: "", assignee: null, source: null, archived: false });
function world() {
  const timers = [];
  const cx = { notify() {}, stop_propagation() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { every: (_ms, fn) => timers.push(fn), after() {} } };
  const host = globalThis.__host = { appHome: "/app", home: "/h", props: {}, notified: [], terminals: [], agents: [], panes: [], spaces: [], focused: { space: "s1", terminal: "t1" }, run() {}, openOverlay() {}, closeOverlay() {},
    state: { "drover.tasks": [task("T-1", "Alpha work", "P-1"), task("T-2", "Other", "P-2")], "drover.projects": [{ id: "P-1", name: "Alpha", repos: [] }, { id: "P-2", name: "Beta", repos: [] }], "drover.runs": [] } };
  const tasks = new Tasks(); tasks.init({}, cx);
  const tasksTimers = timers.splice(0);
  return { host, cx, tasks, tasksTimers, timers };
}
const rows = (v) => { globalThis.__rec = { ids: [], texts: [] }; v.render({ notify() {} }); const r = globalThis.__rec; globalThis.__rec = null; return r.ids.filter((i) => i.startsWith("task-")).length; };

test("after a project jump the existing Tasks instance clears its text query and shows the project's cards", () => {
  const { host, cx, tasks, tasksTimers } = world();
  tasks.input.set_value("unrelated"); tasks.input.handlers.change({}, cx);
  assert.equal(rows(tasks), 0);
  host.props = { overlay: "o9" };
  const jt = []; const jcx = { ...cx, timer: { every: (_m, fn) => jt.push(fn), after() {} } };
  const j = new Jump(); j.init({}, jcx);
  j.input.set_value("alpha"); j.input.handlers.change({}, jcx);
  j.sel = "project:P-1";
  j.input.handlers.submit({}, jcx);
  assert.deepEqual(host.state["drover.tasks.filters:s1"], { project: ["P-1"] });
  for (const f of tasksTimers) f(cx); // Tasks' own timer: outside render
  assert.equal(tasks.query, "");
  assert.equal(tasks.input.value(), "");
  assert.equal(rows(tasks), 1);
});

test("render never reads the reset key; a Tasks opened later does not clear on an old reset", () => {
  const { host, cx, tasksTimers } = world();
  host.state["drover.tasks.query-reset:s1"] = 12345; // an old jump
  const t2 = new Tasks(); const timers = []; const cx2 = { ...cx, timer: { every: (_m, fn) => timers.push(fn), after() {} } };
  t2.init({}, cx2);
  t2.input.set_value("keep me"); t2.input.handlers.change({}, cx2);
  for (const f of timers) f(cx2);
  assert.equal(t2.query, "keep me");
  assert.ok(tasksTimers.length >= 1);
});

// Reset tokens are tracked per space key: switching spaces alone never clears a draft.
test("s1 -> s2 -> s1 with existing and absent tokens and no new jump: the draft stays; a real jump in s1 then clears it", () => {
  const { host, cx, tasks, tasksTimers } = world();
  const tick = () => { for (const f of tasksTimers) f(cx); };
  host.state["drover.tasks.query-reset:s2"] = "old-2"; // s2 has an old token Tasks has not seen yet; s1 has none
  tick();
  tasks.input.set_value("fresh draft"); tasks.input.handlers.change({}, cx);
  host.focused = { space: "s2", terminal: "t1" }; tick();
  assert.equal(tasks.query, "fresh draft", "s2 first seen: its existing token is adopted, not applied");
  host.focused = { space: "s1", terminal: "t1" }; tick();
  host.focused = { space: "s2", terminal: "t1" }; tick();
  host.focused = { space: "s1", terminal: "t1" }; tick();
  assert.equal(tasks.query, "fresh draft", "switching back and forth, no new jump");
  host.focused = { space: "s3", terminal: "t1" }; tick(); // a space with no token at all
  assert.equal(tasks.query, "fresh draft");
  host.focused = { space: "s1", terminal: "t1" };
  host.state["drover.tasks.query-reset:s1"] = "jump-1"; // a real jump in s1
  tick();
  assert.equal(tasks.query, "");
  assert.equal(tasks.input.value(), "");
});

// Round 4: a space Tasks has never looked at. A jump written there BEFORE Tasks' next tick is a real reset; an older token is only a baseline.
function jumpTo(host, cx, name) {
  host.props = { overlay: "o9" };
  const jcx = { ...cx, timer: { every() {}, after() {} } };
  const j = new Jump(); j.init({}, jcx);
  j.input.set_value(name); j.input.handlers.change({}, jcx);
  j.sel = j.cache.get().results.find((x) => x.kind === "project").key;
  j.input.handlers.submit({}, jcx);
}

test("focus moves to an unseen space and a project jump lands before Tasks' next tick: the tick resets the query and shows the project's cards", () => {
  const { host, cx, tasks, tasksTimers } = world();
  const tick = () => { for (const f of tasksTimers) f(cx); };
  tick();
  tasks.input.set_value("unrelated"); tasks.input.handlers.change({}, cx);
  host.focused = { space: "s2", terminal: "t1" };
  jumpTo(host, cx, "alpha"); // writes the s2 filter and the s2 token; Tasks has not ticked since the focus moved
  assert.deepEqual(host.state["drover.tasks.filters:s2"], { project: ["P-1"] });
  tick();
  assert.equal(tasks.query, "");
  assert.equal(tasks.input.value(), "");
  assert.equal(rows(tasks), 1);
});

test("converse: focus moves to an unseen space with an OLDER token and no jump: the draft stays", () => {
  const { host, cx, tasks, tasksTimers } = world();
  const tick = () => { for (const f of tasksTimers) f(cx); };
  tick();
  host.state["drover.tasks.query-reset:s2"] = `${Date.now() - 60_000}-old`; // a jump made long before
  tasks.input.set_value("fresh draft"); tasks.input.handlers.change({}, cx);
  host.focused = { space: "s2", terminal: "t1" };
  tick();
  assert.equal(tasks.query, "fresh draft");
  tick();
  assert.equal(tasks.query, "fresh draft");
});
