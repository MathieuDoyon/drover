// The project editor dialog (drover-projects ProjectEditor) against a fake host: Save validates repos, adds or edits, one close only.
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

const repo = mkdtempSync(join(tmpdir(), "proj-repo-"));
execFileSync("git", ["init", "-q", repo]);
const plain = mkdtempSync(join(tmpdir(), "proj-plain-"));

let host;
const cx = { timer: { after() {} }, notify() {} };
const open = (projectEdit, state = {}) => {
  host = globalThis.__host = {
    props: { overlay: "ov1", projectEdit }, state, notified: [], closeCalls: [], closeOverlay: (id) => host.closeCalls.push(id),
    exec: async (cmd, args, opts) => { try { execFileSync(cmd, args, { cwd: opts.cwd, stdio: "ignore" }); return { code: 0 }; } catch { return { code: 1 }; } },
  };
  return new ProjectEditor(cx);
};
const fill = (e, f) => { for (const [k, v] of Object.entries(f)) e[k].set_value(v); };
const projects = () => host.state["drover.projects"] ?? [];

test("New: a git repo and a folder are saved, the first repo is the default, the dialog closes once", async () => {
  const e = open(null);
  fill(e, { name: "Acme", repos: repo, folders: plain, branch: "" });
  await Promise.all([e.save(cx), e.save(cx)]);
  assert.equal(projects().length, 1);
  assert.deepEqual([projects()[0].repos, projects()[0].folders, projects()[0].branch], [[{ path: repo, default: true }], [plain], "main"]);
  assert.deepEqual(host.closeCalls, ["ov1"]);
});

test("New: a missing name, a non-git folder and a missing path each show an error and save nothing", async () => {
  for (const f of [{ name: " ", repos: repo }, { name: "A", repos: plain }, { name: "A", repos: `${repo}\n/no/such/dir` }]) {
    const e = open(null);
    fill(e, f);
    await e.save(cx);
    assert.ok(e.error, JSON.stringify(f));
    assert.equal(projects().length, 0);
    assert.deepEqual(host.closeCalls, []);
  }
});

test("Edit: fields start from the project; Save keeps the id", async () => {
  const state = {};
  let e = open(null, state);
  fill(e, { name: "Acme", repos: repo });
  await e.save(cx);
  const id = state["drover.projects"][0].id;
  e = open(id, state);
  assert.equal(e.name.value(), "Acme");
  fill(e, { name: "Acme 2", branch: "dev" });
  await e.save(cx);
  assert.deepEqual([projects()[0].id, projects()[0].name, projects()[0].branch], [id, "Acme 2", "dev"]);
});

test("Save during the git check keeps a project another dialog saved meanwhile", async () => {
  const state = {};
  const a = open(null, state);
  fill(a, { name: "A", repos: repo });
  await a.save(cx);
  const b = open(null, state);
  fill(b, { name: "B", repos: repo });
  const edit = open(state["drover.projects"][0].id, state);
  fill(edit, { name: "A2" });
  // B saves while the edit dialog's git check runs
  const pending = edit.save(cx);
  await b.save(cx);
  await pending;
  assert.deepEqual(projects().map((p) => p.name).sort(), ["A2", "B"]);
});

// --- title: click the id to copy; the Remote hint no longer says the cards are read-only ---
const NODE = Symbol.for("test.node");
const findNode = (n, id) => (n.id === id ? n : n.kids.map((k) => findNode(k, id)).find(Boolean));
const renderRec = (e, c) => { globalThis.__rec = { ids: [], texts: [] }; try { const root = e.render(c); return { root: root[NODE], texts: globalThis.__rec.texts }; } finally { globalThis.__rec = undefined; } };
const editOf = async () => {
  const state = {};
  const a = open(null, state);
  fill(a, { name: "Acme", repos: repo });
  await a.save(cx);
  return open(state["drover.projects"][0].id, state);
};

test("Edit: clicking the id in the title copies it and shows Copied, then clears", async () => {
  const e = await editOf();
  const id = projects()[0].id;
  const clips = [], timers = [];
  const c = { notify() {}, timer: { after: (_ms, fn) => timers.push(fn) }, write_to_clipboard: (x) => clips.push(x) };
  let r = renderRec(e, c);
  const n = findNode(r.root, "copy-project-id");
  assert.ok(n?.args.on_click, "the id is clickable");
  assert.ok(!r.texts.includes("Copied"));
  n.args.on_click[0]({}, c);
  assert.deepEqual(clips, [id]);
  assert.ok(renderRec(e, c).texts.includes("Copied"), "feedback shown");
  timers[0](c);
  assert.ok(!renderRec(e, c).texts.includes("Copied"), "feedback clears");
});

test("New: the title has no copy target", () => {
  const e = open(null);
  assert.equal(findNode(renderRec(e, cx).root, "copy-project-id"), undefined);
});

test("Edit: the Remote hint does not claim cards are read-only", async () => {
  const e = await editOf();
  const t = renderRec(e, cx).texts.join(" ");
  assert.match(t, /Remote: machine/);
  assert.doesNotMatch(t, /read-only/i);
});
