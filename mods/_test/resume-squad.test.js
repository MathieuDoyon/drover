// T-MWLGPS2QJQL S2: resumeSquad (whole squad), rollback, duplicates, cancel, recovery after a crash, the reaper, the inbox op.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { until, drain } from "./stubs/until.js";
import { makeSim, OK, SID } from "./stubs/resume-sim.js";

register("./hooks.js", import.meta.url);
const FROZEN = "claude --model claude-sonnet-5-5 --permission-mode auto";
const CURRENT = "claude --model claude-opus-5-5 --permission-mode auto";
const CODEX = "codex --no-daemon --model gpt-6.1-sol";
const CFG = { agents: [
  { id: "lead", name: "Lead", command: CURRENT, soul: "", instructions: "" },
  { id: "ins", name: "Inspector", command: CURRENT, soul: "", instructions: "" },
  { id: "rev", name: "Reviewer", command: CURRENT, soul: "", instructions: "" },
  { id: "cx", name: "Codex", command: CODEX, soul: "", instructions: "" }], squads: [] };
const T = (o) => ({ started: 1, ended: 5, kind: "claude", cwd: "/wt", ...o });
const OLD = (o = {}) => ({
  id: "R-OLD", task: "T-1", project: null, title: "Card", runner: { kind: "squad", id: "s" }, name: "Crew v1", space: "sp-old", started: 1, ended: 9, reportTo: null, worktree: null,
  config: { leader: { id: "lead", name: "Lead", command: FROZEN, role: "leader" }, members: [{ id: "ins", name: "Inspector", command: FROZEN, role: "Inspector" }, { id: "rev", name: "Reviewer", command: FROZEN, role: "Reviewer" }] },
  terminals: [T({ address: "t2", agent: "ins", name: "Inspector", role: "Inspector", session: SID.a, parked: true, model: "claude-sonnet-5-5" }),
    T({ address: "t3", agent: "rev", name: "Reviewer", role: "Reviewer", session: SID.b, parked: true, model: "claude-sonnet-5-5" }),
    T({ address: "t1", agent: "lead", name: "Lead", role: "leader", session: SID.lead, model: "claude-sonnet-5-5" })],
  ...o,
});
const CARD = (o = {}) => ({ id: "T-1", title: "Card", desc: "Do it", column: "review", agent: null, run: "R-OLD", priority: "P2", tags: [], created: 1, updated: 1, project: null, ...o });

let host, sim, tmp, io, S, R;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rs-"));
  io = await import("../_lib/io.js"); S = await import("../_lib/store.js"); R = await import("../_lib/runs.js");
  io.resumeSettle.tries = 6; io.resumeSettle.ms = 0; io.killSettle.tries = 3; io.killSettle.ms = 0; io.parkSettle.ms = 0; io.sessionSettle.tries = 3; io.sessionSettle.ms = 0;
  host = globalThis.__host = { appHome: "/app", home: tmp, props: {}, notified: [], agents: [], panes: [], spaces: [],
    state: { "drover.agents": CFG, "drover.runs": [OLD()], "drover.tasks": [CARD()] }, readTextFile: async () => null };
  sim = makeSim(host); sim.exists.add("/wt");
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const card = () => host.state["drover.tasks"].find((t) => t.id === "T-1");
const runs = () => host.state["drover.runs"];
const oldRun = () => runs().find((r) => r.id === "R-OLD");
const promptOf = (address) => sim.terms.get(address).task;
const RUNS0 = JSON.stringify([OLD()]);

test("happy path: members first, then the leader whose first message holds the exact new address map; members parked; run published and linked", async () => {
  const r = await io.resumeSquad("R-OLD");
  assert.equal(r.error, undefined);
  assert.deepEqual(sim.ops().slice(0, 3), ["space.new", "tab.new", "tab.new"], "the first terminal opens the run's own space");
  const [m1, m2, lead] = sim.opened();
  const leaderPrompt = promptOf(lead);
  for (const re of [new RegExp(`${m1} Inspector: Inspector \\(was t2\\)`), new RegExp(`${m2} Reviewer: Reviewer \\(was t3\\)`), /what changed/i, /every terminal address is new/i, new RegExp(`hc send ${m1}`)]) assert.match(leaderPrompt, re);
  assert.match(promptOf(m1), /resumed/i); assert.match(promptOf(m1), /wait for/i); assert.match(promptOf(m1), /git status/i);
  assert.deepEqual(sim.parked().sort(), [m1, m2].sort(), "members are parked, the leader keeps its tab");
  const n = r.run;
  assert.equal(n.resumedFrom, "R-OLD"); assert.ok(!("ended" in n));
  assert.deepEqual(n.terminals.map((t) => t.address), [m1, m2, lead]);
  assert.deepEqual(n.terminals.map((t) => t.parked === true), [true, true, false]);
  assert.ok(n.space.startsWith("sp-new"), "the space Herdr returned for this attempt");
  assert.equal(runs()[0].id, n.id); assert.equal(oldRun().resumedBy, n.id); assert.equal("ended" in oldRun(), true, "the old run stays history");
  assert.deepEqual({ agent: card().agent, run: card().run, column: card().column, token: card().claimToken, claimedAt: card().claimedAt ?? null }, { agent: lead, run: n.id, column: "doing", token: undefined, claimedAt: null });
  assert.equal(io.attemptOf("R-OLD"), null, "the attempt record is closed");
  for (const t of n.terminals) assert.equal(t.sourceSession, t.session);
});

test("T-MWMG01KB8MW: every resumed Claude terminal is labeled revive.session=<its session>", async () => {
  const r = await io.resumeSquad("R-OLD");
  assert.equal(r.error, undefined);
  const labels = sim.hc.filter((a) => a[0] === "label");
  const want = r.run.terminals.map((t) => ["label", t.address, `revive.session=${t.session}`]);
  assert.equal(want.length, 3);
  assert.deepEqual(labels.sort(), want.sort());
});

test("T-MWMG01KB8MW: after a frozen fallback only the terminal that stayed is labeled; a Codex terminal is not labeled by the resume itself", async () => {
  sim.plan.push({ status: () => "blocked", delivered: () => false }); // member 1: the current command fails, the frozen one is used
  host.state["drover.runs"] = [OLD({ terminals: [...OLD().terminals, T({ address: "t4", agent: "cx", name: "Codex", role: "Codex", kind: "codex", session: SID.a, parked: true })] })];
  const r = await io.resumeSquad("R-OLD");
  assert.equal(r.error, undefined);
  const labels = sim.hc.filter((a) => a[0] === "label").map((a) => a[1]);
  const claude = r.run.terminals.filter((t) => t.kind === "claude").map((t) => t.address);
  assert.deepEqual(labels.sort(), claude.sort(), "no label for the killed attempt, none for Codex");
});

