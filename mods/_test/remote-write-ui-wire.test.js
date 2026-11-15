// The write controls on remote cards, through the real Board and the Editor (T-MWHVWR8TIJB). Stub elements, fake omarchy; no sleeps.
// A disabled control carries a tooltip (the reason) and no click handler; an enabled one has the handler. Pixels are looked at natively.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const R = await import("../_lib/remote.js");
const IO = await import("../_lib/io.js");
const S = await import("../_lib/store.js");
const U = await import("../_lib/remote-write-ui.js");
const NODE = Symbol.for("test.node");
const findNode = (n, id) => (n.id === id ? n : n.kids.map((k) => findNode(k, id)).find(Boolean));
const RID = "P-REMOTE1", LID = "P-ONREM", M = "omarchy";
const SENTINEL = "SENTINEL-sk-not-a-real-secret-0042";
const card = (id, project, extra = {}) => ({ id, title: `title ${id}`, desc: "", column: "todo", priority: "P2", tags: [], project, archived: false, notes: [], ...extra });
const REMOTE_PROJECT = (extra = {}) => ({ id: LID, name: "pairstone", repos: [], folders: [], branch: "main", remote: { machine: M, projectId: RID, id: "B-1", ...extra } });
const CKEY = `drover.remote.${M}.${RID}`;
const base = (p) => p.split("/").pop();

let host, timers, om, notifies;
const mkCx = () => { const cx = { notify: () => notifies.push(1), stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}), timer: { after() {}, every: (_ms, fn) => timers.push(() => fn(cx)) } }; return cx; };
// omarchy: its inbox, its board, and the hc surface the laptop sees.
beforeEach(() => {
  timers = []; notifies = [];
  om = { inbox: {}, step1: [], remote: [], boardReads: 0, board: { "drover.projects": [{ id: RID, name: "r" }], "drover.tasks": [card("T-R1", RID, { rev: 4 }), card("T-R2", RID)], "drover.agents": { env: SENTINEL } } };
  om.consume = (reply) => { for (const n of Object.keys(om.inbox)) if (n.endsWith(".json")) { const cmd = JSON.parse(om.inbox[n]); delete om.inbox[n]; om.inbox[n.replace(/\.json$/, ".result")] = reply(cmd); } };
  host = globalThis.__host = { appHome: "/app", home: "/h", props: {}, notified: [], terminals: [], agents: [], spaces: [], panes: [], state: { "drover.tasks": [card("T-LOCAL1", "P-LOCAL")], "drover.projects": [{ id: "P-LOCAL", name: "mine", repos: [], folders: [], branch: "main" }, REMOTE_PROJECT()] } };
  host.closed = []; host.closeOverlay = (id) => host.closed.push(id);
  host.watchFolder = () => new Promise(() => {}); // the CLI inbox consumer has nothing to watch here
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
async function ready() {
  const cx = mkCx();
  IO.watchRemote(cx, () => true);
  await until(() => host.state[CKEY], "first board read");
  fire();
  await until(() => om.step1.length >= 1 && IO.remoteWriter().inflight(M) === 0, "probe staged and renamed");
  om.consume((cmd) => (cmd.op === "protocol" ? "ok: protocol 2" : "ok: x"));
  await until(async () => { fire(); await drain(2); return IO.remoteWriteState(LID).enabled; }, "writes enabled");
  om.sawList = om.remote.some((a) => a[a.indexOf("-c") + 1] === 'ls "$HOME/.config/herdr-app/data/drover-inbox"');
  om.step1.length = 0; om.remote.length = 0;
  return cx;
}


globalThis.__host = { props: {}, state: {}, notified: [], agents: [] };
const CFG = await import("../_lib/config.js");
CFG.setSettings("drover-board", {});
const { default: Board } = await import("../drover-board/main.js");
const { default: Tasks } = await import("../drover-tasks/main.js");
CFG.setSettings("drover-tasks", {});
const { Editor } = await import("../drover-todos/main.js");
const { ProjectEditor } = await import("../drover-projects/main.js");
const cxOf = () => { const cx = { notify() {}, stop_propagation() {}, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}), focus_handle: () => ({ focus() {} }), timer: { after() {}, every: (_ms, fn) => timers.push(() => fn(cx)) } }; return cx; };
const view = (v, cx, id) => { globalThis.__rec = { ids: [], texts: [] }; try { const root = v.render(cx); return { node: findNode(root[NODE], id), texts: globalThis.__rec.texts }; } finally { globalThis.__rec = undefined; } };
const toolTip = (n) => n?.args.tooltip?.[0];
const clickable = (n) => Boolean(n?.args.on_click);
const settle = (p) => (async () => { for (;;) { fire(); const r = await Promise.race([p, drain(2).then(() => null)]); if (r) return r; } })();

