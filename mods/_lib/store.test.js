import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAIMING, firstSight, add, update, shift, reorder, matches, attention, list, validate, imageName, appendImage, imageLines, staleImages, applyCommand, addCommand, columnName, columnId, NOTE_KINDS, COLUMNS, GROUPS, PRIORITY_LABEL, STATUS_ICON, updatedAgo, clampText, sortCards, archiveDone, inScope, SCOPES, checklistProgress, ringGlyph, menuChange, FILTER_FIELDS, toggleFilter, clearFilters, matchesFilter, filterValues, searchFilters, filterChips, filterProjects, nextIndex, canCreate, isSubmitKey, allTags, toggleTag, newTag, runnerChoices, startHint, canCreateAgent, agentChoices, packDraft, unpackDraft, createSize, editSize, saveText, patchField, assigneeKey, assigneeText } from "./store.js";

test("add, edit, archive, restore keep the id; invalid edits change nothing", () => {
  const a = add([], { title: "  Fix login ", tags: "#Auth, auth, ui", priority: "P1" }, 1);
  assert.equal(a.task.title, "Fix login");
  assert.deepEqual(a.task.tags, ["auth", "ui"]);
  const bad = update(a.tasks, a.task.id, { title: "  " }, 2);
  assert.ok(bad.error);
  const archived = update(a.tasks, a.task.id, { archived: true }, 3);
  const restored = update(archived.tasks, a.task.id, { archived: false }, 4);
  assert.equal(restored.task.id, a.task.id);
  assert.equal(restored.task.archived, false);
  assert.ok(add([], { title: "" }).error);
  assert.ok(validate({ title: "x".repeat(201) }).error);
});

test("list drops junk from shared state", () => {
  assert.deepEqual(list(null), []);
  assert.equal(list([{ id: "a" }, null, 3]).length, 1);
});

test("shift moves between columns and stops at the edges", () => {
  const { tasks, task } = add([], { title: "x", column: "backlog" });
  assert.ok(shift(tasks, task.id, -1).error);
  assert.equal(shift(tasks, task.id, 1).task.column, "todo");
});

test("search words, tags and priority", () => {
  const t = add([], { title: "Fix login bug", tags: "auth", priority: "P0" }).task;
  assert.ok(matches(t, "login #au p0"));
  assert.ok(!matches(t, "login #ui"));
  assert.ok(matches(t, ""));
});

test("attention: a stopped agent is never ready for review", () => {
  const t = { column: "doing", agent: "t1", archived: false };
  const agents = (status) => new Map([["t1", { status }]]);
  assert.equal(attention(t, agents("working")).group, "working");
  assert.equal(attention(t, agents("blocked")).group, "needs");
  assert.equal(attention(t, agents("done")).group, "needs");
  assert.equal(attention(t, new Map()).group, "needs");
  assert.equal(attention({ ...t, column: "review" }, agents("done")).group, "review");
  assert.equal(attention({ ...t, column: "done" }, agents("done")), null);
});

import { base64, jiraPage, parseScope, githubItems, httpProblem } from "./sources.js";
import { bySource } from "./store.js";

test("base64 matches Buffer, including UTF-8", () => {
  for (const s of ["", "a", "ab", "abc", "me@x.ca:tok-é", "€ 😀"]) assert.equal(base64(s), Buffer.from(s).toString("base64"));
});

test("jira page: rows, next page, refuses unknown shapes", () => {
  const p = jiraPage({ issues: [{ id: "10", key: "OG-1", fields: { summary: "S", status: { name: "To Do", statusCategory: { key: "new" } } } }], nextPageToken: "n", isLast: false }, "x.atlassian.net");
  assert.equal(p.items[0].id, "x.atlassian.net/10");
  assert.equal(p.items[0].url, "https://x.atlassian.net/browse/OG-1");
  assert.equal(p.next, "n");
  assert.equal(jiraPage({ issues: [], isLast: true }, "x").items.length, 0);
  assert.throws(() => jiraPage("<html>login</html>", "x"));
  assert.match(httpProblem(401), /token/);
});

test("github scopes deny by default and filter results", () => {
  assert.equal(parseScope("example-org"), "example-org");
  assert.equal(parseScope("https://github.com/example-org/api/"), "example-org/api");
  assert.equal(parseScope("example-org api"), null);
  assert.equal(parseScope("*"), null);
  const raw = [
    { number: 1, title: "a", url: "u1", repository: { nameWithOwner: "example-org/api" } },
    { number: 2, title: "b", url: "u2", repository: { nameWithOwner: "example-orgx/api" } },
  ];
  assert.deepEqual(githubItems(raw, ["example-org"]).map((i) => i.id), ["u1"]);
  assert.equal(githubItems(raw, []).length, 0);
});

test("githubItems keeps bounded labels, author and assignees, no milestones", () => {
  const raw = [{
    number: 1, title: "a", url: "u1", repository: { nameWithOwner: "example-org/api" },
    labels: [{ name: "bug", color: "f00" }, { name: 7 }, null, ...Array.from({ length: 30 }, (_, i) => ({ name: `l${i}` }))],
    author: { login: "ada", is_bot: false },
    assignees: Array.from({ length: 15 }, (_, i) => ({ login: `u${i}` })),
    milestone: { title: "v1" },
  }, { number: 2, title: "b", url: "u2", repository: { nameWithOwner: "example-org/api" } }];
  const [a, b] = githubItems(raw, ["example-org"]);
  assert.equal(a.labels.length, 20);
  assert.deepEqual(a.labels.slice(0, 2), ["bug", "l0"]);
  assert.equal(a.author, "ada");
  assert.equal(a.assignees.length, 10);
  assert.deepEqual(a.assignees.slice(0, 2), ["u0", "u1"]);
  assert.equal("milestone" in a, false);
  assert.deepEqual([b.labels, b.author, b.assignees], [[], "", []]);
});

test("one card per source item", () => {
  const a = add([], { title: "x", source: { kind: "jira", id: "s/1", url: "u" } });
  assert.equal(bySource(a.tasks, "jira", "s/1").id, a.task.id);
  assert.equal(bySource(a.tasks, "github", "s/1"), null);
});


test("agent commands: move only, known columns, known tasks", () => {
  const { tasks, task } = add([], { title: "x" });
  assert.equal(applyCommand(tasks, { op: "move", id: task.id, column: "review" }).task.column, "review");
  assert.ok(applyCommand(tasks, { op: "move", id: task.id, column: "nope" }).error);
  assert.ok(applyCommand(tasks, { op: "move", id: "T-NONE", column: "done" }).error);
  assert.ok(applyCommand(tasks, { op: "delete", id: task.id }).error);
  assert.ok(applyCommand(tasks, { op: "move", id: task.id, column: "done", title: "" }).task.title === "x");
});

test("column names: the CLI name is the board label, the stored id never changes", () => {
  for (const [id, label] of COLUMNS) {
    assert.equal(columnName(id), label.toLowerCase().replace(/ /g, "-"));
    assert.equal(columnId(columnName(id)), id);
    assert.equal(columnId(id), id); // the stored id stays valid input
    assert.equal(columnId(label), id);
    assert.equal(columnId(label.toUpperCase()), id);
  }
  assert.equal(columnName("todo"), "ready");
  assert.equal(columnName("doing"), "in-progress");
  for (const a of ["ready", "READY", " todo "]) assert.equal(columnId(a), "todo");
  for (const a of ["in-progress", "In progress", "inprogress", "doing", "DOING"]) assert.equal(columnId(a), "doing");
  for (const bad of ["nope", "", null, undefined, 3, "in-progres"]) assert.equal(columnId(bad), null);
  assert.equal(columnName("nope"), null);
});

test("agent commands accept column names and aliases and store the id", () => {
  const { tasks, task } = add([], { title: "x" });
  for (const [name, id] of [["ready", "todo"], ["in-progress", "doing"], ["todo", "todo"], ["doing", "doing"], ["Review", "review"]]) {
    assert.equal(applyCommand(tasks, { op: "move", id: task.id, column: name }).task.column, id, name);
  }
  assert.equal(addCommand(tasks, { title: "y", column: "ready" }).task.column, "todo");
  assert.equal(addCommand(tasks, { title: "y", column: "in-progress" }).task.column, "doing");
  assert.equal(addCommand(tasks, { title: "y" }).task.column, "backlog");
  assert.equal(addCommand(tasks, { title: "y", column: "nope" }).error, "Unknown column nope (use backlog, ready, in-progress, review, blocked, done)");
  const bad = applyCommand(tasks, { op: "move", id: task.id, column: "nope" }).error;
  assert.equal(bad, "Unknown column nope (use backlog, ready, in-progress, review, blocked, done)");
});

