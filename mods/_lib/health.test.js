// The machine health poller (T-MWO2HEHGIEC, A4 job 2): pure, runner/list/clock injected, no herdr import, no timers of its own.
// Written before the code. Nothing here sleeps: a fake clock, deferred promises, and until() for the async answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { until } = await import(new URL("../_test/stubs/until.js", import.meta.url).href);
const H = () => import("./health.js");
const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60000, SEC = 1000;

const GOOD = { v: 1, os: "linux", cores: 4, load: { one: 1, five: 0.8, fifteen: 0.6 }, loadPerCore: 0.25, mem: { totalMb: 16000, usedMb: 8000, pct: 50 }, disks: { home: { totalMb: 100000, freeMb: 60000, pct: 40 }, tmp: { totalMb: 50000, freeMb: 45000, pct: 10 } } };
const out = (o = GOOD, extra = {}) => ({ code: 0, stdout: JSON.stringify({ ...o, ...extra }), stderr: "" });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const machines = (...names) => names.map((name) => ({ name, state: "connected" }));

// A harness: fake clock T, a list that returns `L` (or a deferred), an exec that answers `answer(argv, name)` (or a deferred).
async function mk({ names = ["box1"], on = true, screen = true, answer, listAnswer } = {}) {
  const { createHealth, healthArgv } = await H();
  const s = { T: 0, on, screen, L: machines(...names), execs: [], lists: 0, live: new Map(), maxLive: new Map(), answer: answer ?? (() => out()), listAnswer };
  const exec = (argv) => {
    const name = argv[2];
    s.execs.push({ argv, name, at: s.T });
    s.live.set(name, (s.live.get(name) ?? 0) + 1);
    s.maxLive.set(name, Math.max(s.maxLive.get(name) ?? 0, s.live.get(name)));
    const r = s.answer(argv, name);
    return Promise.resolve(r).finally(() => s.live.set(name, s.live.get(name) - 1));
  };
  const list = () => { s.lists++; return s.listAnswer ? s.listAnswer() : Promise.resolve(s.L); };
  s.h = createHealth({ list, exec, now: () => s.T, enabled: () => s.on, active: () => s.screen });
  s.healthArgv = healthArgv;
  s.at = (t) => { s.T = t; };
  // a tick, then let every microtask of the fake answers run (setImmediate is a macrotask): the driver of a clock loop, not a wait for a result
  s.tick = async () => { s.h.tick(); await new Promise((r) => setImmediate(r)); };
  s.row = (name = "box1") => s.h.view().machines.find((m) => m.name === name);
  s.count = (name) => s.execs.filter((e) => e.name === name).length;
  // tick, then wait until the discovery answer has been taken (a first tick only starts the list)
  s.boot = async () => { await s.tick(); await until(() => s.h.view().listState === "ok", "list answered"); await s.tick(); };
  return s;
}

test("the argv for hc is exactly exec --on <m> --timeout 20 -- python3 -c <the script text>; the text is the file, byte for byte; no machine text in it", async () => {
  const { healthArgv, HEALTH_PY } = await H();
  assert.deepEqual(healthArgv("box1"), ["exec", "--on", "box1", "--timeout", "20", "--", "python3", "-c", HEALTH_PY]);
  assert.equal(HEALTH_PY, readFileSync(join(HERE, "../drover-tasks/bin/drover-health.py"), "utf8"));
  assert.ok(!HEALTH_PY.includes("box1"));
});

test("setting off: many ticks over an hour make 0 exec calls; the list call still happens; every row is `off` with no numbers", async () => {
  const s = await mk({ on: false, names: ["box1", "box2"] });
  for (let t = 0; t <= 60 * MIN; t += SEC) { s.at(t); await s.tick(); if (t === 0) await until(() => s.h.view().listState === "ok", "list"); }
  assert.equal(s.execs.length, 0);
  assert.ok(s.lists >= 100, `list called ${s.lists} times`);
  const v = s.h.view();
  assert.deepEqual(v.machines.map((m) => [m.name, m.state, m.numbers]), [["box1", "off", null], ["box2", "off", null]]);
});

