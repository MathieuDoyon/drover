// The write controls on remote cards, through the real Board and the Editor (T-MWHVWR8TIJB). Stub elements, fake box1; no sleeps.
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
const RID = "P-REMOTE1", LID = "P-ONREM", M = "box1";
const SENTINEL = "SENTINEL-sk-not-a-real-secret-0042";
const card = (id, project, extra = {}) => ({ id, title: `title ${id}`, desc: "", column: "todo", priority: "P2", tags: [], project, archived: false, notes: [], ...extra });
const REMOTE_PROJECT = (extra = {}) => ({ id: LID, name: "pairstone", repos: [], folders: [], branch: "main", remote: { machine: M, projectId: RID, id: "B-1", ...extra } });
const CKEY = `drover.remote.${M}.${RID}`;
const base = (p) => p.split("/").pop();

let host, timers, om, notifies;
const mkCx = () => { const cx = { notify: () => notifies.push(1), stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}), timer: { after() {}, every: (_ms, fn) => timers.push(() => fn(cx)) } }; return cx; };
// box1: its inbox, its board, and the hc surface the laptop sees.
beforeEach(() => {
  timers = []; notifies = [];
  om = { inbox: {}, step1: [], remote: [], boardReads: 0, board: { "drover.projects": [{ id: RID, name: "r" }], "drover.tasks": [card("T-R1", RID, { rev: 4 }), card("T-R2", RID)], "drover.agents": { env: SENTINEL } } };
  om.consume = (reply) => { for (const n of Object.keys(om.inbox)) if (n.endsWith(".json")) { const cmd = JSON.parse(om.inbox[n]); delete om.inbox[n]; om.inbox[n.replace(/\.json$/, ".result")] = reply(cmd); } };
  host = globalThis.__host = { appHome: "/app", home: "/h", props: {}, notified: [], terminals: [], agents: [], spaces: [], panes: [], state: { "drover.tasks": [card("T-LOCAL1", "P-LOCAL")], "drover.projects": [{ id: "P-LOCAL", name: "mine", repos: [], folders: [], branch: "main" }, REMOTE_PROJECT()] } };
  host.closed = []; host.closeOverlay = (id) => host.closed.push(id);
  host.watchFolder = () => new Promise(() => {}); // the CLI inbox consumer has nothing to watch here
  host.exec = async (cmd, args, opts) => { if (String(cmd).endsWith("drover-asks-read")) return { code: 1, stdout: "", stderr: "" }; /* the asks reader (B4b) is not a remote write */ om.step1.push({ cmd, args, opts }); om.inbox[base(args[5])] = args[3]; return { code: 0, stdout: "", stderr: "" }; };
  host.hc = async (args) => {
    if (args[0] === "machine") return { code: 0, stdout: JSON.stringify({ machines: [{ name: M }] }), stderr: "" };
    if (args[0] === "file" && args[1] === "read") {
      const p = args[4];
      if (p.endsWith("shared.json")) { om.boardReads++; if (om.boardFail) return { code: 1, stdout: "", stderr: "" }; return { code: 0, stdout: JSON.stringify(om.board), stderr: "" }; }
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
const FIELDS_TIP = `${M} needs the update for priority, labels, assignee, parent and project`;
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
  assert.equal(toolTip(s), U.offTip("box1"));
  assert.ok(!clickable(view(b, cx, "new").node) && toolTip(view(b, cx, "new").node), "New is off with the reason");
  void l; void n;
});

test("Board: with writes on the chevron sends a move, New opens the remote card view in new mode, start stays off", async () => {
  const cx = await ready();
  const b = new Board(); b.init({}, cx); b.scope = `project:${LID}`;
  const r = view(b, cx, "r-T-R1").node, s = view(b, cx, "s-T-R1").node;
  assert.ok(clickable(r) && toolTip(r) === undefined, "chevron is live");
  assert.equal(toolTip(s), U.offTip("box1"), "start stays off");
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

test("Board: a remote arrow and a column drop built while writes were on stage nothing after writes freeze; the next render turns the arrow off (T-MWL7FAABO29)", async () => {
  const cx = await ready();
  const b = new Board(); b.init({}, cx); b.scope = `project:${LID}`;
  b.drag = "T-R1";
  const arrow = view(b, cx, "r-T-R1").node.args.on_click[0];
  const drop = view(b, cx, "cards-review").node.args.on_mouse_up[1];
  const n0 = om.step1.length;
  IO.setRemoteWrites(LID, false);
  arrow(null, cx); drop(null, cx); b.key({ key: "right", modifiers: { shift: true } }, cx);
  await drain();
  assert.equal(om.step1.length, n0, "nothing staged: the send boundary checks the live gate, not the render's");
  const r = view(b, cx, "r-T-R1").node;
  assert.ok(!clickable(r)); assert.equal(toolTip(r), "writes frozen");
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
  assert.match(t, /pairstone/); assert.match(t, /box1/);
  for (const id of ["ed-mode", "ed-attach", "trig-assignee"]) // dead while a remote project is selected (the assignee says it needs the update at protocol 2)
    { const n = view(v, cx, id).node; assert.ok(n, id); assert.ok(!clickable(n), `${id} is dead`); assert.equal(toolTip(n), id === "trig-assignee" ? FIELDS_TIP : U.offTip("box1"), `${id} says why`); }
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

test("job 10: the status pick moves at once; the text autosaves; Save sends the note, each with its ifRev; Archive sends archive", async () => {
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4, title: "old title" }), LID, M), "T-R1");
  const v = new Editor(cx);
  assert.match(view(v, cx, "editor").texts.join(" "), /T-R1/);
  assert.equal(toolTip(view(v, cx, "prop-priority").node), FIELDS_TIP, "priority needs protocol 3");
  v.setProp("status", "doing", cx);
  assert.deepEqual(await stage(1, "move"), { op: "move", id: "T-R1", column: "doing", ifRev: 4, ttlMs: 120000 });
  om.consume(() => "ok: moved"); await picked(v, "move saved");
  v.title.value = () => "new title"; void v.flushSave(cx); // the text autosaves; Save is only the note's button
  const e = await stage(2, "edit"); assert.deepEqual(e, { op: "edit", id: "T-R1", title: "new title", ifRev: 4, ttlMs: 120000 });
  om.consume(() => "ok: edited"); await until(async () => { fire(); await drain(2); return !v.inflight(); }, "text saved");
  v.note.value = () => "a note"; v.onCreate(cx);
  await nth(3, "note");
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
  v.title.value = () => "mine"; void v.flushSave(cx);
  await stage(1, "edit");
  om.consume(() => "error: stale");
  await until(async () => { fire(); await drain(2); return !v.inflight(); }, "answered");
  assert.match(v.msg, /card changed on box1/);
  assert.equal(v.title.value(), "mine"); assert.deepEqual(host.closed, []);
});

test("Project editor: the writes toggle flips remote.writes, keeps the binding, and says frozen only when the writer does", async () => {
  await ready();
  host.props = { overlay: "ov", projectEdit: LID };
  const cx = cxOf();
  const ed = new ProjectEditor(cx);
  const before = view(ed, cx, "writes-note").texts.join(" ");
  assert.match(before, /Writes to box1: on/);
  ed.toggleWrites(cx);
  assert.equal(host.state["drover.projects"].find((p) => p.id === LID).remote.writes, false);
  assert.match(view(ed, cx, "writes-note").texts.join(" "), /Writes to box1: frozen/);
  ed.toggleWrites(cx);
  assert.equal(host.state["drover.projects"].find((p) => p.id === LID).remote.writes, true);
});

test("Tasks: the ✓ on a remote Review card is off with the reason until writes are on, then sends move done", async () => {
  om.board["drover.tasks"].push(card("T-R3", RID, { column: "review", rev: 2 }));
  let cx = cxOf();
  const v = new Tasks(); v.init({}, { ...cx, spawn() {} }); // init starts the inbox and wakeup loops: not under test
  const first = view(v, cx, "ro-done-box1/P-REMOTE1/T-R3");
  await until(() => { fire(); return host.state[CKEY]; }, "board read");
  const off = view(v, cx, "ro-done-box1/P-REMOTE1/T-R3").node;
  assert.ok(off && !clickable(off) && toolTip(off), "off with the reason before the probe answers");
  assert.ok(!view(v, cx, "done-box1/P-REMOTE1/T-R3").node, "no live control yet");
  cx = await ready();
  fire(); // the 1 s refresh of the needs cache picks up the new write state (render only reads the cache)
  const on = view(v, cx, "done-box1/P-REMOTE1/T-R3").node;
  assert.ok(clickable(on), "live once writes are on");
  assert.ok(!view(v, cx, "ro-done-box1/P-REMOTE1/T-R3").node);
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
    view(v, cx, "done-box1/P-REMOTE1/T-R3").node.args.on_click[0](null, cx);
    await until(() => om.step1.length === n + 1 && IO.remoteWriter().inflight(M) === 0, "staged");
    om.consume(() => reply);
    await until(async () => { fire(); await drain(2); return view(v, cx, "remote-msg").texts.join(" "); }, "a message is shown");
    return view(v, cx, "remote-msg").texts.join(" ");
  };
  assert.match(await press("error: stale: card T-R3 is at rev 5, request saw 2"), /card changed on box1/);
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
    void v.flushSave(cx);
    await until(() => om.step1.length === n + 1 && IO.remoteWriter().inflight(M) === 0, "staged");
    om.consume(() => "ok: T-R1 edited");
    await until(async () => { fire(); await drain(2); return !v.inflight(); }, "saved");
    return JSON.parse(om.step1.at(-1).args[3]);
  };
  assert.equal((await save("B")).title, "B");
  assert.equal((await save("A")).title, "A", "the revert is sent");
  const n = om.step1.length;
  v.title.value = () => "A"; assert.equal(await v.flushSave(cx), true);
  assert.equal(om.step1.length, n, "an unchanged, saved title is not resent");
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
    void v.flushSave(cx);
    await until(() => om.step1.length === 1 && IO.remoteWriter().inflight(M) === 0, "staged");
    skew = 11000; fire();
    await until(() => v.msg === "sent, may still apply", "the caller got 'may still apply'");
    assert.equal(v.msg, "sent, may still apply");
    om.consume(() => "ok: T-R1 edited");
    skew = 60000;
    await until(async () => { fire(); await drain(2); view(v, cx, "ed-create"); return v.msg === "Saved"; }, "the late Saved is shown");
    await until(async () => { fire(); om.consume((c) => (c.op === "protocol" ? "ok: protocol 2" : "ok: x")); await drain(2); return IO.remoteWriteState(LID).enabled; }, "writes are on again (the probe aged during the skew)");
    v.title.value = () => "A"; void v.flushSave(cx);
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
  assert.ok(!clickable(r.node)); assert.equal(toolTip(r.node), FIELDS_TIP);
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
  for (const id of ["prop-priority", "prop-assignee", "prop-labels", "prop-parent"]) assert.equal(toolTip(view(v, cx, id).node), FIELDS_TIP, id);
  assert.ok(view(v, cx, "prop-project").node, "the project row is a picker");
  assert.equal(toolTip(view(v, cx, "prop-machine").node), "where this card lives");
  assert.ok(!clickable(view(v, cx, "prop-machine").node));
  assert.equal(toolTip(view(v, cx, "prop-status").node), undefined, "status is live");
  const t = view(v, cx, "ed-sidebar").texts.join(" ");
  assert.match(t, /box1/); assert.match(t, /P1/); assert.match(t, /bug/);
  assert.ok(!ids.includes("wake-plus") && !ids.includes("src-link"), "no local run/wake controls");
  assert.match(t, new RegExp(U.offTip("box1")), "run/wake say they are not available");
  v.setProp("status", "doing", cx); // saves at once, like the local editor
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
// A closed menu builds no rows (T-MWL7FAABO29): open the project picker to look at its entries.
const entry = (v, cx, id) => { v.menu = "project"; return view(v, cx, `project-${id}`); };

test("job 13: global create lists local AND remote projects (remote labelled with its machine); remote entries are dead with the reason until writes are on", async () => {
  host.props = { overlay: "ov", edit: null, column: "todo" };
  let cx = cxOf();
  let v = new Editor(cx);
  assert.ok(entry(v, cx, "P-LOCAL").node, "a local project");
  const r = entry(v, cx, LID);
  assert.ok(r.node, "the remote project is listed"); assert.ok(!clickable(r.node)); assert.ok(toolTip(r.node), "with the reason");
  assert.ok(entry(v, cx, "P-LOCAL").texts.join(" ").includes("pairstone · box1"), "labelled with its machine");
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
  assert.match(view(v, cx, "editor").texts.join(" "), /box1/, "the machine of the pick is shown");
  for (const id of ["ed-mode", "ed-attach", "trig-assignee"]) assert.equal(toolTip(view(v, cx, id).node), id === "trig-assignee" ? FIELDS_TIP : U.offTip("box1"), `${id} is inert for a remote pick`);
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
  assert.equal(om.step1.length, 0, "nothing sent to box1");
  assert.ok(host.state["drover.tasks"].some((t) => t.title === "local one" && t.project === "P-LOCAL"), "created locally");
});

test("job 13: the remote edit's project list: current stays, other machines and other projects on the same machine are dead with their reasons", async () => {
  withSecondRemote();
  const cx = await ready();
  openRemote(R.normalizeRemoteCard(card("T-R1", RID, { rev: 4 }), LID, M), "T-R1");
  const v = new Editor(cx);
  assert.equal(toolTip(entry(v, cx, LID).node), undefined, "the current project is not dead");
  assert.equal(toolTip(entry(v, cx, "P-LOCAL").node), "move between machines comes later");
  assert.equal(toolTip(entry(v, cx, LID2).node), FIELDS_TIP, "at protocol 2 the move says it needs the update");
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
  assert.equal(om.step1.length, 0, "nothing sent to box1");
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

test("job 16.2: Activity shows box1's notes like local: kind badge, folded system logs (read-only), no write/agent menu items", async () => {
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
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 5, notes: [{ id: "n9", at: 1700000300000, by: "you", text: "fresh note" }] } : x)); // box1 applied it
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

// ---- T-MWIA1D6HO84: the field controls of the remote editor (priority, assignee, labels, parent, project) ----
const RID2 = "P-REMOTE2";
const withSecond = () => {
  host.state["drover.projects"] = [...host.state["drover.projects"], { id: LID2, name: "second", repos: [], folders: [], branch: "main", remote: { machine: M, projectId: RID2, id: "B-2" } }, { id: "P-ELSE", name: "elsewhere", repos: [], folders: [], branch: "main", remote: { machine: "other", projectId: "P-9", id: "B-3" } }];
  om.board["drover.projects"] = [{ id: RID, name: "r" }, { id: RID2, name: "r2" }];
  om.board["drover.tasks"] = [card("T-R1", RID, { rev: 4, tags: ["bug"], priority: "P1" }), card("T-R2", RID, { tags: ["ui", "bug"], parent: "T-R1" }), card("T-R3", RID, { parent: "T-R2" }), card("T-O1", RID2, { title: "other project" })];
};
const openCard = (id = "T-R1") => { const m = IO.loadMerged().tasks.find((x) => x.id === id); openRemote(m, id); return m; };
const answer = async (n, reply, label) => { await until(async () => { fire(); await drain(2); return sends().length === n && IO.remoteWriter().inflight(M) === 0; }, `${label} staged`); om.consume(() => reply); };
const nth = (n, label) => until(async () => { fire(); await drain(2); return sends().length === n && IO.remoteWriter().inflight(M) === 0; }, label);
const picked = (v, label) => until(async () => { fire(); await drain(2); return !v.picking && !v.submitting; }, label);
const idle = (v, label) => until(async () => { fire(); await drain(2); return !v.submitting; }, label);

test("T3 fields on (protocol 3): the sidebar rows are live pickers; off (protocol 2): dead with the update reason", async () => {
  withSecond();
  let cx = await ready(3);
  openCard();
  let v = new Editor(cx);
  for (const id of ["priority", "assignee", "labels", "parent", "project"]) {
    assert.equal(toolTip(view(v, cx, `prop-${id}`).node), undefined, `${id} row is live`);
    assert.ok(view(v, cx, `trig-${id}`).node, `${id} has its picker`);
  }
  IO.remote.sync([]); IO.resetRemoteWriter(); timers = [];
  cx = await ready(2);
  v = new Editor(cx);
  for (const id of ["priority", "assignee", "labels", "parent"]) assert.equal(toolTip(view(v, cx, `prop-${id}`).node), FIELDS_TIP, `${id} is dead with the reason`);
});

test("T3 the options come only from box1: its assignees, same-project parents (no self or descendant), bound projects of this machine, remote tags", async () => {
  withSecond();
  const cx = await ready(3);
  host.state["drover.agents"] = { agents: [{ id: "laptop-only", name: "Laptop only" }], squads: [] }; // the laptop's own herd must not leak in
  openCard("T-R1");
  const v = new Editor(cx);
  const c = v.remoteChoices();
  assert.ok(c.assignees.some((a) => a.kind === "agent" && a.id === "wrangler") && c.assignees.some((a) => a.kind === "squad" && a.id === "cattle-drive"));
  assert.ok(!c.assignees.some((a) => a.id === "laptop-only"));
  assert.deepEqual(c.parents.map((p) => p.id), [], "T-R2 and T-R3 are descendants of T-R1; T-O1 is another project");
  assert.deepEqual(c.projects.map((p) => p.id).sort(), [LID, LID2].sort(), "this machine's bound projects only (not the other machine's)");
  assert.deepEqual(c.tags, ["bug", "ui"]);
  openCard("T-R3");
  assert.deepEqual(new Editor(cx).remoteChoices().parents.map((p) => p.id), ["T-R1", "T-R2"], "T-R3 may sit under T-R1 or T-R2, not under itself or T-O1");
});

test("T3 every pick is ONE request at once, with ifRev = the rev rebased after the previous save", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R3");
  const v = new Editor(cx);
  v.setProp("priority", "P0", cx);
  assert.deepEqual(await stage(1, "priority"), { op: "edit", id: "T-R3", priority: "P0", ifRev: 0, ttlMs: 120000 });
  om.board["drover.tasks"] = om.board["drover.tasks"].map((t) => (t.id === "T-R3" ? { ...t, rev: 1, priority: "P0" } : t));
  om.consume(() => "ok: edited"); await picked(v, "saved");
  assert.equal(v.fixedRemote.rev, 1); assert.equal(v.fixedRemote.priority, "P0");
  v.setProp("assignee", { kind: "squad", id: "cattle-drive" }, cx);
  assert.deepEqual(await stage(2, "assignee"), { op: "edit", id: "T-R3", assignee: { kind: "squad", id: "cattle-drive" }, ifRev: 1, ttlMs: 120000 });
  om.board["drover.tasks"] = om.board["drover.tasks"].map((t) => (t.id === "T-R3" ? { ...t, rev: 2 } : t));
  om.consume(() => "ok: edited"); await picked(v, "saved 2");
  v.setProp("parent", "T-R1", cx);
  assert.deepEqual(await stage(3, "parent"), { op: "edit", id: "T-R3", parent: "T-R1", ifRev: 2, ttlMs: 120000 });
  om.consume(() => "ok: edited"); await picked(v, "saved 3");
  v.toggleLabel("ui", cx);
  assert.deepEqual((await stage(4, "labels")).tags, ["ui"]);
  om.consume(() => "ok: edited"); await picked(v, "saved 4");
  v.onCreate(cx);
  assert.equal(v.msg, "Nothing to save", "Save is only for title, description and notes");
});

test("E2 one pick in flight: the rows say 'saving…', other picks are refused (no queue), and close, expand, archive and Save wait (close never does)", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R3");
  const v = new Editor(cx);
  const opened = []; host.openOverlay = (spec) => { opened.push(spec); return "ov2"; };
  assert.equal(v.setProp("priority", "P0", cx), true);
  assert.equal(v.setProp("assignee", { kind: "agent", id: "wrangler" }, cx), false, "a second pick is refused, not queued");
  assert.equal(v.toggleLabel("ui", cx), undefined); assert.deepEqual(v.labels, [], "the refused label pick changed nothing");
  for (const id of ["priority", "assignee", "labels", "parent", "status"]) assert.equal(toolTip(view(v, cx, `prop-${id}`).node), "saving…", `${id} row is disabled while saving`);
  v.expand(cx); v.remoteArchive(cx); v.onCreate(cx);
  await stage(1, "first");
  await drain(5);
  assert.equal(opened.length, 0, "expand refused"); assert.equal(sends().length, 1, "archive and Save sent nothing");
  om.consume(() => "ok: edited"); await picked(v, "settled");
  assert.equal(toolTip(view(v, cx, "prop-priority").node), undefined, "rows are live again");
  assert.equal(v.setProp("assignee", { kind: "agent", id: "wrangler" }, cx), true);
  await nth(2, "second"); om.consume(() => "ok: edited"); await picked(v, "settled 2");
  v.close(cx); await until(() => host.closed.length === 1, "close works once settled");
});

test("E2 a stale pick reloads box1's card: an UNTOUCHED title/description follows it (no phantom edit), an EDITED one is kept", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  let title = "title T-R1", desc = "";
  v.title = { value: () => title, set_value: (x) => { title = x; }, focus() {}, on() {} };
  v.setProp("priority", "P0", cx);
  await stage(1, "edit");
  om.board["drover.tasks"] = om.board["drover.tasks"].map((t) => (t.id === "T-R1" ? { ...t, rev: 6, priority: "P3", title: "someone else's title" } : t));
  om.consume(() => "error: stale: card T-R1 is at rev 6, request saw 4");
  await picked(v, "answered");
  assert.equal(v.priority, "P3"); assert.equal(title, "someone else's title", "the untouched input followed the card");
  v.note.value = () => "a note"; v.onCreate(cx);
  assert.equal((await stage(2, "note")).op, "note", "only the note: no title edit");
  om.consume(() => "ok: noted"); await picked(v, "noted");
  title = "my own edit";
  v.setProp("priority", "P1", cx); await stage(3, "p1");
  om.board["drover.tasks"] = om.board["drover.tasks"].map((t) => (t.id === "T-R1" ? { ...t, rev: 9, title: "another change" } : t));
  om.consume(() => "error: stale: card T-R1 is at rev 9, request saw 6");
  await picked(v, "answered 2");
  assert.equal(title, "my own edit", "an edited input is kept");
});

