// Edit dialog S7: sections (sub-issues, activity cards), composer picker + send routing wired into the Editor, sub-issue create.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mix } from "../_lib/notesend.js";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { Editor } = await import(new URL("../drover-todos/main.js", import.meta.url).href);
const { NODE } = await import(new URL("./stubs/el.js", import.meta.url).href);

let host, work, errors;
const tick = () => new Promise((r) => setImmediate(r));
const flushAll = async () => { while (work.size) await Promise.allSettled([...work]); await tick(); };
const mkcx = () => {
  const cx = { notify() {}, stop_propagation() {}, timer: { after() {} },
    spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)).catch((e) => errors.push(e)).finally(() => work.delete(p)); work.add(p); } };
  return cx;
};
const T = (id, over = {}) => ({ id, title: id, desc: "", priority: "P2", tags: [], column: "todo", archived: false, agent: null, source: null, assignee: null, notes: [], run: null, created: 1, updated: 1, ...over });
const CFG = { agents: [{ id: "claude", name: "Claude", command: "claude", soul: "", instructions: "" }, { id: "codex", name: "Codex", command: "codex", soul: "", instructions: "" }], squads: [{ id: "s1", name: "Crew", leader: "claude", members: [] }] };
beforeEach(() => {
  work = new Set(); errors = [];
  host = globalThis.__host = { appHome: "/tmp/none", props: { overlay: "o", edit: "T-E", column: "todo" }, state: { "drover.agents": CFG }, notified: [], closeCalls: [], opened: [], terminals: [], exec: async () => ({ code: 0 }) };
  host.closeOverlay = (...a) => host.closeCalls.push(a);
  host.openOverlay = (o) => host.opened.push(o);
});
const seed = (main, others = []) => {
  host.state["drover.tasks"] = [T("T-E", main), ...others];
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  e.sent = []; e.started = [];
  e.sendToAgent = async (a, t) => { e.sent.push([a, t]); };
  e.launch = async (task, runner, opts) => { e.startedTask = task; e.started.push([task?.id, runner, opts]); return e.launchResult ?? { id: "R" }; };
  return e;
};
const render = (e) => {
  globalThis.__rec = { ids: [], texts: [], md: [], textareas: [] };
  const root = e.render({ notify() {}, listener: () => () => {} });
  const r = globalThis.__rec; globalThis.__rec = null;
  return { ...r, root: root[NODE] };
};
const find = (n, id) => (n.id === id ? n : n.kids.map((k) => find(k, id)).find(Boolean) ?? null);
const stored = () => host.state["drover.tasks"].find((x) => x.id === "T-E");

// ── sub-issues
test("sub-issues: header, progress done/total, add '+', one list with a row per child (id, title, assignee initial)", () => {
  const e = seed({}, [T("T-1", { parent: "T-E", column: "done", title: "First child", assignee: { kind: "agent", id: "claude" } }), T("T-2", { parent: "T-E", title: "Second" }), T("T-3", { parent: "T-X" })]);
  const r = render(e);
  const sub = find(r.root, "sub-issues");
  assert.ok(sub && find(r.root, "thread") && find(find(r.root, "thread"), "sub-issues"), "inside the one scroll area");
  assert.ok(r.texts.includes("Sub-issues"));
  assert.ok(r.texts.includes("1/2"), "progress");
  assert.ok(r.ids.includes("sub-add"));
  assert.ok(find(sub, "sub-list"));
  assert.ok(find(sub, "sub-row-T-1") && find(sub, "sub-row-T-2"));
  assert.equal(find(r.root, "sub-row-T-3"), null, "another parent's child is not listed");
  assert.ok(r.texts.includes("First child") && r.texts.includes("T-2"));
  assert.ok(r.texts.includes("C"), "assignee initial of the claude agent -> 'C' (Claude)");
});

