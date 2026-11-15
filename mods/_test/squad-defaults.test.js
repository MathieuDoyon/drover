// Card 6: the start dialog (Picker) takes its squad / worktree / report defaults from drover-config; what was used last (drover.agents.last) wins.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], readTextFile: async () => null, exec: async () => ({ code: 0, stdout: "[]", stderr: "" }), appHome: "/h" };
const C = await import("../_lib/config.js");
const { default: Agents } = await import("../drover-agents/main.js");

const CFG = "drover.config", LAST = "drover.agents.last", AGENTS = "drover.agents";
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const task = { id: "T-1", title: "t", desc: "", column: "todo", priority: "P2", tags: [], notes: [], created: 1 };
const squad = { id: "s1", name: "Squad one", version: 1, leader: "claude", members: [] };

async function picker({ config = {}, last, settings, squads = [squad] } = {}) {
  C.resetCache();
  const state = { "drover.tasks": [task], [CFG]: config, [AGENTS]: { agents: [{ id: "claude", name: "Claude", command: "claude", instructions: "", version: 1 }], squads } };
  if (last) state[LAST] = last;
  Object.assign(globalThis.__host, { props: { overlay: "o", pick: "T-1" }, state,
    readTextFile: async (p) => (/drover-agents\/mod\.json$/.test(p) && settings ? JSON.stringify({ settings }) : null) });
  const cx = { notify() {}, spawn: (fn) => Promise.resolve().then(() => fn(cx)), timer: { every() {} } };
  const v = new Agents();
  v.init({}, cx);
  await until(() => C.ready("drover-agents"), "the mod.json layer loaded");
  return v.dialog;
}

beforeEach(() => C.resetCache());

test("no config and no last: claude agent, no worktree, no report (today's behaviour)", async () => {
  const p = await picker();
  assert.deepEqual(p.runner, { kind: "agent", id: "claude" });
  assert.equal(p.worktree, false);
  assert.equal(p.report, false);
});

test("configured defaults apply when nothing was used before", async () => {
  const p = await picker({ config: { "drover-agents": { default_squad: "s1", default_worktree: true, default_report: true } } });
  assert.deepEqual(p.runner, { kind: "squad", id: "s1" });
  assert.equal(p.worktree, true);
  assert.equal(p.report, true);
});

test("what was used last wins, field by field", async () => {
  const config = { "drover-agents": { default_squad: "s1", default_worktree: true, default_report: true } };
  const p = await picker({ config, last: { runner: { kind: "agent", id: "claude" }, worktree: false, report: false } });
  assert.deepEqual(p.runner, { kind: "agent", id: "claude" });
  assert.equal(p.worktree, false, "an explicit last false beats the configured true");
  assert.equal(p.report, false);
  const q = await picker({ config, last: { worktree: false } }); // an old or partial entry: the missing fields use the defaults
  assert.deepEqual(q.runner, { kind: "squad", id: "s1" });
  assert.equal(q.worktree, false);
  assert.equal(q.report, true);
});

test("a default squad that no longer exists is ignored", async () => {
  const p = await picker({ config: { "drover-agents": { default_squad: "gone" } } });
  assert.deepEqual(p.runner, { kind: "agent", id: "claude" });
});

test("the mod.json fallback layer applies once loaded; a click is never overwritten by a late load", async () => {
  const p = await picker({ settings: { default_squad: "s1", default_worktree: true } });
  assert.deepEqual(p.runner, { kind: "squad", id: "s1" });
  assert.equal(p.worktree, true);
  p.worktree = false; // the person unticks it
  assert.equal(p.worktree, false);
});

test("Start writes the same drover.agents.last shape", async () => {
  const p = await picker({ config: { "drover-agents": { default_squad: "s1", default_worktree: true } } });
  p.start?.({}, { notify() {}, spawn() {} });
  assert.deepEqual(globalThis.__host.state[LAST], { runner: { kind: "squad", id: "s1" }, worktree: true, report: false });
});
