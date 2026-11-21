// B7: typing, selection, Enter. Drives the real field handlers and the root key handler.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [] };
const { default: Jump } = await import(new URL("../drover-jump/main.js", import.meta.url).href);

const K = (key) => ({ key, modifiers: {} });
let H, v, cx, timers, runs, opened, closed;
const task = (id, title, extra = {}) => ({ id, title, column: "todo", project: null, created: 1, agent: null, ...extra });

function boot(state = {}, host = {}) {
  runs = []; opened = []; closed = []; timers = [];
  H = globalThis.__host = {
    props: { overlay: "o9" }, notified: [], agents: [], terminals: [], panes: [], spaces: [], home: "/h", appHome: "/nowhere", focused: { terminal: "t1", space: "s1" },
    state: {
      "drover.tasks": [task("T-1", "Fix login", { agent: "t7" }), task("T-2", "Fix signup"), task("T-3", "Docs", { project: "P-1" })],
      "drover.projects": [{ id: "P-1", name: "Alpha" }, { id: "P-2", name: "Empty project" }],
      "drover.runs": [],
      ...state,
    },
    agents_: null,
    run: (...a) => runs.push(a), openOverlay: (o) => { opened.push(o); return "ov1"; }, closeOverlay: (id) => closed.push(id), ...host,
  };
  H.agents = host.agents ?? [{ address: "t7", status: "working" }];
  H.terminals = host.terminals ?? [{ address: "t7" }];
  cx = { notify() {}, stop_propagation() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { every: (_ms, fn) => timers.push(fn), after() {} } };
  v = new Jump(); v.init({}, cx);
}
const submit = () => v.input.handlers.submit({}, cx);
const type = (s) => { v.input.set_value(s); v.input.handlers.change({}, cx); };
const tick = () => timers.forEach((f) => f(cx));
const keysOf = () => v.cache.get().results.map((x) => x.key);
beforeEach(() => boot());

test("typing filters the results and resets the selection to the first", () => {
  assert.equal(keysOf().length, 5);
  v.key(K("down"), cx);
  type("fix");
  assert.deepEqual(keysOf(), ["card:T-1", "card:T-2"]);
  assert.equal(v.sel, "card:T-1");
});

test("Up/Down move and clamp at both ends", () => {
  const all = keysOf();
  v.key(K("up"), cx);
  assert.equal(v.sel, all[0]);
  for (let i = 0; i < 20; i++) v.key(K("down"), cx);
  assert.equal(v.sel, all.at(-1));
  v.key(K("up"), cx);
  assert.equal(v.sel, all.at(-2));
});

test("empty results: Enter does nothing and keeps the dialog open", () => {
  type("zzzz");
  assert.deepEqual(keysOf(), []);
  submit();
  v.input.handlers.submit({}, cx);
  assert.deepEqual(runs, []);
  assert.deepEqual(opened, []);
  assert.deepEqual(closed, []);
});

test("a refresh keeps the selected key when still present, else falls back to the first", () => {
  type("fix");
  v.key(K("down"), cx);
  assert.equal(v.sel, "card:T-2");
  H.state["drover.tasks"] = [...H.state["drover.tasks"], task("T-9", "Fix more")];
  tick();
  assert.equal(v.sel, "card:T-2");
  H.state["drover.tasks"] = H.state["drover.tasks"].filter((t) => t.id !== "T-2");
  tick();
  assert.equal(v.sel, keysOf()[0]);
});

test("a refresh re-filters the current query (a new matching card appears)", () => {
  type("docs");
  assert.deepEqual(keysOf(), ["card:T-3"]);
  H.state["drover.tasks"] = [...H.state["drover.tasks"], task("T-8", "More docs")];
  tick();
  assert.deepEqual(keysOf().sort(), ["card:T-3", "card:T-8"]);
});

test("Enter on a card with a live agent focuses it, once, and closes the overlay", () => {
  type("login");
  submit();
  assert.deepEqual(runs, [["agent.focus", { terminal: "t7" }]]);
  assert.deepEqual(closed, ["o9"]);
});

