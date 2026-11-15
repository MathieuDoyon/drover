// Local parent/child: one optional `parent` task id per task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { add, update, saveText, patchField, setParent, parentOf, childrenOf, validate } from "../_lib/store.js";

const mk = (...titles) => titles.reduce((ts, title, i) => add(ts, { title }, 1000 + i).tasks, []);

test("setParent sets and clears", () => {
  const ts = mk("a", "b");
  const [a, b] = ts;
  const set = setParent(ts, b.id, a.id, 5000);
  assert.equal(set.task.parent, a.id);
  assert.equal(set.task.updated, 5000);
  const cleared = setParent(set.tasks, b.id, null, 6000);
  assert.equal(cleared.task.parent, null);
});

test("patchField accepts parent", () => {
  const [a, b] = mk("a", "b");
  const r = patchField([a, b], b.id, "parent", a.id);
  assert.equal(r.task.parent, a.id);
});

test("setParent errors: task, parent, self, cycle", () => {
  const ts = mk("a", "b", "c");
  const [a, b, c] = ts;
  assert.match(setParent(ts, "nope", a.id).error, /not found/);
  assert.match(setParent(ts, a.id, "nope").error, /not found/);
  assert.match(setParent(ts, a.id, a.id).error, /its own parent/);
  const t2 = setParent(setParent(ts, b.id, a.id).tasks, c.id, b.id).tasks;
  assert.match(setParent(t2, a.id, c.id).error, /cycle/i);
  assert.match(setParent(t2, a.id, b.id).error, /cycle/i);
});

test("archived parent is a valid parent", () => {
  const ts = mk("a", "b");
  const [a, b] = ts;
  const arch = update(ts, a.id, { archived: true }).tasks;
  assert.equal(setParent(arch, b.id, a.id).task.parent, a.id);
});

test("deleted parent: child stays valid, parentOf is null", () => {
  const ts = mk("a", "b");
  const [a, b] = ts;
  const linked = setParent(ts, b.id, a.id).tasks;
  const orphaned = linked.filter((t) => t.id !== a.id);
  const child = orphaned[0];
  assert.equal(parentOf(orphaned, child), null);
  assert.equal(update(orphaned, child.id, { priority: "P0" }).task.parent, a.id);
  assert.equal(setParent(orphaned, child.id, null).task.parent, null);
});

test("parentOf / childrenOf", () => {
  const ts = mk("a", "b", "c");
  const [a, b, c] = ts;
  const t = setParent(setParent(ts, b.id, a.id).tasks, c.id, a.id).tasks;
  assert.equal(parentOf(t, t[1]).id, a.id);
  assert.equal(parentOf(t, t[0]), null);
  assert.deepEqual(childrenOf(t, a.id).map((x) => x.id), [b.id, c.id]);
  assert.deepEqual(childrenOf(t, b.id), []);
});

test("other updates and saveText keep parent; old tasks gain no key", () => {
  const ts = mk("a", "b");
  const [a, b] = ts;
  assert.equal("parent" in b, false);
  const t = setParent(ts, b.id, a.id).tasks;
  assert.equal(update(t, b.id, { priority: "P1" }).task.parent, a.id);
  assert.equal(patchField(t, b.id, "status", "doing").task.parent, a.id);
  assert.equal(saveText(t, b.id, { title: "B2", desc: "x" }).task.parent, a.id);
  assert.equal("parent" in update(ts, b.id, { priority: "P1" }).task, false);
});

test("validate normalizes parent only when present", () => {
  assert.equal("parent" in validate({ title: "x" }).value, false);
  assert.equal(validate({ title: "x", parent: "T-1" }).value.parent, "T-1");
  assert.equal(validate({ title: "x", parent: "" }).value.parent, null);
  assert.equal(validate({ title: "x", parent: 5 }).value.parent, null);
});

import { parentChoices, hasUnsaved } from "../_lib/store.js";
import { sourceCard } from "../_lib/taskrun.js";

test("parentChoices: not self, not archived, not descendants", () => {
  const ts = mk("a", "b", "c", "d");
  const [a, b, c, d] = ts;
  const t = setParent(setParent(ts, b.id, a.id).tasks, c.id, b.id).tasks;
  const arch = update(t, d.id, { archived: true }).tasks;
  assert.deepEqual(parentChoices(arch, a.id).map((x) => x.id), []);
  assert.deepEqual(parentChoices(arch, b.id).map((x) => x.id), [a.id]);
  assert.deepEqual(parentChoices(arch, c.id).map((x) => x.id), [a.id, b.id]);
});

