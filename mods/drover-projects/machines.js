// Install the Drover CLI and its helpers on a linked machine, check them, and hold every push while an install is unfinished.
// Pure laptop-side Node: no Herdr import. The machine is reached only through an injected runtime `rt`:
//   rt.exec(machine, argv, { stdin, timeout }) -> { code, stdout, stderr }     (hc exec --on: argv, no shell)
//   rt.write(machine, relPath, text)                                           (hc file write --on: relative to the remote home)
// The CLI is delivered as ONE complete generation: gen/.stage-<nonce>/ is filled, verified (sha256, mode, each file's test argv), published by an
// exclusive mkdir+rename to gen/<id>/, and only then does ONE atomic switch (a temp link, then os.replace) point `current` at it. A published
// generation is never written again and the previous one is kept, so the running CLI is never half installed and a kill before the switch changes nothing.
import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, posix } from "node:path";
import { createHold, pushGuard } from "./hold.js";

export { createHold, pushGuard };

// Everything the CLI needs: the import chain of bin/drover and its helpers (the closure is checked before any transfer).
export const SHIPPED = ["bin/drover", "bin/drover-export.mjs", "bin/drover-machines.mjs", "bin/find-runtime.sh", "bin/drover-headless", "bin/drover-headless.mjs", "headless-board.js", "remote.js", "machines.js", "hold.js", "publish.js", "herd-export.js", "runs.js", "store.js", "config.js", "config-schema.js", "lessons.js", "workfolder.js", "sources.js"];

const SHARE = ".local/share/drover-herdr";
const GEN = `${SHARE}/gen`;
const ENTRY = ".local/bin/drover";
const IMPORT_SCRIPT = 'import("node:url").then((u) => import(u.pathToFileURL(process.argv[1]).href))';
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

// ---------------------------------------------------------------------------------------------------------- manifest
const testArgv = (path) => (path.endsWith(".mjs") ? ["{node}", "--check", `{gen}/${path}`] : path.endsWith(".js") ? ["{node}", "--input-type=module", "-e", IMPORT_SCRIPT, `{gen}/${path}`] : ["bash", "-n", `{gen}/${path}`]);
export function generationId(files) {
  const lines = files.map((f) => `${f.path} ${f.sha256} ${f.mode}\n`).sort().join("");
  return sha256(lines).slice(0, 16);
}
export function buildManifest(srcRoot) {
  const files = SHIPPED.map((path) => {
    const full = join(srcRoot, path), st = statSync(full);
    return { path, sha256: sha256(readFileSync(full)), mode: st.mode & 0o111 ? "755" : "644", sourceTime: Math.floor(st.mtimeMs), test: testArgv(path) };
  });
  return { id: generationId(files), files };
}
export const expandTest = (argv, { gen, node, python3 }) => argv.map((a) => a.split("{gen}").join(gen).split("{node}").join(node).split("{python3}").join(python3));

// The transitive static-import closure of the shipped files (and the helpers bin/drover names): what is imported must be shipped.
export function closureMissing(srcRoot, shipped = SHIPPED) {
  const have = new Set(shipped), seen = new Set(), todo = [...shipped], missing = new Set();
  const rel = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
  while (todo.length) {
    const p = todo.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    if (!have.has(p)) missing.add(p);
    let text = "";
    try { text = readFileSync(join(srcRoot, p), "utf8"); } catch { continue; }
    if (/\.m?js$/.test(p)) for (const m of text.matchAll(rel)) todo.push(posix.normalize(posix.join(posix.dirname(p), m[1])));
    if (p === "bin/drover") for (const m of text.matchAll(/\$here\/([A-Za-z0-9._\/-]+\.(?:mjs|js|sh))/g)) todo.push(posix.normalize(posix.join("bin", m[1])));
  }
  return [...missing].sort();
}

