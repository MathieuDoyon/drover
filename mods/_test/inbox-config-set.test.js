// Inbox protocol 5 (#70): `config-set` / `config-get` change ONE setting, drover-runs.max_parallel, on an agent's request.
// The consumer is the only place that validates (config.js); the exact allowlist lives there, not in the CLI. The consumer path runs for real.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const IO = await import("../_lib/io.js");
const S = await import("../_lib/store.js");
const C = await import("../_lib/config.js");
const R = await import("../_lib/runs.js");
const { buildPayload } = await import("../_lib/remote-write.js");

const CFG = "drover.config", KEY = "drover.tasks", MAXP = "drover-runs.max_parallel";
let home, inbox, host, sets, mod;
const roots = []; // every fixture root is registered the moment it is made and removed after the test, pass or fail
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
beforeEach(() => {
  C.resetCache();
  home = mkdtempSync(join(tmpdir(), "icfg-home-"));
  roots.push(home);
  inbox = join(home, "data/drover-inbox");
  mkdirSync(inbox, { recursive: true });
  mod = {}; // mods/<name>/mod.json settings by mod (the layer under the shared override)
  sets = [];
  const state = new Proxy({}, { set(o, k, v) { sets.push(k); o[k] = v; return true; } });
  host = globalThis.__host = { appHome: home, home: join(home, "h"), props: {}, notified: [], state, agents: [], terminals: [], watchFolder: () => new Promise(() => {}), exec: async () => ({ code: 0, stdout: "[]", stderr: "" }) };
  host.readTextFile = async (p) => { const m = /mods\/([^/]+)\/mod\.json$/.exec(p); return m && mod[m[1]] ? JSON.stringify({ settings: mod[m[1]] }) : null; };
  host.state[KEY] = S.add([], { title: "keep", column: "todo" }).tasks;
  host.state["drover.projects"] = [];
  sets.length = 0;
});

const startLoop = () => { const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => Promise.resolve().then(() => fn(cx)).catch(() => {}) }; IO.watchInbox(cx); };
const answer = (name) => until(() => existsSync(join(inbox, `${name}.result`)) && readFileSync(join(inbox, `${name}.result`), "utf8"), `the inbox answered ${name}`);
let n = 0;
const send = async (cmd, { age = 0 } = {}) => {
  const name = `${Math.floor(Date.now() / 1000) - age}-${++n}`;
  const p = join(inbox, `${name}.json`);
  writeFileSync(p, typeof cmd === "string" ? cmd : JSON.stringify(cmd));
  if (age) { const t = Date.now() / 1000 - age; utimesSync(p, t, t); }
  startLoop();
  return answer(name);
};
const set = (value, extra = {}) => send({ op: "config-set", key: MAXP, value, from: "t9", ttlMs: 60000, ...extra });
const shared = () => host.state[CFG];
const written = () => sets.filter((k) => k !== "drover.inbox-seen");

test("set 4 writes the shared override, replies old -> new, changes no task and keeps other namespaces", async () => {
  host.state[CFG] = { "drover-jira": { site: "acme.atlassian.net" } };
  const tasks = JSON.stringify(host.state[KEY]);
  const r = await set(4);
  assert.equal(r, `ok: ${MAXP} 2 -> 4`);
  assert.deepEqual(shared(), { "drover-jira": { site: "acme.atlassian.net" }, "drover-runs": { max_parallel: 4 } });
  assert.deepEqual(written().filter((k) => k !== CFG), [], "only drover.config was written");
  assert.equal(JSON.stringify(host.state[KEY]), tasks);
});

test("0, 11, 2.5, a string, null, a list, a missing value: refused and nothing written", async () => {
  for (const [v, re] of [[0, /between 1 and 10/], [11, /between 1 and 10/], [-3, /between 1 and 10/], [2.5, /whole number/], ["4", /whole number/], ["x", /whole number/], [null, /whole number/], [[4], /whole number/], [undefined, /whole number/]]) {
    const r = await send(v === undefined ? { op: "config-set", key: MAXP, ttlMs: 60000 } : { op: "config-set", key: MAXP, value: v, ttlMs: 60000 });
    assert.match(r, /^error: /, JSON.stringify(v));
    assert.match(r, re, JSON.stringify(v));
  }
  assert.equal(shared(), undefined);
  assert.deepEqual(written(), []);
});