test("sub-issues: hidden when there are no children; only an '+ Add sub-issue' link", () => {
  const r = render(seed({}));
  assert.equal(find(r.root, "sub-issues"), null);
  assert.ok(r.ids.includes("add-subissue"));
  assert.ok(r.texts.includes("+ Add sub-issue"));
});

test("sub-issues: collapsing hides the list but keeps header and progress", () => {
  const e = seed({}, [T("T-1", { parent: "T-E" })]);
  e.subsOpen = false;
  const r = render(e);
  assert.ok(r.ids.includes("sub-header") && r.texts.includes("0/1"));
  assert.equal(find(r.root, "sub-list"), null);
});

test("sub-issues: a row click opens that task (flush first), '+' opens create with this task as parent", async () => {
  const e = seed({}, [T("T-1", { parent: "T-E" })]);
  e.title.set_value("edited"); // an unsaved edit: flushed before leaving
  e.openParent("T-1", mkcx());
  await flushAll();
  assert.equal(stored().title, "edited");
  assert.deepEqual(host.opened.map((o) => o.props.edit), ["T-1"]);
  assert.equal(host.closeCalls.length, 1);
  const e2 = seed({}, []);
  host.opened.length = 0;
  e2.addSubIssue(mkcx());
  await flushAll();
  assert.deepEqual(host.opened.map((o) => [o.props.edit, o.props.parent]), [[null, "T-E"]]);
});

test("create with props.parent: the new card saves with that parent", () => {
  host.props = { overlay: "o", edit: null, column: "todo", parent: "T-E" };
  host.state["drover.tasks"] = [T("T-E")];
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  e.title.set_value("child");
  e.submit(mkcx());
  const kid = host.state["drover.tasks"].find((x) => x.title === "child");
  assert.equal(kid.parent, "T-E");
});

// ── activity cards
const NOTES = [{ at: 1000, by: "you", text: "**bold** first" }, { at: 2000, by: "t5", text: "second", kind: "decision" }];
const RUN = { id: "R1", task: "T-E", name: "Squad", started: 1, terminals: [{ address: "t5", name: "Wrangler", role: "Reviewer", started: 1 }] };
test("activity: header, one card per note with avatar initial, author, relative time (tooltip carries exact), kind badge, markdown body", () => {
  host.state["drover.runs"] = [RUN];
  const e = seed({ notes: NOTES, run: "R1" });
  const r = render(e);
  assert.ok(r.texts.includes("Activity") && r.ids.includes("activity-header"));
  const thread = find(r.root, "thread");
  assert.ok(find(thread, "note-0") && find(thread, "note-1"), "cards inside the scroll");
  assert.ok(find(r.root, "note-avatar-0") && find(r.root, "note-avatar-1"));
  assert.ok(r.texts.includes("Y") && r.texts.includes("W"), "avatar initials: you, Wrangler");
  assert.ok(r.texts.includes("you") && r.texts.includes("Wrangler (Reviewer)"));
  assert.ok(r.texts.some((x) => /ago$/.test(x)), "relative time");
  assert.deepEqual(r.ids.filter((i) => i.startsWith("note-kind-")), ["note-kind-1"]);
  assert.deepEqual(r.md.filter((m) => m.id.startsWith("note-md-")).map((m) => m.md), ["**bold** first", "second"]);
  assert.ok(find(r.root, "note-0").calls.includes("rounded") && find(r.root, "note-0").calls.includes("border_1"), "a rounded bordered card");
});

test("activity: 2+ consecutive log notes fold into '› N activities' and expand on click", () => {
  const logs = [{ at: 1, by: "you", text: "hello" }, { at: 2, by: "t5", text: "l1", kind: "log" }, { at: 3, by: "t5", text: "l2", kind: "log" }];
  const e = seed({ notes: logs });
  let r = render(e);
  assert.ok(r.texts.includes("› 2 activities"));
  assert.ok(!r.texts.includes("l1") && !r.md.some((m) => m.md === "l1"), "folded notes are not shown");
  assert.ok(r.ids.includes("fold-1"));
  e.toggleFold(1, mkcx());
  r = render(e);
  assert.ok(r.md.some((m) => m.md === "l1") && r.md.some((m) => m.md === "l2"));
  assert.ok(r.texts.includes("‹ 2 activities") || r.texts.includes("▾ 2 activities"));
});

