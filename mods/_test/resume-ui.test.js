// T-MWLGPS2QJQL S2: "Resume squad" in the Room (a run you are inside) and in Runs (any ended run): shown only when resumeGuard passes; one click = one call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { until, drain } from "./stubs/until.js";
import { makeSim, SID } from "./stubs/resume-sim.js";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [] };
const { default: Room } = await import("../drover-room/main.js");
const { default: Runs } = await import("../drover-runs/main.js");
const C = await import("../_lib/config.js");
const { NODE } = await import("./stubs/el.js");
const CFG = { agents: [{ id: "lead", name: "Lead", command: "claude --model m", soul: "", instructions: "" }], squads: [] };
const T = (o) => ({ started: 1, ended: 5, kind: "claude", cwd: "/wt", ...o });
const WT = { repo: "/r", branch: "feat/T-1/card", path: "/wt" };
const OLD = (o = {}) => ({ id: "R-OLD", task: "T-1", title: "Card", started: 1, ended: 9, space: "sp", worktree: null,
  config: { leader: { id: "lead", name: "Lead", command: "claude --model m", role: "leader" }, members: [] },
  terminals: [T({ address: "t1", agent: "lead", name: "Lead", role: "leader", session: SID.lead })], ...o });
const CARD = (o = {}) => ({ id: "T-1", title: "Card", column: "review", agent: null, run: "R-OLD", priority: "P2", tags: [], created: 1, updated: 1, project: null, ...o });
const walk = (n, out = []) => { out.push(n); for (const k of n.kids ?? []) walk(k, out); return out; };
const nodeOf = (root, id) => walk(root[NODE]).find((n) => n.id === id);
let host, sim, cx, view;
// The element stub records only while __rec is set.
const draw = () => { globalThis.__rec = { ids: [], texts: [] }; try { return view.render(cx); } finally { globalThis.__rec = undefined; } };

// A scripted git for a worktree that is still there and registered (so resume does not need real git here).
const gitOk = (args) => {
  if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: `worktree /r\nbranch refs/heads/main\n\nworktree ${WT.path}\nbranch refs/heads/${WT.branch}\n`, stderr: "" };
  if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return { code: 0, stdout: `${WT.path}\n`, stderr: "" };
  if (args[0] === "rev-parse" && args.includes("--git-common-dir")) return { code: 0, stdout: "/r/.git\n", stderr: "" };
  if (args[0] === "symbolic-ref") return { code: 0, stdout: `refs/heads/${WT.branch}\n`, stderr: "" };
  return { code: 1, stdout: "", stderr: "unexpected git" };
};

async function setup(Screen, { runs = [OLD()], tasks = [CARD()], live = [], focused = { terminal: "t900", cwd: "/wt/src" } } = {}) {
  C.resetCache();
  host = globalThis.__host = { props: {}, notified: [], agents: [], panes: [], spaces: [], home: "/h", appHome: "/app", focused,
    state: { "drover.runs": runs, "drover.tasks": tasks, "drover.agents": CFG, "drover.config": { "drover-room": {}, "drover-runs": {} } }, readTextFile: async () => null };
  sim = makeSim(host); sim.exists.add("/wt"); sim.exists.add("/r"); sim.git = gitOk;
  for (const a of live) sim.terms.set(a, { b: { status: () => "idle", delivered: () => true }, reads: 0, killed: false, argv: [], task: "" });
  cx = { notify() {}, stop_propagation() {}, write_to_clipboard() {}, timer: { every() {}, after() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)) };
  view = new Screen(); view.init({}, cx); view.showEnded = true; // Runs hides ended runs by default
  await until(() => { draw(); return Screen === Room ? view.run : true; }, "the screen is ready"); // gated until its settings load
  return draw();
}

// ---- Room: a run you are inside. The focus is a genuinely live terminal (t900 is on the live list); the run's terminals are all gone.
test("Room: a gone WORKTREE run, focused through a live terminal in its folder, shows Resume squad", async () => {
  const root = await setup(Room, { runs: [OLD({ worktree: WT })] });
  assert.ok(nodeOf(root, "resume-squad"));
});
test("Room: no Resume when the card is Done or archived, the run lives, was resumed, or an attempt runs", async () => {
  for (const [label, o] of [["done", { tasks: [CARD({ column: "done" })] }], ["archived", { tasks: [CARD({ archived: true })] }],
    ["resumed", { runs: [OLD({ worktree: WT, resumedBy: "R-X" })] }]]) assert.equal(nodeOf(await setup(Room, { runs: [OLD({ worktree: WT })], ...o }), "resume-squad"), undefined, label);
  assert.equal(nodeOf(await setup(Room, { runs: [OLD({ worktree: WT })], live: ["t1"] }), "resume-squad"), undefined, "live");
  await setup(Room, { runs: [OLD({ worktree: WT })] });
  host.state["drover.resumes"] = { "R-OLD": { id: "A-1", token: "t", card: "T-1", started: Date.now(), heartbeat: Date.now(), opened: [] } };
  assert.equal(nodeOf(draw(), "resume-squad"), undefined, "in flight");
});
test("Room: one click = one resume call, even when clicked again while it runs", async () => {
  const root = await setup(Room, { runs: [OLD({ worktree: WT })] });
  let release; sim.gate = new Promise((r) => { release = r; });
  const btn = nodeOf(root, "resume-squad");
  btn.args.on_click[0]({}, cx); btn.args.on_click[0]({}, cx); btn.args.on_click[0]({}, cx);
  await until(() => sim.calls.length > 0, "the first open started");
  release();
  await until(() => host.state["drover.runs"][0].resumedFrom === "R-OLD", "the squad was resumed");
  assert.equal(sim.opens().length, 1, "exactly one open");
});
test("Room: a failed resume is shown (notify) and the button comes back", async () => {
  const root = await setup(Room, { runs: [OLD({ worktree: WT })] });
  sim.plan.push({ status: () => "blocked", delivered: () => false }, { status: () => "blocked", delivered: () => false });
  nodeOf(root, "resume-squad").args.on_click[0]({}, cx);
  await until(() => host.notified.length > 0, "the failure was notified");
  await drain();
  assert.ok(nodeOf(draw(), "resume-squad"));
});
test("Room: while an attempt runs it shows Cancel, which sets the durable cancel flag", async () => {
  await setup(Room, { runs: [OLD({ worktree: WT })] });
  host.state["drover.resumes"] = { "R-OLD": { id: "A-1", token: "t", card: "T-1", started: Date.now(), heartbeat: Date.now(), opened: [] } };
  const root = draw();
  nodeOf(root, "resume-cancel").args.on_click[0]({}, cx);
  assert.equal(host.state["drover.resumes"]["R-OLD"].cancel, true);
});

