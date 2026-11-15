// Remote project, step 2: the laptop writes to omarchy's inbox (T-MWHVWR8TIJB). Fake hc runner (records argv + stdin); no real hc, no sleeps.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const W = await import("../_lib/remote-write.js");
const R = await import("../_lib/remote.js");

const M = "omarchy", PID = "P-REMOTE1";
const SENTINEL = "SENTINEL-sk-not-a-real-secret-0042";
const EPOCH = 1_700_000_000; // omarchy's `date +%s`
const KEY = R.cacheKey(M, PID);
const DIR = ".config/herdr-app/data/drover-inbox";

// A fake hc. `inbox` is omarchy's folder: { name -> text }. `mode` decides what the send does:
//   Step 1 (local exec) stages the JSON as `.<nonce>.tmp`; step 2 (remote exec) renames it. mode: ok | stage-fail: step 1 fails |
//   before: step 2 drops before the rename | after: rename done, reply lost
const sc = (a) => a[a.indexOf("-c") + 1]; // the sh -c script
const arg = (a) => a[a.indexOf("-c") + 2]; // its $0
function fakeHc() {
  const f = { calls: [], inbox: {}, mode: "ok", down: false, epoch: EPOCH, listFails: false };
  f.sends = () => f.calls.filter((c) => c.step === 1); // one per delivery: step 1 carries the JSON
  f.remoteSends = () => f.calls.filter((c) => c.args[0] === "exec" && sc(c.args)?.startsWith("d=$HOME"));
  f.old = new Set(); // names that `find -mmin +1440` would report
  f.exec = async (cmd, args, opts = {}) => { // step 1: sh -c 'printf %s "$1" | hc file write --on "$2" "$3"' drover-send <json> <machine> <path>
    f.calls.push({ cmd, args, opts, stdin: args[3], step: 1 });
    if (f.mode === "stage-fail") throw new Error("hc file write failed");
    f.inbox[args[5].split("/").pop()] = args[3];
    return { code: 0, stdout: "", stderr: "" };
  };
  f.rms = () => f.calls.filter((c) => c.args[0] === "exec" && sc(c.args)?.startsWith("rm "));
  f.run = async (args, opts = {}) => {
    f.calls.push({ args, opts, stdin: opts.stdin });
    if (f.down) throw new Error("hc down");
    if (args[0] === "exec" && sc(args)?.startsWith("d=$HOME")) {
      const nonce = arg(args), name = `${f.epoch}-${nonce}`;
      if (f.mode === "before") throw new Error("link dropped");
      if (!(`.${nonce}.tmp` in f.inbox)) return { code: 1, stdout: "", stderr: "mv: no such file" };
      f.inbox[`${name}.json`] = f.inbox[`.${nonce}.tmp`]; delete f.inbox[`.${nonce}.tmp`];
      if (f.mode === "after") throw new Error("link dropped after rename");
      return { code: 0, stdout: `${name}.json\n`, stderr: "" };
    }
    if (args[0] === "exec" && sc(args)?.startsWith("find ")) {
      const hit = Object.keys(f.inbox).filter((n) => n.startsWith(`.L${arg(args)}-`) && n.endsWith(".tmp") && f.old.has(n));
      return { code: 0, stdout: hit.join("\n") + (hit.length ? "\n" : ""), stderr: "" };
    }
    if (args[0] === "exec" && sc(args)?.includes("grep -F")) { // the recovery lookup: exit 3 = the listing failed (unknown), 1 = listed, no match
      if (f.listFails) return { code: 3, stdout: "", stderr: "ls: cannot access" };
      const hit = Object.keys(f.inbox).filter((n) => n.includes(`-${arg(args)}.`));
      return { code: hit.length ? 0 : 1, stdout: hit.join("\n") + (hit.length ? "\n" : ""), stderr: "" };
    }
    if (args[0] === "exec" && sc(args)?.startsWith("ls ")) {
      if (f.listFails) throw new Error("listing failed");
      const names = Object.keys(f.inbox);
      return { code: 0, stdout: names.join("\n") + (names.length ? "\n" : ""), stderr: "" };
    }
    if (args[0] === "exec" && sc(args)?.startsWith("rm ")) { delete f.inbox[arg(args)]; return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "file" && args[1] === "read") {
      const n = args[4].slice(DIR.length + 1);
      return n in f.inbox ? { code: 0, stdout: f.inbox[n], stderr: "" } : { code: 1, stdout: "", stderr: "no such file" };
    }
    return { code: 2, stdout: "", stderr: "unexpected" };
  };
  // omarchy's consumer: answers every .json file with `reply(cmd)`.
  f.consume = (reply) => { for (const n of Object.keys(f.inbox)) if (n.endsWith(".json")) { const cmd = JSON.parse(f.inbox[n]); delete f.inbox[n]; f.inbox[n.replace(/\.json$/, ".result")] = reply(cmd, n); } };
  return f;
}

