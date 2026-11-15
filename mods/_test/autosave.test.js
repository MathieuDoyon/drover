// Edit dialog S6: autosave (debounced field patches + flush), no footer, Archive in the header, Multica-style note composer.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { Editor } = await import(new URL("../drover-todos/main.js", import.meta.url).href);

let host, errors, timers, writes;
const work = new Set();
const tick = () => new Promise((r) => setImmediate(r));
const flushAll = async () => { while (work.size) await Promise.allSettled([...work]); await tick(); };
const tasks = () => host.state["drover.tasks"] ?? [];
const closes = () => host.closeCalls.length;
const seedTask = (extra = {}) => ({ id: "T-E", title: "t", desc: "d", priority: "P2", tags: ["k"], column: "todo", archived: false, agent: null, source: null, assignee: null, notes: [], created: 1, updated: 1, ...extra });

beforeEach(() => {
  work.clear(); errors = []; timers = []; writes = 0;
  const appHome = mkdtempSync(join(tmpdir(), "autosave-test-"));
  mkdirSync(`${appHome}/drover-tasks/images`, { recursive: true });
  host = globalThis.__host = {
    appHome, props: { overlay: "ov1", edit: "T-E", column: "todo" }, notified: [], closeCalls: [], state: {},
    closeOverlay: () => host.closeCalls.push(1),
    exec: async (_c, args) => { writeFileSync(args.at(-1), "png"); return { code: 0 }; },
  };
  let store = [seedTask(), seedTask({ id: "T-P", title: "parent", column: "doing" })];
  Object.defineProperty(host.state, "drover.tasks", { get: () => store, set: (v) => { writes++; store = v; }, enumerable: true, configurable: true });
});

// A live cx: spawn runs the work, timer.after records the callback so a test fires it by hand.
const mkcx = () => {
  const cx = {
    notify() {}, stop_propagation() {},
    timer: { after: (ms, fn) => { timers.push({ ms, fn }); return { cancel() {} }; } },
    spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)).catch((e) => errors.push(e)).finally(() => work.delete(p)); work.add(p); },
  };
  return cx;
};
const openEdit = (extra) => {
  host.state["drover.tasks"] = [seedTask(extra), seedTask({ id: "T-P", title: "parent", column: "doing" })];
  writes = 0;
  return new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
};
const typeTitle = (e, v, cx = mkcx()) => { e.title.set_value(v); e.title.handlers.change({}, cx); };
const typeDesc = (e, v, cx = mkcx()) => { e.desc.set_value(v); e.desc.handlers.change({}, cx); };
const fireTimers = async () => { const ts = timers.splice(0); for (const t of ts) await t.fn(mkcx()); await flushAll(); };
const render = (e) => {
  globalThis.__rec = { ids: [], texts: [], md: [], textareas: [] };
  e.render({ notify() {}, listener: () => () => {} });
  const r = globalThis.__rec; globalThis.__rec = null;
  return r;
};

test("debounce: rapid edits make one write with the final text, 500ms after the last keystroke", async () => {
  const e = openEdit();
  typeTitle(e, "a"); typeTitle(e, "ab"); typeTitle(e, "abc"); typeDesc(e, "new body");
  assert.equal(writes, 0, "nothing written while typing");
  assert.ok(timers.every((t) => t.ms === 500));
  await fireTimers();
  assert.deepEqual(errors, []);
  assert.equal(writes, 1);
  assert.deepEqual([tasks()[0].title, tasks()[0].desc], ["abc", "new body"]);
  assert.equal(closes(), 0, "autosave never closes");
});

test("autosave writes only changed fields: nothing changed, nothing written", async () => {
  const e = openEdit();
  await e.flushSave(mkcx());
  typeTitle(e, "t"); // same text
  await fireTimers();
  assert.equal(writes, 0);
});

test("autosave is a field patch: a property changed in the store between keystroke and flush survives", async () => {
  const e = openEdit();
  typeTitle(e, "new title");
  host.state["drover.tasks"] = [{ ...tasks()[0], column: "review", priority: "P0", tags: ["z"] }, tasks()[1]];
  await fireTimers();
  const t = tasks()[0];
  assert.deepEqual([t.title, t.column, t.priority, t.tags], ["new title", "review", "P0", ["z"]]);
});

