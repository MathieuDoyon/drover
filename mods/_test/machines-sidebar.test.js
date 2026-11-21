// T-MWO2HEHGIEC (A4 job 3): machines in the Tasks sidebar with a polled load meter, through the REAL wiring (Tasks.init -> io.js watchMachines -> health.js).
// A recording host stands in for hc and exec; Date.now is a fake clock; no host call is ever made by render. Written before the code.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const { default: Tasks } = await import(new URL("../drover-tasks/main.js", import.meta.url).href);
const C = await import(new URL("../_lib/config.js", import.meta.url).href);
const IO = await import(new URL("../_lib/io.js", import.meta.url).href);
const S = await import(new URL("../_lib/config-schema.js", import.meta.url).href);
const HL = await import(new URL("../_lib/health.js", import.meta.url).href);

const MIN = 60000, SEC = 1000;
const GOOD = { v: 1, os: "linux", cores: 4, load: { one: 1.6, five: 1, fifteen: 0.8 }, loadPerCore: 0.4, mem: { totalMb: 16000, usedMb: 9760, pct: 61 }, disks: { home: { totalMb: 100000, freeMb: 60000, pct: 40 }, tmp: { totalMb: 50000, freeMb: 45000, pct: 10 } } };
const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

// A host that records every side effect. `answer(argv, name)` answers a health exec; `names` is what `hc machine ls --json` lists.
function setup({ names = ["box1"], polling = false, override, answer = () => ({ code: 0, stdout: JSON.stringify(GOOD), stderr: "" }), listAnswer } = {}) {
  C.resetCache(); C.setSettings("drover-tasks", { machine_polling: polling }); C.setSettings("drover-runs", {}); C.setSettings("drover-wakeups", {});
  IO.resetRemoteWriter(); IO.resetMachineHealth();
  const st = { T: 1_000_000, execs: [], hcs: [], writes: 0, hcWrites: 0, live: new Map(), maxLive: new Map(), names, answer, listAnswer };
  Date.now = () => st.T;
  const raw = { "drover.tasks": [], "drover.projects": [], "drover.runs": [], ...(override === undefined ? {} : { "drover.config": { "drover-tasks": { machine_polling: override } } }) };
  globalThis.__host = {
    props: {}, notified: [], home: "/h", appHome: "/nowhere", state: raw, focused: { terminal: "t1", cwd: "/x", space: null }, spaces: [], panes: [],
    exec: async (cmd, args, opts) => {
      if (cmd !== "hc" || args[0] !== "exec") return { code: 1, stdout: "", stderr: "" };
      const name = args[2];
      st.execs.push({ cmd, args, opts, name, at: st.T });
      st.live.set(name, (st.live.get(name) ?? 0) + 1);
      st.maxLive.set(name, Math.max(st.maxLive.get(name) ?? 0, st.live.get(name)));
      try { return await st.answer(args, name); } finally { st.live.set(name, st.live.get(name) - 1); }
    },
    hc: async (args, opts) => {
      st.hcs.push(args);
      if (args.includes("write") || args.includes("install")) st.hcWrites++;
      if (args[0] === "machine" && args[1] === "ls") {
        if (st.listAnswer) return st.listAnswer();
        return { code: 0, stdout: JSON.stringify({ machines: st.names.map((n) => (typeof n === "string" ? { name: n, state: "connected" } : n)) }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
    readTextFile: async (path) => (String(path).endsWith("/mods/drover-tasks/mod.json") ? JSON.stringify({ settings: { machine_polling: polling } }) : null), writeTextFile: async () => { st.writes++; }, watchFolder: async () => {}, run: () => {},
  };
  const timers = [];
  const cx = { notify() { st.notified = (st.notified ?? 0) + 1; }, stop_propagation() {}, spawn() {} /* as in tasks-render-reads: a real spawn would run the inbox/wakeup loops, which spin on the instant exec stub */, focus_handle: () => ({ focus() {} }), timer: { every(ms, f) { timers.push({ ms, f }); }, after() {} } };
  const t = new Tasks(); t.init({}, cx);
  // one second of the host's timers, then let every microtask of the fake answers run (a clock driver, not a wait for a result)
  // only the Machines timer is driven: the other timers (inbox, wakeups, needs) do real fs reads that a 1800-tick clock loop would queue by the thousand
  const tick = async () => { for (const x of timers) if (String(x.f).includes("health.tick")) x.f(cx); await new Promise((r) => setImmediate(r)); };
  const at = async (ms) => { st.T = 1_000_000 + ms; await tick(); };
  return { t, cx, st, tick, at, timers };
}
const render = (t, cx) => { globalThis.__rec = { ids: [], texts: [] }; try { t.render(cx); return { ...globalThis.__rec }; } finally { globalThis.__rec = undefined; } };
const has = (r, re) => r.texts.some((x) => re.test(x));
const count = (st, n) => st.execs.filter((e) => e.name === n).length;
// the render tree (needs __rec): find a node by id and read what was chained on it
const NODE = Symbol.for("test.node");
const findNode = (root, id) => { const seen = [root[NODE]]; while (seen.length) { const n = seen.shift(); if (!n) continue; if (n.id === id) return n; seen.push(...(n.kids ?? [])); } return null; };
const renderTree = (t, cx) => { globalThis.__rec = { ids: [], texts: [] }; try { return t.render(cx); } finally { globalThis.__rec = undefined; } };
const loaded = (s) => until(() => IO.machineView().listState === "ok", "machine list");

test("setting: drover-tasks.machine_polling is a live boolean, off by default, and the field matrix names it", () => {
  const f = S.field("drover-tasks", "machine_polling");
  assert.equal(f.type, "boolean");
  assert.equal(f.default, false);
  assert.equal(f.live, true);
  assert.match(f.description, /off by default/i);
  assert.match(f.description, /5 minutes/);
  assert.match(f.description, /hc exec/);
  assert.match(readFileSync(new URL("../_lib/config-schema.js", import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"), /drover-tasks\.machine_polling/);
});

test("setting: the shared Drover Config override beats mod.json, both ways (cfg, the layered live reader)", () => {
  C.resetCache(); C.setSettings("drover-tasks", { machine_polling: true });
  C.bind({ shared: (k) => ({ "drover.config": { "drover-tasks": { machine_polling: false } } })[k] });
  assert.equal(C.cfg("drover-tasks", "machine_polling"), false, "shared false, mod.json true: off");
  C.resetCache(); C.setSettings("drover-tasks", { machine_polling: false });
  C.bind({ shared: (k) => ({ "drover.config": { "drover-tasks": { machine_polling: true } } })[k] });
  assert.equal(C.cfg("drover-tasks", "machine_polling"), true, "shared true, mod.json false: on");
  C.resetCache();
});

test("polling off by default: over 10 minutes of 1 s ticks there are 0 exec calls, the list call still runs, and nothing is ever written", async () => {
  const s = setup({ names: ["box1", "box2"] });
  for (let t = 0; t <= 10 * MIN; t += SEC) await s.at(t);
  assert.equal(s.st.execs.length, 0);
  assert.ok(s.st.hcs.filter((a) => a[0] === "machine" && a[1] === "ls").length >= 15, "the local list is read every 30 s");
  assert.ok(s.st.hcs.every((a) => a[0] === "machine" && a[1] === "ls"), "the only hc call is the machine list");
  assert.equal(s.st.writes, 0);
  assert.equal(s.st.hcWrites, 0);
  const r = render(s.t, s.cx);
  assert.ok(r.ids.includes("machine-box1") && r.ids.includes("machine-box2"));
  assert.ok(has(r, /polling off/));
  assert.ok(!has(r, /load \d|mem \d|disk /), "no numbers while polling is off");
});

test("the setting applies live: the shared override turns polling on and off without reopening; off again stops new reads", async () => {
  const s = setup({ polling: false });
  await s.at(0); await loaded(s); await s.at(SEC);
  assert.equal(s.st.execs.length, 0);
  globalThis.__host.state["drover.config"] = { "drover-tasks": { machine_polling: true } };
  await s.at(2 * SEC);
  await until(() => s.st.execs.length === 1, "first read after switch-on");
  globalThis.__host.state["drover.config"] = { "drover-tasks": { machine_polling: false } };
  for (let t = 3 * SEC; t < 12 * MIN; t += 5 * SEC) await s.at(t);
  assert.equal(s.st.execs.length, 1, "off: nothing more");
});

test("mod.json false with the shared override true starts polling; shared override false with mod.json true does not", async () => {
  const on = setup({ polling: false, override: true });
  await on.at(0); await loaded(on); await on.at(SEC);
  await until(() => on.st.execs.length === 1, "polling on by override");
  const off = setup({ polling: true, override: false });
  for (let t = 0; t < 2 * MIN; t += 5 * SEC) await off.at(t);
  assert.equal(off.st.execs.length, 0);
});

test("4 machines through the real wiring over [0, 30 min): at most one exec each per 5 min, never two in flight, only the health argv, via the local exec with a ms timeout", async () => {
  const s = setup({ names: ["box1", "box2", "box3", "box4"], polling: true });
  for (let t = 0; t < 30 * MIN; t += 10 * SEC) await s.at(t);
  for (const n of ["box1", "box2", "box3", "box4"]) assert.ok(count(s.st, n) >= 5 && count(s.st, n) <= 6, `${n}: ${count(s.st, n)}`);
  for (const [n, k] of s.st.maxLive) assert.equal(k, 1, n);
  for (const e of s.st.execs) {
    assert.equal(e.cmd, "hc");
    assert.deepEqual(e.args, HL.healthArgv(e.name));
    assert.ok(Number.isInteger(e.opts?.timeout) && e.opts.timeout >= 20000 && e.opts.timeout <= 30000, "a ms timeout, so the call always settles");
  }
  for (const n of ["box1", "box2", "box3", "box4"]) {
    const ats = s.st.execs.filter((e) => e.name === n).map((e) => e.at);
    for (let i = 1; i < ats.length; i++) assert.ok(ats[i] - ats[i - 1] >= 5 * MIN, `${n}: reads ${i - 1} and ${i} are ${(ats[i] - ats[i - 1]) / 1000}s apart`);
  }
  assert.equal(s.st.writes + s.st.hcWrites, 0, "the poll path never writes or installs");
  assert.ok(s.st.hcs.every((a) => a[0] === "machine"), "no hc call but the list (health goes through exec)");
});

test("a failing machine through the wiring is retried after 10 min, not 5", async () => {
  const s = setup({ names: ["box1", "box2"], polling: true, answer: (a) => (a[2] === "box2" ? { code: 1, stdout: "", stderr: "x" } : { code: 0, stdout: JSON.stringify(GOOD), stderr: "" }) });
  for (let t = 0; t < 30 * MIN; t += 10 * SEC) await s.at(t);
  assert.equal(count(s.st, "box2"), 3);
  assert.ok(count(s.st, "box1") >= 5);
});

test("rows: a fresh read shows the compact meter text; the higher disk is named; the bar is neutral", async () => {
  const s = setup({ polling: true });
  await s.at(0); await loaded(s); await s.at(SEC);
  await until(() => IO.machineView().machines[0]?.state === "fresh", "fresh");
  await s.at(2 * SEC);
  const r = render(s.t, s.cx);
  assert.ok(r.ids.includes("machine-box1"));
  assert.ok(has(r, /^load 0\.4\/core · mem 61% · disk home 40%$/), r.texts.join(" | "));
  assert.ok(has(r, /^▾ Machines$/));
});

test("rows: never read -> 'waiting for the first read'; failed -> dimmed numbers with 'last read N min ago, failed'; python3 missing and an unknown list use fixed texts", async () => {
  let mode = "hang";
  const hang = new Promise(() => {});
  const s = setup({ polling: true, answer: () => (mode === "hang" ? hang : mode === "good" ? { code: 0, stdout: JSON.stringify(GOOD), stderr: "" } : mode === "nopy" ? { code: 127, stdout: "", stderr: "SECRET /home/x" } : { code: 1, stdout: "", stderr: "SECRET /home/x" }) });
  await s.at(0); await loaded(s); await s.at(SEC);
  assert.ok(has(render(s.t, s.cx), /^waiting for the first read$/));
  mode = "good";
  s.st.names = ["box1"];
  const s2 = setup({ polling: true });
  await s2.at(0); await loaded(s2); await s2.at(SEC);
  await until(() => IO.machineView().machines[0]?.state === "fresh", "fresh");
  s2.st.answer = () => ({ code: 1, stdout: "", stderr: "SECRET /home/x" });
  await s2.at(5 * MIN + 2 * SEC); await s2.at(5 * MIN + 3 * SEC);
  await until(() => IO.machineView().machines[0]?.state === "failed", "failed");
  await s2.at(17 * MIN);
  const r = render(s2.t, s2.cx);
  assert.ok(has(r, /last read \d+ min ago, failed/), r.texts.join(" | "));
  assert.ok(has(r, /load 0\.4\/core/), "the last good numbers stay, dimmed");
  assert.ok(!r.texts.join(" ").match(/SECRET|\/home\/x/), "machine text never shown");
  const s3 = setup({ polling: true, answer: () => ({ code: 127, stdout: "", stderr: "" }) });
  await s3.at(0); await loaded(s3); await s3.at(SEC);
  await until(() => IO.machineView().machines[0]?.state === "failed", "no python");
  assert.ok(has(render(s3.t, s3.cx), /python3 missing on this machine/));
  const s4 = setup({ polling: false });
  await s4.at(0); await loaded(s4);
  s4.st.listAnswer = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });
  await s4.at(31 * SEC); await s4.at(32 * SEC);
  await until(() => IO.machineView().listState === "unknown", "list failed");
  await s4.at(60 * SEC);
  assert.ok(has(render(s4.t, s4.cx), /list unknown/));
});

test("rows: an offline machine is dimmed, says so, and gets no exec", async () => {
  const s = setup({ polling: true });
  await s.at(0); await loaded(s); await s.at(SEC);
  await until(() => IO.machineView().machines[0]?.state === "fresh", "fresh");
  s.st.names = [{ name: "box1", state: "disconnected" }];
  for (let t = 31 * SEC; t < 12 * MIN; t += 10 * SEC) await s.at(t);
  assert.equal(count(s.st, "box1"), 1);
  const r = render(s.t, s.cx);
  assert.ok(has(r, /offline/), r.texts.join(" | "));
});

test("render reads memory only: with machines present, render and its repeats make no exec / hc / write / timer call", async () => {
  const s = setup({ polling: true, names: ["box1", "box2"] });
  await s.at(0); await loaded(s); await s.at(SEC);
  await until(() => IO.machineView().machines.every((m) => m.state === "fresh"), "fresh");
  const before = { exec: s.st.execs.length, hc: s.st.hcs.length, w: s.st.writes, timers: s.timers.length };
  for (let i = 0; i < 5; i++) render(s.t, s.cx);
  assert.deepEqual({ exec: s.st.execs.length, hc: s.st.hcs.length, w: s.st.writes, timers: s.timers.length }, before);
  const src = readFileSync(new URL("../drover-tasks/main.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("  render(cx) {"));
  for (const word of ["exec(", "hc(", "watchMachines(", "createHealth(", "healthArgv(", "writeTextFile("]) assert.ok(!body.includes(word), `render must not call ${word}`);
  assert.ok(body.includes("machineView()"), "render reads the health cache");
});

test("the Machines section folds with its own key and the list is hidden when there are no machines", async () => {
  const s = setup({ polling: false });
  await s.at(0); await loaded(s);
  globalThis.__host.state["drover.tasks.machines-fold"] = true;
  const r = render(s.t, s.cx);
  assert.ok(has(r, /^▸ Machines/) || has(r, /Machines/));
  assert.ok(!r.ids.includes("machine-box1"), "folded: no rows");
  const none = setup({ names: [], polling: false });
  await none.at(0); await loaded(none);
  assert.ok(!has(render(none.t, none.cx), /Machines/), "no machine: no section");
});

test("a fresh row carries a tooltip with both disks (home and /tmp)", async () => {
  const s = setup({ polling: true });
  await s.at(0); await loaded(s); await s.at(SEC);
  await until(() => IO.machineView().machines[0]?.state === "fresh", "fresh");
  const n = findNode(renderTree(s.t, s.cx), "machine-box1");
  assert.ok(n, "the row node");
  assert.equal(n.args.tooltip?.[0], "disk home 40% · /tmp 10%");
});

test("a stale row (the machine list stopped answering): dimmed, 'last read N min ago, list unknown', and no exec while it lasts", async () => {
  const s = setup({ polling: true });
  await s.at(0); await loaded(s); await s.at(SEC);
  await until(() => IO.machineView().machines[0]?.state === "fresh", "fresh");
  s.st.listAnswer = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });
  const n0 = s.st.execs.length;
  for (let t = 30 * SEC; t <= 61 * MIN; t += 30 * SEC) await s.at(t);
  assert.equal(s.st.execs.length, n0, "no exec off a stale list");
  const tree = renderTree(s.t, s.cx);
  const row = findNode(tree, "machine-box1");
  assert.ok(row.calls.includes("opacity"), "dimmed");
  const r = render(s.t, s.cx);
  assert.ok(has(r, /last read 6\d min ago, list unknown/), r.texts.join(" | "));
  assert.ok(has(r, /load 0\.4\/core/), "the last good numbers stay");
});

test("docs: the manual path is the one the installer activates (SHARE/current), not .../gen/current", async () => {
  const { SHARE } = await import("../_lib/machines.js");
  const g = readFileSync(new URL("../../docs/guides/machines.md", import.meta.url), "utf8");
  assert.ok(g.includes(`python3 ~/${SHARE}/current/bin/drover-health.py`), "the documented command");
  assert.ok(!g.includes("/gen/current/bin/drover-health.py"));
});

test("docs: the settings row, the Machines paragraph, the machines guide and the hold exemption exist, generic", () => {
  const rd = (p) => readFileSync(new URL(`../../docs/${p}`, import.meta.url), "utf8");
  assert.match(rd("configuration.md"), /\| Tasks \| `machine_polling` \| off \|/);
  assert.match(rd("mods/tasks.md"), /`machine_polling`/);
  assert.match(rd("mods/tasks.md"), /## Machines/);
  const g = rd("guides/machines.md");
  assert.match(g, /drover-health\.py/);
  assert.match(g, /exempt/i);
  assert.match(g, /one argv item/);
  assert.ok(!/anything later\)/.test(g) || !/\(board writes, health,/.test(g), "the old 'code that pushes ... health' line is replaced");
});
