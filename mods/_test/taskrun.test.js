// Pure helpers for the task editor's Run and Wakeups sections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { taskRuns, linkedRun, pastRuns, wakeLabel, runSummary, taskWakes, noteAuthor } from "../_lib/taskrun.js";

const task = { id: "T-1" };
const term = (address, extra = {}) => ({ address, name: `n-${address}`, started: 1000, ...extra });
const run = (id, extra = {}) => ({ id, task: "T-1", started: 1000, terminals: [term("t1", { role: "leader" })], ...extra });
const none = new Map(), alive = (...a) => new Set(a);

test("taskRuns: only this task's runs, newest started first; no run -> []", () => {
  assert.deepEqual(taskRuns(task, []), []);
  const runs = [run("A", { started: 10 }), { ...run("X"), task: "T-2" }, run("B", { started: 30 }), run("C", { started: 20 })];
  assert.deepEqual(taskRuns(task, runs).map((r) => r.id), ["B", "C", "A"]);
});

test("runSummary: working run shows status, runner, branch, running duration and lineage rows", () => {
  const r = run("A", { started: 1000, name: "Squad Alpha", worktree: { path: "/w", branch: "feat/x" } });
  const s = runSummary(r, new Map([["t1", "working"]]), alive("t1"), 1000 + 5 * 60000, [r]);
  assert.equal(s.status, "working");
  assert.equal(s.runner, "Squad Alpha");
  assert.equal(s.branch, "feat/x");
  assert.equal(s.durationText, "5m");
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].leader, true);
});

test("runSummary: cleared run (no terminals / all gone, ended) is ended with a fixed duration and no branch", () => {
  const cleared = run("A", { terminals: [], ended: 1000 + 60 * 60000 });
  const s = runSummary(cleared, none, alive(), 9e12, [cleared]);
  assert.equal(s.status, "ended");
  assert.equal(s.branch, null);
  assert.equal(s.durationText, "1h 00m");
  assert.deepEqual(s.rows, []);
  const gone = run("B", { ended: 2000 });
  assert.equal(runSummary(gone, none, alive(), 9e12, [gone]).status, "ended");
});

test("runSummary: legacy run without name falls back to its id", () => {
  const r = run("A");
  assert.equal(runSummary(r, none, alive("t1"), 2000, [r]).runner, "A");
});

test("linkedRun: the run named by task.run, even when not the newest; null link or missing run -> null", () => {
  const runs = [run("OLD", { started: 10 }), run("NEW", { started: 20 })];
  assert.equal(linkedRun({ id: "T-1", run: "OLD" }, runs).id, "OLD");
  assert.equal(linkedRun({ id: "T-1", run: null }, runs), null);
  assert.equal(linkedRun({ id: "T-1" }, runs), null);
  assert.equal(linkedRun({ id: "T-1", run: "GONE" }, runs), null);
  assert.equal(linkedRun({ id: "T-1", run: "X2" }, [{ ...run("X2"), task: "T-2" }]), null, "another task's run");
});

test("pastRuns: the task's other runs, newest first; a cleared link makes all of them past", () => {
  const runs = [run("A", { started: 10 }), run("B", { started: 30 }), run("C", { started: 20 })];
  assert.deepEqual(pastRuns({ id: "T-1", run: "C" }, runs).map((r) => r.id), ["B", "A"]);
  assert.deepEqual(pastRuns({ id: "T-1", run: null }, runs).map((r) => r.id), ["B", "C", "A"]);
});