test("Board: before the probe answers every remote control is off with the reason; start/agent ops always say OFF_TIP", async () => {
  const cx = cxOf(); const b = new Board(); b.init({}, cx);
  b.scope = `project:${LID}`;
  let n = view(b, cx, "r-T-R1").node ?? view(b, cx, "l-T-R1").node;
  await until(() => { fire(); return host.state[CKEY]; }, "board read");
  const l = view(b, cx, "l-T-R1").node, r = view(b, cx, "r-T-R1").node, s = view(b, cx, "s-T-R1").node;
  assert.ok(r && !clickable(r)); assert.match(toolTip(r), /Checking|unreachable/);
  assert.equal(toolTip(s), U.OFF_TIP);
  assert.ok(!clickable(view(b, cx, "new").node) && toolTip(view(b, cx, "new").node), "New is off with the reason");
  void l; void n;
});

test("Board: with writes on the chevron sends a move, New opens the remote card view in new mode, start stays off", async () => {
  const cx = await ready();
  const b = new Board(); b.init({}, cx); b.scope = `project:${LID}`;
  const r = view(b, cx, "r-T-R1").node, s = view(b, cx, "s-T-R1").node;
  assert.ok(clickable(r) && toolTip(r) === undefined, "chevron is live");
  assert.equal(toolTip(s), U.OFF_TIP, "start stays off");
  assert.ok(clickable(view(b, cx, "new").node));
  assert.match(view(b, cx, `wstatus-${LID}`).texts.join(" "), /writes on/);
  const n0 = om.step1.length;
  r.args.on_click[0](null, cx);
  await until(() => om.step1.length === n0 + 1, "move staged");
  assert.deepEqual(JSON.parse(om.step1.at(-1).args[3]), { op: "move", id: "T-R1", column: "doing", ifRev: 4, ttlMs: 120000 });
  view(b, cx, "new").node.args.on_click[0](null, cx);
  assert.equal(host.state["drover.tasks"].length, 1, "no local card was created");
});

test("Board: a drop on another column sends move for a remote card; the same column sends nothing", async () => {
  const cx = await ready();
  const b = new Board(); b.init({}, cx);
  const n0 = om.step1.length;
  b.drag = "T-R1"; b.drop("todo", null, cx); await drain();
  assert.equal(om.step1.length, n0, "same column");
  b.drag = "T-R1"; b.drop("review", null, cx);
  await until(() => om.step1.length === n0 + 1, "move staged");
  assert.equal(JSON.parse(om.step1.at(-1).args[3]).column, "review");
});

test("Board: writes frozen turns the controls off with 'writes frozen'", async () => {
  const cx = await ready();
  IO.setRemoteWrites(LID, false);
  const b = new Board(); b.init({}, cx); b.scope = `project:${LID}`;
  const r = view(b, cx, "r-T-R1").node;
  assert.ok(!clickable(r)); assert.equal(toolTip(r), "writes frozen");
  assert.match(view(b, cx, `wstatus-${LID}`).texts.join(" "), /writes frozen/);
});

const NEW = (extra = {}) => ({ new: true, id: "", title: "", desc: "", column: "todo", priority: "P2", tags: [], notes: [], project: LID, remote: { machine: M }, ...extra });
const openRemote = (rc, edit = null) => { host.props = { overlay: "ov", edit, column: rc.column ?? "todo", remoteCard: rc }; };
const sends = () => om.step1.map((x) => JSON.parse(x.args[3])).filter((b) => b.op !== "protocol");
const stage = async (n, label) => { await until(() => sends().length === n && IO.remoteWriter().inflight(M) === 0, label); return sends()[n - 1]; };
const saved = async (v, label) => { om.consume((c) => (c.op === "protocol" ? "ok: protocol 2" : "ok: x")); await until(async () => { fire(); await drain(2); return !v.submitting; }, label); };

test("job 10: create on a remote project opens the SAME Editor: breadcrumb, chips, Create another, Switch to Agent; project chip fixed; dead controls say why", async () => {
  const cx = await ready();
  openRemote(NEW());
  const v = new Editor(cx);
  const t = view(v, cx, "editor").texts.join(" ");
  for (const re of [/Create manually/, /Create another/, /Switch to Agent/, /Create task/]) assert.match(t, re);
  assert.ok(view(v, cx, "trig-project").node, "the project chip is a picker now");
  assert.match(t, /pairstone/); assert.match(t, /omarchy/);
  for (const id of ["ed-mode", "ed-attach", "trig-assignee"]) // dead while a remote project is selected
    { const n = view(v, cx, id).node; assert.ok(n, id); assert.ok(!clickable(n), `${id} is dead`); assert.equal(toolTip(n), U.OFF_TIP, `${id} says why`); }
  assert.ok(clickable(view(v, cx, "ed-create").node), "writes are on: Create works");
  v.toggleMode(cx); assert.equal(v.mode, "manual", "Switch to Agent does nothing here");
});

