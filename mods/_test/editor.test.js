// The async task editor (drover-todos Editor) against a fake host.
// Fake host rule: an event cx dies when its handler returns (gpui-kit: only cx.spawn's AsyncContext survives an await).
// Runs on any main.js: EDITOR_MAIN=<path> (the old-commit proof; that file must export class Editor).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync, chmodSync, renameSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./hooks.js", import.meta.url);
const main = process.env.EDITOR_MAIN ? pathToFileURL(process.env.EDITOR_MAIN).href : new URL("../drover-todos/main.js", import.meta.url).href;
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { Editor } = await import(main);
const { default: Agents } = await import("../drover-agents/main.js");
const { drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
// The Squads screen renders a neutral view until its settings are ready: these tests are about the ready screen.
(await import("../_lib/config.js")).setSettings("drover-agents", {});

let host, gate, execFiles, errors;
const tick = () => new Promise((r) => setImmediate(r));
// Wait until all spawned work is done. Work blocked on a held paste never finishes: hold() gives g.reached for that case.
const work = new Set();
const flush = async () => { while (work.size) await Promise.allSettled([...work]); await tick(); };
const tasks = () => host.state["drover.tasks"] ?? [];
const closes = () => host.closeCalls.length;
const link = (f) => `![image](<${f}>)`;

beforeEach(() => {
  work.clear();
  const appHome = mkdtempSync(join(tmpdir(), "editor-test-"));
  mkdirSync(`${appHome}/drover-tasks/images`, { recursive: true });
  execFiles = [];
  errors = [];
  gate = null;
  host = globalThis.__host = {
    appHome, props: { overlay: "ov1", edit: null, column: "todo" }, state: {}, notified: [], closeCalls: [],
    closeOverlay: () => host.closeCalls.push({ staleGone: execFiles.map((f) => !existsSync(f)) }),
    exec: async (_cmd, args) => {
      const file = args.at(-1);
      execFiles.push(file);
      if (gate) { gate.hit(); await gate.promise; }
      await new Promise((r) => setTimeout(r, host.delays?.[execFiles.length - 1] ?? 0));
      writeFileSync(file, "png");
      return { code: 0 };
    },
  };
});

// A paste held at the clipboard step. g.reached: the first paste is there. g.open(): let it finish.
const hold = () => { let open, hit; gate = { promise: new Promise((r) => (open = r)), open, hit: () => hit(), reached: new Promise((r) => (hit = r)) }; return gate; };

// An event handler: its cx is dead once the handler returns. spawn gives the work a live AsyncContext.
function click(fn) {
  let alive = true;
  const stale = () => { if (!alive) throw new Error("stale cx: event cx used after the handler returned"); };
  const cx = {
    notify: stale, stop_propagation: stale, timer: { after: stale },
    spawn: (fn) => {
      stale();
      const p = Promise.resolve().then(() => fn({ notify() {}, timer: { after() {} } })).catch((e) => errors.push(e)).finally(() => work.delete(p));
      work.add(p);
    },
  };
  // Not awaited: an async handler (old code) may wait on the held paste.
  try { Promise.resolve(fn(cx)).catch((e) => errors.push(e)); } finally { alive = false; }
}
const open = () => { const e = new Editor({ focus_handle: () => ({}), timer: { after() {} } }); e.title.set_value("Task A"); return e; };
const paste = (e) => click((cx) => e.pasteImage(cx));
const save = (e) => click((cx) => e.submit(cx));

test("paste, then Save after the paste finished: one task with the image link, editor closes", async () => {
  const e = open();
  await paste(e); await flush();
  await save(e); await flush();
  assert.deepEqual(errors, []);
  assert.equal(tasks().length, 1);
  assert.ok(tasks()[0].desc.includes(link(execFiles[0])));
  assert.equal(closes(), 1);
});

test("Save while a paste is in flight waits for it: the image is in the saved task", async () => {
  const e = open();
  const g = hold();
  await paste(e);
  await save(e); await g.reached; await tick();
  assert.equal(tasks().length, 0, "must not save before the paste lands");
  assert.equal(closes(), 0);
  g.open(); await flush();
  assert.deepEqual(errors, []);
  assert.equal(tasks().length, 1);
  assert.ok(tasks()[0].desc.includes(link(execFiles[0])), "the pasted image must not be lost");
  assert.equal(closes(), 1);
});

test("double Save during a paste (and one after) makes one task and one close", async () => {
  const e = open();
  const g = hold();
  await paste(e);
  await save(e); await save(e); await g.reached;
  g.open(); await flush();
  await save(e); await flush();
  assert.deepEqual(errors, []);
  assert.equal(tasks().length, 1);
  assert.equal(closes(), 1);
});

test("Save with an invalid title during a paste shows the error, keeps the editor open, and a second Save works", async () => {
  const e = open();
  e.title.set_value("");
  const g = hold();
  await paste(e);
  await save(e);
  g.open(); await flush();
  assert.deepEqual(errors, []);
  assert.ok(e.error, "the error shows");
  assert.equal(tasks().length, 0);
  assert.equal(closes(), 0);
  e.title.set_value("Fixed");
  await save(e); await flush();
  assert.equal(tasks().length, 1);
  assert.equal(closes(), 1);
});

test("a paste after Save started does nothing", async () => {
  const e = open();
  const g = hold();
  await paste(e);
  await save(e);
  await paste(e);
  g.open(); await flush();
  assert.equal(execFiles.length, 1);
  assert.equal(tasks().length, 1);
});

test("two pastes land in order", async () => {
  const e = open();
  host.delays = [40, 0]; // the first paste is slower: a second one must still wait for it
  const g = hold();
  await paste(e); await paste(e);
  g.open(); await flush();
  assert.deepEqual(errors, []);
  assert.equal(execFiles.length, 2);
  const d = e.desc.value();
  assert.ok(d.indexOf(link(execFiles[0])) >= 0 && d.indexOf(link(execFiles[0])) < d.indexOf(link(execFiles[1])));
});

test("close deletes only this session's pasted files, before the overlay closes", async () => {
  const e = open();
  const other = `${host.appHome}/drover-tasks/images/old.png`;
  writeFileSync(other, "png");
  await paste(e); await flush();
  await click((cx) => e.close(cx)); await flush();
  assert.equal(existsSync(execFiles[0]), false);
  assert.equal(existsSync(other), true, "a file this session did not paste stays");
  assert.deepEqual(host.closeCalls, [{ staleGone: [true] }], "the file is gone when closeOverlay runs");
});

test("Save keeps the linked image, deletes the pasted one the description dropped, keeps one another task links", async () => {
  const e = open();
  await paste(e); await paste(e); await paste(e); await flush();
  const [kept, dropped, shared] = execFiles;
  host.state["drover.tasks"] = [{ id: "T-OLD", title: "old", desc: link(shared), tags: [], priority: "P2", column: "todo", archived: true }];
  e.desc.set_value(link(kept));
  await save(e); await flush();
  assert.equal(existsSync(kept), true);
  assert.equal(existsSync(dropped), false);
  assert.equal(existsSync(shared), true);
  assert.deepEqual(host.closeCalls, [{ staleGone: [false, true, false] }]);
});

test("Notes: Add note saves at once, newest last in storage, empty is an error, the autosaved title keeps the notes", async () => {
  const seed = { id: "T-N", title: "t", desc: "", priority: "P2", tags: [], column: "todo", archived: false, agent: null, source: null, created: 1, updated: 1 };
  host.state["drover.tasks"] = [seed];
  host.props = { overlay: "ov1", edit: "T-N", column: "todo" };
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  const cx = { notify() {} };
  e.addNote(cx);
  assert.ok(e.error);
  e.note.set_value("decided A");
  e.addNote(cx);
  assert.deepEqual(tasks()[0].notes.map((n) => [n.by, n.text]), [["you", "decided A"]]);
  assert.equal(e.note.value(), "");
  e.title.set_value("t2");
  await e.flushSave(cx);
  assert.deepEqual(errors, []);
  assert.deepEqual([tasks()[0].title, tasks()[0].notes.length], ["t2", 1]);
});

// Create modal: Create another, empty-title button, Cmd+Enter.
const ev = (key, platform) => ({ key, modifiers: { platform } });
const keyCx = () => { const c = { stopped: 0, notify() {}, stop_propagation() { c.stopped++; }, spawn: (fn) => { const p = Promise.resolve().then(() => fn({ notify() {}, timer: { after() {} } })).catch((e) => errors.push(e)).finally(() => work.delete(p)); work.add(p); } }; return c; };

test("Create another: the task saves, the form clears, status/priority/project stay, the editor stays open", async () => {
  const e = open();
  e.another = true; e.priority = "P1"; e.column = "doing"; e.project = "p9";
  e.desc.set_value("body");
  await save(e); await flush();
  assert.deepEqual(errors, []);
  assert.equal(tasks().length, 1);
  assert.equal(closes(), 0);
  assert.equal(e.title.value(), "");
  assert.equal(e.desc.value(), "");
  assert.deepEqual([e.priority, e.column, e.project], ["P1", "doing", "p9"]);
  e.title.set_value("Task B");
  await save(e); await flush();
  assert.equal(tasks().length, 2);
  assert.deepEqual(tasks().map((t) => t.priority), ["P1", "P1"]);
  assert.equal(closes(), 0);
  click((cx) => e.close(cx)); await flush();
  assert.equal(closes(), 1);
});

test("Create another off: Create closes the editor as before", async () => {
  const e = open();
  await save(e); await flush();
  assert.equal(closes(), 1);
});

test("Create another: an image the saved task links survives the final close", async () => {
  const e = open();
  e.another = true;
  await paste(e); await flush();
  await save(e); await flush();
  const f = execFiles[0];
  assert.ok(tasks()[0].desc.includes(link(f)));
  assert.equal(e.desc.value(), "");
  e.title.set_value("Task B");
  await paste(e); await flush();
  click((cx) => e.close(cx)); await flush();
  assert.equal(closes(), 1);
  assert.equal(existsSync(f), true, "the linked image stays");
  assert.equal(existsSync(execFiles[1]), false, "the unlinked image goes");
});

test("create button with an empty title does nothing: no task, no error", async () => {
  const e = open();
  e.title.set_value("  ");
  click((cx) => e.onCreate(cx)); await flush();
  assert.equal(tasks().length, 0);
  assert.equal(e.error, null);
  assert.equal(closes(), 0);
  e.title.set_value("Ok");
  click((cx) => e.onCreate(cx)); await flush();
  assert.equal(tasks().length, 1);
});

test("Cmd+Enter submits and stops the key; plain Enter in the description does not", async () => {
  const e = open();
  const plain = keyCx();
  e.onSubmitKey(ev("enter", false), plain);
  await flush();
  assert.equal(tasks().length, 0);
  assert.equal(plain.stopped, 0);
  const cmd = keyCx();
  e.onSubmitKey(ev("enter", true), cmd);
  await flush();
  assert.equal(tasks().length, 1);
  assert.equal(cmd.stopped, 1);
});

test("create mode: typing in the title re-renders (the Create button colour follows the title)", () => {
  const e = open();
  let n = 0;
  e.title.handlers.change({}, { notify: () => n++ });
  assert.equal(n, 1);
});

test("Textarea submit event (Cmd+Enter): secondary submits; plain does not; a key and a submit event for one press make one task", async () => {
  const e = open();
  e.another = true;
  click((cx) => e.desc.handlers.submit({ secondary: false }, cx)); await flush();
  assert.equal(tasks().length, 0);
  click((cx) => e.desc.handlers.submit({ secondary: true }, cx));
  e.onSubmitKey(ev("enter", true), keyCx()); await flush();
  assert.equal(tasks().length, 1, "no double create");
});

test("Title submit event + Cmd+Enter key for one press, Create another on: one task, the cleared form shows no error", async () => {
  const e = open();
  e.another = true;
  click((cx) => e.title.handlers.submit({}, cx));
  e.onSubmitKey(ev("enter", true), keyCx()); await flush();
  assert.equal(tasks().length, 1, "no double create");
  assert.equal(e.error, null, "no 'Title is required' on the cleared form");
});

test("labels: picked and created tags save into the new task; picking again removes", async () => {
  const e = open();
  e.toggleLabel("bug"); e.toggleLabel("ui"); e.toggleLabel("ui");
  e.labelSearch.set_value(" #Fresh ");
  click((cx) => e.createLabel(cx));
  assert.equal(e.labelSearch.value(), "");
  await save(e); await flush();
  assert.deepEqual(tasks()[0].tags, ["bug", "fresh"]);
});

test("labels: a draft-only tag stays in the choices, so it can be removed before saving", () => {
  const e = open();
  e.labelSearch.set_value("fresh");
  click((cx) => e.createLabel(cx));
  assert.deepEqual(e.labelChoices(), ["fresh"]);
  e.toggleLabel("fresh");
  assert.deepEqual(e.labelChoices(), []);
});

// Assignee: Create adds the card, then starts it. The editor closes only after launch ends.
const runner = { kind: "agent", id: "claude" };
const fakeLaunch = (result = {}) => {
  const f = async (...a) => { f.calls.push(a); f.hit(); await f.gate; return result; };
  f.calls = [];
  f.gate = new Promise((r) => (f.open = r));
  f.reached = new Promise((r) => (f.hit = r));
  return f;
};

test("assignee: the card is saved already claimed (no gap for the queue); launch error releases it to its column", async () => {
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch({ error: "boom" });
  await save(e); await l.reached;
  assert.equal(tasks().length, 1);
  assert.deepEqual([tasks()[0].agent, tasks()[0].column], ["claiming", "doing"]);
  l.open(); await flush();
  assert.deepEqual([tasks()[0].agent, tasks()[0].column], [null, "todo"]);
  assert.equal(tasks().length, 1);
  assert.equal(closes(), 1);
});

test("assignee: card added, then launch(task, runner, {worktree, reportTo}); closes only after launch ends; button says Starting…", async () => {
  host.state["drover.agents.last"] = { worktree: true };
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch();
  await save(e); await l.reached;
  assert.equal(tasks().length, 1);
  assert.equal(l.calls.length, 1);
  assert.deepEqual(l.calls[0], [tasks()[0], runner, { worktree: true, reportTo: null }]);
  assert.equal(closes(), 0);
  assert.equal(e.starting, true);
  save(e); // double submit while launching
  l.open(); await flush();
  assert.equal(l.calls.length, 1);
  assert.equal(tasks().length, 1);
  assert.equal(closes(), 1);
  assert.deepEqual(errors, []);
});

test("assignee: no last pick means no worktree", async () => {
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch(); l.open();
  await save(e); await flush();
  assert.deepEqual(l.calls[0][2], { worktree: false, reportTo: null });
});

// Card 6: the same precedence as the start dialog: last used > Drover Config default > built-in. Report goes to the live Drover, as the Picker does.
const C = await import("../_lib/config.js");
const withDrover = () => {
  C.bind({ shared: (k) => host.state[k] }); // production binds config in View.init before the Editor exists
  host.panes = [{ terminal: "t9" }];
  host.state["drover.runs"] = [{ id: "R-D", started: 1, terminals: [{ agent: "drover", address: "t9" }] }];
};
test("assignee: configured default_worktree and default_report apply when nothing was used before", async () => {
  host.state["drover.config"] = { "drover-agents": { default_worktree: true, default_report: true } };
  withDrover();
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch(); l.open();
  await save(e); await flush();
  assert.deepEqual(l.calls[0][2], { worktree: true, reportTo: "t9" });
});

test("assignee: report default with no Drover on screen reports to nobody", async () => {
  C.bind({ shared: (k) => host.state[k] });
  host.state["drover.config"] = { "drover-agents": { default_report: true } };
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch(); l.open();
  await save(e); await flush();
  assert.deepEqual(l.calls[0][2], { worktree: false, reportTo: null });
});

test("assignee: what was used last beats the configured defaults, field by field", async () => {
  host.state["drover.config"] = { "drover-agents": { default_worktree: true, default_report: true } };
  host.state["drover.agents.last"] = { worktree: false, report: false };
  withDrover();
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch(); l.open();
  await save(e); await flush();
  assert.deepEqual(l.calls[0][2], { worktree: false, reportTo: null });
});

// Round 2: a report-enabled launch is silent in launch(), so Create must show the error itself (as the Picker does).
test("assignee: with reporting on, a failed launch still shows its error (launch stays silent when reportTo is set)", async () => {
  host.state["drover.config"] = { "drover-agents": { default_report: true } };
  withDrover();
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch({ error: "No agent gone" }); l.open();
  await save(e); await flush();
  assert.deepEqual(host.notified.map((n) => [n.title, n.body, n.level]), [[`${tasks()[0].id} not started`, "No agent gone", "error"]]);
  assert.equal(tasks()[0].column, "todo", "claim released");
});

test("assignee: with reporting off, launch() owns the error toast: Create adds none", async () => {
  C.bind({ shared: (k) => host.state[k] });
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch({ error: "boom" }); l.open();
  await save(e); await flush();
  assert.deepEqual(host.notified, []);
});

// Round 2: a cold Todos reads the mod.json fallback of drover-agents before it resolves the launch options, also when the click races the read.
test("assignee: cold inherited default_worktree and default_report (mod.json) apply; Create waits for a pending read", async () => {
  C.resetCache();
  withDrover();
  C.resetCache(); // withDrover binds; start cold again: nothing loaded
  let release;
  const gateRead = new Promise((r) => { release = r; });
  host.readTextFile = async (p) => { await gateRead; return /drover-agents\/mod\.json$/.test(p) ? JSON.stringify({ settings: { default_worktree: true, default_report: true } }) : null; };
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch(); l.open();
  await save(e);
  await drain(); // a negative: a bounded drain
  assert.equal(l.calls.length, 0, "no launch while the settings read is pending");
  release(); await flush();
  assert.deepEqual(l.calls[0][2], { worktree: true, reportTo: "t9" });
});

test("send with a note: cold inherited default_worktree applies too", async () => {
  C.resetCache();
  host.readTextFile = async (p) => (/drover-agents\/mod\.json$/.test(p) ? JSON.stringify({ settings: { default_worktree: true } }) : null);
  const { startOptions } = await import("../_lib/io.js");
  assert.deepEqual(await startOptions(), { worktree: true, reportTo: null });
});

test("assignee: launch error leaves one card, closes the editor, no second add", async () => {
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch({ error: "boom" }); l.open();
  await save(e); await flush();
  assert.equal(tasks().length, 1);
  assert.equal(closes(), 1);
  assert.equal(l.calls.length, 1);
  save(e); await flush();
  assert.equal(tasks().length, 1, "closing editor adds nothing");
});

test("assignee + Create another: launch, then clear; editor stays open and can create again", async () => {
  const e = open(); e.assignee = runner; e.another = true;
  const l = e.launch = fakeLaunch(); 
  await save(e); await l.reached;
  assert.equal(e.title.value(), "Task A", "not cleared before launch ends");
  l.open(); await flush();
  assert.equal(e.title.value(), "");
  assert.equal(closes(), 0);
  assert.equal(e.starting, false);
  e.title.set_value("Task B");
  await save(e); await flush();
  assert.equal(l.calls.length, 2);
  assert.equal(tasks().length, 2);
});

test("no assignee: nothing starts", async () => {
  const e = open();
  const l = e.launch = fakeLaunch(); l.open();
  await save(e); await flush();
  assert.equal(l.calls.length, 0);
  assert.equal(closes(), 1);
});

test("assignee: Esc close is ignored while launching", async () => {
  const e = open(); e.assignee = runner;
  const l = e.launch = fakeLaunch();
  await save(e); await l.reached;
  click((cx) => e.close(cx)); await tick();
  assert.equal(closes(), 0);
  l.open(); await flush();
  assert.equal(closes(), 1);
});

// Agent mode: Create starts a one-shot agent run with the prompt. No card is added by the editor.
const agent = { kind: "agent", id: "claude" };
const openAgent = () => { const e = open(); e.mode = "agent"; e.prompt.set_value("Create a P1 bug card"); return e; };

test("agent mode: Create launches once with (null, agent, {project, create}), adds no task, closes after launch ends", async () => {
  const e = openAgent(); e.project = "P-1";
  const l = e.launch = fakeLaunch();
  await save(e); await l.reached;
  assert.deepEqual(l.calls[0], [null, agent, { project: "P-1", create: "Create a P1 bug card" }]);
  assert.equal(tasks().length, 0);
  assert.equal(closes(), 0);
  assert.equal(e.starting, true);
  save(e); // double click while launching
  l.open(); await flush();
  assert.equal(l.calls.length, 1);
  assert.equal(closes(), 1);
  assert.deepEqual(errors, []);
});

test("agent mode: the default agent is the last picked agent", async () => {
  host.state["drover.agents.last"] = { runner: { kind: "agent", id: "codex" } };
  const e = openAgent();
  const l = e.launch = fakeLaunch(); l.open();
  await save(e); await flush();
  assert.deepEqual(l.calls[0][1], { kind: "agent", id: "codex" });
});

test("agent mode: a launch error shows, stays open, and a new click can run again", async () => {
  const e = openAgent();
  const l = e.launch = fakeLaunch({ error: "boom" }); l.open();
  await save(e); await flush();
  assert.equal(e.error, "boom");
  assert.equal(closes(), 0);
  assert.equal(e.submitting, false);
  await save(e); await flush();
  assert.equal(l.calls.length, 2);
});

test("agent mode: Create another clears the prompt after launch and stays open", async () => {
  const e = openAgent(); e.another = true;
  const l = e.launch = fakeLaunch(); l.open();
  await save(e); await flush();
  assert.equal(e.prompt.value(), "");
  assert.equal(closes(), 0);
});

test("agent mode: a blank prompt does nothing", async () => {
  const e = openAgent(); e.prompt.set_value("   ");
  const l = e.launch = fakeLaunch(); l.open();
  click((cx) => e.onCreate(cx)); await flush();
  assert.equal(l.calls.length, 0);
  assert.equal(closes(), 0);
});

test("toggle mode keeps both drafts", () => {
  const e = open(); e.desc.set_value("details");
  e.prompt.set_value("do it");
  click((cx) => e.toggleMode(cx));
  assert.equal(e.mode, "agent");
  click((cx) => e.toggleMode(cx));
  assert.equal(e.mode, "manual");
  assert.deepEqual([e.title.value(), e.desc.value(), e.prompt.value()], ["Task A", "details", "do it"]);
});

test("agent mode: a last pick of drover is not the default; claude is", async () => {
  host.state["drover.agents.last"] = { runner: { kind: "agent", id: "drover" } };
  const e = openAgent();
  const l = e.launch = fakeLaunch(); l.open();
  await save(e); await flush();
  assert.deepEqual(l.calls[0][1], agent);
});

test("agent mode: Create during a held paste launches with the image link and keeps the file", async () => {
  const e = openAgent();
  const l = e.launch = fakeLaunch(); l.open();
  const g = hold();
  await paste(e);
  await save(e); await g.reached; await tick();
  assert.equal(l.calls.length, 0, "waits for the paste");
  g.open(); await flush();
  assert.deepEqual(errors, []);
  assert.ok(l.calls[0][2].create.includes(link(execFiles[0])), "the image is in the request");
  assert.equal(host.closeCalls[0].staleGone[0], false, "the file stays for the agent");
});

test("agent mode: typing in the prompt re-renders (ready follows the prompt, empty -> text -> empty)", () => {
  const e = open();
  let n = 0;
  e.prompt.handlers.change({}, { notify: () => n++ });
  assert.equal(n, 1);
});

// Expand ⤢ / shrink ⤡: close this overlay, reopen the create modal bigger/smaller with the full draft. Pasted files stay.
test("expand reopens large with the full draft, keeps pasted files, closes once", async () => {
  const opened = [];
  host.openOverlay = (spec) => opened.push(spec);
  const e = open();
  e.desc.set_value("body"); e.prompt.set_value("p"); e.mode = "agent"; e.priority = "P1"; e.column = "doing"; e.project = "p9";
  e.labels = ["a"]; e.assignee = { kind: "agent", id: "a1" }; e.runner = "a2"; e.another = true;
  await paste(e); await flush();
  await click((cx) => e.expand(cx)); await click((cx) => e.expand(cx)); await flush();
  assert.deepEqual(errors, []);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].width, 0.9);
  assert.equal(opened[0].height, 0.85);
  const d = opened[0].props.draft;
  assert.deepEqual([d.mode, d.title, d.desc, d.prompt.startsWith("p\n"), d.priority, d.column, d.project, d.labels, d.assignee, d.runner, d.another, d.pasted], ["agent", "Task A", "body", true, "P1", "doing", "p9", ["a"], { kind: "agent", id: "a1" }, "a2", true, [execFiles[0]]]);
  assert.equal(opened[0].props.large, true);
  assert.equal(existsSync(execFiles[0]), true, "pasted file kept");
  assert.equal(closes(), 1);
});

