// T-MWO6FADBCH4: the pure Dock badge writer. 0 hides, a change writes once, a disabled badge clears, a throwing setBadge retries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockBadge, badgeText } from "./dockbadge.js";

function make(init = {}) {
  const s = { n: 0, on: true, calls: [], fail: false, ...init };
  s.badge = createDockBadge({ count: () => s.n, enabled: () => s.on, setBadge: (t) => { if (s.fail) throw new Error("host"); s.calls.push(t); } });
  return s;
}

test("badgeText: positive integers are the plain count (no cap); 0, negatives and junk hide", () => {
  assert.equal(badgeText(3), "3");
  assert.equal(badgeText(150), "150");
  for (const n of [0, -1, 1.5, NaN, undefined, null, "4"]) assert.equal(badgeText(n), null);
});

test("0 hides: the first sync writes null once, later syncs at 0 write nothing", () => {
  const s = make();
  s.badge.sync(); s.badge.sync(); s.badge.sync();
  assert.deepEqual(s.calls, [null]);
});

test("a change writes once: the same count never rewrites, a new count does, back to 0 clears", () => {
  const s = make({ n: 2 });
  s.badge.sync(); s.badge.sync();
  s.n = 3; s.badge.sync(); s.badge.sync();
  s.n = 200; s.badge.sync();
  s.n = 0; s.badge.sync(); s.badge.sync();
  assert.deepEqual(s.calls, ["2", "3", "200", null]);
});

test("disabled: clears once and never writes a count; enabling again writes the count", () => {
  const s = make({ n: 4 });
  s.badge.sync();
  s.on = false; s.badge.sync(); s.n = 5; s.badge.sync(); s.badge.sync();
  s.on = true; s.badge.sync();
  assert.deepEqual(s.calls, ["4", null, "5"]);
});

test("a throwing setBadge does not throw and is retried on the next sync, then written once", () => {
  const s = make({ n: 1, fail: true });
  s.badge.sync(); s.badge.sync();
  assert.deepEqual(s.calls, []);
  s.fail = false; s.badge.sync(); s.badge.sync();
  assert.deepEqual(s.calls, ["1"]);
});

test("clear(): clears a written badge once; nothing to clear before any write or after a clear", () => {
  const s = make({ n: 2 });
  s.badge.clear();
  assert.deepEqual(s.calls, []);
  s.badge.sync(); s.badge.clear(); s.badge.clear();
  assert.deepEqual(s.calls, ["2", null]);
  const z = make(); z.badge.sync(); z.badge.clear();
  assert.deepEqual(z.calls, [null]);
});
