// T-MWO2HGQOEI2 (B5): `drover doctor` is a read-only report: mods linked and equal to the repo, _lib copies equal, souls present,
// the _lib fingerprint vs the install.sh stamp, the CLI on PATH, the asks hooks of Claude and Codex (B4a, read-only). One line per check, exit 0 unless a check FAILs.
// Everything runs in a disposable repo copy and a disposable HERDR_APP_HOME, with a private PATH: no Herdr, hc or gh, never the real home.
// The stamp is written by the REAL install.sh (fake `herdr-app check`), so doctor and installer must agree on the hash byte for byte.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { utimesSync, chmodSync, symlinkSync, mkdtempSync, mkdirSync, cpSync, readdirSync, lstatSync, readlinkSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync, realpathSync, unlinkSync } from "node:fs";
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
const DOCTOR_TOOLS = ["bash", "sh", "env", "cat", "cmp", "readlink", "dirname", "basename", "wc", "tr", "sed", "head", "tail", "grep", "ls", "cut", "expr", "test", "[", "date"];
const INSTALL_TOOLS = [...DOCTOR_TOOLS, "git", "cp", "mv", "rm", "ln", "install", "mkdir", "awk", "sort", "touch", "chmod", "uname", "rmdir"];
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

// A real install runs this suite while holding mods/.install.lock (and may leave .install-backups): never copy them, or the fixture's own installer is refused.
const copyFilter = (p) => !p.includes("node_modules") && !/\/\.install(\.lock|-backups)$/.test(p);
// a repo whose mods/ is a copy of this one, a Herdr home, and the real installer run once (links + stamp)
function fixture({ install = true, hashers = HASHERS, src = SRC } = {}) {
  const root = tmp("doctor-test-");
  const repo = join(root, "repo");
  mkdirSync(repo);
  cpSync(src, join(repo, "mods"), { recursive: true, filter: copyFilter });
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
  const r = sh(join(f.repo, "mods"), BASH, ["install.sh"], { PATH: path, HOME: f.root, HERDR_APP_HOME: f.home });
  assert.equal(r.status, 0, r.stderr + r.stdout);
};
const fx = fixture;
const doctor = (f, { path, args = ["doctor"], env = {}, cli } = {}) => sh(f.root, BASH, [cli ?? f.cli, ...args], { PATH: path ?? f.dbin, HOME: f.root, HERDR_APP_HOME: f.home, ...env });
const lines = (r) => r.stdout.trimEnd().split("\n");
const line = (r, check) => lines(r).find((l) => new RegExp(`^(ok|FAIL|WARN|skip)  ${check}  `).test(l)) ?? `(no ${check} line)\n${r.stdout}${r.stderr}`;
const status = (r, check) => line(r, check).split("  ")[0];
const LINE = /^(ok|FAIL|WARN|skip)  [a-z-]+  .{0,100}$/;

test("a source mods/ holding .install.lock and .install-backups does not break the fixture's installer", () => {
  const src = tmp("doctor-src-");
  cpSync(SRC, src, { recursive: true, filter: copyFilter }); // seed without a real outer install's own lock
  mkdirSync(join(src, ".install.lock")); mkdirSync(join(src, ".install-backups", "run"), { recursive: true });
  const f = fx({ src });
  for (const n of [".install.lock", ".install-backups"]) assert.ok(!existsSync(join(f.repo, "mods", n)), n);
});