test("blur on title or description flushes at once", async () => {
  const e = openEdit();
  typeTitle(e, "blurred");
  await e.title.handlers.blur({}, mkcx()); await flushAll();
  assert.equal(tasks()[0].title, "blurred");
  typeDesc(e, "blurred body");
  await e.desc.handlers.blur({}, mkcx()); await flushAll();
  assert.equal(tasks()[0].desc, "blurred body");
  assert.equal(writes, 2);
});

test("close flushes pending text first, then closes", async () => {
  const e = openEdit();
  typeTitle(e, "closing"); typeDesc(e, "body2");
  e.close(mkcx()); await flushAll();
  assert.deepEqual(errors, []);
  assert.deepEqual([tasks()[0].title, tasks()[0].desc], ["closing", "body2"]);
  assert.equal(closes(), 1);
});

test("Esc flushes pending text and closes", async () => {
  const e = openEdit();
  typeTitle(e, "via esc");
  e.editKey({ key: "escape" }, mkcx()); await flushAll();
  assert.equal(tasks()[0].title, "via esc");
  assert.equal(closes(), 1);
});

test("expand flushes pending text, then reopens", async () => {
  const opened = [];
  host.openOverlay = (s) => opened.push(s);
  const e = openEdit();
  typeTitle(e, "expanding");
  e.expand(mkcx()); await flushAll();
  assert.equal(tasks()[0].title, "expanding");
  assert.equal(opened.length, 1);
  assert.equal(closes(), 1);
});

test("navigating to the parent flushes pending text, never asks to discard", async () => {
  const opened = [];
  host.openOverlay = (s) => opened.push(s);
  const e = openEdit({ parent: "T-P" });
  typeTitle(e, "before nav");
  e.openParent("T-P", mkcx()); await flushAll();
  assert.deepEqual(errors, []);
  assert.equal(tasks()[0].title, "before nav");
  assert.equal(opened[0].props.edit, "T-P");
  assert.equal(closes(), 1);
  assert.equal(e.confirmParent, undefined);
});

test("failed save: inline error, text stays, close does not leave; a fixed title then closes", async () => {
  const e = openEdit();
  typeTitle(e, "");
  e.close(mkcx()); await flushAll();
  assert.ok(e.error);
  assert.equal(e.title.value(), "");
  assert.equal(closes(), 0);
  assert.equal(tasks()[0].title, "t");
  typeTitle(e, "fixed");
  e.close(mkcx()); await flushAll();
  assert.equal(tasks()[0].title, "fixed");
  assert.equal(closes(), 1);
  assert.equal(e.error, null);
});

test("a failed debounced save shows the error and keeps the text; the next good save clears it", async () => {
  const e = openEdit();
  typeTitle(e, "   ");
  await fireTimers();
  assert.ok(e.error);
  assert.equal(e.title.value(), "   ");
  typeTitle(e, "ok");
  await fireTimers();
  assert.equal(e.error, null);
  assert.equal(tasks()[0].title, "ok");
});

test("flush waits for a paste in flight, then writes the text with the link", async () => {
  let open;
  const gate = new Promise((r) => (open = r));
  host.exec = async (_c, args) => { await gate; writeFileSync(args.at(-1), "png"); return { code: 0 }; };
  const e = openEdit();
  e.pasteImage(mkcx());
  typeTitle(e, "with image");
  const p = e.flushSave(mkcx());
  await tick();
  assert.equal(writes, 0, "not before the paste lands");
  open(); await p; await flushAll();
  assert.equal(tasks()[0].title, "with image");
  assert.match(tasks()[0].desc, /!\[image\]/);
});

test("create mode is untouched: typing schedules no autosave", () => {
  host.props = { overlay: "ov1", edit: null, column: "todo" };
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  typeTitle(e, "x"); typeDesc(e, "y");
  assert.equal(timers.length, 0);
});

