// The GitHub view end to end with a fake host: gh outcomes (empty, rejected, exec rejects), repaint, loading.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const REAL_STDERR = 'Invalid search query "( is:issue state:open author:nobody-xyz-123 ) repo:o/r".\n'
  + "The listed users cannot be searched either because the users do not exist or you do not have permission to view the users.";
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0, stdout: "[]", stderr: "" }), readTextFile: async () => null };
const { default: GitHub } = await import(new URL("../drover-github/main.js", import.meta.url).href);
const { InputState } = await import(new URL("./stubs/gpui-base.js", import.meta.url).href);

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

// A fake host content model on top of the stub InputState: text + token spans.
function patchInput(input, echo) {
  input.tokens = [];
  input.content = () => ({ text: input.v, tokens: input.tokens.map((s) => ({ range: { ...s.range }, token: { ...s.token } })) });
  input.set_value = (v) => { if (typeof v === "string") { input.v = v; input.tokens = []; } else { input.v = v.text; input.tokens = v.tokens; } };
  input.replace_range_with_token = (range, token) => {
    const delta = token.text.length - (range.end - range.start);
    input.tokens = input.tokens.map((s) => (s.range.start >= range.end ? { ...s, range: { start: s.range.start + delta, end: s.range.end + delta } } : s));
    input.v = input.v.slice(0, range.start) + token.text + input.v.slice(range.end);
    input.tokens.push({ range: { start: range.start, end: range.start + token.text.length }, token });
    input.tokens.sort((a, b) => a.range.start - b.range.start);
    if (echo.on) echo.fire();
  };
}

// cx model of the docs: an event Context is valid only during its call; the spawn/init AsyncContext stays valid.
function rig(exec, { echoChange = false, syncSpawn = false } = {}) {
  globalThis.__host.state = { "drover.github.scopes": ["o/r"] };
  globalThis.__host.exec = exec;
  const painted = [];
  let view;
  const asyncCx = {
    notify() { painted.push({ loading: view.loading, error: view.error, inputError: view.inputError }); },
    spawn: (fn) => { const run = () => fn(asyncCx); (syncSpawn ? Promise.resolve(run()) : Promise.resolve().then(run)).catch((e) => painted.push({ spawnFailed: String(e) })); },
    timer: { every() {} },
  };
  const eventCx = () => {
    let alive = true;
    const cx = { notify() { if (!alive) throw new Error("stale-context"); asyncCx.notify(); }, spawn: asyncCx.spawn, timer: asyncCx.timer };
    return { cx, end: () => { alive = false; } };
  };
  const origNew = InputState.new;
  const echo = { on: echoChange, fire: () => fire("change") };
  InputState.new = function (o) { const s = origNew.call(this, o); patchInput(s, echo); return s; };
  view = new GitHub();
  view.init({}, asyncCx);
  InputState.new = origNew;
  const fire = (name, state = view.input) => { const e = eventCx(); try { state.handlers[name]({}, e.cx); } finally { e.end(); } };
  return { view, painted, fire, last: () => painted.at(-1) };
}

const ok = (items = []) => async () => ({ code: 0, stdout: JSON.stringify(items), stderr: "" });

test("rejected search (real stderr shape, exit 1) after an empty result: loading clears, repaint shows the message", async () => {
  let n = 0;
  const { view, painted, fire, last } = rig(async () => (n++ === 0 ? { code: 0, stdout: "[]", stderr: "" } : { code: 1, stdout: "", stderr: REAL_STDERR }));
  await settle();
  assert.equal(last().loading, false, "first load (empty) done");
  view.input.v += "author:nobody-xyz-123";
  fire("change"); fire("submit");
  await settle();
  assert.equal(view.loading, false);
  assert.equal(last().loading, false, "repainted with loading cleared");
  assert.match(last().error, /^GitHub rejected the query \(unknown user, label or qualifier\?\): is:issue state:open author:nobody-xyz-123\.$/);
});

test("exec() rejecting (host failure) also clears loading and repaints the error", async () => {
  let n = 0;
  const { view, last, fire } = rig(async () => { if (n++ === 0) return { code: 0, stdout: "[]", stderr: "" }; throw new Error("exec rejected"); });
  await settle();
  view.input.v += "label:bug";
  fire("submit");
  await settle();
  assert.equal(view.loading, false);
  assert.equal(last().loading, false);
  assert.match(last().error, /exec rejected/);
});

