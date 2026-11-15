// GitHub filter value sources: gh api args, fixture parsers, cache, merge with loaded items, menu rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ghApiArgs, parseValues, createValues, valuesFor, avatarUrl, TTL, FAIL_TTL } from "../drover-github/values.js";
import { menuState } from "../drover-github/menu.js";
import { tokenize } from "../drover-github/filter.js";

const C = (text) => ({ text, tokens: [] });
const ok = (json) => ({ code: 0, stdout: JSON.stringify(json), stderr: "" });
const fake = (answers) => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const a = typeof answers === "function" ? answers(args) : answers;
    if (a instanceof Error) throw a;
    return a;
  };
  return { exec, calls };
};
const clock = () => { const c = { t: 1000, now: () => c.t }; return c; };

test("ghApiArgs: repo scopes only, per_page 100", () => {
  assert.deepEqual(ghApiArgs("o/r", "label"), ["api", "repos/o/r/labels?per_page=100"]);
  assert.deepEqual(ghApiArgs("o/r", "assignee"), ["api", "repos/o/r/assignees?per_page=100"]);
  assert.deepEqual(ghApiArgs("o/r", "author"), ["api", "repos/o/r/assignees?per_page=100"]);
  assert.deepEqual(ghApiArgs("o/r", "milestone"), ["api", "repos/o/r/milestones?state=open&per_page=100"]);
  assert.equal(ghApiArgs("org", "label"), null);
  assert.equal(ghApiArgs("o/r", "state"), null);
});

test("parseValues: labels, people, milestones, empty, malformed, 403 object", () => {
  assert.deepEqual(parseValues("label", [{ name: "bug", color: "d73a4a", id: 1 }, { name: "good first issue", color: "7057ff" }]),
    [{ value: "bug", color: "d73a4a" }, { value: "good first issue", color: "7057ff" }]);
  assert.deepEqual(parseValues("assignee", [{ login: "ada", id: 1 }]), [{ login: "ada", avatar: "https://github.com/ada.png?size=40" }]);
  assert.equal(avatarUrl("ada"), "https://github.com/ada.png?size=40");
  assert.deepEqual(parseValues("milestone", [{ title: "v1", number: 1 }, { title: "v2" }]), [{ value: "v1" }, { value: "v2" }]);
  assert.deepEqual(parseValues("label", []), []);
  assert.deepEqual(parseValues("label", [{ color: "x" }, null, { name: "" }, { name: "ok" }]), [{ value: "ok", color: "" }]);
  assert.throws(() => parseValues("label", { message: "Resource not accessible", status: "403" }));
  assert.throws(() => parseValues("label", "<html>"));
  assert.equal(parseValues("label", Array.from({ length: 150 }, (_, i) => ({ name: `l${i}` }))).length, 100);
});

test("fetch: one gh api call per repo scope, then served from the cache", async () => {
  const { exec, calls } = fake(ok([{ name: "bug", color: "f00" }]));
  const c = clock();
  const v = createValues({ exec, now: c.now });
  assert.equal(v.peek("o/r", "label"), null);
  await v.fetch("label", ["o/r", "org"]);
  assert.equal(calls.length, 1); // org scope: no call
  assert.deepEqual(calls[0], ["gh", "api", "repos/o/r/labels?per_page=100"]);
  assert.deepEqual(v.peek("o/r", "label"), { ok: true, values: [{ value: "bug", color: "f00" }] });
  c.t += TTL - 1;
  await v.fetch("label", ["o/r"]);
  assert.equal(calls.length, 1);
  c.t += 2; // expired
  assert.equal(v.peek("o/r", "label"), null);
  await v.fetch("label", ["o/r"]);
  assert.equal(calls.length, 2);
});

test("fetch: in-flight calls are shared; assignee/author/involves share one endpoint", async () => {
  const { exec, calls } = fake(ok([{ login: "ada" }]));
  const v = createValues({ exec, now: clock().now });
  await Promise.all([v.fetch("assignee", ["o/r"]), v.fetch("assignee", ["o/r"]), v.fetch("author", ["o/r"])]);
  assert.equal(calls.length, 1);
  await v.fetch("involves", ["o/r"]);
  assert.equal(calls.length, 1);
});

