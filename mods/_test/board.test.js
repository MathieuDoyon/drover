// Board render tests. The stubs make elements chainable no-ops; with globalThis.__rec set they also run .when(true, fn)
// and record ids and child text, so these tests see which branches rendered (the confirm row, the filter submenu).
// Layout, paint order and real pointer/Esc behaviour are checked natively, not here.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { add } from "../_lib/store.js";

register("./hooks.js", import.meta.url);
const seed = () => {
  let tasks = [];
  const mk = (title, patch) => { const r = add(tasks, { title, ...patch }, 1); tasks = r.tasks.map((t) => (t.id === r.task.id ? { ...t, ...patch } : t)); return tasks.at(-1).id; };
  mk("done A", { column: "done", project: "pa" });
  mk("done B", { column: "done", project: "pb" });
  mk("urgent", { column: "todo", priority: "P0", agent: "t9", tags: ["ui"] });
  mk("calm", { column: "doing", priority: "P3", tags: ["api"] });
  return tasks;
};
globalThis.__host = { props: {}, state: {}, notified: [], agents: [{ address: "t9", status: "working" }] };
const { default: Board } = await import("../drover-board/main.js");
// The screens render a neutral view until their settings are ready: these tests are about the ready screen.
const CFG = await import("../_lib/config.js");
CFG.setSettings("drover-board", {});

const cx = { notify() {}, stop_propagation() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {} } };
let b;
beforeEach(() => {
  globalThis.__host.state = { "drover.tasks": seed(), "drover.projects": [{ id: "pa", name: "Alpha", repos: [] }, { id: "pb", name: "Beta", repos: [] }] };
  b = new Board(); b.init({}, cx);
});
const render = () => { globalThis.__rec = { ids: [], texts: [] }; b.render(cx); const r = globalThis.__rec; globalThis.__rec = null; return r; };
const titles = () => b.columns().flatMap((c) => c.cards.map((x) => x.title)).sort();

test("Board renders in every popover and view state", () => {
  render();
  for (const pop of ["scope", "filter", "col:done", "col:backlog", "col:blocked"]) { b.setPop(pop, true, cx); render(); }
  b.view = "list"; render();
  b.collapse("blocked", cx); render();
  b.view = "board"; render();
});

test("archive menu: Archive all first, then Confirm/Cancel with the captured count", () => {
  b.setPop("col:done", true, cx);
  let r = render();
  assert.ok(r.texts.includes("Archive all") && !r.texts.includes("Confirm"));
  b.confirm = true; b.confirmIds = ["T-1"]; // as the Archive all click sets them, after the menu is open
  r = render();
  assert.ok(r.ids.includes("archive-confirm") && r.ids.includes("archive-cancel"));
  assert.ok(r.texts.includes("Confirm") && r.texts.includes("Cancel") && r.texts.includes("Archive 1 card?"));
  assert.ok(!r.texts.includes("Archive all"));
});

test("setPop: one popover at a time, confirmation dies with its menu, a stale close is ignored", () => {
  b.setPop("col:done", true, cx);
  b.confirm = true; b.confirmIds = ["T-1"];
  b.setPop("filter", true, cx);
  assert.equal(b.pop, "filter");
  assert.equal(b.confirm, false);
  assert.deepEqual(b.confirmIds, []);
  b.setPop("col:done", false, cx);
  assert.equal(b.pop, "filter");
  b.setPop("filter", false, cx);
  assert.equal(b.pop, null);
  b.setPop("col:done", true, cx); b.confirm = true;
  b.dismissPops();
  assert.equal(b.pop, null);
  assert.equal(b.confirm, false);
});

test("filter popover: field list, submenu with back, search narrows, advanced closes", () => {
  b.setPop("filter", true, cx);
  let r = render();
  for (const f of ["status", "agentStatus", "priority", "date", "assignee", "project", "label", "source"]) assert.ok(r.ids.includes(`fr-${f}`), f);
  assert.ok(r.ids.includes("fr-advanced") && r.texts.includes("Switch to advanced filter"));
  assert.ok(!r.ids.includes("fr-clear")); // nothing to clear yet
  b.filterView = "priority";
  r = render();
  assert.ok(r.ids.includes("fr-back") && r.ids.includes("fr-priority-P0") && r.ids.includes("fr-priority-P3"));
  assert.ok(!r.ids.includes("fr-status"));
  b.filterView = null;
  b.fsearch.set_value("alp");
  r = render();
  assert.ok(r.ids.includes("fr-project-pa") && !r.ids.includes("fr-project-pb") && !r.ids.includes("fr-status"));
  b.fsearch.set_value("zzzz");
  assert.ok(render().texts.includes("No match"));
});

test("active filters: chips render, columns() narrows (AND with text filter), reopening resets the menu", () => {
  b.filters = { priority: ["P0"] };
  const r = render();
  assert.ok(r.ids.includes("chip-priority-P0") && r.ids.includes("chips-clear") && r.ids.includes("fr-clear"));
  assert.deepEqual(titles(), ["urgent"]);
  b.filters = { status: ["done"], project: ["pa"] };
  assert.deepEqual(titles(), ["done A"]);
  b.filters = { agentStatus: ["working"] };
  assert.deepEqual(titles(), ["urgent"]); // t9 is working in the fake host
  b.filters = { label: ["api"] };
  b.query = "calm";
  assert.deepEqual(titles(), ["calm"]);
  b.query = "urgent"; // text filter ANDs with the field filter
  assert.deepEqual(titles(), []);
  b.filters = {}; b.query = "";
  assert.equal(titles().length, 4);
  b.setPop("filter", true, cx); b.filterView = "label"; b.fsearch.set_value("x");
  b.setPop("scope", true, cx);
  assert.equal(b.filterView, null);
  assert.equal(b.fsearch.value(), "");
});

test("card footer: saved assignee name always; with a live agent 'Name · addr status'; also when the terminal is gone", () => {
  const t0 = globalThis.__host.state["drover.tasks"];
  globalThis.__host.state["drover.agents"] = { agents: [], squads: [{ id: "cattle", name: "Cattle Drive", leader: "claude", members: [] }] };
  const seedWith = (patch) => (globalThis.__host.state["drover.tasks"] = t0.map((t) => (t.title === "calm" ? { ...t, ...patch } : t)));
  seedWith({ assignee: { kind: "squad", id: "cattle" } });
  assert.ok(render().texts.includes("Cattle Drive"));
  seedWith({ assignee: { kind: "squad", id: "cattle" }, agent: "t9" }); // live agent: name first, then its status
  assert.ok(render().texts.includes("Cattle Drive · t9 working"));
  seedWith({ agent: "t9" }); // no assignee: unchanged
  assert.ok(render().texts.includes("● t9 working"));
  seedWith({ assignee: { kind: "squad", id: "cattle" }, agent: "t-gone" });
  const r = render();
  assert.ok(r.texts.includes("Cattle Drive") && !r.texts.includes("● t-gone gone"));
  seedWith({ assignee: undefined, agent: "t-gone" });
  assert.ok(render().texts.includes("● t-gone gone")); // no saved assignee: the gone warning stays
});
