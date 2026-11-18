// Inbox protocol 2: `ifRev` rejects a stale write, `ttlMs` drops an old request, op `protocol` is the probe (T-MWHVWQW21AG).
// The consumer path runs for real (watchInbox over a temp inbox). No sleeps or tick counts: conditions via until().
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const IO = await import("../_lib/io.js");
const S = await import("../_lib/store.js");
const R = await import("../_lib/runs.js");
const KEY = "drover.tasks", SEEN = "drover.inbox-seen";

let home, inbox, host, statCalls, hold, noStat, resultWrites, onRead;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "iproto-home-"));
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  statCalls = []; hold = null; noStat = false; resultWrites = []; onRead = null;
  host = globalThis.__host = { appHome: home, props: {}, notified: [], state: {}, agents: [], terminals: [], watchFolder: () => new Promise(() => {}) };
  host.fsGuard = (op, path) => {
    if (op === "writeFile" && path.endsWith(".result")) resultWrites.push(path);
    if (op === "readFile" && path.endsWith(".json")) onRead?.(path);
  };
  host.exec = (cmd, args) => new Promise((resolve) => {
    if (cmd === "stat") { statCalls.push(args); if (noStat) return resolve({ code: 1, stdout: "", stderr: "stat: unavailable" }); }
    const run = () => execFile(cmd, args, { encoding: "utf8" }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }));
    hold ? hold.then(run) : run();
  });
});

const seed = (...titles) => { let t = []; for (const title of titles) t = S.add(t, { title, column: "todo" }).tasks; host.state[KEY] = t; return t.map((x) => x.id); };
const tasks = () => host.state[KEY] ?? [];
const snap = () => JSON.stringify(tasks());
const card = (id) => tasks().find((t) => t.id === id);
const startLoop = () => { const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) }; IO.watchInbox(cx); };
const drop = (name, cmd, { ageS } = {}) => {
  const p = join(inbox, `${name}.json`);
  writeFileSync(p, JSON.stringify(cmd));
  if (ageS != null) { const t = Date.now() / 1000 - ageS; utimesSync(p, t, t); }
};
const answer = (name) => until(() => existsSync(join(inbox, `${name}.result`)) && readFileSync(join(inbox, `${name}.result`), "utf8"), `the inbox answered ${name}`);
let n = 0;
const send = async (cmd, opts) => { const name = `q${++n}`; drop(name, cmd, opts); startLoop(); return answer(name); };

// ---- a. ifRev on move / edit / note / archive
test("a. a matching ifRev applies; a different one is stale and the task list is byte-equal", async () => {
  const [id] = seed("one");
  const reqs = [{ op: "move", column: "doing" }, { op: "edit", title: "renamed" }, { op: "note", text: "hello", by: "x" }, { op: "archive" }];
  for (const r of reqs) {
    const rev = S.revOf(card(id));
    const before = snap();
    const stale = await send({ ...r, id, ifRev: rev + 5 });
    assert.match(stale, /^error: stale: /, r.op);
    assert.ok(stale.includes(id) && stale.includes(`rev ${rev}`) && stale.includes(`saw ${rev + 5}`), stale);
    assert.equal(snap(), before, `${r.op} left the tasks byte-equal`);
    const ok = await send({ ...r, id, ifRev: rev });
    assert.match(ok, /^ok: /, r.op);
    assert.equal(S.revOf(card(id)), rev + 1, `${r.op} bumped rev`);
  }
});

// ---- b. rev strictly increases on every writer path
test("b. rev grows by one on every writer, with the same now and with a clock that goes backwards", () => {
  let ts = S.add([], { title: "a", column: "todo" }, 100).tasks;
  ts = S.add(ts, { title: "b", column: "todo" }, 100).tasks;
  const [a, b] = ts.map((t) => t.id);
  assert.equal(S.revOf(ts[0]), 0, "a new card has no rev: it counts as 0");
  assert.equal("rev" in ts[0], false);
  const steps = [
    ["unarchive", (x, now) => S.update(x, a, { archived: false }, now)],
    ["update", (x, now) => S.update(x, a, { title: "x" + now }, now)],
    ["update again", (x, now) => S.update(x, a, { title: "y" + now }, now)],
    ["reorder", (x, now) => S.reorder(x, a, "todo", b, now)],
    ["claim", (x, now) => S.claim(x, a, undefined, now, new Set())],
    ["release", (x, now) => S.release(x, a, { column: "todo" }, now)],
    ["note", (x, now) => S.applyCommand(x, { op: "note", id: a, text: "n", by: "t" }, now)],
    ["archive", (x, now) => S.applyCommand(x, { op: "archive", id: a }, now)],
  ];
  let prev = 0;
  for (const now of [100, 100, 50, 5]) for (const [name, f] of steps) {
    const r = f(ts, now);
    assert.ok(!r.error, `${name}: ${r.error}`);
    ts = r.tasks;
    const rev = S.revOf(ts.find((t) => t.id === a));
    assert.ok(rev > prev, `${name} at now=${now}: rev ${rev} > ${prev}`);
    prev = rev;
  }
  const noteId = ts.find((t) => t.id === a).notes[0].id;
  for (const op of [{ op: "note-edit", text: "e" }, { op: "note-rm" }]) {
    const before = S.revOf(ts.find((t) => t.id === a));
    ts = S.applyCommand(ts, { ...op, id: a, noteId }, 1).tasks;
    assert.equal(S.revOf(ts.find((t) => t.id === a)), before + 1, op.op);
  }
  const done = S.update(ts, b, { column: "done" }, 1).tasks;
  const bRev = S.revOf(done.find((t) => t.id === b));
  assert.equal(S.archiveDone(done, 1).tasks.find((t) => t.id === b).rev, bRev + 1, "archive all bumps the cards it archives");
});