test("what changed: a frozen fallback and a model change are told to the leader", async () => {
  sim.plan.push({ status: () => "blocked", delivered: () => false }); // member 1: the current command fails
  const r = await io.resumeSquad("R-OLD");
  assert.equal(r.error, undefined);
  const lead = sim.opened().at(-1);
  assert.match(promptOf(lead), /Inspector.*(saved command|frozen)/i);
  assert.match(promptOf(lead), /claude-opus-5-5.*claude-sonnet-5-5|claude-sonnet-5-5.*claude-opus-5-5/s, "the model change is named");
});

test("no half-built run: at every open the saved runs are untouched and the card is still CLAIMING", async () => {
  const seen = [];
  sim.onOpen = () => seen.push([JSON.stringify(runs()), card().agent, card().column]);
  await io.resumeSquad("R-OLD");
  assert.equal(seen.length, 3);
  for (const [rs, agent, column] of seen) { assert.equal(rs, RUNS0); assert.equal(agent, S.CLAIMING); assert.equal(column, "doing"); }
});

test("the durable attempt record lists each opened address as it opens (a crash after any open can be recovered)", async () => {
  const lens = [];
  sim.onOpen = () => lens.push(io.attemptOf("R-OLD").opened.length);
  await io.resumeSquad("R-OLD");
  assert.deepEqual(lens, [0, 1, 2], "each open sees the addresses of the opens before it already recorded");
});

test("guard refusals open nothing and claim nothing: Done, archived, deleted, resumed already, live agent", async () => {
  for (const [tasks, re] of [[[CARD({ column: "done" })], /Done/], [[CARD({ archived: true })], /archived/], [[], /not found|T-1/]]) {
    host.state["drover.tasks"] = tasks;
    assert.match((await io.resumeSquad("R-OLD")).error, re);
  }
  host.state["drover.tasks"] = [CARD()]; host.state["drover.runs"] = [OLD({ resumedBy: "R-NEW" })];
  assert.match((await io.resumeSquad("R-OLD")).error, /already resumed/);
  assert.equal(sim.opens().length, 0);
  assert.equal(card().agent, null);
});

test("an unknown live list (the host is not ready) is not 'nothing is running': refused", async () => {
  sim.empty.add(1); sim.empty.add(2);
  assert.match((await io.resumeSquad("R-OLD")).error, /not ready|unknown|Herdr/i);
  assert.equal(sim.opens().length, 0);
});

test("a card id resolves to its newest run", async () => {
  host.state["drover.runs"] = [OLD({ id: "R-OLDER", started: 0 }), OLD({ id: "R-NEWEST", started: 5 }), OLD({ id: "R-MID", started: 3 })];
  const r = await io.resumeSquad("T-1");
  assert.equal(r.run?.resumedFrom, "R-NEWEST");
});

test("two simultaneous resumes of one run: exactly one wins (run id and card id mixed: the CLI and the UI race)", async () => {
  let release; sim.gate = new Promise((r) => { release = r; });
  const a = io.resumeSquad("R-OLD"), b = io.resumeSquad("T-1"), c = io.resumeSquad("R-OLD");
  const second = await Promise.all([b, c]);
  assert.ok(second.every((x) => /already|claim|resum|starting/i.test(x.error)), JSON.stringify(second));
  release();
  assert.equal((await a).error, undefined);
  assert.equal(sim.opens().length, 3, "one agent set per card");
});

test("a click while the claim is held (the card is CLAIMING by another start) is refused and changes nothing", async () => {
  host.state["drover.tasks"] = [CARD({ agent: S.CLAIMING, claimedAt: Date.now() })];
  assert.match((await io.resumeSquad("R-OLD")).error, /already starting/);
  assert.equal(sim.opens().length, 0);
});

test("member 2 fails both commands: member 1 is killed, the claim released (column restored), the old run untouched; a second try succeeds", async () => {
  sim.plan.push(OK, { status: () => "blocked", delivered: () => false }, { status: () => "blocked", delivered: () => false });
  const before = JSON.stringify(runs());
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /Reviewer|blocked/);
  assert.deepEqual(sim.killed().sort(), sim.opened().sort(), "every terminal of the attempt is dead");
  assert.equal(sim.opened().length, 3, "member 1, then member 2 twice (current, frozen)");
  assert.equal(JSON.stringify(runs()), before, "old run untouched");
  assert.deepEqual({ agent: card().agent, column: card().column, token: card().claimToken, run: card().run }, { agent: null, column: "review", token: undefined, run: "R-OLD" });
  assert.equal(io.attemptOf("R-OLD"), null);
  assert.ok(host.notified.some((n) => /T-1/.test(`${n.title}${n.body}`)), "the failure is shown");
  assert.ok(sim.hc.every((a) => a[0] === "get" || a[0] === "label"), "nothing typed into any terminal");
  const again = await io.resumeSquad("R-OLD");
  assert.equal(again.error, undefined, "a retry works");
});

test("a blocked resumed terminal is a failed attempt that notifies the person and is never answered", async () => {
  sim.plan.push({ status: () => "blocked", delivered: () => false }, { status: () => "blocked", delivered: () => false });
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /blocked/);
  assert.ok(host.notified.some((n) => /blocked/i.test(n.body)), "notify says blocked");
  assert.ok(sim.hc.every((a) => a[0] === "get" || a[0] === "label"));
});

test("T-MWQGKMUG8R3: a member on Codex's Hooks trust screen fails the resume at once with that member and its old address named; nothing is typed", async () => {
  const SCREEN = "plugin contents changed; hook approval required\n6 hooks need review before they can run\nt trust all · enter review · esc close";
  sim.plan.push({ status: () => "running", delivered: () => false, screen: () => SCREEN });
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /Inspector \(t2\) did not resume: .*hooks trust screen/i);
  assert.equal(sim.opened().length, 1, "no fallback, no other member opened");
  assert.deepEqual(sim.killed(), sim.opened());
  assert.deepEqual(sim.hc.filter((a) => ["send", "keys", "key", "type"].includes(a[0])), []);
  assert.equal(io.attemptOf("R-OLD"), null, "rolled back as before");
});

test("the leader fails: every member is killed too, the claim is released, no run is saved", async () => {
  sim.plan.push(OK, OK, { status: () => "gone", delivered: () => false }, { status: () => "gone", delivered: () => false });
  const r = await io.resumeSquad("R-OLD");
  assert.ok(r.error);
  assert.deepEqual(sim.killed().sort(), sim.opened().sort());
  assert.equal(JSON.stringify(runs()), RUNS0);
  assert.equal(card().agent, null);
});

