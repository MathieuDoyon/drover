// A3b J2 (T-MWO2UYPADZC): the exec transport wired into io.js. Stubbed host, a fake headless board behind hc exec; no real hc, no sleeps.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const R = await import("../_lib/remote.js");
const CFG = await import("../_lib/config.js");
const X = await import("../_lib/remote-exec.js");
const UI = await import("../_lib/remote-write-ui.js");
const IO = await import("../_lib/io.js");

const RID = "P-REMOTE1", LID = "P-ONREM", M = "box1";
const OPS = ["add", "archive", "edit", "import", "move", "move-out", "note", "project-add"];
const card = (id, project, extra = {}) => ({ id, title: `title ${id}`, desc: "", column: "todo", priority: "P2", tags: [], project, archived: false, notes: [], ...extra });
const binding = (extra = {}) => ({ id: LID, name: "pairstone", repos: [], folders: [], branch: "main", remote: { machine: M, projectId: RID, id: "B-1", ...extra } });
const CKEY = `drover.remote.${M}.${RID}`;

let host, timers, notifies, hm;
const mkCx = () => { const cx = { notify: () => notifies.push(1), stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}), timer: { after() {}, every: (_ms, fn) => timers.push(() => fn(cx)) } }; return cx; };
const fire = () => { for (const t of timers) t(); };
const verbOf = (args) => args.slice(args.indexOf(X.HEADLESS) + 1);
const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
beforeEach(() => {
  timers = []; notifies = [];
  // hm: the machine. Its headless board, its shared.json (old, for the inbox), and what the laptop did to it.
  hm = { gen: 1, ops: OPS, down: false, hang: false, tasks: [card("T-R1", RID, { rev: 4 }), card("T-R2", RID)], headlessCalls: [], sends: [], inboxTouched: 0, sharedReads: 0, writeReply: null, nonces: new Map(), loseReply: false, skew: 0 };
  host = globalThis.__host = { appHome: "/app", home: "/h", props: {}, notified: [], terminals: [], agents: [], spaces: [], panes: [], state: { "drover.tasks": [], "drover.projects": [{ id: "P-LOCAL", name: "mine", repos: [], folders: [], branch: "main" }, binding()] } };
  host.watchFolder = () => new Promise(() => {}); // the CLI inbox consumer of a Board has nothing to watch here
  host.closed = []; host.closeOverlay = (id) => host.closed.push(id);
  host.hc = async (args) => {
    if (args[0] === "machine") return ok({ machines: [{ name: M }] });
    if (args[0] === "file" && args[1] === "read") { hm.sharedReads++; return ok({ "drover.projects": [{ id: RID, name: "r" }], "drover.tasks": hm.tasks }); }
    if (args[0] === "exec" && args.includes(X.HEADLESS)) {
      hm.headlessCalls.push(args);
      if (hm.hang) return new Promise(() => {});
      if (hm.down) return { code: 255, stdout: "", stderr: "ssh: down secret-host" };
      const v = verbOf(args);
      const nowField = hm.skew === undefined ? {} : { now: Date.now() + hm.skew };
      if (v[0] === "version") return ok({ cli: "drover-headless", schema: 1, ops: hm.ops, ...nowField });
      if (v[0] === "rev") return ok({ gen: hm.gen, tasks: `h${hm.gen}`, bytes: 1, ...nowField });
      if (v[0] === "tasks") return ok({ gen: hm.gen, rev: `h${hm.gen}`, tasks: hm.tasks });
      if (v[0] === "projects") return ok({ gen: hm.gen, projects: [{ id: RID, name: "r" }] });
    }
    hm.inboxTouched++;
    return { code: 2, stdout: "", stderr: "" };
  };
  host.exec = async (cmd, args) => {
    hm.sends.push({ cmd, args });
    if (hm.writeReply) return hm.writeReply;
    const env = JSON.parse(args[3]);
    if (hm.nonces.has(env.nonce)) return ok({ ok: true, gen: hm.gen, replayed: true, attempts: 1, result: hm.nonces.get(env.nonce) }); // the remote's nonce table
    const t = hm.tasks.find((x) => x.id === env.id);
    let result = { id: env.id };
    if (env.op === "move" && t) { t.column = env.column; t.rev = (t.rev ?? 0) + 1; hm.gen++; }
    if (env.op === "add") { result = { id: `T-NEW${hm.tasks.length}` }; hm.tasks.push(card(result.id, RID, { title: env.title })); hm.gen++; }
    hm.nonces.set(env.nonce, result);
    if (hm.loseReply) { hm.loseReply = false; return { code: 255, stdout: "", stderr: "lost link" }; } // applied, but the answer never came back
    return ok({ ok: true, gen: hm.gen, replayed: false, attempts: 1, result });
  };
  IO.remote.sync([]); IO.resetRemoteWriter();
});
const useExec = () => { host.state["drover.projects"] = [host.state["drover.projects"][0], binding({ transport: "exec" })]; };
async function ready() {
  useExec();
  const cx = mkCx();
  IO.watchRemote(cx, () => true);
  await until(() => host.state[CKEY], "first exec read");
  await until(() => IO.remoteWriteState(LID).enabled, "controls on");
  return cx;
}

