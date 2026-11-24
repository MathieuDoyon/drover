// A3b J1 (T-MWO2UYPADZC): the exec transport of a remote project. Tests written first (red): the module does not exist yet.
// Everything is a fake runner: no hc, no machine, no clock. The remote answers like drover-headless (version|rev|tasks|projects, writes on stdin).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const X = await import("../_lib/remote-exec.js");

const OPS = ["add", "archive", "edit", "import", "move", "move-out", "note", "project-add"];
const card = (id, extra = {}) => ({ id, title: id, project: "P-ABC", column: "todo", ...extra });
const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });

// A fake remote board behind a runner. Counts every verb it is asked.
function fakeRemote({ tasks = [card("T-1")], ops = OPS } = {}) {
  const st = { tasks, gen: 1, calls: [], down: false, hang: false };
  const run = async (args) => {
    st.calls.push(args);
    if (st.hang) return new Promise(() => {});
    if (st.down) return { code: 255, stdout: "", stderr: "ssh: unreachable secret-host" };
    const verb = args.slice(args.indexOf(X.HEADLESS) + 1);
    const nowField = st.skew === undefined ? {} : { now: st.nowFn() + st.skew };
    if (verb[0] === "version") return ok({ cli: "drover-headless", schema: 1, ops, ...nowField });
    if (verb[0] === "rev") return ok({ gen: st.gen, tasks: `h${st.gen}`, bytes: 10, ...nowField });
    if (verb[0] === "tasks") return ok({ gen: st.gen, rev: `h${st.gen}`, tasks: st.tasks });
    if (verb[0] === "projects") return ok({ gen: st.gen, projects: [{ id: "P-ABC", name: "Abc" }, { id: "P-XYZ", name: "Xyz" }, { id: "P-OWN", name: "Own", remote: { machine: "m", projectId: "P-1" } }] });
    return { code: 2, stdout: "", stderr: "usage" };
  };
  return { st, run };
}
function mem() { const m = new Map(); return { getShared: (k) => m.get(k), setShared: (k, v) => (v === null ? m.delete(k) : m.set(k, v)), m }; }
function reader(extra = {}) {
  const f = extra.remote ?? fakeRemote();
  const s = mem();
  const clock = { t: 1_000_000 };
  f.st.nowFn = () => clock.t;
  const r = X.createExecReader({ run: f.run, getShared: s.getShared, setShared: s.setShared, now: () => clock.t, ...extra.opts });
  r.sync([{ machine: "box", projectId: "P-ABC", id: "B-1" }]);
  return { r, f, s, clock };
}

test("exec is the only transport: remote-exec.js has no transport chooser and no inbox words", () => {
  assert.equal(X.transport, undefined);
});

test("the headless argv: hc exec --on <m>, the program relative to the remote home, no shell, no payload", () => {
  const a = X.headlessArgv("box", ["rev", "--json"]);
  assert.deepEqual(a.slice(0, 3), ["exec", "--on", "box"]);
  assert.equal(X.HEADLESS, ".local/share/drover-herdr/current/bin/drover-headless");
  assert.ok(!X.HEADLESS.startsWith("/") && !X.HEADLESS.includes("~"));
  assert.deepEqual(a.slice(a.indexOf(X.HEADLESS)), [X.HEADLESS, "rev", "--json"]);
  assert.ok(!a.includes("sh") && !a.includes("-c"));
});

test("reader: first pass asks version, rev, tasks, projects; the view is fresh and has the parseRemote shape", async () => {
  const { r, f, s } = reader();
  await r.tick();
  const verbs = f.st.calls.map((c) => c[c.indexOf(X.HEADLESS) + 1]);
  assert.deepEqual(verbs, ["version", "rev", "tasks", "projects"]);
  const v = r.view("box", "P-ABC");
  assert.equal(v.state, "fresh");
  assert.deepEqual(v.tasks.map((t) => t.id), ["T-1"]);
  assert.deepEqual(v.picks.projects.map((p) => p.id), ["P-ABC", "P-XYZ"], "a project owned by another machine is not a move target");
  assert.ok(Array.isArray(v.picks.assignees) && Array.isArray(v.picks.tags));
  assert.deepEqual(r.ops("box", "P-ABC"), OPS);
  assert.ok(s.m.size === 1);
});

