// T-MWO3FDT7NKL (B4b): the asks state machine and the read-only scan helper. Pure state tests use plain Maps; the helper runs on a real temp dir.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, chmodSync, realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAskFile, cleanAsk, createAsksState, askReason, asksFresh, ASK_TTL_MS as TTL, ASK_TOOLS, terminalIdOk } from "../_lib/asks.js";
import { REASON_MAX } from "../_lib/store.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "drover-tasks", "bin");
const lib = await import(pathToFileURL(join(BIN, "asks-lib.mjs")).href);
const made = [];
after(() => { for (const d of made) { try { chmodSync(d, 0o700); } catch {} rmSync(d, { recursive: true, force: true }); } });
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "asks-read-"))); made.push(d); return d; };
// The helper trusts <home>/data and <home>/data/drover-asks (our uid, no link), like the producer. A bare mkdtemp dir sits in the shared temp root
// (root-owned /tmp on Linux CI), which is correctly UNKNOWN; tests that run a scan use the real layout.
const askdir = () => { const d = join(tmp(), "data", "drover-asks"); mkdirSync(d, { recursive: true }); return d; };

const ask = (id, o = {}) => ({ id, kind: "permission", tool: "Edit", at: 1000, ...o });
const scanOf = (obj) => ({ ok: true, files: new Map(Object.entries(obj)) });
const NOW = 2000;
const upd = (st, scan, { status = {}, alive = ["t1"], now = NOW } = {}) => st.update({ scan, statuses: new Map(Object.entries(status)), alive: new Set(alive), now });

test("the shared constants equal the hook's (tool list, TTL, id rule)", () => {
  assert.deepEqual([...ASK_TOOLS].filter((t) => t !== "tool" && t !== "mcp").sort(), [...lib.TOOLS].sort());
  assert.equal(TTL, lib.ASK_TTL_MS);
  for (const id of ["t1", "t2gk", "a.b", "", "..", "a/b", "-x", "x".repeat(65)]) assert.equal(terminalIdOk(id), lib.terminalIdOk(id), id);
  for (const at of [999, 1000, 1000 + TTL - 1, 1000 + TTL, 500]) assert.equal(asksFresh({ at: 1000 }, at), lib.askFresh({ at: 1000 }, at), String(at));
});

test("parse: only id, kind, tool, at survive; secrets and extra fields never surface; bad shapes are null", () => {
  const SECRET = "sk" + "-FAKE-0123456789abcdef";
  const got = parseAskFile(JSON.stringify({ v: 1, id: 7, kind: "permission", tool: "Bash", at: 5, command: SECRET, title: "rm -rf", extra: { a: 1 } }));
  assert.deepEqual(got, { id: 7, kind: "permission", tool: "Bash", at: 5 });
  assert.ok(!JSON.stringify(got).includes(SECRET));
  for (const bad of [{ v: 1, id: 1, kind: "other", tool: "Bash", at: 1 }, { v: 1, id: 1, kind: "plan", tool: "Format-Disk", at: 1 }, { v: 2, id: 1, kind: "plan", tool: "Bash", at: 1 },
    { v: 1, id: -1, kind: "plan", tool: "Bash", at: 1 }, { v: 1, id: 1.5, kind: "plan", tool: "Bash", at: 1 }, { v: 1, id: 1, kind: "plan", tool: "Bash", at: "x" }, [], null, 3]) assert.equal(parseAskFile(JSON.stringify(bad)), null, JSON.stringify(bad));
  assert.equal(parseAskFile("{nope"), null);
  assert.equal(cleanAsk({ id: 1, kind: "plan", tool: "tool", at: 0, x: 1 }).x, undefined);
});

test("pre-block delivery: an ask read before Herdr shows blocked is kept, then shown once blocked", () => {
  const st = createAsksState();
  assert.equal(upd(st, scanOf({ t1: ask(5) }), { status: { t1: "working" } }).get("t1")?.id, 5);
  assert.equal(upd(st, scanOf({ t1: ask(5) }), { status: { t1: "blocked" } }).get("t1")?.id, 5);
});