// ── composer picker + send routing
test("picker default = the card's assignee (avatar initial + name); 'Will start when sent'", () => {
  const r = render(seed({ assignee: { kind: "agent", id: "codex" } }));
  assert.ok(r.ids.includes("send-picker"));
  assert.ok(r.texts.includes("Will start when sent"));
  assert.ok(r.texts.includes("Codex") && r.texts.includes("C"));
});

test("picker without an assignee defaults to Don't start", () => {
  const r = render(seed({}));
  assert.ok(r.texts.includes("Don't start"));
  assert.ok(!r.texts.includes("Will start when sent"));
});

test("picker options: the assignee first, other agents and squads, Don't start last", () => {
  const e = seed({ assignee: { kind: "agent", id: "codex" } });
  assert.deepEqual(e.sendOptions().map((o) => o.key), ["agent-codex", "squad-s1", "agent-claude", "none"]);
  assert.equal(e.sendOptions().at(-1).text, "Don't start");
});

test("picking an option changes the target; it resets after a send", async () => {
  const e = seed({ assignee: { kind: "agent", id: "codex" } });
  e.pickSend("squad-s1", mkcx());
  assert.deepEqual(e.sendChoice(), { kind: "squad", id: "s1" });
  e.note.set_value("go"); e.noteKey(mkcx()); await flushAll();
  assert.deepEqual(e.started.map((s) => [s[0], s[1], s[2].note]), [["T-E", { kind: "squad", id: "s1" }, "go"]]);
  assert.deepEqual(e.sendChoice(), { kind: "agent", id: "codex" });
});

test("send: no live agent -> note saved, then the assignee started with the note", async () => {
  const e = seed({ assignee: { kind: "agent", id: "claude" } });
  e.note.set_value("please do X"); e.noteKey(mkcx()); await flushAll();
  assert.deepEqual(stored().notes.map((n) => n.text), ["please do X"]);
  assert.equal(e.started.length, 1);
  assert.deepEqual(e.started[0][1], { kind: "agent", id: "claude" });
  assert.equal(e.started[0][2].note, "please do X");
  assert.equal(e.note.value(), "");
});

test("send: a live task.agent gets hc send tagged as from the person, nothing starts", async () => {
  host.terminals = [{ address: "t9" }];
  const e = seed({ agent: "t9", assignee: { kind: "agent", id: "claude" } });
  e.note.set_value("status?"); e.noteKey(mkcx()); await flushAll();
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0][0], "t9");
  assert.match(e.sent[0][1], /from the person/i);
  assert.equal(e.started.length, 0);
  assert.equal(stored().notes.length, 1);
});

test("send: with a live agent and no assignee the note still goes to it; the picker says so", async () => {
  host.terminals = [{ address: "t9" }];
  const e = seed({ agent: "t9" });
  const r = render(e);
  assert.ok(r.texts.includes("Will send to t9"));
  e.note.set_value("hey"); e.noteKey(mkcx()); await flushAll();
  assert.equal(e.sent.length, 1);
});

test("Don't start: only saves the note", async () => {
  const e = seed({ assignee: { kind: "agent", id: "claude" } });
  e.pickSend("none", mkcx());
  e.note.set_value("just a comment"); e.noteKey(mkcx()); await flushAll();
  assert.deepEqual(stored().notes.map((n) => n.text), ["just a comment"]);
  assert.equal(e.started.length + e.sent.length, 0);
});

