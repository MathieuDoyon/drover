// GitHub filter token input: pure helpers, saved query, request loader.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultContent, contentFromModel, restoreContent, tokenize, wordToken, qualToken,
  createLoader, emptyText, planRequests, QUERY_KEY, createController, wordTokens, ghErrorMessage,
} from "../drover-github/filter.js";
import { githubSearchArgs, toArgs } from "../drover-github/query.js";

const { until } = await import(new URL("./stubs/until.js", import.meta.url).href);
const FIELDS = "number,url";
const qual = (key, value, negated = false) => ({ kind: "qual", key, value, negated });

test("default content is two atomic tokens: is:issue state:open", () => {
  const c = defaultContent();
  assert.equal(c.text, "is:issue state:open ");
  assert.equal(c.tokens.length, 2);
  for (const { range, token } of c.tokens) assert.equal(c.text.slice(range.start, range.end), token.text);
  assert.deepEqual(toArgs(tokenize(c)), ["is:issue", "state:open"]);
  assert.equal(QUERY_KEY, "drover.github.query");
});

test("tokenize keeps token ids structured and parses plain spans", () => {
  const t = qualToken(qual("label", "bug"));
  const text = `${t.text} outage OR author:alice `;
  const c = { text, tokens: [{ range: { start: 0, end: t.text.length }, token: t }] };
  assert.deepEqual(tokenize(c), [qual("label", "bug"), { kind: "text", text: "outage" }, { kind: "op" }, qual("author", "alice")]);
});

test("a token whose display text would reparse differently still yields its structured value", () => {
  const node = qual("label", 'say "hi" now');
  const c = contentFromModel([node]);
  assert.deepEqual(tokenize(c), [node]);
  assert.deepEqual(tokenize(c)[0], node);
});

test("embedded-quote value: commit -> JSON save -> restore -> argv keeps it as one element", () => {
  const node = qual("label", 'say "hi" now');
  const saved = JSON.parse(JSON.stringify(contentFromModel([qual("is", "issue"), node, qual("author", "bob", true)])));
  const restored = restoreContent(saved);
  const args = githubSearchArgs("example-org", 10, FIELDS, tokenize(restored));
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["is:issue", 'label:say "hi" now', "-author:bob"]);
});

test("restoreContent: missing or invalid saved values fall back to the default", () => {
  const def = defaultContent();
  for (const bad of [undefined, null, 5, "x", {}, { text: 1, tokens: [] }, { text: "ab", tokens: "no" },
    { text: "ab", tokens: [{ range: { start: 0, end: 9 }, token: { id: "{}", text: "ab", label: "ab" } }] },
    { text: "ab", tokens: [{ range: { start: 0, end: 2 }, token: { id: "not json", text: "ab", label: "ab" } }] },
    { text: "ab", tokens: [{ range: { start: 0, end: 2 }, token: { id: '{"key":"a","value":"","negated":false}', text: "ab", label: "ab" } }] },
    { text: "xx", tokens: [{ range: { start: 0, end: 2 }, token: { id: '{"key":"a","value":"b","negated":false}', text: "a:b", label: "a:b" } }] },
  ]) assert.deepEqual(restoreContent(bad), def, JSON.stringify(bad));
});

test("restoreContent keeps a valid empty query and rejects overlapping tokens", () => {
  assert.deepEqual(restoreContent({ text: "", tokens: [] }), { text: "", tokens: [] });
  const t = qualToken(qual("a", "b"));
  const bad = { text: t.text, tokens: [{ range: { start: 0, end: 3 }, token: t }, { range: { start: 1, end: 3 }, token: t }] };
  assert.deepEqual(restoreContent(bad), defaultContent());
});

test("wordToken: key:value plus space or Enter becomes a token", () => {
  // Enter: caret at the end of the word.
  const a = wordToken({ text: "label:bug", tokens: [] }, 9);
  assert.deepEqual(a.range, { start: 0, end: 9 });
  assert.equal(a.token.text, "label:bug");
  assert.deepEqual(JSON.parse(a.token.id), { key: "label", value: "bug", negated: false });
  // Space already typed: caret after the space.
  const b = wordToken({ text: "-author:@me ", tokens: [] }, 12);
  assert.deepEqual(b.range, { start: 0, end: 11 });
  assert.deepEqual(JSON.parse(b.token.id), { key: "author", value: "@me", negated: true });
});

