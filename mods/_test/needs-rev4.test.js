// T-MWO2HFFHWRB Revision 4: Needs you = only what waits on the owner NOW. Blocked column and Review are not counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsCounts, createNeedsCache, GROUP_IDS } from "../_lib/needs.js";
import { attention, GROUPS, CLAIMING } from "../_lib/store.js";

const card = (o) => ({ id: "T-1", title: "x", column: "todo", agent: null, archived: false, created: 1, priority: "P2", tags: [], ...o });
const live = (status, address = "t9") => new Map([[address, { address, status }]]);
const none = new Map();
const A9 = new Set(["t9"]);
const row = (t, l = none, alive = new Set()) => needsCounts([t], l, alive, []).rows.get(t.id) ?? null;
const NOW = 1_700_000_000_000, H = 3600000;
const wake = (o) => ({ id: "W-1", name: "ping", target: "t9", text: "hi", status: "failed", reason: "Target terminal is gone", at: NOW - H, enabled: true, ...o });

test("Blocked column: its own group 'blocked', not counted in Needs you", () => {
  const r = needsCounts([card({ column: "blocked" })], none, new Set(), [], [], NOW);
  assert.equal(r.rows.get("T-1").group, "blocked");
  assert.equal(r.rows.get("T-1").reason, "Blocked");
  assert.deepEqual(r.byGroup.blocked, ["T-1"]);
  assert.equal(r.counts.needs, 0);
  assert.deepEqual(r.attention, []);
  assert.deepEqual(GROUP_IDS.at(-1), "blocked");
  assert.deepEqual(GROUPS.at(-1), ["blocked", "Blocked"]);
});

test("agent blocked on the owner is counted, in any open column (Blocked and Review too)", () => {
  for (const column of ["todo", "doing", "review", "blocked"]) {
    const r = needsCounts([card({ column, agent: "t9" })], live("blocked"), A9, [], [], NOW);
    assert.equal(r.rows.get("T-1").group, "needs", column);
    assert.equal(r.rows.get("T-1").reason, "Agent asks: open its terminal");
    assert.equal(r.counts.needs, 1, column);
  }
});

test("a blocked status without a live terminal is not an ask", () => {
  assert.notEqual(row(card({ column: "doing", agent: "t9" }), live("blocked"), new Set()).reason, "Agent asks: open its terminal");
});

test("claiming beats the Blocked column", () => {
  assert.equal(row(card({ column: "blocked", agent: CLAIMING })).group, "working");
});

test("a gone agent on an In-progress card is counted; on a todo/backlog card it is not", () => {
  assert.deepEqual({ ...row(card({ column: "doing", agent: "t9" })) }.group, "needs");
  assert.equal(row(card({ column: "doing", agent: "t9" })).reason, "Agent t9 is gone");
  for (const column of ["todo", "backlog"]) assert.equal(row(card({ column, agent: "t9" })).group, column, column);
});

test("a Review card is never in Needs you, even with a gone or stopped agent", () => {
  for (const [l, alive] of [[none, new Set()], [live("done"), A9], [live("idle"), A9]]) {
    const r = needsCounts([card({ column: "review", agent: "t9" })], l, alive, [], [], NOW);
    assert.equal(r.rows.get("T-1").group, "review");
    assert.equal(r.counts.needs, 0);
  }
});

test("a live terminal with no status is not gone: it is working", () => {
  const r = row(card({ column: "doing", agent: "t9" }), none, A9);
  assert.equal(r.group, "working");
  assert.notEqual(r.reason, "Agent t9 is gone");
});

test("stopped, done or idle agent on a live terminal is working, not Needs you", () => {
  for (const s of ["done", "idle", "stopped", "unknown"]) assert.equal(row(card({ column: "doing", agent: "t9" }), live(s), A9).group, "working", s);
  assert.equal(row(card({ column: "doing", agent: "t9" }), live("working"), A9).reason, "Agent is working");
});

test("attention() takes the alive set (same table for one card)", () => {
  assert.equal(attention(card({ column: "doing", agent: "t9" }), none, new Set()).group, "needs");
  assert.equal(attention(card({ column: "doing", agent: "t9" }), none, A9).group, "working");
  assert.equal(attention(card({ column: "blocked" }), none, new Set()).group, "blocked");
});

