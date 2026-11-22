// T-MWO3FDT7NKL (B4b): the ask's reason in the Needs-you row. Counts and groups never change; only the reason of a card whose agent is live-blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsCounts, createNeedsCache } from "../_lib/needs.js";

const T = (o = {}) => ({ id: "T-1", title: "x", column: "doing", agent: "t9", archived: false, created: 1, priority: "P2", tags: [], ...o });
const live = (status, address = "t9") => new Map([[address, { address, status }]]);
const asks = (o) => new Map(Object.entries(o));
const A = { id: 4, kind: "permission", tool: "Edit" };
const FALLBACK = "Agent asks: open its terminal";

test("a live-blocked card gets the ask's reason; counts, groups and order are identical with and without asks", () => {
  const tasks = [T(), T({ id: "T-2", agent: "t8", created: 2 }), T({ id: "T-3", agent: null, created: 3 })];
  const lv = new Map([...live("blocked"), ...live("blocked", "t8")]);
  const alive = new Set(["t9", "t8"]);
  const plain = needsCounts(tasks, lv, alive, [], [], 10);
  const withAsk = needsCounts(tasks, lv, alive, [], [], 10, asks({ t9: A }));
  assert.equal(plain.rows.get("T-1").reason, FALLBACK);
  assert.equal(withAsk.rows.get("T-1").reason, "Asks permission · Edit");
  assert.equal(withAsk.rows.get("T-2").reason, FALLBACK, "no ask for t8: the fallback");
  assert.deepEqual(withAsk.counts, plain.counts);
  assert.deepEqual(withAsk.byGroup, plain.byGroup);
  assert.deepEqual(withAsk.attention.map((a) => a.key), plain.attention.map((a) => a.key));
  assert.equal(withAsk.attention.find((a) => a.key === "T-1").reason, "Asks permission · Edit");
});

test("the override is only for the live-blocked reason: working, gone, parked and review cards keep their reasons", () => {
  const ask = asks({ t9: A });
  assert.equal(needsCounts([T()], live("working"), new Set(["t9"]), [], [], 1, ask).rows.get("T-1").reason, "Agent is working");
  assert.equal(needsCounts([T()], new Map(), new Set(), [], [], 1, ask).rows.get("T-1").reason, "Agent t9 is gone");
  const parked = needsCounts([T({ column: "blocked" })], live("blocked"), new Set(["t9"]), [], [], 1, ask).rows.get("T-1");
  assert.deepEqual([parked.group, parked.reason], ["needs", "Asks permission · Edit"], "a live-blocked agent wins over the blocked column (B1 precedence); the ask only words the reason");
  assert.equal(needsCounts([T({ column: "review" })], live("working"), new Set(["t9"]), [], [], 1, ask).rows.get("T-1").reason, "Ready for review");
  // a remote card never takes a local terminal's ask, even with the same address
  assert.equal(needsCounts([T({ remote: { machine: "b", projectId: "P" } })], live("blocked"), new Set(["t9"]), [], [], 1, ask).rows.values().next().value.reason, FALLBACK);
});

test("question and plan reasons", () => {
  const q = needsCounts([T()], live("blocked"), new Set(["t9"]), [], [], 1, asks({ t9: { id: 1, kind: "question", tool: "AskUserQuestion" } }));
  assert.equal(q.rows.get("T-1").reason, "Question for you");
  const p = needsCounts([T()], live("blocked"), new Set(["t9"]), [], [], 1, asks({ t9: { id: 1, kind: "plan", tool: "ExitPlanMode" } }));
  assert.equal(p.rows.get("T-1").reason, "Plan to approve");
});

// the cache: scan -> state -> reason, all inside refresh(); get() never computes
function world(o = {}) {
  const w = { tasks: [T()], runs: [], agents: [{ address: "t9", status: "blocked" }], terminals: [{ address: "t9" }], asksScan: null, reads: 0, ...o };
  w.read = () => { w.reads++; return { tasks: w.tasks, runs: w.runs, agents: w.agents, terminals: w.terminals, asksScan: w.asksScan }; };
  return w;
}
const scan = (o) => ({ ok: true, files: new Map(Object.entries(o)) });
const file = (id, o = {}) => ({ id, kind: "permission", tool: "Bash", at: 1, ...o });

test("the cache: no scan (no hooks) = fallback; a scan with an ask repaints with the reason; the signature changes with the reason", () => {
  const w = world();
  const c = createNeedsCache({ read: w.read, now: () => 5 });
  c.refresh();
  assert.equal(c.get().rows.get("T-1").reason, FALLBACK);
  const sig = c.signature();
  w.asksScan = scan({ t9: file(2) });
  assert.equal(c.refresh(), true, "the reason change is a real change");
  assert.equal(c.get().rows.get("T-1").reason, "Asks permission · Bash");
  assert.notEqual(c.signature(), sig);
  assert.equal(c.refresh(), false, "nothing new");
  w.asksScan = scan({ t9: file(3, { kind: "plan", tool: "ExitPlanMode" }) });
  assert.equal(c.refresh(), true);
  assert.equal(c.get().rows.get("T-1").reason, "Plan to approve");
});

test("the cache: answered ask (blocked then working) returns to the fallback reason on the next block; live-only transitions", () => {
  const w = world({ asksScan: scan({ t9: file(2) }) });
  const c = createNeedsCache({ read: w.read, now: () => 5 });
  c.refresh();
  assert.equal(c.get().rows.get("T-1").reason, "Asks permission · Bash");
  w.agents = [{ address: "t9", status: "working" }];
  c.refresh();
  assert.equal(c.get().rows.get("T-1").group, "working");
  w.agents = [{ address: "t9", status: "blocked" }]; // blocked again, the same stale file still in the scan: not revived
  c.refresh();
  assert.equal(c.get().rows.get("T-1").reason, FALLBACK);
  w.asksScan = scan({ t9: file(3, { kind: "question", tool: "AskUserQuestion" }) });
  c.refresh();
  assert.equal(c.get().rows.get("T-1").reason, "Question for you");
});

test("the cache: an unknown scan (error) keeps what is shown; get() never reads", () => {
  const w = world({ asksScan: scan({ t9: file(2) }) });
  const c = createNeedsCache({ read: w.read, now: () => 5 });
  c.refresh();
  const reads = w.reads;
  c.get(); c.get();
  assert.equal(w.reads, reads);
  w.asksScan = { ok: false };
  c.refresh();
  assert.equal(c.get().rows.get("T-1").reason, "Asks permission · Bash");
});
