// Remote project step 2, the io.js wiring (T-MWHVWR8TIJB): the exec writer behind Board/Tasks. Stubbed host, a fake drover-headless behind hc exec; no real hc, no sleeps.
// The inbox probe, pending list, late outcomes and cleanup tests retired with the inbox (T-MWO2V65MUSX): exec has no probe, no queue and no late outcome;
// its gates, unknown + held retry, skew and the ops list are in remote-exec.test.js and remote-exec-wire.test.js.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const X = await import("../_lib/remote-exec.js");
const IO = await import("../_lib/io.js");
const S = await import("../_lib/store.js");

const RID = "P-REMOTE1", LID = "P-ONREM", M = "box1";
const SENTINEL = "SENTINEL-sk-not-a-real-secret-0042";
const OPS = ["add", "archive", "edit", "move", "note"];
const card = (id, project, extra = {}) => ({ id, title: `title ${id}`, desc: "", column: "todo", priority: "P2", tags: [], project, archived: false, notes: [], ...extra });
const REMOTE_PROJECT = (extra = {}) => ({ id: LID, name: "pairstone", repos: [], folders: [], branch: "main", remote: { machine: M, projectId: RID, id: "B-1", ...extra } });
const CKEY = `drover.remote.${M}.${RID}`;

let host, timers, hm, notifies;
const mkCx = () => { const cx = { notify: () => notifies.push(1), spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}), timer: { every: (_ms, fn) => timers.push(() => fn(cx)) } }; return cx; };
const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
// The machine: its headless board (with a planted secret in its agents config, which headless never reports) and what the laptop sent it.
beforeEach(() => {
  timers = []; notifies = [];
  hm = { gen: 1, reads: 0, sends: [], remoteArgv: [], tasks: [card("T-R1", RID, { rev: 4 }), card("T-R2", RID)] };
  host = globalThis.__host = { appHome: "/app", home: "/h", props: {}, notified: [], terminals: [], agents: [], spaces: [], panes: [], state: { "drover.tasks": [card("T-LOCAL1", "P-LOCAL")], "drover.projects": [{ id: "P-LOCAL", name: "mine", repos: [], folders: [], branch: "main" }, REMOTE_PROJECT()], "drover.agents": { env: SENTINEL } } };
  host.watchFolder = () => new Promise(() => {});
  host.hc = async (args) => {
    if (args[0] === "machine") return ok({ machines: [{ name: M }] });
    if (args[0] === "exec" && args.includes(X.HEADLESS)) {
      hm.remoteArgv.push(args);
      const v = args.slice(args.indexOf(X.HEADLESS) + 1)[0];
      if (v === "version") return ok({ cli: "drover-headless", schema: 1, ops: OPS, now: Date.now() });
      if (v === "rev") { hm.reads++; return ok({ gen: hm.gen, tasks: `h${hm.gen}`, now: Date.now() }); }
      if (v === "tasks") return ok({ gen: hm.gen, rev: `h${hm.gen}`, tasks: hm.tasks });
      if (v === "projects") return ok({ gen: hm.gen, projects: [{ id: RID, name: "r" }] });
    }
    return { code: 2, stdout: "", stderr: "" };
  };
  host.exec = async (cmd, args, opts) => {
    hm.sends.push({ cmd, args, opts });
    const env = JSON.parse(args[3]);
    if (env.op === "move") { const t = hm.tasks.find((x) => x.id === env.id); t.column = env.column; t.rev = (t.rev ?? 0) + 1; hm.gen++; }
    if (env.op === "add") { hm.tasks.push(card("T-NEW1", RID, { title: env.title })); hm.gen++; }
    return ok({ ok: true, gen: hm.gen, replayed: false, attempts: 1, result: { id: env.id ?? "T-NEW1" } });
  };
  IO.remote.sync([]); IO.resetRemoteWriter();
});
const fire = () => { for (const t of timers) t(); };
async function ready() {
  const cx = mkCx();
  IO.watchRemote(cx, () => true);
  await until(() => host.state[CKEY]?.ops, "first board read");
  await until(() => IO.remoteWriteState(LID).enabled, "writes enabled");
  return cx;
}

test("remoteWriteState: a local project is not remote; a remote one is disabled until the machine answered, with the reason", async () => {
  assert.deepEqual({ ...IO.remoteWriteState("P-LOCAL"), reason: undefined }, { remote: false, enabled: false, reason: undefined });
  const cx = mkCx(); IO.watchRemote(cx, () => true);
  const st = IO.remoteWriteState(LID);
  assert.equal(st.remote, true); assert.equal(st.enabled, false); assert.match(st.reason, /has not answered yet/);
});

