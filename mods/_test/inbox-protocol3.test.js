// Inbox protocol 3 (T-MWIA1D6HO84): edit carries priority, tags, assignee, parent and project in ONE update; add carries assignee.
// Strict, no coercion: a bad value changes nothing (no field, no rev bump). Omitted is not clear. The consumer path runs for real.
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
  home = mkdtempSync(join(tmpdir(), "iproto3-home-"));
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
const PROJ = "drover.projects", CFG = "drover.agents";
const projects = [
  { id: "P-A", name: "alpha", repos: [{ path: "/a", default: true }], folders: [], branch: "main" },
  { id: "P-B", name: "beta", repos: [{ path: "/b", default: true }], folders: [], branch: "main" },
  { id: "P-R", name: "remote", repos: [], folders: [], branch: "main", remote: { machine: "omarchy", projectId: "P-X" } },
];
// cards: a (P-A), p (P-A, parent candidate), o (P-B, other project), c (P-A, child of a)
const world = () => {
  host.state[PROJ] = projects;
  host.state[CFG] = { agents: [{ id: "wrangler", name: "Wrangler", command: "x", version: 1 }], squads: [{ id: "cattle-drive", name: "CD", leader: "wrangler", members: [], version: 1 }] };
  let t = [];
  for (const [title, project] of [["a", "P-A"], ["p", "P-A"], ["o", "P-B"], ["c", "P-A"]]) t = S.add(t, { title, column: "todo", project }).tasks;
  t = t.map((x) => (x.title === "c" ? { ...x, parent: t[0].id } : x));
  host.state[KEY] = t;
  return Object.fromEntries(t.map((x) => [x.title, x.id]));
};

test("probe answers ok: protocol 4", async () => {
  assert.equal(S.PROTOCOL, 4);
  assert.equal(await send({ op: "protocol" }), "ok: protocol 4");
});

test("edit sets priority, tags, assignee, parent and project in ONE update (+1 rev)", async () => {
  const id = world();
  const rev = S.revOf(card(id.a));
  const r = await send({ op: "edit", id: id.a, title: "A2", desc: "d", priority: "P0", tags: ["#Foo", "bar", "foo"], assignee: { kind: "squad", id: "cattle-drive" }, parent: id.p, project: "alpha", ifRev: rev });
  assert.match(r, /^ok: .* edited$/, r);
  const c = card(id.a);
  assert.deepEqual([c.title, c.desc, c.priority, c.tags, c.assignee, c.parent, c.project], ["A2", "d", "P0", ["foo", "bar"], { kind: "squad", id: "cattle-drive" }, id.p, "P-A"]);
  assert.equal(S.revOf(c), rev + 1);
});

test("edit by project name moves the card; none clears project, assignee and parent; omitted fields stay", async () => {
  const id = world();
  assert.match(await send({ op: "edit", id: id.c, project: "beta", parent: "none" }), /^ok:/);
  assert.equal(card(id.c).project, "P-B");
  assert.equal(card(id.c).parent, null);
  assert.match(await send({ op: "edit", id: id.a, assignee: { kind: "agent", id: "wrangler" } }), /^ok:/);
  const keep = card(id.a);
  assert.match(await send({ op: "edit", id: id.a, priority: "P1" }), /^ok:/);
  assert.deepEqual(card(id.a).assignee, keep.assignee, "omitted assignee is not cleared");
  assert.deepEqual(card(id.a).tags, keep.tags);
  assert.match(await send({ op: "edit", id: id.a, assignee: "none", project: "none", tags: [] }), /^ok:/);
  assert.equal(card(id.a).assignee, null);
  assert.equal(card(id.a).project, null);
  assert.deepEqual(card(id.a).tags, []);
});

const BAD = (id) => [
  ["priority P9", { priority: "P9" }, /priority/i],
  ["priority number", { priority: 1 }, /priority/i],
  ["tags a string", { tags: "a,b" }, /tags/i],
  ["tags with a non-string", { tags: ["ok", { x: 1 }] }, /tags/i],
  ["assignee bad kind", { assignee: { kind: "robot", id: "wrangler" } }, /assignee/i],
  ["assignee a string", { assignee: "wrangler" }, /assignee/i],
  ["assignee unknown agent", { assignee: { kind: "agent", id: "ghost" } }, /ghost/],
  ["assignee unknown squad", { assignee: { kind: "squad", id: "ghost" } }, /ghost/],
  ["assignee agent id in the squad slot", { assignee: { kind: "squad", id: "wrangler" } }, /wrangler/],
  ["parent missing", { parent: "T-NOPE" }, /not found/],
  ["parent in another project", { parent: id.o }, /project/i],
  ["parent itself", { parent: id.a }, /own parent/],
  ["parent cycle", { parent: id.c }, /cycle/],
  ["parent not a string", { parent: 5 }, /parent/i],
  ["project unknown", { project: "nope" }, /no project/],
  ["project not a string", { project: 5 }, /project/i],
  ["project owned by another machine", { project: "remote" }, /omarchy/],
];
test("a bad value changes nothing: no field, no rev bump, in any field order", async () => {
  const id = world();
  const good = { title: "NEW", desc: "NEWD", priority: "P0", tags: ["zzz"], assignee: { kind: "agent", id: "wrangler" } };
  for (const [label, bad, re] of BAD(id)) {
    for (const order of ["bad-first", "bad-last"]) {
      const before = snap(), proj = JSON.stringify(host.state[PROJ]);
      const rest = Object.fromEntries(Object.entries(good).filter(([k]) => !(k in bad))); // the bad key keeps its place: first or last in the JSON
      const body = order === "bad-first" ? { ...bad, ...rest } : { ...rest, ...bad };
      const r = await send({ op: "edit", id: id.a, ...body });
      assert.match(r, /^error: /, `${label} ${order}: ${r}`);
      assert.match(r, re, `${label} ${order}: ${r}`);
      assert.equal(snap(), before, `${label} ${order}: tasks byte-equal`);
      assert.equal(JSON.stringify(host.state[PROJ]), proj);
    }
  }
});

