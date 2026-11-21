// T-MWO2HEU32E4 (A5): the pure load hold. Written before the code: every test here fails on the old tree (no loadhold.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { STALE_MS, LOCAL, limitsFor, parseOverrides, judge, sampleOfRow, reservedWarning, createLocalRead, HOLD_PATTERNS } from "./loadhold.js";
import { HEALTH_PY, readResult } from "./health.js";
import { field, validate } from "./config-schema.js";

const S = (o = {}) => ({ v: 1, os: "linux", cores: 4, load: { one: 2, five: 2, fifteen: 2 }, loadPerCore: 0.5, mem: { totalMb: 16000, usedMb: 8000, pct: 50 }, disks: { home: { totalMb: 1, freeMb: 1, pct: 40 }, tmp: { totalMb: 1, freeMb: 1, pct: 10 } }, ...o });
const withMem = (pct) => S({ mem: { totalMb: 16000, usedMb: 1, pct } });
const DEF = { load: "1", memory: "80", disk: "90", machines: "" };
const run = (sample, settings = DEF, machine = LOCAL, ageMs = 0) => judge({ sample, ageMs, limits: limitsFor(settings, machine), label: "this computer" });

test("memory: 81 holds with a plain reason naming the setting; 80 and 79 allow", () => {
  const h = run(withMem(81));
  assert.match(h.hold, /memory is 81% full \(limit 80%/);
  assert.match(h.hold, /drover-runs\.hold_memory/);
  assert.equal(h.warn, null);
  assert.equal(run(withMem(80)).hold, null);
  assert.equal(run(withMem(79)).hold, null);
});

test("a limit set to off is off; off on load leaves memory active", () => {
  assert.equal(run(withMem(99), { ...DEF, memory: "off" }).hold, null);
  const h = run(S({ loadPerCore: 3, mem: { totalMb: 1, usedMb: 1, pct: 95 } }), { ...DEF, load: "off" });
  assert.match(h.hold, /memory is 95% full/);
  assert.doesNotMatch(h.hold, /load/);
});

test("load per core over the limit holds; a per-machine override raises it; an override for another machine does nothing", () => {
  assert.match(run(S({ loadPerCore: 1.2 })).hold, /load is 1\.2 per core \(limit 1/);
  assert.equal(run(S({ loadPerCore: 1.2 })).hold !== null, true);
  const o = { ...DEF, machines: `${LOCAL}: load 2` };
  assert.equal(run(S({ loadPerCore: 1.2 }), o).hold, null);
  assert.match(run(S({ loadPerCore: 1.2 }), { ...DEF, machines: "other: load 2" }).hold, /load is 1\.2/);
  assert.equal(run(S({ loadPerCore: 1 })).hold, null, "exactly at the limit allows");
});

test("an override names hold_machines as the setting to change", () => {
  const h = run(withMem(90), { ...DEF, machines: `${LOCAL}: memory 85` });
  assert.match(h.hold, /memory is 90% full \(limit 85%/);
  assert.match(h.hold, /drover-runs\.hold_machines/);
  assert.match(h.hold, /local: memory off/, "the entry to write, not a bare 'off'");
  assert.doesNotMatch(h.hold, /set it to off/);
  const f = field("drover-runs", "hold_machines");
  assert.equal(validate(f, /(local: memory off)/.exec(h.hold)[1]).ok, true, "the suggested value is accepted by the schema");
  assert.match(run(withMem(90)).hold, /set it to off/, "a global limit still says so");
  const d = run(S({ disks: { home: { pct: 95 }, tmp: { pct: 1 } } }), { ...DEF, machines: "local: disk 91" }).hold;
  assert.match(d, /local: disk off/);
});

test("disk: 91 on home or tmp holds and names the disk; a null disk is skipped", () => {
  assert.match(run(S({ disks: { home: { pct: 91 }, tmp: { pct: 10 } } })).hold, /disk home is 91% full \(limit 90%/);
  assert.match(run(S({ disks: { home: { pct: 10 }, tmp: { pct: 95 } } })).hold, /disk \/tmp is 95% full/);
  assert.equal(run(S({ disks: { home: null, tmp: { pct: 10 } } })).hold, null);
  assert.equal(run(S({ disks: { home: null, tmp: null } })).hold, null);
});

test("several reasons are joined, the most over first", () => {
  const h = run(S({ loadPerCore: 1.1, mem: { totalMb: 1, usedMb: 1, pct: 99 } })).hold;
  assert.ok(h.indexOf("memory") < h.indexOf("load"), h);
  assert.match(h, / · /);
});

test("unknown, failed or stale health allows the start and warns", () => {
  for (const [sample, ageMs] of [[null, null], [null, 0], [withMem(99), null], [withMem(99), STALE_MS + 1]]) {
    const h = run(sample, DEF, LOCAL, ageMs);
    assert.equal(h.hold, null);
    assert.match(h.warn, /this computer health is unknown, start allowed/);
  }
  assert.equal(run(withMem(99), DEF, LOCAL, STALE_MS).hold !== null, true, "exactly at the stale age is still fresh");
});

test("override text: parsed per machine, repeated keys keep the last, bad text gives nothing and never throws", () => {
  assert.deepEqual(parseOverrides("a: memory 85, load off; b: disk 95"), { a: { memory: 85, load: "off" }, b: { disk: 95 } });
  assert.deepEqual(parseOverrides(""), {});
  assert.deepEqual(parseOverrides("a: memory 85, memory 90"), { a: { memory: 90 } });
  assert.deepEqual(parseOverrides("garbage ;;; a: x 1"), {});
  assert.deepEqual(parseOverrides(null), {});
  assert.deepEqual(limitsFor({ load: "zzz", memory: "", disk: undefined, machines: "???" }, LOCAL).memory, { value: 80, setting: "hold_memory" });
});

test("the schema patterns accept good values and refuse bad ones as a whole", () => {
  const P = HOLD_PATTERNS;
  for (const v of ["1", "0.5", "off", "2.25"]) assert.ok(P.load.test(v), v);
  for (const v of ["80", "off", "99.5", "100"]) assert.ok(P.percent.test(v), v);
  for (const v of ["0", "101", "-1", "eighty", "", "80%"]) assert.ok(!P.percent.test(v), v);
  assert.ok(P.machines.test("local: memory off"));
  assert.ok(P.machines.test("a: memory 85, load off; b: disk 95"));
  assert.ok(!P.machines.test("local: memory off; b: nonsense"), "one bad entry refuses the whole value");
});

test("a machine row feeds the judge only when it is fresh with numbers; failed, stale, offline and never are unknown", () => {
  const n = withMem(50);
  assert.deepEqual(sampleOfRow({ state: "fresh", numbers: n, ageMs: 1000 }), { sample: n, ageMs: 1000 });
  for (const state of ["failed", "stale", "offline", "never", "off"]) assert.equal(sampleOfRow({ state, numbers: n, ageMs: 1000 }).sample, null, state);
  assert.equal(sampleOfRow(undefined).sample, null);
  assert.equal(sampleOfRow({ state: "fresh", numbers: null, ageMs: 0 }).sample, null);
});

test("a linked machine literally named local clashes with the laptop name and is warned about", () => {
  assert.match(reservedWarning(["box", "local"]), /named "local".*this computer/);
  assert.match(reservedWarning(["box", "local"]), /drover-runs\.hold_machines/);
  assert.equal(reservedWarning(["box"]), null);
  assert.equal(reservedWarning(undefined), null);
});

// ---- the local read: a bounded local process, cached for 60 s, one read in flight, never hc or --on
const GOODJSON = JSON.stringify({ v: 1, os: "linux", cores: 4, load: { one: 1, five: 1, fifteen: 1 }, loadPerCore: 0.25, mem: { totalMb: 100, usedMb: 50, pct: 50 }, disks: { home: { totalMb: 1, freeMb: 1, pct: 5 }, tmp: { totalMb: 1, freeMb: 1, pct: 5 } } });
function rig(answer = () => ({ code: 0, stdout: GOODJSON, stderr: "" })) {
  const st = { T: 1000, calls: [], pending: 0, maxPending: 0 };
  const read = createLocalRead({ exec: async (cmd, args, opts) => { st.calls.push({ cmd, args, opts }); st.pending++; st.maxPending = Math.max(st.maxPending, st.pending); try { return await answer(st.calls.length); } finally { st.pending--; } }, now: () => st.T, script: HEALTH_PY, parse: readResult });
  return { st, read };
}

test("local read: runs python3 -c with the health script, never hc, never --on, bounded by a timeout", async () => {
  const { st, read } = rig();
  const r = await read();
  assert.equal(r.sample.mem.pct, 50);
  assert.equal(st.calls.length, 1);
  const { cmd, args, opts } = st.calls[0];
  assert.equal(cmd, "python3");
  assert.deepEqual(args, ["-c", HEALTH_PY]);
  assert.ok(!args.includes("--on") && cmd !== "hc");
  assert.ok(opts.timeout > 0 && opts.timeout <= 10000);
});

test("local read: a second call inside 60 s reuses the answer, one after 60 s reads again", async () => {
  const { st, read } = rig();
  await read(); st.T += 59_000; const r = await read();
  assert.equal(st.calls.length, 1);
  assert.equal(r.ageMs, 59_000);
  st.T += 2000; await read();
  assert.equal(st.calls.length, 2);
});

test("local read: concurrent calls share one in-flight read", async () => {
  let release; const gate = new Promise((r) => (release = r));
  const { st, read } = rig(async () => { await gate; return { code: 0, stdout: GOODJSON, stderr: "" }; });
  const ps = [read(), read(), read()];
  release();
  const rs = await Promise.all(ps);
  assert.equal(st.calls.length, 1);
  assert.equal(st.maxPending, 1);
  for (const r of rs) assert.equal(r.sample.mem.pct, 50);
});

test("local read: a failure is cached for 60 s as an error code only (a broken python3 is not respawned per start)", async () => {
  const { st, read } = rig(() => ({ code: 127, stdout: "", stderr: "python3: not found SECRET-PATH" }));
  const a = await read(), b = await read();
  assert.equal(st.calls.length, 1);
  assert.equal(a.sample, null);
  assert.equal(a.error, "no-python");
  assert.equal(JSON.stringify(b).includes("SECRET"), false);
  const t = rig(() => { throw new Error("spawn boom"); });
  assert.equal((await t.read()).sample, null);
  const bad = rig(() => ({ code: 0, stdout: "not json", stderr: "" }));
  assert.equal((await bad.read()).error, "bad-json");
});