test("a large editor opened with a draft restores it; shrink goes back to 720x520", async () => {
  const opened = [];
  host.openOverlay = (spec) => opened.push(spec);
  host.props = { overlay: "ov2", edit: null, column: "todo", large: true, draft: { mode: "agent", title: "T", desc: "D", prompt: "P", priority: "P0", column: "doing", labels: ["x"], assignee: { kind: "squad", id: "s1" }, runner: "a3", project: "p1", another: true, pasted: ["/f.png"] } };
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} } });
  assert.deepEqual([e.mode, e.title.value(), e.desc.value(), e.prompt.value(), e.priority, e.column, e.labels, e.assignee, e.runner, e.project, e.another, e.pasted], ["agent", "T", "D", "P", "P0", "doing", ["x"], { kind: "squad", id: "s1" }, "a3", "p1", true, ["/f.png"]]);
  await click((cx) => e.expand(cx)); await flush();
  assert.deepEqual([opened[0].width, opened[0].height, opened[0].props.large], [720, 520, false]);
});

// Edit dialog S1: create-like shell, Save = title/desc only, properties are patches.
const seedTask = (extra = {}) => ({ id: "T-E", title: "t", desc: "d", priority: "P2", tags: ["k"], column: "todo", archived: false, agent: null, source: null, assignee: { kind: "squad", id: "cattle" }, notes: [], created: 1, updated: 1, ...extra });
const openEdit = (extra) => {
  host.state["drover.tasks"] = [seedTask(extra)];
  host.props = { overlay: "ov1", edit: "T-E", column: "todo" };
  return new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
};

