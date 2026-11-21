// B3b (T-MWO3FDGAIKD): the Accept chain end to end over FAKE deps. Every write (gh pr merge, issue close, card move, note, record) is an injected
// function that appends to one ordered call log; nothing here can reach gh or git. The lock is the real one, over a temp folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import * as nfs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvidence, classifyChecks, formatReview, reviewOf } from "../_lib/evidence.js";
import { runAccept, checkAgain, createLock, lockKey, lockPath } from "../_lib/accept.js";

const LEAK = "gh" + "p_" + "S".repeat(36); // built by concatenation: a secret-shaped literal must not sit in the file
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);
const URL5 = "https://github.com/o/r/pull/5";
const ISSUE = "https://github.com/o/r/issues/7";
const ok = (n = "build") => ({ __typename: "CheckRun", name: n, status: "COMPLETED", conclusion: "SUCCESS" });
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const card = (o = {}) => ({ id: "T-1", project: "P-1", column: "review", archived: false, title: "t", notes: [{ id: "n1", at: 1, by: "c", kind: "decision", text: "plan approved" }], source: { kind: "github", id: "o/r#7", url: ISSUE }, ...o });
const KEY = lockKey({ id: "T-1", project: "P-1" });
// The Inspector's verdict lives in the card's notes (the chain re-derives it from the LATEST notes): w.verdict is rendered as a review note.
const verdictNote = (v) => (v.state === "missing" ? [] : [{ id: "nv", at: 2, by: "inspector", kind: "review", text: formatReview({ head: v.head, verdict: v.state === "adverse" ? "adverse" : "pass", report: v.report ?? "/w/r.md" }) }]);
const reviewAt = (head, verdict, at = 50) => ({ id: `nr${at}`, at, by: "inspector", kind: "review", text: formatReview({ head, verdict, report: "/w/r2.md" }) });

// The fake world: one PR/worktree state, one call log. Overrides replace any dep.
function world(o = {}) {
  const dir = o.lock ? null : mkdtempSync(join(tmpdir(), "accept-chain-")); if (dir) made.push(dir); // an in-memory lock needs no folder
  const w = {
    dir, log: [], seq: [], notes: [], moved: [], closed: [], merges: [], sleeps: 0, records: new Map(),
    task: card(o.task), cards: o.cards ?? null,
    pr: { number: 5, url: URL5, state: "OPEN", head: A, base: "main", baseSha: B, checks: [ok()], isDraft: false, mergeable: "MERGEABLE", title: "feat: x", body: "Part of the work", commits: ["feat: x"], commitCount: 1, ...(o.pr ?? {}) },
    noPr: o.noPr ?? false, wtHead: o.wtHead ?? A,
    verdict: o.verdict ?? { state: "pass", head: A, by: "inspector", at: 1, report: "/w/r.md" },
    issue: { state: "OPEN", labels: ["status: review", "bug"], ...(o.issue ?? {}) },
    mergeResult: o.mergeResult ?? "merged", // merged | queued | { word } | throw
    readBack: o.readBack ?? null, evidenceError: o.evidenceError ?? null, prError: o.prError ?? null, closeResult: o.closeResult ?? { ok: true }, moveOk: o.moveOk ?? true,
  };
  w.taskNow = () => ({ ...w.task, notes: [...verdictNote(w.verdict), ...(w.task.notes ?? [])] });
  w.cards ??= [w.task];
  const L = (s) => w.log.push(s);
  const evidence = () => {
    if (w.evidenceError) return buildEvidence({ pr: { state: "unknown", reason: w.evidenceError }, checks: classifyChecks(undefined) });
    const verdict = reviewOf(w.taskNow().notes, w.noPr ? w.wtHead : w.pr.head);
    if (w.noPr) return buildEvidence({ repo: "o/r", pr: { state: "none" }, head: w.wtHead, headSource: "worktree", checks: classifyChecks(undefined, { noPr: true }), verdict });
    return buildEvidence({ repo: "o/r", pr: { state: "found", number: w.pr.number, url: w.pr.url, prState: w.pr.state }, base: w.pr.base, baseSha: w.pr.baseSha, head: w.pr.head, headSource: "pr", checks: classifyChecks(w.pr.checks), verdict });
  };
  w.evidence = evidence;
  w.lock = o.lock ?? createLock(nfs, join(dir, "data", "drover-accept"));
  w.deps = {
    now: () => 1000,
    sleep: async () => { w.sleeps++; },
    token: (() => { let n = 0; return () => `tok-${++n}`; })(),
    task: () => w.taskNow(),
    cards: () => w.cards,
    readEvidence: async () => { L("read-evidence"); return { evidence: evidence() }; },
    readPr: async (ref) => { L("read-pr"); w.lastPrRef = ref; return w.prError ?? { ok: true, state: w.pr.state, isDraft: w.pr.isDraft, mergeable: w.pr.mergeable, title: w.pr.title, body: w.pr.body, headRefOid: w.pr.head, commits: w.pr.commits, commitCount: w.pr.commitCount }; },
    merge: async (ref) => {
      L("merge"); w.seq.push("merge"); w.merges.push(ref);
      if (typeof w.mergeResult === "function") return w.mergeResult(w);
      if (w.mergeResult === "merged") { w.pr.state = "MERGED"; return { ok: true }; }
      if (w.mergeResult === "queued") return { ok: true };
      return { ok: false, word: w.mergeResult.word, raw: LEAK + " raw gh text" };
    },
    readBack: async () => { L("read-back"); if (w.readBack) return typeof w.readBack === "function" ? w.readBack(w) : w.readBack; return { ok: true, state: w.pr.state, head: w.pr.head }; },
    readIssue: async () => { L("read-issue"); return { ok: true, state: w.issue.state, labels: w.issue.labels }; },
    closeIssue: async (a) => { L("close-issue"); w.seq.push("close-issue"); w.closed.push(a); if (w.closeResult.ok) w.issue.state = "CLOSED"; return w.closeResult; },
    removeLabels: async (a) => { L("remove-labels"); w.seq.push("remove-labels"); w.removed = [...(w.removed ?? []), a]; if (w.removeResult?.ok === false) return w.removeResult; w.issue.labels = w.issue.labels.filter((l) => !a.labels.includes(l)); return { ok: true }; },
    moveDone: async (id, project) => { L("move-done"); w.seq.push("move-done"); if (w.moveOk) w.moved.push([id, project]); return w.moveOk; },
    note: async (id, project, text, kind) => { L(`note:${kind}`); w.seq.push(`note:${text}`); w.notes.push({ id, project, text, kind }); },
    records: { get: (k) => w.records.get(k) ?? null, set: (k, r) => { w.records.set(k, r); } },
    lock: w.lock,
    onStep: () => {},
  };
  Object.assign(w.deps, o.deps ?? {});
  return w;
}
const refOf = (w, o = {}) => ({ id: "T-1", project: "P-1", bound: w.evidence(), mode: w.noPr ? "done-only" : "merge", override: null, ...o });
const wrote = (w) => w.log.filter((x) => ["merge", "close-issue", "remove-labels", "move-done"].includes(x));
const noteTexts = (w) => w.notes.map((n) => n.text);
const WRITES = ["merge", "close-issue", "remove-labels", "move-done"];

