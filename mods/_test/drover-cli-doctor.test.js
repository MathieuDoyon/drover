// T-MWO2HGQOEI2 (B5): `drover doctor` is a read-only report: mods linked and equal to the repo, _lib copies equal, souls present,
// the _lib fingerprint vs the install.sh stamp, the CLI on PATH, a hook slot for B4a. One line per check, exit 0 unless a check FAILs.
// Everything runs in a disposable repo copy and a disposable HERDR_APP_HOME, with a private PATH: no Herdr, hc or gh, never the real home.
// The stamp is written by the REAL install.sh (fake `herdr-app check`), so doctor and installer must agree on the hash byte for byte.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, symlinkSync, mkdtempSync, mkdirSync, cpSync, readdirSync, lstatSync, readlinkSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync, realpathSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cwd, cmd, args, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", env });
const which = (n) => { const r = spawnSync("sh", ["-c", `command -v ${n === "[" ? "'['" : n}`], { encoding: "utf8" }); const p = r.stdout.trim(); return r.status === 0 && p.startsWith("/") ? p : ""; };
const BASH = which("bash");
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); made.push(d); return d; };

// Secret-shaped fakes are built by concatenation: the public leak scan flags the literal prefixes, and the file must not hold one.
const SK = "sk" + "-live-0123456789";
const GH = (tag) => "gh" + "p_" + tag + "X".repeat(36); // a 36+ char token after the prefix, like a real one
const FAKE_SEC = "FAKE_SEC" + "RET";
const DOCTOR_TOOLS = ["bash", "sh", "env", "cat", "cmp", "readlink", "dirname", "basename", "wc", "tr", "sed", "head", "tail", "grep", "ls", "cut", "expr", "test", "["];
const INSTALL_TOOLS = [...DOCTOR_TOOLS, "git", "cp", "mv", "rm", "ln", "install", "mkdir", "awk", "sort", "date", "touch", "chmod", "uname"];
const HASHERS = ["sha256sum", "shasum", "cksum"].filter(which);
// A private bin dir with symlinks to only the named tools (hashers listed on purpose), plus optional extra entries { name: target }.
function binDir(tools, hashers, extra = {}) {
  const dir = tmp("doctor-bin-");
  for (const n of [...tools, ...hashers]) { const p = which(n); if (p) symlinkSync(p, join(dir, n)); }
  for (const [n, target] of Object.entries(extra)) symlinkSync(target, join(dir, n));
  const names = readdirSync(dir);
  for (const bad of ["herdr-app", "hc", "gh", "herdr"]) assert.ok(!names.includes(bad), `${bad} is on the private PATH`);
  return dir;
}
const fakeHerdr = () => { const d = tmp("doctor-fake-"); writeFileSync(join(d, "herdr-app"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); return d; };

// a repo whose mods/ is a copy of this one, a Herdr home, and the real installer run once (links + stamp)
function fixture({ install = true, hashers = HASHERS } = {}) {
  const root = tmp("doctor-test-");
  const repo = join(root, "repo");
  mkdirSync(repo);
  cpSync(SRC, join(repo, "mods"), { recursive: true, filter: (p) => !p.includes("node_modules") });
  const g = (...a) => { const r = sh(repo, which("git"), ["-c", "user.email=t@t", "-c", "user.name=t", ...a], process.env); assert.equal(r.status, 0, r.stderr); };
  g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-q", "-m", "x");
  const home = join(root, "home");
  mkdirSync(join(home, "mods"), { recursive: true }); mkdirSync(join(home, "layouts"));
  const cli = join(repo, "mods", "drover-tasks", "bin", "drover");
  const f = { root, repo, home, cli, hashers, dbin: binDir(DOCTOR_TOOLS, hashers, { drover: cli }), install: () => installIn(f) };
  if (install) f.install();
  return f;
}
// the installer needs its own tools and a fake herdr-app; doctor never gets them
const installIn = (f) => {
  const path = `${fakeHerdr()}:${binDir(INSTALL_TOOLS, f.hashers)}`;
  const r = sh(join(f.repo, "mods"), BASH, ["install.sh"], { PATH: path, HOME: f.root, HERDR_APP_HOME: f.home, DROVER_SKIP_TESTS: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
};
const fx = fixture;
const doctor = (f, { path, args = ["doctor"], env = {}, cli } = {}) => sh(f.root, BASH, [cli ?? f.cli, ...args], { PATH: path ?? f.dbin, HOME: f.root, HERDR_APP_HOME: f.home, ...env });
const lines = (r) => r.stdout.trimEnd().split("\n");
const line = (r, check) => lines(r).find((l) => new RegExp(`^(ok|FAIL|WARN|skip)  ${check}  `).test(l)) ?? `(no ${check} line)\n${r.stdout}${r.stderr}`;
const status = (r, check) => line(r, check).split("  ")[0];
const LINE = /^(ok|FAIL|WARN|skip)  [a-z-]+  .{0,100}$/;

test("an installed fixture: 6 check lines in the shared grammar, a summary, exit 0, hooks skipped", () => {
  const f = fx();
  const r = doctor(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ls = lines(r);
  assert.equal(ls.length, 7, r.stdout);
  for (const l of ls.slice(0, 6)) assert.match(l, LINE);
  assert.deepEqual(ls.slice(0, 6).map((l) => l.split("  ")[1]), ["mods-linked", "lib-copies", "souls", "lib-stamp", "cli-path", "hooks"]);
  assert.match(ls[6], /^doctor: 5 ok, 0 warn, 0 fail$/);
  assert.equal(status(r, "hooks"), "skip");
  assert.match(line(r, "hooks"), /B4a/);
  for (const c of ["mods-linked", "lib-copies", "souls", "lib-stamp", "cli-path"]) assert.equal(status(r, c), "ok", line(r, c));
});

test("the usage names doctor, and an unknown doctor argument exits 2", () => {
  const f = fx({ install: false });
  assert.match(doctor(f, { args: [] }).stderr, /drover doctor/);
  assert.equal(doctor(f, { args: ["doctor", "--nope"] }).status, 2);
});

test("--home <dir> checks that home instead of HERDR_APP_HOME", () => {
  const f = fx();
  const r = doctor(f, { args: ["doctor", "--home", f.home], env: { HERDR_APP_HOME: join(f.root, "elsewhere") } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a mod with no link in the home: FAIL naming the mod, exit 1", () => {
  const f = fx();
  unlinkSync(join(f.home, "mods", "drover-tasks"));
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.match(line(r, "mods-linked"), /^FAIL  mods-linked  .*drover-tasks.*missing/);
  assert.match(line(r, "mods-linked"), /install\.sh/);
});

test("a real folder instead of a link: FAIL 'not a link'", () => {
  const f = fx();
  rmSync(join(f.home, "mods", "drover-tasks"));
  cpSync(join(f.repo, "mods", "drover-tasks"), join(f.home, "mods", "drover-tasks"), { recursive: true });
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.match(line(r, "mods-linked"), /^FAIL  mods-linked  .*drover-tasks.*not a link/);
});

test("a link to another path: FAIL 'points elsewhere', and no path, newline or secret text is printed", () => {
  const f = fx();
  rmSync(join(f.home, "mods", "drover-tasks"));
  const evil = `/nowhere/${"x".repeat(300)}\n${FAKE_SEC}=${SK}`;
  symlinkSync(evil, join(f.home, "mods", "drover-tasks"));
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.match(line(r, "mods-linked"), /^FAIL  mods-linked  .*drover-tasks.*points elsewhere/);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(`nowhere|xxxx|${FAKE_SEC}|sk` + "-live"));
  for (const l of lines(r).slice(0, -1)) assert.match(l, LINE);
});

test("an edited _lib copy: FAIL lib-copies, a count and the install hint, never the content", () => {
  const f = fx();
  appendFileSync(join(f.repo, "mods", "drover-tasks", "store.js"), "\nconst TOKEN = '" + SK + "-FAKE';\n");
  appendFileSync(join(f.repo, "mods", "drover-board", "io.js"), "\n// edited\n");
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.match(line(r, "lib-copies"), /^FAIL  lib-copies  .*differs: 2 files.*install\.sh/);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp("sk" + "-live|FAKE"));
});

test("a missing _lib copy: FAIL lib-copies", () => {
  const f = fx();
  unlinkSync(join(f.repo, "mods", "drover-tasks", "store.js"));
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.match(line(r, "lib-copies"), /^FAIL  lib-copies  .*(missing|differs)/);
});

test("drover-github/query.js present but the drover-config copy deleted: FAIL lib-copies", () => {
  const f = fx();
  unlinkSync(join(f.repo, "mods", "drover-config", "query.js"));
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.match(line(r, "lib-copies"), /^FAIL  lib-copies  /);
});

test("the drover-config query.js copy edited: FAIL lib-copies", () => {
  const f = fx();
  appendFileSync(join(f.repo, "mods", "drover-config", "query.js"), "\n// edited\n");
  assert.equal(status(doctor(f), "lib-copies"), "FAIL");
});

test("a soul missing in the home: FAIL souls naming it", () => {
  const f = fx();
  // the home holds a real copy of drover-agents that lacks one soul the repo lists
  rmSync(join(f.home, "mods", "drover-agents"));
  cpSync(join(f.repo, "mods", "drover-agents"), join(f.home, "mods", "drover-agents"), { recursive: true });
  unlinkSync(join(f.home, "mods", "drover-agents", "souls", "wrangler.md"));
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.match(line(r, "souls"), /^FAIL  souls  .*wrangler\.md/);
});

test("an empty soul: FAIL souls", () => {
  const f = fx();
  writeFileSync(join(f.repo, "mods", "drover-agents", "souls", "wrangler.md"), "");
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.match(line(r, "souls"), /^FAIL  souls  .*wrangler\.md.*empty/);
});

test("_herd.md missing: FAIL souls", () => {
  const f = fx();
  unlinkSync(join(f.repo, "mods", "drover-agents", "souls", "_herd.md"));
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.match(line(r, "souls"), /^FAIL  souls  .*_herd\.md/);
});

test("a changed shared file after the install: WARN lib-stamp (reopen the window), exit 0 on that check alone", () => {
  const f = fx();
  appendFileSync(join(f.repo, "mods", "_lib", "store.js"), "\n// changed\n");
  const r = doctor(f);
  assert.equal(status(r, "lib-stamp"), "WARN", line(r, "lib-stamp"));
  assert.match(line(r, "lib-stamp"), /reopen the window/);
  assert.match(line(r, "lib-stamp"), /not probed/);
});

test("a stale stamp alone never fails the run (copies kept equal)", () => {
  const f = fx();
  const cur = join(f.repo, "mods");
  for (const m of readdirSync(cur).filter((n) => n.startsWith("drover-") || n === "_lib")) if (existsSync(join(cur, m, "store.js"))) appendFileSync(join(cur, m, "store.js"), "\n// pulled\n");
  const r = doctor(f);
  assert.equal(status(r, "lib-stamp"), "WARN");
  assert.equal(r.status, 0, r.stdout);
  assert.match(lines(r).at(-1), /^doctor: 4 ok, 1 warn, 0 fail$/);
});

test("links but no stamp (installed before the stamp existed): WARN lib-stamp", () => {
  const f = fx();
  unlinkSync(join(f.home, ".drover-lib-stamp"));
  assert.equal(status(doctor(f), "lib-stamp"), "WARN");
});

test("no stamp and no links: lib-stamp is skip, never a failure by itself", () => {
  const f = fx({ install: false });
  const r = doctor(f);
  assert.equal(status(r, "lib-stamp"), "skip", line(r, "lib-stamp"));
  assert.equal(status(r, "mods-linked"), "FAIL");
});

test("no hasher on PATH: lib-stamp is skip with a reason", () => {
  const f = fx();
  const r = doctor(f, { path: binDir(DOCTOR_TOOLS, []) });
  assert.equal(status(r, "lib-stamp"), "skip", line(r, "lib-stamp"));
});

test("the same hash as the real installer with each hasher (sha256sum, shasum, cksum): ok, then WARN after a change", () => {
  for (const h of HASHERS) {
    const f = fx({ hashers: [h] });
    assert.equal(status(doctor(f), "lib-stamp"), "ok", `${h}: ${line(doctor(f), "lib-stamp")}`);
    appendFileSync(join(f.repo, "mods", "_lib", "store.js"), "\n// changed\n");
    assert.equal(status(doctor(f), "lib-stamp"), "WARN", h);
  }
});

test("a query.js-only change after the install: WARN lib-stamp", () => {
  const f = fx();
  appendFileSync(join(f.repo, "mods", "drover-github", "query.js"), "\n// changed\n");
  assert.equal(status(doctor(f), "lib-stamp"), "WARN");
});

test("CLI not on PATH: WARN cli-path, exit 0", () => {
  const f = fx();
  const r = doctor(f, { path: binDir(DOCTOR_TOOLS, HASHERS) });
  assert.equal(status(r, "cli-path"), "WARN", line(r, "cli-path"));
  assert.match(line(r, "cli-path"), /not on PATH/);
  assert.equal(r.status, 0, r.stdout);
});

test("a PATH copy that is another file: WARN 'PATH copy is another file', and the PATH dir text is never printed", () => {
  const f = fx();
  const evil = join(f.root, `p\n${FAKE_SEC}=${SK}`, "y".repeat(150), "y".repeat(150)); // a newline, a secret-looking name and 300+ chars of path
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, "drover"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const r = doctor(f, { path: `${evil}:${binDir(DOCTOR_TOOLS, HASHERS)}` });
  assert.equal(status(r, "cli-path"), "WARN", r.stdout + r.stderr);
  assert.match(line(r, "cli-path"), /PATH copy is another file/);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(`${FAKE_SEC}|sk` + "-live|yyyy"));
  for (const l of lines(r).slice(0, -1)) assert.match(l, LINE);
});

test("a PATH link to the script (the installed ~/.local/bin/drover) is the same file: ok cli-path", () => {
  const f = fx();
  assert.equal(status(doctor(f), "cli-path"), "ok");
});

// the three read-only guarantees: nothing written, no secrets shown, no Herdr needed
function snapshot(dir, out = {}, rel = "") {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n), st = lstatSync(p), k = `${rel}/${n}`;
    if (st.isSymbolicLink()) out[k] = `link ${readlinkSync(p)}`;
    else if (st.isDirectory()) { out[k] = `dir ${st.mtimeMs}`; snapshot(p, out, k); }
    else out[k] = `file ${st.mtimeMs} ${createHash("sha1").update(readFileSync(p)).digest("hex")}`;
  }
  return out;
}

test("read-only: the repo and the home are byte, name and mtime identical after a good and a failing run", () => {
  const f = fx();
  const before = snapshot(f.root);
  assert.equal(doctor(f).status, 0);
  appendFileSync(join(f.repo, "mods", "drover-tasks", "store.js"), "\n// x\n");
  unlinkSync(join(f.home, "mods", "drover-board"));
  const mid = snapshot(f.root);
  assert.equal(doctor(f).status, 1);
  assert.deepEqual(snapshot(f.root), mid);
  assert.notDeepEqual(mid, before); // the fixture did change between the runs, only doctor wrote nothing
});

test("no secrets: env values and file content never reach the output", () => {
  const f = fx();
  appendFileSync(join(f.repo, "mods", "drover-tasks", "store.js"), "\nconst k = '" + GH("FILE") + "';\n");
  writeFileSync(join(f.home, ".drover-lib-stamp"), GH("STAMP") + "\n");
  const r = doctor(f, { env: { TOKEN: GH("ENV1"), ["GITHUB" + "_TOKEN"]: GH("ENV2") } });
  assert.equal(status(r, "lib-copies"), "FAIL", r.stdout); // the run really looked at the secret-bearing file
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp("gh" + "p_|FAKE|XXXXXXXXXX"));
});