test("a card kept in a remote-owned project cannot be edited, even with only a priority", async () => {
  const id = world();
  host.state[KEY] = tasks().map((t) => (t.id === id.a ? { ...t, project: "P-R" } : t));
  const before = snap();
  assert.match(await send({ op: "edit", id: id.a, priority: "P1" }), /^error: .*omarchy/);
  assert.equal(snap(), before);
});

test("an edit with no field at all is refused and names the new fields", async () => {
  const id = world();
  const before = snap();
  const r = await send({ op: "edit", id: id.a });
  assert.match(r, /^error: Nothing to edit/);
  assert.match(r, /priority/);
  assert.equal(snap(), before);
});

test("ifRev: a stale edit with the new fields is still refused and changes nothing", async () => {
  const id = world();
  const before = snap();
  const r = await send({ op: "edit", id: id.a, priority: "P0", ifRev: S.revOf(card(id.a)) + 3 });
  assert.match(r, /^error: stale: /);
  assert.equal(snap(), before);
});

test("add carries a validated assignee; none/null/omitted add no assignee; a bad one adds nothing", async () => {
  world();
  const n0 = tasks().length;
  assert.match(await send({ op: "add", title: "x1", project: "alpha", assignee: { kind: "agent", id: "wrangler" } }), /^ok: /);
  assert.deepEqual(tasks().at(-1).assignee, { kind: "agent", id: "wrangler" });
  assert.match(await send({ op: "add", title: "x2", project: "alpha", assignee: null }), /^ok: /);
  assert.match(await send({ op: "add", title: "x3", project: "alpha", assignee: "none" }), /^ok: /);
  assert.match(await send({ op: "add", title: "x4", project: "alpha" }), /^ok: /);
  assert.deepEqual(tasks().slice(-3).map((t) => t.assignee), [null, null, null]);
  const n = tasks().length;
  for (const bad of [{ kind: "agent", id: "ghost" }, { kind: "robot", id: "wrangler" }, "wrangler", { kind: "squad", id: "wrangler" }]) {
    assert.match(await send({ op: "add", title: "bad", project: "alpha", assignee: bad }), /^error: .*assignee|^error: .*ghost|^error: .*wrangler/i, JSON.stringify(bad));
  }
  assert.equal(tasks().length, n);
  assert.equal(n, n0 + 4);
});

test("add with a parent in another project is refused", async () => {
  const id = world();
  const n = tasks().length;
  assert.match(await send({ op: "add", title: "kid", project: "alpha", parent: id.o }), /^error: .*project/i);
  assert.equal(tasks().length, n);
});

// ---- fix round 1 ----
test("a project change that would split parent and children is REFUSED, nothing changes (store)", () => {
  const ctx = { agents: [], squads: [] };
  let ts = []; for (const [title, project] of [["parent", "P-A"], ["kid", "P-A"], ["solo", "P-A"]]) ts = S.add(ts, { title, column: "todo", project }).tasks;
  const [p, k, o] = ts.map((x) => x.id);
  ts = ts.map((x) => (x.id === k ? { ...x, parent: p } : x));
  const before = JSON.stringify(ts);
  for (const [label, id] of [["child", k], ["parent with children", p]]) {
    const r = S.applyCommand(ts, { op: "edit", id, project: "P-B" }, 1, ctx);
    assert.match(r.error ?? "", /detach parent\/children first/, label);
  }
  assert.equal(JSON.stringify(ts), before);
  const ok = S.applyCommand(ts, { op: "edit", id: k, project: "P-B", parent: "none" }, 1, ctx);
  assert.equal(ok.task.project, "P-B"); assert.equal(ok.task.parent, null); assert.equal(S.revOf(ok.task), 1);
  assert.equal(S.applyCommand(ts, { op: "edit", id: o, project: "P-B" }, 1, ctx).task.project, "P-B", "a card with no relatives moves");
  const into = S.applyCommand(ts.map((x) => (x.id === o ? { ...x, project: "P-B" } : x)), { op: "edit", id: k, project: "P-B", parent: o }, 1, ctx);
  assert.equal(into.task.parent, o, "moving with a parent that is already in the destination is fine");
});

test("add validates supplied priority, tags and parent strictly: bad => error, nothing added; omitted/null/'' stay as the CLI sends them", async () => {
  const id = world();
  const n = tasks().length;
  for (const bad of [{ priority: "P9" }, { priority: 1 }, { tags: [{}] }, { tags: "a" }, { parent: 5 }, { parent: "T-NOPE" }]) {
    assert.match(await send({ op: "add", title: "bad", project: "alpha", ...bad }), /^error: /, JSON.stringify(bad));
  }
  assert.equal(tasks().length, n);
  assert.match(await send({ op: "add", title: "cli", project: "alpha", priority: "P2", tags: [], parent: "", assignee: null }), /^ok: /);
  assert.match(await send({ op: "add", title: "cli2", project: "alpha", priority: null, tags: null, parent: null }), /^ok: /);
  assert.match(await send({ op: "add", title: "good", project: "alpha", priority: "P0", tags: ["#X"], parent: id.p }), /^ok: /);
  assert.deepEqual([tasks().at(-1).priority, tasks().at(-1).tags, tasks().at(-1).parent], ["P0", ["x"], id.p]);
});
