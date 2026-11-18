// #53: a successful start makes the squad that runs the card its assignee (only when the card has none).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const CFG = { agents: [
  { id: "lead", name: "Lead", command: "claude", soul: "", instructions: "" },
  { id: "w1", name: "W1", command: "codex", soul: "", instructions: "" },
], squads: [{ id: "s1", name: "Crew", version: 1, leader: "lead", members: [{ agent: "w1", role: "Inspector" }] }] };
const card = (extra = {}) => ({ id: "T-A", title: "t", desc: "", priority: "P2", tags: [], column: "ready", archived: false, agent: null, source: null, assignee: null, notes: [], created: 1, updated: 1, ...extra });
let host, hold;
beforeEach(() => {
  hold = null;
  let n = 0;
  host = globalThis.__host = { appHome: "/app", home: "/nohome", props: {}, notified: [], terminals: [], state: { "drover.agents": CFG, "drover.tasks": [card()] },
    exec: async (cmd, args) => {
      if (cmd !== "herdr-app") return { code: 0, stdout: "" };
      if (args[1] === "tab.new" && hold) { hold.hit(); await hold.promise; }
      if (args[1] === "tab.new" && host.failOpen) return { code: 1, stdout: "", stderr: "boom" };
      return { code: 0, stdout: JSON.stringify({ terminal: `t${++n}` }) };
    } };
});
const { launch } = await import("../_lib/io.js");
const stored = () => host.state["drover.tasks"][0];

test("an unassigned card started with a squad gets that squad as assignee", async () => {
  const run = await launch(stored(), { kind: "squad", id: "s1" });
  assert.equal(run.error, undefined);
  assert.deepEqual(stored().assignee, { kind: "squad", id: "s1" });
  assert.equal(stored().column, "doing");
});

test("a single agent runner becomes the assignee too", async () => {
  await launch(stored(), { kind: "agent", id: "lead" });
  assert.deepEqual(stored().assignee, { kind: "agent", id: "lead" });
});

test("an already assigned card keeps its assignee", async () => {
  host.state["drover.tasks"] = [card({ assignee: { kind: "agent", id: "w1" } })];
  await launch(stored(), { kind: "squad", id: "s1" });
  assert.deepEqual(stored().assignee, { kind: "agent", id: "w1" });
});

test("the owner assigns another runner while the launch is suspended: it survives", async () => {
  let release, hit; hold = { promise: new Promise((r) => (release = r)), hit: () => hit(), reached: new Promise((r) => (hit = r)) };
  const stale = stored(); // launch() receives the card as it was before the owner's edit
  const p = launch(stale, { kind: "squad", id: "s1" });
  await until(() => hold.reached.then(() => true), "launch reached the open step");
  host.state["drover.tasks"] = [{ ...stored(), assignee: { kind: "agent", id: "w1" } }];
  release(); await p;
  assert.deepEqual(stored().assignee, { kind: "agent", id: "w1" });
});

test("a failed launch leaves the assignee empty", async () => {
  host.failOpen = true;
  const run = await launch(stored(), { kind: "squad", id: "s1" });
  assert.ok(run.error);
  assert.equal(stored().assignee, null);
});
