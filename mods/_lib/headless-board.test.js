// A3a headless board writer (T-MWO2HE4FPJK): tests written before the code (red). They fix the API of ./headless-board.js:
//   submit(envelope, { dir, now, hooks }) -> { ok:true, gen, replayed, attempts, result } | { ok:false, code, error }
//   envelope = { nonce, issuedAt, ttlMs, op, ...fields, ifRev? }; error codes: bad-envelope, nonce-reused, expired, stale, refused, unknown-op, busy, board-corrupt
//   hooks, awaited, each called with { step, attempt, target } (target = the generation this attempt wants to create), in the order of one commit attempt:
//     read, tempCreate, write, fsync, beforeLink, (final expiry check, fresh clock), link, afterLink, afterUnlink, dirFsync
//   Board files: <dir>/board.<gen>.json, never deleted or overwritten. No sleeps: waits use until() or real promises (conv/10-testing.md).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as HB from "./headless-board.js";
import { revOf } from "./store.js";

const { until } = await import(new URL("../_test/stubs/until.js", import.meta.url).href);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_URL = pathToFileURL(path.join(HERE, "headless-board.js")).href;

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const cleanup = [];
afterEach(() => { for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hb-")); cleanup.push(d); return d; };

let seq = 0;
const nonce = (tag = "n") => `${tag.replace(/[^A-Za-z0-9]/g, "")}-${String(++seq).padStart(8, "0")}`;
const env = (op, fields = {}, extra = {}) => ({ nonce: nonce(op), issuedAt: NOW, ttlMs: 60000, op, ...fields, ...extra });
const sub = (dir, e, o = {}) => HB.submit(e, { dir, now: () => NOW, ...o });
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const addCard = async (dir, title, fields = {}, o = {}) => ok(await sub(dir, env("add", { title, ...fields }), o));

const genNames = (dir) => fs.readdirSync(dir).map((n) => /^board\.(0|[1-9][0-9]*)\.json$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
const readGen = (dir, g) => JSON.parse(fs.readFileSync(path.join(dir, `board.${g}.json`), "utf8"));
const newest = (dir) => readGen(dir, genNames(dir).at(-1));
const temps = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith(".tmp-"));
const titles = (state) => state.tasks.map((t) => t.title);
const seedBoard = (dir, gen, state) => fs.writeFileSync(path.join(dir, `board.${gen}.json`), JSON.stringify({ schema: 1, gen, writer: "drover-headless", tasks: [], projects: [], agents: { agents: [], squads: [] }, nonces: {}, ...state }));
const cardOf = (dir, title) => newest(dir).tasks.find((t) => t.title === title);

// ---------------------------------------------------------------------------------------------------------- 1. race
test("two writers racing generation N: the loser retries on N+1 and both updates are in the end state", async () => {
  const dir = tmp();
  await addCard(dir, "seed"); // gen 1
  let arrived = 0, go;
  const both = new Promise((r) => { go = r; });
  const hooks = { async read(ctx) { if (ctx.attempt !== 1) return; if (++arrived === 2) go(); await both; } }; // both reads happen before either link
  const [a, b] = await Promise.all([sub(dir, env("add", { title: "A" }), { hooks }), sub(dir, env("add", { title: "B" }), { hooks })]);
  ok(a); ok(b);
  assert.deepEqual([a.gen, b.gen].sort(), [2, 3]);
  assert.deepEqual([a.attempts, b.attempts].sort(), [1, 2]);
  assert.deepEqual(genNames(dir), [1, 2, 3]);
  assert.deepEqual(titles(newest(dir)).sort(), ["A", "B", "seed"]);
  assert.deepEqual(temps(dir), []);
});

// ---------------------------------------------------------------------------------------------------------- 2. paused writer
test("a writer paused between temp and link across 5 commits loses its link (EEXIST), retries, and no acknowledged update is lost", async () => {
  const dir = tmp();
  let paused, release;
  const atLink = new Promise((r) => { paused = r; });
  const gate = new Promise((r) => { release = r; });
  const hooks = { async beforeLink(ctx) { if (ctx.attempt === 1) { paused(ctx.target); await gate; } } };
  const slow = sub(dir, env("add", { title: "slow" }), { hooks });
  assert.equal(await atLink, 1, "the slow writer wants generation 1");
  const acked = [];
  for (let i = 0; i < 5; i++) { const r = await addCard(dir, `other-${i}`); acked.push({ title: `other-${i}`, gen: r.gen }); }
  assert.deepEqual(genNames(dir), [1, 2, 3, 4, 5]);
  const before = [1, 2, 3, 4, 5].map((g) => fs.readFileSync(path.join(dir, `board.${g}.json`), "utf8"));
  release();
  const r = ok(await slow);
  assert.equal(r.gen, 6);
  assert.equal(r.attempts, 2);
  acked.push({ title: "slow", gen: r.gen });
  [1, 2, 3, 4, 5].forEach((g, i) => assert.equal(fs.readFileSync(path.join(dir, `board.${g}.json`), "utf8"), before[i], `generation ${g} was never rewritten`));
  for (const g of genNames(dir)) for (const a of acked) if (a.gen <= g) assert.ok(titles(readGen(dir, g)).includes(a.title), `${a.title} (acked at ${a.gen}) is in generation ${g}`);
  assert.equal(titles(newest(dir)).length, 6);
  assert.deepEqual(temps(dir), []);
});

// ---------------------------------------------------------------------------------------------------------- 3. SIGKILL at each step
const STEPS = ["read", "tempCreate", "write", "fsync", "beforeLink", "afterLink", "afterUnlink", "dirFsync"];
const COMMITTED = new Set(["afterLink", "afterUnlink", "dirFsync"]); // from the link on, the new generation exists
function childScript(dir) {
  const file = path.join(dir, "..", `child-${path.basename(dir)}.mjs`);
  fs.writeFileSync(file, `import * as HB from ${JSON.stringify(LIB_URL)};
const [, , dir, killAt, envJson, nowStr] = process.argv;
const hooks = {};
if (killAt !== "none") hooks[killAt] = async () => { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); };
const r = await HB.submit(JSON.parse(envJson), { dir, now: () => Number(nowStr), hooks });
process.stdout.write(JSON.stringify(r));
`);
  cleanup.push(file);
  return file;
}
const runChild = (file, dir, killAt, envelope) => new Promise((resolve) => {
  const c = spawn(process.execPath, [file, dir, killAt, JSON.stringify(envelope), String(NOW)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => { out += d; });
  c.on("close", (code, signal) => resolve({ code, signal, out }));
});

for (const step of STEPS) {
  test(`SIGKILL at ${step}, then a retry of the same nonce: applied exactly once, board valid`, async () => {
    const dir = tmp();
    await addCard(dir, "seed");
    const e = env("add", { title: `k-${step}` });
    const killed = await runChild(childScript(dir), dir, step, e);
    assert.equal(killed.signal, "SIGKILL", `the child was killed at ${step}: ${killed.out}`);
    const gens = genNames(dir);
    assert.deepEqual(gens, Array.from({ length: gens.length }, (_, i) => i + 1), "no gap, nothing but board.<gen>.json generations");
    for (const g of gens) assert.equal(readGen(dir, g).schema, 1, `generation ${g} parses`);
    assert.ok(titles(newest(dir)).includes("seed"), "the acknowledged seed is still there");
    assert.equal(titles(newest(dir)).includes(`k-${step}`), COMMITTED.has(step), "the killed op is in the board iff its link had happened");
    const retry = ok(await sub(dir, e));
    assert.equal(retry.replayed, COMMITTED.has(step), "a kill before the link is applied by the retry; after it the stored result answers");
    assert.equal(titles(newest(dir)).filter((t) => t === `k-${step}`).length, 1, "exactly one card");
    assert.ok(retry.result?.id);
    assert.equal(newest(dir).tasks.find((t) => t.title === `k-${step}`).id, retry.result.id);
    ok(await sub(dir, e)); // and once more: still one card
    assert.equal(titles(newest(dir)).filter((t) => t === `k-${step}`).length, 1);
  });
}

// ---------------------------------------------------------------------------------------------------------- 4. nonce
test("a nonce reused with another payload is refused; the same payload answers the stored result and commits nothing", async () => {
  const dir = tmp();
  const e = env("add", { title: "X" });
  const r1 = ok(await sub(dir, e));
  const gens = genNames(dir);
  const again = ok(await sub(dir, e));
  assert.equal(again.replayed, true);
  assert.deepEqual(again.result, r1.result);
  assert.equal(again.gen, r1.gen);
  const reordered = ok(await sub(dir, Object.fromEntries(Object.entries(e).reverse())));
  assert.equal(reordered.replayed, true, "key order does not change the fingerprint");
  const other = await sub(dir, { ...e, title: "Y" });
  assert.equal(other.ok, false);
  assert.equal(other.code, "nonce-reused");
  const otherTtl = await sub(dir, { ...e, ttlMs: 61000 });
  assert.equal(otherTtl.code, "nonce-reused", "the whole envelope is fingerprinted, ttl included");
  assert.deepEqual(genNames(dir), gens);
  assert.deepEqual(titles(newest(dir)), ["X"]);
});

test("a malformed envelope is refused as bad-envelope and commits nothing", async () => {
  const dir = tmp();
  const bad = [
    env("add", { title: "t" }, { nonce: "short" }),
    env("add", { title: "t" }, { nonce: "has space in it" }),
    env("add", { title: "t" }, { nonce: "x".repeat(129) }),
    env("add", { title: "t" }, { issuedAt: NOW + 0.5 }),
    env("add", { title: "t" }, { issuedAt: "now" }),
    env("add", { title: "t" }, { ttlMs: 0 }),
    env("add", { title: "t" }, { ttlMs: 600001 }),
    env("add", { title: "t" }, { ttlMs: 1.5 }),
    (() => { const e = env("add", { title: "t" }); delete e.ttlMs; return e; })(),
    (() => { const e = env("add", { title: "t" }); delete e.nonce; return e; })(),
  ];
  for (const e of bad) { const r = await sub(dir, e); assert.equal(r.ok, false); assert.equal(r.code, "bad-envelope", JSON.stringify(e)); }
  ok(await sub(dir, env("add", { title: "t" }, { ttlMs: 600000 })));
  assert.deepEqual(genNames(dir), [1], "only the valid one committed");
});

// ---------------------------------------------------------------------------------------------------------- 5. expiry
test("expiry: exactly ttl is fine, ttl+1 is refused; an issuedAt more than 30 s ahead is refused; a refusal leaves no nonce", async () => {
  const dir = tmp();
  const ttl = 5000;
  const at = (e, t) => sub(dir, e, { now: () => t });
  ok(await at(env("add", { title: "edge" }, { ttlMs: ttl }), NOW + ttl));
  const late = env("add", { title: "late" }, { ttlMs: ttl });
  const r = await at(late, NOW + ttl + 1);
  assert.equal(r.ok, false);
  assert.equal(r.code, "expired");
  assert.deepEqual(genNames(dir), [1]);
  ok(await at(env("add", { title: "ahead-ok" }, { issuedAt: NOW + 30000 }), NOW));
  const ahead = await at(env("add", { title: "ahead-bad" }, { issuedAt: NOW + 30001 }), NOW);
  assert.equal(ahead.code, "expired");
  assert.ok(!(late.nonce in newest(dir).nonces), "a refusal leaves no nonce record");
  const retried = ok(await at(late, NOW + 1)); // judged again, and now in time
  assert.equal(retried.replayed, false);
});

test("REVIEW 1: the clock moves past the ttl after the temp is written and before the link: refused expired, no generation, no temp", async () => {
  const dir = tmp();
  await addCard(dir, "seed");
  let t = NOW;
  let paused, release;
  const atLink = new Promise((r) => { paused = r; });
  const gate = new Promise((r) => { release = r; });
  const hooks = { async beforeLink(ctx) { if (ctx.attempt === 1) { paused(); await gate; } } };
  const p = HB.submit(env("add", { title: "slowpoke" }, { ttlMs: 1000 }), { dir, now: () => t, hooks });
  await atLink; // N+1 is still free: nobody else committed
  t = NOW + 5000; // the final expiry check reads the clock again after the hook returns
  release();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, "expired");
  assert.deepEqual(genNames(dir), [1], "no new generation file");
  assert.deepEqual(temps(dir), [], "the temp is unlinked");
  assert.ok(!titles(newest(dir)).includes("slowpoke"));
});

// ---------------------------------------------------------------------------------------------------------- 6. retention of nonces
test("REVIEW 3: replay at exactly 24 h still answers the stored result; at 24 h + 1 ms it is refused expired (idle board)", async () => {
  const dir = tmp();
  const e = env("add", { title: "old" });
  const r1 = ok(await sub(dir, e));
  const at = (x, t) => sub(dir, x, { now: () => t });
  const edge = ok(await at(e, NOW + DAY));
  assert.equal(edge.replayed, true);
  assert.deepEqual(edge.result, r1.result);
  const gens = genNames(dir);
  const aged = await at(e, NOW + DAY + 1);
  assert.equal(aged.ok, false);
  assert.equal(aged.code, "expired");
  assert.ok(e.nonce in newest(dir).nonces, "idle board: the record is still in the file, it is just not honoured");
  assert.deepEqual(genNames(dir), gens);
  assert.equal(titles(newest(dir)).filter((x) => x === "old").length, 1, "never applied twice");
});

test("REVIEW 3: after a write has pruned the aged record, the old op is still refused expired, also with another payload", async () => {
  const dir = tmp();
  const e = env("add", { title: "old" });
  ok(await sub(dir, e));
  const later = NOW + DAY + 1;
  const at = (x) => sub(dir, x, { now: () => later });
  const fresh = env("add", { title: "fresh" }, { issuedAt: later });
  ok(await at(fresh));
  const nonces = newest(dir).nonces;
  assert.ok(!(e.nonce in nonces), "the aged record is pruned in the same generation");
  assert.ok(fresh.nonce in nonces);
  const gens = genNames(dir);
  const r = await at(e);
  assert.equal(r.code, "expired");
  const other = await at({ ...e, title: "different" });
  assert.equal(other.code, "expired", "an aged nonce with another payload is expired, not nonce-reused");
  assert.deepEqual(genNames(dir), gens);
  assert.deepEqual(titles(newest(dir)).sort(), ["fresh", "old"]);
});

// ---------------------------------------------------------------------------------------------------------- 7. ifRev and invalid ops
test("a stale ifRev is refused and commits nothing; the current rev is accepted", async () => {
  const dir = tmp();
  const id = (await addCard(dir, "card")).result.id;
  ok(await sub(dir, env("note", { id, text: "one", by: "me" })));
  assert.equal(revOf(cardOf(dir, "card")), 1);
  const gens = genNames(dir);
  const stale = await sub(dir, env("edit", { id, title: "renamed" }, { ifRev: 0 }));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale");
  assert.match(stale.error, /^stale: card .* is at rev 1, request saw 0/);
  assert.deepEqual(genNames(dir), gens);
  ok(await sub(dir, env("edit", { id, title: "renamed" }, { ifRev: 1 })));
  assert.ok(cardOf(dir, "renamed"));
  const badRev = await sub(dir, env("edit", { id, title: "x" }, { ifRev: -1 }));
  assert.equal(badRev.ok, false);
  assert.match(badRev.error, /bad ifRev/);
});

test("invalid ops are refused with the inbox's errors and commit nothing", async () => {
  const dir = tmp();
  const id = (await addCard(dir, "card")).result.id;
  const cases = [
    ["unknown note kind", env("note", { id, text: "x", kind: "bogus" }), /Unknown note kind bogus: use decision, log, blocker, pr, handoff, review/],
    ["bad priority", env("add", { title: "t", priority: "P9" }), /Bad priority P9: use P0, P1, P2, P3/],
    ["unknown column", env("move", { id, column: "nowhere" }), /Unknown column nowhere \(use /],
    ["bad parent", env("add", { title: "t", parent: "T-NOPE" }), /Parent T-NOPE not found/],
    ["empty note", env("note", { id, text: "   " }), /Note is empty/],
    ["unknown op", env("frobnicate", { id }), /Unknown drover command/],
    ["done by an agent", env("move", { id, column: "done", from: "agent-terminal" }), /Only the owner moves a card to done/],
    ["no such card", env("note", { id: "T-NOPE", text: "x" }), /Task T-NOPE not found/],
    ["no such project", env("add", { title: "t", project: "no-such-project" }), /no project no-such-project/],
  ];
  const gens = genNames(dir);
  for (const [label, e, re] of cases) {
    const r = await sub(dir, e);
    assert.equal(r.ok, false, label);
    assert.match(r.error, re, label);
    assert.ok(["refused", "unknown-op"].includes(r.code), `${label}: ${r.code}`);
    assert.ok(!(e.nonce in newest(dir).nonces), `${label}: a refusal leaves no nonce`);
  }
  assert.deepEqual(genNames(dir), gens, "nothing committed");
  ok(await sub(dir, env("move", { id, column: "done" })), "no `from` = the owner's own CLI: allowed");
});

test("a corrupt newest generation is a fixed error, never a silent fallback to the one before", async () => {
  const dir = tmp();
  await addCard(dir, "seed");
  fs.writeFileSync(path.join(dir, "board.2.json"), "{not json");
  const r = await sub(dir, env("add", { title: "x" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "board-corrupt");
  assert.deepEqual(genNames(dir), [1, 2]);
});

// ---------------------------------------------------------------------------------------------------------- 8. move-out
test("REVIEW 2: moveOutGate (the one helper; it borrows the archive rev rule, store.js REV_OPS is untouched): matching, stale and missing ifRev", () => {
  const tasks = [{ id: "T-A", rev: 3 }];
  assert.equal(HB.moveOutGate({ op: "move-out", id: "T-A", ifRev: 3 }, tasks), null);
  const stale = HB.moveOutGate({ op: "move-out", id: "T-A", ifRev: 2 }, tasks);
  assert.match(stale.error, /^stale: card T-A is at rev 3, request saw 2/);
  assert.match(HB.moveOutGate({ op: "move-out", id: "T-A" }, tasks).error, /ifRev/);
  assert.match(HB.moveOutGate({ op: "move-out", id: "T-A", ifRev: "3" }, tasks).error, /bad ifRev/);
});

test("move-out: matching ifRev archives and stamps movedOut in one commit and answers the card with its notes; stale and missing ifRev are refused", async () => {
  const dir = tmp();
  const id = (await addCard(dir, "leaver")).result.id;
  ok(await sub(dir, env("note", { id, text: "keep me", kind: "log", by: "me" })));
  const rev = revOf(cardOf(dir, "leaver"));
  const gens = genNames(dir);
  const stale = await sub(dir, env("move-out", { id }, { ifRev: rev - 1 }));
  assert.equal(stale.code, "stale");
  const missing = await sub(dir, env("move-out", { id }));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ifRev/);
  assert.equal((await sub(dir, env("move-out", { id: "T-NOPE" }, { ifRev: 0 }))).ok, false);
  assert.deepEqual(genNames(dir), gens, "refusals commit nothing");
  const r = ok(await sub(dir, env("move-out", { id }, { ifRev: rev })));
  assert.equal(r.gen, gens.at(-1) + 1, "one commit");
  assert.equal(r.result.task.id, id);
  assert.equal(r.result.task.notes.length, 1);
  assert.equal(r.result.task.notes[0].text, "keep me");
  const stored = newest(dir).tasks.find((t) => t.id === id);
  assert.equal(stored.archived, true);
  assert.equal(stored.movedOut, true);
  const again = await sub(dir, env("move-out", { id }, { ifRev: revOf(stored) }));
  assert.equal(again.ok, false, "an archived card is not moved out again");
});

test("move-out refuses a card in Doing with an agent attached", async () => {
  const dir = tmp();
  seedBoard(dir, 1, { tasks: [{ id: "T-BUSY", title: "busy", column: "doing", agent: "t5", archived: false, notes: [], rev: 2 }] });
  const r = await sub(dir, env("move-out", { id: "T-BUSY" }, { ifRev: 2 }));
  assert.equal(r.ok, false);
  assert.equal(newest(dir).tasks[0].archived, false);
});

// ---------------------------------------------------------------------------------------------------------- 9. orphan sweep
test("orphan sweep removes an old temp, keeps a young one, and never touches a board.<gen>.json", async () => {
  const dir = tmp();
  seedBoard(dir, 1, {});
  seedBoard(dir, 2, {});
  const put = (name, ageMs) => { const f = path.join(dir, name); fs.writeFileSync(f, "x"); const t = (NOW - ageMs) / 1000; fs.utimesSync(f, t, t); };
  put(".tmp-123-abc", 2 * 3600000);
  put(".tmp-124-abd", 60000);
  put("board.1.json", 30 * DAY); // old, and still never swept
  put("board.2.json", 30 * DAY);
  put(".tmp-9-zz.json", 5 * DAY); // looks like a temp, is not one (suffix): kept
  put("board.9.json.tmp-1-a", 5 * DAY); // not a temp name: kept
  put("notes.txt", 5 * DAY);
  const r = HB.sweepOrphans(dir, { now: () => NOW });
  assert.deepEqual((await r).removed, [".tmp-123-abc"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [".tmp-124-abd", ".tmp-9-zz.json", "board.1.json", "board.2.json", "board.9.json.tmp-1-a", "notes.txt"]);
});

test("a commit sweeps old orphan temps opportunistically and still leaves young temps and every generation alone", async () => {
  const dir = tmp();
  await addCard(dir, "seed");
  const put = (name, ageMs) => { const f = path.join(dir, name); fs.writeFileSync(f, "x"); const t = (NOW - ageMs) / 1000; fs.utimesSync(f, t, t); };
  put(".tmp-5-old", 3 * 3600000);
  put(".tmp-6-young", 1000);
  await addCard(dir, "next");
  assert.deepEqual(temps(dir), [".tmp-6-young"]);
  assert.deepEqual(genNames(dir), [1, 2]);
});

// ---------------------------------------------------------------------------------------------------------- 10. import and migrate-in
test("import is idempotent by movedFrom across two nonces and carries the notes", async () => {
  const dir = tmp();
  const task = { title: "from elsewhere", desc: "body", tags: ["a", "b"], priority: "P1", column: "todo", created: NOW - 5000,
    notes: [{ id: "n1", at: NOW - 4000, by: "alice", text: "first", kind: "decision" }, { id: "n1", at: NOW - 3000, by: "bob", text: "second" }] };
  const r1 = ok(await sub(dir, env("import", { movedFrom: "src-card-1", task })));
  assert.equal(r1.result.already, undefined);
  const gens = genNames(dir);
  const r2 = ok(await sub(dir, env("import", { movedFrom: "src-card-1", task })));
  assert.equal(r2.result.already, true);
  assert.equal(r2.result.id, r1.result.id);
  assert.equal(genNames(dir).length, gens.length + 1, "the already-answer records its nonce in a nonce-only generation (REVIEW-1 F3)");
  assert.deepEqual(titles(readGen(dir, gens.at(-1))), titles(newest(dir)), "and changes no card");
  const cards = newest(dir).tasks;
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.movedFrom, "src-card-1");
  assert.equal(c.title, "from elsewhere");
  assert.deepEqual(c.notes.map((n) => [n.by, n.text, n.kind ?? null, n.at]), [["alice", "first", "decision", NOW - 4000], ["bob", "second", null, NOW - 3000]]);
  assert.equal(new Set(c.notes.map((n) => n.id)).size, 2, "note ids are regenerated and unique");
  const other = ok(await sub(dir, env("import", { movedFrom: "src-card-2", task: { ...task, title: "second card", notes: [] } })));
  assert.notEqual(other.result.id, r1.result.id);
  assert.equal(newest(dir).tasks.length, 2);
  const noProject = await sub(dir, env("import", { movedFrom: "src-card-3", task: { ...task, project: "P-NOPE" } }));
  assert.equal(noProject.ok, false, "a project that is not on the board is refused");
  const badFrom = await sub(dir, env("import", { movedFrom: "", task }));
  assert.equal(badFrom.ok, false);
});

test("import refuses a malformed review note and keeps a valid one", async () => {
  const dir = tmp();
  const base = { title: "has a review", column: "review", created: NOW - 5000 };
  const bad = await sub(dir, env("import", { movedFrom: "src-rv-1", task: { ...base, notes: [{ at: NOW - 4000, by: "inspector", text: "all good", kind: "review" }] } }));
  assert.equal(bad.ok, false);
  assert.match(String(bad.error ?? ""), /review note/i);
  const text = `head=${"d".repeat(40)} verdict=pass report=/r/review.md`;
  const good = ok(await sub(dir, env("import", { movedFrom: "src-rv-2", task: { ...base, notes: [{ at: NOW - 4000, by: "inspector", text, kind: "review" }] } })));
  assert.ok(good.result.id);
  assert.equal(newest(dir).tasks[0].notes[0].kind, "review");
});

const SECRET_A = "sk" + "-live-" + "0123456789abcdef";
const SECRET_B = "ghp" + "_" + "ZyXwVuTsRqPoNmLkJiHg";
const oldShared = () => ({
  "drover.tasks": [
    { id: "T-ONE", title: "one", column: "todo", priority: "P2", tags: [], archived: false, agent: null, notes: [], source: null, created: 1, updated: 1, rev: 2, claimToken: "claim" + "-" + "abc123" },
    { id: "T-TWO", title: "two", column: "backlog", priority: "P3", tags: ["x"], archived: false, agent: null, notes: [{ id: "n1", at: 1, by: "me", text: "hi" }], source: null, created: 1, updated: 1 },
  ],
  "drover.projects": [{ id: "P-ONE", name: "Proj one", repos: [{ path: "/some/repo", default: true }], folders: [], branch: "main", created: 1 }],
  "drover.agents": {
    agents: [{ id: "a1", name: "Agent one", command: "run --key " + SECRET_A, env: { API_TOKEN: SECRET_B }, soul: "secret soul" }],
    squads: [{ id: "s1", name: "Squad one", leader: "a1", members: [{ agent: "a1", role: "x" }] }],
  },
  "drover.config": { ghToken: SECRET_B },
  "drover.layout": { secretLayout: SECRET_A },
  "drover.wakeups": [{ id: "W-1", text: SECRET_A }],
});
const writeShared = (dir, doc = oldShared()) => { const f = path.join(dir, "..", `old-shared-${path.basename(dir)}.json`); fs.writeFileSync(f, JSON.stringify(doc)); cleanup.push(f); return f; };

test("migrate-in copies ids and names only: secret-looking keys never reach the board; the marker is written last", async () => {
  const dir = tmp();
  const from = writeShared(dir);
  const r = await HB.migrateIn(dir, from, { now: () => NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.copied, { tasks: 2, projects: 1, agents: 1, squads: 1 });
  assert.deepEqual(r.skipped, { tasks: 0, projects: 0, agents: 0, squads: 0 });
  for (const g of genNames(dir)) {
    const text = fs.readFileSync(path.join(dir, `board.${g}.json`), "utf8");
    for (const s of [SECRET_A, SECRET_B, "claimToken", "secret soul", "API_TOKEN", "ghToken", "secretLayout"]) assert.ok(!text.includes(s), `generation ${g} has no ${s}`);
  }
  const end = newest(dir);
  assert.deepEqual(end.agents, { agents: [{ id: "a1", name: "Agent one" }], squads: [{ id: "s1", name: "Squad one" }] });
  assert.deepEqual(end.tasks.map((t) => t.id).sort(), ["T-ONE", "T-TWO"]);
  assert.deepEqual(end.projects.map((p) => p.id), ["P-ONE"]);
  assert.ok(end.migrated && Number.isFinite(end.migrated.at), "the marker is there");
  assert.deepEqual(Object.keys(end).sort(), ["agents", "gen", "migrated", "nonces", "projects", "schema", "tasks", "writer"]);
  const gens = genNames(dir);
  const first = gens.find((g) => readGen(dir, g).tasks.length === 2);
  assert.ok(readGen(dir, first).migrated === undefined, "the generation that first holds the cards has no marker");
  assert.equal(gens.at(-1) > first, true, "the marker commit is after the copy");
});

test("migrate-in is repeatable: a rerun copies only missing ids, never overwrites an edited card, and counts copied vs skipped", async () => {
  const dir = tmp();
  const from = writeShared(dir);
  await HB.migrateIn(dir, from, { now: () => NOW });
  ok(await sub(dir, env("edit", { id: "T-ONE", title: "edited here" })));
  const doc = oldShared();
  doc["drover.tasks"].push({ id: "T-NEW", title: "new one", column: "todo", priority: "P2", tags: [], archived: false, agent: null, notes: [], source: null, created: 1, updated: 1 });
  const from2 = writeShared(tmp(), doc);
  const r = await HB.migrateIn(dir, from2, { now: () => NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.copied, { tasks: 1, projects: 0, agents: 0, squads: 0 });
  assert.deepEqual(r.skipped, { tasks: 2, projects: 1, agents: 1, squads: 1 });
  assert.equal(cardOf(dir, "edited here").id, "T-ONE", "an existing id is never overwritten");
  assert.equal(newest(dir).tasks.length, 3);
  assert.ok(newest(dir).migrated);
});

test("migrate-in: an ordinary edit landing between the copy commit and the marker commit survives (the marker patches the newest state)", async () => {
  const dir = tmp();
  const from = writeShared(dir);
  const hooks = { async betweenCommits() { ok(await sub(dir, env("edit", { id: "T-ONE", title: "edited in between" }))); } };
  const r = await HB.migrateIn(dir, from, { now: () => NOW, hooks });
  assert.equal(r.ok, true, JSON.stringify(r));
  const end = newest(dir);
  assert.ok(end.migrated);
  assert.equal(end.tasks.find((t) => t.id === "T-ONE").title, "edited in between");
  assert.equal(end.tasks.length, 2);
});

test("migrate-in killed between the two commits, an edit lands, the rerun completes: marker present, the edit survives", async () => {
  const dir = tmp();
  const from = writeShared(dir);
  const file = path.join(dir, "..", `migrate-child-${path.basename(dir)}.mjs`);
  fs.writeFileSync(file, `import * as HB from ${JSON.stringify(LIB_URL)};
const [, , dir, from, nowStr] = process.argv;
const hooks = { betweenCommits: async () => { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); } };
await HB.migrateIn(dir, from, { now: () => Number(nowStr), hooks });
`);
  cleanup.push(file);
  const killed = await new Promise((resolve) => { const c = spawn(process.execPath, [file, dir, from, String(NOW)], { stdio: "ignore" }); c.on("close", (code, signal) => resolve(signal)); });
  assert.equal(killed, "SIGKILL");
  assert.equal(newest(dir).migrated, undefined, "killed before the marker");
  assert.equal(newest(dir).tasks.length, 2, "the copy commit is whole");
  ok(await sub(dir, env("edit", { id: "T-TWO", title: "edited after the kill" })));
  const r = await HB.migrateIn(dir, from, { now: () => NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.copied, { tasks: 0, projects: 0, agents: 0, squads: 0 });
  assert.ok(newest(dir).migrated, "the rerun wrote the marker");
  assert.equal(newest(dir).tasks.find((t) => t.id === "T-TWO").title, "edited after the kill");
});

test("migrate-in refuses a missing or invalid source and writes nothing", async () => {
  const dir = tmp();
  const missing = await HB.migrateIn(dir, path.join(dir, "nope.json"), { now: () => NOW });
  assert.equal(missing.ok, false);
  const junk = path.join(dir, "junk.json"); fs.writeFileSync(junk, "{nope");
  const bad = await HB.migrateIn(dir, junk, { now: () => NOW });
  assert.equal(bad.ok, false);
  assert.deepEqual(genNames(dir), []);
});

// ---------------------------------------------------------------------------------------------------------- 11. read verbs and project add
test("read verbs: version lists exactly the ops the dispatcher accepts; rev changes iff the tasks change; tasks and projects read the newest generation", async () => {
  const dir = tmp();
  const v = HB.versionInfo();
  assert.equal(v.cli, "drover-headless");
  assert.equal(v.schema, 1);
  assert.deepEqual([...v.ops].sort(), ["add", "archive", "edit", "import", "move", "move-out", "note", "project-add"]);
  for (const op of v.ops) { const r = await sub(dir, env(op, {})); assert.notEqual(r.code, "unknown-op", `${op} is a known op`); }
  assert.equal((await sub(dir, env("frobnicate", { id: "T-X" }))).code, "unknown-op");
  const r0 = await HB.revInfo(dir);
  assert.equal(r0.gen, 0);
  assert.deepEqual(await HB.tasksInfo(dir), { gen: 0, rev: r0.tasks, tasks: [] });
  const id = (await addCard(dir, "card")).result.id;
  const r1 = await HB.revInfo(dir);
  assert.notEqual(r1.tasks, r0.tasks);
  assert.ok(r1.gen >= 1 && r1.bytes > 0);
  const p = ok(await sub(dir, env("project-add", { name: "Alpha", repo: "/some/repo" })));
  assert.equal(p.result.name, "Alpha");
  assert.equal(p.result.branch, "main", "no git is probed: main by default");
  const r2 = await HB.revInfo(dir);
  assert.equal(r2.tasks, r1.tasks, "a project change does not move the tasks rev");
  assert.ok(r2.gen > r1.gen);
  ok(await sub(dir, env("note", { id, text: "n" })));
  assert.notEqual((await HB.revInfo(dir)).tasks, r1.tasks);
  const t = await HB.tasksInfo(dir);
  assert.equal(t.tasks.length, 1);
  assert.equal(t.rev, (await HB.revInfo(dir)).tasks);
  assert.deepEqual((await HB.projectsInfo(dir)).projects.map((x) => x.name), ["Alpha"]);
  const dup = await sub(dir, env("project-add", { name: "alpha", repo: "/some/repo" }));
  assert.equal(dup.ok, false);
  assert.match(dup.error, /A project named alpha exists/);
  const noOrg = await sub(dir, env("project-add", { name: "Beta", repo: "/r", org: "x" }));
  assert.match(noOrg.error, /org is not accepted here/);
});

test("add resolves a project by name and checks assignees against the board's own agents", async () => {
  const dir = tmp();
  seedBoard(dir, 1, { projects: [{ id: "P-ONE", name: "Proj one", repos: [], folders: [], branch: "main", created: 1 }], agents: { agents: [{ id: "a1", name: "Agent one" }], squads: [] } });
  const c = ok(await sub(dir, env("add", { title: "in project", project: "proj one", assignee: { kind: "agent", id: "a1" } })));
  assert.equal(newest(dir).tasks.find((t) => t.id === c.result.id).project, "P-ONE");
  const bad = await sub(dir, env("add", { title: "x", assignee: { kind: "agent", id: "ghost" } }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown agent ghost/);
});

test("a board file never holds layout, runs, wakeups or config keys", async () => {
  const dir = tmp();
  await addCard(dir, "x");
  assert.deepEqual(Object.keys(newest(dir)).sort(), ["agents", "gen", "nonces", "projects", "schema", "tasks", "writer"]);
});

// ---------------------------------------------------------------------------------------------------------- review 1, finding 2: project ownership
const foreignShared = () => ({
  "drover.tasks": [
    { id: "T-OLD", title: "retained", column: "todo", priority: "P2", tags: [], archived: false, agent: null, notes: [], source: null, project: "P-FOREIGN", created: 1, updated: 1, rev: 1 },
    { id: "T-MINE", title: "mine", column: "todo", priority: "P2", tags: [], archived: false, agent: null, notes: [], source: null, project: "P-LOCAL", created: 1, updated: 1, rev: 1 },
  ],
  "drover.projects": [
    { id: "P-FOREIGN", name: "Foreign", repos: [], folders: [], branch: "main", created: 1, remote: { machine: "other-machine", projectId: "P-ELSEWHERE" } },
    { id: "P-LOCAL", name: "Local one", repos: [], folders: [], branch: "main", created: 1 },
  ],
});
test("REVIEW-1 F2: a project that lives on another machine is read-only: every card mutation touching it (source or destination) is refused and commits nothing", async () => {
  const dir = tmp();
  const m = await HB.migrateIn(dir, writeShared(dir, foreignShared()), { now: () => NOW });
  assert.equal(m.ok, true, JSON.stringify(m));
  const gens = genNames(dir);
  const refused = [
    ["add into it by id", env("add", { title: "x", project: "P-FOREIGN" })],
    ["add into it by name", env("add", { title: "x", project: "foreign" })],
    ["edit a retained card", env("edit", { id: "T-OLD", title: "changed" })],
    ["note on a retained card", env("note", { id: "T-OLD", text: "n" })],
    ["move a retained card", env("move", { id: "T-OLD", column: "review" })],
    ["archive a retained card", env("archive", { id: "T-OLD" })],
    ["edit a local card into it (destination)", env("edit", { id: "T-MINE", project: "P-FOREIGN" })],
    ["import into it", env("import", { movedFrom: "m-1", task: { title: "i", project: "P-FOREIGN" } })],
    ["move-out a retained card", env("move-out", { id: "T-OLD" }, { ifRev: 1 })],
  ];
  for (const [label, e] of refused) {
    const r = await sub(dir, e);
    assert.equal(r.ok, false, label);
    assert.match(r.error, /Project Foreign lives on other-machine/, label);
    assert.deepEqual(genNames(dir), gens, `${label}: nothing committed`);
  }
  ok(await sub(dir, env("add", { title: "fine", project: "P-LOCAL" })));
  ok(await sub(dir, env("edit", { id: "T-MINE", title: "mine, renamed" })));
  ok(await sub(dir, env("edit", { id: "T-MINE", project: "none" })));
});

test("REVIEW-1 F2: ownershipError is one pure check: every card the result adds or changes is checked against its stored and its new project", () => {
  const projects = [{ id: "P-F", name: "F", remote: { machine: "elsewhere", projectId: "P-X" } }, { id: "P-L", name: "L" }];
  const before = [{ id: "A", project: "P-F" }, { id: "B", project: "P-L" }];
  assert.equal(HB.ownershipError(projects, before, before), null, "nothing changed");
  assert.match(HB.ownershipError(projects, before, [{ id: "A", project: "P-F", title: "t" }, before[1]]), /lives on elsewhere/, "stored project");
  assert.match(HB.ownershipError(projects, before, [before[0], { id: "B", project: "P-F" }]), /lives on elsewhere/, "new project");
  assert.match(HB.ownershipError(projects, before, [...before, { id: "C", project: "P-F" }]), /lives on elsewhere/, "a new card");
  assert.equal(HB.ownershipError(projects, before, [...before, { id: "C", project: "P-L" }]), null);
});

// ---------------------------------------------------------------------------------------------------------- review 1, finding 3
test("REVIEW-1 F3: an already-imported answer reserves its nonce: the nonce cannot be reused for another payload, and its own retry replays", async () => {
  const dir = tmp();
  const task = { title: "once", desc: "", tags: [], priority: "P2", column: "backlog", notes: [] };
  ok(await sub(dir, env("import", { movedFrom: "same-src", task })));
  const second = env("import", { movedFrom: "same-src", task });
  const a = ok(await sub(dir, second));
  assert.equal(a.result.already, true);
  const gens = genNames(dir);
  assert.ok(second.nonce in newest(dir).nonces, "the nonce is recorded");
  const reuse = await sub(dir, env("add", { title: "other payload" }, { nonce: second.nonce }));
  assert.equal(reuse.ok, false);
  assert.equal(reuse.code, "nonce-reused");
  assert.deepEqual(genNames(dir), gens);
  assert.equal(newest(dir).tasks.length, 1);
  const again = ok(await sub(dir, second));
  assert.equal(again.replayed, true);
  assert.equal(again.result.already, true);
});

// ---------------------------------------------------------------------------------------------------------- review 1, finding 4: syncs
// `io` is the fault-injection seam: { fsyncFile(fileHandle), fsyncDir(dir) } replace the real calls (the real ones are the default).
const real = {
  fsyncFile: (fh) => fh.sync(),
  fsyncDir: async (d) => { const fh = await fs.promises.open(d, "r"); try { await fh.sync(); } finally { await fh.close(); } },
};
const sysErr = (code) => Object.assign(new Error(`${code} injected`), { code });

test("REVIEW-1 F4: the file is synced before the link and the directory after it, before the acknowledgement (removing either call fails this)", async () => {
  const dir = tmp();
  const events = [];
  const hooks = Object.fromEntries(["read", "tempCreate", "write", "fsync", "beforeLink", "afterLink", "afterUnlink", "dirFsync"].map((s) => [s, () => { events.push(`hook:${s}`); }]));
  const io = { fsyncFile: async (fh) => { events.push("io:fsyncFile"); return real.fsyncFile(fh); }, fsyncDir: async (d) => { events.push("io:fsyncDir"); return real.fsyncDir(d); } };
  await sub(dir, env("add", { title: "ordered" }), { hooks, io }).then(ok);
  events.push("ack");
  const at = (e) => events.indexOf(e);
  assert.ok(at("io:fsyncFile") > at("hook:write") && at("io:fsyncFile") < at("hook:beforeLink"), events.join(" "));
  assert.ok(at("io:fsyncDir") > at("hook:afterUnlink") && at("io:fsyncDir") < at("ack"), events.join(" "));
  assert.equal(events.filter((e) => e === "io:fsyncFile").length, 1);
  assert.equal(events.filter((e) => e === "io:fsyncDir").length, 1);
});

for (const code of ["EPERM", "EIO", "EINVAL", "ENOTSUP"]) {
  test(`REVIEW-1 F4: a directory sync failing with ${code} is E_SYNC, never an acknowledgement; the retry crosses the directory barrier again before it answers`, async () => {
    const dir = tmp();
    let dirCalls = 0, failing = true;
    const io = { fsyncDir: async (d) => { dirCalls++; if (failing) throw sysErr(code); return real.fsyncDir(d); } };
    const e = env("add", { title: "synced" });
    const first = await sub(dir, e, { io });
    assert.equal(first.ok, false);
    assert.equal(first.code, "E_SYNC");
    assert.equal(dirCalls, 1);
    const stillFailing = await sub(dir, e, { io }); // the generation is linked, so this is a replay: it must still sync the directory, and fail with it
    assert.equal(stillFailing.ok, false, "a replay is not acknowledged while the directory cannot be synced");
    assert.equal(stillFailing.code, "E_SYNC");
    assert.equal(dirCalls, 2, "the replay crossed the directory barrier");
    failing = false;
    const healed = ok(await sub(dir, e, { io }));
    assert.equal(healed.replayed, true);
    assert.equal(dirCalls, 3);
    assert.equal(titles(newest(dir)).filter((t) => t === "synced").length, 1);
  });
}

test("REVIEW-1 F4: a file sync failing is E_SYNC: nothing is linked, no temp is left", async () => {
  const dir = tmp();
  await addCard(dir, "seed");
  const io = { fsyncFile: async () => { throw sysErr("EIO"); } };
  const r = await sub(dir, env("add", { title: "never" }), { io });
  assert.equal(r.ok, false);
  assert.equal(r.code, "E_SYNC");
  assert.deepEqual(genNames(dir), [1]);
  assert.deepEqual(temps(dir), []);
});

test("REVIEW-1 F4: a plain replay (nothing new to write) syncs the directory before it answers", async () => {
  const dir = tmp();
  const e = env("add", { title: "r" });
  ok(await sub(dir, e));
  let calls = 0;
  const io = { fsyncDir: async (d) => { calls++; return real.fsyncDir(d); } };
  assert.equal(ok(await sub(dir, e, { io })).replayed, true);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------------------------------------- review 2, F-b: the REAL default syncs
// No `io` override: the actual FileHandle.sync calls are observed (which file or directory, in which order relative to the hooks).
async function withSyncSpy(fn) {
  const events = [];
  const origOpen = fs.promises.open;
  const names = new Map();
  fs.promises.open = async function (p, ...rest) {
    const fh = await origOpen.call(this, p, ...rest);
    names.set(fh, String(p));
    if (!fh.__spied) {
      const sync = fh.sync.bind(fh);
      Object.defineProperty(fh, "__spied", { value: true });
      fh.sync = async () => { events.push(`sync:${names.get(fh)}`); return sync(); };
    }
    return fh;
  };
  try { await fn(events); } finally { fs.promises.open = origOpen; }
  return events;
}

test("REVIEW-2 F-b: with the default io, the temp file is really fsynced before the link and the folder after it, also for a replay", async () => {
  const dir = tmp();
  const e = env("add", { title: "real-sync" });
  const first = [];
  const events = await withSyncSpy(async (ev) => {
    const hooks = Object.fromEntries(["beforeLink", "afterUnlink"].map((s) => [s, () => { ev.push(`hook:${s}`); }]));
    ok(await sub(dir, e, { hooks }));
    first.push(...ev);
  });
  const at = (pred) => events.findIndex(pred);
  const fileSync = at((x) => /^sync:.*\.tmp-/.test(x));
  const dirSync = at((x) => x === `sync:${dir}`);
  assert.ok(fileSync >= 0, `the temp file was fsynced: ${events.join(" | ")}`);
  assert.ok(fileSync < at((x) => x === "hook:beforeLink"), "the file sync is before the link");
  assert.ok(dirSync > at((x) => x === "hook:afterUnlink"), `the folder sync is after the link: ${events.join(" | ")}`);
  const replay = await withSyncSpy(async () => { assert.equal(ok(await sub(dir, e)).replayed, true); });
  assert.deepEqual(replay.filter((x) => x === `sync:${dir}`), [`sync:${dir}`], "a replay crosses the real folder sync");
});
