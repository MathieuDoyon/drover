// B3b (T-MWO3FDGAIKD): the pure part of the Accept chain: the gate truth table, the closing-keyword scan, the source decision, the plan-approval
// marker, the record transitions, the override rule, and the lock (over an injected fs). No host, no exec, no gh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import * as nfs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvidence, classifyChecks, formatReview, reviewOf } from "./evidence.js";
import { gate, closingKeywords, sourceDecision, planApproval, overrideError, step, terminal, commitsComplete, createLock, lockPath, lockKey, clearCommand, STEPS } from "./accept.js";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const URL5 = "https://github.com/o/r/pull/5";
const ISSUE = "https://github.com/o/r/issues/7";
const ok = (n) => ({ __typename: "CheckRun", name: n, status: "COMPLETED", conclusion: "SUCCESS" });
const ev = (o = {}) => buildEvidence({
  repo: "o/r", pr: { state: "found", number: 5, url: URL5, prState: "OPEN" }, base: "main", baseSha: B, head: A, headSource: "pr",
  checks: classifyChecks([ok("build")]), verdict: { state: "pass", head: A, by: "inspector", at: 1, report: "/w/r.md" }, ...o,
});
const prx = (o = {}) => ({ ok: true, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", title: "feat: x", body: "Part of the work", headRefOid: A, commits: ["feat: x"], commitCount: 1, ...o });
const note = (kind, text, at = 1) => ({ id: `n${at}`, at, by: "coordinator", kind, text });
const approved = [note("decision", "plan approved", 1)];
const card = (o = {}) => ({ id: "T-1", project: "P-1", column: "review", archived: false, title: "t", notes: approved, source: { kind: "github", id: "o/r#7", url: ISSUE }, ...o });
const base = (o = {}) => ({ evidence: ev(), prx: prx(), task: card(), cards: [card()], ...o });
const codes = (g) => g.reasons.map((r) => r.code);

// ---- gate: the happy path and each hard stop ----
test("gate: all green, plan approved, review pass at A: merge mode, enabled, no reasons", () => {
  const g = gate(base());
  assert.equal(g.mode, "merge");
  assert.equal(g.enabled, true);
  assert.deepEqual(g.reasons, []);
  assert.match(g.label, /merge/i);
});

for (const [name, patch, code] of [
  ["PR unknown", { evidence: ev({ pr: { state: "unknown", reason: "offline" }, head: null, headSource: null, checks: classifyChecks(undefined) }) }, "pr-unknown"],
  ["head null", { evidence: ev({ head: null }) }, "no-head"],
  ["PR closed", { evidence: ev({ pr: { state: "found", number: 5, url: URL5, prState: "CLOSED" } }) }, "pr-closed"],
  ["PR merged at another head", { evidence: ev({ pr: { state: "found", number: 5, url: URL5, prState: "MERGED" } }), prx: prx({ state: "MERGED", headRefOid: C }), bound: { kind: "pr", repo: "o/r", number: 5, url: URL5, base: "main", baseSha: B, head: C } }, "merged-other-head"],
  ["draft", { prx: prx({ isDraft: true }) }, "draft"],
  ["conflict", { prx: prx({ mergeable: "CONFLICTING" }) }, "conflict"],
  ["red check", { evidence: ev({ checks: classifyChecks([ok("a"), { __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "FAILURE" }]) }) }, "checks"],
  ["pending check", { evidence: ev({ checks: classifyChecks([ok("a"), { __typename: "CheckRun", name: "b", status: "IN_PROGRESS", conclusion: null }]) }) }, "checks"],
  ["skipped check", { evidence: ev({ checks: classifyChecks([ok("a"), { __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "SKIPPED" }]) }) }, "checks"],
  ["cancelled check", { evidence: ev({ checks: classifyChecks([{ __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "CANCELLED" }]) }) }, "checks"],
  ["neutral check", { evidence: ev({ checks: classifyChecks([{ __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "NEUTRAL" }]) }) }, "checks"],
  ["missing checks", { evidence: ev({ checks: classifyChecks(undefined) }) }, "checks"],
  ["empty checks", { evidence: ev({ checks: classifyChecks([]) }) }, "checks"],
  ["remote card", { remote: true }, "remote"],
  ["PR text unread", { prx: undefined }, "text-unreadable"],
  ["PR text read failed", { prx: { ok: false, word: "offline" } }, "text-unreadable"],
  ["commit list partial", { prx: prx({ commits: ["a"], commitCount: 3 }) }, "commits-incomplete"],
  ["commit count over the REST cap", { prx: prx({ commits: new Array(250).fill("c"), commitCount: 251 }) }, "commits-incomplete"],
]) {
  test(`gate hard stop: ${name} blocks, and a typed override never rescues it`, () => {
    const g = gate(base(patch));
    assert.equal(g.enabled, false);
    assert.ok(codes(g).includes(code), `${code} in ${codes(g)}`);
    const o = gate(base({ ...patch, override: { reason: "the owner knows best here", covers: ["plan-missing", "review-missing", "review-stale", "review-adverse", code] } }));
    assert.equal(o.enabled, false, "hard stops ignore the override");
    assert.ok(o.reasons.find((r) => r.code === code && r.soft === false));
  });
}

test("gate: the first reason is the first hard stop, in the documented order (unknown PR before checks)", () => {
  const g = gate(base({ evidence: ev({ pr: { state: "unknown", reason: "auth" }, head: null, headSource: null, checks: classifyChecks(undefined) }) }));
  assert.equal(g.reasons[0].code, "pr-unknown");
});

test("gate: MERGED at A is finish mode (checks not needed); MERGED at another head is blocked", () => {
  const merged = ev({ pr: { state: "found", number: 5, url: URL5, prState: "MERGED" }, checks: classifyChecks([]) });
  const g = gate(base({ evidence: merged, prx: prx({ state: "MERGED" }) }));
  assert.equal(g.mode, "finish");
  assert.equal(g.enabled, true);
  assert.match(g.label, /finish/i);
});

test("gate: no PR is Done only; checks and PR text are not needed; soft gates still apply", () => {
  const none = ev({ pr: { state: "none" }, base: null, baseSha: null, headSource: "worktree", checks: classifyChecks(undefined, { noPr: true }) });
  const g = gate(base({ evidence: none, prx: undefined }));
  assert.equal(g.mode, "done-only");
  assert.equal(g.enabled, true);
  assert.match(g.label, /Done/);
  const g2 = gate(base({ evidence: ev({ pr: { state: "none" }, headSource: "worktree", verdict: { state: "missing" } }), prx: undefined, task: card({ notes: [] }) }));
  assert.equal(g2.mode, "done-only");
  assert.equal(g2.enabled, false);
  assert.deepEqual(g2.soft.sort(), ["plan-missing", "review-missing"]);
});

// ---- gate: soft gates and the override ----
for (const [name, verdict, code] of [
  ["review missing", { state: "missing" }, "review-missing"],
  ["review stale", { state: "stale", head: C, was: "pass" }, "review-stale"],
  ["review adverse", { state: "adverse", head: A, by: "inspector", report: "/w/r.md" }, "review-adverse"],
]) {
  test(`gate soft: ${name} disables Accept unless a valid typed reason covers it`, () => {
    const g = gate(base({ evidence: ev({ verdict }) }));
    assert.equal(g.enabled, false);
    assert.deepEqual(g.soft, [code]);
    assert.equal(g.needsOverride, true);
    const o = gate(base({ evidence: ev({ verdict }), override: { reason: "reviewed by hand on the branch", covers: [code] } }));
    assert.equal(o.enabled, true);
    assert.equal(o.overridden, true);
    const short = gate(base({ evidence: ev({ verdict }), override: { reason: "ok", covers: [code] } }));
    assert.equal(short.enabled, false, "a too short reason does not count");
  });
}

test("gate soft: plan approval missing is soft; withdrawn after approved is missing again", () => {
  assert.deepEqual(gate(base({ task: card({ notes: [] }) })).soft, ["plan-missing"]);
  assert.deepEqual(gate(base({ task: card({ notes: [note("decision", "plan approved", 1), note("decision", "plan withdrawn", 2)] }) })).soft, ["plan-missing"]);
});

test("override covers a SET of codes: a current failure outside the set blocks (pass to adverse at the same head)", () => {
  const o = { reason: "the plan was agreed by voice", covers: ["plan-missing"] };
  assert.equal(gate(base({ task: card({ notes: [] }), override: o })).enabled, true);
  const g = gate(base({ task: card({ notes: [] }), evidence: ev({ verdict: { state: "adverse", head: A, by: "i", report: "/w/r.md" } }), override: o }));
  assert.equal(g.enabled, false, "a new code is not covered");
  assert.deepEqual(g.soft.sort(), ["plan-missing", "review-adverse"]);
});

test("override: an override that is a subset of what the click now needs is fine; fewer codes than now fail", () => {
  const wide = { reason: "owner accepted the risk here", covers: ["plan-missing", "review-missing", "review-adverse"] };
  assert.equal(gate(base({ task: card({ notes: [] }), override: wide })).enabled, true, "covers more than needed");
});

test("overrideError: trimmed 10..300 chars, no newline", () => {
  assert.equal(overrideError("   too short "), "Type a reason of 10 to 300 characters");
  assert.equal(overrideError("x".repeat(301)), "Type a reason of 10 to 300 characters");
  assert.match(overrideError("line one\nline two long enough"), /one line/);
  assert.equal(overrideError("a reason that is fine"), null);
  assert.equal(overrideError("  " + "y".repeat(10) + "  "), null);
  assert.ok(overrideError(undefined));
});

// ---- gate: identity ----
test("gate with a bound record: a different head is head-moved; any other identity field is identity", () => {
  const bound = { kind: "pr", repo: "o/r", number: 5, url: URL5, base: "main", baseSha: B, head: A };
  assert.equal(gate(base({ bound })).enabled, true);
  assert.ok(codes(gate(base({ bound: { ...bound, head: C } }))).includes("head-moved"));
  for (const [k, v] of [["repo", "o/other"], ["number", 6], ["url", "https://github.com/o/r/pull/6"], ["base", "release"], ["baseSha", C], ["kind", "no-pr"]]) {
    const g = gate(base({ bound: { ...bound, [k]: v } }));
    assert.equal(g.enabled, false, k);
    assert.ok(codes(g).includes("identity"), `${k} -> ${codes(g)}`);
  }
});

// ---- closing keywords ----
test("closingKeywords: every GitHub verb, any case, optional colon, #N, owner/repo#N and issue URL", () => {
  for (const v of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved", "Closes", "FIXES", "Resolved"]) {
    assert.deepEqual(closingKeywords(`${v} #7`), [{ verb: v.toLowerCase(), repo: null, number: 7 }], v);
    assert.equal(closingKeywords(`${v}: #7`).length, 1, `${v}:`);
  }
  assert.deepEqual(closingKeywords("Fixes o/r#7"), [{ verb: "fixes", repo: "o/r", number: 7 }]);
  assert.deepEqual(closingKeywords(`closes ${ISSUE}`), [{ verb: "closes", repo: "o/r", number: 7 }]);
  assert.equal(closingKeywords("line one\nResolves #3 and fixes #4").length, 2);
});

test("closingKeywords: no false hit on closest, prefix, a bare number or a reference with no verb", () => {
  for (const t of ["closest #7", "prefix #7", "see #7", "fixing #7", "closes the loop", "fixes", "Part of #7", "unresolved #7", ""]) assert.deepEqual(closingKeywords(t), [], t);
  assert.deepEqual(closingKeywords(undefined), []);
});

// ---- the closing keyword gate (blocks only a shared / parked source) ----
const sib = (o = {}) => card({ id: "T-2", project: "P-2", column: "blocked", ...o });
test("closing keyword for a source with an unresolved sibling blocks, in the body, the title and any commit", () => {
  const cards = [card(), sib()];
  for (const p of [prx({ body: "Fixes #7" }), prx({ title: "Closes #7: x" }), prx({ commits: ["feat: x", "fix: y\n\nResolves o/r#7"], commitCount: 2 })]) {
    const g = gate(base({ prx: p, cards }));
    assert.equal(g.enabled, false);
    assert.ok(codes(g).includes("closing-keyword"));
    assert.equal(gate(base({ prx: p, cards, override: { reason: "close it anyway please", covers: ["closing-keyword"] } })).enabled, false, "no override");
  }
});

test("closing keyword for a source that is NOT shared is the normal path; for another issue it is ignored", () => {
  assert.equal(gate(base({ prx: prx({ body: "Fixes #7" }) })).enabled, true);
  assert.equal(gate(base({ prx: prx({ body: "Fixes #99" }), cards: [card(), sib()] })).enabled, true, "names another issue");
  assert.equal(gate(base({ prx: prx({ body: "Fixes other/repo#7" }), cards: [card(), sib()] })).enabled, true, "names another repo");
});

// ---- sourceDecision ----
test("sourceDecision: closes only when every other card on the source is Done", () => {
  assert.equal(sourceDecision(card(), [card()]).close, true);
  assert.equal(sourceDecision(card(), [card(), sib({ column: "done" })]).close, true, "owner-Done sibling is resolved");
  const parked = sourceDecision(card(), [card(), sib()]);
  assert.equal(parked.close, false);
  assert.match(parked.why, /another card|not Done/i);
});

test("sourceDecision: an archived sibling that is not Done stays unresolved; a Done archived one is resolved; other sources are ignored", () => {
  assert.equal(sourceDecision(card(), [card(), sib({ archived: true, column: "blocked" })]).close, false);
  assert.equal(sourceDecision(card(), [card(), sib({ archived: true, column: "done" })]).close, true);
  assert.equal(sourceDecision(card(), [card(), sib({ source: { kind: "github", id: "o/r#8", url: "https://github.com/o/r/issues/8" } })]).close, true);
});

test("sourceDecision: a sibling in another project with the same source counts; the same id in another project is a different card", () => {
  assert.equal(sourceDecision(card(), [card(), card({ id: "T-1", project: "P-2", column: "doing" })]).close, false);
});

test("sourceDecision: Jira, no source and a PR source never close and say why", () => {
  const j = sourceDecision(card({ source: { kind: "jira", id: "K-1", url: "https://x.atlassian.net/browse/K-1" } }), []);
  assert.deepEqual([j.close, j.action], [false, "skip"]);
  assert.match(j.why, /Jira/);
  assert.equal(sourceDecision(card({ source: null }), []).action, "none");
  assert.equal(sourceDecision(card({ source: { kind: "github", id: "o/r#5", url: URL5 } }), []).action, "skip");
});

// ---- plan approval ----
test("planApproval: exact marker only; newest decision wins; GO withheld and prefixes do not match", () => {
  assert.equal(planApproval([]), "missing");
  assert.equal(planApproval([note("decision", "plan approved")]), "approved");
  assert.equal(planApproval([note("decision", "Plan Approved: scope agreed")]), "approved");
  assert.equal(planApproval([note("decision", "GO withheld")]), "missing");
  assert.equal(planApproval([note("decision", "plan approved but not really")]), "missing");
  assert.equal(planApproval([note("log", "plan approved")]), "missing", "kind decision only");
  assert.equal(planApproval([note("decision", "plan approved", 1), note("decision", "plan withdrawn", 2)]), "missing");
  assert.equal(planApproval([note("decision", "plan approved", 1), note("decision", "plan withdrawn: scope grew", 2), note("decision", "plan approved: again", 3)]), "approved");
  assert.equal(planApproval([note("decision", "plan approved", 1), note("decision", "unrelated decision", 2)]), "approved", "an unrelated decision does not revoke");
  assert.equal(planApproval(undefined), "missing");
});

// ---- commit completeness ----
test("commitsComplete: the listed commits must equal the REST count, and the count must be within the cap", () => {
  assert.equal(commitsComplete({ commits: ["a", "b"], commitCount: 2 }), true);
  assert.equal(commitsComplete({ commits: ["a"], commitCount: 2 }), false);
  assert.equal(commitsComplete({ commits: [], commitCount: 0 }), false, "a PR with no commits is unreadable");
  assert.equal(commitsComplete({ commits: new Array(251).fill("c"), commitCount: 251 }), false);
  assert.equal(commitsComplete({ commits: ["a"], commitCount: "1" }), false);
});

// ---- record transitions ----
const rec = (o = {}) => ({ v: 1, id: "T-1", project: "P-1", repo: "o/r", number: 5, url: URL5, base: "main", baseSha: B, head: A, kind: "pr", mode: "merge", phase: "bound", token: "tk", at: 1, ...o });
test("step: the phases move in one order; an illegal move returns null and changes nothing", () => {
  let r = rec();
  r = step(r, { type: "merging" }); assert.equal(r.phase, "merging");
  r = step(r, { type: "merged" }); assert.equal(r.phase, "merged");
  r = step(r, { type: "synced" }); assert.equal(r.phase, "synced");
  r = step(r, { type: "done" }); assert.equal(r.phase, "done");
  assert.equal(terminal(r), true);
  assert.equal(step(rec({ phase: "merging" }), { type: "done" }), null, "no Done before merged");
  assert.equal(step(rec({ phase: "bound" }), { type: "synced" }), null);
  assert.equal(step(rec({ phase: "done" }), { type: "merging" }), null);
  const before = JSON.stringify(rec());
  step(rec(), { type: "done" });
  assert.equal(JSON.stringify(rec()), before);
});

test("step: failure, not-merged and unknown are bounded words; sync failure keeps merged; no-PR goes bound to done", () => {
  assert.equal(step(rec({ phase: "merging" }), { type: "fail", word: "conflict" }).phase, "failed:conflict");
  assert.equal(terminal(step(rec({ phase: "merging" }), { type: "fail", word: "conflict" })), true);
  assert.equal(step(rec({ phase: "merging" }), { type: "fail", word: "anything goes <script>" }).phase, "failed:unexpected", "an unknown word is folded, never kept");
  assert.equal(step(rec({ phase: "merging" }), { type: "open" }).phase, "open");
  assert.equal(step(rec({ phase: "merging" }), { type: "unreadable" }).phase, "unknown");
  assert.equal(step(rec({ phase: "merged" }), { type: "sync-failed" }).phase, "merged");
  assert.equal(step(rec({ kind: "no-pr", mode: "done-only" }), { type: "done" }).phase, "done");
  assert.equal(step(rec({ kind: "pr" }), { type: "done" }), null, "a PR record cannot skip the merge");
  assert.equal(step(rec({ phase: "bound" }), { type: "merged" }).phase, "merged", "already merged at A");
  assert.ok(STEPS.length >= 6);
});

// ---- the lock ----
const tmpdirOf = () => mkdtempSync(join(tmpdir(), "accept-lock-"));
const lockOn = (dir) => createLock(nfs, dir);

test("lock: both-empty race, exactly one mkdir wins and the loser makes no write", async () => {
  const dir = tmpdirOf();
  try {
    const writes = [];
    const spy = { ...nfs, writeFile: async (...a) => { writes.push(a[0]); return nfs.writeFile(...a); } };
    const l = createLock(spy, dir);
    const r = await Promise.all([l.acquire("P-1__T-1", "tok-a"), l.acquire("P-1__T-1", "tok-b")]);
    assert.deepEqual(r.slice().sort(), ["held", "won"]);
    assert.equal(writes.length, 1, "only the winner writes its token");
    const winner = r[0] === "won" ? "tok-a" : "tok-b";
    assert.equal(await l.read("P-1__T-1"), winner);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: a lock that exists is never replaced, however old; the state says present", async () => {
  const dir = tmpdirOf();
  try {
    const l = lockOn(dir);
    assert.equal(await l.acquire("k", "old"), "won");
    assert.equal(await l.state("k"), "present");
    assert.equal(await l.acquire("k", "new"), "held");
    assert.equal(await l.read("k"), "old");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The Herdr mod host's fs errors carry no Node .code: absence is proven by the host's exists(), never by e.code.
const noCode = (msg = "no such file") => new Error(msg);
const hostFs = ({ exists, held = new Set() } = {}) => {
  const files = new Map();
  const base = {
    readdir: async (p) => { if (held.has(p)) return []; throw noCode(); },
    mkdir: async (p, o) => { if (held.has(p)) throw noCode("exists"); if (!o?.recursive) held.add(p); },
    writeFile: async (p, d) => { files.set(p, d); },
    readFile: async (p) => { if (!files.has(p)) throw noCode(); return files.get(p); },
    unlink: async (p) => { files.delete(p); },
    rmdir: async (p) => { held.delete(p); },
  };
  return exists === undefined ? base : { ...base, exists };
};

test("lock: on a host whose errors have no .code, a missing lock is none when exists() says false", async () => {
  assert.equal(await createLock(hostFs({ exists: async () => false }), "/d").state("k"), "none");
});

test("lock: acquire wins on a host fs whose errors have no .code", async () => {
  const held = new Set();
  const l = createLock(hostFs({ exists: async (p) => held.has(p), held }), "/d");
  assert.equal(await l.acquire("k", "tok"), "won");
  assert.equal(await l.read("k"), "tok");
});

test("lock: unproven absence is unknown, never none and never a rejection", async () => {
  assert.equal(await createLock(hostFs({ exists: async () => true }), "/d").state("k"), "unknown", "exists but unreadable");
  assert.equal(await createLock(hostFs(), "/d").state("k"), "unknown", "no exists()");
  assert.equal(await createLock(hostFs({ exists: async () => { throw noCode("boom"); } }), "/d").state("k"), "unknown", "exists() rejects");
});

test("lock: if the lock cannot be created or read it fails closed (uncertain), not won", async () => {
  const denied = { ...nfs, mkdir: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, exists: async () => false };
  assert.equal(await createLock(denied, "/nowhere/x").acquire("k", "t"), "uncertain");
  const dir = tmpdirOf();
  try {
    const noWrite = { ...nfs, writeFile: async () => { throw new Error("disk full"); } };
    assert.equal(await createLock(noWrite, dir).acquire("k", "t"), "uncertain");
    assert.equal(existsSync(lockPath(dir, "k")), false, "a lock this call created but could not fill is not left behind");
    const wrongRead = { ...nfs, readFile: async () => "someone else" };
    assert.equal(await createLock(wrongRead, dir).acquire("k2", "t"), "uncertain", "token read back differs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: release removes it only when the token on disk is ours; a late cleanup by an old run leaves a foreign lock", async () => {
  const dir = tmpdirOf();
  try {
    const l = lockOn(dir);
    await l.acquire("k", "mine");
    assert.equal(await l.release("k", "mine"), "released");
    assert.equal(existsSync(lockPath(dir, "k")), false);
    await l.acquire("k", "mine");
    writeFileSync(join(lockPath(dir, "k"), "token"), "foreign\n1");
    assert.equal(await l.release("k", "mine"), "kept");
    assert.equal(existsSync(lockPath(dir, "k")), true, "a lock whose token is not ours stays");
    assert.equal(readFileSync(join(lockPath(dir, "k"), "token"), "utf8"), "foreign\n1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: the token file carries the token and the start time in seconds (what doctor reads)", async () => {
  const dir = tmpdirOf();
  try {
    await createLock(nfs, dir, { now: () => 1_700_000_000_000 }).acquire("k", "tk1");
    assert.equal(readFileSync(join(lockPath(dir, "k"), "token"), "utf8"), "tk1\n1700000000");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: the card key is a safe file name; the clear command names the exact path and is ONE command", () => {
  assert.equal(lockKey({ id: "T-AB1", project: "P-1" }), "P-1__T-AB1");
  assert.equal(lockKey({ id: "T-AB1", project: null }), "-__T-AB1");
  assert.equal(lockKey({ id: "../../etc", project: "x y" }), "x_y__.._.._etc");
  const cmd = clearCommand("/h/data/drover-accept", "P-1__T-1");
  assert.equal(cmd, "rm -r '/h/data/drover-accept/P-1__T-1.lock'");
  assert.ok(!/[;&|\n`$]/.test(cmd), "one plain command");
});

// ---- fix round 1 (T-MWO3FDGAIKD) ----
test("H3: sourceDecision and the closing-keyword gate compare the parsed issue identity (case-folded repo and number), not the URL spelling", () => {
  const alias = sib({ source: { kind: "github", id: "O/R#7", url: "https://github.com/O/R/issues/7" } });
  assert.equal(sourceDecision(card(), [card(), alias]).close, false);
  assert.equal(sourceDecision(card(), [card(), { ...alias, archived: true }]).close, false);
  assert.equal(sourceDecision(card(), [card(), { ...alias, column: "done" }]).close, true);
  assert.equal(sourceDecision(card({ source: { kind: "github", id: "O/R#7", url: "https://github.com/O/R/issues/7" } }), [card(), sib()]).close, false, "the card itself may be the odd spelling");
  const g = gate(base({ prx: prx({ body: "Fixes #7" }), cards: [card(), alias] }));
  assert.equal(g.enabled, false);
  assert.ok(codes(g).includes("closing-keyword"));
  assert.equal(sourceDecision(card(), [card(), sib({ source: { kind: "github", id: "o/r#70", url: "https://github.com/o/r/issues/70" } })]).close, true, "issue 70 is not issue 7");
});

test("M5: clearCommand quotes the whole path for a shell: an apostrophe and a space survive; it stays one display-only command", () => {
  const cmd = clearCommand("/h/O'Brien dir/data/drover-accept", "P-1__T-1");
  assert.equal(cmd, "rm -r '/h/O'\\''Brien dir/data/drover-accept/P-1__T-1.lock'");
  assert.ok(!/[;&|\n`$]/.test(cmd.replace(/'\\''/g, "")), "no shell metacharacter outside the quotes");
});

test("M6: when the token cannot be proven ours, acquire never unlinks a token file: a mismatched or unreadable token is preserved", async () => {
  const dir = tmpdirOf();
  try {
    const calls = [];
    const spy = { ...nfs, unlink: async (...a) => { calls.push(["unlink", a[0]]); return nfs.unlink(...a); }, rmdir: async (...a) => { calls.push(["rmdir", a[0]]); return nfs.rmdir(...a); } };
    for (const [name, patch] of [["mismatch", { readFile: async () => "someone else" }], ["unreadable", { readFile: async () => { throw new Error("denied"); } }]]) {
      calls.length = 0;
      assert.equal(await createLock({ ...spy, ...patch }, dir).acquire(`k-${name}`, "t"), "uncertain", name);
      assert.ok(!calls.some(([op]) => op === "unlink"), `${name}: no unlink of an unproven token`);
      assert.ok(existsSync(join(lockPath(dir, `k-${name}`), "token")), `${name}: the token file stays`);
    }
    const noWrite = { ...spy, writeFile: async () => { throw new Error("disk full"); } };
    assert.equal(await createLock(noWrite, dir).acquire("k-empty", "t"), "uncertain");
    assert.equal(existsSync(lockPath(dir, "k-empty")), false, "an EMPTY directory this call made is removed (rmdir cannot remove a token)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
