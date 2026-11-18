// T-MWLGPS2QJQL S1: resumeTerminal (open, readiness barrier, fallback, kill-confirm), the durable attempt record, the claim token and the scoped session patch.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

register("./hooks.js", import.meta.url);
const SID = "11111111-2222-4333-8444-555555555555";
const SID2 = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const SID3 = "99999999-7777-4888-8999-bbbbbbbbbbbb";
const FROZEN = "claude --model claude-sonnet-5-5 --permission-mode auto";
const CURRENT = "claude --model claude-opus-5-5 --permission-mode auto";
const CFG = { agents: [{ id: "lead", name: "Lead", command: CURRENT, soul: "", instructions: "" }, { id: "cx", name: "Codex", command: "codex --no-daemon", soul: "", instructions: "" }], squads: [] };
const term = (o) => ({ address: "t1", agent: "lead", name: "Lead", role: "leader", model: "claude-sonnet-5-5", started: 1, ended: 5, session: SID, kind: "claude", cwd: "/wt", ...o });
const OLD = () => ({ id: "R-OLD", task: "T-1", config: { leader: { id: "lead", name: "Lead", command: FROZEN, role: "leader" }, members: [] }, terminals: [term()], space: "sp-old", started: 1, ended: 9 });

let host, tmp, sim, io, R, S;
// A terminal simulator. A behavior says what one opened terminal does when the barrier reads it:
//   status(read): "idle" | "working" | "blocked" | "running" (alive, no agent yet) | "gone";  delivered(read): the task reached the agent;  killFails: stays alive after terminal.kill.
const OK = { status: () => "idle", delivered: () => true };
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rt-"));
  io = await import("../_lib/io.js"); R = await import("../_lib/runs.js"); S = await import("../_lib/store.js");
  io.resumeSettle.tries = 6; io.resumeSettle.ms = 0; io.killSettle.tries = 3; io.killSettle.ms = 0;
  sim = { plan: [], terms: new Map(), n: 100, hc: [], calls: [], snap: 0, empty: new Set(), onGet: null };
  host = globalThis.__host = { appHome: "/app", home: tmp, props: {}, notified: [], state: { "drover.agents": CFG, "drover.runs": [OLD()] }, agents: [], panes: [], spaces: [],
    readTextFile: async () => null,
    hc: async (args) => {
      sim.hc.push(args);
      if (args[0] === "get") {
        const t = sim.terms.get(args[1]);
        if (!t) return { code: 1, stdout: "", stderr: "no terminal" };
        sim.onGet?.(args[1]);
        if (t.b.unreadable) return { code: 1, stdout: "", stderr: "hc: unavailable" };
        // The per-terminal source is FRESH: a lagging terminal (not on the list yet) is live and reports its real status; a stale-list terminal dies only after `dieAfterGets` reads.
        const lagging = t.reads <= (t.b.lag ?? 0), real = t.b.status(lagging ? (t.b.lag ?? 0) + 1 : t.reads);
        t.gets = (t.gets ?? 0) + (t.killed ? 1 : 0);
        const dead = t.killed ? !t.b.killFails && t.gets > (t.b.dieAfterGets ?? 0) : real === "gone";
        if (dead) t.sawDead = true;
        return { code: 0, stdout: JSON.stringify({ address: args[1], state: dead ? "exited" : "live", status: dead || real === "running" ? null : real, argv: [...t.argv, t.task], ...(t.b.noRecord ? {} : { first_message: { sent: t.b.delivered(t.reads) } }) }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    exec: async (cmd, args) => {
      if (cmd === "sleep") return { code: 0, stdout: "", stderr: "" };
      if (cmd !== "herdr-app") return { code: 0, stdout: "", stderr: "" };
      const [, op, ...rest] = args;
      sim.calls.push([op, rest]);
      if (op === "tab.new" || op === "space.new") {
        for (const o of sim.terms.values()) if (o.killed && o.b.needDeadBeforeNextOpen) sim.openedBeforeDeath = (sim.openedBeforeDeath ?? 0) + (o.sawDead ? 0 : 1);
        const address = `t${++sim.n}`, b = sim.plan.shift() ?? OK;
        sim.terms.set(address, { b, reads: 0, killed: false, argv: JSON.parse(rest[rest.indexOf("--argv") + 1]), task: rest[rest.indexOf("--task") + 1] });
        return { code: 0, stdout: JSON.stringify({ terminal: address, space: op === "space.new" ? "sp-new" : rest[rest.indexOf("--space") + 1] }), stderr: "" };
      }
      if (op === "terminal.kill") { const t = sim.terms.get(rest[rest.indexOf("--terminal") + 1]); if (t) t.killed = true; return { code: 0, stdout: "{}", stderr: "" }; }
      return { code: 0, stdout: "{}", stderr: "" };
    },
  };
  // The live list as the barrier reads it: each read advances every simulated terminal one step.
  Object.defineProperty(host, "terminals", { get() {
    if (sim.empty.has(++sim.snap)) return []; // a transient empty snapshot: the host is not ready, not "everything exited"
    const out = [{ address: "t1" }]; // a bystander: the person's own terminal is always on the list
    for (const [address, t] of sim.terms) {
      t.reads++;
      if (t.reads <= (t.b.lag ?? 0) || (t.b.staleList && t.killed)) { if (t.b.staleList && t.killed) out.push({ address }); continue; } // not on the (cached) list yet / the list still shows a killed one
      const gone = t.killed && !t.b.killFails;
      const status = gone ? "gone" : t.b.status(t.reads);
      if (status === "gone") continue;
      out.push({ address, ...(status === "running" ? {} : { status }) });
    }
    return out;
  } });
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const opened = () => [...sim.terms.keys()];
const killed = () => sim.calls.filter(([op]) => op === "terminal.kill").map(([, r]) => r[r.indexOf("--terminal") + 1]);
const argvOf = (address) => sim.terms.get(address).argv;
const go = (o = {}) => { const old = OLD(); return io.resumeTerminal(old, old.terminals[0], { cwd: "/wt", prompt: R.resumePrompt("member", { task: { id: "T-1", title: "C" }, role: "x", token: "TOK", map: [], leader: { old: "t1", address: "t9" } }), token: "TOK", name: "T-1 Lead", space: "sp-x", ...o }); };

test("opens the agent's CURRENT command with --resume <id>, in the cwd, tab in the given space, with the first message", async () => {
  const r = await go();
  assert.equal(r.error, undefined);
  assert.deepEqual(argvOf(r.address), ["claude", "--resume", SID, "--model", "claude-opus-5-5", "--permission-mode", "auto"]);
  const [op, rest] = sim.calls[0];
  assert.equal(op, "tab.new");
  assert.deepEqual(rest.slice(rest.indexOf("--space"), rest.indexOf("--space") + 2), ["--space", "sp-x"]);
  assert.equal(rest[rest.indexOf("--folder") + 1], "/wt");
  assert.match(rest[rest.indexOf("--task") + 1], /drover-resume-attempt: TOK/);
  assert.deepEqual({ source: r.source, model: r.model, space: r.space }, { source: "current", model: "claude-opus-5-5", space: "sp-x" });
});

test("with spaceName the first terminal of a resumed run opens its own space (space.new) and returns the space Herdr made", async () => {
  const r = await go({ space: null, spaceName: "T-1 Card" });
  assert.equal(sim.calls[0][0], "space.new");
  assert.equal(r.space, "sp-new");
});

test("the env wrapper still launches the agent when it has an env file", async () => {
  host.readTextFile = async (p) => (p.endsWith("/agents/lead.json") ? "{}" : null);
  const r = await go();
  assert.deepEqual(argvOf(r.address).slice(0, 4), ["/app/mods/drover-agents/bin/drover-env", "lead", "--", "claude"]);
  assert.ok(argvOf(r.address).includes("--resume"));
});

test("readiness is an agent status twice in a row AND the first message delivered: a bare shell is not ready", async () => {
  sim.plan.push({ status: (n) => (n < 4 ? "running" : "idle"), delivered: (n) => n >= 5 });
  const r = await go();
  assert.equal(r.error, undefined);
  assert.equal(r.source, "current");
  assert.equal(opened().length, 1, "no fallback: it became ready within the bound");
  assert.ok(sim.terms.get(r.address).reads >= 5, "it waited for the delivery, not just the second status read");
});

test("a terminal whose record has no first_message (task passed in argv) counts as delivered only when its argv carries the attempt token", async () => {
  sim.plan.push({ status: () => "idle", delivered: () => false, noRecord: true });
  assert.equal((await go()).error, undefined, "argv carries the token");
  sim.plan.push({ status: () => "idle", delivered: () => false, noRecord: true }, { status: () => "idle", delivered: () => false, noRecord: true });
  const r = await go({ prompt: "no token here" });
  assert.match(r.error, /first message|deliver/i);
});

test("current command fails (gone after two good reads, delivery still pending): killed and confirmed gone, then the FROZEN command, same session", async () => {
  sim.plan.push({ status: (n) => (n <= 2 ? "idle" : "gone"), delivered: () => false });
  const r = await go();
  assert.equal(r.error, undefined);
  assert.equal(r.source, "frozen");
  assert.equal(r.model, "claude-sonnet-5-5");
  assert.deepEqual(argvOf(r.address), ["claude", "--resume", SID, "--model", "claude-sonnet-5-5", "--permission-mode", "auto"]);
  assert.deepEqual(killed().slice(0, 1), [opened()[0]], "the failed terminal is killed before the fallback opens");
});

test("a first message that never arrives is a failure after the bound; both commands fail = error, both terminals killed", async () => {
  sim.plan.push({ status: () => "idle", delivered: () => false }, { status: () => "idle", delivered: () => false });
  const r = await go();
  assert.match(r.error, /first message|deliver|not ready/i);
  assert.equal(opened().length, 2);
  assert.deepEqual(killed().sort(), opened().sort());
  assert.deepEqual(r.killed.sort(), opened().sort());
});

test("a blocked terminal is a failed attempt: nothing is typed into it (no send, no keys), it is killed, the next command is tried", async () => {
  sim.plan.push({ status: () => "blocked", delivered: () => false });
  const r = await go();
  assert.equal(r.source, "frozen");
  assert.ok(sim.hc.every((a) => a[0] === "get" || a[0] === "label"), `only reads and labels: ${JSON.stringify(sim.hc.map((a) => a[0]))}`);
  assert.equal(killed().length, 1);
});

test("a kill that cannot be confirmed fails closed: no second terminal for the same session, error says so", async () => {
  sim.plan.push({ status: () => "blocked", delivered: () => false, killFails: true });
  const r = await go();
  assert.equal(r.failClosed, true);
  assert.match(r.error, /still|confirm|alive/i);
  assert.equal(opened().length, 1, "the fallback never opened next to a terminal that might still be alive");
});

test("when the current command equals the frozen one there is exactly one attempt", async () => {
  const old = OLD(); old.config.leader.command = CURRENT;
  sim.plan.push({ status: () => "gone", delivered: () => false });
  const r = await io.resumeTerminal(old, old.terminals[0], { cwd: "/wt", prompt: "p", token: "TOK", name: "n", space: "s" });
  assert.ok(r.error);
  assert.equal(opened().length, 1);
});

test("no usable command (own resume flag in both): refused with the terminal named, nothing opened", async () => {
  host.state["drover.agents"] = { ...CFG, agents: [{ id: "lead", name: "Lead", command: "claude --continue", soul: "", instructions: "" }] };
  const old = OLD(); old.config.leader.command = "claude --resume abc";
  const r = await io.resumeTerminal(old, old.terminals[0], { cwd: "/wt", prompt: "p", token: "TOK", name: "n", space: "s" });
  assert.match(r.error, /Lead|t1/);
  assert.equal(opened().length, 0);
});

test("onOpen sees every opened address (also a failed one) before it is killed, so a durable record can own it", async () => {
  const seen = [];
  sim.plan.push({ status: () => "gone", delivered: () => false });
  await go({ onOpen: (a) => seen.push([a, killed().length]) });
  assert.deepEqual(seen.map(([a]) => a), opened());
  assert.equal(seen[0][1], 0, "reported before any kill");
});

// ---- the durable attempt record (drover.resumes) and the claim token
test("beginAttempt writes a durable record before any open; a second live attempt for the same run is refused", () => {
  const a = io.beginAttempt("R-OLD", "T-1", 1000);
  assert.deepEqual({ card: a.card, opened: a.opened, started: a.started }, { card: "T-1", opened: [], started: 1000 });
  assert.ok(a.id && a.token && a.id !== a.token);
  assert.deepEqual(host.state["drover.resumes"]["R-OLD"], a);
  assert.match(io.beginAttempt("R-OLD", "T-1", 1001).error, /already/i);
});
test("attemptOpened appends the address to the shared record (a reload reads it back); endAttempt clears only its own", () => {
  const a = io.beginAttempt("R-OLD", "T-1", 1000);
  io.attemptOpened("R-OLD", a.id, "t5"); io.attemptOpened("R-OLD", a.id, "t6");
  assert.deepEqual(io.attemptOf("R-OLD").opened, ["t5", "t6"]);
  io.endAttempt("R-OLD", "someone-else");
  assert.ok(io.attemptOf("R-OLD"), "another attempt's id does not clear it");
  io.endAttempt("R-OLD", a.id);
  assert.equal(io.attemptOf("R-OLD"), null);
});
test("an existing attempt record, even a lapsed one, blocks a new attempt: it needs a manual Recover (nothing is replaced on its own)", () => {
  io.beginAttempt("R-OLD", "T-1", 1000);
  const again = io.beginAttempt("R-OLD", "T-1", 1000 + R.claimTtl + 1);
  assert.equal(again.recoveryNeeded, true);
  assert.match(again.error, /recover/i);
});
test("claimForResume puts the card in doing with the claim token; a 2nd claim, a wrong-token release and a wrong-token check do nothing", () => {
  host.state["drover.tasks"] = [{ id: "T-1", title: "C", column: "review", agent: null, priority: "P2", tags: [], created: 1, updated: 1 }];
  const key = S.KEY;
  host.state[key] = host.state["drover.tasks"];
  const c = io.claimForResume("T-1", "A1");
  assert.equal(c.error, undefined);
  const card = () => host.state[key].find((t) => t.id === "T-1");
  assert.deepEqual({ agent: card().agent, column: card().column, token: card().claimToken }, { agent: S.CLAIMING, column: "doing", token: "A1" });
  assert.match(io.claimForResume("T-1", "A2").error, /already starting/);
  assert.equal(io.holdsClaim("T-1", "A1"), true);
  assert.equal(io.holdsClaim("T-1", "A2"), false);
  io.releaseResumeClaim("T-1", c.prev, "A2");
  assert.equal(card().agent, S.CLAIMING, "a late attempt cannot release a claim that is not its own");
  io.releaseResumeClaim("T-1", c.prev, "A1");
  assert.deepEqual({ agent: card().agent, column: card().column, token: card().claimToken ?? null }, { agent: null, column: "review", token: null });
});

// ---- Codex: the effective session id after a resume, scoped compare-and-patch
const runWith = (terminals) => ({ id: "R-NEW", task: "T-1", terminals, started: 2 });
test("patchSourceSession replaces `session` only when it still equals the source id of THIS terminal; history and other terminals are untouched", () => {
  host.state["drover.runs"] = [runWith([{ address: "t5", session: SID, sourceSession: SID, kind: "codex" }, { address: "t6", session: SID2, sourceSession: SID2, kind: "codex" }]), OLD()];
  assert.equal(io.patchSourceSession("R-NEW", "t5", SID, SID3), true);
  const runs = host.state["drover.runs"];
  assert.deepEqual(runs[0].terminals.map((t) => [t.session, t.sourceSession]), [[SID3, SID], [SID2, SID2]]);
  assert.equal(runs[1].terminals[0].session, SID, "the old run's history is unchanged");
  assert.equal(io.patchSourceSession("R-NEW", "t5", SID, "00000000-0000-4000-8000-000000000000"), false, "session no longer equals the source: not replaced again");
  assert.equal(io.patchSourceSession("R-NEW", "t6", SID, SID3), false, "another terminal's source id does not match");
  assert.equal(io.patchSourceSession("R-GONE", "t5", SID, SID3), false, "a pruned run is not brought back");
});
test("patchSourceSession refuses an id that is not a uuid", () => {
  host.state["drover.runs"] = [runWith([{ address: "t5", session: SID, sourceSession: SID, kind: "codex" }])];
  assert.equal(io.patchSourceSession("R-NEW", "t5", SID, "not-a-uuid"), false);
  assert.equal(host.state["drover.runs"][0].terminals[0].session, SID);
});

// ---- review S1 (T-MWLGPS2QJQL), each scenario from the Inspector's report
test("review 2: a failed kill plus ONE empty snapshot is not confirmed death: no second session, failClosed", async () => {
  sim.plan.push({ status: () => "blocked", delivered: () => false, killFails: true });
  sim.empty.add(3); sim.empty.add(4); // liveState reads the list twice: reads 1-2 = the barrier, 3-4 = the first kill-confirm
  const r = await go();
  assert.equal(r.failClosed, true);
  assert.equal(opened().length, 1, "the frozen fallback never opened beside a terminal that is still alive");
});
test("review 2: a kill whose terminal the host now reports as exited IS confirmed (authoritative state), even when the list is quiet", async () => {
  sim.plan.push({ status: () => "blocked", delivered: () => false });
  const r = await go();
  assert.equal(r.source, "frozen");
});
test("review 3: the terminal exits while the delivery read is in flight: not a success, the fallback runs", async () => {
  let dead = false;
  sim.plan.push({ status: () => (dead ? "gone" : "idle"), delivered: () => { dead = true; return true; } });
  const r = await go();
  assert.equal(r.source, "frozen");
  assert.notEqual(r.address, opened()[0]);
});
test("review 3: it becomes blocked while the delivery read is in flight: not a success", async () => {
  let blocked = false;
  sim.plan.push({ status: () => (blocked ? "blocked" : "idle"), delivered: () => { blocked = true; return true; } });
  const r = await go();
  assert.equal(r.source, "frozen");
  assert.ok(killed().includes(opened()[0]));
});
test("review 4: a stale attempt record with a recorded terminal that is still alive is KEPT; recovery-needed, nothing overwritten", () => {
  const a = io.beginAttempt("R-OLD", "T-1", 1000);
  io.attemptOpened("R-OLD", a.id, "t5", 1000);
  sim.terms.set("t5", { b: OK, reads: 0, killed: false, argv: [], task: "" });
  const again = io.beginAttempt("R-OLD", "T-1", 1000 + R.claimTtl + 1);
  assert.equal(again.recoveryNeeded, true);
  assert.match(again.error, /recover|still|alive/i);
  assert.deepEqual(io.attemptOf("R-OLD").opened, ["t5"]);
  assert.equal(io.attemptOf("R-OLD").id, a.id);
});
test("review 4: an unknown (empty) snapshot is not proof that the recorded terminal is gone", () => {
  const a = io.beginAttempt("R-OLD", "T-1", 1000);
  io.attemptOpened("R-OLD", a.id, "t5", 1000);
  sim.empty.add(1); sim.empty.add(2);
  assert.equal(io.beginAttempt("R-OLD", "T-1", 1000 + R.claimTtl + 1).recoveryNeeded, true);
});
const seedCard = (o = {}) => { host.state[S.KEY] = [{ id: "T-1", title: "C", column: "review", agent: null, priority: "P2", tags: [], created: 1, updated: 1, project: null, ...o }]; };
const cardNow = () => host.state[S.KEY].find((t) => t.id === "T-1");
test("review 5: a claim that expired and was replaced by an ORDINARY claim cannot be released by the old resume token", () => {
  seedCard();
  const c = io.claimForResume("T-1", "A-old");
  assert.equal(io.holdsClaim("T-1", "A-old"), true);
  const exp = R.reconcile(host.state[S.KEY], [], new Set(), 1e15, null); // expired by reconcile
  host.state[S.KEY] = exp.tasks;
  assert.equal("claimToken" in cardNow() && cardNow().claimToken != null, false, "expiry clears the ownership identity");
  host.state[S.KEY] = S.claim(host.state[S.KEY], "T-1", undefined, undefined, new Set()).tasks; // an ordinary claim
  assert.equal(io.holdsClaim("T-1", "A-old"), false);
  assert.equal(io.releaseResumeClaim("T-1", c.prev, "A-old"), false);
  assert.equal(cardNow().agent, S.CLAIMING, "the newer ordinary claim is untouched");
});
test("review 5: every new claim starts without an ownership identity; adoption and release clear it", () => {
  seedCard({ claimToken: "A-stale" });
  const c = S.claim(host.state[S.KEY], "T-1", undefined, undefined, new Set());
  assert.equal(c.task.claimToken, undefined);
  assert.equal(c.tasks[0].claimToken, undefined);
  seedCard();
  io.claimForResume("T-1", "A1");
  const adopted = R.reconcile(host.state[S.KEY], [{ id: "R-X", task: "T-1", started: 1e14, terminals: [{ address: "t9" }] }], new Set(), 1e14 + 1, null);
  assert.equal(adopted.tasks[0].claimToken, undefined, "adoption clears it");
  seedCard();
  const k = io.claimForResume("T-1", "A2");
  io.releaseResumeClaim("T-1", k.prev, "A2");
  assert.equal(cardNow().claimToken, undefined);
  const k2 = io.claimForResume("T-1", "A3");
  host.state[S.KEY] = S.release(host.state[S.KEY], "T-1", k2.prev).tasks; // an ordinary release (launch failed)
  assert.equal(cardNow().claimToken, undefined);
});

test("review 6: check() before the first open stops it: nothing is opened", async () => {
  const r = await go({ check: () => "card is Done" });
  assert.equal(r.cancelled, true); assert.match(r.error, /Done/);
  assert.equal(opened().length, 0);
});
test("review 6: the card is cancelled while the first candidate is being polled: no fallback opens, the first terminal is killed", async () => {
  let stop = null;
  sim.plan.push({ status: () => "idle", delivered: () => false });
  sim.onGet = () => { stop = "stopped by the person"; };
  const r = await go({ check: () => stop });
  assert.equal(r.cancelled, true);
  assert.equal(opened().length, 1, "the frozen open never happened");
  assert.deepEqual(killed(), opened());
});
test("review 6: a cancel that arrives after a SUCCESSFUL barrier kills that terminal too (the caller never holds a cancelled session)", async () => {
  let stop = null;
  sim.plan.push({ status: () => "idle", delivered: () => { stop = "claim replaced"; return true; } });
  const r = await go({ check: () => stop });
  assert.equal(r.cancelled, true);
  assert.deepEqual(killed(), opened());
});
test("review 6: a rejected onOpen registration (it returns false) kills that terminal and stops: no barrier, no fallback", async () => {
  const r = await go({ onOpen: () => false });
  assert.equal(r.cancelled, true);
  assert.deepEqual(killed(), opened());
  assert.equal(opened().length, 1);
});
test("review 6: a check that throws is a stop, not a pass", async () => {
  const r = await go({ check: () => { throw new Error("boom"); } });
  assert.equal(r.cancelled, true); assert.equal(opened().length, 0);
});

// ---- T-MWM5CE02H07: a just-opened terminal is not on the cached list yet; that is unknown, never "gone".
test("T-MWM5CE02H07: a working terminal missing from the cached list for the first reads is NOT gone: the barrier asks the terminal itself and resumes", async () => {
  sim.plan.push({ status: () => "working", delivered: () => true, lag: 3 });
  const r = await go();
  assert.equal(r.error, undefined, r.error);
  assert.equal(opened().length, 1);
  assert.deepEqual(killed(), []);
});
test("T-MWM5CE02H07: a terminal that really exited (the host says so) is still gone", async () => {
  sim.plan.push({ status: () => "gone", delivered: () => false, lag: 2 }, OK);
  const r = await go();
  assert.equal(r.source, "frozen");
  assert.equal(opened().length, 2);
});
test("T-MWM5CE02H07: a list that never shows the killed terminal is no proof of death: the next open waits until the host says it is no longer live", async () => {
  sim.plan.push({ status: () => "blocked", delivered: () => false, lag: 999, dieAfterGets: 3, needDeadBeforeNextOpen: true }, OK);
  io.killSettle.tries = 10;
  const r = await go();
  assert.equal(r.source, "frozen", r.error);
  assert.equal(sim.openedBeforeDeath ?? 0, 0, "the fallback opened while the first terminal was still live");
});
test("T-MWM5CE02H07: when hc cannot answer, a kill is not confirmed (fail closed), even if the list lacks the terminal", async () => {
  sim.plan.push({ status: () => "blocked", delivered: () => false, unreadable: true });
  const r = await go();
  assert.equal(r.failClosed, true);
  assert.equal(opened().length, 1);
});