test("the first fresh read of the board turns the writes on: no probe, no inbox listing, controls from the ops list", async () => {
  await ready();
  const st = IO.remoteWriteState(LID);
  assert.deepEqual([st.remote, st.enabled, st.reason], [true, true, null]);
  assert.deepEqual(st.fields, { on: true, tip: null });
  assert.ok(hm.remoteArgv.every((a) => !a.includes("protocol") && !a.includes("sh")), "only headless verbs reach the machine");
});

test("remoteSend: a move carries the cached rev, the outcome is saved, and the board is re-read", async () => {
  const cx = await ready();
  const reads = hm.reads;
  const o = await IO.remoteSend(LID, { op: "move", id: "T-R1", column: "doing" }, cx);
  assert.equal(o.status, "saved");
  assert.equal(o.machine, M);
  assert.equal(hm.sends.length, 1);
  assert.equal(JSON.parse(hm.sends[0].args[3]).ifRev, 4);
  assert.ok(hm.reads > reads, "the board is re-read after a save");
  assert.equal(IO.loadMerged().tasks.find((t) => t.id === "T-R1").column, "doing");
  assert.ok(notifies.length > 0);
});

test("the whole payload is a local argv item; no remote argv carries it, and the remote-only sentinel never reaches the laptop's cache", async () => {
  const cx = await ready();
  const o = await IO.remoteSend(LID, { op: "note", id: "T-R1", text: "hello" }, cx);
  assert.equal(o.status, "saved");
  assert.ok(!JSON.stringify(hm.remoteArgv).includes("hello"));
  assert.ok(JSON.parse(hm.sends[0].args[3]).text === "hello", "it is the stdin item of the local sh");
  assert.ok(!JSON.stringify(hm.sends[0].args.slice(4)).includes("hello"), "and in no remote argv word");
  assert.ok(!JSON.stringify(host.state[CKEY]).includes(SENTINEL));
});

test("writes:false: nothing is sent, the binding keeps its id; setRemoteWrites answers {ok, writes}", async () => {
  const cx = await ready();
  const r = IO.setRemoteWrites(LID, false);
  assert.deepEqual(r, { ok: true, writes: false });
  const b = host.state["drover.projects"].find((x) => x.id === LID);
  assert.equal(b.remote.writes, false); assert.equal(b.remote.id, "B-1"); assert.equal(b.remote.machine, M); assert.equal(b.remote.projectId, RID);
  assert.equal(IO.remoteWriteState(LID).enabled, false);
  const o = await IO.remoteSend(LID, { op: "move", id: "T-R1", column: "doing" }, cx);
  assert.equal(o.status, "refused");
  assert.equal(hm.sends.length, 0);
  assert.equal(IO.setRemoteWrites(LID, true).writes, true);
  assert.equal(IO.setRemoteWrites("P-LOCAL", false).error !== undefined, true, "a local project has no remote binding");
});

test("ownership: local producers still cannot put a card into the remote project; the remote writer is the only producer and touches no local card", async () => {
  const cx = await ready();
  const tasks = JSON.stringify(host.state["drover.tasks"]);
  host.notified.length = 0;
  assert.equal(IO.save(S.add(host.state["drover.tasks"], { title: "new", project: LID })), null, "a local create is blocked");
  assert.equal(JSON.stringify(host.state["drover.tasks"]), tasks);
  const o = await IO.remoteSend(LID, { op: "add", title: "from laptop", project: "P-LOCAL" }, cx);
  assert.equal(o.status, "saved");
  assert.equal(JSON.parse(hm.sends[0].args[3]).project, RID, "the project is forced to the one on the machine");
  assert.equal(JSON.stringify(host.state["drover.tasks"]), tasks, "no local card was created");
});

test("a send for a card the saved copy does not have, or with a bad rev, is refused and nothing is sent", async () => {
  const cx = await ready();
  assert.equal((await IO.remoteSend(LID, { op: "move", id: "T-NOPE", column: "doing" }, cx)).status, "refused");
  assert.equal((await IO.remoteSend(LID, { op: "edit", id: "T-R1", title: "x", ifRev: -1 }, cx)).status, "refused");
  assert.equal((await IO.remoteSend("P-LOCAL", { op: "move", id: "T-R1", column: "doing" }, cx)).status, "refused");
  assert.equal(hm.sends.length, 0);
});
