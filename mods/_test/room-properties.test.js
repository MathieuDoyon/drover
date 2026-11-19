// T-MWMRJBZF1J8: the Room's Properties show the CARD's assignee (what the task dialog shows) and the board's column labels.
// The linked issue's own assignee gets its own row (GitHub / Jira), hidden when empty. Render rule: one drover.agents read per
// render (loadConfig), no shared write from render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { until } from "./stubs/until.js";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [] };
const { default: Room } = await import("../drover-room/main.js");
const C = await import("../_lib/config.js");

const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
const AGENTS = { agents: [{ id: "scout", name: "Scout" }], squads: [{ id: "scouting", name: "Scouting Party" }] };
const SQUAD = { kind: "squad", id: "scouting" };
const card = (i, o = {}) => ({ id: `T-${i}`, title: `card ${i}`, column: "doing", agent: null, run: `R${i}`, priority: "P2", tags: [], created: 1, updated: 1, project: P.id, archived: false, notes: [], assignee: null, ...o });
const run = (i) => ({ id: `R${i}`, task: `T-${i}`, project: P.id, started: 1, terminals: [{ address: `t${i}`, agent: "wrangler", name: "W", role: "leader", started: 1 }] });
const writes = [], reads = {};
let host, cx, raw;

// n runs, run 1 focused. `ctx` is the cached Room context of R1 (its issue); null = none cached yet.
function world(n, { first = {}, ctx = null } = {}) {
  C.resetCache(); C.setSettings("drover-room", {});
  writes.length = 0; for (const k in reads) delete reads[k];
  const idx = Array.from({ length: n }, (_, i) => i + 1);
  raw = { "drover.runs": idx.map(run), "drover.tasks": idx.map((i) => card(i, i === 1 ? first : {})), "drover.projects": [P], "drover.agents": AGENTS,
    "drover.config": { "drover-room": {} }, "drover.room": ctx ? { R1: { at: Date.now(), good: Date.now(), prs: [], errors: [], ...ctx } } : {} };
  const state = new Proxy(raw, { get(o, k) { if (typeof k === "string") reads[k] = (reads[k] ?? 0) + 1; return o[k]; }, set(o, k, v) { writes.push(String(k)); o[k] = v; return true; } });
  host = globalThis.__host = { props: {}, notified: [], agents: [], panes: [], spaces: [], terminals: idx.map((i) => ({ address: `t${i}` })), home: "/h", appHome: "/nowhere", state, focused: { terminal: "t1", cwd: "/x" }, readTextFile: async () => null };
  cx = { notify() {}, stop_propagation() {}, write_to_clipboard() {}, focus_handle: () => ({ focus() {} }), timer: { every() {}, after() {} }, spawn() {} };
  const v = new Room(); v.init({}, cx);
  return v;
}
const draw = (view) => { globalThis.__rec = { ids: [], texts: [] }; try { view.render(cx); return globalThis.__rec.texts.slice(); } finally { globalThis.__rec = undefined; } };
async function ready(view) { let out; await until(() => { out = draw(view); return out.includes("Run"); }, "the Room is ready"); return out; }
// The value shown right after a row's label (labels are unique texts in the Properties block).
const valueOf = (texts, label) => { const i = texts.indexOf(label); return i < 0 ? undefined : texts[i + 1]; };
const issue = (o = {}) => ({ issue: { kind: "github", key: "#57", title: "T", status: "OPEN", category: "new", url: "u", assignee: null, project: "o/r", type: "Issue", parent: null, ...o } });

test("the Assignee row is the card's assignee, not the GitHub issue's (issue unassigned)", async () => {
  const v = world(1, { first: { assignee: SQUAD }, ctx: issue() });
  assert.equal(valueOf(await ready(v), "Assignee"), "Scouting Party");
});

test("card assignee and issue assignee both show: Assignee = card, 'GitHub assignee' = the login", async () => {
  const v = world(1, { first: { assignee: SQUAD }, ctx: issue({ assignee: "octo" }) });
  const t = await ready(v);
  assert.equal(valueOf(t, "Assignee"), "Scouting Party");
  assert.equal(valueOf(t, "GitHub assignee"), "octo");
});

