// Pure view-model for the remote write controls (T-MWHVWR8TIJB): control states, outcome text, the exact ops a UI gesture builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const U = await import("../_lib/remote-write-ui.js");
const W = await import("../_lib/remote-write.js");

const card = (extra = {}) => ({ id: "T-AB1", title: "old title", desc: "old desc", column: "todo", priority: "P2", tags: [], project: "P-LOCAL", remote: { machine: "box1" }, ...extra });
const ON = { remote: true, enabled: true, reason: null, frozen: false };

test("control states: enabled -> no tip; otherwise the writer's reason; frozen says so", () => {
  assert.deepEqual(U.controlState(ON), { on: true, tip: null });
  assert.deepEqual(U.controlState({ remote: true, enabled: false, reason: "box1 needs the update", frozen: false }), { on: false, tip: "box1 needs the update" });
  assert.deepEqual(U.controlState({ remote: true, enabled: false, reason: "Checking box1, try again in a moment", frozen: false }), { on: false, tip: "Checking box1, try again in a moment" });
  assert.deepEqual(U.controlState({ remote: true, enabled: false, reason: "x", frozen: true }), { on: false, tip: "writes frozen" });
  assert.equal(U.controlState({ remote: true, enabled: false, reason: null, frozen: false }).tip, "writes are off");
  assert.equal(U.controlState(undefined).on, false);
});

test("agent ops stay off on a remote card, with the fixed tooltip", () => {
  assert.equal(U.OFF_TIP, "not available for projects on the remote machine yet");
});

test("status line per remote project", () => {
  assert.equal(U.statusLine(ON), "writes on");
  assert.equal(U.statusLine({ remote: true, enabled: false, reason: "box1 needs the update", frozen: false }), "box1 needs the update");
  assert.equal(U.statusLine({ remote: true, enabled: false, reason: "r", frozen: true }), "writes frozen");
});

test("ops built from gestures are exact and whitelisted", () => {
  assert.deepEqual(U.moveOp(card(), "doing"), { op: "move", id: "T-AB1", column: "doing" });
  assert.equal(U.moveOp(card(), "todo"), null, "same column: nothing to send");
  assert.equal(U.moveOp(card(), "nowhere"), null);
  assert.deepEqual(U.shiftOp(card({ column: "doing" }), ["backlog", "todo", "doing", "review", "done"], 1), { op: "move", id: "T-AB1", column: "review" });
  assert.deepEqual(U.shiftOp(card({ column: "doing" }), ["backlog", "todo", "doing", "review", "done"], -1), { op: "move", id: "T-AB1", column: "todo" });
  assert.equal(U.shiftOp(card({ column: "done" }), ["todo", "done"], 1), null, "past the last column");
  assert.deepEqual(U.archiveOp(card()), { op: "archive", id: "T-AB1" });
  assert.deepEqual(U.addOp({ title: "  new  ", desc: "d", column: "todo", priority: "P1", tags: ["a"] }), { op: "add", title: "new", desc: "d", tags: ["a"], column: "todo", priority: "P1" });
  assert.equal(U.addOp({ title: "   " }), null);
  for (const o of [U.moveOp(card(), "doing"), U.archiveOp(card()), U.addOp({ title: "x" })]) assert.ok(W.OPS.includes(o.op));
});

test("edit: only changed fields; a note is its own op; nothing to send is an empty list", () => {
  assert.deepEqual(U.editOps(card(), { title: "old title", desc: "old desc", note: "" }), []);
  assert.deepEqual(U.editOps(card(), { title: "new title", desc: "old desc", note: "" }), [{ op: "edit", id: "T-AB1", title: "new title", ifRev: 0 }]);
  assert.deepEqual(U.editOps(card(), { title: "new title", desc: "x", note: "hello" }), [{ op: "edit", id: "T-AB1", title: "new title", desc: "x", ifRev: 0 }, { op: "note", id: "T-AB1", text: "hello" }]);
  assert.deepEqual(U.editOps(card(), { title: "old title", desc: "old desc", note: " hi " }), [{ op: "note", id: "T-AB1", text: "hi", ifRev: 0 }]); // a card with no rev is version 0, never "no baseline"
  assert.deepEqual(U.editOps(card(), { title: "   ", desc: "old desc", note: "" }), [], "an empty title is not sent");
  for (const o of U.editOps(card(), { title: "n", desc: "d", note: "x" })) assert.ok(W.OPS.includes(o.op));
});

test("outcome text: every writer outcome has a fixed message", () => {
  assert.equal(U.outcomeText({ status: "saved" }), "Saved");
  assert.equal(U.outcomeText({ status: "stale", machine: "box1" }), "card changed on box1: reloaded, try again");
  assert.equal(U.outcomeText({ status: "expired" }), "not applied, too old");
  assert.equal(U.outcomeText({ status: "pending" }), "sent, may still apply");
  assert.equal(U.outcomeText({ status: "unknown", machine: "box1" }), "outcome unknown: check the card on box1");
  assert.equal(U.outcomeText({ status: "refused", message: "box1 needs the update" }), "box1 needs the update");
  assert.equal(U.outcomeText({ status: "failed", message: "not sent: nothing was applied" }), "not sent: nothing was applied");
  assert.equal(U.outcomeText({ status: "error", text: "error: unknown task T-ZZ\nsecond line" }), "error: unknown task T-ZZ");
  assert.equal(U.outcomeText({ status: "error", message: "unknown task T-ZZ" }), "error: unknown task T-ZZ");
  assert.equal(U.outcomeText(null), "");
});

