// T-MWL7FAABO29: the Board render read shared state once PER CARD (visibleIds() -> cfg -> shared("drover.config") inside card()).
// A render reads each shared key a number of times that does not depend on the card count; the snapshot is per render, never kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { NODE } from "./stubs/el.js";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { default: Board } = await import(new URL("../drover-board/main.js", import.meta.url).href);
const C = await import(new URL("../_lib/config.js", import.meta.url).href);
const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
const COLS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const cx = { notify() {}, stop_propagation() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {}, every() {} } };
const card = (i) => ({ id: `T-${i}`, title: `card ${i}`, column: COLS[i % 6], priority: "P2", tags: [], created: i, updated: i, project: P.id, archived: false, agent: null, run: null, notes: [], desc: "", assignee: null, source: null });

// A host whose shared state counts reads per key. `cfgShared` is the person's override of drover.config.
const setup = (n, cfgShared = {}) => {
  C.resetCache(); C.setSettings("drover-board", {}); C.setSettings("drover-runs", {});
  const raw = { "drover.tasks": Array.from({ length: n }, (_, i) => card(i + 1)), "drover.projects": [P], "drover.runs": [], "drover.config": cfgShared };
  const reads = {};
  const state = new Proxy(raw, { get(o, k) { if (typeof k === "string") reads[k] = (reads[k] ?? 0) + 1; return o[k]; } });
  globalThis.__host = { props: {}, notified: [], agents: [], panes: [], spaces: [], terminals: [], home: "/h", appHome: "/nowhere", state, focused: { terminal: "t1", cwd: "/x" }, readTextFile: async () => null };
  const b = new Board(); b.init({}, cx);
  return { b, raw, reads };
};
const render = (b) => { globalThis.__rec = { ids: [], texts: [] }; b.render(cx); const r = globalThis.__rec; globalThis.__rec = undefined; return r; };
const counted = (b, reads) => { render(b); for (const k in reads) delete reads[k]; const r = render(b); return { reads: { ...reads }, ...r }; };

for (const scope of ["all", "project:P-1"]) {
  test(`Board render (${scope}): reads of every shared key do not grow with the card count`, () => {
    const seen = [3, 30, 300].map((n) => { const { b, reads } = setup(n); b.scope = scope; const r = counted(b, reads); assert.ok(r.ids.includes(`card-T-${n}`), "cards are rendered with recording on"); return r.reads; });
    assert.deepEqual(seen[1], seen[0], "30 cards read what 3 cards read");
    assert.deepEqual(seen[2], seen[0], "300 cards read what 3 cards read");
    assert.ok(seen[0]["drover.config"] <= 8, `drover.config reads per render: ${seen[0]["drover.config"]}`);
  });
}

test("Board render: a hidden column and a collapsed column build no cards; the hidden count is shown", () => {
  const { b } = setup(12, { "drover-board": { visible_columns: ["backlog", "todo", "doing", "review", "blocked"] } });
  b.sort.todo = "newest"; b.collapsed.add("blocked");
  const r = render(b);
  assert.ok(r.texts.includes("2 hidden"), "T-5 and T-11 sit in done");
  const cards = r.ids.filter((i) => i.startsWith("card-")).sort();
  assert.deepEqual(cards, ["card-T-1", "card-T-12", "card-T-2", "card-T-3", "card-T-6", "card-T-7", "card-T-8", "card-T-9"], "no done cards (T-5, T-11), no cards of the collapsed blocked column (T-4, T-10)");
});

test("Board render: the snapshot is not kept; the same instance sees a changed task and a changed setting on the next render", () => {
  const { b, raw } = setup(6);
  assert.ok(render(b).ids.includes("card-T-1"));
  raw["drover.tasks"] = raw["drover.tasks"].map((t) => (t.id === "T-1" ? { ...t, archived: 9 } : t));
  assert.ok(!render(b).ids.includes("card-T-1"), "an archived card leaves");
  raw["drover.config"] = { "drover-board": { visible_columns: ["backlog"] } };
  const r = render(b);
  assert.ok(r.texts.some((t) => /hidden/.test(t)), "the new visible_columns applies");
});

