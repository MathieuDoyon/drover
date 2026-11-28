import { test } from "node:test";
import assert from "node:assert/strict";
import { freeEndedRuns, add, addProject, applyCommand, attention, queue, squadFor, nextReport, claim, release } from "./store.js";
import { droverOf, activeFor, waitingFor, slotSnapshot, slotsOf, startGuard, projectOfDrover, resumeGuard, markEnded } from "./runs.js";

const { projects } = addProject(addProject([], { name: "A", repos: "/a" }, 1).projects, { name: "B", repos: "/b" }, 2);
const [A, B] = projects;
const card = (title, fields = {}) => ({ title, column: "todo", project: A.id, ...fields });
const seed = (...cards) => cards.reduce((tasks, c, i) => add(tasks, c, 1000 + i).tasks, []);
const idOf = (tasks, title) => tasks.find((t) => t.title === title).id;

// A squad run on a task: terminals t<n> as given.
const sq = (task, project, ...terms) => ({ id: "R" + task, task, project, reportTo: "t81", started: 1, terminals: terms.map((address) => ({ address, agent: "wrangler" })) });
const drv = (address, project, started = 1) => ({ id: "D" + address, task: null, project, started, terminals: [{ address, agent: "drover" }] });

test("queue: only Ready, live, own-project cards with a repo; others skipped with a reason", () => {
  const noRepo = addProject([], { name: "Empty" }, 3).project;
  const tasks = seed(
    card("a1"), card("a2", { priority: "P0" }), card("b1", { project: B.id }), card("arch", { archived: true }),
    card("doing", { column: "doing" }), card("loose", { project: null }), card("norepo", { project: noRepo.id }), card("owned"),
  ).map((t) => (t.title === "arch" ? { ...t, archived: true } : t.title === "owned" ? { ...t, agent: "t9" } : t));
  const q = queue(tasks, A.id, [...projects, noRepo]);
  assert.deepEqual(q.picks.map((t) => t.title), ["a2", "a1"]); // P0 first
  const why = Object.fromEntries(q.skips.map((s) => [s.task.title, s.reason]));
  assert.deepEqual(why, { loose: "no project", owned: "has an agent" });
});

test("queue: a card whose project has no repo is skipped", () => {
  const empty = addProject([], { name: "Empty" }, 3).project;
  const tasks = seed(card("x", { project: empty.id }));
  const q = queue(tasks, empty.id, [empty]);
  assert.equal(q.picks.length, 0);
  assert.equal(q.skips[0].reason, "no repo");
});

test("queue: board order (drag order) beats priority; empty queue is empty", () => {
  const tasks = seed(card("p0", { priority: "P0" }), card("dragged", { priority: "P3" })).map((t) => (t.title === "dragged" ? { ...t, order: 0 } : t));
  assert.deepEqual(queue(tasks, A.id, projects).picks.map((t) => t.title), ["dragged", "p0"]);
  assert.deepEqual(queue([], A.id, projects), { picks: [], skips: [] });
});

test("squadFor: bug/fix -> stray, spike/scope or empty desc -> scouting, else cattle-drive", () => {
  const t = (tags, desc = "d") => ({ tags, desc });
  assert.equal(squadFor(t(["bug"])), "stray");
  assert.equal(squadFor(t(["fix"])), "stray");
  assert.equal(squadFor(t(["spike"])), "scouting");
  assert.equal(squadFor(t(["scope"])), "scouting");
  assert.equal(squadFor(t([], "")), "scouting");
  assert.equal(squadFor(t(["feat"])), "cattle-drive");
});

test("nextReport: slot count, one line per card up to the slots; none at 0 slots", () => {
  const tasks = seed(card("one"), card("two"), card("three"), card("loose", { project: null }));
  const r2 = nextReport(tasks, projects, A.id, 2).split("\n");
  assert.equal(r2[0], "ok: 2 slots");
  assert.match(r2[1], /^T-\S+ P2 squad=scouting one$/); // empty desc
  assert.match(r2[2], /^T-\S+ P2 squad=scouting two$/);
  assert.ok(!r2.some((l) => l.includes("three")));
  assert.ok(r2.some((l) => /^skip T-\S+ no project/.test(l)));
  assert.equal(nextReport(tasks, projects, A.id, 0), "ok: 0 slots");
  assert.equal(nextReport([], projects, A.id, 2), "ok: 2 slots");
});