// ---------------------------------------------------------------------------------------------------------- decisions
// remote = null (never installed) or { present, sha, stampSha, stampKept, stampSourceTime }
export function classify(entry, remote) {
  if (!remote) return "new";
  if (!remote.present) return "missing";
  if (remote.sha === entry.sha256) return "current";
  if (remote.stampKept || remote.sha !== remote.stampSha) return "edited-remote"; // edited on the remote: kept unless --force
  if (remote.stampSourceTime > entry.sourceTime) return "newer-remote"; // older source never replaces newer
  return "update";
}

// ---------------------------------------------------------------------------------------------------------- scripts that run on the remote (python3 from stdin; data only in argv)
const PROBE_PY = `import hashlib, json, os, sys
home = sys.argv[1]
share = os.path.join(home, ${JSON.stringify(SHARE)})
def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()
def mode(p):
    return format(os.stat(p).st_mode & 0o777, "o")
out = {"current": None, "stamp": None, "files": {}, "gens": [], "entry": {"present": False}, "nodeOk": False}
try:
    out["current"] = os.readlink(os.path.join(share, "current"))
except OSError:
    pass
try:
    out["gens"] = sorted(os.listdir(os.path.join(share, "gen")))
except OSError:
    pass
if out["current"]:
    gen = os.path.join(share, out["current"])
    try:
        with open(os.path.join(gen, "MANIFEST.json")) as f:
            out["stamp"] = json.load(f)
    except Exception:
        out["stamp"] = None
    if out["stamp"]:
        for e in out["stamp"].get("files", []):
            p = os.path.join(gen, e["path"])
            if os.path.isfile(p):
                out["files"][e["path"]] = {"present": True, "sha": sha(p), "mode": mode(p)}
            else:
                out["files"][e["path"]] = {"present": False}
        n = out["stamp"].get("node")
        out["nodeOk"] = bool(n) and os.path.isfile(n) and os.access(n, os.X_OK)
ep = os.path.join(home, ${JSON.stringify(ENTRY)})
if os.path.isfile(ep):
    out["entry"] = {"present": True, "sha": sha(ep), "mode": mode(ep)}
print(json.dumps(out))
`;
// argv: gen dir, then path|sha|mode|sourceTime|kept items. Prints the list of problems (the stamp's own sourceTime and kept flag are checked too).
const VERIFY_PY = `import hashlib, json, os, sys
gen = sys.argv[1]
bad = []
entries = {}
if not os.path.isfile(os.path.join(gen, "MANIFEST.json")):
    bad.append({"path": "MANIFEST.json", "why": "missing"})
else:
    try:
        with open(os.path.join(gen, "MANIFEST.json")) as f:
            entries = {e["path"]: e for e in json.load(f).get("files", [])}
    except Exception:
        bad.append({"path": "MANIFEST.json", "why": "unreadable"})
for item in sys.argv[2:]:
    path, want_sha, want_mode, want_time, want_kept = item.split("|")
    p = os.path.join(gen, path)
    if not os.path.isfile(p):
        bad.append({"path": path, "why": "missing"})
        continue
    with open(p, "rb") as f:
        got = hashlib.sha256(f.read()).hexdigest()
    if got != want_sha:
        bad.append({"path": path, "why": "sha"})
    elif format(os.stat(p).st_mode & 0o777, "o") != want_mode:
        bad.append({"path": path, "why": "mode"})
    elif path not in entries or entries[path].get("sourceTime") != int(want_time) or bool(entries[path].get("kept")) != (want_kept == "1"):
        bad.append({"path": path, "why": "meta"})
print(json.dumps(bad))
`;
// argv: source gen dir, destination dir, paths. Copies files remote-side, creating folders.
const COPY_PY = `import os, shutil, sys
src, dst = sys.argv[1], sys.argv[2]
for path in sys.argv[3:]:
    d = os.path.join(dst, path)
    os.makedirs(os.path.dirname(d), exist_ok=True)
    shutil.copyfile(os.path.join(src, path), d)
`;
// argv: dir, then path=mode items
const MODES_PY = `import os, sys
for item in sys.argv[2:]:
    path, mode = item.split("=")
    os.chmod(os.path.join(sys.argv[1], path), int(mode, 8))
`;
// argv: stage, final. ONE rename publishes the whole stage: no empty reservation is ever visible, so a gen dir that is not a stage always holds its
// MANIFEST.json. An id that already exists (exit 3) is refused untouched; rename(2) also refuses a non-empty dir that appeared in between.
export const PUBLISH_PY = `import os, sys
stage, final = sys.argv[1], sys.argv[2]
if os.path.lexists(final):
    sys.exit(3)
os.rename(stage, final)
`;
const LINK_PY = `import os, sys
os.symlink(sys.argv[1], sys.argv[2])
`;
const REPLACE_PY = `import os, sys
os.replace(sys.argv[1], sys.argv[2])
`;
// The remote entry launcher: reads `current` ONCE and runs that generation's CLI by absolute path.
const LAUNCHER = `#!/bin/sh
# Drover launcher (installed by drover machines install). It reads the current generation ONCE and runs that generation's CLI by its absolute
# path, so one invocation uses one generation end to end, even while an update switches the link.
here="$(cd "$(dirname "$0")" && pwd -P)" || exit 127
share="$here/../share/drover-herdr"
gen="$(readlink "$share/current")" || { echo "drover: not installed here (run drover machines install <machine> from the laptop)" >&2; exit 127; }
case "$gen" in /*) ;; *) gen="$share/$gen" ;; esac
exec "$gen/bin/drover" "$@"
`;
const ENTRY_PY = `import os, sys
text = __TEXT__
path, nonce = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = os.path.join(os.path.dirname(path), ".drover-tmp-" + nonce)
with open(tmp, "w") as f:
    f.write(text)
os.chmod(tmp, 0o755)
os.replace(tmp, path)
`;
const LAUNCHER_SHA = sha256(LAUNCHER);

