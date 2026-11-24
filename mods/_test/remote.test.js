// A project bound to another machine (T-MWHVWQNL2HA): the shared vocabulary of the binding, and the bind check. The laptop reads the board through the
// exec reader (remote-exec.js) since the shared.json reader retired (T-MWO2V65MUSX): the read-side behaviours below run against a fake drover-headless
// behind an injected runner. No real hc or machine; no sleeps.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const R = await import("../_lib/remote.js");
const X = await import("../_lib/remote-exec.js");

const SENTINEL = "SENTINEL-sk-not-a-real-secret-0042";
const RID = "P-REMOTE1", RID2 = "P-REMOTE2";
const OPS = ["add", "archive", "edit", "move", "note"];
const card = (id, project, extra = {}) => ({ id, title: `title ${id}`, desc: "", column: "todo", project, archived: false, notes: [], ...extra });
const board = (over = {}) => ({
  "drover.projects": [{ id: RID, name: "r1" }, { id: RID2, name: "r2" }],
  "drover.tasks": [card("T-A", RID), card("T-B", RID, { archived: true }), card("T-C", RID2), card("T-D", null)],
  ...over,
});

// A fake hc: machine ls answers `machines`; hc exec <headless> answers version|rev|tasks|projects from `board`, a hold (on rev), a raw text, or an error.
function fakeHc() {
  const f = { calls: [], machines: ["box1"], board: board(), raw: null, err: null, hold: null, code: 0, gen: 1 };
  const verbOf = (args) => args.slice(args.indexOf(X.HEADLESS) + 1)[0];
  f.run = async (args, opts) => {
    f.calls.push({ args, opts });
    if (args[0] === "machine") return { code: 0, stdout: JSON.stringify({ machines: f.machines.map((name) => ({ name, state: "connected" })) }), stderr: "" };
    const v = verbOf(args);
    if (f.hold && v === "rev") await f.hold;
    if (f.err) throw new Error(f.err);
    if (f.code) return { code: f.code, stdout: "", stderr: `boom ${SENTINEL}\nsecond` };
    if (f.raw !== null) return { code: 0, stdout: f.raw, stderr: "" };
    const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
    if (v === "version") return ok({ cli: "drover-headless", schema: 1, ops: OPS });
    if (v === "rev") return ok({ gen: f.gen, tasks: `h${f.gen}`, bytes: 1 });
    if (v === "tasks") return ok({ gen: f.gen, rev: `h${f.gen}`, tasks: f.board["drover.tasks"] });
    if (v === "projects") return ok({ gen: f.gen, projects: f.board["drover.projects"] });
    return { code: 2, stdout: "", stderr: "usage" };
  };
  f.reads = () => f.calls.filter((c) => c.args[0] === "exec" && verbOf(c.args) === "rev").length; // one poll pass = one rev
  return f;
}
let hc, store, logs, clock, rem;
const BIND = [{ machine: "box1", projectId: RID, id: "B-1" }];
const KEY = `drover.remote.box1.${RID}`;
beforeEach(() => {
  hc = fakeHc(); store = {}; logs = []; clock = 1_000_000;
  rem = X.createExecReader({ run: hc.run, getShared: (k) => store[k], setShared: (k, v) => { if (v === null) delete store[k]; else store[k] = v; }, now: () => clock, log: (l) => logs.push(l) });
});
const bindRemote = (project, args, ctx) => R.bindRemote({ run: hc.run, probeExec: (m, p) => X.probeExec(hc.run, m, p) }, project, args, ctx);

test("2a read: the cache is { at, tasks, picks, ops, skew, rev, gen } at drover.remote.<machine>.<projectId> and nothing else; only the bound project's live cards", async () => {
  rem.sync(BIND);
  await rem.read("box1", RID);
  assert.deepEqual(Object.keys(store), [KEY]);
  assert.deepEqual(Object.keys(store[KEY]).sort(), ["at", "gen", "ops", "picks", "rev", "skew", "tasks"]);
  assert.deepEqual(store[KEY].tasks.map((t) => t.id), ["T-A"], "not archived, not another project's, not a card of no project");
  assert.deepEqual(hc.calls[0].args, X.headlessArgv("box1", ["version", "--json"]));
  assert.equal(hc.calls[0].opts.timeout, 10000);
  assert.ok(hc.calls.every((c) => c.args[0] !== "file"), "hc file is never run: shared.json is not read");
});