test("happy path: re-read, merge pinned to A, read-back MERGED at A, source sync, then Done, in that order, a log note per step", async () => {
  const w = world();
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "done");
  const key = w.log.filter((x) => !x.startsWith("note:"));
  assert.deepEqual(key, ["read-evidence", "read-pr", "merge", "read-back", "read-issue", "close-issue", "remove-labels", "move-done"], "close FIRST, then the status: labels, each its own op");
  assert.deepEqual([w.merges[0].url, w.merges[0].head, w.merges[0].number, w.merges[0].repo], [URL5, A, 5, "o/r"], "the merge asks for the bound PR at the bound head");
  assert.equal(w.closed[0].number, 7);
  assert.equal(w.closed[0].labels, undefined, "the close carries no labels");
  assert.deepEqual(w.removed[0].labels, ["status: review"], "every status: label is removed, others kept");
  assert.deepEqual(w.moved, [["T-1", "P-1"]]);
  const t = noteTexts(w);
  const at = (re) => t.findIndex((x) => re.test(x));
  assert.ok(at(/bound o\/r#5/) >= 0 && at(/bound o\/r#5/) < at(/re-read ok/) && at(/re-read ok/) < at(/merging o\/r#5 at aaaaaaa/) && at(/merging o\/r#5 at aaaaaaa/) < at(/merged at aaaaaaa/) && at(/merged at aaaaaaa/) < at(/source closed/) && at(/source closed/) < at(/moved to Done/), t.join("\n"));
  assert.ok(w.notes.every((n) => n.kind === "log" || n.kind === "decision"));
  assert.ok(t.every((x) => x.startsWith("accept:")));
  assert.equal(w.records.get(KEY).phase, "done");
  assert.equal(existsSync(lockPath(join(w.dir, "data", "drover-accept"), KEY)), false, "the lock is released on a terminal outcome");
});

test("the merge argv is built from evidence and never carries --admin, --auto, --delete-branch or a push (record fields only)", async () => {
  const w = world();
  await runAccept(refOf(w), w.deps);
  assert.ok(!JSON.stringify(w.merges[0]).match(/admin|auto|delete-branch|push/));
});

// ---- head change, identity change ----
test("head changed between the check and the click: evidence refreshed, no merge, nothing written but a note, the lock released", async () => {
  const w = world();
  const ref = refOf(w);
  w.pr.head = C; w.verdict = { ...w.verdict, head: C };
  const r = await runAccept(ref, w.deps);
  assert.equal(r.outcome, "refreshed");
  assert.equal(r.evidence.head, C);
  assert.deepEqual(wrote(w), []);
  assert.ok(noteTexts(w).some((x) => /head moved.*not merged/.test(x)));
  assert.equal(existsSync(lockPath(join(w.dir, "data", "drover-accept"), KEY)), false);
});

for (const [name, patch] of [
  ["PR switched at the same head", { number: 6, url: "https://github.com/o/r/pull/6" }],
  ["PR retargeted to another base", { base: "release" }],
  ["base moved under the PR", { baseSha: D }],
]) {
  test(`identity changed: ${name}: refresh, never merge`, async () => {
    const w = world();
    const ref = refOf(w);
    Object.assign(w.pr, patch);
    const r = await runAccept(ref, w.deps);
    assert.equal(r.outcome, "refreshed", name);
    assert.deepEqual(wrote(w), []);
  });
}

test("a no-PR card that gained a PR since the dialog opened: refresh, not Done", async () => {
  const w = world({ noPr: true });
  const ref = refOf(w);
  w.noPr = false;
  const r = await runAccept(ref, w.deps);
  assert.equal(r.outcome, "refreshed");
  assert.deepEqual(wrote(w), []);
});

test("every later request uses the BOUND url and number, never a re-discovered one", async () => {
  const w = world();
  await runAccept(refOf(w), w.deps);
  assert.deepEqual([w.lastPrRef.url, w.lastPrRef.number], [URL5, 5]);
});

test("the merge itself refuses on the pinned head (head-moved): failed, card not moved, no sync", async () => {
  const w = world({ mergeResult: { word: "head-moved" } });
  const r = await runAccept(refOf(w), w.deps);
  assert.deepEqual([r.outcome, r.word], ["failed", "head-moved"]);
  assert.deepEqual(wrote(w), ["merge"]);
  assert.equal(w.records.get(KEY).phase, "failed:head-moved");
  assert.ok(!JSON.stringify(w.notes).includes("gh" + "p_"), "raw gh text never reaches a note");
  assert.ok(!JSON.stringify(r).includes("gh" + "p_"), "nor the result");
});

// ---- queue, not merged ----
test("queued / rejected: read-back stays OPEN, shown as not merged, the card is not moved, no source sync", async () => {
  const w = world({ mergeResult: "queued" });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "not-merged");
  assert.match(r.text, /Not merged: PR still open \(queued or rejected, not proven\)/);
  assert.ok(!/Queued/.test(r.text));
  assert.deepEqual(wrote(w), ["merge"]);
  assert.equal(w.log.filter((x) => x === "read-back").length, 3, "bounded retries");
  assert.equal(w.sleeps, 2);
  assert.equal(w.records.get(KEY).phase, "open");
});

