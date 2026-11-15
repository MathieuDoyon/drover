// Card 6: board defaults. visible_columns hides columns ON SCREEN ONLY (never in the data or the drover CLI); default_sort seeds each column.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { add, shiftVisible, COLUMNS } from "../_lib/store.js";

register("./hooks.js", import.meta.url);
const CFG_KEY = "drover.config";
const seed = () => {
  let tasks = [];
  let n = 0; // fixed ids ("T-1"...): a random id could contain the search word "a" and match "done B"
  const mk = (title, patch) => { const id = `T-${++n}`; const r = add(tasks, { title, ...patch }, 1); tasks = r.tasks.map((t) => (t.id === r.task.id ? { ...t, ...patch, id } : t)); return id; };
  mk("done A", { column: "done", project: "pa" });
  mk("done B", { column: "done", project: "pb" });
  mk("urgent", { column: "todo", priority: "P0" });
  mk("calm", { column: "doing", priority: "P3" });
  mk("old", { column: "doing", priority: "P1", created: 5 });
  mk("fresh", { column: "doing", priority: "P2", created: 50 });
  mk("gone", { column: "review", archived: 9 });
  return tasks;
};
globalThis.__host = { props: {}, state: {}, notified: [], agents: [] };
const { default: Board } = await import("../drover-board/main.js");
const CFG = await import("../_lib/config.js");
CFG.setSettings("drover-board", {});
const cx = { notify() {}, stop_propagation() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {} } };
const state = globalThis.__host;
let b;
const board = (config = {}) => {
  state.state = { "drover.tasks": seed(), "drover.projects": [{ id: "pa", name: "Alpha", repos: [] }, { id: "pb", name: "Beta", repos: [] }], [CFG_KEY]: { "drover-board": config } };
  b = new Board(); b.init({}, cx);
};
const render = () => { globalThis.__rec = { ids: [], texts: [] }; b.render(cx); const r = globalThis.__rec; globalThis.__rec = null; return r; };
const ids = () => b.columns().map((c) => c.id);
const tasks = () => state.state["drover.tasks"];
beforeEach(() => board());

test("by default every column shows and nothing is hidden", () => {
  assert.deepEqual(ids(), COLUMNS.map(([id]) => id));
  assert.equal(b.hiddenCount(), 0);
  assert.ok(!render().texts.some((t) => /hidden/.test(t)));
});

test("a hidden column leaves the board and the list view, but its cards stay in the data", () => {
  board({ visible_columns: ["backlog", "doing", "review"] });
  const before = JSON.stringify(tasks());
  assert.deepEqual(ids(), ["backlog", "doing", "review"]);
  const r = render();
  assert.ok(!r.ids.includes("col-done") && !r.ids.includes("col-todo") && r.ids.includes("col-doing"));
  b.view = "list";
  const l = render();
  assert.ok(!l.ids.includes("lcol-done") && l.ids.includes("lcol-doing"));
  assert.equal(JSON.stringify(tasks()), before, "rendering and hiding never touch the stored tasks");
  assert.equal(tasks().filter((x) => x.column === "done").length, 2);
});

test("the drover CLI still lists the cards of a hidden column and keeps 6 columns", () => {
  const home = mkdtempSync(join(tmpdir(), "drover-hidden-"));
  writeFileSync(join(home, "shared.json"), JSON.stringify({ "drover.tasks": seed(), [CFG_KEY]: { "drover-board": { visible_columns: ["doing"] } } }));
  const run = (...a) => spawnSync(new URL("../drover-tasks/bin/drover", import.meta.url).pathname, a, { env: { ...process.env, HERDR_APP_HOME: home }, encoding: "utf8" });
  const all = run("tasks").stdout;
  for (const t of ["done A", "done B", "urgent", "calm"]) assert.match(all, new RegExp(t), `${t} is in drover tasks`);
  assert.doesNotMatch(all, /gone/, "archived stays out, as before");
  assert.match(run("tasks", "done").stdout, /done A[\s\S]*done B|done B[\s\S]*done A/);
  assert.match(run("tasks", "todo").stdout, /urgent/);
});

