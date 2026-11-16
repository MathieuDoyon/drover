// Remote project, step 1: the laptop reads omarchy's board (T-MWHVWQNL2HA). Injected fake hc runner; no real hc or omarchy; no sleeps.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const R = await import("../_lib/remote.js");

const SENTINEL = "SENTINEL-sk-not-a-real-secret-0042";
const RID = "P-REMOTE1", RID2 = "P-REMOTE2";
const card = (id, project, extra = {}) => ({ id, title: `title ${id}`, desc: "", column: "todo", project, archived: false, notes: [], ...extra });
const board = (over = {}) => ({
  layout: { secret: SENTINEL },
  "drover.runs": [{ env: SENTINEL }],
  "drover.wakeups": [{ text: SENTINEL }],
  "drover.inbox-seen": ["x"],
  "drover.projects": [{ id: RID, name: "r1" }, { id: RID2, name: "r2" }],
  "drover.tasks": [card("T-A", RID), card("T-B", RID, { archived: true }), card("T-C", RID2), card("T-D", null)],
  ...over,
});

// A fake hc: machine ls answers `machines`; file read answers the current `file` (a string), a hold, or an error.
function fakeHc() {
  const f = { calls: [], machines: ["omarchy"], file: JSON.stringify(board()), err: null, hold: null, code: 0 };
  f.run = async (args, opts) => {
    f.calls.push({ args, opts });
    if (args[0] === "machine") return { code: 0, stdout: JSON.stringify({ machines: f.machines.map((name) => ({ name, state: "connected" })) }), stderr: "" };
    if (f.hold) await f.hold;
    if (f.err) throw new Error(f.err);
    if (f.code) return { code: f.code, stdout: "", stderr: `boom ${SENTINEL}\nsecond` };
    return { code: 0, stdout: f.file, stderr: "" };
  };
  f.reads = () => f.calls.filter((c) => c.args[0] === "file").length;
  return f;
}
let hc, store, logs, clock, rem;
beforeEach(() => {
  hc = fakeHc(); store = {}; logs = []; clock = 1_000_000;
  rem = R.createRemote({ run: hc.run, getShared: (k) => store[k], setShared: (k, v) => { if (v === null) delete store[k]; else store[k] = v; }, now: () => clock, log: (l) => logs.push(l) });
});

test("parseRemote keeps only drover.tasks and drover.projects, the bound project, not archived (2a)", () => {
  const r = R.parseRemote(JSON.stringify(board()), RID);
  assert.deepEqual(r.tasks.map((t) => t.id), ["T-A"]);
  assert.deepEqual(r.projectIds, [RID, RID2]);
  assert.deepEqual(Object.keys(r).sort(), ["picks", "projectIds", "tasks"]);
});

test("2a read: the cache is { at, tasks, picks } at drover.remote.<machine>.<projectId> and nothing else", async () => {
  rem.attach("omarchy", RID);
  await rem.read("omarchy", RID);
  const key = `drover.remote.omarchy.${RID}`;
  assert.deepEqual(Object.keys(store), [key]);
  assert.deepEqual(Object.keys(store[key]).sort(), ["at", "picks", "tasks"]); // picks: the picker data (T-MWIA1D6HO84)
  assert.deepEqual(store[key].tasks.map((t) => t.id), ["T-A"]);
  assert.deepEqual(hc.calls[0].args, ["file", "read", "--on", "omarchy", ".config/herdr-app/shared.json"]);
  assert.equal(hc.calls[0].opts.timeout, 10000);
});

test("2b invalid JSON, a file over 2 MiB and a hc error each keep the previous cache and set stale", async () => {
  rem.attach("omarchy", RID);
  await rem.read("omarchy", RID);
  const before = JSON.stringify(store);
  assert.equal(rem.view("omarchy", RID).state, "fresh");
  for (const [label, set] of [
    ["bad json", () => { hc.file = "{not json"; }],
    ["over 2 MiB", () => { hc.file = JSON.stringify(board({ pad: "x".repeat(R.MAX_BYTES) })); }],
    ["hc exit code", () => { hc.file = "x"; hc.code = 1; }],
    ["hc throws", () => { hc.code = 0; hc.err = "timeout"; }],
  ]) {
    set();
    clock += 20000;
    const out = await rem.read("omarchy", RID);
    assert.ok(out.error, label);
    assert.equal(JSON.stringify(store), before, `${label}: cache untouched`);
    const v = rem.view("omarchy", RID);
    assert.equal(v.state, "stale", label);
    assert.deepEqual(v.tasks.map((t) => t.id), ["T-A"], `${label}: the saved cards stay`);
    assert.match(v.banner, /^omarchy unreachable · last update \d\d:\d\d · showing a saved copy$/);
  }
  hc.err = null; hc.code = 0; hc.file = JSON.stringify(board());
  await rem.read("omarchy", RID);
  assert.equal(rem.view("omarchy", RID).state, "fresh");
  assert.equal(rem.view("omarchy", RID).banner, null, "a fresh cache has no banner");
});

