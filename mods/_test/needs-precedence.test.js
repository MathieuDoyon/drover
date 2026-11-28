// T-MWO2HFFHWRB: one card, one group. Precedence table rows 0-9 (first match wins), reasons <= 40 chars, counts == list lengths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsCounts } from "../_lib/needs.js";
import { attention, CLAIMING } from "../_lib/store.js";

const card = (o) => ({ id: "T-1", title: "x", column: "todo", agent: null, archived: false, created: 1, priority: "P2", tags: [], ...o });
const live = (status, address = "t9") => new Map([[address, { address, status }]]);
const none = new Map();
const one = (t, l = none, alive = new Set(l.keys()), runs = []) => needsCounts([t], l, alive, runs).rows.get(t.id) ?? null;

test("row 0: archived or done is in no group", () => {
  assert.equal(one(card({ archived: true, column: "blocked" })), null);
  assert.equal(one(card({ column: "done", agent: "t9" }), live("blocked")), null);
  const r = needsCounts([card({ archived: true }), card({ id: "T-2", column: "done" })], none, new Set(), []);
  assert.deepEqual(r.counts, { needs: 0, review: 0, working: 0, todo: 0, backlog: 0, blocked: 0 });
});

test("row 2: a claiming card is working (agent is starting)", () => {
  assert.deepEqual(pick(one(card({ column: "doing", agent: CLAIMING }))), { group: "working", reason: "Agent is starting" });
  assert.deepEqual(pick(one(card({ column: "review", agent: CLAIMING }))), { group: "working", reason: "Agent is starting" });
});

test("row 4: the review column beats a gone or stopped agent", () => {
  for (const l of [none, live("done"), live("idle"), live("working")]) {
    assert.deepEqual(pick(one(card({ column: "review", agent: "t9" }), l)), { group: "review", reason: "Ready for review" });
  }
  assert.equal(one(card({ column: "review" })).group, "review");
});

test("row 5: an agent with no live terminal is gone", () => {
  assert.deepEqual(pick(one(card({ column: "doing", agent: "t9" }))), { group: "needs", reason: "Agent t9 is gone" });
});

test("row 7: a working agent is working", () => {
  assert.deepEqual(pick(one(card({ column: "doing", agent: "t9" }), live("working"))), { group: "working", reason: "Agent is working" });
  assert.equal(one(card({ column: "todo", agent: "t9" }), live("working")).group, "working");
});

test("row 8: a doing card with no agent is working (in progress)", () => {
  assert.deepEqual(pick(one(card({ column: "doing" }))), { group: "working", reason: "In progress" });
});

test("row 9: anything else is todo with no reason", () => {
  const r = one(card({ column: "todo" }));
  assert.equal(r.group, "todo");
  assert.equal(r.reason, null);
  assert.equal(one(card({ column: "backlog" })).group, "backlog", "a Backlog card is not Ready");
});

test("attention() is the same table for one card", () => {
  const a = (status) => new Map([["t9", { status }]]);
  assert.equal(attention(card({ column: "review", agent: "t9" }), a("blocked")).group, "needs");
  assert.equal(attention(card({ column: "review", agent: "t9" }), a("done")).group, "review");
  assert.equal(attention(card({ column: "review", agent: "t9" }), new Map()).group, "review");
  assert.equal(attention(card({ column: "doing", agent: "t9" }), a("blocked")).reason, "Agent asks: open its terminal");
});

test("a reason is at most 40 chars, cut at a word", () => {
  const long = "t" + "9".repeat(60);
  const r = one(card({ column: "doing", agent: long }));
  assert.ok(r.reason.length <= 40, r.reason);
  assert.ok(r.reason.length > 0);
});

test("one card, one group; counts equal the list lengths", () => {
  const tasks = [
    card({ id: "T-1", column: "blocked" }),
    card({ id: "T-2", column: "doing", agent: "t9" }),
    card({ id: "T-3", column: "doing", agent: "t8" }),
    card({ id: "T-4", column: "doing", agent: "t7" }),
    card({ id: "T-5", column: "todo" }),
    card({ id: "T-6", column: "done" }),
  ];
  const l = new Map([["t9", { status: "blocked" }], ["t8", { status: "working" }]]);
  const r = needsCounts(tasks, l, new Set(["t9", "t8"]), []);
  const all = Object.values(r.byGroup).flat();
  assert.equal(new Set(all).size, all.length, "no card in two groups");
  for (const g of Object.keys(r.counts)) assert.equal(r.counts[g], r.byGroup[g].length, g);
  assert.deepEqual(r.byGroup.needs, ["T-2", "T-4"]);
  assert.deepEqual(r.byGroup.blocked, ["T-1"]);
  assert.equal(r.rows.size, 5);
});

test("needs group is oldest first by created, then id; an edit does not reorder", () => {
  const tasks = [
    card({ id: "T-B", column: "doing", agent: "tb", created: 20, updated: 5 }),
    card({ id: "T-A", column: "doing", agent: "ta", created: 10, updated: 99 }),
    card({ id: "T-C", column: "doing", agent: "tc", created: 10, updated: 1 }),
  ];
  assert.deepEqual(needsCounts(tasks, none, new Set(), []).byGroup.needs, ["T-A", "T-C", "T-B"]);
});

