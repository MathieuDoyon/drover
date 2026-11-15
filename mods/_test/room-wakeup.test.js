// The Room's Wakeups "+" opens the New wakeup dialog (drover-wakeups) aimed at the run's task or leader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], closeCalls: [] };
const { default: Room } = await import("../drover-room/main.js");

const open = (run) => {
  const opened = [];
  globalThis.__host = { props: {}, state: {}, notified: [], closeCalls: [], openOverlay: (o) => opened.push(o) };
  const r = Object.create(Room.prototype); r.run = run; r.addWakeup();
  return opened;
};

test("Room +: opens the New wakeup dialog aimed at the run's task", () => {
  const o = open({ task: "T-ABC", terminals: [{ address: "t1", role: "leader" }] });
  assert.equal(o.length, 1);
  assert.deepEqual([o[0].mod, o[0].kind, o[0].modal, o[0].props.wakeEdit, o[0].props.wakeTarget], ["drover-wakeups", "dialog", true, null, "T-ABC"]);
});

test("Room +: no task aims at the leader terminal; no run opens nothing", () => {
  assert.equal(open({ task: null, terminals: [{ address: "t3", role: "member" }, { address: "t2", role: "leader" }] })[0].props.wakeTarget, "t2");
  assert.equal(open(null).length, 0);
});