test("launch error: the note stays saved, the error shows inline, the composer is cleared", async () => {
  const e = seed({ assignee: { kind: "agent", id: "claude" } });
  e.launchResult = { error: "no folder" };
  e.note.set_value("keep me"); e.noteKey(mkcx()); await flushAll();
  assert.deepEqual(stored().notes.map((n) => n.text), ["keep me"]);
  const r = render(e);
  assert.ok(r.ids.includes("note-error"));
  assert.ok(r.texts.some((x) => x.includes("no folder")));
});

test("a send in flight blocks a second one", async () => {
  const e = seed({ assignee: { kind: "agent", id: "claude" } });
  let release; e.launch = (...a) => new Promise((r) => { release = () => r({ id: "R" }); });
  e.note.set_value("one"); e.noteKey(mkcx());
  await tick();
  e.note.set_value("two"); e.noteKey(mkcx());
  release(); await flushAll();
  assert.deepEqual(stored().notes.map((n) => n.text), ["one"]);
});

// ── sidebar
test("sidebar: compact 'label · value' rows under a Properties header; the value is the dropdown trigger", () => {
  const r = render(seed({}));
  const side = find(r.root, "ed-sidebar");
  assert.ok(r.texts.includes("Properties"));
  for (const [n, label] of [["status", "Status"], ["priority", "Priority"], ["assignee", "Assignee"], ["labels", "Labels"], ["project", "Project"], ["parent", "Parent"]]) {
    const row = find(side, `prop-${n}`);
    assert.ok(row && row.calls.includes("h") && row.calls.includes("items_center"), `prop-${n} is one compact row`);
    assert.ok(r.texts.includes(label), `label ${label}`);
    assert.ok(r.ids.includes(`trig-${n}`), `trig-${n}`);
  }
});

// ── round 2: review findings
const held = (e) => { e.release = null; e.launch = (task, runner, opts) => new Promise((r) => { e.startedTask = task; e.started.push([task?.id, runner, opts]); e.release = (v = { id: "R" }) => r(v); }); };

test("while a send is in flight, close / expand / archive / open child do nothing", async () => {
  const e = seed({ assignee: { kind: "agent", id: "claude" } }, [T("T-1", { parent: "T-E" })]);
  held(e);
  e.note.set_value("go"); e.noteKey(mkcx());
  await tick(); await tick();
  assert.equal(e.started.length, 1);
  e.close(mkcx()); e.expand(mkcx()); e.archive(mkcx()); e.openParent("T-1", mkcx());
  await tick();
  assert.equal(host.closeCalls.length, 0);
  assert.equal(host.opened.length, 0);
  e.release(); await flushAll();
  e.close(mkcx()); await flushAll();
  assert.equal(host.closeCalls.length, 1, "closing works again afterwards");
});

test("an unsaved title/description edit is flushed before the launch, and the launched task carries it", async () => {
  const e = seed({ title: "old", desc: "old desc", assignee: { kind: "agent", id: "claude" } });
  e.title.set_value("new title"); e.desc.set_value("new desc");
  e.note.set_value("go"); e.noteKey(mkcx()); await flushAll();
  assert.equal(e.started.length, 1);
  assert.equal(e.started[0][0], "T-E");
  const launched = e.startedTask;
  assert.equal(stored().title, "new title");
  assert.equal(launched?.title, "new title");
  assert.equal(launched?.desc, "new desc");
});

test("a failed flush: nothing launches, the note stays saved, the error shows", async () => {
  const e = seed({ title: "old", assignee: { kind: "agent", id: "claude" } });
  e.title.set_value("   "); // an empty title cannot be saved
  e.note.set_value("keep"); e.noteKey(mkcx()); await flushAll();
  assert.equal(e.started.length, 0);
  assert.deepEqual(stored().notes.map((n) => n.text), ["keep"]);
  assert.ok(e.error || e.noteError);
});