test("the poll path only ever runs the health argv; no write, install or other call exists (exempt from the sync hold, nothing to hold)", async () => {
  const s = await mk({ names: ["box1", "box2"] });
  await s.boot();
  await until(() => s.execs.length === 2, "two reads");
  for (const e of s.execs) assert.deepEqual(e.argv, s.healthArgv(e.name));
  assert.equal(Object.keys(await H()).filter((k) => /write|install|hold/i.test(k)).length, 0);
});

test("hung runner: tick() and view() return at once; past the deadline the read is a `timeout` failure; the late answer is dropped", async () => {
  const d = deferred();
  const s = await mk({ answer: () => d.promise });
  await s.tick(); await until(() => s.h.view().listState === "ok", "list");
  const t0 = s.h.tick(); assert.ok(!(t0 instanceof Promise), "tick returns at once");
  assert.equal(s.count("box1"), 1);
  const v = s.h.view(); assert.ok(!(v instanceof Promise));
  assert.equal(s.row().state, "never");
  s.at(24 * SEC); await s.tick();
  assert.equal(s.row().state, "never", "still inside the deadline");
  s.at(26 * SEC); await s.tick();
  assert.equal(s.row().state, "failed");
  assert.equal(s.row().error, "timeout");
  assert.equal(s.row().numbers, null, "no numbers were ever read: no guess");
  d.resolve(out()); // the late answer
  await until(() => s.live.get("box1") === 0, "exec settled");
  assert.equal(s.row().state, "failed", "the late answer was dropped");
  assert.equal(s.row().numbers, null);
});

test("an abandoned exec still occupies the machine until it settles: no second exec while it is unresolved, one after", async () => {
  const d = deferred();
  let first = true;
  const s = await mk({ answer: () => { if (first) { first = false; return d.promise; } return out(); } });
  await s.tick(); await until(() => s.h.view().listState === "ok", "list");
  await s.tick(); s.at(26 * SEC); await s.tick(); // abandoned
  for (let t = 30 * SEC; t <= 30 * MIN; t += 10 * SEC) { s.at(t); await s.tick(); }
  assert.equal(s.count("box1"), 1, "never a second exec while the first is unresolved");
  d.resolve(out());
  await until(() => s.live.get("box1") === 0, "settled");
  s.at(31 * MIN); await s.tick();
  assert.equal(s.count("box1"), 2);
});

test("failed poll after a good one keeps the last numbers marked failed with their age; a later good read replaces them; a first-ever failure has no numbers", async () => {
  let mode = "good";
  const s = await mk({ answer: () => (mode === "good" ? out() : { code: 1, stdout: "", stderr: "boom" }) });
  await s.boot();
  await until(() => s.row().state === "fresh", "good read");
  assert.equal(s.row().numbers.load.one, 1);
  mode = "bad";
  s.at(5 * MIN); await s.tick();
  await until(() => s.row().state === "failed", "failed");
  assert.equal(s.row().error, "exit");
  assert.equal(s.row().numbers.mem.pct, 50, "last good numbers kept");
  assert.equal(s.row().ageMs, 5 * MIN, "age of the numbers");
  s.at(14 * MIN); await s.tick();
  assert.equal(s.count("box1"), 2, "a failed machine is not retried before 10 min");
  s.at(15 * MIN); await s.tick();
  assert.equal(s.count("box1"), 3);
  await until(() => s.live.get("box1") === 0, "settled");
  mode = "good";
  s.at(25 * MIN); await s.tick(); await until(() => s.h.view().listState === "ok", "list"); await s.tick(); // a jump: the list is refreshed first
  await until(() => s.row().state === "fresh", "recovered");
  assert.equal(s.row().ageMs, 0);
  const s2 = await mk({ answer: () => ({ code: 1, stdout: "", stderr: "x" }) });
  await s2.boot();
  await until(() => s2.row().state === "failed", "first-ever failure");
  assert.equal(s2.row().numbers, null);
});

