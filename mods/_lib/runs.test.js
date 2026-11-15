import { test } from "node:test";
import assert from "node:assert/strict";
import { lineageOf, stopTargets, orphanedWorkers, squadRows, openCommand, durationText, createCardsPrompt, leaderPrompt, memberPrompt, droverTerminal, droverChoices, defaultDrover, droverLabel, terminalName, addDefaults, DEFAULT_CONFIG, runFolder, startFolder, runTitle, modelOf, markEnded, terminalRecord, liveStatuses, liveAgents, memberStatus, parseAgentEnv, launchArgv, saveAgent, envProblem, ENV_LOG_MAX, ENV_MAX_BYTES } from "./runs.js";

const run = (id, started, ...terminals) => ({ id, started, terminals: terminals.map(([address, agent]) => ({ address, agent })) });

test("droverTerminal: none when no run has a drover terminal", () => {
  assert.equal(droverTerminal([], ["t1"]), null);
  assert.equal(droverTerminal([run("R1", 1, ["t1", "wrangler"])], ["t1"]), null);
});

test("droverTerminal: ignores a drover terminal that is not on screen", () => {
  assert.equal(droverTerminal([run("R1", 1, ["t5", "drover"])], ["t1"]), null);
});

test("droverTerminal: newest run with a shown drover wins, whatever the list order", () => {
  const runs = [run("old", 1, ["t5", "drover"]), run("new", 9, ["t81", "drover"]), run("gone", 20, ["t99", "drover"])];
  assert.equal(droverTerminal(runs, ["t5", "t81"]), "t81");
  assert.equal(droverTerminal(runs, ["t5"]), "t5");
});

test("terminalName: the name of the run terminal with that address, else the address", () => {
  const runs = [{ id: "R1", terminals: [{ address: "t1", agent: "drover", name: "Drover" }] }];
  assert.equal(terminalName(runs, "t1"), "Drover");
  assert.equal(terminalName(runs, "t9"), "t9");
});

test("defaults: Scoping squad has pm leader and its members exist as agents", () => {
  const sq = DEFAULT_CONFIG.squads.find((s) => s.id === "scoping");
  assert.equal(sq.leader, "pm");
  const ids = new Set(DEFAULT_CONFIG.agents.map((a) => a.id));
  for (const id of ["pm", "architect", "qa", "security", "writer"]) assert.ok(ids.has(id), id);
  assert.deepEqual(sq.members.map((m) => m.agent), ["architect", "qa", "security", "writer", "scout"]);
  assert.ok(ids.has(sq.leader) && sq.members.every((m) => ids.has(m.agent)));
});

test("addDefaults: adds scoping to an old config, keeps user edits", () => {
  const old = { agents: [{ id: "scout", name: "Mine", command: "x", version: 9 }], squads: [] };
  const { config, added } = addDefaults(old);
  assert.equal(config.agents.find((a) => a.id === "scout").name, "Mine");
  assert.ok(config.agents.some((a) => a.id === "pm") && config.squads.some((s) => s.id === "scoping"));
  assert.ok(added > 0);
  assert.equal(addDefaults(config).added, 0);
});

import { isLiveDrover } from "./runs.js";

test("isLiveDrover: only a live terminal of agent drover", () => {
  const runs = [run("R1", 1, ["t81", "drover"], ["t5", "wrangler"])];
  assert.equal(isLiveDrover(runs, "t81", new Set(["t81"])), true);
  assert.equal(isLiveDrover(runs, "t5", new Set(["t5"])), false); // squad agent
  assert.equal(isLiveDrover(runs, "t81", new Set(["t5"])), false); // dead drover
  assert.equal(isLiveDrover(runs, "", new Set([""])), false);
  assert.equal(isLiveDrover(runs, "t9", new Set(["t9"])), false); // unknown
});

test("createCardsPrompt: request as data, drover add with the project, no start, the soul loads", () => {
  const ctx = { drover: "/x/drover", souls: "/x/souls" };
  const text = createCardsPrompt("Fix the login redirect", { soul: "wrangler", instructions: "" }, { id: "P-1", name: "Alpha" }, ctx);
  for (const s of ["Fix the login redirect", "DATA", "/x/drover add", "--project P-1", "Alpha", "Do NOT start", "/x/souls/wrangler.md"]) assert.ok(text.includes(s), s);
  assert.ok(createCardsPrompt("x", { soul: "" }, null, ctx).includes("Project: none"));
});