test("old clear vs new ask: a late read of an older id never replaces or revives; a dropped id never comes back", () => {
  const st = createAsksState();
  upd(st, scanOf({ t1: ask(5, { kind: "plan", tool: "ExitPlanMode" }) }));
  assert.equal(upd(st, scanOf({ t1: ask(3) })).get("t1").id, 5, "an older file does not replace the newer ask");
  assert.equal(upd(st, scanOf({})).has("t1"), false, "the file vanished: the hook cleared it");
  assert.equal(upd(st, scanOf({ t1: ask(5) })).has("t1"), false, "the cleared id does not revive");
  assert.equal(upd(st, scanOf({ t1: ask(4) })).has("t1"), false, "an older id does not revive either");
  assert.equal(upd(st, scanOf({ t1: ask(6) })).get("t1").id, 6, "a newer ask shows");
});

test("status not blocked clears only an ask already seen blocked", () => {
  const st = createAsksState();
  upd(st, scanOf({ t1: ask(5) }), { status: { t1: "blocked" } });
  assert.equal(upd(st, scanOf({ t1: ask(5) }), { status: { t1: "working" } }).has("t1"), false, "answered");
  assert.equal(upd(st, scanOf({ t1: ask(5) }), { status: { t1: "blocked" } }).has("t1"), false, "the same id does not come back from a stale scan");
  assert.equal(upd(st, scanOf({ t1: ask(6) }), { status: { t1: "working" } }).get("t1").id, 6, "a new ask not yet seen blocked stays");
});

test("long-lived ask: blocked for 2 h (far past the TTL) is still shown while the terminal is alive", () => {
  const st = createAsksState();
  const out = upd(st, scanOf({ t1: ask(5, { at: 0 }) }), { status: { t1: "blocked" }, now: 2 * 3600000 });
  assert.equal(out.get("t1")?.id, 5);
  assert.equal(upd(st, scanOf({ t1: ask(5, { at: 0 }) }), { status: { t1: "blocked" }, now: 4 * 3600000 }).get("t1")?.id, 5);
  const idle = createAsksState(); // alive, never seen blocked, stale: kept too (no TTL for an alive terminal)
  assert.equal(upd(idle, scanOf({ t1: ask(5, { at: 0 }) }), { status: { t1: "working" }, now: 2 * 3600000 }).get("t1")?.id, 5);
});

test("TTL applies only to a terminal that is gone", () => {
  const st = createAsksState();
  assert.equal(upd(st, scanOf({ t9: ask(5, { at: 0 }) }), { alive: [], now: TTL - 1 }).has("t9"), true, "fresh, gone: kept");
  assert.equal(upd(st, scanOf({ t9: ask(5, { at: 0 }) }), { alive: [], now: TTL }).has("t9"), false, "stale, gone: dropped");
  assert.equal(upd(st, scanOf({ t9: ask(5, { at: 0 }) }), { alive: [], now: TTL - 1 }).has("t9"), false, "the dropped id stays dropped");
});

test("restart: a new state rebuilds from the files; a blocked ask older than the TTL shows", () => {
  const files = scanOf({ t1: ask(5, { at: 0 }) });
  const out = upd(createAsksState(), files, { status: { t1: "blocked" }, now: 3 * TTL });
  assert.equal(out.get("t1")?.id, 5);
});

test("an unknown scan changes nothing and advances no tombstone; the same id recovers", () => {
  const st = createAsksState();
  upd(st, scanOf({ t1: ask(5) }));
  for (const bad of [null, undefined, { ok: false }, { ok: true }, "x"]) assert.equal(upd(st, bad).get("t1")?.id, 5, String(bad));
  assert.equal(upd(st, scanOf({ t1: ask(5) })).get("t1")?.id, 5, "the same id after an error is still shown");
  const fresh = createAsksState();
  assert.equal(upd(fresh, null).size, 0, "no scan yet: no asks (fallback)");
});

test("defect class sweep: every order of read, clear and status for ids 3 and 5 never shows an id below the highest seen", () => {
  const steps = [() => scanOf({ t1: ask(3) }), () => scanOf({ t1: ask(5) }), () => scanOf({}), () => null];
  const stat = [{}, { t1: "blocked" }, { t1: "working" }];
  const run = (seq) => {
    const st = createAsksState(); let high = -1;
    for (const [i, s] of seq) {
      const out = upd(st, steps[i](), { status: stat[s] });
      const id = out.get("t1")?.id;
      if (id !== undefined) { assert.ok(id >= high, `${JSON.stringify(seq)} showed ${id} after ${high}`); high = Math.max(high, id); }
    }
  };
  const all = []; for (let i = 0; i < 4; i++) for (let s = 0; s < 3; s++) all.push([i, s]);
  for (const a of all) for (const b of all) for (const c of all) run([a, b, c]);
});

