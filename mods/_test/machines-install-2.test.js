// Part 2 of 3 of the `drover machines install` tests (split from machines-install.test.js by measured weight; the shared fixture is machines-install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, chmodSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { RT, GEN, CURRENT, ENTRY, FINDER, CLI, M, SHIPPED, T_NEW, T_LATER, cleanup, machine, clone, source, redate, dateAll, edit, o, H, holdOf, states, noWrites, noTilde, manifestOf, curId, sha, sha256, fresh, finder, line, forEachPoint, assertSane, newest, DEAD, fileStates, stampOf } from "./machines-install-fixture.js";

test("finder: inside the manager tier the newest version wins (24 over 22 over 9, numerically)", () => {
  const m = machine({ managerNode: "nvm" });
  for (const v of ["v24.0.0", "v9.11.2"]) m.nodeWrapper(join(m.home, `.nvm/versions/node/${v}/bin/node`));
  const l = line(finder(m).out, /^node /);
  assert.ok(l.includes("/v24.0.0/bin/node"), l);
});

test("finder: a configured dir beats a manager, and PATH beats both", () => {
  const m = machine({ managerNode: "mise" });
  const dir = join(m.home, "custom/bin");
  m.nodeWrapper(join(dir, "node"));
  assert.match(line(finder(m, [dir]).out, /^node /), new RegExp(`^node tier=configured path=${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/node `));
  const p = machine({ nodeOnPath: true, managerNode: "mise" });
  p.nodeWrapper(join(p.home, "custom/bin/node"));
  assert.match(line(finder(p, [join(p.home, "custom/bin")]).out, /^node /), /^node tier=path /);
});

test("finder: no node anywhere -> E_NODE_NOT_FOUND on stdout, exit 0, python3 still reported", () => {
  const m = machine({ managerNode: null });
  const r = finder(m);
  assert.equal(r.code, 0, "the exit status never carries the outcome");
  assert.match(r.out, /^E_NODE_NOT_FOUND$/m);
  assert.match(r.out, /^python3 tier=path /m);
  assert.doesNotMatch(r.out, /^node /m);
});

test("manifest: each entry has path, sha256 of the source bytes, mode, source mtime and a test argv; ids are stable and content-addressed", async () => {
  const mod = await M();
  const s = source();
  dateAll(s, T_NEW);
  const man = mod.buildManifest(s);
  for (const f of man.files) {
    assert.deepEqual(Object.keys(f).sort(), ["mode", "path", "sha256", "sourceTime", "test"], f.path);
    assert.equal(f.sha256, sha(readFileSync(join(s, f.path))), f.path);
    assert.equal(f.sourceTime, T_NEW, f.path);
    assert.ok(Array.isArray(f.test) && f.test.length > 0 && f.test.every((a) => typeof a === "string"), `${f.path}: test is an argv`);
  }
  assert.equal(man.files.find((f) => f.path === "bin/drover").mode, "755");
  assert.equal(man.files.find((f) => f.path === "store.js").mode, "644");
  assert.equal(man.id, mod.buildManifest(s).id);
  assert.equal(man.id, mod.generationId(man.files));
  edit(s, "store.js", T_LATER);
  assert.notEqual(mod.buildManifest(s).id, man.id, "another byte, another generation id");
  chmodSync(join(s, "store.js"), 0o755);
  assert.notEqual(mod.buildManifest(s).id, mod.generationId(man.files), "the mode is part of the id");
});

