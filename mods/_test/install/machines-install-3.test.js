// Part 3 of 3 of the `drover machines install` tests (split from machines-install.test.js by measured weight; the shared fixture is machines-install-fixture.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, symlinkSync, realpathSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RT, GENERIC_LEAKS, wholeWord, runtimePrivateWords, SHARE, GEN, CURRENT, REPO, TASKS, FINDER, CLI, M, T_NEW, T_LATER, cleanup, machine, clone, source, dateAll, edit, o, holdDir, holdFiles, noWrites, noTilde, manifestOf, curId, fresh, finder, line, forEachPoint, killSet, newest, DEAD } from "../machines-install-fixture.js";

test("finder: platform fixtures. No hasher at all, no timeout(1): exit 0 and no hasher line; shasum only: hasher=shasum; sha256sum only: hasher=sha256sum", () => {
  const none = finder(machine({ hasher: "none", timeout: false }));
  assert.equal(none.code, 0, "a machine without a hasher must not make the finder fail");
  assert.doesNotMatch(none.out, /^hasher=/m);
  assert.match(none.out, /^node /m);
  assert.match(line(finder(machine({ hasher: "shasum" })).out, /^hasher=/), /^hasher=shasum$/);
  assert.match(line(finder(machine({ hasher: "sha256sum" })).out, /^hasher=/), /^hasher=sha256sum$/);
});