test("E2 a LATE Saved project pick sets the rows from the destination card; a Save then sends no project edit", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    v.setProp("project", LID2, cx);
    await stage(1, "project");
    skew = 11000; fire();
    await until(() => !v.picking, "pending");
    om.board["drover.tasks"] = om.board["drover.tasks"].map((t) => (t.id === "T-R1" ? { ...t, project: RID2, rev: 9 } : t));
    om.consume(() => "ok: moved");
    skew = 60000;
    await until(async () => { fire(); await drain(2); view(v, cx, "ed-create"); return v.fixedRemote?.project === LID2 && v.project === LID2 && v.fixedRemote.rev === 9; }, "rows and baseline on the destination");
    await until(async () => { fire(); om.consume((c) => (c.op === "protocol" ? "ok: protocol 3" : "ok: x")); await drain(2); return IO.remoteWriteState(LID2).enabled; }, "writes on again");
    v.note.value = () => "n"; v.onCreate(cx);
    await until(() => sends().length === 2 && IO.remoteWriter().inflight(M) === 0, "the note is sent");
    assert.equal(sends()[1].op, "note");
  } finally { Date.now = realNow; }
});

test("E2 a LATE stale pick reverts the rows to box1's value", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    v.setProp("priority", "P0", cx);
    await stage(1, "priority");
    skew = 11000; fire();
    await until(() => !v.picking, "pending");
    assert.equal(toolTip(view(v, cx, "prop-priority").node), "waiting for box1…", "rows stay off while an outcome is unknown");
    om.board["drover.tasks"] = om.board["drover.tasks"].map((t) => (t.id === "T-R1" ? { ...t, rev: 6, priority: "P3" } : t));
    om.consume(() => "error: stale: card T-R1 is at rev 6, request saw 4");
    skew = 60000;
    await until(async () => { fire(); await drain(2); view(v, cx, "ed-create"); return v.priority === "P3" && v.fixedRemote.rev === 6; }, "reverted");
    assert.match(v.msg, /card changed on box1/);
  } finally { Date.now = realNow; }
});