test("an installed fixture: 10 check lines in the shared grammar, a summary, exit 0, accept-locks ok, the hooks lines skipped (nothing installed)", () => {
  const f = fx();
  const r = doctor(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ls = lines(r);
  assert.equal(ls.length, 11, r.stdout);
  for (const l of ls.slice(0, 10)) assert.match(l, LINE);
  assert.deepEqual(ls.slice(0, 10).map((l) => l.split("  ")[1]), ["mods-linked", "lib-copies", "souls", "lib-stamp", "cli-path", "accept-locks", "hooks-claude", "hooks-codex", "hooks-runtime", "hooks-locks"]);
  assert.match(ls[10], /^doctor: 6 ok, 0 warn, 0 fail$/);
  for (const c of ["hooks-claude", "hooks-codex", "hooks-runtime", "hooks-locks"]) assert.equal(status(r, c), "skip", line(r, c));
  for (const c of ["mods-linked", "lib-copies", "souls", "lib-stamp", "cli-path", "accept-locks"]) assert.equal(status(r, c), "ok", line(r, c));
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
  assert.match(lines(r).at(-1), /^doctor: 5 ok, 1 warn, 0 fail$/);
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
test("an unreadable _lib/copies.txt: FAIL with a fixed detail, exit 1, empty stderr, every line and the summary", { skip: process.getuid?.() === 0 && "root reads a chmod 000 file" }, () => {
  const f = fx();
  chmodSync(join(f.repo, "mods", "_lib", "copies.txt"), 0);
  const r = doctor(f);
  chmodSync(join(f.repo, "mods", "_lib", "copies.txt"), 0o644);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.stderr, "", "a shell diagnostic leaked a path");
  assert.match(line(r, "lib-copies"), /^FAIL  lib-copies  _lib\/copies\.txt is missing or unreadable$/);
  assert.equal(lines(r).length, 11, r.stdout);
  assert.notEqual(status(r, "lib-stamp"), "ok"); // a manifest that cannot be read proves nothing
});

test("a shared file listed in copies.txt but missing in _lib: every line and the summary, lib-stamp skip, no early exit", () => {
  const f = fx();
  unlinkSync(join(f.repo, "mods", "_lib", "store.js"));
  const r = doctor(f);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "");
  assert.equal(lines(r).length, 11, r.stdout);
  assert.equal(status(r, "lib-stamp"), "skip", line(r, "lib-stamp"));
  for (const c of ["cli-path", "hooks-claude", "hooks-codex", "hooks-locks"]) assert.notEqual(line(r, c).startsWith("(no "), true, c);
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

// ---- the asks hooks check (T-MWO2HGDSXX1, B4a part A): read-only, reads two config files, prints only fixed phrases ----
// HOME is a scratch dir in every test, and the explicit paths point there too: the real ~/.claude and ~/.codex are never read.
const withNode = (f) => binDir(DOCTOR_TOOLS, f.hashers, { drover: f.cli, node: process.execPath });
const hookScript = (f) => join(f.repo, "mods", "drover-tasks", "bin", "drover-asks-hook");
const CLAUDE_SET = { PermissionRequest: "set", Notification: "set", PreToolUse: "set", PostToolUse: "clear", UserPromptSubmit: "clear", Stop: "clear", SessionEnd: "clear" };
const CODEX_SET = { PermissionRequest: "set", PostToolUse: "clear", UserPromptSubmit: "clear", Stop: "clear" };
const cfg = (script, events, extra = {}) => JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/other-hook --flag" }] }], ...Object.fromEntries(Object.entries(events).map(([e, a]) => [e, [{ matcher: "", hooks: [{ type: "command", command: `${script} ${a}`, timeout: 5 }] }]])), ...extra } });
const put = (root, rel, text) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
const hooksRun = (f, over = {}) => doctor(f, { path: withNode(f), env: { HOME: f.root, ...over } });
const bothLines = (r) => [line(r, "hooks-claude"), line(r, "hooks-codex")];

test("hooks: no config files: both lines skip, exit 0; a config with only other hooks is skip too", () => {
  const f = fx();
  let r = hooksRun(f);
  assert.equal(r.status, 0); for (const l of bothLines(r)) assert.match(l, /^skip  hooks-(claude|codex)  /);
  put(f.root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } }));
  r = hooksRun(f);
  assert.match(line(r, "hooks-claude"), /^skip  hooks-claude  not installed/);
});

test("hooks: a full Claude and Codex set: ok on both, exit 0, only fixed phrases and counts", () => {
  const f = fx();
  put(f.root, ".claude/settings.json", cfg(hookScript(f), CLAUDE_SET));
  put(f.root, ".codex/hooks.json", cfg(hookScript(f), CODEX_SET));
  const r = hooksRun(f);
  assert.equal(r.status, 0, r.stdout);
  assert.match(line(r, "hooks-claude"), /^ok  hooks-claude  7 events call an existing script$/);
  assert.match(line(r, "hooks-codex"), /^ok  hooks-codex  4 events call an existing script$/);
  assert.equal(r.stderr, "");
});