// ---------------------------------------------------------------------------------------------------------- remote helpers
const verifyItem = (f) => `${f.path}|${f.sha256}|${f.mode}|${f.sourceTime}|${f.kept ? 1 : 0}`;
const tail = (s) => String(s ?? "").trim().split("\n").slice(-3).join(" | ").slice(0, 300);
const py = (rt, machine, python3, script, args = [], timeout = 60) => rt.exec(machine, [python3, "-", ...args], { stdin: script, timeout });
async function pyJson(rt, machine, python3, script, args) {
  const r = await py(rt, machine, python3, script, args);
  if (r.code !== 0) return { error: `exit ${r.code}: ${tail(r.stderr)}` };
  try { return JSON.parse(r.stdout); } catch { return { error: `unreadable output: ${tail(r.stdout)}` }; }
}

// Find node and python3 on the machine. One read-only exec, the finder script on stdin.
async function findRuntime(rt, machine, srcRoot, nodeDir) {
  const script = readFileSync(join(srcRoot, "bin/find-runtime.sh"), "utf8");
  const r = await rt.exec(machine, ["sh", "-s", "--", ...(nodeDir ? [nodeDir] : [])], { stdin: script, timeout: 30 });
  const out = String(r.stdout ?? "");
  const line = (re) => out.split("\n").find((l) => re.test(l));
  const grab = (l) => (l ? { tier: /tier=(\S+)/.exec(l)[1], path: /path=(.*?) version=/.exec(l)[1], version: l.slice(l.indexOf(" version=") + 9) } : null);
  const home = (line(/^home=/) ?? "").slice(5);
  return { home, node: grab(line(/^node /)), python3: grab(line(/^python3 /)), noNode: /^E_NODE_NOT_FOUND$/m.test(out), noPython: /^E_PYTHON_NOT_FOUND$/m.test(out), noTemp: /^E_TEMP_FAILED$/m.test(out), raw: out, code: r.code };
}
const needRuntime = (rtInfo, machine) => {
  if (rtInfo.noTemp) return fail("E_TEMP_FAILED", `${machine} cannot create a safe temporary file (mktemp failed), so its runtimes were not probed`);
  if (!rtInfo.home) return fail("E_PROBE_FAILED", `could not read the home of ${machine}`);
  if (rtInfo.noPython || !rtInfo.python3) return fail("E_PYTHON_NOT_FOUND", `python3 not found on ${machine}`);
  if (rtInfo.noNode || !rtInfo.node) return fail("E_NODE_NOT_FOUND", `node not found on ${machine}: install node there, or pass --node <dir>`);
  return null;
};