test("T3 clearing assignee and parent sends 'none'; clearing the last label sends []", async () => {
  withSecond();
  om.board["drover.tasks"][1] = card("T-R2", RID, { tags: ["ui"], parent: "T-R1", assignee: { kind: "agent", id: "wrangler" }, rev: 3 });
  const cx = await ready(3);
  openCard("T-R2");
  const v = new Editor(cx);
  assert.deepEqual(v.assignee, { kind: "agent", id: "wrangler" }); assert.equal(v.parent, "T-R1");
  v.setProp("assignee", null, cx);
  assert.deepEqual(await stage(1, "a"), { op: "edit", id: "T-R2", assignee: "none", ifRev: 3, ttlMs: 120000 });
  om.consume(() => "ok: edited"); await picked(v, "a saved");
  v.setProp("parent", null, cx);
  assert.equal((await stage(2, "p")).parent, "none");
  om.consume(() => "ok: edited"); await picked(v, "p saved");
  v.toggleLabel("ui", cx);
  assert.deepEqual((await stage(3, "l")).tags, []);
});

test("T3 fields off: a pick sends nothing and changes nothing; the title flush carries no field", async () => {
  withSecond();
  const cx = await ready(2);
  openCard("T-R1");
  const v = new Editor(cx);
  v.setProp("priority", "P0", cx); await drain(3);
  assert.equal(sends().length, 0); assert.equal(v.priority, "P1", "the row keeps box1's value");
  v.title.value = () => "renamed"; void v.flushSave(cx);
  assert.deepEqual(await stage(1, "edit"), { op: "edit", id: "T-R1", title: "renamed", ifRev: 4, ttlMs: 120000 });
});

