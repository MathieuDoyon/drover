// The Config dialog: General group with an enum picker for the work folder, and the never-automatic move offer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: { overlay: "o1" }, state: {}, notified: [], readTextFile: async () => null, appHome: "/app", home: "/home/u" };
const { default: Config } = await import(new URL("../drover-config/main.js", import.meta.url).href);
const { NODE } = await import(new URL("./stubs/el.js", import.meta.url).href);
const findNode = (n, id) => (n.id === id ? n : n.kids.map((k) => findNode(k, id)).find(Boolean));
const KEY = "drover.config";
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const stored = () => globalThis.__host.state[KEY];

// mode: stored work_folder; repoFiles: files to create in <repo>/.drover. Returns the view and the helper calls.
async function open({ mode, repoFiles = [] } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "wfd-"));
  if (repoFiles.length) await fs.mkdir(path.join(repo, ".drover"));
  for (const f of repoFiles) await fs.writeFile(path.join(repo, ".drover", f), "x");
  const helper = [];
  const h = globalThis.__host;
  h.state = { [KEY]: mode ? { "drover-config": { work_folder: mode } } : {}, "drover.projects": [{ id: "P-1", name: "App", repos: [{ path: repo, default: true }], folders: [], branch: "main" }] };
  h.exec = async (cmd, args) => { helper.push([cmd, ...args]); return { code: 0, stdout: "moved 2, skipped 0\n" }; };
  const cx = { notify() {}, spawn(fn) { return Promise.resolve().then(() => fn(cx)); }, timer: { every() {} } };
  const view = new Config();
  view.init({}, cx);
  await settle();
  return { view, cx, repo, helper };
}
const rec = async (fn) => { globalThis.__rec = { ids: [], texts: [], inputs: [] }; try { return await fn(); } finally { globalThis.__rec = undefined; } };
const root = (view, cx) => view.render(cx)[NODE];

test("General is the first group and holds the work folder as an enum row", async () => {
  const { view } = await open();
  assert.deepEqual(view.mod, "drover-config");
  const row = view.rowOf("drover-config", "work_folder");
  assert.equal(row.type, "enum");
  assert.equal(row.value, "project");
  assert.equal(view.inputs.has("drover-config/work_folder"), false, "no text input for an enum");
});

test("picker: one button per option; a click saves that option as an override; the current one does nothing", async () => {
  const { view, cx } = await open();
  await rec(async () => {
    for (const o of ["repo", "project"]) assert.ok(findNode(root(view, cx), `opt-drover-config/work_folder-${o}`), o);
    findNode(root(view, cx), "opt-drover-config/work_folder-project").args.on_click[0]({}, cx);
    assert.deepEqual(stored(), {}, "clicking the current option is not a change");
    findNode(root(view, cx), "opt-drover-config/work_folder-repo").args.on_click[0]({}, cx);
    assert.deepEqual(stored(), { "drover-config": { work_folder: "repo" } });
    assert.equal(view.rowOf("drover-config", "work_folder").value, "repo");
    view.reset("drover-config", "work_folder", cx);
    assert.deepEqual(stored(), {});
  });
});

test("project mode with files in <repo>/.drover: an offer shows, and nothing moves by itself", async () => {
  const { view, cx, helper } = await open({ mode: "project", repoFiles: ["lane.md", "plan.md"] });
  assert.equal(view.offers.length, 1);
  assert.equal(view.offers[0].count, 2);
  await rec(async () => {
    const r = root(view, cx);
    assert.ok(findNode(r, "offer-P-1"));
    assert.ok(findNode(r, "move-P-1"));
    assert.equal(findNode(r, "move-confirm-P-1"), undefined);
  });
  await settle();
  assert.deepEqual(helper, [], "the helper is never called without the confirm click");
});

test("Move… only asks; Cancel backs out; the confirm Move runs the helper once with from and to", async () => {
  const { view, cx, helper, repo } = await open({ mode: "project", repoFiles: ["lane.md"] });
  await rec(async () => {
    findNode(root(view, cx), "move-P-1").args.on_click[0]({}, cx);
    assert.equal(view.confirm, "P-1");
    assert.deepEqual(helper, []);
    root(view, cx); // render the confirm state
    assert.ok(globalThis.__rec.texts.some((t) => /Nothing is overwritten/.test(t)), "confirm text shown");
    findNode(root(view, cx), "move-cancel-P-1").args.on_click[0]({}, cx);
    assert.equal(view.confirm, null);
    assert.deepEqual(helper, []);
    findNode(root(view, cx), "move-P-1").args.on_click[0]({}, cx);
    findNode(root(view, cx), "move-confirm-P-1").args.on_click[0]({}, cx);
  });
  await settle();
  assert.deepEqual(helper, [["/app/mods/drover-agents/bin/drover-workfolder", "move", `${repo}/.drover`, "/home/u/.config/drover-herdr/work/P-1", "--root", "/home/u/.config/drover-herdr"]]);
  assert.equal(view.moveMsg.get("P-1"), "Moved 2 files.");
  assert.equal(view.confirm, null);
});

test("a saved \"run\" (the removed mode) shows as project: the row is not blank and the offer shows", async () => {
  const { view } = await open({ mode: "run", repoFiles: ["a.md"] });
  const row = view.rowOf("drover-config", "work_folder");
  assert.equal(row.value, "project");
  assert.equal(view.offers.length, 1);
});

test("no offer in repo mode, or when <repo>/.drover is absent or empty", async () => {
  assert.deepEqual((await open({ mode: "repo", repoFiles: ["a.md"] })).view.offers, []);
  assert.deepEqual((await open({ mode: "project" })).view.offers, []);
});

test("switching the mode to project loads the offer", async () => {
  const { view, cx } = await open({ mode: "repo", repoFiles: ["a.md"] });
  assert.deepEqual(view.offers, []);
  view.commit("drover-config", "work_folder", "project", cx);
  await settle();
  assert.equal(view.offers.length, 1);
});

test("a description with line breaks draws one text row per line; one without stays a single row (work folder lists one line per choice)", async () => {
  const { view, cx } = await open();
  await rec(async () => {
    root(view, cx);
    const t = globalThis.__rec.texts;
    assert.ok(t.includes("Where agents write plans, scouts, reviews and lane logs. Applies to runs started after a change."));
    for (const o of ["project", "repo"]) assert.equal(t.filter((x) => x.startsWith(`${o} — `)).length, 1, o);
    assert.ok(!t.some((x) => x.includes("(default)")), "the Default line already says it");
    assert.ok(!t.some((x) => x.includes("\n")), "no row holds a line break");
  });
  const b = await open();
  b.view.mod = "drover-board";
  await rec(async () => {
    root(b.view, b.cx);
    assert.ok(globalThis.__rec.texts.includes("How each column sorts its cards. A column's own Sort menu choice wins while the board is open."));
  });
});