test("hooks: a missing event, an unknown event, a gone script, a script that is not executable, a wrong action: WARN with a fixed reason, never FAIL", () => {
  const f = fx();
  const claude = (text) => { put(f.root, ".claude/settings.json", text); return line(hooksRun(f), "hooks-claude"); };
  const { SessionEnd, ...fewer } = CLAUDE_SET;
  assert.match(claude(cfg(hookScript(f), fewer)), /^WARN  hooks-claude  an event of the set is missing$/);
  assert.match(claude(cfg(hookScript(f), { ...CLAUDE_SET, MadeUpEvent: "set" })), /^WARN  hooks-claude  an event is unknown to this Drover$/);
  assert.match(claude(cfg(hookScript(f), { ...CLAUDE_SET, PermissionRequest: "clear" })), /^WARN  hooks-claude  an event has the wrong action$/);
  assert.match(claude(cfg(join(f.root, "gone", "drover-asks-hook"), CLAUDE_SET)), /^WARN  hooks-claude  hook script missing$/);
  const named = put(f.root, "x/drover-asks-hook", "#!/bin/sh\n"); chmodSync(named, 0o644);
  assert.match(claude(cfg(named, CLAUDE_SET)), /^WARN  hooks-claude  hook script not executable$/);
  assert.match(claude(cfg(hookScript(f), { ...CLAUDE_SET }).replace(" set\"", " bogus\"")), /^WARN  hooks-claude  hook command not recognised$/);
  const r = hooksRun(f); assert.equal(r.status, 0, "a WARN never fails doctor");
});

test("hooks: Codex has no Notification event: registering it for Codex is an unknown event", () => {
  const f = fx();
  put(f.root, ".codex/hooks.json", cfg(hookScript(f), { ...CODEX_SET, Notification: "set" }));
  assert.match(line(hooksRun(f), "hooks-codex"), /^WARN  hooks-codex  an event is unknown to this Drover$/);
});

test("hooks: malformed JSON, a non-object root, a huge file: WARN unreadable, no crash, no file content in the output", () => {
  const f = fx();
  for (const text of ["{ not json " + FAKE_SEC, "[]", "null", "123", "x".repeat(3_000_000)]) {
    put(f.root, ".claude/settings.json", text);
    const r = hooksRun(f);
    assert.equal(r.status, 0); assert.match(line(r, "hooks-claude"), /^WARN  hooks-claude  config unreadable$/);
    assert.ok(!r.stdout.includes(FAKE_SEC)); assert.equal(r.stderr, "");
  }
});

test("hooks: no node on the PATH: both lines skip with a fixed phrase", () => {
  const f = fx();
  put(f.root, ".claude/settings.json", cfg(hookScript(f), CLAUDE_SET));
  const r = doctor(f, { env: { HOME: f.root } }); // the default private PATH has no node
  assert.match(line(r, "hooks-claude"), /^skip  hooks-claude  cannot read JSON \(no node\)$/);
  assert.match(line(r, "hooks-codex"), /^skip  hooks-codex  cannot read JSON \(no node\)$/);
});

test("hooks: the output never holds a path, an env value or config content", () => {
  const f = fx();
  put(f.root, ".claude/settings.json", cfg(hookScript(f), CLAUDE_SET, { env: { TOKEN: SK }, FakeEvent: [{ hooks: [{ type: "command", command: `${GH("a")} ${hookScript(f)} set` }] }] }));
  const r = hooksRun(f, { DROVER_CODEX_HOOKS: join(f.root, "secret-dir-" + FAKE_SEC, "hooks.json") });
  const out = r.stdout + r.stderr;
  for (const s of [f.root, SK, FAKE_SEC, "secret-dir", "settings.json", "hooks.json", "FakeEvent"]) assert.ok(!out.includes(s), `printed ${s}`);
  assert.ok(!out.includes(GH("a")));
});

