// A3b fix round 1 (T-MWO2UYPADZC): the exec writer against the REAL headless board code (in process, a temp board), with an injected fault.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const X = await import("../_lib/remote-exec.js");
const HB = await import("../_lib/headless-board.js");

const cleanup = [];
afterEach(() => { for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hexec-")); cleanup.push(d); return d; };

test("F4: a directory-fsync EIO after the link publishes the card; the writer says unknown, and the retry of the same envelope adds nothing", async () => {
  const dir = tmp();
  let faults = 1;
  const io = { fsyncDir: async () => { if (faults-- > 0) { const e = new Error("EIO"); e.code = "EIO"; throw e; } } };
  // exec stands in for `sh -c WRITE_SCRIPT ...`: the JSON (args[3]) goes to submit(), the answer is what the CLI prints (exit 1 on ok:false).
  const made = await HB.submit({ op: "project-add", name: "scratch", repo: dir, nonce: "seed-00000001", issuedAt: Date.now(), ttlMs: 60000 }, { dir });
  assert.equal(made.ok, true, JSON.stringify(made));
  const PID = made.result.id;
  const exec = async (_cmd, args) => {
    const r = await HB.submit(JSON.parse(args[3]), { dir, io });
    return { code: r.ok === false ? 1 : 0, stdout: JSON.stringify(r), stderr: "" };
  };
  const w = X.createExecWriter({ exec, now: Date.now, origin: "T", link: () => ({ state: "fresh", ops: ["add", "move", "note", "edit", "archive"], skew: 0 }) });
  const first = await w.send("box", PID, { op: "add", title: "published then EIO" }, {});
  assert.equal(first.status, "unknown", `E_SYNC can follow the publication, not "not applied": ${first.message}`);
  assert.equal(HB.tasksInfo(dir).tasks.length, 1, "the card is on the board");
  assert.equal(w.pending().length, 1, "the envelope is kept");
  const again = await w.retry(first.nonce);
  assert.equal(again.status, "saved");
  assert.equal(again.replayed, true);
  assert.equal(HB.tasksInfo(dir).tasks.length, 1, "still one card");
  assert.deepEqual(w.pending(), []);
});

test("F5: the headless version and rev answers carry the machine's clock (`now`, ms), additively", () => {
  const dir = tmp();
  const t = 1_700_000_000_000;
  assert.equal(HB.versionInfo(() => t).now, t);
  assert.equal(HB.versionInfo().cli, "drover-headless");
  assert.equal(HB.revInfo(dir, () => t).now, t);
  assert.ok(Number.isSafeInteger(HB.revInfo(dir).now));
  assert.deepEqual(Object.keys(HB.versionInfo()).sort(), ["cli", "now", "ops", "schema"]);
});

// A board of its own and a clock both sides share, so the remote's expiry check sees the time the laptop sees.
async function rig() {
  const dir = tmp();
  const clock = { t: Date.now() };
  const made = await HB.submit({ op: "project-add", name: "scratch", repo: dir, nonce: "seed-00000002", issuedAt: clock.t, ttlMs: 60000 }, { dir, now: () => clock.t });
  const PID = made.result.id;
  const mode = { reply: "apply-lose" }; // apply-lose: the remote applies, the reply is lost | node-gone: the launcher fails (69) | ok
  const exec = async (_cmd, args) => {
    if (mode.reply === "node-gone") return { code: 69, stdout: "", stderr: "E_NODE_NOT_FOUND" };
    const r = await HB.submit(JSON.parse(args[3]), { dir, now: () => clock.t });
    if (mode.reply === "apply-lose") return { code: 255, stdout: "", stderr: "lost" };
    return { code: r.ok === false ? 1 : 0, stdout: JSON.stringify(r), stderr: "" };
  };
  const w = X.createExecWriter({ exec, now: () => clock.t, origin: "T", link: () => ({ state: "fresh", ops: ["add", "move", "note", "edit", "archive"], skew: 0 }) });
  return { dir, clock, PID, mode, w };
}

test("R2-2: real headless, the clock moves 4 minutes past the ttl: repeating the same add replays the retained envelope, one card", async () => {
  const { dir, clock, PID, mode, w } = await rig();
  const add = { op: "add", title: "applied, reply lost" };
  const a = await w.send("box", PID, add, {});
  assert.equal(a.status, "unknown");
  clock.t += 4 * 60000; w.tick();
  mode.reply = "ok";
  const b = await w.send("box", PID, { ...add }, {});
  assert.equal(b.status, "saved", b.message);
  assert.equal(b.nonce, a.nonce);
  assert.equal(HB.tasksInfo(dir).tasks.length, 1, "one card");
});

test("R2-3: real headless: unknown, then a retry that hits a missing Node (69), then the repeat: still one card, same nonce", async () => {
  const { dir, PID, mode, w } = await rig();
  const add = { op: "add", title: "survives a failed retry" };
  const a = await w.send("box", PID, add, {});
  assert.equal(a.status, "unknown");
  mode.reply = "node-gone";
  const b = await w.send("box", PID, { ...add }, {});
  assert.equal(b.status, "unknown");
  mode.reply = "ok";
  const c = await w.send("box", PID, { ...add }, {});
  assert.equal(c.status, "saved");
  assert.equal(c.nonce, a.nonce);
  assert.equal(HB.tasksInfo(dir).tasks.length, 1);
});