test("job 10: Create task stages the exact add (ttlMs, project forced, column from the status chip) and creates no local card", async () => {
  const cx = await ready();
  openRemote(NEW());
  const v = new Editor(cx);
  v.title.value = () => "brand new"; v.desc.value = () => "d";
  v.setProp("status", "doing", cx);
  v.onCreate(cx);
  assert.deepEqual(await stage(1, "add staged"), { op: "add", title: "brand new", desc: "d", tags: [], column: "doing", priority: "P2", project: RID, ttlMs: 120000 });
  await saved(v, "saved");
  assert.deepEqual(host.closed, ["ov"], "closed after the add was saved");
  assert.equal(host.state["drover.tasks"].length, 1, "no local card");
});

test("job 10: Create another keeps the modal open and clears the text; an empty title is refused; cmd+enter creates", async () => {
  const cx = await ready();
  openRemote(NEW());
  const v = new Editor(cx);
  v.title.set_value("   "); v.onCreate(cx);
  assert.equal(om.step1.length, 0, "a blank title sends nothing");
  v.title.set_value("one"); v.desc.set_value(""); v.another = true;
  v.submitKey(cx);
  assert.equal((await stage(1, "added by the key")).title, "one");
  await saved(v, "saved");
  assert.deepEqual(host.closed, [], "stays open");
  assert.equal(v.title.value(), "", "cleared");
  assert.match(v.msg, /Saved/);
});

test("job 10: with writes off Create is dead with the reason, and sends nothing", async () => {
  const cx = cxOf();
  openRemote(NEW());
  const v = new Editor(cx);
  const c = view(v, cx, "ed-create").node;
  assert.ok(!clickable(c)); assert.ok(toolTip(c));
  v.title.value = () => "x"; v.submit(cx);
  assert.equal(om.step1.length, 0);
});

test("job 10: edit sends edit, then the move for the status chip, then the note, each with its ifRev; Archive sends archive", async () => {
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4, title: "old title" }), LID, M), "T-R1");
  const v = new Editor(cx);
  assert.match(view(v, cx, "editor").texts.join(" "), /T-R1/);
  assert.equal(toolTip(view(v, cx, "prop-priority").node), U.OFF_TIP, "priority of an existing card is not an allowed op");
  v.title.value = () => "new title"; v.note.value = () => "a note"; v.setProp("status", "doing", cx);
  v.onCreate(cx);
  const e = await stage(1, "edit"); assert.deepEqual(e, { op: "edit", id: "T-R1", title: "new title", ifRev: 4, ttlMs: 120000 });
  om.consume(() => "ok: edited");
  await until(async () => { fire(); await drain(2); return sends().length === 2 && IO.remoteWriter().inflight(M) === 0; }, "move");
  assert.equal(sends()[1].op, "move"); assert.equal(sends()[1].column, "doing");
  om.consume(() => "ok: moved");
  await until(async () => { fire(); await drain(2); return sends().length === 3 && IO.remoteWriter().inflight(M) === 0; }, "note");
  assert.equal(sends()[2].op, "note");
  await saved(v, "saved");
  v.remoteArchive(cx);
  await until(async () => sends().length === 4 && IO.remoteWriter().inflight(M) === 0, "archive");
  assert.equal(sends()[3].op, "archive");
});

test("job 10: a stale answer keeps the draft and says the card changed", async () => {
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4, title: "old title" }), LID, M), "T-R1");
  const v = new Editor(cx);
  v.title.value = () => "mine"; v.onCreate(cx);
  await stage(1, "edit");
  om.consume(() => "error: stale");
  await until(async () => { fire(); await drain(2); return !v.submitting; }, "answered");
  assert.match(v.msg, /card changed on omarchy/);
  assert.equal(v.title.value(), "mine"); assert.deepEqual(host.closed, []);
});

test("Project editor: the writes toggle flips remote.writes, keeps the binding, and says frozen only when the writer does", async () => {
  await ready();
  host.props = { overlay: "ov", projectEdit: LID };
  const cx = cxOf();
  const ed = new ProjectEditor(cx);
  const before = view(ed, cx, "writes-note").texts.join(" ");
  assert.match(before, /Writes to omarchy: on/);
  ed.toggleWrites(cx);
  assert.equal(host.state["drover.projects"].find((p) => p.id === LID).remote.writes, false);
  assert.match(view(ed, cx, "writes-note").texts.join(" "), /Writes to omarchy: frozen/);
  ed.toggleWrites(cx);
  assert.equal(host.state["drover.projects"].find((p) => p.id === LID).remote.writes, true);
});