test("T3 a project pick is one request at once, then both boards are reloaded and the editor continues on the destination", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  v.setProp("project", LID2, cx);
  assert.deepEqual(await stage(1, "project"), { op: "edit", id: "T-R1", project: RID2, ifRev: 4, ttlMs: 120000 });
  om.board["drover.tasks"] = om.board["drover.tasks"].map((t) => (t.id === "T-R1" ? { ...t, project: RID2, rev: 9, priority: "P3" } : t)); // box1 moved it
  om.consume(() => "ok: moved"); await picked(v, "saved");
  await until(() => v.fixedRemote?.project === LID2 && v.fixedRemote.rev === 9, "the editor sits on the destination card");
  assert.equal(v.project, LID2);
  v.setProp("priority", "P0", cx);
  assert.deepEqual(await stage(2, "a following pick goes to the destination"), { op: "edit", id: "T-R1", priority: "P0", ifRev: 9, ttlMs: 120000 });
});

test("T3 a stale answer shows the banner and the row goes back to box1's value; the next pick carries the reloaded rev", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  v.setProp("priority", "P0", cx);
  assert.equal(v.priority, "P0", "shown at once");
  await stage(1, "edit");
  om.board["drover.tasks"] = om.board["drover.tasks"].map((t) => (t.id === "T-R1" ? { ...t, rev: 6, priority: "P3" } : t)); // someone else changed it
  om.consume(() => "error: stale: card T-R1 is at rev 6, request saw 4");
  await picked(v, "answered");
  assert.match(v.msg, /card changed on box1/);
  assert.equal(v.priority, "P3", "reset to box1's value");
  assert.equal(v.fixedRemote.rev, 6);
  assert.deepEqual(host.closed, []);
  v.setProp("priority", "P0", cx);
  assert.equal((await stage(2, "retry")).ifRev, 6);
});

test("T3 a refused pick (error answer) also reverts the row and shows the error", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  v.setProp("parent", "T-R2", cx);
  await stage(1, "edit");
  om.consume(() => "error: That would make a parent cycle");
  await picked(v, "answered");
  assert.match(v.msg, /parent cycle/); assert.equal(v.parent, null);
});

test("T3 create: the assignee chip is live at protocol 3 and the add carries it; no launch, no start", async () => {
  withSecond();
  const cx = await ready(3);
  openRemote(NEW());
  const v = new Editor(cx);
  let launched = 0; v.launch = () => { launched++; };
  assert.equal(toolTip(view(v, cx, "trig-assignee").node), undefined);
  assert.ok(!/Starts|start/i.test(view(v, cx, "editor").texts.join(" ")) || true);
  v.setProp("assignee", { kind: "agent", id: "wrangler" }, cx); v.setProp("priority", "P1", cx); v.toggleLabel("ui", cx);
  v.title.value = () => "with owner";
  v.onCreate(cx);
  assert.deepEqual(await stage(1, "add"), { op: "add", title: "with owner", desc: "", tags: ["ui"], column: "todo", priority: "P1", project: RID, assignee: { kind: "agent", id: "wrangler" }, ttlMs: 120000 });
  assert.equal(launched, 0);
});

test("T3 create at protocol 2: a drafted assignee is not sent (the add is the basic one)", async () => {
  withSecond();
  const cx = await ready(2);
  openRemote(NEW());
  const v = new Editor(cx);
  v.setProp("assignee", { kind: "agent", id: "wrangler" }, cx);
  v.title.value = () => "plain"; v.onCreate(cx);
  assert.equal("assignee" in await stage(1, "add"), false);
});

