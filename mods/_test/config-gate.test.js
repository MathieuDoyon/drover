// Drover Config card 4: <mod>.enabled=false is SCREEN ONLY. The mod draws "Disabled in Drover Config" and starts no work of its
// own (no timer, exec, fetch or data read); turning it on again starts that work without a restart; turning it off again stops
// it and drops anything in flight. Data keys and the drover CLI are never touched. drover-config, drover-tabs and drover-newtask
// have no switch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0, stdout: "[]", stderr: "" }), readTextFile: async () => null, home: "/h", appHome: "/a" };
const TMP = mkdtempSync(join(tmpdir(), "gate-")); // the inbox consumers of Board/Tasks/Wakeups mkdir under appHome: keep it out of the real fs
const C = await import("../_lib/config.js");
const { SCHEMA } = await import("../_lib/config-schema.js");
const { default: Tabs } = await import(new URL("../drover-tabs/main.js", import.meta.url).href);
const { default: Config } = await import(new URL("../drover-config/main.js", import.meta.url).href);

const CFG = "drover.config";
const STUB = "Disabled in Drover Config";
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const off = (...mods) => ({ [CFG]: Object.fromEntries(mods.map((m) => [m, { enabled: false }])) });

// One fake host for every test: records the calls a switched-off screen must not make. watchFolder never resolves (the inbox
// consumers wait on it), hc is recorded.
let log;
function host(state = {}, extra = {}) {
  C.resetCache();
  log = { exec: [], read: [], fetch: [], timers: [], spawns: 0, flight: 0, watchers: 0, hc: [], runs: [] };
  Object.assign(globalThis.__host, {
    props: {}, state, notified: [], appHome: TMP, focused: null, layout: null, window: null, fetchImpl: null,
    exec: async (cmd, args) => { log.exec.push([cmd, ...(args ?? [])].join(" ")); return { code: 0, stdout: "[]", stderr: "" }; },
    readTextFile: async (p) => { log.read.push(p); return null; },
    hc: async (a) => { log.hc.push(a.join(" ")); return { code: 0, stdout: "", stderr: "" }; },
    run: (...a) => { log.runs.push(a); },
    watchFolder: () => { log.watchers++; return new Promise(() => {}); },
    ...extra,
  });
  globalThis.fetch = async (url, init) => { log.fetch.push(String(url)); return globalThis.__host.fetchImpl ? globalThis.__host.fetchImpl(url, init) : { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) }; };
  return log;
}
// A host context that records timers; spawn runs the body (like the real one) so a started load really runs.
const cxOf = () => {
  const L = log;
  const cx = {
    notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }),
    spawn: (fn) => { L.spawns++; L.flight++; return Promise.resolve().then(() => fn(cx)).catch(() => {}).finally(() => { L.flight--; }); },
    timer: { every: (ms, fn) => { log.timers.push({ ms, fn }); }, after: (ms, fn) => { log.timers.push({ ms, fn, once: true }); } },
  };
  return cx;
};
// Every cx.spawn is counted while it runs; the inbox consumers park one spawn each on watchFolder for good, so those are not "in flight".
// idle() resolves when the screen has no other async work left. A test that holds a call open waits for that held call itself instead.
const idle = () => until(() => log.flight === log.watchers, "no spawned work in flight");
const tickAll = (cx) => Promise.all(log.timers.filter((t) => !t.once).map((t) => t.fn(cx)));
const setConfig = (obj) => { globalThis.__host.state[CFG] = obj; };
const withRec = (fn) => {
  globalThis.__rec = { ids: [], texts: [] };
  try { return { out: fn(), rec: globalThis.__rec }; } finally { globalThis.__rec = undefined; }
};
const folders = () => readdirSync(new URL("../", import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("drover-")).map((d) => d.name);

beforeEach(() => host());

// ---- the gate itself and the inventory ----
const EXEMPT = ["drover-config", "drover-tabs", "drover-newtask"];

test("every mods/drover-* folder has an enabled switch, or is on the exemption list (config, tabs, newtask)", () => {
  const all = folders();
  assert.ok(all.length >= 14, `found ${all.join(", ")}`);
  for (const mod of all) {
    const has = SCHEMA.some((f) => f.mod === mod && f.key === "enabled");
    if (EXEMPT.includes(mod)) assert.equal(has, false, `${mod} must not be switchable`);
    else assert.equal(has, true, `${mod} needs an enabled field in config-schema.js (or an entry in EXEMPT)`);
  }
  assert.deepEqual(EXEMPT.filter((m) => !all.includes(m)), [], "exemption names a folder that does not exist");
});

test("isEnabled: on by default, off from the shared key, live; folders without a switch are always on", () => {
  host(off("drover-board"));
  C.bind({ shared: (k) => globalThis.__host.state[k], modSettings: async () => ({}) });
  assert.equal(C.isEnabled("drover-board"), false);
  assert.equal(C.gate("drover-todos"), "loading", "no override and settings not loaded yet");
  assert.equal(C.isEnabled("drover-todos"), false, "never on while loading");
  C.setSettings("drover-todos", {}); C.setSettings("drover-board", {});
  assert.equal(C.isEnabled("drover-todos"), true);
  setConfig({});
  assert.equal(C.isEnabled("drover-board"), true, "read live, no restart");
  setConfig(off("drover-config", "drover-tabs")[CFG]);
  assert.equal(C.isEnabled("drover-config"), true);
  assert.equal(C.isEnabled("drover-tabs"), true);
  assert.equal(C.isEnabled("drover-newtask"), true);
});

// ---- drover-tabs: menu and presets ----
const menuIds = async (state) => {
  host(state, { props: { menu: "drover", overlay: "o" } });
  const v = new Tabs();
  v.init({}, cxOf());
  await idle(); // the settings of every listed screen are loaded first
  return withRec(() => v.render(cxOf())).rec.ids;
};

test("tabs: a screen that is off has no row in the Drover menu", async () => {
  const all = await menuIds({});
  for (const m of ["todos", "board", "jira", "github", "agents", "runs", "wakeups", "projects", "reader"]) assert.ok(all.includes(`s-drover-${m}`), `${m} on by default`);
  const ids = await menuIds(off("drover-jira", "drover-reader"));
  assert.equal(ids.includes("s-drover-jira"), false);
  assert.equal(ids.includes("s-drover-reader"), false);
  assert.ok(ids.includes("s-drover-board"));
  assert.ok(ids.includes("s-config"), "Config entry stays");
});

test("tabs: a preset needs both its screens on; Tasks is the right screen of Work", async () => {
  const PRE = ["p-Sources", "p-Squads", "p-Work"];
  const presets = async (mod) => { const ids = await menuIds(mod ? off(mod) : {}); return PRE.filter((id) => ids.includes(id)); };
  assert.deepEqual(await presets(), PRE);
  assert.deepEqual(await presets("drover-github"), ["p-Squads", "p-Work"]);
  assert.deepEqual(await presets("drover-runs"), ["p-Sources", "p-Work"]);
  assert.deepEqual(await presets("drover-board"), ["p-Sources", "p-Squads"]);
  const noTasks = await menuIds(off("drover-tasks"));
  assert.equal(noTasks.includes("p-Work"), false, "Work needs Tasks");
  assert.ok(noTasks.includes("s-drover-board"), "Board itself still opens alone");
});

// ---- drover-tabs: the Tasks capsule ----
const NODE = Symbol.for("test.node");
const findNode = (n, id) => (n.id === id ? n : n.kids.map((k) => findNode(k, id)).find(Boolean));
async function tasksCapsule(state) {
  host(state, { layout: { id: "root", children: [{ id: "drover", hidden: false }] } });
  const v = new Tabs();
  v.init({}, cxOf());
  await idle();
  globalThis.__rec = { ids: [], texts: [] };
  try { return findNode(v.render(cxOf())[NODE], "tasks"); } finally { globalThis.__rec = undefined; }
}

test("tabs: the Tasks capsule toggles the column while Tasks is on, and does nothing when it is off", async () => {
  (await tasksCapsule({})).args.on_click[0]();
  assert.deepEqual(log.runs, [["layout.toggle", { id: "drover" }]]);
  host();
  const c = await tasksCapsule(off("drover-tasks"));
  c.args.on_click[0]();
  assert.deepEqual(log.runs, [], "no layout.toggle: cmd-alt-b is bound in keys.json and cannot be gated by a mod (documented in the code)");
});

// ---- the config dialog ----
function dialogTexts(mod) {
  host({});
  const v = new Config();
  v.init({}, cxOf());
  v.mod = mod;
  return withRec(() => v.render(cxOf())).rec.texts.join("\n");
}

test("config dialog: no intro paragraph under the section header (settings screens)", () => {
  assert.doesNotMatch(dialogTexts("drover-board"), /saved right away|cannot be turned off|no data is touched/);
});

test("config dialog: the Tasks switch row says cmd-alt-b still toggles the (empty) Tasks column", () => {
  assert.match(dialogTexts("drover-tasks"), /cmd-alt-b\) still toggles the \(empty\) Tasks column/);
  assert.doesNotMatch(dialogTexts("drover-board"), /cmd-alt-b/);
});


