import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkFolder, safeSegment, FREE_PROJECT } from "../_lib/workfolder.js";
import { field, validate } from "../_lib/config-schema.js";
import { resolve } from "../_lib/config.js";

const base = { repo: "/r/app", worktree: null, project: { id: "P-1", name: "App" }, runId: "R-9", configDir: "/h/.config/drover-herdr" };
const at = (o) => resolveWorkFolder({ ...base, ...o });

test("repo mode: <repo>/.drover, or <worktree>/.drover for a worktree run", () => {
  assert.equal(at({ mode: "repo" }), "/r/app/.drover");
  assert.equal(at({ mode: "repo", worktree: "/w/t1" }), "/w/t1/.drover");
});

test("project mode: <configDir>/work/<project id>, the same for a worktree run", () => {
  assert.equal(at({ mode: "project" }), "/h/.config/drover-herdr/work/P-1");
  assert.equal(at({ mode: "project", worktree: "/w/t1" }), "/h/.config/drover-herdr/work/P-1");
});

test("a leftover \"run\" mode resolves like project (the per-run folder is gone)", () => {
  assert.equal(at({ mode: "run" }), "/h/.config/drover-herdr/work/P-1");
  assert.equal(at({ mode: "run", runId: "../x" }), "/h/.config/drover-herdr/work/P-1");
});

test("free run (no project) uses the _free segment", () => {
  assert.equal(FREE_PROJECT, "_free");
  assert.equal(at({ mode: "project", project: null }), "/h/.config/drover-herdr/work/_free");
});

test("unknown or missing mode falls back to repo", () => {
  for (const mode of ["nope", "", undefined, null, 5]) assert.equal(at({ mode }), "/r/app/.drover", String(mode));
});

test("trailing slashes on inputs do not double up", () => {
  assert.equal(at({ mode: "repo", repo: "/r/app/" }), "/r/app/.drover");
  assert.equal(at({ mode: "project", configDir: "/h/c/" }), "/h/c/work/P-1");
});

test("unsafe segments are rejected (project id)", () => {
  for (const bad of ["", "..", ".", "a/b", "a\\b", "../x", "a\0b", "a\nb", " ", 7, null]) {
    assert.throws(() => at({ mode: "project", project: { id: bad, name: "x" } }), /unsafe/, `project ${JSON.stringify(bad)}`);
  }
  assert.throws(() => at({ mode: "project", project: { id: "../etc" } }), /unsafe/);
});

test("repo mode ignores the project (it is never checked)", () => {
  assert.equal(at({ mode: "repo", project: { id: "a/b" } }), "/r/app/.drover");
});

test("odd but safe ids keep their characters", () => {
  assert.equal(safeSegment("P-MWE7UDFNX3M"), "P-MWE7UDFNX3M");
  assert.equal(safeSegment("my project.v2"), "my project.v2");
  assert.equal(at({ mode: "project", project: { id: "..hidden" } }), "/h/.config/drover-herdr/work/..hidden");
});

test("non-absolute or missing base paths are rejected", () => {
  assert.throws(() => at({ mode: "repo", repo: "rel/app" }), /absolute/);
  assert.throws(() => at({ mode: "repo", repo: null }), /absolute/);
  assert.throws(() => at({ mode: "project", configDir: "cfg" }), /absolute/);
  assert.equal(at({ mode: "project", repo: null }), "/h/.config/drover-herdr/work/P-1"); // repo not needed outside repo mode
});

test("config field drover-config.work_folder: enum repo|project, default project", () => {
  const f = field("drover-config", "work_folder");
  assert.ok(f);
  assert.equal(f.type, "enum");
  assert.deepEqual(f.enum, ["repo", "project"]);
  assert.equal(f.default, "project");
  assert.equal(validate(f, "repo").ok, true);
  assert.equal(validate(f, "global").ok, false);
});

// ---- the move offer (pure) ----
import { moveOffers, confirmText, parseMove, moveSummary, moveCommand } from "../_lib/workfolder.js";

const PROJ = [{ id: "P-1", name: "App", repos: [{ path: "/r/app/", default: true }, { path: "/r/other" }] }, { id: "P-2", name: "Lib", repos: [{ path: "/r/lib" }] }, { id: "../x", name: "Bad", repos: [{ path: "/r/bad" }] }];
const offers = (o) => moveOffers({ mode: "project", projects: PROJ, counts: { "/r/app/": 3, "/r/other": 9, "/r/lib": 0, "/r/bad": 2 }, configDir: "/h/c", ...o });

test("moveOffers: project mode, one offer per project whose default repo has .drover entries", () => {
  assert.deepEqual(offers(), [{ id: "P-1", name: "App", from: "/r/app/.drover", to: "/h/c/work/P-1", count: 3 }]);
});

test("moveOffers: none in repo mode, with no files, or with bad input", () => {
  for (const mode of ["repo", "run", "x", undefined]) assert.deepEqual(offers({ mode }), [], String(mode));
  assert.deepEqual(offers({ counts: {} }), []);
  assert.deepEqual(offers({ projects: null, counts: null }), []);
});

test("confirmText names the count, both paths and that nothing is overwritten", () => {
  const t = confirmText({ count: 1, from: "/a/.drover", to: "/b/P" });
  assert.match(t, /Move 1 item from \/a\/\.drover to \/b\/P\?/);
  assert.match(t, /Nothing is overwritten/);
  assert.match(confirmText({ count: 4, from: "x", to: "y" }), /4 items/);
});

test("parseMove / moveSummary read the helper's answer", () => {
  assert.deepEqual(parseMove("moved 3, skipped 1\nconflict: a.md\n"), { moved: 3, skipped: 1, conflicts: ["a.md"], leftovers: [] });
  assert.equal(parseMove("garbage"), null);
  assert.equal(moveSummary({ moved: 1, skipped: 0, conflicts: [] }), "Moved 1 file.");
  assert.match(moveSummary({ moved: 2, skipped: 1, conflicts: ["a.md"] }), /left 1 that already exists there \(a\.md\)/);
  assert.equal(moveCommand("/bin/dw", "/a/.drover", "/b"), "/bin/dw move /a/.drover /b");
});

test("a saved \"run\" reads as project in every layer, also over an inherited repo (mod.json)", () => {
  const w = (sh, st) => resolve(sh, st, "drover-config", "work_folder");
  assert.equal(w({ "drover-config": { work_folder: "run" } }, {}), "project");
  assert.equal(w({ "drover-config": { work_folder: "run" } }, { work_folder: "repo" }), "project");
  assert.equal(w({}, { work_folder: "run" }), "project");
  assert.equal(w({ "drover-config": { work_folder: "repo" } }, { work_folder: "run" }), "repo");
  assert.equal(w({ "drover-config": { work_folder: "nope" } }, { work_folder: "repo" }), "repo", "other invalid values still fall through");
});

test("the saved-run alias only reads strings (an array or object value is just invalid, never mapped or thrown on)", () => {
  const w = (v, st = {}) => resolve({ "drover-config": { work_folder: v } }, st, "drover-config", "work_folder");
  assert.equal(w(["run"], { work_folder: "repo" }), "repo");
  assert.equal(w({ toString: null }), "project");
  assert.equal(w(null), "project");
});