test("edit: expand then shrink keeps title/desc/note and pasted; opens large then 720x520", async () => {
  const opened = [];
  host.openOverlay = (spec) => opened.push(spec);
  const e = openEdit();
  e.title.set_value("new title"); e.desc.set_value("new desc"); e.note.set_value("half note"); e.pasted = ["/f.png"];
  await click((cx) => e.expand(cx)); await flush();
  assert.deepEqual(errors, []);
  assert.equal(opened.length, 1);
  assert.deepEqual([opened[0].width, opened[0].height, opened[0].props.edit, opened[0].props.large], [0.9, 0.85, "T-E", true]);
  assert.equal(closes(), 1);
  assert.equal(tasks()[0].title, "new title", "expand flushes the pending text");
  host.props = { overlay: "ov2", ...opened[0].props };
  const e2 = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  assert.deepEqual([e2.title.value(), e2.desc.value(), e2.note.value(), e2.pasted], ["new title", "new desc", "half note", ["/f.png"]]);
  await click((cx) => e2.expand(cx)); await flush();
  assert.deepEqual([opened[1].width, opened[1].height, opened[1].props.large], [720, 520, false]);
  assert.equal(opened[1].props.draft.note, "half note");
});

test("edit: patch(priority) writes at once; the autosave afterwards keeps it even if storage changed meanwhile", async () => {
  const e = openEdit({ priority: "P2" });
  e.patch("priority", "P0", { notify() {} });
  assert.equal(tasks()[0].priority, "P0");
  host.state["drover.tasks"] = [{ ...tasks()[0], tags: ["other"], column: "review" }]; // storage changes behind the dialog
  e.title.set_value("t2");
  await e.flushSave({ notify() {} });
  assert.deepEqual(errors, []);
  assert.deepEqual([tasks()[0].title, tasks()[0].priority, tasks()[0].tags, tasks()[0].column], ["t2", "P0", ["other"], "review"]);
  assert.equal(closes(), 0);
});