// ---- per-screen lifecycle ----
// A mounted screen. mount() builds it with the given shared state; show() renders it (recording texts) and lets async work settle.
// GitHub's filter input is a token input: the stub gets the content model the real host has (as in config-wire.test.js).
const { InputState } = await import(new URL("./stubs/gpui-base.js", import.meta.url).href);
function patchInput(input) {
  input.tokens = [];
  input.content = () => ({ text: input.v, tokens: input.tokens.map((s) => ({ range: { ...s.range }, token: { ...s.token } })) });
  input.set_value = (v) => { if (typeof v === "string") { input.v = v; input.tokens = []; } else { input.v = v.text; input.tokens = v.tokens; } };
  input.replace_range_with_token = () => {};
}
const mount = (file, state = {}, extra = {}) => mountRaw(file, state, extra, true);
// No wait: for a test that holds a call open (a wait for idle would never end) and for the render-before-ready checks.
const mountNow = (file, state, extra) => mountRaw(file, state, extra, false);
const textNow = (view, cx) => withRec(() => view.render(cx)).rec.texts.join("\n");
async function mountRaw(file, state, extra, wait) {
  host(state, extra);
  const { default: Cls } = await import(new URL(`../${file}/main.js`, import.meta.url).href);
  const cx = cxOf();
  const view = new Cls();
  const orig = InputState.new;
  InputState.new = function (o) { const st = orig.call(this, o); patchInput(st); return st; };
  try { view.init({}, cx); } finally { InputState.new = orig; }
  if (wait) await idle();
  return { view, cx };
}
async function show(view, cx) {
  const { rec } = withRec(() => view.render(cx));
  await idle();
  return rec.texts.join("\n");
}
// The work a switched-off screen must not do: exec, file reads, fetches. `timers` lists the interval (ms) of each timer started.
const quiet = (expectTimers = []) => {
  assert.deepEqual(log.exec, [], "no exec");
  assert.deepEqual(log.read.filter((p) => !/mod\.json$/.test(p)), [], "no data read (a mod.json settings read is config)");
  assert.deepEqual(log.fetch, [], "no fetch");
  assert.deepEqual(log.hc, [], "no hc");
  assert.deepEqual(log.timers.map((t) => t.ms), expectTimers, "timers");
};
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const dataReads = () => log.read.filter((p) => !/mod\.json$/.test(p));
const jiraCreds = "/h/.config/drover-herdr/atlassian.json";