test("taskWakes: task-id wakes always; terminal wakes only for the linked run; old-run terminals excluded", () => {
  const runs = [run("OLD", { started: 10, terminals: [term("told")] }), run("NEW", { started: 20, terminals: [term("tnew")] }), { ...run("C"), task: "T-2", terminals: [term("t7")] }];
  const w = (id, target, extra = {}) => ({ id, target, status: "scheduled", due: 100, created: 1, ...extra });
  const wakes = [w("W1", "T-1", { due: 300 }), w("W2", "tnew", { due: 200 }), w("W3", "told"), w("W4", "T-2"), w("W5", "t7"), w("W6", "T-1", { status: "sent", at: 50 }), w("W1", "T-1", { due: 300 })];
  assert.deepEqual(taskWakes({ id: "T-1", run: "NEW" }, runs, wakes).map((x) => x.id), ["W2", "W1", "W6"]);
  assert.deepEqual(taskWakes({ id: "T-1", run: "OLD" }, runs, wakes).map((x) => x.id), ["W3", "W1", "W6"]);
  assert.deepEqual(taskWakes({ id: "T-1", run: null }, runs, wakes).map((x) => x.id), ["W1", "W6"], "cleared link: no terminal wakes");
  assert.deepEqual(taskWakes({ id: "T-1" }, [], []), []);
});

test("wakeLabel: task target, member name, or raw address", () => {
  const runs = [run("A", { terminals: [term("t1", { name: "Wrangler" })] })];
  const t = { id: "T-1", run: "A" };
  assert.equal(wakeLabel({ target: "T-1" }, t, runs), "Wake task");
  assert.equal(wakeLabel({ target: "t1" }, t, runs), "Wake Wrangler");
  assert.equal(wakeLabel({ target: "t9" }, t, runs), "Wake t9");
});

// ---- S3b: source card, pull request rows, context rows ----
import { sourceCard, prRows, contextRows, carryContext } from "../_lib/taskrun.js";
import { register } from "node:module";
register("./hooks.js", import.meta.url);
globalThis.__host ??= { props: {}, state: {}, notified: [], agents: [], terminals: [], calls: [], writes: 0 };
const { mergeContext } = await import("../_lib/io.js");

const DAY = 86400000, NOW = Date.parse("2026-02-01T00:00:00Z");
const ghIssue = { kind: "github", key: "o/r#7", title: "Bug", status: "OPEN", category: "indeterminate", url: "https://github.com/o/r/issues/7", assignee: "ann", project: "o/r" };
const pr = (n, extra = {}) => ({ number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, created: NOW - 3 * DAY, state: "Open", via: null, from: null, ...extra });

test("sourceCard: null without an issue; else the fields the mini card shows", () => {
  assert.equal(sourceCard(null), null);
  assert.equal(sourceCard(undefined), null);
  assert.deepEqual(sourceCard(ghIssue), { kind: "github", key: "o/r#7", title: "Bug", status: "OPEN", category: "indeterminate", url: ghIssue.url, assignee: "ann", parent: null });
});

test("prRows: null/[] -> []; label is the provenance label; age text; open first then newest", () => {
  assert.deepEqual(prRows(null, NOW), []);
  assert.deepEqual(prRows([], NOW), []);
  const rows = prRows([
    pr(1, { state: "Merged", created: NOW - 1 * DAY, from: "branch" }),
    pr(2, { state: "Open", created: NOW - 5 * DAY, from: "linked" }),
    pr(3, { state: "Draft", created: NOW - 2 * DAY, from: "branch" }),
    pr(4, { state: "Closed", created: NOW - 9 * DAY, from: "branch" }),
    pr(5, { state: "Open", created: NOW - 1 * DAY, via: "feat/y", from: "branch" }),
  ], NOW);
  assert.deepEqual(rows.map((r) => r.number), [5, 3, 1, 4, 2]);
  assert.deepEqual(rows[0], { number: 5, label: "#5 · via feat/y", title: "PR 5", state: "Open", age: "1d", url: pr(5).url });
  assert.equal(rows[4].label, "#2 · linked", "linked after the branch PRs");
  assert.equal(rows[1].label, "#3 · branch", "branch provenance");
  assert.equal(rows[1].state, "Draft");
});

test("prRows: a PR without a created date has an empty age", () => {
  assert.equal(prRows([pr(1, { created: null })], NOW)[0].age, "");
});

test("contextRows: github source with closing PRs and no run", () => {
  const c = contextRows({ issue: ghIssue, prs: [pr(11, { from: "linked" })], errors: [], good: 1 });
  assert.equal(c.issue.key, "o/r#7");
  assert.deepEqual(c.prs.map((p) => p.label), ["#11 · linked"]);
  assert.deepEqual([c.errors, c.stale], [[], false]);
});

