// T-MWO2HH3HOAU: the class proof for install.sh. A PATH shim counts every mv/ln/rm/cp/mkdir/rmdir the installer runs; for each call, one run FAILS it (the command does
// nothing and returns 1) and one KILLS the installer with -9 right after it. After each faulted run the test plays the owner: every object (the managed copy, its .new,
// the home links) is set to every value it ever held plus one fresh value, the source moves to fresh bytes, and the installer runs again with no fault. The one assertion:
// the object still holds the owner's value and the run exits 1. Allowed replacements: a value equal to the new incoming copy / link target, or equal to what the
// installer itself last put there (learned by comparing the object before and after each installer run, never from the installer's records).
// Temp homes and a minimal fixture only (one _lib file, one mod, one layout); herdr-app is stubbed. No sleeps, no tick counts: every run is awaited.
// SWEEP_INSTALL_SH=<file> runs the sweep against another version of install.sh (the red control).
//
// WHAT THIS DOES NOT COVER (stated blind spots; do not read a green sweep as "every stop point of every write"):
// - Shell builtins are not counted: the printf redirections in put_str/link_set and the final lib-stamp write open, truncate and write without any mv/ln/rm/cp/mkdir/rmdir
//   call. Their later publishing mv IS counted, their own stop points are not. An absolute-path cp/mv, `install`, `sed -i` or another writer added to install.sh later
//   bypasses the PATH shims until this file lists it.
// - "fail" means the command does nothing and returns 1; "kill" means the whole command ran and the installer died right after it. No partial writes, no kill in the
//   middle of one command, no read failures in cmp/git/awk, no concurrent owner or editor writes (the hook tests B6-13*, F1, G1 cover those axes separately).
// - K (the number of fault points) is measured on one normal path per scenario; the owner's replay run has no fault. Calls reachable only on other error branches,
//   a second failure during recovery, no-git / no-hasher / missing-query variants and two installers at once are not swept. The fixture has one shared file.
// - Values are observed at whole-run boundaries only: transient values and absence are not owner byte values, and the faulted runs themselves are not subject to the
//   final assertion. Lock cleanup after a kill is done by the test, so lock release is not proved here.
// - The sweep never reads the installer's records: the owner objects are the managed copy, its .new, and the two home links; the state snapshot used to replay each owner
//   case is a blind byte copy of the whole fixture.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, rmSync, existsSync, symlinkSync, unlinkSync, cpSync, realpathSync, copyFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir, availableParallelism } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALL = process.env.SWEEP_INSTALL_SH || join(SRC, "install.sh");
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); made.push(d); return d; };
const which = (n) => spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }).stdout.trim();
const gitSync = (cwd, ...a) => { const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };

// herdr-app stub, and the counting shims (one script per tool, real tool path embedded)
const BIN = tmp("sweep-bin-");
writeFileSync(join(BIN, "herdr-app"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const SHIMS = tmp("sweep-shims-");
for (const t of ["mv", "ln", "rm", "cp", "mkdir", "rmdir"]) {
  writeFileSync(join(SHIMS, t), `#!/bin/bash
n=$(( $(cat "$SWEEP_CNT" 2>/dev/null || echo 0) + 1 )); echo $n > "$SWEEP_CNT"
if [ "$n" = "\${FAULT_AT:-0}" ]; then
  if [ "$FAULT_MODE" = fail ]; then exit 1; fi
  ${which(t)} "$@"; rc=$?; kill -9 "$(cat "$SWEEP_PID")"; exit $rc
fi
exec ${which(t)} "$@"
`, { mode: 0o755 });
}

// a minimal repo: one shared file, one mod, one layout; the installer under test is copied in and committed with it
function fixture() {
  const root = tmp("sweep-fx-"), repo = join(root, "repo"), mods = join(repo, "mods"), home = join(root, "home");
  mkdirSync(join(mods, "_lib"), { recursive: true }); mkdirSync(join(mods, "drover-x")); mkdirSync(join(mods, "_layouts"));
  mkdirSync(join(home, "mods"), { recursive: true }); mkdirSync(join(home, "layouts"));
  writeFileSync(join(mods, "_lib", "copies.txt"), "a.js\n");
  writeFileSync(join(mods, "_lib", "a.js"), "A\n"); writeFileSync(join(mods, "drover-x", "a.js"), "A\n"); writeFileSync(join(mods, "drover-x", "main.js"), "m\n");
  writeFileSync(join(mods, "_layouts", "drover.json"), "{}\n");
  copyFileSync(INSTALL, join(mods, "install.sh"));
  gitSync(repo, "init", "-q", "-b", "main"); gitSync(repo, "add", "-A"); gitSync(repo, "commit", "-q", "-m", "x");
  return { root, repo, mods, home };
}

// run the installer once (awaited). cwd = the mods folder to run in; fault = { at, mode } or none. Returns { status, signal, out, count }.
let seq = 0;
function install(fx, { cwd = fx.mods, args = [], env = {}, fault = null } = {}) {
  const id = ++seq, cnt = join(fx.root, `cnt-${id}`), pid = join(fx.root, `pid-${id}`);
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", `echo $$ > "${pid}"; exec bash install.sh "$@"`, "sh", ...args], {
      cwd, env: { ...process.env, HERDR_APP_HOME: fx.home, DROVER_SKIP_TESTS: "1", PATH: `${SHIMS}:${BIN}:${process.env.PATH}`, SWEEP_CNT: cnt, SWEEP_PID: pid, FAULT_AT: fault ? String(fault.at) : "0", FAULT_MODE: fault ? fault.mode : "", ...env },
    });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (status, signal) => {
      for (const l of [join(fx.mods, ".install.lock"), join(fx.home, ".drover-install.lock")]) rmSync(l, { recursive: true, force: true }); // a killed run leaves them; the docs say to remove them
      for (const wt of fx.wts || []) rmSync(join(wt, "mods", ".install.lock"), { recursive: true, force: true });
      resolve({ status, signal, out, count: existsSync(cnt) ? Number(readFileSync(cnt, "utf8")) : 0 });
    });
  });
}

const val = (p) => { try { const st = lstatSync(p); return st.isSymbolicLink() ? `->${readlinkSync(p)}` : st.isFile() ? readFileSync(p, "utf8") : "<other>"; } catch { return null; } };
// the four objects the owner can touch, in every scenario: the managed copy, its .new, and the two home links
const objects = (fx) => ({ copy: join(fx.mods, "drover-x", "a.js"), new: join(fx.mods, "drover-x", "a.js.new"), link: join(fx.home, "mods", "drover-x"), layout: join(fx.home, "layouts", "drover.json") });

// Tracks, per object: every value it held, and the value the installer last put there (a change seen across an installer run), per the rule in the header.
class Watch {
  constructor(paths) { this.paths = paths; this.prev = {}; this.put = {}; this.held = {}; for (const [k, p] of Object.entries(paths)) { const v = val(p); this.prev[k] = v; this.put[k] = v; this.held[k] = new Set([v]); } }
  afterInstall() { for (const [k, p] of Object.entries(this.paths)) { const v = val(p); if (v !== this.prev[k]) this.put[k] = v; this.prev[k] = v; this.held[k].add(v); } }
  afterOwner() { for (const [k, p] of Object.entries(this.paths)) { const v = val(p); this.prev[k] = v; this.held[k].add(v); } }
}

const owner = async (fx, w, fn) => { await fn(); w.afterOwner(); }; // an owner action: never a "put" by the installer
const ok = (r) => { assert.ok(r.status === 0 || r.status === 1, `the setup run failed: ${r.status} ${r.signal}\n${r.out}`); return r; };