test("edit: a text flush leaves priority/tags/column/assignee as stored", async () => {
  const e = openEdit();
  e.title.set_value("t2"); e.desc.set_value("d2");
  await e.flushSave({ notify() {} });
  const t = tasks()[0];
  assert.deepEqual([t.title, t.desc, t.priority, t.tags, t.column, t.assignee], ["t2", "d2", "P2", ["k"], "todo", { kind: "squad", id: "cattle" }]);
});

test("edit: close saves the text but never an unsent note", async () => {
  const e = openEdit();
  e.title.set_value("zzz"); e.desc.set_value("yyy"); e.note.set_value("n");
  click((cx) => e.close(cx)); await flush();
  assert.deepEqual([tasks()[0].title, tasks()[0].desc, tasks()[0].notes], ["zzz", "yyy", []]);
  assert.equal(closes(), 1);
});

test("edit: blank title keeps the dialog open with an error on close", async () => {
  const e = openEdit();
  e.title.set_value("");
  click((cx) => e.close(cx)); await flush();
  assert.ok(e.error);
  assert.equal(closes(), 0);
  assert.equal(tasks()[0].title, "t");
});

test("edit: render has breadcrumb, copy-id, more, expand, close; no footer", () => {
  const e = openEdit();
  globalThis.__rec = { ids: [], texts: [] };
  e.render({ notify() {}, listener: () => () => {} });
  const r = globalThis.__rec; globalThis.__rec = null;
  for (const id of ["ed-expand", "ed-close", "copy-id", "ed-more"]) assert.ok(r.ids.includes(id), id);
  assert.ok(r.texts.includes("Drover") && r.texts.includes("T-E"));
});

test("edit: a child's breadcrumb is Drover > parent id > task id; no parent, no parent crumb", () => {
  const rec = (e) => {
    globalThis.__rec = { ids: [], texts: [] };
    e.render({ notify() {}, listener: () => () => {} });
    const r = globalThis.__rec; globalThis.__rec = null; return r;
  };
  const e = openEdit({ parent: "T-P" });
  host.state["drover.tasks"] = [seedTask({ parent: "T-P" }), seedTask({ id: "T-P", title: "p" })];
  const r = rec(e);
  assert.ok(r.ids.includes("crumb-parent"));
  assert.ok(r.texts.includes("T-P") && r.texts.includes("T-E"));
  assert.ok(!rec(openEdit()).ids.includes("crumb-parent"));
  const gone = rec(openEdit({ parent: "T-GONE" }));
  assert.ok(gone.ids.includes("crumb-parent-dim") && !gone.ids.includes("crumb-parent") && gone.texts.includes("T-GONE"));
  const e2 = openEdit({ parent: "T-P" });
  host.state["drover.tasks"] = [seedTask({ parent: "T-P" }), seedTask({ id: "T-P", title: "p", archived: true })];
  const arch = rec(e2);
  assert.ok(arch.ids.includes("crumb-parent-dim") && !arch.ids.includes("crumb-parent"));
});

test("edit: archive flushes the text, sets the flag and closes", async () => {
  const e = openEdit();
  e.title.set_value("unsaved");
  click((cx) => e.archive(cx));
  await flush();
  assert.deepEqual([tasks()[0].archived, tasks()[0].title], [true, "unsaved"]);
  assert.equal(closes(), 1);
});

// Edit dialog S2: properties sidebar + notes composer.
const nocx = () => ({ notify() {}, stop_propagation() {}, spawn() {} });

test("edit: every sidebar property pick patches at once (status, priority, assignee, project, labels)", () => {
  const e = openEdit();
  e.setProp("priority", "P0", nocx());
  e.setProp("status", "review", nocx());
  e.setProp("assignee", { kind: "agent", id: "claude" }, nocx());
  e.setProp("project", "p9", nocx());
  e.setProp("tags", ["k", "z"], nocx());
  const t = tasks()[0];
  assert.deepEqual([t.priority, t.column, t.assignee, t.project, t.tags], ["P0", "review", { kind: "agent", id: "claude" }, "p9", ["k", "z"]]);
  assert.deepEqual(e.labels, ["k", "z"]);
});

test("edit: the labels list starts from the task's tags; toggling one saves at once", () => {
  const e = openEdit({ tags: ["a", "b"] });
  assert.deepEqual(e.labels, ["a", "b"]);
  e.toggleLabel("a", nocx());
  assert.deepEqual(tasks()[0].tags, ["b"]);
  e.toggleLabel("c", nocx());
  assert.deepEqual(tasks()[0].tags, ["b", "c"]);
});

test("edit: render has the sidebar properties and the notes composer", () => {
  const e = openEdit({ notes: [{ at: 1, by: "you", text: "n1" }] });
  globalThis.__rec = { ids: [], texts: [] };
  e.render({ notify() {}, listener: () => () => {} });
  const r = globalThis.__rec; globalThis.__rec = null;
  for (const id of ["trig-status", "trig-priority", "trig-assignee", "trig-labels", "trig-project", "note-add", "notes", "composer"]) assert.ok(r.ids.includes(id), id);
});

test("note: whitespace-only is rejected and stores nothing; a real note clears the composer", () => {
  const e = openEdit();
  e.note.set_value("  \n ");
  e.addNote(nocx());
  assert.ok(e.error);
  assert.deepEqual(tasks()[0].notes, []);
  e.note.set_value("multi\nline");
  e.addNote(nocx());
  assert.deepEqual(tasks()[0].notes.map((n) => n.text), ["multi\nline"]);
  assert.equal(e.note.value(), "");
  assert.equal(e.error, null);
});

test("Cmd+Enter in the note composer adds the note and does not Save or close", async () => {
  const e = openEdit({ assignee: null });
  e.title.set_value("unsaved title");
  e.note.set_value("hello");
  const c = keyCx();
  e.onNoteKey(ev("enter", true), c);
  await flush();
  assert.equal(c.stopped, 1);
  assert.deepEqual(tasks()[0].notes.map((n) => n.text), ["hello"]);
  assert.equal(tasks()[0].title, "t");
  assert.equal(closes(), 0);
  const plain = keyCx();
  e.note.set_value("second");
  e.onNoteKey(ev("enter", false), plain);
  assert.equal(plain.stopped, 0);
  assert.equal(tasks()[0].notes.length, 1, "plain Enter is a newline");
});

test("Cmd+Enter in title/description flushes the text and stays open", async () => {
  const e = openEdit();
  e.title.set_value("saved");
  const c = keyCx();
  e.onSubmitKey(ev("enter", true), c);
  await flush();
  assert.equal(tasks()[0].title, "saved");
  assert.equal(closes(), 0);
});

// Note send dedupe: only the duplicate callback of one attempt is dropped.
const withClock = (fn) => { const real = Date.now; let now = 1000; Date.now = () => now; try { return fn((ms) => (now += ms)); } finally { Date.now = real; } };

test("note: two different texts sent within the dedupe window are both stored", () => {
  withClock((adv) => {
    const e = openEdit({ assignee: null }); // no assignee: Send only saves (the routing has its own tests)
    e.note.set_value("first"); e.noteKey(nocx());
    adv(20);
    e.note.set_value("second"); e.noteKey(nocx());
    assert.deepEqual(tasks()[0].notes.map((n) => n.text), ["first", "second"]);
  });
});

test("note: empty attempt, then corrected text right after, is sent", () => {
  withClock((adv) => {
    const e = openEdit({ assignee: null }); // no assignee: Send only saves (the routing has its own tests)
    e.noteKey(nocx());
    assert.equal(e.error, null, "an empty send is disabled, not an error");
    assert.deepEqual(tasks()[0].notes, []);
    adv(20);
    e.note.set_value("fixed"); e.noteKey(nocx());
    assert.deepEqual(tasks()[0].notes.map((n) => n.text), ["fixed"]);
    assert.equal(e.error, null);
  });
});

test("note: key then submit, and submit then key, for one press make one note and no error", () => {
  withClock((adv) => {
    const e = openEdit({ assignee: null }); // no assignee: Send only saves (the routing has its own tests)
    e.note.set_value("a");
    e.onNoteKey(ev("enter", true), keyCx()); e.noteKey(nocx());
    adv(500);
    e.note.set_value("b");
    e.noteKey(nocx()); e.onNoteKey(ev("enter", true), keyCx());
    assert.deepEqual(tasks()[0].notes.map((n) => n.text), ["a", "b"]);
    assert.equal(e.error, null);
  });
});

