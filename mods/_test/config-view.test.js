// The drover-config dialog against a fake host: inherited mod.json layer, explicit default override, stale retained inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: { overlay: "o1" }, state: {}, notified: [], readTextFile: async () => null, appHome: "/h" };
const { default: Config } = await import(new URL("../drover-config/main.js", import.meta.url).href);

const KEY = "drover.config";
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const { SCHEMA } = await import(new URL("../_lib/config-schema.js", import.meta.url).href);
const MODS = [...new Set(SCHEMA.map((f) => f.mod))];

// mod.json settings per mod, as modSettings() reads them: readTextFile(`<home>/mods/<mod>/mod.json`).
async function open({ shared = {}, settings = {} } = {}) {
  globalThis.__host.state = { [KEY]: shared };
  globalThis.__host.readTextFile = async (path) => {
    const mod = /mods\/([^/]+)\/mod.json$/.exec(path)?.[1];
    return settings[mod] ? JSON.stringify({ settings: settings[mod] }) : null;
  };
  const cx = { notify() {}, spawn(fn) { return Promise.resolve().then(() => fn(cx)); }, timer: { every() {} } };
  const view = new Config();
  view.init({}, cx);
  await until(() => MODS.every((m) => view.inherited.has(m)), "every mod.json layer loaded");
  view.render(cx); // a render refreshes clean inputs
  return { view, cx };
}
const stored = () => globalThis.__host.state[KEY];
const limit = (view) => view.rowOf("drover-github", "limit");
const input = (view, mod, key) => view.inputs.get(`${mod}/${key}`);

test("inherited limit=50 shows 50, with no override", async () => {
  const { view } = await open({ settings: { "drover-github": { limit: 50 } } });
  assert.equal(limit(view).text, "50");
  assert.equal(limit(view).changed, false);
  assert.equal(input(view, "drover-github", "limit").value(), "50");
});

test("typing 100 over an inherited 50 saves an explicit override; Reset shows 50 again", async () => {
  const { view, cx } = await open({ settings: { "drover-github": { limit: 50 } } });
  const i = input(view, "drover-github", "limit");
  i.set_value("100");
  i.handlers.submit({}, cx);
  assert.deepEqual(stored(), { "drover-github": { limit: 100 } });
  assert.equal(limit(view).changed, true);
  view.reset("drover-github", "limit", cx);
  assert.deepEqual(stored(), {});
  assert.equal(i.value(), "50");
  assert.equal(limit(view).text, "50");
});

test("an invalid draft is never written and shows an error", async () => {
  const { view, cx } = await open();
  const i = input(view, "drover-github", "limit");
  i.set_value("0");
  i.handlers.blur({}, cx);
  assert.deepEqual(stored(), {});
  assert.match(view.errors.get("drover-github/limit"), /1 to 1000/);
});

test("blur on an untouched input saves nothing", async () => {
  const { view, cx } = await open();
  input(view, "drover-github", "limit").handlers.blur({}, cx);
  assert.deepEqual(stored(), {});
});

test("a second dialog copy: an external change refreshes a clean input; blurring it does not overwrite", async () => {
  const a = await open();
  const b = await open(); // same shared state
  const ia = input(a.view, "drover-github", "limit");
  ia.set_value("25");
  ia.handlers.submit({}, a.cx);
  assert.deepEqual(stored(), { "drover-github": { limit: 25 } });
  const ib = input(b.view, "drover-github", "limit");
  assert.equal(ib.value(), "100"); // still stale until it paints
  b.view.render(b.cx);
  assert.equal(ib.value(), "25"); // clean input follows the shared value
  ib.handlers.blur({}, b.cx);
  assert.deepEqual(stored(), { "drover-github": { limit: 25 } });
});

test("a dirty draft is not overwritten by an external change", async () => {
  const a = await open();
  const b = await open();
  const ib = input(b.view, "drover-github", "limit");
  ib.set_value("77"); // typing, not saved yet
  const ia = input(a.view, "drover-github", "limit");
  ia.set_value("25");
  ia.handlers.submit({}, a.cx);
  b.view.render(b.cx);
  assert.equal(ib.value(), "77");
  ib.handlers.submit({}, b.cx);
  assert.deepEqual(stored(), { "drover-github": { limit: 77 } });
});

test("+ steps from the effective (inherited) value when the input is clean", async () => {
  const { view, cx } = await open({ settings: { "drover-github": { limit: 50 } } });
  view.step("drover-github", "limit", 1, cx);
  assert.deepEqual(stored(), { "drover-github": { limit: 51 } });
  assert.equal(input(view, "drover-github", "limit").value(), "51");
});