test("b. reorder bumps every card whose stored order changes, and only those", () => {
  let ts = [];
  for (const title of ["a", "b", "c"]) ts = S.add(ts, { title, column: "todo" }, 1).tasks;
  const [a, b, c] = ts.map((t) => t.id);
  const r = S.reorder(ts, c, "todo", a, 1).tasks;
  for (const t of r) {
    const was = ts.find((x) => x.id === t.id);
    const changed = JSON.stringify({ ...t, rev: 0 }) !== JSON.stringify({ ...was, rev: 0 });
    assert.equal(S.revOf(t), S.revOf(was) + (changed ? 1 : 0), t.id);
  }
  assert.ok(S.revOf(r.find((t) => t.id === c)) > 0, "the moved card");
  assert.equal(S.revOf(r.find((t) => t.id === b)), 1, "b was renumbered");
});

test("b. runs.js reconcile (adopt/expire a claim) bumps rev", () => {
  let ts = S.add([], { title: "a", column: "todo", project: "P-1" }, 1).tasks;
  const id = ts[0].id;
  const c = S.claim(ts, id, "P-1", 10, new Set());
  const adopted = R.reconcile(c.tasks, [{ id: "R-1", task: id, started: 20, terminals: [{ address: "t9" }] }], new Set(["t9"]), 30, "P-1");
  assert.ok(S.revOf(adopted.tasks[0]) > S.revOf(c.tasks[0]), "adopt");
  const expired = R.reconcile(c.tasks, [], new Set(), 10 + R.claimTtl + 1, "P-1");
  assert.ok(S.revOf(expired.tasks[0]) > S.revOf(c.tasks[0]), "expire");
});

test("b. a card with no rev counts as 0: ifRev 0 applies, ifRev 1 is stale and says so", async () => {
  const [id] = seed("legacy");
  assert.equal("rev" in card(id), false);
  const stale = await send({ op: "move", id, column: "doing", ifRev: 1 });
  assert.match(stale, /^error: stale: card T-\S+ is at rev 0, request saw 1/);
  assert.ok(stale.includes("card has no rev, counts as 0"), stale);
  assert.equal(card(id).column, "todo");
  assert.match(await send({ op: "move", id, column: "doing", ifRev: 0 }), /^ok: /);
  assert.equal(card(id).rev, 1);
});

// ---- c, i. two consumers, interleaved
const startTwo = () => { startLoop(); startLoop(); };
const results = (names) => Promise.all(names.map(answer));

test("c. 2 distinct requests with the same ifRev across 2 consumers: exactly 1 applies, the other is stale", async () => {
  const [id] = seed("one");
  let release; hold = new Promise((r) => { release = r; }); // both consumers wait at the mtime lookup, then run interleaved
  drop("c1", { op: "move", id, column: "doing", ifRev: 0 });
  drop("c2", { op: "edit", id, title: "renamed", ifRev: 0 });
  startTwo();
  await until(() => statCalls.length >= 2, "both consumers reached the mtime lookup");
  release();
  const [r1, r2] = await results(["c1", "c2"]);
  const oks = [r1, r2].filter((r) => r.startsWith("ok: ")), stales = [r1, r2].filter((r) => r.startsWith("error: stale: "));
  assert.equal(oks.length, 1, `${r1} | ${r2}`);
  assert.equal(stales.length, 1);
  assert.equal(card(id).rev, 1, "applied once");
  assert.equal(resultWrites.length, 2, "one result per request, not per mod");
});