// --- S3a: Run section + Wakeups (read-only run, toggle / add wakeups, history fold) ---
const render = (e) => {
  globalThis.__rec = { ids: [], texts: [], md: [], textareas: [] };
  e.render({ notify() {}, listener: () => () => {} });
  const r = globalThis.__rec; globalThis.__rec = null;
  return r;
};
const RUNS = "drover.runs", WAKES = "drover.wakeups";
const mkRun = (id, extra = {}) => ({ id, task: "T-E", name: `Squad ${id}`, started: 1000, terminals: [{ address: `t${id}`, name: "Lead", role: "leader", started: 1000 }], ...extra });
const mkWake = (id, target, extra = {}) => ({ id, target, text: `msg ${id}`, status: "scheduled", due: Date.now() + 60000, created: 1, enabled: true, source: "you", ...extra });

test("run section: no run shows the empty state", () => {
  const r = render(openEdit());
  assert.ok(r.texts.includes("No active run"));
  assert.ok(!r.ids.some((i) => i.startsWith("run-r-")));
});

test("run section: cleared link with 2 retained runs shows No active run; both sit in a closed History fold", () => {
  const e = openEdit({ run: null });
  host.state[RUNS] = [mkRun("A", { started: 10 }), mkRun("B", { started: 20 })];
  let r = render(e);
  assert.ok(r.texts.includes("No active run"));
  assert.ok(!r.ids.includes("run-r-A") && !r.ids.includes("run-r-B") && !r.ids.some((i) => i.startsWith("run-m-")));
  assert.ok(r.ids.includes("run-history") && r.texts.includes("Run history · 2"));
  e.runHistoryOpen = true;
  r = render(e);
  assert.ok(r.ids.indexOf("run-r-B") < r.ids.indexOf("run-r-A") && !r.ids.some((i) => i.startsWith("run-m-")));
});

test("run section: the linked run is current even when not the newest; the newer one is history", () => {
  const e = openEdit({ run: "A" });
  host.state[RUNS] = [mkRun("A", { started: 10, worktree: { path: "/w", branch: "feat/a" } }), mkRun("B", { started: 20 })];
  const r = render(e);
  assert.ok(r.ids.includes("run-r-A") && r.ids.includes("run-m-tA") && r.texts.includes("feat/a"));
  assert.ok(!r.ids.includes("run-r-B"), "newer unlinked run is behind the fold");
  assert.ok(r.texts.includes("Run history · 1") && !r.texts.includes("No active run"));
});

test("run section: clicking a live member focuses its agent, a parked worker is peeked, a gone one does nothing", async () => {
  const e = openEdit({ run: "A" });
  host.state[RUNS] = [mkRun("A", { terminals: [
    { address: "tL", name: "Lead", role: "leader", started: 1000 },
    { address: "tW", name: "Worker", role: "worker", started: 1000, parked: true },
    { address: "tG", name: "Gone", role: "worker", started: 1000 }] })];
  host.agents = [{ address: "tL", status: "working" }, { address: "tW", status: "idle" }];
  host.terminals = [{ address: "tL" }, { address: "tW" }];
  const calls = (host.runCalls = []);
  host.run = (...a) => calls.push(a);
  const r = render(e);
  const rows = e.runRows();
  assert.deepEqual(rows.map((m) => [m.address, m.focusable]), [["tL", true], ["tW", true], ["tG", false]]);
  assert.ok(r.ids.includes("run-m-tL") && r.ids.includes("run-m-tG"));
  click((cx) => e.openMember(rows[2], cx)); await flush();
  assert.equal(calls.length, 0, "gone member: nothing happens");
  assert.equal(closes(), 0);
  click((cx) => e.openMember(rows[1], cx)); await flush();
  assert.deepEqual(calls, [["terminal.peek", { terminal: "tW" }]]);
  const e2 = openEdit({ run: "A" });
  click((cx) => e2.openMember(rows[0], cx)); await flush();
  assert.deepEqual(calls[1], ["agent.focus", { terminal: "tL" }]);
});

test("run section: a jump flushes unsaved title text before it closes the dialog", async () => {
  const e = openEdit({ run: "A" });
  host.state[RUNS] = [mkRun("A")];
  host.agents = [{ address: "tA", status: "working" }]; host.terminals = [{ address: "tA" }];
  host.run = () => {};
  e.title.set_value("edited title");
  e.title.handlers.change({}, { notify() {}, timer: { after() {} } }); // schedules an autosave that never fires here
  click((cx) => e.openMember(e.runRows()[0], cx)); await flush();
  assert.equal(tasks()[0].title, "edited title");
  assert.equal(closes(), 1);
});

test("run section: a cleared terminal list on the linked run shows ended, no lineage rows", () => {
  const e = openEdit({ run: "A" });
  host.state[RUNS] = [mkRun("A", { terminals: [], ended: 5000 })];
  const r = render(e);
  assert.ok(r.ids.includes("run-r-A") && r.texts.includes("ended") && !r.ids.some((i) => i.startsWith("run-m-")));
});

test("wakeups: a task-targeted wake shows with its toggle; empty state when none", () => {
  const e = openEdit({ assignee: null }); // no assignee: Send only saves (the routing has its own tests)
  assert.ok(render(e).texts.includes("No wakeups for this task."));
  host.state[WAKES] = [mkWake("W1", "T-E"), mkWake("W2", "T-other")];
  const r = render(e);
  assert.ok(r.ids.includes("w-W1") && r.ids.includes("on-W1"));
  assert.ok(!r.ids.includes("w-W2"));
});

test("wakeups: toggle flips enabled in the shared list", () => {
  const e = openEdit({ assignee: null }); // no assignee: Send only saves (the routing has its own tests)
  host.state[WAKES] = [mkWake("W1", "T-E")];
  e.toggleWake("W1", nocx());
  assert.equal(host.state[WAKES][0].enabled, false);
  e.toggleWake("W1", nocx());
  assert.equal(host.state[WAKES][0].enabled, true);
});

test("wakeups: add targets the task id; bad time shows an error and adds nothing; success clears the text", () => {
  const e = openEdit({ assignee: null }); // no assignee: Send only saves (the routing has its own tests)
  e.wakeWhen.set_value("15m"); e.wakeText.set_value("check CI");
  e.addWakeup(nocx());
  assert.equal(host.state[WAKES].length, 1);
  assert.deepEqual([host.state[WAKES][0].target, host.state[WAKES][0].text], ["T-E", "check CI"]);
  assert.equal(e.wakeText.value(), "");
  e.wakeWhen.set_value("never"); e.wakeText.set_value("x");
  e.addWakeup(nocx());
  assert.equal(host.state[WAKES].length, 1);
  assert.ok(e.wakeError);
});

test("wakeups: ended wakes sit behind the History fold, closed by default", () => {
  const e = openEdit({ assignee: null }); // no assignee: Send only saves (the routing has its own tests)
  host.state[WAKES] = [mkWake("W1", "T-E"), mkWake("W3", "T-E", { status: "sent", at: 5 })];
  let r = render(e);
  assert.ok(r.ids.includes("wake-history") && !r.ids.includes("w-W3"));
  assert.ok(r.texts.includes("Wakeup history · 1"));
  e.historyOpen = true;
  r = render(e);
  assert.ok(r.ids.includes("w-W3"));
});

test("wakeups: terminal wake of the linked run is listed, labelled; old-run terminal and cleared link are not", () => {
  const e = openEdit({ run: "B" });
  host.state[RUNS] = [mkRun("A", { started: 10 }), mkRun("B", { started: 20 })];
  host.state[WAKES] = [mkWake("W9", "tB"), mkWake("W8", "tA"), mkWake("W7", "T-E")];
  const r = render(e);
  assert.ok(r.ids.includes("w-W9") && r.ids.includes("w-W7") && !r.ids.includes("w-W8"));
  assert.ok(r.texts.some((x) => x.startsWith("Wake Lead")) && r.texts.some((x) => x.startsWith("Wake task")));
  host.state["drover.tasks"][0].run = null;
  const c = render(e);
  assert.ok(c.ids.includes("w-W7") && !c.ids.includes("w-W9"));
});

// Edit dialog S4: parent navigation.
const withParent = () => {
  host.state["drover.tasks"] = [seedTask({ parent: "T-P" }), seedTask({ id: "T-P", title: "parent", column: "doing" })];
  host.props = { overlay: "ov1", edit: "T-E", column: "todo" };
  return new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
};
const openParent = (e, id = "T-P", force = false) => click((cx) => e.openParent(id, cx, force));

test("parent: the Parent picker has its own trigger focus handle", () => {
  const e = openEdit({ assignee: null }); // no assignee: Send only saves (the routing has its own tests)
  assert.ok(e.trigger.parent, "trigger.parent must exist");
});

test("parent: clean editor opens the parent at once, passing large; the parent's shrink returns to 720x520", async () => {
  const opened = [];
  host.openOverlay = (spec) => opened.push(spec);
  host.props = { overlay: "ov1", edit: "T-E", column: "todo", large: true, draft: { title: "t", desc: "d" } };
  host.state["drover.tasks"] = [seedTask({ parent: "T-P" }), seedTask({ id: "T-P", title: "parent", column: "doing" })];
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  await openParent(e); await flush();
  assert.deepEqual(errors, []);
  assert.deepEqual([opened[0].props.edit, opened[0].props.column, opened[0].props.large, opened[0].width], ["T-P", "doing", true, 0.9]);
  assert.equal(closes(), 1);
  host.props = { overlay: "ov2", ...opened[0].props };
  const e2 = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  assert.equal(e2.large, true);
  await click((cx) => e2.expand(cx)); await flush();
  assert.deepEqual([opened[1].width, opened[1].height], [720, 520]);
});

