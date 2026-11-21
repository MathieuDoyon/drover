// T-MWO2HFFHWRB Rev 3: the three views of the Needs-you cache: the page (drover-needs), the switch tab (drover-switch) and the chip in drover-tabs.
// Each owns a cache and a 1 s timer started in init. Render reads memory only: no exec/hc/read/write/watch/timer/spawn, no host agents()/terminals().
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { NODE } from "./stubs/el.js";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const mod = async (name) => (await import(new URL(`../${name}/main.js`, import.meta.url).href)).default;
const Needs = await mod("drover-needs"), Switch = await mod("drover-switch"), Tabs = await mod("drover-tabs");
const C = await import(new URL("../_lib/config.js", import.meta.url).href);
const IO = await import(new URL("../_lib/io.js", import.meta.url).href);
const NAV = await import(new URL("../_lib/needsnav.js", import.meta.url).href);

const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
const PR = { id: "P-R", name: "box1", repos: [], folders: [], branch: "main", remote: { machine: "box1", projectId: "P-9", id: "B-1", writes: true } };
// odd cards are in progress with a gone agent (Needs you), even ones are doing with no agent: n cards give ceil(n/2) in the Needs you group.
const card = (i, o = {}) => ({ id: `T-${i}`, title: `card ${i}`, column: "doing", priority: "P2", tags: [], created: i, updated: i, project: P.id, archived: false, agent: i % 2 ? `t${100 + i}` : null, run: null, notes: [], desc: "", assignee: null, source: null, ...o });
const LAYOUT = (needsPage) => ({ id: "root", type: "row", children: [{ id: "drover", type: "column", hidden: false, children: [
  { id: "drover-room", type: "block", hidden: needsPage }, { id: "drover-tasks", type: "block", hidden: needsPage }, { id: "drover-needs", type: "block", hidden: !needsPage }] }] });

const SIDE = ["exec", "hc", "read", "write", "watch", "every", "spawn", "set", "terminals"];
function setup(View, tasks, { remote = null, layout = LAYOUT(false), agentsList = [], terminalsList = [], extraRaw = {} } = {}) {
  C.resetCache(); for (const m of ["drover-tasks", "drover-needs", "drover-switch", "drover-tabs"]) C.setSettings(m, {});
  IO.resetRemoteWriter();
  const calls = Object.fromEntries([...SIDE, "agents", "notified"].map((k) => [k, 0]));
  const raw = { "drover.tasks": tasks, "drover.projects": remote ? [P, PR] : [P], "drover.runs": [], ...extraRaw };
  if (remote) raw["drover.remote.box1.P-9"] = { at: Date.now(), tasks: remote, picks: { assignees: [], projects: [] } };
  const runs = [], overlays = [];
  const host = {
    props: {}, notified: [], home: "/h", appHome: "/nowhere", state: new Proxy(raw, { set(o, k, v) { calls.set++; o[k] = v; return true; } }),
    focused: { terminal: "t1", cwd: "/x", space: null }, spaces: [], panes: [], layout,
    exec: async () => { calls.exec++; return { code: 1, stdout: "", stderr: "" }; }, hc: async () => { calls.hc++; return { code: 1, stdout: "", stderr: "" }; },
    readTextFile: async () => { calls.read++; return null; }, writeTextFile: async () => { calls.write++; }, watchFolder: async () => { calls.watch++; },
    run: (...a) => { runs.push(a); }, openOverlay: (o) => { overlays.push(o); return "ov"; },
  };
  Object.defineProperty(host, "agents", { get() { calls.agents++; return agentsList; } });
  Object.defineProperty(host, "terminals", { get() { calls.terminals++; return terminalsList; } });
  globalThis.__host = host;
  const timers = [];
  const cx = { notify() { calls.notified++; }, stop_propagation() {}, spawn() { calls.spawn++; }, focus_handle: () => ({ focus() {} }),
    timer: { every(ms, f) { calls.every++; timers.push({ ms, f }); }, after() { calls.every++; } } };
  const v = new View(); v.init({}, cx);
  return { v, cx, raw, calls, runs, overlays, timers, agentsList, terminalsList, host, tick: () => { for (const x of timers) x.f(cx); } };
}
const rec = (v, cx) => { globalThis.__rec = { ids: [], texts: [] }; try { const root = v.render(cx); return { root: root[NODE], ...globalThis.__rec }; } finally { globalThis.__rec = undefined; } };
const find = (n, id) => (n.id === id ? n : n.kids.map((k) => find(k, id)).find(Boolean));
const delta = (calls, keys, fn) => { const b = { ...calls }; const out = fn(); return { out, d: Object.fromEntries(keys.map((k) => [k, calls[k] - b[k]])) }; };
const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
const cards = (n) => Array.from({ length: n }, (_, i) => card(i + 1));
const needsOf = (n) => Math.ceil(n / 2);

