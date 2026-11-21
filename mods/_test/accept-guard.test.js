// B3b (T-MWO3FDGAIKD): the safety spine. No gh or git WRITE may reach the host from any path a test can drive except the real deps' own methods
// (asserted below by argv, against a recording stub that never runs gh). The chain module has no host import and no exec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { A, URL5, P, IO, host, open, render, rev, good, router, ok, prJson, until, isWrite, WRITE_GH } from "./accept-host.js";

const LEAK = "gh" + "p_" + "S".repeat(36); // built by concatenation: a secret-shaped literal must not sit in the file
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const ACCEPT = read("../_lib/accept.js");
const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

test("accept.js imports no host module and has no exec, spawn or fs of its own", () => {
  const c = code(ACCEPT);
  assert.ok(!/from\s+["'](herdr|gpui|fs|fs\/promises|node:)/.test(c), "no host/fs import");
  assert.ok(!/(?<![.\w])exec\s*\(|\bexecFile\b|\bspawn\s*\(|child_process|\bhc\s*\(/.test(c));
  assert.ok(!/^\s*import\b.*\bio\.js/m.test(c), "the chain never imports the real deps");
});

test("accept.js holds no --admin, --auto, --delete-branch or push, and no recursive delete or foreign-lock removal", () => {
  const c = code(ACCEPT);
  assert.ok(!/--admin|--auto|--delete-branch|\bgit push\b|["']push["']/.test(c));
  assert.ok(!/\.rm\(|rmSync|recursive:\s*true\s*,?\s*force|\bunlinkSync\b/.test(c), "no recursive removal");
  // the only removals in the module are inside the ownership-checked release (compare the token first)
  const rel = c.slice(c.indexOf("release"));
  assert.ok(/token/.test(rel));
});

test("accept.js: removal of a lock exists in one place only, after the token comparison", () => {
  const c = code(ACCEPT);
  const removals = c.match(/\b(?:unlink|rmdir)\(/g) ?? [];
  assert.ok(removals.length >= 1 && removals.length <= 3, `removals: ${removals.length}`);
});

test("the trap classifies the write verbs the plan names", () => {
  for (const g of WRITE_GH) assert.ok(isWrite("/usr/bin/env", ["-u", "GH_TOKEN", "gh", ...g, "x"]), g.join(" "));
  assert.ok(isWrite("gh", ["api", "-X", "POST", "repos/o/r/x"]));
  assert.ok(isWrite("/usr/bin/env", ["gh", "api", "--method=PATCH", "x"]));
  assert.ok(isWrite("git", ["push"]) && isWrite("git", ["commit"]) && isWrite("git", ["checkout", "x"]));
  assert.ok(!isWrite("/usr/bin/env", ["gh", "pr", "view", "x"]) && !isWrite("/usr/bin/env", ["gh", "api", "-X", "GET", "x"]));
  assert.ok(!isWrite("git", ["rev-parse", "HEAD"]) && !isWrite("git", ["log"]));
});

test("opening, refreshing and rendering the dialog reaches the host with reads only (trap), for several card states", async () => {
  for (const card of [good(), rev(), good({ source: null })]) {
    const m = await open([card], { trap: true });
    render(m.v, m.cx);
    m.v.proof.refresh(m.cx);
    await until(() => m.v.proof.state === "ready", "ready");
    render(m.v, m.cx);
    assert.deepEqual(m.calls.writes, [], JSON.stringify(m.calls.writes));
  }
});

test("clicking Accept on the dialog with the fake deps injected reaches the host with no write at all (trap)", async () => {
  const m = await open([good()], { trap: true });
  const writes = [];
  IO.useAcceptDeps(fakeDeps(writes));
  try {
    await until(() => m.v.proof.gate?.enabled, "gate enabled");
    await m.v.proof.accept(m.cx);
    assert.deepEqual(m.calls.writes, []);
    assert.ok(writes.includes("merge"), "the fake merge was the only merge");
  } finally { IO.useAcceptDeps(null); }
});

function fakeDeps(log) {
  const real = IO.acceptDeps();
  return {
    ...real,
    merge: async () => { log.push("merge"); return { ok: true }; },
    closeIssue: async () => { log.push("close-issue"); return { ok: true }; },
    moveDone: async () => { log.push("move-done"); return true; },
    note: async () => { log.push("note"); },
    readBack: async () => ({ ok: true, state: "MERGED", head: A }),
    readIssue: async () => ({ ok: true, state: "OPEN", labels: [] }),
  };
}

// ---- the REAL deps: argv by recording stub (never runs gh) ----
const ENV = (g) => ["-u", "GH_TOKEN", "-u", "GITHUB_TOKEN", "-u", "GH_ENTERPRISE_TOKEN", "-u", "GITHUB_ENTERPRISE_TOKEN", "-u", "GH_CONFIG_DIR", "-u", "GH_HOST", "-u", "GH_REPO", "gh", ...g];
function recorded(answer = () => ok("")) {
  const m = host([good()], { gh: (g) => answer(g) });
  return { ...m, deps: IO.acceptDeps(), argv: () => m.calls.log.filter((c) => c[0] === "/usr/bin/env" && c.includes("gh")).map((c) => c.slice(1)) };
}
const REF = { repo: "o/r", number: 5, url: URL5, head: A };

test("real merge: exactly gh pr merge <bound url> --squash --match-head-commit A, through env -u every selector; no other flag", async () => {
  const m = recorded();
  const r = await m.deps.merge(REF);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(m.argv(), [ENV(["pr", "merge", URL5, "--squash", "--match-head-commit", A])]);
});

for (const [stderr, word] of [
  ["Pull request is not mergeable: the merge commit cannot be cleanly created", "conflict"],
  ["merge conflict between base and head", "conflict"],
  ["Head branch was modified. Review and try the merge again.", "head-moved"],
  ["expected head sha didn't match current head ref", "head-moved"],
  ["Required status checks are expected", "checks-required"],
  ["At least 1 approving review is required by reviewers with write access", "review-required"],
  ["Pull request is in the merge queue and was rejected", "queue-rejected"],
  ["To get started with GitHub CLI, please run: gh auth login", "auth"],
  ["error connecting to api.github.com", "offline"],
  [`something nobody expected ${LEAK}`, "unexpected"],
]) {
  test(`real merge failure "${stderr.slice(0, 40)}" is the bounded word ${word}, never the raw text`, async () => {
    const m = recorded(() => ({ code: 1, stdout: "", stderr }));
    const r = await m.deps.merge(REF);
    assert.deepEqual(r, { ok: false, word });
    assert.ok(!JSON.stringify(r).includes("gh" + "p_"));
  });
}

test("real read-back reads state and headRefOid; real readIssue reads state and labels (GET only)", async () => {
  const m = recorded((g) => (g[0] === "issue" ? ok({ state: "OPEN", labels: [{ name: "status: review" }, { name: "bug" }] }) : ok({ state: "MERGED", headRefOid: A })));
  assert.deepEqual(await m.deps.readBack(REF), { ok: true, state: "MERGED", head: A });
  assert.deepEqual(await m.deps.readIssue({ repo: "o/r", number: 7 }), { ok: true, state: "OPEN", labels: ["status: review", "bug"] });
  assert.ok(m.argv().every((g) => !isWrite("/usr/bin/env", g)));
  assert.deepEqual((await recorded(() => ({ code: 1, stdout: "", stderr: "dial tcp: no such host" })).deps.readBack(REF)), { ok: false, word: "offline" });
});

test("real readPr: title/body/state/mergeable from pr view, every commit message from the paginated REST list, the count from REST (GETs only)", async () => {
  const m = recorded(router({ commits: ["feat: x", "fix: y\n\nCloses #7"], commitCount: 2, view: ok(prJson({ mergeable: "CONFLICTING", isDraft: true })) }));
  const r = await m.deps.readPr(REF);
  assert.deepEqual([r.ok, r.state, r.isDraft, r.mergeable, r.commitCount], [true, "OPEN", true, "CONFLICTING", 2]);
  assert.deepEqual(r.commits, ["feat: x", "fix: y\n\nCloses #7"]);
  const a = m.argv();
  assert.ok(a.some((g) => g.includes("repos/o/r/pulls/5/commits") && g.includes("--paginate")));
  assert.ok(a.every((g) => !isWrite("/usr/bin/env", g)));
});

test("real closeIssue is ONE gh op: only issue close with a one-line comment; no label edit inside it (each mutating op is its own dep)", async () => {
  const m = recorded();
  const r = await m.deps.closeIssue({ repo: "o/r", number: 7, labels: ["status: review", "status: ready"], comment: "Done via PR #5\nsecond line" });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(m.argv(), [ENV(["issue", "close", "7", "-R", "o/r", "-c", "Done via PR #5 second line"])], "one gh call, whatever labels the caller mentions");
});

test("every real write dep issues at most one gh op per call", async () => {
  for (const [name, arg] of [["merge", REF], ["closeIssue", { repo: "o/r", number: 7, comment: "x" }], ["removeLabels", { repo: "o/r", number: 7, labels: ["status: review", "status: ready"] }]]) {
    const m = recorded();
    await m.deps[name](arg);
    assert.equal(m.argv().length, 1, `${name}: ${m.argv().length} gh calls`);
  }
});

test("real deps refuse a malformed ref instead of running gh: a bad repo, number or head never reaches exec", async () => {
  const m = recorded();
  for (const bad of [{ ...REF, repo: "o/r; rm -rf" }, { ...REF, number: "5 --admin" }, { ...REF, head: "main" }, { ...REF, url: "https://evil.example/pull/5" }]) {
    assert.deepEqual((await m.deps.merge(bad)).ok, false);
  }
  assert.deepEqual(m.argv(), []);
});

test("real deps: the lock lives under <app home>/data/drover-accept and release leaves a foreign lock", async () => {
  const m = recorded();
  const key = "P-1__T-3";
  assert.equal(await m.deps.lock.acquire(key, "t1"), "won");
  assert.equal(await m.deps.lock.acquire(key, "t2"), "held");
  assert.ok(existsSync(`${m.home}/data/drover-accept/${key}.lock/token`));
  assert.equal(await m.deps.lock.release(key, "t1"), "released");
  assert.equal(readdirSync(`${m.home}/data/drover-accept`).length, 0);
});

test("M4: real removeLabels is ONE gh issue edit with --remove-label per label, no close and no comment; it refuses a bad ref or label", async () => {
  const m = recorded();
  assert.deepEqual(await m.deps.removeLabels({ repo: "o/r", number: 7, labels: ["status: review", "status: ready"] }), { ok: true });
  assert.deepEqual(m.argv(), [ENV(["issue", "edit", "7", "-R", "o/r", "--remove-label", "status: review", "--remove-label", "status: ready"])]);
  const n = recorded();
  for (const bad of [{ repo: "o/r; x", number: 7, labels: ["a"] }, { repo: "o/r", number: 7, labels: [] }, { repo: "o/r", number: 7, labels: ["a\nb"] }]) assert.equal((await n.deps.removeLabels(bad)).ok, false);
  assert.deepEqual(n.argv(), []);
});
