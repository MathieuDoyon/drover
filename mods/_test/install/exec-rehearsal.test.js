// The scratch-machine rehearsal of the exec cutover (T-MWO2UYPADZC, A3b). Replay it with: node --test mods/_test/install/exec-rehearsal.test.js
// A fake remote machine (the machine-rt harness: real argv, real stdin, a temp HOME, no shell) holds an OLD shared.json. The REAL headless CLI is installed on it,
// then the cutover runs end to end through the laptop code: install + doctor, `drover machines migrate-in`, bind/flip the transport to exec, read, add, edit,
// note, move and archive through the real exec writer, and there is no way back to the inbox (the old store is untouched).
// The laptop side is the real io.js on a stubbed host whose `hc` runs the argv on the fake machine. No sleeps: until() only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { RT, until, M, o, machine, source, dateAll, T_NEW, cleanup } from "./machines-install-fixture.js";

register("../hooks.js", import.meta.url);
const IO = await import("../../_lib/io.js");
const X = await import("../../_lib/remote-exec.js");
const { main } = await import("../../drover-tasks/bin/drover-machines.mjs");

const RID = "P-REMOTE1", LID = "P-ONREM";
const OLD = ".config/herdr-app/shared.json";
const card = (id, extra = {}) => ({ id, title: `old ${id}`, desc: "", column: "todo", priority: "P2", tags: [], project: RID, archived: false, notes: [], ...extra });

// The laptop's host: `hc exec --on <m> [--timeout n] [--stdin] argv` and `hc file read --on <m> <path>` run on the fake machine; the local sh of a write is stood in
// for by running its remote argv with the JSON it was given as an argv item on stdin (the script itself is run for real in the next test).
function laptop(m, state) {
  const h = { down: false, hang: false, execCalls: [], sends: [] };
  const host = globalThis.__host = { appHome: "/app", home: "/h", props: {}, notified: [], terminals: [], agents: [], spaces: [], panes: [], state };
  const parse = (args) => { let i = args.indexOf("--on") + 2; if (args[i] === "--timeout") i += 2; const stdin = args[i] === "--stdin"; if (stdin) i++; if (args[i] === "--") i++; return { argv: args.slice(i), stdin }; };
  host.hc = async (args) => {
    if (args[0] === "machine") return { code: 0, stdout: JSON.stringify({ machines: [{ name: m.name, state: "connected" }] }), stderr: "" };
    if (h.hang) return new Promise(() => {});
    if (h.down) return { code: 255, stdout: "", stderr: "link down" };
    if (args[0] === "file" && args[1] === "read") { const p = join(m.home, args[4]); return existsSync(p) ? { code: 0, stdout: readFileSync(p, "utf8"), stderr: "" } : { code: 1, stdout: "", stderr: "" }; }
    if (args[0] === "exec") { const { argv } = parse(args); h.execCalls.push(argv); return RT.run(argv, m, ""); }
    return { code: 2, stdout: "", stderr: "" };
  };
  host.exec = async (cmd, args) => { h.sends.push(args); return RT.run(args.slice(6), m, args[3]); };
  return h;
}
const projectsState = (m, extra = {}) => [{ id: "P-LOCAL", name: "mine", repos: [], folders: [], branch: "main" }, { id: LID, name: "scratch", repos: [], folders: [], branch: "main", remote: { machine: m.name, projectId: RID, id: "B-1", ...extra } }];
const ids = () => IO.loadMerged().tasks.filter((t) => t.project === LID).map((t) => t.id).sort();
const CKEY = (m) => `drover.remote.${m.name}.${RID}`;