test("droverOf: newest live run with agent drover for that project", () => {
  const runs = [drv("t1", A.id, 1), drv("t2", A.id, 5), drv("t3", B.id, 9), drv("t4", A.id, 20), drv("t5", null, 30)];
  assert.equal(droverOf(runs, A.id, new Set(["t1", "t2", "t3", "t5"])), "t2"); // t4 is dead
  assert.equal(droverOf(runs, A.id, new Set()), null);
  assert.equal(droverOf(runs, null, new Set(["t5"])), null);
});

test("projectOfDrover: the bound project of the Drover terminal, else null", () => {
  assert.equal(projectOfDrover([drv("t1", A.id)], "t1"), A.id);
  assert.equal(projectOfDrover([drv("t1", null)], "t1"), null);
  assert.equal(projectOfDrover([sq("T-1", A.id, "t1")], "t1"), null); // not a drover terminal
  assert.equal(projectOfDrover([], "t1"), null);
});

test("activeFor: runs not ended count (blocked, stopped, starting); claiming cards count; other projects do not", () => {
  const runs = [sq("T-1", A.id, "t1"), sq("T-2", A.id, "t2"), sq("T-3", A.id, "t3"), sq("T-4", B.id, "t4"), drv("t81", A.id)];
  const alive = new Set(["t1", "t2", "t4"]); // t3 ended
  const live = new Map([["t1", "blocked"], ["t2", "working"]]);
  assert.equal(activeFor(runs, [], A.id, live, alive), 2);
  assert.equal(activeFor(runs, [{ id: "T-9", project: A.id, agent: "claiming" }, { id: "T-8", project: B.id, agent: "claiming" }], A.id, live, alive), 3);
  assert.equal(activeFor([], [], A.id, live, alive), 0);
});

test("claim: sets doing + claiming at once; refuses archived, moved, owned or foreign cards", () => {
  const tasks = seed(card("x"));
  const id = tasks[0].id;
  const c = claim(tasks, id, A.id);
  assert.equal(c.task.column, "doing");
  assert.equal(c.task.agent, "claiming");
  assert.equal(c.prev.column, "todo");
  assert.ok(claim(c.tasks, id, A.id).error); // 2nd claim: already claimed
  assert.ok(claim(tasks.map((t) => ({ ...t, archived: true })), id, A.id).error);
  assert.ok(claim(tasks.map((t) => ({ ...t, column: "backlog" })), id, A.id).error);
  assert.ok(claim(tasks, id, B.id).error);
  assert.ok(claim(tasks, "T-NONE", A.id).error);
  const manual = claim(tasks.map((t) => ({ ...t, column: "backlog" })), id); // no project given: a manual start
  assert.equal(manual.task.column, "doing");
  assert.equal(manual.prev.column, "backlog");
});

test("release: a failed launch puts the card back in todo with no agent", () => {
  const tasks = seed(card("x")).map((t) => ({ ...t, order: 3 }));
  const id = tasks[0].id;
  const c = claim(tasks, id, A.id);
  const r = release(c.tasks, id, c.prev);
  assert.equal(r.tasks[0].column, "todo");
  assert.equal(r.tasks[0].agent, null);
  assert.equal(r.tasks[0].order, 3);
});

test("release: does not restore a card the owner moved or archived in the meantime", () => {
  const tasks = seed(card("x"));
  const id = tasks[0].id;
  const c = claim(tasks, id, A.id);
  const moved = c.tasks.map((t) => ({ ...t, agent: null, column: "backlog" }));
  assert.equal(release(moved, id, c.prev).tasks[0].column, "backlog");
  const gone = c.tasks.filter((t) => t.id !== id);
  assert.deepEqual(release(gone, id, c.prev).tasks, []);
});

test("attention: a claiming card shows as working, not as a gone agent", () => {
  const t = { id: "T-1", column: "doing", agent: "claiming", archived: false };
  assert.deepEqual(attention(t, new Map()), { group: "working", reason: "Agent is starting" });
});

const ctx = (tasks, runs, extra = {}) => ({ tasks, runs, projects, live: new Map(), alive: new Set(["t81"]), ...extra });

