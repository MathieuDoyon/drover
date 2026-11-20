// drover-lane: the lane log helper (log | report). Scratch dirs only; the helper is spawned with python3 -I.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = new URL("../drover-agents/bin/drover-lane", import.meta.url).pathname;
const SUITE = realpathSync(mkdtempSync(join(tmpdir(), "lane-suite-")));
after(() => {
  rmSync(SUITE, { recursive: true, force: true });
  assert.ok(!existsSync(SUITE), "the suite leaves no scratch root behind");
});
let n = 0;
const lanePath = () => join(SUITE, `lane-${++n}.md`);
const ENV = { PATH: process.env.PATH, HOME: SUITE, TZ: "America/Toronto" };
const run = (args, input = "") => {
  const p = spawnSync("python3", ["-I", BIN, ...args], { input, encoding: "utf8", env: ENV, timeout: 15000 });
  return { code: p.status, out: p.stdout, err: p.stderr };
};
const arun = (args) => new Promise((res) => {
  const p = spawn("python3", ["-I", BIN, ...args], { env: ENV });
  let err = "";
  p.stderr.on("data", (d) => { err += d; });
  p.on("close", (code) => res({ code, err }));
});
// A lane file from [time, who, EVENT, text] rows (times are HH:MM on one day, -05:00).
const T = (hm) => `2026-11-20T${hm}:00-05:00`;
const lane = (rows, extra = []) => {
  const p = lanePath();
  writeFileSync(p, [...rows.map(([hm, who, ev, text = ""]) => `@ ${T(hm)} | ${who} | ${ev} | ${text}`), ...extra].join("\n") + "\n");
  return p;
};
const report = (p) => {
  const r = run(["report", p, "--json"]);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};
const EVENTS = "START PLAN_READY PLAN_GO BUILD_START REVIEW_START REVIEW_END SEND_BACK READY_FOR_PR OWNER_WORD PR_OPEN PR_CLOSED CI_START CI_END MERGE INSTALLED PUBLIC_GREEN DONE BUSY IDLE".split(" ");

// ---- fixtures 1-4: table 1 ----

test("fixture 1: B5-like single PR, one send-back, two members", () => {
  const p = lane([
    ["09:00", "trail-boss", "START"],
    ["09:00", "trail-boss", "BUSY"],
    ["09:05", "trail-boss", "PLAN_READY"],
    ["09:10", "trail-boss", "PLAN_GO"],
    ["09:10", "wrangler", "BUSY"],
    ["09:30", "wrangler", "IDLE"],
    ["09:30", "inspector", "BUSY"],
    ["09:30", "trail-boss", "REVIEW_START"],
    ["09:40", "inspector", "IDLE"],
    ["09:40", "trail-boss", "REVIEW_END", "findings: 1 High"],
    ["09:40", "trail-boss", "SEND_BACK"],
    ["09:40", "wrangler", "BUSY"],
    ["09:50", "wrangler", "IDLE"],
    ["09:55", "trail-boss", "READY_FOR_PR"],
    ["10:15", "owner", "OWNER_WORD", "go"],
    ["10:20", "drover", "PR_OPEN", "#7"],
    ["10:20", "ci", "CI_START"],
    ["10:26", "ci", "CI_END", "green"],
    ["10:30", "drover", "MERGE"],
    ["10:35", "drover", "INSTALLED"],
    ["10:40", "drover", "PUBLIC_GREEN"],
    ["10:40", "drover", "DONE"],
  ]);
  const r = report(p);
  assert.deepEqual(r.card, { start_to_plan_go: 10, merge_to_done: 10, start_to_done: 100 });
  assert.equal(r.cycles.length, 1);
  const c = r.cycles[0];
  assert.deepEqual([c.build, c.owner, c.pr, c.end], [45, 20, 10, "merge"]);
  assert.deepEqual(c.ci, [{ start: T("10:20"), end: T("10:26"), minutes: 6, result: "green", run: null, ambiguous: false }]);
  assert.equal(c.ci_ambiguous, 0);
  assert.equal(r.members.wrangler.minutes, 30);
  assert.equal(r.members.inspector.minutes, 10);
  assert.equal(r.members["trail-boss"].open, T("09:00")); // never IDLE: open, not summed
  assert.equal(r.members["trail-boss"].minutes, 0);
  assert.equal(r.skipped, 0);
});

