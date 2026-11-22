// T-MWO6FADBCH4: the Dock badge through the real views with a fake host (a setBadge recorder). Tabs' bar copy is the only writer, outside render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { until } from "./stubs/until.js";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const mod = async (name) => (await import(new URL(`../${name}/main.js`, import.meta.url).href)).default;
const Tabs = await mod("drover-tabs"), Needs = await mod("drover-needs"), Switch = await mod("drover-switch"), Tasks = await mod("drover-tasks");
const C = await import(new URL("../_lib/config.js", import.meta.url).href);
const IO = await import(new URL("../_lib/io.js", import.meta.url).href);

const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
// odd cards are in progress with a gone agent (Needs you); n cards give ceil(n/2).
const card = (i) => ({ id: `T-${i}`, title: `card ${i}`, column: "doing", priority: "P2", tags: [], created: i, updated: i, project: P.id, archived: false, agent: i % 2 ? `t${100 + i}` : null, run: null, notes: [], desc: "", assignee: null, source: null });
const cards = (n) => Array.from({ length: n }, (_, i) => card(i + 1));

function setup(View, tasks, { menu, ready = true, mod = {}, shared = {}, realSpawn = null } = {}) {
  C.resetCache(); if (ready) for (const m of ["drover-tasks", "drover-needs", "drover-switch", "drover-tabs"]) C.setSettings(m, m === "drover-tabs" ? mod : {});
  IO.resetRemoteWriter();
  const badge = [], timers = [];
  const raw = { "drover.tasks": tasks, "drover.projects": [P], "drover.runs": [], ...shared };
  const host = {
    props: menu ? { menu } : {}, notified: [], home: "/h", appHome: "/nowhere", state: raw, focused: { terminal: "t1", cwd: "/x", space: null },
    spaces: [], panes: [], layout: { id: "root", type: "row", children: [] }, agents: [], terminals: [],
    exec: async () => ({ code: 1, stdout: "", stderr: "" }), hc: async () => ({ code: 1, stdout: "", stderr: "" }),
    readTextFile: async (path) => (realSpawn ? realSpawn.read(path) : null), writeTextFile: async () => {}, watchFolder: async () => {}, run: () => {}, openOverlay: () => "ov",
    setBadge: (t) => { badge.push(t); },
  };
  globalThis.__host = host;
  const spawned = [];
  const cx = { notify() {}, stop_propagation() {}, spawn(fn) { if (realSpawn) spawned.push(fn(cx)); }, focus_handle: () => ({ focus() {} }), timer: { every(ms, f) { timers.push({ ms, f }); }, after() {} } };
  const v = new View(); v.init({}, cx);
  return { v, cx, badge, raw, host, spawned, tick: () => { for (const x of timers) x.f(cx); } };
}

test("the bar copy writes the count at init and 0 hides it (null)", () => {
  assert.deepEqual(setup(Tabs, cards(3)).badge, ["2"]);
  assert.deepEqual(setup(Tabs, []).badge, [null]);
});

test("a change writes once: ticks with the same count write nothing, a new count writes, back to 0 clears", () => {
  const s = setup(Tabs, cards(3));
  s.tick(); s.tick();
  assert.deepEqual(s.badge, ["2"]);
  s.raw["drover.tasks"] = cards(5); s.tick(); s.tick(); // the cache refreshes on its own timer, the badge follows within one extra tick
  s.tick();
  assert.deepEqual(s.badge, ["2", "3"]);
  s.raw["drover.tasks"] = []; s.tick(); s.tick(); s.tick();
  assert.deepEqual(s.badge, ["2", "3", null]);
});

for (const [name, n] of [["cold", 3], ["warm", 30]]) {
  test(`render never writes the badge (${name})`, () => {
    const s = setup(Tabs, cards(n));
    const before = s.badge.length;
    for (let i = 0; i < 3; i++) s.v.render(s.cx);
    assert.equal(s.badge.length, before);
    s.raw["drover.tasks"] = cards(n + 4); // a changed count with no tick: render alone must not publish it
    s.v.render(s.cx); s.v.render(s.cx);
    assert.equal(s.badge.length, before);
  });
}

