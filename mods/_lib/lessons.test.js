// The pure lessons model: org slug grammar, layer paths, entry parse, title validation, content fingerprint.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "./lessons.js";

const hdr = (n, t) => `### L-${n} ${t}`;

test("org slugs: only [a-z0-9][a-z0-9-]{0,39}, never a path", () => {
  for (const ok of ["acme", "a", "a-b-c", "0org", "x".repeat(40)]) assert.equal(L.isOrgSlug(ok), true, ok);
  for (const bad of ["..", ".", "a/b", "a\\b", "A", "-a", "x".repeat(41), "", null, undefined, 7, {}, "a\u0000b", "a b", "a.b", "é", " a"]) assert.equal(L.isOrgSlug(bad), false, JSON.stringify(bad));
  assert.equal(L.orgSlug("acme"), "acme");
  assert.throws(() => L.orgSlug("../x"), /invalid org slug/);
  assert.throws(() => L.orgSlug(null), /invalid org slug/);
});

test("lessonPaths: one path per layer, bad input gives null for that layer, never a throw", () => {
  const p = L.lessonPaths("/c/", { org: "acme", project: "P-1", agent: "wrangler" });
  assert.deepEqual(p, {
    org: { lessons: "/c/orgs/acme/lessons.md", workflows: "/c/orgs/acme/workflows.md", squads: "/c/orgs/acme/squads.md" },
    project: "/c/projects/P-1/lessons.md",
    agent: "/c/agents/wrangler.lessons.md",
  });
  assert.deepEqual(L.LAYER_FILES, ["lessons.md", "workflows.md", "squads.md"]);
  assert.deepEqual(L.lessonPaths("/c", {}), { org: null, project: null, agent: null });
  const none = { org: null, project: null, agent: null };
  for (const o of [undefined, null, 5, "x", true, []]) assert.deepEqual(L.lessonPaths("/c", o), none, String(o));
  assert.deepEqual(L.lessonPaths("/c", null), none);
  const odd = L.lessonPaths("/c", { org: "../x", project: "a/b", agent: ".." });
  assert.deepEqual(odd, { org: null, project: null, agent: null });
  assert.deepEqual(L.lessonPaths("/c", { org: "A", project: "", agent: "a\u0000" }), { org: null, project: null, agent: null });
  assert.deepEqual(L.lessonPaths("/c", { org: "acme", project: ".hidden", agent: 5 }).project, null);
  for (const rel of ["c", "", null, "./c", undefined]) assert.deepEqual(L.lessonPaths(rel, { org: "acme", project: "P", agent: "a" }), { org: null, project: null, agent: null });
});

test("sanitize strips control, format and bidi characters and collapses spaces", () => {
  assert.equal(L.sanitize("  a\u0000b\u0007c  "), "abc");
  assert.equal(L.sanitize("a \t\n  b"), "a b");
  assert.equal(L.sanitize("a\u200bb\u200dc\ufeffd\u202ee\u2066f\u2069g"), "abcdefg");
  assert.equal(L.sanitize("x\u0085y\u2028z\u2029"), "x y z");
  assert.equal(L.sanitize("a\u007fb\u009fc"), "abc");
  assert.equal(L.sanitize("ok ✓ café 日本"), "ok ✓ café 日本");
  assert.equal(L.sanitize(null), "");
});

test("parseEntries: happy path with metadata", () => {
  const text = [
    "# Lessons",
    "",
    "### L-01 Run the tests first",
    "Always run node --test before a commit.",
    "Even for a one-line change. (added 2026-03-01 · T-ABC123 · confirmed 2026-04-02)",
    "",
    "### L-2 Plain",
    "One line.",
    "",
  ].join("\n");
  const r = L.parseEntries(text);
  assert.equal(r.skipped, 0);
  assert.equal(r.entries.length, 2);
  const [a, b] = r.entries;
  assert.equal(a.id, "L-01");
  assert.equal(a.n, 1);
  assert.equal(a.title, "Run the tests first");
  assert.deepEqual(a.body, ["Always run node --test before a commit.", "Even for a one-line change."]);
  assert.equal(a.added, "2026-03-01");
  assert.equal(a.source, "T-ABC123");
  assert.equal(a.confirmed, "2026-04-02");
  assert.match(a.hash, /^[0-9a-f]{16}$/);
  assert.equal(b.id, "L-02");
  assert.equal(b.n, 2);
  assert.deepEqual([b.added, b.source, b.confirmed], [null, null, null]);
});

