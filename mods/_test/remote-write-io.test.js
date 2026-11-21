// Remote project step 2, the io.js wiring (T-MWHVWR8TIJB): the writer behind Board/Tasks. Stubbed host, fake box1; no real hc, no sleeps.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const R = await import("../_lib/remote.js");
const IO = await import("../_lib/io.js");
const S = await import("../_lib/store.js");

const RID = "P-REMOTE1", LID = "P-ONREM", M = "box1";
const SENTINEL = "SENTINEL-sk-not-a-real-secret-0042";
const card = (id, project, extra = {}) => ({ id, title: `title ${id}`, desc: "", column: "todo", priority: "P2", tags: [], project, archived: false, notes: [], ...extra });
const REMOTE_PROJECT = (extra = {}) => ({ id: LID, name: "pairstone", repos: [], folders: [], branch: "main", remote: { machine: M, projectId: RID, id: "B-1", ...extra } });
const CKEY = `drover.remote.${M}.${RID}`;
const base = (p) => p.split("/").pop();

let host, timers, om, notifies;
const mkCx = () => { const cx = { notify: () => notifies.push(1), spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}), timer: { every: (_ms, fn) => timers.push(() => fn(cx)) } }; return cx; };
// box1: its inbox, its board, and the hc surface the laptop sees.
beforeEach(() => {
  timers = []; notifies = [];
  om = { inbox: {}, step1: [], remote: [], boardReads: 0, board: { "drover.projects": [{ id: RID, name: "r" }], "drover.tasks": [card("T-R1", RID, { rev: 4 }), card("T-R2", RID)], "drover.agents": { env: SENTINEL } } };
  om.consume = (reply) => { for (const n of Object.keys(om.inbox)) if (n.endsWith(".json")) { const cmd = JSON.parse(om.inbox[n]); delete om.inbox[n]; om.inbox[n.replace(/\.json$/, ".result")] = reply(cmd); } };
  host = globalThis.__host = { appHome: "/app", home: "/h", props: {}, notified: [], terminals: [], agents: [], spaces: [], panes: [], state: { "drover.tasks": [card("T-LOCAL1", "P-LOCAL")], "drover.projects": [{ id: "P-LOCAL", name: "mine", repos: [], folders: [], branch: "main" }, REMOTE_PROJECT()] } };
  host.exec = async (cmd, args, opts) => { om.step1.push({ cmd, args, opts }); om.inbox[base(args[5])] = args[3]; return { code: 0, stdout: "", stderr: "" }; };
  host.hc = async (args) => {
    if (args[0] === "machine") return { code: 0, stdout: JSON.stringify({ machines: [{ name: M }] }), stderr: "" };
    if (args[0] === "file" && args[1] === "read") {
      const p = args[4];
      if (p.endsWith("shared.json")) { om.boardReads++; return { code: 0, stdout: JSON.stringify(om.board), stderr: "" }; }
      const n = base(p);
      return n in om.inbox ? { code: 0, stdout: om.inbox[n], stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "exec") {
      const sc = args[args.indexOf("-c") + 1], a0 = args[args.indexOf("-c") + 2];
      om.remote.push(args);
      if (sc.startsWith("d=$HOME")) { const f = `1700000000-${a0}`; om.inbox[`${f}.json`] = om.inbox[`.${a0}.tmp`]; delete om.inbox[`.${a0}.tmp`]; return { code: 0, stdout: `${f}.json\n`, stderr: "" }; }
      if (sc.startsWith("rm ")) { delete om.inbox[a0]; return { code: 0, stdout: "", stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 2, stdout: "", stderr: "" };
  };
  IO.remote.sync([]); IO.resetRemoteWriter();
});
const fire = () => { for (const t of timers) t(); };
// Board read, then the probe on stale -> fresh, answered ok; returns when writes are enabled.
async function ready(level = 2) {
  const cx = mkCx();
  IO.watchRemote(cx, () => true);
  await until(() => host.state[CKEY], "first board read");
  fire();
  await until(() => om.step1.length >= 1 && IO.remoteWriter().inflight(M) === 0, "probe staged and renamed");
  om.consume((cmd) => (cmd.op === "protocol" ? `ok: protocol ${level}` : "ok: x"));
  await until(async () => { fire(); await drain(2); return IO.remoteWriteState(LID).enabled; }, "writes enabled");
  om.sawList = om.remote.some((a) => a[a.indexOf("-c") + 1] === 'ls "$HOME/.config/herdr-app/data/drover-inbox"');
  om.step1.length = 0; om.remote.length = 0;
  return cx;
}

test("remoteWriteState: a local project is not remote; a remote one is disabled until the probe answers, with the reason", async () => {
  assert.deepEqual({ ...IO.remoteWriteState("P-LOCAL"), reason: undefined }, { remote: false, enabled: false, frozen: false, reason: undefined });
  const cx = mkCx(); IO.watchRemote(cx, () => true);
  const st = IO.remoteWriteState(LID);
  assert.equal(st.remote, true); assert.equal(st.enabled, false); assert.ok(st.reason);
});

test("the probe is sent when the board first turns fresh and answers enable writes", async () => {
  await ready();
  assert.deepEqual(IO.remoteWriteState(LID), { remote: true, enabled: true, reason: null, frozen: false, fields: { on: false, tip: `${M} needs the update for priority, labels, assignee, parent and project` } });
});
test("remoteWriteState: protocol 3 turns the field controls on", async () => {
  await ready(3);
  assert.deepEqual(IO.remoteWriteState(LID).fields, { on: true, tip: null });
});

test("remoteSend: a move carries the cached rev, the outcome is saved, and the board is re-read", async () => {
  const cx = await ready();
  const reads = om.boardReads;
  const p = IO.remoteSend(LID, { op: "move", id: "T-R1", column: "doing" }, cx);
  await until(() => om.step1.length === 1 && IO.remoteWriter().inflight(M) === 0, "staged");
  assert.deepEqual(JSON.parse(om.step1[0].args[3]), { op: "move", id: "T-R1", column: "doing", ifRev: 4, ttlMs: 120000 });
  om.consume(() => "ok: T-R1 -> doing");
  const o = await (async () => { for (;;) { fire(); const r = await Promise.race([p, drain(2).then(() => null)]); if (r) return r; } })();
  assert.equal(o.status, "saved");
  await until(() => om.boardReads > reads, "the board is re-read after a save");
  assert.ok(notifies.length > 0);
});

test("the whole payload is a local argv item; no remote argv carries it, and the box1-only sentinel never reaches the laptop's logs or cache", async () => {
  const cx = await ready();
  const p = IO.remoteSend(LID, { op: "note", id: "T-R1", text: "hello" }, cx);
  await until(() => om.step1.length === 1 && IO.remoteWriter().inflight(M) === 0, "staged");
  assert.ok(!JSON.stringify(om.remote).includes("hello"));
  om.consume(() => "ok: T-R1 note 1");
  for (;;) { fire(); if (await Promise.race([p, drain(2).then(() => null)])) break; }
  assert.ok(!JSON.stringify(host.state).includes(SENTINEL), "drover.agents never stored");
});

test("writes:false (the freeze): nothing is sent, and frozen is reported once no send is in flight; setRemoteWrites keeps the binding id", async () => {
  const cx = await ready();
  const r = IO.setRemoteWrites(LID, false);
  assert.equal(r.writes, false);
  const b = host.state["drover.projects"].find((x) => x.id === LID);
  assert.equal(b.remote.writes, false); assert.equal(b.remote.id, "B-1"); assert.equal(b.remote.machine, M); assert.equal(b.remote.projectId, RID);
  assert.equal(IO.remoteWriteState(LID).frozen, true);
  assert.equal(IO.remoteWriteState(LID).enabled, false);
  const o = await IO.remoteSend(LID, { op: "move", id: "T-R1", column: "doing" }, cx);
  assert.equal(o.status, "refused");
  assert.equal(om.step1.length, 0);
  assert.equal(IO.setRemoteWrites(LID, true).writes, true);
  assert.equal(IO.setRemoteWrites("P-LOCAL", false).error !== undefined, true, "a local project has no remote binding");
});

test("ownership: local producers still cannot put a card into the remote project; the remote writer is the only producer and touches no local card", async () => {
  const cx = await ready();
  const tasks = JSON.stringify(host.state["drover.tasks"]);
  host.notified.length = 0;
  assert.equal(IO.save(S.add(host.state["drover.tasks"], { title: "new", project: LID })), null, "a local create is blocked");
  assert.equal(JSON.stringify(host.state["drover.tasks"]), tasks);
  const p = IO.remoteSend(LID, { op: "add", title: "from laptop", project: "P-LOCAL" }, cx);
  await until(() => om.step1.length === 1 && IO.remoteWriter().inflight(M) === 0, "staged");
  assert.equal(JSON.parse(om.step1[0].args[3]).project, RID, "the project is forced to the one on box1");
  om.consume(() => "ok: T-NEW1 added");
  for (;;) { fire(); if (await Promise.race([p, drain(2).then(() => null)])) break; }
  assert.equal(JSON.stringify(host.state["drover.tasks"]), tasks, "no local card was created");
});

test("a late outcome (nobody waiting) repaints through cx.notify", async () => {
  const cx = await ready();
  const p = IO.remoteSend(LID, { op: "move", id: "T-R1", column: "review" }, cx);
  await until(() => om.step1.length === 1 && IO.remoteWriter().inflight(M) === 0, "staged");
  const early = notifies.length;
  // no answer within the wait: pending
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    skew = 11000; fire();
    const o = await p;
    assert.equal(o.status, "pending");
    om.consume(() => "ok: T-R1 -> review");
    skew = 30000;
    await until(async () => { fire(); await drain(2); return notifies.length > early; }, "late result repaints");
  } finally { Date.now = realNow; }
});

test("cleanup runs when the machine turns fresh (the reconnect): the inbox is listed", async () => {
  await ready();
  assert.equal(om.sawList, true);
});

// #70: PROTOCOL is 5. The remote writer's gates are minimums (writes >= 2, fields >= 3): box1 on 4 keeps working, and so does a 5.
test("remoteWriteState: a protocol 4 or 5 answer keeps writes and the field controls on", async () => {
  for (const level of [4, 5]) {
    IO.resetRemoteWriter();
    await ready(level);
    const st = IO.remoteWriteState(LID);
    assert.equal(st.enabled, true, `protocol ${level}`);
    assert.deepEqual(st.fields, { on: true, tip: null }, `protocol ${level}`);
  }
});