test("cancel during the barrier: this attempt's terminals die, the claim is released, nothing is published", async () => {
  sim.plan.push({ status: () => "idle", delivered: () => false });
  sim.onGet = () => io.cancelResume("R-OLD");
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /cancel|stopped/i);
  assert.equal(sim.opened().length, 1, "no fallback and no next member after the cancel");
  assert.deepEqual(sim.killed(), sim.opened());
  assert.equal(JSON.stringify(runs()), RUNS0);
  assert.deepEqual({ agent: card().agent, column: card().column }, { agent: null, column: "review" });
});
test("cancelResume answers false when no attempt runs", () => { assert.equal(io.cancelResume("R-OLD"), false); });

for (const [label, change, expectColumn] of [
  ["the card goes Done", () => { host.state["drover.tasks"] = [CARD({ column: "done", agent: S.CLAIMING, claimToken: "SET" })]; }, "done"],
  ["the card is archived", () => { host.state["drover.tasks"] = [CARD({ archived: true, agent: S.CLAIMING, claimToken: "SET" })]; }, null],
  ["the card is deleted", () => { host.state["drover.tasks"] = []; }, null],
]) {
  test(`${label} while the first member is polled: rollback of this attempt's terminals only`, async () => {
    sim.plan.push({ status: () => "idle", delivered: () => false });
    sim.onGet = () => { change(); const t = host.state["drover.tasks"][0]; if (t?.claimToken === "SET") host.state["drover.tasks"] = [{ ...t, claimToken: io.attemptOf("R-OLD")?.id }]; };
    const r = await io.resumeSquad("R-OLD");
    assert.ok(r.error);
    assert.equal(sim.opened().length, 1);
    assert.deepEqual(sim.killed(), sim.opened());
    assert.equal(JSON.stringify(runs()), RUNS0);
    if (expectColumn) assert.equal(card().column, expectColumn, "the owner's Done is never undone");
    if (card()) assert.notEqual(card().agent, S.CLAIMING, "the claim is released");
    assert.equal(card()?.run === "R-OLD" || card() === undefined, true, "never re-staffed");
  });
}
test("the claim is replaced by someone else mid-attempt: rollback, and the replacement claim is left alone", async () => {
  sim.plan.push({ status: () => "idle", delivered: () => false });
  sim.onGet = () => { host.state["drover.tasks"] = [CARD({ agent: S.CLAIMING, claimedAt: Date.now(), column: "doing", claimToken: "SOMEONE-ELSE" })]; };
  const r = await io.resumeSquad("R-OLD");
  assert.ok(r.error);
  assert.deepEqual(sim.killed(), sim.opened());
  assert.deepEqual({ agent: card().agent, token: card().claimToken }, { agent: S.CLAIMING, token: "SOMEONE-ELSE" });
});

test("the card goes Done while the LEADER is polled (after members opened): all die, no run, Done kept", async () => {
  sim.plan.push(OK, OK, { status: () => "idle", delivered: () => false });
  sim.onGet = (a) => { if (a === "t103") host.state["drover.tasks"] = [{ ...card(), column: "done" }]; };
  const r = await io.resumeSquad("R-OLD");
  assert.ok(r.error);
  assert.deepEqual(sim.killed().sort(), sim.opened().sort());
  assert.equal(card().column, "done");
  assert.equal(JSON.stringify(runs()), RUNS0);
});

test("worktree refused (the main repo is gone): nothing opens, the claim is released, the reason is returned", async () => {
  host.state["drover.runs"] = [OLD({ worktree: { repo: "/r", branch: "feat/T-1/card", path: "/wt/feat-T-1-card" } })];
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /repo \/r is gone/);
  assert.equal(sim.opens().length, 0);
  assert.equal(card().agent, null); assert.equal(io.attemptOf("R-OLD"), null);
});

test("worktree gone is recreated from the branch, told to the leader, and recorded on the new run", async () => {
  const wt = { repo: "/r", branch: "feat/T-1/card", path: "/wt/feat-T-1-card" };
  host.state["drover.runs"] = [OLD({ worktree: wt })];
  sim.exists.add("/r");
  let added = false;
  sim.git = (args) => {
    if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: added ? `worktree /r\nbranch refs/heads/main\n\nworktree ${wt.path}\nbranch refs/heads/${wt.branch}\n` : "worktree /r\nbranch refs/heads/main\n", stderr: "" };
    if (args[0] === "show-ref") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "worktree" && args[1] === "add") { added = true; sim.exists.add(wt.path); return { code: 0, stdout: "", stderr: "" }; }
    return { code: 1, stdout: "", stderr: "unexpected git" };
  };
  const r = await io.resumeSquad("R-OLD");
  assert.equal(r.error, undefined);
  assert.match(promptOf(sim.opened().at(-1)), /worktree was recreated from branch feat\/T-1\/card/);
  assert.deepEqual(r.run.worktree, wt);
  assert.equal(sim.opens()[0][1][sim.opens()[0][1].indexOf("--folder") + 1], wt.path);
});