import * as R from "./runs.js";

test("agents and squads: validate, version, refuse removing a used agent", () => {
  let cfg = R.config(null);
  assert.equal(cfg.agents.length, 13);
  assert.ok(R.saveAgent(cfg, { name: "", command: "x" }).error);
  assert.ok(R.saveAgent(cfg, { name: "X", command: "  " }).error);
  const a = R.saveAgent(cfg, { name: "Opus Dev", command: "claude --model claude-opus-5-5" });
  assert.equal(a.agent.id, "opus-dev");
  assert.ok(R.saveAgent(a.config, { name: "Opus Dev", command: "x" }).error);
  const again = R.saveAgent(a.config, { id: "opus-dev", name: "Opus Dev", command: "claude" });
  assert.equal(again.agent.version, 2);
  assert.ok(R.removeFrom(cfg, "agents", "codex").error);
  assert.ok(R.saveSquad(cfg, { name: "S", leader: "nobody" }).error);
  assert.deepEqual(R.argv(" claude  --model x "), ["claude", "--model", "x"]);
});

test("plan and prompts: roster, worktree, drover hint", () => {
  const cfg = R.config(null);
  const p = R.plan(cfg, { kind: "squad", id: "dev-review" });
  assert.equal(p.leader.id, "claude");
  assert.equal(p.members[0].id, "codex");
  assert.ok(R.plan(cfg, { kind: "agent", id: "nope" }).error);
  const task = { id: "T-1", title: "Fix", desc: "" };
  const ctx = { drover: "/d", souls: "/s" };
  const lp = R.leaderPrompt(task, p.leader, [{ ...p.members[0], address: "t9" }], ctx);
  assert.match(lp, /t9 Codex/);
  assert.match(lp, /\/d move T-1 review/);
  assert.match(R.memberPrompt(task, p.members[0], ctx), /Wait for instructions/);
  // souls, free runs, a coordinator
  const boss = R.plan(cfg, { kind: "squad", id: "cattle-drive" });
  assert.deepEqual([boss.leader.id, ...boss.members.map((m) => m.id)], ["trail-boss", "wrangler", "inspector"]);
  const free = R.leaderPrompt(null, R.plan(cfg, { kind: "agent", id: "drover" }).leader, [], { ...ctx, reportTo: "t3" });
  assert.match(free, /\/s\/drover\.md/);
  assert.match(free, /without a task/);
  assert.match(free, /hc send t3/);
  assert.doesNotMatch(free, /move/);
  const dv = R.plan(cfg, { kind: "agent", id: "drover" }).leader;
  const bound = R.leaderPrompt(null, dv, [], { ...ctx, reportTo: "t3", project: { id: "P-1", name: "Alpha" } });
  assert.match(bound, /bound to project Alpha \(P-1\): queue mode\. Follow the soul section Queue mode now\./);
  assert.doesNotMatch(bound, /say hello|wait for the person/);
  const mine = { agents: [{ id: "claude", name: "Mine", command: "x", version: 3 }], squads: [] };
  const d = R.addDefaults(mine);
  assert.equal(d.config.agents.find((a) => a.id === "claude").name, "Mine");
  assert.ok(d.added > 5);
  assert.equal(R.addDefaults(d.config).added, 0);
  assert.deepEqual(R.worktreeOf("/h", "/src/api", { id: "T-AB", title: "Fix the Login!" }), { branch: "feat/T-AB/fix-the-login", path: "/h/.herdr/worktrees/api/feat-T-AB-fix-the-login" });
});

test("worktree branch: <type>/<id>/<desc>", () => {
  const b = (task) => R.worktreeOf("/h", "/src/api", { id: "T-1", title: "Add x", ...task }).branch;
  assert.equal(b({ tags: ["bug"] }), "fix/T-1/add-x");
  assert.equal(b({ tags: ["E1", "fix"] }), "fix/T-1/add-x");
  assert.equal(b({ tags: ["chore"] }), "chore/T-1/add-x");
  assert.equal(b({ tags: ["hotfix"] }), "hotfix/T-1/add-x");
  assert.equal(b({ tags: ["E1"] }), "feat/T-1/add-x");
  assert.equal(b({ source: { kind: "jira", id: "s/1", url: "https://s.atlassian.net/browse/ABC-123" } }), "feat/ABC-123/add-x");
  assert.equal(b({ source: { kind: "github", id: "u", url: "https://github.com/o/r/issues/42" } }), "feat/42/add-x");
  assert.equal(b({ source: { kind: "jira", id: "s/1", url: "not a url" } }), "feat/T-1/add-x");
  assert.equal(b({ title: "  --Ça va / été?? 100%--  " }), "feat/T-1/a-va-t-100");
  assert.equal(b({ title: "x".repeat(80) }), `feat/T-1/${"x".repeat(50)}`);
  assert.equal(b({ title: "!!!" }), "feat/T-1/task");
  assert.equal(R.worktreeOf("/h", "/src/api", { id: "T-1", title: "a" }).path, "/h/.herdr/worktrees/api/feat-T-1-a");
});

test("run status: blocked wins, gone is explicit", () => {
  const run = { terminals: [{ address: "t1" }, { address: "t2" }] };
  const live = new Map([["t1", "idle"], ["t2", "blocked"]]);
  assert.equal(R.runStatus(run, live, new Set(["t1", "t2"])), "blocked");
  assert.equal(R.runStatus(run, new Map([["t1", "working"]]), new Set(["t1"])), "working");
  assert.equal(R.runStatus(run, new Map(), new Set()), "ended");
  assert.equal(R.runStatus(run, new Map([["t1", "done"]]), new Set(["t1"])), "stopped");
});

import * as W from "./wake.js";
import * as T from "./transcript.js";

test("wakeups: times, validation, never into a blocked agent", () => {
  const now = new Date(2026, 10, 11, 10, 0).getTime();
  assert.equal(W.parseWhen("15m", now), now + 15 * 60000);
  assert.equal(W.parseWhen("1h30m", now), now + 90 * 60000);
  assert.equal(new Date(W.parseWhen("09:00", now)).getDate(), 12);
  assert.equal(new Date(W.parseWhen("11:00", now)).getHours(), 11);
  assert.equal(W.parseWhen("soon", now), null);
  assert.ok(W.addWake([], { target: "x y", when: "now", text: "hi" }).error);
  assert.ok(W.addWake([], { target: "t12", when: "now", text: " " }).error);
  const { wake } = W.addWake([], { target: "T-ABC", when: "now", text: "check CI" }, now);
  assert.equal(W.decide(wake, "idle", now).action, "send");
  assert.equal(W.decide(wake, "blocked", now).action, "wait");
  assert.equal(W.decide(wake, "working", now).action, "wait");
  assert.equal(W.decide(wake, undefined, now).action, "fail");
  assert.equal(W.decide(wake, "idle", now + 3 * 3600000).action, "expire");
  assert.equal(W.decide({ ...wake, due: now + 1 }, "idle", now).action, "wait");
});

test("transcripts: claude and codex, skip noise, compact tools", () => {
  const claude = [
    { type: "user", message: { content: "fix the bug" } },
    { type: "user", message: { content: "<command-name>/model</command-name>" } },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "On it." }, { type: "tool_use", name: "Bash", input: { command: "npm test\nmore" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub" }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n{broken";
  assert.deepEqual(T.claudeEntries(claude).entries, [
    { role: "user", text: "fix the bug" }, { role: "assistant", text: "On it." }, { role: "tool", text: "Bash: npm test" }]);
  const codex = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "# AGENTS.md instructions" }] } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ text: "sys" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "review it" }] } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"git diff\"}" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "LGTM" }] } },
  ].map((x) => JSON.stringify(x)).join("\n");
  assert.deepEqual(T.codexEntries(codex).entries.map((e) => e.text), ["review it", "exec_command: git diff", "LGTM"]);
});

test("wakeups: pause, source; current run and its wakeups", () => {
  const now = 1_700_000_000_000;
  const { wake } = W.addWake([], { target: "t12", when: "now", text: "go", source: "agent" }, now);
  assert.equal(wake.source, "agent");
  const paused = W.setEnabled([wake], wake.id, false)[0];
  assert.deepEqual(W.decide(paused, "idle", now), { action: "wait", reason: "Paused" });
  assert.equal(W.decide(paused, "idle", now + 3 * 3600000).action, "expire");
  const plain = { id: "R1", task: "T-A", space: "s1", worktree: null, terminals: [{ address: "t12" }] };
  const room = { id: "R2", task: "T-B", space: "s2", worktree: { path: "/wt/b" }, terminals: [{ address: "t20" }] };
  const runs = [plain, room];
  assert.equal(R.currentRun({ terminal: "t12", space: "s1" }, runs).id, "R1");
  assert.equal(R.currentRun({ terminal: null, space: "s1", cwd: "/x" }, runs), null); // no worktree: space alone is not "inside"
  assert.equal(R.currentRun({ terminal: "t99", space: "s9", cwd: "/wt/b/src" }, runs).id, "R2");
  assert.equal(R.currentRun({ terminal: null, space: "s2" }, runs).id, "R2");
  const wakes = [{ target: "T-B" }, { target: "t20" }, { target: "t12" }];
  assert.equal(R.wakesOf(room, wakes).length, 2);
});