test("an invalid draft, then the original value restored, clears the red error without writing", async () => {
  const { view, cx } = await open();
  const i = input(view, "drover-github", "limit");
  i.set_value("0");
  i.handlers.blur({}, cx);
  assert.ok(view.errors.has("drover-github/limit"));
  i.set_value("100"); // back to the synced text
  i.handlers.submit({}, cx);
  assert.equal(view.errors.has("drover-github/limit"), false);
  assert.deepEqual(stored(), {});
  i.set_value("0");
  i.handlers.blur({}, cx);
  i.set_value("100");
  i.handlers.blur({}, cx); // blur clears it too
  assert.equal(view.errors.has("drover-github/limit"), false);
});

// The boolean row uses ui.js toggle(): on = foreground track + background knob, off = input track + muted knob.
const { NODE } = await import(new URL("./stubs/el.js", import.meta.url).href);
const findNode = (n, id) => (n.id === id ? n : n.kids.map((k) => findNode(k, id)).find(Boolean));
const THEME = { foreground: "FG", background: "BG", input: "IN", muted: "MU", solid: "SOLID", raised: "RA" };

test("boolean row: toggle colours come from the ui.js tokens, and a click flips the override", async () => {
  const { view, cx } = await open();
  globalThis.__host.theme = new Proxy(THEME, { get: (o, k) => o[k] ?? "#000" });
  globalThis.__rec = { ids: [], texts: [], inputs: [] };
  try {
    view.mod = "drover-board";
    const sw = () => findNode(view.render(cx)[NODE], "sw-drover-board/enabled");
    let n = sw();
    assert.ok(n, "toggle node rendered");
    assert.equal(n.args.bg[0], "FG");
    assert.equal(n.kids[0].args.bg[0], "BG");
    n.args.on_click[0]({}, cx); // enabled -> false
    assert.deepEqual(stored(), { "drover-board": { enabled: false } });
    n = sw();
    assert.equal(n.args.bg[0], "IN");
    assert.equal(n.kids[0].args.bg[0], "MU");
    n.args.on_click[0]({}, cx); // back on: an explicit override equal to the default
    assert.deepEqual(stored(), { "drover-board": { enabled: true } });
  } finally { globalThis.__rec = undefined; globalThis.__host.theme = undefined; }
});

test("the GitHub default query is checked before saving: an unusable one shows a red error and is never stored", async () => {
  const { view, cx } = await open();
  const i = input(view, "drover-github", "query");
  i.set_value("label:");
  i.handlers.submit({}, cx);
  assert.deepEqual(stored(), {});
  assert.match(view.errors.get("drover-github/query"), /Not a usable GitHub query/);
  i.set_value("is:pr label:bug");
  i.handlers.submit({}, cx);
  assert.deepEqual(stored(), { "drover-github": { query: "is:pr label:bug" } });
  assert.equal(view.errors.has("drover-github/query"), false);
});

// ---- card 6: squad and board defaults show in the dialog under their own mod ----
test("the dialog lists the squad and board defaults with their defaults", async () => {
  const { view } = await open();
  const row = (mod, key) => view.rowOf(mod, key);
  assert.equal(row("drover-agents", "default_squad").text, "");
  assert.equal(row("drover-agents", "default_worktree").value, false);
  assert.equal(row("drover-agents", "default_report").value, false);
  assert.equal(row("drover-board", "visible_columns").text, "backlog, todo, doing, review, blocked, done");
  assert.equal(row("drover-board", "default_sort").value, "manual");
  assert.ok(input(view, "drover-board", "visible_columns"), "the list is edited as text");
  assert.ok(input(view, "drover-agents", "default_squad"));
});

test("visible columns: a typed list saves; unknown ids and an empty list are rejected and never written", async () => {
  const { view, cx } = await open();
  const i = input(view, "drover-board", "visible_columns");
  i.set_value("todo, doing, review");
  i.handlers.submit({}, cx);
  assert.deepEqual(stored(), { "drover-board": { visible_columns: ["todo", "doing", "review"] } });
  i.set_value("");
  i.handlers.submit({}, cx);
  assert.deepEqual(stored(), { "drover-board": { visible_columns: ["todo", "doing", "review"] } }, "empty list not written");
  assert.match(view.errors.get("drover-board/visible_columns"), /at least one/i);
  i.set_value("todo, nope");
  i.handlers.submit({}, cx);
  assert.match(view.errors.get("drover-board/visible_columns"), /nope/);
  assert.deepEqual(stored()["drover-board"].visible_columns, ["todo", "doing", "review"]);
});

test("default sort is picked with buttons and saved", async () => {
  const { view, cx } = await open();
  view.commit("drover-board", "default_sort", "priority", cx);
  assert.deepEqual(stored(), { "drover-board": { default_sort: "priority" } });
});
