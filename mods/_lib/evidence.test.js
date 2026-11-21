// The frozen evidence contract of the Accept proof panel (B3a): checks classifier, review note format, identity, contract shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChecks, formatReview, parseReview, reviewOf, proofPathOf, buildEvidence, EVIDENCE_KEYS, PR_KEYS, CHECKS_KEYS, VERDICT_KEYS, ghCall, GH_UNSET, ghProblem, repoOfUrl } from "./evidence.js";

const A = "a".repeat(40), B = "b".repeat(40);
const run = (name, conclusion, status = "COMPLETED") => ({ __typename: "CheckRun", name, status, conclusion });
const ctx = (context, state) => ({ __typename: "StatusContext", context, state });

test("checks: every real-shaped success is green", () => {
  const c = classifyChecks([run("build", "SUCCESS"), ctx("ci/legacy", "SUCCESS"), run("lint", "SUCCESS")]);
  assert.equal(c.green, true);
  assert.deepEqual(c.items.map((i) => [i.name, i.state]), [["build", "pass"], ["ci/legacy", "pass"], ["lint", "pass"]]);
});

test("checks: a status-only success is green", () => {
  assert.equal(classifyChecks([ctx("ci", "SUCCESS")]).green, true);
});

for (const [label, rollup, want] of [
  ["missing rollup (null)", null, "missing"],
  ["missing rollup (undefined)", undefined, "missing"],
  ["not an array", { nope: 1 }, "missing"],
  ["empty rollup", [], "empty"],
  ["queued", [run("build", null, "QUEUED")], "pending"],
  ["in progress", [run("build", null, "IN_PROGRESS")], "pending"],
  ["status pending", [ctx("ci", "PENDING")], "pending"],
  ["status expected", [ctx("ci", "EXPECTED")], "pending"],
  ["red failure", [run("build", "FAILURE")], "red"],
  ["red timed out", [run("build", "TIMED_OUT")], "red"],
  ["status error", [ctx("ci", "ERROR")], "red"],
  ["status failure", [ctx("ci", "FAILURE")], "red"],
  ["cancelled", [run("build", "CANCELLED")], "cancelled"],
  ["skipped", [run("build", "SKIPPED")], "skipped"],
  ["neutral", [run("build", "NEUTRAL")], "neutral"],
  ["unknown conclusion", [run("build", "SOMETHING_NEW")], "unknown"],
  ["unknown type", [{ __typename: "Mystery", name: "x", state: "SUCCESS" }], "unknown"],
  ["unknown status state", [ctx("ci", "WEIRD")], "unknown"],
  ["completed without a conclusion", [run("build", null, "COMPLETED")], "unknown"],
  ["a junk row", [null, "x"], "unknown"],
  ["mixed: success plus one pending", [run("a", "SUCCESS"), run("b", null, "IN_PROGRESS"), ctx("c", "SUCCESS")], "pending"],
  ["mixed: success plus one red", [run("a", "SUCCESS"), run("b", "FAILURE")], "red"],
  ["mixed: success plus one skipped", [run("a", "SUCCESS"), run("b", "SKIPPED")], "skipped"],
]) {
  test(`checks: ${label} is NOT green`, () => {
    const c = classifyChecks(rollup);
    assert.equal(c.green, false);
    assert.ok(c.reason && c.reason.length > 0, "a reason is given");
    assert.match(c.reason.toLowerCase(), new RegExp(want));
  });
}

