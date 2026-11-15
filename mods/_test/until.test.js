// The condition-wait helper itself: the hang guard must work whatever a test does to Date.now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { until, drain } from "./stubs/until.js";

test("until: a frozen Date.now does not disable the cap; the error names the condition", async () => {
  const real = Date.now;
  Date.now = () => 1_000_000;
  try {
    await assert.rejects(() => until(() => false, "never true", 20), /until timed out: never true/);
  } finally { Date.now = real; }
});

test("until: resolves with the truthy value as soon as the condition holds (sync and async conds)", async () => {
  let n = 0;
  assert.equal(await until(() => ++n >= 3 && "ok", "third look"), "ok");
  let done = false;
  setTimeout(() => { done = true; }, 5);
  assert.equal(await until(async () => done, "timer fired"), true);
});

test("drain: yields the requested number of macrotasks", async () => {
  let ran = 0;
  setImmediate(() => { ran++; });
  await drain(2);
  assert.equal(ran, 1);
});