test("wordToken: only the word before the caret, after earlier tokens", () => {
  const t = qualToken(qual("is", "issue"));
  const text = `${t.text} foo label:x `;
  const c = { text, tokens: [{ range: { start: 0, end: t.text.length }, token: t }] };
  const r = wordToken(c, text.length);
  assert.equal(text.slice(r.range.start, r.range.end), "label:x");
});

test("wordToken: plain words, OR, empty values, and already-token words stay text", () => {
  for (const [text, caret] of [["outage", 6], ["OR", 2], ["author:", 7], ["author: ", 8], ["", 0], ["  ", 2]]) {
    assert.equal(wordToken({ text, tokens: [] }, caret), null, text);
  }
  const t = qualToken(qual("is", "issue"));
  assert.equal(wordToken({ text: `${t.text} `, tokens: [{ range: { start: 0, end: t.text.length }, token: t }] }, t.text.length + 1), null);
});

test("wordToken: quoted value with spaces waits for the closing quote", () => {
  assert.equal(wordToken({ text: 'label:"two ', tokens: [] }, 11), null);
  const r = wordToken({ text: 'label:"two words" ', tokens: [] }, 18);
  assert.deepEqual(JSON.parse(r.token.id), { key: "label", value: "two words", negated: false });
  assert.equal(r.token.text, 'label:"two words"');
});

test("token ids are valid for the host: non-empty id/text/label, no control characters", () => {
  const t = qualToken(qual("label", "été 🚀"));
  assert.ok(t.id && t.text && t.label);
  assert.ok(!/[\u0000-\u001f]/.test(t.id + t.text + t.label));
});

test("createLoader: runs a single commit and delivers its result tagged with the request", async () => {
  const seen = [];
  const loader = createLoader({ run: async (r) => `got ${r.query}`, onResult: (r, v) => seen.push([r.query, v]) });
  await loader.commit({ query: "A", scopes: ["o"] });
  assert.deepEqual(seen, [["A", "got A"]]);
});

test("createLoader: A running, B committed, A completes -> A discarded, B runs and shown", async () => {
  const gates = {};
  const run = (r) => new Promise((res) => { gates[r.query] = () => res(`got ${r.query}`); });
  const seen = [];
  const loader = createLoader({ run, onResult: (r, v) => seen.push([r.query, v]), onError: (r, e) => seen.push(["err", r.query]) });
  const done = loader.commit({ query: "A", scopes: ["o"] });
  assert.equal(loader.state().running.query, "A");
  loader.commit({ query: "B", scopes: ["o", "p"] });
  loader.commit({ query: "C", scopes: ["p"] }); // coalesced: only the latest is kept
  assert.equal(loader.state().pending.query, "C");
  gates.A();
  await until(() => loader.state().running?.query === "C", "the loader moved on to C");
  assert.deepEqual(seen, []);
  assert.equal(loader.state().running.query, "C");
  assert.ok(!gates.B, "B never ran");
  gates.C();
  await done;
  assert.deepEqual(seen, [["C", "got C"]]);
  assert.deepEqual(loader.state(), { running: null, pending: null });
});

test("createLoader: a superseded request's error is discarded too; the newest error is reported", async () => {
  const seen = [];
  let n = 0;
  const run = async (r) => { n++; throw new Error(`boom ${r.query}`); };
  const loader = createLoader({ run, onResult: () => seen.push("result"), onError: (r, e) => seen.push([r.query, e.message]) });
  const p = loader.commit({ query: "A", scopes: [] });
  loader.commit({ query: "B", scopes: [] });
  await p;
  assert.deepEqual(seen, [["B", "boom B"]]);
  assert.equal(n, 2);
  await loader.commit({ query: "D", scopes: [] }); // usable after an error
  assert.deepEqual(seen.at(-1), ["D", "boom D"]);
});

test("createLoader: a throwing onResult does not wedge the queue", async () => {
  const loader = createLoader({ run: async () => 1, onResult: () => { throw new Error("ui"); }, onError: () => {} });
  await loader.commit({ query: "A", scopes: [] });
  assert.deepEqual(loader.state(), { running: null, pending: null });
});

test("restart restore: saved content comes back and builds the same request", () => {
  const saved = JSON.parse(JSON.stringify(contentFromModel([qual("is", "pr"), qual("state", "closed")])));
  const model = tokenize(restoreContent(saved));
  assert.deepEqual(toArgs(model), ["is:pr", "state:closed"]);
});