test("fixture 2: two PR cycles, a send-back inside build; no endpoint crosses a cycle", () => {
  const p = lane([
    ["09:00", "trail-boss", "START"],
    ["09:30", "trail-boss", "PLAN_GO"],
    ["09:55", "trail-boss", "BUILD_START"], // cycle 1 build starts at PLAN_GO, not here
    ["10:00", "trail-boss", "READY_FOR_PR"],
    ["10:02", "trail-boss", "SEND_BACK"],
    ["10:05", "trail-boss", "READY_FOR_PR"],
    ["10:06", "owner", "OWNER_WORD"],
    ["10:07", "drover", "PR_OPEN"],
    ["10:10", "drover", "MERGE"],
    ["11:00", "trail-boss", "READY_FOR_PR"],
    ["11:01", "owner", "OWNER_WORD"],
    ["11:02", "drover", "PR_OPEN"],
    ["11:08", "drover", "MERGE"],
  ]);
  const r = report(p);
  assert.equal(r.cycles.length, 2);
  assert.deepEqual([r.cycles[0].build, r.cycles[0].owner, r.cycles[0].pr], [35, 1, 3]);
  assert.deepEqual([r.cycles[1].build, r.cycles[1].owner, r.cycles[1].pr], [null, 1, 6]);
  assert.equal(r.card.merge_to_done, null, "no DONE");
  assert.equal(r.card.start_to_done, null);
});

test("fixture 2b: a later cycle uses its own BUILD_START", () => {
  const r = report(lane([
    ["09:00", "trail-boss", "PLAN_GO"],
    ["09:10", "trail-boss", "READY_FOR_PR"], ["09:11", "owner", "OWNER_WORD"], ["09:12", "drover", "PR_OPEN"], ["09:20", "drover", "MERGE"],
    ["10:00", "trail-boss", "BUILD_START"],
    ["10:30", "trail-boss", "READY_FOR_PR"], ["10:32", "owner", "OWNER_WORD"], ["10:33", "drover", "PR_OPEN"], ["10:40", "drover", "MERGE"],
  ]));
  assert.equal(r.cycles[1].build, 30);
  assert.equal(r.cycles[1].owner, 2);
});

test("fixture 3: first PR closed unmerged, second merged: nothing is borrowed", () => {
  const r = report(lane([
    ["09:00", "trail-boss", "START"],
    ["09:10", "trail-boss", "PLAN_GO"],
    ["09:40", "trail-boss", "READY_FOR_PR"],
    ["09:50", "drover", "PR_OPEN"],
    ["09:55", "drover", "PR_CLOSED", "wrong base"],
    ["10:30", "trail-boss", "READY_FOR_PR"],
    ["10:31", "owner", "OWNER_WORD"],
    ["10:32", "drover", "PR_OPEN"],
    ["10:40", "drover", "MERGE"],
  ]));
  assert.equal(r.cycles.length, 2);
  const [a, b] = r.cycles;
  assert.deepEqual([a.build, a.owner, a.pr, a.end], [30, null, null, "closed"]);
  assert.deepEqual([b.build, b.owner, b.pr, b.end], [null, 1, 8, "merge"]);
});