test("the allowlist is the consumer's: other keys, other mods and odd key shapes are refused from an injected file", async () => {
  host.state[CFG] = { "drover-runs": { kept: 300 } };
  sets.length = 0;
  const before = JSON.stringify(shared());
  for (const key of ["drover-jira.site", "drover-runs.kept", "drover-config.work_folder", "drover-runs.enabled", "drover-runs", "max_parallel", "__proto__.x", "drover-runs.max_parallel ", 7, null, ["drover-runs", "max_parallel"], undefined]) {
    const r = await send({ op: "config-set", key, value: 4, ttlMs: 60000 });
    assert.match(r, /^error: /, String(key));
  }
  assert.equal(JSON.stringify(shared()), before);
  assert.deepEqual(written(), []);
});

test("a request without ttlMs is refused (a queued global write must expire); a bad or old one never applies", async () => {
  assert.match(await send({ op: "config-set", key: MAXP, value: 4 }), /^error: .*ttlMs/);
  assert.match(await send({ op: "config-set", key: MAXP, value: 4, ttlMs: "soon" }), /^error: bad ttlMs/);
  assert.match(await send({ op: "config-set", key: MAXP, value: 4, ttlMs: 60000 }, { age: 3600 }), /^error: expired/);
  assert.equal(shared(), undefined);
  assert.deepEqual(written(), []);
});

test("the same value is a no-op: ok, nothing written", async () => {
  host.state[CFG] = { "drover-runs": { max_parallel: 4 } };
  sets.length = 0;
  const r = await set(4);
  assert.equal(r, `ok: ${MAXP} is already 4`);
  assert.deepEqual(written(), []);
});

test("effective value: an inherited mod.json 7 is what is reported and replaced; set 2 over an inherited 7 WRITES the override", async () => {
  mod["drover-runs"] = { max_parallel: 7 };
  assert.match(await send({ op: "config-get", key: MAXP }), /^ok: drover-runs\.max_parallel 7 /);
  const r = await set(2); // equals the schema default but not the effective value
  assert.equal(r, `ok: ${MAXP} 7 -> 2`);
  assert.deepEqual(shared(), { "drover-runs": { max_parallel: 2 } });
  // now an override equal to the request exists: no-op
  sets.length = 0;
  assert.equal(await set(2), `ok: ${MAXP} is already 2`);
  assert.deepEqual(written(), []);
});

test("effective value: an absent or malformed override falls through to the layer below", async () => {
  mod["drover-runs"] = { max_parallel: 7 };
  for (const bad of [{ "drover-runs": { max_parallel: 99 } }, { "drover-runs": { max_parallel: "four" } }, { "drover-runs": null }, "junk", []]) {
    host.state[CFG] = bad;
    C.resetCache();
    assert.match(await send({ op: "config-get", key: MAXP }), /^ok: drover-runs\.max_parallel 7 /, JSON.stringify(bad));
  }
  host.state[CFG] = undefined;
  C.resetCache();
  mod["drover-runs"] = undefined;
  assert.match(await send({ op: "config-get", key: MAXP }), /^ok: drover-runs\.max_parallel 2 /, "no layer: the schema default");
});

test("config-get without a key lists exactly the agent-settable settings; an unknown key is refused", async () => {
  const r = await send({ op: "config-get" });
  assert.match(r, /^ok: /);
  const lines = r.split("\n").slice(1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^drover-runs\.max_parallel 2 /);
  assert.match(await send({ op: "config-get", key: "drover-jira.site" }), /^error: /);
  assert.deepEqual(written(), []);
});

