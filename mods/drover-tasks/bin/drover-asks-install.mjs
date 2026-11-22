// drover asks-hook install|uninstall|status (T-MWPK6KYSFZV, B4a part B). Opt-in, never automatic: it merges the asks hook into the owner's
// Claude settings.json and Codex hooks.json the way mods/install.sh treats a file it does not own (B6): an entry is added, updated or removed only when it
// is absent or deep-equal to the one we wrote; the old bytes are kept (the retained inode becomes the backup); a record outside every watched tree
// lets uninstall restore; nothing is replaced without being shown as an exact diff and asked first.
// Pure core (no fs): parseConfig, wantedFor, planInstall, planUninstall, render, unifiedDiff, resolveTargets. fs layer: one seam (makeSeam) so tests
// can fault or kill at every mutating call and prove every path read lies under the test's scratch root.
// This module never answers a prompt and never prints file content other than the diff the owner asked for.
import { openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, renameSync, linkSync, unlinkSync, mkdirSync, rmdirSync, lstatSync, realpathSync, readdirSync, chmodSync, accessSync, constants as C } from "node:fs";
import { dirname, basename, join, isAbsolute, resolve as presolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { KNOWN_EVENTS, EVENT_ACTION } from "./asks-lib.mjs";

export class Refuse extends Error {}
export class Abort extends Error {}
const MAX_BYTES = 2 * 1024 * 1024;
const SCRIPT = "drover-asks-hook";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const deepEqual = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => own(b, k) && deepEqual(a[k], b[k])); }
  return false;
};