test("2c a first load that fails is 'not answered yet', never an empty board", async () => {
  rem.attach("omarchy", RID);
  hc.code = 1;
  await rem.read("omarchy", RID);
  const v = rem.view("omarchy", RID);
  assert.equal(v.state, "never");
  assert.equal(v.banner, "omarchy has not answered yet");
  assert.deepEqual(store, {}, "nothing is cached");
});

test("2d bind validation: charset, unknown machine, unknown remote project, local cards; unbind restores the local cards", async () => {
  const proj = { id: "P-LOCAL", name: "mine", repos: [], folders: [], branch: "main" };
  const ctx = (tasks = []) => ({ tasks, projects: [proj] });
  for (const machine of ["", "a b", "x;rm", "a/b", "m".repeat(65), null]) {
    const r = await rem.bind(proj, { machine, projectId: RID }, ctx());
    assert.match(r.error, /Machine name/, String(machine));
  }
  assert.equal(hc.calls.length, 0, "a bad charset never reaches hc");
  assert.match((await rem.bind(proj, { machine: "omarchy", projectId: "bad id" }, ctx())).error, /Remote project id/);
  assert.match((await rem.bind(proj, { machine: "nope", projectId: RID }, ctx())).error, /Unknown machine nope/);
  assert.match((await rem.bind(proj, { machine: "omarchy", projectId: "P-MISSING" }, ctx())).error, /no project P-MISSING/);
  const local = [card("T-L1", "P-LOCAL"), card("T-L2", "P-LOCAL", { archived: true }), card("T-L3", "other")];
  const refused = await rem.bind(proj, { machine: "omarchy", projectId: RID }, ctx(local));
  assert.match(refused.error, /1 local card/, "counts the non-archived local cards only");
  const ok = await rem.bind(proj, { machine: "omarchy", projectId: RID }, ctx([]));
  assert.deepEqual([ok.project.remote.machine, ok.project.remote.projectId], ["omarchy", RID]);
  assert.match(ok.project.remote.id, /^B-/, "each binding has its own id");
  const bound = R.withRemote([proj, { id: "P-O", name: "o" }], "P-LOCAL", ok.project.remote);
  assert.equal(R.remoteOf(bound, "P-LOCAL").machine, "omarchy");
  assert.match((await rem.bind({ id: "P-2", name: "two" }, { machine: "omarchy", projectId: RID }, { tasks: [], projects: bound })).error, /already bound/);
  // unbind: the field and the cache go, the local cards show again (the local tasks were never touched).
  rem.attach("omarchy", RID); await rem.read("omarchy", RID);
  assert.ok(store[`drover.remote.omarchy.${RID}`]);
  rem.detach("omarchy", RID);
  const unbound = R.withRemote(bound, "P-LOCAL", null);
  assert.equal(R.remoteOf(unbound, "P-LOCAL"), null);
  assert.equal("remote" in unbound[0], false);
  assert.deepEqual(store, {});
  assert.equal(R.ownerError(unbound, "P-LOCAL"), null);
});

test("2e a secret planted under other keys never reaches the cache or a log line", async () => {
  rem.attach("omarchy", RID);
  hc.code = 1; await rem.read("omarchy", RID); // the error path: stderr carries the sentinel
  hc.code = 0; clock += 20000; await rem.read("omarchy", RID);
  const proj = { id: "P-LOCAL", name: "mine" };
  await rem.bind(proj, { machine: "omarchy", projectId: RID }, { tasks: [], projects: [] });
  assert.ok(logs.length >= 2);
  assert.ok(!JSON.stringify(store).includes(SENTINEL), "cache");
  assert.ok(!logs.join("\n").includes(SENTINEL), "logs");
  assert.ok(!JSON.stringify(rem.view("omarchy", RID)).includes(SENTINEL), "view");
  hc.code = 1; await rem.read("omarchy", RID);
  assert.ok(!JSON.stringify(rem.view("omarchy", RID)).includes(SENTINEL), "error view");
  assert.ok(!logs.join("\n").includes(SENTINEL), "logs after the error");
});