test("no footer: Save, Cancel and the discard confirm are gone", () => {
  const r = render(openEdit({ parent: "T-P" }));
  for (const id of ["ed-save", "ed-cancel", "parent-discard", "parent-keep", "parent-confirm"]) assert.ok(!r.ids.includes(id), id);
  assert.ok(!r.texts.includes("Save") && !r.texts.includes("Cancel"));
});

test("Archive lives in the header menu and needs an in-UI confirm", async () => {
  const e = openEdit();
  let r = render(e);
  assert.ok(r.ids.includes("ed-more") && !r.ids.includes("ed-archive"), "menu closed");
  e.toggleMore(mkcx());
  r = render(e);
  assert.ok(r.ids.includes("ed-archive"));
  e.askArchive(mkcx());
  r = render(e);
  assert.ok(r.ids.includes("archive-confirm") && r.ids.includes("archive-yes") && r.ids.includes("archive-no"));
  assert.equal(tasks()[0].archived, false, "no archive before the confirm");
  e.archive(mkcx()); await flushAll();
  assert.equal(tasks()[0].archived, true);
  assert.equal(closes(), 1);
});

test("the ⋯ menu is a Popover (floats), and its outside press / Esc close it", () => {
  const e = openEdit();
  assert.ok(render(e).ids.includes("pop-ed-more"), "trigger lives in the Popover");
  e.setMore(true, mkcx());
  assert.ok(render(e).ids.includes("ed-archive"));
  e.setMore(false, mkcx());
  const r = render(e);
  assert.ok(!r.ids.includes("ed-archive") && !r.ids.includes("ed-more-menu"));
  e.setMore(true, mkcx()); e.askArchive(mkcx()); e.setMore(false, mkcx()); e.setMore(true, mkcx());
  assert.ok(!render(e).ids.includes("archive-confirm"), "reopening starts at Archive, not the confirm");
});

test("archive confirm can be cancelled", () => {
  const e = openEdit();
  e.toggleMore(mkcx()); e.askArchive(mkcx());
  e.cancelArchive(mkcx());
  assert.ok(!render(e).ids.includes("archive-confirm"));
  assert.equal(tasks()[0].archived, false);
});

test("archive flushes pending text then sets the flag", async () => {
  const e = openEdit();
  typeTitle(e, "kept");
  e.archive(mkcx()); await flushAll();
  assert.deepEqual([tasks()[0].title, tasks()[0].archived], ["kept", true]);
});

test("composer: one box, 'Leave a comment…', send disabled when empty, keycaps, no paperclip", () => {
  const e = openEdit();
  assert.equal(e.note.o.placeholder, "Leave a comment…");
  assert.equal(e.noteReady(), false);
  e.note.set_value("  \n ");
  assert.equal(e.noteReady(), false);
  const r = render(e);
  assert.ok(r.ids.includes("note-add") && r.ids.includes("note-kc-command") && r.ids.includes("note-kc-corner-down-left"));
  assert.ok(!r.ids.includes("note-attach") && !r.ids.includes("ed-attach"));
  e.note.set_value("hi");
  assert.equal(e.noteReady(), true);
});

test("composer: Cmd+Enter sends; empty Cmd+Enter does nothing (no error)", () => {
  const e = openEdit();
  const c = mkcx();
  e.onNoteKey({ key: "enter", modifiers: { platform: true } }, c);
  assert.equal(e.error, null);
  assert.deepEqual(tasks()[0].notes, []);
  e.note.set_value("sent");
  e.onNoteKey({ key: "enter", modifiers: { platform: true } }, c);
  assert.deepEqual(tasks()[0].notes.map((n) => n.text), ["sent"]);
});

// An event handler's cx dies when the handler returns; spawn gives the work a live one (the host's rule).
const expiring = () => {
  let alive = true;
  const stale = () => { if (!alive) throw new Error("stale cx: event cx used after the handler returned"); };
  const live = mkcx();
  return { cx: { notify: stale, stop_propagation: stale, timer: { after: stale }, spawn: (fn) => { stale(); live.spawn(fn); } }, expire: () => { alive = false; } };
};