test("parseEntries: metadata parts are optional; the whole suffix is validated or none of it is trusted", () => {
  const e = (meta) => L.parseEntries(`### L-1 T\nbody ${meta}\n`).entries[0];
  const m = (x) => [x.added, x.source, x.confirmed];
  assert.deepEqual(m(e("(added 2026-01-02)")), ["2026-01-02", null, null]);
  assert.deepEqual(m(e("(added 2026-01-02 · confirmed 2026-02-03)")), ["2026-01-02", null, "2026-02-03"]);
  assert.deepEqual(m(e("(added 2026-01-02 · T-1)")), ["2026-01-02", "T-1", null]);
  assert.deepEqual(e("(added 2026-01-02)").body, ["body"]);
  // any malformed part: all three null, the suffix stays in the body
  for (const bad of ["(added 2026-13-45 · T-1)", "(added 2026-01-02 · bad source!)", "(added 2026-01-02 · " + "T".repeat(41) + ")",
    "(added 2026-01-02 · T-1 · confirmed 2026-99-99)", "(added 2026-01-02 · confirmed nope)", "(added 2026-01-02 · T-1 · x)",
    "(added 2026-01-02 · T-1 · confirmed 2026-02-03 · more)", "(added 2026-01-02 · confirmed 2026-02-03 · T-1)", "(added yesterday)", "(added 2026-02-30)"]) {
    const x = e(bad);
    assert.ok(x, bad);
    assert.deepEqual(m(x), [null, null, null], bad);
    assert.deepEqual(x.body, [`body ${bad}`], bad);
  }
  // unknown parenthesised text stays body
  assert.deepEqual(L.parseEntries("### L-1 T\nsee (the docs)\n").entries[0].body, ["see (the docs)"]);
});

test("parseEntries: malformed and oversized entries are skipped and counted, never thrown", () => {
  const ok = "### L-9 Fine\nGood body.\n";
  const cases = {
    "four body lines": "### L-1 T\na\nb\nc\nd\n",
    "401 chars": `### L-1 T\n${"x".repeat(401 - 10)}\n`,
    "121-char title": `### L-1 ${"t".repeat(121)}\nbody\n`,
    "bad id": "### L-x Title\nbody\n",
    "no id": "### Title only\nbody\n",
    "L-0": "### L-0 Title\nbody\n",
    "seven digits": "### L-1234567 Title\nbody\n",
    "no body": "### L-1 Title\n\n",
    "empty title": "### L-1 \nbody\n",
  };
  for (const [name, bad] of Object.entries(cases)) {
    let r;
    assert.doesNotThrow(() => { r = L.parseEntries(`${bad}\n${ok}`); }, name);
    assert.equal(r.skipped, 1, name);
    assert.deepEqual(r.entries.map((x) => x.id), ["L-09"], name);
  }
  const dup = L.parseEntries("### L-7 One\nfirst\n\n### L-07 Two\nsecond\n");
  assert.equal(dup.entries.length, 1);
  assert.equal(dup.entries[0].title, "One");
  assert.equal(dup.skipped, 1);
  for (const junk of [null, undefined, 5, "", "random text\nmore", "\u0000\u0001", {}]) {
    const r = L.parseEntries(junk);
    assert.deepEqual(r.entries, []);
    assert.equal(typeof r.skipped, "number");
  }
});

