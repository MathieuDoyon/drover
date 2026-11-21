// B3b (T-MWO3FDGAIKD): the Accept control in the proof dialog. The gate, the lock state and the PR text are loaded in refresh() (read-only), never in
// render; render reads memory. Cold and warm render make no exec/read/write/spawn/timer call and read no shared key, with 3, 30 and 300 cards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLock } from "../_lib/accept.js";
import { A, B, URL5, P, IO, Todos, host, open, render, rev, good, card, router, ok, prJson, until, has, delta, none, reviewNote, approvedNote, OLD, expiringCx } from "./accept-host.js";

const KEY = "P-1__T-3";
const merged = () => ok(prJson({ state: "MERGED" }));

test("a card that is ready: the gate is computed in refresh and Accept is the live control with its label", async () => {
  const { v, cx } = await open([good()]);
  const g = v.proof.gate;
  assert.equal(g.enabled, true);
  assert.equal(g.mode, "merge");
  const r = render(v, cx);
  assert.ok(r.ids.includes("proof-accept"));
  assert.ok(!r.ids.includes("proof-accept-off"));
  assert.ok(has(r, "Accept (merge and move to Done)"));
  assert.ok(!has(r, "ships in B3b"));
  assert.ok(r.ids.includes("proof-close") && r.ids.includes("proof-refresh"));
});

test("a hard stop shows the first reason beside a disabled Accept and the full list; no reason input is offered", async () => {
  const { v, cx } = await open([good()], { gh: router({ view: ok(prJson({ statusCheckRollup: [{ __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "FAILURE" }] })) }) });
  const r = render(v, cx);
  assert.ok(r.ids.includes("proof-accept-off"));
  assert.ok(has(r, "NOT green") || has(r, "checks"));
  assert.ok(!r.ids.includes("proof-reason"));
  assert.equal(v.proof.gate.enabled, false);
});

test("a soft stop offers the Override input; a valid typed reason enables Accept with no I/O; clearing it disables again", async () => {
  const { v, cx, calls } = await open([rev({ notes: [approvedNote] })]); // no review
  assert.deepEqual(v.proof.gate.soft, ["review-missing"]);
  assert.ok(render(v, cx).ids.includes("proof-reason"));
  assert.ok(render(v, cx).ids.includes("proof-accept-off"));
  const before = calls.exec;
  v.proof.reason.set_value("short");
  v.proof.onReason(cx);
  assert.equal(v.proof.gate.enabled, false);
  v.proof.reason.set_value("I reviewed the diff by hand");
  v.proof.onReason(cx);
  assert.equal(v.proof.gate.enabled, true);
  assert.ok(render(v, cx).ids.includes("proof-accept"));
  v.proof.reason.set_value("");
  v.proof.onReason(cx);
  assert.equal(v.proof.gate.enabled, false);
  assert.equal(calls.exec, before, "typing in the reason input never execs");
});

test("Accept runs the chain through the injected deps; each step line shows live; the result line says Merged and moved to Done", async () => {
  const m = await open([good()]);
  const log = [];
  const real = IO.acceptDeps();
  IO.useAcceptDeps({ ...real, merge: async () => { log.push("merge"); return { ok: true }; }, readBack: async () => ({ ok: true, state: "MERGED", head: A }), readIssue: async () => ({ ok: true, state: "CLOSED", labels: [] }), moveDone: async () => { log.push("move"); return true; }, note: async (_i, _p, t) => { log.push(`note ${t}`); } });
  try {
    await m.v.proof.accept(m.cx);
    assert.equal(m.v.proof.run.result.outcome, "done");
    const r = render(m.v, m.cx);
    assert.ok(has(r, "Merged and moved to Done"));
    assert.ok(m.v.proof.run.lines.length >= 4, "step lines kept in memory");
    assert.ok(has(r, m.v.proof.run.lines[0]));
    assert.deepEqual(log.filter((x) => !x.startsWith("note")), ["merge", "move"]);
    assert.ok(!r.ids.includes("proof-accept"), "no second click on a finished chain");
  } finally { IO.useAcceptDeps(null); }
});