test("Check again is read-only: it never merges, writes no note, moves nothing, and a later MERGED is shown as Finish", async () => {
  const w = world({ mergeResult: "queued" });
  await runAccept(refOf(w), w.deps);
  const before = w.log.length, notes = w.notes.length;
  const c = await checkAgain({ id: "T-1", project: "P-1" }, w.deps);
  assert.equal(c.state, "OPEN");
  w.pr.state = "MERGED";
  const c2 = await checkAgain({ id: "T-1", project: "P-1" }, w.deps);
  assert.equal(c2.state, "MERGED");
  assert.equal(w.notes.length, notes);
  assert.ok(w.log.slice(before).every((x) => ["read-evidence", "read-pr", "read-back"].includes(x)), w.log.slice(before).join());
  assert.equal(w.merges.length, 1);
});

test("read-back says MERGED but at another head: failed head-mismatch, no sync, no Done", async () => {
  const w = world({ readBack: { ok: true, state: "MERGED", head: C } });
  const r = await runAccept(refOf(w), w.deps);
  assert.deepEqual([r.outcome, r.word], ["failed", "head-mismatch"]);
  assert.ok(!w.log.includes("close-issue") && !w.log.includes("move-done"));
});

test("read-back CLOSED: failed, no sync, no Done", async () => {
  const w = world({ readBack: { ok: true, state: "CLOSED", head: A } });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "failed");
  assert.deepEqual(wrote(w), ["merge"]);
});

// ---- restart, Finish ----
test("sync fails after the merge: merged stays, the card is NOT moved, the lock is released; Finish (a fresh click) retries sync idempotently and moves it", async () => {
  const w = world({ closeResult: { ok: false, word: "auth" } });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "synced-failed");
  assert.equal(w.records.get(KEY).phase, "merged");
  assert.deepEqual(w.moved, []);
  assert.equal(existsSync(lockPath(join(w.dir, "data", "drover-accept"), KEY)), false);
  // "restart": a new dialog reads MERGED at A and offers Finish; the owner clicks
  w.closeResult = { ok: true };
  const f = await runAccept({ id: "T-1", project: "P-1", bound: w.evidence(), mode: "finish", override: null }, w.deps);
  assert.equal(f.outcome, "done");
  assert.equal(w.merges.length, 1, "no second merge");
  assert.deepEqual(w.moved, [["T-1", "P-1"]]);
});

test("Finish on an issue already closed: the close is skipped; Finish never merges", async () => {
  const w = world({ pr: { state: "MERGED" }, issue: { state: "CLOSED", labels: [] } });
  const r = await runAccept({ id: "T-1", project: "P-1", bound: w.evidence(), mode: "finish", override: null }, w.deps);
  assert.equal(r.outcome, "done");
  assert.ok(!w.log.includes("merge") && !w.log.includes("close-issue"));
  assert.ok(noteTexts(w).some((x) => /already closed/.test(x)));
});

test("already merged at A at the re-read: no merge call, the chain goes on to read-back, sync and Done", async () => {
  const w = world();
  const ref = refOf(w);
  w.pr.state = "MERGED";
  const r = await runAccept(ref, w.deps);
  assert.equal(r.outcome, "done");
  assert.ok(!w.log.includes("merge"));
  assert.ok(noteTexts(w).some((x) => /already merged/.test(x)));
});

test("a PR merged at ANOTHER head than A, or closed, is blocked with zero writes", async () => {
  for (const patch of [{ state: "MERGED", head: C }, { state: "CLOSED" }]) {
    const w = world();
    const ref = refOf(w);
    Object.assign(w.pr, patch);
    const r = await runAccept(ref, w.deps);
    assert.ok(["blocked", "refreshed"].includes(r.outcome), r.outcome);
    assert.deepEqual(wrote(w), []);
  }
});

// ---- closing keywords on a shared source ----
const sibling = (o = {}) => card({ id: "T-2", project: "P-2", column: "blocked", ...o });
const commits101 = () => Array.from({ length: 101 }, (_, i) => (i === 100 ? "fix: last\n\nCloses #7" : `c${i}`));
for (const [name, pr] of [
  ["body", { body: "Fixes #7" }],
  ["title", { title: "feat: x, closes #7" }],
  ["commit 101", { commits: commits101(), commitCount: 101 }],
]) {
  test(`shared source + closing keyword in the ${name}: blocked, zero remote writes, and an override is not accepted`, async () => {
    const w = world({ pr, cards: [card(), sibling()] });
    for (const override of [null, { reason: "close it anyway, owner said so", covers: ["closing-keyword"] }]) {
      const r = await runAccept(refOf(w, { override }), w.deps);
      assert.equal(r.outcome, "blocked", name);
      assert.ok(r.reasons.some((x) => x.code === "closing-keyword"));
    }
    assert.deepEqual(wrote(w), []);
  });
}

test("the closing keyword scan fails closed: partial commit list or unreadable text blocks the merge", async () => {
  for (const o of [{ pr: { commits: ["a"], commitCount: 4 } }, { prError: { ok: false, word: "offline" } }]) {
    const w = world(o);
    const r = await runAccept(refOf(w), w.deps);
    assert.equal(r.outcome, "blocked");
    assert.deepEqual(wrote(w), []);
  }
});

test("a source with a parked sibling and NO keyword: merges, leaves the issue and labels untouched, says why, moves to Done", async () => {
  const w = world({ cards: [card(), sibling()] });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "done");
  assert.ok(!w.log.includes("close-issue") && !w.log.includes("read-issue"));
  assert.ok(noteTexts(w).some((x) => /source kept open/.test(x)));
  assert.deepEqual(w.moved, [["T-1", "P-1"]]);
});