test("startGuard: unbound caller keeps manual behaviour; a duplicate start reports the owner", () => {
  const tasks = seed(card("x"));
  const id = tasks[0].id;
  assert.deepEqual(startGuard(ctx(tasks, []), { task: id, from: "t81" }), { ok: true });
  assert.deepEqual(startGuard(ctx(tasks, []), { task: "", from: "t81" }), { ok: true }); // free run
  const owned = tasks.map((t) => ({ ...t, agent: "t12" }));
  assert.match(startGuard(ctx(owned, [], { alive: new Set(["t81", "t12"]) }), { task: id, from: "t81" }).error, /already has agent t12/);
  assert.equal(startGuard(ctx(owned, []), { task: id, from: "t81" }).ok, true); // that agent is gone: manual restart ok
  const claiming = tasks.map((t) => ({ ...t, agent: "claiming" }));
  assert.match(startGuard(ctx(claiming, []), { task: id, from: "t81" }).error, /already starting/);
});

test("startGuard: queue mode needs Ready, same project, a repo, and a free slot", () => {
  const tasks = seed(card("x"), card("other", { project: B.id }), card("doing", { column: "doing" }), card("loose", { project: null }));
  const runs = [drv("t81", A.id)];
  const g = (title, extra) => startGuard(ctx(tasks, runs, extra), { task: idOf(tasks, title), from: "t81" });
  assert.equal(g("x").ok, true);
  assert.match(g("other").error, /project/);
  assert.match(g("doing").error, /Ready/);
  assert.match(g("loose").error, /project/);
  const full = [...runs, sq("T-1", A.id, "t1"), sq("T-2", A.id, "t2")];
  const f = startGuard(ctx(tasks, full, { alive: new Set(["t81", "t1", "t2"]) }), { task: idOf(tasks, "x"), from: "t81" });
  assert.match(f.error, /no free slot/);
  const noRepo = addProject([], { name: "Empty" }, 9).project;
  const t2 = seed(card("y", { project: noRepo.id }));
  assert.match(startGuard({ ...ctx(t2, [drv("t81", noRepo.id)]), projects: [noRepo] }, { task: t2[0].id, from: "t81" }).error, /repo/);
});

test("startGuard: a blocked or ended squad: blocked keeps its slot, ended frees it", () => {
  const tasks = seed(card("x"));
  const base = [drv("t81", A.id), sq("T-1", A.id, "t1")];
  const guard = (runs, live, alive) => startGuard(ctx(tasks, runs, { live, alive }), { task: tasks[0].id, from: "t81" });
  const two = [...base, sq("T-2", A.id, "t2")];
  assert.ok(guard(two, new Map([["t1", "blocked"]]), new Set(["t81", "t1", "t2"])).error);
  assert.equal(guard(two, new Map(), new Set(["t81", "t1"])).ok, true); // t2 ended
});

test("applyCommand: an agent cannot move a card to done; the owner (no from) can", () => {
  const tasks = seed(card("x", { column: "review" }));
  const id = tasks[0].id;
  assert.match(applyCommand(tasks, { op: "move", id, column: "done", from: "t12" }).error, /owner/);
  assert.equal(applyCommand(tasks, { op: "move", id, column: "done", from: "" }).task.column, "done");
  assert.equal(applyCommand(tasks, { op: "move", id, column: "done" }).task.column, "done");
  assert.equal(applyCommand(tasks, { op: "move", id, column: "backlog", from: "t12" }).task.column, "backlog");
});

test("claim: a stale agent (terminal gone) does not block a manual restart; a live one does", () => {
  const tasks = seed(card("x")).map((t) => ({ ...t, agent: "t12", column: "doing" }));
  const id = tasks[0].id;
  assert.ok(claim(tasks, id, undefined, 1, new Set(["t12"])).error);
  const c = claim(tasks, id, undefined, 1, new Set());
  assert.equal(c.task.agent, "claiming");
  assert.equal(c.prev.column, "doing");
});

