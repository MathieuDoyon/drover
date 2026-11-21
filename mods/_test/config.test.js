// drover-config core: schema, 3-layer cfg(), override helpers, and "each default equals today's code constant".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA, field, validate } from "../_lib/config-schema.js";
import * as C from "../_lib/config.js";
import { DEFAULT_QUERY, toArgs } from "../drover-github/query.js";
import { MAX_RUNS } from "../_lib/runs.js";
import { MIN_EVERY, EXPIRES_AFTER } from "../_lib/wake.js";
import { COLUMNS, SORT_MODES } from "../_lib/store.js";

const MODS = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(MODS, p), "utf8");
const def = (mod, key) => field(mod, key).default;
let n = 0;
const fresh = () => `drover-test-${n++}`; // cache is per module name; a fresh name per test

// ---- schema integrity ----
test("schema: mod+key unique, every default valid against its own field", () => {
  const seen = new Set();
  for (const f of SCHEMA) {
    const id = `${f.mod}/${f.key}`;
    assert.ok(!seen.has(id), `duplicate ${id}`);
    seen.add(id);
    assert.ok(f.title && f.description, `${id} needs title and description`);
    assert.ok(["boolean", "int", "text", "list", "enum"].includes(f.type), id);
    assert.equal(typeof f.live, "boolean", `${id} live`);
    const v = validate(f, f.default);
    assert.ok(v.ok, `${id} default invalid: ${v.error}`);
    assert.deepEqual(v.value, f.default);
  }
});

test("schema: every drover-* folder has an enabled entry, except config, tabs, newtask, needs, switch and jump", () => {
  const folders = readdirSync(MODS, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("drover-")).map((d) => d.name);
  assert.ok(folders.length >= 10);
  const exempt = new Set(["drover-config", "drover-tabs", "drover-newtask", "drover-needs", "drover-switch", "drover-jump"]);
  for (const m of folders) {
    const f = field(m, "enabled");
    if (exempt.has(m)) assert.equal(f, undefined, `${m} must not be disableable`);
    else { assert.ok(f, `${m} lacks enabled`); assert.equal(f.type, "boolean"); assert.equal(f.default, true); }
  }
  for (const f of SCHEMA) if (f.key === "enabled") assert.ok(folders.includes(f.mod), `${f.mod} is not a folder`);
});

test("field: unknown mod/key gives undefined", () => {
  assert.equal(field("drover-github", "nope"), undefined);
  assert.equal(field("nope", "enabled"), undefined);
  assert.equal(field("drover-github", "__proto__"), undefined);
});

// ---- validate ----
test("validate: int range, integers only", () => {
  const f = field("drover-github", "limit");
  assert.deepEqual(validate(f, 50), { ok: true, value: 50 });
  assert.deepEqual(validate(f, 1000), { ok: true, value: 1000 });
  for (const bad of [0, 1001, -3, 1.5, NaN, Infinity, "50", null, undefined, true, []]) assert.equal(validate(f, bad).ok, false, String(bad));
  assert.match(validate(f, 0).error, /1/);
});

test("validate: boolean", () => {
  const f = field("drover-room", "enabled");
  assert.deepEqual(validate(f, false), { ok: true, value: false });
  for (const bad of ["true", 1, 0, null, undefined]) assert.equal(validate(f, bad).ok, false);
});

test("validate: text is trimmed, non-empty, no control chars, max 2000", () => {
  const f = field("drover-github", "query");
  assert.deepEqual(validate(f, "  is:pr  "), { ok: true, value: "is:pr" });
  for (const bad of ["", "   ", "a\nb", "a\u0000b", "a\u007fb", "x".repeat(2001), 5, null, undefined]) assert.equal(validate(f, bad).ok, false, JSON.stringify(bad));
  assert.equal(validate(f, "x".repeat(2000)).ok, true);
});

test("validate: text field with an empty default (jira site) accepts empty", () => {
  const f = field("drover-jira", "site");
  assert.deepEqual(validate(f, ""), { ok: true, value: "" });
  assert.deepEqual(validate(f, "  "), { ok: true, value: "" });
  assert.deepEqual(validate(f, " acme.atlassian.net "), { ok: true, value: "acme.atlassian.net" });
  assert.equal(validate(f, "a\nb").ok, false);
});