test("Codex: the first message carries a discovery marker; a NEW rollout id replaces `session` only while it equals the resumed id (sourceSession stays)", async () => {
  const NEW = "00000000-aaaa-4bbb-8ccc-111111111111";
  host.state["drover.runs"] = [OLD({ terminals: OLD().terminals.map((t) => (t.address === "t2" ? { ...t, kind: "codex", agent: "cx", session: SID.a } : t)),
    config: { ...OLD().config, members: [{ id: "cx", name: "Codex", command: CODEX, role: "Inspector" }, OLD().config.members[1]] } })];
  sim.search = (cmd, args) => {
    if (cmd === "ls") return { code: 0, stdout: args.filter((a) => !a.startsWith("-")).join("\n"), stderr: "" };
    const token = args[args.indexOf("-e") + 1];
    return /drover-launch-marker/.test(promptOf(sim.opened()[0]) ?? "") && promptOf(sim.opened()[0]).includes(token)
      ? { code: 0, stdout: `/h/.codex/sessions/2026/11/17/rollout-2026-11-17T10-00-00-${NEW}.jsonl\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
  };
  host.state["drover.agents"] = { ...CFG, agents: CFG.agents.map((a) => (a.id === "ins" ? a : a)) };
  const r = await io.resumeSquad("R-OLD");
  assert.equal(r.error, undefined);
  assert.deepEqual(sim.terms.get(sim.opened()[0]).argv.slice(0, 3), ["codex", "resume", SID.a]);
  await until(() => runs()[0].terminals[0].session === NEW, "the new codex session was discovered");
  assert.equal(runs()[0].terminals[0].sourceSession, SID.a);
  assert.equal(oldRun().terminals[0].session, SID.a, "history untouched");
});

test("the reaper: an orphan tick after the resume never kills the new squad, and the old run's workers are skipped", async () => {
  const r = await io.resumeSquad("R-OLD");
  host.spaces = [{ id: r.run.space, tabs: [] }];
  const killsBefore = sim.killed().length;
  io.observeEnded(10 ** 12);
  await drain();
  assert.equal(sim.killed().length, killsBefore, "no kill after the resume (new run: leader alive; old run: resumedBy)");
  assert.ok(!("ended" in runs()[0]));
});

// ---- recovery after a crash: durable attempt record
const crashed = (opened, o = {}) => {
  host.state["drover.resumes"] = { "R-OLD": { id: "A-1", token: "TOK", card: "T-1", started: 0, opened, prev: { column: "review" }, ...o } };
  host.state["drover.tasks"] = [CARD({ column: "doing", agent: S.CLAIMING, claimedAt: 0, claimToken: "A-1" })];
};
const orphan = (address, token) => sim.terms.set(address, { b: OK, reads: 0, killed: false, argv: ["claude"], task: token ? `hi\n\ndrover-resume-attempt: ${token}` : "hi" });

test("reconcile never expires a claim held by a live attempt (holds), and clears the claim identity when it does expire", () => {
  const t = [CARD({ column: "doing", agent: S.CLAIMING, claimedAt: 0, claimToken: "A-1", project: null })];
  assert.deepEqual(R.reconcile(t, [], new Set(), 1e15, null, new Set(["T-1"])).lines, [], "held: not expired");
  const out = R.reconcile(t, [], new Set(), 1e15, null, new Set());
  assert.deepEqual(out.lines, ["expired T-1"]); assert.equal(out.tasks[0].claimToken, undefined);
});
test("reconcile still adopts the run of an ORDINARY launch that crashed before the card update", () => {
  const n = { id: "R-ORD", task: "T-1", started: 100, terminals: [{ address: "t8", role: "Inspector", started: 100 }, { address: "t9", role: "leader", started: 100 }] };
  const out = R.reconcile([CARD({ column: "doing", agent: S.CLAIMING, claimedAt: 50 })], [n], new Set(["t9"]), 200, null);
  assert.deepEqual(out.lines, ["adopted T-1 R-ORD"]);
  assert.equal(out.tasks[0].agent, "t9");
});
test("reconcile skips a resume-held card BEFORE adoption and expiry: a manual Recover is the only way out", () => {
  const n = R.resumedRun(OLD(), { id: "R-NEW", started: 100, worktree: null, space: "s", terminals: [{ address: "t8", role: "Inspector", started: 100 }, { address: "t9", role: "leader", started: 100 }] });
  const t = [CARD({ column: "doing", agent: S.CLAIMING, claimedAt: 50, claimToken: "A-1" })];
  for (const now of [200, 1e15]) {
    const out = R.reconcile(t, [{ ...n, resumeAttempt: "A-1" }, OLD()], new Set(["t9"]), now, null, new Set(["T-1"]));
    assert.deepEqual(out.lines, [], `now=${now}`);
    assert.deepEqual({ agent: out.tasks[0].agent, token: out.tasks[0].claimToken }, { agent: S.CLAIMING, token: "A-1" });
  }
});

// ---- the inbox op (the CLI path)
test("inbox op resume answers ok with the new run and leader; op resume --cancel answers for an attempt; a bad ref is an error", async () => {
  const dir = path.join(tmp, "data/drover-inbox");
  host.appHome = tmp; await fs.mkdir(dir, { recursive: true });
  host.watchFolder = () => new Promise(() => {});
  const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) };
  let n = 0;
  const ask = async (cmd) => { const name = `r${++n}`; await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(cmd)); io.watchInbox(cx); return until(() => fs.readFile(path.join(dir, `${name}.result`), "utf8").catch(() => false), `answer ${name}`); };
  assert.match(await ask({ op: "resume", ref: "nonsense" }), /^error: /);
  assert.match(await ask({ op: "resume", ref: "R-OLD", cancel: true }), /^error: no resume in progress/);
  assert.match(await ask({ op: "resume", ref: "R-OLD" }), /^ok: R-[A-Z0-9]+ leader t10\d \(Lead\) · Inspector t10\d · Reviewer t10\d/);
  assert.match(await ask({ op: "resume", ref: "R-OLD" }), /^error: .*already resumed/);
});

// ======== S2 review (T-MWLGPS2QJQL): scenarios A-H ========
const hcWith = (f) => { const base = host.hc; host.hc = async (args) => f(args) ?? base(args); };
const alive = (address, token = "TOK") => sim.terms.set(address, { b: OK, reads: 0, killed: false, argv: ["claude"], task: `hi\n\ndrover-resume-attempt: ${token}` });

test("B: the committed run carries the attempt id it was made by", async () => {
  const r = await io.resumeSquad("R-OLD");
  assert.ok(r.run.resumeAttempt, "bound to its attempt");
  assert.equal(runs()[0].resumeAttempt, r.run.resumeAttempt);
});

// C: an in-flight launch intent
test("C: the launch intent is persisted BEFORE each open and cleared once its address is recorded", async () => {
  const at = [];
  sim.onOpen = () => at.push(io.attemptOf("R-OLD").launching);
  await io.resumeSquad("R-OLD");
  assert.equal(at.length, 3); assert.ok(at.every(Boolean), "set before every open");
});
// D: moving the card
for (const column of ["backlog", "todo", "review", "blocked"]) {
  test(`D: the owner moves the card to ${column} while a member is polled: abort, that column is kept, never forced back to doing`, async () => {
    sim.plan.push({ status: () => "idle", delivered: () => false });
    sim.onGet = () => { host.state["drover.tasks"] = [{ ...card(), column }]; };
    const r = await io.resumeSquad("R-OLD");
    assert.match(r.error, /moved/i);
    assert.deepEqual(sim.killed(), sim.opened());
    assert.deepEqual({ column: card().column, agent: card().agent, run: card().run }, { column, agent: null, run: "R-OLD" });
    assert.equal(JSON.stringify(runs()), RUNS0);
  });
}

// G: the final barrier
test("G: an earlier member dies while the next terminal opens: no success is published", async () => {
  let dead = false;
  sim.plan.push({ status: () => (dead ? "gone" : "idle"), delivered: () => true });
  let opens = 0; sim.onOpen = () => { if (++opens === 2) dead = true; };
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /Inspector|exited|gone/i);
  assert.equal(JSON.stringify(runs()), RUNS0);
  assert.equal(card().agent, null);
});
test("G: the new leader dies while members are being parked: no success is published, everything is killed", async () => {
  let dead = false;
  sim.plan.push(OK, OK, { status: () => (dead ? "gone" : "idle"), delivered: () => true });
  sim.onPark = () => { dead = true; };
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /Lead|exited|gone/i);
  assert.equal(JSON.stringify(runs()), RUNS0);
  assert.equal(card().agent, null);
  assert.ok(sim.killed().length >= 2);
});
test("G: a member that becomes blocked after its own barrier stops the resume", async () => {
  let blocked = false;
  sim.plan.push({ status: () => (blocked ? "blocked" : "idle"), delivered: () => true });
  let opens = 0; sim.onOpen = () => { if (++opens === 3) blocked = true; };
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /blocked/i);
  assert.equal(JSON.stringify(runs()), RUNS0);
});

// H: one consumer: cancel while a resume is pending
test("H: with ONE inbox consumer, a queued `resume --cancel` is answered while the resume is held, and the resume then ends cancelled", async () => {
  const dir = path.join(tmp, "data/drover-inbox");
  host.appHome = tmp; await fs.mkdir(dir, { recursive: true });
  host.watchFolder = () => new Promise(() => {});
  const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) };
  let release; sim.gate = new Promise((r) => { release = r; });
  const ask = async (name, cmd) => { await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(cmd)); io.watchInbox(cx); return until(() => fs.readFile(path.join(dir, `${name}.result`), "utf8").catch(() => false), `answer ${name}`); };
  const start = ask("h1", { op: "resume", ref: "R-OLD" });
  await until(() => sim.opens().length === 1, "the first open is held");
  assert.match(await ask("h2", { op: "resume", ref: "R-OLD", cancel: true }), /^ok: cancel requested/);
  release();
  assert.match(await start, /^error: .*(cancel|stopped)/i);
  assert.equal(JSON.stringify(runs()), RUNS0);
});

// ======== S2-B: no automatic recovery; one manual, fenced Recover / Cancel ========
const lapsed = (opened, o = {}) => crashed(opened, { heartbeat: 0, started: 0, ...o });
const publishedRun = (cardState, attempt = "A-1") => {
  lapsed(["t5", "t6"]); // the attempt record the crash left
  const n = R.resumedRun(OLD(), { id: "R-NEW", started: 100, worktree: null, space: "sp-n", terminals: [
    { address: "t5", agent: "ins", name: "Inspector", role: "Inspector", started: 100, parked: true }, { address: "t6", agent: "lead", name: "Lead", role: "leader", started: 100 }] });
  host.state["drover.runs"] = [{ ...n, resumeAttempt: attempt }, { ...OLD(), resumedBy: "R-NEW" }];
  host.state["drover.tasks"] = [cardState];
  alive("t5"); alive("t6");
};
const CLAIMED = (o = {}) => CARD({ column: "doing", agent: S.CLAIMING, claimedAt: 0, claimToken: "A-1", ...o });

test("S2-B state: none / live / needs-recovery / recovering, derived from the record and the in-process set", async () => {
  assert.equal(io.resumeState("R-OLD"), "none");
  lapsed(["t5"]);
  assert.equal(io.resumeState("R-OLD"), "needs-recovery");
  crashed(["t5"], { heartbeat: Date.now() });
  assert.equal(io.resumeState("R-OLD"), "live");
  crashed(["t5"], { heartbeat: Date.now(), recovering: true });
  assert.equal(io.resumeState("R-OLD"), "recovering");
});

test("S2-B: NOTHING recovers by itself: observeEnded ticks never kill or free a lapsed attempt", async () => {
  lapsed(["t5"]); alive("t5");
  for (let i = 0; i < 3; i++) { io.observeEnded(2e12 + i); await drain(); }
  assert.deepEqual(sim.killed(), []);
  assert.equal(card().agent, S.CLAIMING); assert.ok(io.attemptOf("R-OLD"));
  assert.equal(io.recoverResumes, undefined, "the tick action is gone, not dormant");
});

test("Recover after a crash with members opened: owned terminals are killed (a foreign one is not), the claim is released, the record closed", async () => {
  lapsed(["t5", "t6"]); alive("t5"); orphan("t6", "OTHER");
  const r = await io.recoverResume("R-OLD");
  assert.match(r.ok, /t5/);
  assert.deepEqual(sim.killed(), ["t5"]);
  assert.deepEqual({ agent: card().agent, column: card().column, token: card().claimToken }, { agent: null, column: "review", token: undefined });
  assert.equal(io.attemptOf("R-OLD"), null);
  assert.equal((await io.resumeSquad("R-OLD")).error, undefined, "after a recover the card can be resumed again");
});
test("Recover after a crash before the first open (nothing recorded): releases the claim", async () => {
  lapsed([]);
  assert.ok((await io.recoverResume("R-OLD")).ok);
  assert.equal(card().agent, null); assert.equal(io.attemptOf("R-OLD"), null);
});
test("Recover with a launch intent: a terminal spawned but never recorded is found by token and killed", async () => {
  lapsed([], { launching: 500 }); alive("t7");
  const r = await io.recoverResume("R-OLD");
  assert.ok(r.ok); assert.deepEqual(sim.killed(), ["t7"]);
});
test("Recover with a launch intent and nothing found says so: an open may still land later (close it by hand)", async () => {
  lapsed([], { launching: 500 });
  const r = await io.recoverResume("R-OLD");
  assert.match(r.ok, /in flight|may still|by hand/i);
  assert.equal(card().agent, null);
});
test("Recover: a crash after the run was saved but before the card update ADOPTS (card -> new leader and run), kills nothing", async () => {
  publishedRun(CLAIMED());
  const r = await io.recoverResume("R-OLD");
  assert.match(r.ok, /adopted|R-NEW/);
  assert.deepEqual(sim.killed(), []);
  assert.deepEqual({ agent: card().agent, run: card().run, column: card().column, token: card().claimToken }, { agent: "t6", run: "R-NEW", column: "doing", token: undefined });
  assert.equal(io.attemptOf("R-OLD"), null);
});
test("Recover: a crash after BOTH writes but before the record was closed: nothing killed, record closed", async () => {
  publishedRun(CARD({ column: "doing", agent: "t6", run: "R-NEW" }));
  host.state["drover.resumes"] = { "R-OLD": { id: "A-1", token: "TOK", attemptIds: ["A-1"], card: "T-1", started: 0, heartbeat: 0, opened: ["t5", "t6"], prev: { column: "review" } } };
  assert.ok((await io.recoverResume("R-OLD")).ok);
  assert.deepEqual(sim.killed(), []); assert.equal(io.attemptOf("R-OLD"), null); assert.equal(card().agent, "t6");
});
test("Recover: a run published by ANOTHER attempt does not protect this attempt's terminals", async () => {
  publishedRun(CLAIMED(), "A-OTHER");
  host.state["drover.resumes"]["R-OLD"] = { id: "A-1", token: "TOK", attemptIds: ["A-1"], card: "T-1", started: 0, heartbeat: 0, opened: ["t5", "t6"], prev: { column: "review" } };
  await io.recoverResume("R-OLD");
  assert.deepEqual(sim.killed().sort(), ["t5", "t6"]);
});
for (const [label, cardState, expect] of [
  ["Done", () => CLAIMED({ column: "done" }), { column: "done" }], ["moved to backlog", () => CLAIMED({ column: "backlog" }), { column: "backlog" }],
  ["moved to review", () => CLAIMED({ column: "review" }), { column: "review" }], ["archived", () => CLAIMED({ archived: true }), { column: "doing" }],
]) {
  test(`Recover: a published squad whose card was ${label} is NOT adopted: its terminals are killed, its run removed, the owner's choice kept`, async () => {
    publishedRun(cardState());
    const r = await io.recoverResume("R-OLD");
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(sim.killed().sort(), ["t5", "t6"]);
    assert.equal(runs().some((x) => x.id === "R-NEW"), false, "the published squad is cleaned up");
    assert.equal("resumedBy" in oldRun(), false, "the old run is history again");
    assert.equal(card().column, expect.column); assert.notEqual(card().agent, S.CLAIMING); assert.notEqual(card().run, "R-NEW");
    assert.equal(io.attemptOf("R-OLD"), null);
  });
}
test("Recover: the card goes Done WHILE the ownership reads run: the kill still happens, the release keeps Done", async () => {
  lapsed(["t5"]); alive("t5");
  sim.onGet = (a) => { if (a === "t5") host.state["drover.tasks"] = [{ ...card(), column: "done" }]; };
  const r = await io.recoverResume("R-OLD");
  assert.ok(r.ok);
  assert.deepEqual({ column: card().column, agent: card().agent }, { column: "done", agent: null });
});
test("Recover: a double click runs once; the second is refused", async () => {
  lapsed(["t5"]); alive("t5");
  const both = await Promise.all([io.recoverResume("R-OLD"), io.recoverResume("R-OLD")]);
  assert.equal(both.filter((x) => x.ok).length, 1, JSON.stringify(both));
  assert.match(both.find((x) => x.error).error, /already|recover/i);
  assert.deepEqual(sim.killed(), ["t5"], "one kill only");
});
test("Recover is refused while the resume is running in this window (cancel it instead), and while the heartbeat is fresh", async () => {
  let release; sim.gate = new Promise((r) => { release = r; });
  const p = io.resumeSquad("R-OLD");
  await until(() => sim.opens().length === 1, "held at the first open");
  assert.match((await io.recoverResume("R-OLD")).error, /running|cancel/i);
  release(); await p;
  crashed(["t5"], { heartbeat: Date.now() });
  assert.match((await io.recoverResume("R-OLD")).error, /still|running|heartbeat/i);
});
test("Recover with ownership unknown (failed, throwing or malformed read) keeps the claim and the record, and a later click works", async () => {
  for (const [label, reply] of [["nonzero", () => ({ code: 1, stdout: "", stderr: "x" })], ["throws", () => { throw new Error("hc died"); }], ["malformed", () => ({ code: 0, stdout: "{no", stderr: "" })]]) {
    lapsed(["t5"]); alive("t5");
    const before = host.hc; hcWith((a) => (a[0] === "get" && a[1] === "t5" ? reply() : undefined));
    const r = await io.recoverResume("R-OLD");
    assert.match(r.error, /whose|unknown|tell/i, label);
    assert.deepEqual(sim.killed(), [], label); assert.equal(card().agent, S.CLAIMING, label);
    assert.equal(io.resumeState("R-OLD"), "needs-recovery", `${label}: it can be tried again at once`);
    host.hc = before;
    assert.ok((await io.recoverResume("R-OLD")).ok, `${label}: retry works`);
    sim.terms.clear(); sim.calls.length = 0;
  }
});
test("Recover with an unreadable terminal list changes nothing and can be tried again", async () => {
  lapsed(["t5"]); alive("t5"); sim.empty.add(1); sim.empty.add(2);
  assert.match((await io.recoverResume("R-OLD")).error, /not ready|list/i);
  assert.deepEqual(sim.killed(), []); assert.equal(io.resumeState("R-OLD"), "needs-recovery");
});
test("Recover with a kill that cannot be confirmed keeps the claim and the record", async () => {
  lapsed(["t5"]); sim.terms.set("t5", { b: { ...OK, killFails: true }, reads: 0, killed: false, argv: ["claude"], task: "x\ndrover-resume-attempt: TOK" });
  assert.match((await io.recoverResume("R-OLD")).error, /confirm|alive/i);
  assert.equal(card().agent, S.CLAIMING); assert.ok(io.attemptOf("R-OLD"));
});
test("Cancel of a crashed attempt (abandon) never adopts: it cleans up even a squad the attempt had published", async () => {
  publishedRun(CLAIMED());
  const r = await io.recoverResume("R-OLD", { adopt: false });
  assert.ok(r.ok);
  assert.deepEqual(sim.killed().sort(), ["t5", "t6"]); assert.equal(runs().some((x) => x.id === "R-NEW"), false);
  assert.equal(card().agent, null); assert.equal(card().column, "review");
});
test("fence: an attempt whose record/claim was taken over stops, kills only its own terminals and never touches the successor's record or claim", async () => {
  sim.plan.push({ status: () => "idle", delivered: () => false });
  sim.onGet = () => { // another window's Recover took over: new id in the record, new token on the claim
    host.state["drover.resumes"] = { "R-OLD": { ...io.attemptOf("R-OLD"), id: "A-SUCC", recovering: true } };
    host.state["drover.tasks"] = [{ ...card(), claimToken: "A-SUCC" }];
  };
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /replaced|claim/i);
  assert.deepEqual(sim.killed(), sim.opened());
  assert.equal(io.attemptOf("R-OLD").id, "A-SUCC", "the successor's record stays");
  assert.deepEqual({ agent: card().agent, token: card().claimToken }, { agent: S.CLAIMING, token: "A-SUCC" });
});
test("final barrier: a terminal list that is unknown after parking is a FAILURE (bounded retry), never a pass", async () => {
  sim.onPark = () => { sim.blackout = true; };
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /not ready|could not confirm|list/i);
  assert.equal(JSON.stringify(runs()), RUNS0);
});
test("final barrier: a short blackout after parking is retried and the resume still succeeds", async () => {
  sim.onPark = () => { sim.empty.add(sim.snap + 1); sim.empty.add(sim.snap + 2); };
  const r = await io.resumeSquad("R-OLD");
  assert.equal(r.error, undefined);
});
test("the inbox ops: resume --recover recovers, resume --cancel on a crashed attempt abandons it", async () => {
  const dir = path.join(tmp, "data/drover-inbox");
  host.appHome = tmp; await fs.mkdir(dir, { recursive: true });
  host.watchFolder = () => new Promise(() => {});
  const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) };
  let n = 0;
  const ask = async (cmd) => { const name = `s${++n}`; await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(cmd)); io.watchInbox(cx); return until(() => fs.readFile(path.join(dir, `${name}.result`), "utf8").catch(() => false), `answer ${name}`); };
  assert.match(await ask({ op: "resume", ref: "R-OLD", recover: true }), /^error: no resume to recover/);
  lapsed(["t5"]); alive("t5");
  assert.match(await ask({ op: "resume", ref: "R-OLD", recover: true }), /^ok: /);
  lapsed(["t5"]); sim.terms.clear(); alive("t5");
  assert.match(await ask({ op: "resume", ref: "R-OLD", cancel: true }), /^ok: /);
  assert.equal(io.attemptOf("R-OLD"), null);
});

