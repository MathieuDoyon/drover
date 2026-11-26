// T-MWXRH2E0KIS: the Needs-you page is actionable: Dismiss (+ Dismissed toggle, Restore), Resume / Start / Send on a gone-agent card,
// Focus on an asking card, Remove / Retry on a failed wakeup. Render reads memory only; every action runs in a handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { NODE } from "./stubs/el.js";
import { drain } from "./stubs/until.js";
import { needsCounts } from "../_lib/needs.js";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const Needs = (await import(new URL("../drover-needs/main.js", import.meta.url).href)).default;
const C = await import(new URL("../_lib/config.js", import.meta.url).href);
const IO = await import(new URL("../_lib/io.js", import.meta.url).href);

const NOW = 1_000_000;
const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
const PR = { id: "P-R", name: "box1", repos: [], folders: [], branch: "main", remote: { machine: "box1", projectId: "P-9", id: "B-1", writes: true } };
const card = (i, o = {}) => ({ id: `T-${i}`, title: `card ${i}`, column: "doing", priority: "P2", tags: [], created: i, updated: i, project: P.id, archived: false, agent: `t${100 + i}`, run: null, notes: [], desc: "", assignee: null, source: null, ...o });
const wake = (o = {}) => ({ id: "W-1", target: "t9", text: "hi", name: "ping", due: NOW - 10, expires: NOW - 5, status: "failed", reason: "no", at: NOW - 1000, enabled: true, ...o });
const mk = (tasks, o = {}) => needsCounts(tasks, new Map(), new Set(), [], o.wakes ?? [], NOW, new Map(), o.dismissed);

// ---- the pure view: needsCounts takes the dismissed map ----
test("needsCounts: a dismissed row leaves attention and counts.needs; it lands in hidden", () => {
  const t = [card(1), card(2)];
  const all = mk(t);
  assert.deepEqual(all.attention.map((a) => a.key), ["T-1", "T-2"]);
  const v = mk(t, { dismissed: { "T-1": { reason: all.rows.get("T-1").reason, at: 1 } } });
  assert.deepEqual(v.attention.map((a) => a.key), ["T-2"]);
  assert.equal(v.counts.needs, 1);
  assert.deepEqual(v.hidden.map((a) => a.key), ["T-1"]);
  assert.equal(v.rows.get("T-1").group, "needs", "the card still sits in its group");
});

test("needsCounts: a changed reason resurfaces a dismissed row; a wakeup row can be dismissed too", () => {
  const v = mk([card(1)], { dismissed: { "T-1": { reason: "an older reason", at: 1 } } });
  assert.deepEqual(v.attention.map((a) => a.key), ["T-1"]);
  const w = mk([], { wakes: [wake()], dismissed: { "wake/W-1": { reason: "Wakeup delivery failed", at: 1 } } });
  assert.equal(w.counts.needs, 0);
  assert.deepEqual(w.hidden.map((a) => a.key), ["wake/W-1"]);
});

test("needsCounts: a card with no live agent is `gone`, a card whose live agent asks is not", () => {
  const t = [card(1, { agent: "t9" }), card(2, { agent: "t8" })];
  const v = needsCounts(t, new Map([["t8", { status: "blocked" }]]), new Set(["t8"]), [], [], NOW);
  assert.equal(v.attention.find((a) => a.key === "T-1").gone, true);
  assert.equal(v.attention.find((a) => a.key === "T-2").gone, false);
});

