// T-MWLGPRPU53A: launch records each terminal's session id (Claude --session-id; Codex found by a per-terminal marker) and labels it.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { until, drain } from "./stubs/until.js";

register("./hooks.js", import.meta.url);
const CFG = { agents: [
  { id: "lead", name: "Lead", command: "claude --model opus", soul: "", instructions: "" },
  { id: "cx", name: "Codex", command: "codex --no-daemon", soul: "", instructions: "" },
  { id: "pin", name: "Pin", command: "claude --resume abc --model opus", soul: "", instructions: "" },
  { id: "pin2", name: "Pin2", command: `claude --session-id=${"9".repeat(8)}-0000-4000-8000-000000000000`, soul: "", instructions: "" },
], squads: [
  { id: "s1", name: "Crew", version: 1, leader: "lead", members: [{ agent: "cx", role: "Inspector" }] },
  { id: "s2", name: "Pinned", version: 1, leader: "pin", members: [] },
  { id: "s3", name: "Twins", version: 1, leader: "lead", members: [{ agent: "cx", role: "Inspector" }, { agent: "cx", role: "Reviewer" }] },
  { id: "s4", name: "Pinned2", version: 1, leader: "pin2", members: [] },
] };
const SECRET = "TRANSCRIPT-TEXT-canary";
const WRAP = "/app/mods/drover-agents/bin/drover-env";
const rollout = (id, day = "2026/11/17") => `/home/u/.codex/sessions/${day}/rollout-2026-11-17T10-00-00-${id}.jsonl`;
let host, tmp, n, ids;
const { launch, sessionSettle } = await import("../_lib/io.js");