// GitHub: gh runs through exec. State has one scope, so a load is a gh call.
const GH = { "drover.github.scopes": ["acme"] };
const ghCalls = () => log.exec.filter((c) => c.startsWith("gh "));

test("github off: stub text, no timer, no gh, no config read", async () => {
  const { view, cx } = await mount("drover-github", { ...off("drover-github"), ...GH });
  assert.match(await show(view, cx), new RegExp(STUB));
  await tickAll(cx); await idle();
  quiet();
});

test("github off -> on -> off -> on: starts without a restart, stops, restarts; the typed filter is kept", async () => {
  const { view, cx } = await mount("drover-github", { ...off("drover-github"), ...GH });
  await show(view, cx);
  view.input.set_value("is:pr label:draft");
  setConfig({});
  assert.doesNotMatch(await show(view, cx), new RegExp(STUB));
  assert.equal(ghCalls().length, 1, "turning it on loads once");
  assert.deepEqual(log.timers.map((t) => t.ms), [5 * 60 * 1000]);
  setConfig(off("drover-github")[CFG]);
  assert.match(await show(view, cx), new RegExp(STUB));
  await tickAll(cx); await idle();
  assert.equal(ghCalls().length, 1, "a timer tick while off does nothing");
  setConfig({});
  await show(view, cx);
  assert.equal(ghCalls().length, 2, "back on: reloads");
  assert.equal(log.timers.length, 1, "the timer is started once");
  assert.equal(view.input.value(), "is:pr label:draft", "the draft survives off and on");
});

test("github: a load in flight when it is switched off is dropped (no snapshot written)", async () => {
  const gate = deferred();
  const { view, cx } = await mountNow("drover-github", GH, { exec: async (cmd, args) => { log.exec.push([cmd, ...args].join(" ")); await gate.promise; return { code: 0, stdout: "[]", stderr: "" }; } });
  await until(() => ghCalls().length === 1, "the gh load is in flight (held)");
  setConfig(off("drover-github")[CFG]);
  textNow(view, cx);
  gate.resolve();
  await idle();
  assert.equal(globalThis.__host.state["drover.github.snapshot"], undefined, "no write while off");
  assert.equal(view.loading, false);
});

// Jira: a configured site makes a load a fetch, after the credential read.
const JIRA = { "drover-jira": { site: "acme.atlassian.net" } };
const jiraOn = () => ({ [CFG]: JIRA });
const jiraHost = { readTextFile: async (p) => { log.read.push(p); return p === jiraCreds ? JSON.stringify({ email: "a@b.c", apiToken: "t" }) : null; } };

test("jira off: stub text, no timer, no credential read, no request", async () => {
  const { view, cx } = await mount("drover-jira", { [CFG]: { "drover-jira": { site: "acme.atlassian.net", enabled: false } } }, jiraHost);
  assert.match(await show(view, cx), new RegExp(STUB));
  await tickAll(cx); await idle();
  quiet();
});

test("jira off -> on -> off -> on: loads when turned on, nothing while off, loads again", async () => {
  const { view, cx } = await mount("drover-jira", { [CFG]: { "drover-jira": { site: "acme.atlassian.net", enabled: false } } }, jiraHost);
  await show(view, cx);
  setConfig(JIRA);
  await show(view, cx);
  assert.equal(log.fetch.length, 1);
  assert.equal(log.timers.length, 1);
  setConfig({ "drover-jira": { site: "acme.atlassian.net", enabled: false } });
  assert.match(await show(view, cx), new RegExp(STUB));
  const before = log.fetch.length;
  view.lastRun = 0;
  await tickAll(cx); await idle();
  assert.equal(log.fetch.length, before, "a tick while off requests nothing");
  setConfig(JIRA);
  await show(view, cx);
  assert.equal(log.fetch.length, before + 1, "back on: reloads");
  assert.equal(log.timers.length, 1, "the timer is started once");
});

test("jira: a request in flight when it is switched off is dropped (no snapshot written)", async () => {
  const gate = deferred();
  const { view, cx } = await mountNow("drover-jira", jiraOn(), { ...jiraHost, fetchImpl: async () => { await gate.promise; return { ok: true, status: 200, json: async () => ({ issues: [{ id: "1", key: "A-1", fields: { summary: "s" } }], isLast: true }) }; } });
  await until(() => log.fetch.length === 1, "the request is in flight (held)");
  setConfig({ "drover-jira": { site: "acme.atlassian.net", enabled: false } });
  textNow(view, cx);
  gate.resolve();
  await idle();
  assert.equal(globalThis.__host.state["drover.jira.snapshot"], undefined, "no write while off");
  assert.equal(view.loading, false);
});