test("checks: names come from name or context; a missing name is shown as unnamed", () => {
  const c = classifyChecks([run("build", "SUCCESS"), ctx("ci/x", "PENDING"), { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]);
  assert.deepEqual(c.items.map((i) => i.name), ["build", "ci/x", "(unnamed)"]);
});

test("checks: items are plain data of name and state only", () => {
  const c = classifyChecks([run("build", "SUCCESS")]);
  assert.deepEqual(Object.keys(c.items[0]).sort(), ["name", "state"]);
});

test("review note: format and parse round-trip, with spaces in the path", () => {
  const text = formatReview({ head: A, verdict: "pass", report: "/work dir/review 1.md" });
  assert.equal(text, `head=${A} verdict=pass report="/work dir/review 1.md"`);
  assert.deepEqual(parseReview(text), { head: A, verdict: "pass", report: "/work dir/review 1.md" });
  assert.deepEqual(parseReview(`head=${B} verdict=adverse report=/plain/review.md`), { head: B, verdict: "adverse", report: "/plain/review.md" });
});

test("review note: malformed text never parses", () => {
  for (const bad of ["", "pass", `head=${A} verdict=pass`, `head=short verdict=pass report=/x.md`, `head=${A} verdict=maybe report=/x.md`,
    `head=${A} verdict=pass report=relative.md`, `head=${A.toUpperCase()} verdict=pass report=/x.md`, `head=${A} verdict=pass report=/x.md extra`,
    `head=${A} verdict=pass report="/x.md`, `head=${A} verdict=pass report=""`, `head=${A}  verdict=pass report=/x.md`, null, undefined, 7]) {
    assert.equal(parseReview(bad), null, JSON.stringify(bad));
  }
  assert.throws(() => formatReview({ head: A, verdict: "pass", report: "rel.md" }));
  assert.throws(() => formatReview({ head: A, verdict: "pass", report: '/a"b.md' }));
});

const note = (kind, text, at = 1, by = "inspector") => ({ id: "n" + at, at, by, kind, text });

test("review: newest review note on the same head is pass or adverse", () => {
  const notes = [note("review", formatReview({ head: A, verdict: "adverse", report: "/r1.md" }), 1), note("log", "x", 2), note("review", formatReview({ head: A, verdict: "pass", report: "/r2.md" }), 3)];
  assert.deepEqual(reviewOf(notes, A), { state: "pass", head: A, by: "inspector", at: 3, report: "/r2.md", was: null });
  const adv = reviewOf([note("review", formatReview({ head: A, verdict: "adverse", report: "/r1.md" }))], A);
  assert.equal(adv.state, "adverse");
});

test("review: a review of another head is stale, and keeps what it was", () => {
  const v = reviewOf([note("review", formatReview({ head: B, verdict: "pass", report: "/r.md" }))], A);
  assert.equal(v.state, "stale");
  assert.equal(v.head, B);
  assert.equal(v.was, "pass");
});

test("review: none, wrong kind, malformed, or unknown head is missing, never pass", () => {
  assert.equal(reviewOf([], A).state, "missing");
  assert.equal(reviewOf(undefined, A).state, "missing");
  assert.equal(reviewOf([note("log", formatReview({ head: A, verdict: "pass", report: "/r.md" }))], A).state, "missing");
  assert.equal(reviewOf([note("review", "pass please")], A).state, "missing");
  assert.equal(reviewOf([note("review", formatReview({ head: A, verdict: "pass", report: "/r.md" })), note("review", "garbled", 9)], A).state, "missing", "the newest one decides");
  assert.equal(reviewOf([note("review", formatReview({ head: A, verdict: "pass", report: "/r.md" }))], null).state, "stale", "no known head: a review is never fresh");
});

test("proof artifact: the path of the last pr or handoff note line proof=", () => {
  const notes = [note("handoff", "done\nproof=/old.md", 1), note("log", "proof=/ignored.md", 2), note("pr", 'PR #5\nproof="/my dir/proof 2.png"', 3)];
  assert.equal(proofPathOf(notes), "/my dir/proof 2.png");
  assert.equal(proofPathOf([note("handoff", "no proof here")]), null);
  assert.equal(proofPathOf([note("handoff", "proof=relative.md")]), null);
  assert.equal(proofPathOf(undefined), null);
});

const parts = (over = {}) => ({
  repo: "o/r", pr: { state: "found", number: 5, url: "https://github.com/o/r/pull/5", prState: "OPEN" },
  base: "main", baseSha: B, head: A, headSource: "pr", checks: classifyChecks([run("a", "SUCCESS")]),
  verdict: reviewOf([], A), ...over,
});

test("contract: the key set is frozen (a change here is a deliberate break for B3b)", () => {
  assert.deepEqual(EVIDENCE_KEYS, ["v", "repo", "pr", "base", "baseSha", "head", "headSource", "checks", "verdict"]);
  assert.deepEqual(PR_KEYS, ["state", "number", "url", "prState", "reason"]);
  assert.deepEqual(CHECKS_KEYS, ["green", "reason", "items"]);
  assert.deepEqual(VERDICT_KEYS, ["state", "head", "by", "at", "report", "was"]);
  const e = buildEvidence(parts());
  assert.deepEqual(Object.keys(e), EVIDENCE_KEYS);
  assert.deepEqual(Object.keys(e.pr), PR_KEYS);
  assert.deepEqual(Object.keys(e.checks), CHECKS_KEYS);
  assert.deepEqual(Object.keys(e.verdict), VERDICT_KEYS);
  assert.equal(e.v, 1);
});

test("contract: the result is deep-frozen and drops unknown input keys", () => {
  const e = buildEvidence({ ...parts(), extra: "x" });
  assert.equal(Object.isFrozen(e) && Object.isFrozen(e.pr) && Object.isFrozen(e.checks) && Object.isFrozen(e.checks.items) && Object.isFrozen(e.checks.items[0]) && Object.isFrozen(e.verdict), true);
  assert.equal("extra" in e, false);
  assert.throws(() => { "use strict"; e.head = "x"; });
});

test("contract: PR states are tagged found | none | unknown; unknown carries a reason", () => {
  assert.deepEqual({ ...buildEvidence(parts({ pr: { state: "none" }, headSource: "worktree" })).pr }, { state: "none", number: null, url: null, prState: null, reason: null });
  const u = buildEvidence(parts({ pr: { state: "unknown", reason: "auth" }, head: null, baseSha: null }));
  assert.equal(u.pr.state, "unknown");
  assert.equal(u.pr.reason, "auth");
  assert.equal(u.head, null);
  assert.throws(() => buildEvidence(parts({ pr: { state: "maybe" } })));
});

test("contract: no PR means head is the worktree commit, checks are not green with a reason", () => {
  const e = buildEvidence(parts({ pr: { state: "none" }, headSource: "worktree", baseSha: null, checks: classifyChecks(undefined, { noPr: true }) }));
  assert.equal(e.headSource, "worktree");
  assert.equal(e.checks.green, false);
  assert.match(e.checks.reason, /No PR/);
});

test("contract: a head that is not a full commit id is refused", () => {
  assert.throws(() => buildEvidence(parts({ head: "abc" })));
  assert.throws(() => buildEvidence(parts({ baseSha: "abc" })));
});

test("gh argv: env -u for every selector, no shell, then gh", () => {
  assert.deepEqual(GH_UNSET, ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR", "GH_HOST", "GH_REPO"]);
  const c = ghCall(["pr", "view", "https://x/pull/1", "--json=number"]);
  assert.equal(c.cmd, "/usr/bin/env");
  for (const v of GH_UNSET) {
    const i = c.args.indexOf(v);
    assert.ok(i > 0 && c.args[i - 1] === "-u", `-u ${v}`);
  }
  assert.deepEqual(c.args.slice(GH_UNSET.length * 2), ["gh", "pr", "view", "https://x/pull/1", "--json=number"]);
});

test("gh problems are bounded categories, never raw text", () => {
  assert.equal(ghProblem("gh auth login required: To get started with GitHub CLI, please run: gh auth login"), "auth");
  assert.equal(ghProblem("HTTP 401: Bad credentials"), "auth");
  assert.equal(ghProblem("error connecting to api.github.com"), "offline");
  assert.equal(ghProblem("Could not resolve to a PullRequest"), "not-found");
  assert.equal(ghProblem("HTTP 404: Not Found"), "not-found");
  assert.equal(ghProblem("secret " + "ghp" + "_" + "ZyXwVuTsRqPoNmLkJiHg" + " exploded"), "unexpected");
  assert.equal(ghProblem(""), "unexpected");
});

test("repoOfUrl reads owner/repo from a PR URL only", () => {
  assert.equal(repoOfUrl("https://github.com/o/r/pull/5"), "o/r");
  assert.equal(repoOfUrl("https://github.com/o/r/issues/5"), null);
  assert.equal(repoOfUrl("https://evil.example/o/r/pull/5"), null);
  assert.equal(repoOfUrl("nope"), null);
});
