// `drover machines install|check|doctor <machine> [--force] [--node <dir>] [--json]` and `drover machines hold clear --reason <text>`.
// Runs on the laptop. The machine is reached only through hc (`hc exec --on`, `hc file write --on`, `hc machine ls`): no ssh, no new connection.
// The logic is in ../machines.js; this file is the real runner, the argument parsing and the output.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { install, check, doctor, formatDoctor, createHold, holdDir } from "../machines.js";

const USAGE = `usage: drover machines install|check|doctor <machine> [--force] [--node <dir>] [--json]
       drover machines migrate-in <machine> [--json]
       drover machines hold clear --reason <text>
  install   copy the CLI and its helpers to a linked machine as one complete generation, check it, then switch to it; --force replaces files edited on the machine
  check     read-only: each file is current, update, new, edited-remote, newer-remote or missing; exit 1 on any drift
  doctor    read-only: the checks of an install; clears the sync hold of this machine when everything passes; exit 1 only on FAIL
  migrate-in  copy the cards and projects of the machine's old shared.json into its headless board (drover-headless migrate-in); existing ids are kept, it can be run again
  hold clear   the owner's release of a sync hold that cannot clear itself (an offline machine, a damaged record); appends a record, deletes nothing
  --node    the folder of node on the machine, tried after PATH and before the common places and version managers (node is required there)
  --json    machine-readable output
A machine is one of \`hc machine ls\`. While an install is unfinished nothing is pushed to any machine ("held") until doctor finds it whole.
`;

const collect = (child, input) => new Promise((resolve) => {
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", (e) => resolve({ code: 127, stdout, stderr: String(e.message) }));
  child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
});
const hc = (args, input) => collect(spawn("hc", args, { stdio: ["pipe", "pipe", "pipe"] }), input);

export const hcRuntime = () => ({
  exec: (machine, argv, { stdin = "", timeout = 60 } = {}) => hc(["exec", "--on", machine, "--timeout", String(Math.min(600, Math.max(1, Math.ceil(timeout)))), ...(stdin ? ["--stdin"] : []), "--", ...argv], stdin),
  async write(machine, path, text) {
    const r = await hc(["file", "write", "--on", machine, path], text);
    if (r.code !== 0) throw new Error(`hc file write on ${machine} failed (${path}): ${r.stderr.trim().slice(0, 200)}`);
    return r;
  },
  async link(machine) {
    const r = await hc(["machine", "ls", "--json"]);
    let m;
    try { m = JSON.parse(r.stdout).machines.find((x) => x.name === machine); } catch { return { ok: false, detail: "hc machine ls gave no usable answer" }; }
    if (!m) return { ok: false, detail: `${machine} is not a linked machine (hc machine ls)` };
    if (m.state !== "connected") return { ok: false, detail: `${machine} is ${m.state}` };
    return m.keeps_running_after_logout === true ? { ok: true, detail: `${machine} is connected and keeps running after logout` } : { ok: true, warn: true, detail: `${machine} is connected but may stop when nobody is logged in` };
  },
});

// The old board of a machine is its shared.json under its home. Only the headless verb reads it; the answer's counts are printed, nothing else of it.
// The headless launcher of the installed generation, relative to the remote home (hc exec starts there). Same string as _lib/remote-exec.js HEADLESS (a test compares them):
// this file ships to machines, so it does not import the laptop transport code.
export const HEADLESS = ".local/share/drover-herdr/current/bin/drover-headless";
export const OLD_BOARD = ".config/herdr-app/shared.json";
const KINDS = ["tasks", "projects", "agents", "squads"];
const countsText = (c) => KINDS.map((k) => `${k} ${Number.isSafeInteger(c?.[k]) ? c[k] : 0}`).join(", ");
async function migrateIn(rest, { out, err, runtime }) {
  const json = rest.includes("--json");
  const names = rest.filter((a) => a !== "--json");
  if (names.length !== 1 || names[0].startsWith("-")) { err(USAGE); return 2; }
  const machine = names[0];
  let r = null;
  try { r = await runtime.exec(machine, [HEADLESS, "migrate-in", "--from", OLD_BOARD], { timeout: 120 }); } catch { r = null; }
  let j = null;
  try { j = JSON.parse(String(r?.stdout ?? "")); } catch { j = null; }
  const fail = (code, message) => { if (json) out(`${JSON.stringify({ ok: false, machine, code, message })}\n`); else err(`migrate-in failed on ${machine}: ${code}: ${message}\n`); return 1; };
  if (r?.code === 69) return fail("E_NODE_NOT_FOUND", "Node is not available on the machine (run drover machines doctor)");
  if (r?.code === 0 && j?.ok === true) {
    if (json) out(`${JSON.stringify({ ok: true, machine, copied: j.copied ?? {}, skipped: j.skipped ?? {} })}\n`);
    else out(`migrated into ${machine}: copied ${countsText(j.copied)}; skipped ${countsText(j.skipped)}\n`);
    return 0;
  }
  if (r?.code === 1 && j?.ok === false && typeof j.code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(j.code)) return fail(j.code, "the machine refused it");
  return fail("no-answer", `${machine} did not give a usable answer (is drover-headless installed? drover machines doctor ${machine})`);
}