// scenarios: setup() leaves the state to fault in; the faulted run is `faulted`; `final` = what the owner-play run does afterwards. All return { w, incoming }.
const FRESH = "OWNER-FRESH\n";
const scenarios = {
  replace: { kind: "copy", async setup(fx, w) { ok(await install(fx)); w.afterInstall(); writeFileSync(join(fx.mods, "_lib", "a.js"), "B\n"); }, final: "F\n" },
  first: { kind: "copy", async setup(fx) { writeFileSync(join(fx.mods, "_lib", "a.js"), "B\n"); }, final: "F\n" },
  kept: { kind: "copy", async setup(fx, w) { ok(await install(fx)); w.afterInstall(); await owner(fx, w, () => writeFileSync(join(fx.mods, "drover-x", "a.js"), "O\n")); ok(await install(fx)); w.afterInstall(); writeFileSync(join(fx.mods, "_lib", "a.js"), "B\n"); }, final: "F\n" },
  settled: { kind: "copy", async setup(fx, w) { ok(await install(fx)); w.afterInstall(); await owner(fx, w, () => writeFileSync(join(fx.mods, "drover-x", "a.js"), "O\n")); ok(await install(fx)); w.afterInstall(); await owner(fx, w, () => writeFileSync(join(fx.mods, "drover-x", "a.js"), "A\n")); }, final: "F\n" },
  create: { kind: "copy", async setup(fx, w) { ok(await install(fx)); w.afterInstall(); await owner(fx, w, () => unlinkSync(join(fx.mods, "drover-x", "a.js"))); writeFileSync(join(fx.mods, "_lib", "a.js"), "B\n"); }, final: "F\n" },
  repoint: { kind: "links", async setup(fx, w) { ok(await install(fx)); w.afterInstall(); const wt = join(fx.root, "wt"); gitSync(fx.repo, "worktree", "add", "-q", "-b", "feat", wt); fx.wts = [wt]; fx.run = { cwd: join(wt, "mods"), args: ["--from-worktree"] }; }, final: null },
  skip: { kind: "links", async setup(fx, w) { ok(await install(fx)); w.afterInstall(); fx.run = { env: { DROVER_SKIP_MODS: "drover-x" } }; }, final: null },
};

// What the final (unfaulted) run is, per object: the copy and its .new are decided by a run from the main checkout with the source moved to fresh bytes; the links by the
// scenario's own run (a worktree run, a skip run) or, in a copy scenario, by the main checkout. `want` = the target the final run would give the link (null = it removes it).
const finalRun = (fx, name, k) => ((k === "link" || k === "layout") && fx.run ? { ...fx.run, cwd: fx.run.cwd } : name === "skip" ? { env: { DROVER_SKIP_MODS: "drover-x" } } : {});
const wantOf = (fx, name, k) => {
  const base = { link: join(fx.mods, "drover-x"), layout: join(fx.mods, "_layouts", "drover.json") };
  if (name === "repoint") return { link: join(fx.wts[0], "mods", "drover-x"), layout: join(fx.wts[0], "mods", "_layouts", "drover.json") }[k];
  if (name === "skip" && k === "link") return null;
  return base[k];
};
function ownerCases(fx, name, w) {
  const out = [];
  for (const k of Object.keys(objects(fx))) {
    const isLink = k === "link" || k === "layout";
    const values = new Set([...w.held[k]].filter((v) => v !== null)); values.add(isLink ? `->${join(fx.root, "elsewhere")}` : FRESH);
    for (const v of values) {
      if (v === w.put[k]) continue; // the installer may replace what it last put there
      if (isLink ? v === (wantOf(fx, name, k) === null ? undefined : `->${wantOf(fx, name, k)}`) : v === FINAL) continue; // or a value equal to the new incoming copy / wanted target
      out.push({ k, v });
    }
  }
  return out;
}
const FINAL = "F\n";
const setObject = (p, v) => { rmSync(p, { recursive: true, force: true }); if (v.startsWith("->")) symlinkSync(v.slice(2), p); else writeFileSync(p, v); };
// a blind byte copy of the whole fixture and its restore in place (same absolute paths, so nothing inside needs rewriting)
const snapshot = (fx) => { const d = tmp("sweep-snap-"); cpSync(fx.root, d, { recursive: true, verbatimSymlinks: true }); return d; };
const restore = (fx, snap) => { for (const e of readdirSync(fx.root)) rmSync(join(fx.root, e), { recursive: true, force: true }); cpSync(snap, fx.root, { recursive: true, verbatimSymlinks: true }); };

