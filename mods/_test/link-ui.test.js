// Edit dialog S8: note hover actions (collapse, edit, copy, copy ID, sub-task, delete) on the activity cards.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { list } from "../_lib/store.js";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0 }) };
const { Editor } = await import(new URL("../drover-todos/main.js", import.meta.url).href);
const { NODE } = await import(new URL("./stubs/el.js", import.meta.url).href);

let host, work, errors;
const tick = () => new Promise((r) => setImmediate(r));
const flushAll = async () => { while (work.size) await Promise.allSettled([...work]); await tick(); };
const mkcx = () => {
  const cx = { notify() {}, stop_propagation() {}, timer: { after() {} },
    spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)).catch((e) => errors.push(e)).finally(() => work.delete(p)); work.add(p); } };
  return cx;
};
const T = (id, over = {}) => ({ id, title: id, desc: "", priority: "P2", tags: [], column: "todo", archived: false, agent: null, source: null, assignee: null, notes: [], run: null, created: 1, updated: 1, ...over });
const CFG = { agents: [{ id: "claude", name: "Claude", command: "claude", soul: "", instructions: "" }, { id: "codex", name: "Codex", command: "codex", soul: "", instructions: "" }], squads: [{ id: "s1", name: "Crew", leader: "claude", members: [] }] };
beforeEach(() => {
  work = new Set(); errors = [];
  host = globalThis.__host = { appHome: "/tmp/none", props: { overlay: "o", edit: "T-E", column: "todo" }, state: { "drover.agents": CFG }, notified: [], closeCalls: [], opened: [], terminals: [], exec: async () => ({ code: 0 }) };
  host.closeOverlay = (...a) => host.closeCalls.push(a);
  host.openOverlay = (o) => host.opened.push(o);
});
const seed = (main, others = []) => {
  host.state["drover.tasks"] = [T("T-E", main), ...others];
  const e = new Editor({ focus_handle: () => ({}), timer: { after() {} }, notify() {} });
  e.sent = []; e.started = [];
  e.sendToAgent = async (a, t) => { e.sent.push([a, t]); };
  e.launch = async (task, runner, opts) => { e.startedTask = task; e.started.push([task?.id, runner, opts]); return e.launchResult ?? { id: "R" }; };
  return e;
};
const render = (e) => {
  globalThis.__rec = { ids: [], texts: [], md: [], textareas: [] };
  const root = e.render({ notify() {}, listener: () => () => {} });
  const r = globalThis.__rec; globalThis.__rec = null;
  return { ...r, root: root[NODE] };
};
const find = (n, id) => (n.id === id ? n : n.kids.map((k) => find(k, id)).find(Boolean) ?? null);
const stored = () => list(host.state["drover.tasks"]).find((x) => x.id === "T-E"); // as load() reads it: ids backfilled


test("Source section: no source shows Link issue; a pasted URL links, a bad or taken one shows an error; linked shows Unlink", async () => {
  const e = seed({}, [T("T-O", { source: { kind: "github", id: "https://github.com/o/r/issues/9", url: "https://github.com/o/r/issues/9" } })]);
  const cx = mkcx();
  assert.ok(find(render(e).root, "src-link"), "Link issue action");
  assert.equal(find(render(e).root, "src-unlink"), null);
  assert.equal(await e.linkIssue(cx, "https://example.com/x"), false);
  assert.ok(e.linkError);
  assert.equal(await e.linkIssue(cx, "https://github.com/o/r/issues/9"), false);
  assert.match(e.linkError, /T-O/);
  assert.equal(stored().source, null);
  assert.equal(await e.linkIssue(cx, "https://github.com/o/r/issues/26"), true);
  assert.equal(stored().source.url, "https://github.com/o/r/issues/26");
  assert.equal(e.ctxRun, undefined, "the next render re-reads the source");
  assert.equal(e.ctx, null);
  assert.ok(find(render(e).root, "src-unlink"));
  assert.equal(await e.unlinkIssue(cx), true);
  assert.equal(stored().source, null);
});

test("Link/Unlink handlers run the async work on spawn's context, never on the event cx across an await", async () => {
  const e = seed({});
  let spawned = 0;
  const ev = { notify() { throw new Error("stale event cx"); }, spawn(fn) { spawned++; const acx = { notify() {} }; return fn(acx); } };
  e.srcUrl.set_value("https://github.com/o/r/issues/26");
  await e.startLink(ev);
  assert.equal(spawned, 1);
  assert.equal(stored().source.url, "https://github.com/o/r/issues/26");
  await e.startLink(ev, "none");
  assert.equal(stored().source, null);
  assert.equal(spawned, 2);
});
