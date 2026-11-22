// Shared fixture for the asks-hook install tests (T-MWPK6KYSFZV). Everything lives in one scratch tree; the module runs with DROVER_TEST=1 so its seam
// refuses any path outside that tree and the real ~/.claude and ~/.codex defaults. Never the real home.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, chmodSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "drover-tasks", "bin");
export const MOD = join(BIN, "drover-asks-install.mjs");
export const lib = await import(pathToFileURL(MOD).href);
export const made = [];
export const cleanup = () => { for (const d of made) { try { chmodSync(d, 0o700); } catch {} rmSync(d, { recursive: true, force: true }); } };
export const sha = (b) => createHash("sha256").update(b).digest("hex");
export const tmp = (p) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); made.push(d); return d; };

// a scratch world: home (with .claude/.codex dirs), app home with a launcher, a fake node
export function world({ launcher = true, claudeDir = true, codexDir = true } = {}) {
  const root = tmp("asks-install-");
  const home = join(root, "home"), app = join(root, "app");
  mkdirSync(home); mkdirSync(join(app, "mods", "drover-tasks", "bin"), { recursive: true });
  if (claudeDir) mkdirSync(join(home, ".claude"));
  if (codexDir) mkdirSync(join(home, ".codex"));
  const lpath = join(app, "mods", "drover-tasks", "bin", "drover-asks-hook");
  if (launcher) writeFileSync(lpath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const w = {
    root, home, app, lpath,
    claude: join(home, ".claude", "settings.json"), codex: join(home, ".codex", "hooks.json"),
    env: { HOME: home, HERDR_APP_HOME: app, DROVER_TEST: "1", DROVER_TEST_ROOT: root, DROVER_NODE: process.execPath, PATH: "/usr/bin:/bin" },
    data: join(app, "data"), inst: join(app, "data", "drover-asks-install"), leaf: join(app, "data", "drover-asks-runtime"),
  };
  return w;
}
export const records = (w) => { try { return readdirSync(w.inst).filter((n) => n.endsWith(".json")).map((n) => ({ name: n, ...JSON.parse(readFileSync(join(w.inst, n), "utf8")) })); } catch { return []; } };
export const backups = (w) => { try { return readdirSync(join(w.inst, "backups")); } catch { return []; } };
// run the module in-process; answers = list of replies for the prompt, tty decides whether a prompt is possible
export async function run(w, argv, { tty = false, answers = [], seam = {}, env = {} } = {}) {
  let out = "";
  const asked = [];
  const io = { out: (s) => { out += s; }, err: (s) => { out += s; }, isTTY: tty, ask: async (q) => { asked.push(q); return answers.shift() ?? ""; } };
  const code = await lib.main(argv, { ...w.env, ...env }, io, seam);
  return { code, out, asked };
}
export const snapshot = (dir) => { // path -> sha, recursive, for "nothing changed" asserts
  const m = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else m[p] = sha(readFileSync(p)); } };
  walk(dir); return m;
};
export const write = (p, text, mode = 0o644) => { writeFileSync(p, text, { mode }); chmodSync(p, mode); };
export const read = (p) => readFileSync(p, "utf8");
export { existsSync };

// the mutating calls the sweeps may fault: cleanup/abort/unlock calls are excluded (a fault there leaves honest leftovers, tested on their own)
export const eligible = (label) => !/^(unlock|abort-|cleanup|reconcile-clean|tmp-drop|leaf:tmp-drop|mkdir)/.test(label);