test("default stays inbox: a binding with no transport reads shared.json and never runs drover-headless", async () => {
  const cx = mkCx();
  IO.watchRemote(cx, () => true);
  await until(() => host.state[CKEY], "first read");
  assert.equal(hm.sharedReads > 0, true);
  assert.equal(hm.headlessCalls.length, 0);
  assert.equal(R.bindings(host.state["drover.projects"])[0].transport, undefined);
});

test("bindings and withRemote keep exec and drop any other value", () => {
  assert.equal(R.bindings([binding({ transport: "exec" })])[0].transport, "exec");
  assert.equal(R.bindings([binding({ transport: "weird" })])[0].transport, undefined);
  const w = R.withRemote([binding({ transport: "exec" })], LID, { machine: M, projectId: RID, id: "B-1", transport: "exec" });
  assert.equal(w[0].remote.transport, "exec");
  assert.equal(R.withRemote([binding()], LID, { machine: M, projectId: RID, transport: "weird" })[0].remote.transport, undefined);
});

test("exec binding: read through headless, cards shown, controls from the remote's ops, no inbox traffic and no probe", async () => {
  await ready();
  assert.equal(hm.sharedReads, 0);
  assert.equal(hm.inboxTouched, 0);
  const m = IO.loadMerged();
  assert.deepEqual(m.tasks.filter((t) => t.project === LID).map((t) => t.id), ["T-R1", "T-R2"]);
  const st = IO.remoteWriteState(LID);
  assert.equal(st.enabled, true);
  assert.equal(st.frozen, false);
  assert.deepEqual(st.controls, { move: true, note: true, edit: true, add: true, archive: true });
  assert.equal(st.fields.on, true);
});

test("ops gate the controls: an op the remote did not report is off, with the reason", async () => {
  hm.ops = ["note", "add"];
  useExec();
  const cx = mkCx(); IO.watchRemote(cx, () => true);
  await until(() => host.state[CKEY], "read");
  const st = IO.remoteWriteState(LID);
  assert.equal(st.enabled, true, "the view is fresh and writes are on: the ops decide each control separately");
  assert.equal(st.reason, null);
  assert.match(st.opTips.move, /does not support move/);
  assert.equal(st.controls.note, true);
  assert.equal(st.controls.archive, false);
  assert.equal(st.fields.on, false);
  assert.match(st.fields.tip, /does not support edit/);
  const o = await IO.remoteSend(LID, { op: "move", id: "T-R1", column: "doing" }, cx);
  assert.equal(o.status, "refused");
  assert.equal(hm.sends.length, 0);
});

test("a write: the payload is on stdin only (a local argv item), carries the cached rev, and the board is re-read", async () => {
  const cx = await ready();
  const calls = hm.headlessCalls.length;
  const o = await IO.remoteSend(LID, { op: "move", id: "T-R1", column: "doing" }, cx);
  assert.equal(o.status, "saved");
  assert.equal(hm.sends.length, 1);
  const a = hm.sends[0].args;
  const env = JSON.parse(a[3]);
  assert.equal(env.ifRev, 4);
  assert.deepEqual(a.slice(6), [X.HEADLESS, "move"]);
  assert.ok(!JSON.stringify(hm.headlessCalls).includes(env.nonce), "no hc exec read argv carries the payload");
  assert.ok(hm.headlessCalls.length > calls, "re-read after a save");
  assert.equal(IO.loadMerged().tasks.find((t) => t.id === "T-R1").column, "doing");
  assert.equal(hm.inboxTouched, 0);
});

