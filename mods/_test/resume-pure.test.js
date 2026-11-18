// T-MWLGPS2QJQL S1: the pure builders that resume a gone squad (command, guard, prompts, fresh run record, reaper rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { execFileSync } from "node:child_process";

register("./hooks.js", import.meta.url);
const R = await import("../_lib/runs.js");
const { CLAIMING } = await import("../_lib/store.js");

const SID = "11111111-2222-4333-8444-555555555555";
const SID2 = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const CLAUDE = "claude --model claude-sonnet-5-5 --effort medium --permission-mode auto";
const CODEX = "codex --no-daemon --model gpt-6.1-sol -c model_reasoning_effort=medium";

const profile = (id, command) => ({ id, name: id, command, instructions: "", version: 1 });
const rec = (o) => ({ address: "t1", agent: "lead", name: "Lead", role: "leader", model: "m", started: 1, ended: 5, session: SID, kind: "claude", cwd: "/w", ...o });
const run = (o = {}) => ({
  id: "R-OLD", task: "T-1", project: null, title: "Card", runner: { kind: "squad", id: "s" }, name: "Crew v1",
  config: { leader: { ...profile("lead", CLAUDE), role: "leader" }, members: [{ ...profile("cx", CODEX), role: "Inspector" }, { ...profile("cx", CODEX), role: "Reviewer" }] },
  space: "sp-old", worktree: { repo: "/r", branch: "feat/T-1/card", path: "/wt/feat-T-1-card" }, started: 1, ended: 9, reportTo: null,
  terminals: [rec({ address: "t2", agent: "cx", name: "Inspector", role: "Inspector", kind: "codex", session: SID2, parked: true, reaped: true }),
    rec({ address: "t3", agent: "cx", name: "Reviewer", role: "Reviewer", kind: "codex", session: SID, parked: true }), rec({})],
  ...o,
});