test("2f two bindings on one machine keep separate caches", async () => {
  rem.attach("omarchy", RID); rem.attach("omarchy", RID2);
  await Promise.all([rem.read("omarchy", RID), rem.read("omarchy", RID2)]);
  assert.deepEqual(store[`drover.remote.omarchy.${RID}`].tasks.map((t) => t.id), ["T-A"]);
  assert.deepEqual(store[`drover.remote.omarchy.${RID2}`].tasks.map((t) => t.id), ["T-C"]);
});

test("2f a rebind or an unbind during an in-flight read drops that response", async () => {
  let release;
  hc.hold = new Promise((r) => { release = r; });
  rem.attach("omarchy", RID);
  const p = rem.read("omarchy", RID);
  await until(() => hc.reads() === 1, "the read started");
  rem.attach("omarchy", RID); // rebind: a new generation
  release();
  assert.deepEqual(await p, { dropped: true });
  assert.deepEqual(store, {}, "the old response is not applied");
  // unbind during a read
  hc.hold = new Promise((r) => { release = r; });
  const p2 = rem.read("omarchy", RID);
  await until(() => hc.reads() === 2, "second read started");
  rem.detach("omarchy", RID);
  release();
  assert.deepEqual(await p2, { error: "detached" }, "the waiter is settled at the unbind, not left hanging");
  assert.deepEqual(store, {});
});

test("scheduler: 15 s polls, backoff to 60 s after 5 failures, Retry reads at once, a success resets", async () => {
  rem.attach("omarchy", RID);
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
  await rem.retry("omarchy", RID); assert.equal(hc.reads(), 9, "Retry reads immediately");
  hc.code = 0;
  await rem.retry("omarchy", RID);
  assert.equal(rem.view("omarchy", RID).state, "fresh", "fresh once that read completes");
  clock += 15000; await rem.tick(); assert.equal(hc.reads(), 11, "back to 15 s after a success");
  assert.equal(R.readDelay(4), 15000); assert.equal(R.readDelay(5), 60000); assert.equal(R.readDelay(99), 60000);
});

test("scheduler: one read at a time per binding; Retry joins the running read", async () => {
  let release;
  hc.hold = new Promise((r) => { release = r; });
  rem.attach("omarchy", RID);
  const a = rem.read("omarchy", RID);
  const b = rem.retry("omarchy", RID);
  await rem.tick();
  await until(() => hc.reads() === 1, "started");
  release(); await Promise.all([a, b]);
  assert.equal(hc.reads(), 1);
});

test("2h a remote description loads no local image or file", () => {
  const imageLines = (d) => [...d.matchAll(/!\[[^\]]*\]\(<([^>]+)>\)/g)].map((m) => m[1]);
  const desc = "see ![a](</home/x/key>) and ![b](<img/x.png>)";
  const local = { id: "T-1", desc };
  const remote = { id: "T-2", desc, remote: { machine: "omarchy" } };
  assert.equal(R.imagePaths(local, imageLines, "/h").length, 2, "a local card is unchanged");
  assert.deepEqual(R.imagePaths(remote, imageLines, "/h"), []);
  assert.equal(R.canOpenFile(remote), false);
  assert.equal(R.canOpenFile(local), true);
  rem.attach("omarchy", RID);
  return rem.read("omarchy", RID).then(() => {
    assert.ok(rem.view("omarchy", RID).tasks.every((t) => R.imagePaths(t, imageLines, "/h").length === 0 && !R.canOpenFile(t)), "every card from the view is stamped remote");
  });
});

// ---- job 2: deadline, sync, merge ----
test("the 10 s read deadline: tick abandons a hung read, drops its late answer and counts one failure", async () => {
  let release;
  hc.hold = new Promise((r) => { release = r; });
  rem.attach("omarchy", RID);
  const first = rem.tick();
  await until(() => hc.reads() === 1, "read started");
  clock += 9999; await rem.tick();
  assert.equal(hc.reads(), 1, "still waiting at 9.999 s");
  clock += 2; await rem.tick();
  assert.equal(rem.view("omarchy", RID).state, "never", "abandoned, nothing cached");
  assert.match(rem.view("omarchy", RID).error, /timeout/);
  release();
  await first;
  assert.deepEqual(store, {}, "the late answer is dropped");
  hc.hold = null;
  clock += 14999; await rem.tick(); assert.equal(hc.reads(), 1, "a failure schedules the next read 15 s out");
  clock += 1; await rem.tick();
  assert.equal(hc.reads(), 2);
  await until(() => rem.view("omarchy", RID).state === "fresh", "fresh after the next read");
});