test("reason text: kind and tool, fallback-friendly, never above the cap", () => {
  assert.equal(askReason(ask(1)), "Asks permission · Edit");
  assert.equal(askReason(ask(1, { tool: "tool" })), "Asks permission");
  assert.equal(askReason(ask(1, { tool: "mcp" })), "Asks permission · MCP tool");
  assert.equal(askReason(ask(1, { kind: "question", tool: "AskUserQuestion" })), "Question for you");
  assert.equal(askReason(ask(1, { kind: "plan", tool: "ExitPlanMode" })), "Plan to approve");
  assert.equal(askReason(null), null);
  for (const kind of ["permission", "question", "plan"]) for (const tool of ASK_TOOLS) assert.ok(askReason(ask(1, { kind, tool })).length <= REASON_MAX, `${kind} ${tool}`);
});

// ---- the helper, on a real temp dir ----
const HELPER = join(BIN, "drover-asks-read");
const run = (dir, env = {}) => spawnSync(HELPER, dir === undefined ? [] : [dir], { encoding: "utf8", timeout: 20000, env: { ...process.env, ...env } });
const file = (dir, name, o) => writeFileSync(join(dir, name), typeof o === "string" ? o : JSON.stringify({ v: 1, ...o }), { mode: 0o600 });

test("helper: prints one allowlisted line for good files and skips FIFO, symlink, hardlink, oversize, garbage and bad names", () => {
  const dir = askdir(), outside = tmp();
  file(dir, "t1.json", { id: 5, kind: "permission", tool: "Bash", at: 9, command: "secret" + "-cmd" });
  file(dir, "t2.json", { id: 6, kind: "question", tool: "AskUserQuestion", at: 9 });
  file(dir, "t3.json", "{not json");
  file(dir, "t4.json", " ".repeat(5000) + JSON.stringify({ v: 1, id: 1, kind: "plan", tool: "tool", at: 1 }));
  file(outside, "real.json", { id: 9, kind: "plan", tool: "tool", at: 1 });
  symlinkSync(join(outside, "real.json"), join(dir, "t5.json"));
  linkSync(join(outside, "real.json"), join(dir, "t6.json"));
  file(dir, "bad name.json", { id: 1, kind: "plan", tool: "tool", at: 1 });
  file(dir, "t7.seq", "12");
  spawnSync("mkfifo", [join(dir, "t8.json")]);
  mkdirSync(join(dir, "t9.json"));
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  const o = JSON.parse(r.stdout);
  assert.equal(o.ok, true);
  assert.deepEqual(o.asks.sort((a, b) => a.terminal.localeCompare(b.terminal)), [
    { terminal: "t1", id: 5, kind: "permission", tool: "Bash", at: 9 }, { terminal: "t2", id: 6, kind: "question", tool: "AskUserQuestion", at: 9 }]);
  assert.ok(!r.stdout.includes("secret"));
});

test("helper: a folder whose parent is not ours (root-owned, like /tmp on Linux CI) is UNKNOWN, so tests must use the data/drover-asks layout", { skip: process.getuid?.() === 0 ? "root owns everything" : false }, () => {
  const r = run("/usr"); // its parent "/" is root-owned on macOS and Linux: untrusted, nothing is listed or printed
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
});

test("helper: missing folder = ok with no asks; a symlinked, plain-file or no folder argument = unknown (exit 1, nothing printed)", () => {
  const base = tmp();
  assert.deepEqual(JSON.parse(run(join(base, "nope")).stdout), { ok: true, asks: [] });
  const real = join(base, "real"); mkdirSync(real);
  symlinkSync(real, join(base, "link"));
  const f = join(base, "plain"); writeFileSync(f, "x");
  for (const arg of [join(base, "link"), f, undefined, ""]) { const r = run(arg); assert.equal(r.status, 1, String(arg)); assert.equal(r.stdout, ""); }
});

