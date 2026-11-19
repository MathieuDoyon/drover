// The agent dialog's Open lessons button (T-MWNWMZK4YBF): <config>/agents/<id>.lessons.md, looked for once at open, opened in the text editor, nothing created.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], closeCalls: [] };
const { default: Agents } = await import("../drover-agents/main.js");
const { NODE } = await import(new URL("./stubs/el.js", import.meta.url).href);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
(await import("../_lib/config.js")).setSettings("drover-agents", {});
const findNode = (n, id) => (n.id === id ? n : n.kids.map((k) => findNode(k, id)).find(Boolean));

const HOME = "/home/u";
const LESSONS = (id) => `${HOME}/.config/drover-herdr/agents/${id}.lessons.md`;
const BOT = { id: "bot", name: "Bot", command: "claude", instructions: "", version: 1, envLog: [] };

let host, cx;
// files: paths readTextFile finds. envFails: the env file read throws. lessonsFail: the lessons read throws.
async function open(agent, { files = [], envFails = false, lessonsFail = false, agents = [BOT] } = {}) {
  host = globalThis.__host = {
    props: { overlay: "ov1", agent }, state: { "drover.agents": { agents, squads: [] } }, notified: [], closeCalls: [], home: HOME, calls: [], reads: [],
    closeOverlay: (id) => host.closeCalls.push(id),
    readTextFile: async (p) => {
      host.reads.push(p);
      if (p.endsWith(".lessons.md")) { if (lessonsFail) throw new Error("denied"); return files.includes(p) ? "# lessons\n" : null; }
      if (envFails) throw new Error("env denied");
      return null;
    },
    exec: async (cmd, args) => { host.calls.push([cmd, ...args]); return { code: 0 }; },
  };
  cx = { timer: { after() {}, every() {} }, notify() { cx.notified++; }, notified: 0, stop_propagation() {}, spawn(fn) { return Promise.resolve().then(() => fn(cx)); } };
  const v = new Agents();
  v.init({}, cx);
  await until(() => v.dialog.lessonsChecked === true, "the lessons check finished");
  return v.dialog;
}
const rec = (fn) => { globalThis.__rec = { ids: [], texts: [], inputs: [] }; try { return fn(); } finally { globalThis.__rec = undefined; } };
const render = (e) => e.render(cx)[NODE];
const button = (e) => rec(() => findNode(render(e), "open-lessons"));
const texts = (e) => rec(() => { render(e); return globalThis.__rec.texts.slice(); });
const click = (e) => button(e).args.on_click[0]({}, cx);

test("file present -> enabled, one click runs open -t on agents/<id>.lessons.md", async () => {
  const e = await open("bot", { files: [LESSONS("bot")] });
  assert.equal(e.lessonsReady(), true);
  assert.ok(!texts(e).some((t) => t.includes("none yet")));
  click(e);
  await until(() => host.calls.length === 1, "open was called");
  assert.deepEqual(host.calls, [["open", "-t", LESSONS("bot")]]);
});

test("file absent -> disabled with 'none yet', a click opens nothing", async () => {
  const e = await open("bot");
  assert.equal(e.lessonsReady(), false);
  assert.ok(texts(e).some((t) => t === "none yet"));
  click(e);
  await drain();
  assert.deepEqual(host.calls, []);
});

test("a new agent is disabled with 'save the agent first' and reads nothing", async () => {
  const e = await open(null, { files: [LESSONS("bot")] });
  assert.equal(e.lessonsReady(), false);
  assert.ok(texts(e).some((t) => t === "none yet (save the agent first)"));
  click(e);
  await drain();
  assert.deepEqual(host.calls, []);
  assert.equal(host.reads.filter((p) => p.includes("lessons")).length, 0);
});

test("one read at open, none during renders, a file that appears later does not enable it", async () => {
  const files = [];
  const e = await open("bot", { files });
  const reads = () => host.reads.filter((p) => p === LESSONS("bot")).length;
  assert.equal(reads(), 1);
  files.push(LESSONS("bot"));
  render(e); render(e); render(e);
  await drain();
  assert.equal(reads(), 1);
  assert.equal(e.lessonsReady(), false);
});

test("an id with unsafe characters gives no path: disabled, nothing read", async () => {
  const e = await open(".hidden", { files: [LESSONS(".hidden")], agents: [{ ...BOT, id: ".hidden" }] });
  assert.equal(e.lessonsReady(), false);
  click(e);
  await drain();
  assert.deepEqual(host.calls, []);
  assert.equal(host.reads.filter((p) => p.includes("lessons")).length, 0);
});

test("the env read failing does not disable an existing lessons file", async () => {
  const e = await open("bot", { files: [LESSONS("bot")], envFails: true });
  assert.equal(e.lessonsReady(), true);
  click(e);
  await until(() => host.calls.length === 1, "open was called");
  assert.deepEqual(host.calls, [["open", "-t", LESSONS("bot")]]);
});

test("a rejected lessons read leaves the dialog usable and the button disabled", async () => {
  const e = await open("bot", { lessonsFail: true });
  assert.equal(e.lessonsReady(), false);
  assert.doesNotThrow(() => render(e));
  click(e);
  await drain();
  assert.deepEqual(host.calls, []);
});

test("the repaint comes when the read ends", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  host = globalThis.__host = { props: { overlay: "ov1", agent: "bot" }, state: { "drover.agents": { agents: [BOT], squads: [] } }, notified: [], closeCalls: [], home: HOME, calls: [], reads: [], closeOverlay() {},
    readTextFile: async (p) => { if (p.endsWith(".lessons.md")) { await gate; return "x"; } return null; }, exec: async () => ({ code: 0 }) };
  cx = { timer: { after() {}, every() {} }, notify() { cx.notified++; }, notified: 0, stop_propagation() {}, spawn(fn) { return Promise.resolve().then(() => fn(cx)); } };
  const v = new Agents(); v.init({}, cx);
  await until(() => cx.notified >= 1, "the env load repainted");
  const before = cx.notified;
  assert.equal(v.dialog.lessonsReady(), false);
  release();
  await until(() => v.dialog.lessonsReady(), "enabled after the read");
  assert.ok(cx.notified > before);
});
