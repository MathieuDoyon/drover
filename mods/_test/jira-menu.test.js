// Jira filter key/value menu: pure item builders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { menuState, KEYS, nextIndex } from "../drover-jira/menu.js";
import { qualToken, contentFromModel } from "../drover-jira/query.js";

const at = (text, opts) => menuState({ text, tokens: [] }, undefined, opts);
const labels = (m) => m.items.map((i) => i.label);

test("empty input: the keys in order, then AND / OR / Exclude, then Reset filter", () => {
  const m = at("");
  assert.equal(m.open, true);
  assert.equal(m.stage, "keys");
  assert.deepEqual(KEYS.map((k) => k.label), ["Project", "Status", "Assignee", "Reporter", "Type", "Label", "Priority", "Sprint", "Created", "Updated", "Sort"]);
  assert.deepEqual(labels(m), [...KEYS.map((k) => k.label), "AND", "OR", "Exclude", "Reset filter"]);
  assert.ok(KEYS.every((k) => k.glyph));
  assert.deepEqual(m.items[0].insert, { range: { start: 0, end: 0 }, text: "project:" });
  assert.equal(m.items.find((i) => i.label === "Sort").insert.text, "order:");
  assert.deepEqual(m.items.at(-1).insert, { reset: true });
});

test("typing narrows the keys: ass -> Assignee", () => {
  assert.deepEqual(labels(at("ass")).slice(0, 1), ["Assignee"]);
  assert.ok(!labels(at("ass")).includes("Project"));
  assert.equal(at("zzz").open, false);
});

test("negation: - offers the keys only, with -key: inserted", () => {
  const m = at("-");
  assert.equal(m.negated, true);
  assert.equal(m.items[0].insert.text, "-project:");
  assert.ok(!labels(m).includes("AND") && !labels(m).includes("Exclude") && !labels(m).includes("Reset filter"));
});

test("assignee: values are Me, Unassigned, Exclude, then Jira people", () => {
  const values = { assignee: [{ value: "Ann Lee" }, { value: "Bob" }] };
  const m = at("assignee:", { values });
  assert.equal(m.stage, "values");
  assert.equal(m.key, "assignee");
  assert.deepEqual(labels(m), ["Me", "Unassigned", "Ann Lee", "Bob", "Exclude"]);
  assert.deepEqual(m.items[0].insert.token.id, qualToken({ kind: "qual", key: "assignee", value: "me", negated: false }).id);
  assert.equal(m.items[1].insert.token.text, "assignee:unassigned");
  assert.equal(m.items[2].insert.token.text, 'assignee:"Ann Lee"');
  assert.deepEqual(m.items.at(-1).insert.text, "-assignee:");
});

test("reporter offers Me but not Unassigned; -assignee: has no Exclude and tokens are negated", () => {
  assert.deepEqual(labels(at("reporter:")).slice(0, 2), ["Me", "Exclude"]);
  const m = at("-assignee:");
  assert.ok(!labels(m).includes("Exclude"));
  assert.equal(m.items[0].insert.token.text, "-assignee:me");
});

test("status: lists Jira statuses with spaces as one structured token; typed filter and Use row", () => {
  const values = { status: [{ value: "To Do" }, { value: "In Progress" }, { value: "Done" }] };
  assert.deepEqual(labels(at("status:", { values })), ["To Do", "In Progress", "Done", "Exclude"]);
  assert.deepEqual(labels(at("status:in", { values })).slice(0, 1), ["In Progress"]);
  assert.deepEqual(labels(at("status:Qa", { values })), ["Use Qa"]);
  assert.equal(at("status:Qa", { values }).items[0].insert.token.text, "status:Qa");
});

test("fixed value lists: sprint functions, date presets, sort orders (no Exclude for sort)", () => {
  assert.deepEqual(labels(at("sprint:")).slice(0, 3), ["Open sprints", "Closed sprints", "Future sprints"]);
  assert.equal(at("sprint:").items[0].insert.token.text, "sprint:openSprints()");
  assert.deepEqual(labels(at("created:")).slice(0, 2), ["Last 7 days", "Last 30 days"]);
  assert.equal(at("updated:").items[0].insert.token.text, "updated:>-7d");
  const o = at("order:");
  assert.ok(labels(o).includes("updated-desc"));
  assert.ok(!labels(o).includes("Exclude"));
  assert.equal(o.items.find((i) => i.label === "updated-desc").insert.token.text, "order:updated-desc");
  assert.equal(at("created:>2026-01-01").items[0].insert.token.text, "created:>2026-01-01", "a typed raw value is offered as Use");
});

test("closed: unknown key, quoted value, inside a token, glued to a token", () => {
  assert.equal(at("bogus:").open, false);
  assert.equal(at('status:"x').open, false);
  const t = qualToken({ kind: "qual", key: "status", value: "Done", negated: false });
  const c = contentFromModel([{ kind: "qual", key: "status", value: "Done", negated: false }]);
  assert.equal(menuState(c, 3).open, false, "inside");
  assert.equal(menuState({ text: t.text, tokens: c.tokens }, t.text.length).open, false, "glued");
  assert.equal(menuState(c, c.text.length).open, true, "after the space");
  assert.equal(typeof nextIndex, "function");
});
