// Edit dialog S8: note hover actions (collapse, edit, copy, copy ID, sub-task, delete) on the activity cards.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { list } from "../_lib/store.js";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { Editor } = await import(new URL("../drover-todos/main.js", import.meta.url).href);
const { NODE } = await import(new URL("./stubs/el.js", import.meta.url).href);

let host, work, errors;
const tick = () => new Promise((r) => setImmediate(r));
const flushAll = async () => { while (work.size) await Promise.allSettled([...work]); await tick(); };
const mkcx = () => {
  const cx = { notify() {}, stop_propagation() {}, timer: { after() {} },
    spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)).catch((e) => errors.push(e)).finally(() => work.delete(p)); work.add(p); } };
  return cx;
};
const T = (id, over = {}) => ({ id, title: id, desc: "", priority: "P2", tags: [], column: "todo", archived: false, agent: null, source: null, assignee: null, notes: [], run: null, created: 1, updated: 1, ...over });
const CFG = { agents: [{ id: "claude", name: "Claude", command: "claude", soul: "", instructions: "" }, { id: "codex", name: "Codex", command: "codex", soul: "", instructions: "" }], squads: [{ id: "s1", name: "Crew", leader: "claude", members: [] }] };
beforeEach(() => {
  work = new Set(); errors = [];
  host = globalThis.__host = { appHome: "/tmp/none", props: { overlay: "o", edit: "T-E", column: "todo" }, state: { "drover.agents": CFG }, notified: [], closeCalls: [], opened: [], terminals: [], exec: async () => ({ code: 0 }) };
  host.closeOverlay = (...a) => host.closeCalls.push(a);
  host.openOverlay = (o) => host.opened.push(o);
});
const seed = (main, others = []) => {
  host.state["drover.tasks"] = [T("T-E", main), ...others];
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  e.sent = []; e.started = [];
  e.sendToAgent = async (a, t) => { e.sent.push([a, t]); };
  e.launch = async (task, runner, opts) => { e.startedTask = task; e.started.push([task?.id, runner, opts]); return e.launchResult ?? { id: "R" }; };
  return e;
};
const render = (e) => {
  globalThis.__rec = { ids: [], texts: [], md: [], textareas: [] };
  const root = e.render({ notify() {}, listener: () => () => {} });
  const r = globalThis.__rec; globalThis.__rec = null;
  return { ...r, root: root[NODE] };
};
const find = (n, id) => (n.id === id ? n : n.kids.map((k) => find(k, id)).find(Boolean) ?? null);
const stored = () => list(host.state["drover.tasks"]).find((x) => x.id === "T-E"); // as load() reads it: ids backfilled


const NID = (task, i) => task.notes[i].id;
const N3 = [{ at: 1000, by: "you", text: "alpha\nline two" }, { at: 2000, by: "you", text: "beta" }, { at: 3000, by: "you", text: "gamma" }];
const mkcxc = () => { const cx = mkcx(); cx.clip = []; cx.write_to_clipboard = (s) => cx.clip.push(s); return cx; };
const ids = (e) => stored().notes.map((n) => n.id);

test("hover reveals the actions: hidden by default, shown on hover, and while its menu is open", () => {
  const e = seed({ notes: N3 });
  const id0 = stored().notes[0].id, id1 = stored().notes[1].id;
  let r = render(e);
  assert.equal(r.ids.filter((i) => i.startsWith("note-actions-")).length, 0);
  e.hoverNote(id0, true, mkcx());
  r = render(e);
  assert.deepEqual(r.ids.filter((i) => i.startsWith("note-actions-")), [`note-actions-${id0}`]);
  assert.ok(r.ids.includes(`note-collapse-${id0}`) && r.ids.includes(`note-more-${id0}`));
  e.hoverNote(id0, false, mkcx());
  assert.equal(render(e).ids.filter((i) => i.startsWith("note-actions-")).length, 0);
  e.setNoteMenu(id1, true, mkcx()); // menu open keeps its card's actions even if the pointer left
  assert.deepEqual(render(e).ids.filter((i) => i.startsWith("note-actions-")), [`note-actions-${id1}`]);
});