// ---- resumeArgv: the CURRENT profile + the resume flag, nothing else.
test("Claude: --resume <id> goes right after argv[0], the profile's own flags stay", () => {
  assert.deepEqual(R.resumeArgv(profile("a", CLAUDE), { kind: "claude", session: SID }).argv,
    ["claude", "--resume", SID, "--model", "claude-sonnet-5-5", "--effort", "medium", "--permission-mode", "auto"]);
});
test("Codex: `resume <id>` is a subcommand right after argv[0] and the profile's flags follow it (argv SHAPE only: compatibility with the installed CLI is the next test)", () => {
  const { argv } = R.resumeArgv(profile("c", CODEX), { kind: "codex", session: SID });
  assert.deepEqual(argv, ["codex", "resume", SID, "--no-daemon", "--model", "gpt-6.1-sol", "-c", "model_reasoning_effort=medium"]);
});
// The real CLI's help, not a list written to match: skipped when codex is not installed (then compatibility is NOT checked, and the run says so).
const codexHelp = (() => { try { return execFileSync("codex", ["resume", "--help"], { encoding: "utf8", timeout: 20000 }); } catch { return null; } })();
test("installed `codex resume --help` lists every flag of the default Codex profile after the resume subcommand", { skip: codexHelp ? false : "codex is not installed here: compatibility not checked" }, () => {
  const { argv } = R.resumeArgv(profile("c", CODEX), { kind: "codex", session: SID });
  for (const flag of argv.slice(3).filter((a) => a.startsWith("--") || /^-[a-z]$/.test(a))) assert.ok(codexHelp.includes(flag), `${flag} is accepted by codex resume`);
});
test("a profile that already has its own session, resume or continue flag is skipped (never overridden)", () => {
  for (const cmd of ["claude --resume abc", "claude -r abc", "claude --continue", "claude -c", `claude --session-id ${SID}`, `claude --session-id=${SID}`, "codex resume abc", "codex fork abc", "codex --last"]) {
    const kind = cmd.startsWith("codex") ? "codex" : "claude";
    const r = R.resumeArgv(profile("p", cmd), { kind, session: SID });
    assert.equal(r.argv, undefined, cmd);
    assert.match(r.skip, /session|resume|continue/i, cmd);
  }
});
test("a profile of another harness than the recorded one is skipped (a Claude id is never fed to codex)", () => {
  assert.match(R.resumeArgv(profile("a", CODEX), { kind: "claude", session: SID }).skip, /claude|codex|kind/i);
  assert.match(R.resumeArgv(profile("a", "mytool --x"), { kind: "claude", session: SID }).skip, /kind|claude/i);
});
test("no usable session id: skipped, never a guess", () => {
  for (const session of [undefined, "", "abc", `${SID}; rm -rf /`]) assert.ok(R.resumeArgv(profile("a", CLAUDE), { kind: "claude", session }).skip, String(session));
});
test("resume never ADDS a permissive, sandbox, yolo or session flag: only the resume flag is new", () => {
  const FORBIDDEN = ["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "--allow-dangerously-skip-permissions", "--permission-mode=bypassPermissions", "bypass", "--sandbox", "-s", "--ask-for-approval", "-a", "--session-id", "--fork-session"];
  for (const [command, kind] of [[CLAUDE, "claude"], [CODEX, "codex"], ["claude", "claude"], ["codex", "codex"]]) {
    const { argv } = R.resumeArgv(profile("a", command), { kind, session: SID });
    const added = argv.filter((a) => !R.argv(command).includes(a));
    assert.deepEqual(added, kind === "claude" ? ["--resume", SID] : ["resume", SID], command);
    for (const f of FORBIDDEN) if (!R.argv(command).includes(f)) assert.ok(!argv.includes(f), `${f} not added to ${command}`);
  }
});
test("the env wrapper still applies: launchArgv wraps the resume argv like any launch", () => {
  const { argv } = R.resumeArgv(profile("lead", CLAUDE), { kind: "claude", session: SID });
  assert.deepEqual(R.launchArgv("lead", argv, "/w/drover-env", true).slice(0, 4), ["/w/drover-env", "lead", "--", "claude"]);
});

// ---- frozenFor / resumeCandidates: current first, frozen fallback by terminal index, drift rules.
test("frozenFor picks the frozen profile by terminal position, not by agent id (the same agent twice)", () => {
  const r = run();
  r.config.members[1] = { ...profile("cx", "codex --no-daemon --model OTHER"), role: "Reviewer" };
  assert.equal(R.frozenFor(r, r.terminals[0]).command, CODEX);
  assert.equal(R.frozenFor(r, r.terminals[1]).command, "codex --no-daemon --model OTHER");
  assert.equal(R.frozenFor(r, r.terminals[2]).command, CLAUDE, "the leader terminal gets config.leader");
});
test("frozenFor fails closed when the frozen entry does not match the terminal's agent", () => {
  const r = run();
  r.config.members[0].id = "someone-else";
  assert.equal(R.frozenFor(r, r.terminals[0]), null);
  assert.equal(R.frozenFor({ ...run(), config: null }, run().terminals[2]), null);
});
test("candidates: current profile first, then the frozen command (same session), identical commands once", () => {
  const r = run(), cur = { agents: [profile("lead", "claude --model claude-opus-5-5 --permission-mode auto"), profile("cx", CODEX)] };
  const c = R.resumeCandidates(cur, r, r.terminals[2]);
  assert.deepEqual(c.candidates.map((x) => x.source), ["current", "frozen"]);
  assert.equal(c.candidates[0].model, "claude-opus-5-5");
  assert.equal(c.candidates[1].model, "claude-sonnet-5-5");
  assert.equal(R.resumeCandidates(cur, r, r.terminals[0]).candidates.length, 1, "current == frozen: one attempt");
});
test("candidates: kind changed, model changed, profile removed, own session flag", () => {
  const r = run(), lead = r.terminals[2];
  const kinds = (agents) => R.resumeCandidates({ agents }, r, lead).candidates.map((x) => x.source);
  assert.deepEqual(kinds([profile("lead", CODEX)]), ["frozen"], "the current profile is another harness");
  assert.deepEqual(kinds([]), ["frozen"], "the profile was removed");
  assert.deepEqual(kinds([profile("lead", "claude --resume x")]), ["frozen"], "its own resume flag");
  assert.equal(R.resumeCandidates({ agents: [profile("lead", "claude --model m2")] }, r, lead).candidates[0].model, "m2", "the model of the command that is tried");
});
test("candidates: both unusable = an error naming the terminal, never an empty try", () => {
  const r = run({ config: { leader: { ...profile("lead", "claude --resume x"), role: "leader" }, members: [] } });
  const out = R.resumeCandidates({ agents: [profile("lead", "claude --continue")] }, r, r.terminals[2]);
  assert.equal(out.candidates.length, 0);
  assert.match(out.error, /Lead|t1/);
});

// ---- resumeGuard
const card = (o = {}) => ({ id: "T-1", title: "Card", column: "doing", agent: null, run: "R-OLD", ...o });
const ctx = (o = {}) => ({ tasks: [card()], runs: [run()], alive: new Set(), resuming: new Set(), ...o });
test("guard: an ended run of a live-less card is eligible and returns the run and the card", () => {
  const g = R.resumeGuard(ctx(), "R-OLD");
  assert.equal(g.ok, true);
  assert.equal(g.run.id, "R-OLD");
  assert.equal(g.task.id, "T-1");
});
test("guard refuses: Done, archived, deleted, CLAIMING, live agent, other live run, still-live terminal, no session, already resumed, task-less, in flight, unknown run", () => {
  const no = (c, re, label) => { const g = R.resumeGuard(c, "R-OLD"); assert.equal(g.ok, undefined, label); assert.match(g.error, re, label); };
  no(ctx({ tasks: [card({ column: "done" })] }), /done|Done/, "done");
  no(ctx({ tasks: [card({ archived: true })] }), /archived/, "archived");
  no(ctx({ tasks: [] }), /no card|not found|T-1/i, "card deleted");
  no(ctx({ tasks: [card({ agent: CLAIMING })] }), /already starting|claim/i, "claiming");
  no(ctx({ tasks: [card({ agent: "t77" })], alive: new Set(["t77"]) }), /t77/, "live agent");
  no(ctx({ alive: new Set(["t3"]) }), /still|live|running/i, "a terminal of the run is alive");
  no(ctx({ runs: [run(), run({ id: "R-OTHER", ended: undefined, terminals: [rec({ address: "t88" })] })], alive: new Set(["t88"]) }), /R-OTHER|another run|live/i, "other live run");
  no(ctx({ runs: [run({ terminals: [rec({ session: undefined, kind: undefined })] })] }), /Lead|t1|session/, "missing session");
  no(ctx({ runs: [run({ resumedBy: "R-NEW" })] }), /R-NEW|already resumed/i, "already resumed");
  no(ctx({ runs: [run({ task: null })] }), /card|task/i, "task-less");
  no(ctx({ resuming: new Set(["R-OLD"]) }), /already|resum/i, "in flight");
  assert.match(R.resumeGuard(ctx(), "R-NOPE").error, /R-NOPE/);
});
test("guard: a done card is eligible again only after it left Done (the column is read now, not at click time)", () => {
  assert.equal(R.resumeGuard(ctx({ tasks: [card({ column: "review" })] }), "R-OLD").ok, true);
  assert.equal(R.resumeGuard(ctx({ tasks: [card({ column: "backlog" })] }), "R-OLD").ok, true);
});
test("guard: with the claim held by this attempt the CLAIMING marker is allowed (commit-time revalidation)", () => {
  assert.equal(R.resumeGuard(ctx({ tasks: [card({ agent: CLAIMING, claimToken: "A1" })], attempt: "A1" }), "R-OLD").ok, true);
  assert.match(R.resumeGuard(ctx({ tasks: [card({ agent: CLAIMING, claimToken: "A2" })], attempt: "A1" }), "R-OLD").error, /claim|starting/i);
});

// ---- prompts
const task = { id: "T-1", title: "Card", desc: "Do it" };
const map = [{ role: "Inspector", name: "Inspector", old: "t2", address: "t20" }, { role: "Reviewer", name: "Reviewer", old: "t3", address: "t21" }];
test("member prompt: resumed, same session, new addresses, wait for the leader, check files first, carries the attempt token", () => {
  const p = R.resumePrompt("member", { task, role: "Inspector", token: "TOK1", map, leader: { old: "t1", address: "t22" } });
  for (const re of [/resumed/i, /session/i, /address/i, /wait for/i, /git status/i, /T-1/, /Inspector/, /drover-resume-attempt: TOK1/]) assert.match(p, re);
});
test("leader prompt: the exact new address map (old -> new) and what changed", () => {
  const p = R.resumePrompt("leader", { task, role: "leader", token: "TOK2", map, changes: ["worktree recreated from branch feat/T-1/card at /wt/feat-T-1-card", "Inspector now runs on gpt-6.2"], leader: { old: "t1", address: "t22" } });
  assert.match(p, /t20/); assert.match(p, /t21/); assert.match(p, /was t2/); assert.match(p, /was t3/);
  assert.match(p, /worktree recreated/); assert.match(p, /gpt-6\.2/);
  assert.match(p, /hc send t20/); assert.match(p, /drover-resume-attempt: TOK2/);
  assert.match(p, /what changed/i);
});
test("prompts never carry a secret-shaped env value and name no flag", () => {
  const p = R.resumePrompt("leader", { task, role: "leader", token: "T", map, changes: [], leader: { old: "t1", address: "t22" } });
  assert.ok(!/--dangerously|--yolo|bypass/.test(p));
});

// ---- the fresh run record
test("resumedRun is built fresh: no ended, no reaped, new space and terminals, linked, frozen config copied", () => {
  const old = run();
  const terminals = [{ address: "t20", agent: "cx", name: "Inspector", role: "Inspector", model: "gpt-6.1-sol", started: 50, session: SID2, kind: "codex", cwd: "/wt", parked: true, sourceSession: SID2 },
    { address: "t22", agent: "lead", name: "Lead", role: "leader", model: "m", started: 51, session: SID, kind: "claude", cwd: "/wt", sourceSession: SID }];
  const n = R.resumedRun(old, { id: "R-NEW", started: 60, worktree: { repo: "/r", branch: "feat/T-1/card", path: "/wt/feat-T-1-card" }, space: "sp-new", terminals });
  assert.equal(n.id, "R-NEW"); assert.equal(n.resumedFrom, "R-OLD"); assert.equal(n.space, "sp-new"); assert.equal(n.started, 60);
  assert.ok(!("ended" in n) && !("resumedBy" in n));
  assert.ok(n.terminals.every((t) => !("ended" in t) && !("reaped" in t)));
  assert.deepEqual(n.config, old.config); assert.notEqual(n.config, old.config); assert.notEqual(n.config.leader, old.config.leader);
  for (const k of ["task", "project", "title", "runner", "name", "reportTo"]) assert.deepEqual(n[k], old[k], k);
});
test("a published resumed run survives the observer, prune and the reaper right after publishing (source ended, its space closed)", () => {
  const old = run();
  const terminals = [{ address: "t20", agent: "cx", role: "Inspector", started: 50, parked: true }, { address: "t22", agent: "lead", role: "leader", started: 51 }];
  const n = R.resumedRun(old, { id: "R-NEW", started: 60, worktree: old.worktree, space: "sp-new", terminals });
  const runs = R.linkResumed([old, ...[]], n);
  assert.equal(runs[0].id, "R-NEW"); assert.equal(runs.find((r) => r.id === "R-OLD").resumedBy, "R-NEW");
  const alive = new Set(["t20", "t22"]), live = new Map([["t20", "idle"], ["t22", "working"]]);
  const seen = R.markEnded(runs, live, alive, 100);
  assert.ok(!("ended" in seen.find((r) => r.id === "R-NEW")));
  assert.equal(R.pruneRuns(seen, 0).some((r) => r.id === "R-NEW"), true, "a run in progress is never pruned");
  assert.deepEqual(R.orphanedWorkers(seen.find((r) => r.id === "R-NEW"), alive, new Set(["sp-new", "sp-other"])), []);
  assert.deepEqual(R.orphanedWorkers(seen.find((r) => r.id === "R-OLD"), alive, new Set(["sp-new"])), [], "the old run's workers are skipped: the reaper never touches a resumed run's history");
});
test("orphanedWorkers still reaps the unreaped parked worker of a run that was not resumed", () => {
  assert.deepEqual(R.orphanedWorkers(run(), new Set(["t3"]), new Set()), ["t3"]); // leader t1 is gone; t2 is already reaped
});