// ======== S2-B review ========
test("Cancel (adopt:false) cleans a published squad even when BOTH publish writes landed, clearing only that squad's card ownership", async () => {
  publishedRun(CARD({ column: "doing", agent: "t6", run: "R-NEW" }));
  const r = await io.recoverResume("R-OLD", { adopt: false });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(sim.killed().sort(), ["t5", "t6"]);
  assert.equal(runs().some((x) => x.id === "R-NEW"), false);
  assert.equal("resumedBy" in oldRun(), false);
  assert.deepEqual({ agent: card().agent, run: card().run, column: card().column }, { agent: null, run: "R-OLD", column: "review" }, "the card is back on the old run, in the column it came from");
  assert.equal(io.attemptOf("R-OLD"), null);
});
test("Cancel after both writes keeps a LATER owner choice: a card moved on to Review stays there, only the squad's ownership is cleared", async () => {
  publishedRun(CARD({ column: "review", agent: "t6", run: "R-NEW" }));
  assert.ok((await io.recoverResume("R-OLD", { adopt: false })).ok);
  assert.deepEqual({ agent: card().agent, run: card().run, column: card().column }, { agent: null, run: "R-OLD", column: "review" });
});
test("Cancel after both writes does not touch a card another squad has taken since", async () => {
  publishedRun(CARD({ column: "doing", agent: "t77", run: "R-OTHER" }));
  assert.ok((await io.recoverResume("R-OLD", { adopt: false })).ok);
  assert.deepEqual({ agent: card().agent, run: card().run }, { agent: "t77", run: "R-OTHER" });
});
test("Recover (adopt) after both writes still just closes the record", async () => {
  publishedRun(CARD({ column: "doing", agent: "t6", run: "R-NEW" }));
  assert.match((await io.recoverResume("R-OLD")).ok, /already complete/);
  assert.deepEqual(sim.killed(), []); assert.equal(card().agent, "t6");
});