test("the launch claims the card (agent 'claiming', doing) while in flight and a second send is rejected", async () => {
  const e = seed({ column: "todo", assignee: { kind: "agent", id: "claude" } });
  held(e);
  e.note.set_value("one"); e.noteKey(mkcx());
  await tick(); await tick();
  assert.equal(stored().agent, "claiming");
  const e2 = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  e2.launch = e.launch;
  e2.note.set_value("two"); e2.noteKey(mkcx()); await tick(); await tick(); await tick();
  assert.equal(e.started.length, 1, "no second launch");
  assert.deepEqual(stored().notes.map((n) => n.text), ["one", "two"], "the second note is still saved");
  const r = render(e2);
  assert.ok(r.texts.some((x) => /already starting/.test(x)));
  e.release(); await flushAll();
});

test("a failed launch releases the claim: agent and column go back", async () => {
  const e = seed({ column: "todo", assignee: { kind: "agent", id: "claude" } });
  e.launchResult = { error: "nope" };
  e.note.set_value("x"); e.noteKey(mkcx()); await flushAll();
  assert.equal(stored().agent, null);
  assert.equal(stored().column, "todo");
});

test("picker with an assignee AND a live agent shows the effective live recipient and marks it current", () => {
  host.terminals = [{ address: "t9" }];
  host.state["drover.runs"] = [{ id: "R1", task: "T-E", name: "S", started: 1, terminals: [{ address: "t9", name: "Wrangler", role: "leader", started: 1 }] }];
  const e = seed({ agent: "t9", run: "R1", assignee: { kind: "agent", id: "codex" } });
  const r = render(e);
  assert.ok(r.texts.includes("Will send to Wrangler"));
  assert.ok(!r.texts.includes("Will start when sent"));
  assert.deepEqual(e.sendOptions().filter((o) => o.current).map((o) => o.key), ["live"]);
});

test("round 3: a send during the leave-edit-mode flush is rejected, so that flush cannot clear the lock mid-launch", async () => {
  const e = seed({ assignee: { kind: "agent", id: "claude" } });
  e.editing = true;
  let done; e.pending = new Promise((r) => (done = r)); // an accepted paste still in flight
  e.toggleEdit(mkcx()); await tick();
  assert.equal(e.submitting, true);
  e.note.set_value("go");
  assert.equal(e.sendNote(mkcx()), false, "rejected while the flush holds the lock");
  done(); await flushAll();
  assert.equal(e.started.length, 0);
  assert.equal(e.submitting, false);
  assert.equal(e.note.value(), "go", "the note stays in the composer");
});

test("round 3: while sending, the pencil does nothing", async () => {
  const e = seed({ assignee: { kind: "agent", id: "claude" } });
  held(e);
  e.note.set_value("go"); e.noteKey(mkcx()); await tick(); await tick();
  e.editing = true;
  e.toggleEdit(mkcx()); await tick();
  assert.equal(e.editing, true, "no flush started");
  assert.equal(e.submitting, true);
  e.release(); await flushAll();
});

// ── round 4: owner native check
const popoverOf = (r, name) => find(r.root, `pop-${name}`);
const ARG = (n, k) => n.args[k]?.[0];

test("every sidebar selector is a Popover that opens BELOW its trigger (top_* anchor, mt 4) and closes on outside press", () => {
  const r = render(seed({}));
  for (const n of ["status", "priority", "assignee", "labels", "project", "parent"]) {
    const pop = popoverOf(r, n);
    assert.ok(pop, `pop-${n} is a Popover`);
    assert.ok(/^top_/.test(ARG(pop, "anchor")), `${n}: top anchor, got ${ARG(pop, "anchor")}`);
    const content = pop.kids.find((k) => k.id === `menu-${n}`);
    assert.ok(content, `${n}: content is the list`);
    assert.deepEqual(content.args.mt, [4], `${n}: 4px gap`);
    assert.ok(pop.calls.includes("on_open_change") && pop.calls.includes("open"), `${n}: controlled open + dismissal`);
    const trig = pop.kids.find((k) => k.id === `trig-${n}`);
    assert.ok(trig && !trig.calls.includes("on_click"), `${n}: the Popover owns the press, the trigger has no click of its own`);
  }
});