test("2b an unreadable answer, a hc exit and a throw each keep the previous cache and set stale", async () => {
  rem.sync(BIND);
  await rem.read("box1", RID);
  const before = JSON.stringify(store);
  assert.equal(rem.view("box1", RID).state, "fresh");
  for (const [label, set] of [
    ["bad json", () => { hc.raw = "{not json"; }],
    ["hc exit code", () => { hc.raw = null; hc.code = 1; }],
    ["hc throws", () => { hc.code = 0; hc.err = "timeout"; }],
  ]) {
    set();
    clock += 20000;
    const out = await rem.read("box1", RID);
    assert.ok(out.error, label);
    assert.equal(JSON.stringify(store), before, `${label}: cache untouched`);
    const v = rem.view("box1", RID);
    assert.equal(v.state, "stale", label);
    assert.deepEqual(v.tasks.map((t) => t.id), ["T-A"], `${label}: the saved cards stay`);
    assert.match(v.banner, /^box1 unreachable · last update \d\d:\d\d · showing a saved copy$/);
  }
  hc.err = null; hc.code = 0; hc.raw = null;
  clock += 20000;
  await rem.read("box1", RID);
  assert.equal(rem.view("box1", RID).state, "fresh");
  assert.equal(rem.view("box1", RID).banner, null, "a fresh cache has no banner");
});

test("2c a first load that fails is 'not answered yet', never an empty board", async () => {
  rem.sync(BIND);
  hc.code = 1;
  await rem.read("box1", RID);
  const v = rem.view("box1", RID);
  assert.equal(v.state, "never");
  assert.equal(v.banner, "box1 has not answered yet");
  assert.deepEqual(store, {}, "nothing is cached");
});

test("2d bind validation: charset, unknown machine, unknown remote project, local cards; every binding is exec; unbind restores the local cards", async () => {
  const proj = { id: "P-LOCAL", name: "mine", repos: [], folders: [], branch: "main" };
  const ctx = (tasks = []) => ({ tasks, projects: [proj] });
  for (const machine of ["", "a b", "x;rm", "a/b", "m".repeat(65), null]) {
    const r = await bindRemote(proj, { machine, projectId: RID }, ctx());
    assert.match(r.error, /Machine name/, String(machine));
  }
  assert.equal(hc.calls.length, 0, "a bad charset never reaches hc");
  assert.match((await bindRemote(proj, { machine: "box1", projectId: "bad id" }, ctx())).error, /Remote project id/);
  assert.match((await bindRemote(proj, { machine: "nope", projectId: RID }, ctx())).error, /Unknown machine nope/);
  assert.match((await bindRemote(proj, { machine: "box1", projectId: "P-MISSING" }, ctx())).error, /no project P-MISSING/);
  const local = [card("T-L1", "P-LOCAL"), card("T-L2", "P-LOCAL", { archived: true }), card("T-L3", "other")];
  const refused = await bindRemote(proj, { machine: "box1", projectId: RID }, ctx(local));
  assert.match(refused.error, /1 local card/, "counts the non-archived local cards only");
  const ok = await bindRemote(proj, { machine: "box1", projectId: RID }, ctx([]));
  assert.deepEqual([ok.project.remote.machine, ok.project.remote.projectId, ok.project.remote.transport], ["box1", RID, "exec"]);
  assert.match(ok.project.remote.id, /^B-/, "each binding has its own id");
  const bound = R.withRemote([proj, { id: "P-O", name: "o" }], "P-LOCAL", ok.project.remote);
  assert.equal(R.remoteOf(bound, "P-LOCAL").machine, "box1");
  assert.match((await bindRemote({ id: "P-2", name: "two" }, { machine: "box1", projectId: RID }, { tasks: [], projects: bound })).error, /already bound/);
  assert.ok(hc.calls.every((c) => c.args[0] !== "file"), "bind never reads shared.json");
  const noProbe = await R.bindRemote({ run: hc.run }, proj, { machine: "box1", projectId: RID }, ctx());
  assert.match(noProbe.error, /exec transport is not available/, "no probe, no binding: there is no other transport to fall back to");
  // unbind: the field and the cache go, the local cards show again (the local tasks were never touched).
  rem.sync(BIND); await rem.read("box1", RID);
  assert.ok(store[KEY]);
  rem.detach("box1", RID);
  const unbound = R.withRemote(bound, "P-LOCAL", null);
  assert.equal(R.remoteOf(unbound, "P-LOCAL"), null);
  assert.equal("remote" in unbound[0], false);
  assert.deepEqual(store, {});
  assert.equal(R.ownerError(unbound, "P-LOCAL"), null);
});