test("the commit-time guard rejects an UNKNOWN list when new terminals exist: a blackout right after the group check never publishes", async () => {
  // verifyGroup reads the list 2 + 2 x (3 new terminals) = 8 times after the last park; every read after that is unknown (what must/stop sees).
  sim.onPark = () => { for (let i = 9; i < 60; i++) sim.empty.add(sim.snap + i); };
  const r = await io.resumeSquad("R-OLD");
  assert.match(r.error, /not ready|could not confirm|list/i);
  assert.equal(JSON.stringify(runs()), RUNS0);
});

test("the real `next` op never adopts, frees or re-staffs a resume-held card (a Done card stays Done, claimed until Recover)", async () => {
  const dir = path.join(tmp, "data/drover-inbox");
  host.appHome = tmp; await fs.mkdir(dir, { recursive: true });
  host.watchFolder = () => new Promise(() => {});
  const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) };
  let n = 0;
  const ask = async (cmd) => { const name = `n${++n}`; await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(cmd)); io.watchInbox(cx); return until(() => fs.readFile(path.join(dir, `${name}.result`), "utf8").catch(() => false), `answer ${name}`); };
  for (const column of ["doing", "done"]) {
    lapsed(["t5", "t6"]);
    host.state["drover.projects"] = [{ id: "P-1", name: "P", repos: [{ path: "/r", default: true }], folders: [], branch: "main" }];
    const nrun = { ...R.resumedRun(OLD(), { id: "R-NEW", started: 100, worktree: null, space: "s", terminals: [{ address: "t5", role: "Inspector", started: 100 }, { address: "t6", role: "leader", started: 100 }] }), resumeAttempt: "A-1" };
    host.state["drover.runs"] = [nrun, { ...OLD(), project: "P-1", resumedBy: "R-NEW" }, { id: "R-D", task: null, project: "P-1", started: 1, terminals: [{ address: "t0", agent: "drover", name: "Drover", role: "leader", started: 1 }] }];
    host.state["drover.tasks"] = [CARD({ column, agent: S.CLAIMING, claimedAt: 0, claimToken: "A-1", project: "P-1" })];
    await ask({ op: "next", from: "t0" });
    assert.deepEqual({ agent: card().agent, run: card().run, column: card().column, token: card().claimToken }, { agent: S.CLAIMING, run: "R-OLD", column, token: "A-1" }, column);
    assert.ok(io.attemptOf("R-OLD"), "the record stays: only a manual Recover ends it");
  }
});