let hc, shared, clock, seq, outcomes, reloads, linkState, w;
const card = (id, rev) => ({ id, title: "t", column: "todo", project: "local", notes: [], ...(rev === undefined ? {} : { rev }) });
beforeEach(() => {
  hc = fakeHc(); shared = { [KEY]: { at: 1, tasks: [card("T-AB1", 7), card("T-NOREV")] } };
  clock = 1_000_000_000_000; seq = 0; outcomes = []; reloads = []; linkState = { writes: true, state: "fresh" };
  w = mk();
});
const mk = (over = {}) => W.createWriter({
  run: hc.run, exec: hc.exec, getShared: (k) => shared[k], setShared: (k, v) => { if (v === null) delete shared[k]; else shared[k] = v; },
  now: () => clock, rand: () => String(++seq).padStart(12, "0"), origin: "LAPTOP1",
  link: () => linkState, writable: () => linkState.writes !== false, reload: (m, p) => reloads.push([m, p]), onOutcome: (o) => outcomes.push(o), ...over,
});
// n sends have returned to the writer
const delivered = (n = 1) => hc.sends().length >= n && w.inflight(M) === 0;
const lastSend = () => hc.sends().at(-1);
const bodyOf = (c) => JSON.parse(c.stdin);
// Make the machine writable: answer the probe.
async function enable() {
  const p = w.probe(M);
  await until(() => delivered(), "probe delivered");
  hc.consume((cmd) => (cmd.op === "protocol" ? "ok: protocol 2" : "ok: x"));
  clock += 1000; await w.tick(); await p;
  hc.calls.length = 0;
}
// Send an op, let omarchy answer it, tick, return the outcome.
async function sendAndAnswer(op, reply) {
  const n = hc.sends().length;
  const p = w.send(M, PID, op);
  await until(() => delivered(n + 1), "delivered");
  hc.consume(() => reply);
  clock += 1000; await w.tick();
  return p;
}

// ---- 1a: the exact JSON per op ----
test("1a the whitelist and the exact JSON of each op", async () => {
  await enable();
  const cases = [
    [{ op: "move", id: "T-AB1", column: "doing" }, { op: "move", id: "T-AB1", column: "doing", ifRev: 7, ttlMs: 120000 }],
    [{ op: "note", id: "T-AB1", text: "hi", kind: "log" }, { op: "note", id: "T-AB1", text: "hi", kind: "log", ifRev: 7, ttlMs: 120000 }],
    [{ op: "edit", id: "T-NOREV", title: "new", desc: "d" }, { op: "edit", id: "T-NOREV", title: "new", desc: "d", ifRev: 0, ttlMs: 120000 }],
    [{ op: "archive", id: "T-AB1" }, { op: "archive", id: "T-AB1", ifRev: 7, ttlMs: 120000 }],
    [{ op: "add", title: "x", desc: "", tags: ["a"], column: "backlog", priority: "P1", project: "P-OTHER" }, { op: "add", title: "x", desc: "", tags: ["a"], column: "backlog", priority: "P1", project: PID, ttlMs: 120000 }],
  ];
  for (const [op, want] of cases) {
    const out = await sendAndAnswer(op, "ok: done");
    assert.equal(out.status, "saved", op.op);
    assert.deepEqual(bodyOf(lastSend()), want, op.op);
  }
});

test("1a any op outside the whitelist is refused and nothing is sent", async () => {
  await enable();
  for (const op of ["start", "wake", "next", "link", "project", "project-add", "protocol", "note-rm", "x"]) {
    const out = await w.send(M, PID, { op, id: "T-AB1" });
    assert.equal(out.status, "refused", op);
  }
  assert.equal(hc.sends().length, 0);
});

