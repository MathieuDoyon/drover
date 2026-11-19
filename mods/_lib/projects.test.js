import { test } from "node:test";
import assert from "node:assert/strict";
import { add, update, applyCommand, addProject, updateProject, removeProject, projectOf, repoOf, findProject, projectKey } from "./store.js";

const mk = (fields = {}) => addProject([], { name: "Acme", repos: "/a\n/b", folders: "/docs", ...fields }, 1);

test("addProject: name required, repos/folders parsed, first repo default, branch default main", () => {
  const r = mk();
  assert.match(r.project.id, /^P-/);
  assert.deepEqual(r.project.repos, [{ path: "/a", default: true }, { path: "/b" }]);
  assert.deepEqual(r.project.folders, ["/docs"]);
  assert.equal(r.project.branch, "main");
  assert.ok(addProject([], { name: "  " }).error);
  assert.ok(addProject(r.projects, { name: "acme" }).error); // duplicate name
});

test("updateProject keeps id; removeProject refuses while a task uses it", () => {
  const { projects, project } = mk();
  const u = updateProject(projects, project.id, { name: "Acme 2", repos: "/b\n/a", branch: "dev" });
  assert.equal(u.project.id, project.id);
  assert.equal(u.project.repos[0].path, "/b");
  assert.ok(updateProject(projects, "P-NONE", { name: "x" }).error);
  const t = add([], { title: "x", project: project.id }).tasks;
  assert.ok(removeProject(projects, t, project.id).error);
  assert.equal(removeProject(projects, [], project.id).projects.length, 0);
});

test("task.project: default null, kept on update, set and cleared by command", () => {
  const { projects, project } = mk();
  const a = add([], { title: "x" });
  assert.equal(a.task.project, null);
  assert.equal(add([], { title: "x", project: project.id }).task.project, project.id);
  assert.equal(update(a.tasks, a.task.id, { title: "y" }).task.project, null);
  const set = applyCommand(a.tasks, { op: "project", id: a.task.id, project: project.id });
  assert.equal(set.task.project, project.id);
  assert.equal(applyCommand(set.tasks, { op: "project", id: a.task.id, project: null }).task.project, null);
  assert.equal(projectOf({ title: "old" }, projects), null); // old task without the field
  assert.equal(projectOf(set.task, projects).id, project.id);
});

test("repoOf: default repo, first repo, else null", () => {
  const { projects, project } = mk();
  assert.equal(repoOf({ project: project.id }, projects), "/a");
  const noDefault = [{ ...project, repos: [{ path: "/z" }] }];
  assert.equal(repoOf({ project: project.id }, noDefault), "/z");
  assert.equal(repoOf({ project: project.id }, [{ ...project, repos: [] }]), null);
  assert.equal(repoOf({ project: null }, projects), null);
  assert.equal(repoOf({}, projects), null);
  assert.equal(repoOf({ project: "P-GONE" }, projects), null);
});

test("findProject by id or name, case-insensitive", () => {
  const { projects, project } = mk();
  assert.equal(findProject(projects, project.id).id, project.id);
  assert.equal(findProject(projects, "ACME").id, project.id);
  assert.equal(findProject(projects, "nope"), null);
});

test("projectKey: id or name resolves, none/empty clears, unknown is an error", () => {
  const { projects, project } = mk();
  assert.equal(projectKey(projects, "acme").id, project.id);
  assert.equal(projectKey(projects, "None").id, null);
  assert.equal(projectKey(projects, undefined).id, null);
  assert.ok(projectKey(projects, "nope").error);
});

test("note op appends {at, by, text}, trims, refuses empty; old tasks start with none", () => {
  const a = add([], { title: "x" });
  assert.deepEqual(a.task.notes, []);
  const n1 = applyCommand(a.tasks, { op: "note", id: a.task.id, text: "  decided A ", by: "t5" }, 7);
  assert.match(n1.task.notes[0].id, /^N-[0-9a-f]{6,}$/);
  assert.deepEqual(n1.task.notes.map(({ id, ...n }) => n), [{ at: 7, by: "t5", text: "decided A" }]);
  const n2 = applyCommand(n1.tasks, { op: "note", id: a.task.id, text: "two" }, 8);
  assert.deepEqual(n2.task.notes.map((n) => [n.by, n.text]), [["t5", "decided A"], ["you", "two"]]);
  assert.ok(applyCommand(a.tasks, { op: "note", id: a.task.id, text: "  " }).error);
  assert.equal(applyCommand([{ id: "T-OLD", title: "o", tags: [], priority: "P2", column: "todo" }], { op: "note", id: "T-OLD", text: "hi" }).task.notes.length, 1);
  assert.equal(update(n2.tasks, a.task.id, { title: "y" }).task.notes.length, 2); // an edit keeps the notes
});

test("edit op replaces only the given fields; empty title or no field is refused", () => {
  const a = add([], { title: "old", desc: "d" });
  const e = applyCommand(a.tasks, { op: "edit", id: a.task.id, title: " new " });
  assert.deepEqual([e.task.title, e.task.desc], ["new", "d"]);
  assert.equal(applyCommand(a.tasks, { op: "edit", id: a.task.id, desc: "" }).task.desc, "");
  assert.ok(applyCommand(a.tasks, { op: "edit", id: a.task.id, title: " " }).error);
  assert.ok(applyCommand(a.tasks, { op: "edit", id: a.task.id }).error);
  assert.ok(applyCommand(a.tasks, { op: "edit", id: "T-NONE", title: "x" }).error);
});

test("org: invalid slugs are refused by add and update, projects unchanged", () => {
  const bad = ["Acme", "../x", "a b", "x".repeat(41), "-a", 5, {}, ["a"]];
  const { projects, project } = mk();
  for (const org of bad) {
    const a = addProject(projects, { name: "Other", org });
    assert.match(a.error ?? "", /org/i, JSON.stringify(org));
    assert.equal(a.projects, undefined);
    const frozen = Object.freeze(projects.map((p) => Object.freeze({ ...p })));
    const u = updateProject(frozen, project.id, { org });
    assert.match(u.error ?? "", /org/i, JSON.stringify(org));
    assert.equal(u.projects, undefined);
  }
});

test("org: a valid slug is stored; a project without org has no org key; other updates keep org; clearing removes it", () => {
  const plain = mk();
  assert.equal("org" in plain.project, false);
  assert.deepEqual(Object.keys(plain.project).sort(), ["branch", "created", "folders", "id", "name", "repos"]);
  for (const blank of [undefined, "", "  "]) assert.equal("org" in mk({ org: blank }).project, false, JSON.stringify(blank));
  const { projects, project } = mk({ org: "acme-1" });
  assert.equal(project.org, "acme-1");
  const kept = updateProject(projects, project.id, { branch: "dev" });
  assert.equal(kept.project.org, "acme-1");
  const frozen = Object.freeze(projects.map((p) => Object.freeze({ ...p })));
  const cleared = updateProject(frozen, project.id, { org: "" });
  assert.equal("org" in cleared.project, false);
  assert.equal("org" in cleared.projects[0], false);
  assert.equal(frozen[0].org, "acme-1", "the input project is untouched");
  const changed = updateProject(projects, project.id, { org: "beta" });
  assert.equal(changed.project.org, "beta");
});
