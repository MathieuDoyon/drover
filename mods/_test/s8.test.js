// Edit dialog S8: stable note ids, note-edit / note-rm by id, note reference + sub-task prefill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { list, applyCommand, noteIds, noteHashCount } from "../_lib/store.js";
import { noteRef, noteQuote, subtaskPrefill } from "../_lib/notesend.js";

const T = (id, notes) => ({ id, title: id, desc: "", priority: "P2", tags: [], column: "todo", archived: false, agent: null, source: null, assignee: null, notes, created: 1, updated: 1 });
const old = () => [{ at: 100, by: "you", text: "first" }, { at: 200, by: "t7d", text: "second", kind: "log" }, { at: 200, by: "t7d", text: "second", kind: "log" }];
const ID = /^N-[0-9a-f]{6,}$/;

test("old notes get deterministic ids, text unchanged, duplicates distinct, stable across reloads", () => {
  const a = list([T("T-A", old())])[0].notes, b = list(JSON.parse(JSON.stringify([T("T-A", old())])))[0].notes;
  assert.deepEqual(a.map((n) => n.id), b.map((n) => n.id));
  a.forEach((n) => assert.match(n.id, ID));
  assert.equal(new Set(a.map((n) => n.id)).size, 3);
  assert.deepEqual(a.map((n) => n.text), ["first", "second", "second"]);
  assert.equal(list(list([T("T-A", old())]))[0].notes[0].id, a[0].id); // idempotent
});

test("existing ids are kept; noteIds helper matches list", () => {
  const n = [{ id: "N-abcdef", at: 1, by: "x", text: "t" }];
  assert.equal(list([T("T-A", n)])[0].notes[0].id, "N-abcdef");
  assert.deepEqual(noteIds(old()).map((x) => x.id), list([T("T-A", old())])[0].notes.map((x) => x.id));
});

test("op note gives the new note an id", () => {
  const r = applyCommand(list([T("T-A", [])]), { op: "note", id: "T-A", text: "hi", by: "me" }, 5);
  assert.match(r.task.notes[0].id, ID);
});

test("note-edit by id sets text + edited, keeps other notes", () => {
  const tasks = list([T("T-A", old())]);
  const [n0, n1, n2] = tasks[0].notes;
  const r = applyCommand(tasks, { op: "note-edit", id: "T-A", noteId: n1.id, text: " changed ", now: 999 }, 999);
  assert.equal(r.task.notes[1].text, "changed");
  assert.equal(r.task.notes[1].edited, 999);
  assert.equal(r.task.notes[1].id, n1.id);
  assert.deepEqual(r.task.notes[0], n0);
  assert.deepEqual(r.task.notes[2], n2);
});

test("note-edit patches the current storage: a note added meanwhile survives", () => {
  const tasks = list([T("T-A", old())]);
  const id = tasks[0].notes[0].id;
  const fresh = applyCommand(tasks, { op: "note", id: "T-A", text: "late", by: "x" }, 50).tasks;
  const r = applyCommand(fresh, { op: "note-edit", id: "T-A", noteId: id, text: "e", now: 60 }, 60);
  assert.equal(r.task.notes.length, 4);
  assert.equal(r.task.notes[3].text, "late");
});

test("note-edit errors: unknown note, unknown task, empty text", () => {
  const tasks = list([T("T-A", old())]);
  assert.ok(applyCommand(tasks, { op: "note-edit", id: "T-A", noteId: "N-000000", text: "x" }, 1).error);
  assert.ok(applyCommand(tasks, { op: "note-edit", id: "T-ZZ", noteId: tasks[0].notes[0].id, text: "x" }, 1).error);
  assert.ok(applyCommand(tasks, { op: "note-edit", id: "T-A", noteId: tasks[0].notes[0].id, text: "  " }, 1).error);
});

test("note-rm removes by id only; unknown id is an error", () => {
  const tasks = list([T("T-A", old())]);
  const ns = tasks[0].notes;
  const r = applyCommand(tasks, { op: "note-rm", id: "T-A", noteId: ns[1].id }, 7);
  assert.deepEqual(r.task.notes.map((n) => n.id), [ns[0].id, ns[2].id]);
  assert.ok(applyCommand(tasks, { op: "note-rm", id: "T-A", noteId: "N-nope00" }, 7).error);
});

test("noteRef, noteQuote, subtaskPrefill", () => {
  const task = { id: "T-MWF1" }, note = { id: "N-abc123", text: "line one\nline two" };
  assert.equal(noteRef(task, note), "T-MWF1#N-abc123");
  assert.equal(noteQuote(note), "> line one\n> line two");
  assert.deepEqual(subtaskPrefill(task, note), { parent: "T-MWF1", desc: "> line one\n> line two\n\nFrom note T-MWF1#N-abc123" });
});

test("backfill works without TextEncoder/TextDecoder (the native runtime has none) and gives the same ids (unicode + duplicates)", async () => {
  const fix = () => [{ at: 100, by: "you", text: "héllo ✓ 😀" }, { at: 200, by: "a", text: "s" }, { at: 200, by: "a", text: "s" }];
  const want = list([T("T-A", fix())])[0].notes.map((n) => n.id);
  const { TextEncoder: te, TextDecoder: td } = globalThis;
  delete globalThis.TextEncoder; delete globalThis.TextDecoder;
  try {
    const got = list([T("T-A", fix())])[0].notes.map((n) => n.id);
    assert.deepEqual(got, want);
    assert.deepEqual(got, ["N-0e6f51c8ef02639c", "N-59564d23db6502df", "N-a76e66a44b75e2d8"], "values pinned to the python script's output");
  } finally { globalThis.TextEncoder = te; globalThis.TextDecoder = td; }
});

test("perf: 2000 legacy notes hash once; a second load hashes nothing (memoized)", () => {
  const legacy = () => [T("T-P", Array.from({ length: 2000 }, (_, i) => ({ at: 5000 + i, by: "agent", text: `legacy note number ${i} ${"x".repeat(200)}` })))];
  const before = noteHashCount();
  const first = list(legacy());
  assert.ok(noteHashCount() - before <= 2100, "about one hash per note");
  const mid = noteHashCount();
  const second = list(legacy());
  assert.equal(noteHashCount(), mid, "no hash calls on the repeat load"); // the cache guard: counts calls, no wall-clock budget
  assert.deepEqual(second[0].notes.map((n) => n.id), first[0].notes.map((n) => n.id));
  assert.equal(new Set(first[0].notes.map((n) => n.id)).size, 2000);
  // persisted ids are kept as they are: no hashing at all
  const again = noteHashCount();
  list(first);
  assert.equal(noteHashCount(), again);
});