test("the … menu has exactly 6 items in order with 2 dividers: Edit | Copy, Copy note ID, Create sub-task | Delete", () => {
  const e = seed({ notes: N3 });
  const id = stored().notes[0].id;
  e.hoverNote(id, true, mkcx());
  assert.equal(find(render(e).root, `note-menu-${id}`), null, "closed menu is not rendered");
  e.setNoteMenu(id, true, mkcx());
  const r = render(e);
  const menu = find(r.root, `note-menu-${id}`);
  assert.ok(menu && find(r.root, `pop-note-${id}`));
  assert.deepEqual(menu.kids.map((k) => k.id), ["nm-edit", "nm-div-1", "nm-copy", "nm-copy-id", "nm-subtask", "nm-div-2", "nm-delete"]);
  for (const [i, t] of [["nm-edit", "Edit"], ["nm-copy", "Copy"], ["nm-copy-id", "Copy note ID"], ["nm-subtask", "Create sub-task from here"], ["nm-delete", "Delete"]]) assert.ok(r.texts.includes(t), t);
  const del = find(menu, "nm-delete");
  assert.ok(del.calls.includes("text_color"), "delete is coloured (red)");
  e.setNoteMenu(id, false, mkcx());
  assert.equal(e.noteMenu, null);
});

test("Copy puts the note markdown on the clipboard; Copy note ID puts T-XXXX#N-abc123", () => {
  const e = seed({ notes: N3 });
  const n = stored().notes[0], cx = mkcxc();
  e.copyNote(n.id, cx);
  e.copyNoteId(n.id, cx);
  assert.deepEqual(cx.clip, ["alpha\nline two", `T-E#${n.id}`]);
  assert.match(cx.clip[1], /^T-E#N-[0-9a-f]{6,}$/);
});

test("Create sub-task opens the create modal on top (edit dialog stays open) with parent + quoted text + ref", () => {
  const e = seed({ notes: N3 });
  const n = stored().notes[0];
  e.noteMenu = n.id;
  e.subtaskFromNote(n.id, mkcx());
  assert.equal(host.opened.length, 1);
  const o = host.opened[0];
  assert.equal(o.props.edit, null);
  assert.equal(o.props.parent, "T-E");
  assert.equal(o.props.draft.desc, `> alpha\n> line two\n\nFrom note T-E#${n.id}`);
  assert.equal(host.closeCalls.length, 0, "the edit dialog is not closed");
  assert.equal(e.noteMenu, null);
});

test("Edit: body becomes an inline Textarea with the text; Cancel / Esc discard; Save (button or Cmd+Enter) saves by id and marks edited", async () => {
  const e = seed({ notes: N3 });
  const [n0, n1] = stored().notes;
  e.startEditNote(n1.id, mkcx());
  let r = render(e);
  assert.ok(r.ids.includes(`note-edit-${n1.id}`) && r.ids.includes(`note-edit-save-${n1.id}`) && r.ids.includes(`note-edit-cancel-${n1.id}`));
  assert.equal(r.md.filter((m) => m.md === "beta").length, 0, "no rendered body while editing");
  const ta = e.editNote.state;
  assert.equal(ta.value(), "beta");
  assert.ok(ta.autoGrow, "auto-grow");
  assert.ok(r.textareas.includes(ta));
  ta.set_value("beta v2");
  e.cancelEditNote(mkcx());
  assert.equal(e.editNote, null);
  assert.equal(stored().notes[1].text, "beta");
  // Esc cancels
  e.startEditNote(n1.id, mkcx());
  e.editNote.state.set_value("nope");
  let stopped = 0;
  e.onEditNoteKey({ key: "escape" }, { notify() {}, stop_propagation() { stopped++; } });
  assert.equal(e.editNote, null); assert.equal(stored().notes[1].text, "beta"); assert.equal(stopped, 1);
  // Cmd+Enter saves
  e.startEditNote(n1.id, mkcx());
  e.editNote.state.set_value("  beta v2 ");
  e.onEditNoteKey({ key: "enter", modifiers: { platform: true } }, { notify() {}, stop_propagation() {} });
  await flushAll();
  assert.equal(e.editNote, null);
  assert.equal(stored().notes[1].text, "beta v2");
  assert.ok(stored().notes[1].edited > 0);
  assert.deepEqual(stored().notes[0], n0, "other notes untouched");
  assert.equal(stored().notes[1].id, n1.id);
  r = render(e);
  assert.ok(r.ids.includes(`note-edited-${n1.id}`) && r.texts.includes("edited"));
  assert.equal(r.ids.filter((i) => i.startsWith("note-edited-")).length, 1);
});

test("Edit saves against current storage: a note added meanwhile survives; an empty text is not saved", () => {
  const e = seed({ notes: N3 });
  const n0 = stored().notes[0];
  e.startEditNote(n0.id, mkcx());
  host.state["drover.tasks"] = host.state["drover.tasks"].map((t) => (t.id === "T-E" ? { ...t, notes: [...t.notes, { id: "N-aaaaaa", at: 9, by: "x", text: "late" }] } : t));
  e.editNote.state.set_value("changed");
  e.saveEditNote(mkcx());
  assert.equal(stored().notes.length, 4);
  assert.equal(stored().notes[3].text, "late");
  e.startEditNote(n0.id, mkcx());
  e.editNote.state.set_value("   ");
  e.saveEditNote(mkcx());
  assert.equal(stored().notes[0].text, "changed", "unchanged");
});

test("Delete: asks inline first (Cancel keeps it), Delete removes by id and keeps the other notes", () => {
  const e = seed({ notes: N3 });
  const [n0, n1, n2] = stored().notes;
  e.askDeleteNote(n1.id, mkcx());
  let r = render(e);
  assert.ok(r.ids.includes(`note-del-confirm-${n1.id}`) && r.ids.includes(`note-del-yes-${n1.id}`) && r.ids.includes(`note-del-no-${n1.id}`));
  assert.ok(r.texts.includes("Delete this note?"));
  assert.equal(stored().notes.length, 3, "nothing removed yet");
  e.cancelDeleteNote(mkcx());
  assert.equal(render(e).ids.filter((i) => i.startsWith("note-del-confirm-")).length, 0);
  e.askDeleteNote(n1.id, mkcx());
  e.deleteNote(n1.id, mkcx());
  assert.deepEqual(stored().notes.map((n) => n.id), [n0.id, n2.id]);
  assert.equal(e.confirmDel, null);
});

test("Collapse: chevron toggles a card to header + first line (muted); expand restores", () => {
  const e = seed({ notes: N3 });
  const n0 = stored().notes[0];
  let r = render(e);
  assert.ok(r.md.some((m) => m.md === "alpha\nline two"));
  e.toggleCollapse(n0.id, mkcx());
  assert.ok(e.collapsed.has(n0.id));
  r = render(e);
  assert.equal(r.md.filter((m) => m.md === "alpha\nline two").length, 0, "full markdown not rendered");
  assert.ok(r.ids.includes(`note-line-${n0.id}`) && r.texts.includes("alpha"), "first line only");
  assert.ok(!r.texts.includes("line two"));
  e.toggleCollapse(n0.id, mkcx());
  assert.ok(render(e).md.some((m) => m.md === "alpha\nline two"));
});

test("an expanded fold's note cards get the same hover actions (and the collapsed fold shows no cards)", () => {
  const e = seed({ notes: [{ at: 1, by: "system", text: "a", kind: "log" }, { at: 2, by: "system", text: "b", kind: "log" }] });
  const id = stored().notes[1].id;
  e.hoverNote(id, true, mkcx());
  assert.equal(render(e).ids.filter((i) => i.startsWith("note-actions-")).length, 0, "collapsed fold: no cards");
  e.folds.add(0);
  const r = render(e);
  assert.ok(r.ids.includes("fold-0"), "still folded into a group");
  assert.deepEqual(r.ids.filter((i) => i.startsWith("note-actions-")), [`note-actions-${id}`]);
  e.setNoteMenu(id, true, mkcx());
  assert.ok(find(render(e).root, `note-menu-${id}`));
  e.askDeleteNote(id, mkcx());
  e.deleteNote(id, mkcx());
  assert.equal(stored().notes.length, 1);
});

test("note header row keeps the same fixed height hovered or not (actions appear without shifting the layout)", () => {
  const e = seed({ notes: N3 });
  const id0 = stored().notes[0].id;
  const head = () => find(render(e).root, `note-head-${id0}`);
  const before = head();
  assert.deepEqual(before.args.h, [24]);
  assert.ok(before.calls.includes("flex_none"));
  e.hoverNote(id0, true, mkcx());
  const after = head();
  assert.deepEqual(after.args.h, before.args.h);
  assert.ok(find(after, `note-actions-${id0}`));
  assert.equal(find(before, `note-actions-${id0}`), null, "hidden actions are not rendered, so they cannot take clicks");
});
