// Card 3: GitHub default query/scopes/limit and Jira JQL/pages/refresh/site read through cfg(), with the dialog's query check.
// Precedence everywhere: shared drover.config > mod.json settings > schema default.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.js", import.meta.url);
globalThis.__host = { props: {}, state: {}, notified: [], exec: async () => ({ code: 0, stdout: "[]", stderr: "" }), readTextFile: async () => null, home: "/h", appHome: "/a" };
const C = await import("../_lib/config.js");
const IO = await import("../_lib/io.js");
const { default: GitHub } = await import(new URL("../drover-github/main.js", import.meta.url).href);
const { default: Jira } = await import(new URL("../drover-jira/main.js", import.meta.url).href);
const { menuState } = await import("../drover-github/menu.js");
const { createController, defaultContent, restoreContent, contentFromModel, usableModel } = await import("../drover-github/filter.js");
const { parseQuery, DEFAULT_QUERY } = await import("../drover-github/query.js");
const { SCHEMA, validate } = await import("../_lib/config-schema.js");
const { createModel } = await import("../drover-config/model.js");

const { InputState } = await import(new URL("./stubs/gpui-base.js", import.meta.url).href);
const { until, drain } = await import(new URL("./stubs/until.js", import.meta.url).href);
// Every cx.spawn is counted while it runs, so idle() resolves when the view has no async work left in flight.
// A test that holds a fetch or a credential read open waits for that held call itself (waiting / held), then releases it.
let flight = { n: 0 }; // reset by host(): a spawn of an earlier test can end late without touching this count
const idle = () => until(() => flight.n === 0, "no spawned work in flight");
const CFG = "drover.config";
const jiraFiles = { "/h/.config/drover-herdr/atlassian.json": JSON.stringify({ email: "a@b.c", apiToken: "t" }) };
let reads, execs, fetches, timers;

// settings: mod.json `settings` per mod; shared: other shared keys.
function host({ config = {}, settings = {}, shared = {}, now } = {}) {
  C.resetCache();
  reads = []; execs = []; fetches = []; timers = []; flight = { n: 0 };
  Object.assign(globalThis.__host, {
    state: { [CFG]: config, ...shared },
    readTextFile: async (p) => {
      reads.push(p);
      const mod = /mods\/([^/]+)\/mod.json$/.exec(p)?.[1];
      if (mod) return settings[mod] ? JSON.stringify({ settings: settings[mod] }) : null;
      return jiraFiles[p] ?? null;
    },
    exec: async (cmd, args) => { execs.push({ cmd, args }); return { code: 0, stdout: "[]", stderr: "" }; },
  });
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, url, status: 200, json: async () => ({ issues: [], isLast: true }) };
  };
  if (now) Date.now = now;
}
const cxOf = () => {
  const mine = flight;
  const cx = { notify() {}, spawn: (fn) => { mine.n++; Promise.resolve().then(() => fn(cx)).finally(() => { mine.n--; }); }, timer: { every: (ms, fn) => timers.push({ ms, fn }), after() {} } };
  return cx;
};
const realNow = Date.now;
beforeEach(() => { Date.now = realNow; });

// A fake host content model on top of the stub InputState: text + token spans (as in github-view.test.js).
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
async function github(opts) {
  host(opts);
  const view = new GitHub();
  const origNew = InputState.new;
  InputState.new = function (o) { const s = origNew.call(this, o); patchInput(s); return s; };
  try { view.init({}, cxOf()); } finally { InputState.new = origNew; }
  await idle();
  return view;
}
const ghArgs = () => execs.filter((e) => e.cmd === "gh").map((e) => e.args);
const afterDash = (a) => a.slice(a.indexOf("--") + 1);

// ---- GitHub: default query ----
test("github: no saved query opens with the configured default (shared), parsed by parseQuery", async () => {
  const v = await github({ config: { "drover-github": { query: "is:pr label:bug", scopes: ["o"] } } });
  assert.equal(v.input.content().text.trim(), "is:pr label:bug");
  assert.deepEqual(afterDash(ghArgs()[0]), ["is:pr", "label:bug"]);
});