test("fixture 3b: a cycle with no end runs to the end of the log; its end cells are n/a", () => {
  const r = report(lane([
    ["09:00", "trail-boss", "PLAN_GO"], ["09:20", "trail-boss", "READY_FOR_PR"], ["09:25", "owner", "OWNER_WORD"], ["09:26", "drover", "PR_OPEN"],
    ["09:27", "ci", "CI_START"],
  ]));
  const c = r.cycles[0];
  assert.deepEqual([c.build, c.owner, c.pr, c.end], [20, 5, null, "open"]);
  assert.deepEqual(c.ci, [{ start: T("09:27"), end: null, minutes: null, result: null, run: null, ambiguous: false }]);
});

// ---- CI pairing: by run token when both ends carry one, else strictly serial; anything unclear is ambiguous, never guessed ----

const ci = (rows) => {
  const r = report(lane([["09:00", "trail-boss", "PLAN_GO"], ["09:10", "trail-boss", "READY_FOR_PR"], ["09:11", "drover", "PR_OPEN"], ...rows, ["10:00", "drover", "MERGE"]]));
  return r.cycles[0];
};
const span = (k) => [k.start?.slice(11, 16) ?? null, k.end?.slice(11, 16) ?? null, k.minutes, k.result, k.ambiguous];

test("CI: serial red then green rerun pair strictly in order", () => {
  const c = ci([["09:12", "ci", "CI_START"], ["09:17", "ci", "CI_END", "red"], ["09:20", "ci", "CI_START"], ["09:25", "ci", "CI_END", "green all checks"]]);
  assert.deepEqual(c.ci.map(span), [["09:12", "09:17", 5, "red", false], ["09:20", "09:25", 5, "green", false]]);
  assert.equal(c.ci_ambiguous, 0);
});

test("CI: overlapping tokenless attempts are ambiguous: no minutes, no result, counted and listed", () => {
  const c = ci([["09:12", "ci", "CI_START", "A"], ["09:13", "ci", "CI_START", "B"], ["09:14", "ci", "CI_END", "red"], ["09:18", "ci", "CI_END", "green"]]);
  assert.equal(c.ci.length, 4, "every event is listed");
  for (const k of c.ci) assert.deepEqual([k.minutes, k.result, k.ambiguous], [null, null, true]);
  assert.deepEqual(c.ci.map((k) => k.start?.slice(11, 16) ?? k.end.slice(11, 16)), ["09:12", "09:13", "09:14", "09:18"]);
  assert.equal(c.ci_ambiguous, 4);
});

test("CI: the same overlap with run tokens pairs each attempt with its own endpoint", () => {
  const c = ci([
    ["09:12", "ci", "CI_START", "run=A"], ["09:13", "ci", "CI_START", "run=B"],
    ["09:14", "ci", "CI_END", "run=A red"], ["09:18", "ci", "CI_END", "run=B green"],
  ]);
  assert.deepEqual(c.ci.map(span), [["09:12", "09:14", 2, "red", false], ["09:13", "09:18", 5, "green", false]]);
  assert.deepEqual(c.ci.map((k) => k.run), ["run=A", "run=B"]);
  assert.equal(c.ci_ambiguous, 0);
});

test("CI: an END with no open START, a token with no partner, a repeated token: ambiguous, nothing borrowed", () => {
  let c = ci([["09:12", "ci", "CI_END", "green"], ["09:13", "ci", "CI_START"], ["09:15", "ci", "CI_END", "red"]]);
  assert.deepEqual(c.ci.map(span), [[null, "09:12", null, null, true], ["09:13", "09:15", 2, "red", false]], "the orphan END does not close the later START");
  c = ci([["09:12", "ci", "CI_START", "run=A"], ["09:15", "ci", "CI_END", "run=B green"]]);
  assert.deepEqual(c.ci.map((k) => k.ambiguous), [false, true], "a lone START is open (not ambiguous); a lone token END is");
  assert.deepEqual(span(c.ci[0]), ["09:12", null, null, null, false]);
  c = ci([["09:12", "ci", "CI_START", "run=A"], ["09:13", "ci", "CI_END", "run=A red"], ["09:14", "ci", "CI_END", "run=A green"]]);
  assert.equal(c.ci.length, 3);
  assert.ok(c.ci.every((k) => k.ambiguous && k.minutes === null && k.result === null));
});