test("hooks: isolation: with only HOME=scratch the files read are scratch/.claude/settings.json and scratch/.codex/hooks.json; an empty HOME gives skip; flags and env override", () => {
  const f = fx();
  const good = cfg(hookScript(f), CLAUDE_SET), goodCodex = cfg(hookScript(f), CODEX_SET);
  // a second tree with ok configs that must NOT be read when HOME points to an empty dir
  const other = tmp("doctor-other-"); put(other, ".claude/settings.json", good); put(other, ".codex/hooks.json", goodCodex);
  const emptyHome = tmp("doctor-empty-");
  let r = hooksRun(f, { HOME: emptyHome });
  for (const l of bothLines(r)) assert.match(l, /^skip  /, l);
  r = hooksRun(f, { HOME: other });
  assert.match(line(r, "hooks-claude"), /^ok  /); assert.match(line(r, "hooks-codex"), /^ok  /);
  // flags override HOME
  r = doctor(f, { path: withNode(f), args: ["doctor", "--claude-settings", join(other, ".claude", "settings.json"), "--codex-hooks", join(other, ".codex", "hooks.json")], env: { HOME: emptyHome } });
  assert.match(line(r, "hooks-claude"), /^ok  /); assert.match(line(r, "hooks-codex"), /^ok  /);
  // env override
  r = hooksRun(f, { HOME: emptyHome, DROVER_CLAUDE_SETTINGS: join(other, ".claude", "settings.json"), DROVER_CODEX_HOOKS: join(other, ".codex", "hooks.json") });
  assert.match(line(r, "hooks-claude"), /^ok  /); assert.match(line(r, "hooks-codex"), /^ok  /);
  // a flag without a value is a usage error
  assert.equal(doctor(f, { args: ["doctor", "--claude-settings"] }).status, 2);
});

test("hooks: the doctor changes nothing (the configs are byte-identical afterwards, no file is created)", () => {
  const f = fx();
  const a = put(f.root, ".claude/settings.json", cfg(hookScript(f), CLAUDE_SET)), b = put(f.root, ".codex/hooks.json", cfg(hookScript(f), CODEX_SET));
  const before = [readFileSync(a, "utf8"), readFileSync(b, "utf8")];
  hooksRun(f);
  assert.deepEqual([readFileSync(a, "utf8"), readFileSync(b, "utf8")], before);
  assert.deepEqual(readdirSync(join(f.root, ".claude")), ["settings.json"]);
});

test("hooks: a config path that is a FIFO (or a link to one) is a WARN unreadable, and doctor still finishes", () => {
  const f = fx();
  const fifo = join(f.root, "fifo-settings"); assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  symlinkSync(fifo, join(f.root, "fifo-link"));
  for (const p of [fifo, join(f.root, "fifo-link")]) {
    const r = doctor(f, { path: withNode(f), args: ["doctor", "--claude-settings", p], env: { HOME: f.root } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(line(r, "hooks-claude"), /^WARN  hooks-claude  config unreadable$/);
  }
});

// hooks-locks: a lock dir of the asks hook older than 10 s (LOCK_STALE_MS) means a hook stopped mid-write; the hook itself reclaims it by age at its next run
const lockDir = (f, name, ageMs) => { const p = join(f.home, "data", "drover-asks", name); mkdirSync(p, { recursive: true }); const t = (Date.now() - ageMs) / 1000; utimesSync(p, t, t); return p; };
test("hooks-locks: no asks folder = skip; no lock or a young one = ok; a lock older than 10 s = WARN; fixed text, no path, never FAIL", () => {
  const f = fx();
  let r = hooksRun(f);
  assert.match(line(r, "hooks-locks"), /^skip  hooks-locks  no asks folder yet$/);
  mkdirSync(join(f.home, "data", "drover-asks"), { recursive: true });
  writeFileSync(join(f.home, "data", "drover-asks", "t1.json"), "{}");
  assert.match(line(hooksRun(f), "hooks-locks"), /^ok  hooks-locks  no stale lock$/);
  lockDir(f, "t1.lock", 2_000);
  assert.match(line(hooksRun(f), "hooks-locks"), /^ok  hooks-locks  no stale lock$/);
  lockDir(f, "t2.lock", 30_000);
  r = hooksRun(f);
  assert.match(line(r, "hooks-locks"), /^WARN  hooks-locks  a lock is older than 10 s \(a hook stopped mid-write; the next hook clears it\)$/);
  assert.equal(r.status, 0, "a WARN never fails doctor");
  const out = r.stdout + r.stderr;
  for (const s of [f.root, "t2.lock", "drover-asks"]) assert.ok(!out.includes(s), `printed ${s}`);
});
test("hooks-locks: a symlinked or plain-file lock name is ignored; no node = skip; the doctor creates nothing", () => {
  const f = fx();
  const d = join(f.home, "data", "drover-asks"); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "t3.lock"), "not a dir"); const old = (Date.now() - 60_000) / 1000; utimesSync(join(d, "t3.lock"), old, old);
  symlinkSync(f.root, join(d, "t4.lock"));
  assert.match(line(hooksRun(f), "hooks-locks"), /^ok  hooks-locks  no stale lock$/);
  lockDir(f, "t5.lock", 60_000);
  assert.match(line(doctor(f, { env: { HOME: f.root } }), "hooks-locks"), /^skip  hooks-locks  cannot read the folder \(no node\)$/);
  assert.deepEqual(readdirSync(d).sort(), ["t3.lock", "t4.lock", "t5.lock"]);
});

