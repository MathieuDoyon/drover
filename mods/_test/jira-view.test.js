// The Jira view with a fake host: token filter, saved query, default = Config JQL, legacy key, loads, values, off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
const CFG_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
const SITE = "acme.atlassian.net";
globalThis.__host = { props: {}, state: {}, notified: [], home: "/h", exec: async () => ({ code: 0, stdout: "", stderr: "" }), readTextFile: async () => null };
const { default: Jira } = await import(new URL("../drover-jira/main.js", import.meta.url).href);
const { InputState } = await import(new URL("./stubs/gpui-base.js", import.meta.url).href);
const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);

let flight = { n: 0 };
const idle = () => until(() => flight.n === 0, "the view has nothing in flight");

// A fake host content model on top of the stub InputState: text + token spans.
function patchInput(input) {
  input.tokens = [];
  input.content = () => ({ text: input.v, tokens: input.tokens.map((s) => ({ range: { ...s.range }, token: { ...s.token } })) });
  input.set_value = (v) => { if (typeof v === "string") { input.v = v; input.tokens = []; } else { input.v = v.text; input.tokens = v.tokens; } };
  input.replace_range_with_token = (range, token) => {
    const delta = token.text.length - (range.end - range.start);
    input.tokens = input.tokens.map((s) => (s.range.start >= range.end ? { ...s, range: { start: s.range.start + delta, end: s.range.end + delta } } : s));
    input.v = input.v.slice(0, range.start) + token.text + input.v.slice(range.end);
    input.tokens.push({ range: { start: range.start, end: range.start + token.text.length }, token });
    input.tokens.sort((a, b) => a.range.start - b.range.start);
  };
}

// Answers by path; every call is recorded. The credential is a fake, never a real file.
function rig({ state = {}, answer, settings } = {}) {
  const calls = [];
  globalThis.__host.state = { "drover.config": { "drover-jira": { site: SITE } }, ...state };
  globalThis.__host.readTextFile = async (p) => {
    if (String(p).endsWith("atlassian.json")) return JSON.stringify({ email: "a@example.test", apiToken: "fake" });
    if (settings && String(p).endsWith("/drover-jira/mod.json")) { await new Promise((r) => setTimeout(r, 5)); return JSON.stringify({ settings }); } // the mod.json layer arrives after init
    return null;
  };
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace(`https://${SITE}`, "");
    calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
    const json = answer ? await answer(path, calls) : path.includes("/search/jql") ? { issues: [] } : path.includes("/status") ? [{ name: "To Do" }, { name: "In Progress" }] : [];
    return { ok: true, status: 200, url: String(url), json: async () => json };
  };
  const mine = flight = { n: 0 };
  const painted = [];
  const asyncCx = {
    notify() { painted.push(1); },
    spawn: (fn) => { mine.n++; Promise.resolve().then(() => fn(asyncCx)).catch((e) => painted.push(String(e))).finally(() => { mine.n--; }); },
    timer: { every() {}, after() {} },
  };
  const origNew = InputState.new;
  InputState.new = function (o) { const s = origNew.call(this, o); patchInput(s); return s; };
  const view = new Jira();
  view.init({}, asyncCx);
  InputState.new = origNew;
  const eventCx = { ...asyncCx, stop_propagation() {} };
  const fire = (name) => view.input.handlers[name]({}, eventCx);
  const searches = () => calls.filter((c) => c.path.includes("/search/jql"));
  return { view, calls, searches, fire, asyncCx, eventCx, painted };
}
const tokenTexts = (view) => view.input.content().tokens.map((s) => s.token.text);

test("default: Config JQL is ONE raw jql token and is sent as it is", async () => {
  const { view, searches } = rig();
  await idle();
  assert.deepEqual(tokenTexts(view), [`jql:"${CFG_JQL}"`]);
  assert.equal(searches().length, 1);
  assert.equal(searches()[0].body.jql, CFG_JQL);
});

test("legacy drover.jira.jql becomes the jql token when no query was saved; a saved query wins", async () => {
  const a = rig({ state: { "drover.jira.jql": "project = OLD" } });
  await idle();
  assert.deepEqual(tokenTexts(a.view), ['jql:"project = OLD"']);
  assert.equal(a.searches()[0].body.jql, "project = OLD");
  const b = rig({ state: { "drover.jira.jql": "project = OLD", "drover.jira.query": { text: 'status:Done ', tokens: [{ range: { start: 0, end: 11 }, token: { id: JSON.stringify({ key: "status", value: "Done", negated: false }), text: "status:Done", label: "status:Done" } }] } } });
  await idle();
  assert.deepEqual(tokenTexts(b.view), ["status:Done"]);
  assert.equal(b.searches()[0].body.jql, 'status = "Done"');
});

test("Enter turns key:value words into tokens, saves the query under drover.jira.query and loads its JQL", async () => {
  const { view, searches, fire } = rig();
  await idle();
  view.input.set_value({ text: "", tokens: [] });
  view.input.v = 'status:Done assignee:me ';
  fire("change");
  fire("submit");
  await idle();
  assert.deepEqual(tokenTexts(view), ["status:Done", "assignee:me"]);
  assert.equal(searches().at(-1).body.jql, 'status = "Done" AND assignee = currentUser()');
  const saved = globalThis.__host.state["drover.jira.query"];
  assert.deepEqual(saved.tokens.map((s) => s.token.text), ["status:Done", "assignee:me"]);
});