// ---------------------------------------------------------------------------------------------------------- 4. generations: whole install
test("install: a whole fresh install lands one complete generation, switches to it, passes doctor and check, and sends no ~", async () => {
  const { m, s, rt, res } = await fresh();
  const { buildManifest, doctor, check } = await M();
  const man = buildManifest(s);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.gen, man.id);
  assert.equal(RT.currentOf(m.home), `gen/${man.id}`);
  for (const f of man.files) {
    const p = join(m.home, GEN, man.id, f.path);
    assert.equal(sha(readFileSync(p)), f.sha256, f.path);
    assert.equal(RT.modeOf(p), f.mode, `${f.path} mode`);
  }
  const stamp = manifestOf(m);
  assert.equal(stamp.id, man.id);
  assert.match(stamp.node, new RegExp(`^${m.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.local/share/mise/`), "node is the manager one the finder found, an absolute path");
  assert.deepEqual(stamp.files.map((f) => f.path).sort(), SHIPPED.slice().sort());
  assert.ok(stamp.files.every((f) => f.sha256 && f.mode && f.sourceTime === T_NEW && f.kept !== true));
  assert.ok(existsSync(join(m.home, ENTRY)) && (statSync(join(m.home, ENTRY)).mode & 0o111), "the entry launcher exists and runs");
  const d = await doctor(RT.makeRuntime(m), o(m, s));
  assert.equal(d.ok, true, JSON.stringify(d));
  for (const id of ["node", "python3", "current", "files", "tests", "entry"]) assert.equal(d.checks.find((c) => c.id === id)?.status, "ok", id);
  const c = await check(RT.makeRuntime(m), o(m, s));
  assert.equal(c.exitCode, 0);
  assert.ok(c.files.every((f) => f.state === "current"));
  noTilde(rt);
  assert.ok(rt.calls.every((c) => c.machine === m.name), "every call names the machine it is for");
});

test("install: a kill inside a file write (half a file lands) leaves `current` and every published generation untouched", async () => {
  const { m, s, install } = await fresh();
  edit(s, "store.js", T_LATER);
  const before = RT.currentOf(m.home);
  const published = (home) => Object.fromEntries(Object.entries(RT.snapshot(join(home, GEN))).filter(([k]) => !k.startsWith(".stage-")));
  const snap = published(m.home);
  const probe = RT.makeRuntime(clone(m));
  await install(probe, o(probe.machine, s));
  const writeNs = noWrites(probe).map((c) => c.n);
  assert.ok(writeNs.length >= 2);
  for (const n of writeNs) {
    const c = clone(m);
    await assert.rejects(install(RT.makeRuntime(c, { partial: n }), o(c, s)), /killed in write call/);
    assert.equal(RT.currentOf(c.home), before, `partial write at call ${n}`);
    assert.deepEqual(published(c.home), snap, `partial write at call ${n}: the published generations are byte-equal to before`);
    assertSane(c, `partial ${n}`);
  }
});

test("install: platform fixtures (no timeout(1), shasum only) install and pass doctor", async () => {
  const { m, s, res } = await fresh({}, { hasher: "shasum", timeout: false });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((await (await M()).doctor(RT.makeRuntime(m), o(m, s))).ok, true);
});

// ---------------------------------------------------------------------------------------------------------- 5. decisions on a live install
test("install: a re-run on a whole install is a no-op: every file `current`, zero write calls, nothing on the remote changes", async () => {
  const { m, s, install } = await fresh();
  const snap = RT.snapshot(m.home);
  const rt = RT.makeRuntime(m);
  const res = await install(rt, o(m, s));
  assert.equal(res.ok, true);
  assert.equal(res.noop, true);
  assert.ok(res.files.every((f) => f.state === "current"));
  assert.equal(noWrites(rt).length, 0);
  assert.deepEqual(RT.snapshot(m.home), snap);
});

test("check: read-only (no write call, nothing changes on the remote), per-file states, exit 1 on any drift, exit 0 on a whole install", async () => {
  const { m, s } = await fresh();
  const { check } = await M();
  let rt = RT.makeRuntime(m);
  assert.equal((await check(rt, o(m, s))).exitCode, 0);
  appendFileSync(join(m.home, CURRENT, "store.js"), "\n// x\n");
  rmSync(join(m.home, CURRENT, "sources.js"));
  const damaged = RT.snapshot(m.home);
  edit(s, "runs.js", T_LATER);
  rt = RT.makeRuntime(m);
  const res = await check(rt, o(m, s));
  assert.equal(res.exitCode, 1);
  assert.deepEqual({ ...states(res) }, { ...Object.fromEntries(SHIPPED.map((p) => [p, "current"])), "store.js": "edited-remote", "sources.js": "missing", "runs.js": "update" });
  assert.equal(noWrites(rt).length, 0);
  assert.deepEqual(RT.snapshot(m.home), damaged, "check changed nothing");
  const fresher = machine(); // a machine never installed: every file is new, still read-only
  const rt2 = RT.makeRuntime(fresher), before = RT.snapshot(fresher.home);
  const res2 = await check(rt2, o(fresher, s));
  assert.equal(res2.exitCode, 1);
  assert.ok(res2.files.every((f) => f.state === "new"));
  assert.equal(noWrites(rt2).length, 0);
  assert.deepEqual(RT.snapshot(fresher.home), before);
});

