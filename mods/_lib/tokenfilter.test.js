// Generic token filter and menu helpers, tested with a non-GitHub parser: `key=value` qualifiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTokenFilter, qualToken, createLoader } from "./tokenfilter.js";
import { nextIndex, rank, wordAt, lc } from "./tokenmenu.js";

const qual = (key, value, negated = false) => ({ kind: "qual", key, value, negated });
// Words `k=v` (or `-k=v`) are qualifiers, `OR` is an operator, the rest is text.
const parseQuery = (text) => text.split(/\s+/).filter(Boolean).map((w) => {
  if (w === "OR") return { kind: "op" };
  const m = /^(-?)(\w+)=(.+)$/.exec(w);
  return m ? qual(m[2], m[3], m[1] === "-") : { kind: "text", text: w };
});
const tf = createTokenFilter({ parseQuery, defaultModel: [qual("status", "open")] });

test("default content is one token built from defaultModel", () => {
  const c = tf.defaultContent();
  assert.equal(c.text, "status:open ");
  assert.deepEqual(tf.tokenize(c), [qual("status", "open")]);
});

test("tokenize reads token ids and parses plain spans with the given parser", () => {
  const t = qualToken(qual("who", "a b"));
  assert.equal(t.text, 'who:"a b"');
  const c = { text: `${t.text} x=1 OR hello `, tokens: [{ range: { start: 0, end: t.text.length }, token: t }] };
  assert.deepEqual(tf.tokenize(c), [qual("who", "a b"), qual("x", "1"), { kind: "op" }, { kind: "text", text: "hello" }]);
});

test("wordTokens converts `=` words only, the last one with final", () => {
  const c = { text: "a=1 b=2", tokens: [] };
  assert.deepEqual(tf.wordTokens(c).map((w) => w.token.text), ["a:1"]);
  assert.deepEqual(tf.wordTokens(c, { final: true }).map((w) => w.token.text), ["a:1", "b:2"]);
  assert.equal(tf.wordToken({ text: "plain ", tokens: [] }, 6), null);
});

test("restoreContent keeps valid content and falls back on garbage", () => {
  const c = tf.contentFromModel([qual("a", "1"), { kind: "op" }]);
  assert.deepEqual(tf.restoreContent(c), c);
  assert.deepEqual(tf.restoreContent({ text: "", tokens: [] }), { text: "", tokens: [] });
  assert.deepEqual(tf.restoreContent({ text: "zz", tokens: [{ range: { start: 0, end: 2 }, token: { id: "{}", text: "zz", label: "zz" } }] }), tf.defaultContent());
  assert.deepEqual(tf.restoreContent(null), tf.defaultContent());
});

test("controller: Enter converts words, saves and enqueues the model", () => {
  const input = {
    c: { text: "a=1 ", tokens: [] },
    content() { return this.c; },
    replace_range_with_token(r, token) {
      const text = this.c.text;
      this.c = { text, tokens: [...this.c.tokens, { range: r, token }].sort((x, y) => x.range.start - y.range.start) };
    },
  };
  const saved = [], queued = [];
  const ctl = tf.createController({ input, scopes: () => ["s"], save: (c) => saved.push(c), enqueue: (r) => queued.push(r) });
  ctl.onSubmit();
  assert.equal(saved.length, 1);
  assert.deepEqual(queued, [{ query: [qual("a", "1")], scopes: ["s"] }]);
  assert.deepEqual(ctl.model(), [qual("a", "1")]);
});

test("createLoader: latest wins", async () => {
  const done = [];
  const loader = createLoader({ run: async (r) => r, onResult: (r, v) => done.push(v) });
  loader.commit(1); loader.commit(2); await loader.commit(3);
  assert.deepEqual(done, [3]);
});

test("menu helpers", () => {
  assert.equal(nextIndex(0, 3, "up"), 2);
  assert.equal(nextIndex(2, 3, "down"), 0);
  assert.equal(nextIndex(0, 0, "down"), 0);
  assert.equal(lc("AbC"), "abc");
  const pool = [{ n: "Assignee" }, { n: "Reporter" }, { n: "Label" }];
  assert.deepEqual(rank(pool, "ass", (x) => [x.n]).map((x) => x.n), ["Assignee"]);
  assert.deepEqual(rank(pool, "e", (x) => [x.n]).map((x) => x.n), ["Assignee", "Reporter", "Label"]); // prefix: none; substring keeps pool order
  assert.deepEqual(wordAt({ text: "ass", tokens: [] }, 3), { range: { start: 0, end: 3 }, word: "ass" });
  assert.equal(wordAt({ text: "tok x", tokens: [{ range: { start: 0, end: 3 }, token: {} }] }, 3), null);
});