test("an archived parked sibling keeps the source open; an owner-Done sibling does not", async () => {
  const a = world({ cards: [card(), sibling({ archived: true })] });
  await runAccept(refOf(a), a.deps);
  assert.ok(!a.log.includes("close-issue"));
  const b = world({ cards: [card(), sibling({ column: "done" })] });
  await runAccept(refOf(b), b.deps);
  assert.ok(b.log.includes("close-issue"));
});

test("a Jira source is skipped with a log note and the card still moves to Done", async () => {
  const w = world({ task: { source: { kind: "jira", id: "K-1", url: "https://x.atlassian.net/browse/K-1" } } });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "done");
  assert.ok(!w.log.includes("read-issue") && !w.log.includes("close-issue"));
  assert.ok(noteTexts(w).some((x) => /Jira/.test(x)));
});

// ---- checks ----
for (const [name, checks] of [
  ["red", [ok("a"), { __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "FAILURE" }]],
  ["pending", [ok("a"), { __typename: "CheckRun", name: "b", status: "IN_PROGRESS", conclusion: null }]],
  ["skipped", [ok("a"), { __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "SKIPPED" }]],
  ["missing", undefined],
]) {
  test(`checks ${name} at the click: blocked, no merge`, async () => {
    const w = world();
    const ref = refOf(w);
    w.pr.checks = checks;
    const r = await runAccept(ref, w.deps);
    assert.equal(r.outcome, "blocked");
    assert.deepEqual(wrote(w), []);
    assert.ok(r.reasons.some((x) => x.code === "checks"));
  });
}

test("conflict: blocked at the re-read; and a merge that answers conflict is a failed word, card not moved", async () => {
  const a = world(); const ra = refOf(a); a.pr.mergeable = "CONFLICTING";
  assert.equal((await runAccept(ra, a.deps)).outcome, "blocked");
  assert.deepEqual(wrote(a), []);
  const b = world({ mergeResult: { word: "conflict" } });
  const r = await runAccept(refOf(b), b.deps);
  assert.deepEqual([r.outcome, r.word], ["failed", "conflict"]);
  assert.deepEqual(wrote(b), ["merge"]);
});

// ---- offline ----
test("offline at the read: blocked, no merge, no lock left", async () => {
  const w = world();
  const ref = refOf(w);
  w.evidenceError = "offline";
  const r = await runAccept(ref, w.deps);
  assert.ok(["blocked", "refreshed"].includes(r.outcome));
  assert.deepEqual(wrote(w), []);
});

test("offline at the merge: not assumed either way; the read-back decides (merged at A: carries on; unreadable: unknown, nothing else written)", async () => {
  const a = world({ mergeResult: (w) => { w.pr.state = "MERGED"; return { ok: false, word: "offline" }; } });
  assert.equal((await runAccept(refOf(a), a.deps)).outcome, "done", "the merge landed though the answer was lost");
  const b = world({ mergeResult: { word: "offline" }, readBack: { ok: false, word: "offline" } });
  const r = await runAccept(refOf(b), b.deps);
  assert.equal(r.outcome, "unknown");
  assert.deepEqual(wrote(b), ["merge"]);
  assert.equal(b.records.get(KEY).phase, "unknown");
});

test("offline at the read-back after a good merge: unknown, no sync, no Done; Finish later completes it", async () => {
  const w = world({ readBack: { ok: false, word: "offline" } });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "unknown");
  assert.deepEqual(wrote(w), ["merge"]);
  w.readBack = null;
  const f = await runAccept({ id: "T-1", project: "P-1", bound: w.evidence(), mode: "finish", override: null }, w.deps);
  assert.equal(f.outcome, "done");
  assert.equal(w.merges.length, 1);
});

// ---- double click, two windows, the lock ----
test("double click: the second click is busy at once; one merge", async () => {
  const w = world();
  const [a, b] = await Promise.all([runAccept(refOf(w), w.deps), runAccept(refOf(w), w.deps)]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["busy", "done"]);
  assert.equal(w.merges.length, 1);
});

test("two windows: a lock another window holds means zero writes and a message; the lock is not touched", async () => {
  const w = world();
  const dir = join(w.dir, "data", "drover-accept");
  assert.equal(await createLock(nfs, dir).acquire(KEY, "other-window"), "won");
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "held");
  assert.match(r.text, /Another Accept may be running, or one stopped without finishing/);
  assert.deepEqual(w.log, []);
  assert.equal(w.notes.length, 0);
  assert.equal(readFileSync(join(lockPath(dir, KEY), "token"), "utf8").split("\n")[0], "other-window");
});

test("an uncertain lock (cannot create or read it): fail closed, zero writes", async () => {
  const denied = { ...nfs, mkdir: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, exists: async () => false };
  const w = world({ lock: createLock(denied, "/nowhere") });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "uncertain", "an unprovable lock is not claimed to be held by someone");
  assert.match(r.text, /Could not take the Accept lock/);
  assert.doesNotMatch(r.text, /Another Accept/);
  assert.deepEqual(w.log, []);
});

test("ownership lost before the merge: the token on disk is not ours at the fence, so no merge; the foreign lock stays", async () => {
  const w = world();
  const dir = join(w.dir, "data", "drover-accept");
  const realRead = w.deps.readPr;
  w.deps.readPr = async (r) => { const out = await realRead(r); writeFileSync(join(lockPath(dir, KEY), "token"), "intruder\n1"); return out; };
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "lost-lock");
  assert.ok(!w.log.includes("merge"));
  assert.equal(readFileSync(join(lockPath(dir, KEY), "token"), "utf8"), "intruder\n1", "late cleanup leaves the other owner's lock");
});

test("a crashed run's lock is never stolen: a new Accept sees held (and the dialog shows the clear command)", async () => {
  const w = world({ mergeResult: () => { throw new Error("process died"); } });
  await assert.rejects(runAccept(refOf(w), w.deps));
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "held");
  assert.equal(w.log.filter((x) => x === "merge").length, 1);
});