test("release: after a real move by the owner during launch, the claim is cleared but the column stays", () => {
  const tasks = seed(card("x"));
  const id = tasks[0].id;
  const c = claim(tasks, id, A.id);
  const moved = applyCommand(c.tasks, { op: "move", id, column: "backlog" }).tasks; // keeps agent "claiming"
  const r = release(moved, id, c.prev).tasks[0];
  assert.equal(r.column, "backlog");
  assert.equal(r.agent, null);
  const arch = applyCommand(c.tasks, { op: "archive", id }).tasks;
  const a = release(arch, id, c.prev).tasks[0];
  assert.equal(a.archived, true);
  assert.equal(a.agent, null);
});

test("bind: a bound Drover run gives nextFor slots; startGuard checks the bind", () => {
  const bound = [drv("t81", A.id)];
  assert.equal(projectOfDrover(bound, "t81"), A.id);
  assert.equal(projectOfDrover([drv("t81", null)], "t81"), null);
  const g = (cmd, runs = [], alive = new Set()) => startGuard(ctx([], runs, { alive }), { task: "", runner: "drover", from: "t1", ...cmd });
  assert.equal(g({ project: A.id }).ok, true);
  assert.match(g({ project: A.id, runner: "wrangler" }).error, /only for the drover agent/);
  assert.match(g({ project: A.id }, bound, new Set(["t81"])).error, /project A already has Drover t81/);
  assert.equal(g({ project: A.id }, bound, new Set()).ok, true); // dead Drover: manual re-bind
  assert.equal(g({ project: B.id }, bound, new Set(["t81"])).ok, true); // other project
  const tasks = seed(card("x"));
  assert.match(startGuard(ctx(tasks, []), { task: tasks[0].id, runner: "drover", project: B.id, from: "t1" }).error, /belongs to project A/);
  assert.equal(startGuard(ctx(tasks, []), { task: tasks[0].id, runner: "drover", project: A.id, from: "t1" }).ok, true);
});

test("CLI start: --project and --worktree parse in any order", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readdirSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const bin = new URL("../drover-tasks/bin/drover", import.meta.url).pathname;
  const run = (...args) => {
    const home = mkdtempSync(`${tmpdir()}/drover-cli-`);
    const r = spawnSync(bin, args, { env: { ...process.env, HERDR_APP_HOME: home }, timeout: 1500 });
    const dir = `${home}/data/drover-inbox`;
    const f = readdirSync(dir, { withFileTypes: false }).find((n) => n.endsWith(".json"));
    return { r, cmd: f ? JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) : null };
  };
  for (const args of [["--worktree", "--project", "x y"], ["--project", "x y", "--worktree"]]) {
    const { cmd } = run("start", "T-AB1", "drover", ...args);
    assert.equal(cmd.project, "x y");
    assert.equal(cmd.worktree, true);
  }
  assert.equal(run("start", "-", "drover", "--project", "x").cmd.worktree, false);
  assert.equal(run("start", "-", "drover").cmd.project, "");
  assert.equal(spawnSync(bin, ["start", "-", "drover", "--project"], { env: { ...process.env, HERDR_APP_HOME: "/nonexistent" } }).status, 2);
});

test("bind: uniqueness uses the effective project; a project-less task refuses --project; a reservation blocks a 2nd bind", () => {
  const live = [drv("t81", A.id)];
  const alive = new Set(["t81"]);
  const tasks = seed(card("x"), card("loose", { project: null }));
  const g = (cmd, extra = {}) => startGuard(ctx(tasks, live, { alive, ...extra }), { runner: "drover", from: "t1", project: null, ...cmd });
  assert.match(g({ task: idOf(tasks, "x") }).error, /already has Drover t81/); // implicit bind via the task
  assert.equal(g({ task: idOf(tasks, "x"), runner: "wrangler" }).ok, true); // a squad on the task is not a bind
  assert.match(g({ task: idOf(tasks, "loose"), project: A.id }).error, /has no project/);
  const now = Date.now();
  assert.match(g({ project: B.id }, { binding: { [B.id]: now } }).error, /already being bound/);
  assert.equal(g({ project: B.id }, { binding: { [B.id]: now - 10 * 60000 } }).ok, true); // stale reservation
});

