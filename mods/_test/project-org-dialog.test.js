// The project dialog's Org field and Open lessons button (#57 L5): saved, cleared, validated; the button opens the org lessons.md and creates nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], closeCalls: [] };
const { ProjectEditor } = await import("../drover-projects/main.js");
const { NODE } = await import(new URL("./stubs/el.js", import.meta.url).href);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
const findNode = (n, id) => (n.id === id ? n : n.kids.map((k) => findNode(k, id)).find(Boolean));

const repo = mkdtempSync(join(tmpdir(), "org-repo-"));
execFileSync("git", ["init", "-q", repo]);
const HOME = "/home/u";
const LESSONS = (org) => `${HOME}/.config/drover-herdr/orgs/${org}/lessons.md`;

let host, cx;
// files: paths readTextFile finds. Returns the editor once its one-time existence read has finished.
async function open(projectEdit, { state = {}, files = [] } = {}) {
  host = globalThis.__host = {
    props: { overlay: "ov1", projectEdit }, state, notified: [], closeCalls: [], home: HOME, calls: [], reads: [],
    closeOverlay: (id) => host.closeCalls.push(id),
    readTextFile: async (p) => { host.reads.push(p); return files.includes(p) ? "# lessons\n" : null; },
    writeTextFile: async (...a) => { host.calls.push(["write", ...a]); },
    exec: async (cmd, args, opts) => {
      if (cmd === "open") { host.calls.push([cmd, ...args]); return { code: 0 }; }
      try { execFileSync(cmd, args, { cwd: opts?.cwd, stdio: "ignore" }); return { code: 0 }; } catch { return { code: 1 }; }
    },
  };
  cx = { timer: { after() {} }, notify() { cx.notified++; }, notified: 0, spawn(fn) { return Promise.resolve().then(() => fn(cx)); } };
  const e = new ProjectEditor(cx);
  if (projectEdit) await until(() => e.lessonsChecked === true, "the lessons check finished");
  return e;
}
const projects = () => host.state["drover.projects"] ?? [];
const savedWith = async (org) => {
  const state = {};
  const e = await open(null, { state });
  e.name.set_value("Acme"); e.repos.set_value(repo);
  if (org !== undefined) e.org.set_value(org);
  await e.save(cx);
  return { state, id: state["drover.projects"]?.[0]?.id };
};
const render = (e) => e.render(cx)[NODE];
const rec = (fn) => { globalThis.__rec = { ids: [], texts: [], inputs: [] }; try { return fn(); } finally { globalThis.__rec = undefined; } };
const openLessons = (e) => rec(() => findNode(render(e), "open-lessons"));

test("Org field: a slug is saved on a new project; blank saves no org key", async () => {
  const a = await savedWith("acme-1");
  assert.equal(a.state["drover.projects"][0].org, "acme-1");
  const b = await savedWith("  ");
  assert.equal("org" in b.state["drover.projects"][0], false);
});

test("Org field: blank clears an existing org", async () => {
  const { state, id } = await savedWith("acme-1");
  const e = await open(id, { state });
  assert.equal(e.org.value(), "acme-1");
  e.org.set_value("");
  await e.save(cx);
  assert.equal("org" in projects()[0], false);
  assert.deepEqual(host.closeCalls, ["ov1"]);
});

test("Org field: a bad slug shows the L3 error and saves nothing", async () => {
  const state = {};
  const e = await open(null, { state });
  e.name.set_value("Acme"); e.repos.set_value(repo); e.org.set_value("Bad Org");
  await e.save(cx);
  assert.match(e.error, /Org must be a slug/);
  assert.equal(projects().length, 0);
  assert.deepEqual(host.closeCalls, []);
});

test("Open lessons: file present -> enabled, one click runs open -t on the org lessons.md", async () => {
  const { state, id } = await savedWith("acme-1");
  const e = await open(id, { state, files: [LESSONS("acme-1")] });
  rec(() => { render(e); assert.ok(!globalThis.__rec.texts.includes("none yet")); });
  openLessons(e).args.on_click[0]({}, cx);
  await until(() => host.calls.length === 1, "open was called");
  assert.deepEqual(host.calls, [["open", "-t", LESSONS("acme-1")]]);
});