test("one writer: only the Tabs bar copy and the lib module reference setBadge; the other views never write", () => {
  const root = new URL("../", import.meta.url);
  const hits = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "_test") continue;
    for (const f of readdirSync(new URL(`${d.name}/`, root))) {
      if (!f.endsWith(".js") || f.endsWith(".test.js")) continue;
      if (/\bsetBadge\b/.test(readFileSync(new URL(`${d.name}/${f}`, root), "utf8"))) hits.push(`${d.name}/${f}`);
    }
  }
  // dockbadge.js is the lib module and its byte-equal copies in each mod; the only caller of setBadge is the Tabs bar.
  assert.deepEqual(hits.filter((h) => !h.endsWith("/dockbadge.js")), ["drover-tabs/main.js"]);
  assert.ok(hits.includes("_lib/dockbadge.js"));
  for (const View of [Needs, Switch, Tasks]) {
    const s = setup(View, cards(3));
    s.tick(); s.v.render?.(s.cx);
    assert.deepEqual(s.badge, [], View.name);
  }
});

test("popup copies of drover-tabs (menu drover and agents) never write or clear the bar's badge", async () => {
  const bar = setup(Tabs, cards(3));
  assert.deepEqual(bar.badge, ["2"]);
  for (const menu of ["drover", "agents"]) {
    const pop = setup(Tabs, cards(3), { menu });
    pop.tick(); await pop.v.close(pop.cx);
    assert.deepEqual(pop.badge, [], `popup ${menu}`);
  }
  bar.tick();
  assert.deepEqual(bar.badge, ["2"]);
});

test("close of the bar copy clears the badge once", async () => {
  const s = setup(Tabs, cards(3));
  await s.v.close(s.cx); await s.v.close(s.cx);
  assert.deepEqual(s.badge, ["2", null]);
  const z = setup(Tabs, []);
  await z.v.close(z.cx);
  assert.deepEqual(z.badge, [null]);
});

test("setting: a shared override off clears the badge live and never writes a count again", () => {
  const s = setup(Tabs, cards(3));
  s.raw["drover.config"] = { "drover-tabs": { dock_badge: false } };
  s.tick(); s.raw["drover.tasks"] = cards(7); s.tick(); s.tick();
  assert.deepEqual(s.badge, ["2", null]);
  s.raw["drover.config"] = {}; s.tick();
  assert.deepEqual(s.badge, ["2", null, "4"]);
});

test("setting: an inherited mod.json dock_badge:false (no shared override) is really loaded by Tabs' own init, waited for, then honoured; nothing is written before it loads", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const paths = [];
  const read = async (path) => { paths.push(path); if (!path.endsWith("/mods/drover-tabs/mod.json")) return null; await gate; return JSON.stringify({ settings: { dock_badge: false } }); };
  const s = setup(Tabs, cards(3), { ready: false, realSpawn: { read } }); // the real cx.spawn runs Tabs' loads: no hand-set settings
  s.tick(); s.tick();
  assert.deepEqual(s.badge, [], "mod.json layer not loaded yet: no write");
  release(); await Promise.all(s.spawned);
  assert.ok(paths.some((x) => x.endsWith("/mods/drover-tabs/mod.json")), "Tabs loaded its own mod.json");
  s.tick();
  assert.deepEqual(s.badge, [null], "never a count");
  s.raw["drover.tasks"] = cards(9); s.tick();
  assert.deepEqual(s.badge, [null]);
});

test("setting: unset in mod.json and shared defaults to on; a shared override beats mod.json", () => {
  assert.deepEqual(setup(Tabs, cards(3), { mod: {} }).badge, ["2"]);
  assert.deepEqual(setup(Tabs, cards(3), { mod: { dock_badge: false }, shared: { "drover.config": { "drover-tabs": { dock_badge: true } } } }).badge, ["2"]);
});

test("a throwing setBadge does not break init or the tick, and is retried", () => {
  let fail = true; const got = [];
  C.resetCache(); for (const m of ["drover-tabs"]) C.setSettings(m, {});
  const s = setup(Tabs, cards(3));
  s.host.setBadge = (t) => { if (fail) throw new Error("host"); got.push(t); };
  s.raw["drover.tasks"] = cards(5); s.tick(); s.tick();
  assert.deepEqual(got, []);
  fail = false; s.tick();
  assert.deepEqual(got, ["3"]);
});
