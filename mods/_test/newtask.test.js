// The new-task key and its guard: drover-newtask (the key), io.edit (records the dialog), drover-todos' View (heartbeat, close hook).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const H = globalThis.__host = { props: { overlay: "o9" }, state: {}, notified: [], appHome: "/h" };
const { default: NewTask } = await import(new URL("../drover-newtask/main.js", import.meta.url).href);
const { default: Todos } = await import(new URL("../drover-todos/main.js", import.meta.url).href);
const { edit } = await import(new URL("../_lib/io.js", import.meta.url).href);
const GUARD = "drover.newtask.open";
const old = (ms) => Date.now() - ms;
let n;
function reset() {
  n = 0;
  Object.assign(H, { state: {}, opened: [], closed: [], props: { overlay: "o9" } });
  H.openOverlay = (o) => { H.opened.push(o); return `ov${++n}`; };
  H.closeOverlay = (id) => H.closed.push(id);
}
const press = () => new NewTask().init({}, {});

test("first press opens the Create task dialog (todo column, no id), records {id, at}, closes its own overlay", () => {
  reset();
  press();
  assert.equal(H.opened.length, 1);
  assert.equal(H.opened[0].mod, "drover-todos");
  assert.equal(H.opened[0].props.edit, null);
  assert.equal(H.opened[0].props.column, "todo");
  assert.equal(H.state[GUARD].id, "ov1");
  assert.ok(Date.now() - H.state[GUARD].at < 1000);
  assert.deepEqual(H.closed, ["o9"]);
});

test("N presses while a live guard exists: no dialog at all (drafts survive); each press closes its own overlay", () => {
  reset();
  press();
  for (let i = 0; i < 5; i++) press();
  assert.equal(H.opened.length, 1);
  assert.equal(H.closed.length, 6);
  H.state[GUARD] = { id: "ov1", at: old(39000) }; // still live with a heartbeat just under 40 s
  press();
  assert.equal(H.opened.length, 1);
});

test("a stale guard (older than 40 s), a cleared guard and a legacy string open a dialog", () => {
  for (const g of [{ id: "ov-old", at: old(41000) }, null, "ov1", {}, { pending: true, at: old(4000) }]) {
    reset();
    H.state[GUARD] = g;
    press();
    assert.equal(H.opened.length, 1, JSON.stringify(g));
  }
});

test("a fresh pending reservation blocks (cross-copy race)", () => {
  reset();
  H.state[GUARD] = { pending: true, at: old(500), token: "x" };
  press();
  assert.equal(H.opened.length, 0);
  assert.deepEqual(H.closed, ["o9"]);
});

test("no overlay id (host check only): nothing opens", () => {
  reset();
  H.props = null;
  press();
  assert.equal(H.opened.length, 0);
});

test("io.edit records create dialogs (also the expand/shrink reopen); edit mode leaves the guard", () => {
  reset();
  edit(null, "todo");
  assert.equal(H.state[GUARD].id, "ov1");
  edit(null, "todo", { title: "d" }, true);
  assert.equal(H.state[GUARD].id, "ov2");
  edit("T-1", "todo");
  assert.equal(H.state[GUARD].id, "ov2");
});

// The Create dialog's View: close() clears only its own id; a heartbeat keeps `at` fresh.
function dialog(overlay, extra = {}) {
  H.props = { overlay, edit: null, column: "todo", ...extra };
  const ticks = [];
  const cx = { notify() { throw new Error("heartbeat must not repaint"); }, spawn() {}, focus_handle: () => ({}), timer: { every: (ms, fn) => ticks.push({ ms, fn }), after() {} } };
  const v = new Todos();
  v.init({}, cx);
  return { v, ticks, cx };
}

test("close hook of a create dialog clears the guard only when the guard is its own id", async () => {
  reset();
  H.state[GUARD] = { id: "ovA", at: Date.now() };
  const { v } = dialog("ovA");
  await v.close({});
  assert.equal(H.state[GUARD], null);
  H.state[GUARD] = { id: "ovB", at: Date.now() };
  await dialog("ovA").v.close({});
  assert.deepEqual(H.state[GUARD].id, "ovB");
});

test("expand reopen: the old dialog closes AFTER the new one is recorded and the new guard stays", async () => {
  reset();
  press(); // dialog ov1 recorded
  const { v } = dialog("ov1");
  edit(null, "todo", { title: "d" }, true); // the reopen records ov2 first
  assert.equal(H.state[GUARD].id, "ov2");
  await v.close({}); // then the old dialog goes
  assert.equal(H.state[GUARD].id, "ov2");
});

test("an edit dialog and a non-overlay copy have no close effect", async () => {
  reset();
  H.state[GUARD] = { id: "ov1", at: Date.now() };
  H.props = { overlay: "ov1", edit: "T-1" };
  await new Todos().init({}, { focus_handle: () => ({}), timer: { every() {}, after() {} } });
  const v = new Todos();
  v.init({}, { focus_handle: () => ({}), timer: { every() {}, after() {} } });
  await v.close({});
  assert.equal(H.state[GUARD].id, "ov1");
  H.props = {};
  const b = new Todos();
  b.init({}, { focus_handle: () => ({}), notify() {}, spawn() {}, timer: { every() {}, after() {} } });
  await b.close({});
  assert.equal(H.state[GUARD].id, "ov1");
});

test("heartbeat every 15 s refreshes `at` of its own guard, not of another dialog's", () => {
  reset();
  H.state[GUARD] = { id: "ovA", at: old(30000) };
  const { ticks, cx } = dialog("ovA");
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].ms, 15000);
  ticks[0].fn(cx);
  assert.equal(H.state[GUARD].id, "ovA");
  assert.ok(Date.now() - H.state[GUARD].at < 1000);
  H.state[GUARD] = { id: "ovB", at: old(30000) };
  ticks[0].fn(cx);
  assert.ok(Date.now() - H.state[GUARD].at > 29000);
});

test("heartbeat re-protects the key: open A, open B, B closes (clears), A's heartbeat restores A and a press opens nothing", async () => {
  reset();
  const a = dialog("ovA");
  H.state[GUARD] = { id: "ovB", at: Date.now() }; // B opened later and took the guard
  const b = dialog("ovB");
  await b.v.close({});
  assert.equal(H.state[GUARD], null);
  a.ticks[0].fn(a.cx);
  assert.equal(H.state[GUARD].id, "ovA");
  press();
  assert.equal(H.opened.length, 0);
});

test("heartbeat never overwrites a different LIVE id; it does overwrite a stale one", () => {
  reset();
  const a = dialog("ovA");
  H.state[GUARD] = { id: "ovB", at: old(5000) };
  a.ticks[0].fn(a.cx);
  assert.equal(H.state[GUARD].id, "ovB");
  H.state[GUARD] = { id: "ovB", at: old(41000) };
  a.ticks[0].fn(a.cx);
  assert.equal(H.state[GUARD].id, "ovA");
});