test("emptyText is filter-aware", () => {
  const s = ["example-org"];
  assert.equal(emptyText(tokenize(defaultContent()), s), "Nothing open in these scopes.");
  assert.equal(emptyText([], s), "Nothing open in these scopes.");
  assert.match(emptyText([qual("is", "issue"), qual("state", "closed")], s), /closed/);
  assert.doesNotMatch(emptyText([qual("state", "closed")], s), /Nothing open/);
  assert.match(emptyText([qual("label", "bug")], s), /label:bug/);
  assert.match(emptyText([qual("repo", "other/x")], s), /outside your scopes/);
  assert.match(emptyText([], []), /scope/i);
});

test("planRequests: scopes the query is outside of make no call; all outside -> outside message", () => {
  const q = [qual("is", "issue"), qual("repo", "example-org/api")];
  const plan = planRequests(["example-org", "other", "example-org/web"], 10, FIELDS, q);
  assert.deepEqual(plan.map((p) => p.scope), ["example-org"]);
  assert.ok(plan[0].args.includes("repo:example-org/api"));
  assert.deepEqual(planRequests(["other"], 10, FIELDS, q), []);
});

test("emptyText: closed / merged / is:pr without open state never say 'Nothing open'", () => {
  const s = ["o"];
  for (const m of [[qual("is", "closed")], [qual("is", "merged")], [qual("is", "pr")], [qual("is", "issue")],
    [qual("is", "pr"), qual("state", "closed")], [qual("state", "open"), qual("label", "bug")], [qual("is", "issue"), qual("state", "closed")]]) {
    assert.doesNotMatch(emptyText(m, s), /Nothing open/, JSON.stringify(m));
  }
  assert.match(emptyText([qual("is", "closed")], s), /is:closed/);
  assert.match(emptyText([qual("is", "pr")], s), /is:pr/);
  for (const m of [[], [qual("state", "open")], [qual("is", "issue"), qual("state", "open")], [qual("is", "pr"), qual("state", "open")]]) {
    assert.equal(emptyText(m, s), "Nothing open in these scopes.", JSON.stringify(m));
  }
});

// Fake host input: content + the token/replace calls the controller makes. `echo` re-fires 'change' after a programmatic edit.
function fakeInput(ctl = {}) {
  const inp = {
    text: "", tokens: [], sel: null, calls: 0,
    content() { return { text: this.text, tokens: this.tokens.map((s) => ({ range: { ...s.range }, token: { ...s.token } })) }; },
    edit(start, end, ins, token) {
      const delta = ins.length - (end - start);
      this.tokens = this.tokens.filter((s) => s.range.end <= start || s.range.start >= end)
        .map((s) => (s.range.start >= end ? { ...s, range: { start: s.range.start + delta, end: s.range.end + delta } } : s));
      this.text = this.text.slice(0, start) + ins + this.text.slice(end);
      if (token) this.tokens.push({ range: { start, end: start + ins.length }, token });
      this.tokens.sort((a, b) => a.range.start - b.range.start);
      if (ctl.echo) ctl.onChange?.();
    },
    replace_range_with_token(range, token) { this.calls++; this.edit(range.start, range.end, token.text, token); },
    set_selected_range(r) { this.sel = r; },
    replace(t) { this.edit(this.sel.start, this.sel.end, t); },
    type(str) { for (const ch of str) { this.text += ch; ctl.onChange?.(); } },
  };
  return inp;
}

function rig({ echo = false, scopes = ["o"] } = {}) {
  const ctl = {};
  const input = fakeInput(ctl);
  const saved = [], reqs = [];
  const c = createController({ input, scopes: () => scopes, save: (v) => saved.push(v), enqueue: (r) => reqs.push(r) });
  ctl.onChange = () => c.onChange();
  if (echo) ctl.echo = true;
  return { c, input, saved, reqs };
}

test("incremental typing: author:a -> author:alice stays plain text until the space delimiter", () => {
  for (const echo of [false, true]) {
    const { c, input, saved, reqs } = rig({ echo });
    input.type("author:alice");
    assert.equal(input.calls, 0, "no token while the word is unfinished");
    assert.deepEqual(input.tokens, []);
    assert.equal(saved.length, 0);
    assert.equal(reqs.length, 0);
    input.type(" ");
    assert.deepEqual(input.tokens.map((s) => JSON.parse(s.token.id)), [{ key: "author", value: "alice", negated: false }]);
    assert.equal(saved.length, 1, `saved once (echo=${echo})`);
    assert.deepEqual(saved[0].tokens.map((s) => s.token.text), ["author:alice"]);
    assert.equal(reqs.length, 1);
    assert.deepEqual(reqs[0], { query: [qual("author", "alice")], scopes: ["o"] });
  }
});

