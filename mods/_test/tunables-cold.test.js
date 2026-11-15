// Card 5 review round 1: a COLD View.init (nothing bound, nothing loaded) must still apply drover.config and the mod.json fallback
// layer: overlay dialogs (task editor, wakeup dialog), the Tasks-only inbox consumer, and Room settings read for loadContext from Todos.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const TMP = mkdtempSync(join(tmpdir(), "cold-"));
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0, stdout: "[]", stderr: "" }), readTextFile: async () => null, home: "/h", appHome: TMP };
const C = await import("../_lib/config.js");
const W = await import("../_lib/wake.js");
const IO = await import("../_lib/io.js");

const CFG = "drover.config";
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
// Every cx.spawn (also one started inside another, or from a timer tick) is counted while it runs, so idle() resolves when the mod has no async work left in flight.
let flight = { n: 0 }; // reset by host(): a spawn of an earlier test can end late without touching this count
const idle = () => until(() => flight.n === 0, "no spawned work in flight");
let timers, reads;
// settingsByMod: what each mod's mod.json `settings` block holds (read through readTextFile, like modSettings does).
function host({ state = {}, props = {}, settingsByMod = {}, extra = {} } = {}) {
  C.resetCache();
  timers = []; reads = []; flight = { n: 0 };
  Object.assign(globalThis.__host, {
    props, state, notified: [], appHome: TMP, watchFolder: () => new Promise(() => {}), agents: [], terminals: [],
    readTextFile: async (p) => { reads.push(p); const m = /mods\/([^/]+)\/mod\.json$/.exec(p); return m && settingsByMod[m[1]] ? JSON.stringify({ settings: settingsByMod[m[1]] }) : null; },
    ...extra,
  });
}
// Host contexts do not survive an await (installed AGENTS.md: fresh callback contexts, cx.spawn for async work): an init cx is dead once
// init returns (expire()), a timer callback or spawn body gets a fresh one, and any call on a dead one throws.
const cxOf = () => {
  let dead = false;
  const live = (what) => { if (dead) throw new Error(`stale cx: ${what}`); };
  const fresh = () => cxOf().cx;
  const mine = flight;
  const cx = { notify() { live("notify"); }, stop_propagation() {}, focus_handle: () => ({ focus() {} }),
    spawn: (fn) => { live("spawn"); mine.n++; return Promise.resolve().then(() => fn(fresh())).finally(() => { mine.n--; }); },
    timer: { every: (ms, fn) => { live("timer.every"); timers.push({ ms, fn: () => fn(fresh()) }); }, after: () => {} } };
  return { cx, expire: () => { dead = true; } };
};
// ready: the condition the test asserts next (mounted views may keep a watcher spawn running for good, so "no spawn in flight" is not a fit here).
const mount = async (mod, opts, ready = () => true) => {
  host(opts);
  const { default: V } = await import(new URL(`../${mod}/main.js`, import.meta.url).href);
  const v = new V();
  const c = cxOf();
  v.init({}, c.cx);
  c.expire();
  await until(ready, `${mod} cold startup finished`);
  return v;
};

beforeEach(() => host());

test("cold task-editor overlay applies shared overrides: context refresh timer and PR cap", async () => {
  const task = { id: "T-1", title: "t", desc: "", column: "todo", priority: "P2", tags: [], notes: [], created: 1 };
  await mount("drover-todos", { props: { overlay: "o", edit: "T-1" }, state: { "drover.tasks": [task], [CFG]: { "drover-todos": { context_refresh_seconds: 5, pr_cap: 1 } } } }, () => timers.length > 0);
  assert.deepEqual(timers.map((t) => t.ms).filter((ms) => ms !== 0), [5000], "the configured interval, not the 60s default");
  assert.equal(C.cfg("drover-todos", "pr_cap"), 1);
});

test("cold task-editor overlay loads the mod.json fallback of Todos before it installs the timer, with the screen gate off", async () => {
  const task = { id: "T-1", title: "t", desc: "", column: "todo", priority: "P2", tags: [], notes: [], created: 1 };
  await mount("drover-todos", { props: { overlay: "o", edit: "T-1" }, state: { "drover.tasks": [task], [CFG]: { "drover-todos": { enabled: false } } }, settingsByMod: { "drover-todos": { context_refresh_seconds: 7 } } }, () => timers.length > 0);
  assert.deepEqual(timers.map((t) => t.ms), [7000], "a dialog is never blocked by the screen being off");
});

test("cold wakeup dialog enforces the shared minimum, and the dialog still opens when the Wakeups screen is off", async () => {
  const v = await mount("drover-wakeups", { props: { overlay: "o", wakeEdit: null, wakeTarget: "t7" }, state: { [CFG]: { "drover-wakeups": { min_repeat_minutes: 15, enabled: false } } } }, () => C.ready("drover-wakeups"));
  assert.equal(W.addWake([], { target: "t7", text: "x", every: "10m" }).error, "Repeat at most every 15m");
  assert.ok(v.editor, "the editor opened");
});