test("entry limits: exactly 3 lines and exactly 400 chars are accepted; metadata counts", () => {
  assert.equal(L.parseEntries("### L-1 T\na\nb\nc\n").entries.length, 1);
  const head = "### L-1 T\n";
  const exact = head + "x".repeat(400 - head.length);
  assert.equal(L.parseEntries(exact).entries.length, 1);
  assert.equal(L.parseEntries(exact + "x").skipped, 1);
  const meta = " (added 2026-01-02 · T-1)";
  const withMeta = head + "x".repeat(400 - head.length - meta.length) + meta;
  assert.equal(L.parseEntries(withMeta).entries.length, 1);
  assert.equal(L.parseEntries(head + "x".repeat(401 - head.length - meta.length) + meta).skipped, 1);
  assert.equal(L.TITLE_MAX, 120);
  assert.equal(L.BODY_LINES_MAX, 3);
  assert.equal(L.ENTRY_CHARS_MAX, 400);
  assert.equal(L.FILE_READ_MAX_BYTES, 65536);
});

test("ids: L-7 and L-07 are the same id, canonical L-07", () => {
  assert.equal(L.parseEntries("### L-7 A\nb\n").entries[0].id, "L-07");
  assert.equal(L.parseEntries("### L-123 A\nb\n").entries[0].id, "L-123");
  assert.equal(L.parseEntries("### L-999999 A\nb\n").entries[0].n, 999999);
  assert.deepEqual(L.entryTitle("### L-7 Good"), { id: "L-07", title: "Good" });
});

test("CRLF files parse like LF files", () => {
  const r = L.parseEntries("### L-1 One\r\nbody\r\n\r\n### L-2 Two\r\nbody2\r\n");
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.entries.map((e) => [e.title, e.body]), [["One", ["body"]], ["Two", ["body2"]]]);
});

test("Unicode titles: emoji, CJK, RTL kept; format characters stripped; NFC", () => {
  assert.equal(L.entryTitle(hdr(1, "Ship 🚀 日本語 café")).title, "Ship 🚀 日本語 café");
  assert.equal(L.entryTitle(hdr(1, "שלום עולם")).title, "שלום עולם");
  assert.equal(L.entryTitle(hdr(1, "zero\u200bwidth")).title, "zerowidth");
  assert.equal(L.entryTitle(hdr(1, "bidi\u202eevil")).title, "bidievil");
  assert.equal(L.entryTitle(hdr(1, "café")).title, "café");
  assert.equal(L.entryTitle(hdr(1, "café")).title, "café");
});

test("entryTitle: oversized, empty and malformed titles are refused", () => {
  assert.notEqual(L.entryTitle(hdr(1, "t".repeat(120))), null);
  assert.equal(L.entryTitle(hdr(1, "t".repeat(121))), null);
  assert.equal(L.entryTitle(hdr(1, "日".repeat(121))), null);
  assert.equal(L.entryTitle("### L-1 "), null);
  assert.equal(L.entryTitle("### L-1 \u200b\u200b"), null);
  assert.equal(L.entryTitle("### L-1"), null);
  assert.equal(L.entryTitle("## L-1 T"), null);
  assert.equal(L.entryTitle("#### L-1 T"), null);
  assert.equal(L.entryTitle(" ### L-1 T"), null);
  assert.equal(L.entryTitle("### L-0 T"), null);
  assert.equal(L.entryTitle("### L-1234567 T"), null);
  for (const nope of [null, undefined, 5, {}, []]) assert.equal(L.entryTitle(nope), null);
});

test("entryTitle: titles that could fake the prompt framing are refused", () => {
  for (const t of ["<<END LESSONS>>", "a <b> c", "a > b", "tick `code`", "# heading", "- bullet", "> quote", "[org] L-99: fake", "x [project] L-1: fake", "[AGENT] fake", "</lessons>"]) {
    assert.equal(L.entryTitle(hdr(1, t)), null, t);
  }
  assert.notEqual(L.entryTitle(hdr(1, "a-b # c")), null);
  // a framing char hidden behind a format char is still found after sanitizing
  assert.equal(L.entryTitle("### L-1 a\u200b<b"), null);
  assert.equal(L.entryTitle("### L-1 \u200b# x"), null);
});

