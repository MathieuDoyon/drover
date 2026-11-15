// GitHub filter key/value menu: pure item builders, highlight, pick -> controller sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { menuState, nextIndex, KEYS } from "../drover-github/menu.js";
import { createController, qualToken, tokenize, defaultContent, contentFromModel } from "../drover-github/filter.js";

const C = (text, tokens = []) => ({ text, tokens });
const labels = (m) => m.items.map((i) => i.label);
const find = (m, label) => m.items.find((i) => i.label === label);
const qual = (key, value, negated = false) => ({ kind: "qual", key, value, negated });

test("empty input opens the keys stage: v1 keys with glyphs, then AND / OR / Exclude", () => {
  const m = menuState(C(""));
  assert.equal(m.open, true);
  assert.equal(m.stage, "keys");
  assert.deepEqual(m.range, { start: 0, end: 0 });
  assert.deepEqual(labels(m), ["Is", "State", "Label", "Assignee", "Author", "Involves", "Mentions", "Milestone",
    "Review requested", "Draft", "Project", "In", "Repo", "Created", "Updated", "Commenter", "Comments",
    "AND", "OR", "Exclude", "Reset filter"]);
  for (const i of m.items) assert.ok(i.glyph, i.label);
  assert.equal(KEYS.length, 17);
});

test("opens after a space, closes inside a token and right after a token without a space", () => {
  const tok = qualToken(qual("is", "issue"));
  const text = `${tok.text} `;
  const content = C(text, [{ range: { start: 0, end: tok.text.length }, token: tok }]);
  assert.equal(menuState(content).open, true);
  assert.deepEqual(menuState(content).range, { start: text.length, end: text.length });
  assert.equal(menuState(content, tok.text.length).open, false);
  assert.equal(menuState(content, 3).open, false);
  assert.equal(menuState(C(`${tok.text}x`, [{ range: { start: 0, end: tok.text.length }, token: tok }])).range.start, tok.text.length);
});

test("typing filters keys case-insensitively by prefix then substring: auth -> Author", () => {
  const m = menuState(C("auth"));
  assert.deepEqual(labels(m), ["Author"]);
  assert.deepEqual(m.range, { start: 0, end: 4 });
  assert.deepEqual(labels(menuState(C("AUTH"))), ["Author"]);
  assert.deepEqual(labels(menuState(C("review"))), ["Review requested"]);
  assert.deepEqual(labels(menuState(C("review-"))), ["Review requested"]);
  assert.deepEqual(labels(menuState(C("a"))).slice(0, 2), ["Assignee", "Author"], "prefix matches first");
  assert.ok(labels(menuState(C("a"))).includes("Label"), "substring matches follow");
  assert.equal(menuState(C("zzz")).open, false, "no match closes");
});

test("a plain word that is not a key prefix, e.g. outage, closes the menu", () => {
  assert.equal(menuState(C("outage")).open, false);
});

test("picking a key inserts text key: and the menu moves to values", () => {
  const m = menuState(C("auth"));
  assert.deepEqual(m.items[0].insert, { range: { start: 0, end: 4 }, text: "author:" });
  const v = menuState(C("author:"));
  assert.equal(v.stage, "values");
  assert.equal(v.key, "author");
  const rr = menuState(C("review"));
  assert.equal(rr.items[0].insert.text, "review-requested:");
});

test("Exclude inserts '-' and the next key picks -key:", () => {
  const ex = find(menuState(C("")), "Exclude");
  assert.deepEqual(ex.insert, { range: { start: 0, end: 0 }, text: "-" });
  const m = menuState(C("-"));
  assert.equal(m.stage, "keys");
  assert.equal(m.negated, true);
  assert.ok(!labels(m).includes("OR") && !labels(m).includes("Exclude") && !labels(m).includes("AND"));
  assert.equal(find(m, "Label").insert.text, "-label:");
  assert.equal(menuState(C("-lab")).items[0].insert.text, "-label:");
});

test("AND is implicit: it inserts nothing, only clears the typed word; OR is a plain word", () => {
  const and = find(menuState(C("")), "AND");
  assert.deepEqual(and.insert, { range: { start: 0, end: 0 }, text: "" });
  const or = find(menuState(C("o")), "OR");
  assert.deepEqual(or.insert, { range: { start: 0, end: 1 }, text: "OR " });
  assert.deepEqual(tokenize(C("OR ")).map((n) => n.kind), ["op"]);
  assert.deepEqual(labels(menuState(C("an"))), ["AND"]);
});

test("values: author offers Me (@me) as a token, Exclude, and no Has author / no -no:", () => {
  const m = menuState(C("author:"));
  assert.deepEqual(labels(m), ["Me", "Exclude"]);
  const me = find(m, "Me");
  assert.deepEqual(me.insert.range, { start: 0, end: 7 });
  assert.deepEqual(me.insert.token, qualToken(qual("author", "@me")));
  assert.deepEqual(find(m, "Exclude").insert, { range: { start: 0, end: 7 }, text: "-author:" });
  const neg = menuState(C("-author:"));
  assert.deepEqual(labels(neg), ["Me"]);
  assert.deepEqual(find(neg, "Me").insert.token, qualToken(qual("author", "@me", true)));
});