test("cold wakeup dialog uses the mod.json fallback (inherited expiry)", async () => {
  await mount("drover-wakeups", { props: { overlay: "o", wakeEdit: null, wakeTarget: "t7" }, settingsByMod: { "drover-wakeups": { expiry_hours: 6 } } }, () => C.ready("drover-wakeups"));
  assert.equal(W.addWake([], { target: "t7", text: "x", when: "now" }, 1000).wake.expires, 1000 + 6 * 3600000);
});

// ---- Tasks-only inbox consumer: runs and wakeups policy come from their mod.json, which nothing else loaded ----
const inbox = join(TMP, "data/drover-inbox");
let seq = 0;
async function cli(cmd) {
  mkdirSync(inbox, { recursive: true });
  const name = `c${seq++}`;
  writeFileSync(join(inbox, `${name}.json`), JSON.stringify(cmd));
  const file = join(inbox, `${name}.result`);
  await until(() => readdirSync(inbox).includes(`${name}.result`) && readFileSync(file, "utf8"), `the inbox answered ${name}`);
  return readFileSync(file, "utf8");
}
test("Tasks-only inbox startup: the wake op follows min_repeat_minutes from the Wakeups mod.json", async () => {
  host({ settingsByMod: { "drover-wakeups": { min_repeat_minutes: 15 }, "drover-runs": { max_parallel: 4, kept: 50 } } });
  const { default: Tasks } = await import("../drover-tasks/main.js");
  { const c = cxOf(); new Tasks().init({}, c.cx); c.expire(); }
  const reply = await cli({ op: "wake", target: "t7", text: "x", every: "10m" });
  assert.equal(reply, "error: Repeat at most every 15m");
  assert.equal(C.ready("drover-runs"), true, "runs settings loaded at the inbox boundary");
  assert.equal(IO.maxRunsNow?.() ?? (await import("../_lib/runs.js")).maxRuns(), 4);
  assert.equal((await import("../_lib/runs.js")).keptRuns(), 50);
});

test("Room inherited pr_cap=1 limits the linked PR requests and rows (loadContext from Todos)", async () => {
  host({ settingsByMod: { "drover-room": { pr_cap: 1 } } });
  C.bind({ shared: (k) => globalThis.__host.state[k], modSettings: IO.modSettings });
  const calls = [];
  const pr = (n) => ({ number: n, title: `pr${n}`, state: "OPEN", isDraft: false, url: `https://github.com/o/r/pull/${n}`, createdAt: "2026-01-01T00:00:00Z" });
  globalThis.__host.exec = async (cmd, args) => {
    calls.push(args.join(" "));
    if (args[0] === "issue") return { code: 0, stdout: JSON.stringify({ number: 1, title: "i", state: "OPEN", assignees: [], url: "https://github.com/o/r/issues/1", closedByPullRequestsReferences: [{ url: "https://github.com/o/r/pull/11" }, { url: "https://github.com/o/r/pull/12" }] }), stderr: "" };
    return { code: 0, stdout: JSON.stringify(pr(Number(args[2].split("/").pop()))), stderr: "" };
  };
  const out = await IO.loadContext({ id: "r1", terminals: [] }, { id: "T-1", source: { kind: "github", url: "https://github.com/o/r/issues/1" } });
  assert.deepEqual(out.errors, []);
  assert.equal(calls.filter((c) => c.startsWith("pr view")).length, 1, "one PR request");
  assert.equal(out.prs.length, 1, "one PR row");
});

test("watchWakes delivers a due wake with a fresh cx: the wake ends sent, never stranded as sending", async () => {
  const due = { id: "W-1", target: "t7", text: "ping", due: Date.now() - 1000, expires: Date.now() + 1e6, status: "scheduled", created: 1, enabled: true };
  const sent = [];
  host({ state: { "drover.wakeups": [due] }, extra: { agents: [{ address: "t7", status: "idle" }], terminals: [{ address: "t7" }], hc: async (a) => { sent.push(a.join(" ")); return { code: 0, stdout: "", stderr: "" }; } } });
  const c = cxOf();
  IO.watchWakes(c.cx);
  c.expire();
  await until(() => globalThis.__host.state["drover.wakeups"]?.[0].status === "sent", "the due wake was delivered");
  assert.deepEqual(sent, ["send t7 ping"]);
  assert.equal(globalThis.__host.state["drover.wakeups"][0].status, "sent");
  await Promise.all(timers.map((t) => t.fn())); // the 15s tick also runs on a fresh cx
});

