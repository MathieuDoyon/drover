// Headless `drover agents export`: reads <home>/shared.json and the soul files (read-only; a missing saved herd means the default herd, as in the mods) and runs the SAME core as the mods
// (../herd-export.js). It never opens an environment file (agents/*.json) and never writes. The shell script is only a transport.
// Usage: node drover-export.mjs --home <dir> [--agent <id>]... [--squad <id>]...
// Output (stdout): "ok: exported …" header lines, "---", then the file; or a line starting "error:" and exit 1.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const fail = (msg, code = 1) => { process.stdout.write(`${msg}\n`); process.exit(code); };
const args = process.argv.slice(2);
let home = "";
const agents = [], squads = [];
for (let i = 0; i < args.length; i += 2) {
  const [k, v] = [args[i], args[i + 1]];
  if (typeof v !== "string") fail("error: bad arguments");
  if (k === "--home") home = v; else if (k === "--agent") agents.push(v); else if (k === "--squad") squads.push(v); else fail("error: bad arguments");
}
if (!home) fail("error: --home is required");

// The core is plain ESM with two small imports (runs.js, store.js chain), none of them Herdr-only. A Node that cannot load it (too old to
// run a .js file as ESM) exits 3, and the shell falls back to an open Drover mod.
let HE, RUNS;
try { HE = await import("../herd-export.js"); RUNS = await import("../runs.js"); } catch { fail("error: this node cannot load the export core", 3); }

// Same rule as the mods (loadConfig): no saved herd (no file, no key, a malformed value) exports the shipped defaults, from the same runs.js.
// A shared.json that exists but cannot be read or parsed is an error: defaults must not stand in for a damaged board.
let raw;
try { raw = JSON.parse(readFileSync(`${home}/shared.json`, "utf8"))["drover.agents"]; }
catch (e) { if (e?.code !== "ENOENT") fail("error: cannot read shared.json"); }
const cfg = RUNS.config(raw);

const souls = {};
try {
  const dir = `${home}/mods/drover-agents/souls`;
  const herd = readFileSync(`${dir}/_herd.md`, "utf8");
  for (const f of readdirSync(dir)) {
    const m = /^([a-z0-9-]{1,64})\.md$/.exec(f);
    if (m) souls[m[1]] = HE.soulHash(readFileSync(`${dir}/${f}`, "utf8"), herd);
  }
} catch { fail("error: cannot read the soul files"); }

// home (the --home above is the app data folder) is the real user home: it becomes ~ in the export, like the Squads dialog and the mods.
const opts = { souls, app: "", now: Date.now(), home: homedir() };
if (agents.length) opts.agents = agents;
if (squads.length) opts.squads = squads;
const sum = HE.exportSummary(HE.exportHerd(cfg, opts));
if (sum.error) fail(sum.error);
process.stdout.write([...sum.header, "---", sum.file].join("\n") + "\n");