test("scratch-machine rehearsal: install, doctor, migrate-in, read over exec, add/edit/note/move/archive, no way back", async () => {
  const m = machine(), s = source();
  dateAll(s, T_NEW);
  const rt = RT.makeRuntime(m);
  const { install, doctor } = await M();
  // 1. the headless CLI goes onto the machine, and doctor finds it whole
  const res = await install(rt, o(m, s));
  assert.equal(res.ok, true, JSON.stringify({ code: res.code, message: res.message, path: res.path }));
  assert.equal((await doctor(RT.makeRuntime(m), o(m, s))).ok, true);
  // 2. the machine's old store (what migrate-in reads)
  mkdirSync(dirname(join(m.home, OLD)), { recursive: true });
  writeFileSync(join(m.home, OLD), JSON.stringify({ "drover.projects": [{ id: RID, name: "r" }], "drover.tasks": [card("T-OLD1", { rev: 2 }), card("T-OLD2")], "drover.agents": { agents: [{ id: "a1", name: "A one" }], squads: [] } }));
  const oldBytes = readFileSync(join(m.home, OLD), "utf8");
  const oldIds = ["T-OLD1", "T-OLD2"];
  // 3. drover machines migrate-in: counts, and the old file is only read
  let out = "", err = "";
  assert.equal(await main(["migrate-in", m.name], { runtime: rt, out: (x) => { out += x; }, err: (x) => { err += x; } }), 0, err);
  assert.match(out, /copied tasks 2, projects 1, agents 1, squads 0/);
  assert.equal(readFileSync(join(m.home, OLD), "utf8"), oldBytes, "migrate-in reads the old store, never writes it");
  out = "";
  assert.equal(await main(["migrate-in", m.name, "--json"], { runtime: rt, out: (x) => { out += x; }, err: () => {} }), 0);
  assert.deepEqual(JSON.parse(out).copied, { tasks: 0, projects: 0, agents: 0, squads: 0 }, "a second run copies nothing (existing ids are kept)");
  // 4. the laptop: a binding (exec is the only transport) reads the headless board, which migrate-in filled from the old store
  const h = laptop(m, { "drover.tasks": [], "drover.projects": projectsState(m) });
  const timers = [];
  const cx = { notify() {}, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}), timer: { every: (_ms, fn) => timers.push(() => fn(cx)) } };
  const fire = () => timers.forEach((t) => t());
  IO.remote.sync([]); IO.resetRemoteWriter();
  IO.watchRemote(cx, () => true);
  await until(() => globalThis.__host.state[CKEY(m)]?.ops, "exec read");
  await until(() => IO.remoteWriteState(LID).enabled, "controls on from the remote's ops");
  const bind = () => globalThis.__host.state["drover.projects"].find((p) => p.id === LID).remote;
  assert.deepEqual(ids(), oldIds, "the migrated cards keep their ids");
  assert.ok(h.execCalls.length > 0, "the board was read through the headless CLI");
  assert.equal(bind().id, "B-1", "the binding is the one that was saved");
  assert.deepEqual(IO.remoteWriteState(LID).controls, { move: true, note: true, edit: true, add: true, archive: true });
  // 6. add, edit, note, move, archive through the real exec writer
  const send = async (op) => { const r = await IO.remoteSend(LID, op, cx); assert.equal(r.status, "saved", JSON.stringify(r)); return r; };
  const added = await send({ op: "add", title: "made on the laptop", column: "backlog" });
  await until(() => ids().length === 3, "the new card shows");
  const newId = ids().find((id) => !oldIds.includes(id));
  assert.match(newId, /^T-/);
  await send({ op: "edit", id: "T-OLD1", title: "renamed", priority: "P1" });
  await send({ op: "note", id: "T-OLD1", text: "a note from the laptop", kind: "log" });
  await send({ op: "move", id: "T-OLD1", column: "doing" });
  const find = (id) => IO.loadMerged().tasks.find((t) => t.id === id);
  assert.equal(find("T-OLD1").title, "renamed");
  assert.equal(find("T-OLD1").priority, "P1");
  assert.equal(find("T-OLD1").column, "doing");
  assert.equal(find("T-OLD1").notes.at(-1).text, "a note from the laptop");
  await send({ op: "archive", id: "T-OLD2" });
  assert.deepEqual(ids(), ["T-OLD1", newId].sort(), "an archived card leaves the board");
  assert.equal(h.sends.length, 5);
  for (const a of h.sends) assert.ok(a.slice(6).every((x) => !x.includes("laptop")), "no payload in the remote argv");
  assert.equal(readFileSync(join(m.home, OLD), "utf8"), oldBytes, "the old store was not touched by exec writes");
  // 7. unreachable: the last copy stays, marked stale; a write is refused and nothing is sent
  h.down = true;
  await IO.retryRemote(m.name, RID, cx);
  const view = IO.loadMerged();
  assert.equal(view.remotes[0].state, "stale");
  assert.match(view.remotes[0].banner, /unreachable/);
  assert.deepEqual(ids(), ["T-OLD1", newId].sort());
  const sent = h.sends.length;
  const refused = await IO.remoteSend(LID, { op: "move", id: "T-OLD1", column: "done" }, cx);
  assert.equal(refused.status, "refused");
  assert.match(refused.message, /nothing was sent/);
  assert.equal(h.sends.length, sent);
  h.down = false;
  // 8. a hung runner never blocks render or the timer
  h.hang = true;
  void IO.retryRemote(m.name, RID, cx);
  const t0 = performance.now();
  IO.loadMerged(); fire(); IO.remoteWriteState(LID);
  assert.ok(performance.now() - t0 < 500);
  h.hang = false;
  // 9. there is no way back to the old store: no flip, and the old store is still as migrate-in left it (read, never written)
  assert.equal(IO.setRemoteTransport, undefined);
  assert.equal(readFileSync(join(m.home, OLD), "utf8"), oldBytes);
  fire();
  await until(() => ids().includes(newId), "the board still shows what was written over exec");
  assert.deepEqual(ids(), ["T-OLD1", newId].sort());
  assert.equal(find("T-OLD1").column, "doing");
});