// ---------- pure: what we write (one source of truth: asks-lib's KNOWN_EVENTS / EVENT_ACTION + this matcher/timeout table, checked against the spike table by a test)
export const MATCHERS = { claude: { Notification: "permission_prompt|elicitation_dialog", PreToolUse: "AskUserQuestion|ExitPlanMode" }, codex: {} };
export const timeoutFor = (cli, event) => (cli === "claude" && event === "SessionEnd" ? 1 : 5);
export function launcherOk(path) { return typeof path === "string" && isAbsolute(path) && !/['\n\r\0]/.test(path); }
export function wantedFor(cli, launcher) {
  if (!KNOWN_EVENTS[cli]) throw new Error("unknown cli");
  if (!launcherOk(launcher)) throw new Refuse("the launcher path is empty, relative or holds a quote, newline or NUL");
  const out = {};
  for (const event of KNOWN_EVENTS[cli]) {
    const handler = { type: "command", command: `'${launcher}' ${EVENT_ACTION[cli][event]}`, timeout: timeoutFor(cli, event) };
    const m = MATCHERS[cli][event];
    out[event] = m ? { matcher: m, hooks: [handler] } : { hooks: [handler] };
  }
  return out;
}

// ---------- pure: parse / render
export function indentOf(text) {
  const m = /^\{\r?\n([ \t]+)"/.exec(text);
  return m ? m[1] : "  ";
}
export const render = (root, indent, nl) => JSON.stringify(root, null, indent) + (nl ? "\n" : "");
export function parseConfig(text) {
  if (text.charCodeAt(0) === 0xfeff) throw new Refuse("the file starts with a byte-order mark");
  let root;
  try { root = JSON.parse(text); } catch { throw new Refuse("the file is not valid JSON"); }
  if (!isObj(root)) throw new Refuse("the top level is not a JSON object");
  if (own(root, "__proto__") || own(root, "constructor")) throw new Refuse("the file has a key we will not touch (__proto__ or constructor)");
  if (own(root, "hooks")) {
    const h = root.hooks;
    if (!isObj(h)) throw new Refuse("`hooks` is not an object");
    if (own(h, "__proto__") || own(h, "constructor")) throw new Refuse("`hooks` has a key we will not touch");
    for (const [ev, groups] of Object.entries(h)) {
      if (!Array.isArray(groups)) throw new Refuse(`hooks.${ev} is not an array`);
      for (const g of groups) if (!isObj(g) || !Array.isArray(g.hooks)) throw new Refuse(`a group of hooks.${ev} has no hooks array`);
    }
  }
  const indent = indentOf(text), nl = text.endsWith("\n");
  if (render(root, indent, nl) !== text) throw new Refuse("writing this file back would reformat it (comments, odd spacing, duplicate keys or escapes); we never reformat your file");
  return { root, indent, nl };
}

const namesOurs = (h) => isObj(h) && typeof h.command === "string" && h.command.includes(SCRIPT);
// every handler of the event naming our script, with its place
function oursIn(root, event) {
  const found = [];
  const groups = isObj(root.hooks) && Array.isArray(root.hooks[event]) ? root.hooks[event] : [];
  groups.forEach((g, gi) => g.hooks.forEach((h, hi) => { if (namesOurs(h)) found.push({ gi, hi, group: g, handler: h }); }));
  return found;
}
export function ourHandlersAnywhere(root) {
  const names = [];
  if (isObj(root.hooks)) for (const ev of Object.keys(root.hooks)) for (const f of oursIn(root, ev)) names.push({ event: ev, ...f });
  return names;
}

// ---------- pure: plan
export function planInstall(root, cli, wanted) {
  const next = structuredClone(root);
  const adds = [], same = [], kept = [];
  const created = { hooks: false, events: [] };
  for (const event of KNOWN_EVENTS[cli]) {
    const want = wanted[event];
    const ours = oursIn(next, event);
    if (ours.length === 0) {
      if (!isObj(next.hooks)) { next.hooks = {}; created.hooks = true; }
      if (!Array.isArray(next.hooks[event])) { next.hooks[event] = []; created.events.push(event); }
      next.hooks[event].push(structuredClone(want));
      adds.push(event);
    } else if (ours.length === 1 && deepEqual(ours[0].handler, want.hooks[0]) && (ours[0].group.matcher ?? null) === (want.matcher ?? null)) same.push(event);
    else kept.push({ event, reason: ours.length > 1 ? "more than one entry names the hook script" : "an entry that names the hook script differs from the wanted one", wanted: want });
  }
  // an event outside the set that names our script is the owner's or an older Drover's: reported, never touched
  if (isObj(root.hooks)) for (const ev of Object.keys(root.hooks)) if (!KNOWN_EVENTS[cli].includes(ev) && oursIn(root, ev).length) kept.push({ event: ev, reason: "an event this Drover does not register names the hook script", wanted: null });
  return { next, adds, same, kept, created };
}
export function planUninstall(root, cli, wanted, created = { hooks: false, events: [] }) {
  const next = structuredClone(root);
  const removed = [], kept = [], emptied = new Set();
  if (isObj(next.hooks)) for (const event of Object.keys(next.hooks)) {
    const want = KNOWN_EVENTS[cli].includes(event) ? wanted[event] : null;
    const groups = next.hooks[event];
    for (const g of groups) {
      const keepHandlers = [];
      for (const h of g.hooks) {
        if (!namesOurs(h)) { keepHandlers.push(h); continue; }
        if (want && deepEqual(h, want.hooks[0]) && (g.matcher ?? null) === (want.matcher ?? null)) { removed.push(event); emptied.add(g); }
        else { kept.push({ event, reason: "an entry that names the hook script differs from the one Drover wrote" }); keepHandlers.push(h); }
      }
      g.hooks = keepHandlers;
    }
    // a group goes only when THIS uninstall emptied it; an owner's own empty group is never ours to drop
    next.hooks[event] = groups.filter((g) => !(emptied.has(g) && g.hooks.length === 0 && Object.keys(g).every((k) => k === "matcher" || k === "hooks")));
    if (next.hooks[event].length === 0 && created.events.includes(event)) delete next.hooks[event];
  }
  if (isObj(next.hooks) && Object.keys(next.hooks).length === 0 && created.hooks) delete next.hooks;
  return { next, removed, kept };
}
// does the file hold exactly our wanted entry for each event listed
export function holdsEvents(root, cli, wanted, events) {
  return events.every((ev) => { const o = oursIn(root, ev); return o.length === 1 && deepEqual(o[0].handler, wanted[ev].hooks[0]) && (o[0].group.matcher ?? null) === (wanted[ev].matcher ?? null); });
}

// ---------- pure: unified diff (own LCS, no `diff` binary)
export function unifiedDiff(a, b, labelA, labelB, ctx = 3) {
  if (a === b) return "";
  const A = a === "" ? [] : a.replace(/\n$/, "").split("\n"), B = b === "" ? [] : b.replace(/\n$/, "").split("\n");
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; // [" "|"-"|"+", line]
  let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { ops.push([" ", A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) ops.push(["-", A[i++]]); else ops.push(["+", B[j++]]); }
  while (i < n) ops.push(["-", A[i++]]);
  while (j < m) ops.push(["+", B[j++]]);
  const changed = ops.map((o, k) => (o[0] !== " " ? k : -1)).filter((k) => k >= 0);
  const hunks = [];
  for (const k of changed) {
    const s = Math.max(0, k - ctx), e = Math.min(ops.length, k + ctx + 1);
    if (hunks.length && s <= hunks[hunks.length - 1][1]) hunks[hunks.length - 1][1] = e; else hunks.push([s, e]);
  }
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const [s, e] of hunks) {
    let la = 1, lb = 1;
    for (let k = 0; k < s; k++) { if (ops[k][0] !== "+") la++; if (ops[k][0] !== "-") lb++; }
    const ca = ops.slice(s, e).filter((o) => o[0] !== "+").length, cb = ops.slice(s, e).filter((o) => o[0] !== "-").length;
    out.push(`@@ -${ca === 0 ? la - 1 : la},${ca} +${cb === 0 ? lb - 1 : lb},${cb} @@`);
    for (const [t, line] of ops.slice(s, e)) out.push(t + line);
  }
  return out.join("\n") + "\n";
}

// ---------- pure: where the files are (one resolver, doctor uses it too)
export function resolveTargets(flags = {}, env = {}, home = env.HOME || homedir()) {
  const pick = (flag, own_, root, rootFile, dir, file) => flag || env[own_] || (env[root] ? join(env[root], rootFile) : join(home, dir, file));
  return {
    claude: pick(flags.claudeSettings, "DROVER_CLAUDE_SETTINGS", "CLAUDE_CONFIG_DIR", "settings.json", ".claude", "settings.json"),
    codex: pick(flags.codexHooks, "DROVER_CODEX_HOOKS", "CODEX_HOME", "hooks.json", ".codex", "hooks.json"),
  };
}
export const appHome = (env, home = env.HOME || homedir()) => env.HERDR_APP_HOME || join(home, ".config", "herdr-app");
export const runtimeLeaf = (hh) => join(hh, "data", "drover-asks-runtime");

// ---------- fs seam: every read is guarded and logged, every mutating call is counted and can be faulted/killed by a test hook
export function makeSeam({ root = null, before = null, after = null, realDefaults = null, userHome = null } = {}) {
  let n = 0;
  const opened = [];
  let rootReal = null;
  const within = (p) => { const r = rootReal ?? (rootReal = realpathSync(root)); const full = presolve(p); let probe = full; for (;;) { try { probe = realpathSync(probe) + full.slice(probe.length); break; } catch { const up = dirname(probe); if (up === probe) break; probe = up; } } return probe === r || probe.startsWith(r + sep); };
  const guard = (p) => {
    opened.push(p);
    if (realDefaults && realDefaults.some((d) => presolve(p) === d)) throw new Error(`test guard: refusing to touch the real default ${p}`);
    if (root && !within(p)) throw new Error(`test guard: ${p} is outside the scratch root`);
  };
  const mut = (label, paths, fn) => { for (const p of paths) guard(p); n++; before?.(label, n); const r = fn(); after?.(label, n); return r; };
  const S = {
    opened, get count() { return n; },
    lstat: (p) => { guard(p); return lstatSync(p); },
    realpath: (p) => { guard(p); return realpathSync(p); },
    readdir: (p) => { guard(p); return readdirSync(p); },
    readFile(p) { // regular file only, no symlink at the end, cannot hang on a FIFO
      guard(p);
      const fd = openSync(p, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Refuse("not a regular file");
        if (st.size > MAX_BYTES) throw new Refuse("the file is over 2 MB");
        const b = Buffer.alloc(st.size);
        let off = 0; while (off < st.size) { const r = readSync(fd, b, off, st.size - off, off); if (!r) break; off += r; }
        return { bytes: b.subarray(0, off), st };
      } finally { closeSync(fd); }
    },
    mkdir: (p, label = "mkdir") => mut(label, [p], () => mkdirSync(p, { mode: 0o700 })),
    mkdirp: (p, label = "mkdirp") => mut(label, [p], () => mkdirSync(p, { recursive: true, mode: 0o700 })),
    writeNew: (p, data, mode, label = "write") => mut(label, [p], () => { const fd = openSync(p, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode); try { let o = 0; while (o < data.length) o += writeSync(fd, data, o); fsyncSync(fd); } finally { closeSync(fd); } chmodSync(p, mode); }),
    link: (a, b, label = "link") => mut(label, [a, b], () => linkSync(a, b)),
    rename: (a, b, label = "rename") => mut(label, [a, b], () => renameSync(a, b)),
    unlink: (p, label = "unlink") => mut(label, [p], () => unlinkSync(p)),
    rmdir: (p, label = "rmdir") => mut(label, [p], () => rmdirSync(p)),
    chmod: (p, mode, label = "chmod") => mut(label, [p], () => chmodSync(p, mode)),
    // peek/exec: metadata only, never contents, never logged: the node binary and the ancestors of the launcher are outside the scratch root by nature
    peek: (p) => lstatSync(p),
    exec: (p) => { accessSync(p, C.X_OK); },
    access: (p) => { guard(p); accessSync(p, C.X_OK); },
  };
  return S;
}
export const realDefaultPaths = (userHome) => { try { const h = userHome ?? userInfo().homedir; return [join(h, ".claude", "settings.json"), join(h, ".codex", "hooks.json")]; } catch { return []; } };

// ---------- fs layer
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const tryUnlink = (S, p, label) => { try { S.unlink(p, label); } catch {} };
function inspect(S, path) {
  let l;
  try { l = S.lstat(path); } catch (e) {
    if (e.code !== "ENOENT") throw new Refuse(`cannot look at the file (${e.code})`);
    let rp; try { rp = S.realpath(dirname(path)); } catch { return { missingDir: true }; }
    return { absent: true, real: join(rp, basename(path)) };
  }
  let real;
  try { real = S.realpath(path); } catch { throw new Refuse(l.isSymbolicLink() ? "a symlink that points nowhere" : "cannot resolve the path"); }
  let r;
  try { r = S.readFile(real); } catch (e) { if (e instanceof Refuse) throw e; throw new Refuse(`cannot read the file (${e.code || e.message})`); }
  return { real, bytes: r.bytes, text: r.bytes.toString("utf8"), dev: r.st.dev, ino: r.st.ino, mode: r.st.mode & 0o777 };
}
const sameState = (a, b) => (a.absent && b.absent) || (!a.absent && !b.absent && !a.missingDir && !b.missingDir && Buffer.compare(a.bytes, b.bytes) === 0);

function dataDir(hh) { return join(hh, "data"); }
const instDir = (hh) => join(dataDir(hh), "drover-asks-install");
const backupsDir = (hh) => join(instDir(hh), "backups");
const lockPath = (hh) => join(dataDir(hh), "drover-asks-install.lock");
const recordPath = (hh, cli, real) => join(instDir(hh), `${cli}-${sha(real).slice(0, 16)}.json`);

function writeJson(S, path, obj, label) {
  const tmp = `${path}.tmp.${process.pid}`;
  const data = Buffer.from(JSON.stringify(obj, null, 2) + "\n");
  try { S.writeNew(tmp, data, 0o600, `${label}:tmp`); S.rename(tmp, path, label); } catch (e) { tryUnlink(S, tmp, "cleanup"); throw e; }
}
function readJson(S, path) {
  let r;
  try { r = S.readFile(path); } catch (e) { if (e.code === "ENOENT") return null; return { unreadable: true }; }
  try { const o = JSON.parse(r.bytes.toString("utf8")); return isObj(o) && o.v === 1 ? o : { unreadable: true }; } catch { return { unreadable: true }; }
}

// B6's retention protocol for a file we do not own. newBytes === null deletes the file. `configured` is re-resolved at the final check so a retargeted symlink aborts.
// Returns { backup, keptOwner, asideLeft }. Once the file may have been published the aside (the OLD inode) is only ever MOVED, never unlinked, even when the call throws:
// then the error carries .retained = { backup, keptOwner, asideLeft }.
function retain(S, hh, aside, baseSha, dest) {
  let backup = null, keptOwner = false, asideLeft = aside;
  try {
    const old = S.readFile(aside).bytes;
    keptOwner = sha(old) !== baseSha;
    const to = keptOwner ? dest.replace(/\.json$/, "-owner.json") : dest;
    S.rename(aside, to, "move-aside");
    asideLeft = null; backup = to;
    try { S.chmod(to, 0o600); } catch {}
  } catch {
    // an error after the rename took effect (fail-after-success) must not hide where the old inode is: decide from the state
    try {
      const to = keptOwner ? dest.replace(/\.json$/, "-owner.json") : dest;
      let toThere = false, asideThere = false;
      try { S.peek(to); toThere = true; } catch {}
      try { S.peek(aside); asideThere = true; } catch {}
      if (toThere && !asideThere) { backup = to; asideLeft = null; }
    } catch {}
  }
  return { backup, keptOwner, asideLeft };
}
function publish(S, hh, cli, real, configured, base, newBytes, mode, uniq, dest) {
  const dir = dirname(real), name = basename(real);
  const tmp = join(dir, `.drover-tmp.${uniq}.${name}`);
  const aside = base.absent ? null : join(dir, `.drover-aside.${uniq}.${name}`);
  const landed = () => { // did the publish take effect? decided from the state, never from which call threw
    try { const c = inspect(S, real); if (base.absent) return !c.absent; if (c.absent) return true; return c.ino !== base.ino || c.dev !== base.dev; } catch { return true; } // unknown = assume landed: keep everything
  };
  try {
    if (newBytes !== null) S.writeNew(tmp, newBytes, mode, "tmp");
    if (aside) S.link(real, aside, "aside");
    const cur = inspect(S, configured); // the check immediately before publish (compare-and-swap): same bytes, same physical file, same resolved path
    if (cur.missingDir || cur.real !== real || !sameState(cur, base) || (!base.absent && (cur.ino !== base.ino || cur.dev !== base.dev))) throw new Abort("the file changed while we were working; nothing was written");
    if (base.absent) { S.link(tmp, real, "publish"); tryUnlink(S, tmp, "tmp-drop"); }
    else if (newBytes !== null) S.rename(tmp, real, "publish");
    else S.unlink(real, "publish-delete");
  } catch (e) {
    const did = !(e instanceof Abort) && landed();
    tryUnlink(S, tmp, "abort-tmp");
    if (!did) { if (aside) tryUnlink(S, aside, "abort-aside"); throw e; }
    e.retained = aside ? retain(S, hh, aside, sha(base.bytes), dest) : { backup: null, keptOwner: false, asideLeft: null };
    throw e;
  }
  return aside ? retain(S, hh, aside, sha(base.bytes), dest) : { backup: null, keptOwner: false, asideLeft: null };
}

// reconcile a pending record by CONFIG state first (R5.3). Returns a note string or null.
function reconcile(S, hh, cli, rp, wanted, note) {
  const rec = readJson(S, rp);
  if (!rec) return null;
  if (rec.unreadable) return "needs-owner: a record could not be read; nothing was changed";
  if (rec.state !== "pending") return null;
  const cur = inspect(S, rec.target.real);
  const eq = (side) => (side.exists ? !cur.absent && !cur.missingDir && sha(cur.bytes) === side.sha256 : !!cur.absent);
  const restorePrev = () => { if (rec.prevRecord) writeJson(S, rp, rec.prevRecord, "record:restore"); else tryUnlink(S, rp, "record:drop"); };
  for (const p of [rec.tmp, rec.aside]) if (p) { // abort leftovers: a tmp always; an aside only while it is still the same inode as an unchanged target
    try { if (p === rec.aside) { const t = inspect(S, rec.target.real); const a = S.lstat(p); if (t.absent || a.ino !== t.ino) continue; } S.unlink(p, "reconcile-clean"); } catch {}
  }
  if (eq(rec.base)) { restorePrev(); note?.("a change that did not land was dropped"); return "dropped"; }
  if (eq(rec.after)) {
    if (rec.aside && rec.backup) { // landed but killed before the old inode was moved into the backups folder: finish that move (the aside is never unlinked)
      try { const a = S.lstat(rec.aside); if (a) retain(S, hh, rec.aside, rec.base.sha256, rec.backup); } catch {}
    }
    if (rec.op === "install") { writeJson(S, rp, { ...rec.nextRecord, state: "done" }, "record:done"); note?.("an interrupted install had landed: recorded"); return "committed"; }
    // uninstall landed only if no handler of ours remains unexplained
    const owned = cur.absent ? [] : (() => { try { return ourHandlersAnywhere(parseConfig(cur.text).root); } catch { return [1]; } })();
    if (rec.nextRecord === null && owned.length === 0) { tryUnlink(S, rp, "record:delete"); note?.("an interrupted uninstall had landed: record removed"); return "committed"; }
    if (rec.nextRecord) { writeJson(S, rp, { ...rec.nextRecord, state: "done" }, "record:done"); return "committed"; }
  }
  writeJson(S, rp, { ...rec, state: "needs-owner" }, "record:needs-owner");
  note?.("state unclear: nothing restored (the file is not what we planned or what we started from)");
  return "needs-owner";
}

// ---------- the shared runtime leaf: created or refreshed by install, never touched by uninstall
export function findNode(env) {
  const want = env.DROVER_NODE || "node";
  const cands = isAbsolute(want) ? [want] : (env.PATH || "").split(":").filter(Boolean).map((d) => join(d, want));
  for (const c of cands) { try { const st = lstatSync(c); if (!(st.isFile() || st.isSymbolicLink())) continue; const r = realpathSync(c); accessSync(r, C.X_OK); return c.startsWith("/") ? r : null; } catch {} }
  return null;
}
export function runtimeState(S, hh, node) {
  const leaf = runtimeLeaf(hh);
  let r; try { r = S.readFile(leaf); } catch (e) { return { leaf, state: e.code === "ENOENT" ? "absent" : "differs" }; }
  const line = r.bytes.toString("utf8").replace(/\n$/, "");
  const valid = isAbsolute(line) && !/\n/.test(line) && (() => { try { S.exec(line); return true; } catch { return false; } })();
  return { leaf, state: valid && (!node || line === node) ? "present" : "differs", line };
}
function runtimeStep(S, hh, node, out) {
  if (!node) { out("runtime file: no node found on PATH (or DROVER_NODE); the hook will only run where node is on its PATH"); return 0; }
  const leaf = runtimeLeaf(hh);
  const want = Buffer.from(node + "\n");
  const cur = runtimeState(S, hh, null);
  if (cur.state === "absent") {
    S.mkdirp(dataDir(hh), "mkdir-data");
    const tmp = `${leaf}.tmp.${process.pid}`;
    try { S.writeNew(tmp, want, 0o600, "leaf:tmp"); S.link(tmp, leaf, "leaf:link"); out(`runtime file created: ${leaf}`); }
    catch (e) {
      if (e.code === "EEXIST") { const again = runtimeState(S, hh, node); if (again.state === "present") return 0; out("runtime file KEPT: another file appeared and differs; not overwritten"); return 1; }
      out(`runtime file not written (${e.code || e.message}); the config part continues`); return 1;
    } finally { tryUnlink(S, tmp, "leaf:tmp-drop"); }
    return 0;
  }
  if (cur.state === "present" && cur.line === node) return 0;
  out(`runtime file KEPT: ${leaf} holds other bytes; not overwritten. Wanted line: ${node}`);
  return 1;
}

// ---------- the transaction per target
function launcherFor(S, hh) {
  const p = join(hh, "mods", "drover-tasks", "bin", "drover-asks-hook");
  let real;
  try { real = S.realpath(p); const st = S.lstat(real); if (!st.isFile()) throw 0; S.access(real); } catch { throw new Refuse("the hook launcher is missing or not an executable file: run install.sh from the main checkout first"); }
  // a launcher that lives in a linked git worktree would vanish with it
  for (let d = dirname(real); ; d = dirname(d)) {
    try { const g = S.peek(join(d, ".git")); if (g.isFile()) throw new Refuse("the hook launcher lives in a linked git worktree: run install.sh from the main checkout first"); break; } catch (e) { if (e instanceof Refuse) throw e; }
    if (dirname(d) === d) break;
  }
  return p; // the stable link path, not the real one: it survives a re-link
}

async function confirmAndRun(io, flags, label) {
  if (flags.yes) return "yes";
  if (!io.isTTY) return "noconsent";
  const a = await io.ask(`${label}? [y/N] `);
  return /^\s*y(es)?\s*$/i.test(a || "") ? "yes" : "no";
}

async function oneTarget(ctx, op, cli, configured) {
  const { S, hh, io, flags, env } = ctx;
  const out = (s) => io.out(s + "\n");
  const tag = `[${cli}]`;
  const t = inspect(S, configured);
  if (t.missingDir) { out(`${tag} skipped: ${dirname(configured)} does not exist (that CLI is not installed)`); return 0; }
  const rp = recordPath(hh, cli, t.real);
  const notes = [];
  let rec = readJson(S, rp);
  const rc = reconcile(S, hh, cli, rp, null, (s) => out(`${tag} ${s}`));
  if (rc) rec = readJson(S, rp);
  let launcher, wanted;
  try { launcher = launcherFor(S, hh); wanted = wantedFor(cli, launcher); } catch (e) { if (op === "uninstall" && rec && !rec.unreadable) { launcher = null; } else throw e; }
  if (op === "uninstall" && !wanted) {
    // uninstall without a launcher on disk: compare against the recorded entries
    wanted = rec?.wanted; if (!wanted) throw new Refuse("no launcher and no record: cannot tell which entries are ours");
  }
  const bound = rec && !rec.unreadable && rec.target?.real === t.real;
  const needsOwner = bound && rec.state === "needs-owner";
  // --- parse and plan
  let parsed, root0;
  if (t.absent) { parsed = { root: {}, indent: "  ", nl: true }; root0 = {}; } else { parsed = parseConfig(t.text); root0 = parsed.root; }
  const baseText = t.absent ? "" : t.text;
  let next, summary, newBytes, created = { hooks: false, events: [] }, kept, fast = null;
  if (op === "install") {
    const pl = planInstall(root0, cli, wanted);
    kept = pl.kept; created = pl.created;
    for (const k of kept) out(`${tag} KEPT ${k.event}: ${k.reason}${k.wanted ? `\n${tag} wanted entry: ${JSON.stringify(k.wanted)}` : ""}`);
    next = pl.next; summary = { adds: pl.adds };
    newBytes = pl.adds.length ? Buffer.from(render(next, parsed.indent, parsed.nl)) : null;
  } else {
    const k0 = bound && !needsOwner ? rec : null;
    const fastOk = k0 && k0.state === "done" && k0.origin && k0.origin.repaired === false && k0.after?.sha256 && !t.absent && sha(t.bytes) === k0.after.sha256;
    if (fastOk) {
      if (k0.origin.created?.file) { fast = { del: true }; newBytes = null; next = null; }
      else { try { const b = S.readFile(k0.origin.backup).bytes; if (sha(b) === k0.origin.sha256 && ourHandlersAnywhere(parseConfig(b.toString("utf8")).root).length === 0) { fast = { bytes: b }; newBytes = b; } } catch {} }
    }
    const pl = planUninstall(root0, cli, wanted, bound ? rec.origin?.created ?? undefined : undefined);
    kept = pl.kept;
    for (const k of kept) out(`${tag} KEPT ${k.event}: ${k.reason}`);
    if (!fast) { next = pl.next; newBytes = pl.removed.length ? Buffer.from(render(next, parsed.indent, parsed.nl)) : null; }
    summary = { removed: pl.removed };
  }
  const changeConfig = op === "install" ? newBytes !== null : fast ? true : newBytes !== null;
  // --- runtime block (install only)
  let node = null, rtWork = false;
  if (op === "install") { node = findNode(env); const rs = node ? runtimeState(S, hh, node) : { state: "absent" }; rtWork = !!node && rs.state === "absent"; }
  if (!changeConfig && !rtWork) {
    if (op === "install") out(`${tag} already installed`); else out(`${tag} nothing of ours to remove`);
    if (op === "uninstall" && bound && !kept.length && !needsOwner && ourHandlersAnywhere(root0).length === 0) { tryUnlink(S, rp, "record:delete"); }
    if (op === "install" && node) { const r = runtimeStep(S, hh, node, (s) => out(`${tag} ${s}`)); if (r) return 1; }
    return kept.length ? 1 : 0;
  }
  // --- diff and ask
  const finalText = fast ? (fast.del ? "" : fast.bytes.toString("utf8")) : newBytes ? newBytes.toString("utf8") : baseText;
  if (changeConfig) {
    const absentNew = fast?.del;
    out(unifiedDiff(baseText, finalText, t.absent ? "/dev/null" : configured, absentNew ? "/dev/null" : configured).trimEnd());
  }
  if (rtWork) out(`${tag} + runtime file ${runtimeLeaf(hh)}: ${node}`);
  const answer = await confirmAndRun(io, flags, `Apply to ${configured}`);
  if (answer === "noconsent") { out(`${tag} no terminal to ask on: nothing was written (pass --yes after reading the diff)`); return 2; }
  if (answer === "no") { out(`${tag} declined: nothing was written`); return 0; }
  let code = kept.length ? 1 : 0;
  if (op === "install" && node) code = Math.max(code, runtimeStep(S, hh, node, (s) => out(`${tag} ${s}`)));
  if (!changeConfig) return code;
  // --- config transaction
  S.mkdirp(instDir(hh), "mkdir-inst"); S.mkdirp(backupsDir(hh), "mkdir-backups");
  const cur2 = inspect(S, configured);
  if (cur2.missingDir || cur2.real !== t.real || !sameState(cur2, t) || (!t.absent && (cur2.ino !== t.ino || cur2.dev !== t.dev))) throw new Abort("the file (or the link that points to it) changed while we were asking; nothing was written");
  const mode = t.absent ? 0o600 : t.mode;
  const base = t.absent ? { absent: true, real: t.real } : t;
  const baseSide = t.absent ? { exists: false } : { exists: true, sha256: sha(t.bytes), size: t.bytes.length };
  const afterSide = fast?.del ? { exists: false } : { exists: true, sha256: sha(fast ? fast.bytes : newBytes), size: (fast ? fast.bytes : newBytes).length };
  const target = { configured, real: t.real };
  const prevRecord = rec && !rec.unreadable ? rec : null;
  const uniq = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const dest = join(backupsDir(hh), `${cli}-${stamp()}-${uniq}-${op}.json`); // decided and recorded BEFORE anything changes, so recovery always knows where the old inode goes
  let nextRecord;
  if (op === "install") {
    // repaired = any earlier trace of ours (a record, an unreadable record, or Drover entries already in the file): uninstall is then surgical, never a byte restore
    const prior = (bound && rec.origin) || rec?.unreadable || ourHandlersAnywhere(root0).length > 0;
    const origin = bound && rec.origin ? { ...rec.origin, repaired: true } : { sha256: baseSide.exists ? baseSide.sha256 : null, backup: t.absent ? null : dest, created: { file: t.absent, ...created }, repaired: !!prior };
    nextRecord = { v: 1, cli, state: "done", op, target, origin, after: { sha256: afterSide.sha256 }, wanted, at: new Date().toISOString() };
    if (needsOwner) nextRecord = { ...nextRecord, state: "needs-owner" };
  } else {
    nextRecord = rec && !rec.unreadable && (kept.length || (fast ? false : ourHandlersAnywhere(next).length)) ? { ...rec, state: "done", after: { sha256: afterSide.sha256 }, origin: { ...(rec?.origin || {}), repaired: true }, at: new Date().toISOString() } : null;
    if (needsOwner && nextRecord) nextRecord.state = "needs-owner";
    // an unreadable earlier record is uncertainty evidence: while any handler naming our script remains it stays, as a needs-owner record
    if (!nextRecord && rec?.unreadable && (kept.length || (fast ? false : ourHandlersAnywhere(next).length))) nextRecord = { v: 1, cli, state: "needs-owner", op, target, origin: { sha256: null, backup: null, created: { file: false, hooks: false, events: [] }, repaired: true }, after: { sha256: afterSide.sha256 }, wanted, at: new Date().toISOString() };
  }
  const pending = { backup: t.absent ? null : dest, v: 1, cli, state: "pending", op, target, base: baseSide, after: afterSide, nextRecord, prevRecord, tmp: join(dirname(t.real), `.drover-tmp.${uniq}.${basename(t.real)}`), aside: t.absent ? null : join(dirname(t.real), `.drover-aside.${uniq}.${basename(t.real)}`), at: new Date().toISOString() };
  let res;
  try {
    writeJson(S, rp, pending, "record:pending");
    res = publish(S, hh, cli, t.real, configured, base, fast?.del ? null : fast ? fast.bytes : newBytes, mode, uniq, dest);
    // verify: the file parses and holds what we meant (the launcher is never checked here: a missing script is a doctor WARN, not a reason to roll back)
    const v = inspect(S, t.real);
    const okv = fast?.del ? v.absent : !v.absent && sha(v.bytes) === afterSide.sha256 && (() => { try { const r = parseConfig(v.text).root; return op === "install" ? holdsEvents(r, cli, wanted, [...summary.adds, ...(planInstall(root0, cli, wanted).same)]) : ourHandlersAnywhere(r).length === (fast ? 0 : ourHandlersAnywhere(next).length); } catch { return false; } })();
    if (!okv) throw new Error("verify failed: the file is not what we wrote");
    if (op === "install" && res.keptOwner && !nextRecord.origin.repaired) nextRecord.origin.backup = null; // the plain backup name was never written: no byte restore
    if (nextRecord && res.asideLeft) nextRecord.asideLeft = res.asideLeft;
    if (nextRecord) { writeJson(S, rp, nextRecord, "record:done"); } else tryUnlink(S, rp, "record:delete");
  } catch (e) {
    out(`${tag} FAILED: ${e.message}`);
    try { reconcile(S, hh, cli, rp, null, (s) => out(`${tag} ${s}`)); } catch {}
    const ret = res ?? e.retained;
    if (ret?.asideLeft) out(`${tag} KEPT-OWNER: the old file is kept at ${ret.asideLeft}`);
    else if (ret?.keptOwner) out(`${tag} KEPT-OWNER: your edit made during the update is kept at ${ret.backup}`);
    return 1;
  }
  if (res.keptOwner) { out(`${tag} KEPT-OWNER: your edit made during the update is kept at ${res.backup}; the new file is in place`); code = 1; }
  else if (res.backup) out(`${tag} backup of the previous file kept at ${res.backup}`);
  if (res.asideLeft) { out(`${tag} KEPT-OWNER: the old file is kept at ${res.asideLeft}`); code = 1; }
  if (fast) out(`${tag} restored byte-exact from the original`);
  out(`${tag} ${op === "install" ? "installed" : "uninstalled"}: ${configured}`);
  if (op === "install" && cli === "codex") out(`${tag} Codex asks you to trust the new hook on its first run (/hooks); Drover does not bypass it.`);
  if (op === "uninstall") out(`${tag} runtime file left in place: ${runtimeLeaf(hh)} (Drover never removes it; delete it yourself if you want)`);
  return code;
}

async function statusTarget(ctx, cli, configured) {
  const { S, hh, io, env } = ctx;
  const out = (s) => io.out(`[${cli}] ${s}\n`);
  let t;
  try { t = inspect(S, configured); } catch (e) { out(`${configured}: unreadable (${e.message})`); return 1; }
  if (t.missingDir) { out(`not installed (${dirname(configured)} does not exist)`); return 0; }
  const rp = recordPath(hh, cli, t.real);
  const rec = readJson(S, rp);
  const recNote = !rec ? "no record" : rec.unreadable ? "record unreadable" : `record ${rec.state}`;
  const leftovers = () => {
    try { for (const n of S.readdir(dirname(t.real))) if ((n.startsWith(".drover-aside.") || n.startsWith(".drover-tmp.")) && n.endsWith(`.${basename(t.real)}`)) out(`leftover from an interrupted run: ${join(dirname(t.real), n)}${n.startsWith(".drover-aside.") ? " (the previous file; kept, never removed by us)" : ""}`); } catch {}
    if (rec && !rec.unreadable && rec.asideLeft) out(`previous file kept beside the target: ${rec.asideLeft}`);
  };
  if (t.absent) { out(`not installed (${configured} does not exist); ${recNote}`); leftovers(); return 0; }
  let state;
  try {
    const root = parseConfig(t.text).root;
    const ours = ourHandlersAnywhere(root);
    if (!ours.length) state = "not installed";
    else {
      let wanted = null; try { wanted = wantedFor(cli, launcherFor(S, hh)); } catch {}
      const pl = wanted ? planInstall(root, cli, wanted) : null;
      state = !pl ? `installed (launcher missing: ${ours.length} entries)` : pl.kept.length ? "changed-by-owner" : pl.adds.length ? `partial (${pl.same.length} of ${KNOWN_EVENTS[cli].length} events)` : `installed (${pl.same.length} events)`;
    }
  } catch (e) { state = `unreadable config (${e.message})`; }
  out(`${state} at ${configured}; ${recNote}`);
  leftovers();
  return 0;
}

// ---------- CLI
export const USAGE = `usage: drover asks-hook install|uninstall|status [--claude] [--codex] [--yes] [--claude-settings <file>] [--codex-hooks <file>] [--home <dir>]\n`;
export function parseArgs(argv) {
  const f = { targets: [], yes: false };
  const rest = [...argv];
  const cmd = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    if (a === "--claude") f.targets.push("claude");
    else if (a === "--codex") f.targets.push("codex");
    else if (a === "--yes") f.yes = true;
    else if (a === "--claude-settings" || a === "--codex-hooks" || a === "--home") { const v = rest.shift(); if (!v) return { error: `${a} needs a value` }; f[a === "--claude-settings" ? "claudeSettings" : a === "--codex-hooks" ? "codexHooks" : "home"] = v; }
    else return { error: `unknown argument ${a}` };
  }
  if (!f.targets.length) f.targets = ["claude", "codex"];
  return { cmd, flags: f };
}
export async function main(argv, env = process.env, io = {}, seamOpts = {}) {
  const std = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), isTTY: !!(process.stdin.isTTY && process.stdout.isTTY), ask: null };
  io = { ...std, ...io };
  if (argv[0] === "resolve") { // read-only: doctor asks which file to look at
    const a = parseArgs(["resolve", ...argv.slice(2)]);
    if (a.error || !["claude", "codex"].includes(argv[1])) { io.err(USAGE); return 2; }
    io.out(resolveTargets(a.flags, env)[argv[1]] + "\n"); return 0;
  }
  const a = parseArgs(argv);
  if (a.error || !["install", "uninstall", "status"].includes(a.cmd)) { io.err((a.error ? a.error + "\n" : "") + USAGE); return 2; }
  const { cmd, flags } = a;
  if (!io.ask && io.isTTY) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    io.ask = (q) => new Promise((r) => rl.question(q, (x) => r(x)));
    io.close = () => rl.close();
  }
  const hh = flags.home ?? appHome(env);
  const test = env.DROVER_TEST === "1";
  const S = seamOpts.seam ?? makeSeam({ root: test ? env.DROVER_TEST_ROOT || "/nonexistent-test-root" : null, realDefaults: test ? realDefaultPaths(seamOpts.userHome) : null, ...seamOpts });
  const targets = resolveTargets(flags, env);
  const ctx = { S, hh, io, flags, env };
  let codes = [];
  let locked = false;
  try {
    if (cmd !== "status") {
      try { S.mkdirp(dataDir(hh), "mkdir-data"); S.mkdir(lockPath(hh), "lock"); locked = true; }
      catch (e) { if (e.code === "EEXIST") { io.out(`REFUSED: another install is running or one stopped; remove ${lockPath(hh)} yourself if no install is running\n`); return 1; } io.out(`FAILED: could not take the install lock (${e.code || e.message})\n`); return 1; }
    }
    for (const cli of flags.targets) {
      try { codes.push(cmd === "status" ? await statusTarget(ctx, cli, targets[cli]) : await oneTarget(ctx, cmd, cli, targets[cli])); }
      catch (e) {
        if (e instanceof Refuse || e instanceof Abort) {
          io.out(`[${cli}] ${e instanceof Refuse ? "REFUSED" : "ABORTED"}: ${e.message}\n`);
          if (e instanceof Refuse && cmd === "install") { try { const lau = launcherFor(S, hh); io.out(`[${cli}] to add it by hand, put these entries under "hooks" in ${targets[cli]}:\n${JSON.stringify(wantedFor(cli, lau), null, 2)}\n`); } catch {} }
          codes.push(1);
        } else { io.out(`[${cli}] FAILED: ${e.message}\n`); codes.push(1); }
      }
    }
    if (cmd === "status") {
      const rs = runtimeState(S, hh, findNode(env));
      io.out(`runtime file: ${rs.state} (${rs.leaf})\n`);
    }
  } finally {
    if (locked) { try { S.rmdir(lockPath(hh), "unlock"); } catch {} }
    io.close?.();
  }
  return codes.includes(1) ? 1 : codes.includes(2) ? 2 : 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(1); });
}