test("github: query precedence shared > mod.json > default", async () => {
  const s = { "drover-github": { scopes: ["o"] } };
  const a = await github({ config: { ...s, "drover-github": { scopes: ["o"], query: "is:pr" } }, settings: { "drover-github": { query: "label:x" } } });
  assert.deepEqual(afterDash(ghArgs()[0]), ["is:pr"]);
  const b = await github({ config: s, settings: { "drover-github": { query: "label:x" } } });
  assert.deepEqual(afterDash(ghArgs()[0]), ["label:x"]);
  const c = await github({ config: s });
  assert.deepEqual(afterDash(ghArgs()[0]), ["is:issue", "state:open"]);
  assert.ok(a && b && c);
});

test("github: a saved query beats the configured default", async () => {
  const saved = contentFromModel(parseQuery("label:mine"));
  const v = await github({ config: { "drover-github": { query: "is:pr", scopes: ["o"] } }, shared: { "drover.github.query": saved } });
  assert.deepEqual(afterDash(ghArgs()[0]), ["label:mine"]);
  assert.equal(v.input.content().text.trim(), "label:mine");
});

test("github: an unusable configured query (hand-written mod.json) falls back to DEFAULT_QUERY", async () => {
  await github({ config: { "drover-github": { scopes: ["o"] } }, settings: { "drover-github": { query: "label:" } } });
  assert.deepEqual(afterDash(ghArgs()[0]), ["is:issue", "state:open"]);
  assert.deepEqual(usableModel("  "), DEFAULT_QUERY);
  assert.deepEqual(usableModel("is:pr"), parseQuery("is:pr"));
});

// ---- GitHub: scopes and limit ----
test("github: scopes unset -> configured scopes; saved scopes (even empty) win", async () => {
  await github({ config: { "drover-github": { scopes: ["acme"] } } });
  assert.ok(ghArgs()[0].includes("--owner=acme"));
  await github({ config: { "drover-github": { scopes: ["acme"] } }, shared: { "drover.github.scopes": ["o/r"] } });
  assert.ok(ghArgs()[0].includes("--repo=o/r"));
  await github({ config: { "drover-github": { scopes: ["acme"] } }, shared: { "drover.github.scopes": [] } });
  assert.equal(ghArgs().length, 0, "the person removed every scope: nothing comes back from config");
  await github({ settings: { "drover-github": { scopes: ["fromjson"] } } });
  assert.ok(ghArgs()[0].includes("--owner=fromjson"), "mod.json fallback");
});

test("github: limit precedence shared > mod.json > default", async () => {
  const sc = { "drover.github.scopes": ["o"] };
  await github({ config: { "drover-github": { limit: 7 } }, settings: { "drover-github": { limit: 9 } }, shared: sc });
  assert.ok(ghArgs()[0].includes("--limit=7"));
  await github({ settings: { "drover-github": { limit: 9 } }, shared: sc });
  assert.ok(ghArgs()[0].includes("--limit=9"));
  await github({ shared: sc });
  assert.ok(ghArgs()[0].includes("--limit=100"));
});

// ---- GitHub: Reset filter ----
test("github: Reset filter restores the CONFIGURED default (controller, hint and view)", async () => {
  const v = await github({ config: { "drover-github": { query: "is:pr label:bug", scopes: ["o"] } } });
  v.input.v += "author:zed";
  v.ctl.pick({ reset: true });
  assert.equal(v.input.content().text.trim(), "is:pr label:bug");
  assert.deepEqual(JSON.parse(v.input.content().tokens[0].token.id), { key: "is", value: "pr", negated: false });
  assert.deepEqual(v.ctl.model(), parseQuery("is:pr label:bug"));
  assert.deepEqual(afterDash(ghArgs().at(-1)), ["is:pr", "label:bug"]);
  const m = menuState({ text: "", tokens: [] }, 0, { defaultText: "is:pr label:bug" });
  assert.equal(m.items.find((i) => i.id === "reset").hint, "is:pr label:bug");
  assert.equal(menuState({ text: "", tokens: [] }, 0, {}).items.find((i) => i.id === "reset").hint, "is:issue state:open");
});

test("filter: controller defaults() and restoreContent fallback", () => {
  const input = { c: { text: "x", tokens: [] }, content() { return this.c; }, set_value(v) { this.c = v; } };
  const saved = [], reqs = [];
  const want = contentFromModel(parseQuery("is:pr"));
  const c = createController({ input, scopes: () => ["o"], save: (x) => saved.push(x), enqueue: (r) => reqs.push(r), defaults: () => want });
  c.pick({ reset: true });
  assert.deepEqual(input.c, want);
  assert.deepEqual(restoreContent(undefined, want), want);
  assert.deepEqual(restoreContent(undefined), defaultContent());
});

