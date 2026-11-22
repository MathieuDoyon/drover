// T-MWPK6KYSFZV (B4a part B): the real `drover doctor` against files written by the real install: ok after install, WARN when the launcher is gone or not executable, skip after uninstall,
// the runtime line, resolver parity with `asks-hook status`, and no path or file content in the doctor's output. Scratch tree only; the doctor's own repo checks (mods-linked...) are not asserted here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { lib, world, run, write, read, cleanup, BIN, tmp } from "./asks-install-helper.js";
after(cleanup);
const DROVER = join(BIN, "drover");
const sh = (n) => spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }).stdout.trim();
const toolBin = (extra = []) => { const d = tmp("asks-doctor-bin-"); for (const n of ["bash", "sh", "env", "cat", "cmp", "readlink", "dirname", "basename", "wc", "tr", "sed", "head", "tail", "grep", "ls", "cut", "expr", "date", "sleep", ...extra]) { const p = sh(n); if (p) { try { symlinkSync(p, join(d, n)); } catch {} } } return d; };
function doctor(w, { node = true, env = {}, args = [] } = {}) {
  const bin = toolBin();
  const e = { HOME: w.home, HERDR_APP_HOME: w.app, PATH: bin, DROVER_NODE: process.execPath, DROVER_TEST: "1", DROVER_TEST_ROOT: w.root, ...env }; // guarded by default: a config that resolves outside the scratch root is never opened
  if (node) symlinkSync(process.execPath, join(bin, "node"));
  const r = spawnSync("/bin/bash", [DROVER, "doctor", "--home", w.app, ...args], { env: e, encoding: "utf8" });
  const line = (name) => (r.stdout.split("\n").find((l) => l.includes(` ${name} `)) || "").trim();
  return { ...r, line };
}
test("doctor: skip before install, ok after, WARN when the launcher is gone or not executable, skip after uninstall", async () => {
  const w = world();
  assert.match(doctor(w).line("hooks-claude"), /^skip/);
  await run(w, ["install", "--yes"]);
  let d = doctor(w);
  assert.match(d.line("hooks-claude"), /^ok .*7 events call an existing script/); assert.match(d.line("hooks-codex"), /^ok .*4 events/);
  chmodSync(w.lpath, 0o644);
  assert.match(doctor(w).line("hooks-claude"), /^WARN .*not executable/);
  rmSync(w.lpath);
  assert.match(doctor(w).line("hooks-codex"), /^WARN .*hook script missing/);
  writeFileSync(w.lpath, "#!/bin/sh\n", { mode: 0o755 });
  await run(w, ["uninstall", "--yes"]);
  d = doctor(w);
  assert.match(d.line("hooks-claude"), /^skip/); assert.match(d.line("hooks-codex"), /^skip/);
});
test("doctor reads the same file as install: CLAUDE_CONFIG_DIR and CODEX_HOME, flags over env; output holds no path or file content", async () => {
  const w = world();
  const cdir = join(w.root, "cfg"), xdir = join(w.root, "cx"); mkdirSync(cdir); mkdirSync(xdir);
  const env = { ...w.env, CLAUDE_CONFIG_DIR: cdir, CODEX_HOME: xdir };
  await run(w, ["install", "--yes"], { env });
  const d = doctor(w, { env: { CLAUDE_CONFIG_DIR: cdir, CODEX_HOME: xdir } });
  assert.match(d.line("hooks-claude"), /^ok/); assert.match(d.line("hooks-codex"), /^ok/);
  assert.match(doctor(w).line("hooks-claude"), /^skip/); // the default home has none
  assert.ok(!d.stdout.includes(w.root) && !d.stdout.includes("settings.json") && !d.stdout.includes("drover-asks-hook'"), "no path or content in doctor output");
  const flag = doctor(w, { env: { CLAUDE_CONFIG_DIR: cdir }, args: ["--claude-settings", join(w.root, "none.json")] });
  assert.match(flag.line("hooks-claude"), /^skip .*no config file/);
  const st = await run(w, ["status", "--claude"], { env });
  assert.ok(st.out.includes(join(cdir, "settings.json")));
});
test("hooks-runtime: skip with no hook; ok with node on PATH; without node ok only when the runtime file names an existing node; WARN absent/differs", async () => {
  const w = world();
  assert.match(doctor(w).line("hooks-runtime"), /^skip .*no hook installed/);
  await run(w, ["install", "--yes"]);
  assert.match(doctor(w).line("hooks-runtime"), /^ok .*node is on PATH/);
  // the doctor itself needs a node to read JSON: DROVER_NODE points at it while PATH has none
  assert.match(doctor(w, { node: false }).line("hooks-runtime"), /^ok .*runtime file names an existing node/);
  write(w.leaf, "/nonexistent/node\n", 0o600);
  assert.match(doctor(w, { node: false }).line("hooks-runtime"), /^WARN .*does not name an existing node/);
  rmSync(w.leaf);
  assert.match(doctor(w, { node: false }).line("hooks-runtime"), /^WARN .*no runtime file/);
  await run(w, ["uninstall", "--yes"]);
  assert.match(doctor(w, { node: false }).line("hooks-runtime"), /^skip/);
});
test("drover asks-hook is wired in the CLI: usage lists it and status runs through the dispatcher", () => {
  const w = world();
  const bin = toolBin(); symlinkSync(process.execPath, join(bin, "node"));
  const env = { HOME: w.home, HERDR_APP_HOME: w.app, PATH: bin, DROVER_TEST: "1", DROVER_TEST_ROOT: w.root };
  const u = spawnSync("/bin/bash", [DROVER], { env, encoding: "utf8" });
  assert.match(u.stdout + u.stderr, /drover asks-hook install\|uninstall\|status/);
  const s = spawnSync("/bin/bash", [DROVER, "asks-hook", "status"], { env, encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr); assert.match(s.stdout, /\[claude\] not installed/);
  const n = spawnSync("/bin/bash", [DROVER, "asks-hook", "install"], { env, encoding: "utf8", input: "" });
  assert.equal(n.status, 2); assert.ok(!require_exists(w.claude));
});
import { existsSync } from "node:fs";
function require_exists(p) { return existsSync(p); }

test("test-mode guard on the doctor's own readers (review 1, Medium 6; class: every subprocess that opens a configured path): a symlink out of the scratch root is never read", async () => {
  const w = world();
  const outside = tmp("asks-doctor-outside-");
  const wanted = lib.wantedFor("claude", w.lpath);
  write(join(outside, "settings.json"), lib.render(lib.planInstall({}, "claude", wanted).next, "  ", true));
  write(join(outside, "runtime"), process.execPath + "\n");
  symlinkSync(join(outside, "settings.json"), w.claude);
  mkdirSync(w.data, { recursive: true }); symlinkSync(join(outside, "runtime"), w.leaf);
  const guarded = { DROVER_TEST: "1", DROVER_TEST_ROOT: w.root };
  const d = doctor(w);
  assert.match(d.line("hooks-claude"), /^WARN .*config unreadable/, "an ordinary (default) doctor call refuses a config outside the scratch root");
  const unguarded = doctor(w, { env: { DROVER_TEST: "0" } }); // the one deliberate contrast
  assert.match(unguarded.line("hooks-claude"), /^ok /, "control: without the guard the same file is read");
  const chk = (...a) => spawnSync(process.execPath, [join(BIN, "drover-asks-check.mjs"), ...a], { env: { ...process.env, ...guarded }, encoding: "utf8" }).stdout.trim();
  assert.equal(chk("runtime", w.leaf), "differs");
  assert.equal(chk("locks", join(outside)), "unreadable");
});
test("the checker in test mode without a scratch root fails closed", () => {
  const w = world();
  const r = spawnSync(process.execPath, [join(BIN, "drover-asks-check.mjs"), "claude", w.claude], { env: { ...process.env, DROVER_TEST: "1", DROVER_TEST_ROOT: "" }, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "unreadable");
});
