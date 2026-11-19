import { test } from "node:test";
import assert from "node:assert/strict";
import { projectAddRequest, projectDiff, addProject } from "./store.js";

const ok = (cmd) => projectAddRequest({ name: "n", repo: "/r", ...cmd });

test("projectAddRequest: a valid request is normalized (trimmed name, deduped folders, empty branch = omitted)", () => {
  const r = projectAddRequest({ name: "  multi  ", repo: "/r", branch: "", folders: ["/a", "/b", "/a"] });
  assert.deepEqual(r, { value: { name: "multi", repo: "/r", branch: "", folders: ["/a", "/b"] } });
  assert.equal(ok({ branch: "feat/x" }).value.branch, "feat/x");
});

test("projectAddRequest: name is 1-200 chars with no newline or NUL", () => {
  assert.match(ok({ name: "" }).error, /name/i);
  assert.match(ok({ name: "   " }).error, /name/i);
  assert.match(ok({ name: "a\nb" }).error, /name/i);
  assert.match(ok({ name: "a\rb" }).error, /name/i);
  assert.match(ok({ name: "a\0b" }).error, /name/i);
  for (const edge of ["multi\n", "\nmulti", "multi\r", "\rmulti", "\r\nmulti\r\n", "multi\0", "\0multi"]) assert.match(ok({ name: edge }).error, /name/i, JSON.stringify(edge));
  assert.match(ok({ name: 5 }).error, /name/i);
  assert.ok(ok({ name: "x".repeat(200) }).value);
  assert.match(ok({ name: "x".repeat(201) }).error, /name/i);
});

test("projectAddRequest: repo and folders are absolute, no newline or NUL, at most 4096 chars, at most 20 folders", () => {
  for (const bad of ["", "rel/path", "./x", "/a\nb", "/a\0b", "/" + "x".repeat(4096), " /a", "/a ", 7, undefined]) assert.match(ok({ repo: bad }).error, /repo/i, JSON.stringify(bad));
  assert.ok(ok({ repo: "/" + "x".repeat(4095) }).value);
  for (const bad of ["rel", "/a\nb", "/a\0b", "/" + "x".repeat(4096), 7]) assert.match(ok({ folders: ["/ok", bad] }).error, /folder/i, JSON.stringify(bad));
  assert.match(ok({ folders: "/a" }).error, /folder/i, "folders is a list");
  assert.ok(ok({ folders: Array.from({ length: 20 }, (_, i) => `/f${i}`) }).value);
  assert.match(ok({ folders: Array.from({ length: 21 }, (_, i) => `/f${i}`) }).error, /folder/i);
});

test("projectAddRequest: a branch that cannot be a git argument is refused before git sees it", () => {
  for (const bad of ["-x", "--upload-pack=x", "a\nb", "a\0b", 3]) assert.match(ok({ branch: bad }).error, /branch/i, JSON.stringify(bad));
});

test("projectDiff: equality on the whole normalized request; names the fields that differ", () => {
  const p = addProject([], { name: "Multi", repos: "/r", folders: "/a\n/b", branch: "dev" }, 1).project;
  const req = (o = {}) => ({ name: "multi", repo: "/r", branch: "dev", folders: ["/b", "/a"], ...o });
  assert.deepEqual(projectDiff(p, req()), [], "name case and folder order do not matter");
  assert.deepEqual(projectDiff(p, req({ repo: "/other" })), ["repo"]);
  assert.deepEqual(projectDiff(p, req({ branch: "main" })), ["branch"]);
  assert.deepEqual(projectDiff(p, req({ folders: ["/a"] })), ["folders"]);
  assert.deepEqual(projectDiff(p, req({ repo: "/o", branch: "x", folders: [] })), ["repo", "branch", "folders"]);
  const two = { ...p, repos: [{ path: "/r", default: true }, { path: "/second" }] };
  assert.deepEqual(projectDiff(two, req()), ["repo"], "a project with more repos is not the same request");
});

test("projectAddRequest: a request carrying org is refused (any value, even empty); one without is unchanged", () => {
  for (const org of ["acme", "Bad Slug", "", null, 5]) {
    const r = ok({ org });
    assert.match(r.error ?? "", /org/i, JSON.stringify(org));
    assert.equal(r.value, undefined);
  }
  assert.deepEqual(ok({}), { value: { name: "n", repo: "/r", branch: "", folders: [] } });
});

test("projectDiff org: compared only when the request carries the key", () => {
  const base = { repos: [{ path: "/r", default: true }], branch: "main", folders: [] };
  const req = (o = {}) => ({ repo: "/r", branch: "main", folders: [], ...o });
  assert.deepEqual(projectDiff({ ...base, org: "acme" }, req({ org: "beta" })), ["org"]);
  assert.deepEqual(projectDiff({ ...base, org: "acme" }, req({ org: "acme" })), []);
  assert.deepEqual(projectDiff(base, req({ org: "x" })), ["org"]);
  assert.deepEqual(projectDiff({ ...base, org: "acme" }, req({ org: "" })), ["org"]);
  assert.deepEqual(projectDiff(base, req({ org: "" })), []);
  assert.deepEqual(projectDiff({ ...base, org: "acme" }, req()), [], "inbox request has no org key: never reports org");
});