// Room: a focused run with a worktree branch makes a refresh a gh call. watchWakes (CLI wakeup delivery) stays: its 15s timer is
// the only one a switched-off Room keeps (decision G2: off is screen only).
const RUN = { id: "R-1", task: null, started: 1, terminals: [{ address: "t1", name: "Lead", role: "leader", agent: "x" }], worktree: { branch: "feat/x", path: "/w/x" } };
const roomState = (cfg = {}) => ({ [CFG]: cfg, "drover.runs": [RUN] });
const roomHost = { focused: { terminal: "t1" } };
const prList = () => log.exec.filter((c) => c.startsWith("gh pr list --head"));

test("room off: stub text; only the CLI wakeup consumer keeps a timer; no gh, no mod.json read", async () => {
  const { view, cx } = await mount("drover-room", roomState({ "drover-room": { enabled: false } }), roomHost);
  assert.match(await show(view, cx), new RegExp(STUB));
  await tickAll(cx); await idle();
  quiet([15000]);
});

test("room off -> on -> off -> on", async () => {
  const { view, cx } = await mount("drover-room", roomState({ "drover-room": { enabled: false } }), roomHost);
  await show(view, cx);
  setConfig({});
  assert.doesNotMatch(await show(view, cx), new RegExp(STUB));
  assert.equal(prList().length, 1, "turning it on loads the run's context");
  assert.deepEqual(log.timers.map((t) => t.ms), [15000, 30000]);
  setConfig({ "drover-room": { enabled: false } });
  assert.match(await show(view, cx), new RegExp(STUB));
  globalThis.__host.state["drover.room"] = {};
  await tickAll(cx); await idle();
  assert.equal(prList().length, 1, "a tick while off does nothing");
  setConfig({});
  await show(view, cx);
  assert.equal(prList().length, 2, "back on: loads again");
  assert.equal(log.timers.length, 2, "the 30s timer is started once");
});

test("room: a context load in flight when it is switched off is dropped (nothing written)", async () => {
  const gate = deferred();
  const { view, cx } = await mountNow("drover-room", roomState(), { ...roomHost, exec: async (cmd, args) => { log.exec.push([cmd, ...args].join(" ")); await gate.promise; return { code: 0, stdout: "[]", stderr: "" }; } });
  await until(() => { textNow(view, cx); return prList().length === 1; }, "the room load is in flight (held)");
  setConfig({ "drover-room": { enabled: false } });
  textNow(view, cx);
  gate.resolve();
  await idle();
  assert.equal(globalThis.__host.state["drover.room"], undefined, "no write while off");
  assert.equal(view.loading, null);
});

// ---- Work: Board, Todos, Tasks. watchInbox (the CLI queue: drain -> launch/exec/hc, reaping) keeps running while off (G2):
// its 30s timer is the one a switched-off Board keeps; Tasks also keeps watchWakes (15s). Nothing else of theirs starts.
test("board off: stub text; only the CLI inbox consumer's timer remains; nothing else runs", async () => {
  const { view, cx } = await mount("drover-board", off("drover-board"));
  assert.match(await show(view, cx), new RegExp(STUB));
  await idle();
  quiet([30000]);
});

test("board off -> on -> off -> on: the board comes back without a restart, filter text and selection kept", async () => {
  const { view, cx } = await mount("drover-board", off("drover-board"));
  await show(view, cx);
  view.input.set_value("p1"); view.query = "p1"; view.selected = "T-1";
  setConfig({});
  const on = await show(view, cx);
  assert.doesNotMatch(on, new RegExp(STUB));
  assert.match(on, /Todo|Doing|Review/);
  setConfig(off("drover-board")[CFG]);
  assert.match(await show(view, cx), new RegExp(STUB));
  setConfig({});
  assert.doesNotMatch(await show(view, cx), new RegExp(STUB));
  assert.deepEqual([view.query, view.selected], ["p1", "T-1"]);
  assert.deepEqual(log.exec, [], "the board itself never calls exec");
});

test("todos list off: stub text, no timer, no exec, no read; on again shows the list", async () => {
  const { view, cx } = await mount("drover-todos", off("drover-todos"));
  assert.match(await show(view, cx), new RegExp(STUB));
  await idle();
  quiet();
  setConfig({});
  const on = await show(view, cx);
  assert.doesNotMatch(on, new RegExp(STUB));
  assert.match(on, /No tasks yet/);
  setConfig(off("drover-todos")[CFG]);
  assert.match(await show(view, cx), new RegExp(STUB));
});

test("todos: the task editor dialog (opened by the Board, Tasks and the CLI) still opens while the Todos list is off", async () => {
  host(off("drover-todos"), { props: { overlay: "o1", edit: null } });
  const { default: Todos } = await import(new URL("../drover-todos/main.js", import.meta.url).href);
  const v = new Todos();
  v.init({}, cxOf());
  assert.ok(v.editor, "an Editor, not the list");
  assert.doesNotMatch(withRec(() => v.render(cxOf())).rec.texts.join("\n"), new RegExp(STUB));
});

test("tasks off: draws nothing (an empty div, no stub text, no rows); keeps the CLI consumers' timers only; no exec", async () => {
  const { view, cx } = await mount("drover-tasks", { ...off("drover-tasks"), "drover.tasks": [{ id: "T-1", title: "visible task", column: "doing", tags: [], priority: "p2" }] });
  assert.equal(await show(view, cx), "", "no text at all");
  assert.deepEqual(globalThis.__rec, undefined);
  const { rec } = withRec(() => view.render(cx));
  assert.deepEqual(rec.ids, [], "no elements with ids");
  await idle();
  quiet([30000, 15000]);
});