test("runFolder: worktree, else the project's repo, else the coordinator's folder, else none", () => {
  assert.equal(runFolder("/wt", "/repo", "/boss"), "/wt");
  assert.equal(runFolder(null, "/repo", "/boss"), "/repo", "a project's repo wins over the coordinator's folder");
  assert.equal(runFolder(undefined, "/repo", undefined), "/repo", "no worktree, no coordinator: the project's repo, not Herdr's default");
  assert.equal(runFolder(null, null, "/boss"), "/boss");
  assert.equal(runFolder(undefined, null, undefined), null);
});

test("startFolder: the chosen project's default repo; none, a removed project or a project without repo gives null (the space's folder)", () => {
  const projects = [
    { id: "P1", name: "drover-herdr", repos: [{ path: "/a" }, { path: "/b", default: true }] },
    { id: "P2", name: "docs", repos: [] },
  ];
  assert.equal(startFolder(projects, "P1"), "/b");
  assert.equal(startFolder(projects, null), null);
  assert.equal(startFolder(projects, "P9"), null, "a removed project");
  assert.equal(startFolder(projects, "P2"), null, "a project without repo");
});

test("runTitle: card id plus title; no 'null' for a run without a card", () => {
  assert.equal(runTitle({ task: "T-1", title: "Run" }, { title: "Card" }), "T-1 Card");
  assert.equal(runTitle({ task: "T-1", title: "Run" }, undefined), "T-1 Run");
  assert.equal(runTitle({ task: null, title: "Drover" }, undefined), "Drover");
  assert.equal(runTitle({ title: "Drover" }, undefined), "Drover");
  assert.equal(runTitle({ task: null }, undefined), "");
});

test("modelOf: --model for claude and codex, = form, odd spacing, else null", () => {
  assert.equal(modelOf("claude --model claude-sonnet-5-5 --effort medium"), "claude-sonnet-5-5");
  assert.equal(modelOf("codex --no-daemon --model gpt-6.1-sol -c model_reasoning_effort=medium"), "gpt-6.1-sol");
  assert.equal(modelOf("claude --model=opus-x --effort high"), "opus-x");
  assert.equal(modelOf("  claude \t --model \t  m1   --effort high "), "m1");
  assert.equal(modelOf("claude"), null);
  assert.equal(modelOf("codex --no-daemon"), null);
  assert.equal(modelOf("claude --model"), null);
  assert.equal(modelOf("claude --model="), null);
  assert.equal(modelOf(""), null);
  assert.equal(modelOf(undefined), null);
});

test("terminalRecord: saves requested model and start; role kept", () => {
  const r = terminalRecord("t5", { id: "wrangler", name: "Wrangler", role: "Wrangler", command: "claude --model m --effort low" }, 123);
  assert.deepEqual(r, { address: "t5", agent: "wrangler", name: "Wrangler", role: "Wrangler", model: "m", started: 123 });
  assert.equal(terminalRecord("t6", { id: "x", name: "X", role: "leader", command: "x" }, 1).model, null);
});

const mk = (ts, extra = {}) => ({ id: "R", terminals: ts.map((a) => ({ address: a, agent: "x", started: 1 })), ...extra });
const none = new Map();

test("markEnded: first observed gone sets terminal.ended once; run ended when all gone", () => {
  const runs = [mk(["t1", "t2"])];
  const a = markEnded(runs, none, new Set(["t1"]), 100);
  assert.notEqual(a, runs);
  assert.equal(a[0].terminals[0].ended, undefined);
  assert.equal(a[0].terminals[1].ended, 100);
  assert.equal(a[0].ended, undefined);
  const b = markEnded(a, none, new Set(), 200);
  assert.equal(b[0].terminals[0].ended, 200);
  assert.equal(b[0].terminals[1].ended, 100); // keeps first time
  assert.equal(b[0].ended, 200);
  assert.equal(runs[0].terminals[0].ended, undefined); // input not mutated
});

test("markEnded: idempotent, same object when nothing changes", () => {
  const runs = [mk(["t1"])];
  const a = markEnded(runs, none, new Set(), 100);
  assert.equal(markEnded(a, none, new Set(), 999), a);
  const alive = [mk(["t1"])];
  assert.equal(markEnded(alive, none, new Set(["t1"]), 5), alive);
});

test("markEnded: manual, taskless and unbound runs get ended too", () => {
  const runs = [mk(["t1"], { task: null, project: null }), mk(["t2"], { task: "T-1", project: "p" })];
  const out = markEnded(runs, none, new Set(), 7);
  assert.equal(out[0].ended, 7);
  assert.equal(out[1].ended, 7);
});

test("markEnded: reopening later records first-observed time", () => {
  const old = [mk(["t1"], { started: 1 }), { id: "R2", ended: 5, terminals: [{ address: "t3", started: 1, ended: 5 }] }];
  const out = markEnded(old, none, new Set(["t1"]), 50);
  assert.equal(out, old);
  const later = markEnded(old, none, new Set(), 9000);
  assert.equal(later[0].ended, 9000);
  assert.equal(later[1], old[1]);
  assert.equal(old[0].ended, undefined);
});