// ---- soft gates at the click ----
test("soft gate at the click: the review went pass to adverse at the same head, so no merge unless a typed reason covers it", async () => {
  const w = world();
  const ref = refOf(w);
  w.verdict = { state: "adverse", head: A, by: "inspector", at: 2, report: "/w/r.md" };
  const r = await runAccept(ref, w.deps);
  assert.equal(r.outcome, "blocked");
  assert.deepEqual(r.soft, ["review-adverse"]);
  assert.deepEqual(wrote(w), []);
});

test("an override covering fewer codes than now fail: stop and ask again; nothing written", async () => {
  const w = world({ task: { notes: [] } });
  const ref = refOf(w, { override: { reason: "plan was agreed in person", covers: ["plan-missing"] } });
  w.verdict = { state: "missing" };
  const r = await runAccept(ref, w.deps);
  assert.equal(r.outcome, "blocked");
  assert.deepEqual(r.soft.sort(), ["plan-missing", "review-missing"]);
  assert.deepEqual(wrote(w), []);
});

test("Finish needs the soft gates too: a merged PR with no review and no override is not finished", async () => {
  const w = world({ pr: { state: "MERGED" }, verdict: { state: "missing" } });
  const r = await runAccept({ id: "T-1", project: "P-1", bound: w.evidence(), mode: "finish", override: null }, w.deps);
  assert.equal(r.outcome, "blocked");
  assert.deepEqual(wrote(w), []);
});

test("a valid override is logged as a decision note with its reason and codes, before any write; a short reason is rejected", async () => {
  const w = world({ verdict: { state: "missing" } });
  const r = await runAccept(refOf(w, { override: { reason: "reviewed by hand on the branch", covers: ["review-missing"] } }), w.deps);
  assert.equal(r.outcome, "done");
  const i = w.notes.findIndex((n) => n.kind === "decision");
  assert.ok(i >= 0);
  assert.match(w.notes[i].text, /^accept: override review-missing: reviewed by hand on the branch$/);
  assert.ok(w.log.indexOf("note:decision") < w.log.indexOf("merge"));
  assert.deepEqual(w.records.get(KEY).override, { reason: "reviewed by hand on the branch", covers: ["review-missing"] });
  const x = world({ verdict: { state: "missing" } });
  const bad = await runAccept(refOf(x, { override: { reason: "ok", covers: ["review-missing"] } }), x.deps);
  assert.equal(bad.outcome, "blocked");
  assert.deepEqual(wrote(x), []);
});

test("a hard stop ignores the override and logs nothing as accepted", async () => {
  const w = world();
  const ref = refOf(w, { override: { reason: "merge it, the checks are flaky", covers: ["checks"] } });
  w.pr.checks = [{ __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "FAILURE" }];
  const r = await runAccept(ref, w.deps);
  assert.equal(r.outcome, "blocked");
  assert.ok(!w.notes.some((n) => n.kind === "decision"));
});

// ---- no PR ----
test("no PR: Done only. Zero merge, zero issue read or close, one move, the same soft gates", async () => {
  const w = world({ noPr: true });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "done");
  assert.deepEqual(w.log.filter((x) => !x.startsWith("note:")), ["read-evidence", "move-done"]);
  assert.deepEqual(w.moved, [["T-1", "P-1"]]);
  const x = world({ noPr: true, verdict: { state: "missing" } });
  assert.equal((await runAccept(refOf(x), x.deps)).outcome, "blocked");
  assert.deepEqual(wrote(x), []);
});

test("no PR: the worktree head changed since the dialog opened, so refresh and stop", async () => {
  const w = world({ noPr: true });
  const ref = refOf(w);
  w.wtHead = C; w.verdict = { ...w.verdict, head: C };
  assert.equal((await runAccept(ref, w.deps)).outcome, "refreshed");
  assert.deepEqual(wrote(w), []);
});

// ---- the move ----
test("moving the card fails: reported failed with the merge kept; no claim of Done", async () => {
  const w = world({ moveOk: false });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "failed");
  assert.deepEqual(w.moved, []);
});

test("a card that is gone or no longer in Review is refused before any write", async () => {
  const gone = world(); gone.deps.task = () => null;
  assert.equal((await runAccept(refOf(gone), gone.deps)).outcome, "blocked");
  const moved = world({ task: { column: "doing" } });
  assert.equal((await runAccept(refOf(moved), moved.deps)).outcome, "blocked");
  assert.deepEqual([...wrote(gone), ...wrote(moved)], []);
});

test("WRITES list is the whole write surface of the fake deps", () => {
  assert.deepEqual(WRITES, ["merge", "close-issue", "remove-labels", "move-done"]);
});

// ---- fix round 1 (T-MWO3FDGAIKD) ----
// H2: the verdict for A is re-derived from the LATEST local notes at the final eligibility boundary (merge and Finish).
test("H2: an adverse review of A appended while the PR text is being read blocks the merge (no override)", async () => {
  const w = world();
  const real = w.deps.readPr;
  w.deps.readPr = async (r) => { const out = await real(r); w.task = { ...w.task, notes: [...w.task.notes, reviewAt(A, "adverse")] }; return out; };
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "blocked");
  assert.deepEqual(r.soft, ["review-adverse"]);
  assert.deepEqual(wrote(w), []);
});

test("H2: the review removed while the PR text is being read blocks the merge", async () => {
  const w = world();
  const real = w.deps.readPr;
  w.deps.readPr = async (r) => { const out = await real(r); w.verdict = { state: "missing" }; return out; };
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "blocked");
  assert.deepEqual(r.soft, ["review-missing"]);
  assert.deepEqual(wrote(w), []);
});

test("H2: a review change in the last await before the merge (the lock fence read) still blocks the merge", async () => {
  const w = world();
  const real = w.lock.read;
  w.deps.lock = { ...w.lock, read: async (k) => { const v = await real(k); w.task = { ...w.task, notes: [...w.task.notes, reviewAt(A, "adverse")] }; return v; } };
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "blocked");
  assert.ok(!w.log.includes("merge"));
});