// ---- dialog: the query is checked before it is stored ----
const M = createModel({ SCHEMA, validate, isOverride: C.isOverride, setOverride: C.setOverride, resetOverride: C.resetOverride, resolve: C.resolve, parseQuery });
test("dialog model: an unusable github query is rejected and never produces a shared object", () => {
  for (const bad of ["label:", "   ", "-x:", ""]) {
    const r = M.set({}, "drover-github", "query", bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.shared, undefined);
  }
  const r = M.set({}, "drover-github", "query", "  is:pr   label:bug ");
  assert.equal(r.ok, true);
  assert.equal(r.shared["drover-github"].query, "is:pr   label:bug");
  assert.equal(M.set({}, "drover-github", "limit", "5").ok, true, "other fields unaffected");
});

// ---- Jira ----
async function jira(opts) {
  host(opts);
  const view = new Jira();
  view.init({}, cxOf());
  await idle();
  return view;
}
const SITE = { "drover-jira": { site: "acme.atlassian.net" } };
const searches = () => fetches.filter((f) => f.url.endsWith("/rest/api/3/search/jql"));

test("jira: JIRA_SITE is gone; an empty site shows the message and makes no request at all", async () => {
  assert.equal("JIRA_SITE" in IO, false);
  const v = await jira({});
  assert.deepEqual(fetches, []);
  assert.equal(reads.some((p) => p.includes("atlassian.json")), false, "credentials not even read");
  assert.match(v.errorShown(), /^Set the Jira site in Drover Config/);
  v.refresh(cxOf());
  v.input.handlers.submit({}, cxOf());
  await drain(); // an empty site must make no request: a bounded drain, not a wait for a result
  assert.deepEqual(fetches, []);
  await assert.rejects(() => IO.jiraFetch("", "/x"), /Set the Jira site in Drover Config/);
  assert.deepEqual(fetches, []);
});

test("jira: site from config; fetch goes to that host; a redirect elsewhere is refused", async () => {
  await jira({ config: SITE });
  assert.equal(searches()[0].url, "https://acme.atlassian.net/rest/api/3/search/jql");
  await jira({ settings: SITE });
  assert.equal(searches()[0].url, "https://acme.atlassian.net/rest/api/3/search/jql", "mod.json fallback");
  host({});
  globalThis.fetch = async () => ({ ok: true, url: "https://evil.example/x", json: async () => ({}) });
  await assert.rejects(() => IO.jiraFetch("acme.atlassian.net", "/x"), /redirected elsewhere/);
});

test("jira: a site that is not a bare host is refused before any request", async () => {
  await assert.rejects(() => IO.jiraFetch("https://acme.atlassian.net/", "/x"), /Jira site/);
  await assert.rejects(() => IO.jiraFetch("a.b/x@evil.com", "/x"), /Jira site/);
  assert.deepEqual(fetches, []);
  assert.equal(validate(SCHEMA.find((f) => f.mod === "drover-jira" && f.key === "site"), "https://x.net").ok, false);
  assert.equal(validate(SCHEMA.find((f) => f.mod === "drover-jira" && f.key === "site"), "x.atlassian.net").ok, true);
  assert.equal(validate(SCHEMA.find((f) => f.mod === "drover-jira" && f.key === "site"), "").ok, true);
});

test("jira: jql precedence saved drover.jira.jql > shared config > mod.json > default", async () => {
  const jql = () => searches()[0].body.jql;
  await jira({ config: { ...SITE, "drover-jira": { site: "a.b", jql: "project = C" } }, settings: { "drover-jira": { jql: "project = J" } }, shared: { "drover.jira.jql": "project = S" } });
  assert.equal(jql(), "project = S");
  await jira({ config: { "drover-jira": { site: "a.b", jql: "project = C" } }, settings: { "drover-jira": { jql: "project = J" } } });
  assert.equal(jql(), "project = C");
  await jira({ config: { "drover-jira": { site: "a.b" } }, settings: { "drover-jira": { jql: "project = J" } } });
  assert.equal(jql(), "project = J");
  const v = await jira({ config: { "drover-jira": { site: "a.b" } } });
  assert.equal(jql(), C.cfg("drover-jira", "jql"));
  assert.match(v.input.value(), /^assignee = currentUser\(\)/);
});

