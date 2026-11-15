// The wakeup editor dialog (drover-wakeups WakeEditor) against a fake host: Save adds or edits, Cancel changes nothing, one close only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], closeCalls: [] };
const { WakeEditor } = await import("../drover-wakeups/main.js");

let host;
const cx = { timer: { after() {} }, notify() {} };
const open = (wakeEdit, state = {}) => {
  host = globalThis.__host = { props: { overlay: "ov1", wakeEdit }, state, notified: [], closeCalls: [], closeOverlay: (id) => host.closeCalls.push(id) };
  return new WakeEditor(cx);
};
const fill = (e, f) => { for (const [k, v] of Object.entries(f)) e[k].set_value(v); };
const wakes = () => host.state["drover.wakeups"] ?? [];

beforeEach(() => { host = null; });

test("New: a weekly wakeup is saved with its name, days and enabled flag, then the dialog closes once", () => {
  const e = open(null);
  fill(e, { name: "TZ check", target: "T-ABC", text: "go", time: "16:00" });
  e.days = new Set([1, 3]);
  e.enabled = false;
  e.submit(cx); e.submit(cx);
  assert.equal(wakes().length, 1);
  assert.deepEqual([wakes()[0].name, wakes()[0].sched, wakes()[0].enabled], ["TZ check", { time: "16:00", days: [1, 3] }, false]);
  assert.deepEqual(host.closeCalls, ["ov1"]);
});

test("New from a task: target is fixed, terminal fields hidden, wakeup targets the task", () => {
  const e = open(null);
  host.props.wakeTarget = "T-XYZ";
  const f = new WakeEditor(cx);
  fill(f, { text: "go", time: "10:00" });
  f.submit(cx);
  assert.equal(wakes()[0].target, "T-XYZ");
  globalThis.__rec = { ids: [], texts: [] };
  f.render(cx);
  const r = globalThis.__rec; globalThis.__rec = null;
  assert.ok(!r.texts.some((x) => String(x).includes("Wake (terminal")) && !r.ids.some((x) => x.startsWith("pick-")));
  host.agents = [{ address: "t9", tab_name: "x" }];
  globalThis.__rec = { ids: [], texts: [] };
  open(null).render(cx);
  const r2 = globalThis.__rec; globalThis.__rec = null;
  assert.ok(r2.texts.some((x) => String(x).includes("Wake (terminal")));
});

test("New: Every interval and Once", () => {
  let e = open(null);
  e.kind = "every"; fill(e, { target: "t12", text: "x", minutes: "15" });
  e.submit(cx);
  assert.equal(wakes()[0].every, 15 * 60000);
  e = open(null, host.state);
  e.kind = "once"; fill(e, { target: "t12", text: "y", date: "2099-01-02 09:30" });
  e.submit(cx);
  assert.equal(wakes()[1].due, new Date(2099, 0, 2, 9, 30).getTime());
});