test("CI: tokenless and tokened events do not pair with each other", () => {
  const c = ci([["09:12", "ci", "CI_START", "run=A"], ["09:15", "ci", "CI_END", "green"]]);
  assert.deepEqual(c.ci.map(span), [["09:12", null, null, null, false], [null, "09:15", null, null, true]]);
});

test("the text report lists ambiguous CI events", () => {
  const p = lane([["09:00", "trail-boss", "PLAN_GO"], ["09:10", "trail-boss", "READY_FOR_PR"], ["09:12", "ci", "CI_START"], ["09:13", "ci", "CI_START"], ["09:14", "ci", "CI_END", "red"]]);
  assert.match(run(["report", p]).out, /ambiguous/);
});

test("fixture 4: the post-merge chain, n/a steps still count; DONE means the chain is complete", () => {
  const r = report(lane([
    ["09:00", "trail-boss", "START"],
    ["10:00", "drover", "MERGE"],
    ["10:05", "drover", "INSTALLED", "n/a"],
    ["10:15", "drover", "PUBLIC_GREEN"],
    ["10:15", "drover", "DONE"],
  ]));
  assert.equal(r.card.merge_to_done, 15);
  assert.equal(r.card.start_to_done, 75);
  assert.equal(report(lane([["10:00", "drover", "MERGE"], ["10:05", "drover", "INSTALLED"]])).card.merge_to_done, null);
});

test("an out-of-order pair (end before start) is n/a, never negative", () => {
  const r = report(lane([["10:00", "trail-boss", "START"], ["09:00", "trail-boss", "PLAN_GO"]]));
  assert.equal(r.card.start_to_plan_go, null);
});

test("the text report prints the table, the CI spans and per-member time", () => {
  const p = lane([
    ["09:00", "trail-boss", "START"], ["09:10", "trail-boss", "PLAN_GO"], ["09:10", "wrangler", "BUSY"], ["09:40", "wrangler", "IDLE"],
    ["09:45", "trail-boss", "READY_FOR_PR"], ["09:50", "owner", "OWNER_WORD"], ["09:51", "drover", "PR_OPEN"], ["10:00", "drover", "MERGE"],
  ]);
  const r = run(["report", p]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /start→go/);
  assert.match(r.out, /\b35\b/); // build
  assert.match(r.out, /n\/a/); // merge→done has no DONE
  assert.match(r.out, /wrangler\s+30/);
});

// ---- member spans ----

test("member spans: one per who; a second BUSY is a resume, an IDLE alone is an orphan, an open span is not summed", () => {
  const r = report(lane([
    ["09:00", "wrangler", "BUSY"],
    ["09:05", "inspector", "BUSY"],
    ["09:10", "wrangler", "BUSY"], // dup: the first start is kept
    ["09:20", "wrangler", "IDLE"], // 20
    ["09:25", "wrangler", "IDLE"], // orphan
    ["09:30", "inspector", "IDLE"], // 25
    ["09:40", "wrangler", "BUSY"], // open at the end
    ["09:50", "trail-boss", "BUSY"],
    ["09:50", "trail-boss", "IDLE"], // zero length
  ]));
  assert.deepEqual(r.members.wrangler, { minutes: 20, spans: 1, dup: 1, orphan: 1, open: T("09:40") });
  assert.deepEqual(r.members.inspector, { minutes: 25, spans: 1, dup: 0, orphan: 0, open: null });
  assert.deepEqual(r.members["trail-boss"], { minutes: 0, spans: 1, dup: 0, orphan: 0, open: null });
});

// ---- skipped lines ----