test("2e a secret in the remote's stderr or in a card it does not own never reaches the cache, a log line or a view", async () => {
  hc.board["drover.tasks"].push(card("T-E", RID2, { desc: SENTINEL }));
  rem.sync(BIND);
  hc.code = 1; await rem.read("box1", RID); // the error path: stderr carries the sentinel
  hc.code = 0; clock += 20000; await rem.read("box1", RID);
  const proj = { id: "P-LOCAL", name: "mine" };
  await bindRemote(proj, { machine: "box1", projectId: RID }, { tasks: [], projects: [] });
  assert.ok(logs.length >= 1);
  assert.ok(!JSON.stringify(store).includes(SENTINEL), "cache");
  assert.ok(!logs.join("\n").includes(SENTINEL), "logs");
  assert.ok(!JSON.stringify(rem.view("box1", RID)).includes(SENTINEL), "view");
  hc.code = 1; clock += 20000; await rem.read("box1", RID);
  assert.ok(!JSON.stringify(rem.view("box1", RID)).includes(SENTINEL), "error view");
  assert.ok(!logs.join("\n").includes(SENTINEL), "logs after the error");
});

test("2f two bindings on one machine keep separate caches", async () => {
  rem.sync([{ machine: "box1", projectId: RID, id: "B-1" }, { machine: "box1", projectId: RID2, id: "B-2" }]);
  await Promise.all([rem.read("box1", RID), rem.read("box1", RID2)]);
  assert.deepEqual(store[`drover.remote.box1.${RID}`].tasks.map((t) => t.id), ["T-A"]);
  assert.deepEqual(store[`drover.remote.box1.${RID2}`].tasks.map((t) => t.id), ["T-C"]);
});

test("2f a rebind or an unbind during an in-flight read drops that response and settles its waiter", async () => {
  let release;
  hc.hold = new Promise((r) => { release = r; });
  rem.sync(BIND);
  const p = rem.read("box1", RID);
  await until(() => hc.reads() === 1, "the read started");
  rem.sync([{ machine: "box1", projectId: RID, id: "B-2" }]); // rebind: the same pair, a new binding
  assert.deepEqual(await p, { error: "detached" });
  release();
  await until(() => hc.calls.length >= 3, "the old pass went on");
  assert.deepEqual(store, {}, "the old response is not applied");
  // unbind during a read
  hc.hold = new Promise((r) => { release = r; });
  const p2 = rem.read("box1", RID);
  await until(() => hc.reads() === 2, "second read started");
  rem.detach("box1", RID);
  release();
  assert.deepEqual(await p2, { error: "detached" }, "the waiter is settled at the unbind, not left hanging");
  assert.deepEqual(store, {});
});

