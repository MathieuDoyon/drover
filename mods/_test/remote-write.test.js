// The request a UI op becomes (T-MWHVWR8TIJB): remote-write.js is now only buildPayload; the exec transport (remote-exec.js) sends it.
// The inbox delivery tests (stage + rename, the protocol probe, pending, adoption, sweeps, results) retired with the inbox (T-MWO2V65MUSX): their
// delivery-side faults are covered for exec by remote-exec.test.js (envelope on stdin, unknown + held retry, stale/expired/refused/failed mapping, skew).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const W = await import("../_lib/remote-write.js");
const X = await import("../_lib/remote-exec.js");

const PID = "P-REMOTE1";
const build = (op, rev = 7) => W.buildPayload(op, { projectId: PID, rev });
const SENTINEL = "SENTINEL-sk-not-a-real-secret-0042";

test("the module is only the request builder: no inbox delivery, no pending list, no probe, no writer", () => {
  assert.deepEqual(Object.keys(W).sort(), ["OPS", "TTL_MS", "buildPayload"]);
  const src = readFileSync(new URL("../_lib/remote-write.js", import.meta.url), "utf8");
  for (const w of ["drover-inbox", "createWriter", "PENDING_KEY", "STAGE_SCRIPT", "SEND_SCRIPT", "hc file write", "shared.json"]) assert.ok(!src.includes(w), `${w} is gone`);
});

test("no laptop-side remote file reads shared.json or writes the inbox of a machine", () => {
  for (const f of ["remote.js", "remote-write.js", "remote-write-ui.js", "remote-exec.js"]) {
    const src = readFileSync(new URL(`../_lib/${f}`, import.meta.url), "utf8");
    for (const w of ["drover-inbox", "SHARED_PATH", "parseRemote", "createRemote", "createWriter", "STAGE_SCRIPT"]) assert.ok(!src.includes(w), `${f} still has ${w}`);
  }
  assert.equal((readFileSync(new URL("../_lib/remote.js", import.meta.url), "utf8").match(/"file", "read"/g) ?? []).length, 0, "no hc file read in remote.js");
  assert.equal((readFileSync(new URL("../_lib/remote-exec.js", import.meta.url), "utf8").match(/"file"/g) ?? []).length, 0, "the exec transport never runs hc file");
});

test("every mod copy of the remote files is the same bytes as _lib (nothing of the inbox lives on in a copy)", () => {
  const lib = (f) => readFileSync(new URL(`../_lib/${f}`, import.meta.url), "utf8");
  for (const d of readdirSync(new URL("../", import.meta.url)).filter((n) => n.startsWith("drover-"))) {
    for (const f of ["remote.js", "remote-write.js", "remote-write-ui.js", "remote-exec.js", "io.js"]) {
      let t; try { t = readFileSync(new URL(`../${d}/${f}`, import.meta.url), "utf8"); } catch { continue; }
      assert.equal(t, lib(f), `${d}/${f}`);
    }
  }
});

test("1a the whitelist and the exact JSON of each op", () => {
  const cases = [
    [{ op: "move", id: "T-AB1", column: "doing" }, { op: "move", id: "T-AB1", column: "doing", ifRev: 7, ttlMs: 120000 }],
    [{ op: "note", id: "T-AB1", text: "hi", kind: "log" }, { op: "note", id: "T-AB1", text: "hi", kind: "log", ifRev: 7, ttlMs: 120000 }],
    [{ op: "edit", id: "T-NOREV", title: "new", desc: "d" }, { op: "edit", id: "T-NOREV", title: "new", desc: "d", ifRev: 7, ttlMs: 120000 }],
    [{ op: "archive", id: "T-AB1" }, { op: "archive", id: "T-AB1", ifRev: 7, ttlMs: 120000 }],
    [{ op: "add", title: "x", desc: "", tags: ["a"], column: "backlog", priority: "P1", project: "P-OTHER" }, { op: "add", title: "x", desc: "", tags: ["a"], column: "backlog", priority: "P1", project: PID, ttlMs: 120000 }],
  ];
  for (const [op, want] of cases) assert.deepEqual(build(op).json, want, op.op);
});

