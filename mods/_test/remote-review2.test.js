// Inspector review 2 of T-MWHVWQNL2HA: the Tasks sidebar, Squads "Opens in", cross-reader unbind, bind race, screen gate.
// Read through the exec reader against a fake drover-headless since the shared.json reader retired (T-MWO2V65MUSX).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const R = await import("../_lib/remote.js");
const X = await import("../_lib/remote-exec.js");
const IO = await import("../_lib/io.js");
const CFG = await import("../_lib/config.js");
const { default: Tasks } = await import("../drover-tasks/main.js");
const { ProjectEditor } = await import("../drover-projects/main.js");
CFG.setSettings("drover-tasks", {});

const RID = "P-REMOTE1";
const card = (id, project, extra = {}) => ({ id, title: `title ${id}`, desc: "", column: "todo", priority: "P2", tags: [], project, archived: false, notes: [], ...extra });
// What the machine answers to hc: `machine ls`, and drover-headless version|rev|tasks|projects.
const answer = (args) => {
  if (args[0] === "machine") return { code: 0, stdout: JSON.stringify({ machines: [{ name: "box1" }] }), stderr: "" };
  const v = args.slice(args.indexOf(X.HEADLESS) + 1)[0];
  const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
  if (v === "version") return ok({ cli: "drover-headless", schema: 1, ops: ["add", "archive", "edit", "move", "note"] });
  if (v === "rev") return ok({ gen: 1, tasks: "h1" });
  if (v === "tasks") return ok({ gen: 1, rev: "h1", tasks: [card("T-REMOTE", RID)] });
  if (v === "projects") return ok({ gen: 1, projects: [{ id: RID, name: "r" }] });
  return { code: 2, stdout: "", stderr: "" };
};
const startsOf = (calls) => calls.filter((a) => a[0] === "exec" && a.includes("version")).length; // a poll pass of a fresh reader starts with version
const REMOTE_PROJECT = { id: "P-ONREM", name: "pairstone", repos: [{ path: "/remote/repo", default: true }], folders: [], branch: "main", remote: { machine: "box1", projectId: RID } };
let host, timers, hcCalls;
const mkCx = () => { const cx = { notify() {}, stop_propagation() {}, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}), focus_handle: () => ({ focus() {} }), timer: { after() {}, every: (_ms, fn) => timers.push(() => fn(cx)) } }; return cx; };
beforeEach(() => {
  timers = []; hcCalls = [];
  host = globalThis.__host = { appHome: "/app", home: "/h", props: {}, notified: [], terminals: [], agents: [], spaces: [], panes: [], focused: { space: "s1" }, overlays: [], runs: [],
    state: { "drover.tasks": [], "drover.projects": [REMOTE_PROJECT] },
    hc: async (args) => { hcCalls.push(args); return answer(args); },
    openOverlay: (o) => { host.overlays.push(o); return "ov1"; }, run: (...a) => host.runs.push(a),
    exec: async () => { hcCalls.push(["EXEC"]); return { code: 1, stdout: "", stderr: "" }; } };
});
const render = (v, cx) => { globalThis.__rec = { ids: [], texts: [] }; v.render(cx); const r = globalThis.__rec; globalThis.__rec = null; return r; };
const cacheKey = `drover.remote.box1.${RID}`;

test("F1 the actual Tasks sidebar: never-loaded banner, then remote rows with the machine, stale banner + Retry, fresh without a banner", async () => {
  const cx = mkCx(); const v = new Tasks(); v.init({}, { ...cx, spawn() {} }); // init starts the local inbox and wakeup loops: not under test
  let r = render(v, cx);
  assert.ok(r.ids.includes("banner-P-ONREM") && r.ids.includes("retry-P-ONREM"), "never loaded: banner + Retry");
  assert.ok(r.texts.some((x) => x.includes("box1 has not answered yet")));
  assert.ok(!r.ids.some((i) => i.startsWith("task-")), "no empty-board lie, no rows");
  assert.ok(timers.length >= 1, "the sidebar polls");
  for (const t of timers) t();
  await until(() => host.state[cacheKey], "the first read landed");
  await until(() => { for (const t of timers) t(); return !render(v, cx).ids.includes("banner-P-ONREM"); }, "fresh: no banner"); // the panel repaints from the cache, which the 1 s timer refreshes
  r = render(v, cx);
  assert.ok(r.ids.includes("task-box1/P-REMOTE1/T-REMOTE"), "the remote Ready card is a row");
  assert.ok(r.ids.includes("ro-start-box1/P-REMOTE1/T-REMOTE") && !r.ids.includes("start-box1/P-REMOTE1/T-REMOTE"), "start is a disabled control");
  host.hc = async () => ({ code: 1, stdout: "", stderr: "" });
  await IO.remote.retry("box1", RID);
  for (const t of timers) t(); // the next 1 s refresh of the cache
  r = render(v, cx);
  assert.ok(r.ids.includes("banner-P-ONREM") && r.ids.includes("task-box1/P-REMOTE1/T-REMOTE"), "stale: banner and the saved rows");
  assert.ok(r.texts.some((x) => /box1 unreachable · last update \d\d:\d\d · showing a saved copy/.test(x)));
  v.open({ ...R.normalizeRemoteCard(card("T-REMOTE", RID, { agent: "t7" }), "P-ONREM", "box1") });
  assert.equal(host.runs.length, 0, "no agent focus for a remote card");
  assert.ok(host.overlays.at(-1).props.remoteCard, "opens the read-only view");
});