test("Enter converts an unterminated word, saves and enqueues", () => {
  const { c, input, saved, reqs } = rig();
  input.type("label:bug");
  c.onSubmit();
  assert.equal(input.tokens.length, 1);
  assert.deepEqual(reqs.at(-1).query, [qual("label", "bug")]);
  assert.deepEqual(saved.at(-1).tokens.map((s) => s.token.text), ["label:bug"]);
});

test("Enter with plain text still commits the query (words are search text)", () => {
  const { c, input, saved, reqs } = rig();
  input.type("outage");
  c.onSubmit();
  assert.equal(saved.length, 1);
  assert.deepEqual(reqs.at(-1).query, [{ kind: "text", text: "outage" }]);
});

test("plain typing and unrelated text edits do not save or enqueue", () => {
  const { input, saved, reqs } = rig();
  input.type("outage x");
  assert.equal(saved.length + reqs.length, 0);
});

test("click removal of a token syncs model, saves and enqueues, without a change echo", () => {
  const { c, input, saved, reqs } = rig();
  input.type("label:bug ");
  input.type("is:pr ");
  assert.equal(reqs.length, 2);
  c.onTokenClick(input.tokens[0].range);
  assert.deepEqual(input.tokens.map((s) => s.token.text), ["is:pr"]);
  assert.deepEqual(reqs.at(-1).query, [qual("is", "pr")]);
  assert.deepEqual(saved.at(-1).tokens.map((s) => s.token.text), ["is:pr"]);
  assert.deepEqual(restoreContent(JSON.parse(JSON.stringify(saved.at(-1)))).tokens.map((s) => s.token.text), ["is:pr"]);
});

test("Backspace removal seen only as a change event syncs, saves and enqueues", () => {
  const { c, input, saved, reqs } = rig();
  input.type("label:bug ");
  const before = reqs.length;
  input.tokens = []; input.text = ""; // host removed the whole token
  c.onChange();
  assert.equal(reqs.length, before + 1);
  assert.deepEqual(reqs.at(-1).query, []);
  assert.deepEqual(saved.at(-1), { text: "", tokens: [] });
  c.onChange(); // a second identical change does nothing
  assert.equal(reqs.length, before + 1);
});

test("initial token set is the baseline: opening the view does not save or enqueue", () => {
  const ctl = {};
  const input = fakeInput(ctl);
  const d = defaultContent();
  input.text = d.text; input.tokens = d.tokens;
  const saved = [], reqs = [];
  const c = createController({ input, scopes: () => ["o"], save: (v) => saved.push(v), enqueue: (r) => reqs.push(r) });
  c.onChange();
  assert.equal(saved.length + reqs.length, 0);
  assert.deepEqual(toArgs(c.model()), ["is:issue", "state:open"]);
});

test("scope removal while a request runs supersedes it, clears results of the old scopes", async () => {
  const gates = {};
  const seen = [];
  const loader = createLoader({
    run: (r) => new Promise((res) => { gates[r.scopes.join(",") || "none"] = () => res(`got ${r.scopes.length}`); }),
    onResult: (r, v) => seen.push([r.scopes, v]), onError: (r) => seen.push(["err", r.scopes]),
  });
  let scopes = ["o"];
  const input = fakeInput({});
  const c = createController({ input, scopes: () => scopes, save() {}, enqueue: (r) => loader.commit(r) });
  c.refresh(); // A for [o]
  scopes = [];
  c.refresh(); // empty-scope state is enqueued too
  assert.equal(loader.state().pending.scopes.length, 0);
  gates.o();
  await until(() => gates.none, "the empty-scope request started");
  assert.deepEqual(seen, []);
  gates.none();
  await until(() => seen.length === 1, "the empty-scope result arrived");
  assert.deepEqual(seen, [[[], "got 0"]]);
});

