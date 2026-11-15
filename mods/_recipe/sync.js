// Pastes _recipe/companions.md ({{REPO}} becomes _recipe/repo.txt, the one place the repository name lives besides README.md) between the markers of every RECIPE.md (drover-*/ and _layouts/).
// node _recipe/sync.js          rewrite the files
// node _recipe/sync.js --check  exit 1 when a file is out of date (the recipe test runs the same check)
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const BEGIN = "<!-- companions:begin -->";
export const END = "<!-- companions:end -->";
const mods = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repo = () => fs.readFileSync(path.join(mods, "_recipe/repo.txt"), "utf8").trim();
export const block = () => fs.readFileSync(path.join(mods, "_recipe/companions.md"), "utf8").trim().replaceAll("{{REPO}}", repo());
export const recipes = () => [...fs.readdirSync(mods, { withFileTypes: true }).filter((d) => d.isDirectory() && (d.name.startsWith("drover-") || d.name === "_layouts")).map((d) => path.join(mods, d.name, "RECIPE.md"))].filter((p) => fs.existsSync(p));

export function synced(text) {
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  if (a < 0 || b < a) return null;
  return `${text.slice(0, a + BEGIN.length)}\n${block()}\n${text.slice(b)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const p of recipes()) {
    const text = fs.readFileSync(p, "utf8"), next = synced(text);
    if (next === null) { console.error(`${p}: no companions markers`); stale++; continue; }
    if (next !== text) { stale++; if (check) console.error(`${p}: out of date`); else fs.writeFileSync(p, next); }
  }
  process.exit(check && stale ? 1 : 0);
}