test("fetch: failures never throw, give ok:false, and are retried after the short TTL", async () => {
  const c = clock();
  for (const answer of [{ code: 1, stdout: "", stderr: "HTTP 403" }, { code: 0, stdout: "not json", stderr: "" }, ok({ message: "SAML" }), new Error("spawn")]) {
    const { exec, calls } = fake(answer);
    const v = createValues({ exec, now: c.now });
    await v.fetch("label", ["o/r"]);
    assert.equal(v.peek("o/r", "label").ok, false);
    await v.fetch("label", ["o/r"]);
    assert.equal(calls.length, 1);
    c.t += FAIL_TTL + 1;
    assert.equal(v.peek("o/r", "label"), null);
    await v.fetch("label", ["o/r"]);
    assert.equal(calls.length, 2);
  }
});

const items = [
  { repo: "org/a", labels: ["bug", "Docs"], author: "ada", assignees: ["bob"] },
  { repo: "org/b", labels: ["docs", "ui"], author: "Ada", assignees: ["cy", "bob"] },
  { repo: "other/x", labels: ["nope"], author: "zed", assignees: [] },
];

test("valuesFor: org scope uses values seen on loaded items, deduped case-insensitively", () => {
  const v = createValues({ exec: fake(ok([])).exec });
  const r = valuesFor("label", ["org"], items, v);
  assert.deepEqual(r.map((x) => x.value), ["bug", "Docs", "ui"]);
  assert.deepEqual(valuesFor("author", ["org"], items, v).map((x) => x.login), ["ada"]);
  assert.deepEqual(valuesFor("assignee", ["org"], items, v).map((x) => x.login), ["bob", "cy"]);
  assert.equal(valuesFor("assignee", ["org"], items, v)[0].avatar, "https://github.com/bob.png?size=40");
});

test("valuesFor: repo scope uses the API list; a failed lookup falls back to what was seen", async () => {
  const good = createValues({ exec: fake(ok([{ name: "api-label", color: "0f0" }])).exec });
  await good.fetch("label", ["org/a"]);
  assert.deepEqual(valuesFor("label", ["org/a"], items, good), [{ value: "api-label", color: "0f0" }]);
  const bad = createValues({ exec: fake({ code: 1, stdout: "", stderr: "403" }).exec });
  await bad.fetch("label", ["org/a"]);
  assert.deepEqual(valuesFor("label", ["org/a"], items, bad).map((x) => x.value), ["bug", "Docs"]);
  // not fetched yet: also seen values
  assert.deepEqual(valuesFor("label", ["org/a"], items, createValues({ exec: fake(ok([])).exec })).map((x) => x.value), ["bug", "Docs"]);
});

test("valuesFor: milestone comes from the API only; mixed scopes merge; bounded", async () => {
  const v = createValues({ exec: fake(ok([{ title: "v1" }])).exec });
  assert.deepEqual(valuesFor("milestone", ["org/a"], items, v), []);
  await v.fetch("milestone", ["org/a"]);
  assert.deepEqual(valuesFor("milestone", ["org/a", "org"], items, v), [{ value: "v1" }]);
  const many = [{ repo: "org/a", labels: Array.from({ length: 300 }, (_, i) => `l${i}`) }];
  assert.ok(valuesFor("label", ["org"], many, v).length <= 100);
});

test("valuesFor and menuState never call gh (typing makes no request)", () => {
  const { exec, calls } = fake(ok([]));
  const v = createValues({ exec });
  for (const t of ["label:", "label:b", "label:bu"]) menuState(C(t), undefined, { scopes: ["org"], values: { label: valuesFor("label", ["org"], items, v) } });
  assert.equal(calls.length, 0);
});

const vals = (extra = {}) => ({
  label: [{ value: "bug", color: "f00" }, { value: "good first issue" }, { value: "debug-me" }],
  assignee: [{ login: "ada", avatar: avatarUrl("ada") }, { login: "bob", avatar: avatarUrl("bob") }],
  milestone: [{ value: "v1" }, { value: "Q4 launch" }],
  ...extra,
});
const labelsOf = (m) => m.items.map((i) => i.label);

test("menu: people rows follow Me (first) and carry the avatar; values come before No/Exclude", () => {
  const m = menuState(C("assignee:"), undefined, { scopes: ["org"], values: vals() });
  assert.deepEqual(labelsOf(m), ["Me", "ada", "bob", "No assignee", "Exclude"]);
  assert.equal(m.items[1].avatar, "https://github.com/ada.png?size=40");
  assert.equal(m.items[1].insert.token.text, "assignee:ada");
  assert.equal(m.items[0].avatar, undefined);
});

