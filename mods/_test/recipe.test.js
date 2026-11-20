// Every mod and the layout ship a RECIPE.md (the brief to rebuild it) in the Herdr recipe order, with the shared companions block.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BEGIN, END, block, synced } from "../_recipe/sync.js";

const mods = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = fs.readdirSync(mods, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("drover-")).map((d) => d.name);
const SECTIONS = ["What you see", "How it behaves", "Built from", "Watch out", "Companion mods", "Done when"];
const nameOf = (dir) => (dir === "_layouts" ? "Drover layout" : JSON.parse(fs.readFileSync(path.join(mods, dir, "mod.json"), "utf8")).title);

test("companions.md names every drover-* mod", () => {
  for (const d of dirs) assert.ok(block().includes(`\`${d}\``), `companions.md does not name ${d}`);

  assert.equal(dirs.length, 16, "the block says 16: update companions.md when a mod is added");
});

for (const dir of [...dirs, "_layouts"]) {
  const file = path.join(mods, dir, "RECIPE.md");
  test(`${dir}: RECIPE.md`, () => {
    assert.ok(fs.existsSync(file), `${dir}/RECIPE.md is missing`);
    const text = fs.readFileSync(file, "utf8");
    const name = nameOf(dir);
    const lines = text.split("\n");
    const h1 = lines.filter((l) => /^# /.test(l));
    assert.deepEqual(h1, [`# ${name}`], "one H1, the mod's title");
    const h2 = lines.filter((l) => /^## /.test(l)).map((l) => l.slice(3));
    assert.deepEqual(h2, SECTIONS, "sections, in order");
    const preview = lines.find((l) => l.startsWith(`![${name}](`));
    if (preview) assert.ok(text.indexOf(`![${name}]`) < text.indexOf("## What you see"), "the preview comes before the first section");
    else assert.ok(text.includes("Preview coming: no preview.png yet"), `a preview line ![${name}](preview.png), or the "Preview coming: no preview.png yet" note in Watch out`);
    const a = text.indexOf(BEGIN), b = text.indexOf(END);
    assert.ok(a > text.indexOf("## Companion mods") && b > a && b < text.indexOf("## Done when"), "markers sit inside Companion mods");
    assert.equal(text, synced(text), "companions block is out of date: run node mods/_recipe/sync.js");
    for (const d of dirs) assert.ok(text.includes(`\`${d}\``), `Companion mods does not name ${d}`);
  });
}