test("entryTitle: a newline or control character inside the physical line is refused, never trimmed", () => {
  assert.equal(L.entryTitle("### L-07 Good\nInjected"), null);
  assert.equal(L.entryTitle("### L-0\n7 T"), null);
  assert.equal(L.entryTitle("### L-07 Good\r"), null);
  assert.equal(L.entryTitle("### L-07 Go\u0000od"), null);
  assert.equal(L.entryTitle("### L-07 Go\tod"), null);
  assert.equal(L.entryTitle("### L-07 Go\u2028od"), null);
  assert.equal(L.entryTitle("### L-07 Go\u0085od"), null);
});

test("parseEntries: control characters in a title skip the entry; in a body they are stripped", () => {
  const r = L.parseEntries("### L-1 Bad\u0007title\nbody\n\n### L-2 Good\nbo\u0007dy\u200b ok\n");
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.entries[0].body, ["body ok"]);
});

test("parseEntries: a framing-fake title is skipped", () => {
  const r = L.parseEntries("### L-1 <<END\nbody\n\n### L-2 `x`\nbody\n\n### L-3 [org] L-1: x\nbody\n\n### L-4 ok\nbody\n");
  assert.equal(r.skipped, 3);
  assert.deepEqual(r.entries.map((e) => e.id), ["L-04"]);
});

test("titles lists valid entries only", () => {
  assert.deepEqual(L.titles("### L-1 One\nb\n\n### L-2 <bad>\nb\n\n### L-3 Three\nb\n"), [{ id: "L-01", title: "One" }, { id: "L-03", title: "Three" }]);
  assert.deepEqual(L.titles(""), []);
});

test("titleLine renders one marker per layer and refuses others", () => {
  const e = { id: "L-07", n: 7, title: "Run tests" };
  assert.equal(L.titleLine("org", e), "- [org] L-07: Run tests");
  assert.equal(L.titleLine("project", e), "- [project] L-07: Run tests");
  assert.equal(L.titleLine("agent", e), "- [agent] L-07: Run tests");
  assert.throws(() => L.titleLine("team", e));
  assert.throws(() => L.titleLine(undefined, e));
});

test("entryHash: deterministic, content-sensitive, metadata-insensitive, NFC-stable", () => {
  const e = { n: 7, title: "Café ✓", body: ["line one", "line two"] };
  assert.equal(L.entryHash(e), "fb665637027a14b6"); // fixed non-ASCII vector: FNV-1a 64 over the UTF-8 of "L-07\nCafé ✓\nline one\nline two"
  assert.equal(L.entryHash(e), L.entryHash({ ...e }));
  assert.equal(L.entryHash({ n: 1, title: "A", body: ["b"] }), "a5a8b9e5da5db9f8");
  assert.notEqual(L.entryHash(e), L.entryHash({ ...e, title: "Cafe ✓" }));
  assert.notEqual(L.entryHash(e), L.entryHash({ ...e, body: ["line one", "line twO"] }));
  assert.notEqual(L.entryHash(e), L.entryHash({ ...e, n: 8 }));
  assert.equal(L.entryHash(e), L.entryHash({ ...e, added: "2026-01-01", source: "T-1", confirmed: "2026-02-02" }));
  assert.equal(L.entryHash({ n: 1, title: "café", body: ["x"] }), L.entryHash({ n: 1, title: "café", body: ["x"] }));
  assert.equal(L.entryHash({ id: "L-07", title: e.title, body: e.body }), L.entryHash(e));
  // a confirm (date added to the file) keeps the parsed hash
  const a = L.parseEntries("### L-1 T\nbody (added 2026-01-01)\n").entries[0];
  const b = L.parseEntries("### L-1 T\nbody (added 2026-01-01 · confirmed 2026-05-05)\n").entries[0];
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{16}$/);
});

