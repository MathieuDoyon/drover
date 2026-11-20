// `drover machines install|check|doctor` (T-MWO2HDRQFIP, A2): the CLI and its helpers are copied to a linked machine as ONE complete generation,
// checked, then switched in atomically. Tests only, written before the code: each one fails today because the module, the finder and the verb do not exist.
// Sync-hold behaviour (hold files, pushGuard, doctor clearing the hold) is NOT here: it is the next job and has its own file of cases.
//
// Contract these tests fix (the names the implementation must have):
//   mods/_lib/machines.js (pure; copied to mods/drover-tasks/machines.js through _lib/copies.txt) exports
//     SHIPPED            the 15 relative paths (the plan's 13, plus hold.js and publish.js that machines.js imports) under mods/drover-tasks that are copied
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
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync, utimesSync, existsSync, readdirSync, rmSync, chmodSync, mkdirSync, symlinkSync, statSync, realpathSync, mkdtempSync, readlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, userInfo, hostname } from "node:os";

const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const RT = await import(new URL("./stubs/machine-rt.js", import.meta.url).href);
const { SHARE, GEN, CURRENT, ENTRY } = RT;
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TASKS = join(REPO, "mods/drover-tasks");
const FINDER = join(TASKS, "bin/find-runtime.sh");
const CLI = join(TASKS, "bin/drover");
const M = () => import("../_lib/machines.js"); // loaded inside each test, so a missing module fails that test, not the whole file

const SHIPPED = ["bin/drover", "bin/drover-export.mjs", "bin/drover-machines.mjs", "bin/find-runtime.sh", "machines.js", "herd-export.js", "runs.js", "store.js", "config.js", "config-schema.js", "lessons.js", "workfolder.js", "sources.js", "hold.js", "publish.js"];
const T_OLD = Date.UTC(2026, 0, 1), T_NEW = Date.UTC(2026, 0, 2), T_LATER = Date.UTC(2026, 0, 3);

const cleanup = [];
afterEach(() => { for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });
const machine = (o) => { const m = RT.makeMachine(o); cleanup.push(m.root); return m; };
const clone = (m) => { const c = RT.cloneMachine(m); cleanup.push(c.root); return c; };
const source = () => { const s = RT.copySource(TASKS); cleanup.push(s); return s; };
const redate = (root, rel, ms) => utimesSync(join(root, rel), ms / 1000, ms / 1000);
const dateAll = (root, ms) => { for (const rel of SHIPPED) if (existsSync(join(root, rel))) redate(root, rel, ms); };
const edit = (root, rel, ms) => { appendFileSync(join(root, rel), `\n// edited ${ms}\n`); redate(root, rel, ms); };
const o = (m, srcRoot, extra = {}) => ({ machine: m.name, srcRoot, appHome: m.appHome, ...extra }); // the one place install options are built (the laptop app home holds the sync hold)
const H = () => import("../_lib/hold.js");
const holdDir = (m) => join(m.appHome, "data/drover-sync-hold");
const holdOf = async (m, env = {}) => (await H()).createHold({ dir: holdDir(m), ...env });
const holdFiles = (m) => (existsSync(holdDir(m)) ? readdirSync(holdDir(m)).sort() : []);
const states = (res) => Object.fromEntries(res.files.map((f) => [f.path, f.state]));
const noWrites = (rt) => rt.calls.filter((c) => c.kind === "write");
const noTilde = (rt) => { for (const c of rt.calls) for (const a of c.kind === "exec" ? c.argv : [c.path]) assert.doesNotMatch(a, /(^|\/)~/, `~ sent to the remote: ${a}`); };
const manifestOf = (m, rel = CURRENT) => JSON.parse(readFileSync(join(m.home, rel, "MANIFEST.json"), "utf8"));
const curId = (m) => RT.currentOf(m.home)?.split("/").pop() ?? null;
const sha = (text) => spawnSync("shasum", ["-a", "256"], { input: text, encoding: "utf8" }).stdout.split(" ")[0];

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

test("finder: no python3 -> E_PYTHON_NOT_FOUND on stdout, exit 0", () => {
  const m = machine({ python: false });
  const r = finder(m);
  assert.equal(r.code, 0);
  assert.match(r.out, /^E_PYTHON_NOT_FOUND$/m);
  assert.match(r.out, /^node tier=manager /m);
});

test("finder: platform fixtures. No hasher at all, no timeout(1): exit 0 and no hasher line; shasum only: hasher=shasum; sha256sum only: hasher=sha256sum", () => {
  const none = finder(machine({ hasher: "none", timeout: false }));
  assert.equal(none.code, 0, "a machine without a hasher must not make the finder fail");
  assert.doesNotMatch(none.out, /^hasher=/m);
  assert.match(none.out, /^node /m);
  assert.match(line(finder(machine({ hasher: "shasum" })).out, /^hasher=/), /^hasher=shasum$/);
  assert.match(line(finder(machine({ hasher: "sha256sum" })).out, /^hasher=/), /^hasher=sha256sum$/);
});