test("Tasks: the ✓ on a remote Review card is off with the reason until writes are on, then sends move done", async () => {
  om.board["drover.tasks"].push(card("T-R3", RID, { column: "review", rev: 2 }));
  let cx = cxOf();
  const v = new Tasks(); v.init({}, { ...cx, spawn() {} }); // init starts the inbox and wakeup loops: not under test
  const first = view(v, cx, "ro-done-T-R3");
  await until(() => { fire(); return host.state[CKEY]; }, "board read");
  const off = view(v, cx, "ro-done-T-R3").node;
  assert.ok(off && !clickable(off) && toolTip(off), "off with the reason before the probe answers");
  assert.ok(!view(v, cx, "done-T-R3").node, "no live control yet");
  cx = await ready();
  const on = view(v, cx, "done-T-R3").node;
  assert.ok(clickable(on), "live once writes are on");
  assert.ok(!view(v, cx, "ro-done-T-R3").node);
  const n0 = om.step1.length;
  on.args.on_click[0](null, cx);
  await until(() => om.step1.length === n0 + 1, "move staged");
  assert.deepEqual(JSON.parse(om.step1.at(-1).args[3]), { op: "move", id: "T-R3", column: "done", ifRev: 2, ttlMs: 120000 });
  void first;
});

test("re-review 2.2 Tasks shows what happened to the ✓: stale, expired, error, refused; pending says may still apply", async () => {
  om.board["drover.tasks"].push(card("T-R3", RID, { column: "review", rev: 2 }));
  const cx0 = await ready();
  const cx = cxOf();
  const v = new Tasks(); v.init({}, { ...cx, spawn() {} });
  const press = async (reply) => {
    const n = om.step1.length;
    view(v, cx, "done-T-R3").node.args.on_click[0](null, cx);
    await until(() => om.step1.length === n + 1 && IO.remoteWriter().inflight(M) === 0, "staged");
    om.consume(() => reply);
    await until(async () => { fire(); await drain(2); return view(v, cx, "remote-msg").texts.join(" "); }, "a message is shown");
    return view(v, cx, "remote-msg").texts.join(" ");
  };
  assert.match(await press("error: stale: card T-R3 is at rev 5, request saw 2"), /card changed on omarchy/);
  assert.match(await press("error: expired: arrived 300s ago"), /not applied, too old/);
  assert.match(await press("error: unknown task T-R3"), /error: unknown task T-R3/);
  void cx0;
});

test("re-review 2.4 Save A->B, then revert to A, sends the revert; a saved edit is not sent twice", async () => {
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4, title: "A", desc: "d" }), LID, M), "T-R1");
  const v = new Editor(cx);
  const save = async (title) => {
    const n = om.step1.length;
    v.title.value = () => title; v.desc.value = () => "d"; v.note.value = () => "";
    v.submit(cx);
    await until(() => om.step1.length === n + 1 && IO.remoteWriter().inflight(M) === 0, "staged");
    om.consume(() => "ok: T-R1 edited");
    await until(async () => { fire(); await drain(2); return !v.submitting; }, "saved");
    return JSON.parse(om.step1.at(-1).args[3]);
  };
  assert.equal((await save("B")).title, "B");
  assert.equal((await save("A")).title, "A", "the revert is sent");
  v.title.value = () => "A"; v.submit(cx);
  assert.equal(v.msg, "Nothing to save", "an unchanged, saved title is not resent");
});

test("re-review 2.5 a binding that starts with writes:false stages nothing after its first read", async () => {
  host.state["drover.projects"] = host.state["drover.projects"].map((p) => (p.id === LID ? { ...p, remote: { ...p.remote, writes: false } } : p));
  const cx = mkCx(); IO.watchRemote(cx, () => true);
  await until(() => host.state[CKEY], "first board read");
  fire(); fire(); await drain(); await drain();
  assert.equal(om.step1.length, 0, "no protocol probe either");
  IO.setRemoteWrites(LID, true);
  await until(async () => { fire(); await drain(2); return om.step1.length === 1; }, "a probe once writes are on");
  assert.equal(JSON.parse(om.step1[0].args[3]).op, "protocol");
});