test("Cancel after both writes leaves a NEWER in-flight ordinary claim alone (a real store.claim keeps run = the old squad's run until its launch saves)", async () => {
  publishedRun(CARD({ column: "review", agent: "t6", run: "R-NEW" }));
  const c = S.claim(host.state["drover.tasks"], "T-1", undefined, undefined, new Set()); // the old squad is gone: an ordinary start claims the card
  assert.equal(c.error, undefined);
  host.state["drover.tasks"] = c.tasks;
  const before = JSON.stringify(card());
  assert.equal(card().run, "R-NEW", "claim() keeps the old run reference while the new launch is in flight");
  assert.equal(card().agent, S.CLAIMING);
  assert.ok((await io.recoverResume("R-OLD", { adopt: false })).ok);
  assert.equal(JSON.stringify(card()), before, "the in-flight claim's card state is untouched");
  assert.deepEqual(sim.killed().sort(), ["t5", "t6"], "the old published squad is still cleaned up");
});
test("Cancel after both writes undoes only when the agent is the published leader or already cleared", async () => {
  publishedRun(CARD({ column: "doing", agent: null, run: "R-NEW" }));
  assert.ok((await io.recoverResume("R-OLD", { adopt: false })).ok);
  assert.deepEqual({ agent: card().agent, run: card().run, column: card().column }, { agent: null, run: "R-OLD", column: "review" });
  publishedRun(CARD({ column: "doing", agent: "t55", run: "R-NEW" }));
  assert.ok((await io.recoverResume("R-OLD", { adopt: false })).ok);
  assert.deepEqual({ agent: card().agent, run: card().run }, { agent: "t55", run: "R-NEW" }, "another agent owns it: not undone");
});