test("parent: unsaved title is flushed, then the parent opens without a prompt", async () => {
  const opened = [];
  host.openOverlay = (spec) => opened.push(spec);
  const e = withParent();
  e.title.set_value("changed");
  await openParent(e); await flush();
  assert.equal(opened.length, 1);
  assert.equal(closes(), 1);
  assert.equal(tasks()[0].title, "changed");
});

test("parent: a paste in flight lands first, then its link is saved and the parent opens", async () => {
  const opened = [];
  host.openOverlay = (spec) => opened.push(spec);
  const e = withParent();
  const g = hold();
  await paste(e);
  await openParent(e); await g.reached; await tick();
  assert.equal(opened.length, 0);
  g.open(); await flush();
  assert.deepEqual(errors, []);
  assert.ok(tasks()[0].desc.includes(link(execFiles[0])));
  assert.equal(existsSync(execFiles[0]), true, "a saved task links it");
  assert.equal(opened.length, 1);
});

test("parent: a failed flush stays open with the error", async () => {
  host.openOverlay = () => {};
  const e = withParent();
  e.title.set_value("");
  await openParent(e); await flush();
  assert.ok(e.error);
  assert.equal(closes(), 0);
});

// --- S5: rendered + editable markdown description (edit dialog only) ---
const openDesc = (desc) => openEdit({ desc });

test("S5: Cmd+Enter in the description flushes, stays open; key and submit event for one press are one flush", async () => {
  const e = openDesc("old");
  e.desc.set_value("via key");
  const c = keyCx();
  e.onSubmitKey(ev("enter", true), c);
  e.desc.handlers.submit({ secondary: true }, c); // the editor's own submit event for the same press
  await flush();
  assert.equal(tasks()[0].desc, "via key");
  assert.equal(closes(), 0);
});

test("S5: the description round-trips byte-exact (CRLF, interior blank/indented lines, image links); only outer whitespace is trimmed, as every save does (store.validate)", async () => {
  const text = `line1\r\nline2\n\n${link("/a b/(x).png")}\n\n  indented  \nlast`;
  const e = openDesc("old");
  e.desc.set_value(text);
  await e.flushSave({ notify() {} });
  assert.equal(tasks()[0].desc, text);
  assert.equal(e.desc.value(), text);
  e.desc.set_value(`${text}\n`); // a trailing newline: the field keeps it, the store trims it (existing contract)
  await e.flushSave({ notify() {} });
  assert.equal(tasks()[0].desc, text);
});

test("S5: fields().desc (read by expand and Create) is the live text", () => {
  const e = openDesc("old");
  e.desc.set_value("unsaved");
  assert.equal(e.fields().desc, "unsaved");
});

test("S5: a paste appends the image link", async () => {
  const e = openDesc("before");
  await paste(e); await flush();
  assert.ok(e.desc.value().startsWith("before") && e.desc.value().includes(link(execFiles[0])));
});

test("S5: the create modal keeps the plain textarea", () => {
  host.props = { overlay: "ov1", edit: null, column: "todo" };
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} } });
  const r = render(e);
  assert.ok(r.textareas.includes(e.desc) && r.md.length === 0);
  assert.ok(!r.ids.includes("desc-edit"));
});

test("S5: a flush with two accepted pastes in flight saves both links", async () => {
  const e = openDesc("body");
  const g = hold();
  await paste(e); await paste(e);
  e.flushSave({ notify() {} }); await g.reached; await tick();
  assert.equal(tasks()[0].desc, "body", "not saved before the pastes land");
  g.open(); await flush(); await tick();
  assert.deepEqual(errors, []);
  assert.ok(execFiles.length === 2 && execFiles.every((f) => tasks()[0].desc.includes(link(f))));
  assert.equal(tasks()[0].desc, e.desc.value());
});

// ---- drover-agents: the Environment section of the agent editor (C4). Fake values only, a disposable HOME.
// The fake host runs the real drover-env-write helper, so modes and the atomic rename are the real thing.
const HELPER = new URL("../drover-agents/bin/drover-env-write", import.meta.url).pathname;
const FAKE = "CANARY-fake-editor-9d41-not-a-secret";
const FAKE2 = "CANARY-fake-editor-c07e-not-a-secret";
const BOT = { id: "bot", name: "Bot", command: "claude", instructions: "", version: 1 };
let envHome, helperCalls;
const cfgDir = () => `${envHome}/.config/drover-herdr`;
const envFile = (id = "bot") => `${cfgDir()}/agents/${id}.json`;
const modeOf = (p) => (statSync(p).mode & 0o777).toString(8);
const agentCfg = () => host.state["drover.agents"];
const botNow = () => agentCfg().agents.find((a) => a.id === "bot");
const stageDir = () => `${host.appHome}/drover-env-stage`;
// Models the real runtime: the mod's fs reaches only its appHome (a denied call rejects with an error that has NO .code),
// and readTextFile (null when absent) is how it reads outside it.
function agentHost(props, agents = [BOT], squads = []) {
  envHome = mkdtempSync(join(tmpdir(), "agent-env-"));
  const app = mkdtempSync(join(tmpdir(), "agent-app-"));
  helperCalls = [];
  host = globalThis.__host = {
    appHome: app, home: envHome,
    fsGuard: (_op, p) => { if (!p.startsWith(app)) throw new Error("fs access denied"); },
    readTextFile: async (p) => { try { return readFileSync(p, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }, props: { overlay: "ov", ...props }, notified: [], closeCalls: [], state: { "drover.agents": { agents, squads } },
    closeOverlay: () => host.closeCalls.push(1),
    exec: async (cmd, args) => {
      helperCalls.push([cmd, args]);
      if (host.helper) { const r = host.helper(args); if (r) return r; }
      assert.equal(cmd, `${host.appHome}/mods/drover-agents/bin/drover-env-write`);
      assert.ok(args.includes("--stage-dir") && args[args.indexOf("--stage-dir") + 1] === stageDir(), "the stage dir is under appHome");
      const r = spawnSync(HELPER, args, { encoding: "utf8", env: { PATH: process.env.PATH } });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}
const liveCx = () => ({
  notify() {}, stop_propagation() {},
  spawn: (fn) => { const p = Promise.resolve().then(() => fn({ notify() {}, timer: { after() {} } })).catch((e) => errors.push(e)).finally(() => work.delete(p)); work.add(p); },
});
async function openAg(id = "bot") {
  host.props = { overlay: "ov", agent: id };
  const v = new Agents();
  v.init({}, liveCx());
  await flush();
  return v.dialog;
}
const setRow = (ed, name, value) => { const r = ed.addRow(); r.name.set_value(name); r.value.set_value(value); return r; };
const saveAg = async (ed) => { ed.save(liveCx()); await flush(); };
const onDisk = () => JSON.parse(readFileSync(envFile(), "utf8")).env;
const everything = () => JSON.stringify([host.state, host.notified, helperCalls, host.props]);

test("env save: a 0700 dir and a 0600 file hold the value; shared state, argv and notices never do", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "GH_TOKEN", FAKE); setRow(ed, "GH_CONFIG_DIR", "/fake/gh");
  await saveAg(ed);
  assert.deepEqual(errors, []);
  assert.equal(ed.error, null);
  assert.equal(modeOf(`${cfgDir()}/agents`), "700");
  assert.equal(modeOf(envFile()), "600");
  assert.deepEqual(readdirSync(`${cfgDir()}/agents`), ["bot.json"], "no tmp left");
  assert.equal(onDisk().GH_TOKEN.value, FAKE);
  assert.equal(onDisk().GH_TOKEN.secret, true);
  assert.equal(everything().includes(FAKE), false, "the value is only in the file");
  assert.equal(host.closeCalls.length, 1);
  assert.equal(botNow().version, 2);
  assert.equal("env" in botNow(), false);
});

test("env save: an audit line (time, action, NAMES) is added to the agent, never a value", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "GH_TOKEN", FAKE); setRow(ed, "GH_CONFIG_DIR", "/fake/gh");
  await saveAg(ed);
  const log = botNow().envLog;
  assert.equal(log.length, 1);
  assert.match(log[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z set GH_TOKEN, GH_CONFIG_DIR$/);
  assert.equal(JSON.stringify(log).includes(FAKE), false);
});

test("saved secrets render as 'set' + Replace; no input holds a value and the text never shows one", async () => {
  agentHost({});
  let ed = await openAg();
  setRow(ed, "GH_TOKEN", FAKE); setRow(ed, "GH_CONFIG_DIR", "/fake/gh");
  await saveAg(ed);
  ed = await openAg();
  const rec = globalThis.__rec = { ids: [], texts: [], inputs: [] };
  try {
    ed.render({});
    assert.ok(rec.texts.includes("set"), "shows 'set'");
    assert.ok(rec.ids.filter((i) => i.startsWith("rep-")).length >= 2, "a Replace button per saved variable");
    assert.ok(rec.texts.includes("GH_TOKEN") && rec.texts.includes("GH_CONFIG_DIR"), "names are shown");
    for (const st of rec.inputs) assert.ok(!String(st.value()).includes(FAKE) && !String(st.value()).includes("/fake/gh"), "no input reads a saved value back");
    assert.equal(JSON.stringify(rec).includes(FAKE), false);
  } finally { globalThis.__rec = undefined; }
});

test("saving again without touching a saved secret keeps its value; the file stays 0600", async () => {
  agentHost({});
  let ed = await openAg();
  setRow(ed, "GH_TOKEN", FAKE); setRow(ed, "GH_CONFIG_DIR", "/fake/gh");
  await saveAg(ed);
  ed = await openAg();
  ed.instructions.set_value("changed"); // a plain profile edit
  await saveAg(ed);
  assert.equal(onDisk().GH_TOKEN.value, FAKE);
  assert.equal(modeOf(envFile()), "600");
  assert.equal(botNow().instructions, "changed");
});

test("Replace takes a new value; an empty Replace keeps the old one; other variables stay", async () => {
  agentHost({});
  let ed = await openAg();
  setRow(ed, "GH_TOKEN", FAKE); setRow(ed, "GH_CONFIG_DIR", "/fake/gh");
  await saveAg(ed);
  ed = await openAg();
  const tok = ed.rows.find((r) => r.nameText === "GH_TOKEN");
  ed.replaceRow(tok.key);
  await saveAg(ed); // replace left empty
  assert.equal(onDisk().GH_TOKEN.value, FAKE);
  ed = await openAg();
  const tok2 = ed.rows.find((r) => r.nameText === "GH_TOKEN");
  ed.replaceRow(tok2.key);
  tok2.value.set_value(FAKE2);
  await saveAg(ed);
  assert.equal(onDisk().GH_TOKEN.value, FAKE2);
  assert.equal(onDisk().GH_CONFIG_DIR.value, "/fake/gh");
  assert.equal(everything().includes(FAKE2), false);
});

test("remove drops a variable; removing every row deletes the file and logs 'clear'", async () => {
  agentHost({});
  let ed = await openAg();
  setRow(ed, "FOO", FAKE); setRow(ed, "BAR", FAKE2);
  await saveAg(ed);
  ed = await openAg();
  ed.removeRow(ed.rows.find((r) => r.nameText === "FOO").key);
  await saveAg(ed);
  assert.deepEqual(Object.keys(onDisk()), ["BAR"]);
  ed = await openAg();
  ed.removeRow(ed.rows[0].key);
  await saveAg(ed);
  assert.equal(existsSync(envFile()), false, "no env = no file (launch stays unwrapped)");
  assert.match(botNow().envLog.at(-1), /Z clear$/);
});

test("a new row with a name but no value is refused: nothing written, nothing saved, editor stays open", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "FOO", "");
  await saveAg(ed);
  assert.match(ed.error, /FOO.*value/i);
  assert.equal(existsSync(envFile()), false);
  assert.equal(botNow().version, 1);
  assert.equal(host.closeCalls.length, 0);
});

