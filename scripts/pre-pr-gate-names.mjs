// Helper of scripts/pre-pr-gate.sh: writes the private words (one per line) to the file given as argument, prints what was not checked
// (never a word) and exits 0 complete | 3 incomplete discovery | 4 the shared helper cannot be loaded | 5 its self-check failed.
// The words come from mods/_test/private-words.js (GATE_HELPER overrides the path: tests only).
import { writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as path from "node:path";

const out = process.argv[2];
const helper = process.env.GATE_HELPER || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../mods/_test/private-words.js");
let m;
try { m = await import(pathToFileURL(helper).href); } catch { console.log("helper: cannot be loaded"); process.exit(4); }
if (typeof m.discoverPrivateWords !== "function" || typeof m.privateWords !== "function") { console.log("helper: discoverPrivateWords/privateWords missing"); process.exit(4); }

// Self-check (#89): with ci off, a generic account or host name (a CI runner's) must never come back as a private word.
const generic = new Set(["runner", "root", "admin", "ubuntu", "docker", ...(m.GENERIC_NAMES || [])]);
for (const n of generic) {
  if (m.privateWords({ username: n, host: n, ci: false }).length) { console.log("self-check: a generic name came back as a private word (private-words.js stoplist broken)"); process.exit(5); }
}
const r = m.discoverPrivateWords();
writeFileSync(out, r.words.join("\n") + "\n");
for (const note of r.notes) console.log(note);
process.exit(r.complete ? 0 : 3);