test("hasUnsaved compares title, desc and note to the stored task", () => {
  const stored = { title: "A", desc: "d" };
  assert.equal(hasUnsaved(stored, { title: "A", desc: "d", note: "" }), false);
  assert.equal(hasUnsaved(stored, { title: " A ", desc: "d\n", note: "  " }), false);
  assert.equal(hasUnsaved(stored, { title: "B", desc: "d", note: "" }), true);
  assert.equal(hasUnsaved(stored, { title: "A", desc: "x", note: "" }), true);
  assert.equal(hasUnsaved(stored, { title: "A", desc: "d", note: "hi" }), true);
  assert.equal(hasUnsaved({ title: "A" }, { title: "A", desc: "", note: "" }), false);
});

test("sourceCard carries the Jira parent", () => {
  const parent = { key: "P-1", title: "Epic", status: "Open", category: "new", url: "u" };
  assert.deepEqual(sourceCard({ kind: "jira", key: "K-1", title: "t", parent }).parent, parent);
  assert.equal(sourceCard({ kind: "github", key: "1", title: "t" }).parent, null);
});

// Agent CLI: `drover add --parent` and `drover edit --parent`.
import { addCommand, applyCommand } from "../_lib/store.js";

test("addCommand sets the parent of a new card", () => {
  const [a] = mk("a");
  const r = addCommand([a], { title: "kid", parent: a.id }, null);
  assert.equal(r.task.parent, a.id);
  assert.equal(r.tasks.length, 2);
});

test("addCommand without parent leaves it unset; unknown parent errors and adds nothing", () => {
  const [a] = mk("a");
  assert.equal(addCommand([a], { title: "kid", parent: "" }, null).task.parent ?? null, null);
  assert.match(addCommand([a], { title: "kid", parent: "T-NOPE" }, null).error, /not found/);
});

test("edit --parent sets and clears; self and cycle error", () => {
  const ts = mk("a", "b");
  const [a, b] = ts;
  const set = applyCommand(ts, { op: "edit", id: b.id, parent: a.id });
  assert.equal(set.task.parent, a.id);
  assert.equal(applyCommand(set.tasks, { op: "edit", id: b.id, parent: "none" }).task.parent, null);
  assert.match(applyCommand(ts, { op: "edit", id: a.id, parent: a.id }).error, /own parent/);
  assert.match(applyCommand(set.tasks, { op: "edit", id: a.id, parent: b.id }).error, /cycle/i);
  assert.match(applyCommand(ts, { op: "edit", id: b.id, parent: "T-NOPE" }).error, /not found/);
});

test("edit title and parent together", () => {
  const ts = mk("a", "b");
  const r = applyCommand(ts, { op: "edit", id: ts[1].id, title: "B2", parent: ts[0].id });
  assert.equal(r.task.title, "B2");
  assert.equal(r.task.parent, ts[0].id);
});

import { filterParents, parentLabel } from "../_lib/store.js";

test("filterParents matches title or id, case-insensitive; empty query keeps all", () => {
  const ts = mk("Fix Login bug", "Add export", "Login page");
  assert.equal(filterParents(ts, "").length, 3);
  assert.equal(filterParents(ts, "  ").length, 3);
  assert.deepEqual(filterParents(ts, "LOGIN").map((t) => t.title), ["Fix Login bug", "Login page"]);
  assert.deepEqual(filterParents(ts, ts[1].id.toLowerCase()).map((t) => t.title), ["Add export"]);
  assert.deepEqual(filterParents(ts, "zzz"), []);
});

test("parentLabel strips the owner/repo prefix of GitHub cards", () => {
  assert.equal(parentLabel({ title: "example-org/acme-store#21 Parent issue" }), "#21 Parent issue");
  assert.equal(parentLabel({ title: "CI/CD pipeline" }), "CI/CD pipeline");
  assert.equal(parentLabel({ title: "src/main.js: fix startup" }), "src/main.js: fix startup");
  assert.equal(parentLabel({ title: "Fix Login bug" }), "Fix Login bug");
  assert.equal(parentLabel({ title: "a/b" }), "a/b");
});