test("wakeup dialog: Save while the inherited policy is still loading waits for it, then applies the inherited minimum", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  host({ props: { overlay: "o", wakeEdit: null, wakeTarget: "t7" }, extra: { closeOverlay: () => { closed++; }, readTextFile: async (p) => { await gate; return /drover-wakeups\/mod\.json$/.test(p) ? JSON.stringify({ settings: { min_repeat_minutes: 15 } }) : null; } } });
  let closed = 0;
  const { default: Wakeups } = await import("../drover-wakeups/main.js");
  const v = new Wakeups(), c = cxOf();
  v.init({}, c.cx); c.expire();
  const ed = v.editor;
  ed.kind = "every"; ed.minutes.set_value("10"); ed.text.set_value("ping");
  ed.submit(cxOf().cx);
  await drain(); // nothing may happen while the policy read is held: a bounded drain, not a wait for a result
  assert.equal(closed, 0, "Save does not run on defaults while the policy is loading");
  assert.equal((globalThis.__host.state["drover.wakeups"] ?? []).length, 0);
  release();
  await until(() => ed.error, "the held Save finished");
  assert.equal(ed.error, "Repeat at most every 15m");
  assert.equal(closed, 0);
});

// ---- cold list-screen startup: ensureStarted must use the callback/spawned cx, never the stored init cx (dead after init) ----
const LIST_SCREENS = [["drover-room", 30000], ["drover-wakeups", 30000], ["drover-reader", 5000], ["drover-runs", 60000]];
for (const [mod, ms] of LIST_SCREENS) {
  test(`${mod}: cold list-screen startup installs its timer with a live cx (init cx expired)`, async () => {
    const v = await mount(mod, {}, () => timers.some((t) => t.ms === ms));
    assert.ok(timers.some((t) => t.ms === ms), `${mod}: timer ${ms} installed, got ${timers.map((t) => t.ms)}`);
    await Promise.all(timers.map((t) => t.fn())); // a tick runs on a fresh cx and does not throw
    assert.ok(v);
  });
}

test("drover-reader: re-enable after off reads again with the render cx, not the dead init cx", async () => {
  const v = await mount("drover-reader", {}, () => timers.some((t) => t.ms === 5000));
  assert.ok(timers.some((t) => t.ms === 5000));
  globalThis.__host.state[CFG] = { "drover-reader": { enabled: false } };
  v.render(cxOf().cx);
  assert.equal(v.stopped, true);
  globalThis.__host.state[CFG] = {};
  const reads0 = reads.length;
  assert.doesNotThrow(() => v.render(cxOf().cx));
  await idle();
  assert.equal(v.stopped, false);
  assert.ok(reads.length >= reads0);
});

// ---- Squads, Jira and GitHub: same rule, a cold start never keeps the init cx for its timer or later reads ----
// The stub input has no token content model; GitHub's filter controller needs one at init.
const { InputState: StubInput } = await import(new URL("./stubs/gpui-base.js", import.meta.url).href);
StubInput.prototype.content ??= function () { return { text: this.v ?? "", tokens: [] }; };
StubInput.prototype.set_value = function (v) { this.v = typeof v === "string" ? v : v.text; this.sel = { start: this.v.length, end: this.v.length }; };
const COLD_SCREENS = [["drover-agents", 30000], ["drover-jira", 60000], ["drover-github", 300000]];
for (const [mod, ms] of COLD_SCREENS) {
  test(`${mod}: cold startup installs its timer with a live cx (init cx expired)`, async () => {
    const v = await mount(mod, {}, () => timers.some((t) => t.ms === ms));
    assert.ok(timers.some((t) => t.ms === ms), `${mod}: timer ${ms} installed, got ${timers.map((t) => t.ms)}`);
    await Promise.all(timers.map((t) => t.fn())); // a tick runs on a fresh cx and does not throw
    assert.ok(v);
  });
}

test("drover-jira: re-enable after off reloads with the render cx, not the dead init cx", async () => {
  const v = await mount("drover-jira", { state: { [CFG]: { "drover-jira": { site: "acme.atlassian.net" } } } }, () => timers.length > 0);
  globalThis.__host.state[CFG] = { "drover-jira": { enabled: false } };
  v.render(cxOf().cx);
  globalThis.__host.state[CFG] = { "drover-jira": { site: "acme.atlassian.net" } };
  assert.doesNotThrow(() => v.render(cxOf().cx));
  await idle();
});

test("drover-github: re-enable after off reloads with the render cx, not the dead init cx", async () => {
  const v = await mount("drover-github", {}, () => timers.length > 0);
  globalThis.__host.state[CFG] = { "drover-github": { enabled: false } };
  v.render(cxOf().cx);
  globalThis.__host.state[CFG] = {};
  assert.doesNotThrow(() => v.render(cxOf().cx));
  await idle();
});