test("sync attaches new bindings once, keeps a tracked one (and its generation), detaches removed ones", async () => {
  const b = [{ machine: "omarchy", projectId: RID }];
  rem.sync(b); await rem.tick(); await until(() => store[`drover.remote.omarchy.${RID}`], "cached");
  rem.sync(b); // same binding: not reset
  clock += 1; await rem.tick();
  assert.equal(hc.reads(), 1, "not re-read: still tracked with its schedule");
  rem.sync([]);
  assert.deepEqual(store, {}, "an unbound project loses its cache");
  await rem.tick(); assert.equal(hc.reads(), 1);
});

test("bindings() lists only projects with a valid remote; mergeRemote swaps in the remote cards under the local project id", async () => {
  const projects = [{ id: "P-L", name: "local" }, { id: "P-R", name: "pair", remote: { machine: "omarchy", projectId: RID } }, { id: "P-X", name: "bad", remote: { machine: "a b", projectId: RID } }];
  assert.deepEqual(R.bindings(projects).map(({ id: _i, ...b }) => b), [{ localId: "P-R", machine: "omarchy", projectId: RID }]);
  rem.sync(R.bindings(projects)); await rem.tick(); await until(() => store[`drover.remote.omarchy.${RID}`], "cached");
  const m = R.mergeRemote([card("T-LOCAL", "P-L")], projects, (mach, pid) => rem.view(mach, pid));
  assert.deepEqual(m.tasks.map((t) => t.id), ["T-LOCAL", "T-A"]);
  const r = m.tasks[1];
  assert.equal(r.project, "P-R", "mapped to the local project, so scope and filters work");
  assert.deepEqual(r.remote, { machine: "omarchy", projectId: RID });
  assert.deepEqual(m.remotes.map((x) => [x.localId, x.state, x.banner]), [["P-R", "fresh", null]]);
  const odd = R.normalizeRemoteCard({ id: "T-Z", title: 5, column: "weird", priority: "P9", tags: "x", notes: null, agent: "t7" }, "P-R", "omarchy");
  assert.deepEqual([odd.column, odd.priority, odd.tags, odd.notes, odd.title, odd.agentText], ["backlog", "P2", [], [], "5", "omarchy/t7"]);
  assert.equal(R.agentText({ agent: null }, "omarchy"), null);
});

test("remoteCardRows: a read-only view model of a remote card, text only", () => {
  const c = R.normalizeRemoteCard({ id: "T-9", title: "t", desc: "![x](</etc/passwd>) body", column: "doing", priority: "P1", tags: ["a"], agent: "t3", notes: [{ by: "bob", text: "n1", at: 5, kind: "log" }, { text: 7 }] }, "P-R", "omarchy");
  const v = R.remoteCardRows(c);
  assert.deepEqual([v.id, v.machine, v.column, v.priority, v.tags, v.agentText], ["T-9", "omarchy", "doing", "P1", ["a"], "omarchy/t3"]);
  assert.equal(v.desc, c.desc, "shown as plain text, never rendered");
  assert.deepEqual(v.notes.map((n) => [n.by, n.text, n.kind]), [["bob", "n1", "log"], ["you", "7", null]]);
  assert.equal(R.READONLY_TIP, "This project lives on omarchy (read-only for now)");
});

test("review H1: the size check needs no global Buffer and counts UTF-8 bytes", () => {
  const saved = globalThis.Buffer;
  try {
    delete globalThis.Buffer;
    const doc = (pad) => JSON.stringify({ "drover.tasks": [], "drover.projects": [], pad });
    assert.ok(R.parseRemote(doc(""), RID).tasks, "a valid empty board parses without Buffer");
    const under = doc("a".repeat(R.MAX_BYTES - 200));
    assert.ok(R.parseRemote(under, RID).tasks);
    // 3-byte characters: fewer chars than the limit, more bytes.
    assert.equal(R.parseRemote(doc("€".repeat(Math.ceil(R.MAX_BYTES / 3))), RID).error, "file over 2 MiB");
    assert.equal(R.parseRemote(doc("😀".repeat(Math.ceil(R.MAX_BYTES / 4))), RID).error, "file over 2 MiB", "4-byte pairs");
  } finally { globalThis.Buffer = saved; }
});

