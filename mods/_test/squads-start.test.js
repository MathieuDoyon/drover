// T-MWGM0WWMFVS (#35): Squads ▶ on the Drover agent with a project chosen binds it (queue mode, like drover start --project).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

register("./hooks.js", import.meta.url);
const CFG = { agents: [
  { id: "drover", name: "Drover", command: "claude", soul: "", instructions: "" },
  { id: "helper", name: "Helper", command: "codex", soul: "", instructions: "" },
], squads: [{ id: "s1", name: "Crew", version: 1, leader: "helper", members: [] }] };
const PROJECTS = [
  { id: "P-REPO", name: "with-repo", repos: [{ path: "/repos/with", default: true }] },
  { id: "P-NONE", name: "gallery-wall", repos: [] },
];
let host, calls, tmp;
beforeEach(async () => {
  calls = [];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sq-"));
  host = globalThis.__host = { appHome: "/app", home: tmp, props: {}, notified: [], terminals: [], panes: [], spaces: [],
    focused: { space: "sp1", cwd: "/home/user/acme-store", terminal: "tA" },
    state: { "drover.agents": CFG, "drover.projects": PROJECTS, "drover.runs": [] },
    fsGuard: (_op, p) => { if (!p.startsWith("/app")) throw new Error("fs access denied"); },
    readTextFile: async () => null };
  let n = 0;
  host.exec = async (cmd, args) => {
    if (cmd !== "herdr-app") return { code: 0, stdout: "" };
    const [, op, ...rest] = args;
    calls.push([op, rest]);
    return { code: 0, stdout: JSON.stringify({ terminal: `t${++n}` }) };
  };
});
const { startFromSquads } = await import("../_lib/io.js");
const tabs = () => calls.filter(([op]) => op === "tab.new").map(([, r]) => r);
const folderOf = (r) => r[r.indexOf("--folder") + 1];
const promptOf = (r) => r[r.indexOf("--task") + 1];

test("drover + project: the run is bound to it and opens in the project's repo", async () => {
  const r = await startFromSquads("agent", "drover", "P-REPO");
  assert.equal(r.error, undefined);
  assert.equal(host.state["drover.runs"][0].project, "P-REPO");
  assert.equal(folderOf(tabs()[0]), "/repos/with");
  assert.match(promptOf(tabs()[0]), /bound to project with-repo \(P-REPO\)/);
});

test("drover + project without repo: bound, opens in the focused space's folder, with a hint", async () => {
  const r = await startFromSquads("agent", "drover", "P-NONE");
  assert.equal(r.error, undefined);
  assert.equal(host.state["drover.runs"][0].project, "P-NONE");
  assert.equal(folderOf(tabs()[0]), "/home/user/acme-store");
  assert.ok(host.notified.some((n) => /gallery-wall/.test(n.title + n.body) && /Projects/.test(n.title + n.body)), "hint to set the repo path");
});

test("no repo and no focused folder: falls back as before (no --folder), still bound and hinted", async () => {
  host.focused = { space: "sp1" };
  const r = await startFromSquads("agent", "drover", "P-NONE");
  assert.equal(r.error, undefined);
  assert.equal(tabs()[0].includes("--folder"), false);
  assert.equal(host.state["drover.runs"][0].project, "P-NONE");
  assert.ok(host.notified.some((n) => /Projects/.test(n.title + n.body)));
});

test("a second Drover for the same project is refused with a notice; nothing starts", async () => {
  host.terminals = [{ address: "tLive" }];
  host.state["drover.runs"] = [{ id: "R-1", project: "P-REPO", started: 1, terminals: [{ agent: "drover", address: "tLive", role: "leader" }] }];
  const r = await startFromSquads("agent", "drover", "P-REPO");
  assert.match(r.error, /already has Drover tLive/);
  assert.equal(tabs().length, 0);
  assert.ok(host.notified.some((n) => n.level === "error" && /already has Drover/.test(n.body)));
  assert.equal(host.state["drover.runs"].length, 1);
});

test("no free slot is not a bind concern; the binding reservation is cleared after the start", async () => {
  await startFromSquads("agent", "drover", "P-REPO");
  assert.equal(host.state["drover.binding"]?.["P-REPO"], undefined);
});

test("other agents and squads keep the folder-only behaviour: not bound", async () => {
  await startFromSquads("agent", "helper", "P-REPO");
  await startFromSquads("squad", "s1", "P-REPO");
  for (const r of host.state["drover.runs"]) assert.equal(r.project, null);
  assert.equal(folderOf(tabs()[0]), "/repos/with");
});

test("drover without a project: unbound, as before", async () => {
  await startFromSquads("agent", "drover", null);
  assert.equal(host.state["drover.runs"][0].project, null);
  assert.equal(tabs()[0].includes("--folder"), false);
});