test("H2: Finish re-derives the verdict too: an adverse review appended during the read-back stops the sync and Done", async () => {
  const w = world({ pr: { state: "MERGED" } });
  const real = w.deps.readBack;
  w.deps.readBack = async (r) => { const out = await real(r); w.task = { ...w.task, notes: [...w.task.notes, reviewAt(A, "adverse")] }; return out; };
  const r = await runAccept({ id: "T-1", project: "P-1", bound: w.evidence(), mode: "finish", override: null }, w.deps);
  assert.equal(r.outcome, "blocked");
  assert.deepEqual(wrote(w), []);
});

test("H2: the NEWEST review decides: a review of ANOTHER head appended later makes A stale and blocks the merge", async () => {
  const w = world();
  w.task = { ...w.task, notes: [...w.task.notes, reviewAt(C, "adverse", 60)] };
  assert.equal((await runAccept(refOf(w), w.deps)).outcome, "blocked");
  assert.deepEqual(wrote(w), []);
});

test("H2: a newer pass at A after an earlier adverse one at A is accepted without an override", async () => {
  const w = world({ verdict: { state: "adverse", head: A, by: "inspector", report: "/w/r.md" } });
  w.task = { ...w.task, notes: [...w.task.notes, reviewAt(A, "pass", 60)] };
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "done");
  assert.ok(!w.notes.some((n) => n.kind === "decision"), "no override was needed");
});

// H3: the same issue under two spellings is one source.
const aliasCard = (o = {}) => card({ id: "T-2", project: "P-2", column: "blocked", source: { kind: "github", id: "O/R#7", url: "https://github.com/O/R/issues/7" }, ...o });
test("H3: an unfinished sibling whose source URL differs only in repo case keeps the source open (no close)", async () => {
  const w = world({ cards: [card(), aliasCard()] });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "done");
  assert.ok(!w.log.includes("close-issue") && !w.log.includes("read-issue"));
  assert.ok(noteTexts(w).some((x) => /source kept open/.test(x)));
});

test("H3: a closing keyword for a source with a case-alias unfinished sibling (archived too) blocks the merge, no override", async () => {
  for (const sib of [aliasCard(), aliasCard({ archived: true })]) {
    const w = world({ pr: { body: "Fixes #7" }, cards: [card(), sib] });
    const r = await runAccept(refOf(w, { override: { reason: "close it anyway please", covers: ["closing-keyword"] } }), w.deps);
    assert.equal(r.outcome, "blocked");
    assert.ok(r.reasons.some((x) => x.code === "closing-keyword"));
    assert.deepEqual(wrote(w), []);
  }
});

// M4: a source the PR already closed still loses its status: labels before the card is Done.
test("M4: an issue already CLOSED by the PR keeps no status: label: labels removed with no second close, then Done", async () => {
  const w = world({ issue: { state: "CLOSED", labels: ["status: review", "bug"] } });
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "done");
  assert.ok(!w.log.includes("close-issue"));
  assert.deepEqual(w.removed.map((a) => [a.repo, a.number, a.labels]), [["o/r", 7, ["status: review"]]]);
  assert.ok(w.log.indexOf("remove-labels") < w.log.indexOf("move-done"));
  assert.deepEqual(w.issue.labels, ["bug"]);
});

test("M4: a label edit that fails is not Done: synced-failed, merge kept, and Finish retries the label removal", async () => {
  const w = world({ issue: { state: "CLOSED", labels: ["status: review"] } });
  w.removeResult = { ok: false, word: "auth" };
  const r = await runAccept(refOf(w), w.deps);
  assert.equal(r.outcome, "synced-failed");
  assert.deepEqual(w.moved, []);
  assert.equal(w.records.get(KEY).phase, "merged");
  w.removeResult = null;
  const f = await runAccept({ id: "T-1", project: "P-1", bound: w.evidence(), mode: "finish", override: null }, w.deps);
  assert.equal(f.outcome, "done");
  assert.equal(w.merges.length, 1);
  assert.deepEqual(w.issue.labels, []);
});

// M7: every step is a durable log note, in order.
test("M7: the successful re-read and the merge attempt are persisted as log notes, in order, before the merge call", async () => {
  const w = world();
  await runAccept(refOf(w), w.deps);
  const i = (re) => w.notes.findIndex((n) => re.test(n.text));
  assert.ok(i(/bound/) >= 0 && i(/re-read ok/) > i(/bound/) && i(/merging/) > i(/re-read ok/), noteTexts(w).join("\n"));
  assert.ok(w.notes[i(/merging/)].kind === "log");
  assert.ok(w.seq.findIndex((x) => /note:accept: merging/.test(x)) < w.seq.indexOf("merge"), "the merging note is written before the merge call");
  const x = world({ noPr: true });
  await runAccept(refOf(x), x.deps);
  assert.ok(x.notes.some((n) => /re-read ok/.test(n.text)), "no-PR path logs its re-read too");
});

// ---- fix rounds 2 and 3 (T-MWO3FDGAIKD): the late eligibility gap is a CLASS ----
// Any await between the last eligibility check and an irreversible call lets the world change. Two harnesses inject a mutation while a wait is
// pending: (1) at the ENTRY and at the RESULT of every awaited dep call, (2) at EVERY microtask tick of a run whose deps are in memory (so result
// waits, internal waits and bare awaits are all covered). Whatever the mutation makes ineligible, no irreversible dispatch (merge, issue close,
// label removal, move to Done) may be issued after it.
const IRREVERSIBLE = ["merge", "close-issue", "remove-labels", "move-done"];
const POINTS = ["note", "readEvidence", "readPr", "readBack", "readIssue", "sleep"]; // awaited deps that are not themselves irreversible
const DISPATCHED = ["merge", "closeIssue", "removeLabels", "moveDone"]; // irreversible deps: their RESULT is a wait too
const LOCK_POINTS = ["acquire", "read"];
const adverse = (w) => { w.task = { ...w.task, notes: [...w.task.notes, reviewAt(A, "adverse", 70 + w.seq.length)] }; };
const withdrawn = (w) => { w.task = { ...w.task, notes: [...w.task.notes, { id: `nw${w.seq.length}`, at: 80 + w.seq.length, by: "coordinator", kind: "decision", text: "plan withdrawn" }] }; };
const addSibling = (w) => { w.cards = [...w.cards, aliasCard({ source: { kind: "github", id: "o/r#7", url: ISSUE } })]; };
const memLock = () => { const m = new Map(); return { acquire: async (k, t) => (m.has(k) ? "held" : (m.set(k, t), "won")), read: async (k) => m.get(k) ?? null, release: async (k, t) => (m.get(k) === t ? (m.delete(k), "released") : "kept"), state: async (k) => (m.has(k) ? "present" : "none") }; };

