// Pure view-model for the remote write controls (T-MWHVWR8TIJB): control states, outcome text, the exact ops a UI gesture builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const U = await import("../_lib/remote-write-ui.js");
const W = await import("../_lib/remote-write.js");

const card = (extra = {}) => ({ id: "T-AB1", title: "old title", desc: "old desc", column: "todo", priority: "P2", tags: [], project: "P-LOCAL", remote: { machine: "omarchy" }, ...extra });
const ON = { remote: true, enabled: true, reason: null, frozen: false };

test("control states: enabled -> no tip; otherwise the writer's reason; frozen says so", () => {
  assert.deepEqual(U.controlState(ON), { on: true, tip: null });
  assert.deepEqual(U.controlState({ remote: true, enabled: false, reason: "omarchy needs the update", frozen: false }), { on: false, tip: "omarchy needs the update" });
  assert.deepEqual(U.controlState({ remote: true, enabled: false, reason: "Checking omarchy, try again in a moment", frozen: false }), { on: false, tip: "Checking omarchy, try again in a moment" });
  assert.deepEqual(U.controlState({ remote: true, enabled: false, reason: "x", frozen: true }), { on: false, tip: "writes frozen" });
  assert.equal(U.controlState({ remote: true, enabled: false, reason: null, frozen: false }).tip, "writes are off");
  assert.equal(U.controlState(undefined).on, false);
});

test("agent ops stay off on a remote card, with the fixed tooltip", () => {
  assert.equal(U.OFF_TIP, "not available for omarchy projects yet");
});

test("status line per remote project", () => {
  assert.equal(U.statusLine(ON), "writes on");
  assert.equal(U.statusLine({ remote: true, enabled: false, reason: "omarchy needs the update", frozen: false }), "omarchy needs the update");
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
  assert.deepEqual(U.editOps(card(), { title: "new title", desc: "old desc", note: "" }), [{ op: "edit", id: "T-AB1", title: "new title" }]);
  assert.deepEqual(U.editOps(card(), { title: "new title", desc: "x", note: "hello" }), [{ op: "edit", id: "T-AB1", title: "new title", desc: "x" }, { op: "note", id: "T-AB1", text: "hello" }]);
  assert.deepEqual(U.editOps(card(), { title: "old title", desc: "old desc", note: " hi " }), [{ op: "note", id: "T-AB1", text: "hi" }]);
  assert.deepEqual(U.editOps(card(), { title: "   ", desc: "old desc", note: "" }), [], "an empty title is not sent");
  for (const o of U.editOps(card(), { title: "n", desc: "d", note: "x" })) assert.ok(W.OPS.includes(o.op));
});

test("outcome text: every writer outcome has a fixed message", () => {
  assert.equal(U.outcomeText({ status: "saved" }), "Saved");
  assert.equal(U.outcomeText({ status: "stale" }), "card changed on omarchy: reloaded, try again");
  assert.equal(U.outcomeText({ status: "expired" }), "not applied, too old");
  assert.equal(U.outcomeText({ status: "pending" }), "sent, may still apply");
  assert.equal(U.outcomeText({ status: "unknown" }), "outcome unknown: check the card on omarchy");
  assert.equal(U.outcomeText({ status: "refused", message: "omarchy needs the update" }), "omarchy needs the update");
  assert.equal(U.outcomeText({ status: "failed", message: "not sent: nothing was applied" }), "not sent: nothing was applied");
  assert.equal(U.outcomeText({ status: "error", text: "error: unknown task T-ZZ\nsecond line" }), "error: unknown task T-ZZ");
  assert.equal(U.outcomeText({ status: "error", message: "unknown task T-ZZ" }), "error: unknown task T-ZZ");
  assert.equal(U.outcomeText(null), "");
});

test("writes toggle model: on by default, off reports frozen only when the writer says so", () => {
  assert.deepEqual(U.writesToggle({ machine: "omarchy", projectId: "P-R" }, ON), { on: true, label: "Writes to omarchy", note: "on" });
  assert.deepEqual(U.writesToggle({ machine: "omarchy", writes: false }, { frozen: true }), { on: false, label: "Writes to omarchy", note: "frozen" });
  assert.deepEqual(U.writesToggle({ machine: "omarchy", writes: false }, { frozen: false }), { on: false, label: "Writes to omarchy", note: "off, waiting for sends in flight" });
});

test("applied: a saved move becomes the card's column, so the status chip is not sent twice", () => {
  assert.equal(U.applied({ id: "T-1", column: "todo" }, { op: "move", id: "T-1", column: "doing" }).column, "doing");
  assert.equal(U.moveOp(U.applied({ id: "T-1", column: "todo" }, { op: "move", id: "T-1", column: "doing" }), "doing"), null);
});