test("validate: list of non-empty trimmed strings", () => {
  const f = field("drover-github", "scopes");
  assert.deepEqual(validate(f, []), { ok: true, value: [] });
  assert.deepEqual(validate(f, [" org ", "o/r"]), { ok: true, value: ["org", "o/r"] });
  for (const bad of ["org", [""], ["  "], [1], ["a\nb"], [null], ["x".repeat(2001)], {}]) assert.equal(validate(f, bad).ok, false, JSON.stringify(bad));
});

test("validate: enum member (synthetic field)", () => {
  const f = { mod: "m", key: "k", type: "enum", enum: ["a", "b"], default: "a" };
  assert.deepEqual(validate(f, "b"), { ok: true, value: "b" });
  for (const bad of ["c", 1, null, undefined, ""]) assert.equal(validate(f, bad).ok, false);
});

// ---- resolve: shared -> mod.json settings -> default ----
test("resolve: shared beats settings beats default", () => {
  assert.equal(C.resolve({ "drover-github": { limit: 7 } }, { limit: 9 }, "drover-github", "limit"), 7);
  assert.equal(C.resolve({}, { limit: 9 }, "drover-github", "limit"), 9);
  assert.equal(C.resolve({}, {}, "drover-github", "limit"), 100);
  assert.equal(C.resolve(undefined, undefined, "drover-github", "limit"), 100);
  assert.equal(C.resolve(null, null, "drover-github", "limit"), 100);
});

test("resolve: invalid or out-of-range falls through layer by layer", () => {
  const s = { "drover-github": { limit: 99999 } };
  assert.equal(C.resolve(s, { limit: 9 }, "drover-github", "limit"), 9, "bad shared -> settings");
  assert.equal(C.resolve(s, { limit: 0 }, "drover-github", "limit"), 100, "both bad -> default");
  assert.equal(C.resolve({ "drover-github": { limit: "7" } }, {}, "drover-github", "limit"), 100);
  assert.equal(C.resolve({ "drover-github": "junk" }, { limit: 9 }, "drover-github", "limit"), 9);
  assert.equal(C.resolve([], [], "drover-github", "limit"), 100);
});

test("resolve: returns the validated (trimmed) value; unknown field is undefined", () => {
  assert.equal(C.resolve({ "drover-jira": { jql: "  project = X  " } }, {}, "drover-jira", "jql"), "project = X");
  assert.equal(C.resolve({}, {}, "drover-jira", "nope"), undefined);
});

test("resolve: an explicit false/empty override wins over a truthy inherited value", () => {
  assert.equal(C.resolve({ "drover-room": { enabled: false } }, { enabled: true }, "drover-room", "enabled"), false);
  assert.equal(C.resolve({ "drover-jira": { site: "" } }, { site: "x.atlassian.net" }, "drover-jira", "site"), "");
});

test("resolve: prototype keys are not read as values", () => {
  assert.equal(C.resolve({}, {}, "drover-github", "limit"), 100);
  assert.equal(C.resolve({ "drover-github": Object.create({ limit: 5 }) }, {}, "drover-github", "limit"), 100);
});

// ---- cfg(): sync, cache, ready flag, injected shared reader ----
test("cfg: before ready the mod.json layer is skipped, after setSettings it applies", () => {
  const m = "drover-github";
  C.resetCache();
  C.setSharedReader(() => ({}));
  assert.equal(C.ready(m), false);
  assert.equal(C.cfg(m, "limit"), 100);
  C.setSettings(m, { limit: 9 });
  assert.equal(C.ready(m), true);
  assert.equal(C.cfg(m, "limit"), 9);
});

test("cfg: shared is read live on every call (instant re-render)", () => {
  C.resetCache();
  let shared = {};
  C.setSharedReader(() => shared);
  C.setSettings("drover-github", { limit: 9 });
  assert.equal(C.cfg("drover-github", "limit"), 9);
  shared = { "drover-github": { limit: 3 } };
  assert.equal(C.cfg("drover-github", "limit"), 3);
  shared = {};
  assert.equal(C.cfg("drover-github", "limit"), 9);
});

