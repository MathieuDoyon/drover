// Part 1 of 3 of the `drover machines install` tests (split from machines-install.test.js by measured weight; the shared fixture is machines-install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, rmSync, chmodSync, mkdirSync, realpathSync, mkdtempSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import { spawnTracked, until, RT, privateWords, wholeWord, GEN, CURRENT, ENTRY, TASKS, CLI, M, SHIPPED, T_OLD, T_NEW, T_LATER, cleanup, machine, clone, source, redate, dateAll, edit, o, holdFiles, states, noWrites, noTilde, manifestOf, curId, sha, sha256, fresh, finder, line, forEachPoint, deferred, drainTicks, killSet, killPoints, assertSane, newest, DEAD } from "./machines-install-fixture.js";

// ---------------------------------------------------------------------------------------------------------- 2. the finder
test("finder: node on PATH wins (tier path); exit status is 0; home= is the physical home", () => {
  const m = machine({ nodeOnPath: true, managerNode: "mise" });
  const r = finder(m);
  assert.equal(r.code, 0, r.err);
  assert.match(line(r.out, /^node /), /^node tier=path path=\S.* version=v?\d/);
  assert.equal(line(r.out, /^home=/), `home=${m.home}`);
  assert.doesNotMatch(r.out, /E_NODE_NOT_FOUND|E_PYTHON_NOT_FOUND/);
});

for (const mgr of ["mise", "nvm", "fnm", "asdf", "volta"]) {
  test(`finder: manager-only node (${mgr}) is found by the manager tier, with no manager assumed`, () => {
    const m = machine({ managerNode: mgr });
    const r = finder(m);
    assert.equal(r.code, 0, r.err);
    const l = line(r.out, /^node /);
    assert.match(l, /^node tier=manager /);
    assert.ok(l.includes(join(m.home, m.managers[mgr])), l);
  });
}

test("finder: no python3 -> E_PYTHON_NOT_FOUND on stdout, exit 0", () => {
  const m = machine({ python: false });
  const r = finder(m);
  assert.equal(r.code, 0);
  assert.match(r.out, /^E_PYTHON_NOT_FOUND$/m);
  assert.match(r.out, /^node tier=manager /m);
});

test("finder: home with spaces and an apostrophe is printed whole", () => {
  const m = machine({ homeName: "my home's dir" });
  const r = finder(m);
  assert.equal(line(r.out, /^home=/), `home=${m.home}`);
  assert.match(line(r.out, /^node /), /^node tier=manager /);
});

// ---------------------------------------------------------------------------------------------------------- 3. the manifest
test("manifest: the shipped list is the 13 files of the plan plus hold.js and publish.js (machines.js imports them) and the headless writer (bin/drover-headless, its .mjs and headless-board.js)", async () => {
  const mod = await M();
  assert.deepEqual([...mod.SHIPPED].sort(), [...SHIPPED].sort());
  assert.deepEqual(mod.buildManifest(TASKS).files.map((f) => f.path).sort(), [...SHIPPED].sort());
});

test("manifest: the transitive static-import closure of every shipped .js/.mjs, and the helpers bin/drover names, is inside it", async () => {
  const mod = await M();
  const have = new Set(mod.buildManifest(TASKS).files.map((f) => f.path));
  const rel = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
  const seen = new Set(), todo = [...SHIPPED];
  while (todo.length) {
    const p = todo.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    const file = join(TASKS, p);
    if (!existsSync(file)) continue; // a missing shipped file is the manifest test's failure
    const text = readFileSync(file, "utf8");
    if (/\.m?js$/.test(p)) for (const m of text.matchAll(rel)) todo.push(posix.normalize(posix.join(posix.dirname(p), m[1])));
    if (p === "bin/drover") for (const m of text.matchAll(/\$here\/([A-Za-z0-9._\/-]+\.(?:mjs|js|sh))/g)) todo.push(posix.normalize(posix.join("bin", m[1])));
  }
  const missing = [...seen].filter((p) => !have.has(p));
  assert.deepEqual(missing, [], `imported or exec'd but not in the manifest: ${missing.join(", ")}`);
  assert.ok(seen.has("bin/drover-machines.mjs"), "bin/drover must dispatch machines to bin/drover-machines.mjs");
});