test("free-form lines and malformed @ lines are skipped and counted; manual -0500 lines still parse", () => {
  const p = lanePath();
  writeFileSync(p, [
    "Plan: the change is small", // free form
    "",
    `@ ${T("09:00")} | trail-boss | START | ok`,
    "@ 2026-13-40T99:00:00-05:00 | trail-boss | START | bad time",
    `@ ${T("09:01")} | cowboy | START | bad role`,
    `@ ${T("09:02")} | trail-boss | NOPE | bad event`,
    "@ no pipes at all",
    "@ 2026-11-20T09:10:00-0500 | trail-boss | PLAN_GO | manual style offset",
  ].join("\n") + "\n");
  const r = report(p);
  assert.equal(r.skipped, 5);
  assert.equal(r.card.start_to_plan_go, 10);
});

test("report refuses a missing file", () => {
  const r = run(["report", join(SUITE, "nope.md")]);
  assert.equal(r.code, 1);
});

// ---- log ----

const WELL_FORMED = /^@ \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d \| (\S+) \| ([A-Z_]+) \| (.*)\n$/;

test("log appends exactly one well-formed line with the helper's own time", () => {
  const p = lanePath();
  const before = Date.now();
  const r = run(["log", p, "PLAN_READY", "--who", "trail-boss", "plan", "written", "for", "review"]);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(p, "utf8");
  const m = WELL_FORMED.exec(text);
  assert.ok(m, text);
  assert.deepEqual([m[1], m[2], m[3]], ["trail-boss", "PLAN_READY", "plan written for review"]);
  const at = Date.parse(text.slice(2, 27));
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, "the time is now, to the second");
  assert.equal(statSync(p).mode & 0o077, 0, "a new lane file is private");
  run(["log", p, "BUSY", "--who", "wrangler"]); // --who may come before the text, text may be empty
  const lines = readFileSync(p, "utf8").split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], text.trimEnd(), "the first line is untouched");
  assert.match(lines[1], /\| wrangler \| BUSY \| $/);
});

test("log keeps text that starts with dashes after --", () => {
  const p = lanePath();
  assert.equal(run(["log", p, "SEND_BACK", "--who", "trail-boss", "--", "--fix", "this"]).code, 0);
  assert.match(readFileSync(p, "utf8"), /\| SEND_BACK \| --fix this\n$/);
});

test("log starts on a fresh line when the file lacks a final newline", () => {
  const p = lanePath();
  writeFileSync(p, "manual note without newline");
  assert.equal(run(["log", p, "START", "--who", "trail-boss"]).code, 0);
  const lines = readFileSync(p, "utf8").split("\n");
  assert.equal(lines[0], "manual note without newline");
  assert.match(lines[1], /\| START \|/);
});

test("the log only appends: earlier bytes are never rewritten", () => {
  const p = lane([["09:00", "trail-boss", "START"]], ["free text"]);
  const first = readFileSync(p, "utf8");
  assert.equal(run(["log", p, "PLAN_GO", "--who", "trail-boss"]).code, 0);
  assert.ok(readFileSync(p, "utf8").startsWith(first));
});

test("concurrent appends both land, each as one whole line", async () => {
  const p = lanePath();
  const jobs = Array.from({ length: 12 }, (_, i) => arun(["log", p, i % 2 ? "BUSY" : "IDLE", "--who", i % 2 ? "wrangler" : "inspector", `n${i}`]));
  for (const r of await Promise.all(jobs)) assert.equal(r.code, 0, r.err);
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 12);
  for (const l of lines) assert.match(l + "\n", WELL_FORMED);
  assert.deepEqual(lines.map((l) => l.split(" | ")[3]).sort(), Array.from({ length: 12 }, (_, i) => `n${i}`).sort());
});

