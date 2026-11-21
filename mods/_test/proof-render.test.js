// B3a: the Accept proof dialog (hosted by drover-todos like the card editor) and the Proof icon on the Tasks panel's Review rows.
// The dialog loads when it opens (init), never in render; render reads the loaded evidence only. (B3b: Accept is live only when the gate passes; see accept-render.test.js.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { default: Todos } = await import(new URL("../drover-todos/main.js", import.meta.url).href);
const { default: Tasks } = await import(new URL("../drover-tasks/main.js", import.meta.url).href);
const C = await import(new URL("../_lib/config.js", import.meta.url).href);
const IO = await import(new URL("../_lib/io.js", import.meta.url).href);
const { until } = await import("./stubs/until.js");
const { classifyChecks, formatReview } = await import(new URL("../_lib/evidence.js", import.meta.url).href);

const A = "a".repeat(40), B = "b".repeat(40), OLD = "9".repeat(40);
const URL5 = "https://github.com/o/r/pull/5";
const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
const PR = { id: "P-R", name: "Bunkhouse", repos: [], folders: [], branch: "main", remote: { machine: "bunkhouse", projectId: "P-9", id: "B-1", writes: true } };
const COLS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const card = (i, o = {}) => ({ id: `T-${i}`, title: `card ${i}`, column: COLS[i % 6], priority: "P2", tags: [], created: i, updated: i, project: P.id, archived: false, agent: null, run: null, notes: [], desc: "", assignee: null, source: null, ...o });
const ok = (v) => ({ code: 0, stdout: typeof v === "string" ? v : JSON.stringify(v), stderr: "" });
const success = (name) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS" });
const prJson = (o = {}) => ({ number: 5, url: URL5, state: "OPEN", baseRefName: "main", baseRefOid: B, headRefName: "feat/x", headRefOid: A, statusCheckRollup: [success("build")], ...o });

const SIDE = ["exec", "hc", "read", "write", "watch", "every", "spawn", "set", "agents", "terminals"];
const none = Object.fromEntries(SIDE.map((k) => [k, 0]));
const delta = (calls, fn) => { const b = { ...calls }; const out = fn(); return { out, d: Object.fromEntries(SIDE.map((k) => [k, (calls[k] ?? 0) - (b[k] ?? 0)])) }; };
const render = (v, cx) => { globalThis.__rec = { ids: [], texts: [] }; try { v.render(cx); return { ...globalThis.__rec }; } finally { globalThis.__rec = undefined; } };