// ---- drover-needs: the page ----
for (const [name, View, keys] of [["drover-needs", Needs, [...SIDE, "agents"]], ["drover-switch", Switch, [...SIDE, "agents"]], ["drover-tabs", Tabs, SIDE]]) {
  for (const n of [3, 30, 300]) {
    test(`${name} render, ${n} cards: cold and warm render have no side effects and read no host lists`, () => {
      const s = setup(View, cards(n));
      const cold = delta(s.calls, keys, () => rec(s.v, s.cx));
      assert.deepEqual(cold.d, zero(keys), "cold render");
      assert.deepEqual(delta(s.calls, keys, () => rec(s.v, s.cx)).d, zero(keys), "warm render");
    });
  }
  test(`${name}: init starts its own 1 s refresh timer; render starts none`, () => {
    const s = setup(View, cards(3));
    assert.ok(s.timers.some((x) => x.ms === 1000), "a 1 s timer");
    const before = s.calls.every;
    rec(s.v, s.cx); rec(s.v, s.cx);
    assert.equal(s.calls.every, before);
  });
}

test("drover-needs: rows are the Needs you group, oldest first by created (an edit does not reorder), with a reason line and the count in the header", () => {
  const t = [card(3, { created: 30 }), card(1, { created: 20, updated: 999 }), card(5, { created: 10 }), card(2)];
  const s = setup(Needs, t);
  const r = rec(s.v, s.cx);
  const order = r.ids.filter((i) => i.startsWith("need-"));
  assert.deepEqual(order, ["need-T-5", "need-T-1", "need-T-3"]);
  assert.ok(r.texts.includes("3"), "the count");
  assert.ok(r.texts.some((x) => x.includes("is gone")), "the reason line");
  assert.ok(!r.ids.includes("need-T-2"), "a working card is not listed");
});

test("drover-needs: no card needs you -> one plain line, no rows", () => {
  const s = setup(Needs, [card(2), card(4)]);
  const r = rec(s.v, s.cx);
  assert.ok(r.texts.includes("Nothing needs you"));
  assert.deepEqual(r.ids.filter((i) => i.startsWith("need-")), []);
});

test("count == list: the page, the switch tab and the chip show the same number for the same state", () => {
  for (const n of [3, 30, 300]) {
    const num = (v, cx, re) => Number(rec(v, cx).texts.map((x) => re.exec(x)?.[1]).find(Boolean));
    const a = setup(Needs, cards(n)), b = setup(Switch, cards(n)), c = setup(Tabs, cards(n));
    const rows = rec(a.v, a.cx).ids.filter((i) => i.startsWith("need-")).length;
    assert.equal(rows, needsOf(n));
    assert.equal(num(a.v, a.cx, /^(\d+)$/), rows, "page header");
    assert.equal(Number(rec(b.v, b.cx).texts.find((x) => /^\d+$/.test(x))), rows, "switch badge");
    assert.equal(num(c.v, c.cx, /^(\d+)$/), rows, "chip");
  }
});

test("drover-needs: a row click shows Room + Tasks, then focuses the live agent", () => {
  const s = setup(Needs, [card(1, { column: "doing", agent: "t9" })], { agentsList: [{ address: "t9", status: "blocked" }], terminalsList: [{ address: "t9" }] });
  s.tick();
  const r = rec(s.v, s.cx);
  find(r.root, "need-T-1").args.on_click[0]();
  assert.deepEqual(s.runs, [...NAV.showPage("room"), ["agent.focus", { terminal: "t9" }]]);
  assert.deepEqual(s.overlays, []);
});

test("drover-needs: a row of a card with no live agent shows Room + Tasks, then opens the card editor", () => {
  const s = setup(Needs, [card(1)]);
  find(rec(s.v, s.cx).root, "need-T-1").args.on_click[0]();
  assert.deepEqual(s.runs, NAV.showPage("room"));
  assert.equal(s.overlays.length, 1);
  assert.equal(s.overlays[0].props.edit, "T-1");
});