test("an emptied filter loads the Config JQL", async () => {
  const { view, searches, fire } = rig();
  await idle();
  view.input.set_value({ text: "", tokens: [] });
  fire("submit");
  await idle();
  assert.equal(searches().at(-1).body.jql, CFG_JQL);
});

test("an invalid sort shows its message and sends no request", async () => {
  const { view, searches, fire } = rig();
  await idle();
  const before = searches().length;
  view.input.set_value({ text: "order:nope ", tokens: [] });
  fire("submit");
  await idle();
  assert.equal(searches().length, before);
  assert.match(view.error, /Unknown sort/);
});

test("a new query while a load runs supersedes it", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { view, searches, fire } = rig({ answer: async (path, calls) => { if (path.includes("/search/jql") && calls.filter((c) => c.path.includes("/search/jql")).length === 1) await gate; return { issues: [] }; } });
  await until(() => searches().length === 1, "first load started");
  view.input.set_value({ text: "project:ABC ", tokens: [] });
  fire("submit");
  await until(() => searches().length === 2, "second load started while the first runs");
  release();
  await idle();
  assert.equal(searches().at(-1).body.jql, 'project = "ABC"');
  assert.equal(view.loading, false);
});

test("Defaults button shows only when the query differs; reset restores the Config JQL token", async () => {
  const { view, fire, asyncCx } = rig();
  await idle();
  assert.equal(view.differsFromDefaults(), false);
  view.input.set_value({ text: "status:Done ", tokens: [] });
  fire("submit");
  await idle();
  assert.equal(view.differsFromDefaults(), true);
  view.resetDefaults(asyncCx);
  await idle();
  assert.deepEqual(tokenTexts(view), [`jql:"${CFG_JQL}"`]);
  assert.equal(view.differsFromDefaults(), false);
});

test("menu: keys while focused; the status values load once through jiraFetch and show as rows", async () => {
  const { view, calls, fire, eventCx } = rig();
  await idle();
  assert.equal(view.menuView({}, eventCx).open, false, "closed until focus");
  fire("focus");
  view.input.set_value({ text: "", tokens: [] });
  const m = view.menuNow(eventCx);
  assert.equal(m.stage, "keys");
  assert.equal(m.items[0].label, "Project");
  view.input.v = "status:";
  view.menuNow(eventCx);
  await idle();
  view.menuNow(eventCx);
  await idle();
  assert.equal(calls.filter((c) => c.path.includes("/status")).length, 1);
  const rows = view.menuNow(eventCx).items.map((i) => i.label);
  assert.deepEqual(rows.slice(0, 2), ["To Do", "In Progress"]);
});

test("picking a menu value inserts one atomic token and loads", async () => {
  const { view, searches, fire, eventCx } = rig();
  await idle();
  fire("focus");
  view.input.set_value({ text: "assignee:", tokens: [] });
  const item = view.menuNow(eventCx).items.find((i) => i.label === "Me");
  const before = searches().length;
  view.pick(item, eventCx);
  await idle();
  assert.deepEqual(tokenTexts(view), ["assignee:me"]);
  assert.equal(searches().length, before + 1);
  assert.equal(searches().at(-1).body.jql, "assignee = currentUser()");
});

test("render shows 'No issues match this filter.' for an empty result", async () => {
  const { view, asyncCx } = rig();
  await idle();
  globalThis.__rec = { ids: [], texts: [], inputs: [] };
  try { view.render(asyncCx); assert.ok(globalThis.__rec.texts.includes("No issues match this filter.")); } finally { globalThis.__rec = undefined; }
});

test("Jira switched off: no request at all, no values request from the menu", async () => {
  const { view, calls, fire, eventCx } = rig({ state: { "drover.config": { "drover-jira": { site: SITE, enabled: false } } } });
  await idle();
  fire("focus");
  view.input.v = "status:";
  view.menuNow(eventCx);
  await idle();
  assert.equal(calls.length, 0);
});

test("no site: no request, the 'not configured' error stays", async () => {
  const { view, calls, fire, eventCx } = rig({ state: { "drover.config": { "drover-jira": { site: "" } } } });
  await idle();
  fire("focus");
  view.input.v = "status:";
  view.menuNow(eventCx);
  await idle();
  assert.equal(calls.length, 0);
  assert.match(view.errorShown(), /Set the Jira site/);
});

test("a blank legacy drover.jira.jql does not freeze the early default: the loaded Config jql is adopted", async () => {
  for (const legacy of ["", "   "]) {
    const r = rig({ state: { "drover.jira.jql": legacy }, settings: { jql: "project = CUSTOM" } });
    await idle();
    assert.deepEqual(tokenTexts(r.view), ['jql:"project = CUSTOM"'], JSON.stringify(legacy));
    assert.equal(r.searches().at(-1).body.jql, "project = CUSTOM");
  }
});
