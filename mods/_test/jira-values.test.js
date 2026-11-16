// Jira filter value sources over a FAKE jiraFetch: no network, no credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createValues, valuesFor, TTL, FAIL_TTL, parseValues, pathFor } from "../drover-jira/values.js";

const ANSWERS = {
  project: { values: [{ key: "ABC", name: "Alpha" }, { key: "XYZ", name: "Zed" }] },
  status: [{ name: "To Do" }, { name: "Done" }, { name: "To Do" }],
  assignee: [{ accountId: "1", displayName: "Ann Lee", accountType: "atlassian", active: true }, { accountId: "2", displayName: "Bot", accountType: "app", active: true }, { accountId: "3", displayName: "Gone", accountType: "atlassian", active: false }],
  type: [{ name: "Bug" }, { name: "Task" }],
  priority: [{ name: "High" }],
  label: { values: ["ui", "api"] },
};
function rig({ enabled = true, site = "acme.atlassian.net", fail = false } = {}) {
  const calls = [];
  const state = { enabled, site, t: 0, fail };
  const fetch = async (s, path, init, current) => {
    calls.push({ s, path, init, live: current ? current() : undefined });
    if (state.fail) throw new Error("boom");
    const key = Object.keys({ project: 1, status: 1, users: 1, issuetype: 1, priority: 1, label: 1 }).find((k) => path.includes(`/${k}`));
    return { project: ANSWERS.project, status: ANSWERS.status, users: ANSWERS.assignee, issuetype: ANSWERS.type, priority: ANSWERS.priority, label: ANSWERS.label }[key];
  };
  const v = createValues({ fetch, site: () => state.site, enabled: () => state.enabled, now: () => state.t });
  return { v, calls, state };
}

test("pathFor: the endpoints, no list for sprint/dates/sort", () => {
  assert.match(pathFor("project"), /^\/rest\/api\/3\/project\/search/);
  assert.match(pathFor("status"), /^\/rest\/api\/3\/status/);
  assert.match(pathFor("assignee"), /^\/rest\/api\/3\/users\/search/);
  assert.equal(pathFor("reporter"), pathFor("assignee"));
  assert.match(pathFor("type"), /^\/rest\/api\/3\/issuetype/);
  assert.match(pathFor("priority"), /^\/rest\/api\/3\/priority/);
  assert.match(pathFor("label"), /^\/rest\/api\/3\/label/);
  for (const k of ["sprint", "created", "updated", "order"]) assert.equal(pathFor(k), null);
});

test("parseValues: shapes, dedupe, active atlassian people only; non-list answers throw", () => {
  assert.deepEqual(parseValues("project", ANSWERS.project), [{ value: "ABC", hint: "Alpha" }, { value: "XYZ", hint: "Zed" }]);
  assert.deepEqual(parseValues("status", ANSWERS.status), [{ value: "To Do" }, { value: "Done" }]);
  assert.deepEqual(parseValues("assignee", ANSWERS.assignee), [{ value: "Ann Lee" }]);
  assert.deepEqual(parseValues("label", ANSWERS.label), [{ value: "ui" }, { value: "api" }]);
  assert.throws(() => parseValues("status", { errorMessages: ["no"] }), /unknown format/);
  assert.throws(() => parseValues("project", []), /unknown format/);
});

test("fetch goes through the injected jiraFetch with the site and a live check; results are cached 5 min", async () => {
  const { v, calls, state } = rig();
  assert.equal(v.stale("status"), true);
  await v.fetch("status"); await v.fetch("status");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].s, "acme.atlassian.net");
  assert.equal(calls[0].live, true);
  assert.deepEqual(v.peek("status"), { ok: true, values: [{ value: "To Do" }, { value: "Done" }] });
  assert.equal(v.stale("status"), false);
  state.t = TTL - 1; assert.equal(v.stale("status"), false);
  state.t = TTL; assert.equal(v.stale("status"), true);
  await v.fetch("status");
  assert.equal(calls.length, 2);
});

