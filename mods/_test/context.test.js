// loadContext(run, task) with a stubbed gh: no run, linked PRs, provenance, last-good on failure.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const H = globalThis.__host = { props: {}, state: {}, notified: [], agents: [], terminals: [], calls: [], writes: 0 };
let gh;
H.exec = async (cmd, args, opts) => { H.calls.push([cmd, ...args]); H.cwds.push(opts?.cwd); return gh([cmd, ...args]); };
H.cwds = [];
const { loadContext, mergeContext } = await import("../_lib/io.js");

const pr = (n, extra = {}) => ({ number: n, title: `PR ${n}`, state: "OPEN", isDraft: false, url: `https://github.com/o/r/pull/${n}`, createdAt: "2026-01-01T00:00:00Z", ...extra });
const issueUrl = "https://github.com/o/r/issues/7";
const task = { id: "T-1", source: { kind: "github", url: issueUrl } };
const ok = (v) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
const issueJson = { number: 7, title: "Bug", state: "OPEN", assignees: [], url: issueUrl, closedByPullRequestsReferences: [{ url: pr(11).url }] };

beforeEach(() => { H.calls = []; });

test("github issue with closing PRs and no run: linked PRs show, labelled linked, no branch lookup", async () => {
  gh = ([, sub, verb]) => (sub === "issue" ? ok(issueJson) : ok(pr(11)));
  const c = await loadContext(null, task);
  assert.deepEqual(c.errors, []);
  assert.equal(c.issue.key, "o/r#7");
  assert.deepEqual(c.prs.map((p) => [p.number, p.from]), [[11, "linked"]]);
  assert.ok(!H.calls.some((a) => a.includes("--head")), "no branch PR lookup without a run");
});

test("no run and no source: nothing to show, no calls", async () => {
  const c = await loadContext(null, { id: "T-2" });
  assert.deepEqual([c.issue, c.prs, c.errors], [null, [], []]);
  assert.equal(H.calls.length, 0);
});

test("PRs on the run branch are labelled branch; a linked PR already found by branch keeps the branch label", async () => {
  const run = { id: "R", worktree: { path: "/w", branch: "feat/x" } };
  gh = (a) => {
    if (a[1] === "issue") return ok(issueJson);
    if (a[2] === "list" && a.includes("--head")) return ok([pr(10), pr(11)]);
    return ok(pr(11));
  };
  const c = await loadContext(run, task);
  assert.deepEqual(c.prs.map((p) => [p.number, p.from]), [[10, "branch"], [11, "branch"]]);
});

test("a PR carried by another PR's branch stays via-labelled with from: branch", async () => {
  const run = { id: "R", worktree: { path: "/w", branch: "feat/x" } };
  gh = (a) => {
    if (a[2] === "list" && a.includes("--head")) return ok([]);
    if (a[2] === "list") return ok([{ ...pr(20), headRefName: "feat/y", headRefOid: "abc", baseRefName: "main" }]);
    return { code: 0, stdout: "", stderr: "" }; // git merge-base: 0 = ancestor of head, then...
  };
  H.exec = async (cmd, args) => {
    H.calls.push([cmd, ...args]);
    if (cmd === "git") return { code: args.at(-1) === "abc" ? 0 : 1, stdout: "", stderr: "" };
    return gh([cmd, ...args]);
  };
  const c = await loadContext(run, { id: "T-3" });
  assert.deepEqual(c.prs.map((p) => [p.number, p.via, p.from]), [[20, "feat/y", "branch"]]);
  H.exec = async (cmd, args) => { H.calls.push([cmd, ...args]); return gh([cmd, ...args]); };
});

test("gh failure after good data keeps the last good issue and PRs and adds the error", async () => {
  gh = ([, sub]) => (sub === "issue" ? ok(issueJson) : ok(pr(11)));
  const good = mergeContext(undefined, await loadContext(null, task));
  gh = () => ({ code: 1, stdout: "", stderr: "gh: network down\n" });
  const bad = await loadContext(null, task);
  assert.equal(bad.issue, null);
  assert.ok(bad.errors.length >= 1);
  const m = mergeContext(good, bad);
  assert.equal(m.issue.key, "o/r#7");
  assert.deepEqual(m.prs.map((p) => p.number), [11]);
  assert.equal(m.good, good.at);
  assert.ok(m.errors[0].includes("gh:"));
});

test("prLabel: number plus provenance; carried keeps 'via X'; unknown provenance shows just the number", async () => {
  const { prLabel } = await import("../_lib/sources.js");
  assert.equal(prLabel({ number: 12, from: "branch" }), "#12 · branch");
  assert.equal(prLabel({ number: 12, from: "linked" }), "#12 · linked");
  assert.equal(prLabel({ number: 20, from: "branch", via: "feat/y" }), "#20 · via feat/y");
  assert.equal(prLabel({ number: 5 }), "#5");
});

test("project property label follows the issue source, not always Jira", async () => {
  const { projectLabel, githubIssue, jiraIssue } = await import("../_lib/sources.js");
  assert.equal(projectLabel(githubIssue(issueJson, issueUrl)), "GitHub repo");
  assert.equal(projectLabel(jiraIssue({ key: "A-1", fields: {} }, "x.atlassian.net")), "Jira project");
});

test("a finished child run whose worktree folder is gone looks up its branch from the repo, not the missing folder", async () => {
  const run = { id: "R", worktree: { repo: "/tmp", path: "/gone/worktree", branch: "feat/T-9/x" } };
  H.cwds = [];
  H.exec = async (cmd, args, opts) => {
    H.calls.push([cmd, ...args]); H.cwds.push(opts?.cwd);
    if (opts?.cwd === "/gone/worktree") throw new Error("No such file or directory (os error 2)"); // the host exec rejects on a missing cwd
    return gh([cmd, ...args]);
  };
  gh = (a) => (a.includes("--head") ? ok([pr(30)]) : ok([]));
  const c = await loadContext(run, { id: "T-9" });
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.prs.map((p) => [p.number, p.from]), [[30, "branch"]]);
  assert.equal(H.cwds.at(-1), "/tmp");
});