test("no card assignee, issue assignee octo: Assignee reads Unassigned, octo sits under 'GitHub assignee'", async () => {
  const v = world(1, { ctx: issue({ assignee: "octo" }) });
  const t = await ready(v);
  assert.equal(valueOf(t, "Assignee"), "Unassigned");
  assert.equal(valueOf(t, "GitHub assignee"), "octo");
});

test("a Jira issue's assignee is labelled 'Jira assignee'", async () => {
  const v = world(1, { first: { assignee: SQUAD }, ctx: issue({ kind: "jira", key: "AB-1", assignee: "Ann" }) });
  const t = await ready(v);
  assert.equal(valueOf(t, "Jira assignee"), "Ann");
  assert.equal(valueOf(t, "GitHub assignee"), undefined);
});

test("an issue with no assignee shows no issue-assignee row", async () => {
  const v = world(1, { first: { assignee: SQUAD }, ctx: issue() });
  const t = await ready(v);
  assert.ok(!t.includes("GitHub assignee") && !t.includes("Jira assignee"), t.join("|"));
});

test("the issue's state row is labelled 'Issue status'", async () => {
  const v = world(1, { ctx: issue() });
  const t = await ready(v);
  assert.equal(valueOf(t, "Issue status"), "OPEN");
  assert.ok(!t.includes("Status"), "no bare Status row");
});

test("the Assignee row does not depend on a linked issue: local card, and a failed issue context", async () => {
  let t = await ready(world(1, { first: { assignee: SQUAD } })); // no source, no context
  assert.equal(valueOf(t, "Assignee"), "Scouting Party");
  t = await ready(world(1, { first: { assignee: SQUAD, source: { kind: "github", key: "#1", url: "u" } }, ctx: { issue: null, errors: ["gh failed"] } }));
  assert.equal(valueOf(t, "Assignee"), "Scouting Party");
  t = await ready(world(1));
  assert.equal(valueOf(t, "Assignee"), "Unassigned");
});

test("an assignee whose squad left the config shows its id; an agent assignee shows the agent's name", async () => {
  assert.equal(valueOf(await ready(world(1, { first: { assignee: { kind: "squad", id: "gone" } } })), "Assignee"), "gone");
  assert.equal(valueOf(await ready(world(1, { first: { assignee: { kind: "agent", id: "scout" } } })), "Assignee"), "Scout");
});

test("Column shows the board's label, not the stored id", async () => {
  for (const [id, label] of [["doing", "In progress"], ["todo", "Ready"], ["review", "Review"], ["blocked", "Blocked"], ["backlog", "Backlog"], ["done", "Done"]]) {
    assert.equal(valueOf(await ready(world(1, { first: { column: id } })), "Column"), label, id);
  }
});

test("the same instance shows a changed card assignee and column on the next render (no kept snapshot)", async () => {
  const v = world(1, { first: { assignee: SQUAD }, ctx: issue() });
  await ready(v);
  raw["drover.tasks"] = raw["drover.tasks"].map((x) => ({ ...x, assignee: { kind: "agent", id: "scout" }, column: "review" }));
  const t = draw(v);
  assert.equal(valueOf(t, "Assignee"), "Scout");
  assert.equal(valueOf(t, "Column"), "Review");
});

test("render rule: one drover.agents read per settled render, however many runs; nothing is written", async () => {
  const seen = [];
  for (const n of [3, 30]) {
    const v = world(n, { first: { assignee: SQUAD }, ctx: issue() });
    await ready(v);
    for (const k in reads) delete reads[k];
    writes.length = 0;
    draw(v);
    seen.push({ ...reads });
    assert.deepEqual(writes, [], "render wrote shared state");
  }
  assert.equal(seen[0]["drover.agents"], 1, `drover.agents reads: ${seen[0]["drover.agents"]}`);
  assert.deepEqual(seen[1], seen[0], "30 runs read what 3 runs read");
});
