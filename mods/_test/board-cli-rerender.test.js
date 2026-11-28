// T-MWZEI38ECUW: a card changed by the drover CLI must show on the Board with no click.
// The CLI writes an inbox file; each mod copy that runs watchInbox races to apply it. The copy that loses finds an empty inbox, notifies at once
// (before the winner's write) and never again, so its view stays stale until a click re-renders it. watchTasks (started by the Board) must re-render when the shared tasks change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
const IO = await import("../_lib/io.js");
const card = (id, column, rev) => ({ id, title: id, column, priority: "P2", tags: [], created: 1, updated: rev, rev, project: null, archived: false, notes: [] });

test("shared tasks changed by another mod copy re-render this copy without a click", () => {
  const home = mkdtempSync(join(tmpdir(), "rerender-home-"));
  mkdirSync(join(home, "data/drover-inbox"), { recursive: true });
  const host = globalThis.__host = { appHome: home, props: {}, notified: [], state: { "drover.tasks": [card("T-1", "todo", 1)] }, agents: [], terminals: [], watchFolder: () => new Promise(() => {}), exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
  let notified = 0;
  const timers = [];
  const cx = { notify() { notified++; }, timer: { every: (_ms, fn) => timers.push(fn) }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) };
  IO.watchTasks(cx);
  for (const fn of timers) fn(cx); // a tick with nothing changed
  const settled = notified;
  host.state["drover.tasks"] = [card("T-1", "backlog", 2)]; // the CLI's move, applied by another copy
  for (const fn of timers) fn(cx);
  assert.ok(notified > settled, "a tick after the shared tasks changed re-rendered this copy");
  const again = notified;
  for (const fn of timers) fn(cx);
  assert.equal(notified, again, "a tick with nothing changed does not re-render");
});

// The wiring: the Board itself starts the watcher when its screen renders (a loader that drops the call must fail here).
test("Board: a CLI change to the shared tasks repaints the open Board with no click", async () => {
  const { default: Board } = await import(new URL("../drover-board/main.js", import.meta.url).href);
  const C = await import(new URL("../_lib/config.js", import.meta.url).href);
  C.resetCache(); C.setSettings("drover-board", {}); C.setSettings("drover-runs", {});
  const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
  const home = mkdtempSync(join(tmpdir(), "rerender-board-"));
  const host = globalThis.__host = { props: {}, notified: [], agents: [], panes: [], spaces: [], terminals: [], home: "/h", appHome: home, focused: { terminal: "t1", cwd: "/x" }, readTextFile: async () => null, exec: async () => ({ code: 0, stdout: "", stderr: "" }), watchFolder: () => new Promise(() => {}),
    state: { "drover.tasks": [card("T-1", "todo", 1)], "drover.projects": [P], "drover.runs": [], "drover.config": {} } };
  let notified = 0;
  const timers = [];
  const cx = { notify() { notified++; }, stop_propagation() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {}, every: (_ms, fn) => timers.push(fn) } };
  const b = new Board(); b.init({}, cx);
  b.render(cx);
  for (const fn of timers) fn(cx);
  const settled = notified;
  host.state["drover.tasks"] = [card("T-1", "backlog", 2)];
  for (const fn of timers) fn(cx);
  assert.ok(notified > settled, "the open Board repainted after the shared tasks changed");
});