test("the write script, run by a real sh with a stub hc: the JSON arrives on stdin and is in no argv", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "stubhc-")));
  cleanup.push(dir);
  writeFileSync(join(dir, "hc"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\n`);
  chmodSync(join(dir, "hc"), 0o755);
  const secret = JSON.stringify({ op: "note", text: "tok-REHEARSAL-secret", nonce: "Dabc-123456789012", issuedAt: 1, ttlMs: 1000 });
  const r = spawnSync("/bin/sh", ["-c", X.WRITE_SCRIPT, "drover-send", secret, "box", "10", X.HEADLESS, "note"], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "stdin"), "utf8"), secret);
  const argv = readFileSync(join(dir, "argv"), "utf8").split("\n").filter(Boolean);
  assert.deepEqual(argv, ["exec", "--on", "box", "--timeout", "10", "--stdin", X.HEADLESS, "note"]);
  assert.ok(!argv.join(" ").includes("REHEARSAL"));
});

test("doctor reports the clock of the machine: ok inside 30 s, WARN (not FAIL) beyond it, in both directions", async () => {
  const m = machine(), s = source();
  dateAll(s, T_NEW);
  const { install, doctor } = await M();
  assert.equal((await install(RT.makeRuntime(m), o(m, s))).ok, true);
  // the same machine, but its headless answers a clock that is `offset` ms away
  const skewed = (offset) => { const rt = RT.makeRuntime(m); const real = rt.exec; rt.exec = async (...a) => { const r = await real(...a); if (!a[1].includes("version") || !a[1].some((x) => String(x).endsWith("drover-headless"))) return r; const j = JSON.parse(r.stdout); return { ...r, stdout: JSON.stringify({ ...j, now: j.now + offset }) }; }; return rt; };
  const clock = async (offset) => (await doctor(skewed(offset), o(m, s))).checks.find((c) => c.id === "clock");
  assert.equal((await clock(0)).status, "ok");
  assert.equal((await clock(20000)).status, "ok");
  for (const off of [60000, -60000]) {
    const c = await clock(off);
    assert.equal(c.status, "WARN", String(off));
    assert.match(c.detail, off > 0 ? /ahead of/ : /behind/);
  }
  assert.equal((await doctor(skewed(60000), o(m, s))).ok, true, "a clock WARN never fails the doctor");
});

test("doctor: a headless that reports no clock is a WARN (the writer is the gate: it refuses exec writes until the machine is updated)", async () => {
  const m = machine(), s = source();
  dateAll(s, T_NEW);
  const { install, doctor } = await M();
  assert.equal((await install(RT.makeRuntime(m), o(m, s))).ok, true);
  const rt = RT.makeRuntime(m); const real = rt.exec;
  rt.exec = async (...a) => { const r = await real(...a); if (!a[1].includes("version") || !a[1].some((x) => String(x).endsWith("drover-headless"))) return r; const { now: _n, ...j } = JSON.parse(r.stdout); return { ...r, stdout: JSON.stringify(j) }; };
  const d = await doctor(rt, o(m, s));
  const c = d.checks.find((x) => x.id === "clock");
  assert.equal(c.status, "WARN");
  assert.match(c.detail, /exec writes are refused/);
  assert.equal(d.ok, true);
});
