// Drover Config card 5: tunables (Room, Runs, Wakeups, Todos, Reader) read through cfg(). Each default equals the old constant,
// invalid values fall back, ended runs are pruned (never an unended one), and the CLI wake op follows the configured minimum.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0, stdout: "[]", stderr: "" }), readTextFile: async () => null, home: "/h", appHome: "/a" };
const C = await import("../_lib/config.js");
const { field } = await import("../_lib/config-schema.js");
const W = await import("../_lib/wake.js");
const R = await import("../_lib/runs.js");

const MODS = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(MODS, p), "utf8");
const CFG = "drover.config";
const set = (obj) => { globalThis.__host.state[CFG] = obj; };
beforeEach(() => { C.resetCache(); globalThis.__host.state = {}; C.setSharedReader(() => globalThis.__host.state[CFG]); });

// [mod, key, old constant, min, max, live]
const TABLE = [
  ["drover-room", "refresh_minutes", 5, 1, 1440, true],
  ["drover-room", "pr_cap", 10, 1, 100, true],
  ["drover-room", "kept_contexts", 30, 1, 1000, true],
  ["drover-runs", "max_parallel", 2, 1, 10, true],
  ["drover-runs", "kept", 200, 10, 5000, true],
  ["drover-wakeups", "min_repeat_minutes", 5, 1, 1440, true],
  ["drover-wakeups", "expiry_hours", 2, 1, 168, true],
  ["drover-wakeups", "ui_tick_seconds", 30, 1, 3600, false],
  ["drover-todos", "context_refresh_seconds", 60, 5, 3600, false],
  ["drover-todos", "pr_cap", 10, 1, 100, true],
  ["drover-todos", "run_history_cap", 10, 1, 100, true],
  ["drover-todos", "wake_cap", 20, 1, 200, true],
  ["drover-reader", "max_text", 4000, 200, 100000, true],
];

test("each tunable: default equals the old constant, range clamps to the default, live flag is honest", () => {
  for (const [mod, key, old, min, max, live] of TABLE) {
    const f = field(mod, key);
    assert.ok(f, `${mod}.${key} missing`);
    assert.equal(f.default, old, `${mod}.${key} default`);
    assert.deepEqual([f.min, f.max], [min, max], `${mod}.${key} range`);
    assert.equal(f.live, live, `${mod}.${key} live`);
    assert.equal(C.cfg(mod, key), old);
    for (const bad of [min - 1, max + 1, 1.5, "7", null]) { set({ [mod]: { [key]: bad } }); assert.equal(C.cfg(mod, key), old, `${mod}.${key}=${bad}`); }
    set({ [mod]: { [key]: max } });
    assert.equal(C.cfg(mod, key), max);
  }
});

test("old constants are still the defaults: MAX_RUNS, MIN_EVERY, EXPIRES_AFTER", () => {
  assert.equal(R.MAX_RUNS, 2);
  assert.equal(W.MIN_EVERY, 5 * 60000);
  assert.equal(W.EXPIRES_AFTER, 2 * 3600000);
});

// ---- runs.kept: only ended runs are dropped ----
test("pruneRuns keeps every unended run and trims only ended ones beyond the cap, newest first", () => {
  const run = (id, ended) => ({ id, ...(ended ? { ended: 1 } : {}) });
  const list = [run("a"), run("e1", true), run("b"), run("e2", true), run("e3", true), run("c")];
  assert.deepEqual(R.pruneRuns(list, 2).map((r) => r.id), ["a", "e1", "b", "e2", "c"]);
  assert.deepEqual(R.pruneRuns(list, 0).map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(R.pruneRuns(list, 99).map((r) => r.id), list.map((r) => r.id));
  const many = Array.from({ length: 300 }, (_, i) => run(`u${i}`));
  assert.equal(R.pruneRuns(many, 200).length, 300, "unended runs are never dropped, even over the cap");
});

test("runs.kept and runs.max_parallel are read through cfg()", () => {
  assert.equal(R.keptRuns(), 200);
  assert.equal(R.maxRuns(), 2);
  set({ "drover-runs": { kept: 50, max_parallel: 4 } });
  assert.equal(R.keptRuns(), 50);
  assert.equal(R.maxRuns(), 4);
  assert.doesNotMatch(src("_lib/io.js"), /\.slice\(0, 200\)\); \/\/ ponytail|loadRuns\(\)\]\.slice/);
});