import { jiraIssue, jiraKey, githubIssue, prItems } from "./sources.js";
test("issue context: jira issue, github issue, branch PRs", () => {
  const j = jiraIssue({ key: "MATH-653", fields: { summary: "Profile sheet", status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    assignee: { displayName: "Mika" }, project: { name: "Pairstone" }, issuetype: { name: "Story" },
    parent: { key: "MATH-641", fields: { summary: "Epic F", status: { name: "To Do", statusCategory: { key: "new" } } } } } }, "s.net");
  assert.equal(j.parent.url, "https://s.net/browse/MATH-641");
  assert.deepEqual([j.status, j.assignee, j.project], ["In Progress", "Mika", "Pairstone"]);
  assert.equal(jiraIssue({ key: "A-1", fields: {} }, "s").parent, null);
  assert.throws(() => jiraIssue({}, "s"));
  assert.equal(jiraKey("https://s.net/browse/MATH-653"), "MATH-653");
  assert.equal(jiraKey("https://evil/x"), null);
  const g = githubIssue({ number: 7, title: "Bug", state: "OPEN", assignees: [{ login: "md" }], closedByPullRequestsReferences: [{ url: "u1" }] }, "https://github.com/example-org/app/issues/7");
  assert.deepEqual([g.key, g.assignee, g.type, g.linked[0]], ["example-org/app#7", "md", "Issue", "u1"]);
  const prs = prItems([{ number: 1, url: "a", state: "OPEN", isDraft: true, via: "mods/lean" }, { number: 2, url: "b", state: "MERGED" }, { number: 2, url: "b", state: "MERGED" }]);
  assert.deepEqual(prs.map((p) => [p.state, p.via]), [["Draft", "mods/lean"], ["Merged", null]]);
  assert.throws(() => prItems(null));
});

test("intSetting keeps whole numbers in range, else the fallback", async () => {
  const { intSetting } = await import("./sources.js");
  assert.equal(intSetting(7, 1, 20, 4), 7);
  assert.equal(intSetting(undefined, 1, 20, 4), 4);
  assert.equal(intSetting(0, 1, 20, 4), 4);
  assert.equal(intSetting(2.5, 1, 20, 4), 4);
  assert.equal(intSetting("7", 1, 20, 4), 4);
});

test("wakeups: repeat, dated times, missed repeats move on", async () => {
  const W = await import("./wake.js");
  const n = new Date(2026, 10, 11, 10, 0).getTime();
  const a = W.addWake([], { target: "t1", every: "30m", text: "x" }, n);
  assert.equal(a.wake.due, n + 30 * 60000);
  assert.equal(W.addWake([], { target: "t1", every: "1m", text: "x" }, n).error, "Repeat at most every 5m");
  assert.equal(W.parseWhen("tomorrow 9:00", n), new Date(2026, 10, 12, 9, 0).getTime());
  assert.equal(W.parseWhen("2026-11-12 09:30", n), new Date(2026, 10, 12, 9, 30).getTime());
  assert.equal(W.parseWhen("2025-01-01 09:00", n), null);
  assert.equal(W.parseWhen("1d", n), n + 86400000);
  assert.equal(W.decide({ ...a.wake, due: n, expires: n + 1 }, "idle", n + 5).action, "skip");
  const r = W.reschedule(a.list, a.wake.id, "sent", n + 61 * 60000)[0];
  assert.deepEqual([r.due, r.status, r.count], [n + 90 * 60000, "scheduled", 1]);
  assert.equal(W.every(5400000), "90m");
});

test("wakeups: weekly 'at a time' schedule, name, edit, summary", async () => {
  const W = await import("./wake.js");
  const D = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi).getTime();
  const wed = D(2026, 10, 11, 10, 0); // Wed 2026-11-11 10:00
  const weekdays = [1, 2, 3, 4, 5];
  // same day later, same day already past, weekend skip, Sat->Mon wrap, Sun->Mon wrap
  assert.equal(W.nextAt({ time: "16:00", days: weekdays }, wed), D(2026, 10, 11, 16));
  assert.equal(W.nextAt({ time: "09:00", days: weekdays }, wed), D(2026, 10, 12, 9));
  assert.equal(W.nextAt({ time: "09:00", days: weekdays }, D(2026, 10, 13, 10)), D(2026, 10, 16, 9)); // Fri after 09:00 -> Mon
  assert.equal(W.nextAt({ time: "09:00", days: weekdays }, D(2026, 10, 14, 10)), D(2026, 10, 16, 9)); // Sat -> Mon
  assert.equal(W.nextAt({ time: "09:00", days: weekdays }, D(2026, 10, 15, 10)), D(2026, 10, 16, 9)); // Sun -> Mon
  assert.equal(W.nextAt({ time: "09:00", days: [0] }, D(2026, 10, 15, 10)), D(2026, 10, 22, 9)); // Sun after 09:00 -> next Sun
  assert.equal(W.nextAt({ time: "09:00", days: [1] }, D(2026, 10, 15, 10)), D(2026, 10, 16, 9)); // Sun -> Mon
  // the exact time is past: it moves to the next chosen day (strictly after)
  assert.equal(W.nextAt({ time: "10:00", days: [3] }, wed), D(2026, 10, 18, 10));
  // DST spring forward (US, 2026-03-08): 09:00 stays 09:00 local the next day
  const sat = D(2026, 2, 7, 12);
  const sun = W.nextAt({ time: "09:00", days: [0] }, sat);
  assert.deepEqual([new Date(sun).getDate(), new Date(sun).getHours()], [8, 9]);
  assert.equal(W.nextAt({ time: "09:00", days: [1] }, sun), D(2026, 2, 9, 9));
  // fall back (2026-11-01)
  const fall = W.nextAt({ time: "09:00", days: [0] }, D(2026, 9, 31, 12));
  assert.deepEqual([new Date(fall).getDate(), new Date(fall).getHours()], [1, 9]);
  // bad schedules
  assert.equal(W.nextAt({ time: "25:00", days: [1] }, wed), null);
  assert.equal(W.nextAt({ time: "09:00", days: [] }, wed), null);
  assert.equal(W.nextAt({ time: "09:00", days: [7] }, wed), null);

  const a = W.addWake([], { target: "T-ABC", name: " TZ-68 check ", text: "go", sched: { time: "16:00", days: weekdays } }, wed);
  assert.equal(a.wake.name, "TZ-68 check");
  assert.equal(a.wake.due, D(2026, 10, 11, 16));
  assert.equal(a.wake.every, null);
  assert.deepEqual(a.wake.sched, { time: "16:00", days: weekdays });
  assert.ok(W.addWake([], { target: "T-ABC", text: "go", sched: { time: "99:00", days: [1] } }, wed).error);
  assert.ok(W.addWake([], { target: "T-ABC", text: "go", sched: { time: "09:00", days: [] } }, wed).error);
  // after it was sent it moves to the next chosen day, and again
  const r = W.reschedule(a.list, a.wake.id, "sent", D(2026, 10, 11, 16, 1))[0];
  assert.deepEqual([r.due, r.status, r.count], [D(2026, 10, 12, 16), "scheduled", 1]);
  assert.deepEqual(r.sched, a.wake.sched); // the status stamp `at` must not overwrite the schedule
  assert.equal(r.at, D(2026, 10, 11, 16, 1));
  assert.deepEqual(W.setStatus([r], r.id, "sent", "x", 5)[0].sched, a.wake.sched);
  assert.equal(W.decide({ ...a.wake, due: wed, expires: wed + 1 }, "idle", wed + 5).action, "skip");
  assert.equal(W.decide(a.wake, "idle", a.wake.due).action, "send");
  // old wakeups still work: no name, no at
  const old = W.addWake([], { target: "t1", every: "30m", text: "x" }, wed);
  assert.equal(old.wake.sched ?? null, null);
  assert.equal(W.reschedule(old.list, old.wake.id, "s", wed + 31 * 60000)[0].due, wed + 60 * 60000);
  assert.equal(W.addWake([], { target: "t1", when: "15m", text: "x" }, wed).wake.due, wed + 15 * 60000);
  // edit keeps id, created, count; changes schedule; status goes back to scheduled; bad edit changes nothing
  const e = W.updateWake(a.list, a.wake.id, { target: "T-ABC", name: "n2", text: "new", every: "15m", enabled: false }, wed);
  assert.equal(e.list.length, 1);
  assert.deepEqual([e.wake.id, e.wake.created, e.wake.name, e.wake.text, e.wake.every, e.wake.sched ?? null, e.wake.enabled, e.wake.due, e.wake.status],
    [a.wake.id, a.wake.created, "n2", "new", 15 * 60000, null, false, wed + 15 * 60000, "scheduled"]);
  assert.ok(W.updateWake(a.list, a.wake.id, { target: "T-ABC", text: " " }, wed).error);
  assert.ok(W.updateWake(a.list, "nope", { target: "T-ABC", text: "x", when: "15m" }, wed).error);
  // a wakeup that is being sent cannot be edited: its pending send would overwrite the edit
  const sending = W.setStatus(a.list, a.wake.id, "sending", null, wed);
  assert.equal(W.updateWake(sending, a.wake.id, { target: "T-ABC", text: "new", when: "1h" }, wed).error, "It is sending now: save again in a moment");
  // summary
  assert.equal(W.summary(a.wake), "Weekdays at 16:00");
  assert.equal(W.summary({ ...a.wake, sched: { time: "9:05", days: [0, 1, 2, 3, 4, 5, 6] } }), "Every day at 09:05");
  assert.equal(W.summary({ ...a.wake, sched: { time: "10:00", days: [6, 0] } }), "Weekends at 10:00");
  assert.equal(W.summary({ ...a.wake, sched: { time: "10:00", days: [1, 3] } }), "Mo, We at 10:00");
  assert.equal(W.summary(old.wake), "Every 30m");
  assert.match(W.summary(W.addWake([], { target: "t1", when: "2026-11-12 09:30", text: "x" }, wed).wake), /^Once, /);
});