test("hold: doctor on an old-but-complete install while a hold targets a newer generation WARNs and keeps the hold (paused before activation)", async () => {
  const { m, s, install } = await fresh();
  edit(s, "store.js", T_LATER);
  const { doctor } = await M();
  let seen = null;
  const rt = RT.makeRuntime(m, { after: async (c) => {
    if (c.n !== 6) return; // the new generation is being built, `current` is still the old one
    const n = (await newest(m)).n;
    seen = { d: await doctor(RT.makeRuntime(m), o(m, s)), n, after: (await newest(m)).n, state: (await newest(m)).record.state };
  } });
  const res = await install(rt, o(m, s));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(seen, "the doctor ran mid-install");
  assert.equal(seen.state, "held", "doctor did not clear");
  assert.equal(seen.after, seen.n, "doctor wrote no record");
  assert.equal(seen.d.checks.find((c) => c.id === "hold")?.status, "WARN");
  assert.match(seen.d.checks.find((c) => c.id === "hold").detail, /unfinished/);
  assert.equal((await newest(m)).record.state, "cleared", "the install itself cleared it at its own end");
});

test("hold: doctor output follows the grammar; exit 1 only on FAIL; --json carries ok and checks[]", async () => {
  const { m, s } = await fresh();
  const { doctor, formatDoctor } = await M();
  const d = await doctor(RT.makeRuntime(m), o(m, s));
  const text = formatDoctor(d, { machine: m.name });
  const lines = text.trim().split("\n");
  for (const l of lines.slice(0, -1)) assert.match(l, new RegExp(`^(ok|FAIL|WARN|skip)  ${m.name}:[a-z0-9-]+  \\S`), l);
  assert.match(lines.at(-1), /^doctor: \d+ ok, \d+ warn, \d+ fail$/);
  assert.equal(d.exitCode, 0);
  assert.ok(d.checks.every((c) => ["id", "status", "detail"].every((k) => k in c)));
  rmSync(join(m.home, CURRENT, "store.js"));
  const bad = await doctor(RT.makeRuntime(m), o(m, s));
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.find((c) => c.id === "files").status, "FAIL");
  assert.match(formatDoctor(bad, { machine: m.name }), /^FAIL  m1:files  /m);
});

test("review 1: a remote edit that equals an OLD generation's bytes survives two no-force installs (the old generation is not reused with its old stamp)", async () => {
  const { m, s, install } = await fresh();
  const v1 = readFileSync(join(m.home, CURRENT, "store.js"), "utf8");
  edit(s, "store.js", T_LATER); // V2
  assert.equal((await install(RT.makeRuntime(m), o(m, s))).ok, true);
  writeFileSync(join(m.home, CURRENT, "store.js"), v1); // the remote file edited back to V1 bytes
  for (const round of [1, 2]) {
    const res = await install(RT.makeRuntime(m), o(m, s));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(fileStates(res)["store.js"], "edited-remote", `round ${round}`);
    assert.equal(readFileSync(join(m.home, CURRENT, "store.js"), "utf8"), v1, `round ${round}: the remote edit survives without --force`);
    assert.equal(stampOf(m, "store.js").kept, true, `round ${round}: the stamp in force says kept`);
  }
});

test("review 2: copying an unchanged file keeps its installed source time; an older source still never replaces it, across several installs", async () => {
  const { m, s, install } = await fresh();
  const T = T_NEW;
  const original = readFileSync(join(m.home, CURRENT, "store.js"), "utf8");
  redate(s, "store.js", T - 200000); // the same bytes, an older checkout
  edit(s, "runs.js", T_LATER); // a real update, so a new generation is built and store.js is copied
  assert.equal((await install(RT.makeRuntime(m), o(m, s))).ok, true);
  assert.equal(stampOf(m, "store.js").sourceTime, T, "an unchanged file keeps the source time it was installed with");
  appendFileSync(join(s, "store.js"), "\n// different bytes, still older than what is installed\n");
  redate(s, "store.js", T - 100000);
  const { check } = await M();
  assert.equal(fileStates(await check(RT.makeRuntime(m), o(m, s)))["store.js"], "newer-remote");
  const res = await install(RT.makeRuntime(m), o(m, s));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(readFileSync(join(m.home, CURRENT, "store.js"), "utf8"), original, "the older source did not replace it");
});