test("drover-needs alone: remote cards (their agent is cleared on load) never wait on you, so the page needs no remote watch", () => {
  const rc = (i, o = {}) => card(i, { id: `T-R${i}`, column: "blocked", agent: null, project: "P-9", ...o });
  const s = setup(Needs, [], { remote: [rc(1), rc(2, { column: "doing" })] });
  assert.equal(s.timers.filter((x) => x.ms === 1000).length, 1, "only the refresh timer");
  const r = rec(s.v, s.cx);
  assert.deepEqual(r.ids.filter((i) => i.startsWith("need-")), []);
  assert.ok(r.texts.includes("Nothing needs you"));
});

test("drover-needs: a live-only change (agent blocked -> working) with tasks and runs unchanged updates the rows and the count", () => {
  const s = setup(Needs, [card(1, { column: "doing", agent: "t9" })], { agentsList: [{ address: "t9", status: "working" }], terminalsList: [{ address: "t9" }] });
  s.tick();
  assert.deepEqual(rec(s.v, s.cx).ids.filter((i) => i.startsWith("need-")), []);
  s.agentsList[0] = { address: "t9", status: "blocked" };
  s.tick();
  const r = rec(s.v, s.cx);
  assert.deepEqual(r.ids.filter((i) => i.startsWith("need-")), ["need-T-1"]);
  assert.ok(r.texts.some((x) => x.includes("Agent asks: open its terminal")));
  s.agentsList.length = 0; s.terminalsList.length = 0;
  s.tick();
  assert.ok(rec(s.v, s.cx).texts.some((x) => x.includes("Agent t9 is gone")));
});

// ---- drover-switch ----
test("drover-switch: the selected tab follows layout() (room by default, needs when Needs you shows and Room is hidden)", () => {
  for (const [needsPage, want] of [[false, "seg-room"], [true, "seg-needs"]]) {
    const s = setup(Switch, cards(3), { layout: LAYOUT(needsPage) });
    const r = rec(s.v, s.cx);
    for (const id of ["seg-room", "seg-needs"]) assert.equal(find(r.root, id).calls.includes("bg"), id === want, `${id} (needs page: ${needsPage})`);
  }
});

test("drover-switch: a tab click runs showPage for its page", () => {
  const s = setup(Switch, cards(3));
  const r = rec(s.v, s.cx);
  find(r.root, "seg-needs").args.on_click[0]();
  assert.deepEqual(s.runs, NAV.showPage("needs"));
  s.runs.length = 0;
  find(r.root, "seg-room").args.on_click[0]();
  assert.deepEqual(s.runs, NAV.showPage("room"));
});

test("drover-switch: ONE rounded row with 2 segments; the selected one differs; the count is a badge shown only above 0", () => {
  const themed = (s) => { s.host.theme = new Proxy({}, { get: (_t, k) => String(k) }); return s; };
  for (const [needsPage, sel, other] of [[false, "seg-room", "seg-needs"], [true, "seg-needs", "seg-room"]]) {
    const s = themed(setup(Switch, cards(3), { layout: LAYOUT(needsPage) }));
    const r = rec(s.v, s.cx);
    assert.equal(r.ids.filter((i) => i === "switch-pill").length, 1, "exactly one container");
    const pill = find(r.root, "switch-pill");
    assert.ok(pill.calls.includes("rounded") && pill.calls.includes("bg"), "rounded container with a background");
    assert.deepEqual(r.ids.filter((i) => i.startsWith("seg-")), ["seg-room", "seg-needs"], "two segments");
    const a = find(r.root, sel), b = find(r.root, other);
    assert.ok(a.calls.includes("bg") && !b.calls.includes("bg"), "only the selected segment has a background");
    assert.notEqual(a.args.text_color[0], b.args.text_color[0], "selected text is full colour, the other muted");
    assert.equal(b.args.text_color[0], "muted");
  }
  const lab = (s) => rec(s.v, s.cx).texts;
  const on = setup(Switch, cards(3)); // 2 need the owner
  const r = rec(on.v, on.cx);
  assert.ok(r.ids.includes("needs-badge") && r.texts.includes("2") && r.texts.includes("Needs you") && r.texts.includes("Room + Tasks"));
  assert.ok(!lab(on).some((x) => /^Needs you \d/.test(x)), "the number is not in the label");
  const off = setup(Switch, [card(2)]);
  const r0 = rec(off.v, off.cx);
  assert.ok(!r0.ids.includes("needs-badge") && !r0.texts.includes("0"), "no badge at 0");
});