test("assignee and reporter share one request; a failure is remembered 60 s, never throws", async () => {
  const a = rig();
  await a.v.fetch("assignee"); await a.v.fetch("reporter");
  assert.equal(a.calls.length, 1);
  const f = rig({ fail: true });
  await f.v.fetch("label");
  assert.deepEqual(f.v.peek("label"), { ok: false, values: [] });
  await f.v.fetch("label");
  assert.equal(f.calls.length, 1);
  f.state.t = FAIL_TTL; f.state.fail = false;
  await f.v.fetch("label");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.v.peek("label").values, [{ value: "ui" }, { value: "api" }]);
});

test("in-flight calls are shared", async () => {
  const { v, calls } = rig();
  await Promise.all([v.fetch("type"), v.fetch("type"), v.fetch("type")]);
  assert.equal(calls.length, 1);
});

test("Jira off: no request, nothing stale", async () => {
  const { v, calls } = rig({ enabled: false });
  assert.equal(v.stale("status"), false);
  await v.fetch("status"); await v.fetch("project");
  assert.equal(calls.length, 0);
  assert.equal(v.peek("status"), null);
});

test("empty site: no request, nothing stale", async () => {
  const { v, calls } = rig({ site: "" });
  assert.equal(v.stale("status"), false);
  await v.fetch("status");
  assert.equal(calls.length, 0);
});

test("a key without an endpoint never fetches", async () => {
  const { v, calls } = rig();
  assert.equal(v.stale("sprint"), false);
  await v.fetch("sprint"); await v.fetch("order");
  assert.equal(calls.length, 0);
});

test("valuesFor: cached rows for the key, [] when nothing is cached or it failed", async () => {
  const { v } = rig();
  assert.deepEqual(valuesFor("status", v), []);
  await v.fetch("status");
  assert.deepEqual(valuesFor("status", v), [{ value: "To Do" }, { value: "Done" }]);
  const f = rig({ fail: true });
  await f.v.fetch("status");
  assert.deepEqual(valuesFor("status", f.v), []);
});

test("values.js never calls the global fetch and does not read the credential file", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../drover-jira/values.js", import.meta.url), "utf8");
  assert.ok(!/atlassian\.json/.test(src));
  assert.ok(!/(^|[^.\w])fetch\(\s*["'`]/.test(src));
  assert.ok(!/globalThis\.fetch/.test(src));
});

test("the cache and in-flight calls are per site: a site switch fetches again", async () => {
  const { v, calls, state } = rig({ site: "a.atlassian.net" });
  await v.fetch("status");
  assert.equal(v.stale("status"), false);
  state.site = "b.atlassian.net";
  assert.equal(v.peek("status"), null, "A's values are not B's");
  assert.equal(v.stale("status"), true);
  await v.fetch("status");
  assert.deepEqual(calls.map((c) => c.s), ["a.atlassian.net", "b.atlassian.net"]);
  state.site = "a.atlassian.net";
  assert.equal(v.stale("status"), false, "A's own entry is still fresh");
});

test("a late answer of an old site is dropped, a failure of it too", async () => {
  for (const fail of [false, true]) {
    const state = { site: "a.atlassian.net", t: 0 };
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetch = async (s) => { await gate; if (fail) throw new Error("boom"); return ANSWERS.status; };
    const v = createValues({ fetch, site: () => state.site, enabled: () => true, now: () => state.t });
    const pending = v.fetch("status");
    state.site = "b.atlassian.net";
    release();
    await pending;
    assert.equal(v.peek("status"), null, "nothing cached under B");
    assert.equal(v.stale("status"), true);
    state.site = "a.atlassian.net";
    assert.equal(v.peek("status"), null, "and nothing cached for A either: the answer was dropped");
  }
});

test("a late answer is dropped when Jira is switched off meanwhile", async () => {
  const state = { on: true };
  let release;
  const gate = new Promise((r) => { release = r; });
  const v = createValues({ fetch: async () => { await gate; return ANSWERS.status; }, site: () => "a.atlassian.net", enabled: () => state.on });
  const pending = v.fetch("status");
  state.on = false; release(); await pending;
  state.on = true;
  assert.equal(v.peek("status"), null);
});
