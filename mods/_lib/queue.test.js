import { test } from "node:test";
import assert from "node:assert/strict";
import { add, addProject, applyCommand, attention, queue, squadFor, nextReport, claim, release } from "./store.js";
import { droverOf, activeFor, startGuard, projectOfDrover } from "./runs.js";

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