// ---- T-MWMIQMBO1BQ: a card in Review or Blocked does not hold a parallel slot (its run is "waiting").
const onCard = (id, column, extra = {}) => ({ id, title: id, project: A.id, column, ...extra });
const snapAll = (runs, tasks, alive, limit) => slotSnapshot(runs, tasks, new Map(), alive, limit);
const snap = (runs, tasks, alive, limit, p = A.id) => { const all = snapAll(runs, tasks, alive, limit); return { ...slotsOf(all, p), limit, waitingRunIds: all.waitingRunIds }; };
const ALIVE = new Set(["t81", "t1", "t2", "t3"]);
const full = (c1, c2) => ({ tasks: [onCard("T-1", c1), onCard("T-2", c2)], runs: [drv("t81", A.id), sq("T-1", A.id, "t1"), sq("T-2", A.id, "t2")] });

test("activeFor: a run on a Review or Blocked card is waiting, not active; In progress counts", () => {
  const runs = [sq("T-1", A.id, "t1"), sq("T-2", A.id, "t2"), sq("T-3", A.id, "t3")];
  const tasks = [onCard("T-1", "review"), onCard("T-2", "blocked"), onCard("T-3", "doing")];
  assert.equal(activeFor(runs, tasks, A.id, new Map(), ALIVE), 1);
  assert.equal(waitingFor(runs, tasks, A.id, new Map(), ALIVE), 2);
  const s = snap(runs, tasks, ALIVE, 2);
  assert.deepEqual({ limit: s.limit, active: s.active, waiting: s.waiting, free: s.free }, { limit: 2, active: 1, waiting: 2, free: 1 });
  assert.deepEqual([...s.waitingRunIds].sort(), ["RT-1", "RT-2"]);
});

test("slotSnapshot: archived, missing, claiming, no-task, other-project and ended cases", () => {
  const runs = [sq("T-1", A.id, "t1"), sq("T-2", A.id, "t2"), sq("T-3", A.id, "t3"), sq("T-4", B.id, "t4"), drv("t81", A.id), sq("T-5", A.id, "t9")];
  const tasks = [onCard("T-1", "review", { archived: true }), onCard("T-3", "blocked"), onCard("T-4", "review", { project: B.id }), onCard("T-5", "review"), { id: "T-6", project: A.id, column: "review", agent: "claiming" }];
  const alive = new Set(["t81", "t1", "t2", "t3", "t4"]); // t9 ended
  const s = snap(runs, tasks, alive, 5);
  assert.equal(s.waiting, 1, "only T-3: archived (T-1), missing card (T-2), other project, ended (T-5) are never waiting");
  assert.deepEqual([...s.waitingRunIds].sort(), ["RT-3", "RT-4"], "RT-4 is project B: in the all-project set, not in A numbers");
  assert.equal(s.active, 3, "T-1 archived + T-2 no card count as before; the claiming card counts whatever its column");
  assert.equal(s.free, 2);
  assert.equal(snap([], [], alive, 2).free, 2);
});

test("slotSnapshot: one pass gives a bucket for every project, claim-only projects included; inputs untouched", () => {
  const runs = [sq("T-1", A.id, "t1"), sq("T-2", B.id, "t2"), sq("T-3", B.id, "t3"), drv("t81", A.id)];
  const tasks = [onCard("T-1", "doing"), onCard("T-2", "review", { project: B.id }), onCard("T-3", "doing", { project: B.id }), onCard("T-9", "doing", { project: "P-C", agent: "claiming" })];
  const before = JSON.stringify([runs, tasks]);
  const all = slotSnapshot(runs, tasks, new Map(), ALIVE, 2);
  assert.deepEqual([...all.byProject.keys()].sort(), [A.id, B.id, "P-C"].sort());
  assert.deepEqual(all.byProject.get(A.id), { active: 1, waiting: 0, free: 1 });
  assert.deepEqual(all.byProject.get(B.id), { active: 1, waiting: 1, free: 1 });
  assert.deepEqual(all.byProject.get("P-C"), { active: 1, waiting: 0, free: 1 });
  assert.deepEqual([...all.waitingRunIds], ["RT-2"]);
  assert.equal(all.limit, 2);
  assert.deepEqual(slotsOf(all, "P-NONE"), { active: 0, waiting: 0, free: 2 });
  assert.equal(JSON.stringify([runs, tasks]), before);
});

test("startGuard permitted: limit 2, both runs on Review/Blocked cards -> a Ready card starts", () => {
  const x = seed(card("x"));
  const f = full("review", "blocked");
  const c = ctx([...f.tasks, ...x], f.runs, { alive: ALIVE });
  assert.deepEqual(startGuard(c, { task: x[0].id, from: "t81" }), { ok: true });
});

