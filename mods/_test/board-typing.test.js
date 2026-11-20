// Board single-key shortcuts must not fire while a filter field has focus: the key only types.
// The stubs cannot prove native focus; they prove the board reacts to the InputState focus/blur events.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { add } from "../_lib/store.js";

register("./hooks.js", import.meta.url);
const seed = () => {
  let tasks = [];
  const mk = (title, patch) => { const r = add(tasks, { title, ...patch }, 1); tasks = r.tasks.map((t) => (t.id === r.task.id ? { ...t, ...patch } : t)); return tasks.at(-1).id; };
  mk("urgent", { column: "todo", priority: "P0" });
  mk("calm", { column: "doing", priority: "P3" });
  return tasks;
};
globalThis.__host = { props: {}, state: {}, notified: [], agents: [] };
const { default: Board } = await import("../drover-board/main.js");
const CFG = await import("../_lib/config.js");
CFG.setSettings("drover-board", {});

const cx = { notify() {}, stop_propagation() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {} } };
const KEYS = {
  n: { key: "n", modifiers: {} }, s: { key: "s", modifiers: {} }, enter: { key: "enter", modifiers: {} },
  up: { key: "up", modifiers: {} }, right: { key: "right", modifiers: {} }, left: { key: "left", modifiers: {} }, shiftLeft: { key: "left", modifiers: { shift: true } },
};
let b, opened;
beforeEach(() => {
  opened = [];
  globalThis.__host.state = { "drover.tasks": seed(), "drover.projects": [] };
  globalThis.__host.openOverlay = (o) => { opened.push(o); return "ov"; };
  b = new Board(); b.init({}, cx);
  b.selected = b.columns().flatMap((c) => c.cards)[0].id;
});
// The host calls the handler registered with InputState.on; none registered means the event changes nothing.
const fire = (f, ev) => f.handlers[ev]?.({}, cx);
const snapshot = () => JSON.stringify([b.selected, globalThis.__host.state["drover.tasks"]]);

for (const name of ["input", "fsearch"]) {
  test(`${name} focused: n, s, enter, arrows do nothing and the field keeps its text`, () => {
    const f = b[name];
    fire(f, "focus");
    const before = snapshot();
    for (const k of Object.values(KEYS)) b.key(k, cx);
    assert.deepEqual(opened, [], "no dialog or picker opens");
    assert.equal(snapshot(), before, "selection and cards unchanged");
    f.set_value("n"); fire(f, "change");
    assert.equal(f.value(), "n");
    if (name === "input") assert.equal(b.query, "n");
  });

  test(`${name} blurred: n opens New task, s picks, arrows move again`, () => {
    const f = b[name];
    fire(f, "focus"); fire(f, "blur");
    b.key(KEYS.n, cx);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].mod, "drover-todos");
    assert.equal(opened[0].props.edit, null);
    b.key(KEYS.s, cx);
    assert.equal(opened.at(-1).mod, "drover-agents");
    const sel = b.selected;
    b.key(KEYS.right, cx);
    assert.notEqual(b.selected, sel, "arrow selection moved");
  });
}

test("one field blurred while the other stays focused still blocks the keys", () => {
  fire(b.input, "focus"); fire(b.fsearch, "focus");
  fire(b.input, "blur");
  b.key(KEYS.n, cx); b.key(KEYS.s, cx);
  assert.deepEqual(opened, []);
  fire(b.fsearch, "blur");
  b.key(KEYS.n, cx);
  assert.equal(opened.length, 1);
});

// The filter popover unmounts its search field on close, and an unmounted field may never fire blur.
for (const [how, close] of [["setPop(false)", () => b.setPop("filter", false, cx)], ["dismissPops()", () => b.dismissPops()], ["another popover opening", () => b.setPop("scope", true, cx)]]) {
  test(`closing the filter popover via ${how} without a blur stops blocking the keys`, () => {
    b.setPop("filter", true, cx);
    fire(b.fsearch, "focus");
    b.key(KEYS.n, cx);
    assert.deepEqual(opened, [], "blocked while the search field is focused");
    close();
    b.key(KEYS.n, cx);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].props.edit, null);
  });
}

test("closing the filter popover does not clear a focused board filter input", () => {
  b.setPop("filter", true, cx);
  fire(b.input, "focus"); fire(b.fsearch, "focus");
  b.dismissPops();
  b.key(KEYS.n, cx);
  assert.deepEqual(opened, []);
});