test("runs without Herdr: only HERDR_APP_HOME and a PATH with no herdr-app, hc or gh", () => {
  const f = fx();
  const r = doctor(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stderr, "");
});

test("every output line of every failing fixture above matches the grammar (a broken fixture with 3 failures at once)", () => {
  const f = fx();
  unlinkSync(join(f.home, "mods", "drover-tasks"));
  appendFileSync(join(f.repo, "mods", "drover-board", "io.js"), "\n// edited\n");
  writeFileSync(join(f.repo, "mods", "drover-agents", "souls", "wrangler.md"), "");
  const r = doctor(f);
  assert.equal(r.status, 1);
  const ls = lines(r);
  for (const l of ls.slice(0, -1)) assert.match(l, LINE);
  assert.match(ls.at(-1), /^doctor: \d+ ok, \d+ warn, 3 fail$/);
});

// Inspector review findings 1-3
test("an unreadable _lib/copies.txt: FAIL with a fixed detail, exit 1, empty stderr, all six lines and the summary", { skip: process.getuid?.() === 0 && "root reads a chmod 000 file" }, () => {
  const f = fx();
  chmodSync(join(f.repo, "mods", "_lib", "copies.txt"), 0);
  const r = doctor(f);
  chmodSync(join(f.repo, "mods", "_lib", "copies.txt"), 0o644);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.stderr, "", "a shell diagnostic leaked a path");
  assert.match(line(r, "lib-copies"), /^FAIL  lib-copies  _lib\/copies\.txt is missing or unreadable$/);
  assert.equal(lines(r).length, 7, r.stdout);
  assert.notEqual(status(r, "lib-stamp"), "ok"); // a manifest that cannot be read proves nothing
});