test("manifest: test argvs are argv (no shell), end on the file's own {gen} path, and carry no JS interpolation of that path", async () => {
  const mod = await M();
  const files = mod.buildManifest(TASKS).files;
  const scripts = new Set();
  for (const f of files) {
    assert.equal(f.test.at(-1), `{gen}/${f.path}`, f.path);
    if (f.path.endsWith(".mjs")) assert.deepEqual(f.test.slice(0, 2), ["{node}", "--check"], f.path);
    else if (f.path.endsWith(".js")) {
      assert.deepEqual(f.test.slice(0, 3), ["{node}", "--input-type=module", "-e"], f.path);
      assert.equal(f.test.length, 5, f.path);
      assert.doesNotMatch(f.test[3], /\{gen\}|\{node\}/, "the import script has no placeholder: the path is process.argv[1]");
      scripts.add(f.test[3]);
    } else if (f.path.endsWith(".py")) {
      // a syntax check that writes nothing: py_compile would put a __pycache__ into the immutable generation
      assert.deepEqual(f.test, ["{python3}", "-c", "import sys; compile(open(sys.argv[1],'rb').read(), sys.argv[1], 'exec')", `{gen}/${f.path}`], f.path);
      assert.ok(!f.test.some((a) => /py_compile/.test(a)), "no py_compile");
    } else assert.deepEqual(f.test.slice(0, 2), ["bash", "-n"], f.path);
  }
  assert.equal(scripts.size, 1, "one constant import script for every .js");
  assert.match([...scripts][0], /pathToFileURL\(process\.argv\[1\]\)/);
  assert.deepEqual(mod.expandTest(["{node}", "--check", "{gen}/x"], { gen: "/g/1", node: "/n/node", python3: "/p" }), ["/n/node", "--check", "/g/1/x"]);
});

test("private words: a generic account or host name (a CI runner's) is not private; real names, machines and the env list are", () => {
  assert.deepEqual(privateWords({ username: "runner", host: "runner", extra: "", machines: [] }), []);
  assert.deepEqual(privateWords({ username: "root", host: "ubuntu" }), []);
  assert.deepEqual(privateWords({ username: "alice-w", host: "devbox", extra: "secretword, ab", machines: [{ name: "boxone", host: "boxone", logout_linger_user: "alice-w" }] }).sort(), ["alice-w", "boxone", "devbox", "secretword"]);
  assert.deepEqual(privateWords({ username: "alice-w", host: "devbox", ci: true }), []);
  assert.ok(wholeWord("the runner pool", "runner") && !wholeWord("a prunner", "runner"), "whole words only");
  assert.ok(!wholeWord("every file uses a runner here", "alice-w"));
});

// ---------------------------------------------------------------------------------------------------------- 5. decisions
test("classify: one state per file; older never replaces newer; an edited file is kept; kept stays kept", async () => {
  const { classify } = await M();
  const src = { path: "store.js", sha256: "S", sourceTime: T_NEW };
  const st = (r) => classify(src, r);
  assert.equal(st(null), "new");
  assert.equal(st({ present: true, sha: "S", stampSha: "S", stampKept: false, stampSourceTime: T_NEW }), "current");
  assert.equal(st({ present: true, sha: "OLD", stampSha: "OLD", stampKept: false, stampSourceTime: T_OLD }), "update");
  assert.equal(st({ present: true, sha: "OLD", stampSha: "OLD", stampKept: false, stampSourceTime: T_LATER }), "newer-remote", "source older than what the remote already has");
  assert.equal(st({ present: true, sha: "EDIT", stampSha: "OLD", stampKept: false, stampSourceTime: T_OLD }), "edited-remote", "bytes differ from what we installed");
  assert.equal(st({ present: true, sha: "EDIT", stampSha: "EDIT", stampKept: true, stampSourceTime: T_OLD }), "edited-remote", "a kept file is not overwritten on the next run");
  assert.equal(st({ present: false, sha: null, stampSha: "OLD", stampKept: false, stampSourceTime: T_OLD }), "missing");
  assert.equal(st({ present: true, sha: "S", stampSha: "OLD", stampKept: false, stampSourceTime: T_OLD }), "current", "same bytes as the source, whatever the stamp says");
});