export async function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), runtime = hcRuntime() } = {}) {
  const [verb, ...rest] = argv;
  const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app");
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") { (verb ? out : err)(USAGE); return verb ? 0 : 2; }
  if (verb === "hold") {
    if (rest[0] !== "clear") { err(USAGE); return 2; }
    const i = rest.indexOf("--reason");
    const reason = i >= 0 ? rest[i + 1] : "";
    if (rest.length !== 3 || i !== 1 || !reason) { err("usage: drover machines hold clear --reason <text>   (a reason is required)\n"); return 2; }
    const r = createHold({ dir: holdDir(appHome) }).clearManual(reason);
    if (!r.ok) { err(`${r.message ?? r.reason}\n`); return r.reason === "nothing" ? 0 : 1; }
    out(`hold cleared by hand (hold.${r.record.n}.json): ${reason}\n`);
    return 0;
  }
  if (verb === "migrate-in") return migrateIn(rest, { out, err, runtime });
  if (!["install", "check", "doctor"].includes(verb)) { err(USAGE); return 2; }
  const opts = { force: false, nodeDir: "", json: false };
  let machine = "";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--force") opts.force = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--node") { opts.nodeDir = rest[++i] ?? ""; if (!opts.nodeDir) { err("--node needs a folder\n"); return 2; } }
    else if (a.startsWith("-") || machine) { err(USAGE); return 2; }
    else machine = a;
  }
  if (!machine) { err(USAGE); return 2; }
  const srcRoot = fileURLToPath(new URL("..", import.meta.url));
  const base = { machine, srcRoot, appHome, force: opts.force, nodeDir: opts.nodeDir };
  if (verb === "doctor") {
    const d = await doctor(runtime, base);
    out(opts.json ? `${JSON.stringify({ ok: d.ok, machine, checks: d.checks, summary: d.summary, cleared: d.cleared })}\n` : formatDoctor(d, { machine }));
    return d.exitCode;
  }
  if (verb === "check") {
    const r = await check(runtime, base);
    if (opts.json) out(`${JSON.stringify({ ok: r.exitCode === 0, machine, code: r.code, files: r.files })}\n`);
    else if (r.code) err(`${r.code}: ${r.message}\n`);
    else for (const f of r.files) out(`${f.state.padEnd(13)} ${f.path}\n`);
    return r.exitCode;
  }
  const r = await install(runtime, base);
  if (opts.json) { out(`${JSON.stringify({ ok: r.ok, machine, code: r.code, held: r.held, noop: r.noop, gen: r.gen, message: r.message, files: r.files })}\n`); return r.ok ? 0 : 1; }
  if (!r.ok) {
    err(`${r.held ? "" : "install failed: "}${r.message}${r.path ? ` (${r.path})` : ""}\n`);
    if (r.held) err("nothing was pushed\n");
    else if (r.code !== "E_NODE_NOT_FOUND" && r.code !== "E_PYTHON_NOT_FOUND") err(`the sync hold stands and the running CLI on ${machine} is unchanged; fix it and re-run install, or run drover machines doctor ${machine}\n`);
    return 1;
  }
  for (const f of r.files ?? []) if (f.state !== "current") out(`${f.state.padEnd(13)} ${f.path}\n`);
  out(r.noop ? `current: ${machine} is whole (${r.gen}), nothing to do\n` : `installed: ${machine} runs generation ${r.gen}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`error: ${e?.message ?? e}\n`); process.exit(1); });
}