test("the new files name no machine, no home path, no display manager, and send no ~ (leak check)", () => {
  const code = ["mods/_lib/machines.js", "mods/drover-tasks/machines.js", "mods/_lib/hold.js", "mods/drover-tasks/hold.js", "mods/_lib/publish.js", "mods/drover-tasks/publish.js", "mods/drover-tasks/bin/drover-machines.mjs", "mods/drover-tasks/bin/find-runtime.sh"];
  const all = [...code, "docs/guides/machines.md"];
  const copies = readFileSync(join(REPO, "mods/_lib/copies.txt"), "utf8").split("\n").map((l) => l.trim());
  for (const f of ["machines.js", "hold.js", "publish.js"]) assert.ok(copies.includes(f), `${f} is copied into drover-tasks through _lib/copies.txt`);
  for (const rel of all) {
    assert.ok(existsSync(join(REPO, rel)), `${rel} exists`);
    const text = readFileSync(join(REPO, rel), "utf8");
    assert.doesNotMatch(text, GENERIC_LEAKS, rel);
    for (const w of runtimePrivateWords()) assert.ok(!wholeWord(text, w), `${rel}: names a private word (a user, host or machine name)`);
  }
  for (const rel of code) {
    const body = readFileSync(join(REPO, rel), "utf8").split("\n").filter((l) => !/^\s*(\/\/|#)/.test(l)).join("\n");
    assert.doesNotMatch(body, /(^|[\s"'=:(`])~\//m, `${rel}: ~ is not expanded by hc; use the home the finder prints`);
  }
});

test("install: the generation is staged, MANIFEST.json is written last, and the published dir appears complete in one step", async () => {
  const m = machine(), s = source();
  dateAll(s, T_NEW);
  const seen = [];
  const rt = RT.makeRuntime(m, { after: (c) => { for (const d of RT.genDirs(m.home)) if (!d.startsWith(".")) seen.push({ n: c.n, d, complete: existsSync(join(m.home, GEN, d, "MANIFEST.json")) }); } });
  const { install, buildManifest } = await M();
  const res = await install(rt, o(m, s));
  assert.equal(res.ok, true);
  const writes = noWrites(rt);
  assert.match(writes.at(-1).path, new RegExp(`${GEN.replace(/\./g, "\\.")}/\\.stage-[^/]+/MANIFEST\\.json$`), "MANIFEST.json is the LAST write, in the stage dir");
  assert.ok(writes.slice(0, -1).every((w) => /\/\.stage-[^/]+\//.test(w.path)), "every file is written into a stage dir, never into a published one");
  assert.ok(seen.length > 0 && seen.every((x) => x.complete), "a published generation dir is never seen without its MANIFEST.json");
  assert.ok(seen[0].n > writes.at(-1).n, "no published dir before the stage was complete (MANIFEST.json written)");
  assert.equal(seen[0].d, buildManifest(s).id);
});

test("install: the activation is two calls (temp link, then replace); a kill between them leaves `current` as it was", async () => {
  const { m, s, install } = await fresh();
  edit(s, "store.js", T_LATER);
  const before = RT.currentOf(m.home);
  const links = [];
  const probe = RT.makeRuntime(clone(m), { after: (c, mm) => links.push({ n: c.n, current: c.current, links: RT.symlinks(mm.home) }) });
  await install(probe, o(probe.machine, s));
  const K = links.find((x) => x.current !== before).n; // the call whose end shows the new current
  assert.ok(K >= 2, "the switch is not the only call");
  const tmp = links.find((x) => x.n === K - 1).links.filter((l) => !links.find((y) => y.n === K).links.includes(l));
  assert.ok(tmp.some((l) => l !== CURRENT && l.startsWith(SHARE)), "the call before the switch creates a temp link next to `current`, which the switch then renames away");
  assert.equal(links.find((x) => x.n === K - 1).current, before, "creating the temp link does not change `current`");
  const killed = clone(m);
  await assert.rejects(install(RT.makeRuntime(killed, { kill: K }), o(killed, s)), /killed/);
  assert.equal(RT.currentOf(killed.home), before);
});

test("install: a home with spaces and an apostrophe works end to end", async () => {
  const { m, s, rt, res } = await fresh({}, { homeName: "my home's dir" });
  assert.equal(res.ok, true, JSON.stringify(res));
  const { doctor, check } = await M();
  assert.equal((await doctor(RT.makeRuntime(m), o(m, s))).ok, true);
  assert.equal((await check(RT.makeRuntime(m), o(m, s))).exitCode, 0);
  assert.equal(RT.cliProjects(m).code, 0);
  noTilde(rt);
});

test("install: a configured node dir (nodeDir) beats the manager and is the node recorded in the stamp", async () => {
  const m = machine(), s = source();
  dateAll(s, T_NEW);
  const dir = join(m.home, "custom/bin");
  m.nodeWrapper(join(dir, "node"));
  const { install } = await M();
  const res = await install(RT.makeRuntime(m), o(m, s, { nodeDir: dir }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(manifestOf(m).node, join(dir, "node"));
});

test("install: damage that leaves the bytes equal (a mode) is not a no-op: it is repaired", async () => {
  const { m, s, install } = await fresh();
  const id = curId(m);
  chmodSync(join(m.home, CURRENT, "bin/drover"), 0o644);
  const rt = RT.makeRuntime(m);
  const res = await install(rt, o(m, s));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.notEqual(res.noop, true);
  assert.equal(RT.modeOf(join(m.home, CURRENT, "bin/drover")), "755");
  assert.ok(curId(m).startsWith(id), "same content id, a fresh dir (the damaged one is never rewritten)");
  assert.equal((await (await M()).doctor(RT.makeRuntime(m), o(m, s))).ok, true);
});

test("every test argv runs on the remote: once in the install's verify step (before the switch), once per doctor", async () => {
  const { m, s, rt } = await fresh();
  const { buildManifest, doctor } = await M();
  const stamp = manifestOf(m);
  const home = m.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const norm = (argv) => argv.map((a) => a.replace(new RegExp(`^${home}/\\.local/share/drover-herdr/(?:gen/[^/]+|current)`), "{gen}"));
  const want = buildManifest(s).files.map((f) => ({ path: f.path, argv: f.test.map((a) => a.replace("{node}", stamp.node).replace("{python3}", stamp.python3)) }));
  const count = (calls, argv) => calls.filter((c) => c.kind === "exec" && JSON.stringify(norm(c.argv)) === JSON.stringify(argv)).length;
  const K = rt.calls.find((c) => c.current === `gen/${stamp.id}`).n;
  const pre = rt.calls.filter((c) => c.n < K);
  for (const w of want) assert.equal(count(pre, w.argv), 1, `${w.path}: its test argv ran once on the remote before activation`);
  const d = RT.makeRuntime(m);
  await doctor(d, o(m, s));
  for (const w of want) assert.equal(count(d.calls, w.argv), 1, `${w.path}: doctor runs its test argv once`);
  assert.ok(d.calls.every((c) => c.kind === "exec"), "doctor writes nothing");
});

test("the `machines` verb reaches bin/drover-machines.mjs through a symlink, from an unrelated cwd", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mlink-")));
  cleanup.push(dir);
  mkdirSync(join(dir, "elsewhere"));
  symlinkSync(CLI, join(dir, "drover"));
  const r = spawnSync("bash", [join(dir, "drover"), "machines", "--help"], { cwd: join(dir, "elsewhere"), encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: join(dir, "app") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^usage: drover machines install\|check\|doctor <machine> \[--force\]/m);
});

test("hold: a no-op re-run writes no hold and no remote file", async () => {
  const { m, s, install } = await fresh();
  const files = holdFiles(m);
  const rt = RT.makeRuntime(m);
  const res = await install(rt, o(m, s));
  assert.equal(res.noop, true);
  assert.deepEqual(holdFiles(m), files);
  assert.equal(noWrites(rt).length, 0);
});

test("hold: install killed at runner calls keeps the hold from the moment it was taken, names the target, and pushes nothing to a second machine; a re-run completes and clears it", async () => {
  const { m: base, s, install } = await fresh();
  edit(s, "store.js", T_LATER);
  const { doctor, buildManifest } = await M();
  const probe = clone(base);
  const trace = [];
  const clean = RT.makeRuntime(probe, { after: async (c) => trace.push({ n: c.n, hold: (await newest(probe))?.record?.state ?? null }) });
  await install(clean, o(probe, s));
  const firstHeld = trace.find((t) => t.hold === "held").n; // the hold was taken between call firstHeld-1 and call firstHeld
  assert.ok(firstHeld >= 2, "the read-only probe comes first");
  const target = buildManifest(s).id;
  await forEachPoint(killSet(clean.calls.length, firstHeld), async (n) => {
    const c = clone(base);
    const before = holdFiles(c).length;
    await assert.rejects(install(RT.makeRuntime(c, { kill: n }), o(c, s)), /killed/, `kill ${n}`);
    const r = await newest(c);
    if (n < firstHeld) assert.equal(holdFiles(c).length, before, `kill ${n}: a kill before the hold was taken leaves no new record`);
    else {
      assert.equal(r.record.state, "held", `kill ${n}: the hold stays`);
      assert.equal(r.record.target, target, `kill ${n}`);
      assert.equal(r.record.machine, base.name);
      const other = machine({ name: "m2" });
      const rt2 = RT.makeRuntime(other);
      const refused = await install(rt2, o(other, s, { appHome: c.appHome }));
      assert.equal(refused.ok, false, `kill ${n}`);
      assert.match(refused.message, /held/i);
      assert.equal(rt2.calls.length, 0, `kill ${n}: a second machine receives zero calls while the hold stands`);
    }
    const res = await install(RT.makeRuntime(c), o(c, s, { holdEnv: DEAD }));
    assert.equal(res.ok, true, `rerun after kill ${n}: ${JSON.stringify(res)}`);
    assert.equal((await newest(c)).record.state, "cleared", `rerun after kill ${n} clears the hold`);
    assert.equal(curId(c), target);
    assert.equal((await doctor(RT.makeRuntime(c), o(c, s))).ok, true);
  });
});

test("hold: while one installer holds, a second installer (live owner) stops with `held`, for the same machine and for another one", async () => {
  const m = machine(), s = source();
  dateAll(s, T_NEW);
  const { install } = await M();
  const other = machine({ name: "m2" });
  let second = null, third = null, rt2 = null, rt3 = null;
  const rt = RT.makeRuntime(m, { after: async (c) => {
    if (c.n !== 4) return;
    rt2 = RT.makeRuntime(m); // the same machine, another installer process
    second = await install(rt2, o(m, s));
    rt3 = RT.makeRuntime(other);
    third = await install(rt3, o(other, s, { appHome: m.appHome }));
  } });
  const first = await install(rt, o(m, s));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, false);
  assert.match(second.message, /held/i);
  assert.equal(noWrites(rt2).length, 0, "the second installer on the same machine pushes nothing");
  assert.equal(third.ok, false);
  assert.match(third.message, /held/i);
  assert.equal(rt3.calls.length, 0, "the other machine gets zero calls");
  assert.equal(curId(other), null);
});

test("hold: `drover machines hold clear --reason <text>` appends a cleared record with reason manual and deletes nothing", async () => {
  const m = machine();
  const dir = holdDir(m);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hold.1.json"), JSON.stringify({ n: 1, state: "held", machine: "m1", token: "t", pid: 1, host: "some-other-host", target: "abc", since: "2026-01-01T00:00:00.000Z" }));
  const r = spawnSync("bash", [CLI, "machines", "hold", "clear", "--reason", "link gone for good"], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: m.appHome } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(holdFiles(m), ["hold.1.json", "hold.2.json"]);
  const rec = JSON.parse(readFileSync(join(dir, "hold.2.json"), "utf8"));
  assert.equal(rec.state, "cleared");
  assert.equal(rec.reason, "manual");
  assert.match(rec.note, /link gone for good/);
  assert.equal(JSON.parse(readFileSync(join(dir, "hold.1.json"), "utf8")).state, "held", "the old record is untouched");
  const again = spawnSync("bash", [CLI, "machines", "hold", "clear"], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: m.appHome } });
  assert.notEqual(again.status, 0, "a reason is required");
});

test("review 5: doctor on an offline machine (no finder output) returns FAIL checks in the agreed grammar, through doctor and through the CLI; it never throws", async () => {
  const { doctor, formatDoctor } = await M();
  const offline = { calls: [], exec: async () => ({ code: 1, stdout: "", stderr: "offline" }), write: async () => { throw new Error("no writes"); }, link: async () => ({ ok: false, detail: "m1 is disconnected" }) };
  const d = await doctor(offline, { machine: "m1", srcRoot: TASKS, appHome: machine().appHome });
  assert.equal(d.ok, false);
  assert.equal(d.exitCode, 1);
  assert.ok(d.checks.length >= 4 && d.checks.every((c) => ["ok", "FAIL", "WARN", "skip"].includes(c.status)));
  assert.equal(d.checks.find((c) => c.id === "link").status, "FAIL");
  assert.match(formatDoctor(d, { machine: "m1" }), /^doctor: \d+ ok, \d+ warn, [1-9]\d* fail$/m);
  const { main } = await import("../../drover-tasks/bin/drover-machines.mjs");
  const app = machine().appHome;
  const prev = process.env.HERDR_APP_HOME;
  process.env.HERDR_APP_HOME = app;
  try {
    for (const json of [false, true]) {
      let out = "", err = "";
      const code = await main(["doctor", "m1", ...(json ? ["--json"] : [])], { runtime: offline, out: (x) => { out += x; }, err: (x) => { err += x; } });
      assert.equal(code, 1, err);
      if (json) { const j = JSON.parse(out); assert.equal(j.ok, false); assert.ok(j.checks.some((c) => c.status === "FAIL")); }
      else { assert.match(out, /^FAIL  m1:[a-z0-9-]+  /m); assert.match(out, /^doctor: /m); }
    }
  } finally { if (prev === undefined) delete process.env.HERDR_APP_HOME; else process.env.HERDR_APP_HOME = prev; }
});

test("review N2: when secure temp creation fails the finder reports E_TEMP_FAILED (exit 0) and never opens a predictable fallback path", () => {
  const m = machine({ mktemp: "fail" });
  const tmp = join(m.root, "tmp"), victim = join(m.root, "victim");
  mkdirSync(tmp);
  writeFileSync(victim, "KEEP ME");
  // plant a symlink at the old fallback name of the very shell that runs the finder ($$ survives the exec)
  const r = spawnSync("/bin/sh", ["-c", 'ln -s "$VICTIM" "$TMPDIR/drover-find.$$"; exec /bin/sh -s'], { cwd: m.home, env: { ...m.env, TMPDIR: tmp, VICTIM: victim }, input: readFileSync(FINDER, "utf8"), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^E_TEMP_FAILED$/m);
  assert.doesNotMatch(r.stdout, /^node |^python3 /m, "no runtime is reported from a probe that could not run safely");
  assert.equal(readFileSync(victim, "utf8"), "KEEP ME", "the symlink target was never opened");
});