test("GH_TOKEN without GH_CONFIG_DIR: the editor refuses with a clear message and writes nothing", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "GH_TOKEN", FAKE);
  await saveAg(ed);
  assert.match(ed.error, /GH_CONFIG_DIR/);
  assert.equal(ed.error.includes(FAKE), false);
  assert.equal(existsSync(envFile()), false);
  assert.equal(helperCalls.length, 0);
  assert.equal(botNow().version, 1);
  assert.equal(host.closeCalls.length, 0);
});

test("bad or denied names are refused with no value in the message", async () => {
  for (const name of ["path", "PATH", "HOME", "HC_X", "FOO BAR", "1X"]) {
    agentHost({});
    const ed = await openAg();
    setRow(ed, name, FAKE);
    await saveAg(ed);
    assert.ok(ed.error, name);
    assert.equal(ed.error.includes(FAKE), false, name);
    assert.equal(existsSync(envFile()), false, name);
    assert.equal(botNow().version, 1, name);
  }
});

test("two rows with the same name are refused", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "FOO", FAKE); setRow(ed, "FOO", FAKE2);
  await saveAg(ed);
  assert.match(ed.error, /twice|duplicate/i);
  assert.equal(existsSync(envFile()), false);
});

test("a helper failure shows its reason, keeps the old profile and leaves no tmp", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "FOO", FAKE);
  host.helper = (args) => (args[0] === "commit" ? { code: 1, stdout: "", stderr: "drover-env-write: pending file mode must be 0600\n" } : null);
  await saveAg(ed);
  assert.match(ed.error, /0600/);
  assert.equal(botNow().version, 1);
  assert.equal(host.closeCalls.length, 0);
  assert.equal(existsSync(envFile()), false);
  assert.deepEqual(existsSync(`${cfgDir()}/agents`) ? readdirSync(`${cfgDir()}/agents`) : [], [], "a failed commit leaves no tmp");
});

const realHelper = (args) => { const r = spawnSync(HELPER, args, { encoding: "utf8", env: { PATH: process.env.PATH } }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };

test("the tmp is created 0600 and empty before the value is written", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "FOO", FAKE);
  const seen = [];
  host.helper = (args) => {
    if (args[0] !== "prepare") return null;
    const r = realHelper(args);
    const tmp = `${stageDir()}/${r.stdout.trim()}`;
    seen.push([modeOf(tmp), statSync(tmp).size, modeOf(stageDir()), readdirSync(`${cfgDir()}/agents`).length]);
    return r;
  };
  await saveAg(ed);
  assert.deepEqual(seen, [["600", 0, "700", 0]]);
  assert.equal(onDisk().FOO.value, FAKE);
});

test("a failed write of the value aborts: the tmp is deleted, nothing saved", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "FOO", FAKE);
  const ops = [];
  host.helper = (args) => {
    ops.push(args[0]);
    if (args[0] !== "prepare") return null;
    const r = realHelper(args);
    chmodSync(`${stageDir()}/${r.stdout.trim()}`, 0o400); // the write into it now fails
    return r;
  };
  await saveAg(ed);
  assert.ok(ed.error);
  assert.equal(ed.error.includes(FAKE), false);
  assert.deepEqual(ops, ["prepare", "abort"]);
  assert.deepEqual(readdirSync(stageDir()), []);
  assert.deepEqual(readdirSync(`${cfgDir()}/agents`), []);
  assert.equal(botNow().version, 1);
  assert.equal(host.closeCalls.length, 0);
});

test("a rejected helper run (cannot start) after prepare: sanitized error, the tmp is aborted, busy resets, a retry works", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "FOO", FAKE);
  host.helper = (args) => { if (args[0] === "commit") throw new Error(`spawn ENOENT /secret/path ${FAKE}`); return null; };
  await saveAg(ed);
  assert.ok(ed.error);
  assert.equal(ed.error.includes("ENOENT") || ed.error.includes(FAKE) || ed.error.includes("/secret/path"), false, "no raw exec error");
  assert.equal(ed.busy, false);
  assert.deepEqual(helperCalls.map(([, a]) => a[0]), ["prepare", "commit", "abort"]);
  assert.deepEqual(readdirSync(`${cfgDir()}/agents`), [], "no tmp left");
  assert.deepEqual(readdirSync(stageDir()), [], "no tmp left in the stage dir");
  assert.equal(botNow().version, 1);
  host.helper = null;
  await saveAg(ed);
  assert.equal(ed.error, null);
  assert.equal(onDisk().FOO.value, FAKE);
});

test("a rejected prepare: sanitized error, busy resets, nothing saved", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "FOO", FAKE);
  host.helper = () => { throw new Error(`boom ${FAKE}`); };
  await saveAg(ed);
  assert.ok(ed.error);
  assert.equal(ed.error.includes("boom") || ed.error.includes(FAKE), false);
  assert.equal(ed.busy, false);
  assert.equal(botNow().version, 1);
  assert.equal(host.closeCalls.length, 0);
});

test("overlapping saves from two editors: each uses its own tmp and the last commit wins, 0600 throughout", async () => {
  agentHost({});
  const a = await openAg(), b = await openAg();
  setRow(a, "FOO", FAKE); setRow(b, "FOO", FAKE2);
  a.save(liveCx()); b.save(liveCx());
  await flush();
  assert.deepEqual(errors, []);
  assert.equal(modeOf(envFile()), "600");
  assert.ok([FAKE, FAKE2].includes(onDisk().FOO.value));
  assert.deepEqual(readdirSync(`${cfgDir()}/agents`), ["bot.json"]);
});

const captureLogs = async (fn) => {
  const logs = [], orig = console.log;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  try { await fn(); } finally { console.log = orig; }
  return logs;
};

test("opening an agent with no env file shows no problem (readTextFile null), even though the mod fs cannot read outside appHome", async () => {
  agentHost({});
  const ed = await openAg();
  assert.equal(ed.envError, null);
  assert.deepEqual(ed.rows, []);
  assert.deepEqual(errors, []);
});

test("a failing read shows only an allowlisted code; the log has a fixed label and that code, never the message or name", async () => {
  agentHost({});
  mkdirSync(`${cfgDir()}/agents`, { recursive: true, mode: 0o700 });
  writeFileSync(envFile(), text0(), { mode: 0o600 });
  host.readTextFile = async () => { const e = new Error(`cannot read ${envFile()} ${FAKE}`); e.name = `Read${FAKE}`; e.code = "EIO"; throw e; };
  let ed;
  const logs = await captureLogs(async () => { ed = await openAg(); });
  assert.match(ed.envError, /\(EIO\)/);
  assert.equal(ed.envError.includes(FAKE), false);
  assert.ok(logs.some((l) => l.includes("read failed") && l.includes("EIO")), JSON.stringify(logs));
  assert.equal(logs.join("\n").includes(FAKE), false, "no value in the log");
  assert.equal(logs.join("\n").includes("cannot read"), false, "no raw message in the log");
});
const text0 = () => JSON.stringify({ version: 1, env: { FOO: { value: FAKE, secret: true } } });

