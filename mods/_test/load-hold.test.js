// T-MWO2HEU32E4 (A5): the load hold through the REAL launch / start / resume paths. A simulated Herdr and a stubbed local python3 stand in; no real hc, no real python.
// Written before the code: every test fails on the old tree.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { makeSim, OK, SID } from "./stubs/resume-sim.js";
import { until } from "./stubs/until.js";

register("./hooks.js", import.meta.url);
const CLAUDE = "claude --model claude-opus-5-5 --permission-mode auto";
const CFG = { agents: [{ id: "lead", name: "Lead", command: CLAUDE, soul: "", instructions: "" }, { id: "ins", name: "Inspector", command: CLAUDE, soul: "", instructions: "" }],
  squads: [{ id: "s1", name: "Crew", version: 1, leader: "lead", members: [{ agent: "ins", role: "Inspector" }] }] };
const T = (o) => ({ started: 1, ended: 5, kind: "claude", cwd: "/wt", ...o });
const OLD = () => ({ id: "R-OLD", task: "T-1", project: null, title: "Card", runner: { kind: "squad", id: "s1" }, name: "Crew v1", space: "sp-old", started: 1, ended: 9, reportTo: null, worktree: null,
  config: { leader: { id: "lead", name: "Lead", command: CLAUDE, role: "leader" }, members: [{ id: "ins", name: "Inspector", command: CLAUDE, role: "Inspector" }] },
  terminals: [T({ address: "t2", agent: "ins", name: "Inspector", role: "Inspector", session: SID.a, parked: true, model: "claude-opus-5-5" }), T({ address: "t1", agent: "lead", name: "Lead", role: "leader", session: SID.lead, model: "claude-opus-5-5" })] });
const CARD = (o) => ({ id: "T-1", title: "Card", desc: "Do it", column: "review", agent: null, run: "R-OLD", priority: "P2", tags: [], created: 1, updated: 1, project: null, archived: false, notes: [], ...o });
const READY = (o) => CARD({ id: "T-2", title: "New", column: "todo", run: null, ...o });
const sample = (pct, extra = {}) => JSON.stringify({ v: 1, os: "linux", cores: 4, load: { one: 1, five: 1, fifteen: 1 }, loadPerCore: 0.25, mem: { totalMb: 100, usedMb: pct, pct }, disks: { home: { totalMb: 1, freeMb: 1, pct: 5 }, tmp: { totalMb: 1, freeMb: 1, pct: 5 } }, ...extra });

let host, sim, tmp, io, C, py, execs;
const CONFIG_KEY = "drover.config";
const setMem = (pct) => { py.answer = () => ({ code: 0, stdout: sample(pct), stderr: "" }); };
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lh-"));
  io = await import("../_lib/io.js"); C = await import("../_lib/config.js");
  io.resumeSettle.tries = 6; io.resumeSettle.ms = 0; io.killSettle.tries = 3; io.killSettle.ms = 0; io.parkSettle.ms = 0; io.sessionSettle.tries = 3; io.sessionSettle.ms = 0;
  C.resetCache(); C.setSettings("drover-runs", {}); io.resetLocalHealth();
  host = globalThis.__host = { pyExec: true, appHome: "/app", home: tmp, props: {}, notified: [], agents: [], panes: [], spaces: [],
    state: { "drover.agents": CFG, "drover.runs": [OLD()], "drover.tasks": [CARD(), READY()] }, readTextFile: async () => null };
  sim = makeSim(host); sim.exists.add("/wt");
  py = { calls: [], answer: null }; setMem(50); execs = [];
  const base = host.exec;
  host.exec = async (cmd, args, opts) => { execs.push([cmd, ...args]); if (cmd === "python3") { py.calls.push({ cmd, args, opts }); return py.answer(); } return base(cmd, args, opts); };
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const task = (id) => host.state["drover.tasks"].find((t) => t.id === id);
const opens = () => sim.calls.filter(([op]) => op === "tab.new" || op === "space.new");
const SQUAD = { kind: "squad", id: "s1" };
const setCfg = (o) => { host.state[CONFIG_KEY] = { "drover-runs": o }; };