test("review H2: through io.js's real adapter, a hung hc read is abandoned at 10 s, its late answer dropped, Retry starts a new read", async () => {
  const host = globalThis.__host = { state: {}, notified: [], calls: [] };
  let release;
  const hung = new Promise((r) => { release = r; });
  host.hc = (...a) => { host.calls.push(a); return host.calls.length === 1 ? hung.then(() => ({ code: 0, stdout: JSON.stringify(board()), stderr: "" })) : Promise.resolve({ code: 0, stdout: JSON.stringify(board()), stderr: "" }); };
  const IOm = await import("../_lib/io.js");
  let t = 5_000_000;
  const r2 = R.createRemote({ run: IOm.remoteRun, getShared: (k) => host.state[k], setShared: (k, v) => { if (v === null) delete host.state[k]; else host.state[k] = v; }, now: () => t });
  r2.attach("omarchy", RID);
  const first = r2.tick();
  await until(() => host.calls.length === 1, "the adapter was called");
  assert.deepEqual(host.calls[0], [["file", "read", "--on", "omarchy", ".config/herdr-app/shared.json"]], "only argv reaches hc");
  t += 10001; await r2.tick();
  assert.match(r2.view("omarchy", RID).error, /timeout/);
  release(); await first;
  assert.deepEqual(host.state, {}, "the late answer is dropped");
  await r2.retry("omarchy", RID);
  assert.equal(r2.view("omarchy", RID).state, "fresh");
  assert.equal(host.calls.length, 2);
});

// ---- T-MWIA1D6HO84: the card keeps its fields, the cache carries the picker data (and nothing else of omarchy's config) ----
const cfgBoard = () => board({
  "drover.agents": {
    agents: [{ id: "wrangler", name: "Wrangler", command: `claude --token ${SENTINEL}`, instructions: SENTINEL, env: { K: SENTINEL }, version: 1 }, { id: "bad id!", name: "x" }],
    squads: [{ id: "cattle-drive", name: "Cattle Drive", leader: "wrangler", members: [{ agent: "wrangler", role: SENTINEL }], version: 1 }],
  },
  "drover.projects": [{ id: RID, name: "r1" }, { id: RID2, name: "r2", repos: [{ path: `/x/${SENTINEL}` }] }, { id: "P-REMOTEX", name: "owned", remote: { machine: "elsewhere", projectId: "P-9" } }],
  "drover.tasks": [card("T-A", RID, { tags: ["x", "y"], parent: "T-P", assignee: { kind: "agent", id: "wrangler" }, rev: 4 }), card("T-P", RID, { tags: ["y", "z"] }), card("T-C", RID2)],
});
test("parseRemote picks: assignee catalogue {kind,id,name}, omarchy projects {id,name}; never commands, env, souls, paths", () => {
  const r = R.parseRemote(JSON.stringify(cfgBoard()), RID);
  assert.deepEqual(r.picks.assignees, [{ kind: "agent", id: "wrangler", name: "Wrangler" }, { kind: "squad", id: "cattle-drive", name: "Cattle Drive" }]);
  assert.deepEqual(r.picks.projects, [{ id: RID, name: "r1" }, { id: RID2, name: "r2" }], "a project owned by another machine is not a target");
  assert.ok(!JSON.stringify(r.picks).includes(SENTINEL));
});
test("parseRemote picks: no drover.agents on omarchy -> its default herd (the consumer's own default)", () => {
  const r = R.parseRemote(JSON.stringify(board()), RID);
  assert.ok(r.picks.assignees.some((a) => a.kind === "agent" && a.id === "wrangler"));
  assert.ok(r.picks.assignees.some((a) => a.kind === "squad" && a.id === "cattle-drive"));
  assert.ok(!JSON.stringify(r.picks).includes("command"));
});
test("the cache holds picks only; view() returns tasks with their fields, picks and tags from the remote tasks", async () => {
  hc.file = JSON.stringify(cfgBoard());
  rem.attach("omarchy", RID);
  await rem.read("omarchy", RID);
  const key = `drover.remote.omarchy.${RID}`;
  assert.ok(!JSON.stringify(store[key]).includes(SENTINEL));
  const v = rem.view("omarchy", RID);
  assert.deepEqual(v.picks.tags, ["x", "y", "z"]);
  assert.equal(v.tasks.find((t) => t.id === "T-A").parent, "T-P");
  assert.deepEqual(v.picks.assignees.map((a) => a.id), ["wrangler", "cattle-drive"]);
  hc.file = "nope"; await rem.read("omarchy", RID); // stale copy keeps its picks
  assert.deepEqual(rem.view("omarchy", RID).picks.projects.map((p) => p.id), [RID, RID2]);
  assert.deepEqual(R.createRemote({ run: hc.run, getShared: () => undefined, setShared() {} }).view("omarchy", RID).picks, { assignees: [], projects: [], tags: [], loading: true });
});
test("normalizeRemoteCard keeps parent and a valid assignee, and the remote project id; the project stays the local binding", () => {
  const n = R.normalizeRemoteCard({ id: "T-A", title: "t", project: RID, parent: "T-P", assignee: { kind: "squad", id: "cattle-drive", extra: 1 } }, "P-LOCAL", "omarchy", RID);
  assert.equal(n.parent, "T-P"); assert.deepEqual(n.assignee, { kind: "squad", id: "cattle-drive" });
  assert.equal(n.project, "P-LOCAL"); assert.deepEqual(n.remote, { machine: "omarchy", projectId: RID });
  const bad = R.normalizeRemoteCard({ id: "T-B", parent: 5, assignee: { kind: "robot", id: "x" } }, "P-LOCAL", "omarchy", RID);
  assert.equal(bad.parent, null); assert.equal(bad.assignee, null);
});
test("mergeRemote passes the remote project id and the picks of each binding", () => {
  const view = () => ({ state: "fresh", tasks: [{ id: "T-A", title: "t" }], picks: { assignees: [], projects: [], tags: ["q"] }, banner: null });
  const m = R.mergeRemote([], [{ id: "P-LOCAL", name: "n", remote: { machine: "omarchy", projectId: RID } }], view);
  assert.deepEqual(m.tasks[0].remote, { machine: "omarchy", projectId: RID });
  assert.deepEqual(m.remotes[0].picks.tags, ["q"]);
});