test("forEachPoint: runs every point, with exactly `limit` in flight at once (a serial helper fails this)", async () => {
  const gates = new Map(), ran = [];
  let inFlight = 0, peak = 0;
  const points = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const all = forEachPoint(points, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    gates.set(n, deferred());
    await gates.get(n).promise;
    ran.push(n); inFlight--;
  }, 4);
  await until(() => gates.size === 4, "4 workers started");
  assert.equal(inFlight, 4, "the pool fills to the limit before any worker finishes");
  for (const n of points) { await until(() => gates.has(n), `point ${n} started`); gates.get(n).resolve(); }
  await all;
  assert.equal(peak, 4);
  assert.deepEqual([...ran].sort((a, b) => a - b), points, "every point ran once");
});

test("forEachPoint: a failure stops new work, waits for every started worker, then throws the failure of the lowest point", async () => {
  const gates = new Map(), started = [];
  let lateDone = false, settled = false;
  const all = forEachPoint([1, 2, 3, 4, 5, 6], async (n) => {
    started.push(n);
    gates.set(n, deferred());
    await gates.get(n).promise;
    if (n === 3) throw new Error("point 3 failed");
    if (n === 1) lateDone = true;
  }, 3).catch((e) => e).finally(() => { settled = true; });
  await until(() => gates.size === 3, "points 1-3 started");
  gates.get(3).resolve(); // point 3 fails while 1 and 2 are still pending
  await drainTicks();
  assert.equal(settled, false, "the helper does not settle while a started worker is pending");
  assert.deepEqual(started, [1, 2, 3], "no new point starts after the failure");
  gates.get(2).resolve();
  await drainTicks();
  assert.equal(settled, false, "still waiting for point 1");
  gates.get(1).resolve();
  const err = await all;
  assert.equal(lateDone, true, "the late worker finished before the helper settled");
  assert.equal(err.message, "point 3 failed");
  assert.deepEqual(started, [1, 2, 3]);
});

test("forEachPoint: with two failures the lowest point's failure is the one thrown", async () => {
  const err = await forEachPoint([1, 2, 3], async (n) => { if (n > 1) throw new Error(`point ${n} failed`); await drainTicks(); throw new Error("point 1 failed"); }, 3).catch((e) => e);
  assert.equal(err.message, "point 1 failed");
});

for (const scenario of ["fresh", "update"]) {
  test(`install killed at runner calls (${scenario}): before activation \`current\` is untouched, after it \`current\` is the target; published gens stay whole; a re-run finishes`, async () => {
    const { m, s, install } = await fresh();
    let base = m;
    if (scenario === "fresh") { base = machine(); }
    else edit(s, "store.js", T_LATER);
    const { doctor } = await M();
    const { total, K, before, target } = await killPoints(base, s, install);
    assert.ok(total > 5 && K > 1 && K <= total);
    await forEachPoint(killSet(total, K), async (n) => {
      const c = clone(base);
      const rt = RT.makeRuntime(c, { kill: n });
      await assert.rejects(install(rt, o(c, s)), /killed/, `kill ${n}`);
      assert.equal(rt.calls.length, n - 1, `kill ${n}: the killed call never ran`);
      if (n <= K) assert.equal(RT.currentOf(c.home), before, `kill ${n}: a kill before the switch changes nothing the CLI runs`);
      else assert.equal(RT.currentOf(c.home), target, `kill ${n}: after the switch \`current\` is the complete target`);
      assertSane(c, `kill ${n}`);
      if (scenario === "update" && n <= K) assert.equal(RT.cliProjects(c).code, 0, `kill ${n}: the CLI still works`);
      const again = RT.makeRuntime(c);
      const res = await install(again, o(c, s, { holdEnv: DEAD })); // the killed installer's pid is this test process: pretend it is gone
      assert.equal(res.ok, true, `rerun after kill ${n}: ${JSON.stringify(res)}`);
      assert.equal(curId(c), (await M()).buildManifest(s).id, `rerun after kill ${n} ends on the target generation`);
    });
  });
}

