// T-MWSLVHRJN4A: the Room Squad row shows no model chip and no session/resume row.
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

test("Squad rows: no model chip, no session id, no resume command or copy row; name, role · address, status and age stay", async () => {
  const { rec, root } = await rendered(T);
  assert.equal(rec.ids.some((id) => /^resume-t\d/.test(id)), false, "no per-member resume row");
  assert.equal(rec.texts.some((x) => /^(req:|session )/.test(String(x)) || /--resume|codex resume|Copy/.test(String(x))), false);
  assert.ok(rec.texts.includes("Lead") && rec.texts.includes("leader · t3"));
  assert.equal(rec.texts.filter((x) => x === "running").length, 3, "status stays on each row");
  assert.equal(rec.texts.filter((x) => /^\d+d \d+h$/.test(x)).length, 3, "age stays on each row (started: 1 is far past, so the day format)");
  for (const a of ["t1", "t2", "t3"]) assert.ok(nodeOf(root, `m-${a}`), `row ${a} stays`);
});

test("Squad rows: only a live row focuses (live or gone)", async () => {
  for (const live of [["t1", "t2", "t3"], []]) {
    const { root } = await rendered(T, live);
    assert.equal(Boolean(nodeOf(root, "m-t3").args.on_click), live.length > 0);
  }
});