test("cfg: no reader, or a throwing reader, gives the lower layers", () => {
  C.resetCache();
  C.setSharedReader(undefined);
  assert.equal(C.cfg("drover-github", "limit"), 100);
  C.setSharedReader(() => { throw new Error("boom"); });
  assert.equal(C.cfg("drover-github", "limit"), 100);
});

test("cfg: setSettings does not keep a live reference or accept junk", () => {
  C.resetCache();
  C.setSharedReader(() => ({}));
  const o = { limit: 9 };
  C.setSettings("drover-github", o);
  o.limit = 4;
  assert.equal(C.cfg("drover-github", "limit"), 9);
  C.setSettings("drover-room", "junk");
  assert.equal(C.ready("drover-room"), true);
  assert.equal(C.cfg("drover-room", "refresh_minutes"), 5);
});

test("bind: wires shared + modSettings; load fills the cache", async () => {
  C.resetCache();
  const calls = [];
  C.bind({ shared: (k) => { calls.push(k); return { "drover-room": { refresh_minutes: 10 } }; }, modSettings: async (m) => ({ refresh_minutes: 2, _m: m }) });
  assert.equal(C.cfg("drover-room", "refresh_minutes"), 10, "shared works before ready");
  await C.load("drover-room");
  assert.equal(C.ready("drover-room"), true);
  assert.ok(calls.every((k) => k === C.KEY));
  assert.equal(C.KEY, "drover.config");
});

test("bind: a failing modSettings still marks ready with no settings", async () => {
  C.resetCache();
  C.bind({ shared: () => ({}), modSettings: async () => { throw new Error("no file"); } });
  await C.load("drover-room");
  assert.equal(C.ready("drover-room"), true);
  assert.equal(C.cfg("drover-room", "refresh_minutes"), 5);
});

// ---- override helpers ----
test("isOverride / setOverride / resetOverride: inherited vs override vs reset", () => {
  const a = {};
  assert.equal(C.isOverride(a, "drover-github", "limit"), false);
  const b = C.setOverride(a, "drover-github", "limit", 50);
  assert.deepEqual(a, {}, "input not mutated");
  assert.deepEqual(b, { "drover-github": { limit: 50 } });
  assert.equal(C.isOverride(b, "drover-github", "limit"), true);
  assert.equal(C.resolve(b, { limit: 9 }, "drover-github", "limit"), 50);
  const r = C.resetOverride(b, "drover-github", "limit");
  assert.deepEqual(b, { "drover-github": { limit: 50 } }, "input not mutated");
  assert.deepEqual(r, {}, "empty mod object dropped");
  assert.equal(C.isOverride(r, "drover-github", "limit"), false);
  assert.equal(C.resolve(r, { limit: 9 }, "drover-github", "limit"), 9, "reset returns to inherited, not default");
});

test("setOverride: an override equal to the default is still stored; reset never writes the default", () => {
  const s = C.setOverride({}, "drover-github", "limit", 100);
  assert.deepEqual(s, { "drover-github": { limit: 100 } });
  assert.equal(C.isOverride(s, "drover-github", "limit"), true);
  assert.equal(C.resolve(s, { limit: 9 }, "drover-github", "limit"), 100, "explicit 100 beats inherited 9");
  const r = C.resetOverride(s, "drover-github", "limit");
  assert.equal(Object.hasOwn(r, "drover-github"), false);
});

test("setOverride: validates, stores the trimmed value, keeps other keys and mods, throws on bad input", () => {
  let s = C.setOverride({}, "drover-github", "limit", 7);
  s = C.setOverride(s, "drover-github", "query", "  is:pr  ");
  s = C.setOverride(s, "drover-room", "enabled", false);
  assert.deepEqual(s, { "drover-github": { limit: 7, query: "is:pr" }, "drover-room": { enabled: false } });
  const before = JSON.stringify(s);
  assert.throws(() => C.setOverride(s, "drover-github", "limit", 5000));
  assert.throws(() => C.setOverride(s, "drover-github", "nope", 1));
  assert.throws(() => C.setOverride(s, "nope", "enabled", true));
  assert.equal(JSON.stringify(s), before);
  const r = C.resetOverride(s, "drover-github", "limit");
  assert.deepEqual(r, { "drover-github": { query: "is:pr" }, "drover-room": { enabled: false } });
});