test("finder: home with spaces and an apostrophe is printed whole", () => {
  const m = machine({ homeName: "my home's dir" });
  const r = finder(m);
  assert.equal(line(r.out, /^home=/), `home=${m.home}`);
  assert.match(line(r.out, /^node /), /^node tier=manager /);
});

// ---------------------------------------------------------------------------------------------------------- 3. the manifest
test("manifest: the shipped list is the 13 files of the plan plus hold.js and publish.js (machines.js imports them, so the closure ships them)", async () => {
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
    } else assert.deepEqual(f.test.slice(0, 2), ["bash", "-n"], f.path);
  }
  assert.equal(scripts.size, 1, "one constant import script for every .js");
  assert.match([...scripts][0], /pathToFileURL\(process\.argv\[1\]\)/);
  assert.deepEqual(mod.expandTest(["{node}", "--check", "{gen}/x"], { gen: "/g/1", node: "/n/node", python3: "/p" }), ["/n/node", "--check", "/g/1/x"]);
});

// Private words are read at run time, so this public file never spells a person or a machine: this user and host, the linked machines
// (`hc machine ls --json`, skipped without hc) and an optional DROVER_PRIVATE_WORDS (comma-separated). Generic account and host names (a CI
// runner's) are skipped: they are not private and ordinary code uses such words. Words under 4 characters are ignored; matches are whole words.
const GENERIC_LEAKS = /sddm|gdm\b|lightdm|autologin|greeter|hyprland|\/(Users|home)\/[A-Za-z]/i;
const GENERIC_NAMES = new Set(["runner", "root", "admin", "user", "ubuntu", "ec2-user", "localhost", "github", "docker", "vagrant"]);
const clean = (w) => String(w || "").trim().toLowerCase();
const privateWords = ({ username, host, extra = "", machines = [], ci = false } = {}) => {
  const w = new Set();
  if (!ci) for (const x of [username, host]) if (!GENERIC_NAMES.has(clean(x))) w.add(x);
  for (const x of extra.split(",")) w.add(x);
  for (const m of machines) { w.add(m.name); w.add(m.host); w.add(m.logout_linger_user); }
  return [...w].map(clean).filter((x) => x.length >= 4);
};
const wholeWord = (text, word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i").test(text);
const runtimePrivateWords = () => {
  let username, host, machines = [];
  try { username = userInfo().username; } catch {}
  try { host = hostname().split(".")[0]; } catch {}
  try {
    const r = spawnSync("hc", ["machine", "ls", "--json"], { encoding: "utf8", timeout: 10000 });
    if (r.status === 0) machines = JSON.parse(r.stdout).machines || [];
  } catch {}
  return privateWords({ username, host, extra: process.env.DROVER_PRIVATE_WORDS || "", machines, ci: !!process.env.CI });
};

test("private words: a generic account or host name (a CI runner's) is not private; real names, machines and the env list are", () => {
  assert.deepEqual(privateWords({ username: "runner", host: "runner", extra: "", machines: [] }), []);
  assert.deepEqual(privateWords({ username: "root", host: "ubuntu" }), []);
  assert.deepEqual(privateWords({ username: "alice-w", host: "devbox", extra: "secretword, ab", machines: [{ name: "boxone", host: "boxone", logout_linger_user: "alice-w" }] }).sort(), ["alice-w", "boxone", "devbox", "secretword"]);
  assert.deepEqual(privateWords({ username: "alice-w", host: "devbox", ci: true }), []);
  assert.ok(wholeWord("the runner pool", "runner") && !wholeWord("a prunner", "runner"), "whole words only");
  assert.ok(!wholeWord("every file uses a runner here", "alice-w"));
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

// A SAMPLE of the kill points (the first calls, around the hold and the switch, the last calls, and every 4th call in between): each call costs a process
// on this computer, and the full sweep made the suite minutes long. The sample does not prove that every window is safe. The windows that matter are named in
// the phase-boundary test below (a kill at the edge of each step of an install), and the publisher's own inside-the-call window has its own test.
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
    for (const f of man.files) assert.equal(sha(readFileSync(join(m.home, GEN, d, f.path))), f.sha256, `${label}: ${d}/${f.path} is not what its manifest says`);
  }
}

for (const scenario of ["fresh", "update"]) {
  test(`install killed at runner calls (${scenario}): before activation \`current\` is untouched, after it \`current\` is the target; published gens stay whole; a re-run finishes`, async () => {
    const { m, s, install } = await fresh();
    let base = m;
    if (scenario === "fresh") { base = machine(); }
    else edit(s, "store.js", T_LATER);
    const { doctor } = await M();
    const { total, K, before, target } = await killPoints(base, s, install);
    assert.ok(total > 5 && K > 1 && K <= total);
    for (const n of killSet(total, K)) {
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
    }
  });
}

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
  writeFileSync(shim, `#!/bin/sh\necho "$1" > "${rec}"\n: > "${started}"\nwhile [ ! -e "${release}" ]; do sleep 0.01; done\nexec ${process.execPath} "$@"\n`);
  chmodSync(shim, 0o755);
  mkdirSync(m.appHome, { recursive: true });
  const child = spawn(join(m.home, ENTRY), ["agents", "export"], { cwd: m.home, env: { ...m.env, HERDR_APP_HOME: m.appHome, DROVER_NODE: shim }, stdio: "ignore" });
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

test("install: a home with spaces and an apostrophe works end to end", async () => {
  const { m, s, rt, res } = await fresh({}, { homeName: "my home's dir" });
  assert.equal(res.ok, true, JSON.stringify(res));
  const { doctor, check } = await M();
  assert.equal((await doctor(RT.makeRuntime(m), o(m, s))).ok, true);
  assert.equal((await check(RT.makeRuntime(m), o(m, s))).exitCode, 0);
  assert.equal(RT.cliProjects(m).code, 0);
  noTilde(rt);
});

test("install: platform fixtures (no timeout(1), shasum only) install and pass doctor", async () => {
  const { m, s, res } = await fresh({}, { hasher: "shasum", timeout: false });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal((await (await M()).doctor(RT.makeRuntime(m), o(m, s))).ok, true);
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

// ---------------------------------------------------------------------------------------------------------- 6. CLI wiring
test("bin/drover resolves its physical directory once, at the top, and dispatches `machines` to bin/drover-machines.mjs", () => {
  const text = readFileSync(CLI, "utf8");
  const assigns = [...text.matchAll(/^\s*here="\$\(cd -P/gm)];
  assert.equal(assigns.length, 1, "one `here=` for the whole script (the lazy one inside `agents export` is gone)");
  assert.ok(assigns[0].index < text.indexOf("usage() {"), "`here` is set before usage() and every verb");
  assert.match(text, /^\s*machines\) exec "\$\{DROVER_NODE:-node\}" "\$here\/drover-machines\.mjs" "\$\{@:2\}" ;;/m);
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

// ====================================================================================================== the sync hold (job 2)
// data/drover-sync-hold/hold.<n>.json, append-only (see hold.test.js for the record protocol itself). Here: how install and doctor use it.
const newest = async (m, env) => (await holdOf(m, env)).read();
const DEAD = { alive: () => false }; // the owner of the hold is gone (a killed installer): the test process is the "owner" and is alive, so a resume needs this

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
  for (const n of killSet(clean.calls.length, firstHeld)) {
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
  }
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

// ====================================================================================================== review round 1
const fileStates = (res) => Object.fromEntries(res.files.map((f) => [f.path, f.state]));
const stampOf = (m, path) => manifestOf(m).files.find((f) => f.path === path);

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

test("review 5: doctor on an offline machine (no finder output) returns FAIL checks in the agreed grammar, through doctor and through the CLI; it never throws", async () => {
  const { doctor, formatDoctor } = await M();
  const offline = { calls: [], exec: async () => ({ code: 1, stdout: "", stderr: "offline" }), write: async () => { throw new Error("no writes"); }, link: async () => ({ ok: false, detail: "m1 is disconnected" }) };
  const d = await doctor(offline, { machine: "m1", srcRoot: TASKS, appHome: machine().appHome });
  assert.equal(d.ok, false);
  assert.equal(d.exitCode, 1);
  assert.ok(d.checks.length >= 4 && d.checks.every((c) => ["ok", "FAIL", "WARN", "skip"].includes(c.status)));
  assert.equal(d.checks.find((c) => c.id === "link").status, "FAIL");
  assert.match(formatDoctor(d, { machine: "m1" }), /^doctor: \d+ ok, \d+ warn, [1-9]\d* fail$/m);
  const { main } = await import("../drover-tasks/bin/drover-machines.mjs");
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
  for (const n of points) {
    const c = clone(base);
    await assert.rejects(install(RT.makeRuntime(c, { kill: n }), o(c, s)), /killed/, `kill ${n} (${phases[n - 1]})`);
    assert.equal(RT.currentOf(c.home), n <= K ? before : `gen/${target}`, `kill before call ${n} (${phases[n - 1]})`);
    assertSane(c, `kill ${n}`);
    if (n >= 3) assert.equal((await newest(c)).record.state, "held", `kill ${n} (${phases[n - 1]}): the hold stands`);
    assert.equal(RT.cliProjects(c).code, 0, `kill ${n}: the CLI works`);
    const res = await install(RT.makeRuntime(c), o(c, s, { holdEnv: DEAD }));
    assert.equal(res.ok, true, `rerun after kill ${n}: ${JSON.stringify(res)}`);
    assert.equal(curId(c), target);
  }
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