test("jira: pages precedence shared > mod.json > default", async () => {
  const paged = () => { globalThis.fetch = async (url, init) => { fetches.push({ url, body: JSON.parse(init.body) }); return { ok: true, url, json: async () => ({ issues: [], nextPageToken: "n" }) }; }; };
  const run = async (o) => { host(o); paged(); const v = new Jira(); v.init({}, cxOf()); await idle(); return searches().length; };
  assert.equal(await run({ config: { "drover-jira": { site: "a.b", pages: 2 } }, settings: { "drover-jira": { pages: 3 } } }), 2);
  assert.equal(await run({ config: { "drover-jira": { site: "a.b" } }, settings: { "drover-jira": { pages: 3 } } }), 3);
  assert.equal(await run({ config: { "drover-jira": { site: "a.b" } } }), 4);
});

test("jira: refresh minutes are read live on every tick (no hard-coded 5 min)", async () => {
  let t = 1_000_000;
  const v = await jira({ config: { "drover-jira": { site: "a.b", refresh_minutes: 10 } }, now: () => t });
  assert.equal(searches().length, 1);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms <= 60_000, "the timer only ticks; the interval is checked live");
  const tickAt = async (min) => { t = 1_000_000 + min * 60_000; timers[0].fn(cxOf()); await idle(); };
  await tickAt(5);
  assert.equal(searches().length, 1, "5 min < 10 configured");
  await tickAt(10);
  assert.equal(searches().length, 2);
  globalThis.__host.state[CFG] = { "drover-jira": { site: "a.b", refresh_minutes: 1 } }; // changed in the dialog, no reopen
  await tickAt(11);
  assert.equal(searches().length, 3, "now every minute");
  globalThis.__host.state[CFG] = {}; // site cleared: ticks make no request
  await tickAt(30);
  assert.equal(searches().length, 3);
  assert.ok(v);
});

test("jira: loadContext (Room/Todos) uses the configured site; empty site -> an Issue error and no fetch", async () => {
  const task = { source: { kind: "jira", url: "https://acme.atlassian.net/browse/AB-1" } };
  host({});
  const empty = await IO.loadContext(null, task);
  assert.deepEqual(fetches, []);
  assert.match(empty.errors[0], /^Issue: Set the Jira site in Drover Config/);
  host({ config: SITE });
  globalThis.fetch = async (url) => { fetches.push({ url }); return { ok: true, url, json: async () => ({ key: "AB-1", fields: {} }) }; };
  await IO.loadContext(null, task);
  assert.equal(fetches[0].url, "https://acme.atlassian.net/rest/api/3/issue/AB-1?fields=summary,status,assignee,project,issuetype,parent");
});

// ---- Jira: a site change invalidates an in-flight load; clearing the site shows the message live ----
function deferredFetch() {
  const waiting = [];
  globalThis.fetch = (url, init) => new Promise((resolve) => {
    fetches.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    waiting.push((json) => resolve({ ok: true, url, status: 200, json: async () => json }));
  });
  return waiting;
}
const snap = () => globalThis.__host.state["drover.jira.snapshot"];
const issue = (id) => ({ id, key: `K-${id}`, fields: { summary: "S", status: { name: "To Do", statusCategory: { key: "new" } } } });
const NO_SITE = /^Set the Jira site in Drover Config\./;

async function pending(config) {
  host({ config });
  const waiting = deferredFetch();
  const v = new Jira();
  v.init({}, cxOf());
  await until(() => waiting.length === 1, "page 1 requested (held)");
  return { v, waiting };
}

test("jira: site cleared while page 1 is in flight -> no page-2 request to the old host, no snapshot, message shown", async () => {
  const { v, waiting } = await pending({ "drover-jira": { site: "a.b", pages: 2 } });
  assert.equal(searches().length, 1);
  globalThis.__host.state[CFG] = {};
  v.refresh(cxOf());
  timers[0].fn(cxOf());
  waiting[0]({ issues: [issue("1")], nextPageToken: "n" });
  await idle();
  assert.equal(searches().length, 1, "no second page to the old host");
  assert.equal(snap(), undefined, "no stale snapshot");
  assert.equal(v.loading, false);
  assert.match(v.errorShown(), NO_SITE);
  assert.equal(fetches.every((f) => f.url.startsWith("https://a.b/")), true);
});