test("repaint does not depend on a stored event cx: error and success after the handler returned", async () => {
  const { view, painted, fire } = rig(async () => ({ code: 1, stdout: "", stderr: REAL_STDERR }));
  await settle();
  assert.equal(painted.at(-1).loading, false);
  assert.match(painted.at(-1).error, /GitHub rejected/);
  fire("submit");
  await settle();
  assert.equal(painted.at(-1).loading, false);
  assert.ok(!painted.some((p) => p.spawnFailed), JSON.stringify(painted.filter((p) => p.spawnFailed)));
});

for (const [name, opts] of [["host echoes change after a token edit", { echoChange: true }], ["spawn body runs synchronously", { syncSpawn: true }], ["both", { echoChange: true, syncSpawn: true }]]) {
  test(`rejected search clears loading and repaints: ${name}`, async () => {
    let n = 0;
    const { view, last, fire } = rig(async () => (n++ === 0 ? { code: 0, stdout: "[]", stderr: "" } : { code: 1, stdout: "", stderr: REAL_STDERR }), opts);
    await settle();
    view.input.v += "author:nobody-xyz-123";
    fire("change"); fire("submit");
    await settle();
    assert.equal(view.loading, false);
    assert.equal(last().loading, false);
    assert.match(last().error, /GitHub rejected/);
  });
}

test("menu: opens on focus, Enter picks the highlighted item once (no extra submit), Esc closes, empty Enter commits", async () => {
  const { view, fire } = rig(ok());
  await settle();
  const cx = { notify() {}, spawn: (fn) => { Promise.resolve().then(() => fn(cx)); }, stop_propagation() { this.stopped = true; }, timer: { after() {} } };
  const key = (k) => { cx.stopped = false; view.menuView({}, cx).onKey({ key: k }, cx); return cx.stopped; };
  assert.equal(view.menuView({}, view.cx).open, false, "closed until the input is focused");
  fire("focus");
  view.input.v += "auth";
  assert.equal(view.menuView({}, view.cx).open, true);
  assert.equal(key("down"), true);
  assert.equal(key("up"), true);
  assert.equal(key("enter"), true);
  assert.equal(view.input.v.endsWith("author:"), true, "key pick inserts key:");
  view.input.v += "alice";
  assert.equal(key("enter"), true);
  assert.deepEqual(view.input.tokens.map((s) => s.token.text).at(-1), "author:alice");
  const before = view.ctl.model().length;
  fire("submit"); // the host's submit for that same Enter: skipped
  assert.equal(view.ctl.model().length, before);
  assert.equal(key("escape"), true);
  assert.equal(view.menuView({}, view.cx).open, false, "Esc dismisses");
  view.input.v += "x";
  assert.equal(view.menuView({}, view.cx).open, true, "typing reopens it");
  view.input.v = "";
  view.dismissed = false;
  assert.equal(view.menuView({}, view.cx).open, true);
  assert.equal(key("enter"), false, "no highlight on an empty input: Enter falls through to submit");
});

function menuRig() {
  const r = rig(ok());
  const timers = [];
  const cx = { notify() {}, spawn: (fn) => { Promise.resolve().then(() => fn(cx)); }, stop_propagation() { this.stopped = true; }, timer: { after: (_ms, fn) => timers.push(fn) } };
  const handler = (name) => r.view.input.handlers[name]({}, cx);
  const key = (k) => { cx.stopped = false; r.view.menuView({}, cx).onKey({ key: k }, cx); return cx.stopped; };
  return { ...r, timers, cx, handler, key };
}

test("a pending blur callback does not close the menu after the input regained focus", async () => {
  const { view, timers, cx, handler } = menuRig();
  await settle();
  handler("focus");
  handler("blur");
  handler("focus");
  for (const fn of timers) fn(cx);
  assert.equal(view.focused, true);
  assert.equal(view.menuView({}, view.cx).open, true);
  handler("blur"); // a real blur still closes, once its callback runs
  for (const fn of timers.splice(0)) fn(cx);
  assert.equal(view.focused, false);
});