test("1a two argv-only steps: the JSON is a local argv item only; the remote script has the nonce as $0 and omarchy stamps date +%s", async () => {
  await enable();
  await sendAndAnswer({ op: "move", id: "T-AB1", column: "doing" }, "ok: T-AB1 -> doing");
  const s1 = lastSend();
  assert.equal(s1.cmd, "sh");
  assert.equal(s1.args[0], "-c"); assert.equal(s1.args[1], 'printf %s "$1" | hc file write --on "$2" "$3"');
  assert.equal(s1.args[2], "drover-send");
  assert.equal(s1.args[4], M);
  const nonce = hc.remoteSends().at(-1).args[6];
  assert.equal(s1.args[5], `${DIR}/.${nonce}.tmp`);
  assert.deepEqual(JSON.parse(s1.args[3]), { op: "move", id: "T-AB1", column: "doing", ifRev: 7, ttlMs: 120000 });
  const a = hc.remoteSends().at(-1).args;
  assert.deepEqual(a.slice(0, 5), ["exec", "--on", M, "sh", "-c"]);
  assert.equal(a[5], 'd=$HOME/.config/herdr-app/data/drover-inbox; f=$(date +%s)-$0; mv "$d/.$0.tmp" "$d/$f.json" && echo "$f.json"');
  assert.equal(a.length, 7);
  assert.match(a[6], /^LLAPTOP1-\d{12}$/);
  assert.ok(!hc.calls.filter((c) => c.step !== 1).map((c) => JSON.stringify(c.args)).join("").includes('"op"'), "the payload is never in a remote argv or script");
});

test("1a step 1 fails: nothing is applied, no second step, no resend", async () => {
  await enable();
  hc.mode = "stage-fail";
  const o = await w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  assert.equal(o.status, "failed"); assert.match(o.message, /nothing was applied/);
  assert.equal(hc.remoteSends().length, 0);
  assert.deepEqual((shared[W.PENDING_KEY] ?? []).filter((e) => !e.probe), []);
  assert.equal(w.inflight(M), 0);
});

// ---- 1b: the nonce ----
test("1b the nonce is unique per call, in pending BEFORE the send, passed as $0 and never in the script", async () => {
  const seen = [];
  const spy = { pending: [] };
  w = mk({
    exec: async (c, a, o) => { spy.pending = (shared[W.PENDING_KEY] ?? []).map((e) => e.nonce); return hc.exec(c, a, o); },
    run: async (args, o) => { if (sc(args)?.startsWith("d=$HOME")) seen.push({ nonce: arg(args), script: sc(args), pending: spy.pending }); return hc.run(args, o); },
  });
  await enable();
  for (let i = 0; i < 3; i++) await sendAndAnswer({ op: "move", id: "T-AB1", column: "doing" }, "ok: x");
  assert.equal(seen.length, 4); // the probe and 3 moves
  assert.equal(new Set(seen.map((s) => s.nonce)).size, 4);
  for (const s of seen) {
    assert.match(s.nonce, /^LLAPTOP1-[A-Za-z0-9]{12}$/);
    assert.ok(s.pending.includes(s.nonce), "recorded in pending before the exec");
    assert.ok(!s.script.includes(s.nonce), "never inline in the script");
  }
});

test("1b a task id, machine or nonce outside its charset never reaches argv", async () => {
  await enable();
  for (const id of ["T-ab", "T-A; rm -rf /", "../x", "", "T-"]) assert.equal((await w.send(M, PID, { op: "move", id, column: "doing" })).status, "refused", id);
  assert.equal((await w.send("bad machine;", PID, { op: "move", id: "T-AB1", column: "doing" })).status, "refused");
  assert.equal((await w.send("om$(x)", PID, { op: "add", title: "x" })).status, "refused");
  assert.throws(() => mk({ origin: "bad origin" }), /origin/);
  await assert.rejects(mk({ rand: () => "x;y" }).probe(M), /nonce/);
  assert.equal(hc.sends().length, 0);
  const everything = hc.calls.flatMap((c) => c.args).join(" ");
  assert.ok(!everything.includes("rm -rf"));
});

// ---- 1b2: reply lost ----
test("1b2 the rename happened but the reply was lost: recover by nonce, no resend, no cleanup as 'no longer pending'", async () => {
  await enable();
  hc.mode = "after";
  const out = await w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  assert.equal(out.status, "pending");
  assert.match(out.message, /may still apply/);
  assert.equal(hc.sends().length, 1);
  hc.mode = "ok";
  await w.cleanup(M); // would remove "no longer pending" results if it did
  assert.equal(hc.rms().length, 0);
  hc.consume(() => "ok: T-AB1 -> doing");
  clock += 20000; await w.tick();
  await until(() => outcomes.length === 1, "late outcome");
  assert.equal(outcomes[0].status, "saved");
  assert.equal(hc.sends().length, 1, "never resent");
  const ls = hc.calls.find((c) => sc(c.args)?.includes("grep -F"));
  assert.ok(ls && /^LLAPTOP1-/.test(arg(ls.args)), "recovered through ls | grep -F with the nonce in $0");
  assert.deepEqual(shared[W.PENDING_KEY] ?? [], []);
});