test("unreachable: the last cache stays marked stale with a banner, and a write is refused with nothing sent", async () => {
  const cx = await ready();
  hm.down = true;
  await IO.retryRemote(M, RID, cx);
  const m = IO.loadMerged();
  assert.equal(m.remotes[0].state, "stale");
  assert.match(m.remotes[0].banner, /unreachable/);
  assert.doesNotMatch(JSON.stringify(m.remotes), /secret-host/);
  assert.equal(m.tasks.filter((t) => t.project === LID).length, 2, "the last copy is still shown");
  const st = IO.remoteWriteState(LID);
  assert.equal(st.enabled, false);
  assert.match(st.reason, /unreachable/);
  const o = await IO.remoteSend(LID, { op: "move", id: "T-R1", column: "doing" }, cx);
  assert.equal(o.status, "refused");
  assert.match(o.message, /nothing was sent/);
  assert.equal(hm.sends.length, 0);
  assert.deepEqual(IO.remoteWriteState(LID).frozen, false, "no freeze, no queue");
});

test("a hung runner never blocks render or the timer: loadMerged and the tick return at once", async () => {
  const cx = await ready();
  hm.hang = true;
  hm.gen = 2;
  IO.retryRemote(M, RID, cx); // starts a read that never answers
  await drain(2);
  const t0 = performance.now();
  const m = IO.loadMerged();
  fire();
  assert.ok(performance.now() - t0 < 200);
  assert.equal(m.tasks.filter((t) => t.project === LID).length, 2);
  assert.doesNotThrow(() => IO.remoteWriteState(LID));
});

test("the writes toggle (writes: false) refuses an exec write and reports frozen without a writer", async () => {
  const cx = await ready();
  const r = IO.setRemoteWrites(LID, false);
  assert.equal(r.frozen, true);
  assert.equal(host.state["drover.projects"].find((p) => p.id === LID).remote.transport, "exec");
  const o = await IO.remoteSend(LID, { op: "move", id: "T-R1", column: "doing" }, cx);
  assert.equal(o.status, "refused");
  assert.equal(hm.sends.length, 0);
});

test("flip: inbox -> exec -> inbox -> exec keeps the binding id and the card ids; nothing but the binding changes", async () => {
  const cx = mkCx(); IO.watchRemote(cx, () => true);
  await until(() => host.state[CKEY], "inbox read");
  const ids = () => IO.loadMerged().tasks.filter((t) => t.project === LID).map((t) => t.id).sort();
  assert.deepEqual(ids(), ["T-R1", "T-R2"]);
  const before = JSON.stringify(host.state["drover.tasks"]);
  assert.deepEqual(await IO.setRemoteTransport(LID, "exec"), { ok: true, transport: "exec" });
  const b = () => host.state["drover.projects"].find((p) => p.id === LID).remote;
  assert.equal(b().transport, "exec"); assert.equal(b().id, "B-1");
  fire(); await until(() => host.state[CKEY]?.ops, "exec read");
  assert.deepEqual(ids(), ["T-R1", "T-R2"]);
  assert.deepEqual(await IO.setRemoteTransport(LID, "inbox"), { ok: true, transport: "inbox" });
  assert.equal(b().transport, undefined); assert.equal(b().id, "B-1");
  fire(); await until(() => host.state[CKEY] && !host.state[CKEY].ops, "inbox read again");
  assert.deepEqual(ids(), ["T-R1", "T-R2"]);
  assert.equal((await IO.setRemoteTransport(LID, "exec")).ok, true);
  assert.equal(JSON.stringify(host.state["drover.tasks"]), before, "no local card was created or changed");
});

test("flip to exec is refused (binding unchanged) when the machine does not answer headless or lacks the project; a bad value or a local project is refused", async () => {
  hm.down = true;
  const r = await IO.setRemoteTransport(LID, "exec");
  assert.match(r.error, /did not answer drover-headless/);
  assert.equal(host.state["drover.projects"].find((p) => p.id === LID).remote.transport, undefined);
  hm.down = false;
  assert.match((await IO.setRemoteTransport(LID, "carrier-pigeon")).error, /inbox or exec/);
  assert.match((await IO.setRemoteTransport("P-LOCAL", "exec")).error, /Not a remote project/);
});