test("4 machines over [0, 30 min): one exec each per 5 min (6 at most), never two in flight for one; a failing machine is retried after 10 min, not 5", async () => {
  const s = await mk({ names: ["box1", "box2", "box3", "box4"], answer: (argv) => (argv[2] === "box3" ? { code: 1, stdout: "", stderr: "" } : out()) });
  for (let t = 0; t < 30 * MIN; t += 5 * SEC) { s.at(t); await s.tick(); await until(() => [...s.live.values()].every((n) => n === 0), "reads settled"); }
  for (const n of ["box1", "box2", "box4"]) assert.equal(s.count(n), 6, n);
  assert.equal(s.count("box3"), 3, "0, 10, 20 min");
  assert.deepEqual(s.execs.filter((e) => e.name === "box3").map((e) => Math.floor(e.at / MIN)), [0, 10, 20], "the first read waits one tick for the list");
  for (const [n, k] of s.maxLive) assert.equal(k, 1, `${n} had ${k} in flight`);
});

test("offline machine (link not connected): no exec, last numbers kept and marked", async () => {
  const s = await mk();
  await s.boot();
  await until(() => s.row().state === "fresh", "read");
  s.L = [{ name: "box1", state: "disconnected" }];
  s.at(31 * SEC); await s.tick(); await until(() => s.row().link === "disconnected", "list refreshed");
  for (let t = 32 * SEC; t < 20 * MIN; t += 15 * SEC) { s.at(t); await s.tick(); }
  assert.equal(s.count("box1"), 1, "no exec to an offline machine");
  assert.equal(s.row().state, "offline");
  assert.equal(s.row().numbers.mem.pct, 50);
});

const BAD = {
  "non-JSON": [{ code: 0, stdout: "not json at all", stderr: "" }, "bad-json"],
  "empty": [{ code: 0, stdout: "", stderr: "" }, "bad-json"],
  "an array": [{ code: 0, stdout: "[1,2]", stderr: "" }, "bad-json"],
  "wrong shape": [out({ v: 1, hello: "x" }), "bad-shape"],
  "wrong version": [out({ ...GOOD, v: 2 }), "bad-shape"],
  "negative number": [out({ ...GOOD, load: { one: -1, five: 0, fifteen: 0 } }), "bad-shape"],
  "absurd number": [{ code: 0, stdout: JSON.stringify(GOOD).replace('"pct":50', '"pct":1e99'), stderr: "" }, "bad-shape"],
  "a string where a number goes": [out({ ...GOOD, cores: "4" }), "bad-shape"],
  "1 MB stdout": [{ code: 0, stdout: " ".repeat(1024 * 1024) + JSON.stringify(GOOD), stderr: "" }, "bad-json"],
  "exit 1": [{ code: 1, stdout: "", stderr: "SECRET-STDERR-TEXT host.example /home/x" }, "exit"],
  "python3 missing (127)": [{ code: 127, stdout: "", stderr: "" }, "no-python"],
  "python3 missing (text)": [{ code: 1, stdout: "", stderr: "sh: python3: command not found" }, "no-python"],
  "mem null (partial)": [out({ ...GOOD, mem: null }), "partial"],
  "load null (partial)": [out({ ...GOOD, load: null, loadPerCore: null }), "partial"],
  "load.one null (partial)": [out({ ...GOOD, load: { ...GOOD.load, one: null } }), "partial"],
  "load.fifteen null (partial)": [out({ ...GOOD, load: { ...GOOD.load, fifteen: null } }), "partial"],
  "loadPerCore null (partial)": [out({ ...GOOD, loadPerCore: null }), "partial"],
  "mem.pct null (partial)": [out({ ...GOOD, mem: { ...GOOD.mem, pct: null } }), "partial"],
  "mem all leaves null (partial)": [out({ ...GOOD, mem: { totalMb: null, usedMb: null, pct: null } }), "partial"],
  "both disks with null leaves (partial)": [out({ ...GOOD, disks: { home: { totalMb: null, freeMb: null, pct: null }, tmp: { ...GOOD.disks.tmp, pct: null } } }), "partial"],
  "both disks null (partial)": [out({ ...GOOD, disks: { home: null, tmp: null } }), "partial"],
};
for (const [label, [res, code]] of Object.entries(BAD)) {
  test(`bad output: ${label} -> a failed read with the fixed code ${code}; no machine text reaches the view`, async () => {
    const s = await mk({ answer: () => res });
    await s.boot();
    await until(() => s.row().state === "failed", "failed");
    assert.equal(s.row().error, code);
    assert.equal(s.row().numbers, null);
    const all = JSON.stringify(s.h.view());
    assert.doesNotMatch(all, /SECRET-STDERR|host\.example|\/home\/|not json/);
    assert.ok(typeof s.row().errorText === "string" && s.row().errorText.length < 80);
  });
}