// A host. `gh` answers every env-wrapped gh call (see ghOf), `git` the git calls.
function host(tasks, { gh = (...a) => router()(...a), props = {}, remote = false, runSpawn = true } = {}) {
  C.resetCache(); C.setSettings("drover-tasks", {}); C.setSettings("drover-runs", {}); C.setSettings("drover-wakeups", {}); C.setSettings("drover-todos", {});
  IO.resetRemoteWriter();
  const calls = { exec: 0, hc: 0, read: 0, write: 0, watch: 0, every: 0, spawn: 0, set: 0, agents: 0, terminals: 0, opened: [] };
  const reads = {};
  const raw = { "drover.tasks": tasks, "drover.projects": remote ? [P, PR] : [P], "drover.runs": [] };
  if (remote) raw["drover.remote.bunkhouse.P-9"] = { at: Date.now(), tasks: [card(901, { id: "T-5", column: "review", project: "P-9" })], picks: { assignees: [], projects: [] } };
  const state = new Proxy(raw, { get(o, k) { if (typeof k === "string") reads[k] = (reads[k] ?? 0) + 1; return o[k]; }, set(o, k, v) { calls.set++; o[k] = v; return true; } });
  const h = {
    props, notified: [], home: "/h", appHome: "/nowhere", state, focused: { terminal: "t1", cwd: "/x", space: null }, spaces: [], panes: [], overlays: [],
    exec: async (cmd, args, opts) => {
      calls.exec++; (calls.log ??= []).push([cmd, ...args]);
      if (cmd === "test") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "open") { calls.opened.push(args); return { code: 0, stdout: "", stderr: "" }; }
      if (cmd === "git") return args[0] === "log" ? ok("a1 one") : args[0] === "diff" ? ok(" f.js | 1 +") : args[0] === "rev-parse" ? ok(A) : { code: 0, stdout: "", stderr: "" };
      return gh(args.slice(args.indexOf("gh") + 1), opts);
    },
    hc: async () => { calls.hc++; return { code: 1, stdout: "", stderr: "" }; },
    readTextFile: async () => { calls.read++; return null; },
    writeTextFile: async () => { calls.write++; },
    watchFolder: async () => { calls.watch++; },
    openOverlay: (o) => { h.overlays.push(o); return "ov1"; }, closeOverlay: (id) => { calls.closed = id; },
    run: () => {},
  };
  Object.defineProperty(h, "agents", { get() { calls.agents++; return []; } });
  Object.defineProperty(h, "terminals", { get() { calls.terminals++; return []; } });
  globalThis.__host = h;
  const timers = [];
  const cx = { notify() { calls.notified = (calls.notified ?? 0) + 1; }, stop_propagation() {}, spawn(f) { calls.spawn++; return runSpawn ? f(cx) : undefined; }, focus_handle: () => ({ focus() {} }), timer: { every(ms, f) { calls.every++; timers.push({ ms, f }); }, after() { calls.every++; } } };
  return { h, cx, raw, calls, reads, timers };
}
const router = (o = {}) => (g) => {
  if (g[0] === "api" && g[1] === "user") return ok("reader\n");
  if (g[0] === "api") return ok(B + "\n");
  if (g[0] === "repo") return ok({ nameWithOwner: "o/r" });
  if (g[0] === "pr" && g[1] === "list") return ok(o.list ?? [{ number: 5, url: URL5, state: "OPEN" }]);
  return o.view ?? ok(prJson());
};
const reviewNote = (head, verdict = "pass") => ({ id: "n9", at: 9, by: "inspector", kind: "review", text: formatReview({ head, verdict, report: "/w/review one.md" }) });
const WT = { id: "R-1", task: "T-3", worktree: { path: "/w", repo: "/repo", branch: "feat/x" } };

// Opens the dialog through the real host class (the same entry as the card editor): props { overlay, proof }.
async function open(tasks, o = {}) {
  const m = host(tasks, { ...o, props: { overlay: "ov1", proof: { id: "T-3", project: P.id } } });
  m.raw["drover.runs"] = [WT];
  const v = new Todos();
  v.init({}, m.cx);
  if (!o.noWait) await until(() => v.proof.state !== "reading", "proof loaded");
  return { ...m, v };
}
const rev = (o = {}) => card(3, { column: "review", run: "R-1", source: { kind: "github", id: "o/r#5", url: URL5 }, ...o });
const has = (r, s) => r.texts.some((x) => x.includes(s));

test("the dialog loads when it opens (init), shows reading first, then the evidence", async () => {
  const { v, calls, cx } = await open([rev()], { noWait: true });
  assert.equal(v.proof.state, "reading");
  assert.match(render(v, cx).texts.join("\n"), /Reading the proof/);
  await until(() => v.proof.state === "ready", "ready");
  assert.ok(calls.exec > 0, "init loaded");
  const r = render(v, cx);
  for (const s of ["Summary", "Changes", "Checks", "Review", "Proof artifact", "Green on aaaaaaa", "PR #5", "a1 one", "Reading as reader"]) assert.ok(has(r, s), s);
});

test("checks: green only when all passed on head A; pending, missing, empty and red are shown NOT green", async () => {
  for (const [label, roll] of [["pending", [success("a"), { __typename: "CheckRun", name: "b", status: "IN_PROGRESS", conclusion: null }]], ["missing", undefined], ["empty", []], ["red", [{ __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "FAILURE" }]]]) {
    const { v, cx } = await open([rev()], { gh: router({ view: ok(prJson({ statusCheckRollup: roll })) }) });
    const r = render(v, cx);
    assert.ok(has(r, "NOT green"), label);
    assert.ok(!has(r, "Green on"), label);
    assert.ok(roll?.length ? has(r, "b: ") : true);
  }
});