test("bind with transport exec checks the machine over exec (version, projects), not shared.json", async () => {
  const project = { id: LID, name: "pairstone", repos: [], folders: [], branch: "main" };
  const r = await IO.remote.bind(project, { machine: M, projectId: RID, transport: "exec" }, { tasks: [], projects: [project] });
  assert.equal(r.project.remote.transport, "exec");
  assert.equal(hm.sharedReads, 0);
  hm.down = true;
  assert.match((await IO.remote.bind(project, { machine: M, projectId: RID, transport: "exec" }, { tasks: [], projects: [project] })).error, /did not answer drover-headless/);
});

test("the editor's Transport control: a view-model for each side of the flip, with note text", () => {
  const a = UI.transportToggle({ machine: M, projectId: RID });
  assert.deepEqual([a.value, a.next, a.button], ["inbox", "exec", "Switch to exec"]);
  assert.match(a.note, /nothing moves/);
  const b = UI.transportToggle({ machine: M, projectId: RID, transport: "exec" });
  assert.deepEqual([b.value, b.next, b.button], ["exec", "inbox", "Back to inbox"]);
  assert.match(b.label, new RegExp(M));
});

// ---- fix round 1 ----
const NODE = Symbol.for("test.node");
const findNode = (n, id) => (n.id === id ? n : n.kids.map((k) => findNode(k, id)).find(Boolean));
CFG.setSettings("drover-board", {});
const { default: Board } = await import("../drover-board/main.js");
const cxOf = () => { const cx = { notify() {}, stop_propagation() {}, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}), focus_handle: () => ({ focus() {} }), timer: { after() {}, every: (_ms, fn) => timers.push(() => fn(cx)) } }; return cx; };
const view = (v, cx, id) => { globalThis.__rec = { ids: [], texts: [] }; try { const root = v.render(cx); return findNode(root[NODE], id); } finally { globalThis.__rec = undefined; } };
const tip = (n) => n?.args.tooltip?.[0];
const clickable = (n) => Boolean(n?.args.on_click);

test("F2: the real Board's New control follows the add op: ops=[move] has New off with the reason, the chevron on", async () => {
  hm.ops = ["move"];
  await ready();
  const b = new Board(); b.init({}, cxOf()); b.scope = `project:${LID}`;
  const cx = cxOf();
  assert.equal(clickable(view(b, cx, "new")), false);
  assert.match(tip(view(b, cx, "new")), /does not support add/);
  assert.equal(clickable(view(b, cx, "r-T-R1")), true, "move is reported: the chevron stays on");
});

test("F2: the real Board with ops=[add,note]: New is on, the chevron (move) is off with its own reason", async () => {
  hm.ops = ["add", "note"];
  await ready();
  const b = new Board(); b.init({}, cxOf()); b.scope = `project:${LID}`;
  const cx = cxOf();
  assert.equal(clickable(view(b, cx, "new")), true);
  const r = view(b, cx, "r-T-R1");
  assert.equal(clickable(r), false);
  assert.match(tip(r), /does not support move/);
});

test("F2: controlState and fieldState take the op; freshness and writes still gate first", async () => {
  hm.ops = ["note"];
  await ready();
  const U2 = await import("../_lib/remote-write-ui.js");
  const ws = IO.remoteWriteState(LID);
  assert.equal(U2.controlState(ws, "note").on, true);
  for (const op of ["move", "add", "edit", "archive"]) { const c = U2.controlState(ws, op); assert.equal(c.on, false, op); assert.match(c.tip, new RegExp(`does not support ${op}`)); }
  assert.equal(U2.fieldState(ws).on, false);
  assert.match(U2.fieldState(ws).tip, /does not support edit/);
  hm.down = true; await IO.retryRemote(M, RID, mkCx());
  const stale = U2.controlState(IO.remoteWriteState(LID), "note");
  assert.equal(stale.on, false); assert.match(stale.tip, /unreachable/, "freshness still wins over the op");
});