test("1a any op outside the whitelist is refused", () => {
  for (const op of ["start", "wake", "next", "link", "project", "project-add", "protocol", "note-rm", "x"]) assert.match(build({ op, id: "T-AB1" }).error, /not allowed/, op);
  assert.match(build(undefined).error, /not allowed/);
});

test("1b a card id or value outside its charset is refused, never built", () => {
  for (const id of ["T-ab", "T-A; rm -rf /", "../x", "", "T-"]) assert.ok(build({ op: "move", id, column: "doing" }).error, id);
  for (const col of ["nowhere", "", undefined, 5]) assert.ok(build({ op: "move", id: "T-AB1", column: col }).error, String(col));
  assert.ok(build({ op: "add", title: "   " }).error);
  assert.ok(build({ op: "note", id: "T-AB1", text: " " }).error);
  assert.ok(build({ op: "note", id: "T-AB1", text: "x", kind: "weird" }).error);
  assert.ok(build({ op: "edit", id: "T-AB1" }).error, "nothing to change");
});

test("5 payloads hold only op fields plus ifRev and ttlMs; nothing else of the caller's object is copied", () => {
  const b = build({ op: "move", id: "T-AB1", column: "doing", agent: SENTINEL, env: SENTINEL, desc: SENTINEL }).json;
  assert.deepEqual(Object.keys(b).sort(), ["column", "id", "ifRev", "op", "ttlMs"]);
  assert.ok(!JSON.stringify(b).includes(SENTINEL));
});

test("T3 the exact JSON of each field op; {kind,id} of an assignee is copied, not the caller's object", () => {
  const op = { op: "edit", id: "T-AB1", priority: "P0", tags: ["a", "b"], assignee: { kind: "agent", id: "wrangler", junk: 1 }, parent: "T-AB2", project: "P-OTHER", title: "n" };
  assert.deepEqual(build(op).json, { op: "edit", id: "T-AB1", title: "n", priority: "P0", tags: ["a", "b"], assignee: { kind: "agent", id: "wrangler" }, parent: "T-AB2", project: "P-OTHER", ifRev: 7, ttlMs: 120000 });
  assert.notEqual(build(op).json.assignee, op.assignee);
  assert.deepEqual(build({ op: "edit", id: "T-AB1", assignee: "none", parent: "none", project: "none" }).json, { op: "edit", id: "T-AB1", assignee: "none", parent: "none", project: "none", ifRev: 7, ttlMs: 120000 });
  assert.deepEqual(build({ op: "add", title: "x", assignee: { kind: "squad", id: "cattle-drive" }, parent: "T-AB1" }).json, { op: "add", title: "x", desc: "", tags: [], column: "backlog", priority: "P2", project: PID, assignee: { kind: "squad", id: "cattle-drive" }, parent: "T-AB1", ttlMs: 120000 });
});

test("T3 strict payloads: bad priority, tags, assignee, parent, project are refused", () => {
  for (const bad of [{ priority: "P9" }, { tags: "a" }, { tags: [1] }, { assignee: { kind: "robot", id: "x" } }, { assignee: "x" }, { assignee: null }, { parent: "nope" }, { parent: 5 }, { project: "x y" }, { project: 5 }]) {
    assert.ok(build({ op: "edit", id: "T-AB1", ...bad }).error, JSON.stringify(bad));
  }
  assert.ok(build({ op: "add", title: "x", assignee: { kind: "agent" } }).error);
  assert.ok(build({ op: "add", title: "x", parent: "nope" }).error);
});

test("the exec writer sends exactly what buildPayload built, with the rev the caller gave (the editor's opened baseline wins over the saved copy)", async () => {
  const sent = [];
  const w = X.createExecWriter({ exec: async (_c, a) => { sent.push(JSON.parse(a[3])); return { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: "" }; }, link: () => ({ state: "fresh", ops: ["move", "edit"], skew: 0 }) });
  assert.equal((await w.send("box1", PID, { op: "edit", id: "T-AB1", priority: "P0" }, { rev: 3 })).status, "saved");
  assert.equal(sent[0].ifRev, 3);
  assert.deepEqual([sent[0].op, sent[0].priority, sent[0].ttlMs], ["edit", "P0", 120000]);
});