test("only the submit of the consumed Enter is skipped; a later Enter commits", async () => {
  const { view, handler, key } = menuRig();
  await settle();
  handler("focus");
  view.input.v += "auth";
  assert.equal(key("enter"), true); // picks Author (a text pick: author:)
  handler("submit"); // the host's submit for that Enter: skipped
  assert.equal(view.ctl.model().some((n) => n.kind === "text" || n.kind === "op"), false);
  key("escape");
  view.input.v += " outage";
  handler("submit"); // a separate Enter: commits at once, not swallowed by a time window
  assert.ok(view.ctl.model().some((n) => n.kind === "text" && n.text === "outage"));
});

test("an Enter pick whose submit never arrives does not swallow the next Enter", async () => {
  const { view, handler, key } = menuRig();
  await settle();
  handler("focus");
  view.input.v += "auth";
  key("enter"); // consumed, host sent no submit
  key("escape"); // the next key clears the pending skip
  view.input.v += " outage";
  handler("submit");
  assert.ok(view.ctl.model().some((n) => n.kind === "text" && n.text === "outage"));
});

test("a mouse pick never swallows a submit", async () => {
  const { view, cx, handler } = menuRig();
  await settle();
  handler("focus");
  view.input.v += "auth";
  view.pick(view.menuNow(view.cx).items[0], cx);
  view.input.v += " outage";
  handler("submit");
  assert.ok(view.ctl.model().some((n) => n.kind === "text" && n.text === "outage"));
});

// loadValues with a fake clock: the same key refetches after TTL / failure TTL and after a close, never per keystroke.
test("loadValues: refetch after expiry and reopen, one call while cached, none for org scopes", async () => {
  const { createValues, TTL, FAIL_TTL } = await import(new URL("../drover-github/values.js", import.meta.url).href);
  for (const [answer, ttl] of [[{ code: 0, stdout: '[{"title":"v1"}]', stderr: "" }, TTL], [{ code: 1, stdout: "", stderr: "403" }, FAIL_TTL]]) {
    let t = 0, calls = 0;
    const values = createValues({ exec: async () => { calls++; return answer; }, now: () => t });
    const self = { values, pending: new Set(), };
    const spawnCx = { spawn: (fn) => fn({ notify() {} }) };
    const open = { open: true, stage: "values", key: "milestone" };
    const load = async (m, list = ["o/r"]) => { GitHub.prototype.loadValues.call(self, m, list, spawnCx); await settle(); };
    await load(open);
    for (let i = 0; i < 5; i++) await load(open); // typing: cache decides, no call
    assert.equal(calls, 1);
    await load({ open: false, items: [] }); // closed
    await load(open); // reopened while fresh
    assert.equal(calls, 1);
    t += ttl + 1;
    await load(open); // expired: the same key asks again
    assert.equal(calls, 2);
    await load(open, ["org"]);
    assert.equal(calls, 2);
  }
});

// People rows draw a plain circle with the login's initial; no Avatar parts, no remote image (the host did not draw the fallback).
test("people value menu: each row shows the uppercased initial of the login", async () => {
  const { view, fire } = rig(ok());
  await settle();
  globalThis.__host.state["drover.github.snapshot"] = { items: [{ repo: "o/r", author: "ada", assignees: ["bob", "cy"], labels: [] }] };
  fire("focus");
  for (const key of ["assignee", "author"]) {
    globalThis.__rec = { ids: [], texts: [] };
    view.input.tokens = [];
    view.input.v = `${key}:`;
    view.menuView({}, view.cx);
    const texts = globalThis.__rec.texts;
    globalThis.__rec = undefined;
    const logins = key === "assignee" ? ["bob", "cy"] : ["ada"];
    for (const login of logins) {
      assert.ok(texts.includes(login), `${key}: row ${login}`);
      assert.ok(texts.includes(login[0].toUpperCase()), `${key}: initial of ${login}`);
    }
  }
});

test("menu view: 'commen' in an empty focused field opens the popup with Commenter and Comments", async () => {
  const { view, fire } = rig(ok());
  await settle();
  fire("focus");
  view.input.set_value("");
  for (const w of ["comm", "commen", "ass"]) {
    view.input.v = w;
    assert.equal(view.menuView({}, view.cx).open, true, w);
    assert.ok(view.menuNow(view.cx).items.length >= 1, w);
  }
  view.input.v = "commen";
  assert.deepEqual(view.menuNow(view.cx).items.map((i) => i.label), ["Commenter", "Comments"]);
});