test("startGuard refused: 2 runs on In progress cards -> no free slot; with one waiting the text says so", () => {
  const x = seed(card("x"));
  const f = full("doing", "doing");
  const e = startGuard(ctx([...f.tasks, ...x], f.runs, { alive: ALIVE }), { task: x[0].id, from: "t81" }).error;
  assert.match(e, /^no free slot: limit 2 reached/);
  assert.doesNotMatch(e, /waiting/);
  const runs3 = [...f.runs, sq("T-3", A.id, "t3")];
  const e2 = startGuard(ctx([...f.tasks, onCard("T-3", "review"), ...x], runs3, { alive: ALIVE }), { task: x[0].id, from: "t81" }).error;
  assert.match(e2, /^no free slot: limit 2 reached/);
  assert.match(e2, /1 waiting in Review\/Blocked \(not counted\)/);
  assert.ok(e2.includes("Only the owner") && e2.includes("drover config max-parallel <n>"));
});

test("a card moves back to In progress with the slots full: the move is accepted, active exceeds the limit, starts are refused, slots are 0", () => {
  const x = seed(card("x"));
  const f = full("doing", "doing");
  const tasks = [...f.tasks, onCard("T-3", "review"), ...x];
  const runs = [...f.runs, sq("T-3", A.id, "t3")];
  assert.equal(snap(runs, tasks, ALIVE, 2).active, 2); // T-3 is waiting
  const m = applyCommand(tasks, { op: "move", id: "T-3", column: "doing", from: "t12" });
  assert.equal(m.error, undefined, "the move is never blocked by the limit");
  assert.equal(m.task.column, "doing");
  const after = m.tasks;
  const s = snap(runs, after, ALIVE, 2);
  assert.deepEqual({ active: s.active, waiting: s.waiting, free: s.free }, { active: 3, waiting: 0, free: 0 });
  assert.equal(activeFor(runs, after, A.id, new Map(), ALIVE), 3);
  assert.match(startGuard(ctx(after, runs, { alive: ALIVE }), { task: x[0].id, from: "t81" }).error, /no free slot/);
  assert.equal(nextReport(after, projects, A.id, s.free, s.waiting), "ok: 0 slots");
});

test("no run is killed: activeFor, startGuard, nextReport and markEnded leave runs and the alive set untouched", () => {
  const f = full("review", "doing");
  const x = seed(card("x"));
  const tasks = [...f.tasks, ...x];
  const before = JSON.stringify({ r: f.runs, t: tasks });
  const alive = new Set(ALIVE), live = new Map([["t1", "working"]]);
  activeFor(f.runs, tasks, A.id, live, alive); waitingFor(f.runs, tasks, A.id, live, alive); slotSnapshot(f.runs, tasks, live, alive, 2);
  startGuard(ctx(tasks, f.runs, { alive }), { task: x[0].id, from: "t81" });
  nextReport(tasks, projects, A.id, 1, 1);
  assert.equal(JSON.stringify({ r: f.runs, t: tasks }), before);
  assert.deepEqual([...alive].sort(), [...ALIVE].sort());
  // the parked run (card in Review, terminals alive) stays open: markEnded changes nothing
  const withStart = f.runs.map((r) => ({ ...r, terminals: r.terminals.map((m) => ({ ...m, started: 1 })) }));
  assert.equal(markEnded(withStart, live, alive, 99), withStart);
});

test("nextReport: the waiting count is shown after the slots, also at 0 slots; absent when 0", () => {
  const tasks = seed(card("a1"));
  assert.equal(nextReport(tasks, projects, A.id, 0, 2), "ok: 0 slots \u00b7 2 waiting");
  assert.equal(nextReport(tasks, projects, A.id, 0, 0), "ok: 0 slots");
  const r = nextReport(tasks, projects, A.id, 1, 3).split("\n");
  assert.equal(r[0], "ok: 1 slots \u00b7 3 waiting");
  assert.match(r[1], /a1/);
  assert.equal(nextReport([], projects, A.id, 2, 0), "ok: 2 slots");
});