test("a pasted image becomes a unique file name and a markdown line at the end of the description", () => {
  assert.match(imageName(1700000000000), /^img-\d+-[a-z0-9]+\.png$/);
  assert.notEqual(imageName(1), imageName(1));
  assert.equal(appendImage("", "/a/b.png"), "![image](</a/b.png>)");
  assert.equal(appendImage("Fix it", "/a/b.png"), "Fix it\n![image](</a/b.png>)");
  assert.equal(appendImage("", "/a b/(c).png"), "![image](</a b/(c).png>)");
  assert.equal(appendImage("Fix it\n", "/a/b.png"), "Fix it\n![image](</a/b.png>)");
});

test("a request name applies once; a 2nd sight is not fresh", () => {
  const a = firstSight(undefined, "r1.json");
  assert.equal(a.fresh, true);
  assert.equal(firstSight(a.seen, "r1.json").fresh, false);
  assert.equal(firstSight(a.seen, "r2.json").fresh, true);
  assert.equal(firstSight(Array.from({ length: 300 }, (_, i) => String(i)), "x").seen.length, 200);
});

test("archive command archives a task; unknown id errors", () => {
  const { tasks, task } = add([], { title: "x" });
  assert.equal(applyCommand(tasks, { op: "archive", id: task.id }).task.archived, true);
  assert.ok(applyCommand(tasks, { op: "archive", id: "T-NOPE" }).error);
});

test("the todo column and group show the label Ready; the id stays todo", () => {
  assert.deepEqual(COLUMNS.find(([id]) => id === "todo"), ["todo", "Ready"]);
  assert.deepEqual(GROUPS.find(([id]) => id === "todo"), ["todo", "Ready"]);
});

test("imageLines lists image paths in a description, relative to the app home when under it", () => {
  const d = "Fix it\n![image](</h/drover-tasks/images/a.png>)\ntext\n![image](</o/b c/(d).png>)\n![alt](<rel.png>) ![image](</h/x.png>)";
  assert.deepEqual(imageLines(d, "/h"), ["drover-tasks/images/a.png", "/o/b c/(d).png", "rel.png", "x.png"]);
  assert.deepEqual(imageLines("", "/h"), []);
  assert.deepEqual(imageLines("no images [x](<y>)", "/h"), []);
  assert.deepEqual(imageLines(appendImage("t", "/h/i/a.png"), "/h"), ["i/a.png"]);
});

test("staleImages lists only this session's pasted files that no saved description links", () => {
  const h = "/h", a = "/h/drover-tasks/images/a.png", b = "/h/drover-tasks/images/b.png";
  assert.deepEqual(staleImages([a, b], [appendImage("t", a)], h), [b]);
  assert.deepEqual(staleImages([a, b], [], h), [a, b]);
  assert.deepEqual(staleImages([a, b], ["x", appendImage("", a), appendImage("", b)], h), []);
  assert.deepEqual(staleImages([], [appendImage("t", a)], h), []);
  // A link in another task (even archived) keeps the file; a file this session did not paste is never listed.
  assert.deepEqual(staleImages([a], ["![image](</h/drover-tasks/images/other.png>)"], h), [a]);
  // A home-relative link is the same file as the absolute path.
  assert.deepEqual(staleImages([a, b], ["![image](<drover-tasks/images/a.png>)"], h), [b]);
});

test("reorder: drag within a column and across columns; sorted honours order", async () => {
  const { reorder, sorted } = await import("./store.js");
  let t = [];
  for (const [n, c] of [["a", "todo"], ["b", "todo"], ["c", "todo"], ["x", "doing"]]) t = add(t, { title: n, column: c }, n.charCodeAt(0)).tasks;
  const id = (n) => t.find((k) => k.title === n).id;
  const col = (c) => sorted(t.filter((k) => k.column === c)).map((k) => k.title).join("");
  assert.equal(col("todo"), "abc");
  t = reorder(t, id("c"), "todo", id("a"), 9).tasks; // c before a
  assert.equal(col("todo"), "cab");
  t = reorder(t, id("c"), "todo", null, 9).tasks; // c to the end
  assert.equal(col("todo"), "abc");
  t = reorder(t, id("b"), "doing", id("x"), 9).tasks; // b into doing, before x
  assert.equal(col("doing"), "bx");
  assert.equal(col("todo"), "ac");
  const n = add(t, { title: "n", column: "doing" }, 99).tasks; // new card without order goes last
  assert.equal(sorted(n.filter((k) => k.column === "doing")).map((k) => k.title).join(""), "bxn");
  assert.ok(reorder(t, "nope", "todo", null).error);
  assert.ok(reorder(t, id("a"), "nowhere", null).error);
});

test("a column change by update, shift or applyCommand clears order; same column keeps it", async () => {
  const { reorder } = await import("./store.js");
  let t = add([], { title: "a", column: "todo" }, 1).tasks;
  t = reorder(t, t[0].id, "todo", null).tasks;
  assert.equal(t[0].order, 0);
  assert.equal(update(t, t[0].id, { title: "b" }).task.order, 0);
  assert.equal(update(t, t[0].id, { column: "doing" }).task.order, undefined);
  assert.equal(shift(t, t[0].id, 1).task.order, undefined);
  assert.equal(applyCommand(t, { op: "move", id: t[0].id, column: "review" }).task.order, undefined);
});

test("a card that leaves doing for backlog or todo drops its agent and run (CLI, shift, drag)", () => {
  const seed = add([], { title: "x", column: "doing" }, 1).tasks.map((t) => ({ ...t, agent: "t9", run: "R-1" }));
  const doing = () => seed, id = seed[0].id;
  const gone = (r) => { assert.equal(r.tasks[0].agent, null); assert.equal(r.tasks[0].run, null); };
  gone(applyCommand(doing(), { op: "move", id, column: "backlog" }, 2));
  gone(applyCommand(doing(), { op: "move", id, column: "todo" }, 2));
  gone(shift(doing(), id, -2, 2));
  gone(reorder(doing(), id, "backlog", null, 2));
  // review and done keep the agent
  assert.equal(applyCommand(doing(), { op: "move", id, column: "review" }, 2).tasks[0].agent, "t9");
  // a card that stays in doing keeps it
  assert.equal(update(doing(), id, { title: "y" }, 2).tasks[0].agent, "t9");
});

test("a claiming card moved out of doing keeps its claim (C1: no 2nd run)", () => {
  const seed = add([], { title: "x", column: "doing" }, 1).tasks.map((t) => ({ ...t, agent: CLAIMING, claimedAt: 5 }));
  const id = seed[0].id;
  for (const r of [applyCommand(seed, { op: "move", id, column: "todo" }, 2), shift(seed, id, -1, 2), reorder(seed, id, "backlog", null, 2)]) {
    assert.equal(r.tasks[0].agent, CLAIMING);
    assert.equal(r.tasks[0].claimedAt, 5);
  }
});

