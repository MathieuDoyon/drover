// Floating workers: launch parks every member after the leader opened (never the leader);
// a park failure keeps that tab and notifies once; worker rows open with terminal.peek, leader rows with agent.focus.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { lineageOf, squadRows, openCommand } from "../_lib/runs.js";

register("./hooks.js", import.meta.url);
const CFG = { agents: [
  { id: "lead", name: "Lead", command: "claude", soul: "", instructions: "" },
  { id: "w1", name: "W1", command: "claude", soul: "", instructions: "" },
  { id: "w2", name: "W2", command: "codex", soul: "", instructions: "" },
], squads: [{ id: "s1", name: "Crew", version: 1, leader: "lead", members: [{ agent: "w1", role: "Wrangler" }, { agent: "w2", role: "Inspector" }] }] };
let host, calls, failPark, pendingPark;
beforeEach(() => {
  calls = []; failPark = new Set(); pendingPark = new Set();
  host = globalThis.__host = { appHome: "/tmp/none", props: {}, notified: [], closeCalls: [], terminals: [], state: { "drover.agents": CFG } };
  let n = 0;
  host.exec = async (cmd, args) => {
    if (cmd !== "herdr-app") return { code: 0, stdout: "" };
    const [, op, ...rest] = args;
    calls.push([op, rest]);
    if (op === "terminal.park" && pendingPark.has(rest[rest.indexOf("--terminal") + 1])) return { code: 0, stdout: JSON.stringify({ pending: true }) };
    if (op === "terminal.park") return failPark.has(rest[rest.indexOf("--terminal") + 1]) ? { code: 1, stdout: JSON.stringify({ error: "nope" }) } : { code: 0, stdout: "{}" };
    return { code: 0, stdout: JSON.stringify({ terminal: `t${++n}` }) };
  };
});
const { launch, parkSettle } = await import("../_lib/io.js");
parkSettle.ms = 0; parkSettle.tries = 3;
const runner = { kind: "squad", id: "s1" };
const parks = () => calls.filter(([op]) => op === "terminal.park").map(([, r]) => r[r.indexOf("--terminal") + 1]);

test("launch parks each member after the leader is open, never the leader", async () => {
  const run = await launch(null, runner);
  assert.equal(run.error, undefined);
  assert.deepEqual(parks(), ["t1", "t2"]);
  assert.equal(calls.findIndex(([op]) => op === "tab.new" || op === "space.new") >= 0, true);
  const lastOpen = calls.map(([op]) => op).lastIndexOf("tab.new");
  assert.equal(calls.findIndex(([op]) => op === "terminal.park") > lastOpen, true, "parked only after the leader opened");
  const byAddr = Object.fromEntries(run.terminals.map((t) => [t.address, t]));
  assert.equal(byAddr.t3.role, "leader");
  assert.equal(byAddr.t3.parked, undefined);
  assert.deepEqual([byAddr.t1.parked, byAddr.t2.parked], [true, true]);
  assert.equal(host.state["drover.runs"].length, 1);
});

test("a lone agent run (leader only) parks nothing", async () => {
  await launch(null, { kind: "agent", id: "lead" });
  assert.deepEqual(parks(), []);
});

test("park failure: that tab is kept, the run is still recorded with all terminals, one notice", async () => {
  failPark.add("t1");
  const run = await launch(null, runner);
  assert.equal(run.error, undefined);
  assert.deepEqual(parks(), ["t1", "t2"], "the next member is still tried");
  assert.equal(run.terminals.length, 3);
  assert.deepEqual(run.terminals.map((t) => t.parked), [undefined, true, undefined]);
  assert.equal(host.state["drover.runs"].length, 1);
  assert.equal(host.notified.length, 1);
  assert.match(host.notified[0].body, /t1/);
});

test("rows: a parked member opens with terminal.peek; leader, unparked and legacy members with agent.focus", () => {
  const run = { id: "R", terminals: [
    { address: "t1", role: "Wrangler", parked: true }, { address: "t2", role: "Inspector" }, { address: "t3", role: "leader" }] };
  const rows = squadRows(lineageOf(run, [run], new Map(), new Set(["t1", "t2", "t3"]), 0));
  const cmd = Object.fromEntries(rows.map((r) => [r.address, openCommand(r)]));
  assert.deepEqual(cmd, { t3: "agent.focus", t1: "terminal.peek", t2: "agent.focus" });
  const withBoss = { ...run, reportTo: "t9" };
  const r2 = squadRows(lineageOf(withBoss, [withBoss], new Map(), new Set(["t1", "t3"]), 0));
  assert.equal(openCommand(r2[0]), "agent.focus", "the coordinator (Drover) row keeps agent.focus");
});

test("park failure is notified even for a coordinator-driven launch (reportTo)", async () => {
  host.panes = [{ terminal: "t0", tab: "tb0", cwd: "/tmp" }]; host.spaces = [{ id: "sp0", tabs: [{ id: "tb0" }] }];
  failPark.add("t1");
  const run = await launch(null, runner, { reportTo: "t0" });
  assert.equal(run.error, undefined);
  assert.equal(host.notified.length, 1);
  assert.match(host.notified[0].body, /t1/);
});

// terminal.park may answer pending:true and fail later: parked is recorded only once the pane is gone.
test("pending park that settles (pane gone): recorded parked", async () => {
  pendingPark.add("t1"); host.panes = [{ terminal: "t1", tab: "x" }];
  let reads = 0; Object.defineProperty(host, "panes", { get: () => (++reads > 1 ? [] : [{ terminal: "t1", tab: "x" }]) });
  const run = await launch(null, runner);
  assert.deepEqual(run.terminals.map((t) => t.parked), [true, true, undefined]);
  assert.equal(host.notified.length, 0);
});

test("pending park that fails (pane stays): not recorded parked, keeps agent.focus, one notice", async () => {
  pendingPark.add("t1"); host.panes = [{ terminal: "t1", tab: "x" }];
  const run = await launch(null, runner);
  assert.deepEqual(run.terminals.map((t) => t.parked), [undefined, true, undefined]);
  assert.equal(host.notified.length, 1);
  assert.match(host.notified[0].body, /t1/);
  const rows = squadRows(lineageOf(run, [run], new Map(), new Set(["t1", "t2", "t3"]), 0));
  assert.equal(openCommand(rows.find((r) => r.address === "t1")), "agent.focus");
});