test("wake rows: failed and expired within 24 h count; older, disabled, sent and future do not", () => {
  const ok = [wake({ id: "W-F", status: "failed" }), wake({ id: "W-E", status: "expired", reason: "x", at: NOW - H + 1 })];
  const no = [wake({ id: "W-OLD", at: NOW - 25 * H }), wake({ id: "W-OFF", enabled: false }), wake({ id: "W-SENT", status: "scheduled", reason: "sent to t9" }), wake({ id: "W-FUT", at: NOW + H }), wake({ id: "W-NAN", at: "x" }), wake({ id: "W-DONE", status: "sending" })];
  const r = needsCounts([], none, new Set(), [], [...ok, ...no], NOW);
  assert.deepEqual(r.attention.map((a) => a.key), ["wake/W-F", "wake/W-E"]);
  assert.equal(r.counts.needs, 2);
  assert.deepEqual(r.attention.map((a) => a.kind), ["wake", "wake"]);
  assert.equal(r.attention[0].reason, "Wakeup delivery failed");
  assert.equal(r.attention[1].reason, "Wakeup didn't start");
  assert.equal(needsCounts([], none, new Set(), [], [wake({ at: NOW - 24 * H })], NOW).counts.needs, 1);
  assert.equal(needsCounts([], none, new Set(), [], [wake({ at: NOW - 24 * H - 1 })], NOW).counts.needs, 0);
});

test("mixed cards and wakes: one list, oldest first by one timestamp, count == list length; byGroup.needs stays card-only", () => {
  const cards = [card({ id: "T-A", column: "doing", agent: "t9", created: NOW - 5 * H }), card({ id: "T-B", column: "doing", agent: "t8", created: NOW - 1 * H })];
  const wakes = [wake({ id: "W-X", at: NOW - 3 * H })];
  const r = needsCounts(cards, none, new Set(), [], wakes, NOW);
  assert.deepEqual(r.attention.map((a) => a.key), ["T-A", "wake/W-X", "T-B"]);
  assert.deepEqual(r.attention.map((a) => a.kind), ["card", "wake", "card"]);
  assert.equal(r.counts.needs, r.attention.length);
  assert.deepEqual(r.byGroup.needs, ["T-A", "T-B"]);
});

test("the cache keeps the combined list; a wake-only change (delete, reschedule, expiry) changes the signature without any card change", () => {
  let wakes = [wake({})], t = NOW;
  const c = createNeedsCache({ read: () => ({ tasks: [], runs: [], agents: [], terminals: [], wakes }), now: () => t });
  c.refresh();
  assert.equal(c.get().counts.needs, 1);
  assert.equal(c.get().attention[0].key, "wake/W-1");
  assert.equal(c.refresh(), false);
  wakes = []; // deleted
  assert.equal(c.refresh(), true);
  assert.equal(c.get().counts.needs, 0);
  wakes = [wake({})]; c.refresh();
  wakes = [wake({ status: "scheduled", reason: null })]; // rescheduled
  assert.equal(c.refresh(), true);
  assert.equal(c.get().counts.needs, 0);
  wakes = [wake({ at: NOW - H })]; c.refresh();
  t = NOW + 24 * H; // the 24 h window passes with nothing else changing
  assert.equal(c.refresh(), true);
  assert.equal(c.get().counts.needs, 0);
});

test("review 3: the signature covers what a wake row shows and sorts by: name, target, reason detail, at", () => {
  let w = wake({});
  const c = createNeedsCache({ read: () => ({ tasks: [], runs: [], agents: [], terminals: [], wakes: [w] }), now: () => NOW });
  c.refresh();
  for (const change of [{ reason: "hc send failed (may have arrived): x" }, { name: "renamed" }, { target: "t10" }, { at: NOW - 2 * H }]) {
    w = { ...w, ...change };
    assert.equal(c.refresh(), true, JSON.stringify(change));
    assert.equal(c.get().counts.needs, 1, "count and order unchanged");
    assert.equal(c.refresh(), false);
  }
});

test("Backlog cards get their own group; Ready holds only column todo, and the counts follow", () => {
  const r = needsCounts([card({ id: "T-R", column: "todo" }), card({ id: "T-B1", column: "backlog" }), card({ id: "T-B2", column: "backlog" })], none, new Set(), []);
  assert.deepEqual(r.byGroup.todo, ["T-R"]);
  assert.deepEqual(r.byGroup.backlog, ["T-B1", "T-B2"]);
  assert.equal(r.counts.todo, 1);
  assert.equal(r.counts.backlog, 2);
  assert.deepEqual(GROUPS.find(([id]) => id === "backlog"), ["backlog", "Backlog"]);
});