test("drover-switch: the count follows a live-only change after the next refresh", () => {
  const s = setup(Switch, [card(1, { column: "doing", agent: "t9" })], { agentsList: [{ address: "t9", status: "working" }], terminalsList: [{ address: "t9" }] });
  s.tick();
  assert.ok(!rec(s.v, s.cx).ids.includes("needs-badge"));
  s.agentsList[0] = { address: "t9", status: "blocked" };
  assert.ok(!rec(s.v, s.cx).ids.includes("needs-badge"), "render alone does not look again");
  s.tick();
  assert.ok(rec(s.v, s.cx).ids.includes("needs-badge"));
});

// ---- drover-tabs chip ----
test("drover-tabs: the chip shows the count beside Tasks, is hidden at 0, and a click runs showPage('needs') (it shows the hidden column first)", () => {
  const s = setup(Tabs, cards(3), { layout: { ...LAYOUT(false), children: [{ ...LAYOUT(false).children[0], hidden: true }] } });
  const r = rec(s.v, s.cx);
  assert.ok(r.ids.includes("needs-chip"));
  assert.ok(r.texts.includes("2"));
  find(r.root, "needs-chip").args.on_click[0](null, s.cx);
  assert.deepEqual(s.runs, NAV.showPage("needs"));
  assert.deepEqual(s.runs[0], ["layout.show", { id: "drover" }]);
  const none = setup(Tabs, [card(2)]);
  assert.ok(!rec(none.v, none.cx).ids.includes("needs-chip"), "no chip at 0");
});

// ---- no work in render, by source ----
test("the three views never derive groups or start work in render (source check)", () => {
  for (const f of ["drover-needs", "drover-switch", "drover-tabs"]) {
    const src = readFileSync(new URL(`../${f}/main.js`, import.meta.url), "utf8");
    const body = src.slice(src.indexOf("  render("));
    for (const word of ["attention(", "needsCounts(", "loadMerged(", "watchRemote(", "remoteWriteState(", "loadRuns(", "terminals()"]) assert.ok(!body.includes(word), `${f} render must not call ${word}`);
  }
});

test("drover-needs: a remote card with the same id as a local Needs card does not take its row; the row acts on the local card", () => {
  const local = card(1, { id: "T-X", title: "local gone" });
  const rem = card(2, { id: "T-X", title: "remote blocked", column: "blocked", agent: null, project: "P-9" });
  const s = setup(Needs, [local], { remote: [rem] });
  const r = rec(s.v, s.cx);
  assert.deepEqual(r.ids.filter((i) => i.startsWith("need-")), ["need-T-X"]);
  assert.ok(r.texts.includes("1"), "the count is the list length");
  find(r.root, "need-T-X").args.on_click[0]();
  assert.equal(s.overlays.at(-1).props.edit, "T-X");
  assert.equal(s.overlays.at(-1).props.remoteCard, undefined, "the local row opens the local editor");
});

// ---- Revision 4: cards and failed wakeups share one Needs-you list and one count ----
const WAKE = (o = {}) => ({ id: "W-1", name: "ping", target: "t9", text: "hi", status: "failed", reason: "Target terminal is gone", at: Date.now() - 3600000, enabled: true, ...o });
const withWake = (View, tasks, wakes) => { const s = setup(View, tasks); s.raw["drover.wakeups"] = wakes; s.tick(); return s; };

test("Rev 4: a failed wakeup is a row on the page and counts the same on the page, the switch badge and the chip", () => {
  const a = withWake(Needs, cards(3), [WAKE()]), b = withWake(Switch, cards(3), [WAKE()]), c = withWake(Tabs, cards(3), [WAKE()]);
  const ra = rec(a.v, a.cx);
  assert.equal(ra.ids.filter((i) => i.startsWith("need-")).length, needsOf(3) + 1);
  assert.ok(ra.ids.includes("need-wake/W-1"));
  assert.ok(ra.texts.includes(String(needsOf(3) + 1)), "page header");
  assert.ok(ra.texts.some((x) => x.includes("Wakeup delivery failed")));
  assert.ok(rec(b.v, b.cx).texts.includes(String(needsOf(3) + 1)), "switch badge");
  assert.ok(rec(c.v, c.cx).texts.includes(String(needsOf(3) + 1)), "chip");
});

test("Rev 4: a wakeup row click opens the Wakeups screen (and nothing else)", () => {
  const s = withWake(Needs, [], [WAKE()]);
  find(rec(s.v, s.cx).root, "need-wake/W-1").args.on_click[0]();
  assert.deepEqual(s.runs, [["tab.new", { name: "Wakeups", mod: "drover-wakeups" }]]);
});