test("blur with a failing save: the error shows without touching the dead event cx", async () => {
  const e = openEdit();
  e.title.set_value("");
  const { cx, expire } = expiring();
  try { e.title.handlers.blur({}, cx); } finally { expire(); }
  await flushAll();
  assert.deepEqual(errors, []);
  assert.ok(e.error);
  assert.equal(e.title.value(), "");
});

test("blur with a good save after an await: no stale cx either", async () => {
  const e = openEdit();
  e.title.set_value("blurred ok"); e.desc.set_value("body ok");
  const { cx, expire } = expiring();
  try { e.desc.handlers.blur({}, cx); } finally { expire(); }
  await flushAll();
  assert.deepEqual(errors, []);
  assert.deepEqual([tasks()[0].title, tasks()[0].desc], ["blurred ok", "body ok"]);
});

test("title submit event with a failing save: no stale cx", async () => {
  const e = openEdit();
  e.title.set_value("");
  const { cx, expire } = expiring();
  try { e.title.handlers.submit({}, cx); } finally { expire(); }
  await flushAll();
  assert.deepEqual(errors, []);
  assert.ok(e.error);
});

test("flush patches only what the person edited: a title edit keeps an external description update", async () => {
  const e = openEdit({ desc: "old body" });
  host.state["drover.tasks"] = [{ ...tasks()[0], desc: "concurrent CLI description" }, tasks()[1]];
  writes = 0;
  typeTitle(e, "my title");
  await fireTimers();
  assert.deepEqual([tasks()[0].title, tasks()[0].desc], ["my title", "concurrent CLI description"]);
});

test("flush patches only what the person edited: a description edit keeps an external title update", async () => {
  const e = openEdit();
  host.state["drover.tasks"] = [{ ...tasks()[0], title: "external title" }, tasks()[1]];
  typeDesc(e, "my desc");
  await e.flushSave(mkcx());
  assert.deepEqual([tasks()[0].title, tasks()[0].desc], ["external title", "my desc"]);
});

test("open and close without an edit writes nothing, even after an external text update", async () => {
  const e = openEdit();
  host.state["drover.tasks"] = [{ ...tasks()[0], title: "ext", desc: "ext body" }, tasks()[1]];
  writes = 0;
  e.close(mkcx()); await flushAll();
  assert.equal(writes, 0);
  assert.deepEqual([tasks()[0].title, tasks()[0].desc], ["ext", "ext body"]);
  assert.equal(closes(), 1);
});

test("after a flush the baseline moves: the next flush writes nothing until another edit", async () => {
  const e = openEdit();
  typeTitle(e, "one");
  await e.flushSave(mkcx());
  host.state["drover.tasks"] = [{ ...tasks()[0], title: "external after" }, tasks()[1]];
  writes = 0;
  await e.flushSave(mkcx());
  assert.equal(writes, 0);
  assert.equal(tasks()[0].title, "external after");
});

test("expand/shrink after an external desc update and a title-only edit: an unchanged close keeps the external desc", async () => {
  const opened = [];
  host.openOverlay = (s) => opened.push(s);
  const e = openEdit({ desc: "old body" });
  host.state["drover.tasks"] = [{ ...tasks()[0], desc: "external desc" }, tasks()[1]];
  typeTitle(e, "my title");
  e.expand(mkcx()); await flushAll();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].props.draft.desc, "external desc", "the draft carries what is stored");
  host.props = { overlay: "ov2", ...opened[0].props };
  const e2 = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  e2.expand(mkcx()); await flushAll(); // shrink
  host.props = { overlay: "ov3", ...opened[1].props };
  const e3 = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  writes = 0;
  e3.close(mkcx()); await flushAll();
  assert.equal(writes, 0);
  assert.deepEqual([tasks()[0].title, tasks()[0].desc], ["my title", "external desc"]);
});