test("the change is announced with the claimed requester; an unknown terminal is the address, an empty one is `unknown`", async () => {
  host.state["drover.runs"] = [{ id: "R1", terminals: [{ address: "t9", name: "T-1 Wrangler", agent: "wrangler" }] }];
  await set(3);
  assert.match(host.notified.at(-1).body, /drover-runs\.max_parallel 2 -> 3/);
  assert.match(host.notified.at(-1).body, /T-1 Wrangler/);
  assert.match(host.notified.at(-1).body, /unverified/);
  await set(5, { from: "" });
  assert.match(host.notified.at(-1).body, /requested by unknown/);
  const k = host.notified.length;
  await set(5); // no-op: no announcement
  assert.equal(host.notified.length, k);
});

test("two open mods that read the same file apply and announce it once", async () => {
  const name = `${Math.floor(Date.now() / 1000)}-dup`;
  writeFileSync(join(inbox, `${name}.json`), JSON.stringify({ op: "config-set", key: MAXP, value: 6, from: "t9", ttlMs: 60000 }));
  startLoop(); startLoop();
  assert.equal(await answer(name), `ok: ${MAXP} 2 -> 6`);
  await drain();
  assert.equal(host.notified.filter((x) => /max_parallel/.test(x.body)).length, 1);
});

test("end to end: 2 active runs hold the slots; set 4 admits another start without a restart; set 1 refuses more and kills nothing", async () => {
  const { projects } = S.addProject([], { name: "A", repos: "/a" }, 1);
  const A = projects[0];
  let tasks = S.add([], { title: "x", column: "todo", project: A.id }, 1000).tasks;
  const sq = (task, address) => ({ id: "R" + task, task, project: A.id, reportTo: "t81", started: 1, terminals: [{ address, agent: "wrangler" }] });
  const runs = [{ id: "Dt81", task: null, project: A.id, started: 1, terminals: [{ address: "t81", agent: "drover" }] }, sq("T-1", "t1"), sq("T-2", "t2")];
  const guard = () => R.startGuard({ tasks, runs, projects, live: new Map(), alive: new Set(["t81", "t1", "t2"]) }, { task: tasks[0].id, from: "t81" });
  await IO.loadPolicy("drover-runs");
  assert.match(guard().error, /no free slot/);
  assert.equal(await set(4), `ok: ${MAXP} 2 -> 4`);
  assert.deepEqual(guard(), { ok: true });
  assert.equal(await set(1), `ok: ${MAXP} 4 -> 1`);
  assert.match(guard().error, /no free slot/);
  assert.equal(runs.length, 3, "nothing was killed");
});

test("the refusal names the setting, the range, the per-project scope, the owner rule and the command", () => {
  const { projects } = S.addProject([], { name: "A", repos: "/a" }, 1);
  const tasks = S.add([], { title: "x", column: "todo", project: projects[0].id }, 1000).tasks;
  const sq = (task, address) => ({ id: "R" + task, task, project: projects[0].id, started: 1, terminals: [{ address, agent: "wrangler" }] });
  const runs = [{ id: "D", task: null, project: projects[0].id, started: 1, terminals: [{ address: "t81", agent: "drover" }] }, sq("T-1", "t1"), sq("T-2", "t2")];
  const e = R.startGuard({ tasks, runs, projects, live: new Map(), alive: new Set(["t81", "t1", "t2"]) }, { task: tasks[0].id, from: "t81" }).error;
  assert.match(e, /^no free slot: limit 2 reached/);
  for (const s of ["drover-runs.max_parallel", "1-10", "each project", "Only the owner", "drover config max-parallel <n>"]) assert.ok(e.includes(s), s);
});

test("a config-set is never forwarded to a remote machine: the remote writer's op list refuses it", () => {
  for (const op of ["config-set", "config-get"]) {
    const r = buildPayload({ op, key: MAXP, value: 9 }, { projectId: "P-R1", rev: 1 });
    assert.match(r.error, /not allowed/, op);
    assert.equal(r.json, undefined);
  }
});

test("no file is left behind: every request is consumed", async () => {
  await set(3);
  assert.deepEqual(readdirSync(inbox).filter((f) => f.endsWith(".json")), []);
});