// ---- wakeups ----
const base = { target: "t7", text: "ping" };
test("addWake: shortest repeat follows the setting; the error names the configured minutes", () => {
  assert.equal(W.addWake([], { ...base, every: "3m" }).error, "Repeat at most every 5m");
  set({ "drover-wakeups": { min_repeat_minutes: 10 } });
  assert.equal(W.addWake([], { ...base, every: "9m" }).error, "Repeat at most every 10m");
  assert.ok(W.addWake([], { ...base, every: "10m" }).wake);
  set({ "drover-wakeups": { min_repeat_minutes: 1 } });
  assert.ok(W.addWake([], { ...base, every: "1m" }).wake);
  assert.equal(W.updateWake([{ id: "W-1", status: "scheduled" }], "W-1", { ...base, every: "30s" }).error, "Can't read repeat \"30s\": use 30m, 2h, 1d");
});

test("addWake and reschedule: expiry follows expiry_hours", () => {
  const now = 1_000_000;
  assert.equal(W.addWake([], { ...base, when: "now" }, now).wake.expires, now + 2 * 3600000);
  set({ "drover-wakeups": { expiry_hours: 6 } });
  const one = W.addWake([], { ...base, when: "now" }, now).wake;
  assert.equal(one.expires, now + 6 * 3600000);
  const rep = W.addWake([], { ...base, every: "1h" }, now).wake;
  assert.equal(rep.expires, rep.due + 3600000, "a repeat still waits at most one interval");
  const next = W.reschedule([{ ...rep, status: "sending" }], rep.id, null, now + 1)[0];
  assert.equal(next.expires, next.due + 3600000);
});

test("the CLI wake op (inbox) enforces the configured minimum, the same value as the dialog", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "tun-"));
  Object.assign(globalThis.__host, { appHome: tmp, watchFolder: () => new Promise(() => {}), agents: [], terminals: [] });
  mkdirSync(join(tmp, "data/drover-inbox"), { recursive: true });
  const IO = await import("../_lib/io.js");
  const send = async (name, cmd) => {
    writeFileSync(join(tmp, "data/drover-inbox", `${name}.json`), JSON.stringify(cmd));
    const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) };
    IO.watchInbox(cx);
    const file = join(tmp, "data/drover-inbox", `${name}.result`);
    await until(() => readdirSync(join(tmp, "data/drover-inbox")).includes(`${name}.result`) && readFileSync(file, "utf8"), `the inbox answered ${name}`);
    return readFileSync(file, "utf8");
  };
  set({ "drover-wakeups": { min_repeat_minutes: 15 } });
  assert.equal(await send("a1", { op: "wake", target: "t7", text: "x", every: "10m" }), "error: Repeat at most every 15m");
  assert.match(await send("a2", { op: "wake", target: "t7", text: "x", every: "15m" }), /^ok: W-/);
});

// ---- source checks: the sites read cfg(), no private copy of the number is left ----
test("sites read cfg(): Room live refresh, caps, Todos, Reader, Wakeups tick", () => {
  const room = src("drover-room/main.js");
  assert.doesNotMatch(room, /EVERY_MIN|intSetting|this\.everyMin/, "Room reads refresh_minutes live, not once at init");
  assert.match(room, /cfg\("drover-room", "refresh_minutes"\)/);
  assert.match(room, /cfg\("drover-room", "kept_contexts"\)/);
  assert.match(src("_lib/io.js"), /cfg\("drover-room", "pr_cap"\)/);
  const todos = src("drover-todos/main.js");
  for (const k of ["context_refresh_seconds", "pr_cap", "run_history_cap", "wake_cap"]) assert.match(todos, new RegExp(`cfg\\("drover-todos", "${k}"\\)`), k);
  assert.doesNotMatch(todos, /every\?\.\(60000/);
  assert.match(src("drover-reader/main.js"), /cfg\("drover-reader", "max_text"\)/);
  assert.doesNotMatch(src("drover-reader/main.js"), /const MAX_TEXT/);
  assert.match(src("drover-wakeups/main.js"), /cfg\("drover-wakeups", "ui_tick_seconds"\)/);
});

test("the dialog lists the new fields under each mod, and the wakeups note says the CLI shares them", async () => {
  const { createModel } = await import("../drover-config/model.js");
  const S = await import("../_lib/config-schema.js");
  const m = createModel({ ...S, ...C });
  for (const [mod, key] of TABLE) assert.ok(m.rows({}, mod).some((r) => r.key === key), `${mod}.${key} not listed`);
  assert.match(src("drover-config/main.js"), /"drover-wakeups\/min_repeat_minutes": "[^"]*drover wake[^"]*"/);
});
