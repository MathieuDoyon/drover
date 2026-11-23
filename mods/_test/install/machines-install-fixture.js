// `drover machines install|check|doctor` (T-MWO2HDRQFIP, A2): the CLI and its helpers are copied to a linked machine as ONE complete generation,
// checked, then switched in atomically. Tests only, written before the code: each one fails today because the module, the finder and the verb do not exist.
// Sync-hold behaviour (hold files, pushGuard, doctor clearing the hold) is NOT here: it is the next job and has its own file of cases.
//
// Contract these tests fix (the names the implementation must have):
//   mods/_lib/machines.js (pure; copied to mods/drover-tasks/machines.js through _lib/copies.txt) exports
//     SHIPPED            the 21 relative paths (the plan's 13, plus hold.js and publish.js that machines.js imports, plus the 3 headless writer files and remote.js (its ownership check)) under mods/drover-tasks that are copied
//     buildManifest(srcRoot) -> { id, files: [{ path, sha256, mode: "755"|"644", sourceTime: <mtime ms>, test: [argv with {gen} {node} {python3}] }] }
//     generationId(files) -> hash of the sorted "path sha mode" lines (what buildManifest().id is)
//     expandTest(argv, { gen, node, python3 })
//     classify(entry, remote) -> current | update | new | edited-remote | newer-remote | missing
//       remote = null (never installed) or { present, sha, stampSha, stampKept, stampSourceTime }
//     install(rt, { machine, srcRoot, force, nodeDir })  -> { ok, code, noop, gen, path, files: [{ path, state }] }   (a kill = the rt throws: install rejects)
//     check(rt, { machine, srcRoot })                    -> { exitCode, files: [{ path, state }] }                    (read-only)
//     doctor(rt, { machine, srcRoot })                   -> { ok, checks: [{ id, status: ok|warn|FAIL|skip }] }
//   rt = { exec(machine, argv, { stdin, timeout }) -> { code, stdout, stderr }, write(machine, path, text) }; paths are relative to the remote home.
//   Remote layout: .local/share/drover-herdr/gen/<id>/ (+ MANIFEST.json = { id, node, python3, files: [{ path, sha256, mode, sourceTime, kept }] }),
//     .local/share/drover-herdr/current -> gen/<id>, .local/bin/drover = immutable launcher script. Stage dirs: gen/.stage-<nonce>.
//   mods/drover-tasks/bin/find-runtime.sh: run as `sh -s -- [<configured node dir>]` with the script on stdin. Stdout lines:
//     home=<pwd -P>  node tier=<path|configured|manager> path=<abs> version=<v>  python3 tier=… path=… version=…  hasher=<sha256sum|shasum>
//     or E_NODE_NOT_FOUND / E_PYTHON_NOT_FOUND. Exit status is always 0. DROVER_FIND_SYSTEM_DIRS (colon list) replaces the built-in common install locations.
// Shared fixture for the machines-install-N.test.js files (split from machines-install.test.js so the parallel runner spreads them; test bodies unchanged).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, utimesSync, existsSync, readdirSync, rmSync, chmodSync, mkdirSync, symlinkSync, statSync, realpathSync, mkdtempSync, readlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, userInfo, hostname } from "node:os";