test("menu: typed text filters values by prefix then substring, case-insensitive", () => {
  const m = menuState(C("label:BU"), undefined, { values: vals() });
  assert.deepEqual(labelsOf(m).slice(0, 2), ["bug", "debug-me"]);
  assert.equal(labelsOf(m).at(-1), "Use BU");
});

test("menu: a multiword value is one qualToken value, shown quoted", () => {
  const m = menuState(C("label:good"), undefined, { values: vals() });
  const item = m.items.find((i) => i.label === "good first issue");
  assert.equal(item.insert.token.text, 'label:"good first issue"');
  assert.deepEqual(JSON.parse(item.insert.token.id), { key: "label", value: "good first issue", negated: false });
  const ms = menuState(C("milestone:q"), undefined, { values: vals() }).items.find((i) => i.label === "Q4 launch");
  assert.equal(ms.insert.token.text, 'milestone:"Q4 launch"');
});

test("menu: no match or no values (API failed) keeps free text via Use <typed>", () => {
  assert.deepEqual(labelsOf(menuState(C("label:zzz"), undefined, { values: vals() })), ["Use zzz"]);
  assert.deepEqual(labelsOf(menuState(C("milestone:v9"), undefined, { values: {} })), ["Use v9"]);
  assert.deepEqual(labelsOf(menuState(C("label:"), undefined, { values: {} })).includes("No label"), true);
  assert.equal(menuState(C("label:bug"), undefined, { values: vals() }).items.some((i) => i.label.startsWith("Use")), false);
  const exact = menuState(C("assignee:ADA"), undefined, { values: vals() });
  assert.equal(exact.items.some((i) => i.label === "Use ADA"), false);
});

test("menu: negated key lists values; rows are capped", () => {
  assert.equal(menuState(C("-label:"), undefined, { values: vals() }).items.some((i) => i.label === "bug"), true);
  const big = { label: Array.from({ length: 100 }, (_, i) => ({ value: `l${i}` })) };
  assert.ok(menuState(C("label:"), undefined, { values: big }).items.length <= 53);
  assert.ok(tokenize);
});

test("valuesFor: loaded-item fallback matches scopes case-insensitively (org, failed repo; labels and people)", async () => {
  const its = [{ repo: "org/a", labels: ["bug"], author: "ada", assignees: ["bob"] }];
  const v = createValues({ exec: fake({ code: 1, stdout: "", stderr: "403" }).exec });
  await v.fetch("label", ["ORG/A"]);
  assert.deepEqual(valuesFor("label", ["ORG"], its, v).map((x) => x.value), ["bug"]);
  assert.deepEqual(valuesFor("label", ["ORG/A"], its, v).map((x) => x.value), ["bug"]);
  assert.deepEqual(valuesFor("assignee", ["ORG"], its, v).map((x) => x.login), ["bob"]);
  assert.deepEqual(valuesFor("author", ["Org/A"], its, v).map((x) => x.login), ["ada"]);
});

test("stale: true only for a repo scope with nothing fresh cached", async () => {
  const c = clock();
  const v = createValues({ exec: fake(ok([])).exec, now: c.now });
  assert.equal(v.stale("label", ["org"]), false);
  assert.equal(v.stale("label", ["o/r"]), true);
  await v.fetch("label", ["o/r"]);
  assert.equal(v.stale("label", ["o/r"]), false);
  c.t += TTL + 1;
  assert.equal(v.stale("label", ["o/r"]), true);
});

test("menu: an exact typed value is never hidden by the 50 row cap", () => {
  const rows = [...Array.from({ length: 51 }, (_, i) => ({ value: `bug-${i}` })), { value: "bug" }];
  const m = menuState(C("label:bug"), undefined, { values: { label: rows } });
  const exact = m.items.find((i) => i.label === "bug");
  assert.ok(exact, "exact row visible");
  assert.equal(m.items.filter((i) => i.id.startsWith("v:")).length, 50);
  assert.equal(m.items.some((i) => i.label === "Use bug"), false);
  // a value that is not listed at all still offers Use
  assert.equal(menuState(C("label:bug-9"), undefined, { values: { label: rows } }).items.some((i) => i.label.startsWith("bug-9")), true);
});
