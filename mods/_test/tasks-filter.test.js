// Tasks (right sidebar) filter menu: same helpers as the Board's. With __rec set the stubs run .when(true, fn) and record ids and child text.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { add } from "../_lib/store.js";

register("./hooks.js", import.meta.url);
const seed = () => {
  let tasks = [];
  const mk = (title, patch) => { const r = add(tasks, { title, ...patch }, 1); tasks = r.tasks.map((t) => (t.id === r.task.id ? { ...t, ...patch } : t)); };
  mk("alpha urgent", { column: "todo", priority: "P0", project: "pa", tags: ["ui"] });
  mk("alpha calm", { column: "doing", priority: "P3", project: "pa" });
  mk("beta one", { column: "todo", priority: "P1", project: "pb" });
  mk("beta done", { column: "done", project: "pb" }); // never shows in Tasks
  return tasks;
};
const CFG = await import("../_lib/config.js");
const { default: Tasks } = await import("../drover-tasks/main.js");
CFG.setSettings("drover-tasks", {});

const cx = { notify() {}, stop_propagation() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {}, every() {} } };
let host, v;
beforeEach(() => {
  host = globalThis.__host = { appHome: "/app", home: "/h", props: {}, notified: [], terminals: [], agents: [],
    focused: { space: "s1", terminal: "tTasks" },
    spaces: [{ id: "s1", name: "herdr", tabs: [{ id: "tab1" }] }, { id: "s2", name: "gallery", tabs: [{ id: "tab2" }] }],
    panes: [{ terminal: "t1", tab: "tab1" }, { terminal: "t2", tab: "tab2" }],
    state: { "drover.tasks": seed(), "drover.projects": [{ id: "pa", name: "Alpha", repos: [] }, { id: "pb", name: "Beta", repos: [] }],
      "drover.runs": [{ id: "R1", started: 1, project: "pa", terminals: [{ address: "t1", agent: "drover", name: "Drover" }] }, { id: "R2", started: 2, project: "pb", terminals: [{ address: "t2", agent: "drover", name: "Drover" }] }] } };
  v = new Tasks(); v.init({}, cx);
});
const render = () => { globalThis.__rec = { ids: [], texts: [] }; v.render(cx); const r = globalThis.__rec; globalThis.__rec = null; return r; };
const rows = (r) => r.ids.filter((i) => i.startsWith("task-")).length;

test("no filter: every row shows, no chips row, the filter button is in the header", () => {
  const r = render();
  assert.equal(rows(r), 3);
  assert.ok(r.ids.includes("filter") && !r.ids.includes("filter-chips"));
});

test("project filter narrows the rows (AND across fields), chips + Clear show, Clear restores", () => {
  v.setFilters({ project: ["pa"] });
  let r = render();
  assert.equal(rows(r), 2);
  assert.ok(r.ids.includes("filter-chips") && r.ids.includes("chip-project-pa") && r.ids.includes("chips-clear"));
  v.setFilters({ project: ["pa"], priority: ["P0"] });
  assert.equal(rows(render()), 1);
  v.setFilters({});
  assert.equal(rows(render()), 3);
});

test("filters persist in shared state and a fresh view starts from them; default is no filter", () => {
  assert.deepEqual(v.filters(), {});
  v.setFilters({ project: ["pb"] });
  assert.deepEqual(host.state["drover.tasks.filters:s1"], { project: ["pb"] });
  const w = new Tasks(); w.init({}, cx);
  assert.deepEqual(w.filters(), { project: ["pb"] });
});

test("filters hiding every row show 'Nothing matches this filter.'", () => {
  v.setFilters({ project: ["pa"], priority: ["P3", "P1"], label: ["ui"] });
  const r = render();
  assert.equal(rows(r), 0);
  assert.ok(r.texts.includes("Nothing matches this filter."));
});

test("popover: field list (Project first, no advanced row), then a field's values", () => {
  v.setPop("filter", true, cx);
  let r = render();
  assert.ok(r.ids.includes("filter-menu") && r.ids.includes("fr-project") && r.ids.includes("fr-status") && !r.ids.includes("fr-advanced"));
  assert.ok(r.ids.indexOf("fr-project") < r.ids.indexOf("fr-status"));
  v.filterView = "project";
  r = render();
  assert.ok(r.ids.includes("fr-project-pa") && r.ids.includes("fr-project-pb") && r.ids.includes("fr-back"));
});

test("'This space' row: the project of the Drover in the sidebar's space toggles that project", () => {
  assert.equal(v.spaceProject(), "pa");
  v.setPop("filter", true, cx); v.filterView = "project";
  assert.ok(render().ids.includes("fr-space"));
  v.toggleSpace();
  assert.deepEqual(v.filters(), { project: ["pa"] });
  v.toggleSpace();
  assert.deepEqual(v.filters(), {});
  host.focused = { space: "s9" }; // no Drover there: no row
  assert.equal(v.spaceProject(), null);
  assert.ok(!render().ids.includes("fr-space"));
});

test("setPop: closing resets the submenu; a stale close is ignored", () => {
  v.setPop("filter", true, cx); v.filterView = "project";
  v.setPop("filter", false, cx);
  assert.equal(v.pop, null); assert.equal(v.filterView, null);
});

test("each space keeps its own filter: s1 and s2 sidebars do not share, and the key follows the space at render", () => {
  v.setFilters({ project: ["pa"] }); // sidebar in s1
  host.focused = { space: "s2", terminal: "tTasks2" };
  const w = new Tasks(); w.init({}, cx);
  assert.deepEqual(w.filters(), {}, "a sidebar in another space starts unfiltered");
  w.setFilters({ project: ["pb"] });
  assert.deepEqual(w.filters(), { project: ["pb"] });
  host.focused = { space: "s1", terminal: "tTasks" };
  assert.deepEqual(v.filters(), { project: ["pa"] }, "s1 is untouched by s2");
  assert.equal(rows(render()), 2);
  host.focused = { space: "s2" }; // same view, the space changed: read at render, not cached
  assert.equal(rows(render()), 1);
});

test("no space known: a separate fallback key, not any space's filter", () => {
  v.setFilters({ project: ["pa"] });
  host.focused = undefined;
  assert.deepEqual(v.filters(), {});
  v.setFilters({ project: ["pb"] });
  assert.deepEqual(host.state["drover.tasks.filters"], { project: ["pb"] });
  assert.deepEqual(host.state["drover.tasks.filters:s1"], { project: ["pa"] });
});