test("a shared file listed in copies.txt but missing in _lib: all six lines and the summary, lib-stamp skip, no early exit", () => {
  const f = fx();
  unlinkSync(join(f.repo, "mods", "_lib", "store.js"));
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "");
  assert.equal(lines(r).length, 7, r.stdout);
  assert.equal(status(r, "lib-stamp"), "skip", line(r, "lib-stamp"));
  for (const c of ["cli-path", "hooks"]) assert.notEqual(line(r, c).startsWith("(no "), true, c);
  assert.match(lines(r).at(-1), /^doctor: \d+ ok, \d+ warn, \d+ fail$/);
});

test("failure details are short and complete (count, first failure, the hint), never cut mid-phrase", () => {
  const f = fx();
  for (const m of ["drover-agents", "drover-board", "drover-config"]) unlinkSync(join(f.home, "mods", m));
  const missing = line(doctor(f), "mods-linked");
  assert.match(missing, /^FAIL  mods-linked  3 of \d+ mods: drover-agents missing \(\+2 more\); run install\.sh \(no DROVER_SKIP_MODS\)$/);
  const g = fx();
  rmSync(join(g.home, "mods", "drover-tasks")); symlinkSync("/nowhere", join(g.home, "mods", "drover-tasks"));
  assert.match(line(doctor(g), "mods-linked"), /^FAIL  mods-linked  1 of \d+ mods: drover-tasks points elsewhere; run install\.sh$/, "the skip-mod hint is for a missing mod only");
  const h = fx();
  for (const m of ["drover-tasks", "drover-board", "drover-config"]) appendFileSync(join(h.repo, "mods", m, "io.js"), "\n// x\n");
  assert.match(line(doctor(h), "lib-copies"), /^FAIL  lib-copies  differs: 3 files, first drover-[a-z]+\/io\.js; run install\.sh$/);
  const k = fx();
  for (const n of ["wrangler.md", "scout.md", "qa.md"]) writeFileSync(join(k.repo, "mods", "drover-agents", "souls", n), "");
  assert.match(line(doctor(k), "souls"), /^FAIL  souls  3 of \d+: [a-z-]+\.md empty \(\+2 more\)$/);
});