// (1) entry + result injection. index === null: no mutation (counts the points).
async function sweepOnce(make, run, index, mutate, bad) {
  const w = make();
  let n = 0, hit = null;
  const at = (label) => { if (n++ === index) { hit = label; w.mutatedAt = w.seq.length; mutate(w); } };
  for (const k of POINTS) { const orig = w.deps[k]; w.deps[k] = async (...a) => { at(k); const out = await orig(...a); at(`${k} result`); return out; }; }
  for (const k of DISPATCHED) { const orig = w.deps[k]; w.deps[k] = (...a) => { const p = orig(...a); return p.then((out) => { at(`${k} result`); return out; }); }; }
  const lock = { ...w.deps.lock };
  for (const k of LOCK_POINTS) { const orig = w.deps.lock[k]; lock[k] = async (...a) => { at(`lock.${k}`); return orig(...a); }; }
  w.deps.lock = lock;
  const r = await run(w);
  const violations = hit === null ? [] : w.seq.slice(w.mutatedAt).filter((x) => bad.includes(x));
  return { points: n, hit, outcome: r.outcome, violations };
}
async function sweep(name, make, run, mutate, bad) {
  const base = await sweepOnce(make, run, null, mutate, bad);
  assert.ok(base.points >= 5, `${name}: the path has await points (${base.points})`);
  assert.equal(base.outcome, "done", `${name}: the unmutated path completes`);
  for (let i = 0; i < base.points; i++) {
    const r = await sweepOnce(make, run, i, mutate, bad);
    assert.deepEqual(r.violations, [], `${name}: a mutation injected at wait #${i} (${r.hit}) was still followed by ${r.violations.join(", ")}`);
  }
}

// (2) every microtask. Deps are async in-memory fakes, so the whole run is one chain of microtasks; a ticker that awaits K times then mutates lands
// the mutation between ANY two steps of the chain, including a bare `await` between a gate and its dispatch.
async function microOnce(make, run, K, mutate, bad) {
  const w = make();
  let fired = false, finished = false;
  const ticker = (async () => { for (let i = 0; i < K && !finished; i++) await null; if (!finished) { fired = true; w.mutatedAt = w.seq.length; mutate(w); } })();
  const r = await run(w);
  finished = true;
  await ticker;
  return { fired, outcome: r.outcome, violations: fired ? w.seq.slice(w.mutatedAt).filter((x) => bad.includes(x)) : [] };
}
async function microSweep(name, make, run, mutate, bad) {
  assert.equal((await microOnce(make, run, 1e9, mutate, bad)).outcome, "done", `${name}: the unmutated path completes`);
  let K = 0;
  for (; K < 20000; K++) {
    const r = await microOnce(make, run, K, mutate, bad);
    if (!r.fired) break;
    assert.deepEqual(r.violations, [], `${name}: a mutation landing after ${K} microtasks was still followed by ${r.violations.join(", ")}`);
  }
  assert.ok(K >= 10, `${name}: the sweep covered ${K} microtask positions`);
}

const pathsFor = (ra, lock = () => undefined) => ({
  "merge path": [() => world({ pr: { body: "Fixes #7" }, lock: lock() }), (w) => ra(refOf(w), w.deps)],
  "finish path": [() => world({ pr: { state: "MERGED" }, lock: lock() }), (w) => ra({ id: "T-1", project: "P-1", bound: w.evidence(), mode: "finish", override: null }, w.deps)],
  "no-PR path": [() => world({ noPr: true, lock: lock() }), (w) => ra(refOf(w), w.deps)],
});
const PATHS = pathsFor(runAccept);
const MICRO = pathsFor(runAccept, memLock);
for (const [pname, [make, run]] of Object.entries(PATHS)) {
  test(`sweep, ${pname}: an adverse review appended at any await point is never followed by a merge, an issue write or Done`, async () => {
    await sweep(pname, make, run, adverse, IRREVERSIBLE);
  });
  test(`sweep, ${pname}: the plan withdrawn at any await point is never followed by a merge, an issue write or Done`, async () => {
    await sweep(pname, make, run, withdrawn, IRREVERSIBLE);
  });
  test(`microtask sweep, ${pname}: an adverse review or a withdrawn plan landing between ANY two steps is never followed by an irreversible call`, async () => {
    await microSweep(pname, MICRO[pname][0], MICRO[pname][1], adverse, IRREVERSIBLE);
    await microSweep(pname, MICRO[pname][0], MICRO[pname][1], withdrawn, IRREVERSIBLE);
  });
}
test("sweep, merge path: an unfinished same-source sibling added at any await point (PR body Fixes #7) is never followed by a merge or an issue close", async () => {
  await sweep("merge path", PATHS["merge path"][0], PATHS["merge path"][1], addSibling, ["merge", "close-issue", "remove-labels"]);
  await microSweep("merge path", MICRO["merge path"][0], MICRO["merge path"][1], addSibling, ["merge", "close-issue", "remove-labels"]);
});
test("sweep, finish path: a sibling added at any await point is never followed by an issue write", async () => {
  await sweep("finish path", PATHS["finish path"][0], PATHS["finish path"][1], addSibling, ["close-issue", "remove-labels"]);
  await microSweep("finish path", MICRO["finish path"][0], MICRO["finish path"][1], addSibling, ["close-issue", "remove-labels"]);
});
test("sweep: a newer pass at A after an adverse review (override covering it) injected at any await point never blocks a chain that was eligible", async () => {
  const pass = (w) => { w.task = { ...w.task, notes: [...w.task.notes, reviewAt(A, "pass", 90 + w.seq.length)] }; };
  const make = () => world({ verdict: { state: "adverse", head: A, by: "inspector", report: "/w/r.md" } });
  const run = (w) => runAccept(refOf(w, { override: { reason: "the adverse note was about a docs typo", covers: ["review-adverse"] } }), w.deps);
  await sweep("override path", make, run, pass, []);
  for (let i = 0; i < 6; i++) assert.equal((await sweepOnce(make, run, i, pass, [])).outcome, "done", `a newer pass at point ${i} keeps it eligible`);
});

