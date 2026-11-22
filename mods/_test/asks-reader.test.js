// T-MWO3FDT7NKL (B4b): the reader (startAsks) in the Tasks mod: timer started at init, one scan in flight, hard deadline, end-to-end into the row,
// Tasks-only (Runs never opened), render reads memory only. exec is stubbed; the real helper is covered in asks.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { default: Tasks } = await import(new URL("../drover-tasks/main.js", import.meta.url).href);
const C = await import(new URL("../_lib/config.js", import.meta.url).href);
const IO = await import(new URL("../_lib/io.js", import.meta.url).href);

const P = { id: "P-1", name: "Alpha", repos: [], folders: [], branch: "main" };
const COLS = ["backlog", "todo", "doing", "review", "blocked", "done"];
const card = (i, o = {}) => ({ id: `T-${i}`, title: `card ${i}`, column: COLS[i % 6], priority: "P2", tags: [], created: i, updated: i, project: P.id, archived: false, agent: null, run: null, notes: [], desc: "", assignee: null, source: null, ...o });
const out = (asks) => ({ code: 0, stdout: JSON.stringify({ ok: true, asks }) + "\n", stderr: "" });
const SIDE = ["exec", "hc", "read", "write", "watch", "every", "spawn", "set", "agents", "terminals", "fsp"];

function setup(n = 3, { scan = () => out([]), cards, tasksSettings = {} } = {}) {
  C.resetCache(); C.setSettings("drover-tasks", tasksSettings); C.setSettings("drover-runs", {}); C.setSettings("drover-wakeups", {});
  IO.resetRemoteWriter(); IO.resetAsks?.();
  const calls = { exec: 0, hc: 0, read: 0, write: 0, watch: 0, every: 0, spawn: 0, set: 0, agents: 0, terminals: 0, fsp: 0 };
  const execs = [];
  const raw = { "drover.tasks": cards ?? Array.from({ length: n }, (_, i) => card(i + 1)), "drover.projects": [P], "drover.runs": [] };
  const state = new Proxy(raw, { set(o, k, v) { calls.set++; o[k] = v; return true; }, get: (o, k) => o[k] });
  const agentsList = [], terminalsList = [];
  const host = {
    props: {}, notified: [], home: "/h", appHome: "/fake-home", state, focused: { terminal: "t1", cwd: "/x", space: null }, spaces: [], panes: [],
    exec: (cmd, args, opts) => { calls.exec++; execs.push({ cmd, args, opts }); return scan(cmd, args, opts); },
    hc: async () => { calls.hc++; return { code: 1, stdout: "", stderr: "" }; },
    readTextFile: async () => { calls.read++; return null; },
    writeTextFile: async () => { calls.write++; },
    watchFolder: async () => { calls.watch++; },
    run: () => {},
  };
  Object.defineProperty(host, "agents", { get() { calls.agents++; return agentsList; } });
  Object.defineProperty(host, "terminals", { get() { calls.terminals++; return terminalsList; } });
  globalThis.__host = host;
  const timers = [];
  const cx = { notify() { calls.notified = (calls.notified ?? 0) + 1; }, stop_propagation() {}, spawn() { calls.spawn++; }, focus_handle: () => ({ focus() {} }),
    timer: { every(ms, f) { calls.every++; timers.push({ ms, f }); }, after() { calls.every++; } } };
  const t = new Tasks(); t.init({}, cx);
  const tick = () => { for (const x of timers) x.f(cx); };
  return { t, cx, raw, calls, execs, agentsList, terminalsList, tick, timers };
}
const render = (t, cx) => { globalThis.__rec = { ids: [], texts: [] }; try { t.render(cx); return { ...globalThis.__rec }; } finally { globalThis.__rec = undefined; } };
const delta = (calls, fn) => { const b = { ...calls }; const o = fn(); return { out: o, d: Object.fromEntries(SIDE.map((k) => [k, (calls[k] ?? 0) - (b[k] ?? 0)])) }; };
const none = Object.fromEntries(SIDE.map((k) => [k, 0]));
const asksExecs = (h) => h.execs.filter((e) => String(e.cmd).endsWith("drover-asks-read"));
const blockedCard = card(2, { id: "T-B", column: "doing", agent: "t9", created: 1 });

test("init starts the reader's timer and one scan: the helper under appHome, the asks dir as its only argument, a 2 s deadline", async () => {
  const h = setup(3);
  await until(() => asksExecs(h).length === 1, "first scan at init");
  const e = asksExecs(h)[0];
  assert.equal(e.cmd, "/fake-home/mods/drover-tasks/bin/drover-asks-read");
  assert.deepEqual(e.args, ["/fake-home/data/drover-asks"]);
  assert.equal(e.opts.timeout, 2000);
});

