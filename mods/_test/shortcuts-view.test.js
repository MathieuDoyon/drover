// The Shortcuts entry of drover-config against a fake host whose keys.json is a string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: { overlay: "o1" }, state: {}, notified: [], appHome: "/h" };
const { default: Config } = await import(new URL("../drover-config/main.js", import.meta.url).href);

const canon = (o) => JSON.stringify(o, null, 2) + "\n";
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

async function open(text) {
  const files = { "/h/keys.json": text };
  globalThis.__host.state = { "drover.config": {} };
  globalThis.__host.readTextFile = async (p) => files[p] ?? null;
  globalThis.__host.writeTextFile = async (p, t, expected) => {
    if ((files[p] ?? null) !== expected) throw new Error("stale");
    files[p] = t;
  };
  const cx = { notify() {}, spawn(fn) { return Promise.resolve().then(() => fn(cx)); }, timer: { every() {} } };
  const view = new Config();
  view.init({}, cx);
  await settle();
  return { view, files };
}

test("state is read from keys.json on open", async () => {
  const { view } = await open(canon({ "layout:drover": { "cmd-alt-b": { command: "layout.toggle", args: { id: "drover" } } }, global: {} }));
  assert.equal(view.keyState.get("sidebar").state, "on");
  assert.equal(view.keyState.get("newtask").state, "off");
});

test("flipping a switch writes the binding, backs up first, and re-reads", async () => {
  const text = canon({ global: { "cmd-b": "layout.toggle:sidebar" } });
  const { view, files } = await open(text);
  await view.flip(SHORTCUT("newtask"));
  await settle();
  assert.equal(view.keyState.get("newtask").state, "on");
  assert.equal(JSON.parse(files["/h/keys.json"]).global["cmd-shift-c"], "mod.open:drover-newtask");
  const bak = Object.keys(files).filter((k) => k.includes("keys.json.bak-"));
  assert.equal(bak.length, 1);
  assert.equal(files[bak[0]], text);
  await new Promise((r) => setTimeout(r, 3)); // backups are named by millisecond
  await view.flip(SHORTCUT("newtask"));
  assert.equal(view.keyState.get("newtask").state, "off");
  assert.equal(files["/h/keys.json"], text);
});

test("a conflicting key is refused: message shown, file untouched", async () => {
  const text = canon({ global: { "cmd-shift-c": "app.quit" } });
  const { view, files } = await open(text);
  assert.equal(view.keyState.get("newtask").state, "conflict");
  await view.flip(SHORTCUT("newtask"));
  assert.match(view.keyErrors.get("newtask"), /already bound.*app\.quit/);
  assert.equal(files["/h/keys.json"], text);
  assert.equal(Object.keys(files).length, 1);
});

test("a malformed keys.json is refused and untouched", async () => {
  const { view, files } = await open("{ nope");
  await view.flip(SHORTCUT("sidebar"));
  assert.match(view.keyErrors.get("sidebar"), /not valid JSON/);
  assert.equal(files["/h/keys.json"], "{ nope");
  assert.equal(Object.keys(files).length, 1);
});

test("render with the Shortcuts entry selected shows both switches", async () => {
  const { view, files } = await open(canon({ global: {} }));
  view.mod = "@shortcuts";
  globalThis.__rec = { ids: [], texts: [] };
  view.render({ notify() {} });
  const { ids, texts } = globalThis.__rec;
  globalThis.__rec = undefined;
  assert.ok(ids.includes("sw-sc-sidebar") && ids.includes("sw-sc-newtask") && ids.includes("mod-shortcuts"), ids.join());
  assert.ok(texts.some((x) => x.includes("cmd-alt-b")) && texts.some((x) => x.includes("cmd-shift-c")));
  void files;
});

import { SHORTCUTS } from "../_lib/keys.js";
function SHORTCUT(id) { return SHORTCUTS.find((s) => s.id === id); }

test("masked Drover binding: switch is ON with the warning; flipping removes only Drover's entry", async () => {
  const text = canon({ global: { "cmd-shift-c": "mod.open:drover-newtask" }, terminal: { "cmd-shift-c": "terminal.copy" } });
  const { view, files } = await open(text);
  const st = view.keyState.get("newtask");
  assert.deepEqual([st.installed, st.state], [true, "on"]);
  globalThis.__rec = { ids: [], texts: [] };
  view.mod = "@shortcuts";
  view.render({ notify() {} });
  const texts = globalThis.__rec.texts;
  globalThis.__rec = undefined;
  assert.ok(texts.some((x) => x.includes("terminal.copy")), "warning shown");
  await view.flip(SHORTCUT("newtask"));
  assert.deepEqual(JSON.parse(files["/h/keys.json"]), { global: {}, terminal: { "cmd-shift-c": "terminal.copy" } });
  assert.equal(view.keyState.get("newtask").installed, false);
});