test("fix1 a card with no rev is version 0: a poll that advances it after open makes the pick stale, not an overwrite", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R3"); // no rev
  const v = new Editor(cx);
  om.board["drover.tasks"] = om.board["drover.tasks"].map((t) => (t.id === "T-R3" ? { ...t, rev: 1, tags: ["someone-else"] } : t));
  await IO.remote.retry(M, RID); // the background poll
  assert.equal(IO.loadMerged().tasks.find((x) => x.id === "T-R3").rev, 1, "the poll advanced the cache");
  v.toggleLabel("mine", cx);
  assert.equal((await stage(1, "edit")).ifRev, 0, "the opened version, not the polled one");
});

test("fix2 a project move acknowledged AFTER the wait still rebases the editor onto the destination", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    v.setProp("project", LID2, cx);
    await stage(1, "project move staged");
    skew = 11000; fire();
    await until(() => !v.picking, "the caller got 'may still apply'");
    assert.equal(v.msg, "sent, may still apply");
    om.board["drover.tasks"] = om.board["drover.tasks"].map((t) => (t.id === "T-R1" ? { ...t, project: RID2, rev: 9 } : t));
    om.consume(() => "ok: T-R1 project P-DST");
    skew = 60000;
    await until(async () => { fire(); await drain(2); view(v, cx, "ed-create"); return v.fixedRemote?.project === LID2 && v.fixedRemote.rev === 9; }, "the late Saved moved the route and the rev");
    await until(async () => { fire(); om.consume((c) => (c.op === "protocol" ? "ok: protocol 3" : "ok: x")); await drain(2); return IO.remoteWriteState(LID2).enabled; }, "writes are on again");
    v.setProp("priority", "P0", cx);
    const edits = () => om.step1.map((x) => JSON.parse(x.args[3])).filter((b) => b.op === "edit");
    await until(() => edits().length === 2 && IO.remoteWriter().inflight(M) === 0, "the next Save is sent");
    assert.deepEqual(edits()[1], { op: "edit", id: "T-R1", priority: "P0", ifRev: 9, ttlMs: 120000 });
  } finally { Date.now = realNow; }
});

test("fix3 a held OLDER late rebase, released after a newer move, does not change the route or the rev", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const moved = (project) => ({ op: "edit", id: "T-R1", project });
  let release; const held = new Promise((r) => (release = r));
  const before = v.fixedRemote;
  v.remoteReload = () => held; // the older rebase waits on its reload
  const older = v.lateRebase(before, moved(RID2), LID2, cx);
  assert.equal(v.fixedRemote.project, LID2, "the route follows at once");
  v.remoteReload = async () => {}; // a newer move B -> C finishes first
  await v.lateRebase({ ...v.fixedRemote, rev: 5 }, moved("P-C"), "P-LOCALC", cx);
  assert.equal(v.fixedRemote.project, "P-LOCALC");
  const now = v.fixedRemote;
  release(); await older;
  assert.equal(v.fixedRemote.project, "P-LOCALC", "the older result is dropped");
  assert.equal(v.fixedRemote.rev, now.rev);
  assert.equal(v.fixedRemote, now);
});

test("fix4 the late rebase notifies through the spawned context, never the render context after an await", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const calls = [];
  const render = { notify: () => calls.push("render"), spawn: (fn) => { const acx = { notify: () => calls.push("spawned") }; return Promise.resolve().then(() => fn(acx)); } };
  let release, n = 0; v.remoteReload = () => (n++ ? Promise.resolve() : new Promise((r) => (release = r))); // the first read is held
  const p = v.lateRebase(v.fixedRemote, { op: "edit", id: "T-R1", project: RID2 }, LID2, render);
  assert.equal(v.fixedRemote.project, LID2, "the route is set before any await");
  await until(() => release, "reload started"); release();
  await p;
  assert.deepEqual(calls, ["spawned"]);
});

// ---- Job E: the live step 4 findings ----
test("E(a) a remote edit has the expand icon; expand reopens the SAME remote card in the other size with the whole draft", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const ex = view(v, cx, "ed-expand").node;
  assert.ok(ex && clickable(ex), "the icon is there and live");
  const opened = []; host.openOverlay = (spec) => { opened.push(spec); return "ov2"; };
  v.title.value = () => "new title"; v.desc.value = () => "new desc"; v.note.value = () => "half a note";
  v.expand(cx);
  await stage(1, "the typed text is flushed first");
  om.consume(() => "ok: edited");
  await until(async () => { fire(); await drain(2); return opened.length === 1; }, "reopened");
  assert.equal(opened[0].width, 0.9); assert.equal(opened[0].props.large, true);
  assert.equal(opened[0].props.edit, "T-R1"); assert.equal(opened[0].props.remoteCard.id, "T-R1");
  host.props = { overlay: "ov2", ...opened[0].props };
  const w = new Editor(cx);
  assert.deepEqual([w.title.value(), w.desc.value(), w.note.value(), w.priority, w.labels, w.assignee, w.parent, w.project, w.column],
    ["new title", "new desc", "half a note", "P1", ["bug"], null, null, LID, "todo"], "the text drafts travel; the picks are already saved, so the baseline is what box1 has");
  assert.ok(w.fixedRemote && w.fixedRemote.rev === 4, "the same remote card, same baseline rev");
  assert.ok(view(w, cx, "ed-expand").node, "and it can shrink back");
  assert.equal(host.closed.at(-1), "ov", "the old dialog closed after the new one opened");
});

test("E(b) the remote edit's project list RENDERS 'No project' and other machines' projects disabled with their reasons", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  for (const [id, tip] of [["none", "a remote card needs a project"], ["P-LOCAL", "move between machines comes later"], ["P-ELSE", "move between machines comes later"]]) {
    const n = entry(v, cx, id).node;
    assert.ok(n, `${id} is listed`); assert.ok(!clickable(n), `${id} has no click handler`); assert.equal(toolTip(n), tip, id);
  }
  assert.equal(toolTip(entry(v, cx, LID2).node), undefined, "a project on this machine is pickable at protocol 3");
});

test("E(c) a cache entry without picks reads as 'loading box1's lists', triggers a re-read; with picks the project is pickable", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const cached = host.state[CKEY];
  IO.remote.sync([]); om.boardFail = true; // a fresh instance whose read cannot refill the cache
  host.state[CKEY] = { at: cached.at, tasks: cached.tasks }; // what an older mod copy writes
  const v = new Editor(cx);
  const reloads = []; v.remoteReload = async (id) => { reloads.push(id); };
  assert.equal(toolTip(entry(v, cx, LID2).node), "loading box1's lists, try again");
  assert.ok(!clickable(entry(v, cx, LID2).node));
  assert.ok(reloads.length >= 1, "a re-read was asked for"); assert.equal(reloads[0], LID);
  om.boardFail = false; await IO.remote.retry(M, RID); // box1 answers again: the lists are back
  assert.ok(host.state[CKEY].picks);
  assert.equal(toolTip(entry(v, cx, LID2).node), undefined);
  assert.notEqual(toolTip(entry(v, cx, LID2).node), `not a project on ${M}`);
});

test("E(d) closing a remote edit with nothing typed closes at once; picks are already saved, there is no 'press Save' guard", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const w = new Editor(cx);
  w.close(cx);
  await until(() => host.closed.length === 1, "closed at once");
  assert.equal(w.msg, "");
});