test("i. a local edit that commits before both compares makes both requests stale; without one, exactly 1 applies", async () => {
  const [id] = seed("one");
  let edited = false;
  onRead = () => { if (!edited) { edited = true; host.state[KEY] = S.update(tasks(), id, { desc: "local" }).tasks; } }; // between the file reads
  drop("i1", { op: "move", id, column: "doing", ifRev: 0 });
  drop("i2", { op: "note", id, text: "x", by: "y", ifRev: 0 });
  startTwo();
  const rs = await results(["i1", "i2"]);
  assert.deepEqual(rs.map((r) => r.slice(0, 13)), ["error: stale:", "error: stale:"]);
  assert.equal(card(id).rev, 1, "only the local edit");
  assert.equal(card(id).desc, "local");
  assert.equal(card(id).column, "todo");
});

test("c. compare and apply have no await between them: a microtask edit after the compare cannot slip in", async () => {
  const [id] = seed("one");
  let armed = true;
  const real = host.state;
  // The first read of the task list after the gate schedules a local edit as a microtask. It may only run after the write.
  host.state = new Proxy(real, { get(t, k) { if (k === KEY && armed && statCalls.length) { armed = false; queueMicrotask(() => { real[KEY] = S.update(real[KEY], id, { desc: "local" }).tasks; }); } return t[k]; }, set(t, k, v) { t[k] = v; return true; } });
  const reply = await send({ op: "move", id, column: "doing", ifRev: 0 });
  assert.match(reply, /^ok: /);
  const final = real[KEY].find((t) => t.id === id);
  assert.equal(final.column, "doing");
  assert.equal(final.desc, "local", "the local edit survived: nothing wrote an older copy over it");
  assert.equal(final.rev, 2);
});

// ---- d. backward compat
test("d. requests with no ifRev/ttlMs behave as before, for every op of the table", async () => {
  const [id, other] = seed("one", "two");
  const noteId = (await (async () => { await send({ op: "note", id, text: "n", by: "t" }); return card(id).notes[0].id; })());
  host.state[KEY] = tasks().map((t) => (t.id === id ? { ...t, project: "P-OLD" } : t)); // so the `project none` row has something to clear
  const table = [
    [{ op: "move", id, column: "doing" }, /^ok: T-\S+ -> in-progress$/],
    [{ op: "edit", id, title: "t2" }, /^ok: T-\S+ edited$/],
    [{ op: "note", id, text: "again", by: "t" }, /^ok: T-\S+ note 2$/],
    [{ op: "note-edit", id, noteId, text: "z" }, /^ok: T-\S+ \S+ edited$/],
    [{ op: "note-rm", id, noteId }, /^ok: T-\S+ \S+ removed$/],
    [{ op: "project", id, project: "none" }, /^ok: T-\S+ project none$/],
    [{ op: "link", id, url: "https://github.com/o/r/issues/1" }, /^ok: T-\S+ source https:\/\/github\.com\/o\/r\/issues\/1$/],
    [{ op: "add", title: "fresh" }, /^ok: T-\S+ added to backlog$/],
    [{ op: "wakes" }, /^ok: no wakeups/],
    [{ op: "wake-rm", id: "W-NONE" }, /^error: no wakeup W-NONE/],
    [{ op: "next", from: "t0" }, /^error: you are not bound to a project/],
    [{ op: "start", task: id, runner: "no-such-squad" }, /^error: no squad or agent no-such-squad/],
    [{ op: "archive", id: other }, /^ok: T-\S+ -> /],
    [{ op: "nonsense", id }, /^error: Unknown drover command$/],
  ];
  for (const [cmd, re] of table) {
    const reply = await send(cmd);
    assert.match(reply, re, JSON.stringify(cmd));
    if (cmd.op === "project") assert.equal(card(id).project ?? null, null, "the project is cleared");
  }
});

test("d. wake create, wake-off, wake-on and wake-rm through the inbox, with no protocol fields, change the stored wakeups as before", async () => {
  seed("one");
  const WAKE = "drover.wakeups", wakes = () => host.state[WAKE] ?? [];
  const made = await send({ op: "wake", target: "t7", when: "1d", text: "check CI" });
  assert.match(made, /^ok: W-\S+ to t7 at /);
  assert.equal(wakes().length, 1);
  const w = wakes()[0];
  assert.equal(made.split(" ")[1], w.id);
  assert.deepEqual([w.target, w.text, w.status, w.enabled, w.source], ["t7", "check CI", "scheduled", true, "agent"]);
  assert.match(w.src, /^q\d+\.json$/, "the file name is kept so a 2nd mod cannot add it twice");
  assert.equal(await send({ op: "wake-off", id: w.id }), `ok: ${w.id} disabled`);
  assert.equal(wakes()[0].enabled, false);
  assert.equal(await send({ op: "wake-on", id: w.id }), `ok: ${w.id} enabled`);
  assert.equal(wakes()[0].enabled, true);
  assert.match(await send({ op: "wakes" }), new RegExp(`^ok: 1 wakeups[^]*${w.id}`));
  assert.equal(await send({ op: "wake-rm", id: w.id }), `ok: ${w.id} removed`);
  assert.equal(wakes().length, 0);
});