test("resetOverride: missing key, missing mod, junk input are no-ops that return a new object", () => {
  const s = { "drover-room": { enabled: false } };
  assert.deepEqual(C.resetOverride(s, "drover-github", "limit"), s);
  assert.notEqual(C.resetOverride(s, "drover-github", "limit"), s);
  assert.deepEqual(C.resetOverride(undefined, "drover-github", "limit"), {});
  assert.deepEqual(C.setOverride(null, "drover-room", "enabled", true), { "drover-room": { enabled: true } });
});

// ---- each default equals today's code constant ----
test("default = today's constant: github query", () => {
  assert.equal(def("drover-github", "query"), toArgs(DEFAULT_QUERY).join(" "));
  assert.deepEqual(def("drover-github", "scopes"), []);
});

test("default = today's constant: runs MAX_RUNS", () => {
  assert.equal(def("drover-runs", "max_parallel"), MAX_RUNS);
});

test("default = today's constant: wake MIN_EVERY and EXPIRES_AFTER", () => {
  assert.equal(def("drover-wakeups", "min_repeat_minutes") * 60000, MIN_EVERY);
  assert.equal(def("drover-wakeups", "expiry_hours") * 3600000, EXPIRES_AFTER);
});

// github limit and the jira values are read through cfg() since card 3: the old file-private constants are gone, the schema is the only home.
test("github and jira mains read cfg(), keep no private copy of the defaults, and the jira site constant is gone", () => {
  const g = src("drover-github/main.js"), j = src("drover-jira/main.js"), io = src("_lib/io.js");
  assert.doesNotMatch(g, /const LIMIT =/);
  assert.match(g, /cfg\(MOD, "limit"\)/);
  assert.doesNotMatch(j, /DEFAULT_JQL|const PAGES|5 \* 60 \* 1000/);
  for (const k of ["jql", "pages", "refresh_minutes", "site"]) assert.match(j, new RegExp(`cfg\\(MOD, "${k}"\\)`), k);
  assert.doesNotMatch(io, /JIRA_SITE/);
  assert.equal(def("drover-github", "limit"), 100);
  assert.equal(def("drover-jira", "pages"), 4);
  assert.equal(def("drover-jira", "refresh_minutes"), 5);
  assert.equal(field("drover-jira", "refresh_minutes").live, true);
  assert.match(def("drover-jira", "jql"), /^assignee = currentUser\(\) AND statusCategory != Done ORDER BY updated DESC$/);
});

test("default = today's constant: room refresh is 5 minutes, live (see tunables.test.js)", () => {
  assert.equal(def("drover-room", "refresh_minutes"), 5);
  assert.equal(field("drover-room", "refresh_minutes").live, true);
});

test("jira site default is intentionally empty (no site is shipped; io.js has no site constant)", () => {
  assert.equal(def("drover-jira", "site"), "");
});

// ---- addendum: before ready, never undefined; unknown mod/key throws ----
test("cfg before ready: valid shared value, else schema default, never undefined (every field)", () => {
  C.resetCache();
  C.setSharedReader(() => ({ "drover-github": { limit: 12, query: "bad\nvalue" } }));
  assert.equal(C.ready("drover-github"), false);
  assert.equal(C.cfg("drover-github", "limit"), 12, "valid shared wins before ready");
  assert.equal(C.cfg("drover-github", "query"), def("drover-github", "query"), "invalid shared -> default");
  C.setSharedReader(undefined);
  for (const f of SCHEMA) {
    const v = C.cfg(f.mod, f.key);
    assert.notEqual(v, undefined, `${f.mod}/${f.key}`);
    assert.deepEqual(v, f.default);
  }
});

