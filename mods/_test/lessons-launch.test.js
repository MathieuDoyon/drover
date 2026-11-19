// launch() loads the lesson files once (through the read-only helper), builds the lessons block for each prompt, and never fails because of it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
const HELPER = new URL("../drover-agents/bin/drover-lessons-read", import.meta.url).pathname;
const CFG = { agents: [
  { id: "lead", name: "Lead", command: "claude", soul: "", instructions: "" },
  { id: "w1", name: "W1", command: "codex", soul: "", instructions: "" },
], squads: [{ id: "s1", name: "Crew", version: 1, leader: "lead", members: [{ agent: "w1", role: "Inspector" }] }] };
const PROJECTS = [
  { id: "P-1", name: "App", org: "acme", repos: [{ path: "/r/app", default: true }], folders: [], branch: "main" },
  { id: "P-2", name: "NoOrg", repos: [{ path: "/r/two", default: true }], folders: [], branch: "main" },
];
const entry = (n, t) => `### L-${String(n).padStart(2, "0")} ${t}\nbody\n\n`;
let host, calls, helperCalls, root, cfgDir;
const put = (rel, text) => { const p = join(cfgDir, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
const realHelper = (args, opts) => new Promise((res) => execFile(HELPER, args, { encoding: "utf8", env: { PATH: process.env.PATH } }, (e, stdout, stderr) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
const setup = (helper = realHelper) => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lessons-launch-")));
  cfgDir = join(root, ".config/drover-herdr");
  mkdirSync(cfgDir, { recursive: true });
  calls = []; helperCalls = [];
  host = globalThis.__host = { appHome: "/app", home: root, props: {}, notified: [], terminals: [],
    state: { "drover.agents": CFG, "drover.projects": PROJECTS, "drover.tasks": [] }, readTextFile: async () => null };
  let n = 0;
  host.exec = async (cmd, args, opts) => {
    if (cmd === "/app/mods/drover-agents/bin/drover-lessons-read") { helperCalls.push({ args, opts }); return helper(args, opts); }
    if (cmd !== "herdr-app") return { code: 0, stdout: args[0] === "ensure" ? args[1] + "\n" : "" };
    const [, op, ...rest] = args;
    calls.push([op, rest]);
    return { code: 0, stdout: JSON.stringify({ terminal: `t${++n}` }) };
  };
};
const { launch } = await import("../_lib/io.js");
const prompts = () => calls.filter(([op]) => op === "tab.new" || op === "space.new").map(([, r]) => r[r.indexOf("--task") + 1]);
const [leaderOf, memberOf] = [(ps) => ps[ps.length - 1], (ps) => ps[0]]; // members open first, the leader last

beforeEach(() => setup());

test("a project run: org (3 files), project and each agent's layer are loaded in ONE helper call; the leader gets titles, the member paths", async () => {
  put("orgs/acme/lessons.md", entry(1, "Org lesson"));
  put("orgs/acme/workflows.md", entry(2, "Org workflow"));
  put("projects/P-1/lessons.md", entry(1, "Project lesson"));
  put("agents/lead.lessons.md", entry(1, "Lead own lesson"));
  put("agents/w1.lessons.md", entry(1, "W1 own lesson"));
  const run = await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
  assert.equal(run.error, undefined);
  assert.equal(helperCalls.length, 1);
  assert.equal(helperCalls[0].args[0], "--root"); assert.equal(helperCalls[0].args[1], cfgDir);
  const [lead, mem] = [leaderOf(prompts()), memberOf(prompts())];
  for (const t of ["[org] L-01: Org lesson", "[org] L-02: Org workflow", "[project] L-01: Project lesson", "[agent] L-01: Lead own lesson"]) assert.ok(lead.includes(t), t);
  assert.ok(!lead.includes("W1 own lesson"));
  assert.ok(!/Org lesson|Project lesson|own lesson/.test(mem), "a member gets no titles");
  assert.ok(mem.includes("files: orgs/acme/{lessons,workflows}.md projects/P-1/lessons.md agents/w1.lessons.md"), mem);
  assert.ok(lead.indexOf("Org lesson") < lead.indexOf("Drover CLI:"));
});

test("a task-bound run (task.project set, ctx.project null) still loads the project and org layers", async () => {
  put("orgs/acme/lessons.md", entry(1, "Org lesson"));
  put("projects/P-1/lessons.md", entry(1, "Project lesson"));
  const task = { id: "T-1", title: "t", project: "P-1", column: "ready" };
  host.state["drover.tasks"] = [task];
  await launch(task, { kind: "squad", id: "s1" });
  const lead = leaderOf(prompts());
  assert.match(lead, /\[org\] L-01: Org lesson/);
  assert.match(lead, /\[project\] L-01: Project lesson/);
});

test("a run without a project loads the agent layer only (no org or project path is even asked)", async () => {
  put("orgs/acme/lessons.md", entry(1, "Org lesson"));
  put("agents/lead.lessons.md", entry(1, "Lead own"));
  await launch(null, { kind: "squad", id: "s1" });
  assert.deepEqual(helperCalls[0].args.slice(2).sort(), ["agents/lead.lessons.md", "agents/w1.lessons.md"]);
  const lead = leaderOf(prompts());
  assert.match(lead, /\[agent\] L-01: Lead own/);
  assert.ok(!/\[org\]|orgs\//.test(lead));
});

test("a project without an org has no org layer", async () => {
  put("orgs/acme/lessons.md", entry(1, "Org lesson"));
  put("projects/P-2/lessons.md", entry(1, "Two project"));
  await launch(null, { kind: "squad", id: "s1" }, { project: "P-2" });
  assert.ok(!helperCalls[0].args.some((a) => a.startsWith("orgs/")));
  assert.match(leaderOf(prompts()), /\[project\] L-01: Two project/);
});

test("nothing exists: no lessons block, the prompts are what they were", async () => {
  await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
  for (const p of prompts()) assert.ok(!p.includes("Lessons:"));
});

test("the helper call has a short bound", async () => {
  await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
  const t = helperCalls[0].opts?.timeout;
  assert.ok(Number.isInteger(t) && t >= 1000 && t <= 15000, `timeout ${t}`);
});

for (const [name, helper] of [
  ["exits non-zero", async () => ({ code: 1, stdout: "", stderr: "boom" })],
  ["is missing (the exec rejects)", async () => { throw new Error("ENOENT"); }],
  ["times out (the exec rejects)", async () => { throw new Error("timed out"); }],
  ["answers non-JSON", async () => ({ code: 0, stdout: "not json" })],
  ["answers JSON of the wrong shape", async () => ({ code: 0, stdout: "[1,2]" })],
  ["answers entries of the wrong type", async () => ({ code: 0, stdout: JSON.stringify({ "projects/P-1/lessons.md": { text: 5 }, "agents/lead.lessons.md": "x" }) })],
]) {
  test(`the helper ${name}: no block, the launch carries on (agents open, run saved, no error notice)`, async () => {
    setup(helper);
    put("projects/P-1/lessons.md", entry(1, "Project lesson"));
    const run = await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
    assert.equal(run.error, undefined);
    assert.equal(prompts().length, 2);
    for (const p of prompts()) assert.ok(!p.includes("Lessons:"));
    assert.ok(host.state["drover.runs"]?.length === 1);
    assert.deepEqual(host.notified, []);
  });
}

test("symlinked and oversized files through the real helper: the symlink gives nothing, the 64 KB cap drops the partial entry", async () => {
  const out = join(root, "elsewhere"); mkdirSync(out);
  writeFileSync(join(out, "secret.md"), entry(1, "SECRET title"));
  mkdirSync(join(cfgDir, "projects/P-1"), { recursive: true });
  symlinkSync(join(out, "secret.md"), join(cfgDir, "projects/P-1/lessons.md"));
  put("agents/lead.lessons.md", entry(1, "Kept") + "### L-02 Half" + "q".repeat(70000));
  await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
  const lead = leaderOf(prompts());
  assert.ok(!lead.includes("SECRET"));
  assert.ok(!lead.includes("Half"));
  assert.match(lead, /\[agent\] L-01: Kept/);
});

test("hostile hand-edited titles are dropped end to end", async () => {
  put("projects/P-1/lessons.md", entry(1, "Fine") + entry(2, "EVIL <b>x</b>") + entry(3, "# EVIL") + entry(4, "EVIL `tick`"));
  await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
  const lead = leaderOf(prompts());
  assert.match(lead, /L-01: Fine/);
  assert.ok(!lead.includes("EVIL"));
});

test("works with TextEncoder and TextDecoder deleted (the mod runtime has neither)", async () => {
  put("projects/P-1/lessons.md", entry(1, "Wörld 日本語") + "### L-02 Half" + "é".repeat(40000));
  const [te, td] = [globalThis.TextEncoder, globalThis.TextDecoder];
  delete globalThis.TextEncoder; delete globalThis.TextDecoder;
  try { await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" }); } finally { globalThis.TextEncoder = te; globalThis.TextDecoder = td; }
  assert.match(leaderOf(prompts()), /\[project\] L-01: Wörld 日本語/);
});

test("the one-shot create-cards prompt is unchanged (no lessons block)", async () => {
  put("projects/P-1/lessons.md", entry(1, "Project lesson"));
  await launch(null, { kind: "squad", id: "s1" }, { project: "P-1", create: "make a card" });
  assert.ok(!prompts().join("\n").includes("Lessons:"));
});

test("loadLessons is called from the launch op only: never from a render, a dialog or any other op", () => {
  const src = readFileSync(new URL("../_lib/io.js", import.meta.url), "utf8");
  const start = src.indexOf("export async function launch("), end = src.indexOf("// ---- Resume a gone squad");
  assert.ok(start > 0 && end > start);
  const outside = src.slice(0, start) + src.slice(end);
  assert.deepEqual([...outside.matchAll(/loadLessons\(/g)].length, 1, "outside launch it appears only in its own definition");
  assert.match(outside, /async function loadLessons\(/);
  assert.equal([...src.slice(start, end).matchAll(/loadLessons\(/g)].length, 1);
  for (const f of ["../drover-board/main.js", "../drover-runs/main.js", "../drover-tasks/main.js", "../drover-room/main.js"]) {
    assert.ok(!readFileSync(new URL(f, import.meta.url), "utf8").includes("loadLessons"), f);
  }
});