// ---- 1b3: gate, probe, freeze ----
test("1b3 the probe is {op:protocol, ttlMs:30000}; writes need `ok: protocol 2` newer than 60 s", async () => {
  const p = w.probe(M);
  await until(() => delivered(), "probe sent");
  assert.deepEqual(bodyOf(lastSend()), { op: "protocol", ttlMs: 30000 });
  assert.equal(w.canWrite(M, PID).ok, false);
  hc.consume(() => "ok: protocol 2"); clock += 1000; await w.tick(); await p;
  assert.equal(w.canWrite(M, PID).ok, true);
  clock += 59000; assert.equal(w.canWrite(M, PID).ok, true);
  clock += 2000; assert.equal(w.canWrite(M, PID).ok, false, "older than 60 s");
});

test("1b3 the probe is re-sent when the last answer is old, and writes stay off when it fails", async () => {
  await enable();
  clock += 61000;
  const t = w.tick();
  await until(() => delivered(), "re-probe");
  assert.equal(bodyOf(lastSend()).op, "protocol");
  hc.consume(() => "error: Unknown drover command: protocol"); // rollback to v1 with hc still up
  clock += 1000; await w.tick(); await t;
  const g = w.canWrite(M, PID);
  assert.equal(g.ok, false);
  assert.match(g.reason, /needs the update/);
});

test("1b3 reconnect forgets the answer and re-probes", async () => {
  await enable();
  w.reconnect(M);
  assert.equal(w.canWrite(M, PID).ok, false);
  await until(() => hc.sends().some((c) => bodyOf(c).op === "protocol"), "probe on reconnect");
});

test("1b3 a read-only binding (writes:false) sends nothing", async () => {
  await enable();
  linkState.writes = false;
  const out = await w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  assert.equal(out.status, "refused");
  assert.match(out.message, /read-only/);
  assert.equal(hc.sends().length, 0);
});