test("reader: an unchanged rev fetches nothing more; a changed rev fetches tasks and projects", async () => {
  const { r, f, clock } = reader();
  await r.tick();
  f.st.calls.length = 0;
  clock.t += X.POLL_MS + 1;
  await r.tick();
  assert.deepEqual(f.st.calls.map((c) => c[c.indexOf(X.HEADLESS) + 1]), ["rev"]);
  f.st.gen = 2; f.st.tasks = [card("T-1"), card("T-2")];
  f.st.calls.length = 0;
  clock.t += X.POLL_MS + 1;
  await r.tick();
  assert.deepEqual(f.st.calls.map((c) => c[c.indexOf(X.HEADLESS) + 1]), ["rev", "tasks", "projects"]);
  assert.equal(r.view("box", "P-ABC").tasks.length, 2);
});

test("reader: archived and other projects' cards are not shown", async () => {
  const { r } = reader({ remote: fakeRemote({ tasks: [card("T-1"), card("T-2", { archived: true }), card("T-3", { project: "P-XYZ" })] }) });
  await r.tick();
  assert.deepEqual(r.view("box", "P-ABC").tasks.map((t) => t.id), ["T-1"]);
});

test("unreachable remote: the last cache stays, marked stale, with a fixed banner (no stderr); backoff to the slow cap", async () => {
  const { r, f, clock } = reader();
  await r.tick();
  f.st.down = true;
  for (let i = 0; i < X.SLOW_AFTER; i++) { clock.t += X.SLOW_MS + 1; await r.tick(); }
  const v = r.view("box", "P-ABC");
  assert.equal(v.state, "stale");
  assert.deepEqual(v.tasks.map((t) => t.id), ["T-1"]);
  assert.match(v.banner, /unreachable/);
  assert.doesNotMatch(JSON.stringify(v), /secret-host|ssh/);
  const n = f.st.calls.length;
  clock.t += X.POLL_MS + 1;
  await r.tick();
  assert.equal(f.st.calls.length, n, "after SLOW_AFTER failures the next poll waits the slow delay, not the normal one");
});

test("a hung runner never blocks tick: the read is abandoned at the deadline and counts as a failure", async () => {
  const { r, f, clock } = reader();
  await r.tick();
  f.st.hang = true;
  clock.t += X.POLL_MS + 1;
  const first = r.tick(); // starts a read that never answers
  clock.t += X.TIMEOUT_MS + 1;
  await r.tick(); // must return although the first read is still held
  await first;
  const v = r.view("box", "P-ABC");
  assert.equal(v.state, "stale");
  assert.equal(v.tasks.length, 1, "the cache is still shown");
});

test("a read that answers after it was abandoned is dropped", async () => {
  let release;
  const gate = new Promise((res) => (release = res));
  const f = fakeRemote();
  const slow = { ...f, run: async (a) => { if (f.st.hang) { await gate; return { code: 0, stdout: JSON.stringify({ gen: 9, rev: "late", tasks: [card("T-LATE")] }), stderr: "" }; } return f.run(a); } };
  const { r, clock } = reader({ remote: slow });
  await r.tick();
  f.st.hang = false; slow.st.hang = false;
  f.st.gen = 5; f.st.tasks = [card("T-5")];
  f.st.hang = true; // run() above waits on gate for every call
  clock.t += X.POLL_MS + 1;
  const p = r.tick();
  clock.t += X.TIMEOUT_MS + 1;
  await r.tick();
  release();
  await p;
  assert.ok(!r.view("box", "P-ABC").tasks.some((t) => t.id === "T-LATE"));
});

