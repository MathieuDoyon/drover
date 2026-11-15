// Every relative link and image in README.md, docs/**/*.md and mods/**/RECIPE.md resolves (file and #anchor); the README lists every mod; every mod has a docs page.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mods = path.join(root, "mods");
const walk = (dir, keep) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name), keep)) : keep(e.name) ? [path.join(dir, e.name)] : [])) : [];
const files = [path.join(root, "README.md"), ...walk(path.join(root, "docs"), (n) => n.endsWith(".md")), ...walk(mods, (n) => n === "RECIPE.md")];
const slug = (h) => h.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/ /g, "-");
const anchors = (file) => new Set(fs.readFileSync(file, "utf8").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, "").replace(/`/g, ""))));
const modDirs = fs.readdirSync(mods, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("drover-")).map((d) => d.name);

test("there are documents to check", () => assert.ok(files.length >= 20));

test("every relative link and image resolves", () => {
  const bad = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8"), text = raw.replace(/```[\s\S]*?```/g, "");
    const targets = [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]).concat([...text.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]));
    for (const t of targets) {
      if (/^(https?:|mailto:)/.test(t) || /^<.*>$/.test(t)) continue;
      const [rel, frag] = t.split("#");
      const target = rel ? path.resolve(path.dirname(f), rel) : f;
      if (!fs.existsSync(target)) { bad.push(`${path.relative(root, f)}: ${t} (missing file)`); continue; }
      if (frag && target.endsWith(".md") && !anchors(target).has(frag)) bad.push(`${path.relative(root, f)}: ${t} (no such heading)`);
    }
  }
  assert.deepEqual(bad, []);
});

test("README.md lists every mod and links its docs page", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  for (const d of modDirs) {
    assert.ok(readme.includes(`\`${d}\``), `README.md does not list ${d}`);
    assert.ok(readme.includes(`docs/mods/${d.replace("drover-", "")}.md`), `README.md does not link docs/mods/${d.replace("drover-", "")}.md`);
  }
});

test("every mod has a docs page that links its RECIPE.md", () => {
  for (const d of modDirs) {
    const page = path.join(root, "docs/mods", `${d.replace("drover-", "")}.md`);
    assert.ok(fs.existsSync(page), `docs/mods/${d.replace("drover-", "")}.md is missing`);
    assert.ok(fs.readFileSync(page, "utf8").includes(`../../mods/${d}/RECIPE.md`), `${d} page does not link its RECIPE.md`);
  }
});

test("a RECIPE.md image is the local preview.png, a real PNG under 1.5 MB, and no TODO marker is left", () => {
  const MAX = 1.5 * 1024 * 1024;
  for (const dir of [...modDirs.map((d) => path.join(mods, d)), path.join(mods, "_layouts")]) {
    const recipe = fs.readFileSync(path.join(dir, "RECIPE.md"), "utf8");
    assert.ok(!recipe.includes("TODO preview.png"), `${path.relative(root, dir)}/RECIPE.md still has a TODO preview marker`);
    const image = recipe.split("\n").find((l) => /^!\[[^\]]*\]\(/.test(l));
    if (!image) continue; // a mod with no honest screenshot says so in Watch out
    assert.match(image, /\]\(preview\.png\)$/, `${path.relative(root, dir)}/RECIPE.md: the image must be ](preview.png), next to the recipe`);
    const png = path.join(dir, "preview.png");
    assert.ok(fs.existsSync(png), `${path.relative(root, dir)}/preview.png is missing`);
    const bytes = fs.readFileSync(png);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${path.relative(root, png)} is not a PNG`);
    assert.ok(bytes.length < MAX, `${path.relative(root, png)} is ${bytes.length} bytes (limit ${MAX})`);
  }
});

test("a RECIPE.md without an image says so in Watch out", () => {
  for (const d of modDirs) {
    const recipe = fs.readFileSync(path.join(mods, d, "RECIPE.md"), "utf8");
    if (!recipe.split("\n").some((l) => /^!\[[^\]]*\]\(/.test(l))) assert.ok(recipe.includes("Preview coming: no preview.png yet"), `${d}/RECIPE.md has no image and no "Preview coming: no preview.png yet" note`);
  }
});