test("tasks off -> on -> off -> on", async () => {
  const { view, cx } = await mount("drover-tasks", off("drover-tasks"));
  assert.equal(await show(view, cx), "");
  setConfig({});
  assert.match(await show(view, cx), /Tasks/);
  setConfig(off("drover-tasks")[CFG]);
  assert.equal(await show(view, cx), "");
  setConfig({});
  assert.match(await show(view, cx), /Tasks/);
});

// ---- Squads: Agents, Runs, Wakeups, Projects, Reader ----
const shows = async (view, cx) => ({ view, cx, text: await show(view, cx) });
// G2: off is screen only. The drover CLI queue (inbox commands, wakeup delivery) is served by Tasks, Board, Wakeups and Room
// whether or not their screen is on.
test("a CLI command in the inbox is still served while the Tasks, Board and Wakeups screens are off", async () => {
  mkdirSync(join(TMP, "data/drover-inbox"), { recursive: true });
  for (const mod of ["drover-tasks", "drover-board", "drover-wakeups"]) {
    const name = `${mod}-${Date.now()}.json`;
    writeFileSync(join(TMP, "data/drover-inbox", name), JSON.stringify({ op: "add", title: `from the CLI via ${mod}` }));
    const { view, cx } = await mount(mod, off(mod));
    await show(view, cx);
    // The inbox drain reads real files with node fs, so its result arrives when the OS delivers it: wait for the condition (the hang guard
    // in until() is not a timing expectation: the happy path returns as soon as the state matches).
    const want = new RegExp(`from the CLI via ${mod}`);
    await until(() => { textNow(view, cx); return want.test(JSON.stringify(globalThis.__host.state)); }, `${mod}: the inbox add command was applied`);
    assert.match(JSON.stringify(globalThis.__host.state), want, `${mod}: the add command was applied while off`);
  }
});

test("a due wakeup is delivered (hc send) while the Tasks screen is off", async () => {
  const w = { id: "W-2", target: "t7", text: "ping tasks", due: Date.now() - 1000, status: "scheduled", created: Date.now() - 5000, enabled: true };
  const { view, cx } = await mount("drover-tasks", { ...off("drover-tasks"), "drover.wakeups": [w] }, { agents: [{ address: "t7", status: "idle" }], terminals: [{ address: "t7" }] });
  await show(view, cx);
  await until(() => log.hc.length >= 1, "the due wake was sent");
  assert.deepEqual(log.hc, ["send t7 ping tasks"]);
});

const isStub = (text) => new RegExp(STUB).test(text);

test("agents (Squads) off: stub text, no reaper timer, no env-name read; on again starts it once", async () => {
  const { view, cx } = await mount("drover-agents", off("drover-agents"));
  assert.match(await show(view, cx), new RegExp(STUB));
  await idle();
  quiet();
  setConfig({});
  const on = await show(view, cx);
  assert.match(on, /Agents & Squads/);
  assert.deepEqual(log.timers.map((t) => t.ms), [30000]);
  setConfig(off("drover-agents")[CFG]);
  assert.match(await show(view, cx), new RegExp(STUB));
  setConfig({});
  await show(view, cx);
  assert.equal(log.timers.length, 1, "the timer is started once");
});

test("agents: the picker and editor dialogs other screens open are not switched off with the screen", async () => {
  host(off("drover-agents"), { props: { overlay: "o1", agent: null } });
  const { default: Agents } = await import(new URL("../drover-agents/main.js", import.meta.url).href);
  const cx = cxOf();
  const v = new Agents();
  v.init({}, cx);
  assert.ok(v.dialog);
  assert.equal(isStub(withRec(() => v.render(cx)).rec.texts.join("\n")), false);
});

// A run whose terminal is gone while another terminal is alive: observeEnded() stamps it ended (a shared write, and it can kill parked workers).
const ENDED_RUN = { ...RUN, terminals: [{ address: "t1", name: "Lead", role: "leader", agent: "x", started: 1 }] };
const endedHost = { terminals: [{ address: "t9" }], agents: [] };

test("runs off: stub text, no observeEnded (no shared write, no kill), no timer; on again observes and starts the timer once", async () => {
  const state = { ...off("drover-runs"), "drover.runs": [ENDED_RUN] };
  const before = JSON.stringify(state["drover.runs"]);
  const { view, cx } = await mount("drover-runs", state, endedHost);
  assert.match(await show(view, cx), new RegExp(STUB));
  await tickAll(cx); await idle();
  quiet();
  assert.equal(JSON.stringify(globalThis.__host.state["drover.runs"]), before, "runs untouched while off");
  setConfig({});
  assert.doesNotMatch(await show(view, cx), new RegExp(STUB));
  assert.notEqual(JSON.stringify(globalThis.__host.state["drover.runs"]), before, "on: the ended run is observed");
  assert.deepEqual(log.timers.map((t) => t.ms), [60000]);
  setConfig(off("drover-runs")[CFG]);
  assert.match(await show(view, cx), new RegExp(STUB));
  assert.equal(log.timers.length, 1);
});