test("while the chain runs Accept is disabled (double click is one run); Close stays available", async () => {
  const m = await open([good()]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const real = IO.acceptDeps();
  let merges = 0;
  IO.useAcceptDeps({ ...real, merge: async () => { merges++; await gate; return { ok: true }; }, readBack: async () => ({ ok: true, state: "MERGED", head: A }), readIssue: async () => ({ ok: true, state: "CLOSED", labels: [] }), moveDone: async () => true, note: async () => {} });
  try {
    const first = m.v.proof.accept(m.cx);
    await until(() => m.v.proof.run?.running && merges === 1, "merging");
    const r = render(m.v, m.cx);
    assert.ok(r.ids.includes("proof-accept-off") && r.ids.includes("proof-close"));
    await m.v.proof.accept(m.cx);
    release();
    await first;
    assert.equal(merges, 1);
  } finally { IO.useAcceptDeps(null); }
});

test("a lock this process did not create: Accept off, 'Another Accept may be running', the PR state, the exact lock path and ONE clear command (text only)", async () => {
  const m = await open([good()], { trap: true });
  assert.equal(await IO.acceptDeps().lock.acquire(KEY, "other-window"), "won");
  m.v.proof.refresh(m.cx);
  await until(() => m.v.proof.state === "ready" && m.v.proof.lock === "present", "lock seen");
  const r = render(m.v, m.cx);
  assert.ok(r.ids.includes("proof-accept-off") && !r.ids.includes("proof-accept"));
  assert.ok(has(r, "Another Accept may be running, or one stopped without finishing"));
  const path = `${m.home}/data/drover-accept/${KEY}.lock`;
  assert.ok(has(r, path), "the exact path");
  assert.ok(has(r, `rm -r '${path}'`), "the ONE command");
  assert.ok(has(r, "your call") || has(r, "no Drover window"), "says it is the owner's call");
  assert.ok(has(r, "PR #5 OPEN"), "the read-only PR state is shown before the instruction");
  assert.ok(!r.ids.some((i) => /release/i.test(i)), "no in-app Release control");
  assert.deepEqual(m.calls.writes, []);
  assert.ok(m.calls.log.every(([c]) => c !== "rm"), "the app never runs the command");
});

test("a lock state that cannot be read is not HELD: 'Cannot read the lock state', no clear command, Accept stays off", async () => {
  const m = await open([good()], { trap: true });
  const real = IO.acceptDeps();
  IO.useAcceptDeps({ ...real, lock: { ...real.lock, state: async () => "unknown" } });
  try {
    m.v.proof.refresh(m.cx);
    await until(() => m.v.proof.state === "ready" && m.v.proof.lock === "unknown", "unknown seen");
    const r = render(m.v, m.cx);
    assert.ok(has(r, "Cannot read the lock state"));
    assert.ok(!has(r, "Another Accept"), "not claimed to be held");
    assert.ok(!r.texts.some((t) => String(t).includes("rm -r")), "no clear command for a lock that may not exist");
    assert.equal(m.v.proof.ready, false);
    assert.ok(r.ids.includes("proof-accept-off") && !r.ids.includes("proof-accept"));
  } finally { IO.useAcceptDeps(null); }
});

test("a click whose lock cannot be taken (code-less fs errors) never shows 'Another Accept' in the result line or after the refresh", async () => {
  const m = await open([good()], { trap: true });
  const real = IO.acceptDeps();
  const broken = { readdir: async () => { throw new Error("permission denied"); }, mkdir: async () => { throw new Error("permission denied"); }, exists: async () => { throw new Error("permission denied"); }, readFile: async () => { throw new Error("permission denied"); }, writeFile: async () => { throw new Error("permission denied"); }, unlink: async () => {}, rmdir: async () => {} };
  IO.useAcceptDeps({ ...real, lock: createLock(broken, "/nowhere") });
  try {
    await m.v.proof.accept(m.cx);
    await until(() => m.v.proof.state === "ready" && m.v.proof.lock === "unknown", "unknown after the failed click");
    const r = render(m.v, m.cx);
    assert.ok(has(r, "Could not take the Accept lock"));
    assert.ok(has(r, "Cannot read the lock state"));
    assert.ok(!has(r, "Another Accept"), "neither the lock section nor the result line claims it is held");
    assert.ok(r.ids.includes("proof-accept-off") && !r.ids.includes("proof-accept"));
  } finally { IO.useAcceptDeps(null); }
});

test("restart after the merge: an earlier Accept stopped before the sync, the PR is MERGED at A: the dialog offers Finish (sync and Done), not Accept", async () => {
  const m = await open([good()], { gh: router({ view: merged() }), noWait: true });
  m.raw["drover.accept"] = { [KEY]: { v: 1, id: "T-3", project: P.id, repo: "o/r", number: 5, url: URL5, base: "main", baseSha: B, head: A, kind: "pr", mode: "merge", phase: "merged", token: "x", at: 1 } };
  await until(() => m.v.proof.state === "ready", "ready");
  m.v.proof.refresh(m.cx);
  await until(() => m.v.proof.state === "ready" && m.v.proof.gate, "gate");
  const r = render(m.v, m.cx);
  assert.equal(m.v.proof.gate.mode, "finish");
  assert.ok(has(r, "Finish (sync and move to Done)"));
  assert.ok(has(r, "Merged at aaaaaaa"));
  assert.ok(r.ids.includes("proof-accept"));
});

test("an earlier attempt left the PR OPEN: shown as not merged (never Queued); Check again is offered and is read-only", async () => {
  const m = await open([good()]);
  m.raw["drover.accept"] = { [KEY]: { v: 1, id: "T-3", project: P.id, repo: "o/r", number: 5, url: URL5, base: "main", baseSha: B, head: A, kind: "pr", mode: "merge", phase: "open", token: "x", at: 1 } };
  m.v.proof.refresh(m.cx);
  await until(() => m.v.proof.record?.phase === "open", "record read");
  const r = render(m.v, m.cx);
  assert.ok(has(r, "Not merged: PR still open (queued or rejected, not proven)"));
  assert.ok(!r.texts.some((t) => /Queued/.test(t)));
  assert.ok(r.ids.includes("proof-check-again"));
  const writes = m.calls.log.length;
  await m.v.proof.checkAgain(m.cx);
  assert.ok(m.calls.log.slice(writes).every((c) => !c.includes("merge")));
});

for (const state of ["ready", "held", "finish", "done"]) {
  test(`dialog render in ${state}: cold and warm make no exec/read/write/spawn/timer call and read no shared key`, async () => {
    const o = state === "finish" ? { gh: router({ view: merged() }) } : {};
    const m = await open([good()], o);
    if (state === "held") { await IO.acceptDeps().lock.acquire(KEY, "x"); m.v.proof.refresh(m.cx); await until(() => m.v.proof.lock === "present", "lock"); }
    if (state === "done") m.v.proof.run = { running: false, lines: ["accept: moved to Done"], result: { outcome: "done", text: "Merged and moved to Done" } };
    for (const k in m.reads) delete m.reads[k];
    const cold = delta(m.calls, () => render(m.v, m.cx));
    assert.deepEqual(cold.d, none, "cold");
    assert.deepEqual(delta(m.calls, () => render(m.v, m.cx)).d, none, "warm");
    assert.deepEqual(m.reads, {}, "no shared key read in render");
  });
}

test("the gate is recomputed by refresh and by typing a reason, never by render: the object is the same across renders", async () => {
  const m = await open([good()]);
  const g = m.v.proof.gate;
  render(m.v, m.cx); render(m.v, m.cx);
  assert.equal(m.v.proof.gate, g);
  m.v.proof.refresh(m.cx);
  await until(() => m.v.proof.state === "ready" && m.v.proof.gate !== g, "recomputed");
});

test("with 3, 30 and 300 cards in the store the dialog reads the same keys in render (none) and does the same I/O to load", async () => {
  const seen = [];
  for (const n of [3, 30, 300]) {
    const others = Array.from({ length: n }, (_, i) => card(100 + i, { column: i % 2 ? "blocked" : "doing", source: i % 5 ? null : { kind: "github", id: "o/r#7", url: "https://github.com/o/r/issues/7" } }));
    const m = await open([good(), ...others]);
    for (const k in m.reads) delete m.reads[k];
    render(m.v, m.cx);
    assert.deepEqual(m.reads, {});
    seen.push({ exec: m.calls.log.length, enabled: m.v.proof.gate.enabled });
  }
  assert.deepEqual(seen[1].exec, seen[0].exec, "loading does not scale its gh calls with the card count");
  assert.deepEqual(seen[2].exec, seen[0].exec);
});

test("source: render and the gate helpers call no loader, io read, exec or spawn", () => {
  const src = readFileSync(new URL("../drover-todos/proof.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("  render(cx) {"));
  for (const word of ["loadEvidence(", "load(", "loadRuns(", "exec(", "readTextFile(", "writeTextFile(", "cx.spawn(", "timer", "gate(", "acceptDeps(", "runAccept(", "InputState.new("]) assert.ok(!body.includes(word), `render must not call ${word}`);
});

// ---- fix round 1 (T-MWO3FDGAIKD) ----
test("H1: the step notifier uses the spawn callback's durable context, not the click context that expires across an await", async () => {
  const m = await open([good()]);
  const click = expiringCx(m.cx);
  const log = [];
  const real = IO.acceptDeps();
  IO.useAcceptDeps({ ...real, merge: async () => { log.push("merge"); return { ok: true }; }, readBack: async () => ({ ok: true, state: "MERGED", head: A }), readIssue: async () => ({ ok: true, state: "CLOSED", labels: [] }), moveDone: async () => true, note: async () => {} });
  try {
    await m.v.proof.accept(click);
    assert.equal(m.v.proof.run.result.outcome, "done", JSON.stringify(m.v.proof.run.result));
    assert.deepEqual(log, ["merge"]);
    assert.ok(click.durable.notified >= 4, "steps notified through the durable context");
    assert.equal(await IO.acceptDeps().lock.state(KEY), "none", "the lock is released");
  } finally { IO.useAcceptDeps(null); }
});

test("H1: an error after the lock is taken leaves the lock by design, and the dialog then shows the lock recovery text, not a generic failure", async () => {
  const m = await open([good()]);
  const real = IO.acceptDeps();
  IO.useAcceptDeps({ ...real, merge: async () => { throw new Error("process trouble"); }, note: async () => {} });
  try {
    await m.v.proof.accept(m.cx);
    await until(() => m.v.proof.state === "ready" && m.v.proof.lock === "present", "lock shown after the stop");
    const r = render(m.v, m.cx);
    const path = `${m.home}/data/drover-accept/${KEY}.lock`;
    assert.ok(has(r, "Another Accept may be running, or one stopped without finishing"));
    assert.ok(has(r, path) && has(r, `rm -r '${path}'`));
    assert.ok(!r.texts.some((t) => /^Failed|read the card's notes and the PR before trying again/.test(t)), "not a generic failed run");
    assert.ok(has(r, "The Accept lock is kept"), "the result line says the lock is kept");
    assert.ok(r.ids.includes("proof-accept-off") && !r.ids.includes("proof-accept"));
  } finally { IO.useAcceptDeps(null); }
});
