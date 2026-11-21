import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, lineOf, activeFor, lineLabel, LINE_STALE_MS, LINE_MAX } from "./runline.js";

const FAKE_GH = String.fromCharCode(103, 104, 112, 95) + "a1B2".repeat(6); // built from char codes: no secret-shaped literal in the file
const ROOT = "/" + ["Us", "ers"].join("");
const FAKE_ASSIGN = "MY_API" + "_KEY=" + "zzzz";

test("validate: 1..40 code points, boundaries", () => {
  assert.equal(LINE_MAX, 40);
  assert.deepEqual(validate("a".repeat(40)), { ok: true, text: "a".repeat(40), progress: null });
  assert.equal(validate("a".repeat(41)).ok, false);
  assert.match(validate("a".repeat(41)).error, /40/);
  assert.equal(validate("a").ok, true);
});

test("validate: counts code points, not UTF-16 units", () => {
  assert.equal(validate("😀".repeat(40)).ok, true);
  assert.equal(validate("😀".repeat(41)).ok, false);
});

test("validate: empty, blank and non-string are errors", () => {
  for (const v of ["", "   ", "\t ", undefined, null, 5, {}]) assert.equal(validate(v).ok, false, String(v));
});

test("validate: trims and collapses inner whitespace", () => {
  assert.equal(validate("  reading   the  code  ").text, "reading the code");
  // the length is measured after the collapse
  assert.equal(validate("a" + " ".repeat(60) + "b").text, "a b");
});

test("validate: newline and control characters are rejected before the whitespace collapse", () => {
  for (const bad of ["a\nb", "a\r\nb", "a\tb", "a\u0000b", "a\u001bb", "a\u007fb", "a\u0085b", "\nabc"]) {
    const r = validate(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /control|newline/i);
  }
});

test("validate: progress is an optional integer 0..100", () => {
  assert.equal(validate("x", 0).progress, 0);
  assert.equal(validate("x", 100).progress, 100);
  assert.equal(validate("x", 40).progress, 40);
  for (const p of [undefined, null]) assert.equal(validate("x", p).progress, null);
  for (const p of [-1, 101, 1.5, "x", "", NaN, Infinity, {}, []]) assert.equal(validate("x", p).ok, false, String(p));
  assert.match(validate("x", 150).error, /progress/);
});

test("validate: a numeric string progress from the CLI is accepted when it is a whole number", () => {
  assert.equal(validate("x", "20").progress, 20);
  assert.equal(validate("x", "2.5").ok, false);
  assert.equal(validate("x", " 20 ").ok, false);
});

test("validate: a secret-shaped text is refused with the rule name and never echoes the value", () => {
  for (const [text, rule] of [[FAKE_GH, "github-token"], [FAKE_ASSIGN, "secret-assignment"], ["see " + FAKE_GH, "github-token"]]) {
    const r = validate(text);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes(rule), r.error);
    assert.ok(!r.error.includes(FAKE_GH) && !r.error.includes("zzzz"), "value echoed: " + r.error);
  }
});

test("validate: a home folder path is refused without echoing it", () => {
  for (const text of [ROOT + "/x/y", "in /home/x/repo"]) {
    const r = validate(text);
    assert.equal(r.ok, false);
    assert.match(r.error, /home-path/);
    assert.ok(!r.error.includes("/x/"));
  }
});

test("validate: an over-long secret reports the length, not the secret", () => {
  const r = validate(FAKE_GH + "x".repeat(40));
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes(FAKE_GH));
});

const NOW = 1_000_000_000;
const runWith = (over = {}) => ({ id: "R1", task: "T-1", line: { text: "reading", progress: 20, at: NOW - 5 * 60000, by: "Wrangler" }, ...over });

test("lineOf: the view of a live line", () => {
  assert.deepEqual(lineOf(runWith(), "working", NOW), { text: "reading", progress: 20, ageMin: 5, stale: false });
});

test("lineOf: 10 minutes is a named constant; 9m59s is fresh, 10m00s is stale", () => {
  assert.equal(LINE_STALE_MS, 10 * 60000);
  assert.equal(lineOf(runWith({ line: { text: "a", at: NOW - (LINE_STALE_MS - 1000) } }), "working", NOW).stale, false);
  assert.equal(lineOf(runWith({ line: { text: "a", at: NOW - LINE_STALE_MS } }), "working", NOW).stale, true);
  assert.equal(lineOf(runWith({ line: { text: "a", at: NOW - (LINE_STALE_MS - 1000) } }), "working", NOW).ageMin, 9);
});

test("lineOf: under one minute is ageMin 0; a clock behind the line never goes negative", () => {
  assert.equal(lineOf(runWith({ line: { text: "a", at: NOW - 59000 } }), "working", NOW).ageMin, 0);
  const v = lineOf(runWith({ line: { text: "a", at: NOW + 5000 } }), "working", NOW);
  assert.equal(v.ageMin, 0);
  assert.equal(v.stale, false);
});

