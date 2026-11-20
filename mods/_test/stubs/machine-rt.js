// Fake remote machine for the machines install tests (T-MWO2HDRQFIP). Test code only; nothing here ships.
// It stands where `hc exec --on <m>` and `hc file write --on <m>` stand: the REAL argv and stdin run on this computer with
// HOME = a temp dir, cwd = that dir, no shell, no `~` expansion, and a PATH made only of the tools the fixture allows.
// Nothing waits on a clock: each call does its work at once (the methods are async only because the real runner is, and so an `after` hook may await another actor), and a kill is an error thrown at a chosen call.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, chmodSync, realpathSync, existsSync, rmSync, cpSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, resolve } from "node:path";

// The remote layout the plan fixes (all relative to the remote home).
export const SHARE = ".local/share/drover-herdr";
export const GEN = `${SHARE}/gen`;
export const CURRENT = `${SHARE}/current`;
export const ENTRY = ".local/bin/drover";

const TOOLS = ["sh", "bash", "python3", "cat", "ls", "ln", "cp", "mv", "rm", "mkdir", "chmod", "dirname", "basename", "readlink", "realpath", "pwd", "uname", "env", "sleep", "sed", "grep", "awk", "tr", "head", "tail", "sort", "find", "stat", "touch", "date", "wc", "id", "cut", "tee", "xargs", "mktemp", "uniq", "expr", "kill", "od", "diff", "cmp", "rmdir", "true", "false", "test", "tar"];
const which = (name) => {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const p = r.stdout.trim();
  return r.status === 0 && p.startsWith("/") ? p : "";
};

// A remote with a fixed set of tools on its (non-login) exec PATH. Node is NOT on it: it lives only in a manager tree, the way the
// A1 spike found it, unless a test asks otherwise.
//   hasher: "sha256sum" | "shasum" | "both" | "none"      timeout: whether timeout(1) exists      python: whether python3 exists
export function makeMachine({ mktemp = "ok", hasher = "both", timeout = false, python = true, nodeOnPath = false, managerNode = "mise", name = "m1", homeName = "home" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mrt-")));
  const home = join(root, homeName); // homeName may hold spaces and an apostrophe
  mkdirSync(home, { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const t of TOOLS) {
    if (t === "python3" && !python) continue;
    if (t === "mktemp" && mktemp === "fail") { writeFileSync(join(bin, "mktemp"), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, "mktemp"), 0o755); continue; }
    const p = which(t);
    if (p) symlinkSync(p, join(bin, t));
  }
  const hashTool = (n, args) => { writeFileSync(join(bin, n), `#!/bin/sh\nexec ${which("shasum")} ${args} "$@"\n`); chmodSync(join(bin, n), 0o755); };
  if (hasher === "sha256sum" || hasher === "both") hashTool("sha256sum", "-a 256");
  if (hasher === "shasum" || hasher === "both") hashTool("shasum", "-a 256");
  if (timeout) { writeFileSync(join(bin, "timeout"), `#!/bin/sh\nshift\nexec "$@"\n`); chmodSync(join(bin, "timeout"), 0o755); }
  const nodeWrapper = (file) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `#!/bin/sh\nexec ${process.execPath} "$@"\n`); chmodSync(file, 0o755); };
  if (nodeOnPath === "hang") { writeFileSync(join(bin, "node"), "#!/bin/sh\nsleep 7\necho v99.0.0\n"); chmodSync(join(bin, "node"), 0o755); } // a PATH node that never answers in time
  else if (nodeOnPath) nodeWrapper(join(bin, "node"));
  const managers = {
    mise: ".local/share/mise/installs/node/lts/bin/node",
    nvm: ".nvm/versions/node/v22.1.0/bin/node",
    fnm: ".local/share/fnm/node-versions/v22.1.0/installation/bin/node",
    asdf: ".asdf/installs/nodejs/22.1.0/bin/node",
    volta: ".volta/bin/node",
  };
  if (managerNode) nodeWrapper(join(home, managers[managerNode]));
  const empty = join(root, "empty"); // the "common install locations" of this remote: none (a laptop's own /opt/homebrew must never leak in)
  mkdirSync(empty);
  const env = { PATH: bin, HOME: home, DROVER_FIND_SYSTEM_DIRS: empty, LANG: "C" };
  return { name, root, home, bin, env, managers, nodeWrapper, appHome: join(root, "app-home") };
}

