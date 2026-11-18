// T-MWLGPRPU53A: the Room Squad row shows the session id and a copyable resume command; the click copies and stops there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { until } from "./stubs/until.js";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [] };
const { default: Room } = await import("../drover-room/main.js");
const C = await import("../_lib/config.js");
const { NODE } = await import("./stubs/el.js");
const ID = "0b9f6c2e-5d1a-4c3b-8e7f-123456789abc", ID2 = "1c0a7d3f-6e2b-4d4c-9f80-23456789abcd";

const mkcx = (clips, stops, timers) => { const cx = { notify() {}, stop_propagation: () => stops.push(1), write_to_clipboard: (s) => clips.push(s), timer: { every() {}, after: (_ms, fn) => timers.push(fn) }, spawn: (fn) => Promise.resolve().then(() => fn(cx)) }; return cx; };

async function rendered(terminals, live = ["t1", "t2", "t3"]) {
  C.resetCache();
  const runs = [{ id: "R1", task: null, started: 1, space: "s", terminals }];
  const calls = [];
  globalThis.__host = { props: {}, notified: [], state: { "drover.runs": runs, "drover.config": { "drover-room": {} } }, home: "/h", appHome: "/app",
    focused: { terminal: "t3" }, terminals: live.map((a) => ({ address: a })), agents: [], run: (...a) => calls.push(a),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }), readTextFile: async () => null };
  const clips = [], stops = [], timers = [], cx = mkcx(clips, stops, timers);
  const room = new Room(); room.init({}, cx);
  globalThis.__rec = { ids: [], texts: [] };
  await until(() => { globalThis.__rec.ids.length = 0; globalThis.__rec.texts.length = 0; return room.render(cx) && globalThis.__rec.ids.includes("resume-t3") || globalThis.__rec.ids.includes("m-t3"); }, "room rendered");
  globalThis.__rec.ids.length = 0; globalThis.__rec.texts.length = 0;
  const root = room.render(cx);
  const rec = globalThis.__rec; globalThis.__rec = undefined;
  return { room, root, rec, cx, clips, stops, timers, calls };
}
const walk = (n, out = []) => { out.push(n); for (const k of n.kids ?? []) walk(k, out); return out; };
const nodeOf = (root, id) => walk(root[NODE]).find((n) => n.id === id);
const T = [
  { address: "t1", agent: "cx", name: "Codex", role: "Inspector", started: 1, kind: "codex", session: ID2, cwd: "/r" },
  { address: "t3", agent: "lead", name: "Lead", role: "leader", started: 2, kind: "claude", session: ID },
  { address: "t2", agent: "old", name: "Old", role: "Wrangler", started: 1 },
];

test("Squad rows: a recorded session shows the short id and the resume command; a legacy row shows none", async () => {
  const { rec } = await rendered(T);
  assert.ok(rec.ids.includes("resume-t3") && rec.ids.includes("resume-t1"));
  assert.equal(rec.ids.includes("resume-t2"), false, "legacy record renders unchanged");
  assert.ok(rec.texts.includes(`claude --resume ${ID}`));
  assert.ok(rec.texts.includes(`codex resume ${ID2}`));
  assert.ok(rec.texts.includes(`session ${ID.slice(0, 8)}`));
});

test("copy: the rendered resume control's own click copies the command and stops there (no focus, no peek), live or gone", async () => {
  for (const live of [["t1", "t2", "t3"], []]) {
    const { root, clips, stops, calls, cx } = await rendered(T, live);
    const ctl = nodeOf(root, "resume-t3");
    assert.ok(ctl?.args.on_click, "the resume control has a click handler");
    ctl.args.on_click[0]({}, cx);
    assert.deepEqual(clips, [`claude --resume ${ID}`]);
    assert.equal(stops.length, 1);
    assert.deepEqual(calls, [], "no agent.focus or terminal.peek");
    assert.equal(Boolean(nodeOf(root, "m-t3").args.on_click), live.length > 0, "only a live row focuses");
  }
});

test("copy: the Copied hint clears itself", async () => {
  const { room, cx, timers } = await rendered(T);
  room.copyResume("t3", "x", cx);
  assert.equal(room.copied, "t3");
  timers.forEach((f) => f(cx));
  assert.equal(room.copied, null);
});