test("contextRows: nothing loaded yet / no source -> empty, not stale", () => {
  for (const ctx of [null, undefined, { issue: null, prs: [], errors: [] }]) {
    assert.deepEqual(contextRows(ctx), { issue: null, prs: [], errors: [], stale: false });
  }
});

test("contextRows: gh failure keeps the last good data, shows the error and is stale", () => {
  const good = mergeContext(undefined, { at: 1, issue: ghIssue, prs: [pr(11, { from: "linked" })], errors: [] });
  const bad = mergeContext(good, { at: 2, issue: null, prs: null, errors: ["Issue: gh: network down", "Pull requests: gh: network down"] });
  const c = contextRows(bad);
  assert.equal(c.issue.key, "o/r#7");
  assert.deepEqual(c.prs.map((p) => p.number), [11]);
  assert.equal(c.errors.length, 2);
  assert.equal(c.stale, true);
});

test("contextRows: an error with no earlier data is shown but not stale", () => {
  const c = contextRows(mergeContext(undefined, { at: 1, issue: null, prs: null, errors: ["Issue: boom"] }));
  assert.deepEqual([c.issue, c.prs, c.errors, c.stale], [null, [], ["Issue: boom"], false]);
});

test("prRows: branch PRs come before linked ones, even when merged and the linked are open (10 linked cannot push the branch PR out)", () => {
  const rows = prRows([
    ...Array.from({ length: 10 }, (_, i) => pr(100 + i, { from: "linked", state: "Open", created: NOW - i * DAY })),
    pr(1, { from: "branch", state: "Merged", created: NOW - 30 * DAY }),
  ], NOW);
  assert.equal(rows[0].number, 1);
  assert.equal(rows.slice(0, 10).some((r) => r.number === 1), true);
  const mixed = prRows([pr(2, { from: "branch", state: "Closed" }), pr(3, { from: "branch", state: "Open" }), pr(4, { from: "linked", state: "Open" })], NOW);
  assert.deepEqual(mixed.map((r) => r.number), [3, 2, 4], "within branch: open first; then linked");
});

test("carryContext: last good PRs never cross runs; the task-scoped issue does", () => {
  const prev = { at: 1, run: "A", issue: ghIssue, prs: [pr(9, { from: "branch" })], errors: [], good: 1 };
  assert.equal(carryContext(undefined, "A"), undefined);
  assert.equal(carryContext(prev, "A"), prev, "same run: unchanged");
  const other = carryContext(prev, "B");
  assert.equal(other.prs, null);
  assert.equal(other.issue.key, "o/r#7");
  assert.equal(carryContext(prev, null).prs, null, "run cleared");
  // B fails to load: the issue stays, A's PR does not appear
  const merged = mergeContext(other, { at: 2, issue: ghIssue, prs: null, errors: ["Pull requests: gh: offline"] });
  assert.deepEqual(contextRows(merged).prs, []);
  assert.equal(merged.issue.key, "o/r#7");
});

test("noteAuthor: a person stays as is; an agent address resolves to name (role) from the task's runs; unknown address stays", () => {
  const runs = [run("R1", { terminals: [term("t5", { name: "Wrangler", role: "Wrangler" }), term("t4", { name: "Trail Boss", role: "leader" })] }), { ...run("R2"), task: "T-2", terminals: [term("t8", { name: "Other" })] }];
  assert.equal(noteAuthor("you", task, runs), "you");
  assert.equal(noteAuthor("t5", task, runs), "Wrangler");
  assert.equal(noteAuthor("t4", task, runs), "Trail Boss (leader)");
  assert.equal(noteAuthor("t8", task, runs), "t8", "another task's run does not resolve");
  assert.equal(noteAuthor("t99", task, runs), "t99");
  assert.equal(noteAuthor("t5", task, []), "t5");
  assert.equal(noteAuthor("", task, runs), "you");
});