test("d. the store applies a command the way an old consumer does: protocol fields are ignored there", () => {
  const ts = S.add([], { title: "a", column: "todo" }, 1).tasks;
  const r = S.applyCommand(ts, { op: "move", id: ts[0].id, column: "doing", ifRev: 99, ttlMs: 1 }, 2);
  assert.ok(!r.error, "applyCommand alone does not gate: an old consumer applies unconditionally, so a sender must probe `protocol` first");
});

// ---- e. ttlMs and bad values
test("e. ttlMs exceeded: the file is unlinked, the answer is expired, nothing applied; within the TTL it applies", async () => {
  const [id] = seed("one");
  const before = snap();
  drop("e1", { op: "move", id, column: "doing", ttlMs: 1000 }, { ageS: 60 });
  startLoop();
  assert.match(await answer("e1"), /^error: expired: /);
  assert.equal(snap(), before);
  assert.equal(existsSync(join(inbox, "e1.json")), false, "the file is gone");
  assert.match(await send({ op: "move", id, column: "doing", ttlMs: 120000 }, { ageS: 60 }), /^ok: /);
  assert.equal(card(id).column, "doing");
});

test("e. a non-integer, negative, NaN or non-number ifRev/ttlMs is `error: bad …` and changes nothing", async () => {
  const [id] = seed("one");
  const before = snap();
  for (const field of ["ifRev", "ttlMs"]) for (const v of [1.5, -1, null, "NaN", "3", true, [1], {}, 1e999]) {
    const reply = await send({ op: "move", id, column: "doing", [field]: v });
    assert.ok(reply.startsWith(`error: bad ${field}`), `${field}=${JSON.stringify(v)}: ${reply}`);
  }
  assert.equal(snap(), before);
  assert.match(S.protocolFields({ op: "move", id, ifRev: NaN }).error, /^bad ifRev/);
});

test("e. ifRev on an op with no card id is `error: bad ifRev: not supported for <op>`", async () => {
  seed("one");
  for (const op of ["add", "wakes", "next", "start", "protocol", "project-add"]) {
    assert.equal(await send({ op, ifRev: 0 }), `error: bad ifRev: not supported for ${op}`);
  }
});

// ---- f. arrival time
test("f. a pre-existing expired file is dropped when the consumer starts; the age comes from mtime, not from a body time or first sight", async () => {
  const [id] = seed("one");
  const before = snap();
  drop("f1", { op: "move", id, column: "doing", ttlMs: 5000, at: Date.now(), sentAt: Date.now() + 1e9, now: Date.now() }, { ageS: 3600 });
  startLoop();
  assert.match(await answer("f1"), /^error: expired: /);
  assert.equal(snap(), before);
  // Fresh mtime, but a body time from long ago: not expired (a body time is never read).
  assert.match(await send({ op: "move", id, column: "doing", ttlMs: 60000, at: 1, sentAt: 1 }), /^ok: /);
});

test("f. mtime unavailable: the epoch seconds of the file name are the arrival; a file with neither is `no arrival time`", async () => {
  const [id] = seed("one");
  noStat = true;
  const sec = Math.floor(Date.now() / 1000);
  drop(`${sec - 3600}-4242`, { op: "move", id, column: "doing", ttlMs: 5000 });
  startLoop();
  assert.match(await answer(`${sec - 3600}-4242`), /^error: expired: /);
  assert.equal(card(id).column, "todo");
  assert.match(await send0(`${sec}-77`, { op: "move", id, column: "doing", ttlMs: 60000 }), /^ok: /, "a fresh name epoch is within the TTL");
  const noTime = await send0("noarrival", { op: "edit", id, title: "no", ttlMs: 60000 });
  assert.match(noTime, /^error: no arrival time/);
  assert.equal(card(id).title, "one");
  assert.match(await send0("plain", { op: "edit", id, title: "fine" }), /^ok: /, "no ttlMs: no arrival time is needed");
});
const send0 = async (name, cmd) => { drop(name, cmd); startLoop(); return answer(name); };