test("partial after a good read: the previous good sample stays, marked failed; a single disk null is accepted", async () => {
  let r = out();
  const s = await mk({ answer: () => r });
  await s.boot();
  await until(() => s.row().state === "fresh", "good");
  r = out({ ...GOOD, mem: null });
  s.at(5 * MIN); await s.tick();
  await until(() => s.row().state === "failed", "partial");
  assert.equal(s.row().error, "partial");
  assert.equal(s.row().numbers.mem.pct, 50);
  await until(() => s.live.get("box1") === 0, "settled");
  r = out({ ...GOOD, disks: { home: GOOD.disks.home, tmp: null } });
  s.at(15 * MIN); await s.tick(); await s.tick();
  await until(() => s.row().state === "fresh", "one disk null is fine");
  assert.equal(s.row().numbers.disks.tmp, null);
});

test("the cached object is built from the fixed keys: extra keys, a hostname and nested extras never reach the view", async () => {
  const dirty = { ...GOOD, hostname: "some-host", user: "someone", load: { ...GOOD.load, extra: 9 }, mem: { ...GOOD.mem, path: "/x" }, disks: { ...GOOD.disks, other: GOOD.disks.home, home: { ...GOOD.disks.home, mount: "/m" } } };
  const s = await mk({ answer: () => out(dirty) });
  await s.boot();
  await until(() => s.row().state === "fresh", "read");
  assert.deepEqual(s.row().numbers, GOOD);
  assert.doesNotMatch(JSON.stringify(s.h.view()), /some-host|someone|"extra"|"path"|"mount"|"other"/);
  s.row().numbers.mem.pct = 1; // a caller mutating its copy changes nothing
  assert.equal(s.row().numbers.mem.pct, 50);
});

test("fencing: a read in flight across switch-off, screen disable or removal/re-add is dropped, and NO second exec starts until it settles", async () => {
  for (const how of ["off-on", "screen", "remove-readd"]) {
    const d = deferred();
    let calls = 0;
    const s = await mk({ answer: () => (++calls === 1 ? d.promise : out()) });
    await s.boot();
    assert.equal(s.count("box1"), 1, how);
    if (how === "off-on") { s.on = false; s.at(1 * SEC); await s.tick(); s.on = true; }
    if (how === "screen") { s.screen = false; s.at(1 * SEC); await s.tick(); s.screen = true; }
    if (how === "remove-readd") {
      s.L = []; s.at(31 * SEC); await s.tick(); await until(() => s.h.view().machines.length === 0, "removed");
      s.L = machines("box1"); s.at(62 * SEC); await s.tick(); await until(() => s.h.view().machines.length === 1, "re-added");
    }
    for (let t = 63 * SEC; t < 12 * MIN; t += 20 * SEC) { s.at(t); await s.tick(); }
    assert.equal(s.count("box1"), 1, `${how}: still one exec while the first is unresolved`);
    d.resolve(out());
    await until(() => s.live.get("box1") === 0, `${how}: settled`);
    assert.notEqual(s.row().state, "fresh", `${how}: the old answer was dropped`);
    s.at(13 * MIN); await s.tick();
    assert.equal(s.count("box1"), 2, `${how}: exactly one after it settled`);
    assert.equal(s.maxLive.get("box1"), 1, how);
  }
});