test("titleKey normalises for exact-duplicate detection", () => {
  assert.equal(L.titleKey("  Run   TESTS "), "run tests");
  assert.equal(L.titleKey("Café"), L.titleKey("café"));
  assert.notEqual(L.titleKey("a"), L.titleKey("b"));
});

test("boundText: under the limit is unchanged; over it is cut on a char boundary and drops the partial entry", () => {
  assert.equal(L.boundText("### L-1 A\nb\n"), "### L-1 A\nb\n");
  assert.equal(L.boundText(null), "");
  const entry = (n) => `### L-${n} T\n${"x".repeat(100)}\n\n`;
  let big = "";
  for (let i = 1; Buffer.byteLength(big) < 70000; i++) big += entry(i);
  const out = L.boundText(big);
  assert.ok(Buffer.byteLength(out) <= 65536);
  assert.ok(big.startsWith(out));
  const r = L.parseEntries(out);
  assert.equal(r.skipped, 0);
  assert.ok(r.entries.length > 100);
  assert.ok(/\n\n$|\n$/.test(out));
  // every kept entry is whole
  assert.ok(r.entries.every((e) => e.body[0] === "x".repeat(100)));
});

test("boundText: multibyte text is never split inside a character", () => {
  const entry = (n) => `### L-${n} 日本\n${"日".repeat(90)}\n\n`;
  let big = "";
  for (let i = 1; Buffer.byteLength(big) < 70000; i++) big += entry(i);
  const out = L.boundText(big);
  assert.ok(Buffer.byteLength(out) <= 65536);
  assert.ok(!out.includes("�"));
  assert.ok(big.startsWith(out));
  assert.equal(L.parseEntries(out).skipped, 0);
});

test("boundText: a heading or body straddling the cut is dropped, not half-read", () => {
  const filler = "### L-1 First\nok\n\n";
  // heading straddles the cut
  let t = filler + "### L-2 " + "h".repeat(70000);
  let out = L.boundText(t);
  assert.ok(Buffer.byteLength(out) <= 65536);
  assert.deepEqual(L.parseEntries(out).entries.map((e) => e.id), ["L-01"]);
  // body straddles the cut
  t = filler + "### L-2 Second\n" + "b".repeat(70000);
  out = L.boundText(t);
  assert.deepEqual(L.parseEntries(out).entries.map((e) => e.id), ["L-01"]);
  assert.ok(!out.includes("Second"));
  // nothing complete at all
  assert.equal(L.boundText("### L-1 A\n" + "q".repeat(70000)), "");
});

test("boundText with truncated:true: a capped read ending inside a heading or body drops that entry", () => {
  const CAP = L.FILE_READ_MAX_BYTES;
  const first = "### L-1 First\nok\n\n";
  const cap = (head, tail) => {
    // head + filler + tail, exactly CAP bytes, the filler being ignored text outside any entry
    const fill = "z".repeat(CAP - Buffer.byteLength(first + head + tail) - 2);
    const t = first + fill + "\n\n" + head + tail;
    assert.equal(Buffer.byteLength(t), CAP);
    return t;
  };
  const ids = (t, o) => L.parseEntries(L.boundText(t, o)).entries.map((e) => e.id);
  // ends inside the body, no boundary yet
  let t = cap("### L-2 Title\n", "body");
  assert.deepEqual(ids(t, { truncated: true }), ["L-01"]);
  // ends inside the heading
  t = cap("### L-2 Ti", "");
  assert.deepEqual(ids(t, { truncated: true }), ["L-01"]);
  // ends right after the body line but without its newline / boundary
  t = cap("### L-2 Title\n", "body\n");
  assert.deepEqual(ids(t, { truncated: true }), ["L-01"]);
  // a complete boundary after the entry keeps it
  t = cap("### L-2 Title\n", "body\n\n");
  assert.deepEqual(ids(t, { truncated: true }), ["L-01", "L-02"]);
  // without the flag an exact-cap text is trusted as complete (a whole file)
  t = cap("### L-2 Title\n", "body");
  assert.deepEqual(ids(t), ["L-01", "L-02"]);
  // a small complete file is unchanged; a small truncated read still drops its partial tail
  assert.equal(L.boundText("### L-1 A\nb\n\n"), "### L-1 A\nb\n\n");
  assert.deepEqual(ids("### L-1 A\nb\n\n### L-2 B\npartial", { truncated: true }), ["L-01"]);
  assert.equal(L.boundText("### L-1 A\nb", { truncated: true }), "");
});

