// T-MWO2HFFHWRB Rev 3: one navigation function for the Needs-you page. Pure: it returns commands, the caller runs them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { showPage, pageOf, runPage } from "../_lib/needsnav.js";

const lay = ({ column = false, room = false, tasks = false, needs = true } = {}) => ({
  id: "root", type: "row", children: [{ id: "work", type: "column", children: [{ id: "drover", type: "column", hidden: column, children: [
    { id: "drover-switch", type: "block" }, { id: "drover-room", type: "block", hidden: room }, { id: "drover-tasks", type: "block", hidden: tasks }, { id: "drover-needs", type: "block", hidden: needs },
  ] }] }],
});

test("showPage('room'): show Room and Tasks, hide Needs you", () => {
  assert.deepEqual(showPage("room"), [["layout.show", { id: "drover-room" }], ["layout.show", { id: "drover-tasks" }], ["layout.hide", { id: "drover-needs" }]]);
});

test("showPage('needs'): show the column first (it may be hidden), hide Room and Tasks, show Needs you", () => {
  assert.deepEqual(showPage("needs"), [["layout.show", { id: "drover" }], ["layout.hide", { id: "drover-room" }], ["layout.hide", { id: "drover-tasks" }], ["layout.show", { id: "drover-needs" }]]);
});

test("showPage: an unknown page is the room page", () => {
  assert.deepEqual(showPage("x"), showPage("room"));
  assert.deepEqual(showPage(undefined), showPage("room"));
});

test("pageOf: needs shown and room hidden is the needs page", () => {
  assert.equal(pageOf(lay({ room: true, tasks: true, needs: false })), "needs");
});

test("pageOf: the default layout (needs hidden) is the room page", () => {
  assert.equal(pageOf(lay()), "room");
});

test("pageOf: a half-applied state reads as room (needs shown but room still shown, or room hidden but needs hidden)", () => {
  assert.equal(pageOf(lay({ room: false, needs: false })), "room");
  assert.equal(pageOf(lay({ room: true, needs: true })), "room");
});

test("pageOf: a layout with none of these nodes, or no layout, is room", () => {
  assert.equal(pageOf({ id: "root", type: "row", children: [] }), "room");
  assert.equal(pageOf(null), "room");
  assert.equal(pageOf(undefined), "room");
});

test("pageOf: the hidden column does not change the page (the chip click shows the column itself)", () => {
  assert.equal(pageOf(lay({ column: true, room: true, tasks: true, needs: false })), "needs");
});

test("a half-applied state heals: running showPage('room') from it ends on the room page", () => {
  const state = { "drover-room": true, "drover-tasks": false, "drover-needs": false }; // room hidden, needs hidden: nothing shows
  for (const [cmd, { id }] of showPage("room")) if (id in state) state[id] = cmd === "layout.hide";
  assert.deepEqual(state, { "drover-room": false, "drover-tasks": false, "drover-needs": true });
});

test("runPage runs every command in order with the host's run()", () => {
  const seen = [];
  runPage((c, a) => seen.push([c, a]), "needs");
  assert.deepEqual(seen, showPage("needs"));
});