test("ops gating: a control is on only when the remote reported its op", () => {
  assert.equal(X.opGate(["move", "note"], "move"), null);
  assert.match(X.opGate(["move", "note"], "archive"), /does not support/);
  assert.match(X.opGate(null, "move"), /not reported/i);
  assert.match(X.opGate([], "move"), /does not support/);
  const all = X.controls(OPS);
  assert.deepEqual(all, { move: true, note: true, edit: true, add: true, archive: true });
  assert.deepEqual(X.controls(["move", "note"]), { move: true, note: true, edit: false, add: false, archive: false });
  assert.deepEqual(X.controls(null), { move: false, note: false, edit: false, add: false, archive: false });
});

// ---- the writer ----
function writer(extra = {}) {
  const calls = [];
  let seq = 0;
  const clock = { t: 5_000_000 };
  const inner = extra.exec ?? (async () => ok({ ok: true, gen: 2, replayed: false, attempts: 1, result: { id: "T-1", column: "doing", rev: 3 } }));
  const exec = async (cmd, args, o) => { calls.push({ cmd, args, o }); return inner(cmd, args, o); };
  const view = extra.view ?? { state: "fresh", ops: OPS, skew: 0 };
  const w = X.createExecWriter({ exec, now: () => clock.t, rand: () => `r${String(++seq).padStart(11, "0")}`, origin: "Lab", link: () => view, ...extra.opts });
  return { w, calls, clock };
}
const MOVE = { op: "move", id: "T-1", column: "doing" };
const body = (c) => c.args[c.args.indexOf("drover-send") + 1];

test("send: the payload travels as a LOCAL argv item to a local sh and reaches hc exec on stdin; no remote argv holds it", async () => {
  const { w, calls } = writer();
  const r = await w.send("box", "P-ABC", { ...MOVE, text: undefined }, { rev: 7 });
  assert.equal(r.status, "saved");
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.cmd, "sh");
  assert.match(c.args[1], /printf %s "\$p" \| hc exec/);
  assert.match(c.args[1], /--stdin/);
  const env = JSON.parse(body(c));
  assert.equal(env.op, "move");
  assert.equal(env.ifRev, 7);
  assert.match(env.nonce, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(env.issuedAt, 5_000_000);
  assert.ok(Number.isSafeInteger(env.ttlMs) && env.ttlMs > 0);
  // the remote argv (what follows the script, program onward) never contains the JSON or a card field
  const rest = c.args.slice(c.args.indexOf("drover-send") + 2);
  assert.ok(rest.includes(X.HEADLESS));
  assert.deepEqual(rest.slice(rest.indexOf(X.HEADLESS)), [X.HEADLESS, "move"]);
  for (const a of rest) assert.ok(!a.includes(env.nonce) && !a.includes("T-1"), `payload in argv: ${a}`);
  assert.ok(!c.args[1].includes(env.nonce), "the script text holds no payload");
});

test("send: a note with secret-looking text is only in the stdin item", async () => {
  const { w, calls } = writer();
  await w.send("box", "P-ABC", { op: "note", id: "T-1", text: "tok-SECRET-123", kind: "log" }, { rev: 1 });
  const c = calls[0];
  assert.equal(c.args.filter((a) => a.includes("tok-SECRET-123")).length, 1);
  assert.equal(c.args[c.args.indexOf("drover-send") + 1].includes("tok-SECRET-123"), true);
});

test("send: add uses the project id on the remote and verb add; the verb is the op name", async () => {
  const { w, calls } = writer();
  await w.send("box", "P-ABC", { op: "add", title: "new" }, {});
  const env = JSON.parse(body(calls[0]));
  assert.equal(env.project, "P-ABC");
  assert.equal(env.ifRev, undefined);
  assert.deepEqual(X.verbOf("move"), ["move"]);
});