// ---- the source sync order (round 3): close FIRST, then the labels, each behind its own final ----
const hookAfter = (w, dep, f) => { const orig = w.deps[dep]; w.deps[dep] = async (...a) => { const out = await orig(...a); f(w); return out; }; };
for (const [mname, mut] of [["a sibling is added", addSibling], ["an adverse review is appended", adverse]]) {
  test(`source sync (a): ${mname} between the merge result and the close: no close, no label removal`, async () => {
    const w = world();
    hookAfter(w, "merge", mut);
    const r = await runAccept(refOf(w), w.deps);
    assert.ok(!w.log.includes("close-issue") && !w.log.includes("remove-labels"), w.log.join());
    if (mut === adverse) { assert.equal(r.outcome, "blocked"); assert.deepEqual(w.moved, []); }
    assert.equal(w.merges.length, 1, "the merge stands");
  });
  test(`source sync (b): ${mname} between the close and the label removal: the close stays, the labels are skipped with a note`, async () => {
    const w = world();
    hookAfter(w, "closeIssue", mut);
    const r = await runAccept(refOf(w), w.deps);
    assert.equal(w.log.filter((x) => x === "close-issue").length, 1);
    assert.ok(!w.log.includes("remove-labels"), "no label removal after the change");
    assert.ok(noteTexts(w).some((t) => /status labels not removed/.test(t)), noteTexts(w).join("\n"));
    assert.equal(r.outcome, mut === adverse ? "blocked" : "done");
    if (mut === adverse) assert.deepEqual(w.moved, []);
  });
  test(`source sync (c): ${mname} on the Finish path while the issue is read: no close, no label removal`, async () => {
    const w = world({ pr: { state: "MERGED" } });
    hookAfter(w, "readIssue", mut);
    await runAccept({ id: "T-1", project: "P-1", bound: w.evidence(), mode: "finish", override: null }, w.deps);
    assert.ok(!w.log.includes("close-issue") && !w.log.includes("remove-labels"), w.log.join());
  });
}
test("source sync: the close comes first and the labels second; an issue already CLOSED skips the close; a failed close skips the labels", async () => {
  const w = world();
  await runAccept(refOf(w), w.deps);
  assert.ok(w.log.indexOf("close-issue") < w.log.indexOf("remove-labels"));
  const c = world({ issue: { state: "CLOSED", labels: ["status: review"] } });
  await runAccept(refOf(c), c.deps);
  assert.ok(!c.log.includes("close-issue") && c.log.includes("remove-labels"));
  const f = world({ closeResult: { ok: false, word: "auth" } });
  const r = await runAccept(refOf(f), f.deps);
  assert.equal(r.outcome, "synced-failed");
  assert.ok(!f.log.includes("remove-labels"));
});

// ---- the source guard and its mutation sentinel (round 3) ----
const ACCEPT_URL = new URL("../_lib/accept.js", import.meta.url);
const ACCEPT_SRC = readFileSync(ACCEPT_URL, "utf8");
const FINALS = { merge: ["deps.merge(rec)", "f1"], close: ["deps.closeIssue(", "fs"], labels: ["deps.removeLabels(", "fl"], done: ["deps.moveDone(", "fd"] };
const uncommented = (t) => t.replace(/(^|\s)\/\/[^\n]*/g, "$1");
// The dispatch calls whose span from the END of their `const <name> = final(...);` statement to the call holds an `await` (comments ignored).
function awaitGaps(src) {
  const gaps = [];
  for (const [what, [call, name]] of Object.entries(FINALS)) {
    const decl = new RegExp(`const ${name} = final\\([^;]*\\);`).exec(src);
    const at = src.indexOf(call, decl ? decl.index + decl[0].length : 0);
    if (!decl || at < 0) { gaps.push(`${what}: no final() gate before ${call}`); continue; }
    if (/\bawait\b/.test(uncommented(src.slice(decl.index + decl[0].length, at)))) gaps.push(`${what}: an await between ${name} = final(...) and ${call}`);
  }
  return gaps;
}
async function loadMutant(src, tag) {
  globalThis.__acceptReviewOf = reviewOf;
  const text = src.replace('import { reviewOf } from "./evidence.js";', "const reviewOf = globalThis.__acceptReviewOf;") + `\n// ${tag}`;
  return import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);
}
const withBareAwait = (name) => ACCEPT_SRC.replace(new RegExp(`(const ${name} = final\\([^;]*\\);)`), "$1 await Promise.resolve();");

test("source: every irreversible dispatch follows its own final() with no await in the WHOLE span between them", () => {
  assert.deepEqual(awaitGaps(ACCEPT_SRC), []);
});

for (const [what, [, name]] of Object.entries(FINALS)) {
  test(`mutation sentinel (${what}): a bare 'await Promise.resolve();' right after ${name} = final(...) is caught by the source guard AND by the microtask sweep`, async () => {
    const mutated = withBareAwait(name);
    assert.notEqual(mutated, ACCEPT_SRC, "the mutant differs from the source");
    assert.ok(awaitGaps(mutated).length >= 1, "the source guard sees the await");
    const mod = await loadMutant(mutated, name);
    const mpaths = pathsFor(mod.runAccept, memLock);
    let caught = null;
    for (const [pname, [make, run]] of Object.entries(mpaths)) {
      try { await microSweep(pname, make, run, adverse, IRREVERSIBLE); } catch (e) { caught = e; break; }
    }
    assert.ok(caught, "the microtask sweep must fail on this mutant");
    assert.match(String(caught.message), /still followed by/);
  });
}