// ---- Runs: reachable for ANY ended run, including a squad without a worktree that no focus can select in the Room.
test("Runs: a gone squad WITHOUT a worktree has Resume squad in its card (the Room cannot select it)", async () => {
  await setup(Runs);
  assert.ok(nodeOf(draw(), "resume-R-OLD"));
});
test("Runs: hidden when the card is Done or the run was resumed; Cancel shows while an attempt runs", async () => {
  await setup(Runs, { tasks: [CARD({ column: "done" })] });
  host.state["drover.runs"] = [OLD()];
  assert.equal(nodeOf(draw(), "resume-R-OLD"), undefined);
  await setup(Runs);
  host.state["drover.resumes"] = { "R-OLD": { id: "A-1", token: "t", card: "T-1", started: Date.now(), heartbeat: Date.now(), opened: [] } };
  assert.ok(nodeOf(draw(), "resume-cancel-R-OLD"));
});
test("Runs: one click = one resume call", async () => {
  await setup(Runs);
  let release; sim.gate = new Promise((r) => { release = r; });
  const btn = nodeOf(draw(), "resume-R-OLD");
  btn.args.on_click[0]({}, cx); btn.args.on_click[0]({}, cx);
  await until(() => sim.calls.length > 0, "the first open started");
  release();
  await until(() => host.state["drover.runs"][0].resumedFrom === "R-OLD", "resumed");
  assert.equal(sim.opens().length, 1);
});

// ---- a crashed attempt: "Resume needs recovery" with Recover + Cancel (nothing recovers by itself)
const lapsedRecord = () => ({ "R-OLD": { id: "A-1", token: "TOK", attemptIds: ["A-1"], card: "T-1", started: 0, heartbeat: 0, opened: [], prev: { column: "review" } } });
test("Room: a crashed attempt shows 'needs recovery' with Recover and Cancel, and no Resume; Recover runs once", async () => {
  await setup(Room, { runs: [OLD({ worktree: WT })], tasks: [CARD({ column: "doing", agent: "claiming", claimToken: "A-1", claimedAt: 0 })] });
  host.state["drover.resumes"] = lapsedRecord();
  const root = draw();
  assert.equal(nodeOf(root, "resume-squad"), undefined);
  assert.ok(nodeOf(root, "resume-needs-recovery"));
  assert.ok(nodeOf(root, "resume-recover") && nodeOf(root, "resume-abandon"));
  nodeOf(root, "resume-recover").args.on_click[0]({}, cx); nodeOf(root, "resume-recover").args.on_click[0]({}, cx);
  await until(() => !host.state["drover.resumes"]["R-OLD"], "recovered once");
  assert.deepEqual(sim.killed(), []);
  assert.equal(host.state["drover.tasks"][0].agent, null);
});
test("Room: Cancel on a crashed attempt abandons it", async () => {
  await setup(Room, { runs: [OLD({ worktree: WT })], tasks: [CARD({ column: "doing", agent: "claiming", claimToken: "A-1", claimedAt: 0 })] });
  host.state["drover.resumes"] = lapsedRecord();
  nodeOf(draw(), "resume-abandon").args.on_click[0]({}, cx);
  await until(() => !host.state["drover.resumes"]["R-OLD"], "abandoned");
  assert.equal(host.state["drover.tasks"][0].agent, null);
});
test("Runs: a crashed attempt shows Recover and Cancel on the ended run's card; no automatic action on a tick", async () => {
  await setup(Runs, { tasks: [CARD({ column: "doing", agent: "claiming", claimToken: "A-1", claimedAt: 0 })] });
  host.state["drover.resumes"] = lapsedRecord();
  const root = draw();
  assert.ok(nodeOf(root, "resume-recover-R-OLD") && nodeOf(root, "resume-abandon-R-OLD"));
  assert.equal(nodeOf(root, "resume-R-OLD"), undefined);
  assert.ok(host.state["drover.resumes"]["R-OLD"], "still there: a render or a tick recovers nothing");
  nodeOf(root, "resume-recover-R-OLD").args.on_click[0]({}, cx);
  await until(() => !host.state["drover.resumes"]["R-OLD"], "recovered");
});
