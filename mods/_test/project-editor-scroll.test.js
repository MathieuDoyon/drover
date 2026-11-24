// The Edit project dialog must scroll (T-MWO2UYPADZC fix 4): with the remote rows (Remote, Writes, Transport) it is taller than the window, and the bottom was cut off.
// The recorder does not lay anything out, so this asserts on the recorded style calls (the idiom of the other dialogs: a body with flex_1 + min_h(0) + overflow_y_scrollbar
// inside a root with max_h_full), and on who sits inside the scroll body and who stays outside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], closeCalls: [] };
const { ProjectEditor } = await import("../drover-projects/main.js");
const { NODE } = await import(new URL("./stubs/el.js", import.meta.url).href);
const UI = await import("../_lib/remote-write-ui.js");
const findNode = (n, id) => (n.id === id ? n : n.kids.map((k) => findNode(k, id)).find(Boolean));

function render(projects) {
  const host = globalThis.__host = { props: { overlay: "ov1", projectEdit: "P-ONREM" }, state: { "drover.projects": projects }, notified: [], closeCalls: [], home: "/h", closeOverlay() {}, readTextFile: async () => null };
  const cx = { timer: { after() {}, every() {} }, notify() {}, spawn: (fn) => Promise.resolve().then(() => fn(cx)) };
  const e = new ProjectEditor(cx);
  globalThis.__rec = { ids: [], texts: [] };
  try { return { root: e.render(cx)[NODE], texts: globalThis.__rec.texts, host }; } finally { globalThis.__rec = undefined; }
}
const BOUND = [{ id: "P-ONREM", name: "scratch", repos: [], folders: [], branch: "main", remote: { machine: "box1", projectId: "P-REMOTE1", id: "B-1", transport: "exec" } }];

const descendants = (n) => n.kids.reduce((a, k) => a + 1 + descendants(k), 0);

test("what the owner sees: the root has a DEFINITE height (h_full, as the working dialogs), the body is flex_1 + min_h(0) + scroll and not zero-sized by style, and every field is inside it", () => {
  const { root, texts } = render(BOUND);
  assert.equal(root.id, "project-editor");
  for (const c of ["h_full", "max_h_full", "min_h"]) assert.ok(root.calls.includes(c), `the root has ${c}: without a definite height, flex_1 of the body resolves to 0`);
  const body = findNode(root, "project-editor-body");
  assert.ok(body, "there is a scrolling body");
  for (const c of ["overflow_y_scrollbar", "flex_1", "min_h"]) assert.ok(body.calls.includes(c), `the body has ${c}`);
  assert.deepEqual(body.args.min_h, [0], "min_h(0): it may shrink and scroll");
  for (const k of ["h", "max_h", "h_0"]) assert.ok(!(k in body.args) || body.args[k][0] !== 0, `the body is not sized to zero by ${k}`);
  assert.ok(!body.calls.includes("max_h"), "no max_h on the body");
  // header (title, Esc), the body, the Cancel/Save row: nothing else is a direct child, so every field sits in the body
  assert.equal(root.kids.length, 3, "root = header + body + footer");
  assert.ok(root.kids[1] === body, "the body is the middle child");
  assert.ok(descendants(body) > descendants(root.kids[0]) + descendants(root.kids[2]), "the body holds the form");
  for (const label of ["Name", "Repos", "Folders", "Base branch", "Org (optional", "Remote: machine"]) assert.ok(texts.some((t) => t.startsWith(label)), `label ${label} rendered`);
  for (const id of ["open-lessons", "open-project-lessons", "bind-remote", "unbind-remote", "toggle-writes"]) assert.ok(findNode(body, id), `${id} is inside the scrolling body`);
  assert.ok(!findNode(body, "toggle-transport") && !findNode(body, "transport-note"), "the inbox is retired: no transport control");
  for (const id of ["ed-save", "ed-cancel"]) { assert.ok(findNode(root, id), id); assert.ok(!findNode(body, id), `${id} stays outside the scroll`); }
});

test("source contract: the project dialog uses the same root + body idiom as the working drover-agents dialogs, and is opened with a definite height", () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
  const agents = read("../drover-agents/main.js");
  // the working idiom: the frame is w_full().max_h_full().min_h(0); each dialog's root then gets .h_full(); the body is flex_1().min_h(0).overflow_y_scrollbar()
  assert.match(agents, /id\("dialog"\)\.w_full\(\)\.max_h_full\(\)\.min_h\(0\)/);
  assert.match(agents, /\)\)\)\.h_full\(\);/);
  assert.match(agents, /flex_1\(\)\.min_h\(0\)\.overflow_y_scrollbar\(\)/);
  const src = read("../drover-projects/main.js");
  assert.match(src, /id\("project-editor"\)\.w_full\(\)\.max_h_full\(\)\.min_h\(0\)/);
  assert.match(src, /id\("project-editor-body"\)\.flex_1\(\)\.min_h\(0\)\.overflow_y_scrollbar\(\)/);
  assert.match(src, /"ed-save"[^\n]*\n\s*\}\n/s, "the render ends at the Save button");
  const tail = src.slice(src.indexOf('"ed-save"'), src.indexOf("export default class Projects"));
  assert.match(tail, /\.h_full\(\);/, "the root gets .h_full() at the end of the chain, as the agents dialogs do");
  const open = src.match(/export const openEditor = [^\n]*/)[0];
  assert.match(open, /height: 0\.\d+/, "opened with a definite height, like the other scrolling dialogs (the proof and the pick dialogs)");
});