test("values: No X items are no:assignee|label|milestone|project, never negated", () => {
  const cases = { assignee: "No assignee", label: "No label", milestone: "No milestone", project: "No project" };
  for (const [key, text] of Object.entries(cases)) {
    const it = find(menuState(C(`${key}:`)), text);
    assert.ok(it, text);
    assert.deepEqual(it.insert.token, qualToken(qual("no", key)));
    assert.equal(find(menuState(C(`-${key}:`)), text), undefined, `no -no: for ${key}`);
  }
  assert.equal(find(menuState(C("author:")), "No author"), undefined);
  assert.equal(find(menuState(C("author:")), "Has author"), undefined);
  assert.equal(find(menuState(C("assignee:")), "Has assignee"), undefined);
});

test("values: fixed lists for is / state / draft / in; review-requested offers Me", () => {
  const vals = (c) => menuState(C(c)).items.filter((i) => i.insert.token && i.id !== "use").map((i) => JSON.parse(i.insert.token.id).value);
  assert.deepEqual(vals("is:"), ["issue", "pr", "open", "closed", "draft", "merged", "locked"]);
  assert.deepEqual(vals("state:"), ["open", "closed"]);
  assert.deepEqual(vals("draft:"), ["true", "false"]);
  assert.deepEqual(vals("in:"), ["title", "body", "comments"]);
  assert.deepEqual(vals("review-requested:"), ["@me"]);
  assert.deepEqual(vals("involves:"), ["@me"]);
  assert.deepEqual(vals("mentions:"), ["@me"]);
  assert.deepEqual(vals("is:p"), ["pr"]);
});

test("values: free text -> 'Use <typed>' unless it is a listed value", () => {
  const m = menuState(C("author:alice"));
  assert.deepEqual(labels(m), ["Use alice"]);
  assert.deepEqual(m.items[0].insert.token, qualToken(qual("author", "alice")));
  assert.deepEqual(m.items[0].insert.range, { start: 0, end: 12 });
  assert.deepEqual(labels(menuState(C("is:pr"))), ["pr"]);
  assert.deepEqual(labels(menuState(C("is:PR"))), ["pr"]);
  assert.deepEqual(labels(menuState(C("label:good"))), ["Use good"]);
  assert.deepEqual(menuState(C("-label:bug")).items[0].insert.token, qualToken(qual("label", "bug", true)));
  assert.deepEqual(labels(menuState(C("author:@me"))), ["Me"]);
  assert.equal(menuState(C("is:zzz")).items[0].label, "Use zzz");
});

test("values: repo offers repo scopes only; an org scope offers just free text", () => {
  const org = menuState(C("repo:"), undefined, { scopes: ["example-org"] });
  assert.deepEqual(labels(org), ["Exclude"]);
  assert.equal(org.open, true, "stays open on the values stage");
  const both = menuState(C("repo:"), undefined, { scopes: ["example-org", "example-org/a", "o/b"] });
  assert.deepEqual(labels(both), ["example-org/a", "o/b", "Exclude"]);
  assert.deepEqual(find(both, "o/b").insert.token, qualToken(qual("repo", "o/b")));
  const typed = menuState(C("repo:example-org/x"), undefined, { scopes: ["example-org"] });
  assert.deepEqual(labels(typed), ["Use example-org/x"]);
  assert.equal(typed.items[0].hint, "");
  const out = menuState(C("repo:zed/x"), undefined, { scopes: ["example-org"] });
  assert.equal(out.items[0].hint, "outside your scopes");
  assert.equal(menuState(C("repo:"), undefined, { scopes: [] }).open, true);
});

test("unknown key and a quoted/closed value close the menu", () => {
  assert.equal(menuState(C("foo:")).open, false);
  assert.equal(menuState(C('label:"ab')).open, false);
});

test("nextIndex wraps both ways and handles empty lists", () => {
  assert.equal(nextIndex(0, 3, "down"), 1);
  assert.equal(nextIndex(2, 3, "down"), 0);
  assert.equal(nextIndex(0, 3, "up"), 2);
  assert.equal(nextIndex(1, 3, "up"), 0);
  assert.equal(nextIndex(0, 0, "down"), 0);
});

// A fake InputState that tracks text, tokens and a selection, like the controller tests.
function fakeInput() {
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
      this.caret = start + ins.length;
    },
    replace_range_with_token(range, token) { this.calls++; this.edit(range.start, range.end, token.text, token); },
    set_selected_range(r) { this.sel = r; },
    set_value(c) { this.text = c.text; this.tokens = c.tokens.map((t) => ({ range: { ...t.range }, token: { ...t.token } })); },
    replace(t) { this.edit(this.sel.start, this.sel.end, t); },
  };
  return inp;
}

function rig() {
  const input = fakeInput();
  const saved = [], reqs = [];
  const c = createController({ input, scopes: () => ["o"], save: (v) => saved.push(v), enqueue: (r) => reqs.push(r) });
  return { c, input, saved, reqs };
}