// ---- the page ----
const SHARED = "drover.needs.dismissed";
function setup(tasks, { wakes = [], dismissed, remote = null, agentsList = [], terminalsList = [], hcCode = 0 } = {}) {
  C.resetCache(); for (const m of ["drover-tasks", "drover-needs"]) C.setSettings(m, {});
  IO.resetRemoteWriter();
  const raw = { "drover.tasks": tasks, "drover.projects": remote ? [P, PR] : [P], "drover.runs": [], "drover.wakeups": wakes, ...(dismissed ? { [SHARED]: dismissed } : {}) };
  if (remote) raw["drover.remote.box1.P-9"] = { at: Date.now(), tasks: remote, picks: { assignees: [], projects: [] } };
  const runs = [], overlays = [], hcCalls = [], notified = [];
  const host = {
    props: {}, notified, home: "/h", appHome: "/nowhere", state: raw, focused: { terminal: "t1", cwd: "/x", space: null }, spaces: [], panes: [], layout: null,
    exec: async () => ({ code: 1, stdout: "", stderr: "" }), hc: async (argv) => { hcCalls.push(argv); return { code: hcCode, stdout: "", stderr: hcCode ? "boom" : "" }; },
    readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: async () => {},
    run: (...a) => { runs.push(a); }, openOverlay: (o) => { overlays.push(o); return "ov"; },
    agents: agentsList, terminals: terminalsList,
  };
  globalThis.__host = host;
  const spawned = [], timers = [];
  let stopped = 0;
  const violations = [];
  // The context of init, render and timers, and the long-lived one a cx.spawn callback receives (acx). A click gets a fresh strict one (see fresh()).
  const acx = { notify() {}, spawn(f) { spawned.push(Promise.resolve().then(() => f(acx))); } };
  const cx = { notify() {}, stop_propagation() { stopped++; }, spawn(f) { spawned.push(Promise.resolve().then(() => f(acx))); }, focus_handle: () => ({ focus() {} }), timer: { every(ms, f) { timers.push(f); }, after() {} } };
  // gpui-kit.d.ts: an ordinary Context is valid for one host call only. This fake throws on any use after the handler returned; only spawn hands over a long-lived context.
  const fresh = () => {
    const c = { dead: false };
    const live = (what) => { if (c.dead) { violations.push(what); throw new Error(`stale context: ${what} after the call returned`); } };
    return Object.assign(c, { stop_propagation() { live("stop_propagation"); stopped++; }, notify() { live("notify"); }, spawn(f) { live("spawn"); spawned.push(Promise.resolve().then(() => f(acx))); } });
  };
  const v = new Needs(); v.init({}, cx);
  return { v, cx, raw, runs, overlays, hcCalls, notified, fresh, violations, tick: () => timers.forEach((f) => f(cx)), settle: () => Promise.all(spawned.splice(0)), stopped: () => stopped };
}
const rec = (v, cx) => { globalThis.__rec = { ids: [], texts: [] }; try { const root = v.render(cx); return { root: root[NODE], ...globalThis.__rec }; } finally { globalThis.__rec = undefined; } };
const find = (n, id) => (n.id === id ? n : n.kids.map((k) => find(k, id)).find(Boolean));
const click = (s, id) => {
  const r = s.fresh(); // render gets a strict context too: a handler that keeps it across an await is stale
  let n; try { n = find(rec(s.v, r).root, id); } finally { r.dead = true; }
  assert.ok(n, `no element ${id}`); const c = s.fresh(); try { return n.args.on_click[0]({}, c); } finally { c.dead = true; } };
const has = (s, id) => rec(s.v, s.cx).ids.includes(id);

test("Dismiss on a card row writes {reason, at}, hides the row, and does not open the row", () => {
  const s = setup([card(1), card(2)]);
  click(s, "needact-dismiss-T-1");
  assert.equal(s.stopped(), 1, "the click stops at the button");
  assert.deepEqual(s.runs, [], "the row click did not run");
  assert.equal(s.raw[SHARED]["T-1"].reason, "Agent t101 is gone");
  assert.ok(Number.isFinite(s.raw[SHARED]["T-1"].at));
  s.tick();
  const r = rec(s.v, s.cx);
  assert.ok(!r.ids.includes("need-T-1"));
  assert.ok(r.ids.includes("need-T-2"));
  assert.ok(r.texts.includes("1"), "the count excludes it");
});

test("the Dismissed toggle lists hidden rows with Restore; Restore brings the row back", () => {
  const s = setup([card(1)], { dismissed: { "T-1": { reason: "Agent t101 is gone", at: 1 } } });
  assert.ok(!has(s, "need-T-1"));
  assert.ok(has(s, "needs-dismissed-toggle"));
  click(s, "needs-dismissed-toggle");
  assert.ok(has(s, "needhid-T-1"));
  click(s, "needact-restore-T-1");
  assert.equal(SHARED in s.raw && "T-1" in s.raw[SHARED], false);
  s.tick();
  assert.ok(has(s, "need-T-1"));
});