test("Open lessons: file absent -> disabled with 'none yet', a click does nothing", async () => {
  const { state, id } = await savedWith("acme-1");
  const e = await open(id, { state });
  rec(() => { render(e); assert.ok(globalThis.__rec.texts.some((t) => t.includes("none yet"))); });
  openLessons(e).args.on_click[0]({}, cx);
  await drain();
  assert.deepEqual(host.calls, []);
});

test("Open lessons: a project without an org, and a new project, are disabled", async () => {
  const { state, id } = await savedWith(undefined);
  const e = await open(id, { state, files: [LESSONS("acme-1")] });
  rec(() => { render(e); assert.ok(globalThis.__rec.texts.some((t) => t.includes("none yet"))); });
  openLessons(e).args.on_click[0]({}, cx);
  const n = await open(null, { files: [LESSONS("acme-1")] });
  n.org.set_value("acme-1");
  openLessons(n).args.on_click[0]({}, cx);
  await drain();
  assert.deepEqual(host.calls, []);
});

test("Open lessons: the Org input must equal the saved org: change or clear disables, restoring re-enables", async () => {
  const { state, id } = await savedWith("acme-1");
  const e = await open(id, { state, files: [LESSONS("acme-1"), LESSONS("other")] });
  for (const v of ["other", ""]) {
    e.org.set_value(v);
    openLessons(e).args.on_click[0]({}, cx);
    await drain();
    assert.deepEqual(host.calls, [], `org input ${JSON.stringify(v)}`);
  }
  e.org.set_value(" acme-1 ");
  openLessons(e).args.on_click[0]({}, cx);
  await until(() => host.calls.length === 1, "restored org opens again");
  assert.deepEqual(host.calls, [["open", "-t", LESSONS("acme-1")]]);
});

test("creates nothing: renders add no reads, and the only call is the one open", async () => {
  const { state, id } = await savedWith("acme-1");
  const e = await open(id, { state, files: [LESSONS("acme-1")] });
  const before = host.reads.length;
  render(e); render(e);
  assert.equal(host.reads.length, before, "render does no I/O");
  assert.deepEqual(host.reads.filter((p) => p.includes("lessons")), [LESSONS("acme-1")], "one existence read, on open");
  openLessons(e).args.on_click[0]({}, cx);
  await until(() => host.calls.length === 1, "open was called");
  await drain();
  assert.deepEqual(host.calls, [["open", "-t", LESSONS("acme-1")]], "no write, no other exec");
});

test("the existence read repaints when it finishes: first render dimmed, then a notify, then enabled", async () => {
  const { state, id } = await savedWith("acme-1");
  let release;
  const gate = new Promise((r) => { release = r; });
  host = globalThis.__host = { ...globalThis.__host, props: { overlay: "ov1", projectEdit: id }, state, readTextFile: async () => { await gate; return "# lessons\n"; }, calls: [], closeCalls: [] };
  cx = { timer: { after() {} }, notified: 0, notify() { cx.notified++; }, spawn(fn) { return Promise.resolve().then(() => fn(cx)); } };
  const e = new ProjectEditor(cx);
  rec(() => { render(e); assert.ok(globalThis.__rec.texts.some((t) => t.includes("none yet")), "dimmed before the read ends"); });
  assert.equal(cx.notified, 0);
  release();
  await until(() => cx.notified === 1, "a repaint was requested");
  rec(() => { render(e); assert.ok(!globalThis.__rec.texts.some((t) => t.includes("none yet")), "enabled after"); });
  assert.equal(e.lessonsReady(), true);
});

test("a dialog closed before the read ends is not repainted", async () => {
  const { state, id } = await savedWith("acme-1");
  let release;
  const gate = new Promise((r) => { release = r; });
  host = globalThis.__host = { ...globalThis.__host, props: { overlay: "ov1", projectEdit: id }, state, readTextFile: async () => { await gate; return "x"; }, calls: [], closeCalls: [], closeOverlay() {} };
  cx = { timer: { after() {} }, notified: 0, notify() { cx.notified++; }, spawn(fn) { return Promise.resolve().then(() => fn(cx)); } };
  const e = new ProjectEditor(cx);
  e.close();
  release();
  await until(() => e.lessonsChecked, "read finished");
  assert.equal(cx.notified, 0);
});