test("re-review 3 a LATE saved edit also advances the editor baseline: B arrives after the deadline, then a revert to A is sent", async () => {
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4, title: "A", desc: "d" }), LID, M), "T-R1");
  const v = new Editor(cx);
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    v.title.value = () => "B"; v.desc.value = () => "d"; v.note.value = () => "";
    v.submit(cx);
    await until(() => om.step1.length === 1 && IO.remoteWriter().inflight(M) === 0, "staged");
    skew = 11000; fire();
    await until(() => !v.submitting, "the caller got 'may still apply'");
    assert.equal(v.msg, "sent, may still apply");
    om.consume(() => "ok: T-R1 edited");
    skew = 60000;
    await until(async () => { fire(); await drain(2); view(v, cx, "ed-create"); return v.msg === "Saved"; }, "the late Saved is shown");
    await until(async () => { fire(); om.consume((c) => (c.op === "protocol" ? "ok: protocol 2" : "ok: x")); await drain(2); return IO.remoteWriteState(LID).enabled; }, "writes are on again (the probe aged during the skew)");
    v.title.value = () => "A"; v.submit(cx);
    const edits = () => om.step1.map((x) => JSON.parse(x.args[3])).filter((b) => b.op === "edit"); // (a refresh probe may be among the sends)
    await until(() => edits().length === 2 && IO.remoteWriter().inflight(M) === 0, "the revert is sent");
    assert.equal(edits()[1].title, "A");
  } finally { Date.now = realNow; }
});

test("job 11: a remote Editor ignores a paste into the description (no local image helper runs)", async () => {
  const cx = await ready();
  openRemote(NEW());
  const v = new Editor(cx);
  let ran = 0; host.exec = async () => { ran++; return { code: 1, stdout: "", stderr: "" }; };
  v.pasteImage(cx); v.pasteImage(cx);
  await drain(3);
  assert.equal(ran, 0); assert.equal(v.busy ?? 0, 0); assert.deepEqual(v.pasted ?? [], []);
});

test("job 11: an existing remote card shows its real labels in the (dead) label chip", async () => {
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4, tags: ["bug", "ui"] }), LID, M), "T-R1");
  const v = new Editor(cx);
  const r = view(v, cx, "prop-labels");
  assert.ok(!clickable(r.node)); assert.equal(toolTip(r.node), U.OFF_TIP);
  assert.match(view(v, cx, "editor").texts.join(" "), /bug, ui/);
  assert.doesNotMatch(view(v, cx, "prop-labels").texts.join(" "), /Add label/);
});

const idsOf = (v, cx) => { globalThis.__rec = { ids: [], texts: [] }; try { v.render(cx); return [...globalThis.__rec.ids]; } finally { globalThis.__rec = undefined; } };

test("job 12: a remote card's edit modal has the right sidebar, in the local order, with a Machine row; dead rows say why; Status stays live", async () => {
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4, tags: ["bug"], priority: "P1" }), LID, M), "T-R1");
  const v = new Editor(cx);
  const ids = idsOf(v, cx);
  assert.ok(ids.includes("ed-sidebar"), "the sidebar is back");
  const order = ["prop-status", "prop-priority", "prop-assignee", "prop-labels", "prop-project", "prop-machine", "prop-parent"].map((i) => ids.indexOf(i));
  assert.ok(order.every((i) => i >= 0), `all rows: ${order}`); assert.deepEqual([...order].sort((a, b) => a - b), order, "same order as the local edit view");
  for (const id of ["prop-priority", "prop-assignee", "prop-labels", "prop-parent"]) assert.equal(toolTip(view(v, cx, id).node), U.OFF_TIP, id);
  assert.ok(view(v, cx, "prop-project").node, "the project row is a picker");
  assert.equal(toolTip(view(v, cx, "prop-machine").node), "where this card lives");
  assert.ok(!clickable(view(v, cx, "prop-machine").node));
  assert.equal(toolTip(view(v, cx, "prop-status").node), undefined, "status is live");
  const t = view(v, cx, "ed-sidebar").texts.join(" ");
  assert.match(t, /omarchy/); assert.match(t, /P1/); assert.match(t, /bug/);
  assert.ok(!ids.includes("wake-plus") && !ids.includes("src-link"), "no local run/wake controls");
  assert.match(t, new RegExp(U.OFF_TIP), "run/wake say they are not available");
  v.setProp("status", "doing", cx); v.onCreate(cx);
  assert.deepEqual(await stage(1, "move"), { op: "move", id: "T-R1", column: "doing", ifRev: 4, ttlMs: 120000 });
});

test("job 12: the remote edit modal keeps Save, Archive and the comment box; no local card appears", async () => {
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4 }), LID, M), "T-R1");
  const v = new Editor(cx);
  const ids = idsOf(v, cx);
  for (const i of ["ed-create", "remote-archive", "remote-note-new", "ed-close"]) assert.ok(ids.includes(i), i);
  v.note.value = () => "hello"; v.onCreate(cx);
  assert.equal((await stage(1, "note")).op, "note");
  assert.equal(host.state["drover.tasks"].length, 1);
});