test("F2 sweep: no control in Board, Tasks or Todos asks the write state without naming its op", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["drover-board", "drover-tasks", "drover-todos"]) {
    const src = readFileSync(new URL(`../${f}/main.js`, import.meta.url), "utf8");
    const bare = src.split("\n").filter((l) => /controlState\(remoteWriteState\([^()]*\)\)/.test(l) && !/gstate\(\)/.test(l)); // gstate() is the freshness-only banner gate of the Todos editor
    assert.deepEqual(bare, [], `${f}: controlState(remoteWriteState(x)) with no op`);
  }
});

test("F3: repeating the same add after a lost reply re-sends the retained envelope: one card, the same nonce", async () => {
  const cx = await ready();
  hm.loseReply = true;
  const add = { op: "add", title: "once only" };
  const first = await IO.remoteSend(LID, add, cx);
  assert.equal(first.status, "unknown");
  assert.match((await import("../_lib/remote-write-ui.js")).outcomeText(first), /repeat within 24 h to retry safely; after 24 h check the card first/i);
  const second = await IO.remoteSend(LID, { ...add }, cx);
  assert.equal(second.status, "saved");
  assert.equal(hm.tasks.filter((t) => t.title === "once only").length, 1, "one card on the remote");
  assert.equal(hm.sends.length, 2);
  assert.equal(hm.sends[0].args[3], hm.sends[1].args[3], "the same bytes, so the same nonce and issuedAt");
});

test("F5: a remote clock more than 30 s away, either way, turns the controls off with a fixed reason and refuses the write", async () => {
  for (const skew of [60000, -60000]) {
    hm.skew = skew;
    useExec();
    IO.remote.sync([]);
    const cx = mkCx(); IO.watchRemote(cx, () => true);
    await until(() => host.state[CKEY] && IO.remoteWriteState(LID).reason !== undefined, "read");
    const st = IO.remoteWriteState(LID);
    assert.equal(st.enabled, false, String(skew));
    assert.match(st.reason, /clock/i);
    const o = await IO.remoteSend(LID, { op: "move", id: "T-R1", column: "doing" }, cx);
    assert.equal(o.status, "refused");
    assert.match(o.message, /nothing was sent/);
    assert.equal(hm.sends.length, 0);
    IO.remote.sync([]); host.state[CKEY] = undefined; timers.length = 0;
  }
  hm.skew = 20000;
  const cx = await ready();
  assert.equal(IO.remoteWriteState(LID).enabled, true, "20 s is inside the limit");
  void cx;
});

// ---- fix round 2 ----
const { Editor } = await import("../drover-todos/main.js");
const NEW = () => ({ new: true, id: "", title: "", desc: "", column: "todo", priority: "P2", tags: [], notes: [], project: LID, remote: { machine: M } });
const openRemote = (rc, edit = null) => { host.props = { overlay: "ov", edit, column: rc.column ?? "todo", remoteCard: rc }; };
const editorOf = (cx) => { const v = new Editor(cx); return v; };
const existing = () => R.normalizeRemoteCard(card("T-R1", RID, { rev: 4, title: "old title" }), LID, M);

test("R2-1: the real Todos editor on an existing card renders Archive, Send and Status through their own op gates", async () => {
  hm.ops = ["move"];
  const cx = await ready();
  openRemote(existing(), "T-R1");
  const v = editorOf(cx);
  assert.equal(clickable(view(v, cx, "remote-archive")), false);
  assert.match(tip(view(v, cx, "remote-archive")), /does not support archive/);
  assert.equal(clickable(view(v, cx, "ed-create")), false);
  assert.match(tip(view(v, cx, "ed-create")), /does not support note/);
  assert.doesNotMatch(String(tip(view(v, cx, "prop-status")) ?? ""), /does not support/, "move is reported: Status stays on");
});

test("R2-1: ops=[add,note] on an existing card: Send is on, Archive and Status are off with their own reasons", async () => {
  hm.ops = ["add", "note"];
  const cx = await ready();
  openRemote(existing(), "T-R1");
  const v = editorOf(cx);
  assert.equal(clickable(view(v, cx, "ed-create")), true, "note is reported");
  assert.equal(clickable(view(v, cx, "remote-archive")), false);
  assert.match(tip(view(v, cx, "remote-archive")), /does not support archive/);
  assert.match(String(tip(view(v, cx, "prop-status"))), /does not support move/);
});