test("install: a CLI call (the real read verb through the entry launcher) works after EVERY runner call of an update", async () => {
  const { m, s, install } = await fresh();
  assert.equal(RT.cliProjects(m).code, 0, RT.cliProjects(m).stderr);
  edit(s, "store.js", T_LATER);
  const bad = [];
  let probes = 0;
  const rt = RT.makeRuntime(m, { after: (c, mm) => { probes++; const r = RT.cliProjects(mm); if (r.code !== 0 || !/no projects/.test(r.stderr + r.stdout)) bad.push({ n: c.n, code: r.code, err: r.stderr.slice(0, 200) }); } });
  const res = await install(rt, o(m, s));
  assert.equal(res.ok, true);
  assert.ok(probes === rt.calls.length && probes > 5);
  assert.deepEqual(bad, []);
  assert.equal(RT.cliProjects(m).code, 0);
});

test("install: a transfer that damages a file (sha mismatch) fails before activation and changes nothing that runs", async () => {
  const { m, s, install } = await fresh();
  edit(s, "store.js", T_LATER);
  const before = RT.currentOf(m.home);
  const rt = RT.makeRuntime(m, { mangle: (p, text) => (p.endsWith("/store.js") ? `${text}\n/* damaged in transit */` : text) });
  const res = await install(rt, o(m, s));
  assert.equal(res.ok, false);
  assert.match(res.code, /^E_[A-Z_]+$/);
  assert.equal(RT.currentOf(m.home), before);
  assert.equal(RT.cliProjects(m).code, 0);
  assertSane(m, "after a damaged transfer");
  noTilde(rt);
});

test("install: a file whose test argv fails on the remote fails before activation and changes nothing that runs", async () => {
  const { m, s, install } = await fresh();
  appendFileSync(join(s, "herd-export.js"), '\nthrow new Error("broken on purpose");\n');
  redate(s, "herd-export.js", T_LATER);
  const before = RT.currentOf(m.home);
  const rt = RT.makeRuntime(m);
  const res = await install(rt, o(m, s));
  assert.equal(res.ok, false);
  assert.match(res.code, /^E_[A-Z_]+$/);
  assert.equal(res.path, "herd-export.js", "the failing file is named");
  assert.equal(RT.currentOf(m.home), before);
  assert.equal(RT.cliProjects(m).code, 0);
  assertSane(m, "after a failing test argv");
});