test("scheduler: 15 s polls, backoff to 60 s after 5 failures, Retry reads at once, a success resets", async () => {
  rem.sync(BIND);
  await rem.tick(); assert.equal(hc.reads(), 1, "first tick reads");
  await rem.tick(); assert.equal(hc.reads(), 1, "not due yet");
  clock += 14999; await rem.tick(); assert.equal(hc.reads(), 1);
  clock += 1; await rem.tick(); assert.equal(hc.reads(), 2, "due at 15 s");
  hc.code = 1;
  for (let i = 1; i <= 4; i++) { clock += 15000; await rem.tick(); } // failures 1..4: still 15 s
  assert.equal(hc.reads(), 6);
  clock += 15000; await rem.tick(); // failure 5: now the cap
  assert.equal(hc.reads(), 7);
  clock += 59999; await rem.tick(); assert.equal(hc.reads(), 7, "backed off");
  clock += 1; await rem.tick(); assert.equal(hc.reads(), 8, "due at the 60 s cap");
  await rem.retry("box1", RID); assert.equal(hc.reads(), 9, "Retry reads immediately");
  hc.code = 0;
  await rem.retry("box1", RID);
  assert.equal(rem.view("box1", RID).state, "fresh", "fresh once that read completes");
  clock += 15000; await rem.tick(); assert.equal(hc.reads(), 11, "back to 15 s after a success");
  assert.equal(R.readDelay(4), 15000); assert.equal(R.readDelay(5), 60000); assert.equal(R.readDelay(99), 60000);
});

test("scheduler: one read at a time per binding; Retry joins the running read", async () => {
  let release;
  hc.hold = new Promise((r) => { release = r; });
  rem.sync(BIND);
  const a = rem.read("box1", RID);
  const b = rem.retry("box1", RID);
  await rem.tick();
  await until(() => hc.reads() === 1, "started");
  release(); await Promise.all([a, b]);
  assert.equal(hc.reads(), 1);
});

test("2h a remote description loads no local image or file", () => {
  const imageLines = (d) => [...d.matchAll(/!\[[^\]]*\]\(<([^>]+)>\)/g)].map((m) => m[1]);
  const desc = "see ![a](</home/x/key>) and ![b](<img/x.png>)";
  const local = { id: "T-1", desc };
  const remote = { id: "T-2", desc, remote: { machine: "box1" } };
  assert.equal(R.imagePaths(local, imageLines, "/h").length, 2, "a local card is unchanged");
  assert.deepEqual(R.imagePaths(remote, imageLines, "/h"), []);
  assert.equal(R.canOpenFile(remote), false);
  assert.equal(R.canOpenFile(local), true);
  rem.sync(BIND);
  return rem.read("box1", RID).then(() => {
    assert.ok(rem.view("box1", RID).tasks.every((t) => R.imagePaths(t, imageLines, "/h").length === 0 && !R.canOpenFile(t)), "every card from the view is stamped remote");
  });
});

// ---- deadline, sync, merge ----
test("the 10 s read deadline: tick abandons a hung read, drops its late answer and counts one failure", async () => {
  let release;
  hc.hold = new Promise((r) => { release = r; });
  rem.sync(BIND);
  const first = rem.tick();
  await until(() => hc.reads() === 1, "read started");
  clock += 9999; await rem.tick();
  assert.equal(hc.reads(), 1, "still waiting at 9.999 s");
  clock += 2; await rem.tick();
  assert.equal(rem.view("box1", RID).state, "never", "abandoned, nothing cached");
  assert.match(rem.view("box1", RID).error, /timeout/);
  release();
  await first;
  assert.deepEqual(store, {}, "the late answer is dropped");
  hc.hold = null;
  clock += 14999; await rem.tick(); assert.equal(hc.reads(), 1, "a failure schedules the next read 15 s out");
  clock += 1; await rem.tick();
  assert.equal(hc.reads(), 2);
  await until(() => rem.view("box1", RID).state === "fresh", "fresh after the next read");
});

test("sync attaches new bindings once, keeps a tracked one (and its generation), detaches removed ones", async () => {
  rem.sync(BIND); await rem.tick(); await until(() => store[KEY], "cached");
  rem.sync(BIND); // same binding: not reset
  clock += 1; await rem.tick();
  assert.equal(hc.reads(), 1, "not re-read: still tracked with its schedule");
  rem.sync([]);
  assert.deepEqual(store, {}, "an unbound project loses its cache");
  await rem.tick(); assert.equal(hc.reads(), 1);
});

