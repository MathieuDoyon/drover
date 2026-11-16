// Jira filter model: parseQuery, toJql, saved content. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, toJql, jqlModel, tokenize, contentFromModel, restoreContent, defaultContent, qualToken, QUERY_KEY } from "../drover-jira/query.js";

const qual = (key, value, negated = false) => ({ kind: "qual", key, value, negated });

test("parseQuery: keys, negation, quotes, OR, text, unknown keys and empty values", () => {
  assert.deepEqual(parseQuery('status:Open -assignee:me Project:ABC label:"two words" OR fix foo:bar sprint:'), [
    qual("status", "Open"), qual("assignee", "me", true), qual("project", "ABC"), qual("label", "two words"),
    { kind: "op" }, { kind: "text", text: "fix" }, { kind: "text", text: "foo:bar" },
  ]);
  assert.equal(QUERY_KEY, "drover.jira.query");
});

test("toJql: each key, AND implicit, OR operator", () => {
  assert.equal(toJql([qual("project", "ABC"), qual("status", "In Progress")]), 'project = "ABC" AND status = "In Progress"');
  assert.equal(toJql([qual("type", "Bug"), qual("label", "ui"), qual("priority", "High"), qual("reporter", "Ann")]),
    'issuetype = "Bug" AND labels = "ui" AND priority = "High" AND reporter = "Ann"');
  assert.equal(toJql([qual("status", "Open"), { kind: "op" }, qual("status", "Blocked"), qual("project", "A")]),
    'status = "Open" OR status = "Blocked" AND project = "A"');
  assert.equal(toJql([{ kind: "op" }, qual("project", "A"), { kind: "op" }, { kind: "op" }]), 'project = "A"', "dangling OR dropped");
  assert.equal(toJql([]), "");
});

test("toJql: negation, people and sprint functions", () => {
  assert.equal(toJql([qual("status", "Done", true)]), 'status != "Done"');
  assert.equal(toJql([qual("assignee", "me"), qual("reporter", "@Me", true)]), "assignee = currentUser() AND reporter != currentUser()");
  assert.equal(toJql([qual("assignee", "unassigned")]), "assignee = EMPTY");
  assert.equal(toJql([qual("assignee", "Unassigned", true)]), "assignee != EMPTY");
  assert.equal(toJql([qual("sprint", "openSprints()")]), "sprint in openSprints()");
  assert.equal(toJql([qual("sprint", "closedSprints()", true)]), "sprint not in closedSprints()");
  assert.equal(toJql([qual("sprint", "Sprint 4")]), 'sprint = "Sprint 4"');
  assert.equal(toJql([qual("sprint", "openSprints() OR project = X")]), 'sprint = "openSprints() OR project = X"', "only the exact function names are bare");
});

test("toJql: dates, text words, order", () => {
  assert.equal(toJql([qual("created", ">2026-01-01"), qual("updated", ">=-7d")]), 'created > "2026-01-01" AND updated >= "-7d"');
  assert.equal(toJql([qual("created", "2026-01-01")]), 'created = "2026-01-01"');
  assert.equal(toJql([qual("updated", ">-30d", true)]), 'NOT (updated > "-30d")');
  assert.equal(toJql([{ kind: "text", text: "crash" }]), 'text ~ "crash"');
  assert.equal(toJql([qual("project", "A"), qual("order", "updated-desc")]), 'project = "A" ORDER BY updated DESC');
  assert.equal(toJql([qual("order", "created"), qual("order", "key-asc")]), "ORDER BY created ASC, key ASC");
  assert.throws(() => toJql([qual("order", "bogus; drop-desc")]), /Unknown sort/);
});