test("Rev 4: render with wakes still reads memory only", () => {
  const s = withWake(Needs, cards(30), [WAKE(), WAKE({ id: "W-2", status: "expired" })]);
  const { d } = delta(s.calls, [...SIDE, "agents"], () => rec(s.v, s.cx));
  assert.deepEqual(d, zero([...SIDE, "agents"]));
});

test("Rev 4: a Blocked-column card is rendered in Tasks (group Blocked), not on the Needs page", async () => {
  const Tasks = await mod("drover-tasks");
  const s = setup(Tasks, [card(2, { id: "T-PARK", column: "blocked" })]);
  const r = rec(s.v, s.cx);
  assert.ok(r.ids.includes("task-T-PARK"), "the parked card is drawn");
  assert.ok(r.texts.includes("▾ Blocked"), "under a Blocked group header");
  const n = setup(Needs, [card(2, { id: "T-PARK", column: "blocked" })]);
  assert.ok(!rec(n.v, n.cx).ids.includes("need-T-PARK"));
  assert.ok(rec(n.v, n.cx).texts.includes("Nothing needs you"));
});

test("Rev 4 review 3: a Needs-only host delivers wakeups: an already-expired scheduled wake becomes expired and shows in the row and the count", async () => {
  const due = { id: "W-OLD", name: "late", target: "t7", text: "ping", due: Date.now() - 7200000, expires: Date.now() - 3600000, status: "scheduled", created: 1, enabled: true, reason: null };
  const s = setup(Needs, [], { extraRaw: { "drover.wakeups": [due] } });
  assert.ok(s.timers.some((x) => x.ms === 15000), "the Needs page starts the wake consumer (15 s tick)");
  assert.ok(!rec(s.v, s.cx).ids.includes("need-wake/W-OLD"), "not expired yet");
  const real = { ...s.cx, spawn: (fn) => fn(real), notify() {} };
  await Promise.all(s.timers.filter((x) => x.ms === 15000).map((x) => x.f(real)));
  await new Promise((r) => setImmediate(r));
  assert.equal(s.raw["drover.wakeups"][0].status, "expired");
  s.tick();
  const r = rec(s.v, s.cx);
  assert.ok(r.ids.includes("need-wake/W-OLD"), "shows in the combined list");
  assert.ok(r.texts.includes("1"), "and in the count");
});

test("Job 6: the two segments are DIRECT children of the pill (a flex row); no Tabs/Tab element; the pill fits the 34px block", () => {
  const s = setup(Switch, cards(3));
  const r = rec(s.v, s.cx);
  const pill = find(r.root, "switch-pill");
  assert.deepEqual(pill.kids.map((k) => k.id), ["seg-room", "seg-needs"], "both segments sit directly in the pill");
  assert.ok(!r.ids.some((i) => i === "switch-tabs" || i.startsWith("tab-")), "no Tabs/Tab wrapper in the tree");
  const src = readFileSync(new URL("../drover-switch/main.js", import.meta.url), "utf8");
  assert.ok(!/\bTabs?\b/.test(src.replace(/\/\/.*$/gm, "")), "the source does not use Tabs/Tab");
  for (const id of ["seg-room", "seg-needs"]) assert.equal(find(r.root, id).args.h[0], 24, `${id} height`);
  assert.ok(pill.calls.includes("p"), "the pill sets its padding");
  assert.ok(24 + 2 * pill.args.p[0] <= 34, `24 + 2*${pill.args.p[0]} fits in 34`);
  find(r.root, "seg-needs").args.on_click[0]();
  assert.deepEqual(s.runs, NAV.showPage("needs"));
  s.runs.length = 0;
  find(r.root, "seg-room").args.on_click[0]();
  assert.deepEqual(s.runs, NAV.showPage("room"));
  for (const id of ["seg-room", "seg-needs"]) assert.ok(find(r.root, id).calls.includes("cursor_pointer"), `${id} is clickable`);
});

test("Round 5: the pill is a tab_list; each segment is a tab with aria_selected true only on the selected one", () => {
  for (const [needsPage, sel, other] of [[false, "seg-room", "seg-needs"], [true, "seg-needs", "seg-room"]]) {
    const s = setup(Switch, cards(3), { layout: LAYOUT(needsPage) });
    const r = rec(s.v, s.cx);
    assert.deepEqual(find(r.root, "switch-pill").args.role, ["tab_list"]);
    for (const id of [sel, other]) assert.deepEqual(find(r.root, id).args.role, ["tab"], `${id} role`);
    assert.deepEqual(find(r.root, sel).args.aria_selected, [true]);
    assert.deepEqual(find(r.root, other).args.aria_selected, [false]);
  }
});