test("bindings() lists only projects with a valid remote, always exec; mergeRemote swaps in the remote cards under the local project id", async () => {
  const projects = [{ id: "P-L", name: "local" }, { id: "P-R", name: "pair", remote: { machine: "box1", projectId: RID } }, { id: "P-X", name: "bad", remote: { machine: "a b", projectId: RID } }];
  assert.deepEqual(R.bindings(projects).map(({ id: _i, ...b }) => b), [{ localId: "P-R", machine: "box1", projectId: RID, transport: "exec" }]);
  rem.sync(R.bindings(projects)); await rem.tick(); await until(() => store[KEY], "cached");
  const m = R.mergeRemote([card("T-LOCAL", "P-L")], projects, (mach, pid) => rem.view(mach, pid));
  assert.deepEqual(m.tasks.map((t) => t.id), ["T-LOCAL", "T-A"]);
  const r = m.tasks[1];
  assert.equal(r.project, "P-R", "mapped to the local project, so scope and filters work");
  assert.deepEqual(r.remote, { machine: "box1", projectId: RID });
  assert.deepEqual(m.remotes.map((x) => [x.localId, x.state, x.banner]), [["P-R", "fresh", null]]);
  const odd = R.normalizeRemoteCard({ id: "T-Z", title: 5, column: "weird", priority: "P9", tags: "x", notes: null, agent: "t7" }, "P-R", "box1");
  assert.deepEqual([odd.column, odd.priority, odd.tags, odd.notes, odd.title, odd.agentText], ["backlog", "P2", [], [], "5", "box1/t7"]);
  assert.equal(R.agentText({ agent: null }, "box1"), null);
});

test("remoteCardRows: a read-only view model of a remote card, text only", () => {
  const c = R.normalizeRemoteCard({ id: "T-9", title: "t", desc: "![x](</etc/passwd>) body", column: "doing", priority: "P1", tags: ["a"], agent: "t3", notes: [{ by: "bob", text: "n1", at: 5, kind: "log" }, { text: 7 }] }, "P-R", "box1");
  const v = R.remoteCardRows(c);
  assert.deepEqual([v.id, v.machine, v.column, v.priority, v.tags, v.agentText], ["T-9", "box1", "doing", "P1", ["a"], "box1/t3"]);
  assert.equal(v.desc, c.desc, "shown as plain text, never rendered");
  assert.deepEqual(v.notes.map((n) => [n.by, n.text, n.kind]), [["bob", "n1", "log"], ["you", "7", null]]);
  assert.equal(R.READONLY_TIP, "This project lives on another machine (read-only for now)");
});

// ---- the card keeps its fields; the cache carries the picker data (and nothing else of the remote's config) ----
test("the cache holds picks only; view() returns tasks with their fields, picks and tags from the remote tasks", async () => {
  hc.board = board({
    "drover.projects": [{ id: RID, name: "r1" }, { id: RID2, name: "r2", repos: [{ path: `/x/${SENTINEL}` }] }, { id: "P-REMOTEX", name: "owned", remote: { machine: "elsewhere", projectId: "P-9" } }],
    "drover.tasks": [card("T-A", RID, { tags: ["x", "y"], parent: "T-P", assignee: { kind: "agent", id: "wrangler" }, rev: 4 }), card("T-P", RID, { tags: ["y", "z"] }), card("T-C", RID2)],
  });
  rem.sync(BIND);
  await rem.read("box1", RID);
  assert.ok(!JSON.stringify(store[KEY]).includes(SENTINEL));
  const v = rem.view("box1", RID);
  assert.deepEqual(v.picks.tags, ["x", "y", "z"]);
  assert.equal(v.tasks.find((t) => t.id === "T-A").parent, "T-P");
  assert.deepEqual(v.picks.projects, [{ id: RID, name: "r1" }, { id: RID2, name: "r2" }], "a project owned by another machine is not a target");
  assert.deepEqual(v.picks.assignees, [], "drover-headless reports no agents: no assignee is offered for a remote project");
  hc.raw = "nope"; clock += 20000; await rem.read("box1", RID); // stale copy keeps its picks
  assert.deepEqual(rem.view("box1", RID).picks.projects.map((p) => p.id), [RID, RID2]);
  const empty = X.createExecReader({ run: hc.run, getShared: () => undefined, setShared() {} });
  assert.deepEqual(empty.view("box1", RID).picks, { assignees: [], projects: [], tags: [], loading: true });
});
test("normalizeRemoteCard keeps parent and a valid assignee, and the remote project id; the project stays the local binding", () => {
  const n = R.normalizeRemoteCard({ id: "T-A", title: "t", project: RID, parent: "T-P", assignee: { kind: "squad", id: "cattle-drive", extra: 1 } }, "P-LOCAL", "box1", RID);
  assert.equal(n.parent, "T-P"); assert.deepEqual(n.assignee, { kind: "squad", id: "cattle-drive" });
  assert.equal(n.project, "P-LOCAL"); assert.deepEqual(n.remote, { machine: "box1", projectId: RID });
  const bad = R.normalizeRemoteCard({ id: "T-B", parent: 5, assignee: { kind: "robot", id: "x" } }, "P-LOCAL", "box1", RID);
  assert.equal(bad.parent, null); assert.equal(bad.assignee, null);
});
test("mergeRemote passes the remote project id and the picks of each binding", () => {
  const view = () => ({ state: "fresh", tasks: [{ id: "T-A", title: "t" }], picks: { assignees: [], projects: [], tags: ["q"] }, banner: null });
  const m = R.mergeRemote([], [{ id: "P-LOCAL", name: "n", remote: { machine: "box1", projectId: RID } }], view);
  assert.deepEqual(m.tasks[0].remote, { machine: "box1", projectId: RID });
  assert.deepEqual(m.remotes[0].picks.tags, ["q"]);
});