test("lineOf: no progress is null", () => {
  assert.equal(lineOf(runWith({ line: { text: "a", at: NOW } }), "working", NOW).progress, null);
});

test("lineOf: null without a line, with a bad line, on a stamped-ended run, or when the live status is ended", () => {
  assert.equal(lineOf({ id: "R1" }, "working", NOW), null);
  assert.equal(lineOf(null, "working", NOW), null);
  assert.equal(lineOf(runWith({ line: { text: "", at: NOW } }), "working", NOW), null);
  assert.equal(lineOf(runWith({ line: { text: "a" } }), "working", NOW), null);
  assert.equal(lineOf(runWith({ ended: NOW - 1 }), "working", NOW), null);
  assert.equal(lineOf(runWith(), "ended", NOW), null, "live-only end: the record is unchanged but the terminals are gone");
  for (const s of ["working", "blocked", "stopped"]) assert.notEqual(lineOf(runWith(), s, NOW), null, s);
});

const term = (address, extra = {}) => ({ address, agent: "wrangler", ...extra });
const live = (o) => new Map(Object.entries(o).map(([k, v]) => [k, { status: v }]));

test("activeFor: the terminal of an active run of the task", () => {
  const runs = [{ id: "R1", task: "T-1", started: 1, terminals: [term("t1", { started: 1 }), term("t2", { started: 1 })] }];
  const r = activeFor(runs, "T-1", "t2", live({ t2: "working" }), new Set(["t1", "t2"]));
  assert.equal(r.run.id, "R1");
  assert.equal(r.terminal.address, "t2");
});

test("activeFor: null for another task, another terminal, or no runs", () => {
  const runs = [{ id: "R1", task: "T-1", terminals: [term("t1")] }];
  const alive = new Set(["t1"]);
  assert.equal(activeFor(runs, "T-2", "t1", new Map(), alive), null);
  assert.equal(activeFor(runs, "T-1", "t9", new Map(), alive), null);
  assert.equal(activeFor([], "T-1", "t1", new Map(), alive), null);
  assert.equal(activeFor(undefined, "T-1", "t1", new Map(), alive), null);
  assert.equal(activeFor(runs, "T-1", undefined, new Map(), alive), null);
});

test("activeFor: a stamped-ended run is not active", () => {
  const runs = [{ id: "R1", task: "T-1", ended: 5, terminals: [term("t1")] }];
  assert.equal(activeFor(runs, "T-1", "t1", new Map(), new Set(["t1"])), null);
});

test("activeFor: live-only end (terminals gone, record unchanged) and a legacy record without started are not active", () => {
  const legacy = [{ id: "R1", task: "T-1", terminals: [term("t1")] }]; // no started, never stamped
  assert.equal(activeFor(legacy, "T-1", "t1", new Map(), new Set()), null);
  const modern = [{ id: "R2", task: "T-1", started: 1, terminals: [term("t1", { started: 1 })] }];
  assert.equal(activeFor(modern, "T-1", "t1", new Map(), new Set()), null);
  // the same legacy record with its terminal alive is active
  assert.equal(activeFor(legacy, "T-1", "t1", new Map(), new Set(["t1"])).run.id, "R1");
});

test("activeFor: when two runs share the task, the one whose terminal posts wins; an ended earlier run is skipped", () => {
  const runs = [
    { id: "new", task: "T-1", terminals: [term("t5")] },
    { id: "old", task: "T-1", ended: 3, terminals: [term("t1")] },
  ];
  const alive = new Set(["t1", "t5"]);
  assert.equal(activeFor(runs, "T-1", "t5", new Map(), alive).run.id, "new");
  assert.equal(activeFor(runs, "T-1", "t1", new Map(), alive), null);
});

test("activeFor: unknown host (nothing alive, no live agents) follows runStatus: ended, not eligible", () => {
  const runs = [{ id: "R1", task: "T-1", started: 1, terminals: [term("t1", { started: 1 })] }];
  assert.equal(activeFor(runs, "T-1", "t1", new Map(), new Set()), null);
});

test("lineLabel: text, percent when there is one, elapsed minutes ('<1m' under a minute)", () => {
  assert.equal(lineLabel({ text: "reading", progress: 40, ageMin: 3, stale: false }), "reading · 40% · 3m");
  assert.equal(lineLabel({ text: "reading", progress: null, ageMin: 0, stale: false }), "reading · <1m");
  assert.equal(lineLabel({ text: "x", progress: 0, ageMin: 12, stale: true }), "x · 0% · 12m");
  assert.equal(lineLabel(null), "");
});
