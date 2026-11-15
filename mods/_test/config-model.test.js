// drover-config dialog model: rows, draft validation, changed flag, set/reset/reset-all. Pure; no herdr import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, validate } from "../_lib/config-schema.js";
import * as C from "../_lib/config.js";
import { createModel } from "../drover-config/model.js";

const M = createModel({ SCHEMA, validate, isOverride: C.isOverride, setOverride: C.setOverride, resetOverride: C.resetOverride, resolve: C.resolve });

test("mods: one entry per schema mod, in schema order, with a readable title", () => {
  const list = M.mods({});
  assert.deepEqual(list.map((m) => m.mod), [...new Set(SCHEMA.map((f) => f.mod))]);
  assert.equal(list.find((m) => m.mod === "drover-github").title, "GitHub");
  assert.equal(list.find((m) => m.mod === "drover-wakeups").title, "Wakeups");
});

test("mods: changed count follows the shared object", () => {
  const shared = { "drover-github": { limit: 50, query: "is:pr" } };
  assert.equal(M.mods(shared).find((m) => m.mod === "drover-github").changed, 2);
  assert.equal(M.mods(shared).find((m) => m.mod === "drover-jira").changed, 0);
});

test("rows: effective value is the default until overridden; changed flag marks overrides", () => {
  const rows = M.rows({}, "drover-github");
  const limit = rows.find((r) => r.key === "limit");
  assert.equal(limit.value, 100);
  assert.equal(limit.changed, false);
  const after = M.rows({ "drover-github": { limit: 100 } }, "drover-github").find((r) => r.key === "limit");
  assert.equal(after.changed, true); // an override equal to the default still counts as changed
  assert.equal(M.rows({ "drover-github": { limit: 7 } }, "drover-github").find((r) => r.key === "limit").value, 7);
});

test("rows: an invalid stored value shows the default, not the bad value", () => {
  const r = M.rows({ "drover-github": { limit: 99999 } }, "drover-github").find((x) => x.key === "limit");
  assert.equal(r.value, 100);
});

test("text: list shows comma separated, an int shows as a string", () => {
  const rows = M.rows({ "drover-github": { scopes: ["a", "b/c"], limit: 5 } }, "drover-github");
  assert.equal(rows.find((r) => r.key === "scopes").text, "a, b/c");
  assert.equal(rows.find((r) => r.key === "limit").text, "5");
});

test("check: int parses text, rejects junk and out of range with a message", () => {
  assert.deepEqual(M.check("drover-github", "limit", " 25 "), { ok: true, value: 25 });
  for (const bad of ["", "abc", "1.5", "0", "1001", "-3"]) {
    const r = M.check("drover-github", "limit", bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /whole number|1 to 1000/);
  }
});

test("check: text trims; empty is refused unless the field allows it", () => {
  assert.deepEqual(M.check("drover-github", "query", "  is:pr  "), { ok: true, value: "is:pr" });
  assert.equal(M.check("drover-github", "query", "   ").ok, false);
  assert.deepEqual(M.check("drover-jira", "site", ""), { ok: true, value: "" });
  assert.equal(M.check("drover-github", "query", "a\nb").ok, false);
});

test("check: list splits on commas, trims, drops empty items", () => {
  assert.deepEqual(M.check("drover-github", "scopes", " a , b/c ,, "), { ok: true, value: ["a", "b/c"] });
  assert.deepEqual(M.check("drover-github", "scopes", ""), { ok: true, value: [] });
});

test("check: boolean passes through, wrong type refused, unknown field refused", () => {
  assert.deepEqual(M.check("drover-board", "enabled", false), { ok: true, value: false });
  assert.equal(M.check("drover-board", "enabled", "yes").ok, false);
  assert.equal(M.check("drover-nope", "x", "1").ok, false);
});

test("set: a valid draft returns a new shared with only that value; input untouched", () => {
  const before = { "drover-jira": { pages: 3 } };
  const r = M.set(before, "drover-github", "limit", "25");
  assert.equal(r.ok, true);
  assert.deepEqual(r.shared, { "drover-jira": { pages: 3 }, "drover-github": { limit: 25 } });
  assert.deepEqual(before, { "drover-jira": { pages: 3 } });
});

test("set: an invalid draft is never written (no shared in the result)", () => {
  const r = M.set({}, "drover-github", "limit", "0");
  assert.equal(r.ok, false);
  assert.equal("shared" in r, false);
  assert.match(r.error, /1 to 1000/);
});

test("reset: removes the override, leaves siblings, drops an empty mod object; never writes the default", () => {
  const shared = { "drover-github": { limit: 5, query: "is:pr" } };
  assert.deepEqual(M.reset(shared, "drover-github", "limit"), { "drover-github": { query: "is:pr" } });
  assert.deepEqual(M.reset({ "drover-github": { limit: 5 } }, "drover-github", "limit"), {});
});

test("resetAll: clears one mod only", () => {
  const shared = { "drover-github": { limit: 5, query: "is:pr" }, "drover-jira": { pages: 3 } };
  assert.deepEqual(M.resetAll(shared, "drover-github"), { "drover-jira": { pages: 3 } });
  assert.deepEqual(M.resetAll({}, "drover-github"), {});
});

test("step: moves by one and clamps to the field range", () => {
  const f = SCHEMA.find((x) => x.mod === "drover-github" && x.key === "limit");
  assert.equal(M.step(f, 100, 1), 101);
  assert.equal(M.step(f, 1, -1), 1);
  assert.equal(M.step(f, 1000, 1), 1000);
});

test("step: starts from the draft text when it is a number, else the effective value", () => {
  assert.equal(M.stepFrom("drover-github", "limit", "40", 100, 1), 41);
  assert.equal(M.stepFrom("drover-github", "limit", "junk", 100, -1), 99);
});

test("rows: an inherited mod.json value is what shows, and what Reset goes back to", () => {
  const inherited = { limit: 50 };
  const r = M.rows({}, "drover-github", inherited).find((x) => x.key === "limit");
  assert.equal(r.value, 50);
  assert.equal(r.text, "50");
  assert.equal(r.changed, false);
  assert.equal(r.inheritedText, "50");
  assert.equal(r.defaultText, "100");
  const over = M.rows({ "drover-github": { limit: 7 } }, "drover-github", inherited).find((x) => x.key === "limit");
  assert.equal(over.text, "7");
  const back = M.rows(M.reset({ "drover-github": { limit: 7 } }, "drover-github", "limit"), "drover-github", inherited).find((x) => x.key === "limit");
  assert.equal(back.text, "50"); // Reset shows the inherited value, not the schema default
});

test("rows: an invalid inherited value is ignored (default shows, no inheritedText)", () => {
  const r = M.rows({}, "drover-github", { limit: 99999 }).find((x) => x.key === "limit");
  assert.equal(r.text, "100");
  assert.equal(r.inheritedText, null);
});

test("set: typing the default over a different inherited value saves an explicit override", () => {
  const r = M.set({}, "drover-github", "limit", "100");
  assert.deepEqual(r, { ok: true, shared: { "drover-github": { limit: 100 } } });
  const row = M.rows(r.shared, "drover-github", { limit: 50 }).find((x) => x.key === "limit");
  assert.equal(row.text, "100");
  assert.equal(row.changed, true);
});

test("mods: General (drover-config) comes first, titled General", () => {
  const list = M.mods({});
  assert.equal(list[0].mod, "drover-config");
  assert.equal(list[0].title, "General");
});