test("log refusals change nothing", () => {
  const p = lane([["09:00", "trail-boss", "START"]]);
  const before = readFileSync(p, "utf8");
  const bad = [
    ["log", p, "NOPE", "--who", "trail-boss"], // unknown event
    ["log", p, "start", "--who", "trail-boss"], // case matters
    ["log", p, "START"], // --who is required
    ["log", p, "START", "--who", "cowboy"], // unknown role
    ["log", p, "START", "--who"], // role missing
    ["log", p, "START", "--who", "trail-boss", "a | b"], // pipe
    ["log", p, "START", "--who", "trail-boss", "line1\nline2"], // newline
    ["log", p, "START", "--who", "trail-boss", "a\rb"], // carriage return
    ["log", p, "START", "--who", "trail-boss", "x".repeat(501)], // too long
    ["log", "relative-lane.md", "START", "--who", "trail-boss"], // path must be absolute
    ["log", p, "START", "--who", "trail-boss", "--nope"], // unknown flag
    ["log", p], // event missing
    ["frobnicate", p], // unknown verb
    [],
  ];
  for (const a of bad) {
    const r = run(a);
    assert.equal(r.code, 1, JSON.stringify(a));
    assert.ok(r.err.length > 0, JSON.stringify(a));
  }
  assert.equal(readFileSync(p, "utf8"), before);
  assert.ok(!existsSync(join(SUITE, "relative-lane.md")));
});

test("log refuses a symlink and a missing directory; it never creates directories", () => {
  const target = lane([["09:00", "trail-boss", "START"]]);
  const link = join(SUITE, "link.md");
  symlinkSync(target, link);
  const before = readFileSync(target, "utf8");
  assert.equal(run(["log", link, "IDLE", "--who", "wrangler"]).code, 1);
  assert.equal(readFileSync(target, "utf8"), before);
  const deep = join(SUITE, "no-such-dir", "lane.md");
  assert.equal(run(["log", deep, "IDLE", "--who", "wrangler"]).code, 1);
  assert.ok(!existsSync(join(SUITE, "no-such-dir")));
});

test("every accepted event is logged by the helper and read back by report", () => {
  const p = lanePath();
  for (const e of EVENTS) assert.equal(run(["log", p, e, "--who", "drover", "x"]).code, 0, e);
  assert.equal(report(p).skipped, 0);
});

// ---- souls drift guard ----

const soul = (name) => readFileSync(new URL(`../drover-agents/souls/${name}.md`, import.meta.url), "utf8");

test("_herd.md names every event the helper accepts, and the roles", () => {
  const h = soul("_herd");
  const section = h.slice(h.indexOf("Lane log timing"));
  assert.ok(section.length > 0 && h.includes("Lane log timing"), "section present");
  for (const e of EVENTS) assert.ok(section.includes(`\`${e}\``), e);
  for (const w of ["trail-boss", "wrangler", "inspector", "drover", "owner", "ci"]) assert.ok(section.includes(`\`${w}\``), w);
  assert.match(section, /lane-<T-id>\.md/);
});

test("trail-boss, wrangler and inspector log through drover-lane", () => {
  for (const s of ["trail-boss", "wrangler", "inspector"]) assert.match(soul(s), /drover-lane/, s);
  assert.doesNotMatch(soul("trail-boss"), /lane\.md\b/, "the shared lane.md is replaced by lane-<T-id>.md");
});

test("a person-started drive has a chain-event writer: the Trail Boss, with --who owner for the owner's word", () => {
  const h = soul("_herd");
  const section = h.slice(h.indexOf("Lane log timing"));
  assert.match(section, /no coordinator/);
  assert.match(section, /`--who owner`/);
  const t = soul("trail-boss");
  assert.match(t, /no coordinator/);
  assert.match(t, /--who owner/);
  assert.match(t, /--who trail-boss/);
  assert.match(section, /run=<id>/, "the CI run token is documented");
});

test("the helper's accepted events match the list in its header", () => {
  const head = readFileSync(BIN, "utf8").split("\n").slice(0, 30).join("\n");
  for (const e of EVENTS) assert.ok(head.includes(e), e);
});