// ---- Job E: a cache without picks (an older mod copy wrote it) is "loading", never "not a project" ----
test("E(c) view(): a cache without picks is loading; a re-read fills it; a later cache write without picks does not erase the picks this instance holds", async () => {
  const key = `drover.remote.omarchy.${RID}`;
  store[key] = { at: 1, tasks: [card("T-A", RID)] };
  rem.attach("omarchy", RID);
  assert.equal(rem.view("omarchy", RID).picks.loading, true);
  hc.file = JSON.stringify(cfgBoard());
  await rem.read("omarchy", RID);
  const ok = rem.view("omarchy", RID).picks;
  assert.ok(!ok.loading); assert.ok(ok.assignees.length && ok.projects.length);
  store[key] = { at: 2, tasks: store[key].tasks }; // an older copy overwrites without picks
  const again = rem.view("omarchy", RID).picks;
  assert.ok(!again.loading, "this instance still has the lists it read"); assert.deepEqual(again.projects, ok.projects);
});
test("E(c) tick() re-reads at once when the cache lost its picks, without waiting for the poll", async () => {
  rem.attach("omarchy", RID);
  await rem.read("omarchy", RID);
  const n = hc.reads();
  const key = `drover.remote.omarchy.${RID}`;
  store[key] = { at: 5, tasks: store[key].tasks };
  rem.attach; clock += 1000; // well inside the 15 s poll
  await rem.tick();
  assert.equal(hc.reads(), n + 1);
});

test("E3 an abandoned read settles the callers waiting on it (retry / join) with a timeout, never hangs them", async () => {
  rem.attach("omarchy", RID);
  let release; hc.hold = new Promise((r) => (release = r));
  const waiting = rem.retry("omarchy", RID);
  clock += 11000;
  await rem.tick();
  const got = await Promise.race([waiting, new Promise((r) => setTimeout(() => r("HUNG"), 50))]);
  assert.deepEqual(got, { error: "timeout" });
  release();
});

test("F3 a detach or rebind settles the callers waiting on an in-flight read ({error:'detached'})", async () => {
  rem.attach("omarchy", RID, "B-1");
  hc.hold = new Promise(() => {});
  const waiting = rem.retry("omarchy", RID);
  rem.sync([]);
  assert.deepEqual(await Promise.race([waiting, new Promise((r) => setTimeout(() => r("HUNG"), 50))]), { error: "detached" });
  rem.attach("omarchy", RID, "B-2");
  const again = rem.retry("omarchy", RID);
  rem.sync([{ machine: "omarchy", projectId: RID, id: "B-3" }]); // same pair, new binding
  assert.deepEqual(await Promise.race([again, new Promise((r) => setTimeout(() => r("HUNG"), 50))]), { error: "detached" });
});