test("parseEntries bounds oversized input and stays quick", () => {
  const huge = "### L-1 A\nb\n\n".repeat(20000);
  const t0 = Date.now();
  const r = L.parseEntries(huge);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(r.entries.length <= 1 && r.skipped < 20000);
  const withHuge = "### L-1 Ok\nb\n\n" + "z".repeat(1_000_000);
  assert.doesNotThrow(() => L.parseEntries(withHuge));
});

test("formatEntry: canonical text that parses back to the same entry", () => {
  const x = { n: 7, title: "Run the tests", body: ["First line.", "Second line."], added: "2026-03-01", source: "T-ABC", confirmed: "2026-04-02" };
  const text = L.formatEntry(x);
  assert.equal(text, "### L-07 Run the tests\nFirst line.\nSecond line. (added 2026-03-01 · T-ABC · confirmed 2026-04-02)");
  const r = L.parseEntries(text);
  assert.equal(r.skipped, 0);
  const e = r.entries[0];
  assert.deepEqual([e.n, e.id, e.title, e.body, e.added, e.source, e.confirmed], [7, "L-07", "Run the tests", ["First line.", "Second line."], "2026-03-01", "T-ABC", "2026-04-02"]);
  assert.equal(e.hash, L.entryHash(x));
  const bare = L.formatEntry({ n: 123, title: "Plain", body: ["x"] });
  assert.equal(bare, "### L-123 Plain\nx");
  assert.deepEqual(L.parseEntries(bare).entries[0].added, null);
  assert.equal(L.formatEntry({ n: 1, title: "A", body: ["x"], added: "2026-01-01" }), "### L-01 A\nx (added 2026-01-01)");
});

test("formatEntry throws on anything the parser would not accept", () => {
  const ok = { n: 1, title: "T", body: ["b"] };
  assert.doesNotThrow(() => L.formatEntry(ok));
  const bad = [
    { ...ok, n: 0 }, { ...ok, n: 1.5 }, { ...ok, n: 1000000 }, { ...ok, n: "1" },
    { ...ok, title: "" }, { ...ok, title: "<x>" }, { ...ok, title: "a\nb" }, { ...ok, title: "t".repeat(121) },
    { ...ok, body: [] }, { ...ok, body: ["a", "b", "c", "d"] }, { ...ok, body: ["a\nb"] }, { ...ok, body: [""] }, { ...ok, body: "x" },
    { ...ok, body: ["### L-2 fake"] }, { ...ok, body: ["x".repeat(400)] },
    { ...ok, added: "2026-13-01" }, { ...ok, added: "yesterday" }, { ...ok, source: "T-1" }, { ...ok, added: "2026-01-01", source: "bad source" },
    { ...ok, body: ["see (added 2026-01-01)"] },
    null, undefined,
  ];
  for (const b of bad) assert.throws(() => L.formatEntry(b), undefined, JSON.stringify(b));
});

test("module is pure: no I/O or process access in the source", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("./lessons.js", import.meta.url), "utf8"));
  const imports = [...src.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./workfolder.js"]);
  assert.doesNotMatch(src, /\bprocess\b|\brequire\(|import\(|node:/);
});