test("jira: site A -> B while in flight: A's data is never published; B loads on the next tick", async () => {
  const { v, waiting } = await pending({ "drover-jira": { site: "a.b", pages: 2 } });
  globalThis.__host.state[CFG] = { "drover-jira": { site: "c.d", pages: 2 } };
  timers[0].fn(cxOf()); // reconciles: the load for a.b is dropped, c.d starts
  await until(() => searches().some((f) => f.url.startsWith("https://c.d/")), "c.d requested (held)");
  assert.equal(searches().at(-1).url, "https://c.d/rest/api/3/search/jql");
  waiting[0]({ issues: [issue("1")], nextPageToken: "n" }); // A answers late
  await drain(); // a late answer must change nothing: a bounded drain, B is still held
  assert.equal(searches().filter((f) => f.url.startsWith("https://a.b/")).length, 1, "no page 2 to a.b");
  assert.equal(snap(), undefined, "A's result not published under B");
  waiting[1]({ issues: [issue("2")], isLast: true });
  await until(() => snap(), "B's snapshot published");
  assert.equal(snap().items.length, 1);
  assert.match(snap().items[0].id, /^c\.d\//);
  assert.equal(v.loading, false);
  assert.equal(v.error, null);
});

test("jira: A -> B refresh pressed while A is still loading starts B at once", async () => {
  const { v, waiting } = await pending({ "drover-jira": { site: "a.b" } });
  globalThis.__host.state[CFG] = { "drover-jira": { site: "c.d" } };
  v.refresh(cxOf());
  await until(() => searches().some((f) => f.url.startsWith("https://c.d/")), "c.d requested (held)");
  assert.equal(searches().at(-1).url, "https://c.d/rest/api/3/search/jql");
  waiting[0]({ issues: [issue("1")], isLast: true });
  await drain(); // A's late answer must publish nothing: a bounded drain, B is still held
  assert.equal(snap(), undefined);
});

test("jira: settled configured -> empty: the message shows on render and after a tick, with no request", async () => {
  host({ config: { "drover-jira": { site: "a.b" } } });
  const v = new Jira();
  v.init({}, cxOf());
  await idle();
  assert.equal(v.render(cxOf()) !== undefined, true);
  const before = fetches.length;
  globalThis.__host.state[CFG] = {};
  assert.match(v.errorShown(), NO_SITE);
  timers[0].fn(cxOf());
  await idle();
  assert.match(v.errorShown(), NO_SITE);
  assert.equal(fetches.length, before);
  globalThis.__host.state[CFG] = { "drover-jira": { site: "a.b" } };
  assert.equal(v.errorShown(), null, "message goes away when a site is set again");
});

// ---- Jira: the credential read is an await too; the guard is checked again right before fetch ----
function heldCredentials() {
  const held = [];
  const base = globalThis.__host.readTextFile;
  globalThis.__host.readTextFile = (p) => (p.includes("atlassian.json") ? new Promise((res) => held.push(() => res(jiraFiles[p]))) : base(p));
  return held;
}

test("jira: site cleared + refresh while the credential read is held -> zero fetch after it resolves", async () => {
  host({ config: { "drover-jira": { site: "a.b" } } });
  const held = heldCredentials();
  const v = new Jira();
  v.init({}, cxOf());
  await until(() => held.length === 1, "the credential read is held");
  assert.equal(held.length, 1);
  assert.equal(fetches.length, 0);
  globalThis.__host.state[CFG] = {};
  v.refresh(cxOf());
  held[0]();
  await idle();
  assert.equal(fetches.length, 0, "no request to the old host");
  assert.equal(snap(), undefined);
  assert.match(v.errorShown(), NO_SITE);
  assert.equal(v.loading, false);
});

test("jira: site A -> B while the credential read is held -> only B is requested", async () => {
  host({ config: { "drover-jira": { site: "a.b" } } });
  const held = heldCredentials();
  const v = new Jira();
  v.init({}, cxOf());
  await until(() => held.length === 1, "A's credential read is held");
  globalThis.__host.state[CFG] = { "drover-jira": { site: "c.d" } };
  v.refresh(cxOf());
  await until(() => held.length === 2, "B's credential read is held");
  held.forEach((r) => r());
  await idle();
  assert.deepEqual(fetches.map((f) => new URL(f.url).host), ["c.d"]);
});

test("jira: jiraFetch with a guard that turns false after the credential read throws JIRA_STALE and sends nothing", async () => {
  host({});
  let ok = true;
  globalThis.__host.readTextFile = async (p) => { ok = false; return jiraFiles[p]; };
  await assert.rejects(() => IO.jiraFetch("a.b", "/x", {}, () => ok), (e) => e === IO.JIRA_STALE);
  assert.deepEqual(fetches, []);
});