afterEach(async () => { mock.timers.reset?.(); mock.restoreAll(); if (tmp) await fs.rm(tmp, { recursive: true, force: true }); tmp = null; });
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sr-"));
  await fs.mkdir(path.join(tmp, ".config/drover-herdr/agents"), { recursive: true });
  n = 0; ids = new Map();
  sessionSettle.tries = 6; sessionSettle.ms = 0;
  host = globalThis.__host = { appHome: "/app", home: tmp, props: {}, notified: [], terminals: [], state: { "drover.agents": CFG },
    calls: [], labels: [], prompts: {}, greps: [], grepAnswer: null,
    readTextFile: async (p) => { try { return await fs.readFile(p, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } },
    hc: async (args) => { host.labels.push(args); return host.hcResult ? host.hcResult(args) : { code: 0, stdout: "", stderr: "" }; },
  };
  host.exec = async (cmd, args) => {
    await Promise.resolve();
    if (cmd === "herdr-app") {
      const [, op, ...rest] = args;
      host.calls.push([op, rest]);
      const terminal = `t${++n}`;
      if (rest.includes("--task")) host.prompts[terminal] = rest[rest.indexOf("--task") + 1];
      return { code: 0, stdout: JSON.stringify({ terminal, space: "s1" }), stderr: "" };
    }
    if (cmd === "ls" && host.lsAnswer) return host.lsAnswer(args);
    if (cmd === "ls") return { code: 0, stdout: args.filter((a) => !a.startsWith("-")).join("\n"), stderr: "" };
    if (cmd === "grep") {
      const token = args[args.indexOf("-e") + 1];
      host.greps.push({ args, token });
      return host.grepAnswer ? host.grepAnswer({ args, token, nth: host.greps.length }) : { code: 1, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
});
const uuidFor = (token) => { if (!ids.has(token)) ids.set(token, `${String(ids.size + 1).padStart(8, "0")}-1111-4111-8111-111111111111`); return ids.get(token); };
const found = ({ token }) => ({ code: 0, stdout: rollout(uuidFor(token)) + "\n", stderr: "" });
const markerOf = (prompt) => prompt.match(/drover-launch-marker: (\S+)/)?.[1];
const argvs = () => host.calls.filter(([op]) => op === "tab.new" || op === "space.new").map(([, r]) => JSON.parse(r[r.indexOf("--argv") + 1]));
const savedRuns = () => host.state["drover.runs"] ?? [];
const term = (run, role) => run.terminals.find((t) => t.role === role);
// By address: two launches in the same millisecond share a run id (it comes from the clock); addresses are unique.
const sessionOf = (runId, address) => savedRuns().filter((r) => r.id === runId).flatMap((r) => r.terminals).find((t) => t.address === address)?.session;

test("Claude leader: argv gets --session-id, the record keeps the same id and the folder, the terminal is labelled", async () => {
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r/proj" });
  const lead = term(run, "leader");
  const flag = argvs().at(-1);
  const id = flag[flag.indexOf("--session-id") + 1];
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(flag, ["claude", "--session-id", id, "--model", "opus"]);
  assert.equal(lead.session, id);
  assert.equal(lead.kind, "claude");
  assert.equal(lead.cwd, "/r/proj");
  assert.deepEqual(host.labels.filter((l) => l[1] === lead.address), [["label", lead.address, `revive.session=${id}`]]);
  assert.equal(sessionOf(run.id, lead.address), id, "saved in drover.runs");
});

test("a profile with its own --resume or --session-id: argv untouched, session unknown, no label", async () => {
  for (const sq of ["s2", "s4"]) {
    host.calls = []; host.labels = [];
    const run = await launch(null, { kind: "squad", id: sq });
    assert.equal(argvs().at(-1).includes("--session-id") && sq === "s2", false);
    assert.deepEqual(argvs().at(-1), sq === "s2" ? ["claude", "--resume", "abc", "--model", "opus"] : ["claude", `--session-id=${"9".repeat(8)}-0000-4000-8000-000000000000`]);
    assert.equal("session" in term(run, "leader"), false);
    assert.deepEqual(host.labels, []);
  }
});

test("env wrapper: the flag lands inside the wrapped argv, after the --", async () => {
  await fs.writeFile(path.join(tmp, ".config/drover-herdr/agents/lead.json"), '{"version":1,"env":{"X":{"value":"v","secret":false}}}', { mode: 0o600 });
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  const a = argvs().at(-1), id = term(run, "leader").session;
  assert.deepEqual(a, [WRAP, "lead", "--", "claude", "--session-id", id, "--model", "opus"]);
});

test("no folder given: cwd is omitted (never guessed); a relative folder is not recorded either", async () => {
  const a = await launch(null, { kind: "squad", id: "s1" });
  assert.ok(a.terminals.every((t) => !("cwd" in t)));
  const b = await launch(null, { kind: "squad", id: "s1" }, { folder: "rel/dir" });
  assert.ok(b.terminals.every((t) => !("cwd" in t)));
});

test("Codex: the prompt holds the marker once; the id is recorded after the rollout is found; label set; launch does not wait", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  host.grepAnswer = async (q) => { await gate; return found(q); };
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  const cx = run.terminals.find((t) => t.agent === "cx");
  const prompt = host.prompts[cx.address], token = markerOf(prompt);
  assert.ok(token);
  assert.equal(prompt.split(`drover-launch-marker: ${token}`).length, 2, "exactly once");
  assert.equal(host.prompts[term(run, "leader").address].includes("drover-launch-marker"), false, "a Claude prompt has no marker");
  assert.equal(sessionOf(run.id, cx.address), undefined, "launch returned before the transcript was searched for");
  release();
  await until(() => sessionOf(run.id, cx.address), "codex session recorded");
  assert.equal(sessionOf(run.id, cx.address), uuidFor(token));
  const t = savedRuns()[0].terminals.find((x) => x.address === cx.address);
  assert.equal(t.kind, "codex");
  assert.equal(t.parked, true, "the patch keeps the other fields");
  assert.deepEqual(host.labels.filter((l) => l[1] === cx.address), [["label", cx.address, `revive.session=${uuidFor(token)}`]]);
});

test("Codex: grep reads paths only (-l), covers yesterday, today and tomorrow, and the record holds ids and folders only", async () => {
  host.grepAnswer = (q) => ({ code: 0, stdout: rollout(uuidFor(q.token)) + `\n/x/other.txt:${SECRET}\n`, stderr: "" });
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  await until(() => sessionOf(run.id, run.terminals.find((t) => t.agent === "cx").address), "found");
  const flags = host.greps[0].args.filter((a) => a.startsWith("-") && a !== "-e");
  assert.ok(flags.includes("-l"));
  assert.deepEqual(flags.filter((f) => !["-r", "-l", "-F", "-s"].includes(f) && !f.startsWith("--include=")), [], "no flag that prints content");
  const day = (d) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
  const now = Date.now();
  for (const off of [-1, 0, 1]) assert.ok(host.greps[0].args.some((a) => a.endsWith(day(new Date(now + off * 86400000)))), `day ${off}`);
  assert.equal(JSON.stringify([savedRuns(), host.notified, host.labels]).includes(SECRET), false);
  for (const t of savedRuns()[0].terminals) assert.deepEqual(Object.keys(t).filter((k) => !["address", "agent", "name", "role", "model", "started", "parked", "session", "kind", "cwd"].includes(k)), []);
});

test("concurrent launches in one folder: each terminal gets its own id, no cross-assignment, no lost update", async () => {
  host.grepAnswer = found;
  const [a, b] = await Promise.all([launch(null, { kind: "squad", id: "s1" }, { folder: "/r" }), launch(null, { kind: "squad", id: "s1" }, { folder: "/r" })]);
  const cxs = [a, b].map((r) => r.terminals.find((t) => t.agent === "cx"));
  await until(() => cxs.every((t, i) => sessionOf([a, b][i].id, t.address)), "both found");
  const got = cxs.map((t, i) => sessionOf([a, b][i].id, t.address));
  assert.notEqual(got[0], got[1]);
  cxs.forEach((t, i) => assert.equal(got[i], uuidFor(markerOf(host.prompts[t.address]))));
  const leads = [a, b].map((r) => term(r, "leader").session);
  assert.notEqual(leads[0], leads[1]);
  assert.equal(savedRuns().length, 2, "both runs survive");
  [a, b].forEach((r, i) => assert.equal(sessionOf(r.id, term(r, "leader").address), leads[i]));
});

test("two codex members of one run: both patched, neither overwrites the other", async () => {
  host.grepAnswer = found;
  const run = await launch(null, { kind: "squad", id: "s3" }, { folder: "/r" });
  const cxs = run.terminals.filter((t) => t.agent === "cx");
  assert.equal(cxs.length, 2);
  await until(() => cxs.every((t) => sessionOf(run.id, t.address)), "both members");
  assert.notEqual(sessionOf(run.id, cxs[0].address), sessionOf(run.id, cxs[1].address));
  assert.equal(sessionOf(run.id, term(run, "leader").address), term(run, "leader").session);
});

test("late transcript: found on a later try; one that never appears leaves the session unknown and launch unaffected", async () => {
  host.grepAnswer = (q) => (q.nth >= 3 ? found(q) : { code: 1, stdout: "", stderr: "" });
  const late = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  const lt = late.terminals.find((t) => t.agent === "cx");
  await until(() => sessionOf(late.id, lt.address), "found on try 3");
  assert.ok(host.greps.length >= 3);

  host.greps = []; host.labels = []; host.grepAnswer = null;
  const never = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  assert.equal(never.error, undefined);
  await until(() => host.greps.length >= sessionSettle.tries, "all tries used");
  await drain();
  assert.equal(host.greps.length, sessionSettle.tries, "bounded");
  const nt = never.terminals.find((t) => t.agent === "cx");
  assert.equal(sessionOf(never.id, nt.address), undefined);
  assert.deepEqual(host.labels.filter((l) => l[1] === nt.address), []);
});

test("2 files match the marker: unknown, no guess, no label; 0 matches too", async () => {
  host.grepAnswer = () => ({ code: 0, stdout: rollout("aaaaaaaa-1111-4111-8111-111111111111") + "\n" + rollout("bbbbbbbb-1111-4111-8111-111111111111") + "\n", stderr: "" });
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  await until(() => host.greps.length >= sessionSettle.tries, "tries used");
  await drain();
  const cx = run.terminals.find((t) => t.agent === "cx");
  assert.equal(sessionOf(run.id, cx.address), undefined);
  assert.deepEqual(host.labels.filter((l) => l[1] === cx.address), []);
});

test("a grep that exits non-zero is unknown even with output; a throwing grep or hc label never fails the launch", async () => {
  host.grepAnswer = (q) => ({ code: 2, stdout: rollout(uuidFor(q.token)) + "\n", stderr: "denied" });
  host.hcResult = () => { throw new Error("hc missing"); };
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  assert.equal(run.error, undefined);
  await until(() => host.greps.length >= sessionSettle.tries, "tries used");
  await drain();
  assert.equal(sessionOf(run.id, run.terminals.find((t) => t.agent === "cx").address), undefined);
  assert.ok(term(run, "leader").session, "the Claude id is recorded even when its label failed");
  assert.deepEqual(host.notified, []);

  host.grepAnswer = () => { throw new Error("no grep"); };
  const again = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  assert.equal(again.error, undefined);
  await drain();
});

test("a pruned run is never resurrected; an ended mark made meanwhile is kept", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  host.grepAnswer = async (q) => { await gate; return found(q); };
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  const cx = run.terminals.find((t) => t.agent === "cx");
  host.state["drover.runs"] = savedRuns().map((r) => ({ ...r, terminals: r.terminals.map((t) => (t.address === cx.address ? { ...t, ended: 123, reaped: true } : t)) }));
  release();
  await until(() => sessionOf(run.id, cx.address), "patched");
  const t = savedRuns()[0].terminals.find((x) => x.address === cx.address);
  assert.equal(t.ended, 123); assert.equal(t.reaped, true);

  host.greps = []; host.state["drover.runs"] = [];
  let r2; const g2 = new Promise((r) => { r2 = r; });
  host.grepAnswer = async (q) => { await g2; return found(q); };
  const other = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  host.state["drover.runs"] = []; // pruned before the transcript appeared
  r2();
  await until(() => host.greps.length >= 1, "searched");
  await drain();
  assert.deepEqual(host.state["drover.runs"], []);
  assert.ok(other.id);
});