// ---- a cache without picks is "loading", never "not a project" ----
test("E(c) view(): a cache without picks is loading; a re-read fills it; a later cache write without picks does not erase the picks this instance holds", async () => {
  store[KEY] = { at: 1, tasks: [card("T-A", RID)] };
  rem.sync(BIND);
  assert.equal(rem.view("box1", RID).picks.loading, true);
  await rem.read("box1", RID);
  const ok = rem.view("box1", RID).picks;
  assert.ok(!ok.loading); assert.ok(ok.projects.length);
  store[KEY] = { at: 2, tasks: store[KEY].tasks }; // a copy overwrites without picks
  const again = rem.view("box1", RID).picks;
  assert.ok(!again.loading, "this instance still has the lists it read"); assert.deepEqual(again.projects, ok.projects);
});

test("E3 an abandoned read settles the callers waiting on it (retry / join) with a timeout, never hangs them", async () => {
  rem.sync(BIND);
  let release; hc.hold = new Promise((r) => (release = r));
  const waiting = rem.retry("box1", RID);
  await until(() => hc.reads() === 1, "the read started");
  clock += 11000;
  await rem.tick();
  assert.deepEqual(await waiting, { error: "timeout" });
  release();
});

test("F3 a detach or rebind settles the callers waiting on an in-flight read ({error:'detached'})", async () => {
  rem.sync([{ machine: "box1", projectId: RID, id: "B-1" }]);
  hc.hold = new Promise(() => {});
  const waiting = rem.retry("box1", RID);
  await until(() => hc.reads() === 1, "the read started");
  rem.sync([]);
  assert.deepEqual(await waiting, { error: "detached" });
  rem.sync([{ machine: "box1", projectId: RID, id: "B-2" }]);
  const again = rem.retry("box1", RID);
  await until(() => hc.reads() === 2, "the second read started");
  rem.sync([{ machine: "box1", projectId: RID, id: "B-3" }]); // same pair, new binding
  assert.deepEqual(await again, { error: "detached" });
});

test("machineOf: Local, a remote address, or a project bound to a machine (T-MWICMO38T36)", () => {
  const projects = [{ id: "P-L", name: "l" }, { id: "P-R", name: "r", remote: { machine: "box1", projectId: "P-X" } }];
  assert.equal(R.machineOf(projects, "P-L", "t4"), "Local");
  assert.equal(R.machineOf(projects, null, undefined), "Local");
  assert.equal(R.machineOf(projects, "P-L", "box1/t4"), "box1");
  assert.equal(R.machineOf(projects, "P-R", "t4"), "box1");
  assert.equal(R.machineOf([], "P-R", "t4"), "Local");
  assert.equal(R.machineOf(projects, "P-L", "bad name/t4"), "Local");
});