test("controller.pick(token) inserts the token plus a space, then syncs model, save and enqueue", () => {
  const { c, input, saved, reqs } = rig();
  input.text = "author:";
  const item = find(menuState(input.content()), "Me");
  c.pick(item.insert);
  assert.equal(input.text, "author:@me ");
  assert.deepEqual(input.tokens.map((s) => JSON.parse(s.token.id)), [{ key: "author", value: "@me", negated: false }]);
  assert.equal(saved.length, 1);
  assert.deepEqual(reqs, [{ query: [qual("author", "@me")], scopes: ["o"] }]);
  assert.equal(menuState(input.content()).stage, "keys", "next word: back to keys");
});

test("controller.pick(text) replaces the word without saving or enqueueing", () => {
  const { c, input, saved, reqs } = rig();
  input.text = "auth";
  c.pick(menuState(input.content()).items[0].insert);
  assert.equal(input.text, "author:");
  assert.equal(input.calls, 0);
  assert.equal(saved.length + reqs.length, 0);
  assert.equal(menuState(input.content()).stage, "values");
  c.pick(find(menuState(input.content()), "Exclude").insert);
  assert.equal(input.text, "-author:");
});

test("pick after an earlier token keeps it; AND pick only clears the word", () => {
  const { c, input, reqs } = rig();
  input.text = "is:issue ";
  c.pick({ range: { start: 0, end: 8 }, token: qualToken(qual("is", "issue")) });
  input.text += "s";
  const m = menuState(input.content());
  c.pick(find(m, "State").insert);
  assert.equal(input.text.endsWith("state:"), true);
  assert.equal(reqs.length, 1);
});

test("is: hides the kind that conflicts with an existing positive is:issue / is:pr", () => {
  const isVals = (content) => menuState({ ...content, text: `${content.text}is:` }).items.filter((i) => i.id !== "use" && i.insert.token).map((i) => i.id);
  assert.deepEqual(isVals(defaultContent()), ["issue", "open", "closed", "draft", "merged", "locked"], "default has is:issue: pr hidden");
  assert.deepEqual(isVals(contentFromModel([qual("is", "pr")])), ["pr", "open", "closed", "draft", "merged", "locked"]);
  assert.deepEqual(isVals(contentFromModel([qual("is", "issue", true)])), ["issue", "pr", "open", "closed", "draft", "merged", "locked"], "a negated is:issue does not conflict");
  assert.deepEqual(isVals(contentFromModel([])), ["issue", "pr", "open", "closed", "draft", "merged", "locked"]);
  // Typing the conflicting value offers no token for it either.
  const typed = menuState({ ...defaultContent(), text: `${defaultContent().text}is:pr` });
  assert.deepEqual(typed.items.map((i) => i.id), []);
});

// C5: extra keys and Reset filter.
test("Commenter is a people key (Me); Comments, Created, Updated, Mentions and Project take typed raw values", () => {
  assert.ok(find(menuState(C("commenter:")), "Me"));
  const me = find(menuState(C("commenter:")), "Me");
  assert.deepEqual(JSON.parse(me.insert.token.id), { key: "commenter", value: "@me", negated: false });
  for (const [typed, key, value] of [["comments:>5", "comments", ">5"], ["created:>2026-01-01", "created", ">2026-01-01"],
    ["updated:<2026-06-01", "updated", "<2026-06-01"], ["mentions:alice", "mentions", "alice"], ["project:example-org/7", "project", "example-org/7"]]) {
    const use = find(menuState(C(typed)), `Use ${value}`);
    assert.ok(use, typed);
    assert.deepEqual(JSON.parse(use.insert.token.id), { key, value, negated: false });
  }
  assert.deepEqual(labels(menuState(C("comm"))), ["Commenter", "Comments"]);
});

test("Reset filter is offered in the keys stage (not negated) and filters by typing", () => {
  const item = find(menuState(C("")), "Reset filter");
  assert.deepEqual(item.insert, { reset: true });
  assert.deepEqual(labels(menuState(C("reset"))), ["Reset filter"]);
  assert.equal(find(menuState(C("-")), "Reset filter"), undefined);
  assert.equal(find(menuState(C("author:")), "Reset filter"), undefined);
});

test("controller.pick(reset) restores is:issue state:open as tokens, saves and enqueues", () => {
  const { c, input, saved, reqs } = rig();
  input.text = "label:bug outage";
  c.pick({ reset: true });
  assert.deepEqual(input.content(), defaultContent());
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], defaultContent());
  assert.deepEqual(reqs, [{ query: [qual("is", "issue"), qual("state", "open")], scopes: ["o"] }]);
  assert.deepEqual(c.model(), [qual("is", "issue"), qual("state", "open")]);
});

test("typing comm / commen / comment in an empty field lists Commenter and Comments", () => {
  for (const w of ["comm", "commen", "comment"]) {
    const m = menuState(C(w));
    assert.equal(m.open, true, w);
    assert.deepEqual(labels(m), ["Commenter", "Comments"], w);
  }
});