// ---- accept locks (B3b): a read-only WARN for a lock older than 15 minutes; never a removal ----
const acceptLockDir = (f, name) => join(f.home, "data", "drover-accept", `${name}.lock`);
const mkLock = (f, name, content) => { mkdirSync(acceptLockDir(f, name), { recursive: true }); writeFileSync(join(acceptLockDir(f, name), "token"), content); };
const nowSec = () => Math.floor(Date.now() / 1000);

test("an accept lock older than 15 minutes: WARN with a count and where to read more; exit 0; the lock and its token are untouched", () => {
  const f = fx();
  mkLock(f, "P-1__T-1", `secret-looking-token\n${nowSec() - 16 * 60}`);
  const before = readFileSync(join(acceptLockDir(f, "P-1__T-1"), "token"), "utf8");
  const r = doctor(f);
  assert.equal(r.status, 0, "a WARN is not a failure");
  assert.equal(status(r, "accept-locks"), "WARN", line(r, "accept-locks"));
  assert.match(line(r, "accept-locks"), /1 accept lock.*older than 15 min/);
  assert.match(lines(r).at(-1), /^doctor: 5 ok, 1 warn, 0 fail$/);
  assert.ok(existsSync(acceptLockDir(f, "P-1__T-1")), "doctor removes nothing");
  assert.equal(readFileSync(join(acceptLockDir(f, "P-1__T-1"), "token"), "utf8"), before);
  assert.doesNotMatch(r.stdout + r.stderr, /secret-looking|P-1__T-1|drover-accept/, "no token, key or path is printed");
});

test("a fresh accept lock does not warn; two old ones are counted; an unreadable age counts as old", () => {
  const f = fx();
  mkLock(f, "P-1__T-1", `tk\n${nowSec() - 60}`);
  assert.equal(status(doctor(f), "accept-locks"), "ok");
  mkLock(f, "P-1__T-2", `tk\n${nowSec() - 3600}`);
  mkLock(f, "P-1__T-3", "no timestamp here");
  const r = doctor(f);
  assert.equal(status(r, "accept-locks"), "WARN");
  assert.match(line(r, "accept-locks"), /2 accept locks/);
  assert.ok(["P-1__T-1", "P-1__T-2", "P-1__T-3"].every((n) => existsSync(acceptLockDir(f, n))), "nothing removed");
});

test("an unreadable or empty token file is an old lock, never a crash or a removal", () => {
  const f = fx();
  mkdirSync(acceptLockDir(f, "P-1__T-9"), { recursive: true });
  const r = doctor(f);
  assert.equal(status(r, "accept-locks"), "WARN");
  assert.ok(existsSync(acceptLockDir(f, "P-1__T-9")));
});
