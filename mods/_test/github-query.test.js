// GitHub filter query model: parse, serialize to gh argv, scope check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, toArgs, githubSearchArgs, outsideScope, DEFAULT_QUERY } from "../drover-github/query.js";

const BASE = ["search", "issues", "--include-prs"];
const tail = (scope, limit = 50, fields = "number,url") => [
  scope.includes("/") ? `--repo=${scope}` : `--owner=${scope}`, `--limit=${limit}`, `--json=${fields}`,
];
const q = (kind, key, value, negated = false) => ({ kind, key, value, negated });

test("DEFAULT_QUERY serializes to is:issue state:open", () => {
  assert.deepEqual(toArgs(DEFAULT_QUERY), ["is:issue", "state:open"]);
});

test("no query gives exactly today's args", () => {
  const today = ["search", "issues", "--include-prs", "--state=open", "--owner=example-org", "--limit=50", "--json=number,url"];
  for (const none of [undefined, null, [], "", "   "]) {
    assert.deepEqual(githubSearchArgs("example-org", 50, "number,url", none), today);
  }
  assert.deepEqual(githubSearchArgs("example-org/api", 10, "a", undefined),
    ["search", "issues", "--include-prs", "--state=open", "--repo=example-org/api", "--limit=10", "--json=a"]);
});

test("query args put -- right before the query, no --state", () => {
  const args = githubSearchArgs("example-org", 50, "number,url", DEFAULT_QUERY);
  assert.deepEqual(args, [...BASE, ...tail("example-org"), "--", "is:issue", "state:open"]);
  assert.ok(!args.some((a) => a.startsWith("--state")));
  assert.equal(args.indexOf("--"), args.length - 3);
});

test("repo scope uses --repo with a query", () => {
  assert.deepEqual(githubSearchArgs("example-org/api", 5, "x", "is:pr"), [...BASE, ...tail("example-org/api", 5, "x"), "--", "is:pr"]);
});

test("string and model give the same args", () => {
  assert.deepEqual(githubSearchArgs("o", 1, "f", "is:pr label:bug"), githubSearchArgs("o", 1, "f", parseQuery("is:pr label:bug")));
});

test("Exclude: -label:bug and -author:@me", () => {
  assert.deepEqual(toArgs(parseQuery("-label:bug -author:@me")), ["-label:bug", "-author:@me"]);
  assert.deepEqual(toArgs([q("qual", "label", "bug", true)]), ["-label:bug"]);
});

test("OR is its own element and keeps both operands", () => {
  assert.deepEqual(toArgs(parseQuery("author:alice OR author:bob")), ["author:alice", "OR", "author:bob"]);
  assert.deepEqual(toArgs(parseQuery("author:alice OR outage")), ["author:alice", "OR", "outage"]);
  assert.deepEqual(parseQuery("a OR b")[1], { kind: "op" });
});

test("lower-case or is plain text", () => {
  assert.deepEqual(parseQuery("a or b").map((n) => n.kind), ["text", "text", "text"]);
});

test("multi-word label is one element, no quote chars", () => {
  const m = parseQuery('label:"good first issue" is:open');
  assert.deepEqual(m[0], q("qual", "label", "good first issue"));
  assert.deepEqual(toArgs(m), ["label:good first issue", "is:open"]);
  assert.deepEqual(toArgs(parseQuery('-label:"help wanted"')), ["-label:help wanted"]);
});

test("embedded quotes and Unicode stay verbatim", () => {
  assert.deepEqual(toArgs([q("qual", "label", 'say "hi" it\'s')]), ['label:say "hi" it\'s']);
  assert.deepEqual(toArgs(parseQuery("label:café")), ["label:café"]);
  assert.deepEqual(toArgs(parseQuery("日本語")), ["日本語"]);
  assert.deepEqual(toArgs(parseQuery('label:"日本語 テスト"')), ["label:日本語 テスト"]);
  const args = githubSearchArgs("o", 1, "f", [q("qual", "label", 'a "b" c')]);
  assert.equal(args[args.length - 1], 'label:a "b" c');
});