test("Board keys read fresh state: shift+right moves the selected card using the current visible columns", () => {
  const { b, raw } = setup(6);
  b.selected = "T-1"; // todo
  raw["drover.config"] = { "drover-board": { visible_columns: ["backlog", "todo", "review"] } };
  b.key({ key: "right", modifiers: { shift: true } }, cx);
  assert.equal(raw["drover.tasks"].find((t) => t.id === "T-1").column, "review", "doing is hidden: the card skips to review");
});

// Rendered callbacks: the node tree gives the handler the render built; a test changes the data AFTER that render and fires it.
const find = (n, id) => n.id === id ? n : n.kids.map((k) => find(k, id)).find(Boolean);
const renderTree = (b) => { globalThis.__rec = { ids: [], texts: [] }; try { const root = b.render(cx); return { root: root[NODE], ids: globalThis.__rec.ids, texts: globalThis.__rec.texts }; } finally { globalThis.__rec = undefined; } };
const col = (tasks, id) => tasks.find((t) => t.id === id).column;

test("Board and List: a column sort override orders its cards; a query changes the hidden count", () => {
  for (const view of ["board", "list"]) {
    const { b } = setup(12, { "drover-board": { visible_columns: ["backlog", "todo", "doing", "review", "blocked"] } });
    b.view = view; b.sort.todo = "newest";
    let r = renderTree(b);
    assert.ok(r.ids.indexOf("card-T-7") < r.ids.indexOf("card-T-1"), `${view}: newest first in todo`);
    b.sort.todo = "oldest";
    r = renderTree(b);
    assert.ok(r.ids.indexOf("card-T-1") < r.ids.indexOf("card-T-7"), `${view}: oldest first in todo`);
    assert.ok(r.texts.includes("2 hidden"));
    b.query = "card 5";
    assert.ok(renderTree(b).texts.includes("1 hidden"), `${view}: only T-5 matches among the hidden done cards`);
  }
});

test("Board: a shift arrow built by an earlier render uses the data and visible columns of the moment it is clicked", () => {
  const { b, raw } = setup(6);
  const r = renderTree(b);
  const click = find(r.root, "r-T-1").args.on_click[0];
  raw["drover.tasks"] = raw["drover.tasks"].map((t) => (t.id === "T-3" ? { ...t, title: "edited after render" } : t));
  raw["drover.config"] = { "drover-board": { visible_columns: ["backlog", "todo", "review"] } };
  click({}, cx);
  assert.equal(col(raw["drover.tasks"], "T-1"), "review", "doing is hidden now: the arrow skips it");
  assert.equal(raw["drover.tasks"].find((t) => t.id === "T-3").title, "edited after render", "the newer edit is not overwritten");
});

test("Board: a column drop built by an earlier render moves the dragged card on the current data", () => {
  const { b, raw } = setup(6);
  b.drag = "T-1";
  const r = renderTree(b);
  const drop = find(r.root, "cards-review").args.on_mouse_up[1];
  raw["drover.tasks"] = raw["drover.tasks"].map((t) => (t.id === "T-3" ? { ...t, title: "edited after render" } : t));
  drop({}, cx);
  assert.equal(col(raw["drover.tasks"], "T-1"), "review");
  assert.equal(raw["drover.tasks"].find((t) => t.id === "T-3").title, "edited after render");
  assert.equal(raw["drover.tasks"].length, 6, "no card lost");
});

test("Board keys: a key after a render still reads the current visible columns", () => {
  const { b, raw } = setup(6);
  b.selected = "T-1"; render(b);
  raw["drover.config"] = { "drover-board": { visible_columns: ["backlog", "todo", "review"] } };
  b.key({ key: "right", modifiers: { shift: true } }, cx);
  assert.equal(col(raw["drover.tasks"], "T-1"), "review");
});