test("end to end, Runs never opened: helper output -> cache -> the row's reason; the scan repaints", async () => {
  let asks = [];
  const h = setup(0, { scan: async () => out(asks), cards: [blockedCard] });
  h.agentsList.push({ address: "t9", status: "blocked" }); h.terminalsList.push({ address: "t9" });
  h.tick();
  assert.equal(h.t.cache.get().rows.get("T-B").reason, "Agent asks: open its terminal", "no ask yet: fallback");
  asks = [{ terminal: "t9", id: 3, kind: "question", tool: "AskUserQuestion", at: Date.now() }];
  const before = h.calls.notified ?? 0;
  await until(() => { h.tick(); return h.t.cache.get().rows.get("T-B").reason === "Question for you"; }, "reason from the helper");
  assert.ok((h.calls.notified ?? 0) > before, "a repaint was requested");
  const text = render(h.t, h.cx).texts.join("|");
  assert.match(text, /Question for you/);
  asks = [];
  await until(() => { h.tick(); return h.t.cache.get().rows.get("T-B").reason === "Agent asks: open its terminal"; }, "ask cleared with its file");
});

test("one scan in flight: ticks while it runs start no second; a failed or non-JSON scan changes nothing and recovers", async () => {
  let mode = "hang", release;
  const h = setup(0, { cards: [blockedCard], scan: () => (mode === "hang" ? new Promise((r) => { release = r; }) : mode === "bad" ? Promise.resolve({ code: 1, stdout: "", stderr: "" }) : mode === "junk" ? Promise.resolve({ code: 0, stdout: "not json", stderr: "" }) : Promise.resolve(out([{ terminal: "t9", id: 3, kind: "plan", tool: "ExitPlanMode", at: Date.now() }]))) });
  h.agentsList.push({ address: "t9", status: "blocked" }); h.terminalsList.push({ address: "t9" });
  await until(() => asksExecs(h).length === 1, "started");
  for (let i = 0; i < 3; i++) { h.tick(); await drain(2); }
  assert.equal(asksExecs(h).length, 1, "no second scan while one is in flight");
  mode = "ok"; release(out([{ terminal: "t9", id: 3, kind: "plan", tool: "ExitPlanMode", at: Date.now() }]));
  await until(() => { h.tick(); return h.t.cache.get().rows.get("T-B").reason === "Plan to approve"; }, "recovered");
  for (const m of ["bad", "junk"]) { mode = m; h.tick(); await drain(5); h.tick(); assert.equal(h.t.cache.get().rows.get("T-B").reason, "Plan to approve", `${m}: unknown scan changes nothing`); }
  mode = "ok"; await until(() => { h.tick(); return asksExecs(h).length > 3; }, "scans continue after errors");
  assert.equal(h.t.cache.get().rows.get("T-B").reason, "Plan to approve");
});

test("a scan that never settles is abandoned after the deadline; the in-flight guard is released and a late answer is ignored", async () => {
  const resolvers = [];
  const h = setup(0, { cards: [blockedCard], scan: () => new Promise((r) => resolvers.push(r)) });
  h.agentsList.push({ address: "t9", status: "blocked" }); h.terminalsList.push({ address: "t9" });
  await until(() => resolvers.length === 1, "first scan");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10000; // the host's timeout never fired: the reader's own guard lets go
    h.tick();
    await until(() => resolvers.length === 2, "a new scan after the deadline");
  } finally { Date.now = realNow; }
  resolvers[0](out([{ terminal: "t9", id: 9, kind: "plan", tool: "ExitPlanMode", at: Date.now() }])); // the abandoned scan answers late
  await drain(10); h.tick();
  assert.equal(h.t.cache.get().rows.get("T-B").reason, "Agent asks: open its terminal", "a late answer of an abandoned scan is ignored");
  resolvers[1](out([{ terminal: "t9", id: 4, kind: "question", tool: "AskUserQuestion", at: Date.now() }]));
  await until(() => { h.tick(); return h.t.cache.get().rows.get("T-B").reason === "Question for you"; }, "the new scan counts");
});

test("a disabled Tasks screen starts no scan; enabling it later starts one", async () => {
  const h = setup(1, { tasksSettings: { enabled: false } });
  h.tick(); await drain(5);
  assert.equal(asksExecs(h).length, 0);
  C.setSettings("drover-tasks", {});
  h.tick();
  await until(() => asksExecs(h).length === 1, "scan once enabled");
});