// --- read / edit toggle: read mode (rendered), pencil -> edit mode (Input + auto-grow Textarea), edit mode only; create untouched ---
import { NODE } from "./stubs/el.js";
const renderRec = (e) => {
  globalThis.__rec = { ids: [], texts: [], md: [], textareas: [], inputs: [] };
  const root = e.render({ notify() {}, listener: () => () => {} });
  const r = globalThis.__rec; globalThis.__rec = null;
  return { ...r, root: root[NODE] };
};
const find = (n, id) => (n.id === id ? n : n.kids.map((k) => find(k, id)).find(Boolean) ?? null);
// Popover menus paint in their own layer above the dialog (not a scroll area of the column): not counted.
const scrolls = (n) => (n.id?.startsWith("menu-") ? 0 : (n.calls.includes("overflow_y_scrollbar") ? 1 : 0) + n.kids.reduce((a, k) => a + scrolls(k), 0));

test("read mode: no Input/Textarea/Editor for title and description; rendered markdown, plain title, pencil", () => {
  const e = openEdit({ title: "Plain title", desc: "# hi" });
  const r = renderRec(e);
  assert.ok(!r.inputs.includes(e.title) && !r.textareas.includes(e.desc) && true);
  assert.deepEqual(r.md.map((m) => m.md), ["# hi"]);
  assert.ok(r.texts.includes("Plain title"));
  assert.ok(r.ids.includes("ed-pencil"));
  for (const id of ["desc-edit", "desc-done"]) assert.ok(!r.ids.includes(id), id);
  assert.equal(e.editing, false);
});

test("read mode: an empty description shows a dim placeholder that enters edit mode", () => {
  const e = openEdit({ desc: "" });
  const r = renderRec(e);
  assert.ok(r.ids.includes("desc-empty") && r.md.length === 0);
  e.toggleEdit(mkcx());
  assert.equal(e.editing, true);
});

test("pencil -> edit mode: title Input + auto-grow Textarea, no fixed height box", () => {
  const e = openEdit({ desc: "body" });
  e.toggleEdit(mkcx());
  const r = renderRec(e);
  assert.ok(r.inputs.includes(e.title) && r.textareas.includes(e.desc));
  assert.equal(r.md.length, 0);
  assert.ok(Array.isArray(e.desc.autoGrow) && e.desc.autoGrow[1] > e.desc.autoGrow[0], "set_auto_grow(min, max)");
  const block = find(r.root, "desc-block");
  assert.ok(block && !block.calls.includes("h") && !find(block, "desc-block-fixed"), "no fixed .h on the description block");
  assert.ok(!r.ids.includes("desc-done"));
  assert.ok(e.title.focused >= 1, "the title takes focus");
});

test("auto-grow has no practical cap (the thread stays the only scroll): a description longer than the old 18/40 row caps", () => {
  const long = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
  const small = openEdit({ desc: long });
  assert.ok(small.desc.autoGrow[1] >= 400 && small.desc.autoGrow[1] > 120);
  host.props = { overlay: "ov1", edit: "T-E", column: "todo", large: true };
  const large = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  assert.ok(large.desc.autoGrow[1] >= 400);
});

test("pencil again flushes the pending text once and returns to the rendered saved text", async () => {
  const e = openEdit({ desc: "old" });
  e.toggleEdit(mkcx());
  typeTitle(e, "T2"); typeDesc(e, "D2");
  e.toggleEdit(mkcx()); await flushAll();
  assert.deepEqual(errors, []);
  assert.equal(writes, 1);
  assert.deepEqual([tasks()[0].title, tasks()[0].desc], ["T2", "D2"]);
  assert.equal(e.editing, false);
  const r = renderRec(e);
  assert.deepEqual(r.md.map((m) => m.md), ["D2"]);
  assert.ok(r.texts.includes("T2"));
  await fireTimers(); // the stale debounce timers do nothing
  assert.equal(writes, 1);
});

test("leaving edit mode with a failing save stays in edit mode with the error", async () => {
  const e = openEdit();
  e.toggleEdit(mkcx());
  typeTitle(e, "");
  e.toggleEdit(mkcx()); await flushAll();
  assert.equal(e.editing, true);
  assert.ok(e.error);
  assert.equal(e.title.value(), "");
});