const probe = (rt, machine, info) => pyJson(rt, machine, info.python3.path, PROBE_PY, [info.home]);
const abs = (home, rel) => `${home}/${rel}`;
const genAbs = (home, current) => (current.startsWith("/") ? current : `${home}/${SHARE}/${current}`);

// What a stamp must be before anything trusts it: a list of well-formed entries that covers every shipped file.
export function stampProblems(stamp) {
  if (!stamp || typeof stamp !== "object" || !Array.isArray(stamp.files) || !stamp.files.length) return ["MANIFEST.json has no files list"];
  const bad = [], seen = new Set();
  for (const e of stamp.files) {
    if (!e || typeof e.path !== "string" || !e.path || e.path.startsWith("/") || e.path.split("/").includes("..")) { bad.push(`bad path ${JSON.stringify(e?.path)}`); continue; }
    seen.add(e.path);
    if (!/^[0-9a-f]{64}$/.test(e.sha256 ?? "")) bad.push(`${e.path}: bad sha256`);
    if (!/^[0-7]{3}$/.test(e.mode ?? "")) bad.push(`${e.path}: bad mode`);
    if (!Number.isFinite(e.sourceTime)) bad.push(`${e.path}: bad sourceTime`);
  }
  for (const p of SHIPPED) if (!seen.has(p)) bad.push(`${p}: not in the stamp`);
  return bad;
}
// An installation exists (`current` is a link) but its stamp cannot be trusted: that is NOT a fresh machine. Replacing it needs --force.
const brokenInstall = (P) => (P.current && stampProblems(P.stamp).length ? stampProblems(P.stamp) : null);
const stampRefusal = (machine, P, problems) => fail("E_STAMP_INVALID", `${machine} has an installation (current -> ${P.current}) whose MANIFEST.json is missing or not whole (${problems.slice(0, 3).join("; ")}); it is not treated as a fresh machine, so nothing was changed. Run drover machines doctor ${machine}, or re-run install with --force to replace it`);
const trustedProbe = (P) => (stampProblems(P.stamp).length ? { ...P, stamp: null, files: {} } : P); // a damaged stamp is not an installed state: plan from nothing

// ---------------------------------------------------------------------------------------------------------- plan: one state per file
function plan(manifest, P, force) {
  const stamp = P.stamp, byPath = new Map((stamp?.files ?? []).map((e) => [e.path, e]));
  const entries = manifest.files.map((f) => {
    const e = byPath.get(f.path), live = P.files?.[f.path];
    const remote = e ? { present: !!live?.present, sha: live?.sha ?? null, stampSha: e.sha256, stampKept: !!e.kept, stampSourceTime: e.sourceTime } : null;
    const state = classify(f, remote);
    let action = "source";
    if (state === "current") action = "copy";
    else if ((state === "edited-remote" || state === "newer-remote") && !force) action = "keep";
    return { f, e, remote, state, action };
  });
  const files = entries.map(({ f, e, remote, state, action }) => {
    if (action === "keep") return { path: f.path, sha256: remote.sha, mode: e.mode, sourceTime: e.sourceTime, kept: state === "edited-remote", test: f.test };
    // Unchanged bytes keep the provenance they were installed with: an older checkout never lowers a recorded source time.
    return { path: f.path, sha256: f.sha256, mode: f.mode, sourceTime: action === "copy" && e ? e.sourceTime : f.sourceTime, kept: false, test: f.test };
  });
  const work = entries.some(({ state, action, remote }) => ["update", "new", "missing"].includes(state) || (state === "edited-remote" && (action === "source" || remote.sha !== remote.stampSha)) || (state === "newer-remote" && action === "source"));
  return { entries, files, work, id: generationId(files), states: entries.map((x) => ({ path: x.f.path, state: x.state })) };
}