test("involves:@me and involves:alice", () => {
  assert.deepEqual(toArgs(parseQuery("involves:@me involves:alice")), ["involves:@me", "involves:alice"]);
  assert.equal(outsideScope("involves:@me", "example-org"), false);
});

test("repo qualifier: org scope", () => {
  assert.equal(outsideScope("repo:example-org/x", "example-org"), false);
  assert.equal(outsideScope("repo:example-org/x", "example-org"), false);
  assert.equal(outsideScope("org:example-org", "example-org"), false);
  assert.equal(outsideScope("repo:other/x", "example-org"), true);
  assert.equal(outsideScope("org:other", "example-org"), true);
  assert.equal(outsideScope("user:other", "example-org"), true);
  assert.notEqual(githubSearchArgs("example-org", 1, "f", "repo:example-org/x"), null);
  assert.equal(githubSearchArgs("example-org", 1, "f", "repo:other/x"), null);
});

test("repo qualifier: repo scope", () => {
  assert.equal(outsideScope("repo:example-org/api", "example-org/api"), false);
  assert.equal(outsideScope("repo:example-org/API", "example-org/api"), false);
  assert.equal(outsideScope("repo:example-org/web", "example-org/api"), true);
  assert.equal(outsideScope("org:example-org", "example-org/api"), true);
  assert.equal(githubSearchArgs("example-org/api", 1, "f", "repo:example-org/web"), null);
  assert.notEqual(githubSearchArgs("example-org/api", 1, "f", "repo:example-org/api"), null);
});

test("negated repo/org/user pass through", () => {
  assert.equal(outsideScope("-repo:other/x", "example-org"), false);
  const args = githubSearchArgs("example-org", 1, "f", "-repo:other/x");
  assert.equal(args[args.length - 1], "-repo:other/x");
});

test("free text is kept as search words", () => {
  assert.deepEqual(toArgs(parseQuery("login bug in:title")), ["login", "bug", "in:title"]);
  const args = githubSearchArgs("o", 1, "f", "login crash");
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["login", "crash"]);
});

test("empty-value qualifier is dropped", () => {
  assert.deepEqual(parseQuery("label: -author: is:open"), [q("qual", "is", "open")]);
  assert.deepEqual(parseQuery('label:""'), []);
  assert.deepEqual(parseQuery("   "), []);
});

test("parse -> toArgs roundtrip", () => {
  const text = 'is:pr -label:"help wanted" author:@me OR author:alice crash label:café';
  const args = toArgs(parseQuery(text));
  assert.deepEqual(args, ["is:pr", "-label:help wanted", "author:@me", "OR", "author:alice", "crash", "label:café"]);
  assert.deepEqual(toArgs(parseQuery(args.map((a) => (/\s/.test(a) ? a.replace(/:(.*)$/, ':"$1"') : a)).join(" "))), args);
});

test("github search lists every open issue and PR in the scope, not only yours", () => {
  assert.deepEqual(githubSearchArgs("example-org", 50, "number,url"),
    ["search", "issues", "--include-prs", "--state=open", "--owner=example-org", "--limit=50", "--json=number,url"]);
  assert.deepEqual(githubSearchArgs("example-org/api", 5, "f").slice(4, 5), ["--repo=example-org/api"]);
  assert.ok(!githubSearchArgs("example-org", 5, "f").some((a) => a.includes("involves")));
});

test("embedded quote in a value: built as a model node, toArgs verbatim; parse has no escapes", () => {
  assert.deepEqual(toArgs([q("qual", "label", 'a "b" c')]), ['label:a "b" c']);
  // Backslashes are not escapes: the quote after a backslash closes the value and the rest sticks to it.
  assert.deepEqual(parseQuery(String.raw`label:"a \"b\" c"`),
    [q("qual", "label", 'a \\b\\"'), { kind: "text", text: 'c"' }]);
});