test("markEnded: legacy run (no terminal.started) gone + unrelated live terminal -> same array, no write", () => {
  const legacy = [{ id: "legacy", started: 1, terminals: [{ address: "gone", agent: "wrangler", role: "leader" }] }];
  assert.equal(markEnded(legacy, none, new Set(["unrelated"]), 9000), legacy);
  assert.equal(markEnded(legacy, none, new Set(), 9000), legacy);
});

test("markEnded: mixed run: run.ended only when every terminal has started and is gone", () => {
  const runs = [{ id: "M", terminals: [{ address: "a", started: 1 }, { address: "b" }] }];
  const out = markEnded(runs, none, new Set(["z"]), 10);
  assert.equal(out[0].terminals[0].ended, 10);
  assert.equal(out[0].terminals[1].ended, undefined);
  assert.equal(out[0].ended, undefined);
});

test("markEnded: live status counts as present; run without terminals unchanged", () => {
  const runs = [mk(["t1"]), { id: "E", terminals: [] }, { id: "N" }];
  const out = markEnded(runs, new Map([["t1", "idle"]]), new Set(), 3);
  assert.equal(out, runs);
});

// lineageOf
const T = (address, o = {}) => ({ address, agent: "wrangler", name: address, role: "Wrangler", ...o });
const lineRun = (o = {}) => ({
  id: "R1", reportTo: null,
  terminals: [T("t2", { agent: "inspector", name: "Inspector", role: "Inspector", model: "gpt-6.1-sol", started: 1000 }),
    T("t3", { agent: "trail-boss", name: "Trail Boss", role: "leader", model: "claude-sonnet-5-5", started: 2000 })],
  ...o,
});
const rowAddrs = (rows) => rows.map((r) => r.address);

test("lineageOf: solo run is the leader only, no root row", () => {
  const rows = lineageOf({ id: "R1", terminals: [T("t9", { role: "leader" })] }, [], new Map(), new Set(["t9"]), 5000);
  assert.deepEqual(rowAddrs(rows), ["t9"]);
});

test("lineageOf: leader is the role leader, never terminals[0]; members keep launch order", () => {
  const r = lineRun({ terminals: [T("t1"), T("t2"), T("t3", { role: "leader" })] });
  assert.deepEqual(rowAddrs(lineageOf(r, [], new Map(), new Set(["t1", "t2", "t3"]), 0)), ["t3", "t1", "t2"]);
  const first = lineRun({ terminals: [T("t1", { role: "leader" }), T("t2"), T("t3")] });
  assert.deepEqual(rowAddrs(lineageOf(first, [], new Map(), new Set(), 0)), ["t1", "t2", "t3"]);
});

test("lineageOf: legacy run without a leader role falls back to the last terminal", () => {
  const r = { id: "R0", terminals: [{ address: "t1", agent: "a" }, { address: "t2", agent: "b" }] };
  assert.deepEqual(rowAddrs(lineageOf(r, [], new Map(), new Set(), 0)), ["t2", "t1"]);
});

test("lineageOf: coordinator resolved from another run's terminal, in front", () => {
  const boss = { id: "R0", terminals: [T("t7", { agent: "drover", name: "Drover", role: "leader", model: "claude-opus-5-5", started: 10 })] };
  const rows = lineageOf(lineRun({ reportTo: "t7" }), [boss, lineRun({ reportTo: "t7" })], new Map([["t7", "working"]]), new Set(["t7", "t2", "t3"]), 110);
  assert.deepEqual(rowAddrs(rows), ["t7", "t3", "t2"]);
  assert.deepEqual(rows[0], { address: "t7", name: "Drover", role: "coordinator", agent: "drover", model: "claude-opus-5-5", status: "working", startedMs: 10, endedMs: null, durationMs: 100, gone: false, parked: false });
});

test("lineageOf: non-Drover coordinator is shown from its terminal", () => {
  const other = { id: "R0", terminals: [T("t7", { agent: "claude", name: "Claude", role: "leader" })] };
  const rows = lineageOf(lineRun({ reportTo: "t7" }), [other], new Map(), new Set(["t7"]), 0);
  assert.equal(rows[0].name, "Claude");
  assert.equal(rows[0].agent, "claude");
});

test("lineageOf: unknown coordinator is 'Coordinator <addr>' with model null", () => {
  const rows = lineageOf(lineRun({ reportTo: "t88" }), [], new Map(), new Set(), 0);
  assert.equal(rows[0].name, "Coordinator t88");
  assert.equal(rows[0].model, null);
  assert.equal(rows[0].agent, null);
  assert.equal(rows[0].startedMs, null);
  assert.equal(rows[0].durationMs, null);
  assert.equal(rows[0].status, "gone");
});