test("writes toggle model: on by default, off reports frozen only when the writer says so", () => {
  assert.deepEqual(U.writesToggle({ machine: "box1", projectId: "P-R" }, ON), { on: true, label: "Writes to box1", note: "on" });
  assert.deepEqual(U.writesToggle({ machine: "box1", writes: false }, { frozen: true }), { on: false, label: "Writes to box1", note: "frozen" });
  assert.deepEqual(U.writesToggle({ machine: "box1", writes: false }, { frozen: false }), { on: false, label: "Writes to box1", note: "off, waiting for sends in flight" });
});

test("applied: a saved move becomes the card's column, so the status chip is not sent twice", () => {
  assert.equal(U.applied({ id: "T-1", column: "todo" }, { op: "move", id: "T-1", column: "doing" }).column, "doing");
  assert.equal(U.moveOp(U.applied({ id: "T-1", column: "todo" }, { op: "move", id: "T-1", column: "doing" }), "doing"), null);
});

// ---- T-MWIA1D6HO84: the field ops of a Save ----
const rcard = (extra = {}) => card({ rev: 5, priority: "P2", tags: ["a", "b"], assignee: null, parent: null, remote: { machine: "box1", projectId: "P-R1" }, ...extra });
test("editOps: only changed fields; text edit first, then the note, the project change LAST; ifRev (opened baseline) only on the first op", () => {
  const ops = U.editOps(rcard(), { title: "new", note: "hi", priority: "P0", tags: ["b", "c"], assignee: { kind: "agent", id: "wrangler" }, parent: "T-P", project: "P-R2" });
  assert.deepEqual(ops, [
    { op: "edit", id: "T-AB1", title: "new", priority: "P0", tags: ["b", "c"], assignee: { kind: "agent", id: "wrangler" }, parent: "T-P", ifRev: 5 },
    { op: "note", id: "T-AB1", text: "hi" },
    { op: "edit", id: "T-AB1", project: "P-R2" },
  ]);
});
test("editOps: unchanged drafts send nothing; null clears (\"none\") only when the card has a value; same project is no move", () => {
  assert.deepEqual(U.editOps(rcard(), { priority: "P2", tags: ["b", "a"], assignee: null, parent: null, project: "P-R1" }), []);
  assert.deepEqual(U.editOps(rcard({ assignee: { kind: "squad", id: "s" }, parent: "T-P" }), { assignee: null, parent: null }), [{ op: "edit", id: "T-AB1", assignee: "none", parent: "none", ifRev: 5 }]);
  assert.deepEqual(U.editOps(rcard(), { tags: [] }), [{ op: "edit", id: "T-AB1", tags: [], ifRev: 5 }], "[] clears the labels; omitted does not");
  assert.deepEqual(U.editOps(rcard(), { title: "old title" }), []);
});
test("editOps: a project-only change is one edit with the baseline ifRev; a note-only save names it too", () => {
  assert.deepEqual(U.editOps(rcard(), { project: "P-R2" }), [{ op: "edit", id: "T-AB1", project: "P-R2", ifRev: 5 }]);
  assert.deepEqual(U.editOps(rcard(), { note: "n" }), [{ op: "note", id: "T-AB1", text: "n", ifRev: 5 }]);
});
test("addOp carries the assignee (and parent) only when given", () => {
  assert.deepEqual(U.addOp({ title: "x", assignee: { kind: "agent", id: "wrangler" }, parent: "T-P" }), { op: "add", title: "x", desc: "", tags: [], column: "backlog", priority: "P2", assignee: { kind: "agent", id: "wrangler" }, parent: "T-P" });
  assert.equal("assignee" in U.addOp({ title: "x", assignee: null }), false);
  assert.equal("parent" in U.addOp({ title: "x" }), false);
});
test("applied: the saved fields become the editor's baseline; none clears", () => {
  const c = rcard({ assignee: { kind: "agent", id: "a" }, parent: "T-P" });
  const a = U.applied(c, { op: "edit", id: "T-AB1", priority: "P0", tags: ["z"], assignee: "none", parent: "T-Q" });
  assert.deepEqual([a.priority, a.tags, a.assignee, a.parent], ["P0", ["z"], null, "T-Q"]);
  assert.deepEqual(U.applied(c, { op: "edit", id: "T-AB1", assignee: { kind: "squad", id: "s" } }).assignee, { kind: "squad", id: "s" });
  assert.equal(U.applied(c, { op: "edit", id: "T-AB1", project: "P-R2" }).remote.projectId, "P-R2");
});
test("fieldState: on only when the writer is on AND the probe allows fields; else the reason", () => {
  assert.deepEqual(U.fieldState({ ...ON, fields: { on: true, tip: null } }), { on: true, tip: null });
  assert.deepEqual(U.fieldState({ ...ON, fields: { on: false, tip: "box1 needs the update for priority, labels, assignee, parent and project" } }), { on: false, tip: "box1 needs the update for priority, labels, assignee, parent and project" });
  assert.deepEqual(U.fieldState({ remote: true, enabled: false, reason: "r", frozen: false, fields: { on: true, tip: null } }), { on: false, tip: "r" });
  assert.equal(U.fieldState(undefined).on, false);
});