// T-MWV45TGVB9L: a finished run's agent must not keep a card out of the queue; a live parked agent must keep its card.
const staffed = (tasks, f) => tasks.map((t) => ({ ...t, ...f })); // add() stores no agent; a run puts it there
const SNAPSHOT = new Set(["t1"]); // a real snapshot that does not list the dead agents below
test("queue: a card in Blocked with a dead agent, moved to Ready, is listed by drover next", () => {
  const tasks = staffed(seed(card("stuck", { column: "blocked" })), { agent: "t25s", run: "R-1", claimedAt: 5 });
  const id = idOf(tasks, "stuck");
  const moved = applyCommand(tasks, { op: "move", id, column: "ready" }, 2000, { alive: SNAPSHOT }).tasks;
  assert.match(nextReport(moved, projects, A.id, 1), new RegExp(`${id} .* stuck`));
  assert.deepEqual(moved.find((t) => t.id === id).agent ?? null, null);
});

test("queue: Review or Backlog with a dead agent frees it on the way to Ready; staying parked keeps it", () => {
  for (const column of ["review", "backlog"]) {
    const tasks = staffed(seed(card("c", { column })), { agent: "t9", run: "R-9" });
    const t = applyCommand(tasks, { op: "move", id: tasks[0].id, column: "ready" }, 2000, { alive: SNAPSHOT }).task;
    assert.deepEqual([t.agent, t.run, t.claimedAt], [null, null, null]);
  }
  const tasks = staffed(seed(card("c", { column: "review" })), { agent: "t9", run: "R-9" });
  assert.equal(applyCommand(tasks, { op: "move", id: tasks[0].id, column: "blocked" }, 2000, { alive: SNAPSHOT }).task.agent, "t9");
});

test("a LIVE parked agent, or no liveness snapshot, keeps the card's agent on move and release", () => {
  const tasks = staffed(seed(card("p", { column: "blocked" })), { agent: "t9", run: "R-9" });
  const id = tasks[0].id;
  for (const ctx of [{ alive: new Set(["t9"]) }, { alive: new Set() }, undefined]) {
    assert.equal(applyCommand(tasks, { op: "move", id, column: "ready" }, 2000, ctx).task.agent, "t9");
    assert.match(applyCommand(tasks, { op: "release", id }, 2000, ctx).error, /alive or cannot be checked/);
  }
});

test("release op: clears a dead agent on a parked card, refuses a card in progress", () => {
  const tasks = seed(card("p", { column: "blocked" }), card("d", { column: "doing" })).map((t, i) => ({ ...t, agent: i ? "t3" : "t25s", run: i ? "R-2" : "R-1" }));
  const r = applyCommand(tasks, { op: "release", id: tasks[0].id }, 2000, { alive: SNAPSHOT });
  assert.deepEqual([r.task.agent, r.task.run, r.task.column], [null, null, "blocked"]);
  assert.match(applyCommand(tasks, { op: "release", id: tasks[1].id }, 2000, { alive: SNAPSHOT }).error, /in progress/);
});

test("freeEndedRuns: a parked card of an ended run is freed and queued; a live, claiming or running card is not", () => {
  const tasks = staffed(seed(card("a", { column: "blocked" }), card("b", { column: "review" }), card("c", { column: "blocked" }), card("d", { column: "doing" })), {})
    .map((t, i) => ({ ...t, agent: ["t25s", "t9", "t7", "t8"][i], run: ["R-1", "R-2", "R-3", "R-1"][i] }));
  const runs = [{ id: "R-1", ended: 5 }, { id: "R-2", ended: 5 }, { id: "R-3" }];
  const out = freeEndedRuns(tasks, runs, new Set(["t9", "t1"])); // t9 is alive (reused address), R-3 has not ended
  assert.deepEqual(out.map((t) => [t.agent, t.run]), [[null, null], ["t9", "R-2"], ["t7", "R-3"], ["t8", "R-1"]]);
  assert.equal(freeEndedRuns(tasks, runs, new Set()), tasks); // no snapshot: nothing freed
  assert.equal(freeEndedRuns(out, runs, new Set(["t9", "t1"])), out); // idempotent
  const moved = applyCommand(out, { op: "move", id: out[0].id, column: "ready" }, 2000).tasks;
  assert.match(nextReport(moved, projects, A.id, 1), /a$/m);
});
