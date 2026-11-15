// launch() resolves the work folder from drover.config, passes it in every prompt, and makes it (0700, via the helper) only in global modes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const CFG = { agents: [
  { id: "lead", name: "Lead", command: "claude", soul: "", instructions: "" },
  { id: "w1", name: "W1", command: "codex", soul: "", instructions: "" },
], squads: [{ id: "s1", name: "Crew", version: 1, leader: "lead", members: [{ agent: "w1", role: "Inspector" }] }] };
const PROJECTS = [{ id: "P-1", name: "App", repos: [{ path: "/r/app", default: true }], folders: [], branch: "main" }];
const BIN = "/app/mods/drover-agents/bin/drover-workfolder";
let host, calls, helper;
const setup = (mode, { fail = false } = {}) => {
  calls = []; helper = [];
  host = globalThis.__host = { appHome: "/app", home: "/home/u", props: {}, notified: [], terminals: [],
    state: { "drover.agents": CFG, "drover.projects": PROJECTS, ...(mode ? { "drover.config": { "drover-config": { work_folder: mode } } } : {}) },
    readTextFile: async () => null };
  let n = 0;
  host.exec = async (cmd, args) => {
    if (cmd === BIN) { helper.push(args); return fail ? { code: 1, stdout: "", stderr: "cannot create: Permission denied" } : { code: 0, stdout: args[1] + "\n" }; }
    if (cmd !== "herdr-app") return { code: 0, stdout: "" };
    const [, op, ...rest] = args;
    calls.push([op, rest]);
    return { code: 0, stdout: JSON.stringify({ terminal: `t${++n}` }) };
  };
};
const { launch } = await import("../_lib/io.js");
const prompts = () => calls.filter(([op]) => op === "tab.new" || op === "space.new").map(([, r]) => r[r.indexOf("--task") + 1]);
const line = (p) => /Work folder \(plans, scouts, reviews, lane logs\): (\S+)/.exec(p)?.[1];

beforeEach(() => setup(null));

test("repo mode: every prompt names <repo>/.drover and no folder is made by Drover", async () => {
  setup("repo");
  await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
  assert.equal(prompts().length, 2);
  for (const p of prompts()) assert.equal(line(p), "/r/app/.drover");
  assert.deepEqual(helper, []);
});

test("project mode: <configDir>/work/<project id>, made with the helper before the agents start", async () => {
  setup("project");
  await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
  for (const p of prompts()) assert.equal(line(p), "/home/u/.config/drover-herdr/work/P-1");
  assert.deepEqual(helper, [["ensure", "/home/u/.config/drover-herdr/work/P-1", "--root", "/home/u/.config/drover-herdr"]]);
});

test("a saved \"run\" (the removed mode) reads as project", async () => {
  setup("run");
  await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
  const want = "/home/u/.config/drover-herdr/work/P-1";
  for (const p of prompts()) assert.equal(line(p), want);
  assert.deepEqual(helper, [["ensure", want, "--root", "/home/u/.config/drover-herdr"]]);
});

test("a run without a project uses _free", async () => {
  setup("project");
  await launch(null, { kind: "squad", id: "s1" });
  for (const p of prompts()) assert.equal(line(p), "/home/u/.config/drover-herdr/work/_free");
});

test("the helper refusing the folder aborts the launch: no agent opens, no run is saved, the reason is shown", async () => {
  for (const mode of ["project"]) {
    setup(mode, { fail: true });
    const run = await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
    assert.equal(run.id, undefined, "no run");
    assert.match(run.error, /^work folder not ready: \/home\/u\/\.config\/drover-herdr\/work\/P-1.*Permission denied/);
    assert.deepEqual(calls, [], "no tab or space was opened");
    assert.equal(host.state["drover.runs"], undefined, "no run record");
    assert.equal(host.notified.length, 1);
    assert.match(host.notified[0].body, /work folder not ready.*Permission denied/);
  }
});

test("the folder is checked before the worktree is made (a refusal leaves no worktree behind)", async () => {
  setup("project", { fail: true });
  const git = [];
  const inner = host.exec;
  host.exec = async (cmd, args, ...r) => { if (cmd === "git") git.push(args); return inner(cmd, args, ...r); };
  const run = await launch({ id: "T-1", title: "t", project: "P-1", column: "ready" }, { kind: "squad", id: "s1" }, { worktree: true });
  assert.match(run.error, /work folder not ready/);
  assert.deepEqual(git, []);
});

test("default (no setting) and an invalid config value both give project mode", async () => {
  for (const mode of [null, "global"]) {
    setup(mode);
    await launch(null, { kind: "squad", id: "s1" }, { project: "P-1" });
    for (const p of prompts()) assert.equal(line(p), "/home/u/.config/drover-herdr/work/P-1");
  }
});