test("toJql: every value is quoted and escaped, quotes and backslashes cannot break out", () => {
  const evil = 'a" OR project = SECRET OR "b';
  const j = toJql([qual("status", evil)]);
  assert.equal(j, 'status = "a\\" OR project = SECRET OR \\"b"');
  assert.equal(toJql([qual("label", "x\\")]), 'labels = "x\\\\"');
  assert.equal(toJql([qual("label", "a\nb\tc\u0000d")]), 'labels = "a\\nb\\tcd"');
  assert.equal(toJql([{ kind: "text", text: 'q"; x' }]), 'text ~ "q\\"; x"');
  for (const v of [evil, 'x\\"', '\\\\"', '"""']) {
    const body = toJql([qual("project", v)]).slice('project = '.length);
    const stripped = body.replace(/\\[\\"nrt]/g, "");
    assert.equal(stripped.match(/"/g).length, 2, `${v}: only the outer quotes are bare`);
  }
  assert.equal(toJql([qual("created", '>2026" OR 1=1')]), 'created > "2026\\" OR 1=1"');
});

test("jql: tokens are verbatim in parentheses, ORDER BY moves to the end", () => {
  assert.equal(toJql([qual("jql", 'project = A OR project = B')]), "project = A OR project = B", "alone: as it is");
  assert.equal(toJql([qual("jql", "project = A OR project = B"), qual("status", "Open")]), '(project = A OR project = B) AND status = "Open"');
  assert.equal(toJql([qual("jql", "project = A ORDER BY created DESC"), qual("status", "Open")]), '(project = A) AND status = "Open" ORDER BY created DESC');
  assert.equal(toJql([qual("jql", "order by rank")]), "ORDER BY rank");
  assert.equal(toJql([qual("jql", "project = A ORDER BY created DESC"), qual("order", "updated-asc")]), "project = A ORDER BY updated ASC", "an explicit sort wins");
  assert.equal(toJql([qual("jql", "project = A", true)]), "NOT (project = A)");
  assert.equal(toJql(jqlModel("  project =  A\n ORDER BY x ")), "project = A ORDER BY x");
  assert.deepEqual(jqlModel(""), []);
  assert.deepEqual(jqlModel("  "), []);
});

test("content: tokens round-trip, default content is empty, restore falls back", () => {
  assert.deepEqual(defaultContent(), { text: "", tokens: [] });
  const model = [qual("jql", "project = A AND x = \"y\""), qual("status", "In Progress"), { kind: "op" }, qual("assignee", "me", true)];
  const c = contentFromModel(model);
  assert.equal(c.tokens.length, 3);
  assert.deepEqual(tokenize(c), model);
  assert.deepEqual(tokenize(restoreContent(JSON.parse(JSON.stringify(c)))), model);
  assert.equal(restoreContent("junk", null), null);
  assert.equal(qualToken(qual("status", "In Progress")).text, 'status:"In Progress"');
});

test("jql: ORDER BY inside a quoted value is text, not a sort", () => {
  const raw = 'summary ~ "sort order by date"';
  assert.equal(toJql(jqlModel(raw)), raw);
  assert.equal(toJql([...jqlModel(raw), qual("status", "Open")]), `(${raw}) AND status = "Open"`);
  assert.equal(toJql(jqlModel("summary ~ 'a order by b' ORDER BY created DESC")), "summary ~ 'a order by b' ORDER BY created DESC");
  assert.equal(toJql([...jqlModel('summary ~ "say \\"order by\\" x" order by rank'), qual("status", "Open")]), '(summary ~ "say \\"order by\\" x") AND status = "Open" ORDER BY rank');
  assert.equal(toJql([...jqlModel("project = A order by rank"), qual("status", "Open")]), '(project = A) AND status = "Open" ORDER BY rank');
});

test("jqlModel: whitespace inside quotes is kept, outside it is collapsed", () => {
  assert.equal(toJql(jqlModel('labels = "two  spaces"')), 'labels = "two  spaces"');
  assert.equal(toJql(jqlModel("  labels  =\n 'a  b'   AND x = 1 ")), "labels = 'a  b' AND x = 1");
  assert.equal(toJql(jqlModel('summary ~ "a\nb\tc"'.replace("\\n", "\n"))).includes("\n"), false, "no raw newline survives");
  assert.equal(jqlModel('summary ~ "a\nb"')[0].value, 'summary ~ "a\\nb"', "a raw newline in a literal becomes its JQL escape, same meaning");
});