test("R2-1: creating a card (ops=[move] off, ops=[add] on): Create follows the add op", async () => {
  hm.ops = ["move"];
  let cx = await ready();
  openRemote(NEW());
  let v = editorOf(cx);
  assert.equal(clickable(view(v, cx, "ed-create")), false);
  assert.match(tip(view(v, cx, "ed-create")), /does not support add/);
  IO.remote.sync([]); host.state[CKEY] = undefined; timers.length = 0;
  hm.ops = ["add"];
  cx = await ready();
  openRemote(NEW());
  v = editorOf(cx);
  assert.equal(clickable(view(v, cx, "ed-create")), true);
});

test("R2-1 sweep: Todos never asks wstate() without an op (the indirect generic gate); the create destination asks add", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../drover-todos/main.js", import.meta.url), "utf8");
  assert.deepEqual(src.match(/\.wstate\(\)/g) ?? [], [], "every wstate call names its op (use gstate() for the freshness-only banner)");
  assert.doesNotMatch(src, /controlState\(remoteWriteState\(p\.id\), "edit"\)/, "choosing where to CREATE a card is an add, not an edit");
  assert.match(src, /controlState\(remoteWriteState\(p\.id\), "add"\)/);
});

test("R2-4: the remote reports no clock (an older headless): reads work, the controls are off and a write is refused with the update hint", async () => {
  hm.skew = undefined;
  useExec();
  const cx = mkCx(); IO.watchRemote(cx, () => true);
  await until(() => host.state[CKEY], "read");
  assert.equal(IO.loadMerged().tasks.filter((t) => t.project === LID).length, 2, "reads stay allowed");
  const st = IO.remoteWriteState(LID);
  assert.equal(st.enabled, false);
  assert.match(st.reason, /update the machine: drover machines install/);
  const o = await IO.remoteSend(LID, { op: "move", id: "T-R1", column: "doing" }, cx);
  assert.equal(o.status, "refused");
  assert.match(o.message, /update the machine: drover machines install/);
  assert.equal(hm.sends.length, 0);
});

// ---- fix round 3 ----
const recorded = (v, cx) => { globalThis.__rec = { ids: [], texts: [], inputs: [], textareas: [] }; try { v.render(cx); return { inputs: globalThis.__rec.inputs, textareas: globalThis.__rec.textareas, texts: globalThis.__rec.texts }; } finally { globalThis.__rec = undefined; } };

test("R3-2: an existing remote card whose edit op is off shows its title and description read-only (no live Input or Textarea for them)", async () => {
  hm.ops = ["move", "note", "archive"];
  const cx = await ready();
  openRemote(existing(), "T-R1");
  const v = editorOf(cx);
  const r = recorded(v, cx);
  assert.ok(!r.inputs.includes(v.title), "the title is not an Input");
  assert.ok(!r.textareas.includes(v.desc), "the description is not a Textarea");
  assert.ok(r.textareas.includes(v.note), "the note composer stays (note is supported)");
  assert.ok(view(v, cx, "title-text"), "a read view of the title");
  assert.match(r.texts.join(" "), /old title/);
});

test("R3-2: with edit reported, the same card renders the live title Input and description Textarea", async () => {
  hm.ops = ["edit", "note"];
  const cx = await ready();
  openRemote(existing(), "T-R1");
  const v = editorOf(cx);
  const r = recorded(v, cx);
  assert.ok(r.inputs.includes(v.title));
  assert.ok(r.textareas.includes(v.desc));
});

test("R3-1 (accepted): the unknown text and the docs state the 24 h window, with no unconditional promise", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = readFileSync(new URL("../../docs/guides/remote-machines.md", import.meta.url), "utf8");
  assert.match(doc, /a retry within 24 h re-sends the same request and creates no second card; after 24 h the remote no longer remembers it and a repeat can create a duplicate: check the card first/);
  assert.doesNotMatch(doc, /\(no second card\)/, "the unconditional promise is gone");
  assert.match(X.classify(null).message, /repeat within 24 h to retry safely; after 24 h check the card first/i);
});