// The runtime: the object the installer is given. `kill` throws before call N (1-based); `partial` writes half of write-call N, then throws.
// `after(call)` runs synchronously after each call (the CLI-keeps-working probe). `mangle(path, text)` rewrites what a write lands (a damaged transfer).
export function makeRuntime(machine, { kill = 0, partial = 0, after = null, mangle = null, machineName = machine.name } = {}) {
  const calls = [];
  const rt = {
    machine,
    calls,
    abs: (rel) => join(machine.home, rel),
    async exec(m, argv, { stdin = "", timeout = 60 } = {}) {
      step();
      if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) throw new Error("rt.exec: argv must be an array of strings");
      const c = record({ kind: "exec", machine: m, argv, stdin, timeout });
      const r = spawnSync(argv[0], argv.slice(1), { cwd: machine.home, env: machine.env, input: stdin, encoding: "utf8" });
      if (r.error) { c.code = 127; await done(c); return { code: 127, stdout: "", stderr: String(r.error.message) }; }
      c.code = r.status ?? 1;
      await done(c);
      return { code: c.code, stdout: r.stdout, stderr: r.stderr };
    },
    async write(m, path, text) {
      const c = record({ kind: "write", machine: m, path, text });
      if (path.startsWith("~") || path.includes("/~")) throw new Error(`rt.write: ~ is not expanded by hc: ${path}`);
      const full = isAbsolute(path) ? path : join(machine.home, path);
      if (!full.startsWith(machine.home)) throw new Error(`rt.write outside the remote home: ${path}`);
      mkdirSync(dirname(full), { recursive: true });
      const landed = mangle ? mangle(path, text) : text;
      if (partial === calls.length) { writeFileSync(full, String(landed).slice(0, Math.floor(String(landed).length / 2))); throw new Error(`killed in write call ${calls.length}`); }
      writeFileSync(full, landed);
      c.code = 0;
      await done(c);
      return { code: 0 };
    },
  };
  function step() { if (kill === calls.length + 1) throw new Error(`killed before call ${kill}`); }
  function record(c) { if (c.kind === "write") step(); c.n = calls.length + 1; calls.push(c); return c; }
  async function done(c) { c.current = currentOf(machine.home); if (after) await after(c, machine); }
  return rt;
}

// ---- what a test looks at on the fake remote
export const currentOf = (home) => { try { return readlinkSync(join(home, CURRENT)); } catch { return null; } };
export const genDirs = (home) => { try { return readdirSync(join(home, GEN)); } catch { return []; } };
export const readRel = (home, rel) => readFileSync(join(home, rel), "utf8");
export const modeOf = (full) => (statSync(full).mode & 0o777).toString(8);

// Every path under home: files (sha of bytes + mode), directories, symlinks (target). Two equal snapshots = nothing changed.
export function snapshot(home) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name), rel = full.slice(home.length + 1), st = lstatSync(full);
      if (st.isSymbolicLink()) out[rel] = `link ${readlinkSync(full)}`;
      else if (st.isDirectory()) { out[rel] = "dir"; walk(full); }
      else out[rel] = `file ${(st.mode & 0o777).toString(8)} ${readFileSync(full).toString("base64")}`;
    }
  };
  walk(home);
  return out;
}
export const symlinks = (home) => Object.entries(snapshot(home)).filter(([, v]) => v.startsWith("link ")).map(([k]) => k);
// A copy of a remote home (links kept as links), to start many kill points from one prepared state.
export function cloneMachine(machine) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mrt-")));
  cpSync(machine.root, root, { recursive: true, verbatimSymlinks: true });
  const rebase = (p) => p.replace(machine.root, root);
  const home = rebase(machine.home), bin = rebase(machine.bin);
  return { ...machine, root, home, bin, appHome: rebase(machine.appHome), env: { ...machine.env, PATH: bin, HOME: home, DROVER_FIND_SYSTEM_DIRS: rebase(machine.env.DROVER_FIND_SYSTEM_DIRS) } };
}
export const rmMachine = (machine) => rmSync(machine.root, { recursive: true, force: true });

// The real read verb (`drover projects`, empty app home) through the remote entry launcher, as an agent on the remote would call it.
export function cliProjects(machine) {
  mkdirSync(machine.appHome, { recursive: true });
  const r = spawnSync(join(machine.home, ENTRY), ["projects"], { cwd: machine.home, env: { ...machine.env, HERDR_APP_HOME: machine.appHome }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
}

// A source tree to install from: a copy of mods/drover-tasks (real files, real bytes) that a test may edit and re-date.
export function copySource(from) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "msrc-")));
  cpSync(from, root, { recursive: true, dereference: true, preserveTimestamps: true, filter: (p) => !p.endsWith(".png") && !p.endsWith(".svg") });
  return root;
}
export const resolveIn = (root, rel) => resolve(root, rel);
export { existsSync };