test("no leak: no notice, and the grep and label calls hold ids only", async () => {
  host.grepAnswer = found;
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  await until(() => sessionOf(run.id, run.terminals.find((t) => t.agent === "cx").address), "found");
  assert.deepEqual(host.notified, []);
  for (const l of host.labels) assert.match(l[2], /^revive\.session=[0-9a-f-]{36}$/);
});

test("a failed directory listing is unknown: partial stdout plus a non-absent error never yields a match", async () => {
  host.lsAnswer = (args) => ({ code: 2, stdout: args[args.length - 1] + "\n", stderr: `ls: ${args[0]}: Permission denied\n` });
  host.grepAnswer = found;
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  await until(() => host.greps.length >= 0 && host.calls.length > 0, "launched");
  await drain(60);
  assert.equal(host.greps.length, 0, "no grep over a partial root list");
  assert.equal(sessionOf(run.id, run.terminals.find((t) => t.agent === "cx").address), undefined);
});

test("plain absent day folders (ls omits a real root and names it in a No such file line, exit 1) still allow the match", async () => {
  const roots = (args) => args.slice(1); // args[0] is -d
  let absent;
  host.lsAnswer = (args) => { absent = roots(args)[0]; return { code: 1, stdout: roots(args).slice(1).join("\n") + "\n", stderr: `ls: ${absent}: No such file or directory\n` }; };
  host.grepAnswer = found;
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  await until(() => sessionOf(run.id, run.terminals.find((t) => t.agent === "cx").address), "found");
  const searched = host.greps[0].args.filter((a) => a.startsWith(tmp));
  assert.ok(absent.startsWith(tmp));
  assert.equal(searched.includes(absent), false, "the absent root is not searched");
  assert.ok(searched.length > 0);
});