test("the Board says how many cards are hidden, and the count follows scope, filter and search", () => {
  board({ visible_columns: ["backlog", "doing", "review", "blocked"] });
  assert.equal(b.hiddenCount(), 3, "urgent + 2 done; the archived card is not counted");
  assert.ok(render().texts.includes("3 hidden"));
  b.query = "done A";
  assert.equal(b.hiddenCount(), 1);
  assert.ok(render().texts.includes("1 hidden"));
  b.query = "";
  b.scope = "project:pa";
  assert.equal(b.hiddenCount(), 1, "scope narrows the count");
  b.scope = "all";
  b.filters = { priority: ["P0"] };
  assert.equal(b.hiddenCount(), 1, "filter narrows the count");
  b.query = "nothing matches this";
  assert.equal(b.hiddenCount(), 0);
  assert.ok(!render().texts.some((t) => /hidden/.test(t)), "no note when nothing is hidden");
});

test("default_sort seeds every column; a column's own Sort choice wins", () => {
  const order = (id) => b.columns().find((c) => c.id === id).cards.map((x) => x.title);
  board({ default_sort: "newest" });
  assert.deepEqual(order("doing"), ["fresh", "old", "calm"]);
  board({ default_sort: "priority" });
  assert.deepEqual(order("doing"), ["old", "fresh", "calm"]);
  b.sort.doing = "newest";
  assert.deepEqual(order("doing"), ["fresh", "old", "calm"], "the column menu wins over the default");
  board();
  assert.equal(order("doing").length, 3);
});

// ---- a card shifted toward a hidden column skips it, and is never lost ----
const T = (column) => [{ id: "T-A", title: "a", desc: "", column, priority: "P2", tags: [], notes: [], created: 1 }];
test("shiftVisible: skips hidden columns in both directions, stops at the last visible one with an error and the card unchanged", () => {
  const visible = ["backlog", "doing", "done"];
  assert.equal(shiftVisible(T("backlog"), "T-A", 1, visible, 5).task.column, "doing");
  assert.equal(shiftVisible(T("doing"), "T-A", 1, visible, 5).task.column, "done", "todo... review, blocked are skipped");
  assert.equal(shiftVisible(T("done"), "T-A", -1, visible, 5).task.column, "doing");
  assert.equal(shiftVisible(T("doing"), "T-A", -1, visible, 5).task.column, "backlog");
  assert.ok(shiftVisible(T("done"), "T-A", 1, visible, 5).error);
  assert.ok(shiftVisible(T("backlog"), "T-A", -1, visible, 5).error);
  assert.ok(shiftVisible(T("doing"), "T-A", 1, ["backlog", "doing"], 5).error, "no visible column that way: the card stays");
  assert.ok(shiftVisible(T("doing"), "T-A", 1, visible, 5).tasks.every((x) => x.id), "tasks come back whole");
});

test("shift keys on the board skip hidden columns; the card ends in a visible column", () => {
  board({ visible_columns: ["backlog", "doing", "done"] });
  const id = tasks().find((x) => x.title === "calm").id;
  b.selected = id;
  b.key({ key: "right", modifiers: { shift: true } }, cx);
  assert.equal(tasks().find((x) => x.id === id).column, "done", "review and blocked are hidden");
  b.key({ key: "right", modifiers: { shift: true } }, cx);
  assert.equal(tasks().find((x) => x.id === id).column, "done", "no visible column further right: stays");
  assert.equal(tasks().length, 7, "no card lost");
});

test("a new card goes to Ready, or to the first visible column when Ready is hidden", () => {
  assert.equal(b.newColumn(), "todo");
  board({ visible_columns: ["doing", "done"] });
  assert.equal(b.newColumn(), "doing");
});