test("F2 Squads 'Opens in' a remote project: refused for a plain agent and a squad, nothing launched or opened", async () => {
  for (const [kind, id] of [["agent", "claude"], ["squad", "x"], ["agent", "drover"]]) {
    const r = await IO.startFromSquads(kind, id, "P-ONREM");
    assert.match(r.error, /box1/, `${kind}/${id}`);
  }
  assert.equal(hcCalls.length, 0, "no exec, no hc");
  assert.ok(host.notified.length >= 3);
});

test("F3 unbind reaches a read already running in another reader instance, and a rebind of the same pair is a new binding", async () => {
  const store = {};
  const getShared = (k) => store[k], setShared = (k, v) => { if (v === null) delete store[k]; else store[k] = v; };
  let projects = [{ id: "P-L", name: "l", remote: { machine: "box1", projectId: RID, id: "B1" } }];
  const bound = (m, p, id) => R.bindings(projects).some((b) => b.machine === m && b.projectId === p && b.id === id);
  let release; const hold = new Promise((r) => { release = r; });
  const run = async (args) => { await hold; return answer(args); };
  const A = X.createExecReader({ run, getShared, setShared, bound }), B = X.createExecReader({ run, getShared, setShared, bound });
  A.sync(R.bindings(projects)); B.sync(R.bindings(projects));
  const pending = A.tick();
  // B (the Projects mod) unbinds: removes the field and detaches ITS entries.
  projects = [{ id: "P-L", name: "l" }]; B.detach("box1", RID);
  release(); await pending;
  assert.deepEqual(store, {}, "A's late answer does not recreate the cache");
  // rebind of the same pair with a new binding id before A's next timer tick
  projects = [{ id: "P-L", name: "l", remote: { machine: "box1", projectId: RID, id: "B2" } }];
  A.sync(R.bindings(projects));
  assert.equal(A.view("box1", RID).state, "never", "a new binding id starts a fresh entry");
});

test("F4 an in-flight Rebind cannot undo a later Unbind", async () => {
  let release; const hold = new Promise((r) => { release = r; });
  host.hc = async (args) => { if (args[0] === "machine") return answer(args); await hold; return answer(args); };
  const cx = mkCx();
  host.props = { overlay: "ov", projectEdit: "P-ONREM" };
  const ed = new ProjectEditor(cx);
  const bindP = ed.bindRemote(cx);
  await until(() => ed.binding, "bind in flight");
  ed.unbindRemote(cx);
  assert.equal(R.remoteOf(host.state["drover.projects"], "P-ONREM"), null, "unbound");
  release(); await bindP;
  assert.equal(R.remoteOf(host.state["drover.projects"], "P-ONREM"), null, "the late bind did not write the binding back");
  assert.ok(ed.remoteMsg && !/Bound to/.test(ed.remoteMsg));
});

test("F5 a disabled screen's remote timer reads nothing and drops its pending read", async () => {
  IO.remote.sync([]); // the module-level reader is shared by the tests of this file
  let on = true;
  const cx = mkCx();
  let release; const hold = new Promise((r) => { release = r; });
  host.hc = async (args) => { hcCalls.push(args); await hold; return answer(args); };
  IO.watchRemote(cx, () => on);
  await until(() => startsOf(hcCalls) === 1, "a read starts while the screen is on");
  on = false;
  for (const t of timers) t(); // the screen was switched off
  release();
  await drain();
  assert.equal(host.state[cacheKey], undefined, "the late answer is not committed");
  hcCalls.length = 0;
  for (const t of timers) t();
  await drain();
  assert.equal(startsOf(hcCalls), 0, "no read while the screen is off");
  on = true;
  for (const t of timers) t();
  await until(() => startsOf(hcCalls) === 1, "reads resume when the screen is on again");
});

// A binding exactly as the Projects dialog saves it: produced by remote.bind (it carries an id).
async function uiBinding() {
  const run = async (args) => answer(args);
  const { project, error } = await R.bindRemote({ run, probeExec: (m, p) => X.probeExec(run, m, p) },{ id: "P-ONREM", name: "pairstone", repos: [], folders: [], branch: "main" }, { machine: "box1", projectId: RID }, { tasks: [], projects: [] });
  assert.ok(!error, error);
  assert.match(project.remote.id, /^B-/);
  assert.equal(project.remote.transport, "exec");
  return project;
}

test("R3-High a binding made by the UI (with its id) is read, shown and Retry-able through the real IO adapter", async () => {
  IO.remote.sync([]);
  host.state["drover.projects"] = [await uiBinding()];
  const cx = mkCx();
  IO.watchRemote(cx, () => true);
  await until(() => host.state[cacheKey], "the first read committed");
  assert.equal(IO.loadMerged().remotes[0].state, "fresh");
  assert.equal(IO.loadMerged().tasks.length, 1);
  delete host.state[cacheKey];
  IO.remote.sync([]); IO.remote.sync(R.bindings(host.state["drover.projects"]));
  await IO.remote.retry("box1", RID);
  assert.ok(host.state[cacheKey], "Retry commits too");
});

test("R3-Medium a read that returns after the screen was switched off, before the next timer tick, is not committed", async () => {
  IO.remote.sync([]);
  host.state["drover.projects"] = [await uiBinding()];
  let on = true;
  let release; const hold = new Promise((r) => { release = r; });
  host.hc = async (args) => { hcCalls.push(args); await hold; return answer(args); };
  const cx = mkCx();
  IO.watchRemote(cx, () => on);
  await until(() => startsOf(hcCalls) === 1, "a read is in flight");
  on = false; // switched off; the timer has NOT run again
  release();
  await IO.remote.read("box1", RID);
  assert.equal(host.state[cacheKey], undefined, "not committed while off");
  on = true;
  for (const t of timers) t();
  hcCalls.length = 0;
  host.hc = async (args) => answer(args);
  await until(() => host.state[cacheKey], "reads resume and commit once on");
});