test("launch: refused with the reason at 81% memory, allowed at 79% and at 80%", async () => {
  setMem(81);
  const r = await io.launch(task("T-2"), SQUAD, { worktree: true });
  assert.match(r.error, /held: memory is 81% full \(limit 80%/);
  assert.match(r.error, /drover-runs\.hold_memory/);
  assert.equal(opens().length, 0, "no terminal opened");
  assert.equal(sim.calls.length, 0);
  assert.equal(execs.some(([c]) => c === "git"), false, "no worktree made");
  assert.deepEqual([task("T-2").column, task("T-2").agent], ["todo", null], "the card is as it was");
  assert.deepEqual(await fs.readdir(tmp), [], "no work folder made");
  for (const pct of [79, 80]) {
    io.resetLocalHealth(); setMem(pct);
    const ok = await io.launch(task("T-2"), SQUAD);
    assert.equal(ok.error, undefined, `${pct}%`);
    assert.equal(ok.warning, undefined);
    host.state["drover.tasks"] = [CARD(), READY()];
  }
});

test("launch: a limit set to off is off, and a raised limit lets the start through", async () => {
  setMem(99); setCfg({ hold_memory: "off" });
  assert.equal((await io.launch(task("T-2"), SQUAD)).error, undefined);
  host.state["drover.tasks"] = [CARD(), READY()]; io.resetLocalHealth(); setCfg({ hold_memory: "95" }); setMem(90);
  assert.equal((await io.launch(task("T-2"), SQUAD)).error, undefined);
  host.state["drover.tasks"] = [CARD(), READY()]; io.resetLocalHealth(); setCfg({ hold_machines: "local: memory 85" }); setMem(90);
  assert.match((await io.launch(task("T-2"), SQUAD)).error, /memory is 90% full \(limit 85%.*hold_machines/);
});

test("launch: unknown health (python3 missing or failing) allows the start and carries a warning", async () => {
  py.answer = () => ({ code: 127, stdout: "", stderr: "python3: not found" });
  const r = await io.launch(task("T-2"), SQUAD);
  assert.equal(r.error, undefined);
  assert.match(r.warning, /health is unknown, start allowed/);
  assert.ok(host.notified.some((n) => /health is unknown/.test(n.body ?? n.title) && n.level !== "error"), "a notice, not an error");
  py.answer = () => { throw new Error("spawn failed"); };
  io.resetLocalHealth(); host.state["drover.tasks"] = [CARD(), READY()];
  assert.match((await io.launch(task("T-2"), SQUAD)).warning, /unknown/);
});

test("stale or failed remote rows are unknown (allow + warn); only a fresh row is judged; no row is unknown", async () => {
  const numbers = JSON.parse(sample(99));
  assert.equal((await io.holdFor("box1", { row: { state: "stale", numbers, ageMs: 20 * 60000 } })).hold, null);
  assert.match((await io.holdFor("box1", { row: { state: "failed", numbers, ageMs: 1000 } })).warn, /box1 health is unknown/);
  assert.match((await io.holdFor("box1", { row: { state: "fresh", numbers, ageMs: 1000 } })).hold, /memory is 99% full/);
  const none = await io.holdFor("box1");
  assert.equal(none.hold, null); assert.match(none.warn, /box1 health is unknown/);
  assert.equal(py.calls.length, 0, "a remote machine is never read through the laptop's python");
});

test("drover start refused: reply is error: held, the claim is released and the card is unchanged", async () => {
  setMem(81);
  const look = () => { const t = task("T-2"); return { column: t.column, agent: t.agent, run: t.run, claimedAt: t.claimedAt ?? null }; };
  const before = look();
  const reply = await io.startFromAgent({ op: "start", task: "T-2", runner: "s1", from: "" });
  assert.match(reply, /^error: held: memory is 81% full/);
  assert.deepEqual(look(), before, "the claim was released: column and agent as before");
  assert.equal(opens().length, 0);
  io.resetLocalHealth(); setMem(79);
  assert.match(await io.startFromAgent({ op: "start", task: "T-2", runner: "s1", from: "" }), /^ok: R-/);
});

test("drover start with unknown health: started, and the ok line carries the warning", async () => {
  py.answer = () => ({ code: 1, stdout: "", stderr: "" });
  const reply = await io.startFromAgent({ op: "start", task: "T-2", runner: "s1", from: "" });
  assert.match(reply, /^ok: R-.* · warning: .*health is unknown, start allowed/);
});

test("the cold policy: a start from a mod that never loaded drover-runs reads the mod.json layer first", async () => {
  C.resetCache(); // drover-runs is NOT ready
  host.readTextFile = async (p) => (String(p).endsWith("/mods/drover-runs/mod.json") ? JSON.stringify({ settings: { hold_memory: "off" } }) : null);
  setMem(99);
  assert.equal((await io.launch(task("T-2"), SQUAD)).error, undefined, "inherited off is honoured");
  assert.equal(C.ready("drover-runs"), true);
  C.resetCache(); io.resetLocalHealth(); host.state["drover.tasks"] = [CARD(), READY()];
  host.readTextFile = async (p) => (String(p).endsWith("/mods/drover-runs/mod.json") ? JSON.stringify({ settings: { hold_memory: "95" } }) : null);
  setMem(90);
  assert.equal((await io.launch(task("T-2"), SQUAD)).error, undefined, "inherited raised limit is honoured");
  C.resetCache(); io.resetLocalHealth(); host.state["drover.tasks"] = [CARD(), READY()]; setCfg({ hold_memory: "50" }); setMem(60);
  assert.match((await io.launch(task("T-2"), SQUAD)).error, /memory is 60% full \(limit 50%/, "the owner's value beats the inherited one");
});

test("resume of a gone squad is a start: held at 81% (nothing opened, no claim), allowed at 79%", async () => {
  setMem(81);
  const before = JSON.stringify([host.state["drover.tasks"], host.state["drover.runs"]]);
  const r = await io.resumeSquad("R-OLD", { quiet: true });
  assert.match(r.error, /held: memory is 81% full/);
  assert.equal(opens().length, 0);
  assert.equal(JSON.stringify([host.state["drover.tasks"], host.state["drover.runs"]]), before, "no claim, run untouched");
  io.resetLocalHealth(); setMem(79);
  const ok = await io.resumeSquad("R-OLD", { quiet: true });
  assert.equal(ok.error, undefined);
  assert.equal(py.calls.length, 2, "one read for each check, not one per terminal");
});

test("resumeTerminal (a direct reopen of a dead terminal) is held too; inside a squad resume it is not checked again", async () => {
  setMem(81);
  const r = await io.resumeTerminal(OLD(), OLD().terminals[0], { cwd: "/wt", prompt: "p", token: "x", name: "n" });
  assert.match(r.error, /held: memory is 81% full/);
  assert.deepEqual(r.killed, []);
  assert.equal(opens().length, 0);
});

test("a held machine never changes the slot numbers, and a Review run still takes no slot", async () => {
  const R = await import("../_lib/runs.js");
  const runs = [{ ...OLD(), ended: undefined, project: "P-1", terminals: [T({ address: "t1", ended: undefined })] }];
  const tasks = [CARD({ project: "P-1" })];
  const snap = () => JSON.stringify(R.slotsOf(R.slotSnapshot(runs, tasks, new Map(), new Set(["t1"])), "P-1"));
  const a = snap(); setMem(99); await io.holdFor("local"); assert.equal(snap(), a);
  assert.match(a, /"waiting":1/); assert.match(a, /"active":0/);
  const state = JSON.stringify(host.state);
  setMem(99); io.resetLocalHealth(); await io.holdFor("local");
  assert.equal(JSON.stringify(host.state), state, "the hold writes nothing");
});

test("the local read is a bounded local process: no hc, no --on; render (machineView) reads nothing", async () => {
  const { HEALTH_PY } = await import("../_lib/health.js");
  io.machineView(); io.machineView();
  assert.equal(py.calls.length, 0, "no read from a render path");
  assert.equal(execs.length, 0);
  await io.holdFor("local"); await io.holdFor("local");
  assert.equal(py.calls.length, 1, "cached for 60 s");
  assert.deepEqual(py.calls[0].args, ["-c", HEALTH_PY]);
  assert.ok(py.calls[0].opts.timeout > 0);
  assert.equal(execs.some(([c, ...a]) => c === "hc" || a.includes("--on")), false);
  assert.equal(sim.hc.some((a) => a.includes("exec") || a.includes("--on")), false);
});

test("a read of a local machine in flight is shared: concurrent starts cost one read", async () => {
  let release; const gate = new Promise((r) => (release = r));
  py.answer = async () => { await gate; return { code: 0, stdout: sample(50), stderr: "" }; };
  const ps = [io.holdFor("local"), io.holdFor("local"), io.holdFor("local")];
  release(); await Promise.all(ps);
  assert.equal(py.calls.length, 1);
});

test("drover next: one held: line from the cache, no new read", async () => {
  assert.equal(io.heldNote(), null, "nothing read yet: nothing said");
  setMem(88); await io.holdFor("local");
  const n = py.calls.length;
  assert.match(io.heldNote(), /^held: memory is 88% full/);
  assert.equal(py.calls.length, n);
  io.resetLocalHealth(); setMem(10); await io.holdFor("local");
  assert.equal(io.heldNote(), null);
});

test("machines doctor warns when the machine is literally named local (the laptop's name in hold_machines); other names get no such line", async () => {
  const M = await import("../_lib/machines.js");
  const rt = { exec: async () => ({ code: 1, stdout: "", stderr: "" }), write: async () => ({ code: 1 }) };
  const run = async (machine) => (await M.doctor(rt, { machine, srcRoot: path.join(import.meta.dirname, "../drover-tasks"), appHome: null })).checks.find((c) => c.id === "name");
  const clash = await run("local");
  assert.equal(clash.status, "WARN");
  assert.match(clash.detail, /named "local".*this computer.*drover-runs\.hold_machines/);
  assert.equal(await run("box1"), undefined);
});

test("the dialog setting text refuses a bad hold_machines value as a whole and says why; local is documented as this computer", async () => {
  const S = await import("../_lib/config-schema.js");
  const f = S.field("drover-runs", "hold_machines");
  assert.equal(S.validate(f, "local: memory off").ok, true);
  const bad = S.validate(f, "local: memory off; b: nonsense");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /local is this computer/);
  assert.match(f.description, /local is this computer/);
  for (const [k, d] of [["hold_load", "1"], ["hold_memory", "80"], ["hold_disk", "90"], ["hold_machines", ""]]) assert.equal(C.cfg("drover-runs", k), d, k);
  assert.equal(S.validate(S.field("drover-runs", "hold_memory"), "eighty").ok, false);
});

test("launch with Report to Drover on: the unknown-health warning is still shown (a notice), and the run carries it", async () => {
  py.answer = () => ({ code: 127, stdout: "", stderr: "" });
  host.panes = [{ terminal: "tBoss", tab: "tab1", cwd: "/x" }]; host.spaces = [{ id: "sp1", tabs: [{ id: "tab1" }] }];
  const r = await io.launch(task("T-2"), SQUAD, { reportTo: "tBoss" });
  assert.equal(r.error, undefined);
  assert.match(r.warning, /health is unknown/);
  assert.equal(host.notified.filter((n) => /health is unknown/.test(n.body)).length, 1, "one notice, level not error");
  assert.notEqual(host.notified.find((n) => /health is unknown/.test(n.body)).level, "error");
});

test("drover start held: the check comes BEFORE the claim: the card and shared state are never written (no rev bump)", async () => {
  let release; const gate = new Promise((r) => (release = r));
  let entered = false;
  py.answer = async () => { entered = true; await gate; return { code: 0, stdout: sample(81), stderr: "" }; };
  const tasks0 = JSON.stringify(host.state["drover.tasks"]), writes = [];
  host.state = new Proxy(host.state, { set(o, k, v) { writes.push(String(k)); o[k] = v; return true; } });
  const p = io.startFromAgent({ op: "start", task: "T-2", runner: "s1", from: "" });
  await until(() => entered, "the health read was entered"); // the read is pending: nothing was claimed
  assert.equal(task("T-2").agent, null, "not claiming while the health read is pending");
  assert.equal(task("T-2").column, "todo");
  release();
  assert.match(await p, /^error: held: memory is 81% full/);
  assert.equal(JSON.stringify(host.state["drover.tasks"]), tasks0, "byte-equal: no rev bump, no updated change");
  assert.deepEqual(writes, [], "no shared key was written");
});

test("drover start: a card that changed while the health read was pending is judged on the state after it (no stale claim)", async () => {
  let release; const gate = new Promise((r) => (release = r));
  let entered = false;
  py.answer = async () => { entered = true; await gate; return { code: 0, stdout: sample(10), stderr: "" }; };
  const p = io.startFromAgent({ op: "start", task: "T-2", runner: "s1", from: "" });
  await until(() => entered, "the health read was entered");
  host.state["drover.tasks"] = host.state["drover.tasks"].map((t) => (t.id === "T-2" ? { ...t, archived: true } : t));
  release();
  assert.match(await p, /^error: .*(archived|not found)/);
  assert.equal(opens().length, 0);
});