test("review 3: doctor refuses an empty, incomplete or malformed stamp; a missing CLI can never clear the hold", async () => {
  const { m, s } = await fresh();
  const { doctor } = await M();
  const stampPath = join(m.home, CURRENT, "MANIFEST.json");
  const good = readFileSync(stampPath, "utf8");
  const target = curId(m);
  const mutate = (fn) => { const st = JSON.parse(good); fn(st); writeFileSync(stampPath, JSON.stringify(st)); };
  const cases = {
    "empty inventory and the CLI missing": () => { mutate((st) => { st.files = []; }); rmSync(join(m.home, CURRENT, "bin/drover")); },
    "a required file absent from the stamp": () => mutate((st) => { st.files = st.files.filter((f) => f.path !== "bin/drover"); }),
    "an entry without a sha256": () => mutate((st) => { delete st.files[0].sha256; }),
    "an entry with a bad mode": () => mutate((st) => { st.files[0].mode = "rwx"; }),
    "a path that climbs out": () => mutate((st) => { st.files[0].path = "../x"; }),
    "files is not a list": () => mutate((st) => { st.files = {}; }),
  };
  for (const [label, damage] of Object.entries(cases)) {
    writeFileSync(stampPath, good);
    if (!existsSync(join(m.home, CURRENT, "bin/drover"))) writeFileSync(join(m.home, CURRENT, "bin/drover"), readFileSync(join(s, "bin/drover")), { mode: 0o755 });
    const h = await holdOf(m);
    assert.equal(h.acquire({ machine: m.name, target }).ok, true, label);
    damage();
    const d = await doctor(RT.makeRuntime(m), o(m, s));
    assert.equal(d.ok, false, label);
    assert.ok(d.checks.some((c) => c.status === "FAIL"), label);
    assert.equal(d.cleared, false, label);
    assert.equal((await newest(m)).record.state, "held", `${label}: the hold stands`);
    assert.equal(h.clearManual("test cleanup").ok, true);
  }
});

test("review 4: a PATH node that hangs is rejected at the bound and the manager tier is used (no timeout(1)); the bound is configurable, default 5 s", () => {
  const m = machine({ nodeOnPath: "hang", managerNode: "mise", timeout: false });
  const t0 = performance.now();
  const r = spawnSync("/bin/sh", ["-s"], { cwd: m.home, env: { ...m.env, DROVER_FIND_TIMEOUT_S: "1" }, input: readFileSync(FINDER, "utf8"), encoding: "utf8" });
  const took = performance.now() - t0;
  assert.equal(r.status, 0);
  assert.match(r.stdout.split("\n").find((l) => /^node /.test(l)), /^node tier=manager /);
  assert.ok(took < 4500, `the hung candidate was cut at the bound, not waited for: ${Math.round(took)} ms`);
  assert.match(readFileSync(FINDER, "utf8"), /DROVER_FIND_TIMEOUT_S:-5/, "default bound 5 s");
});

