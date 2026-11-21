// T-MWL7FAABO29: the host interrupted a render that built every closed menu's rows (drover-todos popover -> list -> map).
// A closed menu builds no row. Ids are recorded by the el stub (__rec): `menu-<name>` is a built menu, `<name>-<key>` one of its rows.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { Editor } = await import(new URL("../drover-todos/main.js", import.meta.url).href);
const { default: Board } = await import(new URL("../drover-board/main.js", import.meta.url).href);
const N = Number(process.env.LAZY_N ?? 200);
const T = (id, over = {}) => ({ id, title: id, desc: "", priority: "P2", tags: [`l${id.length % 7}`], column: "todo", archived: false, agent: null, source: null, assignee: null, notes: [], run: null, created: 1, updated: 1, ...over });
const PROJECTS = Array.from({ length: 50 }, (_, i) => ({ id: `P-${i}`, name: `proj ${i}`, repos: [], folders: [], branch: "main" }));
(await import("../_lib/config.js")).setSettings("drover-board", {});
const bcx = { notify() {}, stop_propagation() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {} } };

beforeEach(() => {
  const tasks = [T("T-E"), ...Array.from({ length: N }, (_, i) => T(`T-${i}`, { tags: [`label${i % 40}`] }))];
  globalThis.__host = { appHome: "/tmp/none", props: { overlay: "o", edit: "T-E", column: "todo" }, state: { "drover.tasks": tasks, "drover.projects": PROJECTS }, notified: [], closeCalls: [], opened: [], terminals: [], exec: async () => ({ code: 0 }) };
  globalThis.__host.closeOverlay = () => {};
  globalThis.__host.openOverlay = () => {};
});
const renderEditor = (e) => {
  globalThis.__rec = { ids: [], texts: [], md: [], textareas: [], inputs: [] };
  const t0 = performance.now();
  e.render({ notify() {}, listener: () => () => {} });
  const ms = performance.now() - t0;
  const r = globalThis.__rec; globalThis.__rec = null;
  return { ids: r.ids, ms };
};
const mkEditor = () => new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
const menus = (ids) => ids.filter((i) => i.startsWith("menu-"));
const rows = (ids, name) => ids.filter((i) => i.startsWith(`${name}-`) && !i.startsWith("menu-"));

test(`Todos dialog: with ${N} tasks every menu is closed, so no menu and no row is built`, () => {
  const e = mkEditor();
  const { ids, ms } = renderEditor(e);
  console.log(`# render cost Todos dialog, ${N} tasks: ${ms.toFixed(1)} ms, ${menus(ids).length} menus built, ${rows(ids, "parent").length} parent rows`);
  assert.deepEqual(menus(ids), [], "a closed menu is not built");
  assert.equal(rows(ids, "parent").length, 0);
});

test("Todos dialog: an open menu builds its own rows and no other menu", () => {
  const e = mkEditor();
  e.menu = "parent";
  const { ids } = renderEditor(e);
  assert.deepEqual(menus(ids), ["menu-parent"]);
  assert.ok(rows(ids, "parent").length >= N, "the parent menu lists the tasks");
  assert.equal(rows(ids, "project").length, 0);
});

test("Board: closed scope, filter and column menus are not built; an open one is", () => {
  const b = new Board(); b.init({}, bcx);
  const go = () => { globalThis.__rec = { ids: [], texts: [] }; const t0 = performance.now(); b.render(bcx); const ms = performance.now() - t0; const r = globalThis.__rec; globalThis.__rec = null; return { ids: r.ids, ms }; };
  const closed = go();
  console.log(`# render cost Board, ${N} tasks, ${PROJECTS.length} projects: ${closed.ms.toFixed(1)} ms`);
  assert.deepEqual(closed.ids.filter((i) => i === "scope-menu" || i === "filter-menu" || i.startsWith("menu-")), [], "no menu built while closed");
  b.setPop("scope", true, bcx);
  const open = go().ids;
  assert.ok(open.includes("scope-menu"));
  assert.ok(!open.some((i) => i.startsWith("menu-")), "a column menu stays unbuilt");
});

// Board gate: the write gate of a remote project is computed once per render, not once per card (28 -> 820 shared reads for 1 -> 100 cards).
test("Board: shared reads of one render do not grow with the number of remote cards", () => {
  const M = "box1", RID = "P-REMOTE1", LID = "P-ONREM";
  const reads = (n) => {
    const rt = (i) => T(`T-R${i}`, { project: RID, column: "todo" });
    globalThis.__host.state = { "drover.tasks": [], "drover.projects": [{ id: LID, name: "pairstone", repos: [], folders: [], branch: "main", remote: { machine: M, projectId: RID, id: "B-1" } }],
      [`drover.remote.${M}.${RID}`]: { at: Date.now(), tasks: Array.from({ length: n }, (_, i) => rt(i)), picks: { assignees: [], projects: [], tags: [] } } };
    const b = new Board(); b.init({}, bcx);
    const counts = {};
    const raw = globalThis.__host.state;
    globalThis.__host.state = new Proxy(raw, { get(t, k) { counts[k] = (counts[k] || 0) + 1; return t[k]; } });
    globalThis.__rec = { ids: [], texts: [] };
    b.render(bcx);
    const r = globalThis.__rec; globalThis.__rec = null;
    globalThis.__host.state = raw;
    return { projects: counts["drover.projects"] ?? 0, cache: counts[`drover.remote.${M}.${RID}`] ?? 0, cards: r.ids.filter((i) => /^(l|r)-T-R/.test(i)).length };
  };
  const one = reads(1), many = reads(100);
  console.log(`# Board shared reads: 1 card ${JSON.stringify(one)}, 100 cards ${JSON.stringify(many)}`);
  assert.ok(many.cards >= 100, `the 100 remote cards rendered (${many.cards})`);
  assert.ok(many.projects - one.projects <= 4, `drover.projects reads: ${one.projects} -> ${many.projects}`);
  assert.ok(many.cache - one.cache <= 4, `remote cache reads: ${one.cache} -> ${many.cache}`);
});