test("lineageOf: duration is (ended ?? now) - started; gone rows keep a frozen duration", () => {
  const r = lineRun({ terminals: [T("t2", { started: 1000, ended: 4000 }), T("t3", { role: "leader", started: 500 })] });
  const rows = lineageOf(r, [], new Map(), new Set(["t3"]), 9000);
  assert.deepEqual(rowAddrs(rows), ["t3", "t2"]);
  assert.equal(rows[0].durationMs, 8500);
  assert.equal(rows[0].gone, false);
  assert.equal(rows[1].gone, true);
  assert.equal(rows[1].durationMs, 3000);
  assert.equal(lineageOf(r, [], new Map(), new Set(["t3"]), 99999)[1].durationMs, 3000);
});

test("lineageOf: old run without model/started/ended gives nulls", () => {
  const r = { id: "R0", terminals: [{ address: "t1", agent: "a", name: "A", role: "leader" }] };
  const [row] = lineageOf(r, [], new Map(), new Set(["t1"]), 5000);
  assert.deepEqual([row.model, row.startedMs, row.endedMs, row.durationMs], [null, null, null, null]);
  assert.equal(row.status, "running");
});

// squadRows / durationText
test("durationText: '—' when unknown, '<1m', minutes, hours padded", () => {
  assert.equal(durationText(null), "—");
  assert.equal(durationText(undefined), "—");
  assert.equal(durationText(0), "<1m");
  assert.equal(durationText(29000), "<1m");
  assert.equal(durationText(30000), "1m");
  assert.equal(durationText(89000), "1m");
  assert.equal(durationText(5 * 60000 + 20000), "5m");
  assert.equal(durationText(59 * 60000 + 40000), "1h 00m");
  assert.equal(durationText(65 * 60000), "1h 05m");
  assert.equal(durationText(3 * 3600000 + 11 * 60000), "3h 11m");
});

const squad = (extra = {}, alive = ["t1", "t2", "t3"], now = 600000) => squadRows(lineageOf(
  { id: "R", terminals: [T("t1", { role: "member", model: "sonnet", started: 0 }), T("t2", { role: "member", started: 0 }), T("t3", { role: "leader", model: "opus", started: 0 })], worktree: { branch: "feat/x" }, ...extra },
  [], new Map(), new Set(alive), now));

test("squadRows: coordinator+leader+members indent 0/1/2, leader is last launched", () => {
  const rows = squad({ reportTo: "t88" });
  assert.deepEqual(rows.map((r) => [r.address, r.depth]), [["t88", 0], ["t3", 1], ["t1", 2], ["t2", 2]]);
  assert.deepEqual(rows.map((r) => r.leader), [false, true, false, false]);
});

test("squadRows: no coordinator -> leader depth 0, members depth 1; solo run", () => {
  assert.deepEqual(squad().map((r) => r.depth), [0, 1, 1]);
  const solo = squadRows(lineageOf({ id: "S", terminals: [T("t9", { role: "leader" })] }, [], new Map(), new Set(["t9"]), 0));
  assert.deepEqual(solo.map((r) => [r.address, r.depth, r.leader]), [["t9", 0, true]]);
});

test("squadRows: live coordinator focuses its agent; live rows focusable; gone rows dim and not focusable", () => {
  const rows = squad({ reportTo: "t88" }, ["t3", "t88", "t1"]);
  const by = Object.fromEntries(rows.map((r) => [r.address, r]));
  assert.equal(by.t88.focusable, true);
  assert.equal(openCommand(by.t88), "agent.focus");
  assert.equal(by.t88.dim, false);
  assert.equal(by.t3.focusable, true);
  assert.equal(by.t1.focusable, true);
  assert.deepEqual([by.t2.focusable, by.t2.dim], [false, true]);
});

test("squadRows: gone coordinator is not focusable", () => {
  const c = squad({ reportTo: "t88" }, ["t3", "t1"]).find((r) => r.address === "t88");
  assert.equal(c.focusable, false);
});

test("squadRows: modelText and durationText; legacy record gives '—' without throwing", () => {
  const rows = squad({}, ["t1", "t2", "t3"], 5 * 60000);
  assert.deepEqual(rows.map((r) => [r.modelText, r.durationText]), [["opus", "5m"], ["sonnet", "5m"], ["—", "5m"]]);
  const old = squadRows(lineageOf({ id: "O", terminals: [{ address: "t1", agent: "a", name: "A", role: "leader" }] }, [], new Map(), new Set(["t1"]), 5000));
  assert.deepEqual([old[0].modelText, old[0].durationText], ["—", "—"]);
  const coord = squadRows(lineageOf({ id: "O", reportTo: "t88", terminals: [] }, [], new Map(), new Set(), 0));
  assert.deepEqual([coord[0].modelText, coord[0].durationText], ["—", "—"]);
});