for (const n of [3, 30, 300]) {
  test(`render, ${n} cards, asks present: cold and warm render have no side effects (exec, hc, fs, timers, host lists)`, async () => {
    const cards = Array.from({ length: n }, (_, i) => card(i + 1, i === 0 ? { column: "doing", agent: "t9" } : {}));
    const h = setup(0, { cards, scan: async () => out([{ terminal: "t9", id: 3, kind: "permission", tool: "Edit", at: Date.now() }]) });
    h.agentsList.push({ address: "t9", status: "blocked" }); h.terminalsList.push({ address: "t9" });
    await until(() => { h.tick(); return h.t.cache.get().rows.get("T-1").reason === "Asks permission · Edit"; }, "ask in the cache");
    await drain(5);
    const cold = delta(h.calls, () => render(h.t, h.cx));
    assert.match(cold.out.texts.join("|"), /Asks permission · Edit/);
    assert.deepEqual(cold.d, none, "cold render");
    assert.deepEqual(delta(h.calls, () => render(h.t, h.cx)).d, none, "warm render");
  });
}

test("render: shared-key reads per render do not depend on the card count, with an ask present", async () => {
  const seen = [];
  for (const n of [3, 30, 300]) {
    const cards = Array.from({ length: n }, (_, i) => card(i + 1, i === 0 ? { column: "doing", agent: "t9" } : {}));
    const h = setup(0, { cards, scan: async () => out([{ terminal: "t9", id: 3, kind: "permission", tool: "Edit", at: Date.now() }]) });
    h.agentsList.push({ address: "t9", status: "blocked" }); h.terminalsList.push({ address: "t9" });
    await until(() => { h.tick(); return h.t.cache.get().rows.get("T-1").reason === "Asks permission · Edit"; }, "ask");
    const reads = {};
    globalThis.__host.state = new Proxy(h.raw, { get(o, k) { if (typeof k === "string") reads[k] = (reads[k] ?? 0) + 1; return o[k]; }, set(o, k, v) { o[k] = v; return true; } });
    render(h.t, h.cx); for (const k in reads) delete reads[k]; render(h.t, h.cx);
    seen.push({ ...reads });
  }
  assert.deepEqual(seen[1], seen[0]); assert.deepEqual(seen[2], seen[0]);
});

test("the cache is invalidated when an ask appears: the signature changes and the screen is notified, render itself starts nothing", async () => {
  let asks = [];
  const h = setup(0, { cards: [blockedCard], scan: async () => out(asks) });
  h.agentsList.push({ address: "t9", status: "blocked" }); h.terminalsList.push({ address: "t9" });
  h.tick(); await drain(5);
  const sig = h.t.cache.signature();
  asks = [{ terminal: "t9", id: 5, kind: "plan", tool: "ExitPlanMode", at: Date.now() }];
  await until(() => { h.tick(); return h.t.cache.signature() !== sig; }, "signature");
  assert.equal(h.t.cache.get().rows.get("T-B").reason, "Plan to approve");
});

test("nothing answers: the new files contain no hc send/keys, no write/unlink/rename of the asks dir, no dialog input", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  for (const f of ["../_lib/asks.js", "../drover-tasks/bin/drover-asks-read.mjs", "../drover-tasks/bin/drover-asks-read"]) {
    assert.doesNotMatch(read(f), /\bhc\b.*\b(send|keys)\b|writeFile|writeTextFile|unlink|rename|rmSync|appendFile|\.send\(|sendKeys/, f);
  }
  const io = read("../_lib/io.js");
  const reader = io.slice(io.indexOf("// ---- The asks reader"), io.indexOf("// ---- The asks reader") + 4000);
  assert.ok(reader.length > 200, "the reader block exists");
  assert.doesNotMatch(reader.slice(0, reader.indexOf("// ---- end asks reader")), /writeTextFile|fs\.write|unlink|rename|hc\(|"send"|"keys"/);
});

test("round 1: a helper line with any entry the mod's allowlist rejects is an unknown scan (nothing is dropped as absence)", async () => {
  let reply = out([{ terminal: "t9", id: 3, kind: "plan", tool: "ExitPlanMode", at: Date.now() }]);
  const h = setup(0, { cards: [blockedCard], scan: async () => reply });
  h.agentsList.push({ address: "t9", status: "blocked" }); h.terminalsList.push({ address: "t9" });
  await until(() => { h.tick(); return h.t.cache.get().rows.get("T-B").reason === "Plan to approve"; }, "ask shown");
  const n = asksExecs(h).length;
  reply = out([{ terminal: "t9", id: 4, kind: "bogus", tool: "Bash", at: 1 }]); // the held terminal's own entry is rejected: not a clear
  await until(() => { h.tick(); return asksExecs(h).length >= n + 2; }, "the bad line was read");
  await drain(5); h.tick();
  assert.equal(h.t.cache.get().rows.get("T-B").reason, "Plan to approve");
  reply = out([]); // a good, empty scan is a clear
  await until(() => { h.tick(); return h.t.cache.get().rows.get("T-B").reason === "Agent asks: open its terminal"; }, "clear");
});