test("menu view: typing 'commen' one key at a time (with change events) keeps the popup open at every step", async () => {
  const { view, fire } = rig(ok());
  await settle();
  fire("focus");
  view.input.set_value("");
  for (const ch of "commen") {
    view.input.v += ch;
    fire("change");
    assert.equal(view.menuView({}, view.cx).open, true, view.input.v);
  }
  assert.deepEqual(view.menuNow(view.cx).items.map((i) => i.label), ["Commenter", "Comments"]);
});

// ↺ Defaults: saved scopes and the query go back to Config.
const withConfig = (r, scopes, saved) => {
  const s = globalThis.__host.state;
  s["drover.config"] = { "drover-github": { scopes } };
  if (saved === undefined) delete s["drover.github.scopes"]; else s["drover.github.scopes"] = saved;
  return r;
};
const ids = (view) => { globalThis.__rec = { ids: [], texts: [] }; try { view.render(view.cx); return globalThis.__rec.ids; } finally { globalThis.__rec = null; } };
const execLog = () => { const calls = []; return { calls, exec: async (_c, args) => { calls.push(args.join(" ")); return { code: 0, stdout: "[]", stderr: "" }; } }; };

test("Defaults: saved [] shadows Config scopes; reset forgets it and the Config scopes load", async () => {
  const log = execLog();
  const { view, fire } = rig(log.exec);
  withConfig({}, ["cfg-org"], []);
  await settle();
  assert.deepEqual(log.calls.filter((c) => c.includes("cfg-org")), [], "saved [] : nothing loads");
  assert.ok(ids(view).includes("reset-defaults"), "button shows: saved scopes differ from Config");
  view.resetDefaults(view.cx);
  await settle();
  assert.equal(globalThis.__host.state["drover.github.scopes"], null);
  assert.ok(log.calls.some((c) => c.includes("cfg-org")), log.calls.join("\n"));
  assert.ok(!ids(view).includes("reset-defaults"), "hidden once default");
});

test("Defaults: reset also restores the query and drops the stale snapshot", async () => {
  const log = execLog();
  const { view, fire } = rig(log.exec);
  withConfig({}, ["cfg-org"], ["o/r"]);
  globalThis.__host.state["drover.github.snapshot"] = { items: [{ id: "x", repo: "o/r", updated: 1, state: "OPEN" }], query: [], at: 1 };
  view.input.v += "label:bug"; fire("submit");
  await settle();
  assert.ok(ids(view).includes("reset-defaults"));
  globalThis.__host.exec = async (...a) => { assert.equal(globalThis.__host.state["drover.github.snapshot"], null, "dropped before the reload"); return log.exec(...a); };
  view.resetDefaults(view.cx);
  await settle();
  assert.equal(view.input.v.trim(), "is:issue state:open");
});

test("Defaults: hidden when saved scopes equal Config (any order) and the query is the default; reset then is a no-op for scopes", async () => {
  const { view } = rig(ok());
  withConfig({}, ["a", "b/c"], ["b/c", "a"]);
  await settle();
  assert.ok(!ids(view).includes("reset-defaults"));
  withConfig({}, ["a"], undefined);
  assert.ok(!ids(view).includes("reset-defaults"), "never saved: nothing differs");
});

test("Defaults: after reset, + scope saves the Config scopes plus the new one", async () => {
  const { view } = rig(ok());
  withConfig({}, ["cfg-org"], []);
  await settle();
  view.resetDefaults(view.cx);
  await settle();
  view.scopeInput.set_value("new-org");
  view.scopeInput.handlers.submit({}, view.cx);
  await settle();
  assert.deepEqual(globalThis.__host.state["drover.github.scopes"], ["cfg-org", "new-org"]);
});

test("menu Reset filter restores the scopes too", async () => {
  const log = execLog();
  const { view } = rig(log.exec);
  withConfig({}, ["cfg-org"], []);
  await settle();
  view.pick({ insert: { reset: true } }, view.cx);
  await settle();
  assert.equal(globalThis.__host.state["drover.github.scopes"], null);
  assert.ok(log.calls.some((c) => c.includes("cfg-org")));
});

test("Defaults: a committed query whose argv differs only in word boundaries from the Config query still shows the button", async () => {
  const { view, fire } = rig(ok());
  withConfig({}, ["o/r"], undefined);
  globalThis.__host.state["drover.config"]["drover-github"].query = 'label:"good first issue"';
  await settle();
  view.input.set_value("label:good first issue");
  fire("submit");
  await settle();
  assert.ok(ids(view).includes("reset-defaults"));
});