test("Enter exactly once: submit plus the bubbling key, or key mashing, acts one time", () => {
  type("login");
  v.input.handlers.submit({}, cx);
  v.key(K("enter"), cx);
  v.key(K("enter"), cx);
  submit();
  assert.equal(runs.length, 1);
  assert.equal(closed.length, 1);
});

test("Enter on a card without an agent opens its editor", () => {
  type("signup");
  submit();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].mod, "drover-todos");
  assert.equal(opened[0].props.edit, "T-2");
  assert.deepEqual(closed, ["o9"]);
});

test("Enter on a run focuses its first live member, else opens the Runs screen", () => {
  const run = { id: "R-1", task: "T-1", title: "", terminals: [{ address: "t3", role: "worker" }, { address: "t7", role: "leader" }], started: 1 };
  boot({ "drover.runs": [run] }, { terminals: [{ address: "t7" }], agents: [{ address: "t7", status: "working" }] });
  type("R-1");
  assert.equal(v.cache.get().results[0].kind, "run");
  submit();
  assert.deepEqual(runs, [["agent.focus", { terminal: "t7" }]]);
  boot({ "drover.runs": [run] }, { terminals: [], agents: [] });
  type("R-1");
  submit();
  assert.deepEqual(runs.at(-1), ["tab.new", { name: "Runs", mod: "drover-runs" }]);
});

test("Enter on a project writes the Tasks per-space filter and shows Room + Tasks", () => {
  type("alpha");
  assert.equal(v.cache.get().results.find((x) => x.kind === "project").key, "project:P-1");
  v.sel = "project:P-1";
  submit();
  assert.deepEqual(H.state["drover.tasks.filters:s1"], { project: ["P-1"] });
  assert.deepEqual(runs, [["layout.show", { id: "drover" }], ["layout.show", { id: "drover-room" }], ["layout.show", { id: "drover-tasks" }], ["layout.hide", { id: "drover-needs" }]]);
  assert.deepEqual(closed, ["o9"]);
});

test("project: no space known falls back to the unscoped filter; a project with no cards still selects", () => {
  boot({}, { focused: null });
  type("empty project");
  submit();
  assert.deepEqual(H.state["drover.tasks.filters"], { project: ["P-2"] });
  assert.equal(H.state["drover.tasks.filters:s1"], undefined);
});

test("project: the jump replaces the old filter object (nothing hides the project's cards)", () => {
  boot({ "drover.tasks.filters:s1": { status: ["done"], project: ["P-9"] } });
  type("alpha");
  v.sel = "project:P-1";
  submit();
  assert.deepEqual(H.state["drover.tasks.filters:s1"], { project: ["P-1"] });
});

test("the action resolves from the current snapshot at Enter: a card removed since the last tick does nothing", () => {
  type("signup");
  H.state["drover.tasks"] = H.state["drover.tasks"].filter((t) => t.id !== "T-2");
  submit();
  assert.deepEqual(opened, []);
  assert.deepEqual(runs, []);
});

test("Escape closes the overlay once", () => {
  v.key(K("escape"), cx);
  v.key(K("escape"), cx);
  assert.deepEqual(closed, ["o9"]);
});

test("overlay == null (host check): nothing happens, no throw", () => {
  boot({}, {});
  H.props = { overlay: null };
  const w = new Jump(); w.init({}, cx);
  assert.doesNotThrow(() => w.key(K("enter"), cx));
  assert.deepEqual(closed, []);
  assert.deepEqual(runs, []);
});