test("wakeups off: stub text; only the CLI inbox and wakeup consumers keep their timers; on adds the countdown timer once", async () => {
  const { view, cx } = await mount("drover-wakeups", off("drover-wakeups"));
  assert.match(await show(view, cx), new RegExp(STUB));
  await idle();
  quiet([30000, 15000]);
  setConfig({});
  assert.doesNotMatch(await show(view, cx), new RegExp(STUB));
  assert.deepEqual(log.timers.map((t) => t.ms), [30000, 15000, 30000]);
  setConfig(off("drover-wakeups")[CFG]);
  assert.match(await show(view, cx), new RegExp(STUB));
  setConfig({});
  await show(view, cx);
  assert.equal(log.timers.length, 3, "the countdown timer is started once");
});

test("wakeups: a due wakeup is still delivered while the screen is off (the queue is not the screen)", async () => {
  const w = { id: "W-1", target: "t7", text: "ping", due: Date.now() - 1000, status: "scheduled", created: Date.now() - 5000, enabled: true };
  const { view, cx } = await mount("drover-wakeups", { ...off("drover-wakeups"), "drover.wakeups": [w] }, { agents: [{ address: "t7", status: "idle" }], terminals: [{ address: "t7" }] });
  await show(view, cx);
  await until(() => log.hc.length >= 1, "the due wake was sent");
  assert.deepEqual(log.hc, ["send t7 ping"]);
});

test("projects off: stub text, nothing else runs; on again lists projects", async () => {
  const { view, cx } = await mount("drover-projects", off("drover-projects"));
  assert.match(await show(view, cx), new RegExp(STUB));
  quiet();
  setConfig({});
  assert.doesNotMatch(await show(view, cx), new RegExp(STUB));
  setConfig(off("drover-projects")[CFG]);
  assert.match(await show(view, cx), new RegExp(STUB));
  quiet();
});

// Reader: a terminal with a session label makes a load an exec (find).
const readerHost = { props: { terminal: "t1" }, terminals: [{ address: "t1", labels: { "revive.session": "S1" }, agent: "claude-code" }], agents: [{ address: "t1", app: "claude" }] };
const finds = () => log.exec.filter((c) => c.startsWith("find "));

test("reader off: stub text, no timer, no find, no transcript read; on starts reading, off stops, on again reads", async () => {
  const { view, cx } = await mount("drover-reader", off("drover-reader"), readerHost);
  assert.match(await show(view, cx), new RegExp(STUB));
  await tickAll(cx); await idle();
  quiet();
  setConfig({});
  assert.doesNotMatch(await show(view, cx), new RegExp(STUB));
  assert.equal(finds().length, 1, "turning it on locates the transcript");
  assert.equal(dataReads().length, 1, "and reads it");
  assert.deepEqual(log.timers.map((t) => t.ms), [5000]);
  setConfig(off("drover-reader")[CFG]);
  assert.match(await show(view, cx), new RegExp(STUB));
  await tickAll(cx); await idle();
  assert.equal(dataReads().length, 1, "a tick while off reads nothing");
  setConfig({});
  await show(view, cx);
  assert.equal(dataReads().length, 2, "back on: reads again (the located path is cached)");
  assert.equal(log.timers.length, 1, "the timer is started once");
});

test("reader: a read in flight when it is switched off is dropped (state not updated)", async () => {
  const gate = deferred();
  const { view, cx } = await mountNow("drover-reader", {}, { ...readerHost, exec: async (cmd, args) => { log.exec.push([cmd, ...args].join(" ")); await gate.promise; return { code: 0, stdout: "", stderr: "" }; } });
  await until(() => finds().length === 1, "the find is in flight (held)");
  setConfig(off("drover-reader")[CFG]);
  textNow(view, cx);
  gate.resolve();
  await idle();
  assert.deepEqual(view.state, { loading: true }, "the late answer was dropped");
});

// ---- review-1 regressions ----
// A transcript line the Reader parses into one entry with this text.
const claudeLine = (text) => JSON.stringify({ type: "user", message: { content: text } }) + "\n";

test("github: a multi-scope load switched off after its first gh call starts no further gh call", async () => {
  const gate = deferred();
  let first = true;
  const { view, cx } = await mountNow("drover-github", { "drover.github.scopes": ["acme", "beta"] }, {
    exec: async (cmd, args) => { log.exec.push([cmd, ...args].join(" ")); if (first) { first = false; await gate.promise; } return { code: 0, stdout: "[]", stderr: "" }; },
  });
  await until(() => ghCalls().length === 1, "the first scope is in flight (held)");
  setConfig(off("drover-github")[CFG]);
  assert.match(textNow(view, cx), new RegExp(STUB));
  gate.resolve();
  await idle();
  assert.equal(ghCalls().length, 1, "the second scope is not requested while off");
  assert.equal(globalThis.__host.state["drover.github.snapshot"], undefined);
});

test("room: a context load switched off after its first gh call starts no further gh call (carriedBy)", async () => {
  const gate = deferred();
  let first = true;
  const { view, cx } = await mountNow("drover-room", roomState(), { ...roomHost,
    exec: async (cmd, args) => { log.exec.push([cmd, ...args].join(" ")); if (first) { first = false; await gate.promise; } return { code: 0, stdout: "[]", stderr: "" }; } });
  await until(() => { textNow(view, cx); return prList().length === 1; }, "the branch query is in flight (held)");
  setConfig({ "drover-room": { enabled: false } });
  assert.match(textNow(view, cx), new RegExp(STUB));
  gate.resolve();
  await idle();
  assert.deepEqual(log.exec.filter((c) => c.includes("--state open")), [], "no carried-by query while off");
  assert.equal(globalThis.__host.state["drover.room"], undefined);
});