test("review 7: phase-boundary kills: a kill at the edge of every step of an update leaves `current` right, the hold standing, every published generation whole, and the re-run completes", async () => {
  const { m: base, s, install } = await fresh();
  edit(s, "store.js", T_LATER);
  const { buildManifest } = await M();
  const target = buildManifest(s).id;
  const probe = clone(base);
  const trace = [];
  const clean = RT.makeRuntime(probe, { after: (c) => trace.push({ n: c.n, current: c.current }) });
  await install(clean, o(probe, s));
  const K = trace.find((t) => t.current !== RT.currentOf(base.home)).n;
  const phaseOf = (c) => {
    const t = c.kind === "write" ? (c.path.endsWith("MANIFEST.json") ? "manifest" : "stage-file") : c.argv[0] === "sh" ? "finder" : /hashlib\.sha256\(f\.read\(\)\)\.hexdigest\(\)\ndef mode/.test(c.stdin) ? "probe" : /shutil\.copyfile/.test(c.stdin) ? "copy" : /os\.chmod\(os\.path\.join\(sys\.argv\[1\]/.test(c.stdin) ? "modes" : /bad\.append/.test(c.stdin) ? "verify" : /os\.rename\(stage, final\)/.test(c.stdin) ? "publish" : /os\.symlink/.test(c.stdin) ? "link" : /^import os, sys\nos\.replace/.test(c.stdin) ? "replace" : /drover-tmp/.test(c.stdin) ? "entry" : "test-or-doctor";
    return t;
  };
  const phases = clean.calls.map(phaseOf);
  for (const must of ["finder", "probe", "stage-file", "copy", "modes", "manifest", "verify", "publish", "link", "replace"]) assert.ok(phases.includes(must), `the install has a ${must} step`);
  const edges = new Set();
  phases.forEach((ph, i) => { if (i === 0 || phases[i - 1] !== ph) { edges.add(i + 1); } if (i + 1 < phases.length && phases[i + 1] !== ph) edges.add(i + 2); });
  const bounds = phases.map((ph, i) => (ph === "test-or-doctor" || ph === "probe" ? null : i + 1)).filter(Boolean);
  const points = [...new Set([...edges, ...bounds])].filter((n) => n <= clean.calls.length).sort((a, b) => a - b);
  assert.ok(points.length >= 12, `phase-boundary kill points: ${points.join(",")}`);
  const before = RT.currentOf(base.home);
  await forEachPoint(points, async (n) => {
    const c = clone(base);
    await assert.rejects(install(RT.makeRuntime(c, { kill: n }), o(c, s)), /killed/, `kill ${n} (${phases[n - 1]})`);
    assert.equal(RT.currentOf(c.home), n <= K ? before : `gen/${target}`, `kill before call ${n} (${phases[n - 1]})`);
    assertSane(c, `kill ${n}`);
    if (n >= 3) assert.equal((await newest(c)).record.state, "held", `kill ${n} (${phases[n - 1]}): the hold stands`);
    assert.equal(RT.cliProjects(c).code, 0, `kill ${n}: the CLI works`);
    const res = await install(RT.makeRuntime(c), o(c, s, { holdEnv: DEAD }));
    assert.equal(res.ok, true, `rerun after kill ${n}: ${JSON.stringify(res)}`);
    assert.equal(curId(c), target);
  });
});

test("review N2: install and doctor turn E_TEMP_FAILED into their fixed failure, writing nothing", async () => {
  const m = machine({ mktemp: "fail" }), s = source();
  const { install, doctor } = await M();
  const rt = RT.makeRuntime(m), snap = RT.snapshot(m.home);
  const res = await install(rt, o(m, s));
  assert.deepEqual([res.ok, res.code], [false, "E_TEMP_FAILED"]);
  assert.equal(noWrites(rt).length, 0);
  assert.deepEqual(RT.snapshot(m.home), snap);
  const d = await doctor(RT.makeRuntime(m), o(m, s));
  assert.equal(d.ok, false);
  assert.match(d.checks.find((c) => c.id === "node").detail, /E_TEMP_FAILED/);
});

test("known limit: a first install killed after publishing and before the first switch: a hand edit in that never-activated generation stays in the orphan, unused; the active generation holds the laptop bytes", async () => {
  const m = machine(), s = source();
  dateAll(s, T_NEW);
  const { install, buildManifest } = await M();
  const H = buildManifest(s).id;
  const probe = clone(m);
  const clean = RT.makeRuntime(probe);
  await install(clean, o(probe, s));
  const published = clean.calls.find((c) => c.kind === "exec" && /os\.rename\(stage, final\)/.test(c.stdin)).n;
  await assert.rejects(install(RT.makeRuntime(m, { kill: published + 1 }), o(m, s)), /killed/);
  assert.equal(RT.currentOf(m.home), null, "published, never activated");
  assert.ok(existsSync(join(m.home, GEN, H, "MANIFEST.json")));
  const orphanFile = join(m.home, GEN, H, "store.js");
  appendFileSync(orphanFile, "\n// edited by hand in the orphan\n");
  const edited = readFileSync(orphanFile, "utf8");
  const res = await install(RT.makeRuntime(m), o(m, s, { holdEnv: DEAD }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(readFileSync(orphanFile, "utf8"), edited, "the edit stays on disk in the orphan generation");
  assert.notEqual(curId(m), H, "the orphan was not activated");
  assert.equal(readFileSync(join(m.home, CURRENT, "store.js"), "utf8"), readFileSync(join(s, "store.js"), "utf8"), "the active generation holds the laptop bytes");
  assert.ok(existsSync(join(m.home, GEN, H)), "nothing is deleted");
});