test("a dismissed key whose card is gone stays dismissed: nothing is pruned from what a read returned", () => {
  const d = { "T-1": { reason: "Agent t101 is gone", at: Date.now() }, "T-OLD": { reason: "x", at: Date.now() }, "wake/W-9": { reason: "y", at: Date.now() } };
  const s = setup([card(1)], { dismissed: d });
  s.tick();
  assert.deepEqual(s.raw[SHARED], d);
});

test("gone-agent card: Resume, Start, Send and Dismiss; Start opens the agent picker for the card", () => {
  const s = setup([card(1)]);
  for (const b of ["resume", "start", "send", "dismiss"]) assert.ok(has(s, `needact-${b}-T-1`), b);
  assert.ok(!has(s, "needact-focus-T-1"));
  click(s, "needact-start-T-1");
  assert.equal(s.overlays[0].props.pick, "T-1");
  assert.deepEqual(s.runs, []);
});

test("asking card: Focus + Dismiss (and Send), no Resume or Start; Focus focuses the live agent", () => {
  const s = setup([card(1, { agent: "t9" })], { agentsList: [{ address: "t9", status: "blocked" }], terminalsList: [{ address: "t9" }] });
  s.tick();
  assert.ok(has(s, "needact-focus-T-1") && has(s, "needact-dismiss-T-1"));
  assert.ok(!has(s, "needact-resume-T-1") && !has(s, "needact-start-T-1"));
  click(s, "needact-focus-T-1");
  assert.deepEqual(s.runs.at(-1), ["agent.focus", { terminal: "t9" }]);
});

test("Send lists the live agents; a pick sends exactly the template through hc argv", async () => {
  const s = setup([card(1, { title: 'Fix "login"\nrm -rf' })], { agentsList: [{ address: "t7", status: "idle" }], terminalsList: [{ address: "t7" }] });
  s.tick();
  click(s, "needact-send-T-1");
  assert.ok(has(s, "needact-send-to-T-1-t7"));
  click(s, "needact-send-to-T-1-t7");
  await s.settle();
  assert.deepEqual(s.hcCalls, [["send", "t7", `Help wanted on T-1: "Fix 'login' rm -rf" (reason: Agent t101 is gone)`]]);
  assert.ok(!has(s, "needact-send-to-T-1-t7"), "the picker closes");
});

test("remote card: Resume, Start and Send are hidden; Dismiss stays", () => {
  const t = card(1);
  const s = setup([], { remote: [{ ...t, id: "T-R1", project: "P-9" }] });
  // a remote card can only be in Needs you through the cache (its agent is cleared on load): hand the page such a view
  const rc = { ...t, id: "T-R1", remote: { machine: "box1", projectId: "P-9" } };
  const v = needsCounts([rc], new Map(), new Set(), [], [], NOW);
  assert.equal(v.attention[0].gone, true);
  const base = s.v.cache.get();
  s.v.cache = { get: () => ({ ...base, ...v, byId: new Map([["box1/P-9/T-R1", rc]]) }) };
  const ids = rec(s.v, s.cx).ids;
  assert.ok(ids.includes("needact-dismiss-box1/P-9/T-R1"));
  for (const b of ["resume", "start", "send"]) assert.ok(!ids.includes(`needact-${b}-box1/P-9/T-R1`), b);
});

test("failed wakeup row: Remove, Retry, Dismiss; Remove deletes it, Retry reschedules it", () => {
  const at = Date.now() - 1000, due = at - 10;
  const s = setup([], { wakes: [wake({ at, due }), wake({ id: "W-2", name: "other", at, due })] });
  for (const b of ["needact-wake-rm-W-1", "needact-wake-retry-W-1", "needact-dismiss-wake/W-1"]) assert.ok(has(s, b), b);
  click(s, "needact-wake-retry-W-1");
  const r = s.raw["drover.wakeups"].find((w) => w.id === "W-1");
  assert.equal(r.status, "scheduled");
  click(s, "needact-wake-rm-W-2");
  assert.deepEqual(s.raw["drover.wakeups"].map((w) => w.id), ["W-1"]);
});