test("T-MWM5CE02H07: a refused resume (guard error before any open) is shown to the person, not only returned", async () => {
  host.state["drover.tasks"] = [CARD({ column: "done" })];
  const r = await io.resumeSquad("R-OLD");
  assert.ok(r.error, "refused");
  assert.ok(host.notified.some((n) => n.level === "error" && n.body.includes(r.error)), `notified: ${JSON.stringify(host.notified)}`);
  const q = await io.resumeSquad("R-OLD", { quiet: true });
  assert.ok(q.error);
  assert.equal(host.notified.length, 1, "quiet (the CLI) prints the error itself: no toast");
});
test("T-MWM5CE02H07: a just-opened member missing from the cached list is not 'exited': the whole squad resumes", async () => {
  sim.plan.push({ status: () => "working", delivered: () => true, lag: 999 });
  const r = await io.resumeSquad("R-OLD");
  assert.equal(r.error, undefined, r.error);
});

// ---- T-MWMIQMBO1BQ: Resume of a Review/Blocked card while its project is at full capacity (limit 2, two live bystander squads on In progress cards).
// A resume is an owner action: it is never refused by the slot limit, its claim counts while in flight, and no bystander terminal is ever touched.
const P1 = "P-1";
function fullProject(column) {
  const bystander = (n, addr) => ({ id: `R-B${n}`, task: `T-B${n}`, project: P1, started: 2, reportTo: "t81", terminals: [{ address: addr, agent: "wrangler", name: "W", role: "leader", started: 2 }] });
  const bcard = (n) => ({ ...CARD({ id: `T-B${n}`, title: `by ${n}`, column: "doing", run: `R-B${n}`, agent: `t1${n}` }), project: P1 });
  host.state["drover.projects"] = [{ id: P1, name: "P", repos: [], folders: [], branch: "main" }];
  host.state["drover.runs"] = [OLD({ project: P1 }), bystander(1, "t11"), bystander(2, "t12")];
  host.state["drover.tasks"] = [CARD({ project: P1, column }), bcard(1), bcard(2)];
  for (const a of ["t11", "t12"]) sim.terms.set(a, { b: OK, reads: 0, killed: false, argv: [], task: "" });
}
// The slot numbers of P-1 as the guard sees them right now (a fixed alive set: reading host.terminals would advance the simulator).
const slots = () => {
  const alive = new Set(["t11", "t12", ...sim.opened().filter((a) => !sim.terms.get(a).killed)]);
  return R.slotsOf(R.slotSnapshot(runs(), host.state["drover.tasks"], new Map(), alive, 2), P1);
};
const bystanders = () => JSON.stringify(runs().filter((r) => r.id.startsWith("R-B")));

for (const column of ["review", "blocked"]) {
  test(`resume at capacity, ${column}: not refused; the claim counts while in flight (over the limit); both bystander squads survive unchanged`, async () => {
    fullProject(column);
    const by0 = bystanders(), aliveBefore = sim.terms.size;
    assert.deepEqual(slots(), { active: 2, waiting: 0, free: 0 }, "full before the resume (the gone old run holds nothing)");
    const inFlight = [];
    sim.onOpen = () => inFlight.push({ ...slots(), agent: card().agent, column: card().column });
    const r = await io.resumeSquad("R-OLD");
    assert.equal(r.error, undefined, "an owner's resume is not refused by the slot limit");
    assert.ok(inFlight.length >= 1);
    for (const s of inFlight) assert.deepEqual(s, { active: 3, waiting: 0, free: 0, agent: S.CLAIMING, column: "doing" }, "the claim counts at once: 2 squads + the claim, over the limit");
    assert.deepEqual(slots(), { active: 3, waiting: 0, free: 0 }, "after: the new run counts once (not twice)");
    assert.equal(bystanders(), by0, "bystander runs unchanged");
    assert.ok(!sim.killed().some((a) => a === "t11" || a === "t12"), "no bystander terminal killed");
    assert.equal(sim.terms.get("t11").killed || sim.terms.get("t12").killed, false);
    assert.equal(sim.terms.size, aliveBefore + 3, "only the 3 resumed terminals were added");
  });

  test(`resume at capacity, ${column}: a failed attempt rolls back to ${column}, frees the claim, kills only its own terminals`, async () => {
    fullProject(column);
    const by0 = bystanders(), old0 = JSON.stringify(oldRun());
    sim.plan.push(OK, { status: () => "blocked", delivered: () => false }, { status: () => "blocked", delivered: () => false });
    const inFlight = [];
    sim.onOpen = () => inFlight.push(slots().active);
    const r = await io.resumeSquad("R-OLD");
    assert.ok(r.error);
    assert.ok(inFlight.length > 0 && inFlight.every((a) => a === 3), `the claim counted while it ran: ${inFlight}`);
    assert.deepEqual(sim.killed().sort(), sim.opened().filter((a) => !["t11", "t12"].includes(a)).sort(), "exactly the attempt's own terminals");
    assert.deepEqual({ agent: card().agent, column: card().column, run: card().run }, { agent: null, column, run: "R-OLD" });
    assert.deepEqual(slots(), { active: 2, waiting: 0, free: 0 }, "the claim is gone: back to the 2 bystanders");
    assert.equal(bystanders(), by0);
    assert.equal(JSON.stringify(oldRun()), old0, "the old run is untouched");
  });

  test(`resume at capacity, ${column}: cancel mid-attempt releases the claim and leaves the bystander squads alone`, async () => {
    fullProject(column);
    const by0 = bystanders();
    sim.plan.push({ status: () => "idle", delivered: () => false });
    let during = null;
    sim.onGet = () => { during ??= slots().active; io.cancelResume("R-OLD"); };
    const r = await io.resumeSquad("R-OLD");
    assert.match(r.error, /cancel|stopped/i);
    assert.equal(during, 3, "the claim counted while the attempt ran");
    assert.deepEqual(sim.killed(), sim.opened().filter((a) => !["t11", "t12"].includes(a)));
    assert.equal(card().column, column);
    assert.equal(card().agent, null);
    assert.deepEqual(slots(), { active: 2, waiting: 0, free: 0 });
    assert.equal(bystanders(), by0);
  });
}