test("wordTokens: every complete key:value word in plain spans, quote-aware, right words only", () => {
  const t = qualToken(qual("is", "issue"));
  const text = `${t.text}label:say "hi" -a:b outage x:"p q" y: z:"open`;
  const c = { text, tokens: [{ range: { start: 0, end: t.text.length }, token: t }] };
  const final = wordTokens(c, { final: true }).map((w) => text.slice(w.range.start, w.range.end));
  assert.deepEqual(final, ["label:say", "-a:b", 'x:"p q"']);
  const live = wordTokens(c).map((w) => text.slice(w.range.start, w.range.end));
  assert.deepEqual(live, ["label:say", "-a:b", 'x:"p q"'], 'unterminated z:"open never converts');
  // The last word is only converted live once something follows it.
  assert.deepEqual(wordTokens({ text: "a:b", tokens: [] }), []);
  assert.equal(wordTokens({ text: "a:b", tokens: [] }, { final: true }).length, 1);
  assert.equal(wordTokens({ text: "a:b ", tokens: [] }).length, 1);
});

test("Enter on 'label:say \"hi\"' chips label:say and sends \"hi\" as a search word (nothing dropped)", () => {
  for (const typed of ['label:say "hi"', 'label:say "hi"']) {
    const { c, input, saved, reqs } = rig();
    input.text = typed; // pasted / typed with any change lag: no change events seen
    c.onSubmit();
    assert.deepEqual(input.tokens.map((s) => s.token.text), ["label:say"]);
    assert.deepEqual(reqs.at(-1).query, [qual("label", "say"), { kind: "text", text: '"hi"' }]);
    assert.deepEqual(toArgs(reqs.at(-1).query), ["label:say", '"hi"']);
    assert.equal(saved.length, 1);
  }
});

test("space after label:say chips it even when the change event lags one keystroke", () => {
  const { c, input, reqs } = rig();
  input.text = "label:say"; c.onChange();       // host content still lacks the space
  assert.equal(reqs.length, 0);
  input.text = "label:say "; c.onChange();
  assert.deepEqual(input.tokens.map((s) => s.token.text), ["label:say"]);
  assert.deepEqual(reqs.at(-1).query, [qual("label", "say")]);
});

test("typing after a token with no space between (host dropped the delimiter) still chips on Enter", () => {
  const { c, input, reqs } = rig();
  input.type("is:issue ");
  input.text = input.text.replace(" ", ""); input.tokens[0].range.end -= 0; // adjacent: token then text
  input.type("author:alice");
  c.onSubmit();
  assert.deepEqual(input.tokens.map((s) => s.token.text), ["is:issue", "author:alice"]);
  assert.deepEqual(reqs.at(-1).query, [qual("is", "issue"), qual("author", "alice")]);
});

test("a quoted value with an embedded quote built as a model survives commit -> save -> restore -> argv", () => {
  const node = qual("label", 'say "hi" now');
  const restored = restoreContent(JSON.parse(JSON.stringify(contentFromModel([node]))));
  const args = githubSearchArgs("o", 5, FIELDS, tokenize(restored));
  assert.equal(args.at(-1), 'label:say "hi" now');
});

test("a throwing host edit submits nothing: no save, no search, model unchanged; a later good Enter works", () => {
  const { c, input, saved, reqs } = rig();
  input.type("label:bug");
  const ok = input.replace_range_with_token.bind(input);
  input.replace_range_with_token = () => { throw new Error("host rejected"); };
  assert.throws(() => c.onSubmit(), /host rejected/);
  assert.throws(() => { input.text += " "; c.onChange(); }, /host rejected/);
  assert.equal(saved.length, 0);
  assert.equal(reqs.length, 0);
  assert.deepEqual(c.model(), []);
  input.replace_range_with_token = ok;
  c.onSubmit();
  assert.equal(reqs.length, 1);
  assert.deepEqual(reqs[0].query, [qual("label", "bug")]);
});

test("ghErrorMessage: Invalid search query shows the user's tokens, not the internal form", () => {
  const stderr = 'Invalid search query "( is:issue state:open author:nobody ) repo:o/r".\n';
  const m = ghErrorMessage(stderr, "o/r", [qual("is", "issue"), qual("state", "open"), qual("author", "nobody")]);
  assert.equal(m, "GitHub rejected the query (unknown user, label or qualifier?): is:issue state:open author:nobody.");
  assert.ok(!m.includes("repo:") && !m.split(": ").slice(1).join(": ").includes("("));
  assert.equal(ghErrorMessage("HTTP 502\nmore", "o/r", []), "gh failed for o/r: HTTP 502.");
  assert.equal(ghErrorMessage("boom.", "o", []), "gh failed for o: boom.");
  assert.equal(ghErrorMessage("", "o", []), "gh failed for o: no output.");
});