test("writes are refused, and nothing is sent, when the view is not fresh", async () => {
  for (const state of ["stale", "never"]) {
    const { w, calls } = writer({ view: { state, ops: OPS, writes: true } });
    const r = await w.send("box", "P-ABC", MOVE, { rev: 1 });
    assert.equal(r.status, "refused");
    assert.match(r.message, /nothing was sent/);
    assert.equal(calls.length, 0);
    assert.deepEqual(w.pending(), [], "no queue");
  }
});

test("writes are refused when the op is not in the remote's ops list", async () => {
  const { w, calls } = writer({ view: { state: "fresh", ops: ["note"], writes: true } });
  const r = await w.send("box", "P-ABC", MOVE, { rev: 1 });
  assert.equal(r.status, "refused");
  assert.match(r.message, /does not support/);
  assert.match(r.message, /nothing was sent/);
  assert.equal(calls.length, 0);
});

test("retry re-sends the SAME envelope (same nonce, same issuedAt, same bytes)", async () => {
  let n = 0;
  const { w, calls, clock } = writer({ exec: async () => (++n === 1 ? { code: 255, stdout: "", stderr: "ssh: connection reset" } : ok({ ok: true, gen: 2, replayed: true, attempts: 1, result: { id: "T-1" } })) });
  const r1 = await w.send("box", "P-ABC", MOVE, { rev: 4 });
  assert.equal(r1.status, "unknown");
  assert.match(r1.message, /repeat within 24 h to retry safely; after 24 h check the card first/i);
  assert.ok(r1.nonce);
  assert.doesNotMatch(JSON.stringify(r1), /ssh|reset/);
  clock.t += 20_000;
  const r2 = await w.retry(r1.nonce);
  assert.equal(r2.status, "saved");
  assert.equal(calls.length, 2);
  assert.equal(body(calls[0]), body(calls[1]));
  assert.deepEqual(w.pending(), [], "settled: nothing held");
});

test("retry of an unknown nonce is refused without sending", async () => {
  const { w, calls } = writer();
  const r = await w.retry("nope");
  assert.equal(r.status, "refused");
  assert.equal(calls.length, 0);
});

const answer = (code, json) => ({ code, stdout: JSON.stringify(json), stderr: "raw stderr with a path" });
const cases = [
  [answer(1, { ok: false, code: "stale", error: "stale: card changed" }), "stale"],
  [answer(1, { ok: false, code: "expired", error: "expired: x" }), "expired"],
  [answer(1, { ok: false, code: "refused", error: "no such card" }), "refused"],
  [answer(1, { ok: false, code: "bad-envelope", error: "bad" }), "refused"],
  [answer(1, { ok: false, code: "nonce-reused", error: "x" }), "refused"],
  [answer(1, { ok: false, code: "unknown-op", error: "x" }), "refused"],
  [answer(1, { ok: false, code: "busy", error: "x" }), "failed"],
  [answer(1, { ok: false, code: "board-corrupt", error: "x" }), "failed"],
  [answer(1, { ok: false, code: "board-schema", error: "x" }), "failed"],
  [answer(1, { ok: false, code: "no-link", error: "x" }), "failed"],
  [answer(1, { ok: false, code: "E_SYNC", error: "x" }), "unknown"], // the new generation may already be published: the answer is not an "applied: no"
  [answer(1, { ok: false, code: "io", error: "x" }), "unknown"],
  [answer(1, { ok: false, code: "some-future-code", error: "x" }), "unknown"],
  [{ code: 69, stdout: "", stderr: "E_NODE_NOT_FOUND" }, "failed"],
  [{ code: 2, stdout: "", stderr: "usage" }, "failed"],
  [{ code: 255, stdout: "", stderr: "boom" }, "unknown"],
  [{ code: 0, stdout: "not json", stderr: "" }, "unknown"],
  [{ code: 1, stdout: "not json", stderr: "" }, "unknown"],
  [null, "unknown"],
];
test("error mapping: exit and JSON -> saved|stale|expired|refused|failed|unknown, with fixed messages", async () => {
  for (const [res, want] of cases) {
    const { w } = writer({ exec: async () => res });
    const r = await w.send("box", "P-ABC", MOVE, { rev: 1 });
    assert.equal(r.status, want, JSON.stringify(res));
    assert.doesNotMatch(JSON.stringify(r), /raw stderr|boom|E_NODE/, "never the raw stderr or the remote's error text");
    assert.ok(typeof r.message === "string" && r.message.length < 140);
  }
  assert.equal(X.classify(ok({ ok: true })).status, "saved");
});

