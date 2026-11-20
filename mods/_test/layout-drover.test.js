// T-MWO2HFFHWRB Rev 3: the shipped drover layout. Shape only (no app is launched): unique ids, only documented node types and fields,
// the Needs-you page hidden by default, the switch on top of the drover column.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = JSON.parse(readFileSync(new URL("../_layouts/drover.json", import.meta.url), "utf8"));
const walk = (n, out = []) => { out.push(n); for (const c of n.children ?? []) walk(c, out); return out; };
const nodes = walk(doc);
const byId = (id) => nodes.find((n) => n.id === id);
const TYPES = ["block", "row", "column", "stack"];
const NODE_FIELDS = ["id", "type", "size", "min", "max", "hidden", "children", "content", "active", "header", "background", "resizable", "padding", "gap", "window_drag"];
const ROOT_ONLY = ["titlebar", "traffic_lights", "terminal_padding", "divider"];

test("node ids are unique", () => {
  const ids = nodes.map((n) => n.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test("only documented node types and fields", () => {
  for (const n of nodes) {
    assert.ok(TYPES.includes(n.type), `${n.id}: type ${n.type}`);
    for (const k of Object.keys(n)) assert.ok(NODE_FIELDS.includes(k) || (n === doc && ROOT_ONLY.includes(k)), `${n.id}: field ${k}`);
    if (n.type === "block") assert.ok(n.content, `${n.id}: a block has content`);
  }
});

test("the drover column holds the switch, Room, Tasks and a hidden Needs you page, in that order", () => {
  const col = byId("drover");
  assert.equal(col.type, "column");
  assert.deepEqual(col.children.map((c) => c.id), ["drover-switch", "drover-room", "drover-tasks", "drover-needs"]);
  assert.deepEqual(byId("drover-switch").size, { px: 34 });
  assert.equal(byId("drover-switch").content.mod, "drover-switch");
  assert.equal(byId("drover-needs").content.mod, "drover-needs");
  assert.equal(byId("drover-needs").hidden, true, "Room + Tasks is the default page");
  assert.deepEqual(byId("drover-needs").size, { weight: 1 });
  assert.ok(!byId("drover-room").hidden && !byId("drover-tasks").hidden);
  assert.ok(!col.hidden, "the column id stays `drover`: the Tasks capsule toggles it");
});

test("every id the navigation commands name exists in the layout", () => {
  for (const id of ["drover", "drover-room", "drover-tasks", "drover-needs"]) assert.ok(byId(id), id);
});