// ---- B7 review fixes ----
test("project jump reveals a hidden `drover` parent: the nested Room and Tasks end up visible, Needs hidden", () => {
  const tree = { drover: { hidden: true, parent: null }, "drover-room": { hidden: true, parent: "drover" }, "drover-tasks": { hidden: true, parent: "drover" }, "drover-needs": { hidden: false, parent: "drover" } };
  const visible = (id) => { for (let n = id; n; n = tree[n].parent) if (tree[n].hidden) return false; return true; };
  boot({}, { run: (cmd, a) => { if (cmd === "layout.show") tree[a.id].hidden = false; if (cmd === "layout.hide") tree[a.id].hidden = true; } });
  type("alpha");
  v.sel = "project:P-1";
  submit();
  assert.deepEqual(["drover", "drover-room", "drover-tasks"].map(visible), [true, true, true]);
  assert.equal(visible("drover-needs"), false);
});

test("a removed selection with other results: submit + bubbling Enter does nothing and closes nothing, then a fresh Enter acts", () => {
  type("fix");
  v.key(K("down"), cx);
  assert.equal(v.sel, "card:T-2");
  H.state["drover.tasks"] = H.state["drover.tasks"].filter((t) => t.id !== "T-2");
  v.input.handlers.submit({}, cx);
  v.key(K("enter"), cx);
  assert.deepEqual(opened, []);
  assert.deepEqual(runs, []);
  assert.deepEqual(closed, []);
});

test("keyboard selection is revealed in the list: the requested index follows Up/Down, typing and a refresh", () => {
  globalThis.__scrolls = [];
  boot();
  const all = keysOf();
  v.key(K("down"), cx); v.key(K("down"), cx);
  assert.equal(globalThis.__scrolls.at(-1), 2);
  type("fix");
  assert.equal(globalThis.__scrolls.at(-1), 0);
  v.key(K("down"), cx);
  assert.equal(globalThis.__scrolls.at(-1), 1);
  H.state["drover.tasks"] = [task("T-0", "Fix zero"), ...H.state["drover.tasks"]];
  tick();
  assert.equal(v.sel, "card:T-2");
  assert.equal(globalThis.__scrolls.at(-1), keysOf().indexOf("card:T-2"));
  assert.ok(all.length > 2);
  globalThis.__scrolls = undefined;
});

// Enter has ONE authoritative path while the field is focused: its submit. The bubbled root key is ignored (no clock involved).
test("a delayed duplicate (the bubbled key long after the submit's no-target attempt) does nothing", () => {
  type("fix");
  v.key(K("down"), cx);
  H.state["drover.tasks"] = H.state["drover.tasks"].filter((t) => t.id !== "T-2");
  let clock = Date.now(); const realNow = Date.now; Date.now = () => (clock += 10_000); // a fake clock that jumps 10 s per read: any time-window guard has expired by the second delivery
  try { submit(); v.key(K("enter"), cx); } finally { Date.now = realNow; }
  assert.deepEqual(opened, []);
  assert.deepEqual(runs, []);
  assert.deepEqual(closed, []);
});

test("a fresh press right after a no-target attempt still acts", () => {
  type("fix");
  v.key(K("down"), cx);
  H.state["drover.tasks"] = H.state["drover.tasks"].filter((t) => t.id !== "T-2");
  submit(); // no target
  type("docs");
  submit(); // a new press: acts at once, however soon
  assert.equal(opened.length + runs.length, 1);
  assert.deepEqual(closed, ["o9"]);
});

test("the same event object delivered twice acts once; with the field blurred the root key is the path", () => {
  type("login");
  const ev = {};
  v.input.handlers.submit(ev, cx);
  v.input.handlers.submit(ev, cx);
  assert.equal(runs.length, 1);
  boot();
  type("login");
  v.input.handlers.blur({}, cx);
  v.key(K("enter"), cx);
  assert.equal(runs.length, 1, "blurred: the key acts");
  v.key(K("enter"), cx);
  assert.equal(runs.length, 1);
});

test("a focused field: the root Enter alone does nothing (the submit is the one path)", () => {
  type("login");
  v.key(K("enter"), cx);
  assert.deepEqual(runs, []);
  v.input.handlers.blur({}, cx);
  v.input.handlers.focus({}, cx);
  v.key(K("enter"), cx);
  assert.deepEqual(runs, []);
});