test("cfg: unknown mod or key throws (documented), resolve returns undefined", () => {
  C.resetCache();
  assert.throws(() => C.cfg("drover-github", "nope"), /unknown setting drover-github\.nope/);
  assert.throws(() => C.cfg("drover-nope", "enabled"), /unknown setting/);
  assert.throws(() => C.cfg("drover-config", "enabled"), /unknown setting/, "config is not disableable");
  assert.throws(() => C.cfg("drover-tabs", "enabled"), /unknown setting/, "tabs is not disableable");
  assert.equal(C.resolve({}, {}, "drover-github", "nope"), undefined);
});

// ---- installer: the cp line ships the lib, and the copy is self-contained ----
test("the copy list (_lib/copies.txt) has config-schema.js and config.js; a copy in a fake mod folder imports and works", async () => {
  assert.match(src("install.sh"), /_lib\/copies\.txt/, "install.sh reads the copy list");
  const files = src("_lib/copies.txt").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const f of ["config-schema.js", "config.js"]) assert.ok(files.includes(f), `${f} missing from copies.txt`);
  const tmp = mkdtempSync(join(tmpdir(), "drover-config-install-"));
  try {
    const dest = join(tmp, "home", "mods", "drover-x");
    mkdirSync(dest, { recursive: true });
    for (const f of ["_lib/config-schema.js", "_lib/config.js", "_lib/store.js", "_lib/sources.js", "_lib/lessons.js", "_lib/workfolder.js", "_lib/evidence.js"]) copyFileSync(join(MODS, f), join(dest, f.split("/")[1]));
    const copy = await import(pathToFileURL(join(dest, "config.js")).href);
    copy.setSharedReader(() => ({}));
    assert.equal(copy.cfg("drover-github", "limit"), 100);
    assert.equal(copy.resolve({ "drover-github": { limit: 7 } }, {}, "drover-github", "limit"), 7);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- card 6: squad and board defaults ----
test("defaults: squad picker starts as today (no squad, no worktree, no report); the board shows all 6 columns, manual sort", () => {
  assert.equal(def("drover-agents", "default_squad"), "");
  assert.equal(field("drover-agents", "default_squad").empty, true);
  assert.equal(def("drover-agents", "default_worktree"), false);
  assert.equal(def("drover-agents", "default_report"), false);
  assert.deepEqual(def("drover-board", "visible_columns"), COLUMNS.map(([id]) => id));
  assert.equal(def("drover-board", "default_sort"), "manual");
  assert.deepEqual(field("drover-board", "default_sort").enum, SORT_MODES.map(([m]) => m));
});

test("validate: visible_columns takes known column ids only, never an empty list, and is normalised", () => {
  const f = field("drover-board", "visible_columns");
  assert.deepEqual(validate(f, ["todo", "doing"]), { ok: true, value: ["todo", "doing"] });
  assert.deepEqual(validate(f, ["done", "backlog", "done"]), { ok: true, value: ["backlog", "done"] }, "column order, no duplicates");
  assert.deepEqual(validate(f, [" review "]), { ok: true, value: ["review"] });
  for (const bad of [[], ["nope"], ["todo", "nope"], [""], "todo", [1], null, undefined]) assert.equal(validate(f, bad).ok, false, JSON.stringify(bad));
  assert.match(validate(f, []).error, /at least one/i, "everything can never be hidden");
  assert.match(validate(f, ["nope"]).error, /backlog/);
  // a stored empty or bad list falls back: the board never ends up with no column
  assert.deepEqual(C.resolve({ "drover-board": { visible_columns: [] } }, {}, "drover-board", "visible_columns"), def("drover-board", "visible_columns"));
});

test("validate: default_sort is one of the sort modes; default_squad is trimmed text, empty allowed", () => {
  const sort = field("drover-board", "default_sort");
  for (const m of ["manual", "priority", "newest"]) assert.equal(validate(sort, m).ok, true, m);
  assert.equal(validate(sort, "oldest").ok, false);
  const sq = field("drover-agents", "default_squad");
  assert.deepEqual(validate(sq, " s1 "), { ok: true, value: "s1" });
  assert.deepEqual(validate(sq, ""), { ok: true, value: "" });
});