test("reader: a find that finishes after it was switched off does not start the transcript read", async () => {
  const gate = deferred();
  const { view, cx } = await mountNow("drover-reader", {}, { ...readerHost, exec: async (cmd, args) => { log.exec.push([cmd, ...args].join(" ")); await gate.promise; return { code: 0, stdout: "/fake/session.jsonl\n", stderr: "" }; } });
  await until(() => finds().length === 1, "the find is in flight (held)");
  setConfig(off("drover-reader")[CFG]);
  textNow(view, cx);
  gate.resolve();
  await idle();
  assert.deepEqual(log.read.filter((p) => !/mod\.json$/.test(p)), [], "no transcript read while off");
});

test("reader: an old read from before a disable cannot overwrite the read started by the re-enable", async () => {
  const gates = [deferred(), deferred()];
  let n = 0;
  const { view, cx } = await mountNow("drover-reader", {}, { ...readerHost,
    exec: async (cmd, args) => { log.exec.push([cmd, ...args].join(" ")); return { code: 0, stdout: "/fake/session.jsonl\n", stderr: "" }; },
    readTextFile: async (p) => { if (/mod\.json$/.test(p)) return null; log.read.push(p); const i = n++; await gates[i].promise; return claudeLine(i === 0 ? "OLD" : "NEW"); } });
  await until(() => log.read.length === 1, "the first read is held");
  setConfig(off("drover-reader")[CFG]);
  textNow(view, cx);
  setConfig({});
  textNow(view, cx);
  await until(() => log.read.length === 2, "the re-enable started a second read (held)");
  gates[1].resolve();
  await until(() => view.state.entries?.[0]?.text === "NEW", "the new read landed");
  gates[0].resolve();
  await idle();
  assert.equal(view.state.entries?.[0]?.text, "NEW", "the late old read is dropped");
});

test("jira: a JQL typed while the first-enable settings load is pending is kept", async () => {
  const gate = deferred();
  const dis = { "drover-jira": { site: "acme.atlassian.net", enabled: false } };
  const { view, cx } = await mountNow("drover-jira", { [CFG]: dis }, { readTextFile: async (p) => { log.read.push(p); if (/mod\.json$/.test(p)) { await gate.promise; return null; } return null; } });
  setConfig({ "drover-jira": { site: "acme.atlassian.net" } });
  textNow(view, cx);
  view.input.set_value("project = MYDRAFT");
  gate.resolve();
  await idle();
  assert.equal(view.input.value(), "project = MYDRAFT");
});

// Inherited enabled (mod.json settings) with no shared override: every gate loads its own settings first.
const SCREENS_CFG = [
  ["drover-github", [], {}], ["drover-jira", [], {}], ["drover-room", [15000], roomHost], ["drover-board", [30000], {}], ["drover-todos", [], {}], ["drover-tasks", [30000, 15000], {}],
  ["drover-agents", [], {}], ["drover-runs", [], {}], ["drover-wakeups", [30000, 15000], {}], ["drover-projects", [], {}], ["drover-reader", [], readerHost],
];
const inheritedHost = (mod, settings) => ({ readTextFile: async (p) => { log.read.push(p); return new RegExp(`mods/${mod}/mod\\.json$`).test(p) ? JSON.stringify({ settings }) : null; } });

for (const [mod, timers, extra] of SCREENS_CFG) {
  test(`${mod}: enabled=false inherited from mod.json hides the screen and starts no work; a shared override beats it; Reset returns to off`, async () => {
    const { view, cx } = await mount(mod, {}, { ...extra, ...inheritedHost(mod, { enabled: false }) });
    const isOff = (text) => (mod === "drover-tasks" ? text === "" : new RegExp(STUB).test(text)); // Tasks draws nothing
    assert.ok(isOff(await show(view, cx)), "stub once the settings are loaded");
    await tickAll(cx); await idle();
    assert.deepEqual(log.exec, []);
    assert.deepEqual(dataReads(), []);
    assert.deepEqual(log.fetch, []);
    assert.deepEqual(log.timers.map((t) => t.ms), timers);
    setConfig({ [mod]: { enabled: true } });
    assert.equal(isOff(await show(view, cx)), false, "the shared override beats mod.json");
    setConfig({});
    assert.ok(isOff(await show(view, cx)), "Reset to inherited turns it off again");
  });
}

test("tabs: an inherited enabled=false hides the screen from the menu and presets, and the Tasks capsule does nothing", async () => {
  const mods = { "drover-github": { enabled: false }, "drover-tasks": { enabled: false } };
  const readSettings = { readTextFile: async (p) => { log.read.push(p); const m = /mods\/([^/]+)\/mod\.json$/.exec(p)?.[1]; return mods[m] ? JSON.stringify({ settings: mods[m] }) : null; } };
  host({}, { props: { menu: "drover", overlay: "o" }, ...readSettings, layout: { id: "root", children: [{ id: "drover", hidden: false }] } });
  const { default: TabsView } = await import(new URL("../drover-tabs/main.js", import.meta.url).href);
  const cx = cxOf();
  const v = new TabsView();
  v.init({}, cx);
  await idle();
  const ids = withRec(() => v.render(cx)).rec.ids;
  assert.equal(ids.includes("s-drover-github"), false);
  assert.equal(ids.includes("p-Sources"), false);
  assert.equal(ids.includes("p-Work"), false);
  assert.ok(ids.includes("s-drover-board"));
  globalThis.__host.props = {};
  globalThis.__rec = { ids: [], texts: [] };
  try { findNode(v.render(cx)[NODE], "tasks").args.on_click[0](); } finally { globalThis.__rec = undefined; }
  assert.deepEqual(log.runs, []);
  setConfig({ "drover-github": { enabled: true } });
  globalThis.__host.props = { menu: "drover", overlay: "o" };
  assert.ok(withRec(() => v.render(cx)).rec.ids.includes("s-drover-github"), "a shared override wins over the inherited off");
});

