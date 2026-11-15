import { test } from "node:test";
import assert from "node:assert/strict";
import { add, applyCommand, bySource } from "./store.js";
import { parseSourceUrl } from "./sources.js";

test("parseSourceUrl: GitHub issue/PR and Jira browse URLs only", () => {
  assert.deepEqual(parseSourceUrl("https://github.com/o/r/issues/26"), { kind: "github", id: "https://github.com/o/r/issues/26", url: "https://github.com/o/r/issues/26" });
  assert.equal(parseSourceUrl(" https://github.com/o/r/pull/7/ ").url, "https://github.com/o/r/pull/7");
  assert.deepEqual(parseSourceUrl("https://s.atlassian.net/browse/ABC-12"), { kind: "jira", id: "s.atlassian.net/ABC-12", url: "https://s.atlassian.net/browse/ABC-12" });
  for (const bad of ["", "none", "https://github.com/o/r", "https://github.com/o/r/issues/x", "https://evil.com/o/r/issues/1", "http://github.com/o/r/issues/1", "https://s.net/browse/abc-1", "https://github.com.evil.io/o/r/issues/1", null])
    assert.equal(parseSourceUrl(bad), null, String(bad));
});

test("link op sets source like an import, logs a note, refuses a URL linked elsewhere, none clears", () => {
  const a = add([], { title: "a" }, 1), b = add(a.tasks, { title: "b" }, 2);
  const url = "https://github.com/o/r/issues/26";
  const r = applyCommand(b.tasks, { op: "link", id: a.task.id, url, by: "t2g" }, 3);
  assert.deepEqual(r.task.source, { kind: "github", id: url, url });
  assert.match(r.task.notes.at(-1).text, /linked/i);
  const dup = applyCommand(r.tasks, { op: "link", id: b.task.id, url }, 4);
  assert.match(dup.error, new RegExp(a.task.id));
  assert.ok(applyCommand(r.tasks, { op: "link", id: a.task.id, url: "https://x.io/y" }, 4).error);
  assert.equal(applyCommand(r.tasks, { op: "link", id: a.task.id, url }, 4).task.source.url, url); // same card again is fine
  const off = applyCommand(r.tasks, { op: "link", id: a.task.id, url: "none" }, 5);
  assert.equal(off.task.source, null);
  assert.match(off.task.notes.at(-1).text, /unlinked/i);
  assert.match(applyCommand(b.tasks, { op: "link", id: b.task.id, url: "none" }, 5).error, /no linked/);
});

test("Jira link: only the configured site; a hand link is found by url when an import looks it up by its numeric id", () => {
  const a = add([], { title: "a" }, 1);
  const url = "https://s.atlassian.net/browse/ABC-12";
  assert.match(applyCommand(a.tasks, { op: "link", id: a.task.id, url }, 2).error, /Jira site/);
  assert.match(applyCommand(a.tasks, { op: "link", id: a.task.id, url, jiraSite: "other.atlassian.net" }, 2).error, /not the configured/);
  const r = applyCommand(a.tasks, { op: "link", id: a.task.id, url, jiraSite: "S.atlassian.net" }, 2);
  assert.equal(r.task.source.url, url);
  assert.equal(bySource(r.tasks, "jira", "s.atlassian.net/10012", url).id, a.task.id);
  assert.equal(bySource(r.tasks, "jira", "s.atlassian.net/10012"), null);
});