test("a bad form keeps the dialog open with the error; Cancel and Esc change nothing", () => {
  const e = open(null);
  fill(e, { target: "T-ABC", text: " " });
  e.submit(cx);
  assert.equal(e.error, "Message is empty");
  assert.equal(host.closeCalls.length, 0);
  e.days = new Set(); fill(e, { text: "x" }); e.submit(cx);
  assert.match(e.error, /at least one day/);
  e.kind = "every"; fill(e, { minutes: "2" }); e.submit(cx);
  assert.equal(e.error, "Repeat at most every 5m");
  e.kind = "every"; fill(e, { minutes: "abc" }); e.submit(cx);
  assert.match(e.error, /Can't read repeat/);
  e.close(); e.close();
  assert.equal(wakes().length, 0);
  assert.equal(host.closeCalls.length, 1);
});

test("Edit: fields start from the wakeup; Save keeps id and send count, switches the schedule", () => {
  const first = open(null);
  fill(first, { name: "a", target: "T-ABC", text: "go", time: "09:00" });
  first.submit(cx);
  const w = { ...wakes()[0], count: 3 };
  host.state["drover.wakeups"] = [w];
  const e = open(w.id, host.state);
  assert.deepEqual([e.kind, e.name.value(), e.time.value(), [...e.days]], ["at", "a", "09:00", [1, 2, 3, 4, 5]]);
  e.kind = "every"; fill(e, { minutes: "30", text: "new" });
  e.submit(cx);
  assert.equal(wakes().length, 1);
  assert.deepEqual([wakes()[0].id, wakes()[0].count, wakes()[0].every, wakes()[0].sched ?? null, wakes()[0].text], [w.id, 3, 30 * 60000, null, "new"]);
});

// Inbox ops from the drover CLI: wakes (list), wake-off / wake-on, wake-rm. Pure: wakeOp(list, cmd) -> { reply, list? }.
const { wakeOp, addWake, wakeName } = await import("../_lib/wake.js");
const seed = () => {
  let list = [];
  for (const f of [{ target: "t5", text: "a", when: "15m", name: "Ping" }, { target: "T-ABC", text: "b", every: "1h" }]) list = addWake(list, f).list;
  return list;
};

test("CLI wakes: lists id, name, target, summary, next run, status, enabled; filters by target", () => {
  const list = seed();
  const all = wakeOp(list, { op: "wakes" }).reply.split("\n");
  assert.match(all[0], /^ok: 2 wakeups/);
  assert.match(all[1], new RegExp(`^${list[0].id}\\s+Ping\\s+t5\\s+Once.*in 1[45]m\\s+scheduled\\s+on$`));
  assert.match(all[2], /T-ABC\s+Every 1h/);
  const one = wakeOp(list, { op: "wakes", target: "T-ABC" }).reply.split("\n");
  assert.equal(one.length, 2);
  assert.match(wakeOp(list, { op: "wakes", target: "t9" }).reply, /^ok: no wakeups/);
});

test("CLI wake off / on / rm change one wakeup; an unknown id is a clear error that changes nothing", () => {
  const list = seed();
  const id = list[0].id;
  const off = wakeOp(list, { op: "wake-off", id });
  assert.match(off.reply, new RegExp(`^ok: ${id}`));
  assert.deepEqual(off.list.map((w) => w.enabled), [false, true]);
  assert.deepEqual(wakeOp(off.list, { op: "wake-on", id }).list.map((w) => w.enabled), [true, true]);
  const rm = wakeOp(list, { op: "wake-rm", id });
  assert.deepEqual(rm.list.map((w) => w.id), [list[1].id]);
  for (const op of ["wake-off", "wake-on", "wake-rm"]) {
    const bad = wakeOp(list, { op, id: "W-NOPE" });
    assert.equal(bad.reply, "error: no wakeup W-NOPE (see: drover wakes)");
    assert.equal(bad.list, undefined);
  }
});

test("CLI wake off: a hostile id stays one JSON string and cannot change the op", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readdirSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(`${tmpdir()}/drover-cli-`);
  const id = 'W-NOPE","op":"archive","id":"T-ABC';
  spawnSync(new URL("../drover-tasks/bin/drover", import.meta.url).pathname, ["wake", "off", id], { env: { ...process.env, HERDR_APP_HOME: home } });
  const dir = `${home}/data/drover-inbox`;
  const cmd = JSON.parse(readFileSync(`${dir}/${readdirSync(dir).find((f) => f.endsWith(".json"))}`, "utf8"));
  assert.deepEqual(cmd, { op: "wake-off", id });
});

test("CLI wakes: an unnamed wakeup shows the first line of its message as the name, not '-'", () => {
  const list = addWake([], { target: "t5", text: "Queue", every: "15m" }).list;
  assert.match(wakeOp(list, { op: "wakes" }).reply.split("\n")[1], new RegExp(`^${list[0].id}\\s+Queue\\s+t5\\s`));
  assert.equal(wakeName({ name: "", text: "A very long first line that goes on and on and on past the limit\nsecond" }), "A very long first line that goes on and on and …");
});

test("defaultOnce: now+15m rounded up to the next 5 minutes", async () => {
  const { defaultOnce } = await import("../_lib/wake.js");
  const at = (h, m, s = 0) => new Date(2026, 10, 12, h, m, s).getTime();
  assert.equal(defaultOnce(at(10, 12, 30)), at(10, 30));
  assert.equal(defaultOnce(at(10, 15)), at(10, 30));
  assert.equal(defaultOnce(at(10, 46)), at(11, 5));
});

test("New Once dialog: the field starts 15-20 minutes ahead", () => {
  const e = open(null);
  const ms = new Date(e.date.value().replace(" ", "T")).getTime() - Date.now();
  assert.ok(ms > 14 * 60000 && ms <= 20 * 60000, String(ms));
});