test("install: a published generation is never written (edited active gen + --force back to source bytes leaves the active dir byte-equal; the new gen gets a suffix)", async () => {
  const { m, s, install } = await fresh();
  const { buildManifest } = await M();
  const id = buildManifest(s).id, active = join(m.home, GEN, id);
  appendFileSync(join(active, "store.js"), "\n// edited on the remote\n");
  const frozen = RT.snapshot(active);
  const res = await install(RT.makeRuntime(m), o(m, s, { force: true }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(RT.snapshot(active), frozen, "the old active dir is byte-equal to before the force");
  assert.notEqual(curId(m), id);
  assert.ok(curId(m).startsWith(`${id}-`), `new id carries a suffix: ${curId(m)}`);
  assert.equal(sha(readFileSync(join(m.home, CURRENT, "store.js"))), buildManifest(s).files.find((f) => f.path === "store.js").sha256);
});

test("install: an existing generation that still verifies is reused: the switch back writes nothing", async () => {
  const { m, s, install } = await fresh();
  const a = curId(m);
  edit(s, "store.js", T_LATER);
  await install(RT.makeRuntime(m), o(m, s));
  assert.notEqual(curId(m), a);
  const prior = RT.snapshot(join(m.home, GEN, a));
  const dir = join(s, "store.js");
  writeFileSync(dir, readFileSync(join(TASKS, "store.js"))); // the source goes back to the bytes of generation a
  redate(s, "store.js", T_NEW);
  const rt = RT.makeRuntime(m);
  const res = await install(rt, o(m, s, { force: true }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(curId(m), a);
  assert.equal(noWrites(rt).length, 0, "no file is sent again");
  assert.deepEqual(RT.snapshot(join(m.home, GEN, a)), prior);
});

test("launcher: an invocation that started on an old generation keeps using that generation's helpers after `current` switches", async () => {
  const { m, s, install } = await fresh();
  const a = curId(m);
  const shim = join(m.root, "node-shim"), rec = join(m.root, "node-argv1"), started = join(m.root, "started"), release = join(m.root, "release");
  writeFileSync(shim, `#!/bin/sh\necho "$1" > "${rec}"\n: > "${started}"\nn=0; while [ ! -e "${release}" ]; do sleep 0.01 || exit 1; n=$((n+1)); [ $n -lt 6000 ] || exit 1; done\nexec ${process.execPath} "$@"\n`);
  chmodSync(shim, 0o755);
  mkdirSync(m.appHome, { recursive: true });
  const child = spawnTracked(join(m.home, ENTRY), ["agents", "export"], { cwd: m.home, env: { ...m.env, HERDR_APP_HOME: m.appHome, DROVER_NODE: shim }, stdio: "ignore" });
  const exited = new Promise((r) => child.on("close", r));
  await until(() => existsSync(started), "the old invocation reached its node call");
  edit(s, "store.js", T_LATER);
  assert.equal((await install(RT.makeRuntime(m), o(m, s))).ok, true);
  assert.notEqual(curId(m), a, "current moved on");
  writeFileSync(release, "");
  await exited;
  const argv1 = realpathSync(readFileSync(rec, "utf8").trim());
  assert.ok(argv1.startsWith(join(m.home, GEN, a) + "/"), `the old invocation ran its own generation's helper: ${argv1}`);
  assert.ok(existsSync(join(m.home, GEN, a, "herd-export.js")), "the previous generation is kept whole");
});

test("install: no node -> E_NODE_NOT_FOUND, no python3 -> E_PYTHON_NOT_FOUND, each before ANY write; nothing on the remote changes", async () => {
  for (const [mo, code] of [[{ managerNode: null }, "E_NODE_NOT_FOUND"], [{ python: false }, "E_PYTHON_NOT_FOUND"]]) {
    const m = machine(mo), s = source();
    const rt = RT.makeRuntime(m), snap = RT.snapshot(m.home);
    const { install } = await M();
    const res = await install(rt, o(m, s));
    assert.equal(res.ok, false);
    assert.equal(res.code, code);
    assert.equal(noWrites(rt).length, 0, code);
    assert.deepEqual(RT.snapshot(m.home), snap, code);
  }
});

test("install: an older source never replaces a newer remote file; --force does", async () => {
  const { m, s, install } = await fresh();
  const { check } = await M();
  const keep = readFileSync(join(m.home, CURRENT, "store.js"), "utf8");
  appendFileSync(join(s, "store.js"), "\n// an older checkout\n");
  redate(s, "store.js", T_OLD);
  assert.equal(states(await check(RT.makeRuntime(m), o(m, s)))["store.js"], "newer-remote");
  const res = await install(RT.makeRuntime(m), o(m, s));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(states(res)["store.js"], "newer-remote");
  assert.equal(readFileSync(join(m.home, CURRENT, "store.js"), "utf8"), keep, "the newer file on the remote stays");
  const forced = await install(RT.makeRuntime(m), o(m, s, { force: true }));
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(readFileSync(join(m.home, CURRENT, "store.js"), "utf8"), readFileSync(join(s, "store.js"), "utf8"));
  edit(s, "runs.js", T_LATER);
  assert.equal(states(await check(RT.makeRuntime(m), o(m, s)))["runs.js"], "update", "a newer source does update");
});

test("install: a file edited on the remote is kept without --force (also on the next run), replaced with it", async () => {
  const { m, s, install } = await fresh();
  const { check, doctor } = await M();
  appendFileSync(join(m.home, CURRENT, "store.js"), "\n// edited on the remote\n");
  const edited = readFileSync(join(m.home, CURRENT, "store.js"), "utf8");
  assert.equal(states(await check(RT.makeRuntime(m), o(m, s)))["store.js"], "edited-remote");
  for (const round of [1, 2]) {
    const res = await install(RT.makeRuntime(m), o(m, s));
    assert.equal(res.ok, true, `round ${round}: ${JSON.stringify(res)}`);
    assert.equal(states(res)["store.js"], "edited-remote", `round ${round}`);
    assert.equal(readFileSync(join(m.home, CURRENT, "store.js"), "utf8"), edited, `round ${round}: the remote edit survives`);
    assert.equal(manifestOf(m).files.find((f) => f.path === "store.js").kept, true, `round ${round}: the stamp says kept`);
    assert.equal((await doctor(RT.makeRuntime(m), o(m, s))).ok, true, `round ${round}: a kept file is checked against its recorded sha`);
  }
  const forced = await install(RT.makeRuntime(m), o(m, s, { force: true }));
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(readFileSync(join(m.home, CURRENT, "store.js"), "utf8"), readFileSync(join(s, "store.js"), "utf8"));
  assert.notEqual(manifestOf(m).files.find((f) => f.path === "store.js").kept, true);
});

test("the health script ships; doctor and check on the installed machine leave the generation tree unchanged (no __pycache__, no byte changed)", async () => {
  const { m, s } = await fresh();
  const { doctor, check } = await M();
  assert.ok(existsSync(join(m.home, CURRENT, "bin/drover-health.py")), "the health script is in the generation");
  const before = RT.snapshot(m.home);
  assert.equal((await doctor(RT.makeRuntime(m), o(m, s))).ok, true);
  assert.equal((await check(RT.makeRuntime(m), o(m, s))).exitCode, 0);
  assert.deepEqual(RT.snapshot(m.home), before, "doctor and check changed nothing, no new path");
  assert.ok(!Object.keys(RT.snapshot(m.home)).some((k) => /__pycache__|\.pyc$/.test(k)));
});

// ---------------------------------------------------------------------------------------------------------- 6. CLI wiring
test("bin/drover resolves its physical directory once, at the top, and dispatches `machines` to bin/drover-machines.mjs", () => {
  const text = readFileSync(CLI, "utf8");
  const assigns = [...text.matchAll(/^\s*here="\$\(cd -P/gm)];
  assert.equal(assigns.length, 1, "one `here=` for the whole script (the lazy one inside `agents export` is gone)");
  assert.ok(assigns[0].index < text.indexOf("usage() {"), "`here` is set before usage() and every verb");
  assert.match(text, /^\s*machines\) exec "\$\{DROVER_NODE:-node\}" "\$here\/drover-machines\.mjs" "\$\{@:2\}" ;;/m);
});

test("hold: a whole install writes a held record first and doctor clears it; nothing is ever deleted", async () => {
  const m = machine(), s = source();
  dateAll(s, T_NEW);
  const { install, buildManifest } = await M();
  const seen = [];
  const rt = RT.makeRuntime(m, { after: async (c) => { const r = await newest(m); seen.push({ n: c.n, state: r?.record?.state ?? null, target: r?.record?.target ?? null }); } });
  const res = await install(rt, o(m, s));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(seen[0].state, null, "the first calls (probe) are reads: no hold yet");
  const held = seen.find((x) => x.state === "held");
  assert.ok(held, "a held record exists while the install runs");
  assert.equal(held.target, buildManifest(s).id, "the hold names the generation being installed");
  const before = seen.findIndex((x) => x.state === "held");
  assert.ok(rt.calls.filter((c) => c.kind === "write").every((c) => c.n > seen[before].n - 1), "no file is written before the hold exists");
  assert.deepEqual(holdFiles(m), ["hold.1.json", "hold.2.json"], "held, then cleared: both stay");
  const r = await newest(m);
  assert.equal(r.record.state, "cleared");
  assert.equal(r.record.machine, m.name);
});

test("hold: the install decides from a RE-PROBE taken after the hold, not from the first one", async () => {
  const { m, s, install } = await fresh();
  const { buildManifest } = await M();
  edit(s, "store.js", T_LATER);
  // another actor (own app home: its own hold) finishes the same update between our first probe (call 2) and the hold
  let ran = false;
  const rt = RT.makeRuntime(m, { after: async (c) => {
    if (c.n !== 2 || ran) return;
    ran = true;
    const other = machine();
    assert.equal((await install(RT.makeRuntime(m), o(m, s, { appHome: other.appHome }))).ok, true);
  } });
  const res = await install(rt, o(m, s));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(noWrites(rt).length, 0, "the re-probe saw a whole install: nothing was sent");
  assert.equal(curId(m), buildManifest(s).id);
  assert.equal((await newest(m)).record.state, "cleared", "our own hold is cleared by the doctor");
});

test("hold: a kill after the switch and before doctor leaves the hold; the re-run completes and clears it without rebuilding", async () => {
  const { m, s, install } = await fresh();
  edit(s, "store.js", T_LATER);
  const { buildManifest } = await M();
  const probe = clone(m), trace = [];
  await install(RT.makeRuntime(probe, { after: (c) => trace.push({ n: c.n, current: c.current }) }), o(probe, s));
  const K = trace.find((t) => t.current === `gen/${buildManifest(s).id}`).n;
  const c = clone(m);
  await assert.rejects(install(RT.makeRuntime(c, { kill: K + 2 }), o(c, s)), /killed/);
  assert.equal(curId(c), buildManifest(s).id);
  assert.equal((await newest(c)).record.state, "held");
  const rt = RT.makeRuntime(c);
  const res = await install(rt, o(c, s, { holdEnv: DEAD }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(noWrites(rt).length, 0, "nothing is rebuilt");
  assert.equal((await newest(c)).record.state, "cleared");
});

test("review 7: the publish step is ONE rename: a failure at that point leaves no non-stage generation dir (and none without MANIFEST.json); an existing id is refused untouched", async () => {
  const { PUBLISH_PY } = await M();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pub-")));
  cleanup.push(root);
  const gen = join(root, "gen");
  mkdirSync(join(gen, ".stage-1"), { recursive: true });
  writeFileSync(join(gen, ".stage-1/MANIFEST.json"), "{}");
  const script = join(root, "publish.py");
  writeFileSync(script, PUBLISH_PY);
  const run = (pre) => spawnSync("python3", ["-c", `import os, runpy, sys\n${pre}\nrunpy.run_path(${JSON.stringify(script)}, run_name="__main__")`, join(gen, ".stage-1"), join(gen, "abc")], { encoding: "utf8" });
  // the barrier: the rename itself fails (or the process dies) right where the old mkdir+rename pair left an empty reservation
  const hit = run('def boom(*a, **k): raise OSError("killed at the publish barrier")\nos.rename = boom\nos.mkdir = boom');
  assert.notEqual(hit.status, 0);
  assert.deepEqual(readdirSync(gen).sort(), [".stage-1"], "no generation dir exists without its MANIFEST.json");
  // an id that already exists is refused (exit 3) and left as it is
  mkdirSync(join(gen, "abc"));
  writeFileSync(join(gen, "abc/keep"), "x");
  const dup = run("");
  assert.equal(dup.status, 3);
  assert.deepEqual(readdirSync(join(gen, "abc")), ["keep"]);
  assert.ok(existsSync(join(gen, ".stage-1/MANIFEST.json")), "the stage is untouched: a re-run starts from a fresh stage");
  // and when nothing is in the way, one rename publishes the whole dir
  rmSync(join(gen, "abc"), { recursive: true });
  assert.equal(run("").status, 0);
  assert.deepEqual(readdirSync(gen).sort(), ["abc"]);
  assert.ok(existsSync(join(gen, "abc/MANIFEST.json")));
});

// ====================================================================================================== review round 2
test("review N1: an existing installation whose stamp is invalid or missing is NOT treated as fresh: no-force install refuses and the remote edit survives; --force installs", async () => {
  const { m, s, install } = await fresh();
  const { check, doctor } = await M();
  const stampPath = join(m.home, CURRENT, "MANIFEST.json");
  const good = readFileSync(stampPath, "utf8");
  const edited = `${readFileSync(join(m.home, CURRENT, "store.js"), "utf8")}\n// a private customization\n`;
  const damage = {
    "an unrelated entry removed": () => { const st = JSON.parse(good); st.files = st.files.filter((f) => f.path !== "sources.js"); writeFileSync(stampPath, JSON.stringify(st)); },
    "the stamp missing": () => rmSync(stampPath),
  };
  for (const [label, hurt] of Object.entries(damage)) {
    writeFileSync(stampPath, good);
    writeFileSync(join(m.home, CURRENT, "store.js"), edited);
    hurt();
    const holds = holdFiles(m).length, snap = RT.snapshot(m.home);
    const rt = RT.makeRuntime(m);
    const res = await install(rt, o(m, s));
    assert.equal(res.ok, false, label);
    assert.equal(res.code, "E_STAMP_INVALID", label);
    assert.match(res.message, /--force/, label);
    assert.equal(noWrites(rt).length, 0, label);
    assert.deepEqual(RT.snapshot(m.home), snap, `${label}: nothing on the remote changed`);
    assert.equal(readFileSync(join(m.home, CURRENT, "store.js"), "utf8"), edited, `${label}: the edit survives`);
    assert.equal(holdFiles(m).length, holds, `${label}: no hold was taken`);
    assert.equal((await check(RT.makeRuntime(m), o(m, s))).exitCode, 1, label);
    assert.equal((await doctor(RT.makeRuntime(m), o(m, s))).checks.find((c) => c.id === "current").status, "FAIL", label);
    const forced = await install(RT.makeRuntime(m), o(m, s, { force: true }));
    assert.equal(forced.ok, true, `${label}: ${JSON.stringify(forced)}`);
    assert.equal(readFileSync(join(m.home, CURRENT, "store.js"), "utf8"), readFileSync(join(s, "store.js"), "utf8"), `${label}: --force replaced it`);
  }
});

test("review N1: a machine that was never installed, and one interrupted before its first switch (generations but no current), is still a fresh install", async () => {
  const m = machine(), s = source();
  dateAll(s, T_NEW);
  const { install } = await M();
  const probe = clone(m);
  const clean = RT.makeRuntime(probe, { after: (c) => c });
  await install(clean, o(probe, s));
  const killAt = clean.calls.find((c) => c.current).n; // the switch
  await assert.rejects(install(RT.makeRuntime(m, { kill: killAt }), o(m, s)), /killed/);
  assert.equal(RT.currentOf(m.home), null);
  assert.ok(RT.genDirs(m.home).some((d) => !d.startsWith(".")), "a published generation exists, current does not");
  const res = await install(RT.makeRuntime(m), o(m, s, { holdEnv: DEAD }));
  assert.equal(res.ok, true, JSON.stringify(res));
});
