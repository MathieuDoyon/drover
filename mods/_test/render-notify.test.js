// The host forbids cx.notify() while a render runs. A screen switched off and on again restarts from its render
// (render -> ensureStarted): that restart must be deferred, never notify synchronously. The stub cx throws like the host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], home: "/h", exec: async () => ({ code: 0, stdout: "[]", stderr: "" }), readTextFile: async () => null };
const { default: Jira } = await import(new URL("../drover-jira/main.js", import.meta.url).href);
const { default: GitHub } = await import(new URL("../drover-github/main.js", import.meta.url).href);
const { default: Reader } = await import(new URL("../drover-reader/main.js", import.meta.url).href);
const { default: Room } = await import(new URL("../drover-room/main.js", import.meta.url).href);
const { default: Agents } = await import(new URL("../drover-agents/main.js", import.meta.url).href);
const { InputState } = await import(new URL("./stubs/gpui-base.js", import.meta.url).href);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const C = await import("../_lib/config.js");

let flight = { n: 0 };
const idle = () => until(() => flight.n === 0, "nothing in flight");

function patchInput(input) {
  input.tokens = [];
  input.content = () => ({ text: input.v, tokens: input.tokens.map((s) => ({ range: { ...s.range }, token: { ...s.token } })) });
  input.set_value = (v) => { if (typeof v === "string") { input.v = v; input.tokens = []; } else { input.v = v.text; input.tokens = v.tokens; } };
  input.replace_range_with_token = () => {};
}

// A cx that, like the host, refuses notify() while render() runs.
function rig(Screen, mod, { state = {}, setup } = {}) {
  C.resetCache();
  Object.assign(globalThis.__host, { state: { "drover.config": { [mod]: { site: "acme.atlassian.net" } }, ...state }, notified: [] });
  globalThis.__host.readTextFile = async (p) => (String(p).endsWith("atlassian.json") ? JSON.stringify({ email: "a@example.test", apiToken: "fake" }) : null);
  const fetches = [];
  globalThis.fetch = async (url, init) => { fetches.push(String(url)); return { ok: true, status: 200, url: String(url), json: async () => ({ issues: [], isLast: true }) }; };
  const execs = [];
  globalThis.__host.exec = async (cmd, args) => { execs.push({ cmd, args }); return { code: 0, stdout: "[]", stderr: "" }; };
  setup?.();
  const mine = flight = { n: 0 };
  const state2 = { rendering: false, notifies: 0, errors: [] };
  const cx = {
    notify() { if (state2.rendering) throw new Error("cx.notify() is not allowed during the render phase"); state2.notifies++; },
    spawn: (fn) => { mine.n++; Promise.resolve().then(() => fn(cx)).catch((e) => state2.errors.push(String(e))).finally(() => { mine.n--; }); },
    timer: { every() {}, after() {} },
    stop_propagation() {},
  };
  const origNew = InputState.new;
  InputState.new = function (o) { const s = origNew.call(this, o); patchInput(s); return s; };
  const view = new Screen();
  try { view.init({}, cx); } finally { InputState.new = origNew; }
  const render = () => { state2.rendering = true; try { return view.render(cx); } finally { state2.rendering = false; } };
  const set = (enabled) => { globalThis.__host.state["drover.config"] = { ...globalThis.__host.state["drover.config"], [mod]: { ...globalThis.__host.state["drover.config"][mod], enabled } }; };
  return { view, cx, render, set, fetches, execs, state: state2 };
}

async function offThenOn(r) {
  await idle();
  r.render();
  r.set(false);
  r.render();
  r.set(true);
  assert.doesNotThrow(() => r.render(), /render phase/); // the re-enable render
  await idle();
  assert.deepEqual(r.state.errors, []);
}

test("Jira: off then on, render never notifies, and the list reloads", async () => {
  const r = rig(Jira, "drover-jira");
  await idle();
  const before = r.fetches.length;
  assert.ok(before >= 1, "first load");
  await offThenOn(r);
  assert.ok(r.fetches.length > before, "the list reloaded after the re-enable");
});

test("Jira: re-enable with no site never notifies from render either", async () => {
  const r = rig(Jira, "drover-jira", { state: { "drover.config": { "drover-jira": { site: "" } } } });
  await offThenOn(r);
});

test("GitHub: off then on, render never notifies, and the search reloads", async () => {
  const r = rig(GitHub, "drover-github", { state: { "drover.config": { "drover-github": {} }, "drover.github.scopes": ["o/r"] } });
  await idle();
  const before = r.execs.filter((e) => e.cmd === "gh").length;
  assert.ok(before >= 1, "first search");
  await offThenOn(r);
  assert.ok(r.execs.filter((e) => e.cmd === "gh").length > before, "the search reloaded after the re-enable");
});

test("Reader: off then on, render never notifies (no agent to read)", async () => {
  const r = rig(Reader, "drover-reader", { state: { "drover.config": { "drover-reader": {} } } });
  await offThenOn(r);
});

test("Room: off then on, render never notifies", async () => {
  const r = rig(Room, "drover-room", { state: { "drover.config": { "drover-room": {} } } });
  await offThenOn(r);
});

test("Agents (Squads screen): off then on, render never notifies", async () => {
  const r = rig(Agents, "drover-agents", { state: { "drover.config": { "drover-agents": {} } } });
  await offThenOn(r);
});