test("helper: it only reads the folder it is given and never writes (the folder is unchanged, mode and mtime)", () => {
  const dir = askdir();
  file(dir, "t1.json", { id: 5, kind: "plan", tool: "tool", at: 9 });
  const before = [readdirSync(dir), readFileSync(join(dir, "t1.json"), "utf8"), statSync(dir).mtimeMs, statSync(join(dir, "t1.json")).mtimeMs];
  run(dir);
  assert.deepEqual([readdirSync(dir), readFileSync(join(dir, "t1.json"), "utf8"), statSync(dir).mtimeMs, statSync(join(dir, "t1.json")).mtimeMs], before);
  const src = readFileSync(join(BIN, "drover-asks-read.mjs"), "utf8") + readFileSync(join(BIN, "drover-asks-read"), "utf8");
  assert.doesNotMatch(src, /writeFile|unlink|rename|rmSync|mkdir|appendFile|chmod|copyFile|symlinkSync|\bhc send\b|\bhc keys\b/, "the helper has no write or answer call");
});

test("helper: no node on PATH and no recorded runtime = unknown, never 'no asks'", () => {
  const dir = askdir(), empty = tmp();
  const r = spawnSync("/bin/sh", [HELPER, dir], { encoding: "utf8", timeout: 20000, env: { PATH: empty, HERDR_APP_HOME: empty, HOME: empty } });
  if (r.status === 0) return; // find-runtime found a node in a common place: the scan then ran, which is fine
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
});

// ---- review round 1: every place the helper treats an error, a limit or a path as complete or trusted (T-MWO3FDT7NKL) ----
const state1 = (r) => (r.status === 0 ? { ok: true, files: new Map(JSON.parse(r.stdout).asks.map((a) => [a.terminal, cleanAsk(a)])) } : null); // what the reader does with a helper result
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("round 1 (1): an unreadable leaf makes the whole scan UNKNOWN, never absence; the same id recovers across helper and state", { skip: isRoot && "root reads every file" }, () => {
  const dir = askdir();
  file(dir, "t9.json", { id: 5, kind: "permission", tool: "Edit", at: 1000 });
  const st = createAsksState();
  assert.equal(upd(st, state1(run(dir)), { alive: ["t9"], status: { t9: "blocked" } }).get("t9")?.id, 5);
  chmodSync(join(dir, "t9.json"), 0o000); // EACCES on open: not "gone"
  const bad = run(dir);
  assert.equal(bad.status, 1, "unknown");
  assert.equal(bad.stdout, "");
  assert.equal(upd(st, state1(bad), { alive: ["t9"], status: { t9: "blocked" } }).get("t9")?.id, 5, "an unknown scan advances no tombstone");
  chmodSync(join(dir, "t9.json"), 0o600);
  assert.equal(upd(st, state1(run(dir)), { alive: ["t9"], status: { t9: "blocked" } }).get("t9")?.id, 5, "the same id shows again");
});

test("round 1 (1): an unreadable folder (readdir fails) is unknown", { skip: isRoot && "root reads every file" }, () => {
  const dir = askdir();
  file(dir, "t1.json", { id: 1, kind: "plan", tool: "tool", at: 1 });
  chmodSync(dir, 0o000);
  const r = run(dir);
  chmodSync(dir, 0o700);
  assert.equal(r.status, 1, "readdir failure");
});

test("round 1 (2): irrelevant files do not use the budget: 1100 .seq files and one ask still find the ask", () => {
  const dir = askdir();
  for (let i = 0; i < 1100; i++) writeFileSync(join(dir, `a${String(i).padStart(4, "0")}.seq`), "7");
  file(dir, "zzzz.json", { id: 8, kind: "question", tool: "AskUserQuestion", at: 2 });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).asks.map((a) => a.terminal), ["zzzz"]);
});

test("round 1 (2): more valid candidates than the budget is UNKNOWN, never a complete partial scan", () => {
  const dir = askdir();
  for (let i = 0; i < 1001; i++) file(dir, `t${i}.json`, { id: 1, kind: "plan", tool: "tool", at: 1 });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
});