test("counts ignore filters: the input is every card, there is no filter argument", () => {
  const tasks = [card({ id: "T-1", column: "doing", agent: "ta", project: "P-1", tags: ["a"] }), card({ id: "T-2", column: "doing", agent: "tb", project: "P-2" })];
  const full = needsCounts(tasks, none, new Set(), []);
  assert.equal(full.counts.needs, 2);
  assert.equal(needsCounts.length <= 4, true);
});

test("a remote card is in its group by its qualified key (a remote card has no local agent, so it is never Needs you)", () => {
  const t = card({ id: "T-R", column: "blocked", remote: { machine: "box1", projectId: "P-9" } });
  const r = needsCounts([t], none, new Set(), []);
  assert.deepEqual(r.byGroup.blocked, ["box1/P-9/T-R"]);
  assert.equal(r.counts.needs, 0);
});

test("a review card with a live agent gets the review-live dot; others keep their group", () => {
  const t = card({ id: "T-1", column: "review", agent: "t9" });
  assert.equal(one(t, live("working"), new Set(["t9"])).dot, "review-live");
  assert.equal(one(t, none, new Set()).dot, "review");
  assert.equal(one(card({ column: "blocked" })).dot, "blocked");
});

test("needsCounts is pure: it does not mutate its inputs", () => {
  const tasks = [card({ column: "blocked" })];
  const snap = JSON.stringify(tasks);
  needsCounts(tasks, none, new Set(), []);
  assert.equal(JSON.stringify(tasks), snap);
});

function pick(r) { return r && { group: r.group, reason: r.reason }; }

// ---- Review round 1: cards of different boards can share an id; each keeps its own row, group and identity. ----
import { cardKey } from "../_lib/needs.js";
const remote = (o, machine = "box1", projectId = "P-9") => card({ ...o, project: "P-L", remote: { machine, projectId } });

test("cardKey: a local card keeps its id; a remote card is qualified by machine and remote project", () => {
  assert.equal(cardKey(card({ id: "T-1" })), "T-1");
  assert.equal(cardKey(remote({ id: "T-1" })), "box1/P-9/T-1");
  assert.notEqual(cardKey(remote({ id: "T-1" }, "a")), cardKey(remote({ id: "T-1" }, "b")));
  assert.notEqual(cardKey(remote({ id: "T-1" }, "a", "P-1")), cardKey(remote({ id: "T-1" }, "a", "P-2")));
});

test("same id: a local blocked card and a remote Done card: Done does not show and does not take the local reason", () => {
  const local = card({ id: "T-X", title: "local gone", column: "doing", agent: "t9" });
  const done = remote({ id: "T-X", title: "remote done", column: "done" });
  for (const tasks of [[local, done], [done, local]]) {
    const r = needsCounts(tasks, none, new Set(), []);
    assert.deepEqual(r.byGroup.needs, ["T-X"]);
    assert.deepEqual(r.counts, { needs: 1, review: 0, working: 0, todo: 0, backlog: 0, blocked: 0 });
    assert.equal(r.rows.size, 1);
    assert.equal(r.rows.get("T-X").reason, "Agent t9 is gone");
    assert.equal(r.rows.has(cardKey(done)), false, "the Done remote card is in no group");
  }
});

test("same id: a local Ready card and a remote Blocked card are two rows in two groups", () => {
  const local = card({ id: "T-1", column: "todo" });
  const rem = remote({ id: "T-1", column: "blocked" });
  const r = needsCounts([local, rem], none, new Set(), []);
  assert.deepEqual(r.byGroup.blocked, [cardKey(rem)]);
  assert.deepEqual(r.byGroup.todo, ["T-1"]);
  assert.deepEqual(r.counts, { needs: 0, review: 0, working: 0, todo: 1, backlog: 0, blocked: 1 });
  assert.equal(r.rows.get("T-1").group, "todo", "the local card stays Ready");
});

test("same id on two remote boards: both are listed, oldest first, counts equal the list", () => {
  const a = remote({ id: "T-1", column: "blocked", created: 5 }, "a"), b = remote({ id: "T-1", column: "blocked", created: 3 }, "b"), c = remote({ id: "T-1", column: "review" }, "a", "P-2");
  const r = needsCounts([a, b, c], none, new Set(), []);
  assert.deepEqual(r.byGroup.blocked, [cardKey(b), cardKey(a)]);
  assert.deepEqual(r.byGroup.review, [cardKey(c)]);
  for (const g of Object.keys(r.counts)) assert.equal(r.counts[g], r.byGroup[g].length, g);
  assert.equal(r.rows.size, 3);
});

test("a remote Review card does not take the review-live dot from a LOCAL run with the same bare id; the local card keeps its dot", () => {
  const runs = [{ id: "R-1", task: "T-X", terminals: [{ address: "t5" }] }];
  const l = new Map([["t5", { address: "t5", status: "working" }]]);
  const alive = new Set(["t5"]);
  const rem = remote({ id: "T-X", column: "review" });
  const local = card({ id: "T-X", column: "review" });
  assert.equal(needsCounts([rem], l, alive, runs).rows.get(cardKey(rem)).dot, "review", "remote: no local-run liveness");
  const both = needsCounts([local, rem], l, alive, runs);
  assert.equal(both.rows.get("T-X").dot, "review-live", "the local card keeps its dot");
  assert.equal(both.rows.get(cardKey(rem)).dot, "review");
});