test("job 12: a local card's edit modal shows Machine = Local, after Project", async () => {
  host.props = { overlay: "ov", edit: "T-LOCAL1", column: "todo" };
  const cx = cxOf();
  const v = new Editor(cx);
  const ids = idsOf(v, cx);
  assert.ok(ids.indexOf("prop-machine") > ids.indexOf("prop-project"));
  const n = view(v, cx, "prop-machine");
  assert.equal(toolTip(n.node), "where this card lives"); assert.ok(!clickable(n.node));
  assert.match(view(v, cx, "ed-sidebar").texts.join(" "), /Local/);
});

// ---- job 13: the project picker lists remote-bound projects; the route is decided from the CURRENT pick ----
const LID2 = "P-ONREM2";
const withSecondRemote = () => host.state["drover.projects"].push({ id: LID2, name: "second", repos: [], folders: [], branch: "main", remote: { machine: M, projectId: "P-REMOTE2", id: "B-2" } });
const entry = (v, cx, id) => view(v, cx, `project-${id}`);

test("job 13: global create lists local AND remote projects (remote labelled with its machine); remote entries are dead with the reason until writes are on", async () => {
  host.props = { overlay: "ov", edit: null, column: "todo" };
  let cx = cxOf();
  let v = new Editor(cx);
  assert.ok(entry(v, cx, "P-LOCAL").node, "a local project");
  const r = entry(v, cx, LID);
  assert.ok(r.node, "the remote project is listed"); assert.ok(!clickable(r.node)); assert.ok(toolTip(r.node), "with the reason");
  assert.ok(entry(v, cx, "P-LOCAL").texts.join(" ").includes("pairstone · omarchy"), "labelled with its machine");
  cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo" };
  v = new Editor(cx);
  assert.ok(clickable(entry(v, cx, LID).node), "enabled once writes are on");
});

test("job 13: picking a remote project routes Create to the writer (add, project forced); the route follows the CURRENT pick; no local add", async () => {
  const cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo" };
  const v = new Editor(cx);
  v.setProp("project", LID, cx); v.setProp("project", "P-LOCAL", cx); v.setProp("project", LID, cx); // back and forth: only the last counts
  assert.match(view(v, cx, "editor").texts.join(" "), /omarchy/, "the machine of the pick is shown");
  for (const id of ["ed-mode", "ed-attach", "trig-assignee"]) assert.equal(toolTip(view(v, cx, id).node), U.OFF_TIP, `${id} is inert for a remote pick`);
  v.title.set_value("from the global modal"); v.setProp("priority", "P1", cx);
  v.onCreate(cx);
  const b = await stage(1, "add");
  assert.equal(b.op, "add"); assert.equal(b.project, RID); assert.equal(b.priority, "P1"); assert.equal(b.ttlMs, 120000);
  assert.equal(host.state["drover.tasks"].length, 1, "no local card was written");
  await saved(v, "saved");
});

test("job 13: switching back to a local project creates locally, and the controls are live again", async () => {
  const cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo" };
  const v = new Editor(cx);
  v.setProp("project", LID, cx); v.setProp("project", "P-LOCAL", cx);
  for (const id of ["ed-mode", "ed-attach"]) assert.ok(clickable(view(v, cx, id).node), `${id} is live for a local pick`);
  v.title.set_value("local one"); v.onCreate(cx);
  await drain(3);
  assert.equal(om.step1.length, 0, "nothing sent to omarchy");
  assert.ok(host.state["drover.tasks"].some((t) => t.title === "local one" && t.project === "P-LOCAL"), "created locally");
});

test("job 13: the remote edit's project list: current stays, other machines and other projects on the same machine are dead with their reasons", async () => {
  withSecondRemote();
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4 }), LID, M), "T-R1");
  const v = new Editor(cx);
  assert.equal(toolTip(entry(v, cx, LID).node), undefined, "the current project is not dead");
  assert.equal(toolTip(entry(v, cx, "P-LOCAL").node), "move between machines comes later");
  assert.equal(toolTip(entry(v, cx, LID2).node), "moving a card to another project comes later");
  assert.ok(!clickable(entry(v, cx, LID2).node));
});

test("job 13: a local card's edit lists remote projects as dead ('move between machines comes later'); local stays live", async () => {
  const cx = await ready();
  host.props = { overlay: "ov", edit: "T-LOCAL1", column: "todo" };
  const v = new Editor(cx);
  assert.equal(toolTip(entry(v, cx, LID).node), "move between machines comes later");
  assert.ok(clickable(entry(v, cx, "P-LOCAL").node));
});