// ---------------------------------------------------------------------------------------------------------- doctor
// Every check is read-only on the remote. The hold is judged from the newest record read at the START (what doctor saw), and released only
// when every check passes, `current` is the hold's target, and no other actor appended a record meanwhile.
export async function doctor(rt, opts) {
  const { machine, srcRoot, nodeDir = "", appHome, holdEnv = {}, hold: holdIn } = opts;
  const hold = holdIn ?? (appHome ? createHold({ dir: holdDir(appHome), ...holdEnv }) : null);
  const started = hold?.read() ?? null;
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  if (rt.link) { const l = await rt.link(machine); add("link", l.ok ? (l.warn ? "WARN" : "ok") : "FAIL", l.detail); } else add("link", "skip", "no link information from this runner");
  const info = await findRuntime(rt, machine, srcRoot ?? process.cwd(), nodeDir);
  const hasPython = !!(info.home && info.python3 && !info.noPython && !info.noTemp);
  // a transport or finder gap is a FAIL, never an exception: nothing is probed without a home and a python3
  const P = hasPython ? await probe(rt, machine, info) : null;
  const node = info.node && !info.noNode ? info.node.path : P?.nodeOk ? P.stamp?.node : null;
  add("node", node ? "ok" : "FAIL", node ? `${node}${info.node && !info.noNode ? ` (${info.node.tier})` : " (recorded at install)"}` : info.noTemp ? "E_TEMP_FAILED" : info.home ? "E_NODE_NOT_FOUND" : `no usable answer from ${machine} (offline?)`);
  add("python3", hasPython ? "ok" : "FAIL", hasPython ? `${info.python3.path} (${info.python3.tier})` : info.noTemp ? "E_TEMP_FAILED" : info.home ? "E_PYTHON_NOT_FOUND" : `no usable answer from ${machine} (offline?)`);
  const stamp = P?.stamp;
  const problems = P && P.current && stamp ? stampProblems(stamp) : [];
  if (!P || P.error || !P.current || !stamp || problems.length) {
    add("current", "FAIL", !P ? "the machine could not be read" : P.error ?? (!P.current ? "not installed" : !stamp ? "the current generation has no readable MANIFEST.json" : `MANIFEST.json is not whole: ${problems.slice(0, 3).join("; ")}`));
    add("files", "skip", "no valid installed generation");
    add("tests", "skip", "no valid installed generation");
  } else {
    const genDir = genAbs(info.home, P.current);
    add("current", "ok", `${P.current} (${stamp.files.length} files)`);
    const bad = await pyJson(rt, machine, info.python3.path, VERIFY_PY, [genDir, ...stamp.files.map(verifyItem)]);
    add("files", Array.isArray(bad) && !bad.length ? "ok" : "FAIL", Array.isArray(bad) ? (bad.length ? bad.map((b) => `${b.path}: ${b.why}`).join(", ") : "every sha256 and mode matches the stamp") : bad.error);
    let failed = null, count = 0;
    if (node) for (const e of stamp.files) {
      const r = await rt.exec(machine, expandTest(e.test ?? testArgv(e.path), { gen: `${info.home}/${SHARE}/current`, node, python3: info.python3.path }), { timeout: 60 });
      count++;
      if (r.code !== 0) { failed = { path: e.path, err: tail(r.stderr || r.stdout) }; break; }
    }
    add("tests", !node ? "skip" : failed ? "FAIL" : "ok", !node ? "no node" : failed ? `${failed.path}: ${failed.err}` : `${count} test argvs passed`);
  }
  const entryOk = P?.entry?.present && P.entry.sha === LAUNCHER_SHA && P.entry.mode === "755";
  if (!P || P.error) add("entry", "skip", "the machine could not be read");
  else add("entry", entryOk ? "ok" : "FAIL", entryOk ? `${ENTRY} runs the current generation` : P.entry?.present ? `${ENTRY} differs from the launcher (run install)` : `${ENTRY} is missing`);
  let cleared = false;
  const currentId = P?.current ? posix.basename(P.current) : null;
  if (hold) {
    const s = started;
    if (!s || (s.record && s.record.state !== "held")) add("hold", "ok", "no hold");
    else if (s.damaged) add("hold", "WARN", `${s.damaged} is damaged: the hold stands (drover machines hold clear --reason <text>)`);
    else if (s.record.machine !== machine) add("hold", "WARN", `held for ${s.record.machine}: run drover machines doctor ${s.record.machine}`);
    else if (checks.some((c) => c.status === "FAIL")) add("hold", "WARN", `held since ${s.record.since}: this install is not whole yet, so the hold stands`);
    else if (currentId !== s.record.target) add("hold", "WARN", `held: install of ${s.record.target} unfinished (current is ${currentId}); the hold stands`);
    else {
      const c = hold.clear({ expectN: s.n, machine });
      cleared = c.ok;
      add("hold", c.ok ? "ok" : "WARN", c.ok ? `hold cleared: ${machine} is whole` : "another actor moved the hold first: it stands");
    }
  }
  const count = (st) => checks.filter((c) => c.status === st).length;
  return { ok: count("FAIL") === 0, exitCode: count("FAIL") ? 1 : 0, checks, cleared, summary: { ok: count("ok"), warn: count("WARN"), fail: count("FAIL") } };
}
export function formatDoctor(d, { machine }) {
  return `${d.checks.map((c) => `${c.status}  ${machine}:${c.id}  ${c.detail}`).join("\n")}\ndoctor: ${d.summary.ok} ok, ${d.summary.warn} warn, ${d.summary.fail} fail\n`;
}

