// C1: the real launch() and observeEnded() against a fake host (stubs/herdr.js).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const H = globalThis.__host = { props: {}, state: {}, notified: [], agents: [], terminals: [], calls: [], writes: 0 };
let n = 0;
H.exec = async (cmd, args) => {
  if (String(cmd).endsWith("/drover-workfolder")) return { code: 0, stdout: "", stderr: "" }; // the work folder helper is not a herdr call
  H.calls.push(args);
  return { code: 0, stdout: JSON.stringify({ terminal: `t${++n}`, space: "s1" }), stderr: "" };
};
const { launch, observeEnded } = await import("../_lib/io.js");

const cfg = { agents: [
  { id: "boss", name: "Boss", command: "claude --model m-lead --effort low", instructions: "", version: 1 },
  { id: "w", name: "Wrangler", command: "claude --model=m-w", instructions: "", version: 1 },
  { id: "i", name: "Inspector", command: "codex --no-daemon", instructions: "", version: 1 }],
squads: [{ id: "sq", name: "Sq", leader: "boss", version: 1, members: [{ agent: "w", role: "Wrangler" }, { agent: "i", role: "Inspector" }] }] };

beforeEach(() => { n = 0; H.calls = []; H.writes = 0; H.notified = []; H.terminals = []; H.state = { "drover.agents": cfg }; });

test("launch: squad opens members then leader; saved terminals keep role, model, started", async () => {
  const before = Date.now();
  const r = await launch(null, { kind: "squad", id: "sq" });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.terminals.map((t) => [t.address, t.agent, t.role, t.model]),
    [["t1", "w", "Wrangler", "m-w"], ["t2", "i", "Inspector", null], ["t3", "boss", "leader", "m-lead"]]);
  assert.ok(r.terminals.every((t) => typeof t.started === "number" && t.started >= before));
  assert.equal(r.terminals.at(-1).role, "leader");
  assert.equal(H.state["drover.runs"][0].id, r.id);
});

test("launch: solo agent run has one leader terminal with its model", async () => {
  const r = await launch(null, { kind: "agent", id: "boss" });
  assert.equal(r.terminals.length, 1);
  assert.equal(r.terminals[0].role, "leader");
  assert.equal(r.terminals[0].model, "m-lead");
});

test("observeEnded: empty terminal snapshot writes nothing", () => {
  const runs = [{ id: "R", terminals: [{ address: "t1", started: 1 }] }];
  H.state["drover.runs"] = runs; H.terminals = [];
  assert.equal(observeEnded(100), false);
  assert.equal(H.state["drover.runs"], runs);
});

test("observeEnded: one change writes once, repeat writes zero", () => {
  const runs = [{ id: "R", terminals: [{ address: "t1", started: 1 }] }];
  H.state["drover.runs"] = runs; H.terminals = [{ address: "t9" }];
  let writes = 0; const set = Object.getOwnPropertyDescriptor(H.state, "drover.runs");
  Object.defineProperty(H.state, "drover.runs", { configurable: true, enumerable: true,
    get: () => set.value, set: (v) => { writes++; set.value = v; } });
  assert.equal(observeEnded(100), true);
  assert.equal(writes, 1);
  assert.equal(H.state["drover.runs"][0].terminals[0].ended, 100);
  assert.equal(H.state["drover.runs"][0].ended, 100);
  assert.equal(observeEnded(200), false);
  assert.equal(writes, 1);
});