test("discovery: a deferred list does not block view() or tick(); at its 10 s deadline it is abandoned and the late answer dropped; rows stay marked unknown", async () => {
  const s = await mk();
  await s.boot();
  await until(() => s.row().state === "fresh", "read");
  const d = deferred();
  s.listAnswer = () => d.promise;
  s.at(31 * SEC); await s.tick();
  const lists = s.lists;
  s.at(35 * SEC); await s.tick(); assert.equal(s.lists, lists, "one list in flight at a time");
  assert.equal(s.row().state, "fresh", "rows are served while the list hangs");
  s.at(42 * SEC); await s.tick();
  assert.equal(s.h.view().listState, "unknown");
  assert.equal(s.h.view().machines.length, 1, "last known list kept");
  d.resolve([]); // late: must not empty the table
  await until(() => s.h.view().listState === "unknown", "still unknown");
  assert.equal(s.h.view().machines.length, 1);
  s.at(101 * SEC); await s.tick(); assert.equal(s.lists, lists, "not before 60 s after the failure");
  s.at(102 * SEC); await s.tick(); // 60 s after the failure: retried
  assert.equal(s.lists, lists + 1);
});

test("discovery retries: 30 s after a good list, 60 s after a failed one", async () => {
  const s = await mk();
  await s.tick(); await until(() => s.h.view().listState === "ok", "list 1");
  s.at(29 * SEC); await s.tick(); assert.equal(s.lists, 1);
  s.at(30 * SEC); await s.tick(); assert.equal(s.lists, 2);
  await until(() => s.h.view().listState === "ok", "list 2");
  s.listAnswer = () => Promise.reject(new Error("x"));
  s.at(60 * SEC); await s.tick(); assert.equal(s.lists, 3);
  await until(() => s.h.view().listState === "unknown", "failed");
  s.at(119 * SEC); await s.tick(); assert.equal(s.lists, 3);
  s.at(120 * SEC); await s.tick(); assert.equal(s.lists, 4);
});

test("a list older than 5 min stops polling (no exec to a machine from a stale list); rows still shown", async () => {
  const s = await mk();
  await s.boot();
  await until(() => s.row().state === "fresh", "read");
  s.listAnswer = () => Promise.reject(new Error("x"));
  for (let t = 30 * SEC; t <= 5 * MIN + 31 * SEC; t += 30 * SEC) { s.at(t); await s.tick(); }
  await until(() => s.h.view().listState === "unknown", "unknown");
  const n = s.count("box1");
  s.at(5 * MIN + 31 * SEC); await s.tick(); // good-read interval is due, but the list is stale
  assert.equal(s.count("box1"), n, "no exec off a stale list");
  assert.equal(s.h.view().machines.length, 1);
});

test("a machine name that is not valid is never exec'd or shown; validMachine runs before any exec", async () => {
  const s = await mk({ names: ["box1", "bad name; rm -rf", "-x", "a".repeat(70)] });
  await s.boot();
  await until(() => s.count("box1") === 1, "valid one read");
  assert.deepEqual(s.h.view().machines.map((m) => m.name), ["box1"]);
  assert.equal(s.execs.length, 1);
});

test("retry(name) makes a failed machine due now, still never two in flight", async () => {
  let ok = false;
  const s = await mk({ answer: () => (ok ? out() : { code: 1, stdout: "", stderr: "" }) });
  await s.boot();
  await until(() => s.row().state === "failed", "failed");
  ok = true;
  s.at(1 * MIN); s.h.retry("box1"); await s.tick();
  assert.equal(s.count("box1"), 2);
  await until(() => s.row().state === "fresh", "fresh");
});

test("a runner that throws synchronously is a failed read (exit), not a crash", async () => {
  const s = await mk({ answer: () => { throw new Error("hc missing"); } });
  await s.boot();
  await until(() => s.row().state === "failed", "failed");
  assert.equal(s.row().error, "exit");
});

test("a disk object with a null leaf is an unknown disk (null), the other disk keeps the read good", async () => {
  const s = await mk({ answer: () => out({ ...GOOD, disks: { home: GOOD.disks.home, tmp: { totalMb: 1, freeMb: null, pct: 3 } } }) });
  await s.boot();
  await until(() => s.row().state === "fresh", "read");
  assert.equal(s.row().numbers.disks.tmp, null);
  assert.deepEqual(s.row().numbers.disks.home, GOOD.disks.home);
});