test("no PR: the head is the worktree commit; checks NOT green (No PR: no checks)", async () => {
  const { v, cx } = await open([rev({ source: null })], { gh: router({ list: [] }) });
  const r = render(v, cx);
  assert.ok(has(r, "No PR"));
  assert.ok(has(r, "NOT green"));
  assert.ok(has(r, "worktree commit"));
});

test("gh not logged in: NOT green, shown as unknown (gh not logged in), nothing raw", async () => {
  const { v, cx } = await open([rev()], { gh: () => ({ code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run: gh auth login" }) });
  const r = render(v, cx);
  assert.ok(has(r, "unknown (gh not logged in)"));
  assert.ok(has(r, "NOT green"));
  assert.ok(!r.texts.join("\n").includes("To get started"));
});

test("review: pass and adverse on head A; a review of another head is shown stale; none is shown missing", async () => {
  const t = async (notes) => { const { v, cx } = await open([rev({ notes })]); return render(v, cx); };
  assert.ok(has(await t([reviewNote(A)]), "Pass on aaaaaaa"));
  assert.ok(has(await t([reviewNote(A, "adverse")]), "Adverse on aaaaaaa"));
  const stale = await t([reviewNote(OLD)]);
  assert.ok(has(stale, "Stale"), "other head");
  assert.ok(has(stale, "999999"), "names the reviewed commit");
  assert.ok(!has(stale, "Pass on"), "a stale pass is not a pass");
  assert.ok(has(await t([]), "No review"));
  assert.ok(has(await t([{ id: "n", at: 1, by: "x", kind: "review", text: "looks good" }]), "No review"), "malformed is missing");
});

test("review file and proof artifact are links that open the path (spaces allowed)", async () => {
  const notes = [reviewNote(A), { id: "h", at: 2, by: "w", kind: "handoff", text: 'done\nproof="/p dir/proof 1.png"' }];
  const { v, cx, calls } = await open([rev({ notes })]);
  const r = render(v, cx);
  assert.ok(has(r, "/w/review one.md") && has(r, "/p dir/proof 1.png"));
  assert.ok(r.ids.includes("proof-open-review") && r.ids.includes("proof-open-artifact"));
  v.proof.openPath("/p dir/proof 1.png");
  await until(() => calls.opened.length === 1, "open called");
  assert.deepEqual(calls.opened[0], ["/p dir/proof 1.png"]);
  v.proof.openPath("relative/x");
  v.proof.openPath("-a/evil");
  assert.equal(calls.opened.length, 1, "only an absolute path opens");
});

test("Accept is disabled in every state that is not ready to accept, with a reason; Refresh and Close are live", async () => {
  const states = [];
  const a = await open([rev()], { noWait: true }); states.push(["reading", a]);
  await until(() => a.v.proof.state === "ready", "ready"); states.push(["ready", a]);
  const b = await open([rev()], { gh: () => ({ code: 1, stdout: "", stderr: "boom" }) }); states.push(["unknown", b]);
  const c = await open([rev()], { gh: router({ view: ok(prJson({ statusCheckRollup: [] })) }) }); states.push(["red/empty", c]);
  const d = await open([rev({ notes: [reviewNote(OLD)] })]); states.push(["stale", d]);
  const e = host([rev()], { props: { overlay: "ov1", proof: { id: "T-NOPE", project: P.id } } }); const ev = new Todos(); ev.init({}, e.cx); states.push(["missing card", { v: ev, cx: e.cx }]);
  for (const [name, { v, cx }] of states) {
    const r = render(v, cx);
    assert.ok(r.ids.includes("proof-accept-off"), `${name}: Accept is the disabled control`);
    assert.ok(!r.ids.includes("proof-accept"), `${name}: no live Accept`);
    assert.ok(!has(r, "ships in B3b"), `${name}: the B3a stub text is gone`);
    assert.ok(r.texts.some((x) => /Reading|Card not found|unknown|NOT green|plan|review|Review|Stale/.test(x)), `${name}: a reason is shown`);
    assert.ok(r.ids.includes("proof-close"), name);
  }
  assert.ok(render(b.v, b.cx).ids.includes("proof-refresh"));
});

test("a card that is not in the local store for that id and project: Card not found here", async () => {
  const m = host([rev({ project: "P-OTHER" })], { props: { overlay: "ov1", proof: { id: "T-3", project: P.id } } });
  const v = new Todos(); v.init({}, m.cx);
  assert.ok(has(render(v, m.cx), "Card not found here"));
  assert.equal(m.calls.exec, 0, "no I/O for a card that is not here");
});

test("Refresh reloads; a load from before a refresh or a close is dropped", async () => {
  let release;
  let gate = new Promise((r) => { release = r; });
  const { v, cx } = await open([rev()], { gh: (g) => (g[0] === "pr" && g[1] === "view" ? gate.then(() => ok(prJson())) : router()(g)), noWait: true });
  const first = v.proof.gen;
  v.proof.refresh(cx);
  assert.ok(v.proof.gen > first);
  release();
  await until(() => v.proof.state === "ready", "ready after refresh");
  const gen = v.proof.gen;
  v.proof.refresh(cx);
  await v.close(cx);
  await new Promise((r) => setImmediate(r));
  assert.equal(v.proof.closed, true);
  assert.ok(v.proof.gen > gen + 1, "close bumps the generation: the load in flight is dropped");
  assert.notEqual(v.proof.state, "error");
  assert.equal(v.proof.state, "reading", "a dropped load never lands");
});

for (const state of ["reading", "ready", "error"]) {
  test(`dialog render in ${state}: cold and warm make no exec/read/write/spawn/timer call and read no shared key`, async () => {
    const { v, cx, calls, reads } = await open([rev()], state === "error" ? { gh: () => { throw new Error("x"); } } : { noWait: state === "reading" });
    if (state === "error") v.proof.state = "error";
    for (const k in reads) delete reads[k];
    const cold = delta(calls, () => render(v, cx));
    assert.deepEqual(cold.d, none, "cold");
    assert.deepEqual(delta(calls, () => render(v, cx)).d, none, "warm");
    assert.deepEqual(reads, {}, "no shared key read in render");
  });
}

test("dialog source: render calls no loader, no io read, no exec", () => {
  const src = readFileSync(new URL("../drover-todos/proof.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("  render(cx) {"));
  for (const word of ["loadEvidence(", "load(", "loadRuns(", "exec(", "readTextFile(", "writeTextFile(", "cx.spawn(", "timer"]) assert.ok(!body.includes(word), `render must not call ${word}`);
});

// ---- the Tasks panel row ----
const tasksPanel = (n, { remote = false } = {}) => {
  const tasks = Array.from({ length: n }, (_, i) => card(i + 1));
  const m = host(tasks, { remote, runSpawn: false }); // the panel's own watchers are not under test here: its spawns do not run
  const t = new Tasks(); t.init({}, m.cx);
  return { t, ...m };
};

for (const n of [3, 30, 300]) {
  test(`Tasks panel, ${n} cards: Review rows have a Proof icon; cold and warm render stay side-effect free`, () => {
    const { t, cx, calls } = tasksPanel(n);
    const cold = delta(calls, () => render(t, cx));
    assert.deepEqual(cold.d, none, "cold");
    assert.ok(cold.out.ids.some((i) => i.startsWith("proof-T-")), "a Review row has Proof");
    assert.ok(cold.out.ids.some((i) => i.startsWith("done-T-")), "the existing check mark stays");
    assert.deepEqual(delta(calls, () => render(t, cx)).d, none, "warm");
  });
}

test("Tasks panel: shared-key reads of a render do not depend on the card count", () => {
  const seen = [3, 30, 300].map((n) => { const { t, cx, reads } = tasksPanel(n); render(t, cx); for (const k in reads) delete reads[k]; render(t, cx); return { ...reads }; });
  assert.deepEqual(seen[1], seen[0]);
  assert.deepEqual(seen[2], seen[0]);
});

test("Tasks panel: Proof opens the dialog overlay with the card id and project (an action, not render)", () => {
  const { t, cx, h } = tasksPanel(6);
  const before = h.overlays.length;
  render(t, cx);
  assert.equal(h.overlays.length, before, "render opens nothing");
  IO.openProof({ id: "T-3", project: P.id });
  const o = h.overlays.at(-1);
  assert.deepEqual([o.mod, o.kind, o.modal, o.props], ["drover-todos", "dialog", true, { proof: { id: "T-3", project: P.id } }]);
});

test("Tasks panel: a remote Review card has Proof off with the reason and does no I/O", () => {
  const { t, cx, calls, h } = tasksPanel(3, { remote: true });
  const r = delta(calls, () => render(t, cx));
  assert.deepEqual(r.d, none);
  assert.ok(r.out.ids.includes("ro-proof-bunkhouse/P-9/T-5"), "off control for the remote row");
  assert.ok(!r.out.ids.includes("proof-bunkhouse/P-9/T-5"), "no live Proof on a remote row");
  assert.ok(r.out.ids.some((i) => i === "proof-T-3"), "the local Review card with the same id family still has it");
  assert.equal(h.overlays.length, 0);
});

test("Tasks panel: a changed card shows after the cache refresh outside render (rows follow the snapshot)", () => {
  const { t, cx, raw, calls, timers } = tasksPanel(3);
  const hasId = (r, id) => r.ids.includes(id);
  assert.ok(hasId(render(t, cx), "proof-T-3"));
  raw["drover.tasks"] = raw["drover.tasks"].map((x) => (x.id === "T-3" ? { ...x, column: "doing", updated: 99 } : x));
  assert.ok(hasId(render(t, cx), "proof-T-3"), "render alone does not look again");
  for (const x of timers) x.f(cx);
  assert.ok(!hasId(render(t, cx), "proof-T-3"), "after the refresh the row follows the card");
  assert.deepEqual(delta(calls, () => render(t, cx)).d, none);
});

// ---- review round 1, finding 1: Refresh re-reads the card ----
test("Refresh re-resolves the card from the local store: a changed verdict, source, summary and notes show; the old snapshot is never reused", async () => {
  const { v, cx, raw, calls } = await open([rev({ title: "old summary", notes: [reviewNote(A)] })], { gh: (g) => (g[0] === "pr" && g[1] === "view" ? ok(prJson({ url: g[2] })) : router()(g)) }); // gh answers about the PR it was asked about
  assert.ok(has(render(v, cx), "Pass on aaaaaaa") && has(render(v, cx), "old summary"));
  raw["drover.tasks"] = [rev({ title: "new summary", source: { kind: "github", id: "o/r#9", url: "https://github.com/o/r/pull/9" }, notes: [reviewNote(A, "adverse")] })];
  calls.log = [];
  v.proof.refresh(cx);
  await until(() => v.proof.state === "ready", "reloaded");
  const r = render(v, cx);
  assert.ok(has(r, "new summary") && !has(r, "old summary"));
  assert.ok(has(r, "Adverse on aaaaaaa") && !has(r, "Pass on"));
  assert.ok(calls.log.some((c) => c.includes("https://github.com/o/r/pull/9")), "asks about the new PR");
  assert.ok(!calls.log.some((c) => c.includes(URL5)), "never about the old one");
});

test("Refresh: a card that was removed, or moved to another project, shows Card not found here and asks nothing", async () => {
  for (const next of [[], [rev({ project: "P-OTHER" })]]) {
    const { v, cx, raw, calls } = await open([rev()]);
    raw["drover.tasks"] = next;
    calls.exec = 0;
    v.proof.refresh(cx);
    const r = render(v, cx);
    assert.equal(v.proof.state, "missing");
    assert.ok(has(r, "Card not found here"));
    assert.ok(!has(r, "Green on"), "the old evidence is not left on screen");
    assert.ok(r.ids.includes("proof-accept-off"));
    assert.equal(calls.exec, 0, "no I/O for a card that is gone");
  }
});
