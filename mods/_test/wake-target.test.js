// A wakeup to a parked terminal (no pane agent) reads its status from the terminal list, so it waits while the target works.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
let host;
beforeEach(() => { host = globalThis.__host = { appHome: "/tmp/none", props: {}, notified: [], state: {}, agents: [], terminals: [] }; });
const { wakeTarget } = await import("../_lib/io.js");
const { decide } = await import("../_lib/wake.js");
const due = { id: "W1", status: "scheduled", due: 1, expires: Date.now() + 1e6 };
const act = (address) => decide(due, wakeTarget(address).status).action;

test("parked working -> wait; parked blocked -> wait; parked idle/done -> send", () => {
  host.terminals = [{ address: "t1", status: "working" }, { address: "t2", status: "blocked" }, { address: "t3", status: "idle" }, { address: "t4", status: "done" }];
  assert.deepEqual(["t1", "t2", "t3", "t4"].map(act), ["wait", "wait", "send", "send"]);
});

test("pane agent status wins; no reported status stays running (send); unknown terminal is gone (fail)", () => {
  host.agents = [{ address: "t1", status: "idle" }];
  host.terminals = [{ address: "t1", status: "working" }, { address: "t5" }];
  assert.equal(wakeTarget("t1").status, "idle");
  assert.equal(wakeTarget("t5").status, "running");
  assert.equal(act("t5"), "send");
  assert.equal(act("t9"), "fail");
});