// ---- review-2: nothing is shown or started before a screen's settings are ready ----
// mod.json reads are held until release(); then they answer { settings }. Render happens right after init, before any settle.
function heldSettings(settings) {
  const gate = deferred();
  return { release: () => gate.resolve(), extra: { readTextFile: async (p) => { log.read.push(p); if (/mod\.json$/.test(p)) { await gate.promise; return JSON.stringify({ settings }); } return null; } } };
}

for (const [mod, timers, extra] of SCREENS_CFG) {
  test(`${mod}: before its settings are ready it renders a neutral view, shows no content and does no work; then the inherited off applies`, async () => {
    const held = heldSettings({ enabled: false });
    const { view, cx } = await mountNow(mod, {}, { ...extra, ...held.extra });
    assert.equal(textNow(view, cx), "", "no content and no stub while loading");
    assert.deepEqual(log.exec, []);
    assert.deepEqual(dataReads(), []);
    assert.deepEqual(log.fetch, []);
    held.release();
    await idle();
    const after = textNow(view, cx);
    assert.ok(mod === "drover-tasks" ? after === "" : new RegExp(STUB).test(after), "off once loaded");
    assert.deepEqual(log.exec, []);
    assert.deepEqual(dataReads(), []);
    assert.deepEqual(log.timers.map((t) => t.ms), timers);
  });

  test(`${mod}: a shared override decides at once, without waiting for the settings`, async () => {
    const held = heldSettings({});
    const off1 = await mountNow(mod, { [CFG]: { [mod]: { enabled: false } } }, { ...extra, ...held.extra });
    const t = textNow(off1.view, off1.cx);
    assert.ok(mod === "drover-tasks" ? t === "" : new RegExp(STUB).test(t), "shared false: stub immediately");
    held.release();
    await idle();
  });
}

test("room: a focused run with a branch is not queried while the settings are pending", async () => {
  const held = heldSettings({ enabled: false });
  const { view, cx } = await mountNow("drover-room", roomState(), { ...roomHost, ...held.extra });
  textNow(view, cx);
  assert.deepEqual(log.exec, [], "no gh before the settings are ready");
  held.release();
  await idle();
  textNow(view, cx);
  assert.deepEqual(log.exec, []);
});

test("agents: the env files of the default agents are not read while the settings are pending", async () => {
  const held = heldSettings({ enabled: false });
  const { view, cx } = await mountNow("drover-agents", {}, held.extra);
  textNow(view, cx);
  assert.deepEqual(dataReads(), []);
  held.release();
  await idle();
});

test("tabs: no screen entry is offered until the settings are ready; a shared false hides at once; a mod without settings becomes ready", async () => {
  const held = heldSettings({ enabled: false });
  host({ [CFG]: { "drover-reader": { enabled: false } } }, { props: { menu: "drover", overlay: "o" }, ...held.extra });
  const { default: TabsView } = await import(new URL("../drover-tabs/main.js", import.meta.url).href);
  const cx = cxOf();
  const v = new TabsView();
  v.init({}, cx);
  let ids = withRec(() => v.render(cx)).rec.ids;
  assert.equal(ids.some((i) => i.startsWith("s-drover-")), false, "no entry while loading");
  assert.equal(ids.some((i) => i.startsWith("p-")), false, "no preset while loading");
  held.release();
  await idle();
  ids = withRec(() => v.render(cx)).rec.ids;
  assert.equal(ids.includes("s-drover-todos"), false, "inherited off");
  host({}, { props: { menu: "drover", overlay: "o" } });
  const w = new TabsView();
  const cx2 = cxOf();
  w.init({}, cx2);
  await idle();
  assert.ok(withRec(() => w.render(cx2)).rec.ids.includes("s-drover-todos"), "no settings anywhere: ready, shown");
});

// ---- review-3: one stuck settings read must not block the other screens in the menu ----
test("tabs: a settings read that never resolves hides only its own screen; the others load and repaint", async () => {
  let notified = 0;
  host({}, { props: { menu: "drover", overlay: "o" },
    readTextFile: async (p) => { log.read.push(p); if (/mods\/drover-github\/mod\.json$/.test(p)) return new Promise(() => {}); return null; } });
  const { default: TabsView } = await import(new URL("../drover-tabs/main.js", import.meta.url).href);
  const cx = { ...cxOf(), notify() { notified++; }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) };
  const v = new TabsView();
  v.init({}, cx);
  await until(() => notified >= 9, "every readable settings read repainted");
  const ids = withRec(() => v.render(cx)).rec.ids;
  assert.equal(ids.includes("s-drover-github"), false, "the stuck screen stays hidden");
  for (const m of ["todos", "board", "jira", "agents", "runs", "wakeups", "projects", "reader"]) assert.ok(ids.includes(`s-drover-${m}`), `${m} is offered`);
  assert.ok(ids.includes("p-Squads"), "a preset whose screens are ready is offered");
  assert.equal(ids.includes("p-Sources"), false, "Sources needs GitHub");
  assert.ok(notified >= 9, "repainted as each read settled");
});