test("round 1 (3): the data parent is checked like the producer's prepareDir: a symlinked data folder, or one that is a file, is unknown; a missing one is no asks", () => {
  const app = tmp(), outside = tmp();
  mkdirSync(join(outside, "drover-asks"));
  file(join(outside, "drover-asks"), "t9.json", { id: 5, kind: "permission", tool: "Edit", at: 1000 });
  symlinkSync(outside, join(app, "data"));
  const r = run(join(app, "data", "drover-asks"));
  assert.equal(r.status, 1, "a symlinked parent is not trusted");
  assert.equal(r.stdout, "");
  const app2 = tmp(); writeFileSync(join(app2, "data"), "x");
  assert.equal(run(join(app2, "data", "drover-asks")).status, 1);
  const app3 = tmp();
  assert.deepEqual(JSON.parse(run(join(app3, "data", "drover-asks")).stdout), { ok: true, asks: [] }, "no data folder yet: no hooks, no asks");
  const app4 = tmp(); mkdirSync(join(app4, "data")); mkdirSync(join(app4, "data", "drover-asks"));
  file(join(app4, "data", "drover-asks"), "t1.json", { id: 3, kind: "plan", tool: "tool", at: 1 });
  assert.equal(JSON.parse(run(join(app4, "data", "drover-asks")).stdout).asks.length, 1, "the real layout still reads");
});

// ---- review round 2: the folders checked are the folders listed and read (dev+ino+type+uid unchanged across the scan) ----
const { scan: scanDir } = await import(pathToFileURL(join(BIN, "drover-asks-read.mjs")).href);
import { renameSync } from "node:fs";
function layout() {
  const app = tmp(), outside = tmp();
  mkdirSync(join(app, "data")); const dir = join(app, "data", "drover-asks"); mkdirSync(dir);
  file(dir, "t9.json", { id: 5, kind: "permission", tool: "Edit", at: 1000 });
  mkdirSync(join(outside, "d")); file(join(outside, "d"), "t9.json", { id: 99, kind: "plan", tool: "tool", at: 1 });
  return { app, dir, outside, data: join(app, "data") };
}
const aside = (p) => renameSync(p, p + ".orig");
const back = (p) => { rmSync(p, { recursive: true, force: true }); renameSync(p + ".orig", p); };

test("round 2 (A): the asks folder replaced by a symlink after the checks and before the listing = unknown, never the outside file", () => {
  const { dir, outside } = layout();
  const r = scanDir(dir, { afterCheck: () => { aside(dir); symlinkSync(join(outside, "d"), dir); } });
  back(dir);
  assert.equal(r, null);
});

test("round 2 (B): the folder swapped with an empty one after the listing, before the leaf reads = unknown, never a clear; the same id recovers", () => {
  const { dir } = layout();
  const st = createAsksState();
  const first = scanDir(dir);
  assert.equal(upd(st, state1ok(first), { alive: ["t9"], status: { t9: "blocked" } }).get("t9")?.id, 5);
  const r = scanDir(dir, { afterList: () => { aside(dir); mkdirSync(dir); } });
  back(dir);
  assert.equal(r, null);
  assert.equal(upd(st, state1ok(r), { alive: ["t9"], status: { t9: "blocked" } }).get("t9")?.id, 5, "no tombstone from an unknown scan");
  assert.equal(upd(st, state1ok(scanDir(dir)), { alive: ["t9"], status: { t9: "blocked" } }).get("t9")?.id, 5, "the same id recovers");
});

test("round 2: the data parent swapped (a link) between the listing and the end = unknown; a swap after the leaf reads is caught by the last check", () => {
  const { dir, data, outside } = layout();
  assert.equal(scanDir(dir, { afterList: () => { aside(data); symlinkSync(outside, data); } }), null);
  back(data);
  assert.equal(scanDir(dir, { afterReads: () => { aside(data); mkdirSync(data); } }), null);
  back(data);
  assert.equal(scanDir(dir).asks.length, 1, "an unchanged layout reads");
});
const state1ok = (r) => (r ? { ok: true, files: new Map(r.asks.map((a) => [a.terminal, cleanAsk(a)])) } : null);

test("round 3: validation and baseline come from ONE lstat per folder: a symlink put in place right after the validation is never the trusted baseline", () => {
  const { dir, data, outside } = layout();
  for (const [target, link] of [[dir, join(outside, "d")], [data, outside]]) {
    mkdirSync(join(outside, "d"), { recursive: true });
    const r = scanDir(dir, { afterValidate: () => { aside(target); symlinkSync(link, target); }, afterCheck: () => {} });
    back(target);
    assert.equal(r, null, target);
  }
  assert.equal(scanDir(dir).asks.length, 1);
});
