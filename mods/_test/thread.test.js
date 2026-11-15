// Edit dialog S6 thread: notes oldest first, kind badge, author resolution, composer pinned outside the scroll area.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { Editor } = await import(new URL("../drover-todos/main.js", import.meta.url).href);
const { NODE } = await import(new URL("./stubs/el.js", import.meta.url).href);

let host;
beforeEach(() => { host = globalThis.__host = { appHome: "/tmp/none", props: { overlay: "o", edit: "T-E", column: "todo" }, state: {}, notified: [], closeCalls: [], exec: async () => ({ code: 0 }) }; });
const seed = (notes, runs = []) => {
  host.state["drover.tasks"] = [{ id: "T-E", title: "t", desc: "d", priority: "P2", tags: [], column: "todo", archived: false, agent: null, source: null, assignee: null, notes, run: runs[0]?.id ?? null, created: 1, updated: 1 }];
  host.state["drover.runs"] = runs;
  return new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
};
const render = (e) => {
  globalThis.__rec = { ids: [], texts: [], md: [], textareas: [] };
  const root = e.render({ notify() {}, listener: () => () => {} });
  const r = globalThis.__rec; globalThis.__rec = null;
  return { ...r, root: root[NODE] };
};
const find = (n, id) => (n.id === id ? n : n.kids.map((k) => find(k, id)).find(Boolean) ?? null);
const NOTES = [{ at: 1000, by: "you", text: "first" }, { at: 2000, by: "t5", text: "second", kind: "decision" }, { at: 3000, by: "t77", text: "third" }];
const RUN = { id: "R1", task: "T-E", name: "Squad", started: 1, terminals: [{ address: "t5", name: "Wrangler", role: "Wrangler", started: 1 }] };

test("notes read oldest first", () => {
  const r = render(seed(NOTES));
  const at = (x) => r.md.findIndex((m) => m.md === x);
  assert.ok(at("first") >= 0 && at("first") < at("second") && at("second") < at("third"), r.md.map((m) => m.md).join("|"));
});

test("the kind badge shows only on a note with a kind, with the kind text", () => {
  const r = render(seed(NOTES));
  assert.deepEqual(r.ids.filter((i) => i.startsWith("note-kind-")), ["note-kind-1"]);
  assert.ok(r.texts.includes("decision"));
});

test("author: a resolved agent address shows its name; an unresolved one shows the address; the person stays", () => {
  const r = render(seed(NOTES, [RUN]));
  assert.ok(r.texts.includes("you"));
  assert.ok(r.texts.includes("Wrangler"));
  assert.ok(r.texts.includes("t77"));
  assert.ok(!r.texts.includes("t5"));
});

test("the composer sits outside the scrolling thread; title, description and notes sit inside it", () => {
  const r = render(seed(NOTES));
  const thread = find(r.root, "thread");
  assert.ok(thread, "a thread scroll container");
  assert.ok(find(thread, "notes") && find(thread, "note-0"));
  assert.equal(find(thread, "composer"), null, "composer is not inside the scroll area");
  assert.ok(find(r.root, "composer"), "composer is still rendered");
});

// The stub cannot prove real heights. It proves structure and the sizing calls: every child of the scroll area is flex_none
// (so it cannot shrink to 0), the scroll area and its column are bounded, and the composer is outside it.
const called = (n, m) => n.calls.includes(m);

test("blocker: title, description and notes sit inside #thread and cannot shrink (flex_none)", () => {
  const r = render(seed(NOTES));
  const thread = find(r.root, "thread");
  for (const id of ["title-row", "desc-block", "activity-header", "notes"]) {
    const n = find(thread, id);
    assert.ok(n, `${id} inside #thread`);
    assert.ok(called(n, "flex_none"), `${id} is flex_none`);
  }
  assert.ok(find(thread, "desc-block"), "the description editor inside #thread");
});

test("blocker: the main column and the thread have a definite height; the composer is fixed (flex_none) outside the thread", () => {
  const r = render(seed(NOTES));
  const main = find(r.root, "main-col"), thread = find(r.root, "thread"), composer = find(r.root, "composer");
  assert.ok(called(main, "h_full") && called(main, "min_h"), "main column: h_full + min_h");
  assert.ok(called(thread, "flex_1") && called(thread, "min_h") && called(thread, "overflow_y_scrollbar"), "thread: flex_1 + min_h + scroll");
  assert.ok(called(composer, "flex_none"));
  assert.ok(main.kids.includes(thread) && main.kids.includes(composer), "thread and composer are siblings in the main column");
  assert.ok(called(find(r.root, "body-row"), "min_h") && called(find(r.root, "body-row"), "flex_1"));
});

test("blocker: each note is flex_none so a long thread scrolls instead of squeezing", () => {
  const r = render(seed(NOTES));
  assert.ok(called(find(r.root, "note-0"), "flex_none"));
});