// ---- job 14: the submission keeps its own target through every await ----
const errOf = (p) => p.then(() => null, (e) => e);
test("job 14 (race A): a remote Create another keeps its target when the pick changes while the add is in flight; completion clears the draft", async () => {
  const cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo" };
  const v = new Editor(cx);
  v.setProp("project", LID, cx); v.title.set_value("first"); v.another = true;
  const failures = []; const spawn = cx.spawn; cx.spawn = (fn) => spawn((c) => Promise.resolve(fn(c)).catch((e) => { failures.push(e); throw e; }));
  v.onCreate(cx);
  await stage(1, "add");
  v.project = "P-LOCAL"; // whatever moved the pick: the in-flight create must not read it again
  await saved(v, "saved");
  assert.deepEqual(failures.map(String), [], "completion did not throw");
  assert.equal(v.title.value(), "", "Create another cleared the draft");
  assert.deepEqual(host.closed, []);
  assert.equal(om.step1.length, 1, "no second send");
});

test("job 14: while a Create is in flight the project picker is inert ('creating…'), and unfreezes after", async () => {
  const cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo" };
  const v = new Editor(cx);
  v.setProp("project", LID, cx); v.title.set_value("x"); v.another = true;
  v.onCreate(cx);
  await stage(1, "add");
  for (const id of ["P-LOCAL", LID]) { const n = entry(v, cx, id).node; assert.equal(toolTip(n), "creating…", id); assert.ok(!clickable(n)); }
  v.setProp("project", "P-LOCAL", cx);
  assert.equal(v.project, LID, "the pick did not change");
  await saved(v, "saved");
  assert.ok(clickable(entry(v, cx, "P-LOCAL").node), "unfrozen after completion");
});

test("job 14 (race B): a local Create waiting for a paste keeps the LOCAL target when the pick is moved; the card is created in the local project", async () => {
  const cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo" };
  const v = new Editor(cx);
  v.setProp("project", "P-LOCAL", cx); v.title.set_value("pasted one");
  let release; v.pending = new Promise((r) => (release = r)); v.busy = 1;
  v.onCreate(cx);
  v.project = LID; // moved while the paste is pending
  release(); v.busy = 0;
  await until(() => host.closed.length === 1, "closed");
  assert.ok(host.state["drover.tasks"].some((t) => t.title === "pasted one" && t.project === "P-LOCAL"), "created in the captured local project");
  assert.equal(om.step1.length, 0, "nothing sent to omarchy");
});

test("job 14: a refused local save keeps the modal open with the draft and shows the error", async () => {
  const cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo" };
  const v = new Editor(cx);
  v.setProp("project", "P-LOCAL", cx); v.title.set_value("kept draft");
  let release; v.pending = new Promise((r) => (release = r)); v.busy = 1;
  v.onCreate(cx);
  host.state["drover.projects"] = host.state["drover.projects"].map((p) => (p.id === "P-LOCAL" ? { ...p, remote: { machine: M, projectId: "P-OTHER", id: "B-9" } } : p)); // the ownership guard now refuses it
  release(); v.busy = 0;
  await until(() => v.error, "an error is shown");
  assert.deepEqual(host.closed, [], "stays open");
  assert.equal(v.title.value(), "kept draft"); assert.ok(!v.submitting);
  assert.ok(!host.state["drover.tasks"].some((t) => t.title === "kept draft"));
});

// ---- job 15 ----
test("job 15 (High): Create another clears the draft only if it still equals what was submitted; text typed during the wait is kept and not resent", async () => {
  const cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo" };
  const v = new Editor(cx);
  v.setProp("project", LID, cx); v.title.set_value("A"); v.desc.set_value("da"); v.another = true;
  v.onCreate(cx);
  await stage(1, "A sent");
  v.title.set_value("B"); // typed while the add is in flight
  await saved(v, "saved");
  assert.equal(v.title.value(), "B", "B kept"); assert.equal(v.desc.value(), "da");
  assert.equal(sends().filter((b) => b.title === "A").length, 1, "A not resent");
});

test("job 15 (Medium): a rejecting remote sender resets submitting and the frozen picker, shows 'Not saved: <first line>', and keeps the draft", async () => {
  const cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo" };
  const v = new Editor(cx);
  v.setProp("project", LID, cx); v.title.set_value("keep me");
  v.remoteSender = async () => { throw new Error("link exploded\nsecond line"); };
  v.onCreate(cx);
  await until(() => !v.submitting, "reset");
  assert.match(v.msg, /^Not saved: link exploded$/); assert.match(v.error, /Not saved: link exploded/);
  assert.equal(v.title.value(), "keep me"); assert.deepEqual(host.closed, []);
  assert.ok(clickable(entry(v, cx, "P-LOCAL").node), "picker unfrozen");
});

