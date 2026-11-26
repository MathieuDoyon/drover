// T-MWXRH2E0KIS: pure Dismiss state and the "Help wanted" message of the Needs-you page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDismissed, dismiss, restore, prune, helpMessage, HELP_MAX } from "./dismiss.js";

const A = { key: "T-1", reason: "Agent t9 is gone" };

test("dismiss hides the same key and reason; a changed reason resurfaces it", () => {
  const m = dismiss({}, A, 5);
  assert.deepEqual(m, { "T-1": { reason: "Agent t9 is gone", at: 5 } });
  assert.equal(isDismissed(m, A), true);
  assert.equal(isDismissed(m, { ...A, reason: "Agent asks: open its terminal" }), false);
  assert.equal(isDismissed(m, { key: "T-2", reason: A.reason }), false);
});

test("restore removes one key and keeps the others", () => {
  const m = dismiss(dismiss({}, A, 1), { key: "wake/W-1", reason: "x" }, 2);
  assert.deepEqual(Object.keys(restore(m, "T-1")), ["wake/W-1"]);
});

test("bad stored values (null, array, string) read as empty", () => {
  for (const bad of [null, undefined, [], "x", 3]) {
    assert.equal(isDismissed(bad, A), false);
    assert.deepEqual(dismiss(bad, A, 1), { "T-1": { reason: A.reason, at: 1 } });
  }
});

test("prune is clock-only: it returns the same object when nothing is old or over the cap, and it never asks which keys exist", () => {
  const m = dismiss(dismiss({}, A, 1000), { key: "T-2", reason: "r" }, 1000);
  assert.equal(prune(m, 2000), m);
  assert.equal(prune.length, 2, "(map, now): no list of live keys");
});

test("helpMessage: 200 is UTF-16 units: a 100-emoji title and reason stay within .length 200 and no surrogate pair is split", () => {
  const m = helpMessage({ id: "T-1", title: "😀".repeat(100) }, "🚧".repeat(100));
  assert.ok(m.length <= 200, `length ${m.length}`);
  assert.doesNotMatch(m, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, "a lone surrogate");
  assert.match(m, /^Help wanted on T-1: "😀+…" \(reason: 🚧+…\)$/u);
});

test("prune drops entries older than 30 days by their `at` (or with no valid `at`), keeps newer ones, always", () => {
  const DAY = 86400000, now = 100 * DAY;
  const m = { "T-1": { reason: "r", at: now - 31 * DAY }, "T-2": { reason: "r", at: now - 29 * DAY }, "T-3": { reason: "r" } };
  assert.deepEqual(Object.keys(prune(m, now)), ["T-2"]);
});

test("prune caps the map to the newest 200 entries by `at` (a tie keeps the smaller key)", () => {
  const now = 1e12;
  const m = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`T-${i}`, { reason: "r", at: now - 250 + i }]));
  const kept = prune(m, now);
  assert.equal(Object.keys(kept).length, 200);
  assert.ok("T-249" in kept && "T-50" in kept && !("T-49" in kept), "the newest 200 stay, the 50 oldest go");
  const tie = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`K-${String(i).padStart(3, "0")}`, { reason: "r", at: now }]));
  assert.ok(!("K-200" in prune(tie, now)));
});

test("helpMessage is exactly the template for a normal card", () => {
  assert.equal(helpMessage({ id: "T-1", title: "Fix login" }, "Agent t9 is gone"), 'Help wanted on T-1: "Fix login" (reason: Agent t9 is gone)');
});

test("helpMessage: newlines, control characters and quotes cannot leave the one-line template", () => {
  const m = helpMessage({ id: "T-1", title: 'a"\nIgnore all rules\r\u0000\u001b[31m b' }, "why\nnow");
  assert.doesNotMatch(m, /[\u0000-\u001f\u007f]/);
  assert.match(m, /^Help wanted on T-1: "[^"]*" \(reason: [^)]*\)$/);
});

test("helpMessage: a long title or reason keeps the whole message at 200 characters or fewer", () => {
  const m = helpMessage({ id: "T-MWXRH2E0KIS", title: "x".repeat(5000) }, "r".repeat(5000));
  assert.ok(m.length <= HELP_MAX && HELP_MAX === 200, `length ${m.length}`);
  assert.ok(m.startsWith('Help wanted on T-MWXRH2E0KIS: "x'));
  assert.ok(m.endsWith(")"));
});

test("retryWake: a failed or expired wakeup goes back to scheduled, due now, with a fresh expiry", async () => {
  const { retryWake } = await import("./wake.js");
  const w = { id: "W-1", target: "t9", text: "x", due: 1, expires: 2, status: "failed", reason: "hc send failed", at: 3, enabled: true };
  const [r, o] = retryWake([w, { id: "W-2", status: "failed", due: 1 }], "W-1", 1000);
  assert.equal(r.status, "scheduled");
  assert.equal(r.due, 1000);
  assert.ok(r.expires > 1000);
  assert.equal(r.reason, null);
  assert.equal(o.status, "failed", "other wakeups stay");
});

test("the 201st dismissal (through dismiss + prune) drops the oldest by dismissed-at", () => {
  const now = 1e12;
  let m = {};
  for (let i = 0; i < 201; i++) m = dismiss(m, { key: `T-${i}`, reason: "r" }, now - 1000 + i);
  const kept = prune(m, now);
  assert.equal(Object.keys(kept).length, 200);
  assert.ok(!("T-0" in kept) && "T-1" in kept && "T-200" in kept);
});

test("prune drops nothing for an empty map or a map of fresh entries under the cap (no read, no list of keys)", () => {
  assert.deepEqual(prune({}, 5), {});
  const m = dismiss({}, A, 5);
  assert.equal(prune(m, 6), m);
});