test("wakeOrder: open by due, ended newest first", async () => {
  const { wakeOrder } = await import("./wake.js");
  const w = (id, status, due, at, created = 1) => ({ id, status, due, at, created });
  const ids = [w("e1", "done", 0, 100), w("o2", "scheduled", 20), w("e3", "done", 0, 300), w("o1", "scheduled", 10), w("e2", "done", 0, undefined, 200)]
    .sort(wakeOrder).map((x) => x.id);
  assert.deepEqual(ids.filter((i) => i[0] === "o"), ["o1", "o2"]);
  assert.deepEqual(ids.filter((i) => i[0] === "e"), ["e3", "e2", "e1"]);
});

test("drover edit refuses an empty or blank title and keeps the task", () => {
  const { tasks, task } = add([], { title: "Keep me" }, 1);
  for (const title of ["", "   ", "\t\n"]) {
    const r = applyCommand(tasks, { op: "edit", id: task.id, title }, 2);
    assert.equal(r.error, "Title is required");
    assert.equal(r.tasks, undefined);
  }
  assert.equal(applyCommand(tasks, { op: "edit", id: task.id, title: " New " }, 2).task.title, "New");
  assert.equal(applyCommand(tasks, { op: "edit", id: task.id, desc: "" }, 2).task.title, "Keep me");
});

test("move to done: owner and a live Drover may; a squad agent may not", () => {
  const { tasks, task } = add([], { title: "x" });
  const mv = (extra) => applyCommand(tasks, { op: "move", id: task.id, column: "done", ...extra });
  assert.equal(mv({}).task.column, "done"); // owner: no from
  assert.equal(mv({ from: "t81", fromDrover: true }).task.column, "done"); // live Drover terminal
  assert.match(mv({ from: "t5" }).error, /Only the owner moves a card to done/); // squad terminal
  assert.match(mv({ from: "t81", fromDrover: false }).error, /Only the owner/); // dead or unknown Drover address
});

test("editor menu helpers: priority labels, status icons, project filter", () => {
  assert.deepEqual(["P0", "P1", "P2", "P3"].map((p) => PRIORITY_LABEL[p]), ["Urgent", "High", "Medium", "Low"]);
  for (const [id] of COLUMNS) assert.ok(STATUS_ICON[id]?.icon && STATUS_ICON[id]?.tone, id);
  assert.equal(Object.keys(STATUS_ICON).length, COLUMNS.length);
  const ps = [{ id: "p1", name: "Blueprint UI" }, { id: "p2", name: "Drover" }];
  assert.deepEqual(filterProjects(ps, "  BLUE ").map((p) => p.id), ["p1"]);
  assert.deepEqual(filterProjects(ps, "").map((p) => p.id), ["p1", "p2"]);
  assert.deepEqual(filterProjects(ps, "p2").map((p) => p.id), ["p2"]);
  assert.deepEqual(filterProjects(ps, "zzz"), []);
});

test("nextIndex: arrows wrap, empty list stays 0", () => {
  assert.equal(nextIndex(0, 3, "down"), 1);
  assert.equal(nextIndex(2, 3, "down"), 0);
  assert.equal(nextIndex(0, 3, "up"), 2);
  assert.equal(nextIndex(1, 3, "up"), 0);
  assert.equal(nextIndex(0, 0, "down"), 0);
  assert.equal(nextIndex(5, 3, "down"), 0);
});

test("canCreate: a title with a non-space character", () => {
  assert.equal(canCreate("Fix it"), true);
  assert.equal(canCreate("  x "), true);
  assert.equal(canCreate(""), false);
  assert.equal(canCreate("   \n"), false);
  assert.equal(canCreate(undefined), false);
});

test("isSubmitKey: Cmd+Enter only", () => {
  assert.equal(isSubmitKey({ key: "enter", modifiers: { platform: true } }), true);
  assert.equal(isSubmitKey({ key: "enter", modifiers: { platform: false } }), false);
  assert.equal(isSubmitKey({ key: "a", modifiers: { platform: true } }), false);
  assert.equal(isSubmitKey({ key: "enter" }), false);
});

test("allTags: unique tags of all tasks, sorted", () => {
  assert.deepEqual(allTags([{ tags: ["ui", "bug"] }, { tags: ["bug"] }, {}]), ["bug", "ui"]);
  assert.deepEqual(allTags([]), []);
});