test("exactly one scroll container in the main column, in read and in edit mode", () => {
  const e = openEdit({ desc: "body" });
  assert.equal(scrolls(find(renderRec(e).root, "main-col")), 1);
  e.toggleEdit(mkcx());
  assert.equal(scrolls(find(renderRec(e).root, "main-col")), 1);
});

test("Esc: leaves edit mode first (flushing), a second Esc closes", async () => {
  const e = openEdit();
  e.toggleEdit(mkcx());
  typeTitle(e, "esc title");
  e.editKey({ key: "escape" }, mkcx()); await flushAll();
  assert.equal(e.editing, false);
  assert.equal(closes(), 0);
  assert.equal(tasks()[0].title, "esc title");
  e.editKey({ key: "escape" }, mkcx()); await flushAll();
  assert.equal(closes(), 1);
});

test("Cmd+Enter while editing leaves edit mode (flush), once per press", async () => {
  const e = openEdit();
  e.toggleEdit(mkcx());
  e.desc.set_value("via key");
  const c = mkcx();
  e.onSubmitKey({ key: "enter", modifiers: { platform: true } }, c);
  e.desc.handlers.submit({ secondary: true }, c);
  await flushAll();
  assert.equal(tasks()[0].desc, "via key");
  assert.equal(e.editing, false);
  assert.equal(closes(), 0);
});

test("create mode keeps its Textarea and Input, untouched", () => {
  host.props = { overlay: "ov1", edit: null, column: "todo" };
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  const r = renderRec(e);
  assert.ok(r.textareas.includes(e.desc) && r.inputs.includes(e.title));
  assert.ok(!r.ids.includes("ed-pencil"));
});

test("typing in the description autosaves debounced as one field patch", async () => {
  const e = openEdit();
  e.toggleEdit(mkcx());
  typeDesc(e, "a"); typeDesc(e, "ab"); typeDesc(e, "abc");
  assert.equal(writes, 0);
  await fireTimers();
  assert.equal(writes, 1);
  assert.equal(tasks()[0].desc, "abc");
});

test("an image paste inserts at the cursor in the middle of the text", async () => {
  const e = openEdit({ desc: "abcdef" });
  e.toggleEdit(mkcx());
  e.desc.set_selected_range({ start: 3, end: 3 });
  e.pasteImage(mkcx()); await flushAll();
  assert.deepEqual(errors, []);
  assert.match(e.desc.value(), /^abc!\[image\]\(<[^>]+>\)def$/);
  assert.ok(e.desc.focused >= 1);
  await e.flushSave(mkcx());
  assert.match(tasks()[0].desc, /^abc!\[image\]\(<[^>]+>\)def$/);
});

test("an image paste replaces the selected range", async () => {
  const e = openEdit({ desc: "abcdef" });
  e.toggleEdit(mkcx());
  e.desc.set_selected_range({ start: 1, end: 4 });
  e.pasteImage(mkcx()); await flushAll();
  assert.match(e.desc.value(), /^a!\[image\]\(<[^>]+>\)ef$/);
});

test("an image paste with the cursor at the end appends; the file is tracked as pasted", async () => {
  const e = openEdit({ desc: "before" });
  e.toggleEdit(mkcx());
  e.pasteImage(mkcx()); await flushAll();
  assert.match(e.desc.value(), /^before!\[image\]/);
  assert.equal(e.pasted.length, 1);
});

test("create mode and the agent prompt still append the image link (unchanged)", async () => {
  host.props = { overlay: "ov1", edit: null, column: "todo" };
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  e.desc.set_value("abcdef"); e.desc.set_selected_range({ start: 2, end: 2 });
  e.pasteImage(mkcx()); await flushAll();
  assert.match(e.desc.value(), /^abcdef\n!\[image\]/, "create: appended at the end, as before");
  e.mode = "agent"; e.prompt.set_value("do it");
  e.pasteImage(mkcx()); await flushAll();
  assert.match(e.prompt.value(), /^do it\n!\[image\]/);
});
