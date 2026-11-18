// C3: launch wires the drover-env wrapper when an agent has an env file; no file = argv unchanged;
// a wrapper problem never falls back to the plain agent; run records hold no value.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

register("./hooks.js", import.meta.url);
const CFG = { agents: [
  { id: "lead", name: "Lead", command: "claude --model opus", soul: "", instructions: "" },
  { id: "w1", name: "W1", command: "codex", soul: "", instructions: "" },
], squads: [{ id: "s1", name: "Crew", version: 1, leader: "lead", members: [{ agent: "w1", role: "Inspector" }] }] };
const FAKE = "fake-canary-value-123";
let host, calls, tmp;
beforeEach(async () => {
  calls = [];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "c3-"));
  await fs.mkdir(path.join(tmp, ".config/drover-herdr/agents"), { recursive: true });
  // Real shapes: the mod fs cannot touch ~/.config (a denied call rejects with a code-less Error); readTextFile reads it (null when absent).
  host = globalThis.__host = { appHome: "/app", home: tmp, props: {}, notified: [], terminals: [], state: { "drover.agents": CFG },
    fsGuard: (_op, p) => { if (!p.startsWith("/app")) throw new Error("fs access denied"); },
    readTextFile: async (p) => { try { return await fs.readFile(p, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } } };
  let n = 0;
  host.exec = async (cmd, args) => {
    if (cmd !== "herdr-app") return { code: 0, stdout: "" };
    const [, op, ...rest] = args;
    calls.push([op, rest]);
    return { code: 0, stdout: JSON.stringify({ terminal: `t${++n}` }) };
  };
});
const { launch } = await import("../_lib/io.js");
const WRAP = "/app/mods/drover-agents/bin/drover-env";
const envFile = (id, body = `{"version":1,"env":{"GH_TOKEN":{"value":"${FAKE}","secret":true}}}`) =>
  fs.writeFile(path.join(tmp, ".config/drover-herdr/agents", id + ".json"), body, { mode: 0o600 });
// Claude also gets a Drover-made --session-id <uuid> (session-record.test.js covers it): dropped here so these tests stay about the wrapper.
const noSession = (a) => { const i = a.indexOf("--session-id"); return i < 0 ? a : [...a.slice(0, i), ...a.slice(i + 2)]; };
const argvs = () => calls.filter(([op]) => op === "tab.new" || op === "space.new").map(([, r]) => noSession(JSON.parse(r[r.indexOf("--argv") + 1])));

test("no env file: argv is unchanged", async () => {
  await launch(null, { kind: "squad", id: "s1" });
  assert.deepEqual(argvs(), [["codex"], ["claude", "--model", "opus"]]);
});

test("env file: that agent's argv is wrapped, others unchanged", async () => {
  await envFile("w1");
  await launch(null, { kind: "squad", id: "s1" });
  assert.deepEqual(argvs(), [[WRAP, "w1", "--", "codex"], ["claude", "--model", "opus"]]);
});

test("env file on the leader wraps the leader; park still runs for members", async () => {
  await envFile("lead");
  const run = await launch(null, { kind: "squad", id: "s1" });
  assert.deepEqual(argvs(), [["codex"], [WRAP, "lead", "--", "claude", "--model", "opus"]]);
  assert.deepEqual(calls.filter(([op]) => op === "terminal.park").map(([, r]) => r[1]), ["t1"]);
  assert.equal(run.terminals[0].parked, true);
});

test("run records and notices hold no value", async () => {
  await envFile("w1"); await envFile("lead");
  const run = await launch(null, { kind: "squad", id: "s1" });
  assert.equal(JSON.stringify(host.state["drover.runs"]).includes(FAKE), false);
  assert.equal(JSON.stringify(run).includes(FAKE), false);
  assert.equal(JSON.stringify(calls).includes(FAKE), false, "the value never reaches herdr");
  assert.equal(JSON.stringify(host.notified).includes(FAKE), false);
});

test("the check works when the mod fs is denied outside appHome (readTextFile, no readdir)", async () => {
  await launch(null, { kind: "squad", id: "s1" });
  assert.deepEqual(argvs(), [["codex"], ["claude", "--model", "opus"]]);
  await envFile("w1");
  calls.length = 0;
  await launch(null, { kind: "squad", id: "s1" });
  assert.deepEqual(argvs()[0], [WRAP, "w1", "--", "codex"]);
});

test("the launch never puts the file content anywhere, even though it reads it to see that it exists", async () => {
  await envFile("w1");
  const run = await launch(null, { kind: "squad", id: "s1" });
  assert.equal(JSON.stringify([run, calls, host.notified, host.state]).includes(FAKE), false);
});

test("an env file that cannot be read stops the launch (it may exist): never the plain agent", async () => {
  await envFile("w1");
  await fs.chmod(path.join(tmp, ".config/drover-herdr/agents/w1.json"), 0o000);
  const run = await launch(null, { kind: "squad", id: "s1" });
  assert.match(run.error, /environment/i);
  assert.match(run.error, /EACCES/);
  assert.deepEqual(argvs(), []);
});

test("a read that rejects with no code stops the launch with the code 'Error'; the log has a label and the code only", async () => {
  host.readTextFile = async () => { const e = new Error(`denied for /x ${FAKE}`); e.name = "ReadDenied"; throw e; };
  const logs = [], orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let run;
  try { run = await launch(null, { kind: "squad", id: "s1" }); } finally { console.log = orig; }
  assert.match(run.error, /\(Error\)/);
  assert.deepEqual(argvs(), []);
  assert.ok(logs.some((l) => l.includes("env check failed")));
  assert.equal(JSON.stringify([logs, run]).includes(FAKE) || JSON.stringify(logs).includes("denied for"), false);
});

test("a symlinked env file that points at a real file is read through and wrapped, so the wrapper decides (fails closed)", async () => {
  await fs.writeFile(path.join(tmp, "elsewhere.json"), "{}", { mode: 0o644 });
  await fs.symlink(path.join(tmp, "elsewhere.json"), path.join(tmp, ".config/drover-herdr/agents/w1.json"));
  await launch(null, { kind: "squad", id: "s1" });
  assert.deepEqual(argvs()[0], [WRAP, "w1", "--", "codex"]);
});

test("agents/ is a file (not a folder): readTextFile fails with ENOTDIR, the launch stops, nothing opens", async () => {
  await fs.rm(path.join(tmp, ".config/drover-herdr/agents"), { recursive: true });
  await fs.writeFile(path.join(tmp, ".config/drover-herdr/agents"), "x");
  const run = await launch(null, { kind: "squad", id: "s1" });
  assert.match(run.error, /environment/i);
  assert.deepEqual(argvs(), []);
});

test("a path-like agent id never reaches the filesystem check and never wraps", async () => {
  host.state["drover.agents"] = { agents: [{ id: "../x", name: "X", command: "codex", soul: "", instructions: "" }], squads: [] };
  await launch(null, { kind: "agent", id: "../x" });
  assert.deepEqual(argvs(), [["codex"]]);
});