// ---------------------------------------------------------------------------------------------------------- check (read-only)
export async function check(rt, opts) {
  const { machine, srcRoot, nodeDir = "", force = false } = opts;
  const manifest = buildManifest(srcRoot);
  const info = await findRuntime(rt, machine, srcRoot, nodeDir);
  const bad = needRuntime(info, machine);
  if (bad) return { exitCode: 1, ...bad, files: [] };
  const P = await probe(rt, machine, info);
  if (P.error) return { exitCode: 1, ...fail("E_PROBE_FAILED", P.error), files: [] };
  const broken = brokenInstall(P);
  if (broken && !force) return { exitCode: 1, ...stampRefusal(machine, P, broken), files: [] };
  const p = plan(manifest, trustedProbe(P), force);
  return { exitCode: p.states.every((x) => x.state === "current") ? 0 : 1, files: p.states };
}

// ---------------------------------------------------------------------------------------------------------- install
export const holdDir = (appHome) => join(appHome, "data/drover-sync-hold");

export async function install(rt, opts) {
  const { machine, srcRoot, force = false, nodeDir = "", appHome, holdEnv = {}, hold: holdIn } = opts;
  const hold = holdIn ?? (appHome ? createHold({ dir: holdDir(appHome), ...holdEnv }) : null);
  if (!hold) return fail("E_NO_APP_HOME", "no app home: the sync hold needs a folder");
  const manifest = buildManifest(srcRoot);
  const open = closureMissing(srcRoot);
  if (open.length) return fail("E_MANIFEST_OPEN", `imported but not shipped: ${open.join(", ")}`);
  // 0. Anything held (another machine, a live installer, a damaged record) stops us before a single call to the machine.
  const guard = pushGuard(hold, { resume: machine });
  if (guard.held) return fail("E_HELD", guard.message, { held: true });
  // 1. Read-only: the runtimes, then what is installed. Nothing is written before both are known.
  const info = await findRuntime(rt, machine, srcRoot, nodeDir);
  const bad = needRuntime(info, machine);
  if (bad) return bad;
  const home = info.home, python3 = info.python3.path, node = info.node.path;
  let P = await probe(rt, machine, info);
  if (P.error) return fail("E_PROBE_FAILED", P.error);
  const broken1 = brokenInstall(P);
  if (broken1 && !force) return stampRefusal(machine, P, broken1);
  let p = plan(manifest, trustedProbe(P), force);
  const first = p.states;
  const done = (extra) => ({ ok: true, noop: false, files: first, ...extra });

  const wholeNow = async () => {
    const d = await doctor(rt, { machine, srcRoot, nodeDir, hold: null });
    return d.checks.every((c) => c.status !== "FAIL");
  };
  const held = hold.read();
  const ours = held?.record?.state === "held" && held.record.machine === machine;
  const currentId = P.current ? posix.basename(P.current) : null;
  if (!p.work && P.current && (await wholeNow())) {
    if (!ours) return { ok: true, noop: true, gen: currentId, files: first };
    if (held.record.target === currentId) { // a kill after the switch: finish what was started
      const d = await doctor(rt, { machine, srcRoot, nodeDir, hold });
      return d.ok ? done({ gen: currentId, completed: true }) : fail("E_DOCTOR", "doctor found the install not whole", { checks: d.checks, files: first });
    }
  }

  // 2. Something will be written: take the hold FIRST (exclusive), then decide again from a fresh read.
  const acq = hold.acquire({ machine, target: p.id });
  if (!acq.ok) return fail("E_HELD", acq.message, { held: true, reason: acq.reason });
  const token = acq.record.token;
  P = await probe(rt, machine, info);
  if (P.error) return fail("E_PROBE_FAILED", P.error);
  const broken2 = brokenInstall(P);
  if (broken2 && !force) return stampRefusal(machine, P, broken2); // the hold taken just now stands: doctor or --force settles it
  p = plan(manifest, trustedProbe(P), force);
  const cur2 = P.current ? posix.basename(P.current) : null;
  if (!p.work && P.current && (await wholeNow())) { // somebody else finished it while we took the hold
    if (hold.read().record.target !== cur2) hold.retarget(token, cur2);
    const d = await doctor(rt, { machine, srcRoot, nodeDir, hold });
    return d.ok ? done({ gen: cur2 }) : fail("E_DOCTOR", "doctor found the install not whole", { checks: d.checks, files: first });
  }

  // 3. The generation id: the content id when that directory is absent or still verifies, else a suffixed one (a published dir is never written).
  const shareAbs = abs(home, SHARE), nonce = randomBytes(4).toString("hex");
  const triples = p.files.map(verifyItem);
  const runTests = async (genDir) => {
    for (const f of p.files) {
      const r = await rt.exec(machine, expandTest(f.test, { gen: genDir, node, python3 }), { timeout: 60 });
      if (r.code !== 0) return fail("E_VERIFY_TEST", `the test for ${f.path} failed on ${machine}: ${tail(r.stderr || r.stdout)}`, { path: f.path, files: first });
    }
    return null;
  };
  let id = p.id, reuse = false;
  if (P.gens.includes(id)) {
    const v = await pyJson(rt, machine, python3, VERIFY_PY, [abs(home, `${GEN}/${id}`), ...triples]);
    if (Array.isArray(v) && !v.length) {
      const t = await runTests(abs(home, `${GEN}/${id}`));
      if (!t) reuse = true;
    }
    if (!reuse) id = `${p.id}-${nonce}`;
  }
  if (hold.read().record.target !== id) {
    const r = hold.retarget(token, id);
    if (!r.ok) return fail("E_HELD", "the hold moved while this install was deciding; nothing was written", { held: true });
  }

  if (!reuse) {
    const stageRel = `${GEN}/.stage-${nonce}`, stageAbs = abs(home, stageRel);
    for (const x of p.entries) if (x.action === "source") await rt.write(machine, `${stageRel}/${x.f.path}`, readFileSync(join(srcRoot, x.f.path), "utf8"));
    const copies = p.entries.filter((x) => x.action !== "source").map((x) => x.f.path);
    if (copies.length) {
      const r = await py(rt, machine, python3, COPY_PY, [genAbs(home, P.current), stageAbs, ...copies]);
      if (r.code !== 0) return fail("E_COPY_FAILED", `copying the kept files on ${machine} failed: ${tail(r.stderr)}`, { files: first });
    }
    const m = await py(rt, machine, python3, MODES_PY, [stageAbs, ...p.files.map((f) => `${f.path}=${f.mode}`)]);
    if (m.code !== 0) return fail("E_MODE_FAILED", `setting modes on ${machine} failed: ${tail(m.stderr)}`, { files: first });
    // MANIFEST.json is the stamp and the "this generation is complete" mark: written LAST.
    await rt.write(machine, `${stageRel}/MANIFEST.json`, `${JSON.stringify({ id, node, python3, installedAt: new Date().toISOString(), files: p.files }, null, 1)}\n`);
    const v = await pyJson(rt, machine, python3, VERIFY_PY, [stageAbs, ...triples]);
    if (!Array.isArray(v)) return fail("E_VERIFY_FAILED", v.error, { files: first });
    if (v.length) return fail(v[0].why === "mode" ? "E_VERIFY_MODE" : v[0].why === "sha" ? "E_VERIFY_SHA" : "E_VERIFY_MISSING", `${v[0].path}: ${v[0].why} does not match what was sent`, { path: v[0].path, files: first });
    const t = await runTests(stageAbs);
    if (t) return t;
    const pub = await py(rt, machine, python3, PUBLISH_PY, [stageAbs, abs(home, `${GEN}/${id}`)]);
    if (pub.code !== 0) return fail("E_PUBLISH_EXISTS", pub.code === 3 ? `gen/${id} already exists on ${machine}; nothing was switched` : `could not publish gen/${id} on ${machine} (${tail(pub.stderr)}); nothing was switched`, { files: first });
  }

  // 4. The switch: two calls. A temp link (current untouched), then ONE rename over `current`.
  const tmp = `${shareAbs}/current.tmp-${nonce}`;
  const l = await py(rt, machine, python3, LINK_PY, [`gen/${id}`, tmp]);
  if (l.code !== 0) return fail("E_SWITCH_FAILED", `could not create the switch link on ${machine}: ${tail(l.stderr)}`, { files: first });
  const s = await py(rt, machine, python3, REPLACE_PY, [tmp, `${shareAbs}/current`]);
  if (s.code !== 0) return fail("E_SWITCH_FAILED", `could not switch current on ${machine}: ${tail(s.stderr)}`, { files: first });
  // 5. The entry launcher (immutable; written only when missing or different).
  if (!(P.entry?.present && P.entry.sha === LAUNCHER_SHA && P.entry.mode === "755")) {
    const e = await py(rt, machine, python3, ENTRY_PY.replace("__TEXT__", JSON.stringify(LAUNCHER)), [abs(home, ENTRY), nonce]);
    if (e.code !== 0) return fail("E_ENTRY_FAILED", `could not write ${ENTRY} on ${machine}: ${tail(e.stderr)}`, { files: first });
  }
  // 6. Doctor: only a passing doctor clears the hold.
  const d = await doctor(rt, { machine, srcRoot, nodeDir, hold });
  return d.ok ? done({ gen: id, path: `${GEN}/${id}` }) : fail("E_DOCTOR", "doctor found the install not whole; the hold stands", { checks: d.checks, files: first });
}