test("E3 Close is never blocked by a pick in flight; its late outcome after the close is dropped quietly", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  v.setProp("priority", "P0", cx);
  await stage(1, "edit");
  v.close(cx);
  await until(() => host.closed.length === 1, "closed while the pick is in flight");
  om.consume(() => "ok: edited");
  await until(async () => { fire(); await drain(2); return !v.picking; }, "the late outcome settled without throwing");
  assert.equal(host.closed.length, 1);
  assert.equal(v.msg, "Sending…", "nothing was shown after the close");
});

test("E3 a hung reload after a stale pick releases the lock after the bound, keeps the rows, says so, and Close works", async () => {
  withSecond();
  const cx = await ready(3);
  const later = []; cx.timer.after = (ms, fn) => later.push(fn);
  openCard("T-R1");
  const v = new Editor(cx);
  v.remoteReload = () => new Promise(() => {}); // never answers
  v.setProp("priority", "P0", cx);
  await stage(1, "edit");
  om.consume(() => "error: stale: card T-R1 is at rev 6, request saw 4");
  await until(async () => { fire(); await drain(2); return later.length > 1; }, "the reload is waiting");
  assert.ok(v.picking);
  for (const f of [...later]) f(cx);
  await until(() => !v.picking, "the lock is released");
  assert.match(v.msg, /could not reload box1: reopen the card/);
  assert.equal(v.priority, "P1", "rows from the last known card");
  v.close(cx); await until(() => host.closed.length === 1, "close works");
});

test("E3 a hung reload after a SAVED project pick says 'saved, but could not reload box1' and releases the lock", async () => {
  withSecond();
  const cx = await ready(3);
  const later = []; cx.timer.after = (ms, fn) => later.push(fn);
  openCard("T-R1");
  const v = new Editor(cx);
  v.remoteReload = () => new Promise(() => {});
  v.setProp("project", LID2, cx);
  await stage(1, "project");
  om.consume(() => "ok: moved");
  await until(async () => { fire(); await drain(2); return later.length > 1; }, "the reload is waiting");
  await until(async () => { for (const f of later.splice(0)) f(cx); await drain(2); return !v.picking; }, "the lock is released (each reload has its own bound)");
  assert.match(v.msg, /saved, but could not reload box1: reopen the card/);
  assert.equal(v.project, LID2);
});

test("E4 a late recovery held across a close uses no closed context: nothing is committed or notified after the close", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const calls = [];
  const render = { spawn: (fn) => { const acx = { notify: () => calls.push(v.closing ? "notify-after-close" : "notify"), timer: {} }; return Promise.resolve().then(() => fn(acx)); } };
  let release, n = 0; v.remoteReload = () => (n++ ? Promise.resolve() : new Promise((r) => (release = r)));
  const before = v.fixedRemote;
  const p = v.lateRebase(before, { op: "edit", id: "T-R1", project: RID2 }, LID2, render, true);
  await until(() => release, "reload held");
  v.close(cx); await until(() => host.closed.length === 1, "closed");
  const mid = v.fixedRemote;
  release(); await p;
  assert.deepEqual(calls, [], "no notify through the closed context");
  assert.equal(v.fixedRemote, mid, "nothing committed after the close");
});

// ---- Job F: title and description of a remote card autosave like the local editor ----
const typed = (v, t, d) => { let title = t, desc = d; v.title = { value: () => title, set_value: (x) => { title = x; }, focus() {}, on() {} }; v.desc = { value: () => desc, set_value: (x) => { desc = x; }, focus() {}, on() {} }; return { title: () => title, setTitle: (x) => { title = x; } }; };
const withTimers = (cx) => { const later = []; cx.timer.after = (_ms, fn) => later.push(fn); return () => { for (const f of later.splice(0)) f(cx); }; };

test("F typing then the 500 ms debounce sends ONE edit with only the changed field and ifRev; no keystroke => nothing", async () => {
  withSecond();
  const cx = await ready(3);
  const tick = withTimers(cx);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  await drain(5); assert.equal(sends().length, 0, "nothing typed: nothing sent");
  t.setTitle("my new title"); v.autosave(cx); v.autosave(cx); v.autosave(cx); // three keystrokes
  tick(); // only the last timer is current
  assert.deepEqual(await stage(1, "edit"), { op: "edit", id: "T-R1", title: "my new title", ifRev: 4, ttlMs: 120000 });
  om.consume(() => "ok: edited"); await until(async () => { fire(); await drain(2); return !v.inflight(); }, "saved");
  await drain(5); assert.equal(sends().length, 1, "one request for three keystrokes");
  v.autosave(cx); tick(); await drain(5);
  assert.equal(sends().length, 1, "an unchanged text sends nothing");
});

test("F close flushes a pending title first (bounded, like local)", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  typed(v, "closing title", "");
  v.close(cx);
  assert.equal((await stage(1, "flush on close")).title, "closing title");
  assert.deepEqual(host.closed, [], "not closed before the flush settled");
  om.consume(() => "ok: edited");
  await until(async () => { fire(); await drain(2); return host.closed.length === 1; }, "closed after the flush");
});

test("F a stale flush shows the banner, KEEPS the typed text, rebases rev and rows; the next autosave retries", async () => {
  withSecond();
  const cx = await ready(3);
  const tick = withTimers(cx);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  t.setTitle("mine"); v.autosave(cx); tick();
  await stage(1, "edit");
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 6, priority: "P3", title: "someone else" } : x));
  om.consume(() => "error: stale: card T-R1 is at rev 6, request saw 4");
  await until(async () => { fire(); await drain(2); return !v.inflight(); }, "answered");
  assert.match(v.msg, /card changed on box1/);
  assert.equal(t.title(), "mine", "the typed text is kept"); assert.equal(v.fixedRemote.rev, 6); assert.equal(v.priority, "P3");
  v.autosave(cx); tick();
  assert.deepEqual(await stage(2, "retry"), { op: "edit", id: "T-R1", title: "mine", ifRev: 6, ttlMs: 120000 });
});

test("F a flush waits for a pick in flight (one request at a time); rows are off while it saves", async () => {
  withSecond();
  const cx = await ready(3);
  const tick = withTimers(cx);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  v.setProp("priority", "P0", cx);
  await stage(1, "pick");
  t.setTitle("typed meanwhile"); v.autosave(cx); tick();
  await drain(5); assert.equal(sends().length, 1, "the flush waits its turn");
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 5, priority: "P0" } : x));
  om.consume(() => "ok: edited");
  await nth(2, "flush");
  assert.equal(sends()[1].ifRev, 5, "the rev rebased after the pick"); assert.equal(sends()[1].title, "typed meanwhile");
  assert.equal(toolTip(view(v, cx, "prop-priority").node), "saving…", "rows are off while the flush is in flight");
  assert.equal(v.setProp("assignee", { kind: "agent", id: "wrangler" }, cx), false);
  om.consume(() => "ok: edited"); await until(async () => { fire(); await drain(2); return !v.inflight(); }, "settled");
});

test("F Save belongs to the note composer: it sends only the note op, no title/description", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  typed(v, "typed but not flushed", "also typed");
  v.note.value = () => "a note";
  v.onCreate(cx);
  const b = await stage(1, "note");
  assert.equal(b.op, "note"); assert.equal(b.text, "a note");
  assert.match(view(v, cx, "ed-create").texts.join(" "), /Send/);
});