test("f. ONE batched stat per drain pass for all pending files, as an argv call (never a shell string)", async () => {
  const [id] = seed("one");
  for (const i of [1, 2, 3]) drop(`b${i}`, { op: "note", id, text: `n${i}`, by: "t", ttlMs: 60000 });
  startLoop();
  await results(["b1", "b2", "b3"]);
  const first = statCalls.filter((a) => a[0] === "-c");
  assert.equal(first.length, 1, "one GNU stat call for the whole pass");
  assert.ok(statCalls.length <= 2, "at most one BSD fallback");
  assert.equal(first[0].filter((a) => a.endsWith(".json")).length, 3, "all three paths in that call");
  assert.deepEqual(first[0].slice(0, 2), ["-c", "%Y %n"], "plain argv: a format, then the paths");
});

// ---- g. rejected requests still mark seen and answer once
test("g. a stale, expired or bad request marks its name in inbox-seen and writes its .result once, even with 2 mods racing", async () => {
  const [id] = seed("one");
  const cases = [["g1", { op: "move", id, column: "doing", ifRev: 9 }, {}], ["g2", { op: "move", id, column: "doing", ttlMs: 10 }, { ageS: 100 }], ["g3", { op: "move", id, column: "doing", ifRev: -1 }, {}]];
  for (const [name, cmd, o] of cases) drop(name, cmd, o);
  startTwo();
  const rs = await results(cases.map((c) => c[0]));
  assert.deepEqual(rs.map((r) => r.split(":")[0] + ":" + r.split(":")[1]), ["error: stale", "error: expired", "error: bad ifRev"]);
  await drain();
  for (const [name] of cases) {
    assert.ok(host.state[SEEN].includes(`${name}.json`), `${name} is marked seen`);
    assert.equal(resultWrites.filter((p) => p.endsWith(`${name}.result`)).length, 1, `${name} answered once`);
  }
  assert.equal(card(id).column, "todo");
});

// ---- h. the probe
test("h. op protocol answers `ok: protocol 4` and changes no state", async () => {
  seed("one");
  const before = snap(), proj = JSON.stringify(host.state["drover.projects"] ?? null);
  assert.equal(await send({ op: "protocol" }), "ok: protocol 4");
  assert.equal(snap(), before);
  assert.equal(JSON.stringify(host.state["drover.projects"] ?? null), proj);
});

test("h. the old consumer answered the probe with an error: it reaches applyCommand, which refuses an op with no card id", () => {
  // Old io.js sent every op it did not know to applyCommand(load(), cmd) and replied `error: ${r.error}`.
  // That path is still the fallthrough for unknown ops, so this is the current-code check of the old answer.
  const r = S.applyCommand([], { op: "protocol" });
  assert.equal(`error: ${r.error}`, "error: Unknown drover command");
});

// ---- helpers of the gate (pure)
test("inboxGate: order is bad, then expired, then stale", () => {
  const ts = [{ id: "T-1", rev: 3 }];
  const g = (cmd, arrival, now = 100000) => S.inboxGate(cmd, ts, { arrival, now });
  assert.equal(g({ op: "move", id: "T-1" }, null), null, "no fields: nothing to check");
  assert.match(g({ op: "move", id: "T-1", ifRev: 3, ttlMs: -1 }, 1).error, /^bad ttlMs/);
  assert.match(g({ op: "move", id: "T-1", ifRev: 1, ttlMs: 5 }, 1).error, /^expired: /);
  assert.match(g({ op: "move", id: "T-1", ifRev: 1 }, null).error, /^stale: card T-1 is at rev 3, request saw 1$/);
  assert.equal(g({ op: "move", id: "T-1", ifRev: 3, ttlMs: 99999 }, 1), null);
  assert.equal(g({ op: "move", id: "T-1", ttlMs: 99999 }, 1), null, "age == ttl - 1 is within");
  assert.match(g({ op: "move", id: "T-1", ttlMs: 5 }, null).error, /^no arrival time/);
  assert.equal(g({ op: "move", id: "T-NONE", ifRev: 0 }, null), null, "a missing card is the op's own error, not stale");
});

test("arrival: mtime first, then the name epoch, never anything else", () => {
  assert.equal(S.arrivalOf("x.json", 1700000000), 1700000000000);
  assert.equal(S.arrivalOf("1700000123-99.json", undefined), 1700000123000);
  assert.equal(S.arrivalOf("1700000123-99.json", 5), 5000, "mtime wins over the name");
  assert.equal(S.arrivalOf("r1.json", undefined), null);
  assert.equal(S.arrivalOf("12-x.json", undefined), null, "a short number is not an epoch");
});