test("Resume and Send keep working after the click call returned: they use the spawn context, never the click context", async () => {
  const s = setup([card(1)], { agentsList: [{ address: "t7", status: "idle" }], terminalsList: [{ address: "t7" }] });
  s.tick();
  click(s, "needact-resume-T-1");
  await s.settle(); await drain(); // "nothing happened" assert: no stale context use
  assert.deepEqual(s.violations, [], "a context used after its call returned");
  click(s, "needact-send-T-1");
  click(s, "needact-send-to-T-1-t7");
  await s.settle(); await drain();
  assert.deepEqual(s.violations, []);
  assert.equal(s.hcCalls.length, 1);
});

test("an empty read (no cards, no wakeups) proves nothing: dismissals survive it and still hide the card when it returns", () => {
  const dismissed = { "T-1": { reason: "Agent t101 is gone", at: Date.now() } };
  const s = setup([card(1)], { dismissed });
  s.raw["drover.tasks"] = [];
  s.tick(); s.tick();
  assert.deepEqual(s.raw[SHARED], dismissed, "kept through the empty read");
  s.raw["drover.tasks"] = [card(1)];
  s.tick();
  assert.ok(!has(s, "need-T-1"), "still dismissed");
});

test("an empty cards read with a wakeup present, then the card returns: still dismissed", () => {
  const at = Date.now() - 1000;
  const dismissed = { "T-1": { reason: "Agent t101 is gone", at: Date.now() } };
  const s = setup([card(1)], { wakes: [wake({ at, due: at - 10 })], dismissed });
  s.raw["drover.tasks"] = [];
  s.tick(); s.tick();
  assert.deepEqual(s.raw[SHARED], dismissed);
  s.raw["drover.tasks"] = [card(1)];
  s.tick();
  assert.ok(!has(s, "need-T-1"), "still dismissed");
});

test("an empty wakeups read with cards present, then the wakeup returns: still dismissed", () => {
  const at = Date.now() - 1000;
  const dismissed = { "wake/W-1": { reason: "Wakeup delivery failed", at: Date.now() } };
  const s = setup([card(2, { agent: null })], { wakes: [], dismissed });
  s.tick(); s.tick();
  assert.deepEqual(s.raw[SHARED], dismissed);
  s.raw["drover.wakeups"] = [wake({ at, due: at - 10 })];
  s.tick();
  assert.ok(!has(s, "need-wake/W-1"), "still dismissed");
});

test("a dismissal older than 30 days leaves the map even when the read is empty, and its row comes back", () => {
  const old = Date.now() - 31 * 86400000;
  const s = setup([card(1)], { dismissed: { "T-1": { reason: "Agent t101 is gone", at: old } } });
  s.raw["drover.tasks"] = [];
  s.tick();
  assert.equal("T-1" in (s.raw[SHARED] ?? {}), false, "expired while the read is empty");
  s.raw["drover.tasks"] = [card(1)];
  s.tick();
  assert.ok(has(s, "need-T-1"));
});

test("the map is capped to the newest 200 dismissals by the refresh", () => {
  const now = Date.now();
  const d = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`T-X${i}`, { reason: "r", at: now - 1000 + i }]));
  const s = setup([card(1)], { dismissed: d });
  s.tick();
  const keys = Object.keys(s.raw[SHARED]);
  assert.equal(keys.length, 200);
  assert.ok(keys.includes("T-X249") && !keys.includes("T-X0"));
});

test("the 201st dismissal drops the oldest one, and only that one", () => {
  const now = Date.now();
  const d = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`T-X${i}`, { reason: "r", at: now - 5000 + i }]));
  const s = setup([card(1)], { dismissed: d });
  click(s, "needact-dismiss-T-1"); // the 201st, newest
  s.tick();
  const keys = Object.keys(s.raw[SHARED]);
  assert.equal(keys.length, 200);
  assert.ok(keys.includes("T-1") && !keys.includes("T-X0") && keys.includes("T-X1"));
});
