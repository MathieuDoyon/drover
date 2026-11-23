// install.sh must not make Herdr reload mods for nothing (a saved file reloads the mod) and must not link mods to a worktree by accident.
// Everything runs in a disposable repo copy and a disposable HERDR_APP_HOME; never the real Herdr home.
// Shared fixture for the install-N.test.js files (split from install.test.js so the parallel runner spreads them; test bodies unchanged).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdtempSync, unlinkSync, chmodSync, renameSync, mkdirSync, cpSync, readdirSync, statSync, lstatSync, readlinkSync, writeFileSync, appendFileSync, readFileSync, utimesSync, rmSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sh = (cwd, cmd, args, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const git = (cwd, ...a) => { const r = sh(cwd, "git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a]); assert.equal(r.status, 0, r.stderr); return r.stdout; };
// install.sh runs `herdr-app check` per mod; CI has no Herdr, so a fake that always passes goes first on PATH.
const BIN = mkdtempSync(join(tmpdir(), "install-test-bin-"));
writeFileSync(join(BIN, "herdr-app"), "#!/bin/sh\n[ -n \"$FAKE_CHECK_FAIL\" ] && exit 1\nexit 0\n", { mode: 0o755 });
const made = [BIN];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); }); // worktree metadata lives inside the root, so one rm cleans all
// a repo whose mods/ is a copy of this one, plus an empty Herdr home
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-test-")));
  made.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  cpSync(SRC, join(repo, "mods"), { recursive: true, filter: (p) => !p.includes("node_modules") && !/\/\.install(\.lock|-backups)$/.test(p) });
  if (process.env.INSTALL_SH_UNDER_TEST) cpSync(process.env.INSTALL_SH_UNDER_TEST, join(repo, "mods", "install.sh")); // a scratch variant of the installer (mutation / red controls)
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "x");
  const home = join(root, "home");
  mkdirSync(join(home, "mods"), { recursive: true }); mkdirSync(join(home, "layouts"));
  return { root, repo, home };
}
const install = (dir, home, ...args) => sh(join(dir, "mods"), "bash", ["install.sh", ...args], { HERDR_APP_HOME: home, PATH: `${BIN}:${process.env.PATH}` });
const mtimes = (dir) => {
  const out = {};
  for (const m of readdirSync(dir).filter((n) => n.startsWith("drover-")))
    for (const f of readdirSync(join(dir, m))) { const st = lstatSync(join(dir, m, f)); if (st.isFile()) out[`${m}/${f}`] = st.mtimeMs; }
  return out;
};
// the reopen note: shared _lib code that changed since the last good install (Herdr may keep the old imports)
const NOTE = /NOTE: shared _lib code changed/;
const mainJs = (repo) => Object.fromEntries(readdirSync(join(repo, "mods")).filter((n) => n.startsWith("drover-")).map((m) => [m, statSync(join(repo, "mods", m, "main.js")).mtimeMs]));
const run = (repo, home, env = {}) => sh(join(repo, "mods"), "bash", ["install.sh"], { HERDR_APP_HOME: home, PATH: `${BIN}:${process.env.PATH}`, ...env });
// box1 (Arch) runs this script too: no shasum there, and the GitHub mod may be skipped. Never a false alarm, never a failed install.
// A private bin dir with symlinks to only the tools install.sh needs, found on the real PATH. Hiding the hashers by editing PATH cannot work:
// on Linux they sit in /usr/bin with every other tool. The dir is checked by listing it, not by running anything.
const NEEDED = ["bash", "sh", "env", "cat", "cp", "mv", "rm", "ln", "install", "cmp", "readlink", "dirname", "basename", "git", "mkdir", "grep", "head", "tail", "sed", "awk", "tr", "sort", "ls", "date", "touch", "chmod", "rmdir", "uname", "cut", "wc", "expr", "test", "["];
function noHasherPath(keepCksum = false) {
  const dir = mkdtempSync(join(tmpdir(), "install-test-nohash-"));
  made.push(dir);
  for (const n of [...NEEDED, ...(keepCksum ? ["cksum"] : [])]) {
    const r = sh(".", "sh", ["-c", `command -v ${n === "[" ? "'['" : n}`]);
    const found = r.stdout.trim();
    if (r.status === 0 && found.startsWith("/")) symlinkSync(found, join(dir, n));
  }
  const names = readdirSync(dir);
  assert.deepEqual(names.filter((n) => ["sha256sum", "shasum"].includes(n) || (n === "cksum" && !keepCksum)), [], "a hasher is in the private bin");
  for (const must of ["bash", "sh", "git", "cat", "cp"]) assert.ok(names.includes(must), `${must} is not available for the install`);
  return dir;
}
const CANNOT = /fingerprint could not be checked/;
const runIn = (repo, home, path, env = {}) => sh(join(repo, "mods"), join(path.split(":")[1], "bash"), ["install.sh"], { HERDR_APP_HOME: home, PATH: path, ...env });
// ---- T-MWO2HH3HOAU (B6): safe updates. Owner-changed managed files are never overwritten; the incoming copy lands beside them as <file>.new.
const rd = (p) => readFileSync(p, "utf8");
const mp = (repo, ...a) => join(repo, "mods", ...a);
const KEPT = /^KEPT /gm;
const keptLines = (r) => r.stdout.split("\n").filter((l) => /^KEPT/.test(l));
const ageAll = (repo) => { const old = new Date(Date.now() - 3600_000); for (const f of Object.keys(mtimes(mp(repo)))) utimesSync(mp(repo, f), old, old); };
const commitAll = (repo, msg = "y") => { git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", msg); };
const owner = "\n// owner edit\n";
const installed = () => { const f = fixture(); assert.equal(run(f.repo, f.home).status, 0); return f; };
const spawnTimed = (repo, home, env) => spawnSync("bash", ["install.sh"], { cwd: mp(repo), encoding: "utf8", timeout: 30000, env: { ...process.env, HERDR_APP_HOME: home, PATH: `${BIN}:${process.env.PATH}`, ...env } }); // timeout: a hang guard only
const backups = (repo) => { const d = mp(repo, ".install-backups"); return existsSync(d) ? readdirSync(d).map((s) => join(d, s)) : []; };
// race hooks (DROVER_INSTALL_TEST_HOOK is test-only): the hook runs at four points of one file's publish and edits the file as an owner would.
const hookScript = (root, body) => { const p = join(root, "hook.sh"); writeFileSync(p, `#!/bin/bash\n[ "$2" = drover-tasks/store.js ] || exit 0\n${body}\n`, { mode: 0o755 }); return p; };
const upstream = (repo) => appendFileSync(mp(repo, "_lib", "store.js"), "\n// upstream\n");
const find = (repo, re) => readdirSync(mp(repo, "drover-tasks")).filter((n) => re.test(n));
// ---- review round 1 fixes (findings 1, 2, 3, 5, 6)
const blDir = (repo, home) => join(home, ".drover-baseline", mp(repo));
// ---- review round 2 fixes (equal path reference, failed record update, staging ownership)
const realTool = (n) => { const r = spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }); return r.stdout.trim(); };
const shimDir = (root, name, body) => { const d = join(root, `shim-${name}`); mkdirSync(d); writeFileSync(join(d, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }); return d; };
const withShim = (repo, home, dir, env = {}) => spawnSync("bash", ["install.sh"], { cwd: mp(repo), encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, PATH: `${dir}:${BIN}:${process.env.PATH}`, ...env } });
const forget = (repo, home, f) => { for (const n of [f, `${f}.head`]) rmSync(join(blDir(repo, home), "drover-tasks", n), { force: true }); };
// the installer's pid is predictable and its clock is pinned by a date shim shared with the wrapper: the planted names are exact, not a guess
const FIXED = "20260101T000000Z";
let dateShim;
const plant = (repo, home, script) => {
  dateShim ??= (() => { const d = mkdtempSync(join(tmpdir(), "install-test-date-")); made.push(d); writeFileSync(join(d, "date"), `#!/bin/bash\nif [ "$*" = "-u +%Y%m%dT%H%M%SZ" ]; then echo ${FIXED}; else exec ${realTool("date")} "$@"; fi\n`, { mode: 0o755 }); return d; })();
  return spawnSync("sh", ["-c", `S="${FIXED}"; ${script}; exec bash install.sh`], { cwd: mp(repo), encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, PATH: `${dateShim}:${BIN}:${process.env.PATH}` } });
};
// ---- review round 3: a record or marker that cannot be written means no change for that file
const mvFault = (root, glob) => shimDir(root, "mv", `case "\${@: -1}" in ${glob}) exit 1;; esac; exec ${realTool("mv")} "$@"`);
// ---- Judge ruling 2: the .new is stateless, the baseline key is physical, one installer per home
const anyNewrec = (home) => { const out = []; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.newrec$/.test(e.name)) out.push(p); } }; walk(home); return out; };
// T4: a logical alias for the checkout. `cd` in a shell keeps the alias in $PWD and the exec'd installer inherits it (spawning with cwd=alias would let bash recompute
// the physical path and prove nothing). The control swaps the physical key for the logical one in a scratch copy of the installer and must see the guard bypassed.
function aliasScenario(patch) {
  const { root, repo, home } = installed();
  const A = rd(mp(repo, "drover-tasks", "store.js"));
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// B\n");
  assert.equal(run(repo, home).status, 0);
  const alias = join(root, "alias"); symlinkSync(repo, alias);
  if (patch) writeFileSync(mp(repo, "install.sh"), patch(rd(mp(repo, "install.sh"))));
  writeFileSync(mp(repo, "drover-tasks", "store.js"), A); // the owner restores the committed copy
  appendFileSync(mp(repo, "_lib", "store.js"), "\n// C\n");
  const r = spawnSync("sh", ["-c", `cd ${JSON.stringify(join(alias, "mods"))} && [ "$PWD" = ${JSON.stringify(join(alias, "mods"))} ] && exec bash install.sh`], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, PATH: `${BIN}:${process.env.PATH}` } });
  return { r, A, repo };
}

export { sh, git, BIN, made, fixture, install, mtimes, NOTE, mainJs, run, noHasherPath, CANNOT, runIn, rd, mp, KEPT, keptLines, ageAll, commitAll, owner, installed, spawnTimed, backups, hookScript, upstream, find, blDir, realTool, shimDir, withShim, forget, plant, mvFault, anyNewrec, aliasScenario };