test("the composer picker opens UPWARD (bottom_left, mb 4) so it never covers its trigger", () => {
  const r = render(seed({}));
  const pop = popoverOf(r, "send");
  assert.ok(pop);
  assert.equal(ARG(pop, "anchor"), "bottom_left");
  assert.deepEqual(pop.kids.find((k) => k.id === "menu-send").args.mb, [4]);
  assert.ok(pop.calls.includes("on_open_change"));
});

test("outside press (on_open_change false) closes the open selector; opening one closes another", () => {
  const e = seed({});
  const cx = mkcx();
  e.menuFocus = { focus() {} };
  let r = render(e);
  popoverOf(r, "status").args.on_open_change[0](true, cx);
  assert.equal(e.menu, "status");
  r = render(e);
  assert.deepEqual(popoverOf(r, "status").args.open, [true]);
  assert.deepEqual(popoverOf(r, "priority").args.open, [false]);
  popoverOf(r, "status").args.on_open_change[0](false, cx);
  assert.equal(e.menu, null);
  popoverOf(r, "send").args.on_open_change[0](true, cx);
  assert.equal(e.menu, "send");
  popoverOf(r, "send").args.on_open_change[0](false, cx);
  assert.equal(e.menu, null);
});

test("note cards: softer border and a background between the dialog and the darkest tone (mixed, not the raw background)", () => {
  host.theme = { popover: "#25262b", background: "#1b1c20", border: "#3a3b40" };
  const e = seed({ notes: [{ at: 1, by: "you", text: "hi" }] });
  const r = render(e);
  const card = find(r.root, "note-0");
  const bg = card.args.bg[0], border = card.args.border_color[0];
  assert.notEqual(bg, "#1b1c20", "not the full-dark background");
  assert.notEqual(bg, "#25262b", "but not the dialog colour either");
  assert.notEqual(border, "#3a3b40", "softer than the theme border");
  assert.match(bg, /^#[0-9a-f]{6}$/);
  assert.equal(bg, mix("#25262b", "#1b1c20", 0.30), "background: 30% of the way from the dialog to the darkest tone");
  assert.equal(border, mix("#25262b", "#3a3b40", 0.30), "border: 30% of the way to the theme border");
});

// ── round 5: Popover opening focus lands where the key handler / search is
test("every selector's Popover names the menu focus handle (the list's key handler) as its track_focus destination", () => {
  const e = seed({});
  const r = render(e);
  for (const n of ["status", "priority", "assignee", "labels", "project", "parent", "send"]) {
    assert.equal(ARG(popoverOf(r, n), "track_focus"), e.menuFocus, `${n}: track_focus = menuFocus`);
    assert.equal(find(popoverOf(r, n), `menu-${n}`).args.track_focus?.[0], e.menuFocus, `${n}: the list tracks the same handle`);
  }
});

test("opening Labels or Project: the search input takes the keyboard after Popover's own focus move (deferred), plain menus do not", () => {
  const e = seed({});
  const timers = [];
  const cx = { ...mkcx(), timer: { after: (ms, fn) => timers.push(fn) } };
  e.menuFocus = { focus() { e.menuFocused = (e.menuFocused ?? 0) + 1; } };
  const r = render(e);
  popoverOf(r, "labels").args.on_open_change[0](true, cx);
  const before = e.labelSearch.focused ?? 0;
  assert.equal(timers.length, 1, "a deferred focus is scheduled");
  timers.splice(0).forEach((f) => f(cx));
  assert.equal(e.labelSearch.focused, before + 1, "search focused after Popover's own focus move");
  popoverOf(r, "labels").args.on_open_change[0](false, cx);
  popoverOf(r, "status").args.on_open_change[0](true, cx);
  assert.equal(timers.length, 0, "no deferred search focus for a plain menu");
});