test("toggleTag adds a missing tag and removes a present one", () => {
  assert.deepEqual(toggleTag(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleTag(["a", "b"], "a"), ["b"]);
});

test("newTag: normalized text that is new, else null", () => {
  assert.equal(newTag(" #Auth ", ["bug"]), "auth");
  assert.equal(newTag("bug", ["bug"]), null);
  assert.equal(newTag("BUG", ["bug"]), null);
  assert.equal(newTag("  ", []), null);
  assert.equal(newTag("a,b", []), null);
});

test("runnerChoices: squads first, then agents, with the picker's names", () => {
  const cfg = { agents: [{ id: "a1", name: "Opus dev", command: "claude" }, { id: "a2", name: "Rev", command: "codex" }],
    squads: [{ id: "s1", name: "Pair", leader: "a1", members: [{ agent: "a2", role: "r" }, { agent: "gone", role: "x" }] }] };
  assert.deepEqual(runnerChoices(cfg), [
    { kind: "squad", id: "s1", name: "Pair", detail: "Opus dev + Rev + gone" },
    { kind: "agent", id: "a1", name: "Opus dev", detail: "claude" },
    { kind: "agent", id: "a2", name: "Rev", detail: "codex" },
  ]);
  assert.deepEqual(runnerChoices({ agents: [], squads: [] }), []);
});

test("startHint names the assignee", () => {
  assert.equal(startHint("Pair"), "Pair will start working right after creation.");
});

test("canCreateAgent: a prompt needs text", () => {
  assert.equal(canCreateAgent("Create a card"), true);
  assert.equal(canCreateAgent("  \n "), false);
  assert.equal(canCreateAgent(""), false);
  assert.equal(canCreateAgent(undefined), false);
});

test("agentChoices: agents only, no squads", () => {
  const cfg = { agents: [{ id: "a1", name: "Opus dev", command: "claude" }], squads: [{ id: "s1", name: "Pair", leader: "a1", members: [] }] };
  assert.deepEqual(agentChoices(cfg).map((c) => [c.kind, c.id]), [["agent", "a1"]]);
});

test("agentChoices: the coordinator agent (drover) is not offered", () => {
  const cfg = { agents: [{ id: "drover", name: "Drover", command: "claude" }, { id: "a1", name: "Dev", command: "claude" }], squads: [] };
  assert.deepEqual(agentChoices(cfg).map((c) => c.id), ["a1"]);
});

test("createSize: normal 720x520, large 0.9x0.85 of the window", () => {
  assert.deepEqual(createSize(false), { width: 720, height: 520 });
  assert.deepEqual(createSize(true), { width: 0.9, height: 0.85 });
});

test("packDraft/unpackDraft: the draft survives the round trip", () => {
  const d = { mode: "agent", title: "T", desc: "D", prompt: "P", column: "doing", priority: "P1", labels: ["a", "b"], assignee: { kind: "squad", id: "s1" }, runner: "a2", project: "p9", another: true, pasted: ["/x/1.png"], note: "n" };
  assert.deepEqual(unpackDraft(JSON.parse(JSON.stringify(packDraft(d)))), d);
});

test("packDraft drops unknown keys; unpackDraft fills defaults and rejects bad types", () => {
  assert.deepEqual(Object.keys(packDraft({ title: "T", junk: 1 })), ["title"]);
  assert.equal(unpackDraft(undefined), null);
  assert.equal(unpackDraft("x"), null);
  const d = unpackDraft({ mode: "weird", title: 5, labels: "a", pasted: [1, "/f.png"], another: "yes", assignee: { kind: "agent" } });
  assert.deepEqual(d, { mode: "manual", title: "", desc: "", prompt: "", labels: [], pasted: ["/f.png"], another: false, assignee: null, note: "" });
});

test("Blocked is a real column between Review and Done", () => {
  assert.deepEqual(COLUMNS.map(([id]) => id), ["backlog", "todo", "doing", "review", "blocked", "done"]);
  assert.deepEqual(COLUMNS.find(([id]) => id === "blocked"), ["blocked", "Blocked"]);
  assert.equal(STATUS_ICON.blocked.tone, "blocked");
  const { tasks, task } = add([], { title: "x", column: "review" }, 1);
  assert.equal(shift(tasks, task.id, 1, 2).task.column, "blocked");
  assert.equal(shift(shift(tasks, task.id, 1, 2).tasks, task.id, 1, 3).task.column, "done");
  assert.equal(applyCommand(tasks, { op: "move", id: task.id, column: "blocked" }, 2).task.column, "blocked");
  assert.equal(reorder(tasks, task.id, "blocked", null, 2).tasks[0].column, "blocked");
});

test("a blocked card keeps its agent and shows as Blocked in the Needs you group", () => {
  const seed = add([], { title: "x", column: "doing" }, 1).tasks.map((t) => ({ ...t, agent: "t9", run: "R-1" }));
  const id = seed[0].id;
  assert.equal(applyCommand(seed, { op: "move", id, column: "blocked" }, 2).tasks[0].agent, "t9");
  const blocked = { column: "blocked", agent: "t9", archived: false };
  const at = attention(blocked, new Map([["t9", { status: "working" }]]));
  assert.deepEqual(at, { group: "needs", reason: "Blocked" });
  assert.deepEqual(attention({ ...blocked, agent: null }, new Map()), { group: "needs", reason: "Blocked" });
});

test("updatedAgo: relative time like 'Updated 15h ago'", () => {
  const now = 10_000_000_000;
  const ago = (ms) => updatedAgo(now - ms, now);
  assert.equal(ago(0), "Updated just now");
  assert.equal(ago(59_000), "Updated just now");
  assert.equal(ago(5 * 60_000), "Updated 5m ago");
  assert.equal(ago(15 * 3_600_000), "Updated 15h ago");
  assert.equal(ago(7 * 86_400_000 + 1000), "Updated 7d ago");
  assert.equal(updatedAgo(now + 5000, now), "Updated just now"); // clock skew
  assert.equal(updatedAgo(undefined, now), "");
});

test("clampText: cuts at a word with an ellipsis, leaves short text alone", () => {
  assert.equal(clampText("short title", 20), "short title");
  assert.equal(clampText("  spaced   out  ", 20), "spaced out");
  const out = clampText("Connected Pairstone Epic F: Map and visuals today", 30);
  assert.ok(out.endsWith("…") && out.length <= 30, out);
  assert.equal(out, "Connected Pairstone Epic F:…");
  assert.equal(clampText("Supercalifragilisticexpialidocious", 10), "Supercali…");
  assert.equal(clampText(undefined, 10), "");
});

test("sortCards: manual keeps the board order, priority and newest re-sort a copy", () => {
  const c = (id, priority, created, order) => ({ id, priority, created, ...(order === undefined ? {} : { order }) });
  const cards = [c("a", "P2", 1, 0), c("b", "P0", 2, 1), c("c", "P1", 3, 2)];
  const ids = (l) => l.map((x) => x.id).join("");
  assert.equal(ids(sortCards(cards, "manual")), "abc");
  assert.equal(ids(sortCards(cards, "priority")), "bca");
  assert.equal(ids(sortCards(cards, "newest")), "cba");
  assert.equal(ids(sortCards(cards, "bogus")), "abc");
  assert.equal(ids(cards), "abc"); // input not mutated
});

test("archiveDone archives only done cards that are not archived yet, never others", () => {
  const mk = (title, column, extra = {}) => ({ ...add([], { title, column }, 1).task, ...extra });
  const tasks = [mk("d1", "done"), mk("d2", "done", { archived: true, updated: 5 }), mk("b", "blocked"), mk("r", "review"), mk("t", "todo")];
  tasks.forEach((t, i) => { t.id = `T-${i}`; });
  const r = archiveDone(tasks, 99);
  assert.equal(r.count, 1);
  assert.deepEqual(r.tasks.map((t) => !!t.archived), [true, true, false, false, false]);
  assert.equal(r.tasks[0].updated, 99);
  assert.equal(r.tasks[1].updated, 5); // already archived: untouched
  assert.deepEqual(r.tasks.slice(2), tasks.slice(2)); // non-done cards identical
  assert.equal(archiveDone(r.tasks, 100).count, 0);
});

test("inScope: All issues, agent, no agent, P0-P1 and per-project presets", () => {
  const projects = [{ id: "pr1", name: "Alpha" }];
  const t = (extra) => ({ priority: "P2", agent: null, ...extra });
  assert.ok(inScope(t(), "all", projects));
  assert.ok(inScope(t(), undefined, projects));
  assert.ok(inScope(t({ agent: "t3" }), "agent", projects) && !inScope(t(), "agent", projects));
  assert.ok(inScope(t(), "noagent", projects) && !inScope(t({ agent: "t3" }), "noagent", projects));
  assert.ok(inScope(t({ priority: "P0" }), "p01", projects) && inScope(t({ priority: "P1" }), "p01", projects));
  assert.ok(!inScope(t({ priority: "P2" }), "p01", projects) && !inScope(t({ priority: "P3" }), "p01", projects));
  assert.ok(inScope(t({ project: "pr1" }), "project:pr1", projects) && !inScope(t({ project: "pr2" }), "project:pr1", projects) && !inScope(t(), "project:pr1", projects));
  assert.ok(inScope(t(), "project:gone", projects)); // a deleted project falls back to all
  assert.deepEqual(SCOPES.map(([id]) => id), ["all", "agent", "noagent", "p01"]);
});

test("checklistProgress counts markdown task lines, not code fences", () => {
  assert.deepEqual(checklistProgress(""), { done: 0, total: 0 });
  assert.deepEqual(checklistProgress(undefined), { done: 0, total: 0 });
  assert.deepEqual(checklistProgress("just text\n- plain bullet\n- [] not a task"), { done: 0, total: 0 });
  assert.deepEqual(checklistProgress("- [ ] a\n- [x] b\n* [X] c\n  - [ ] nested\n\t- [x] tab"), { done: 3, total: 5 });
  assert.deepEqual(checklistProgress("- [x] real\n```\n- [ ] in fence\n- [x] too\n```\n- [ ] after"), { done: 1, total: 2 });
  assert.deepEqual(checklistProgress("~~~\n- [x] tilde fence\n~~~\n1. [x] numbered"), { done: 0, total: 0 });
});

test("ringGlyph picks a quarter ring by fraction done", () => {
  assert.equal(ringGlyph(0, 4), "○");
  assert.equal(ringGlyph(1, 4), "◔");
  assert.equal(ringGlyph(2, 4), "◑");
  assert.equal(ringGlyph(3, 4), "◕");
  assert.equal(ringGlyph(4, 4), "●");
  assert.equal(ringGlyph(1, 10), "○"); // 10% still rounds down to empty
  assert.equal(ringGlyph(0, 0), "○");
  assert.equal(ringGlyph(9, 4), "●"); // clamped
});

test("archiveDone with ids archives exactly those done cards (scoped confirm)", () => {
  const mk = (id, column, project, extra = {}) => ({ ...add([], { title: id, column }, 1).task, id, project, ...extra });
  const tasks = [mk("A", "done", "pa"), mk("B", "done", "pb"), mk("C", "review", "pa"), mk("D", "done", "pa", { archived: true })];
  const r = archiveDone(tasks, 50, ["A", "C", "D", "NOPE"]); // C is not done, D already archived
  assert.equal(r.count, 1);
  assert.deepEqual(r.tasks.map((t) => !!t.archived), [true, false, false, true]);
  assert.deepEqual(archiveDone(tasks, 50, []).tasks, tasks); // an empty id list archives nothing
  assert.equal(archiveDone(tasks, 50).count, 2); // no ids: every done card, as before
  // a project scope: the visible Done cards are only A; B stays
  const visible = tasks.filter((t) => inScope(t, "project:pa", [{ id: "pa" }, { id: "pb" }]) && t.column === "done" && !t.archived).map((t) => t.id);
  assert.deepEqual(archiveDone(tasks, 50, visible).tasks.map((t) => !!t.archived), [true, false, false, true]);
});

test("checklistProgress: a longer fence is closed only by a same-char fence at least as long", () => {
  const nested = "````markdown\n```js\n- [x] sample\n```\n- [x] still sample\n````\n- [ ] actual";
  assert.deepEqual(checklistProgress(nested), { done: 0, total: 1 });
  assert.deepEqual(checklistProgress("~~~\n```\n- [x] a\n~~~\n- [ ] b"), { done: 0, total: 1 }); // ``` does not close ~~~
  assert.deepEqual(checklistProgress("```\n- [x] a\n``` trailing\n- [x] b\n```\n- [ ] c"), { done: 0, total: 1 }); // text after fence: not a closer
});

test("menuChange: one open popover at a time; a stale close never shuts another", () => {
  assert.equal(menuChange(null, "col:done", true), "col:done");
  assert.equal(menuChange("col:done", "scope", true), "scope"); // opening one closes the other
  assert.equal(menuChange("scope", "col:done", false), "scope"); // late close of the old one is ignored
  assert.equal(menuChange("scope", "scope", false), null);
  assert.equal(menuChange(null, "scope", false), null);
});

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 12, 15, 0, 0).getTime(); // 12 Nov 2026 15:00 local
const fctx = (extra = {}) => ({
  now: NOW,
  projects: [{ id: "pa", name: "Alpha" }, { id: "pb", name: "Beta" }],
  runs: [{ terminals: [{ address: "t9", name: "Astra" }] }],
  agentsByAddress: new Map([["t9", { status: "working" }], ["t4", { status: "idle" }]]),
  tasks: [],
  ...extra,
});
const ft = (extra) => ({ id: "T-1", column: "todo", priority: "P2", tags: [], agent: null, project: null, source: null, created: NOW - 40 * DAY, updated: NOW - 40 * DAY, ...extra });