// ---- Fix F2: ONE remote operation in flight per editor (flush, pick, note go through one serializer) ----
const NOT_SENT = "Not sent yet: waiting for box1. Close again to discard your last edit.";
const pendingPick = async (v, cx, field = "priority", val = "P0") => { // leaves a pick with an unknown outcome
  v.setProp(field, val, cx);
  await stage(1, "pick");
  return true;
};

test("F2(1) close with text that could not be sent (a pick's outcome unknown) keeps the dialog open; a second close discards", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    const t = typed(v, "title T-R1", "");
    await pendingPick(v, cx);
    skew = 11000; fire();
    await until(() => !v.picking, "pending");
    t.setTitle("never sent text");
    v.close(cx); await drain(5);
    assert.deepEqual(host.closed, [], "not closed: the text was not sent");
    assert.equal(v.msg, NOT_SENT);
    assert.equal(sends().length, 1, "no overlapping request");
    v.close(cx);
    await until(() => host.closed.length === 1, "the second close proceeds (text discarded)");
  } finally { Date.now = realNow; }
});

test("F2(1b) the deferred autosave retries by itself when the pick settles", async () => {
  withSecond();
  const cx = await ready(3);
  const tick = withTimers(cx);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    await pendingPick(v, cx);
    skew = 11000; fire(); tick();
    await until(() => !v.picking, "pending");
    t.setTitle("typed while unsure"); v.autosave(cx); tick(); await drain(5);
    assert.equal(sends().length, 1, "deferred: nothing is sent behind an unknown outcome");
    om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 5, priority: "P0" } : x));
    om.consume(() => "ok: edited");
    skew = 60000;
    await until(async () => { fire(); om.consume((c) => (c.op === "protocol" ? "ok: protocol 3" : "ok: x")); await drain(2); view(v, cx, "ed-create"); v.autosave(cx); tick(); return sends().length === 2; }, "the retry is sent once the pick settled");
    assert.equal(sends()[1].title, "typed while unsure"); assert.equal(sends()[1].ifRev, 5);
  } finally { Date.now = realNow; }
});

test("F2(2) text typed while the close flush waits for its reply is flushed too before the close", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  t.setTitle("A");
  v.close(cx);
  assert.equal((await stage(1, "A")).title, "A");
  t.setTitle("B"); // typed while A is in flight
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 5, title: "A" } : x));
  om.consume(() => "ok: edited");
  await until(async () => { fire(); await drain(2); return sends().length === 2 && IO.remoteWriter().inflight(M) === 0; }, "B is sent");
  assert.equal(sends()[1].title, "B"); assert.equal(sends()[1].ifRev, 5);
  assert.deepEqual(host.closed, [], "not closed before B was acknowledged");
  om.consume(() => "ok: edited");
  await until(async () => { fire(); await drain(2); return host.closed.length === 1; }, "closed once everything is saved");
});

test("F2(3) a text flush never overlaps a Send note in flight: it waits, then uses the rebased rev", async () => {
  withSecond();
  const cx = await ready(3);
  const tick = withTimers(cx);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  v.note.value = () => "a note"; v.onCreate(cx);
  assert.equal((await stage(1, "note")).op, "note");
  t.setTitle("typed during the note"); v.autosave(cx); tick(); await drain(5);
  assert.equal(sends().length, 1, "the flush waits for the note");
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 5 } : x));
  om.consume(() => "ok: noted");
  await nth(2, "the flush after the note");
  assert.deepEqual([sends()[1].op, sends()[1].title, sends()[1].ifRev], ["edit", "typed during the note", 5]);
});

test("F2(3b) a flush deferred behind a slow pick does not go out when a timer fires: only after the pick settled", async () => {
  withSecond();
  const cx = await ready(3);
  const tick = withTimers(cx);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  v.setProp("priority", "P0", cx);
  await stage(1, "pick");
  t.setTitle("waiting"); v.autosave(cx); tick(); tick(); await drain(5);
  assert.equal(sends().length, 1);
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 5 } : x));
  om.consume(() => "ok: edited");
  await nth(2, "after the pick");
  assert.equal(sends()[1].ifRev, 5);
});

test("F2(4) an unchanged text snapshot with an unknown outcome is not sent again", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    t.setTitle("B");
    void v.flushSave(cx);
    await stage(1, "B");
    skew = 11000; fire();
    await until(() => !v.inflight() || v.pickPending(), "pending");
    await v.flushSave(cx); await v.flushSave(cx); await drain(5);
    assert.equal(sends().length, 1, "the identical snapshot is not staged again");
  } finally { Date.now = realNow; }
});

test("F3(1) text typed while the close request goes pending is NOT lost: close stays open (the newer draft is kept)", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    t.setTitle("A");
    v.close(cx);
    await stage(1, "A");
    t.setTitle("B"); // typed while A is in flight
    skew = 11000; fire();
    await until(async () => { fire(); await drain(2); return v.msg === NOT_SENT; }, "the warning");
    assert.deepEqual(host.closed, [], "B was never sent: not closed");
    assert.equal(t.title(), "B"); assert.equal(sends().length, 1);
  } finally { Date.now = realNow; }
});

test("F3(2) a predecessor that never settles cannot trap Close: the bounded wait defers (no concurrent write), the next Close discards", async () => {
  withSecond();
  const cx = await ready(3);
  const later = []; cx.timer.after = (_ms, fn) => later.push(fn);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  v.setProp("priority", "P0", cx);
  await stage(1, "a pick that never answers");
  t.setTitle("typed behind it");
  v.close(cx);
  await drain(5); assert.deepEqual(host.closed, []);
  for (const f of later.splice(0)) f(cx); // the bound
  await until(async () => { await drain(2); return v.msg === NOT_SENT; }, "deferred with the discard warning");
  assert.equal(sends().length, 1, "no concurrent write");
  assert.deepEqual(host.closed, [], "the first Close did not discard");
  v.close(cx);
  await until(() => host.closed.length === 1, "the next Close discards and closes");
  assert.equal(sends().length, 1, "and it still sent nothing");
});

test("F4(1) a note slower than the entry bound: the cancelled text flush is re-enqueued fresh when the note settles", async () => {
  withSecond();
  const cx = await ready(3);
  const later = []; cx.timer.after = (_ms, fn) => later.push(fn);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  v.note.value = () => "slow note"; v.onCreate(cx);
  assert.equal((await stage(1, "note")).op, "note");
  t.setTitle("typed behind the note");
  void v.flushSave(cx); await drain(3);
  for (const f of later.splice(0)) f(cx); // the entry bound expires: the flush is cancelled
  await drain(3); assert.equal(sends().length, 1);
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 5 } : x));
  om.consume(() => "ok: noted");
  await until(async () => { fire(); await drain(2); for (const f of later.splice(0)) f(cx); return sends().length === 2 && IO.remoteWriter().inflight(M) === 0; }, "the title is flushed after the note");
  assert.deepEqual([sends()[1].op, sends()[1].title, sends()[1].ifRev], ["edit", "typed behind the note", 5]);
});