test("a thrown or hung exec is unknown, never a hang: tick() ends the wait at the deadline", async () => {
  const { w, clock } = writer({ exec: async () => new Promise(() => {}) });
  const p = w.send("box", "P-ABC", MOVE, { rev: 1 });
  clock.t += X.SEND_TIMEOUT_MS + 1;
  w.tick();
  const r = await p;
  assert.equal(r.status, "unknown");
  const t = writer({ exec: async () => { throw new Error("spawn failed"); } });
  assert.equal((await t.w.send("box", "P-ABC", MOVE, { rev: 1 })).status, "unknown");
});

test("a definite answer forgets the envelope; an unknown one keeps it for retry only", async () => {
  const { w } = writer({ exec: async () => answer(1, { ok: false, code: "stale", error: "x" }) });
  const r = await w.send("box", "P-ABC", MOVE, { rev: 1 });
  assert.equal(r.status, "stale");
  assert.deepEqual(w.pending(), []);
});

test("the module is generic: no machine name, home path or OS word; a pure file (no Buffer, setTimeout, fs)", () => {
  const src = fs.readFileSync(new URL("../_lib/remote-exec.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, new RegExp(["homelab", "\\/home\\/", "\\/Us" + "ers\\/", "hyprland", "systemd", "launchd", "darwin", "linux", "project-add"].join("|"), "i"));
  assert.doesNotMatch(src, /\bBuffer\b|setTimeout|setInterval|require\(|from "node:|\bfs\./);
});

// ---- fix round 1 ----
test("F1: the header and the docs say 'never in a remote command line' and name the local argv limit", () => {
  const src = fs.readFileSync(new URL("../_lib/remote-exec.js", import.meta.url), "utf8");
  assert.match(src, /never in a remote command line/);
  assert.match(src, /local argv item/i);
  const doc = fs.readFileSync(new URL("../../docs/guides/remote-machines.md", import.meta.url), "utf8");
  assert.match(doc, /never in a remote command line/);
  assert.match(doc, /local/i);
});

test("F3: repeating the same op after an unknown answer re-sends the retained envelope (same nonce, same bytes); another op or a later repeat gets a new nonce", async () => {
  let n = 0;
  const { w, calls } = writer({ exec: async () => (++n === 1 ? { code: 255, stdout: "", stderr: "lost" } : ok({ ok: true, gen: 2, replayed: true, attempts: 1, result: { id: "T-9" } })) });
  const add = { op: "add", title: "same card", desc: "d" };
  const a = await w.send("box", "P-ABC", add, {});
  assert.equal(a.status, "unknown");
  const other = await w.send("box", "P-ABC", { op: "add", title: "another card" }, {});
  assert.equal(other.status, "saved");
  assert.notEqual(other.nonce, a.nonce, "a different op is a new request");
  const b = await w.send("box", "P-ABC", { ...add }, {});
  assert.equal(b.status, "saved");
  assert.equal(b.nonce, a.nonce);
  assert.equal(body(calls[0]), body(calls[2]), "the same bytes");
  assert.deepEqual(w.pending(), []);
  const c = await w.send("box", "P-ABC", { ...add }, {});
  assert.notEqual(c.nonce, a.nonce, "once answered, the same text is a new card on purpose");
});

test("F4: errors that can follow the publication are unknown and keep the envelope; errors before any write are failed", async () => {
  for (const code of ["E_SYNC", "io"]) {
    const { w } = writer({ exec: async () => answer(1, { ok: false, code, error: "x" }) });
    const r = await w.send("box", "P-ABC", MOVE, { rev: 1 });
    assert.equal(r.status, "unknown", code);
    assert.equal(w.pending().length, 1, `${code}: the envelope is kept`);
    assert.equal((await w.retry(r.nonce)).status, "unknown");
  }
  for (const code of ["busy", "board-corrupt", "board-schema", "no-link"]) {
    const { w } = writer({ exec: async () => answer(1, { ok: false, code, error: "x" }) });
    assert.equal((await w.send("box", "P-ABC", MOVE, { rev: 1 })).status, "failed", code);
  }
});

test("F5: the reader keeps the clock skew of the remote (midpoint of the call); no `now` in the answer means unknown", async () => {
  const { r, f } = reader({ remote: Object.assign(fakeRemote(), {}) });
  await r.tick();
  assert.equal(r.view("box", "P-ABC").skew, null, "an older headless reports no clock");
  const b = reader();
  b.f.st.skew = 45000;
  await b.r.tick();
  assert.equal(b.r.view("box", "P-ABC").skew, 45000);
  const c = reader();
  c.f.st.skew = -45000;
  await c.r.tick();
  assert.equal(c.r.view("box", "P-ABC").skew, -45000);
  void f;
});

test("F5: writes are refused with a fixed reason beyond 30 s of skew, in both directions, and allowed inside", async () => {
  for (const skew of [31000, -31000, 120000, -120000]) {
    const { w, calls } = writer({ view: { state: "fresh", ops: OPS, skew } });
    const r = await w.send("box", "P-ABC", MOVE, { rev: 1 });
    assert.equal(r.status, "refused", String(skew));
    assert.match(r.message, /clock/i);
    assert.match(r.message, /nothing was sent/);
    assert.equal(calls.length, 0);
  }
  for (const skew of [30000, -30000, 0, 5000]) {
    const { w } = writer({ view: { state: "fresh", ops: OPS, skew } });
    assert.equal((await w.send("box", "P-ABC", MOVE, { rev: 1 })).status, "saved", String(skew));
  }
  assert.equal(X.skewReason("box", 45000) !== null, true);
  assert.equal(X.skewReason("box", 1000), null);
});

// ---- fix round 2 ----
test("R2-4: with no clock reported (skew unknown) writes are refused, closed: 'update the machine: drover machines install'; reads are untouched", async () => {
  for (const skew of [null, undefined, NaN]) {
    const { w, calls } = writer({ view: { state: "fresh", ops: OPS, skew } });
    const r = await w.send("box", "P-ABC", MOVE, { rev: 1 });
    assert.equal(r.status, "refused");
    assert.match(r.message, /update the machine: drover machines install/);
    assert.match(r.message, /nothing was sent/);
    assert.equal(calls.length, 0);
  }
  assert.match(X.skewReason("box", null), /update the machine: drover machines install/);
});

test("R2-2: an unknown envelope is held for 24 h, not ttl + 60 s: the same action repeated after minutes re-sends the same bytes; after 24 h it is a new action", async () => {
  let n = 0;
  const { w, calls, clock } = writer({ exec: async () => (++n === 1 ? { code: 255, stdout: "", stderr: "lost" } : ok({ ok: true, gen: 2, replayed: true, attempts: 1, result: { id: "T-9" } })) });
  const add = { op: "add", title: "held a day" };
  const a = await w.send("box", "P-ABC", add, {});
  assert.equal(a.status, "unknown");
  clock.t += X.HELD_MS - 1000; w.tick();
  assert.equal(w.pending().length, 1, "still held just inside 24 h");
  const b = await w.send("box", "P-ABC", { ...add }, {});
  assert.equal(b.nonce, a.nonce);
  assert.equal(body(calls[0]), body(calls[1]));
  assert.equal(X.HELD_MS, 24 * 3600000);
});
test("R2-2/R3-1 (accepted by the owner): after 24 h the remote forgets the nonce, so the unresolved action is dropped and a repeat is a new request (a possible duplicate; the text says to check the card first)", async () => {
  const { w, clock } = writer({ exec: async () => ({ code: 255, stdout: "", stderr: "lost" }) });
  const a = await w.send("box", "P-ABC", { op: "add", title: "old" }, {});
  clock.t += X.HELD_MS + 1; w.tick();
  assert.deepEqual(w.pending(), []);
  const b = await w.send("box", "P-ABC", { op: "add", title: "old" }, {});
  assert.notEqual(b.nonce, a.nonce);
});

test("R2-3: a retry that fails non-authoritatively (exit 69, a launcher error, a timeout, busy) keeps the original unknown and its envelope; a real answer clears it", async () => {
  for (const bad of [{ code: 69, stdout: "", stderr: "E_NODE_NOT_FOUND" }, { code: 2, stdout: "", stderr: "usage" }, answer(1, { ok: false, code: "busy", error: "x" }), answer(1, { ok: false, code: "board-corrupt", error: "x" }), null]) {
    let n = 0;
    const { w, calls } = writer({ exec: async () => (++n === 1 ? { code: 255, stdout: "", stderr: "lost" } : n === 2 ? bad : ok({ ok: true, gen: 2, replayed: true, attempts: 1, result: { id: "T-9" } })) });
    const add = { op: "add", title: "kept through a failed retry" };
    const a = await w.send("box", "P-ABC", add, {});
    const b = await w.send("box", "P-ABC", { ...add }, {});
    assert.equal(b.status, "unknown", JSON.stringify(bad));
    assert.equal(b.nonce, a.nonce);
    assert.equal(w.pending().length, 1, "the original envelope is still held");
    const c = await w.send("box", "P-ABC", { ...add }, {});
    assert.equal(c.status, "saved");
    assert.equal(c.nonce, a.nonce);
    assert.equal(body(calls[0]), body(calls[2]));
    assert.deepEqual(w.pending(), []);
  }
});
test("R2-3: an authoritative answer to the retry (stale, expired, refused by the op) clears the held envelope", async () => {
  for (const [res, want] of [[answer(1, { ok: false, code: "stale", error: "x" }), "stale"], [answer(1, { ok: false, code: "expired", error: "x" }), "expired"], [answer(1, { ok: false, code: "refused", error: "x" }), "refused"]]) {
    let n = 0;
    const { w } = writer({ exec: async () => (++n === 1 ? { code: 255, stdout: "", stderr: "lost" } : res) });
    await w.send("box", "P-ABC", MOVE, { rev: 1 });
    const r = await w.send("box", "P-ABC", { ...MOVE }, { rev: 1 });
    assert.equal(r.status, want);
    assert.deepEqual(w.pending(), []);
  }
});

// Restored from the retired inbox tests (1h: a failed step logs one payload-free line; a stderr sentinel never reaches the log).
test("writer log: an unanswered (unknown) write logs one fixed line; neither the payload, the nonce nor the remote's stderr reaches the log", async () => {
  const SENTINEL = "SENTINEL-WRITER-LOG";
  const lines = [];
  const w = X.createExecWriter({
    exec: async () => ({ code: 255, stdout: "", stderr: SENTINEL }),
    link: () => ({ state: "fresh", ops: OPS, skew: 0 }),
    log: (line) => lines.push(String(line)),
  });
  const o = await w.send("box", "P-ABC", { op: "note", id: "T-1", text: SENTINEL, kind: "log" }, { rev: 1 });
  assert.equal(o.status, "unknown");
  assert.equal(lines.length, 1, "one line");
  assert.equal(lines[0], "remote box/P-ABC: exec write unanswered, note held for retry");
  assert.ok(!lines.join("\n").includes(SENTINEL), "no payload, no stderr");
  assert.ok(!lines.join("\n").includes(o.nonce), "no nonce");
});