test("squadRows: a resolved coordinator with a stored model still shows '—'", () => {
  const other = { id: "D", terminals: [T("t88", { role: "member", model: "opus", started: 0 })] };
  const rows = squadRows(lineageOf({ id: "R", reportTo: "t88", terminals: [T("t1", { role: "leader", model: "sonnet" })] }, [other], new Map(), new Set(["t88", "t1"]), 0));
  assert.equal(rows[0].role, "coordinator");
  assert.equal(rows[0].model, "opus");
  assert.equal(rows[0].modelText, "—");
  assert.equal(rows[1].modelText, "sonnet");
});

// stopTargets (Runs card Stop)
test("stopTargets: only live terminals of this run; coordinator and other runs never targeted", () => {
  const a = { id: "A", reportTo: "t0", terminals: [{ address: "t1", role: "Wrangler" }, { address: "t2", role: "leader" }, { address: "t3" }] };
  const b = { id: "B", terminals: [{ address: "t7", role: "leader" }] };
  const alive = new Set(["t0", "t1", "t2", "t7"]); // t3 gone, t0 is the coordinator, t7 belongs to run B
  assert.deepEqual(stopTargets(a, alive), ["t1", "t2"]);
  assert.deepEqual(stopTargets(b, alive), ["t7"]);
  assert.deepEqual(stopTargets({ id: "C" }, alive), []);
});

test("leaderPrompt appends the person's note when ctx.note is set, after the task and before the roster", () => {
  const ctx = { drover: "/d", souls: "/s", reportTo: null };
  const task = { id: "T-1", title: "t", desc: "" };
  const leader = { name: "L", role: "leader", command: "x" };
  const withNote = leaderPrompt(task, leader, [], { ...ctx, note: "please start with the tests" });
  assert.match(withNote, /Task T-1: t\n\nNote from the person, read it first: please start with the tests/);
  assert.ok(!leaderPrompt(task, leader, [], ctx).includes("Note from the person"));
});

test("work folder: leader, member and create-cards prompts carry the absolute folder when ctx.workFolder is set, none otherwise", () => {
  const ctx = { drover: "/d", souls: "/s", reportTo: null };
  const wf = { ...ctx, workFolder: "/h/.config/drover-herdr/P-1/R-9" };
  const line = "Work folder (plans, scouts, reviews, lane logs): /h/.config/drover-herdr/P-1/R-9";
  const task = { id: "T-1", title: "t", desc: "" };
  const agent = { name: "L", role: "leader", command: "x" };
  assert.ok(leaderPrompt(task, agent, [], wf).includes(line));
  assert.ok(memberPrompt(task, { ...agent, role: "Wrangler" }, wf).includes(line));
  assert.ok(createCardsPrompt("do x", agent, null, wf).includes(line));
  for (const p of [leaderPrompt(task, agent, [], ctx), memberPrompt(task, agent, ctx), createCardsPrompt("do x", agent, null, ctx)]) assert.ok(!p.includes("Work folder"));
});

const envText = (env) => JSON.stringify({ version: 1, env });
const ok = (name) => ({ [name]: { value: "canary-value-1", secret: true } });

test("parseAgentEnv: a valid file gives names and values", () => {
  const r = parseAgentEnv(envText({ ...ok("GH_TOKEN"), ...ok("_X9") }));
  assert.deepEqual(r.names, ["GH_TOKEN", "_X9"]);
  assert.equal(r.env.GH_TOKEN, "canary-value-1");
  assert.equal(r.error, undefined);
});

test("parseAgentEnv: rejects bad names", () => {
  for (const n of ["gh_token", "1A", "A-B", "A B", "", "A=B"]) assert.ok(parseAgentEnv(envText(ok(n))).error, n);
});

