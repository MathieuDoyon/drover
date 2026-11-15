// The repository name lives in README.md (Install) and mods/_recipe/repo.txt (pasted into every RECIPE.md): nowhere else.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { repo } from "../_recipe/sync.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const slug = repo();
const SKIP = new Set([".git", "node_modules", ".drover", "__pycache__"]);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (!/\.(png|jpg|gif|ico)$/.test(e.name)) files.push(p);
  }
})(root);
const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const allowed = (r) => r === "README.md" || r === "mods/_recipe/repo.txt" || /^mods\/(drover-[a-z]+|_layouts)\/RECIPE\.md$/.test(r);

test("repo.txt is an owner/name, and not the old repository name", () => {
  assert.match(slug, /^[\w.-]+\/[\w.-]+$/);
  assert.ok(!slug.endsWith("/drover-herdr"), "repo.txt still names the old repository (drover-herdr)");
});

test("the old repository name (drover-herdr as a GitHub slug or a clone folder) appears in no file", () => {
  // ~/.config/drover-herdr (the data folder) and the service name are not the repository and stay.
  const old = /(github\.com[/:][\w.-]+|[\w.-]+\/Developer|~\/Developer|MathieuDoyon)\/drover-herdr(?![\w-])/;
  const bad = files.filter((f) => !/\.png$/.test(f) && old.test(fs.readFileSync(f, "utf8"))).map(rel);
  assert.deepEqual(bad, []);
});

test("the repository name appears only in README.md, repo.txt and the generated RECIPE.md copies", () => {
  const bad = [];
  for (const f of files) {
    const r = rel(f);
    if (allowed(r)) continue;
    const text = fs.readFileSync(f, "utf8");
    if (text.includes(slug) || /github\.com[/:][\w.-]+\/drover-herdr/.test(text)) bad.push(r);
  }
  assert.deepEqual(bad, [], "use a relative link or 'this repository'; the name lives in repo.txt and README.md");
});

test("README.md clones the repository named in repo.txt", () => {
  assert.ok(fs.readFileSync(path.join(root, "README.md"), "utf8").includes(`github.com/${slug}`));
});

test("no file refers to the home folder of a real person", () => {
  const home = /(?<![\w$}.\/-])\/(Users|home)\/(?!(user|you|u|x)\/)[A-Za-z][\w.-]*\//;
  const bad = files.filter((f) => home.test(fs.readFileSync(f, "utf8"))).map(rel);
  assert.deepEqual(bad, []);
});