async function pool(items, n, fn) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { for (let it = q.shift(); it; it = q.shift()) await fn(it); })); }

for (const name of Object.keys(scenarios)) {
  test(`sweep ${name}: no faulted run (fail or kill at any mv/ln/rm/cp/mkdir/rmdir) lets a later run replace an owner value of the copy, its .new or either link`, { timeout: 1_200_000 }, async () => {
    const sc = scenarios[name];
    const prep = async () => { const fx = fixture(); const w = new Watch(objects(fx)); await sc.setup(fx, w); return { fx, w }; };
    const run = (fx, fault) => install(fx, { ...(fx.run || {}), fault });
    const base = await prep(); const counted = await run(base.fx, null);
    rmSync(base.fx.root, { recursive: true, force: true });
    assert.ok(counted.count > 0, "the shims counted nothing");
    const K = counted.count;
    const failures = []; let faultedRuns = 0, ownerRuns = 0, cases = 0;
    const points = []; for (let at = 1; at <= K; at++) for (const mode of ["fail", "kill"]) points.push({ at, mode });
    await pool(points, Math.max(4, availableParallelism()), async ({ at, mode }) => {
      const { fx, w } = await prep();
      const r = await run(fx, { at, mode }); faultedRuns++;
      if (mode === "kill") assert.equal(r.signal, "SIGKILL", `point ${at}: the installer was not killed (${r.status})`);
      w.afterInstall();
      const todo = ownerCases(fx, name, w); cases += todo.length;
      const snap = todo.length ? snapshot(fx) : null;
      for (const c of todo) {
        restore(fx, snap);
        setObject(objects(fx)[c.k], c.v);
        writeFileSync(join(fx.mods, "_lib", "a.js"), FINAL); // the source advances for every replay, whatever object the owner touched
        const r2 = await install(fx, finalRun(fx, name, c.k)); ownerRuns++;
        const held = val(objects(fx)[c.k]);
        if (held !== c.v || r2.status !== 1) failures.push(`${name} ${mode}@${at} ${c.k}=${JSON.stringify(c.v)}: held ${JSON.stringify(held)} exit ${r2.status}\n${r2.out.split("\n").slice(0, 6).join("\n")}`);
      }
      if (snap) rmSync(snap, { recursive: true, force: true });
      rmSync(fx.root, { recursive: true, force: true });
    });
    const groups = {}; for (const f of failures) { const m = f.match(/^(\w+) (fail|kill)@(\d+) (\w+)=(.*?): held/); const g = m ? `${m[4]}=${m[5]}` : "?"; (groups[g] ??= []).push(`${m[2]}@${m[3]}`); }
    for (const [g, pts] of Object.entries(groups)) console.log(`# sweep ${name} owner value replaced or unreported: ${g} at ${pts.length} fault points, first ${pts.sort().slice(0, 4).join(" ")}`);
    console.log(`# sweep ${name}: ${K} fault points x 2 modes = ${faultedRuns} faulted runs, ${cases} owner cases, ${ownerRuns} owner runs, ${failures.length} failures`);
    assert.equal(failures.length, 0, `${failures.length} owner value(s) replaced or not reported:\n${failures.slice(0, 8).join("\n---\n")}`);
  });
}