test("filter state: toggleFilter adds/removes, empty fields vanish, input never mutated", () => {
  const a = toggleFilter({}, "priority", "P0");
  assert.deepEqual(a, { priority: ["P0"] });
  const b = toggleFilter(a, "priority", "P1");
  assert.deepEqual(b, { priority: ["P0", "P1"] });
  assert.deepEqual(a, { priority: ["P0"] });
  assert.deepEqual(toggleFilter(b, "priority", "P0"), { priority: ["P1"] });
  assert.deepEqual(toggleFilter(a, "priority", "P0"), {});
  assert.deepEqual(clearFilters(), {});
  assert.deepEqual(clearFilters({ priority: ["P0"], label: ["x"] }, "priority"), { label: ["x"] });
  assert.deepEqual(clearFilters({ priority: ["P0"] }, "nope"), { priority: ["P0"] });
});

test("matchesFilter: empty state matches all; OR within a field, AND across fields", () => {
  const c = fctx();
  assert.ok(matchesFilter(ft(), {}, c));
  assert.ok(matchesFilter(ft({ priority: "P1" }), { priority: ["P0", "P1"] }, c));
  assert.ok(!matchesFilter(ft({ priority: "P3" }), { priority: ["P0", "P1"] }, c));
  const st = { priority: ["P0"], status: ["todo", "doing"] };
  assert.ok(matchesFilter(ft({ priority: "P0", column: "doing" }), st, c));
  assert.ok(!matchesFilter(ft({ priority: "P0", column: "done" }), st, c)); // AND across fields
  assert.ok(!matchesFilter(ft({ priority: "P1", column: "todo" }), st, c));
});

test("matchesFilter: agent status, assignee, project, label, source", () => {
  const c = fctx();
  assert.ok(matchesFilter(ft({ agent: "t9" }), { agentStatus: ["working"] }, c));
  assert.ok(!matchesFilter(ft({ agent: "t4" }), { agentStatus: ["working"] }, c));
  assert.ok(matchesFilter(ft({ agent: "t4" }), { agentStatus: ["working", "idle"] }, c));
  assert.ok(matchesFilter(ft(), { agentStatus: ["none"] }, c));
  assert.ok(!matchesFilter(ft({ agent: "t9" }), { agentStatus: ["none"] }, c));
  assert.ok(!matchesFilter(ft({ agent: "t77" }), { agentStatus: ["working", "idle", "blocked", "done", "none"] }, c)); // a gone agent has no status
  // assignee: task.assignee wins, else the live agent address, else Unassigned
  assert.ok(matchesFilter(ft({ assignee: { kind: "squad", id: "cattle" } }), { assignee: ["squad:cattle"] }, c));
  assert.ok(!matchesFilter(ft({ assignee: { kind: "squad", id: "cattle" } }), { assignee: ["agent:cattle"] }, c)); // kind matters
  assert.ok(matchesFilter(ft({ assignee: { kind: "agent", id: "claude" }, agent: "t9" }), { assignee: ["agent:claude"] }, c));
  assert.ok(!matchesFilter(ft({ assignee: { kind: "agent", id: "claude" }, agent: "t9" }), { assignee: ["live:t9"] }, c)); // assignee wins over the live address
  assert.ok(matchesFilter(ft({ agent: "t9" }), { assignee: ["live:t9"] }, c) && !matchesFilter(ft(), { assignee: ["live:t9"] }, c));
  assert.ok(matchesFilter(ft(), { assignee: ["none"] }, c) && !matchesFilter(ft({ agent: "t9" }), { assignee: ["none"] }, c) && !matchesFilter(ft({ assignee: { kind: "agent", id: "x" } }), { assignee: ["none"] }, c));
  assert.ok(matchesFilter(ft({ agent: "t9" }), { assignee: ["none", "live:t9"] }, c)); // OR within the field
  assert.ok(matchesFilter(ft({ project: "pa" }), { project: ["pa", "pb"] }, c) && !matchesFilter(ft(), { project: ["pa"] }, c));
  assert.ok(matchesFilter(ft({ tags: ["ui", "x"] }), { label: ["ui"] }, c) && !matchesFilter(ft({ tags: ["x"] }), { label: ["ui"] }, c));
  assert.ok(matchesFilter(ft({ source: { kind: "github" } }), { source: ["github"] }, c));
  assert.ok(matchesFilter(ft(), { source: ["manual"] }, c) && !matchesFilter(ft({ source: { kind: "jira" } }), { source: ["manual"] }, c));
  assert.ok(!matchesFilter(ft({ tags: undefined }), { label: ["ui"] }, c));
});

test("matchesFilter: date windows (created|updated x today|7d|30d)", () => {
  const c = fctx();
  const startOfToday = new Date(2026, 10, 12).getTime();
  assert.ok(matchesFilter(ft({ created: startOfToday }), { date: ["created:today"] }, c));
  assert.ok(!matchesFilter(ft({ created: startOfToday - 1 }), { date: ["created:today"] }, c));
  assert.ok(matchesFilter(ft({ updated: NOW - 6 * DAY }), { date: ["updated:7d"] }, c));
  assert.ok(!matchesFilter(ft({ updated: NOW - 8 * DAY }), { date: ["updated:7d"] }, c));
  assert.ok(matchesFilter(ft({ created: NOW - 29 * DAY }), { date: ["created:30d"] }, c));
  assert.ok(!matchesFilter(ft({ created: NOW - 31 * DAY }), { date: ["created:30d"] }, c));
  assert.ok(!matchesFilter(ft({ created: NOW - 5 * DAY }), { date: ["updated:7d"] }, c)); // created recently, updated long ago
  assert.ok(matchesFilter(ft({ created: NOW - 5 * DAY }), { date: ["updated:7d", "created:7d"] }, c)); // OR within the field
  assert.ok(!matchesFilter(ft({ updated: undefined }), { date: ["updated:today"] }, c));
});

test("filterValues lists each field's choices", () => {
  const tasks = [ft({ agent: "t9", tags: ["ui", "api"], project: "pa" }), ft({ tags: ["ui"], agent: "t4" }), ft({ assignee: { kind: "squad", id: "cattle" } }), ft({ assignee: { kind: "agent", id: "ghost" } })];
  const c = fctx({ tasks, config: { squads: [{ id: "cattle", name: "Cattle Drive" }], agents: [] } });
  assert.deepEqual(FILTER_FIELDS.map(([id]) => id), ["status", "agentStatus", "priority", "date", "assignee", "project", "label", "source"]);
  assert.deepEqual(filterValues("status", c).map((v) => v.value), ["backlog", "todo", "doing", "review", "blocked", "done"]);
  assert.equal(filterValues("status", c).find((v) => v.value === "todo").label, "Ready");
  assert.deepEqual(filterValues("agentStatus", c).map((v) => v.value), ["working", "idle", "blocked", "done", "none"]);
  assert.deepEqual(filterValues("priority", c).map((v) => v.value), ["P0", "P1", "P2", "P3"]);
  assert.equal(filterValues("date", c).length, 6);
  assert.deepEqual(filterValues("date", c)[0], { value: "created:today", label: "Created today" });
  // Saved assignees by name (id when the config lacks it), then live agents by run name (else address), then Unassigned last
  assert.deepEqual(filterValues("assignee", c), [
    { value: "squad:cattle", label: "Cattle Drive" },
    { value: "agent:ghost", label: "ghost" },
    { value: "live:t9", label: "Astra" },
    { value: "live:t4", label: "t4" },
    { value: "none", label: "Unassigned" },
  ]);
  assert.deepEqual(filterValues("assignee", fctx()).map((v) => v.value), ["none"]);
  assert.deepEqual(filterValues("project", c).map((v) => v.label), ["Alpha", "Beta"]);
  assert.deepEqual(filterValues("label", c).map((v) => v.value), ["api", "ui"]);
  assert.deepEqual(filterValues("source", c).map((v) => v.value), ["github", "jira", "manual"]);
});