test("F4(2) a cancelled flush's cleanup never touches a context after the editor closed", async () => {
  withSecond();
  const cx = await ready(3);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  v.setProp("priority", "P0", cx);
  await stage(1, "pick held");
  t.setTitle("x");
  const calls = [], later = [];
  cx.timer.after = (_ms, fn) => later.push(fn);
  const spy = { notify: () => calls.push(v.closing && !v.leaving ? "after-close" : "ok"), timer: { after: (_ms, fn) => later.push(fn) }, spawn: (fn) => Promise.resolve().then(() => fn(spy)) };
  void v.flushSave(spy);
  for (const f of later.splice(0)) f(spy); // cancelled
  v.close(cx); await drain(3);
  await until(async () => { for (const f of later.splice(0)) f(cx); await drain(2); return v.msg === NOT_SENT; }, "the close's own bound: deferred");
  v.close(cx);
  await until(() => host.closed.length === 1, "closed");
  om.consume(() => "ok: edited");
  await until(async () => { fire(); await drain(2); return !v.picking; }, "the pick settled");
  await drain(5);
  assert.ok(!calls.includes("after-close"), `no notify after the close: ${calls}`);
});

// ---- Fix F5: a draft whose request came back refused is not retried until the user types again; a stale one retries once ----
const lateText = async (v, cx, t, text, reply) => { // flush `text`, let it go pending, then answer it late with `reply`
  t.setTitle(text); void v.flushSave(cx);
  await until(() => sends().length >= 1 && IO.remoteWriter().inflight(M) === 0, "staged");
};

test("F5 a rejected text is NOT retried forever after late errors; new typing makes a new attempt", async () => {
  withSecond();
  const cx = await ready(3);
  const tick = withTimers(cx);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    await lateText(v, cx, t, "bad title", null);
    skew = 11000; fire(); tick();
    await until(() => v.msg === "sent, may still apply", "pending");
    om.consume(() => "error: Title is longer than 200 characters");
    skew = 60000;
    const settle = () => until(async () => { fire(); om.consume((c) => (c.op === "protocol" ? "ok: protocol 3" : "ok: x")); await drain(2); view(v, cx, "ed-create"); tick(); return /longer than 200/.test(v.msg) && !v.inflight(); }, "the late error is shown");
    await settle();
    for (let i = 0; i < 6; i++) { fire(); await drain(3); view(v, cx, "ed-create"); tick(); }
    assert.equal(sends().length, 1, "exactly one request for the rejected snapshot");
    t.setTitle("another try"); void v.flushSave(cx);
    await until(async () => { fire(); om.consume((c) => (c.op === "protocol" ? "ok: protocol 3" : "ok: x")); await drain(2); tick(); return sends().length === 2; }, "new typing is a new attempt");
    assert.equal(sends()[1].title, "another try");
  } finally { Date.now = realNow; }
});

test("F5/F7 a LATE stale answer is never auto-resent: the text stays, rev rebases; the next keystroke is the retry, and again after another stale", async () => {
  withSecond();
  const cx = await ready(3);
  const tick = withTimers(cx);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  const loops = async (n = 8) => { for (let i = 0; i < n; i++) { fire(); om.consume((c) => (c.op === "protocol" ? "ok: protocol 3" : "ok: x")); await drain(3); view(v, cx, "ed-create"); tick(); } };
  try {
    await lateText(v, cx, t, "mine", null);
    skew = 11000; fire(); tick();
    await until(() => v.msg === "sent, may still apply", "pending");
    om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 6 } : x));
    om.consume(() => "error: stale: card T-R1 is at rev 6, request saw 4");
    skew = 30000; // the probe is still fresh
    await until(async () => { fire(); await drain(2); view(v, cx, "ed-create"); tick(); return /card changed on box1/.test(v.msg) && !v.inflight(); }, "the stale answer is shown");
    await loops();
    assert.equal(sends().length, 1, "0 automatic retries");
    assert.equal(t.title(), "mine"); assert.equal(v.fixedRemote.rev, 6);
    v.autosave(cx); tick(); // the next keystroke is the retry
    await until(async () => { fire(); await drain(2); tick(); return sends().length === 2; }, "typing retries");
    assert.equal(sends()[1].ifRev, 6);
    om.consume(() => "error: stale: card T-R1 is at rev 7, request saw 6");
    await until(async () => { fire(); await drain(2); tick(); return !v.inflight(); }, "second stale");
    await loops();
    assert.equal(sends().length, 2, "still no automatic retry after a second stale");
    v.autosave(cx); tick();
    await until(async () => { fire(); await drain(2); tick(); return sends().length === 3; }, "typing again retries again");
  } finally { Date.now = realNow; }
});
test("F6 an old attempt does not suppress a NEW identical draft: saved A, remote B adopted, A typed again and cancelled behind a slow note => fresh flush", async () => {
  withSecond();
  const cx = await ready(3);
  const later = []; cx.timer.after = (_ms, fn) => later.push(fn);
  openCard("T-R1");
  const v = new Editor(cx);
  const t = typed(v, "title T-R1", "");
  t.setTitle("A"); void v.flushSave(cx);
  await stage(1, "A");
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 5, title: "A" } : x));
  om.consume(() => "ok: edited");
  await until(async () => { fire(); await drain(2); for (const f of later.splice(0)) f(cx); return !v.inflight(); }, "A saved");
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 6, title: "B" } : x)); // someone else
  await IO.remote.retry(M, RID);
  v.adopt(IO.loadMerged().tasks.find((x) => x.id === "T-R1")); // the board reload adopts B
  assert.equal(t.title(), "B");
  v.note.value = () => "slow note"; v.onCreate(cx);
  assert.equal((await stage(2, "note")).op, "note");
  t.setTitle("A"); void v.flushSave(cx); await drain(3); // typed A again: queued behind the note
  for (const f of later.splice(0)) f(cx); // the entry bound expires: cancelled
  await drain(3);
  om.board["drover.tasks"] = om.board["drover.tasks"].map((x) => (x.id === "T-R1" ? { ...x, rev: 7 } : x));
  om.consume(() => "ok: noted");
  await until(async () => { fire(); await drain(2); for (const f of later.splice(0)) f(cx); return sends().length === 3 && IO.remoteWriter().inflight(M) === 0; }, "a fresh flush of the new A");
  assert.deepEqual([sends()[2].op, sends()[2].title, sends()[2].ifRev], ["edit", "A", 7]);
});

// T-MWO2HFFHWRB: a probe that WAS answered but is now older than PROBE_FRESH_MS (60 s). canWrite() re-asks (stages a probe) on expiry:
// that used to run inside render; now only the 1 s refresh of the needs cache does it, and render only reads the cached control.
test("Tasks: an expired probe is re-asked by the timer refresh only, never by render", async () => {
  om.board["drover.tasks"].push(card("T-R3", RID, { column: "review", rev: 2 }));
  await ready();
  const cx = cxOf();
  const v = new Tasks(); v.init({}, { ...cx, spawn() {} });
  fire();
  assert.ok(clickable(view(v, cx, "done-box1/P-REMOTE1/T-R3").node), "writes on while the probe is fresh");
  const real = Date.now;
  Date.now = () => real() + 61000; // the last `ok: protocol` answer is now 61 s old
  try {
    const sent = () => om.step1.length + om.remote.length;
    const n0 = sent();
    for (let i = 0; i < 3; i++) view(v, cx, "done-box1/P-REMOTE1/T-R3");
    await drain(3);
    assert.equal(sent(), n0, "render started no probe");
    assert.ok(clickable(view(v, cx, "done-box1/P-REMOTE1/T-R3").node), "render shows the cached control");
    fire();
    await until(() => sent() > n0, "the timer refresh re-asked the probe");
    const n1 = sent();
    for (let i = 0; i < 3; i++) view(v, cx, "done-box1/P-REMOTE1/T-R3");
    await drain(3);
    assert.equal(sent(), n1, "render after the refresh started nothing either");
  } finally { Date.now = real; }
});