const { until } = await import(new URL("../stubs/until.js", import.meta.url).href);
const RT = await import(new URL("./stubs/machine-rt.js", import.meta.url).href);
const { GENERIC_LEAKS, privateWords, wholeWord, runtimePrivateWords } = await import(new URL("../private-words.js", import.meta.url).href); // shared with shipped-generic.test.js
const { SHARE, GEN, CURRENT, ENTRY } = RT;
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const TASKS = join(REPO, "mods/drover-tasks");
const FINDER = join(TASKS, "bin/find-runtime.sh");
const CLI = join(TASKS, "bin/drover");
const M = () => import("../../_lib/machines.js"); // loaded inside each test, so a missing module fails that test, not the whole file
const SHIPPED = ["bin/drover", "bin/drover-export.mjs", "bin/drover-machines.mjs", "bin/find-runtime.sh", "bin/drover-headless", "bin/drover-headless.mjs", "bin/drover-asks-check.mjs", "bin/drover-asks-install.mjs", "bin/asks-lib.mjs", "headless-board.js", "remote.js", "machines.js", "herd-export.js", "runs.js", "store.js", "config.js", "config-schema.js", "lessons.js", "workfolder.js", "sources.js", "hold.js", "publish.js", "bin/drover-health.py", "bin/drover-line.mjs", "runline.js", "evidence.js"];
const T_OLD = Date.UTC(2026, 0, 1), T_NEW = Date.UTC(2026, 0, 2), T_LATER = Date.UTC(2026, 0, 3);
const cleanup = [];
// Children a test spawned (own process group each). A test that throws never reaches its own release/kill, and the temp dirs below hold the PATH the child's `sleep` needs:
// removed first, a polling shim would spin. So afterEach kills the groups and waits for every close BEFORE it removes the dirs.
const children = [];
function spawnTracked(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { ...opts, detached: true });
  const closed = new Promise((r) => { child.once("close", r); child.once("error", r); });
  children.push({ child, closed });
  return child;
}
async function reapChildren() {
  const list = children.splice(0);
  for (const { child } of list) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } // ESRCH: already gone; no pid: it never started
  await Promise.all(list.map(({ closed }) => closed));
}
afterEach(async () => { await reapChildren(); for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });
const machine = (o) => { const m = RT.makeMachine(o); cleanup.push(m.root); return m; };
const clone = (m) => { const c = RT.cloneMachine(m); cleanup.push(c.root); return c; };
const source = () => { const s = RT.copySource(TASKS); cleanup.push(s); return s; };
const redate = (root, rel, ms) => utimesSync(join(root, rel), ms / 1000, ms / 1000);
const dateAll = (root, ms) => { for (const rel of SHIPPED) if (existsSync(join(root, rel))) redate(root, rel, ms); };
const edit = (root, rel, ms) => { appendFileSync(join(root, rel), `\n// edited ${ms}\n`); redate(root, rel, ms); };
const o = (m, srcRoot, extra = {}) => ({ machine: m.name, srcRoot, appHome: m.appHome, ...extra }); // the one place install options are built (the laptop app home holds the sync hold)
const H = () => import("../../_lib/hold.js");
const holdDir = (m) => join(m.appHome, "data/drover-sync-hold");
const holdOf = async (m, env = {}) => (await H()).createHold({ dir: holdDir(m), ...env });
const holdFiles = (m) => (existsSync(holdDir(m)) ? readdirSync(holdDir(m)).sort() : []);
const states = (res) => Object.fromEntries(res.files.map((f) => [f.path, f.state]));
const noWrites = (rt) => rt.calls.filter((c) => c.kind === "write");
const noTilde = (rt) => { for (const c of rt.calls) for (const a of c.kind === "exec" ? c.argv : [c.path]) assert.doesNotMatch(a, /(^|\/)~/, `~ sent to the remote: ${a}`); };
const manifestOf = (m, rel = CURRENT) => JSON.parse(readFileSync(join(m.home, rel, "MANIFEST.json"), "utf8"));
const curId = (m) => RT.currentOf(m.home)?.split("/").pop() ?? null;
const sha = (text) => spawnSync("shasum", ["-a", "256"], { input: text, encoding: "utf8" }).stdout.split(" ")[0];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex"); // in process: assertSane runs per kill point, 15 shasum spawns each were most of its cost
async function fresh(extra = {}, mo = {}) {
  const m = machine(mo), s = source();
  dateAll(s, T_NEW);
  const rt = RT.makeRuntime(m, extra);
  const { install } = await M();
  const res = await install(rt, o(m, s));
  return { m, s, rt, res, install };
}
// Run the finder like `hc exec --on <m> --stdin -- sh -s` does: the script on stdin, the fixture's environment, no shell, no ~ expansion.
const finder = (m, args = []) => {
  const r = spawnSync("/bin/sh", ["-s", "--", ...args], { cwd: m.home, env: m.env, input: readFileSync(FINDER, "utf8"), encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const line = (out, re) => out.split("\n").find((l) => re.test(l));
// A SAMPLE of the kill points (the first calls, around the hold and the switch, the last calls, and every 4th call in between): each call costs a process
// on this computer, and the full sweep made the suite minutes long. The sample does not prove that every window is safe. The windows that matter are named in
// the phase-boundary test below (a kill at the edge of each step of an install), and the publisher's own inside-the-call window has its own test.
// Runs fn(point) for every point with at most `limit` in flight (each point owns its own clone, so they cannot touch one another). After the first failure nothing
// new is started; every started worker is awaited (a point still running must not outlive the test and write into a cleaned-up clone); then the failure of the
// lowest point in `points` order is thrown. Every point still gets every assertion: this changes when points run, never which.
async function forEachPoint(points, fn, limit = 4) {
  const failures = new Map();
  let next = 0, failed = false;
  const worker = async () => {
    while (!failed && next < points.length) {
      const i = next++;
      try { await fn(points[i]); } catch (e) { failed = true; failures.set(i, e); }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(limit, points.length) }, worker));
  if (failures.size) throw failures.get(Math.min(...failures.keys()));
}
const deferred = () => { let resolve; const promise = new Promise((a) => { resolve = a; }); return { promise, resolve }; };
const drainTicks = async (ticks = 20) => { for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r)); };
const killSet = (total, ...marks) => Array.from({ length: total }, (_, i) => i + 1).filter((n) => n <= 4 || n >= total - 3 || n % 4 === 0 || marks.some((k) => Math.abs(n - k) <= 1));
// One scenario, every kill point.
async function killPoints(prepared, srcRoot, install) {
  const before = RT.currentOf(prepared.home);
  const trace = [];
  const probe = clone(prepared);
  const clean = RT.makeRuntime(probe, { after: (c) => trace.push({ n: c.n, current: c.current }) });
  await install(clean, o(probe, srcRoot));
  const K = trace.find((t) => t.current !== before).n;
  const target = trace.at(-1).current;
  return { total: clean.calls.length, K, before, target };
}
function assertSane(m, label) {
  for (const d of RT.genDirs(m.home).filter((x) => !x.startsWith("."))) {
    assert.ok(existsSync(join(m.home, GEN, d, "MANIFEST.json")), `${label}: published gen ${d} has no MANIFEST.json`);
    const man = JSON.parse(readFileSync(join(m.home, GEN, d, "MANIFEST.json"), "utf8"));
    for (const f of man.files) assert.equal(sha256(readFileSync(join(m.home, GEN, d, f.path))), f.sha256, `${label}: ${d}/${f.path} is not what its manifest says`);
  }
}
// ====================================================================================================== the sync hold (job 2)
// data/drover-sync-hold/hold.<n>.json, append-only (see hold.test.js for the record protocol itself). Here: how install and doctor use it.
const newest = async (m, env) => (await holdOf(m, env)).read();
const DEAD = { alive: () => false }; // the owner of the hold is gone (a killed installer): the test process is the "owner" and is alive, so a resume needs this
// ====================================================================================================== review round 1
const fileStates = (res) => Object.fromEntries(res.files.map((f) => [f.path, f.state]));
const stampOf = (m, path) => manifestOf(m).files.find((f) => f.path === path);

export { spawnTracked, reapChildren, until, RT, GENERIC_LEAKS, privateWords, wholeWord, runtimePrivateWords, SHARE, GEN, CURRENT, ENTRY, REPO, TASKS, FINDER, CLI, M, SHIPPED, T_OLD, T_NEW, T_LATER, cleanup, machine, clone, source, redate, dateAll, edit, o, H, holdDir, holdOf, holdFiles, states, noWrites, noTilde, manifestOf, curId, sha, sha256, fresh, finder, line, forEachPoint, deferred, drainTicks, killSet, killPoints, assertSane, newest, DEAD, fileStates, stampOf };