test("rowLines never throws and never prints a guessed number for an unknown leaf (shown as '-')", async () => {
  const { rowLines } = await H();
  const nul = { ...GOOD, load: { one: null, five: null, fifteen: null }, loadPerCore: null, mem: { totalMb: null, usedMb: null, pct: null }, disks: { home: { totalMb: null, freeMb: null, pct: null }, tmp: null } };
  for (const state of ["fresh", "failed", "offline", "stale"]) {
    const r = rowLines({ name: "box1", link: "connected", state, numbers: nul, ageMs: 3 * MIN, error: state === "failed" ? "exit" : null });
    assert.ok(r.lines.length >= 1, state);
    assert.doesNotMatch(r.lines.join(" | "), /NaN|undefined|null|\b0%|load 0/, `${state}: ${r.lines.join(" | ")}`);
    assert.match(r.lines[0], /load - · mem - · disk/, state);
  }
  const half = rowLines({ name: "box1", link: "connected", state: "fresh", numbers: { ...GOOD, loadPerCore: null }, ageMs: 0, error: null });
  assert.match(half.lines[0], /^load 1\.0 · mem 50%/, "no per-core figure: the raw load, still no crash");
  for (const junk of [null, undefined, {}, { load: 5 }, { load: {}, mem: [], disks: 3 }]) assert.doesNotThrow(() => rowLines({ name: "b", link: "connected", state: "fresh", numbers: junk, ageMs: 0, error: null }));
});

test("the disk tooltip lists both disks, home and /tmp, with '-' for an unknown one; the row keeps the higher", async () => {
  const { rowLines } = await H();
  const r = rowLines({ name: "box1", link: "connected", state: "fresh", numbers: GOOD, ageMs: 0, error: null });
  assert.match(r.lines[0], /disk home 40%/);
  assert.equal(r.tip, "disk home 40% · /tmp 10%");
  const noTmp = rowLines({ name: "box1", link: "connected", state: "fresh", numbers: { ...GOOD, disks: { home: GOOD.disks.home, tmp: null } }, ageMs: 0, error: null });
  assert.equal(noTmp.tip, "disk home 40% · /tmp -");
  const noHome = rowLines({ name: "box1", link: "connected", state: "fresh", numbers: { ...GOOD, disks: { home: null, tmp: GOOD.disks.tmp } }, ageMs: 0, error: null });
  assert.equal(noHome.tip, "disk home - · /tmp 10%");
  assert.match(noHome.lines[0], /disk \/tmp 10%|disk tmp 10%/);
  assert.equal(rowLines({ name: "b", link: "connected", state: "off", numbers: null, ageMs: null, error: null }).tip, null);
});

test("discovery failing for an hour after a good sample: the row turns stale (numbers kept, age shown, no exec), and recovers when the list does", async () => {
  const s = await mk();
  await s.boot();
  await until(() => s.row().state === "fresh", "read");
  s.listAnswer = () => Promise.reject(new Error("x"));
  let atStall = 0;
  for (let t = 30 * SEC; t <= 60 * MIN; t += 30 * SEC) { s.at(t); await s.tick(); if (t === 6 * MIN) atStall = s.count("box1"); } // the 5 min read before the cutoff is legitimate
  assert.equal(s.count("box1"), atStall, "no exec once the list is stale");
  const row = s.row();
  assert.equal(row.state, "stale");
  assert.equal(row.numbers.mem.pct, 50, "last good numbers kept");
  assert.equal(row.ageMs >= 54 * MIN, true, `age ${row.ageMs}`);
  assert.equal(s.h.view().listState, "unknown");
  const n = s.count("box1");
  s.listAnswer = undefined; // the list recovers
  s.at(61 * MIN + 30 * SEC); await s.tick();
  await until(() => s.h.view().listState === "ok", "list back");
  await s.tick();
  await until(() => s.row().state === "fresh" && s.row().ageMs < MIN, "polling resumes");
  assert.ok(s.count("box1") > n);
});

test("a stale list does not hide a failed or offline state: off > stale only while polling is stopped by discovery", async () => {
  const s = await mk({ on: false });
  await s.boot();
  s.listAnswer = () => Promise.reject(new Error("x"));
  for (let t = 30 * SEC; t <= 20 * MIN; t += 30 * SEC) { s.at(t); await s.tick(); }
  assert.equal(s.row().state, "off", "polling off stays off");
});