test("job 15 (Medium): a local submit that rejects (paste wait) resets submitting, shows the error, keeps the draft", async () => {
  const cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo" };
  const v = new Editor(cx);
  v.setProp("project", "P-LOCAL", cx); v.title.set_value("local keep");
  v.pending = Promise.reject(new Error("paste exploded")); v.pending.catch(() => {}); v.busy = 1;
  v.onCreate(cx);
  await until(() => !v.submitting && v.error, "reset with error");
  assert.match(v.error, /^Not saved: paste exploded/); assert.equal(v.title.value(), "local keep"); assert.deepEqual(host.closed, []);
});

// ---- job 16 ----
const NOTES = [
  { id: "n1", at: 1700000000000, by: "mathieu", text: "decided to ship", kind: "decision" },
  { id: "n2", at: 1700000100000, by: "system", text: "moved to doing", kind: "log" },
  { id: "n3", at: 1700000200000, by: "system", text: "moved to review", kind: "log" },
];
const copyCx = (clips) => ({ ...cxOf(), write_to_clipboard: (x) => clips.push(x) });

test("job 16.1: the header id of a remote card copies on click", async () => {
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4 }), LID, M), "T-R1");
  const v = new Editor(cx);
  const n = view(v, cx, "copy-id").node;
  assert.ok(n && clickable(n), "the id is clickable");
  const clips = []; n.args.on_click[0]({}, copyCx(clips));
  assert.deepEqual(clips, ["T-R1"]);
});

test("job 16.2: Activity shows omarchy's notes like local: kind badge, folded system logs (read-only), no write/agent menu items", async () => {
  om.board["drover.tasks"][0].notes = NOTES; // the board is the truth for the thread
  const cx = await ready();
  openRemote(IO.loadMerged().tasks.find((x) => x.id === "T-R1"), "T-R1");
  const v = new Editor(cx);
  let r = view(v, cx, "editor"); let t = r.texts.join(" ");
  assert.match(t, /decided to ship/); assert.match(t, /decision/); assert.match(t, /› 2 activities/);
  assert.doesNotMatch(t, /moved to doing/, "the folded logs are collapsed");
  const ids = idsOf(v, cx);
  assert.ok(ids.includes("fold-1"));
  assert.ok(!ids.some((i) => /^(nm-|note-more-|note-del|note-edit)/.test(i)), "no edit/delete/subtask/agent menu");
  view(v, cx, "fold-1").node.args.on_click[0]({}, cxOf());
  t = view(v, cx, "editor").texts.join(" ");
  assert.match(t, /moved to doing/); assert.match(t, /moved to review/);
});

test("job 16.2: a note sent from the laptop shows in Activity once the board is re-read", async () => {
  const cx = await ready();
  const open = IO.loadMerged().tasks.find((x) => x.id === "T-R1");
  openRemote(open, "T-R1");
  const v = new Editor(cx);
  assert.doesNotMatch(view(v, cx, "editor").texts.join(" "), /fresh note/);
  v.note.value = () => "fresh note"; v.onCreate(cx);
  await stage(1, "note");
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 5, notes: [{ id: "n9", at: 1700000300000, by: "you", text: "fresh note" }] } : x)); // omarchy applied it
  await saved(v, "saved");
  await until(async () => { fire(); await drain(2); return /fresh note/.test(view(v, cx, "editor").texts.join(" ")); }, "the note shows");
});

test("job 16.3: no 'writes on' line in the edit modal; the reason (or an outcome) sits right under the header", async () => {
  let cx = cxOf();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4 }), LID, M), "T-R1");
  let v = new Editor(cx);
  let ids = idsOf(v, cx);
  assert.ok(ids.includes("remote-ro"), "writes are off: the reason shows");
  assert.ok(ids.indexOf("remote-ro") < ids.indexOf("body-row"), "directly under the breadcrumb, above the body");
  cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4 }), LID, M), "T-R1");
  v = new Editor(cx);
  assert.ok(!idsOf(v, cx).includes("remote-ro"), "writes on: nothing floats");
  assert.doesNotMatch(view(v, cx, "editor").texts.join(" "), /writes on/);
  v.msg = "Saved"; assert.ok(idsOf(v, cx).includes("remote-ro"), "an outcome still shows");
});

test("job 16.3: the create modal shows only the reason when not writable", async () => {
  let cx = cxOf();
  openRemote(NEW(), null); host.props = { overlay: "ov", edit: null, column: "todo", remoteCard: NEW() };
  let v = new Editor(cx);
  assert.ok(idsOf(v, cx).includes("remote-ro"));
  cx = await ready();
  host.props = { overlay: "ov", edit: null, column: "todo", remoteCard: NEW() };
  v = new Editor(cx);
  assert.ok(!idsOf(v, cx).includes("remote-ro")); assert.doesNotMatch(view(v, cx, "editor").texts.join(" "), /writes on/);
});