test("1b3 frozen is reported only after the in-flight sends end", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  w = mk({ exec: async (c, a, o) => { if (JSON.parse(a[3]).op === "move") await gate; return hc.exec(c, a, o); } });
  await enable();
  const p = w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  await until(() => w.inflight(M) === 1, "in flight");
  linkState.writes = false;
  assert.equal(w.frozen(M, PID), false, "a send is still in flight");
  release(); await until(() => w.inflight(M) === 0, "send ended");
  assert.equal(w.frozen(M, PID), true);
  assert.equal((await w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" })).status, "refused");
  clock += 1000; await w.tick(); void p;
});

// the drain-check (a disposable inbox) is deploy/omarchy/drain-check.sh, Job 2.

// ---- 1c: result mapping ----
test("1c ok saves, stale reloads, expired says too old", async () => {
  await enable();
  let o = await sendAndAnswer({ op: "move", id: "T-AB1", column: "doing" }, "ok: T-AB1 -> doing");
  assert.equal(o.status, "saved");
  o = await sendAndAnswer({ op: "move", id: "T-AB1", column: "doing" }, "error: stale: card T-AB1 is at rev 9, request saw 7");
  assert.equal(o.status, "stale"); assert.equal(o.message, "card changed on omarchy");
  assert.deepEqual(reloads, [[M, PID]]);
  o = await sendAndAnswer({ op: "move", id: "T-AB1", column: "doing" }, "error: expired: arrived 300s ago, ttl 120000ms; not applied");
  assert.equal(o.status, "expired"); assert.equal(o.message, "not applied, too old");
  o = await sendAndAnswer({ op: "move", id: "T-AB1", column: "doing" }, "error: unknown task T-NOPE");
  assert.equal(o.status, "error"); assert.match(o.message, /unknown task/);
});

test("1c no result in 10 s: 'sent, may still apply', no resend; the result file is removed after it is read", async () => {
  await enable();
  const p = w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  await until(() => delivered(), "sent");
  clock += 10001; await w.tick();
  const o = await p;
  assert.equal(o.status, "pending"); assert.equal(o.message, "sent, may still apply");
  clock += 5000; await w.tick(); await drain();
  assert.equal(hc.sends().length, 1);
  hc.inbox = {}; // the first request is still pending on the laptop side only
  const done = await sendAndAnswer({ op: "archive", id: "T-AB1" }, "ok: T-AB1 archived");
  assert.equal(done.status, "saved");
  assert.equal(hc.rms().length, 1, "own result removed after reading");
  assert.match(arg(hc.rms()[0].args), /^\d+-LLAPTOP1-\d{12}\.result$/);
});

// ---- 1d: refusal ----
test("1d stale or unreachable machine, or an unanswered probe: every write is refused with the reason", async () => {
  linkState.state = "stale";
  let o = await w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  assert.equal(o.status, "refused"); assert.match(o.message, /unreachable|saved copy/);
  linkState.state = "fresh";
  o = await w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  assert.equal(o.status, "refused"); assert.match(o.message, /checking/i);
  assert.equal(hc.sends().filter((c) => bodyOf(c).op !== "protocol").length, 0);
});

test("1d a card missing from the saved copy is refused (no ifRev to send)", async () => {
  await enable();
  const o = await w.send(M, PID, { op: "move", id: "T-GONE", column: "doing" });
  assert.equal(o.status, "refused");
  assert.equal(hc.sends().length, 0);
});

// ---- 1f: delayed outcomes ----
test("1f disconnect before the rename (step 2 drops): a missing file is NOT proof of nothing applied; it stays pending until TTL + 1 h, then unknown", async () => {
  await enable();
  hc.mode = "before";
  const o = await w.send(M, PID, { op: "add", title: "x" });
  assert.equal(o.status, "pending"); assert.match(o.message, /may still apply/);
  assert.equal(hc.sends().length, 1);
  assert.equal((shared[W.PENDING_KEY] ?? []).filter((e) => !e.probe).length, 1, "kept");
  clock += 20000; await w.tick(); await drain();
  assert.equal(outcomes.length, 0, "absence alone settles nothing");
  clock += 3600000 + 120000; await w.tick();
  await until(() => outcomes.some((x) => x.status === "unknown"), "unknown");
  assert.equal(hc.sends().filter((c) => bodyOf(c).op === "add").length, 1, "never resent");
});

test("review 1.3 a failed listing is unknown, never 'nothing applied'; the entry stays and a later result still reconciles", async () => {
  await enable();
  hc.mode = "after";
  const p = await w.send(M, PID, { op: "add", title: "x" });
  assert.equal(p.status, "pending");
  hc.mode = "ok"; hc.listFails = true;
  clock += 20000; await w.tick(); await drain();
  assert.equal(outcomes.length, 0);
  assert.equal((shared[W.PENDING_KEY] ?? []).filter((e) => !e.probe).length, 1);
  hc.listFails = false;
  hc.consume(() => "ok: T-NEW1 added");
  clock += 20000; await w.tick();
  await until(() => outcomes.some((x) => x.status === "saved"), "late result");
});

test("1f a timed-out add is reconciled by its late result after the UI is reopened", async () => {
  await enable();
  const p = w.send(M, PID, { op: "add", title: "x" });
  await until(() => delivered(), "sent");
  clock += 10001; await w.tick(); await p;
  const saved = JSON.parse(JSON.stringify(shared[W.PENDING_KEY]));
  w = mk(); // UI reopened: a new writer with the persisted pending list
  assert.deepEqual(shared[W.PENDING_KEY], saved);
  hc.consume(() => "ok: T-NEW1 added");
  clock += 40000; await w.tick(); // the old writer stopped beating: the new one adopts the entry after 30 s
  await until(() => outcomes.length === 1, "late result");
  assert.equal(outcomes[0].status, "saved");
  assert.equal(hc.sends().length, 1);
});

test("1f a late error: stale reloads the board", async () => {
  await enable();
  const p = w.send(M, PID, { op: "edit", id: "T-AB1", title: "n" });
  await until(() => delivered(), "sent");
  clock += 10001; await w.tick(); await p;
  hc.consume(() => "error: stale: card T-AB1 is at rev 8, request saw 7");
  clock += 20000; await w.tick();
  await until(() => outcomes.length === 1, "late");
  assert.equal(outcomes[0].status, "stale");
  assert.deepEqual(reloads, [[M, PID]]);
});

test("1f a pending entry older than TTL + 1 h is 'outcome unknown'; nothing is resent", async () => {
  await enable();
  hc.mode = "after";
  await w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  hc.mode = "ok"; hc.inbox = {};
  clock += 120000 + 3600000 + 1000; await w.tick();
  await until(() => outcomes.length === 1, "unknown");
  assert.equal(outcomes[0].status, "unknown"); assert.match(outcomes[0].message, /outcome unknown/);
  assert.equal(hc.sends().filter((c) => bodyOf(c).op === "move").length, 1, "the move is never resent (a new probe is not a resend)");
  assert.deepEqual((shared[W.PENDING_KEY] ?? []).filter((e) => !e.probe), []);
});

// ---- 1g: cleanup ----
test("1g a leftover own-origin .result older than 24 h is removed; a foreign one and a young one are kept", async () => {
  const day = 86400;
  const nowS = Math.floor(clock / 1000);
  hc.inbox = {
    [`${nowS - day - 10}-LLAPTOP1-000000000001.result`]: "ok: old own",
    [`${nowS - 100}-LLAPTOP1-000000000002.result`]: "ok: young own",
    [`${nowS - day - 10}-LOTHER-000000000003.result`]: "ok: foreign origin",
    [`${nowS - day - 10}-4242.result`]: "ok: CLI",
    [`${nowS - day - 10}-LLAPTOP1-000000000004.json`]: "{}",
  };
  await w.cleanup(M);
  assert.deepEqual(Object.keys(hc.inbox).sort(), [`${nowS - 100}-LLAPTOP1-000000000002.result`, `${nowS - day - 10}-4242.result`, `${nowS - day - 10}-LLAPTOP1-000000000004.json`, `${nowS - day - 10}-LOTHER-000000000003.result`].sort());
  assert.equal(hc.rms().length, 1);
  assert.ok(sc(hc.rms()[0].args).includes("rm --"));
});

test("1g a name outside the charset is never passed to rm", async () => {
  const nowS = Math.floor(clock / 1000);
  hc.inbox = { [`${nowS - 100000}-LLAPTOP1-0000000000$x.result`]: "x", [`${nowS - 100000}-LLAPTOP1-000000000001.result; rm`]: "x" };
  await w.cleanup(M);
  assert.equal(hc.rms().length, 0);
});

// ---- 5: security ----
test("5 payloads hold only op fields plus ifRev and ttlMs; a sentinel in the cache never reaches argv or stdin", async () => {
  shared[KEY].tasks[0].desc = SENTINEL; shared[KEY].tasks[0].agent = SENTINEL;
  await enable();
  await sendAndAnswer({ op: "move", id: "T-AB1", column: "doing", agent: SENTINEL, env: SENTINEL }, "ok: x");
  const body = bodyOf(lastSend());
  assert.deepEqual(Object.keys(body).sort(), ["column", "id", "ifRev", "op", "ttlMs"]);
  assert.ok(!JSON.stringify(hc.calls).includes(SENTINEL));
});

test("1g step 1 leftovers: an own-origin `.L<origin>-*.tmp` older than 24 h is removed; foreign, young and still-pending ones are kept", async () => {
  const p = w.probe(M); await until(() => delivered(), "probe"); // a pending entry with its own staging name
  const live = `.${shared[W.PENDING_KEY][0].nonce}.tmp`;
  Object.assign(hc.inbox, { ".LLAPTOP1-000000000091.tmp": "{}", ".LLAPTOP1-000000000092.tmp": "{}", ".LOTHER-000000000093.tmp": "{}", ".4242.tmp": "{}", ".LLAPTOP1-0000000000$x.tmp": "{}" });
  hc.inbox[live] ??= "{}";
  hc.old = new Set([".LLAPTOP1-000000000091.tmp", ".LOTHER-000000000093.tmp", ".4242.tmp", ".LLAPTOP1-0000000000$x.tmp", live]);
  await w.cleanup(M);
  assert.ok(!(".LLAPTOP1-000000000091.tmp" in hc.inbox), "own, old: removed");
  for (const n of [".LLAPTOP1-000000000092.tmp", ".LOTHER-000000000093.tmp", ".4242.tmp", ".LLAPTOP1-0000000000$x.tmp", live]) assert.ok(n in hc.inbox, `${n} kept`);
  assert.equal(hc.rms().length, 1);
  assert.match(arg(hc.rms()[0].args), /^\.LLAPTOP1-\d{12}\.tmp$/);
  void p;
});

// ---- Inspector review 1 (Job 5): several writers on one pending list, shared freeze, probe generations, deadlines ----
const mkB = (over = {}) => W.createWriter({
  run: hc.run, exec: hc.exec, getShared: (k) => shared[k], setShared: (k, v) => { if (v === null) delete shared[k]; else shared[k] = v; },
  now: () => clock, rand: () => "B" + String(++seq).padStart(11, "0"), origin: "LAPTOP1", link: () => linkState, writable: () => linkState.writes !== false, reload: () => {}, onOutcome: (o) => outcomesB.push(o), ...over,
});
let outcomesB;
const gated = () => { let release; const gate = new Promise((r) => (release = r)); return { gate, release }; };

test("review 1.1 a second writer never touches the first one's staging entry; A's caller still resolves; an orphan is adopted after 30 s", async () => {
  outcomesB = [];
  const g = gated();
  w = mk({ exec: async (c, a, o) => { if (JSON.parse(a[3]).op === "add") await g.gate; return hc.exec(c, a, o); } });
  await enable();
  const B = mkB();
  const pA = w.send(M, PID, { op: "add", title: "from A" });
  await until(() => w.inflight(M) === 1, "A is staging");
  clock += 2000; await B.tick();
  assert.equal(outcomesB.length, 0);
  assert.equal((shared[W.PENDING_KEY] ?? []).filter((e) => !e.probe).length, 1, "B did not remove A's entry");
  g.release();
  await until(() => w.inflight(M) === 0, "A's rename done");
  hc.consume(() => "ok: T-NEW1 added");
  clock += 1000;
  const o = await (async () => { for (;;) { await w.tick(); await B.tick(); const r = await Promise.race([pA, drain(2).then(() => null)]); if (r) return r; } })();
  assert.equal(o.status, "saved", "A's own waiter got the answer");
  assert.equal(outcomesB.length, 0, "B did not surface it");
});

test("review 1.1 an entry whose owner stopped beating is adopted by another writer after 30 s and reconciled", async () => {
  outcomesB = [];
  await enable();
  hc.mode = "after";
  await w.send(M, PID, { op: "add", title: "x" }); // A: pending, then A goes away (UI closed)
  hc.mode = "ok"; hc.consume(() => "ok: T-NEW2 added");
  const B = mkB();
  clock += 20000; await B.tick(); await drain();
  assert.equal(outcomesB.length, 0, "A is still alive for B (beat younger than 30 s)... or not adopted yet");
  clock += 40000; await B.tick();
  await until(() => outcomesB.some((x) => x.status === "saved"), "adopted and settled by B");
});

test("review 1.2 frozen comes from the shared pending list: another copy's send in staging keeps it false", async () => {
  const g = gated();
  w = mk({ exec: async (c, a, o) => { if (JSON.parse(a[3]).op === "move") await g.gate; return hc.exec(c, a, o); } });
  await enable();
  const B = mkB();
  const p = w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  await until(() => w.inflight(M) === 1, "A is staging");
  linkState.writes = false;
  assert.equal(B.frozen(M, PID), false, "B sees A's send in flight");
  assert.equal(w.frozen(M, PID), false);
  g.release(); await until(() => w.inflight(M) === 0, "A done");
  assert.equal(B.frozen(M, PID), true);
  assert.equal(w.frozen(M, PID), true);
  clock += 1000; await w.tick(); void p;
});

test("review 1.4 a probe answered after reconnect() is discarded and a new probe is sent", async () => {
  const p0 = w.probe(M);
  await until(() => delivered(), "old probe staged");
  const oldJson = Object.keys(hc.inbox).find((n) => n.endsWith(".json"));
  w.reconnect(M);
  await until(() => hc.sends().length === 2 && w.inflight(M) === 0, "a new probe is sent for the new connection");
  hc.inbox[oldJson.replace(/\.json$/, ".result")] = "ok: protocol 2"; delete hc.inbox[oldJson]; // only the OLD connection's probe is answered
  clock += 1000; await w.tick(); await drain();
  assert.equal(w.canWrite(M, PID).ok, false, "the old answer does not enable writes");
  hc.consume(() => "ok: protocol 2");
  clock += 1000; await w.tick();
  await until(() => w.canWrite(M, PID).ok, "the new connection's answer enables writes");
  void p0;
});

test("review 1.5 a held remote rename: at 10 s the caller resolves 'may still apply', the send stays in flight until hc returns, a late return is reconciled", async () => {
  const g = gated();
  w = mk({ run: async (a, o) => { if (g.on && sc(a)?.startsWith("d=$HOME")) await g.gate; return hc.run(a, o); } });
  await enable();
  g.on = true;
  const p = w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  await until(() => hc.sends().length === 1, "staged");
  clock += 10001;
  const t = w.tick();
  const o = await p;
  assert.equal(o.status, "pending"); assert.equal(o.message, "sent, may still apply");
  assert.equal(w.inflight(M), 1, "still counted in flight (frozen stays false)");
  linkState.writes = false; assert.equal(w.frozen(M, PID), false);
  g.release();
  await until(() => w.inflight(M) === 0, "the late return");
  assert.equal(linkState.writes === false && w.frozen(M, PID), true);
  hc.consume(() => "ok: T-AB1 -> doing");
  clock += 20000; await w.tick();
  await until(() => outcomes.some((x) => x.status === "saved"), "late result reconciled");
  assert.equal(hc.sends().length, 1, "no resend"); void t;
});

test("review 1.5 a held result read does not block the caller's deadline", async () => {
  const g = gated();
  w = mk({ run: async (a, o) => { if (a[0] === "file" && a[4].endsWith(".result") && g.on) await g.gate; return hc.run(a, o); } });
  await enable();
  g.on = true;
  const p = w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  await until(() => delivered(), "staged");
  clock += 1000; const t1 = w.tick(); // the first look is held
  clock += 10000; const t2 = w.tick();
  const o = await p;
  assert.equal(o.status, "pending");
  g.release(); await t1; await t2;
});

test("review 1.3 the real FIND_SCRIPT: a failing listing exits 3 (unknown), not 1 (absent); a hit exits 0", () => {
  const home = mkdtempSync(join(tmpdir(), "find-home-"));
  const run = (h) => spawnSync("sh", ["-c", W.FIND_SCRIPT, "LX-000000000001"], { env: { HOME: h, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(run(join(home, "no-such-home")).status, 3, "the inbox cannot be listed");
  const dir = join(home, ".config/herdr-app/data/drover-inbox");
  mkdirSync(dir, { recursive: true });
  assert.equal(run(home).status, 1, "listed, no match");
  writeFileSync(join(dir, "1700000000-LX-000000000001.json"), "{}");
  const hit = run(home);
  assert.equal(hit.status, 0); assert.equal(hit.stdout.trim(), "1700000000-LX-000000000001.json");
});

// ---- Inspector re-review 2 (Job 7) ----
const tickSome = async (w_) => { await Promise.race([w_.tick(), drain(2)]); };

test("re-review 2.1 a live owner's send stays in flight until its hc call returns, however long it takes", async () => {
  const g = gated();
  w = mk({ run: async (a, o) => { if (g.on && sc(a)?.startsWith("d=$HOME")) await g.gate; return hc.run(a, o); } });
  await enable();
  g.on = true;
  const p = w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  await until(() => w.inflight(M) === 1 && hc.sends().length === 1, "rename held");
  g.on = false; // only this one call is held
  linkState.writes = false;
  for (let i = 0; i < 16; i++) { clock += 10000; await tickSome(w); } // 160 s: past the old 120 s cut-off, the owner still beats
  assert.equal(w.frozen(M, PID), false, "the rename can still happen");
  g.release();
  await until(() => w.inflight(M) === 0, "the call returned");
  assert.equal(w.frozen(M, PID), true);
  void p;
});

test("re-review 2.1 an entry adopted from a dead owner still counts as in flight for 2 x ttl after adoption", async () => {
  outcomesB = [];
  const g = gated();
  w = mk({ run: async (a, o) => { if (g.on && sc(a)?.startsWith("d=$HOME")) await g.gate; return hc.run(a, o); } });
  await enable();
  g.on = true;
  const pA = w.send(M, PID, { op: "move", id: "T-AB1", column: "doing" });
  await until(() => w.inflight(M) === 1 && hc.sends().length === 1, "rename held");
  linkState.writes = false;
  const B = mkB(); // A goes silent (no more ticks)
  clock += 31000; await tickSome(B);
  assert.equal(B.frozen(M, PID), false, "adopted, but not certified ended");
  clock += 200000; await tickSome(B);
  assert.equal(B.frozen(M, PID), false, "still inside 2 x ttl of the adoption");
  clock += 60000; await tickSome(B);
  assert.equal(B.frozen(M, PID), true, "after 240 s from adoption");
  g.release(); void pA;
});

test("re-review 2.3 lost-reply recovery does not hold the caller past the 10 s deadline", async () => {
  const g = gated();
  w = mk({ run: async (a, o) => { if (g.on && sc(a)?.startsWith("d=$HOME")) clock += 9000; if (g.on && sc(a)?.includes("grep -F")) await g.gate; return hc.run(a, o); } }); // the reply is lost at send + 9 s
  await enable();
  g.on = true;
  hc.mode = "after";
  let o = null;
  const p = w.send(M, PID, { op: "add", title: "x" }).then((v) => (o = v));
  await until(() => hc.sends().length === 1 && w.inflight(M) === 0, "rename done, reply lost, lookup held");
  clock += 1001; await tickSome(w); // send + 10.001 s
  await until(() => o, "the caller resolved at its deadline", 2000);
  assert.equal(o.status, "pending"); assert.equal(o.message, "sent, may still apply");
  g.release(); void p;
});

test("re-review 2.5 writes:false sends nothing, not even the protocol probe; turning writes on probes at once", async () => {
  linkState.writes = false;
  w.reconnect(M);
  clock += 1000; await tickSome(w); await drain();
  clock += 100000; await tickSome(w); await drain();
  assert.equal(hc.sends().length, 0, "nothing staged");
  assert.equal(hc.remoteSends().length, 0);
  linkState.writes = true;
  clock += 1000; await tickSome(w);
  await until(() => hc.sends().length === 1, "a probe as soon as writes are on");
  assert.equal(bodyOf(hc.sends()[0]).op, "protocol");
});
