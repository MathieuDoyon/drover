// Closing a squad's space (or its leader tab) kills the parked workers; observeEnded is the observer.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
let host, kills;
const mk = (extra = {}) => ({ id: "R1", space: "s1", worktree: { path: "/w" }, started: 1, terminals: [
  { address: "t1", role: "leader", started: 1 }, { address: "t2", role: "W", started: 1, parked: true }, { address: "t3", role: "I", started: 1, parked: true }], ...extra });
beforeEach(() => {
  kills = [];
  host = globalThis.__host = { appHome: "/tmp/none", props: {}, notified: [], terminals: [{ address: "t1" }, { address: "t2" }, { address: "t3" }],
    spaces: [{ id: "s1", tabs: [] }], state: { "drover.runs": [mk()] } };
  host.exec = async (cmd, args) => { if (cmd === "herdr-app" && args[1] === "terminal.kill") kills.push(args[args.indexOf("--terminal") + 1]); return { code: 0, stdout: "{}" }; };
});
const { observeEnded } = await import("../_lib/io.js");
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
// observeEnded() reaps in the background (kills, then stamps `reaped`): wait for the stamps, not for a time.
const reaped = (run = 0) => host.state["drover.runs"][run].terminals.filter((t) => t.reaped).length;

test("space open: nothing is killed", async () => {
  observeEnded();
  await drain(); // a negative: a bounded drain
  assert.deepEqual(kills, []);
});

test("space closed: every parked worker is killed once, the leader record is untouched", async () => {
  host.spaces = [{ id: "s9", tabs: [] }];
  observeEnded();
  await until(() => reaped() === 2, "both parked workers stamped reaped");
  assert.deepEqual(kills, ["t2", "t3"]);
  observeEnded();
  await drain(); // a negative: a bounded drain
  assert.deepEqual(kills, ["t2", "t3"], "not killed again");
});

test("leader tab closed (space stays): parked workers are killed", async () => {
  host.terminals = [{ address: "t2" }, { address: "t3" }];
  observeEnded();
  await until(() => reaped() === 2, "both parked workers stamped reaped");
  assert.deepEqual(kills, ["t2", "t3"]);
});

test("a failed kill is unknown, not gone: no stamp, retried next tick, then stamped once", async () => {
  host.spaces = [{ id: "s9", tabs: [] }];
  let fail = true;
  host.exec = async (cmd, args) => { if (args[1] === "terminal.kill") { kills.push(args[args.indexOf("--terminal") + 1]); if (fail) return { code: 1, stdout: "" }; } return { code: 0, stdout: "{}" }; };
  observeEnded();
  await until(() => kills.length === 2, "both kills were tried (and failed)");
  assert.equal(host.state["drover.runs"][0].terminals.some((t) => t.reaped), false);
  fail = false;
  await until(() => { observeEnded(); return reaped() === 2; }, "the retry killed and stamped both"); // each pass retries what is not stamped yet
  assert.deepEqual(kills, ["t2", "t3", "t2", "t3"], "retried once, then never again");
  assert.equal(host.state["drover.runs"][0].terminals.filter((t) => t.reaped).length, 2);
});

test("a worker already gone from the live list is stamped without a kill; other runs' terminals are never touched", async () => {
  host.spaces = [{ id: "s9", tabs: [] }];
  host.terminals = [{ address: "t1" }, { address: "t3" }, { address: "t50" }];
  host.state["drover.runs"] = [mk(), { id: "R2", space: "s9", worktree: { path: "/x" }, terminals: [{ address: "t50", role: "leader", started: 1 }, { address: "t51", role: "W", started: 1, parked: true }] }];
  observeEnded();
  await until(() => reaped() === 2, "t2 and t3 stamped reaped");
  assert.deepEqual(kills, ["t3"], "t2 gone (no kill); t3 killed");
  const [r1, r2] = host.state["drover.runs"];
  assert.equal(r1.terminals.find((t) => t.address === "t2").reaped, true);
  assert.equal(r2.terminals.some((t) => t.reaped), false);
});

test("standalone Squads screen registers the observer timer", async () => {
  const { default: Agents } = await import("../drover-agents/main.js");
  const every = [];
  const cx = { timer: { every: (ms, f) => every.push([ms, f]) }, spawn: (f) => Promise.resolve().then(() => f(cx)), notify() {} };
  new Agents().init({}, cx);
  await until(() => every.length === 1, "the screen loaded its settings and started the timer");
});