test("midnight rollover: the day folders are recomputed on every attempt", async () => {
  let now = Date.parse("2026-11-17T23:59:00Z");
  mock.method(Date, "now", () => now);
  host.grepAnswer = (q) => { if (q.nth === 1) { now = Date.parse("2026-11-18T00:01:00Z"); return { code: 1, stdout: "", stderr: "" }; } return found(q); };
  const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
  await until(() => sessionOf(run.id, run.terminals.find((t) => t.agent === "cx").address), "found after midnight");
  const roots = (i) => host.greps[i].args.filter((a) => a.startsWith("/home") || a.startsWith(tmp)).sort().join();
  assert.notEqual(roots(0), roots(1), "a frozen first-attempt list would be identical");
  assert.ok(roots(1).includes("2026/11/19"), "tomorrow of the new day");
});

test("runtime reload: pending discovery cannot corrupt other saved runs or raise an unhandled failure", async () => {
  const unhandled = []; const on = (e) => unhandled.push(e); process.on("unhandledRejection", on);
  try {
    let release; const gate = new Promise((r) => { release = r; });
    host.grepAnswer = async (q) => { await gate; return found(q); };
    const run = await launch(null, { kind: "squad", id: "s1" }, { folder: "/r" });
    const other = { id: "R-OTHER", terminals: [{ address: "t99", agent: "x", started: 1 }] };
    host.state["drover.runs"] = [other]; // the reloaded app's runs; the old runtime's run is gone
    host.hcResult = () => { throw new Error("runtime disposed"); };
    host.exec = async () => { throw new Error("runtime disposed"); };
    release();
    await drain(60);
    assert.deepEqual(host.state["drover.runs"], [other]);
    assert.equal(run.error, undefined);
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", on); }
});