test("searchFilters narrows field rows and values; filterChips describes active filters", () => {
  const c = fctx({ tasks: [ft({ tags: ["ui"], project: "pa" })] });
  assert.equal(searchFilters("", c).fields.length, FILTER_FIELDS.length);
  assert.deepEqual(searchFilters("", c).values, []);
  assert.deepEqual(searchFilters("prio", c).fields.map(([id]) => id), ["priority"]);
  const r = searchFilters("alp", c);
  assert.deepEqual(r.fields, []);
  assert.deepEqual(r.values, [{ field: "project", fieldLabel: "Project", value: "pa", label: "Alpha" }]);
  assert.ok(searchFilters("P0", c).values.some((v) => v.field === "priority" && v.value === "P0"));
  assert.deepEqual(filterChips({ priority: ["P0"], project: ["pa", "gone"] }, c).map((x) => `${x.fieldLabel}: ${x.label}`), ["Priority: P0 Urgent", "Project: Alpha", "Project: gone"]);
  assert.deepEqual(filterChips({}, c), []);
});

test("assignee persists on the saved card; bad shapes are dropped; old tasks stay valid", () => {
  const a = add([], { title: "T", assignee: { kind: "squad", id: "cattle" } }, 1);
  assert.deepEqual(a.task.assignee, { kind: "squad", id: "cattle" });
  assert.equal(assigneeKey(a.task), "squad:cattle");
  // kept through edit, move and start (agent set)
  const e = update(a.tasks, a.task.id, { title: "T2" }, 2);
  assert.deepEqual(e.task.assignee, { kind: "squad", id: "cattle" });
  assert.deepEqual(shift(e.tasks, a.task.id, 1, 3).task.assignee, { kind: "squad", id: "cattle" });
  assert.deepEqual(reorder(e.tasks, a.task.id, "doing", null, 4).task.assignee, { kind: "squad", id: "cattle" });
  assert.deepEqual(update(e.tasks, a.task.id, { agent: "t9", column: "doing" }, 5).task.assignee, { kind: "squad", id: "cattle" });
  // change and clear
  assert.deepEqual(update(a.tasks, a.task.id, { assignee: { kind: "agent", id: "claude" } }, 2).task.assignee, { kind: "agent", id: "claude" });
  assert.equal(update(a.tasks, a.task.id, { assignee: null }, 2).task.assignee, null);
  // bad shapes
  for (const bad of [{ kind: "user", id: "x" }, { kind: "squad" }, { kind: "squad", id: "" }, { kind: 1, id: "x" }, "squad:x", [], 5, undefined])
    assert.equal(validate({ title: "T", assignee: bad }).value.assignee, null, JSON.stringify(bad));
  assert.equal(update(a.tasks, a.task.id, { assignee: { kind: "bogus", id: "x" } }, 2).task.assignee, null);
  // old task without assignee stays valid
  const old = { id: "T-OLD", title: "Old", desc: "", priority: "P2", tags: [], column: "todo", archived: false, agent: null, notes: [], created: 1, updated: 1 };
  assert.equal(update([old], "T-OLD", { title: "New" }, 2).task.assignee, null);
  assert.equal(assigneeKey(old), "none");
  assert.equal(assigneeKey({ ...old, agent: "t9" }), "live:t9");
  assert.equal(assigneeKey({ ...old, assignee: { kind: "squad", id: "s" }, agent: "t9" }), "squad:s"); // saved wins over live
});

test("assigneeText names a saved assignee from the config", () => {
  const cfg = { squads: [{ id: "cattle", name: "Cattle Drive" }], agents: [{ id: "claude", name: "Claude" }] };
  assert.equal(assigneeText({ kind: "squad", id: "cattle" }, cfg), "Cattle Drive");
  assert.equal(assigneeText({ kind: "agent", id: "claude" }, cfg), "Claude");
  assert.equal(assigneeText({ kind: "agent", id: "gone" }, cfg), "gone");
  assert.equal(assigneeText(null, cfg), "");
});

test("editSize: small 720x520, large 0.9x0.85 (same as createSize)", () => {
  assert.deepEqual(editSize(false), { width: 720, height: 520 });
  assert.deepEqual(editSize(true), { width: 0.9, height: 0.85 });
});

const seedT = () => add([], { title: "T", desc: "d", priority: "P1", tags: ["a"], column: "doing", assignee: { kind: "agent", id: "x" }, project: "p1" }, 1);

test("saveText writes only title and desc; every other field stays as stored", () => {
  const { tasks, task } = seedT();
  const r = saveText(tasks, task.id, { title: "T2", desc: "d2", priority: "P0", tags: "z", column: "done", assignee: null, project: null }, 5);
  assert.equal(r.error, undefined);
  assert.deepEqual([r.task.title, r.task.desc], ["T2", "d2"]);
  for (const k of ["priority", "tags", "column", "assignee", "project"]) assert.deepEqual(r.task[k], task[k], k);
  assert.equal(r.task.updated, 5);
});

test("saveText: blank title errors; unknown id errors", () => {
  const { tasks, task } = seedT();
  assert.ok(saveText(tasks, task.id, { title: "  ", desc: "x" }).error);
  assert.ok(saveText(tasks, "nope", { title: "a", desc: "" }).error);
});

test("patchField: whitelist status/priority/assignee/project/tags; unknown field errors", () => {
  const { tasks, task } = seedT();
  assert.equal(patchField(tasks, task.id, "priority", "P0").task.priority, "P0");
  assert.equal(patchField(tasks, task.id, "status", "review").task.column, "review");
  assert.deepEqual(patchField(tasks, task.id, "assignee", null).task.assignee, null);
  assert.equal(patchField(tasks, task.id, "project", "p2").task.project, "p2");
  assert.deepEqual(patchField(tasks, task.id, "tags", ["q"]).task.tags, ["q"]);
  assert.equal(patchField(tasks, task.id, "title", "x").task.title, "x");
  assert.equal(patchField(tasks, task.id, "desc", "body").task.desc, "body");
  assert.ok(patchField(tasks, task.id, "title", "  ").error);
  assert.ok(patchField(tasks, task.id, "archived", true).error);
});

test("patchField on a doing task keeps the run for priority/tags/project/assignee; only todo/backlog clears it", () => {
  const { tasks } = add([], { title: "A", column: "doing" });
  const run = { ...tasks[0], agent: "claude", run: "r1", claimedAt: 5 };
  const base = [run];
  for (const [f, v] of [["priority", "P0"], ["tags", ["x"]], ["project", "p1"], ["assignee", { kind: "agent", id: "claude" }]]) {
    const t = patchField(base, run.id, f, v).task;
    assert.deepEqual([t.agent, t.run, t.claimedAt, t.column], ["claude", "r1", 5, "doing"], f);
  }
  assert.equal(patchField(base, run.id, "status", "review").task.run, "r1");
  for (const to of ["todo", "backlog"]) {
    const t = patchField(base, run.id, "status", to).task;
    assert.deepEqual([t.agent, t.run, t.claimedAt], [null, null, null], to);
  }
});

test("note op rejects empty and whitespace-only text", () => {
  const { tasks, task } = add([], { title: "A" });
  for (const text of ["", "   ", "\n\t "]) assert.ok(applyCommand(tasks, { op: "note", id: task.id, text }).error, JSON.stringify(text));
  assert.equal(applyCommand(tasks, { op: "note", id: task.id, text: " ok " }).task.notes[0].text, "ok");
});

test("note op: kind is stored; none keeps the old shape; unknown is rejected", () => {
  const { tasks, task } = add([], { title: "A" });
  assert.deepEqual(NOTE_KINDS, ["decision", "log", "blocker", "pr", "handoff"]);
  for (const kind of NOTE_KINDS) assert.equal(applyCommand(tasks, { op: "note", id: task.id, text: "x", kind }).task.notes[0].kind, kind);
  const plain = applyCommand(tasks, { op: "note", id: task.id, text: "x" }).task.notes[0];
  assert.ok(!("kind" in plain), "no kind key without a kind");
  assert.ok(!("kind" in applyCommand(tasks, { op: "note", id: task.id, text: "x", kind: "" }).task.notes[0]));
  assert.ok(applyCommand(tasks, { op: "note", id: task.id, text: "x", kind: "gossip" }).error);
});

test("note op: old notes without a kind stay valid next to new ones", () => {
  const { tasks, task } = add([], { title: "A" });
  const old = tasks.map((t) => ({ ...t, notes: [{ at: 1, by: "you", text: "old" }] }));
  const r = applyCommand(old, { op: "note", id: task.id, text: "new", kind: "log" });
  assert.deepEqual(r.task.notes.map((n) => n.kind), [undefined, "log"]);
});