test("parseAgentEnv: rejects deny-listed names", () => {
  for (const n of ["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TERM", "HC_TERMINAL_ID", "HERDR_ENV", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONPATH"])
    assert.ok(parseAgentEnv(envText(ok(n))).error, n);
  assert.equal(parseAgentEnv(envText(ok("PATHS"))).error, undefined);
});

test("parseAgentEnv: rejects duplicate names (raw JSON text)", () => {
  const t = '{"version":1,"env":{"A":{"value":"x"},"A":{"value":"y"}}}';
  assert.match(parseAgentEnv(t).error, /duplicate/i);
});

test("parseAgentEnv: rejects more than 8 KiB", () => {
  assert.equal(ENV_MAX_BYTES, 8192);
  const big = envText({ A: { value: "x".repeat(ENV_MAX_BYTES) } });
  assert.match(parseAgentEnv(big).error, /8 KiB/);
});

test("parseAgentEnv: rejects bad schema, never echoes a value in the error", () => {
  for (const t of ["", "nope", "[]", "{}", '{"version":2,"env":{}}', '{"version":1,"env":[]}',
    envText({ A: "plain" }), envText({ A: { value: 5 } }), envText({ A: { value: "a\u0000b" } })]) assert.ok(parseAgentEnv(t).error, t);
  assert.ok(!JSON.stringify(parseAgentEnv(envText({ lower: { value: "canary-value-1" } }))).includes("canary-value-1"));
});

test("launchArgv: wraps only when the agent has env", () => {
  assert.deepEqual(launchArgv("inspector", ["codex", "--x"], "/w/drover-env", false), ["codex", "--x"]);
  assert.deepEqual(launchArgv("inspector", ["codex", "--x"], "/w/drover-env", true), ["/w/drover-env", "inspector", "--", "codex", "--x"]);
});

test("terminalRecord: adds env names, never values", () => {
  const agent = { id: "inspector", name: "Inspector", role: "r", command: "codex", env: { GH_TOKEN: { value: "canary-value-1" } } };
  const r = terminalRecord("t1", agent, 5, ["GH_TOKEN"]);
  assert.deepEqual(r.env, ["GH_TOKEN"]);
  assert.ok(!JSON.stringify(r).includes("canary-value-1"));
  assert.equal("env" in terminalRecord("t1", agent, 5), false);
  assert.equal("env" in terminalRecord("t1", agent, 5, []), false);
});

test("saveAgent: rejects an env field, and never keeps env on a profile", () => {
  const cfg = { agents: [{ id: "a", name: "A", command: "x", instructions: "", version: 1, env: { K: { value: "canary-value-1" } } }], squads: [] };
  assert.ok(saveAgent(cfg, { id: "a", name: "A", command: "x", env: { K: { value: "canary-value-1" } } }).error);
  const r = saveAgent(cfg, { id: "a", name: "A2", command: "x" });
  assert.equal("env" in r.agent, false);
  assert.ok(!JSON.stringify(r.config).includes("canary-value-1"));
});

test("parseAgentEnv: duplicates by escape, null first, or repeated env object are rejected", () => {
  for (const t of ['{"version":1,"env":{"A":{"value":"x"},"\\u0041":{"value":"y"}}}',
    '{"version":1,"env":{"A":null,"A":{"value":"y"}}}',
    '{"version":1,"env":{},"env":{}}']) assert.match(parseAgentEnv(t).error, /duplicate/i, t);
  assert.deepEqual(parseAgentEnv('{"version":1,"env":{"A":{"value":"a,\\"B\\":{"},"B":{"value":"b"}}}').names, ["A", "B"]);
});

test("parseAgentEnv: works without TextEncoder and counts multibyte bytes", () => {
  const saved = globalThis.TextEncoder;
  delete globalThis.TextEncoder;
  try {
    assert.deepEqual(parseAgentEnv(envText({})).names, []);
    const fill = (n, ch) => envText({ A: { value: ch.repeat(n) } });
    const base = fill(0, "x").length;
    assert.equal(parseAgentEnv(fill(ENV_MAX_BYTES - base, "x")).error, undefined);
    assert.ok(parseAgentEnv(fill(ENV_MAX_BYTES - base + 1, "x")).error);
    assert.ok(parseAgentEnv(fill(Math.floor((ENV_MAX_BYTES - base) / 2) + 1, "é")).error);
    assert.equal(parseAgentEnv(fill(Math.floor((ENV_MAX_BYTES - base) / 2), "é")).error, undefined);
  } finally { globalThis.TextEncoder = saved; }
});

test("envProblem: GH_TOKEN needs GH_CONFIG_DIR, nothing else is checked here", () => {
  assert.match(envProblem(["GH_TOKEN"]), /GH_CONFIG_DIR/);
  assert.match(envProblem(["FOO", "GH_TOKEN"]), /GH_CONFIG_DIR/);
  assert.equal(envProblem(["GH_TOKEN", "GH_CONFIG_DIR"]), null);
  assert.equal(envProblem(["GH_CONFIG_DIR"]), null);
  assert.equal(envProblem([]), null);
});

const AT = "2026-11-13T10:00:00.000Z";
const cfgOf = (a) => ({ agents: [{ id: "a", name: "A", command: "x", instructions: "", version: 1, ...a }], squads: [] });
test("saveAgent: an env event adds one names-only audit line to the agent", () => {
  const r = saveAgent(cfgOf(), { id: "a", name: "A", command: "x", envEvent: { at: AT, action: "set", names: ["GH_TOKEN", "GH_CONFIG_DIR"] } });
  assert.deepEqual(r.agent.envLog, [`${AT} set GH_TOKEN, GH_CONFIG_DIR`]);
  assert.equal("envEvent" in r.agent, false);
});

test("saveAgent: the audit log is kept across a save with no env event, and keeps the last 10", () => {
  const log = Array.from({ length: ENV_LOG_MAX }, (_, i) => `${AT} set N${i}`);
  const kept = saveAgent(cfgOf({ envLog: log }), { id: "a", name: "A2", command: "x" });
  assert.deepEqual(kept.agent.envLog, log);
  const more = saveAgent(cfgOf({ envLog: log }), { id: "a", name: "A", command: "x", envEvent: { at: AT, action: "clear", names: [] } });
  assert.equal(more.agent.envLog.length, ENV_LOG_MAX);
  assert.equal(more.agent.envLog.at(-1), `${AT} clear`);
  assert.equal(more.agent.envLog[0], log[1]);
});

test("saveAgent: an audit line holds only a valid time, an action and valid names; junk is dropped, never a value", () => {
  const bad = [
    { at: AT, action: "set", names: ["ok-lowercase", "has space", "A=canary-value-1"] },
    { at: "canary-value-1", action: "set", names: ["A"] },
    { at: AT, action: "canary-value-1", names: ["A"] },
    { at: AT, action: "set", names: "canary-value-1" },
  ];
  for (const envEvent of bad) {
    const r = saveAgent(cfgOf(), { id: "a", name: "A", command: "x", envEvent });
    assert.ok(!JSON.stringify(r.config).includes("canary-value-1"), JSON.stringify(envEvent));
    assert.ok(!(r.agent.envLog ?? []).some((l) => /ok-lowercase|has space/.test(l)));
  }
  const first = saveAgent(cfgOf(), { id: "a", name: "A", command: "x", envEvent: bad[0] });
  assert.equal(first.agent.envLog?.length ?? 0, 1); // the event is real (a set), only the bad names are dropped
  assert.equal(first.agent.envLog[0], `${AT} set`);
});

test("saveAgent: a stored envLog that is not a list of strings is dropped, and an old env field still is", () => {
  const r = saveAgent(cfgOf({ envLog: { x: 1 }, env: { K: { value: "canary-value-1" } } }), { id: "a", name: "A", command: "x" });
  assert.equal("envLog" in r.agent, false);
  assert.equal("env" in r.agent, false);
  const s = saveAgent(cfgOf({ envLog: [5, `${AT} set A`, "x".repeat(2000)] }), { id: "a", name: "A", command: "x" });
  assert.deepEqual(s.agent.envLog, [`${AT} set A`]);
});

// Parked workers have no pane: Stop and a closed space must still end them.
test("stopTargets: a parked member is targeted even when the live list omits it", () => {
  const r = { id: "A", terminals: [{ address: "t1", role: "leader" }, { address: "t2", role: "Wrangler", parked: true }, { address: "t3", role: "Inspector", parked: true }] };
  assert.deepEqual(stopTargets(r, new Set(["t1"])), ["t1", "t2", "t3"]);
});

test("orphanedWorkers: closed own space or gone leader orphans the parked members", () => {
  const r = { id: "A", space: "s1", worktree: { path: "/w" }, terminals: [{ address: "t1", role: "leader" }, { address: "t2", role: "W", parked: true }, { address: "t3", role: "W", parked: true, reaped: true }, { address: "t4", role: "W" }] };
  assert.deepEqual(orphanedWorkers(r, new Set(["t1"]), new Set(["s1"])), [], "space open and leader alive");
  assert.deepEqual(orphanedWorkers(r, new Set(["t1"]), new Set(["s9"])), ["t2"], "space closed: only unreaped parked, never a pane worker");
  assert.deepEqual(orphanedWorkers(r, new Set(["t2"]), new Set(["s1"])), ["t2"], "leader gone");
  assert.deepEqual(orphanedWorkers(r, new Set(["t1"]), new Set()), [], "empty space list is unknown, not closed");
  assert.deepEqual(orphanedWorkers(r, new Set(["t2"]), new Set()), ["t2"], "leader gone still counts with an empty space list");
  assert.deepEqual(orphanedWorkers({ ...r, ended: 5 }, new Set(), new Set(["s9"])), ["t2"], "an ended run still reaps leftovers");
  assert.deepEqual(orphanedWorkers({ ...r, worktree: null }, new Set(["t1"]), new Set(["s9"])), [], "shared space (no worktree): space rule off");
  assert.deepEqual(orphanedWorkers({ ...r, worktree: null }, new Set(["t2"]), new Set(["s9"])), ["t2"], "shared space: leader-gone rule only");
  assert.deepEqual(orphanedWorkers({ id: "B", terminals: [{ address: "t9", parked: true }] }, new Set(), new Set(["s9"])), [], "no leader record: nothing");
});

import { reviewLive, dotKind } from "./runs.js";

test("reviewLive: a Review card whose run still has a working or running agent", () => {
  const runs = [{ task: "T-1", terminals: [{ address: "t1" }, { address: "t2" }] }, { task: "T-2", terminals: [{ address: "t9" }] }];
  const live = (o) => new Map(Object.entries(o));
  const none = new Set();
  assert.equal(reviewLive({ id: "T-1", column: "review" }, runs, live({ t2: "working" }), none), true);
  assert.equal(reviewLive({ id: "T-1", column: "review" }, runs, live({}), new Set(["t1"])), true); // running: terminal alive, no agent status
  assert.equal(reviewLive({ id: "T-1", column: "review" }, runs, live({ t1: "done" }), none), false);
  assert.equal(reviewLive({ id: "T-1", column: "review" }, runs, live({ t9: "working" }), none), false); // other run
  assert.equal(reviewLive({ id: "T-1", column: "review", agent: "t5" }, [], live({ t5: "working" }), none), true);
  assert.equal(reviewLive({ id: "T-1", column: "doing" }, runs, live({ t2: "working" }), none), false);
});

test("dotKind: only a live Review row gets the two-colour dot", () => {
  assert.equal(dotKind("review", true), "review-live");
  assert.equal(dotKind("review", false), "review");
  assert.equal(dotKind("working", true), "working");
});

test("liveStatuses: a parked terminal (no pane agent) keeps the status hc reports; a pane agent wins; no status stays unset", () => {
  const live = liveStatuses(
    [{ address: "t1", status: "idle" }],
    [{ address: "t1", status: "working" }, { address: "t2", status: "working" }, { address: "t3", status: "done" }, { address: "t4" }, { address: "t5", status: "" }]);
  assert.equal(live.get("t1"), "idle");
  assert.equal(live.get("t2"), "working");
  assert.equal(live.get("t3"), "done");
  const alive = new Set(["t1", "t2", "t3", "t4", "t5", "t6"]);
  assert.equal(memberStatus("t4", live, alive), "running");
  assert.equal(memberStatus("t5", live, alive), "running");
  assert.equal(memberStatus("t2", live, alive), "working");
  assert.equal(memberStatus("t9", live, alive), "gone");
});

test("liveAgents: parked terminal with a status counts as a live agent; pane agent object wins; status-less terminal is not an agent", () => {
  const pane = { address: "t1", status: "idle", seq: 3 };
  const m = liveAgents([pane], [{ address: "t1", status: "working" }, { address: "t2", status: "working" }, { address: "t3" }]);
  assert.equal(m.get("t1"), pane);
  assert.equal(m.get("t2").status, "working");
  assert.equal(m.has("t3"), false);
});

// T-MWGM0XUUWJT (#34): Report to Drover defaults to the Drover of the sidebar's space.
const named = (id, started, address, name) => ({ id, started, terminals: [{ address, agent: "drover", name }] });
const spaceOf = (m) => (a) => m[a] ?? null;
test("droverChoices: every shown Drover once, newest run first, with its space", () => {
  const runs = [named("a", 1, "t1", "Drover"), named("b", 9, "t2", "Drover"), named("gone", 20, "t9", "Drover"), run("w", 30, ["t3", "wrangler"])];
  const c = droverChoices(runs, ["t1", "t2", "t3"], spaceOf({ t1: { id: "s1", name: "herdr" }, t2: { id: "s2", name: "gallery-all" } }));
  assert.deepEqual(c.map((x) => x.address), ["t2", "t1"]);
  assert.equal(c[0].spaceName, "gallery-all");
  assert.equal(droverLabel(c[0]), "Drover · gallery-all · t2");
  assert.equal(droverLabel({ name: "Drover", address: "t4", space: null, spaceName: null }), "Drover · t4");
});

test("defaultDrover: the sidebar's space wins over a newer Drover elsewhere; else the newest; else null", () => {
  const c = [{ address: "t2", space: "s2" }, { address: "t1", space: "s1" }];
  assert.equal(defaultDrover(c, "s1"), "t1");
  assert.equal(defaultDrover(c, "s9"), "t2", "no Drover in that space: the newest on screen, as before");
  assert.equal(defaultDrover(c, null), "t2");
  assert.equal(defaultDrover([], "s1"), null);
});