test("a code that is not a plain code word becomes 'Error' (no free text from the host reaches the editor or the log)", async () => {
  for (const code of [`E${FAKE}`, "lowercase", "has space", "X", "A".repeat(21), 5, null, {}]) {
    agentHost({});
    host.readTextFile = async () => { const e = new Error(`boom ${FAKE}`); e.code = code; throw e; };
    let ed;
    const logs = await captureLogs(async () => { ed = await openAg(); });
    assert.match(ed.envError, /\(Error\)/, String(code));
    assert.equal(JSON.stringify([ed.envError, logs]).includes(FAKE), false, String(code));
  }
});

test("a denied write of the value shows 'Error' (code-less), logs only a label and the code, aborts the tmp, saves nothing", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "FOO", FAKE);
  const guard = host.fsGuard;
  host.fsGuard = (op, p) => { if (op === "writeFile" && p.startsWith(stageDir())) { const e = new Error(`write refused for ${p} ${FAKE}`); e.name = "FsDenied"; throw e; } guard(op, p); };
  const logs = await captureLogs(() => saveAg(ed));
  assert.match(ed.error, /Could not write the environment file \(Error\)/);
  assert.equal(ed.error.includes(FAKE), false);
  assert.ok(logs.some((l) => l.includes("write failed") && l.includes("Error")), JSON.stringify(logs));
  assert.equal(JSON.stringify(logs).includes(FAKE) || JSON.stringify(logs).includes("write refused") || JSON.stringify(logs).includes("FsDenied"), false);
  assert.deepEqual(readdirSync(stageDir()), []);
  assert.equal(botNow().version, 1);
  assert.equal(ed.busy, false);
});

test("a rejected helper run with a value in its message: the editor and the log show only the code", async () => {
  agentHost({});
  const ed = await openAg();
  setRow(ed, "FOO", FAKE);
  host.helper = (args) => { if (args[0] === "prepare") { const e = new Error(`spawn failed ${FAKE}`); e.name = "SpawnError"; e.code = "ENOENT"; throw e; } return null; };
  const logs = await captureLogs(() => saveAg(ed));
  assert.match(ed.error, /\(ENOENT\)/);
  assert.ok(logs.some((l) => l.includes("helper prepare failed") && l.includes("ENOENT")), JSON.stringify(logs));
  assert.equal(JSON.stringify([logs, ed.error]).includes(FAKE), false);
});

test("the value-bearing failure fixtures print nothing with the value (rejected commit and prepare, console scanned)", async () => {
  for (const op of ["commit", "prepare", "abort"]) {
    agentHost({});
    const ed = await openAg();
    setRow(ed, "FOO", FAKE);
    host.helper = (args) => { if (args[0] === op) throw new Error(`spawn ENOENT /secret/path ${FAKE}`); return null; };
    const logs = await captureLogs(() => saveAg(ed));
    assert.equal(JSON.stringify([logs, ed.error]).includes(FAKE), false, op);
    assert.equal(JSON.stringify(logs).includes("/secret/path"), false, op);
  }
});

test("Delete with the stage dir not 0700 fails, keeps the profile AND the identity file", async () => {
  agentHost({});
  let ed = await openAg();
  setRow(ed, "FOO", FAKE);
  await saveAg(ed);
  chmodSync(stageDir(), 0o755);
  ed = await openAg();
  ed.remove(liveCx()); await flush();
  assert.ok(ed.error);
  assert.equal(agentCfg().agents.length, 1);
  assert.equal(onDisk().FOO.value, FAKE, "the credential is still there, so a launch still wraps");
  chmodSync(stageDir(), 0o700);
});

test("a plain edit with no env at all makes no helper call and creates nothing on disk", async () => {
  agentHost({});
  const ed = await openAg();
  ed.name.set_value("Bot 2");
  await saveAg(ed);
  assert.equal(helperCalls.length, 0);
  assert.equal(existsSync(cfgDir()), false);
  assert.equal(botNow().name, "Bot 2");
  assert.equal("envLog" in botNow(), false);
  assert.equal(host.closeCalls.length, 1);
});

test("a new agent: its env is written under the id the save gives it", async () => {
  agentHost({}, []);
  host.props = { overlay: "ov", agent: null };
  const v = new Agents(); v.init({}, liveCx()); await flush();
  const ed = v.dialog;
  ed.name.set_value("Review Bot"); ed.command.set_value("codex");
  setRow(ed, "FOO", FAKE);
  await saveAg(ed);
  assert.deepEqual(errors, []);
  assert.equal(agentCfg().agents[0].id, "review-bot");
  assert.equal(onDiskFor("review-bot").FOO.value, FAKE);
  assert.equal(everything().includes(FAKE), false);
});
const onDiskFor = (id) => JSON.parse(readFileSync(envFile(id), "utf8")).env;

test("a new agent whose profile is invalid writes no env file", async () => {
  agentHost({}, []);
  host.props = { overlay: "ov", agent: null };
  const v = new Agents(); v.init({}, liveCx()); await flush();
  const ed = v.dialog;
  ed.name.set_value(""); setRow(ed, "FOO", FAKE);
  await saveAg(ed);
  assert.ok(ed.error);
  assert.equal(existsSync(cfgDir()), false);
});

test("Delete removes the agent and its env file (and a stale tmp)", async () => {
  agentHost({});
  let ed = await openAg();
  setRow(ed, "FOO", FAKE);
  await saveAg(ed);
  writeFileSync(`${stageDir()}/bot.0123456789abcdef.tmp`, "stale", { mode: 0o600 });
  ed = await openAg();
  ed.remove(liveCx()); await flush();
  assert.deepEqual(errors, []);
  assert.equal(agentCfg().agents.length, 0);
  assert.deepEqual(readdirSync(`${cfgDir()}/agents`), []);
  assert.deepEqual(readdirSync(stageDir()), []);
  assert.equal(host.closeCalls.length, 2);
});

test("Delete when the env file cannot be removed safely keeps the agent, shows the error and resets busy", async () => {
  agentHost({});
  let ed = await openAg();
  setRow(ed, "FOO", FAKE);
  await saveAg(ed);
  renameSync(`${cfgDir()}/agents`, `${cfgDir()}/agents-kept`);
  symlinkSync(`${cfgDir()}/agents-kept`, `${cfgDir()}/agents`);
  ed = await openAg();
  ed.remove(liveCx()); await flush();
  assert.ok(ed.error);
  assert.equal(ed.error.includes(FAKE), false);
  assert.equal(ed.busy, false);
  assert.equal(agentCfg().agents.length, 1, "the profile stays");
  assert.ok(existsSync(`${cfgDir()}/agents-kept/bot.json`), "the file stays (nothing followed)");
  assert.equal(host.closeCalls.length, 1, "only the earlier save closed the editor");
});

test("Delete with a rejecting helper keeps the agent and resets busy", async () => {
  agentHost({});
  const ed = await openAg();
  host.helper = () => { throw new Error("cannot start"); };
  ed.remove(liveCx()); await flush();
  assert.ok(ed.error);
  assert.equal(ed.busy, false);
  assert.equal(agentCfg().agents.length, 1);
});

test("Delete of an agent a squad uses is refused and keeps the env file", async () => {
  agentHost({}, [BOT], [{ id: "s", name: "S", leader: "bot", members: [], version: 1 }]);
  let ed = await openAg();
  setRow(ed, "FOO", FAKE);
  await saveAg(ed);
  ed = await openAg();
  ed.remove(liveCx()); await flush();
  assert.match(ed.error, /squad/i);
  assert.ok(existsSync(envFile()));
  assert.equal(agentCfg().agents.length, 1);
});

test("an unreadable env file shows a problem without its content; a plain save still works and leaves the file alone", async () => {
  agentHost({});
  mkdirSync(`${cfgDir()}/agents`, { recursive: true, mode: 0o700 });
  writeFileSync(envFile(), `{"version":1,"env":{"FOO":{"value":"${FAKE}"`, { mode: 0o600 });
  const ed = await openAg();
  assert.ok(ed.envError);
  assert.equal(ed.envError.includes(FAKE), false);
  assert.deepEqual(ed.rows, []);
  ed.name.set_value("Bot 3");
  await saveAg(ed);
  assert.equal(botNow().name, "Bot 3");
  assert.ok(readFileSync(envFile(), "utf8").includes(FAKE), "untouched");
});

test("the agent list shows the env count per agent, names and values stay out of it", async () => {
  agentHost({}, [BOT, { id: "plain", name: "Plain", command: "codex", instructions: "", version: 1 }]);
  let ed = await openAg();
  setRow(ed, "FOO", FAKE); setRow(ed, "BAR", FAKE2);
  await saveAg(ed);
  host.props = { overlay: "ov" };
  const v = new Agents(); v.init({}, liveCx());
  const rec = globalThis.__rec = { ids: [], texts: [], inputs: [] };
  try {
    v.render(liveCx()); await flush();
    rec.texts.length = 0;
    v.render(liveCx());
    assert.ok(rec.texts.some((t) => /· 2 env\b/.test(t)), JSON.stringify(rec.texts));
    assert.equal(rec.texts.filter((t) => /\benv\b/.test(t)).length, 1, "only the agent with an env shows a count");
    assert.equal(JSON.stringify(rec.texts).includes(FAKE), false);
  } finally { globalThis.__rec = undefined; }
});
